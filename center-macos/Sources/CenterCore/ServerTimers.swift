import Foundation

// Scheduled tasks on a server (server.timers and friends in the core):
// systemd timers, disabled ones included, and cron read only. The same
// logic as the Windows app (center-windows/Core/ServerTimers.cs).

/// What WECOMMANDER wrote into a timer it created: the form's fields.
public struct ManagedTimer: Decodable, Equatable, Hashable, Sendable {
    public let name: String
    public let description: String
    public let command: String
    public let user: String
    public let calendar: String
}

/// One systemd timer and the service it starts. Times are unix seconds.
public struct ServerTimer: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public var unit: String
    public var scope: String
    public var description: String
    public var unitFileState: String
    public var activeState: String
    public var subState: String
    public var calendar: [String]
    public var monotonic: [String]
    public var schedule: String
    public var nextRun: Int64?
    public var lastRun: Int64?
    public var service: String
    public var serviceDescription: String
    public var command: String
    public var user: String
    public var result: String
    public var exitStatus: Int?
    public var lastExit: Int64?
    public var serviceState: String
    public var fragmentPath: String
    public var persistent: Bool
    public var managed: ManagedTimer?

    public var id: String { scope + ":" + unit }

    enum CodingKeys: String, CodingKey {
        case unit, scope, description, unitFileState, activeState, subState, calendar, monotonic, schedule, nextRun, lastRun
        case service, serviceDescription, command, user, result, exitStatus, lastExit, serviceState, fragmentPath, persistent, managed
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        unit = try c.decodeIfPresent(String.self, forKey: .unit) ?? ""
        scope = try c.decodeIfPresent(String.self, forKey: .scope) ?? "system"
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        unitFileState = try c.decodeIfPresent(String.self, forKey: .unitFileState) ?? ""
        activeState = try c.decodeIfPresent(String.self, forKey: .activeState) ?? ""
        subState = try c.decodeIfPresent(String.self, forKey: .subState) ?? ""
        calendar = try c.decodeIfPresent([String].self, forKey: .calendar) ?? []
        monotonic = try c.decodeIfPresent([String].self, forKey: .monotonic) ?? []
        schedule = try c.decodeIfPresent(String.self, forKey: .schedule) ?? ""
        nextRun = try c.decodeIfPresent(Int64.self, forKey: .nextRun)
        lastRun = try c.decodeIfPresent(Int64.self, forKey: .lastRun)
        service = try c.decodeIfPresent(String.self, forKey: .service) ?? ""
        serviceDescription = try c.decodeIfPresent(String.self, forKey: .serviceDescription) ?? ""
        command = try c.decodeIfPresent(String.self, forKey: .command) ?? ""
        user = try c.decodeIfPresent(String.self, forKey: .user) ?? ""
        result = try c.decodeIfPresent(String.self, forKey: .result) ?? ""
        exitStatus = try c.decodeIfPresent(Int.self, forKey: .exitStatus)
        lastExit = try c.decodeIfPresent(Int64.self, forKey: .lastExit)
        serviceState = try c.decodeIfPresent(String.self, forKey: .serviceState) ?? ""
        fragmentPath = try c.decodeIfPresent(String.self, forKey: .fragmentPath) ?? ""
        persistent = try c.decodeIfPresent(Bool.self, forKey: .persistent) ?? false
        managed = try c.decodeIfPresent(ManagedTimer.self, forKey: .managed)
    }

    public var isSystem: Bool { scope != "user" }
    public var isManaged: Bool { managed != nil }
    public var isActive: Bool { activeState == "active" }
    public var isEnabled: Bool { ["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"].contains(unitFileState) }
    public var isMasked: Bool { unitFileState.hasPrefix("masked") }
    public var isStatic: Bool { ["static", "generated", "transient", "indirect"].contains(unitFileState) }
}

/// One cron line, or a script in /etc/cron.daily and the like (schedule "daily").
public struct CronEntry: Decodable, Equatable, Hashable, Sendable {
    public let source: String
    public let schedule: String
    public let user: String
    public let command: String

    /// A file in /etc/cron.d this user may not read.
    public var unreadable: Bool { schedule.isEmpty && command.isEmpty }
}

