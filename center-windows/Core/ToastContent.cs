using System.Security;

namespace Wecommander.Center.Core;

/// <summary>
/// Notification XML and arguments for the Windows toast API. The app shows
/// notifications through Windows.UI.Notifications under its own
/// AppUserModelID (app.wecommander.center): on the owner's machine that is
/// what reached the banner, while the Windows App SDK notification API did not.
/// </summary>
public static class ToastContent
{
    /// <summary>Data-binding keys of the countdown progress bar.</summary>
    public const string ProgressTitle = "progressTitle";
    public const string ProgressValue = "progressValue";
    public const string ProgressValueString = "progressValueString";
    public const string ProgressStatus = "progressStatus";

    public static string Escape(string text) => SecurityElement.Escape(text) ?? "";

    /// <summary>Arguments carried by a toast or its buttons, e.g. action=approve&amp;id=…</summary>
    public static string EncodeArgs(IEnumerable<KeyValuePair<string, string>> args) =>
        string.Join("&", args.Select(a => $"{Uri.EscapeDataString(a.Key)}={Uri.EscapeDataString(a.Value)}"));

    public static Dictionary<string, string> DecodeArgs(string? raw)
    {
        var result = new Dictionary<string, string>();
        if (string.IsNullOrEmpty(raw)) return result;
        foreach (var part in raw.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var i = part.IndexOf('=');
            if (i <= 0) continue;
            result[Uri.UnescapeDataString(part[..i])] = Uri.UnescapeDataString(part[(i + 1)..]);
        }
        return result;
    }

    /// <summary>A plain notification: title and text; a click opens the panel.</summary>
    public static string Simple(string title, string text) =>
        $"<toast launch=\"{Escape(EncodeArgs([new("action", "open")]))}\"><visual><binding template=\"ToastGeneric\">" +
        $"<text>{Escape(title)}</text><text>{Escape(text)}</text></binding></visual></toast>";

    /// <summary>
    /// One approval request: what it allows, a countdown bar bound to the
    /// progress keys, and Onayla / Reddet. Urgent (Windows 11 22H2+) shows the
    /// banner even with Do not disturb; Reminder keeps it on screen until answered.
    /// </summary>
    public static string Approval(string id, string device, string what, string kindLabel, bool urgent)
    {
        string Button(string label, string action) =>
            $"<action content=\"{label}\" activationType=\"foreground\" arguments=\"" +
            Escape(EncodeArgs([new("action", action), new("id", id), new("device", device)])) + "\"/>";
        return $"<toast scenario=\"{(urgent ? "urgent" : "reminder")}\" launch=\"{Escape(EncodeArgs([new("action", "open")]))}\">" +
               "<visual><binding template=\"ToastGeneric\">" +
               $"<text>{Escape($"Onay bekliyor · {device}")}</text>" +
               $"<text>{Escape(what)}</text>" +
               $"<text>{Escape($"{kindLabel} · yalnız bu işlem, bir kez")}</text>" +
               $"<progress title=\"{{{ProgressTitle}}}\" value=\"{{{ProgressValue}}}\" " +
               $"valueStringOverride=\"{{{ProgressValueString}}}\" status=\"{{{ProgressStatus}}}\"/>" +
               "</binding></visual><actions>" + Button("Onayla", "approve") + Button("Reddet", "deny") +
               "</actions></toast>";
    }

    /// <summary>Values for the countdown bar at <paramref name="now"/>.</summary>
    public static Dictionary<string, string> Countdown(DateTimeOffset createdAt, DateTimeOffset expiresAt, DateTimeOffset now)
    {
        var expired = expiresAt <= now;
        return new Dictionary<string, string>
        {
            [ProgressTitle] = expired ? "Süresi doldu" : "Kalan süre",
            [ProgressValue] = Texts.RemainingFraction(createdAt, expiresAt, now).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture),
            [ProgressValueString] = Texts.Countdown(expiresAt, now),
            [ProgressStatus] = expired ? "Bu istek artık onaylanamaz" : "Süre dolunca istek düşer",
        };
    }
}
