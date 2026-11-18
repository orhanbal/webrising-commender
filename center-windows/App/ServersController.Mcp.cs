using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// AI access of saved hosts and local MCP (Hybrid Access H1/H2): the
/// <c>hosts.setAiAccess</c> and <c>mcp.*</c> calls of wecommander-core and its
/// <c>mcp-client-request</c>, <c>mcp-approval</c> and <c>mcp-activity</c>
/// events. Nothing here ever approves or allows by itself: every decision
/// comes from a person's click (App.Mcp.cs, ServersWindow.AiAccess.cs).
/// </summary>
public sealed partial class ServersController
{
    private LocalMcpService Mcp => new(Core);

    /// <summary>The running core for the remote connector (H3); null until it started.</summary>
    public ICoreTransport? CoreTransport => _core;
    private McpStatus? _mcpStatus;

    /// <summary>The newest local MCP activity first (in memory, for the Settings → Yapay zekâ page).</summary>
    public McpActivityLog McpLog { get; } = new();

    /// <summary>Approvals waiting for the owner, by approval id.</summary>
    public ConcurrentDictionary<string, McpApproval> PendingMcpApprovals { get; } = new();

    /// <summary>Unknown AI apps waiting to be allowed or refused, by client id.</summary>
    public ConcurrentDictionary<string, McpClientRequest> PendingMcpClients { get; } = new();

    /// <summary>An unknown AI app asks to connect (any thread).</summary>
    public event Action<McpClientRequest>? McpClientRequested;
    /// <summary>A local AI app wants a risky action approved (any thread).</summary>
    public event Action<McpApproval>? McpApprovalRequested;
    /// <summary>An approval was decided here (dialog or notification): close the other one.</summary>
    public event Action<string>? McpApprovalClosed;
    /// <summary>A client request was answered: close the other prompt.</summary>
    public event Action<string>? McpClientClosed;
    /// <summary>A new line for the activity list (any thread).</summary>
    public event Action<McpActivity>? McpActivityAdded;

    /// <summary>The core says it can serve remote AI access (phase H3); until then the switch explains that it comes later.</summary>
    public bool RemoteAiSupported => AiAccessRules.RemoteSupported(_core?.Info) || _mcpStatus?.RemoteSupported == true;

    private void OnMcpEvent(string name, JsonNode? data)
    {
        var now = DateTimeOffset.UtcNow;
        switch (name)
        {
            case "mcp-client-request":
            {
                var request = McpParse.ClientRequest(data);
                if (request.Id.Length == 0) return;
                PendingMcpClients[request.Id] = request;
                McpClientRequested?.Invoke(request);
                break;
            }
            case "mcp-approval":
            {
                var approval = McpParse.Approval(data, now);
                if (approval.ApprovalId.Length == 0 || approval.ExpiresAt <= now) return;
                PendingMcpApprovals[approval.ApprovalId] = approval;
                McpApprovalRequested?.Invoke(approval);
                break;
            }
            case "mcp-activity":
            {
                var activity = McpParse.Activity(data, now);
                McpLog.Add(activity);
                McpActivityAdded?.Invoke(activity);
                break;
            }
        }
    }

    /// <summary>An approval still waiting (and not expired).</summary>
    public McpApproval? PendingMcpApproval(string approvalId)
    {
        if (!PendingMcpApprovals.TryGetValue(approvalId, out var item)) return null;
        if (item.ExpiresAt > DateTimeOffset.UtcNow) return item;
        PendingMcpApprovals.TryRemove(approvalId, out _);
        return null;
    }

    public async Task SetAiAccess(CoreHost host, AiAccess access)
    {
        Hosts = await Mcp.SetAiAccess(host, access, RemoteAiSupported, DateTimeOffset.UtcNow);
        Changed?.Invoke();
    }

    public async Task<McpStatus> GetMcpStatus()
    {
        _mcpStatus = await Mcp.Status();
        return _mcpStatus;
    }

    public Task<List<McpClient>> GetMcpClients() => Mcp.Clients();

    /// <summary>The owner's answer to a client request (dialog, notification or Settings).</summary>
    public async Task AllowMcpClient(string id, bool allow)
    {
        try { await Mcp.AllowClient(id, allow); }
        finally
        {
            PendingMcpClients.TryRemove(id, out _);
            McpClientClosed?.Invoke(id);
        }
    }

    public Task ForgetMcpClient(string id) => Mcp.ForgetClient(id);

    public Task<McpConfigPreview> McpConfigFor(string client) => Mcp.ConfigFor(client);

    public Task McpWriteConfig(string client) => Mcp.WriteConfig(client);

    /// <summary>The owner's answer to one approval; called only from a click on Onayla / Reddet.</summary>
    public async Task DecideMcp(string approvalId, bool approve)
    {
        try { await Mcp.Decide(approvalId, approve); }
        finally
        {
            PendingMcpApprovals.TryRemove(approvalId, out _);
            McpApprovalClosed?.Invoke(approvalId);
        }
    }
}