public struct ServerTimers: Decodable, Equatable, Sendable {
    public var privilege: String
    public var loginUser: String
    public var systemd: Bool
    public var timers: [ServerTimer]
    public var cron: [CronEntry]
    /// The login user's crontab: ok, empty, not-readable, missing.
    public var crontab: String
    public var crontabMessage: String

    enum CodingKeys: String, CodingKey { case privilege, loginUser, systemd, timers, cron, crontab, crontabMessage }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        privilege = try c.decodeIfPresent(String.self, forKey: .privilege) ?? ""
        loginUser = try c.decodeIfPresent(String.self, forKey: .loginUser) ?? ""
        systemd = try c.decodeIfPresent(Bool.self, forKey: .systemd) ?? false
        timers = try c.decodeIfPresent([ServerTimer].self, forKey: .timers) ?? []
        cron = try c.decodeIfPresent([CronEntry].self, forKey: .cron) ?? []
        crontab = try c.decodeIfPresent(String.self, forKey: .crontab) ?? ""
        crontabMessage = try c.decodeIfPresent(String.self, forKey: .crontabMessage) ?? ""
    }

    public var canChange: Bool { ServerPrivilege.canChange(privilege) }
}

/// What a change did: the exact commands that ran and their output.
public struct TimerResult: Decodable, Equatable, Sendable {
    public let command: String
    public let ok: Bool
    public let output: String
}

public struct TimerLogs: Decodable, Equatable, Sendable {
    public let command: String
    public let lines: [String]
    public let note: String
}

/// The create / edit form.
public struct TimerSpec: Equatable, Sendable {
    public var name: String
    public var description: String
    public var command: String
    public var user: String
    public var calendar: String

    public init(name: String, description: String, command: String, user: String, calendar: String) {
        self.name = name; self.description = description; self.command = command; self.user = user; self.calendar = calendar
    }

    public var trimmed: TimerSpec {
        let ws = CharacterSet.whitespacesAndNewlines
        return TimerSpec(name: name.trimmingCharacters(in: ws), description: description.trimmingCharacters(in: ws),
                         command: command.trimmingCharacters(in: ws), user: user.trimmingCharacters(in: ws),
                         calendar: calendar.trimmingCharacters(in: ws))
    }
}

/// What the timers page shows, the checks of its form, and the commands it confirms (the same the core runs).
public enum TimerView {
    public static let managedMark = "# Managed by WECOMMANDER"
    static let unitDir = "/etc/systemd/system"

    /// active, passive, failed or masked: the badge.
    public static func state(_ t: ServerTimer) -> String {
        if t.isMasked { return "masked" }
        if t.activeState == "failed" { return "failed" }
        return t.isActive ? "active" : "passive"
    }

    public static func stateText(_ t: ServerTimer) -> String {
        switch state(t) {
        case "active": return L.t("Etkin")
        case "failed": return L.t("Hatalı")
        case "masked": return L.t("Maskeli")
        default: return L.t("Pasif")
        }
    }

    /// Enable is offered unless it is enabled and running already (never for masked or static ones).
    public static func canEnable(_ t: ServerTimer) -> Bool { t.isSystem && !t.isMasked && !t.isStatic && !(t.isEnabled && t.isActive) }
    public static func canDisable(_ t: ServerTimer) -> Bool { t.isSystem && !t.isMasked && (t.isEnabled || t.isActive) }
    public static func canRunNow(_ t: ServerTimer) -> Bool { t.isSystem && !t.isMasked }
    public static func canStop(_ t: ServerTimer) -> Bool {
        t.isSystem && ["active", "activating", "reloading"].contains(t.serviceState)
    }

    /// The schedule in words: calendar expressions as they are, monotonic ones explained.
    public static func schedule(_ t: ServerTimer) -> String {
        var parts: [String] = t.calendar
        for m in t.monotonic {
            guard let eq = m.firstIndex(of: "=") else { parts.append(m); continue }
            let key = String(m[m.startIndex..<eq])
            let value = String(m[m.index(after: eq)...])
            switch key {
            case "OnBootUSec": parts.append(L.f("açılıştan {0} sonra", value))
            case "OnStartupUSec": parts.append(L.f("systemd başladıktan {0} sonra", value))
            case "OnActiveUSec": parts.append(L.f("zamanlayıcı başladıktan {0} sonra", value))
            case "OnUnitActiveUSec": parts.append(L.f("son başlangıçtan {0} sonra", value))
            case "OnUnitInactiveUSec": parts.append(L.f("son çalışma bitince {0} sonra", value))
            default: parts.append(m)
            }
        }
        if parts.isEmpty { return t.schedule.isEmpty ? "—" : t.schedule }
        return parts.joined(separator: " · ")
    }

