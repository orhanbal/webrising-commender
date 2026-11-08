import Foundation

/// Turkish texts shown to the person (same wording as the Windows app).
public enum Texts {
    public static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "process_exec": return "Komut çalıştır"
        case "process_kill": return "İşlemi sonlandır"
        case "task_start": return "Arka plan görevi başlat"
        case "task_cancel": return "Görevi iptal et"
        case "terminal_start": return "Terminal aç"
        case "terminal_stop": return "Terminali kapat"
        case "terminal_input": return "Terminale yaz"
        case "fs_delete": return "Dosya sil"
        case "fs_move": return "Dosya taşı"
        default: return kind
        }
    }

    /// "macOS'tan onaylandı" for a request this center showed but another
    /// center or the web panel decided; nil when nothing should be said
    /// (decided here, expired, still pending).
    public static func decidedElsewhere(_ outcome: ApprovalOutcome) -> String? {
        let verb: String
        switch outcome.status {
        case "approved", "consumed": verb = "onaylandı"
        case "denied": verb = "reddedildi"
        default: return nil
        }
        guard let via = outcome.decidedVia, !via.isSelf else { return nil }
        let place: String
        if via.kind == "panel" {
            place = "Web panelinden"
        } else {
            switch via.platform {
            case "macos": place = "macOS'tan"
            case "windows": place = "Windows'tan"
            case "linux": place = "Linux'tan"
            default:
                let name = via.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                place = name.isEmpty ? "Başka bir Yönetim Merkezinden" : "\(name) üzerinden"
            }
        }
        return "\(place) \(verb)"
    }

    public static let notificationIntroTitle = "WECOMMANDER bildirimleri hazır"
    public static let notificationIntroText =
        "Onay istekleri sağ üstte bildirim olarak görünecek. macOS izin sorarsa \"İzin Ver\"e bas."
    public static let notificationTestTitle = "Test bildirimi"
    public static let notificationTestText = "Bunu görüyorsan onay istekleri de burada görünecek."

    /// macOS notification authorization as UNAuthorizationStatus / alert style names.
    public static func notificationBlockedMessage(_ state: String) -> String {
        switch state {
        case "denied":
            return "macOS bu uygulamanın bildirimlerini kapatmış; onay istekleri ekranda görünmez. " +
                "\"Bildirimlere izin ver\"e bas ve WECOMMANDER Yönetim Merkezi için bildirimleri aç."
        case "noAlerts":
            return "Bildirimler açık ama ekranda gösterilmiyor (stil: Hiçbiri). " +
                "\"Bildirimlere izin ver\"e bas ve stili \"Afişler\" ya da \"Uyarılar\" yap."
        case "notDetermined":
            return "macOS henüz bildirim izni sormadı. \"Bildirimlere izin ver\"e bas; açılan soruda \"İzin Ver\"i seç."
        default:
            return ""
        }
    }

    public static func forErrorCode(_ code: String, status: Int) -> String {
        switch code {
        case "reauthentication_failed": return "Şifre hatalı."
        case "approval_request_expired":
            return "Bu onay isteğinin süresi dolmuş. Yapay zekâ işlemi yeniden denediğinde yeni bir istek gelir."
        case "approval_request_not_pending": return "Bu istek için zaten karar verilmiş."
        case "approval_request_not_found": return "Onay isteği bulunamadı."
        case "forbidden": return "Bu işlem için yönetici ya da sahip rolü gerekiyor."
        case "center_scope": return "Yönetim Merkezi bu işlemi yapamaz."
        case "rate_limited": return "Çok fazla deneme. Biraz sonra yeniden dene."
        case "invalid_request", "validation_error": return "İstek geçersiz."
        case "": return "Sunucu hatası (HTTP \(status))."
        default: return code.replacingOccurrences(of: "_", with: " ")
        }
    }

    public static let signedOutByServer = "Oturum sunucuda kapatılmış ya da süresi dolmuş. Yeniden oturum aç."

    /// Time left until an expiry, e.g. "8 dk 12 sn"; "süresi doldu" when past.
    public static func remaining(_ expiresAt: Date, now: Date) -> String {
        let left = expiresAt.timeIntervalSince(now)
        if left <= 0 { return "süresi doldu" }
        if left >= 3600 { return "\(Int((left / 3600).rounded())) sa" }
        let seconds = Int(left)
        return seconds >= 60 ? "\(seconds / 60) dk \(seconds % 60) sn" : "\(seconds) sn"
    }

    /// Clock-style time left: "4:07", "1:02:05"; "0:00" when past.
    public static func countdown(_ expiresAt: Date, now: Date) -> String {
        let left = expiresAt.timeIntervalSince(now)
        if left <= 0 { return "0:00" }
        let total = Int(left.rounded(.up))
        if total >= 3600 {
            return String(format: "%d:%02d:%02d", total / 3600, total % 3600 / 60, total % 60)
        }
        return String(format: "%d:%02d", total / 60, total % 60)
    }

    /// Share of the approval window still left, 1 at creation and 0 at expiry.
    public static func remainingFraction(created: Date, expires: Date, now: Date) -> Double {
        let window = expires.timeIntervalSince(created)
        if window <= 0 { return 0 }
        return min(1, max(0, expires.timeIntervalSince(now) / window))
    }

    /// "23:41" in the given time zone.
    public static func clock(_ date: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "tr_TR")
        f.timeZone = timeZone
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    /// The deadline line of an approval notification, e.g. "Süre: 9 dk · 01:27'ye kadar".
    public static func deadline(_ expiresAt: Date, now: Date, timeZone: TimeZone = .current) -> String {
        let minutes = max(0, Int((expiresAt.timeIntervalSince(now) / 60).rounded()))
        let left = minutes >= 1 ? "\(minutes) dk" : "1 dk'dan az"
        return "Süre: \(left) · \(clock(expiresAt, timeZone: timeZone))'e kadar"
    }

    public static func until(_ date: Date?, timeZone: TimeZone = .current) -> String {
        guard let date else { return "süresiz" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "tr_TR")
        f.timeZone = timeZone
        f.dateFormat = "dd.MM HH:mm"
        return f.string(from: date) + "'e kadar"
    }

    public static func trustLabel(_ level: String?) -> String {
        switch level {
        case "strict": return "Sıkı: her işlem onaylı"
        case "full": return "Otonom: onay istenmiyor"
        default: return "Standart: riskli işlemler onaylı"
        }
    }
}

