using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Wecommander.Center.Core;

/// <summary>The core's request channel (CoreClient; a fake in tests).</summary>
public interface ICoreTransport
{
    Task<JsonNode?> CallAsync(string method, object? parameters = null);
}

/// <summary>An AI app that connected to the local MCP endpoint (mcp.clients).</summary>
public sealed record McpClient(string Id, string Name, string? Version, bool Allowed, DateTimeOffset? FirstSeen, DateTimeOffset? LastSeen);

/// <summary>mcp.status: whether local MCP runs, where, and the command AI apps start.</summary>
public sealed record McpStatus(bool Enabled, string? Endpoint, IReadOnlyList<string> BridgeCommand, IReadOnlyList<McpClient> Clients, bool RemoteSupported);

/// <summary>An unknown AI app connected; its requests wait (up to 2 minutes) for allow/deny.</summary>
public sealed record McpClientRequest(string Id, string Name, string? Version);

/// <summary>A risky action of a local AI app waiting for the owner (single use, bound to the exact command).</summary>
public sealed record McpApproval(string ApprovalId, string ClientName, string TargetId, string TargetLabel, string Tool,
    string Summary, string Command, DateTimeOffset ExpiresAt);

/// <summary>One line of the in-app activity list.</summary>
public sealed record McpActivity(string ClientName, string TargetLabel, string Tool, string Outcome, DateTimeOffset At);

/// <summary>mcp.configFor: the AI app's config file now and after WECOMMANDER's entry is added.</summary>
public sealed record McpConfigPreview(string Client, string Path, string? Before, string After);

/// <summary>Reads the core's mcp.* results and events; tolerant of missing fields.</summary>
public static class McpParse
{
    private static string Str(JsonNode? node, string name, string fallback = "") =>
        node is JsonObject o && o[name] is JsonValue v && v.TryGetValue(out string? s) && s is not null ? s : fallback;

    private static bool Bool(JsonNode? node, string name) =>
        node is JsonObject o && o[name] is JsonValue v && v.TryGetValue(out bool b) && b;

    /// <summary>RFC 3339 text, or Unix seconds / milliseconds.</summary>
    public static DateTimeOffset? Time(JsonNode? node)
    {
        if (node is not JsonValue v) return null;
        if (v.TryGetValue(out string? s))
            return DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var t) ? t : null;
        if (v.TryGetValue(out long n))
            return n > 100_000_000_000 ? DateTimeOffset.FromUnixTimeMilliseconds(n) : DateTimeOffset.FromUnixTimeSeconds(n);
        return null;
    }

    public static McpClient Client(JsonNode? node) => new(
        Str(node, "id"), Str(node, "name", Str(node, "id")), Str(node, "version") is { Length: > 0 } ver ? ver : null,
        Bool(node, "allowed"), Time(node?["firstSeen"]), Time(node?["lastSeen"]));

    public static List<McpClient> Clients(JsonNode? node) =>
        (node as JsonArray ?? node?["clients"] as JsonArray)?.Select(Client).Where(c => c.Id.Length > 0).ToList() ?? [];

    public static McpStatus Status(JsonNode? node)
    {
        var bridge = node?["bridgeCommand"] is JsonArray a
            ? a.Select(x => x is JsonValue v && v.TryGetValue(out string? s) ? s : null).Where(s => s is not null).Select(s => s!).ToList()
            : [];
        return new McpStatus(Bool(node, "enabled"), Str(node, "endpoint") is { Length: > 0 } e ? e : null, bridge,
            node?["clients"] is JsonArray ? Clients(node["clients"]) : [], AiAccessRules.RemoteSupported(null, node));
    }

    public static McpClientRequest ClientRequest(JsonNode? node) =>
        new(Str(node, "id"), Str(node, "name", Str(node, "id")), Str(node, "version") is { Length: > 0 } v ? v : null);

    public static McpApproval Approval(JsonNode? node, DateTimeOffset now) => new(
        Str(node, "approvalId"), Str(node, "clientName"), Str(node, "targetId"), Str(node, "targetLabel", Str(node, "targetId")),
        Str(node, "tool"), Str(node, "summary"), Str(node, "command"),
        // No expiry given: the contract's 5 minutes.
        Time(node?["expiresAt"]) ?? now.AddMinutes(5));

    public static McpActivity Activity(JsonNode? node, DateTimeOffset now) => new(
        Str(node, "clientName"), Str(node, "targetLabel"), Str(node, "tool"), Str(node, "outcome"), Time(node?["at"]) ?? now);

    public static McpConfigPreview Preview(string client, JsonNode? node) =>
        new(client, Str(node, "path"), node?["before"] is JsonValue b && b.TryGetValue(out string? before) ? before : null, Str(node, "after"));
}

