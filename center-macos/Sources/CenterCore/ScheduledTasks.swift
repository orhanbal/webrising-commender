import Foundation

// WECOMMANDER's own scheduled tasks, stored on the WECOMMANDER server (not in
// launchd or cron): the models of docs/SCHEDULED_TASKS.md, the editor's
// checks, schedules in words, and the Center runner that runs the tasks of
// saved SSH hosts through the core's `hosts.exec`. The same logic as the
// Windows app (center-windows/Core/ScheduledTasks.cs).

/// Where a task runs: an agent device, or a saved SSH host run by the Center that saved it.
public struct TaskTarget: Decodable, Equatable, Hashable, Sendable {
    public var kind: String
    public var deviceId: String?
    public var centerId: String?
    public var hostId: String?
    public var hostLabel: String?

    public init(kind: String, deviceId: String? = nil, centerId: String? = nil, hostId: String? = nil, hostLabel: String? = nil) {
        self.kind = kind; self.deviceId = deviceId; self.centerId = centerId; self.hostId = hostId; self.hostLabel = hostLabel
    }

    public var isSsh: Bool { kind == "ssh" }

    public static func device(_ deviceId: String) -> TaskTarget { TaskTarget(kind: "device", deviceId: deviceId) }

    public static func ssh(centerId: String, hostId: String, hostLabel: String) -> TaskTarget {
        TaskTarget(kind: "ssh", centerId: centerId, hostId: hostId, hostLabel: hostLabel)
    }

    public func json() -> [String: Any] {
        if isSsh {
            return ["kind": "ssh", "centerId": centerId ?? "", "hostId": hostId ?? "", "hostLabel": hostLabel ?? ""]
        }
        return ["kind": "device", "deviceId": deviceId ?? ""]
    }

    public func sameAs(_ other: TaskTarget?) -> Bool {
        guard let other, other.kind == kind else { return false }
        if isSsh { return other.centerId == centerId && other.hostId == hostId }
        return other.deviceId == deviceId
    }
}

/// When a task runs: cron (5 fields), every N minutes, or once.
public struct TaskSchedule: Decodable, Equatable, Sendable {
    public var kind: String
    public var expr: String?
    public var minutes: Int?
    public var at: Date?

    public init(kind: String, expr: String? = nil, minutes: Int? = nil, at: Date? = nil) {
        self.kind = kind; self.expr = expr; self.minutes = minutes; self.at = at
    }

    public static func cron(_ expr: String) -> TaskSchedule {
        TaskSchedule(kind: "cron", expr: expr.trimmingCharacters(in: .whitespaces))
    }

    public static func interval(_ minutes: Int) -> TaskSchedule { TaskSchedule(kind: "interval", minutes: minutes) }

    public static func once(_ at: Date) -> TaskSchedule { TaskSchedule(kind: "once", at: at) }

    /// Every day at hour:minute (in the task's time zone).
    public static func daily(hour: Int, minute: Int) -> TaskSchedule {
        cron(String(minute) + " " + String(hour) + " * * *")
    }

    /// Every week on `weekday` (0 = Sunday, as in cron) at hour:minute.
    public static func weekly(weekday: Int, hour: Int, minute: Int) -> TaskSchedule {
        cron(String(minute) + " " + String(hour) + " * * " + String(weekday))
    }

    public func json() -> [String: Any] {
        switch kind {
        case "interval": return ["kind": "interval", "minutes": minutes ?? 0]
        case "once": return ["kind": "once", "at": at.map(ScheduleText.utc) ?? ""]
        default: return ["kind": "cron", "expr": expr ?? ""]
        }
    }
}