public enum Durations {
    /// Minutes from now until 09:00 local time (tomorrow if already past), at least 5.
    public static func minutesUntilNine(_ now: Date, calendar: Calendar = .current) -> Int {
        var target = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: now)!
        if target <= now { target = calendar.date(byAdding: .day, value: 1, to: target)! }
        return max(5, Int((target.timeIntervalSince(now) / 60).rounded()))
    }

    /// Duration choices of the autonomous mode, as in the Windows app.
    public static let choices = ["30 dakika", "1 saat", "4 saat", "Yarın 09:00'a kadar", "Süresiz"]

    /// Minutes for choice index; nil means indefinite.
    public static func minutes(forChoice index: Int, now: Date, calendar: Calendar = .current) -> Int? {
        switch index {
        case 0: return 30
        case 1: return 60
        case 2: return 240
        case 3: return minutesUntilNine(now, calendar: calendar)
        default: return nil
        }
    }
}

public enum ServerURL {
    public struct Invalid: Error, LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }

    /// Accept an https origin, or http only for this computer.
    public static func normalize(_ input: String) throws -> String {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: text), let scheme = comps.scheme?.lowercased(),
              let host = comps.host, !host.isEmpty else {
            throw Invalid(message: "Geçerli bir sunucu adresi girin.")
        }
        let local = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        guard scheme == "https" || (scheme == "http" && local) else {
            throw Invalid(message: "Sunucu adresi https:// ile başlamalı.")
        }
        guard (comps.path.isEmpty || comps.path == "/"), comps.query == nil, comps.fragment == nil,
              comps.user == nil, comps.password == nil else {
            throw Invalid(message: "Sunucu adresi yalnızca alan adı olmalı, ör. https://wecommander.app")
        }
        var origin = "\(scheme)://\(host.lowercased())"
        if let port = comps.port { origin += ":\(port)" }
        return origin
    }
}
