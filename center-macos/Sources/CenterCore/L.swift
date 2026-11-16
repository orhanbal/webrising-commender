import Foundation

/// Interface language. The Turkish text written in the code is the key; the
/// tables (LStrings.swift, the same texts as the Windows app) hold the other
/// languages. A missing entry falls back to the Turkish text, so nothing is
/// ever shown empty. Terminal output, logs, paths and system errors are never
/// passed through here.
public enum L {
    /// Supported languages, in menu order: code and native name.
    public static let languages: [(code: String, name: String)] = [
        ("en", "English"), ("tr", "Türkçe"), ("de", "Deutsch"),
        ("pt-BR", "Português (Brasil)"), ("es", "Español"), ("fr", "Français"),
    ]

    private static let lock = NSLock()
    private static var active: [String: String] = [:]
    private static var code = "tr"
    private static var cache: [String: [String: String]] = [:]

    /// The language in use ("tr" until `use` is called).
    public static var current: String { lock.lock(); defer { lock.unlock() }; return code }

    /// Locale for dates and numbers in the interface language.
    public static var locale: Locale {
        Locale(identifier: current == "tr" ? "tr_TR" : current.replacingOccurrences(of: "-", with: "_"))
    }

    /// The language for a setting ("system", nil or a code) and the system's
    /// preferred languages; English when none of them is supported.
    public static func resolve(_ setting: String?, preferred: [String] = Locale.preferredLanguages) -> String {
        if let setting, let m = match(setting) { return m }
        for tag in preferred { if let m = match(tag) { return m } }
        return "en"
    }

    /// Supported code for a language tag ("de-AT" → "de", "pt_PT" → "pt-BR").
    public static func match(_ tag: String) -> String? {
        let t = tag.replacingOccurrences(of: "_", with: "-").lowercased()
        if t.isEmpty || t == "system" { return nil }
        if let exact = languages.first(where: { $0.code.lowercased() == t }) { return exact.code }
        let base = String(t.split(separator: "-").first ?? "")
        if base == "pt" { return "pt-BR" }
        return languages.first(where: { $0.code.lowercased() == base })?.code
    }

    /// Switch the interface language; texts read after this are in `language`.
    public static func use(_ language: String) {
        let next = match(language) ?? "en"
        let t = next == "tr" ? [:] : table(next)
        lock.lock(); code = next; active = t; lock.unlock()
    }

    /// The translation table of a language (empty for Turkish, the source).
    public static func table(_ language: String) -> [String: String] {
        lock.lock(); defer { lock.unlock() }
        if let t = cache[language] { return t }
        guard let json = LStrings.tables[language], let data = json.data(using: .utf8),
              let t = (try? JSONSerialization.jsonObject(with: data)) as? [String: String] else { return [:] }
        cache[language] = t
        return t
    }

    /// The text in the interface language.
    public static func t(_ source: String) -> String {
        lock.lock(); defer { lock.unlock() }
        return active[source] ?? source
    }

    /// `source` with {0}, {1}… filled in, in the interface language.
    public static func f(_ source: String, _ args: Any...) -> String { fill(t(source), args) }

    /// `source` translated into `language` regardless of the interface language.
    public static func inLanguage(_ language: String, _ source: String) -> String {
        language == "tr" ? source : (table(language)[source] ?? source)
    }

    /// {n} → args[n]; {{ and }} → literal braces.
    public static func fill(_ template: String, _ args: [Any]) -> String {
        var out = ""
        var i = template.startIndex
        while i < template.endIndex {
            let c = template[i]
            let next = template.index(after: i)
            if c == "{", next < template.endIndex, template[next] == "{" { out.append("{"); i = template.index(after: next); continue }
            if c == "}", next < template.endIndex, template[next] == "}" { out.append("}"); i = template.index(after: next); continue }
            if c == "{", let close = template[next...].firstIndex(of: "}"),
               let n = Int(template[next..<close]), n >= 0, n < args.count {
                out.append(text(args[n]))
                i = template.index(after: close)
                continue
            }
            out.append(c)
            i = next
        }
        return out
    }

    private static func text(_ value: Any) -> String {
        if let s = value as? String { return s }
        if let s = value as? Substring { return String(s) }
        return String(describing: value)
    }
}