/// One run of a task.
public struct TaskRun: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let taskId: String
    public let scheduledFor: Date?
    public let startedAt: Date?
    public let finishedAt: Date?
    public let status: String
    public let exitCode: Int?
    public let output: String?
    public let runner: String?
    public let trigger: String?
    public let error: String?

    enum CodingKeys: String, CodingKey { case id, taskId, scheduledFor, startedAt, finishedAt, status, exitCode, output, runner, trigger, error }

    public init(id: String, taskId: String = "", status: String = "", exitCode: Int? = nil, output: String? = nil, error: String? = nil) {
        self.id = id; self.taskId = taskId; self.status = status; self.exitCode = exitCode; self.output = output; self.error = error
        scheduledFor = nil; startedAt = nil; finishedAt = nil; runner = nil; trigger = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId) ?? ""
        scheduledFor = try c.decodeIfPresent(Date.self, forKey: .scheduledFor)
        startedAt = try c.decodeIfPresent(Date.self, forKey: .startedAt)
        finishedAt = try c.decodeIfPresent(Date.self, forKey: .finishedAt)
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? ""
        exitCode = try c.decodeIfPresent(Int.self, forKey: .exitCode)
        output = try c.decodeIfPresent(String.self, forKey: .output)
        runner = try c.decodeIfPresent(String.self, forKey: .runner)
        trigger = try c.decodeIfPresent(String.self, forKey: .trigger)
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }

    /// The time shown for the run: when it finished, started or was due.
    public var shownAt: Date? { finishedAt ?? startedAt ?? scheduledFor }
}

public struct ScheduledTask: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let description: String?
    public let target: TaskTarget
    public let command: String
    public let schedule: TaskSchedule
    public let timezone: String?
    public var enabled: Bool
    public let timeoutSec: Int
    public let notify: String
    public let createdBy: String?
    public let nextRunAt: Date?
    public let lastRun: TaskRun?

    enum CodingKeys: String, CodingKey { case id, name, description, target, command, schedule, timezone, enabled, timeoutSec, notify, createdBy, nextRunAt, lastRun }

    public init(id: String, name: String = "", target: TaskTarget, command: String, schedule: TaskSchedule = .cron("0 3 * * *"),
                timeoutSec: Int = ScheduledTaskDraft.defaultTimeout, enabled: Bool = true) {
        self.id = id; self.name = name; self.target = target; self.command = command; self.schedule = schedule
        self.timeoutSec = timeoutSec; self.enabled = enabled
        description = nil; timezone = nil; notify = "failure"; createdBy = nil; nextRunAt = nil; lastRun = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        description = try c.decodeIfPresent(String.self, forKey: .description)
        target = try c.decodeIfPresent(TaskTarget.self, forKey: .target) ?? TaskTarget(kind: "device")
        command = try c.decodeIfPresent(String.self, forKey: .command) ?? ""
        schedule = try c.decodeIfPresent(TaskSchedule.self, forKey: .schedule) ?? TaskSchedule(kind: "cron")
        timezone = try c.decodeIfPresent(String.self, forKey: .timezone)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        timeoutSec = try c.decodeIfPresent(Int.self, forKey: .timeoutSec) ?? ScheduledTaskDraft.defaultTimeout
        notify = try c.decodeIfPresent(String.self, forKey: .notify) ?? "failure"
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy)
        nextRunAt = try c.decodeIfPresent(Date.self, forKey: .nextRunAt)
        lastRun = try c.decodeIfPresent(TaskRun.self, forKey: .lastRun)
    }
}

/// A queued SSH run this Center claimed (GET /api/center/scheduled-runs/claim).
public struct ClaimedRun: Decodable, Equatable, Sendable {
    public let run: TaskRun
    public let task: ScheduledTask

    public init(run: TaskRun, task: ScheduledTask) { self.run = run; self.task = task }
}

/// A command's result on a remote host: exit code (nil when it never finished), its output and why it failed.
public struct RemoteExecResult: Equatable, Sendable {
    public let exitCode: Int?
    public let output: String
    public let error: String?
    public let timedOut: Bool

    public init(exitCode: Int?, output: String, error: String?, timedOut: Bool = false) {
        self.exitCode = exitCode; self.output = output; self.error = error; self.timedOut = timedOut
    }
}

