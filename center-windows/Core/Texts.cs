namespace Wecommander.Center.Core;

/// <summary>Turkish texts shown to the person.</summary>
public static class Texts
{
    public static string KindLabel(string kind) => kind switch
    {
        "process_exec" => L.T("Komut çalıştır"),
        "process_kill" => L.T("İşlemi sonlandır"),
        "task_start" => L.T("Arka plan görevi başlat"),
        "task_cancel" => L.T("Görevi iptal et"),
        "terminal_start" => L.T("Terminal aç"),
        "terminal_stop" => L.T("Terminali kapat"),
        "terminal_input" => L.T("Terminale yaz"),
        "fs_delete" => L.T("Dosya sil"),
        "fs_move" => L.T("Dosya taşı"),
        "server_cleanup_run" => L.T("Sunucuda yer aç (temizlik)"),
        "server_process_signal" => L.T("Sürece sinyal gönder"),
        "server_restart_owner" => L.T("Servisi yeniden başlat"),
        _ => kind,
    };

    /// <summary>
    /// "macOS'tan onaylandı" for a request this center showed but another
    /// center or the web panel decided; null when nothing should be said
    /// (decided here, expired, still pending).
    /// </summary>
    public static string? DecidedElsewhere(ApprovalOutcome outcome)
    {
        var verb = outcome.Status switch
        {
            "approved" or "consumed" => L.T("onaylandı"),
            "denied" => "reddedildi",
            _ => null,
        };
        if (verb is null || outcome.DecidedVia is not { Self: false } via) return null;
        var place = via.Kind == "panel" ? L.T("Web panelinden") : via.Platform switch
        {
            "macos" => L.T("macOS'tan"),
            "windows" => L.T("Windows'tan"),
            "linux" => L.T("Linux'tan"),
            _ => string.IsNullOrWhiteSpace(via.Name) ? L.T("Başka bir Yönetim Merkezinden") : L.F("{0} üzerinden", via.Name.Trim()),
        };
        return $"{place} {verb}";
    }

    public static string AgentNotInstalled =>
        L.T("Bu bilgisayarda WECOMMANDER ajanı kurulu değil. Kurmak için wecommander.app panelindeki Cihazlar sayfasındaki Windows komutunu kullan.");

    public static string EmbeddedNotPaired =>
        L.T("Bu bilgisayar henüz hesabına bağlı değil. Giriş yaptığında uygulama onu kendiliğinden bağlar; ayrıca bir şey kurman gerekmez.");
    public static string EmbeddedRunning =>
        L.T("Ajan bu uygulamanın içinde, arka planda çalışıyor. Durursa uygulama onu yeniden başlatır. Tepsiden Çıkış yaparsan ajan da durur.");

    /// <summary>One line for the agent card and the tray menu.</summary>
    public static string AgentStateLabel(AgentStatus? status) => status switch
    {
        null => L.T("Ajan durumu okunuyor…"),
        { State: AgentRunState.Running } => L.T("Ajan çalışıyor"),
        { State: AgentRunState.NotInstalled } => L.T("Ajan kurulu değil"),
        { Enabled: false } => L.T("Ajan kapalı"),
        _ => L.T("Ajan durdu"),
    };

    public static string AgentRestartedText => L.T("Bu bilgisayardaki ajan durmuştu; yeniden başlatıldı.");
    public static string AgentGaveUpText =>
        L.T("Bu bilgisayardaki ajan durdu ve yeniden başlatılamadı. Yapay zekâ bu bilgisayara erişemez. Paneli açıp \"Ajan çalışsın\"ı yeniden dene.");
    public static string AgentServiceStoppedText =>
        L.T("Bu bilgisayardaki ajan (Windows hizmeti) durdu. Başlatmak için paneldeki \"Ajan çalışsın\"ı aç; Windows yönetici onayı isteyecek.");
    public static string AgentUpdateStarted =>
        L.T("Ajan güncelleme penceresi açıldı. Windows yönetici onayı isteyecek; cihazın kaydı korunur.");
    public static string AgentInstallStarted =>
        L.T("Ajan kurulum penceresi açıldı. Windows yönetici onayı isteyecek; ajan bu hesapla otomatik bağlanır.");
    public static string AgentOffWarning => L.T("Ajan kapalıyken yapay zekâ bu bilgisayara erişemez.");

    public static string NotificationIntroTitle => L.T("WECOMMANDER bildirimleri hazır");
    public static string NotificationIntroText =>
        L.T("Onay istekleri burada, sağ altta görünecek. Windows izin sorarsa \"İzin ver\"e bas.");
    public static string NotificationTestTitle => L.T("Test bildirimi");
    public static string NotificationTestText => L.T("Bunu sağ altta görüyorsan onay istekleri de burada görünecek.");

