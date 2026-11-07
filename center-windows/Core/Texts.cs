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
        "fs_delete" => "Dosya sil",
        "fs_move" => "Dosya taşı",
        _ => kind,
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