/// What the Center reports for a run it executed.
public struct ScheduledRunResult: Equatable, Sendable {
    public let status: String
    public let exitCode: Int?
    public let output: String
    public let error: String?

    public init(status: String, exitCode: Int?, output: String, error: String?) {
        self.status = status; self.exitCode = exitCode; self.output = output; self.error = error
    }

    /// Succeeded only when the command ran to the end with exit code 0.
    public static func from(_ r: RemoteExecResult) -> ScheduledRunResult {
        let ok = r.error == nil && !r.timedOut && r.exitCode == 0
        return ScheduledRunResult(status: ok ? "succeeded" : "failed", exitCode: r.exitCode, output: RunOutput.cap(r.output), error: r.error)
    }

    public static func failed(_ error: String) -> ScheduledRunResult {
        ScheduledRunResult(status: "failed", exitCode: nil, output: "", error: error)
    }

    public func json() -> [String: Any] {
        var o: [String: Any] = ["status": status, "output": output]
        o["exitCode"] = exitCode.map { $0 as Any } ?? NSNull()
        if let error { o["error"] = error }
        return o
    }
}

/// The task fields the create / edit form fills in.
public struct ScheduledTaskDraft: Equatable, Sendable {
    public static let defaultTimeout = 600
    public var name = ""
    public var description: String?
    public var target: TaskTarget?
    public var command = ""
    public var schedule = TaskSchedule.daily(hour: 3, minute: 0)
    public var timezone = ScheduleText.defaultTimeZone()
    public var enabled = true
    public var timeoutSec = ScheduledTaskDraft.defaultTimeout
    public var notify = "failure"

    public init() {}

    public init(_ t: ScheduledTask) {
        name = t.name
        description = t.description
        target = t.target
        command = t.command
        schedule = t.schedule
        let zone = (t.timezone ?? "").trimmingCharacters(in: .whitespaces)
        timezone = zone.isEmpty ? ScheduleText.defaultTimeZone() : zone
        enabled = t.enabled
        timeoutSec = t.timeoutSec
        notify = t.notify
    }

    /// Why the draft cannot be saved (nil: it can).
    public func validate(now: Date) -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.count > 80 { return L.t("Ad 1 ile 80 karakter arasında olmalı.") }
        if target == nil { return L.t("Görevin çalışacağı hedefi seç.") }
        if command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return L.t("Çalıştırılacak komutu yaz.") }
        if command.count > 4000 { return L.t("Komut en fazla 4000 karakter olabilir.") }
        if timeoutSec < 10 || timeoutSec > 3600 { return L.t("Zaman aşımı 10 ile 3600 saniye arasında olmalı.") }
        if !ScheduleText.notifyValues.contains(notify) { return L.t("Bildirim seçimi geçersiz.") }
        switch schedule.kind {
        case "interval":
            let m = schedule.minutes ?? 0
            if m < 5 || m > 10080 { return L.t("Aralık 5 ile 10080 dakika arasında olmalı.") }
        case "once":
            guard let at = schedule.at, at > now else { return L.t("Tek seferlik çalışma zamanı gelecekte olmalı.") }
        default:
            if !CronShape.looksValid(schedule.expr) {
                return L.t("Cron ifadesi beş alandan oluşmalı (dakika saat gün ay haftanın günü).")
            }
        }
        return nil
    }

    /// The POST /api/scheduled-tasks body (PATCH takes the same fields).
    public func json() -> [String: Any] {
        let about = (description ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var o: [String: Any] = [
            "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
            "command": command,
            "schedule": schedule.json(),
            "timezone": timezone,
            "enabled": enabled,
            "timeoutSec": timeoutSec,
            "notify": notify,
        ]
        o["description"] = about.isEmpty ? NSNull() : about
        o["target"] = target.map { $0.json() as Any } ?? NSNull()
        return o
    }
}