    /// A unix time in local time ("17.11.2026 14:30"); "—" for never.
    public static func time(_ unix: Int64?, timeZone: TimeZone = .current) -> String {
        guard let u = unix, u > 0 else { return "—" }
        let f = DateFormatter()
        f.locale = L.locale
        f.timeZone = timeZone
        f.dateStyle = .short
        f.timeStyle = .short
        return f.string(from: Date(timeIntervalSince1970: TimeInterval(u)))
    }

    /// "2 sa 0 dk sonra" / "40 sn önce" next to a time.
    public static func relative(_ unix: Int64?, now: Date) -> String {
        guard let u = unix, u > 0 else { return "" }
        let diff = u - Int64(now.timeIntervalSince1970)
        if diff >= 0 { return L.f("{0} sonra", Sizes.duration(UInt64(diff))) }
        return L.f("{0} önce", Sizes.duration(UInt64(-diff)))
    }

    /// The last run's result: "success", "exit-code (1)".
    public static func result(_ t: ServerTimer) -> String {
        if t.result.isEmpty { return "—" }
        if let code = t.exitStatus, code != 0 || t.result != "success" { return t.result + " (" + String(code) + ")" }
        return t.result
    }

    /// System timers first, then the login user's; by name.
    public static func ordered(_ timers: [ServerTimer], filter: String = "") -> [ServerTimer] {
        let f = filter.trimmingCharacters(in: .whitespaces)
        let shown = timers.filter { t in
            if f.isEmpty { return true }
            let fields = [t.unit, t.description, t.command, t.user]
            return fields.contains { $0.range(of: f, options: .caseInsensitive) != nil }
        }
        return shown.sorted { a, b in
            if a.isSystem != b.isSystem { return a.isSystem }
            return a.unit < b.unit
        }
    }

    // MARK: the form

    static func isLower(_ c: Character) -> Bool { c >= "a" && c <= "z" }
    static func isDigit(_ c: Character) -> Bool { c >= "0" && c <= "9" }
    static func isLetter(_ c: Character) -> Bool { isLower(c) || (c >= "A" && c <= "Z") }
    static func hasControl(_ s: String) -> Bool {
        s.unicodeScalars.contains { $0.value < 0x20 || ($0.value >= 0x7F && $0.value <= 0x9F) }
    }

    /// Why the form cannot be sent, or nil (the core checks the same, and the calendar with systemd-analyze).
    public static func check(_ s: TimerSpec) -> String? {
        let t = s.trimmed
        let name = t.name
        let first: Character = name.first ?? " "
        let nameChars: Bool = name.allSatisfy { c in isLower(c) || isDigit(c) || c == "_" || c == "." || c == "-" }
        let nameEnd: Bool = name.hasSuffix(".timer") || name.hasSuffix(".service") || name.hasSuffix(".")
        let nameOk: Bool = !name.isEmpty && name.count <= 64 && (isLower(first) || isDigit(first)) && nameChars && !nameEnd
        if !nameOk {
            return L.t("Ad geçersiz: küçük harf, rakam, nokta, alt çizgi ve tire kullanılabilir; harf ya da rakamla başlar, en çok 64 karakter.")
        }
        if t.description.count > 200 || hasControl(t.description) || t.description.hasSuffix("\\") {
            return L.t("Açıklama tek satır olmalı (en çok 200 karakter).")
        }
        if t.command.isEmpty || t.command.count > 2000 || hasControl(t.command) {
            return L.t("Komut boş olamaz ve tek satır olmalı (en çok 2000 karakter).")
        }
        let u = t.user
        let userFirst: Character = u.first ?? " "
        let userChars: Bool = u.allSatisfy { c in isLower(c) || isDigit(c) || c == "_" || c == "-" }
        let userOk: Bool = !u.isEmpty && u.count <= 32 && (isLower(userFirst) || userFirst == "_") && userChars
        if !userOk { return L.t("Kullanıcı adı geçersiz.") }
        let cal = t.calendar
        let calChars: Bool = cal.allSatisfy { c in isLetter(c) || isDigit(c) || " *-:,./~+_".contains(c) }
        let calOk: Bool = !cal.isEmpty && cal.count <= 200 && !cal.hasPrefix("-") && calChars
        if !calOk {
            return L.t("Takvim ifadesi geçersiz (örnek: daily, hourly, Mon *-*-* 03:00, *-*-* 04:30:00).")
        }
        return nil
    }

