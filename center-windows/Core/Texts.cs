namespace Wecommander.Center.Core;

/// <summary>Turkish texts shown to the person.</summary>
public static class Texts
{
    public static string KindLabel(string kind) => kind switch
    {
        "process_exec" => "Komut çalıştır",
        "process_kill" => "İşlemi sonlandır",
        "task_start" => "Arka plan görevi başlat",
        "task_cancel" => "Görevi iptal et",
        "terminal_start" => "Terminal aç",
        "terminal_stop" => "Terminali kapat",
        "terminal_input" => "Terminale yaz",
        "fs_delete" => "Dosya sil",
        "fs_move" => "Dosya taşı",
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
            "approved" or "consumed" => "onaylandı",
            "denied" => "reddedildi",
            _ => null,
        };
        if (verb is null || outcome.DecidedVia is not { Self: false } via) return null;
        var place = via.Kind == "panel" ? "Web panelinden" : via.Platform switch
        {
            "macos" => "macOS'tan",
            "windows" => "Windows'tan",
            "linux" => "Linux'tan",
            _ => string.IsNullOrWhiteSpace(via.Name) ? "Başka bir Yönetim Merkezinden" : $"{via.Name.Trim()} üzerinden",
        };
        return $"{place} {verb}";
    }

    public const string AgentNotInstalled =
        "Bu bilgisayarda WECOMMANDER ajanı kurulu değil. Kurmak için wecommander.app panelindeki Cihazlar sayfasındaki Windows komutunu kullan.";

    /// <summary>One line for the agent card and the tray menu.</summary>
    public static string AgentStateLabel(AgentStatus? status) => status switch
    {
        null => "Ajan durumu okunuyor…",
        { State: AgentRunState.Running } => "Ajan çalışıyor",
        { State: AgentRunState.NotInstalled } => "Ajan kurulu değil",
        { Enabled: false } => "Ajan kapalı",
        _ => "Ajan durdu",
    };

    public const string AgentRestartedText = "Bu bilgisayardaki ajan durmuştu; yeniden başlatıldı.";
    public const string AgentGaveUpText =
        "Bu bilgisayardaki ajan durdu ve yeniden başlatılamadı. Yapay zekâ bu bilgisayara erişemez. Paneli açıp \"Ajan çalışsın\"ı yeniden dene.";
    public const string AgentServiceStoppedText =
        "Bu bilgisayardaki ajan (Windows hizmeti) durdu. Başlatmak için paneldeki \"Ajan çalışsın\"ı aç; Windows yönetici onayı isteyecek.";
    public const string AgentOffWarning = "Ajan kapalıyken yapay zekâ bu bilgisayara erişemez.";

    public const string NotificationIntroTitle = "WECOMMANDER bildirimleri hazır";
    public const string NotificationIntroText =
        "Onay istekleri burada, sağ altta görünecek. Windows izin sorarsa \"İzin ver\"e bas.";
    public const string NotificationTestTitle = "Test bildirimi";
    public const string NotificationTestText = "Bunu sağ altta görüyorsan onay istekleri de burada görünecek.";

    /// <summary>
    /// Why Windows does not show our notifications, from the Windows App SDK
    /// AppNotificationSetting name, and where the owner turns them on.
    /// </summary>
    public static string NotificationBlockedMessage(string setting) => setting switch
    {
        "DisabledForApplication" =>
            "Windows bu uygulamanın bildirimlerini kapatmış; onay istekleri ekranda görünmez. " +
            "\"Bildirimlere izin ver\"e bas, listede WECOMMANDER Yönetim Merkezi'ni aç.",
        "DisabledForUser" =>
            "Windows'ta bildirimler tamamen kapalı; onay istekleri ekranda görünmez. " +
            "\"Bildirimlere izin ver\"e bas ve en üstteki Bildirimler anahtarını aç.",
        "DisabledByGroupPolicy" =>
            "Bildirimler kuruluşunun ilkesiyle kapatılmış. Bilgisayar yöneticine başvur; o zamana kadar yeni istekte bu panel açılır.",
        "DisabledByManifest" =>
            "Bu kurulumda bildirimler kullanılamıyor. Uygulamayı yeniden kur; o zamana kadar yeni istekte bu panel açılır.",
        _ => "",
    };

    public static string ForErrorCode(string code, int status) => code switch
    {
        "reauthentication_failed" => "Şifre hatalı.",
        "approval_request_expired" => "Bu onay isteğinin süresi dolmuş. Yapay zekâ işlemi yeniden denediğinde yeni bir istek gelir.",
        "approval_request_not_pending" => "Bu istek için zaten karar verilmiş.",
        "approval_request_not_found" => "Onay isteği bulunamadı.",
        "forbidden" => "Bu işlem için yönetici ya da sahip rolü gerekiyor.",
        "center_scope" => "Yönetim Merkezi bu işlemi yapamaz.",
        "rate_limited" => "Çok fazla deneme. Biraz sonra yeniden dene.",
        "invalid_request" or "validation_error" => "İstek geçersiz.",
        "" => $"Sunucu hatası (HTTP {status}).",
        _ => code.Replace('_', ' '),
    };

    public const string SignedOutByServer = "Oturum sunucuda kapatılmış ya da süresi dolmuş. Yeniden oturum aç.";

    /// <summary>Time left until an expiry, e.g. "8 dk 12 sn"; "süresi doldu" when past.</summary>
    public static string Remaining(DateTimeOffset expiresAt, DateTimeOffset now)
    {
        var left = expiresAt - now;
        if (left <= TimeSpan.Zero) return "süresi doldu";
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
        ? u.ToLocalTime().ToString("dd.MM HH:mm") + "'e kadar"
        : "süresiz";
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
            throw new ArgumentException("Geçerli bir sunucu adresi girin.");
        var local = uri.IsLoopback;
        if (uri.Scheme != Uri.UriSchemeHttps && !(uri.Scheme == Uri.UriSchemeHttp && local))
            throw new ArgumentException("Sunucu adresi https:// ile başlamalı.");
        if (uri.AbsolutePath != "/" || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment) || !string.IsNullOrEmpty(uri.UserInfo))
            throw new ArgumentException("Sunucu adresi yalnızca alan adı olmalı, ör. https://wecommander.app");
        return uri.GetLeftPart(UriPartial.Authority);
    }
}