public enum CronShape {
    /// A quick shape check (five fields); the server validates fully and the preview shows its message.
    public static func looksValid(_ expr: String?) -> Bool {
        guard let expr else { return false }
        let parts = expr.split(separator: " ", omittingEmptySubsequences: true)
        guard parts.count == 5 else { return false }
        let allowed = CharacterSet(charactersIn: "0123456789*/,-?abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
        for part in parts {
            for scalar in part.unicodeScalars where !allowed.contains(scalar) { return false }
        }
        return true
    }
}

/// The editor's schedule fields for an existing schedule (mode 0 daily, 1 weekly, 2 interval, 3 once, 4 cron).
public struct ScheduleForm: Equatable, Sendable {
    public var mode: Int
    public var hour: Int
    public var minute: Int
    /// 0 = Sunday, as in cron.
    public var weekday: Int
    public var minutes: Int
    public var at: Date?
    public var expr: String
}

/// Schedules in words, run statuses and time zones for the scheduled tasks page.
public enum ScheduleText {
    /// One or two ASCII digits as a number.
    static func small(_ s: Substring) -> Int? {
        guard !s.isEmpty, s.count <= 2, s.allSatisfy({ $0 >= "0" && $0 <= "9" }) else { return nil }
        return Int(s)
    }

    /// The day name used in "Her {0} saat {1}" (0 = Sunday, as in cron).
    public static func day(_ weekday: Int) -> String {
        switch weekday % 7 {
        case 1: return L.t("pazartesi")
        case 2: return L.t("salı")
        case 3: return L.t("çarşamba")
        case 4: return L.t("perşembe")
        case 5: return L.t("cuma")
        case 6: return L.t("cumartesi")
        default: return L.t("pazar")
        }
    }

    /// Days in the week picker order (Monday first; 0 = Sunday).
    public static let weekOrder = [1, 2, 3, 4, 5, 6, 0]

    static func clock(_ hour: Int, _ minute: Int) -> String {
        String(format: "%02d:%02d", hour, minute)
    }

    /// "Her gün saat 03:00", "Her 15 dakikada bir", "Bir kez: 20.11.2026 09:00"; anything else as the cron text.
    public static func describe(_ s: TaskSchedule, timeZone: TimeZone = .current) -> String {
        switch s.kind {
        case "interval":
            let m = s.minutes ?? 0
            if m >= 60 && m % 1440 == 0 { return L.f("Her {0} günde bir", m / 1440) }
            if m >= 60 && m % 60 == 0 { return L.f("Her {0} saatte bir", m / 60) }
            return L.f("Her {0} dakikada bir", m)
        case "once":
            guard let at = s.at else { return L.t("Bir kez") }
            return L.f("Bir kez: {0}", localTime(at, timeZone: timeZone))
        default:
            break
        }
        let expr = (s.expr ?? "").trimmingCharacters(in: .whitespaces)
        let f = expr.split(separator: " ", omittingEmptySubsequences: true)
        if f.count != 5 { return L.f("Gelişmiş (cron): {0}", expr) }
        if let minute = small(f[0]), let hour = small(f[1]), minute < 60, hour < 24, f[3] == "*" {
            let time = clock(hour, minute)
            if f[2] == "*" && f[4] == "*" { return L.f("Her gün saat {0}", time) }
            if f[2] == "*" && f[4] == "1-5" { return L.f("Hafta içi her gün saat {0}", time) }
            if f[2] == "*" && (f[4] == "0,6" || f[4] == "6,0") { return L.f("Hafta sonu her gün saat {0}", time) }
            if f[2] == "*", let d = small(f[4]), d <= 7 { return L.f("Her {0} saat {1}", day(d), time) }
            if f[4] == "*", let dom = small(f[2]), dom >= 1, dom <= 31 { return L.f("Her ayın {0}. günü saat {1}", dom, time) }
        }
        if f[1] == "*" && f[2] == "*" && f[3] == "*" && f[4] == "*" {
            if f[0].hasPrefix("*/"), let every = Int(f[0].dropFirst(2)), every > 0 { return L.f("Her {0} dakikada bir", every) }
            if let minute = small(f[0]), minute < 60 { return L.f("Her saat, {0}. dakikada", minute) }
        }
        return L.f("Gelişmiş (cron): {0}", expr)
    }