    // MARK: commands (the same text the core runs and returns)

    public static func quote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// A unit as one shell word: plain when safe, else quoted.
    public static func word(_ unit: String) -> String {
        let safe = unit.allSatisfy { isLetter($0) || isDigit($0) || "@._:-".contains($0) }
        return safe ? unit : quote(unit)
    }

    /// enable, disable, start-now (runs the service now), stop (stops the running service); nil for anything else.
    public static func actionCommand(_ t: ServerTimer, _ action: String) -> String? {
        switch action {
        case "enable": return "systemctl enable --now " + word(t.unit)
        case "disable": return "systemctl disable --now " + word(t.unit)
        case "start-now": return "systemctl start --no-block " + word(t.service)
        case "stop": return "systemctl stop " + word(t.service)
        default: return nil
        }
    }

    public static func logsCommand(_ t: ServerTimer, lines: Int) -> String {
        "journalctl -u " + word(t.service) + " -n " + String(lines) + " --no-pager -o short-iso"
    }

    /// ExecStart= for a command: run by /bin/sh -c, escaped for systemd's quoting, $ and % specifiers.
    public static func execStart(_ command: String) -> String {
        var out = "/bin/sh -c \""
        for c in command {
            switch c {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "$": out += "$$"
            case "%": out += "%%"
            default: out.append(c)
            }
        }
        return out + "\""
    }

    public static func serviceFile(_ s: TimerSpec) -> String {
        let about = s.description.replacingOccurrences(of: "%", with: "%%")
        var text = managedMark + "\n[Unit]\nDescription=" + about + "\n\n"
        text += "[Service]\nType=oneshot\nUser=" + s.user + "\nExecStart=" + execStart(s.command) + "\n"
        return text
    }

    public static func timerFile(_ s: TimerSpec) -> String {
        let about = s.description.replacingOccurrences(of: "%", with: "%%")
        var text = managedMark + "\n[Unit]\nDescription=" + about + "\n\n"
        text += "[Timer]\nOnCalendar=" + s.calendar + "\nPersistent=true\nUnit=" + s.name + ".service\n\n"
        text += "[Install]\nWantedBy=timers.target\n"
        return text
    }

    /// What a create (or edit) runs: write both files, reload, then enable --now (edit: try-restart).
    public static func writeCommand(_ spec: TimerSpec, edit: Bool) -> String {
        let s = spec.trimmed
        let service: String = "printf '%s' " + quote(serviceFile(s)) + " | tee " + unitDir + "/" + s.name + ".service >/dev/null"
        let timer: String = "printf '%s' " + quote(timerFile(s)) + " | tee " + unitDir + "/" + s.name + ".timer >/dev/null"
        let start: String = edit ? "systemctl try-restart " + s.name + ".timer" : "systemctl enable --now " + s.name + ".timer"
        return [service, timer, "systemctl daemon-reload", start].joined(separator: "\n")
    }

    /// What deleting a WECOMMANDER timer runs.
    public static func deleteCommand(_ name: String) -> String {
        let files: String = "rm -f " + unitDir + "/" + name + ".timer " + unitDir + "/" + name + ".service"
        return ["systemctl disable --now " + name + ".timer", files, "systemctl daemon-reload"].joined(separator: "\n")
    }

    /// The name of a WECOMMANDER timer, from its unit.
    public static func nameOf(_ t: ServerTimer) -> String {
        if let m = t.managed { return m.name }
        return t.unit.hasSuffix(".timer") ? String(t.unit.dropLast(6)) : t.unit
    }

    /// The crontab's state in words; empty when it was read.
    public static func crontabNote(_ s: ServerTimers) -> String {
        switch s.crontab {
        case "empty": return L.f("{0} kullanıcısının crontab'ı boş.", s.loginUser)
        case "not-readable": return L.f("{0} kullanıcısının crontab'ı okunamadı (izin yok).", s.loginUser)
        case "missing": return L.t("Sunucuda crontab komutu yok.")
        default: return ""
        }
    }
}