/// <summary>
/// AI access and local MCP calls of wecommander-core (contract section 7).
/// Checks what it can before calling, and turns the core's error codes into
/// clear sentences (CoreException.Message; Raw keeps the code).
/// </summary>
public sealed class LocalMcpService(ICoreTransport core)
{
    /// <summary>Saves a host's AI access; returns the new host list.</summary>
    public async Task<List<CoreHost>> SetAiAccess(CoreHost host, AiAccess access, bool remoteSupported, DateTimeOffset now)
    {
        access = AiAccessRules.Normalize(access);
        if (access.Remote && !remoteSupported) throw new CoreException(AiAccessRules.RemoteNotSupported);
        if (AiAccessRules.Validate(access, now) is { } invalid) throw new CoreException(invalid);
        if (access.Any && AiAccessRules.Blockers(host) is { Count: > 0 } blockers) throw new CoreException(AiAccessRules.Code(blockers[0]));
        var result = await core.CallAsync("hosts.setAiAccess", new { id = host.Id, aiAccess = access });
        return result?.Deserialize<List<CoreHost>>(CoreClient.Json) ?? [];
    }

    public async Task<McpStatus> Status() => McpParse.Status(await core.CallAsync("mcp.status"));

    public async Task<List<McpClient>> Clients() => McpParse.Clients(await core.CallAsync("mcp.clients"));

    public Task AllowClient(string id, bool allow) => core.CallAsync("mcp.allowClient", new { id, allow });

    public Task ForgetClient(string id) => core.CallAsync("mcp.forgetClient", new { id });

    public async Task<McpConfigPreview> ConfigFor(string client)
    {
        if (!AiAccessText.SetupClients.Contains(client)) throw new CoreException("unknown_mcp_client");
        return McpParse.Preview(client, await core.CallAsync("mcp.configFor", new { client }));
    }

    public Task WriteConfig(string client)
    {
        if (!AiAccessText.SetupClients.Contains(client)) throw new CoreException("unknown_mcp_client");
        return core.CallAsync("mcp.writeConfig", new { client });
    }

    /// <summary>The owner's answer to one approval; only ever called from a person's click.</summary>
    public Task Decide(string approvalId, bool approve) => core.CallAsync("mcp.decide", new { approvalId, approve });
}

/// <summary>The newest local MCP activity first, kept short.</summary>
public sealed class McpActivityLog(int capacity = 100)
{
    private readonly LinkedList<McpActivity> _items = new();
    private readonly object _gate = new();

    public void Add(McpActivity item)
    {
        lock (_gate)
        {
            _items.AddFirst(item);
            while (_items.Count > capacity) _items.RemoveLast();
        }
    }

    public IReadOnlyList<McpActivity> Items { get { lock (_gate) return _items.ToList(); } }
}

/// <summary>One line of a config change: ' ' kept, '+' added, '-' removed, '…' skipped unchanged lines.</summary>
public sealed record DiffLine(char Kind, string Text);

/// <summary>The before/after of an AI app's config file, shown before WECOMMANDER writes it.</summary>
public static class ConfigDiff
{
    private const long MaxCells = 4_000_000;