    /// The badge text for a run status.
    public static func status(_ status: String?) -> String {
        switch status ?? "" {
        case "succeeded": return L.t("Başarılı")
        case "failed": return L.t("Başarısız")
        case "missed": return L.t("Kaçırıldı")
        case "running": return L.t("Çalışıyor")
        case "queued": return L.t("Sırada")
        case "skipped": return L.t("Atlandı")
        case "cancelled": return L.t("İptal edildi")
        case "": return L.t("Henüz çalışmadı")
        default: return status ?? ""
        }
    }

    /// Badge colour family: good, bad, warn, busy or none.
    public static func tone(_ status: String?) -> String {
        switch status ?? "" {
        case "succeeded": return "good"
        case "failed": return "bad"
        case "missed", "skipped", "cancelled": return "warn"
        case "running", "queued": return "busy"
        default: return "none"
        }
    }

    public static let notifyValues = ["failure", "always", "never"]

    public static func notifyLabel(_ notify: String) -> String {
        switch notify {
        case "always": return L.t("Her çalışmada bildir")
        case "never": return L.t("Bildirme")
        default: return L.t("Yalnız başarısız olunca bildir")
        }
    }

    /// This Mac's IANA time zone; Europe/Istanbul when it has none.
    public static func defaultTimeZone() -> String {
        let id = TimeZone.current.identifier
        return id.contains("/") || id == "UTC" ? id : "Europe/Istanbul"
    }

    /// "20.11.2026 03:00" in this Mac's time; "—" when none.
    public static func localTime(_ date: Date?, timeZone: TimeZone = .current) -> String {
        guard let date else { return "—" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "dd.MM.yyyy HH:mm"
        return f.string(from: date)
    }

    /// "2026-11-20T06:00:00Z": a time as the server takes it.
    public static func utc(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        return f.string(from: date)
    }

    /// The form's fields for an existing schedule.
    public static func form(_ s: TaskSchedule) -> ScheduleForm {
        var form = ScheduleForm(mode: 4, hour: 3, minute: 0, weekday: 1, minutes: 60, at: nil, expr: "")
        switch s.kind {
        case "interval":
            form.mode = 2
            form.minutes = s.minutes ?? 60
            return form
        case "once":
            form.mode = 3
            form.at = s.at
            return form
        default:
            break
        }
        let expr = (s.expr ?? "").trimmingCharacters(in: .whitespaces)
        form.expr = expr
        let f = expr.split(separator: " ", omittingEmptySubsequences: true)
        if f.count == 5, let minute = small(f[0]), let hour = small(f[1]), f[2] == "*", f[3] == "*", minute < 60, hour < 24 {
            if f[4] == "*" {
                form.mode = 0; form.hour = hour; form.minute = minute
            } else if let d = small(f[4]), d <= 7 {
                form.mode = 1; form.hour = hour; form.minute = minute; form.weekday = d % 7
            }
        }
        return form
    }

    /// Who may change scheduled tasks: owner and admin (an unknown role is left to the server, which answers 403).
    public static func canEdit(role: String?) -> Bool {
        guard let role, !role.isEmpty else { return true }
        return role == "owner" || role == "admin"
    }

    public static var readOnly: String {
        L.t("Zamanlanmış görevleri yalnız sahip ve yöneticiler değiştirebilir; sen yalnız görüntüleyebilirsin.")
    }

    /// A gateway error on the scheduled tasks page in words.
    public static func error(_ e: Error) -> String {
        guard let g = e as? GatewayError else { return e.localizedDescription }
        if g.status == 403 { return readOnly }
        if g.status == 404 && g.code.isEmpty { return L.t("Bu sunucu zamanlanmış görevleri henüz desteklemiyor.") }
        if g.status == 400, let extra = g.serverMessage, !extra.trimmingCharacters(in: .whitespaces).isEmpty {
            return g.message + " " + extra
        }
        return g.message
    }
}

/// Output kept for a run: at most 64 KiB of UTF-8, the end kept (the error is usually last).
public enum RunOutput {
    public static let maxBytes = 64 * 1024

