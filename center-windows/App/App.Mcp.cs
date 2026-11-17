using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Local MCP prompts (Hybrid Access H2): an unknown AI app asking to connect
/// and a local AI app's risky action waiting for approval. Each is shown as a
/// Windows notification with buttons and, when the main window is open (or
/// notifications cannot be shown), as a dialog. Nothing is ever allowed or
/// approved without a click; an unanswered request simply expires in the core.
/// </summary>
public partial class App
{
    private const string McpTagPrefix = "mcp-";

    private static string McpTag(string id) => McpTagPrefix + id;

    /// <summary>Called once at launch, after the core started.</summary>
    private void StartLocalMcpPrompts()
    {
        Servers.McpClientRequested += request => _ui.TryEnqueue(() => OnMcpClientRequest(request));
        Servers.McpApprovalRequested += approval => _ui.TryEnqueue(() => OnMcpApproval(approval));
        Servers.McpApprovalClosed += id => _ui.TryEnqueue(() => { _shown.Remove(McpTag(id)); RemoveToast(McpTag(id)); });
        Servers.McpClientClosed += id => _ui.TryEnqueue(() => RemoveToast(McpTag("client-" + id)));
    }

    /// <summary>Like approvals: a dialog too when the window is open, asked for, or notifications cannot be shown.</summary>
    private bool McpWantsDialog => (_servers?.IsShown ?? false) || Settings.OpenOnRequest || NotificationsBlocked || !Settings.Notifications;

    private void OnMcpClientRequest(McpClientRequest request)
    {
        if (Settings.Notifications) ShowToast(ToastContent.McpClientRequest(request), McpTag("client-" + request.Id));
        if (!McpWantsDialog) return;
        ShowServers();
        _ = _servers!.AskMcpClient(request);
    }

    private void OnMcpApproval(McpApproval approval)
    {
        if (Settings.Notifications)
        {
            var urgent = Environment.OSVersion.Version.Build >= 22621;
            var tag = McpTag(approval.ApprovalId);
            var created = DateTimeOffset.UtcNow;
            ShowToast(ToastContent.McpApproval(approval, urgent), tag, CountdownData(created, approval.ExpiresAt, 1), approval.ExpiresAt.AddSeconds(30));
            _shown[tag] = (created, approval.ExpiresAt, 1);
            StartCountdown();
        }
        if (!McpWantsDialog) return;
        ShowServers();
        _ = _servers!.AskMcpApproval(approval);
    }

    /// <summary>A click on a local MCP notification or one of its buttons; false when it is not one.</summary>
    private async Task<bool> HandleMcpNotification(string? action, string? id)
    {
        if (action is null || !action.StartsWith(McpTagPrefix, StringComparison.Ordinal)) return false;
        if (id is null) return true;
        try
        {
            switch (action)
            {
                case "mcp-approve" or "mcp-deny":
                    if (Servers.PendingMcpApproval(id) is not { } item) { Toast(L.T("Bu onay artık geçerli değil (karar verilmiş ya da süresi dolmuş).")); break; }
                    var approve = action == "mcp-approve";
                    await Servers.DecideMcp(id, approve);
                    Toast(approve
                        ? L.F("{0} · onaylandı; yapay zekâ bu komutu bir kez çalıştırabilir.", item.TargetLabel)
                        : L.F("{0} · reddedildi.", item.TargetLabel));
                    break;
                case "mcp-allow" or "mcp-block":
                    var name = Servers.PendingMcpClients.TryGetValue(id, out var request) ? request.Name : id;
                    var allow = action == "mcp-allow";
                    await Servers.AllowMcpClient(id, allow);
                    Toast(allow ? L.F("{0} artık bu bilgisayardan WECOMMANDER'a bağlanabilir.", name) : L.F("{0} reddedildi.", name));
                    break;
                case "mcp-open":
                    ShowServers();
                    if (Servers.PendingMcpApproval(id) is { } pending) await _servers!.AskMcpApproval(pending);
                    break;
                case "mcp-client":
                    ShowServers();
                    if (Servers.PendingMcpClients.TryGetValue(id, out var waiting)) await _servers!.AskMcpClient(waiting);
                    break;
            }
        }
        catch (CoreException e) { Toast(e.Message); }
        return true;
    }
}
