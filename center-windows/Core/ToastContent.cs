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
               $"<text>{Escape(L.F("Onay bekliyor · {0}", device))}</text>" +
               $"<text>{Escape(what)}</text>" +
               $"<text>{Escape(L.F("{0} · yalnız bu işlem, bir kez", kindLabel))}</text>" +
               $"<progress title=\"{{{ProgressTitle}}}\" value=\"{{{ProgressValue}}}\" " +
               $"valueStringOverride=\"{{{ProgressValueString}}}\" status=\"{{{ProgressStatus}}}\"/>" +
               "</binding></visual><actions>" + Button(L.T("Onayla"), "approve") + Button(L.T("Reddet"), "deny") +
               "</actions></toast>";
    }

    /// <summary>
    /// A local AI app's risky action (mcp-approval): which app, which server,
    /// the exact command, a countdown and Onayla / Reddet. Nothing is approved
    /// without a click; the buttons carry action=mcp-approve / mcp-deny.
    /// </summary>
    public static string McpApproval(McpApproval item, bool urgent)
    {
        string Button(string label, string action) =>
            $"<action content=\"{Escape(label)}\" activationType=\"foreground\" arguments=\"" +
            Escape(EncodeArgs([new("action", action), new("id", item.ApprovalId), new("client", item.ClientName)])) + "\"/>";
        var what = string.IsNullOrWhiteSpace(item.Command) ? item.Summary : item.Command;
        return $"<toast scenario=\"{(urgent ? "urgent" : "reminder")}\" launch=\"{Escape(EncodeArgs([new("action", "mcp-open"), new("id", item.ApprovalId)]))}\">" +
               "<visual><binding template=\"ToastGeneric\">" +
               $"<text>{Escape(L.F("{0} onay istiyor · {1}", item.ClientName, item.TargetLabel))}</text>" +
               $"<text>{Escape(what)}</text>" +
               $"<text>{Escape(L.F("{0} · yerel yapay zekâ · yalnız bu komut, bir kez", Texts.KindLabel(item.Tool)))}</text>" +
               $"<progress title=\"{{{ProgressTitle}}}\" value=\"{{{ProgressValue}}}\" " +
               $"valueStringOverride=\"{{{ProgressValueString}}}\" status=\"{{{ProgressStatus}}}\"/>" +
               "</binding></visual><actions>" + Button(L.T("Onayla"), "mcp-approve") + Button(L.T("Reddet"), "mcp-deny") +
               "</actions></toast>";
    }

    /// <summary>An unknown local AI app asks to connect: İzin ver / Reddet (action=mcp-allow / mcp-block).</summary>
    public static string McpClientRequest(McpClientRequest request)
    {
        string Button(string label, string action) =>
            $"<action content=\"{Escape(label)}\" activationType=\"foreground\" arguments=\"" +
            Escape(EncodeArgs([new("action", action), new("id", request.Id), new("client", request.Name)])) + "\"/>";
        return $"<toast scenario=\"reminder\" launch=\"{Escape(EncodeArgs([new("action", "mcp-client"), new("id", request.Id)]))}\">" +
               "<visual><binding template=\"ToastGeneric\">" +
               $"<text>{Escape(AiAccessText.ClientRequestTitle(request.Name))}</text>" +
               $"<text>{Escape(AiAccessText.ClientRequestHelp)}</text>" +
               "</binding></visual><actions>" + Button(L.T("İzin ver"), "mcp-allow") + Button(L.T("Reddet"), "mcp-block") +
               "</actions></toast>";
    }

    /// <summary>Values for the countdown bar at <paramref name="now"/>.</summary>
    public static Dictionary<string, string> Countdown(DateTimeOffset createdAt, DateTimeOffset expiresAt, DateTimeOffset now)
    {
        var expired = expiresAt <= now;
        return new Dictionary<string, string>
        {
            [ProgressTitle] = expired ? L.T("Süresi doldu") : L.T("Kalan süre"),
            [ProgressValue] = Texts.RemainingFraction(createdAt, expiresAt, now).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture),
            [ProgressValueString] = Texts.Countdown(expiresAt, now),
            [ProgressStatus] = expired ? L.T("Bu istek artık onaylanamaz") : L.T("Süre dolunca istek düşer"),
        };
    }
}