    static func utf8Length(_ scalar: Unicode.Scalar) -> Int {
        let v = scalar.value
        if v < 0x80 { return 1 }
        if v < 0x800 { return 2 }
        if v < 0x10000 { return 3 }
        return 4
    }

    public static func cap(_ text: String, maxBytes: Int = RunOutput.maxBytes) -> String {
        if text.utf8.count <= maxBytes { return text }
        let marker = "…\n"
        let budget = maxBytes - marker.utf8.count
        let scalars = text.unicodeScalars
        var used = 0
        var start = scalars.endIndex
        while start > scalars.startIndex {
            let previous = scalars.index(before: start)
            let bytes = utf8Length(scalars[previous])
            if used + bytes > budget { break }
            used += bytes
            start = previous
        }
        let tail = String.UnicodeScalarView(scalars[start...])
        return marker + String(tail)
    }
}

/// What the core's `hosts.exec` answers.
public struct HostExecReply: Decodable, Equatable, Sendable {
    public let exitCode: Int?
    public let output: String
    public let timedOut: Bool
    public let truncated: Bool

    enum CodingKeys: String, CodingKey { case exitCode, output, timedOut, truncated }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        exitCode = try c.decodeIfPresent(Int.self, forKey: .exitCode)
        output = try c.decodeIfPresent(String.self, forKey: .output) ?? ""
        timedOut = try c.decodeIfPresent(Bool.self, forKey: .timedOut) ?? false
        truncated = try c.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

/// Texts for wecommander-core's `hosts.exec` (docs/CORE_PROTOCOL.md): its
/// errors start with a code (needs_credential, host_key_unknown, ...).
public enum HostExecText {
    public static var needsSavedLogin: String {
        L.t("Bu sunucuya parola sorulmadan bağlanılamıyor. Zamanlanmış görevler için girişi bu bilgisayarda kaydet (parolayı sakla ya da SSH anahtarı kullan).")
    }

    /// The error code and the rest of the core's error text.
    public static func split(_ raw: String) -> (code: String, detail: String) {
        guard let r = raw.range(of: ": "), r.lowerBound > raw.startIndex else { return ("", raw) }
        let code = raw[raw.startIndex..<r.lowerBound]
        let valid = code.allSatisfy { ($0 >= "a" && $0 <= "z") || $0 == "_" }
        if !valid { return ("", raw) }
        return (String(code), String(raw[r.upperBound...]))
    }

    public static func error(_ raw: String) -> String {
        let (code, detail) = split(raw)
        let trimmed = detail.trimmingCharacters(in: .whitespaces)
        let why = trimmed.isEmpty ? "" : " (" + CoreText.turkish(detail) + ")"
        switch code {
        case "needs_credential": return needsSavedLogin + why
        case "host_key_unknown": return L.t("Bu sunucunun anahtarı henüz onaylanmadı. Bir kez terminalden bağlanıp anahtarı onayla.")
        case "host_key_changed":
            return L.t("Bu sunucunun anahtarı değişti; komut çalıştırılmadı. Sunucuyu yeniden kurmadıysan araya biri girmiş olabilir; terminalden bağlanıp kontrol et.")
        case "host_not_found": return L.t("Bu sunucu bu bilgisayarın kayıtlı sunucuları arasında yok (silinmiş olabilir).")
        case "not_ssh": return L.t("Zamanlanmış görevler yalnız SSH ile bağlanılan sunucularda çalışır.")
        case "connect_failed": return L.t("Sunucuya bağlanılamadı: ") + CoreText.turkish(detail)
        default: return L.t("Komut çalıştırılamadı: ") + CoreText.turkish(detail)
        }
    }

