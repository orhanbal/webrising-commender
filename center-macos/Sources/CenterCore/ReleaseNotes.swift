import Foundation

/// One "Yenilikler" entry: short user-facing sentences per language.
public struct ReleaseNote: Equatable, Sendable {
    public let id: String
    public let date: String
    /// "windows", "macos"; empty: both apps.
    public let platforms: [String]
    public let items: [String: [String]]

    public init(id: String, date: String, platforms: [String] = [], items: [String: [String]]) {
        self.id = id
        self.date = date
        self.platforms = platforms
        self.items = items
    }

    public func applies(to platform: String) -> Bool {
        platforms.isEmpty || platforms.contains { $0.lowercased() == platform.lowercased() }
    }

    /// The sentences in `language`, else English, else Turkish.
    public func lines(_ language: String) -> [String] {
        if let own = items[language], !own.isEmpty { return own }
        if let en = items["en"], !en.isEmpty { return en }
        return items["tr"] ?? []
    }

    /// The date as a long date in `locale` (the raw text when it is not YYYY-MM-DD).
    public func dateText(_ locale: Locale) -> String {
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(identifier: "UTC")
        parser.dateFormat = "yyyy-MM-dd"
        guard let day = parser.date(from: date) else { return date }
        let out = DateFormatter()
        out.locale = locale
        out.timeZone = TimeZone(identifier: "UTC")
        out.dateStyle = .long
        out.timeStyle = .none
        return out.string(from: day)
    }
}

/// The release notes shipped inside the app (release-notes/notes.json, copied
/// into ReleaseNotesData.swift by scripts/gen-release-notes.py). Entries are
/// matched by id, not by build number: each platform numbers its builds
/// separately and the number is not known when a note is written. The app
/// remembers the newest id it has shown (CenterSettings.lastSeenNotes) and
/// shows every entry above it in the list (newest first).
public enum ReleaseNotes {
    public static let windows = "windows"
    public static let macOS = "macos"
    /// A person updating from a much older version sees at most this many entries.
    public static let maxShown = 5

    /// Every entry in the app, newest first.
    public static let embedded: [ReleaseNote] = parse(ReleaseNotesData.json)

    /// Reads notes.json; entries without an id or date are skipped. Never throws.
    public static func parse(_ json: String) -> [ReleaseNote] {
        guard let data = json.data(using: .utf8),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let releases = root["releases"] as? [Any] else { return [] }
        return releases.compactMap { value -> ReleaseNote? in
            guard let r = value as? [String: Any],
                  let id = r["id"] as? String, !id.isEmpty,
                  let date = r["date"] as? String, !date.isEmpty else { return nil }
            let platforms = (r["platforms"] as? [Any])?.compactMap { $0 as? String } ?? []
            var items: [String: [String]] = [:]
            for (lang, list) in (r["items"] as? [String: Any]) ?? [:] {
                let lines = ((list as? [Any]) ?? []).compactMap { $0 as? String }
                    .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                items[lang] = lines
            }
            return ReleaseNote(id: id, date: date, platforms: platforms, items: items)
        }
    }

    public static func filter(_ notes: [ReleaseNote], platform: String) -> [ReleaseNote] {
        notes.filter { $0.applies(to: platform) }
    }

    /// The entries newer than `lastSeen` (one platform's notes, newest first):
    /// those above it in the list. An id no longer in the list falls back to
    /// its date (ids start with YYYY-MM-DD); no last seen id: all of them.
    /// At most `maxShown`.
    public static func since(_ notes: [ReleaseNote], lastSeen: String?) -> [ReleaseNote] {
        guard let lastSeen, !lastSeen.trimmingCharacters(in: .whitespaces).isEmpty else {
            return Array(notes.prefix(maxShown))
        }
        if let index = notes.firstIndex(where: { $0.id == lastSeen }) {
            return Array(notes.prefix(min(index, maxShown)))
        }
        let day = String(lastSeen.prefix(10))
        guard day.count == 10, day.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return [] }
        return Array(notes.filter { $0.date > day }.prefix(maxShown))
    }

    /// What to do at start: the entries to show now, and the id to remember (nil: keep the stored one).
    public struct Decision: Equatable, Sendable {
        public let show: [ReleaseNote]
        public let remember: String?
    }

    /// A fresh install (no settings yet) shows nothing and remembers the
    /// newest id. After an update the entries since the remembered id are
    /// shown; an install from before this feature (settings, but no id) sees
    /// the entries it carries. Nothing new: only the id is brought up to date.
    public static func atStart(_ notes: [ReleaseNote], lastSeen: String?, settingsExisted: Bool) -> Decision {
        guard let newest = notes.first?.id else { return Decision(show: [], remember: nil) }
        let remember = newest == lastSeen ? nil : newest
        if !settingsExisted { return Decision(show: [], remember: remember) }
        return Decision(show: since(notes, lastSeen: lastSeen), remember: remember)
    }
}