    private static string[] Split(string? text) =>
        string.IsNullOrEmpty(text) ? [] : text.Replace("\r\n", "\n").TrimEnd('\n').Split('\n');

    /// <summary>A line diff (longest common subsequence on the changed middle).</summary>
    public static List<DiffLine> Lines(string? before, string after)
    {
        var a = Split(before);
        var b = Split(after);
        var start = 0;
        while (start < a.Length && start < b.Length && a[start] == b[start]) start++;
        var endA = a.Length;
        var endB = b.Length;
        while (endA > start && endB > start && a[endA - 1] == b[endB - 1]) { endA--; endB--; }
        var result = new List<DiffLine>();
        for (var i = 0; i < start; i++) result.Add(new DiffLine(' ', a[i]));
        var n = endA - start;
        var m = endB - start;
        if ((long)n * m > MaxCells)
        {
            for (var i = start; i < endA; i++) result.Add(new DiffLine('-', a[i]));
            for (var j = start; j < endB; j++) result.Add(new DiffLine('+', b[j]));
        }
        else
        {
            var len = new int[n + 1, m + 1];
            for (var i = n - 1; i >= 0; i--)
                for (var j = m - 1; j >= 0; j--)
                    len[i, j] = a[start + i] == b[start + j] ? len[i + 1, j + 1] + 1 : Math.Max(len[i + 1, j], len[i, j + 1]);
            int x = 0, y = 0;
            while (x < n && y < m)
            {
                if (a[start + x] == b[start + y]) { result.Add(new DiffLine(' ', a[start + x])); x++; y++; }
                else if (len[x + 1, y] >= len[x, y + 1]) { result.Add(new DiffLine('-', a[start + x])); x++; }
                else { result.Add(new DiffLine('+', b[start + y])); y++; }
            }
            for (; x < n; x++) result.Add(new DiffLine('-', a[start + x]));
            for (; y < m; y++) result.Add(new DiffLine('+', b[start + y]));
        }
        for (var i = endA; i < a.Length; i++) result.Add(new DiffLine(' ', a[i]));
        return result;
    }

    /// <summary>Only the changes with <paramref name="context"/> lines around them; long unchanged runs become '…'.</summary>
    public static List<DiffLine> Compact(IReadOnlyList<DiffLine> lines, int context = 3)
    {
        var keep = new bool[lines.Count];
        for (var i = 0; i < lines.Count; i++)
        {
            if (lines[i].Kind == ' ') continue;
            for (var k = Math.Max(0, i - context); k <= Math.Min(lines.Count - 1, i + context); k++) keep[k] = true;
        }
        var result = new List<DiffLine>();
        var skipped = 0;
        for (var i = 0; i < lines.Count; i++)
        {
            if (keep[i])
            {
                if (skipped > 0) { result.Add(new DiffLine('…', L.F("{0} satır değişmeden kalır", skipped))); skipped = 0; }
                result.Add(lines[i]);
            }
            else skipped++;
        }
        if (skipped > 0) result.Add(new DiffLine('…', L.F("{0} satır değişmeden kalır", skipped)));
        return result;
    }

    /// <summary>One sentence for the dialog: what happens to the file.</summary>
    public static string Summary(string? before, string after)
    {
        if (before is null) return L.F("Dosya yok; WECOMMANDER girdisiyle yeni oluşturulur ({0} satır).", Split(after).Length);
        var lines = Lines(before, after);
        var added = lines.Count(l => l.Kind == '+');
        var removed = lines.Count(l => l.Kind == '-');
        if (added == 0 && removed == 0) return L.T("Değişiklik yok: WECOMMANDER zaten ekli.");
        return removed == 0
            ? L.F("{0} satır eklenir; mevcut satırların hiçbiri silinmez.", added)
            : L.F("{0} satır eklenir, {1} satır değişir (yalnız WECOMMANDER girdisi ve çevresindeki biçim).", added, removed);
    }
}