    /// The run as the Center reports it.
    public static func result(exitCode: Int?, output: String, timedOut: Bool, timeoutSec: Int) -> RemoteExecResult {
        if timedOut {
            return RemoteExecResult(exitCode: nil, output: output,
                                    error: L.f("Zaman aşımı: komut {0} saniyede bitmedi ve durduruldu.", timeoutSec), timedOut: true)
        }
        guard let exitCode else {
            return RemoteExecResult(exitCode: nil, output: output,
                                    error: L.t("Komut çıkış kodu vermeden bitti (bir sinyalle durdurulmuş olabilir)."))
        }
        return RemoteExecResult(exitCode: exitCode, output: output, error: nil)
    }
}

// MARK: - the Center runner

/// Runs one command on a saved SSH host without a terminal (the app does it through wecommander-core).
public protocol RemoteExecutor: Sendable {
    func run(hostId: String, command: String, timeoutSec: Int) async throws -> RemoteExecResult
}

/// The two Center calls of the runner (claim, result).
public protocol ScheduledRunTransport: Sendable {
    func claim() async throws -> [ClaimedRun]
    func postResult(runId: String, result: ScheduledRunResult) async throws
}

public struct GatewayRunTransport: ScheduledRunTransport {
    public let gateway: GatewayClient
    public let token: String

    public init(gateway: GatewayClient, token: String) { self.gateway = gateway; self.token = token }

    public func claim() async throws -> [ClaimedRun] { try await gateway.claimScheduledRuns(token: token) }

    public func postResult(runId: String, result: ScheduledRunResult) async throws {
        try await gateway.postScheduledRunResult(token: token, runId: runId, result: result)
    }
}

/// The Center side of scheduled tasks on saved SSH hosts: claims queued runs,
/// runs each on its host in the background and reports the result. Never
/// throws to its caller.
public actor ScheduledRunner {
    public static let pollEvery: TimeInterval = 30
    private let executor: RemoteExecutor
    private var active: [String: Task<Void, Never>] = [:]
    private var polling = false

    public init(executor: RemoteExecutor) { self.executor = executor }

    /// Runs going on now.
    public var activeCount: Int { active.count }

    /// Claims once and starts every claimed run in the background; returns how many started.
    @discardableResult
    public func pollOnce(_ transport: ScheduledRunTransport) async -> Int {
        if polling { return 0 }
        polling = true
        defer { polling = false }
        let items: [ClaimedRun]
        do {
            items = try await transport.claim()
        } catch {
            return 0 // offline, signed out or an older server: the next poll tries again
        }
        var started = 0
        for item in items {
            let id = item.run.id
            if id.isEmpty || active[id] != nil { continue }
            let executor = self.executor
            let task = Task.detached { [weak self] in
                await ScheduledRunner.runOne(executor, transport, item)
                await self?.finished(id)
            }
            active[id] = task
            started += 1
        }
        return started
    }

    private func finished(_ id: String) { active.removeValue(forKey: id) }

    /// Waits for the runs going on now (tests, sign-out).
    public func whenIdle() async {
        while !active.isEmpty {
            let tasks = Array(active.values)
            for t in tasks { await t.value }
        }
    }

    static func runOne(_ executor: RemoteExecutor, _ transport: ScheduledRunTransport, _ item: ClaimedRun) async {
        let task = item.task
        let result: ScheduledRunResult
        let hostId = task.target.hostId ?? ""
        if !task.target.isSsh || hostId.isEmpty {
            result = .failed(L.t("Bu çalışma bir SSH sunucusu için değil; Yönetim Merkezi çalıştırmadı."))
        } else {
            let timeout = min(3600, max(10, task.timeoutSec))
            do {
                let r = try await executor.run(hostId: hostId, command: task.command, timeoutSec: timeout)
                result = .from(r)
            } catch {
                result = .failed(L.t("Komut çalıştırılamadı: ") + error.localizedDescription)
            }
        }
        // The result matters (otherwise the run stays "running" until its lease ends): a few tries.
        for attempt in 0..<3 {
            do {
                try await transport.postResult(runId: item.run.id, result: result)
                return
            } catch let e as GatewayError where e.kind == .network {
                if attempt == 2 { return }
                let wait: UInt64 = attempt == 0 ? 2_000_000_000 : 10_000_000_000
                try? await Task.sleep(nanoseconds: wait)
            } catch {
                return // refused (run no longer ours, signed out): nothing to retry
            }
        }
    }
}

// MARK: - gateway calls

extension GatewayClient {
    /// Ids are uuids; anything else never reaches the URL.
    static func uuid(_ id: String) throws -> String {
        guard let u = UUID(uuidString: id) else {
            throw GatewayError(.http, 400, "invalid_request", Texts.forErrorCode("invalid_request", status: 400))
        }
        return u.uuidString.lowercased()
    }