    /// <summary>
    /// Why Windows does not show our notifications, from the Windows App SDK
    /// AppNotificationSetting name, and where the owner turns them on.
    /// </summary>
    public static string NotificationBlockedMessage(string setting) => setting switch
    {
        "DisabledForApplication" =>
            L.T("Windows bu uygulamanın bildirimlerini kapatmış; onay istekleri ekranda görünmez. ") +
            L.T("\"Bildirimlere izin ver\"e bas, listede WECOMMANDER Yönetim Merkezi'ni aç."),
        "DisabledForUser" =>
            L.T("Windows'ta bildirimler tamamen kapalı; onay istekleri ekranda görünmez. ") +
            L.T("\"Bildirimlere izin ver\"e bas ve en üstteki Bildirimler anahtarını aç."),
        "DisabledByGroupPolicy" =>
            L.T("Bildirimler kuruluşunun ilkesiyle kapatılmış. Bilgisayar yöneticine başvur; o zamana kadar yeni istekte bu panel açılır."),
        "DisabledByManifest" =>
            L.T("Bu kurulumda bildirimler kullanılamıyor. Uygulamayı yeniden kur; o zamana kadar yeni istekte bu panel açılır."),
        _ => "",
    };

    public static string ForErrorCode(string code, int status) => code switch
    {
        "reauthentication_failed" => L.T("Şifre hatalı."),
        "approval_request_expired" => L.T("Bu onay isteğinin süresi dolmuş. Yapay zekâ işlemi yeniden denediğinde yeni bir istek gelir."),
        "approval_request_not_pending" => L.T("Bu istek için zaten karar verilmiş."),
        "approval_request_not_found" => L.T("Onay isteği bulunamadı."),
        "forbidden" => L.T("Bu işlem için yönetici ya da sahip rolü gerekiyor."),
        "center_scope" => L.T("Yönetim Merkezi bu işlemi yapamaz."),
        "rate_limited" => L.T("Çok fazla deneme. Biraz sonra yeniden dene."),
        "invalid_request" or "validation_error" => L.T("İstek geçersiz."),
        "" => L.F("Sunucu hatası (HTTP {0}).", status),
        _ => code.Replace('_', ' '),
    };

    public static string SignedOutByServer => L.T("Oturum sunucuda kapatılmış ya da süresi dolmuş. Yeniden oturum aç.");

    /// <summary>Time left until an expiry, e.g. "8 dk 12 sn"; "süresi doldu" when past.</summary>
    public static string Remaining(DateTimeOffset expiresAt, DateTimeOffset now)
    {
        var left = expiresAt - now;
        if (left <= TimeSpan.Zero) return L.T("süresi doldu");
        if (left.TotalMinutes >= 60) return $"{Math.Round(left.TotalHours)} sa";
        return left.TotalMinutes >= 1 ? $"{(int)left.TotalMinutes} dk {left.Seconds} sn" : $"{left.Seconds} sn";
    }

    /// <summary>Clock-style time left for a notification countdown: "4:07", "1:02:05"; "0:00" when past.</summary>
    public static string Countdown(DateTimeOffset expiresAt, DateTimeOffset now)
    {
        var left = expiresAt - now;
        if (left <= TimeSpan.Zero) return "0:00";
        var total = (int)Math.Ceiling(left.TotalSeconds);
        return total >= 3600
            ? $"{total / 3600}:{total % 3600 / 60:00}:{total % 60:00}"
            : $"{total / 60}:{total % 60:00}";
    }

    /// <summary>Share of the approval window still left, 1 at creation and 0 at expiry.</summary>
    public static double RemainingFraction(DateTimeOffset createdAt, DateTimeOffset expiresAt, DateTimeOffset now)
    {
        var window = (expiresAt - createdAt).TotalSeconds;
        if (window <= 0) return 0;
        return Math.Clamp((expiresAt - now).TotalSeconds / window, 0, 1);
    }

    public static string Until(DateTimeOffset? until) => until is { } u
        ? u.ToLocalTime().ToString("dd.MM HH:mm") + L.T("'e kadar")
        : L.T("süresiz");
}

public static class Durations
{
    /// <summary>Minutes from now until 09:00 local time (tomorrow if already past), at least 5.</summary>
    public static int MinutesUntilNine(DateTime nowLocal)
    {
        var target = nowLocal.Date.AddHours(9);
        if (target <= nowLocal) target = target.AddDays(1);
        return Math.Max(5, (int)Math.Round((target - nowLocal).TotalMinutes));
    }
}

public static class ServerUrl
{
    /// <summary>Accept an https origin, or http only for this computer.</summary>
    public static string Normalize(string input)
    {
        if (!Uri.TryCreate(input.Trim(), UriKind.Absolute, out var uri))
            throw new ArgumentException(L.T("Geçerli bir sunucu adresi girin."));
        var local = uri.IsLoopback;
        if (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && local))
            throw new ArgumentException(L.T("Sunucu adresi https:// ile başlamalı."));
        if (uri.AbsolutePath != "/" || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || !string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException(L.T("Sunucu adresi yalnızca alan adı olmalı, ör. https://wecommander.app"));
        return uri.GetLeftPart(UriPartial.Authority);
    }
}
