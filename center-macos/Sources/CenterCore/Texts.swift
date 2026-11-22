import Foundation

/// Turkish texts shown to the person (same wording as the Windows app).
public enum Texts {
    public static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "process_exec": return L.t("Komut çalıştır")
        case "process_kill": return L.t("İşlemi sonlandır")
        case "task_start": return L.t("Arka plan görevi başlat")
        case "task_cancel": return L.t("Görevi iptal et")
        case "terminal_start": return L.t("Terminal aç")
        case "terminal_stop": return L.t("Terminali kapat")
        case "terminal_input": return L.t("Terminale yaz")
        case "fs_delete": return L.t("Dosya sil")
        case "fs_move": return L.t("Dosya taşı")
        case "server_cleanup_run": return L.t("Sunucuda yer aç (temizlik)")
        case "server_process_signal": return L.t("Sürece sinyal gönder")
        case "server_restart_owner": return L.t("Servisi yeniden başlat")
        case "docker_container_action": return L.t("Konteyneri başlat veya durdur")
        case "scheduled_task_create": return L.t("Zamanlanmış görev oluştur")
        case "scheduled_task_update": return L.t("Zamanlanmış görevi düzenle")
        case "scheduled_task_delete": return L.t("Zamanlanmış görevi sil")
        case "scheduled_task_run_now": return L.t("Zamanlanmış görevi şimdi çalıştır")
        default: return kind
        }
    }

    /// "macOS'tan onaylandı" for a request this center showed but another
    /// center or the web panel decided; nil when nothing should be said
    /// (decided here, expired, still pending).
    public static func decidedElsewhere(_ outcome: ApprovalOutcome) -> String? {
        let verb: String
        switch outcome.status {
        case "approved", "consumed": verb = L.t("onaylandı")
        case "denied": verb = L.t("reddedildi")
        default: return nil
        }
        guard let via = outcome.decidedVia, !via.isSelf else { return nil }
        let place: String
        if via.kind == "panel" {
            place = L.t("Web panelinden")
        } else {
            switch via.platform {
            case "macos": place = L.t("macOS'tan")
            case "windows": place = L.t("Windows'tan")
            case "linux": place = L.t("Linux'tan")
            default:
                let name = via.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                place = name.isEmpty ? L.t("Başka bir Yönetim Merkezinden") : L.f("{0} üzerinden", name)
            }
        }
        return "\(place) \(verb)"
    }

    public static var agentNotInstalled: String {
        L.t("Bu Mac'te WECOMMANDER ajanı kurulu değil. Kurmak için wecommander.app panelindeki Cihazlar sayfasındaki macOS komutunu kullan.") }
    public static var agentRestarted: String { L.t("Bu Mac'teki ajan durmuştu; yeniden başlatıldı.") }
    public static var agentGaveUp: String {
        L.t("Bu Mac'teki ajan durdu ve yeniden başlatılamadı. Yapay zekâ bu Mac'e erişemez. Menü çubuğundaki simgeden \"Ajan çalışsın\"ı yeniden dene.") }
    public static var agentUpdateStarted: String {
        L.t("Ajan güncellemesi Terminal'de açıldı. macOS yönetici şifresini isteyecek; Mac'in kaydı korunur.") }
    public static var agentInstallStarted: String {
        L.t("Ajan kurulumu Terminal'de açıldı. macOS yönetici şifresini isteyecek; ajan bu hesapla otomatik bağlanır.") }
    public static var agentOffWarning: String { L.t("Ajan kapalıyken yapay zekâ bu Mac'e erişemez.") }
    public static var embeddedNotPaired: String {
        L.t("Bu Mac henüz hesabına bağlı değil. Giriş yaptığında uygulama onu kendiliğinden bağlar; ayrıca bir şey kurman gerekmez.") }
    public static var embeddedRunning: String {
        L.t("Ajan bu uygulamanın içinde, arka planda çalışıyor. Durursa uygulama onu yeniden başlatır. Menüden Çıkış yaparsan ajan da durur.") }

    /// One line for the agent card and the menu.
    public static func agentStateLabel(_ status: AgentStatus?) -> String {
        guard let status else { return L.t("Ajan durumu okunuyor…") }
        switch status.state {
        case .running: return L.t("Ajan çalışıyor")
        case .notInstalled: return L.t("Ajan kurulu değil")
        case .stopped: return status.enabled ? L.t("Ajan durdu") : L.t("Ajan kapalı")
        }
    }

    public static var notificationIntroTitle: String { L.t("WECOMMANDER bildirimleri hazır") }
    public static var notificationIntroText: String {
        L.t("Onay istekleri sağ üstte bildirim olarak görünecek. macOS izin sorarsa \"İzin Ver\"e bas.") }
    public static var notificationTestTitle: String { L.t("Test bildirimi") }
    public static var notificationTestText: String { L.t("Bunu görüyorsan onay istekleri de burada görünecek.") }

    /// macOS notification authorization as UNAuthorizationStatus / alert style names.
    public static func notificationBlockedMessage(_ state: String) -> String {
        switch state {
        case "denied":
            return L.t("macOS bu uygulamanın bildirimlerini kapatmış; onay istekleri ekranda görünmez. ") +
                L.t("\"Bildirimlere izin ver\"e bas ve WECOMMANDER Yönetim Merkezi için bildirimleri aç.")
        case "noAlerts":
            return L.t("Bildirimler açık ama ekranda gösterilmiyor (stil: Hiçbiri). ") +
                L.t("\"Bildirimlere izin ver\"e bas ve stili \"Afişler\" ya da \"Uyarılar\" yap.")
        case "notDetermined":
            return L.t("macOS henüz bildirim izni sormadı. \"Bildirimlere izin ver\"e bas; açılan soruda \"İzin Ver\"i seç.")
        default:
            return ""
        }
    }

    public static func forErrorCode(_ code: String, status: Int) -> String {
        switch code {
        case "reauthentication_failed": return L.t("Şifre hatalı.")
        case "approval_request_expired":
            return L.t("Bu onay isteğinin süresi dolmuş. Yapay zekâ işlemi yeniden denediğinde yeni bir istek gelir.")
        case "approval_request_not_pending": return L.t("Bu istek için zaten karar verilmiş.")
        case "approval_request_not_found": return L.t("Onay isteği bulunamadı.")
        case "forbidden": return L.t("Bu işlem için yönetici ya da sahip rolü gerekiyor.")
        case "center_scope": return L.t("Yönetim Merkezi bu işlemi yapamaz.")
        case "device_not_root_capable":
            return L.t("Bu bilgisayarda root izni verilmemiş. Önce o makinede ajan root izniyle kurulmalı.")
        case "device_not_found": return L.t("Cihaz bulunamadı.")
        case "browser_session_required": return L.t("Bu ayar yalnız web panelinden değiştirilebilir.")
        case "rate_limited": return L.t("Çok fazla deneme. Biraz sonra yeniden dene.")
        case "invalid_request", "validation_error": return L.t("İstek geçersiz.")
        case "": return L.f("Sunucu hatası (HTTP {0}).", status)
        default: return code.replacingOccurrences(of: "_", with: " ")
        }
    }

    public static var signedOutByServer: String { L.t("Oturum sunucuda kapatılmış ya da süresi dolmuş. Yeniden oturum aç.") }

    /// Time left until an expiry, e.g. "8 dk 12 sn"; "süresi doldu" when past.
    public static func remaining(_ expiresAt: Date, now: Date) -> String {
        let left = expiresAt.timeIntervalSince(now)
        if left <= 0 { return L.t("süresi doldu") }
        if left >= 3600 { return L.f("{0} sa", Int((left / 3600).rounded())) }
        let seconds = Int(left)
        return seconds >= 60 ? L.f("{0} dk {1} sn", seconds / 60, seconds % 60) : L.f("{0} sn", seconds)
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
        f.locale = L.locale
        f.timeZone = timeZone
        f.dateFormat = "HH:mm"
        return f.string(from: date)
    }

    /// The deadline line of an approval notification, e.g. "Süre: 9 dk · 01:27'ye kadar".
    public static func deadline(_ expiresAt: Date, now: Date, timeZone: TimeZone = .current) -> String {
        let minutes = max(0, Int((expiresAt.timeIntervalSince(now) / 60).rounded()))
        let left = minutes >= 1 ? L.f("{0} dk", minutes) : L.t("1 dk'dan az")
        return L.f("Süre: {0} · {1}'e kadar", left, clock(expiresAt, timeZone: timeZone))
    }

    public static func until(_ date: Date?, timeZone: TimeZone = .current) -> String {
        guard let date else { return L.t("süresiz") }
        let f = DateFormatter()
        f.locale = L.locale
        f.timeZone = timeZone
        f.dateFormat = "dd.MM HH:mm"
        return L.f("{0}'e kadar", f.string(from: date))
    }

    public static func trustLabel(_ level: String?) -> String {
        switch level {
        case "strict": return L.t("Sıkı: her işlem onaylı")
        case "full": return L.t("Otonom: onay istenmiyor")
        default: return L.t("Standart: riskli işlemler onaylı")
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
    public static var choices: [String] { [L.t("30 dakika"), L.t("1 saat"), L.t("4 saat"), L.t("Yarın 09:00'a kadar"), L.t("Süresiz")] }

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
            throw Invalid(message: L.t("Geçerli bir sunucu adresi girin."))
        }
        let local = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
        guard scheme == "https" || (scheme == "http" && local) else {
            throw Invalid(message: L.t("Sunucu adresi https:// ile başlamalı."))
        }
        guard (comps.path.isEmpty || comps.path == "/"), comps.query == nil, comps.fragment == nil,
              comps.user == nil, comps.password == nil else {
            throw Invalid(message: L.t("Sunucu adresi yalnızca alan adı olmalı, ör. https://wecommander.app"))
        }
        var origin = "\(scheme)://\(host.lowercased())"
        if let port = comps.port { origin += ":\(port)" }
        return origin
    }
}