    public func scheduledTasks(token: String) async throws -> [ScheduledTask] {
        try await items("/api/scheduled-tasks", token: token)
    }

    public func createScheduledTask(token: String, draft: ScheduledTaskDraft) async throws -> ScheduledTask {
        let json = try await sendJSON("POST", "/api/scheduled-tasks", token: token, body: draft.json()) as? [String: Any]
        return try decode(ScheduledTask.self, json?["item"])
    }

    /// PATCH with only the fields to change (e.g. ["enabled": false]).
    public func updateScheduledTask(token: String, id: String, changes: [String: Any]) async throws -> ScheduledTask {
        let uuid = try Self.uuid(id)
        let path = "/api/scheduled-tasks/" + uuid
        let json = try await sendJSON("PATCH", path, token: token, body: changes) as? [String: Any]
        return try decode(ScheduledTask.self, json?["item"])
    }

    public func deleteScheduledTask(token: String, id: String) async throws {
        let uuid = try Self.uuid(id)
        let path = "/api/scheduled-tasks/" + uuid
        _ = try await sendJSON("DELETE", path, token: token, body: nil)
    }

    /// Run now (trigger = manual); the run is queued on the server.
    public func runScheduledTask(token: String, id: String) async throws -> TaskRun {
        let uuid = try Self.uuid(id)
        let path = "/api/scheduled-tasks/" + uuid + "/run"
        let json = try await sendJSON("POST", path, token: token, body: [:]) as? [String: Any]
        return try decode(TaskRun.self, json?["run"])
    }

    public func scheduledTaskRuns(token: String, id: String, limit: Int = 50) async throws -> [TaskRun] {
        let n = min(200, max(1, limit))
        let uuid = try Self.uuid(id)
        let path = "/api/scheduled-tasks/" + uuid + "/runs?limit=" + String(n)
        return try await items(path, token: token)
    }

    /// The next five run times; an invalid schedule is a 400 whose `serverMessage` says why.
    public func previewSchedule(token: String, schedule: TaskSchedule, timezone: String) async throws -> [Date] {
        let body: [String: Any] = ["schedule": schedule.json(), "timezone": timezone]
        let json = try await sendJSON("POST", "/api/scheduled-tasks/preview", token: token, body: body) as? [String: Any]
        let texts = json?["next"] as? [String] ?? []
        return texts.compactMap { GatewayDates.parse($0) }
    }

    /// Runs queued for saved SSH hosts of this Center, now marked running for it (lease 15 min).
    public func claimScheduledRuns(token: String) async throws -> [ClaimedRun] {
        try await items("/api/center/scheduled-runs/claim", token: token)
    }

    public func postScheduledRunResult(token: String, runId: String, result: ScheduledRunResult) async throws {
        let uuid = try Self.uuid(runId)
        let path = "/api/center/scheduled-runs/" + uuid + "/result"
        _ = try await sendJSON("POST", path, token: token, body: result.json())
    }
}
