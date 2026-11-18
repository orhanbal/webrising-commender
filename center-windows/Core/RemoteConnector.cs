using System.Text.Json.Nodes;

namespace Wecommander.Center.Core;

/// <summary>A remote AI call the gateway queued for this computer (Hybrid Access H3).</summary>
public sealed record ConnectorCall(string Id, string HostId, string Tool, JsonObject Args, bool Approved, string Client)
{
    public static ConnectorCall? From(JsonNode? node)
    {
        if (node is not JsonObject o) return null;
        static string Str(JsonObject o, string name) => o[name] is JsonValue v && v.TryGetValue(out string? s) && s is not null ? s : "";
        var id = Str(o, "id");
        var tool = Str(o, "tool");
        if (id.Length == 0 || tool.Length == 0) return null;
        var args = o["args"] is JsonObject a ? (JsonObject)a.DeepClone() : new JsonObject();
        var approved = o["approved"] is JsonValue av && av.TryGetValue(out bool b) && b;
        return new ConnectorCall(id, Str(o, "hostId"), tool, args, approved, Str(o, "client"));
    }
}

/// <summary>The gateway side of the connector (GatewayClient; a fake in tests).</summary>
public interface IConnectorTransport
{
    /// <summary>Replaces the hosts this computer shares with remote AI (name, preset, sudo; never an address or key).</summary>
    Task PublishAsync(JsonArray targets, CancellationToken ct);
    /// <summary>Waits up to <paramref name="waitMs"/> for calls queued for this computer.</summary>
    Task<List<ConnectorCall>> ClaimAsync(int waitMs, CancellationToken ct);
    Task PostResultAsync(string callId, JsonNode result, CancellationToken ct);
}

/// <summary>
/// "Bu bilgisayar" as the connector (docs/HYBRID_ACCESS.md §5, phase H3):
/// while the app runs and is signed in, it publishes the saved SSH hosts
/// shared with remote AI (wecommander-core <c>mcp.remoteTargets</c>), waits
/// for the calls Claude/ChatGPT make through wecommander.app and hands each
/// to the core (<c>mcp.remoteCall</c>), which connects from this computer:
/// SSH keys and passwords never leave it. Approvals are decided on the
/// gateway (the person approves in this app's notification or on the web);
/// this loop never approves anything. When no host is shared it only checks
/// again now and then.
/// </summary>
public sealed class RemoteConnector(ICoreTransport core, Action<Exception>? log = null)
{
    public static readonly TimeSpan RepublishEvery = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan IdleCheck = TimeSpan.FromSeconds(15);
    public static readonly TimeSpan RetryAfter = TimeSpan.FromSeconds(5);
    /// <summary>Long-poll wait; under the app's 20 s HTTP timeout.</summary>
    public const int ClaimWaitMs = 12_000;

    private readonly Dictionary<string, Task> _active = [];
    private readonly object _gate = new();
    private string? _published;
    private DateTime _publishedAt = DateTime.MinValue;

    /// <summary>Calls running now.</summary>
    public int Active { get { lock (_gate) return _active.Count; } }

    /// <summary>Hosts shared right now (last published).</summary>
    public int Shared { get; private set; }

    /// <summary>Runs until cancelled. <paramref name="centerId"/> is this app's Management Center id (null while unknown).</summary>
    public async Task RunAsync(IConnectorTransport transport, Func<string?> centerId, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var wait = TimeSpan.Zero;
            try { wait = await StepAsync(transport, centerId(), ct).ConfigureAwait(false); }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (GatewayException e) when (e.Kind == GatewayErrorKind.Unauthorized) { wait = TimeSpan.FromSeconds(30); }
            catch (GatewayException) { wait = RetryAfter; } // offline or an older server
            catch (CoreException) { wait = RetryAfter; }
            catch (Exception e) { log?.Invoke(e); wait = RetryAfter; }
            if (wait > TimeSpan.Zero)
            {
                try { await Task.Delay(wait, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
            }
        }
        Task[] running;
        lock (_gate) running = _active.Values.ToArray();
        try { await Task.WhenAll(running).ConfigureAwait(false); } catch { }
    }

    /// <summary>One round: publish if changed (or a minute passed), then claim and start the calls. Returns how long to wait.</summary>
    public async Task<TimeSpan> StepAsync(IConnectorTransport transport, string? centerId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(centerId)) return IdleCheck;
        var targets = await core.CallAsync("mcp.remoteTargets", new { centerId }).ConfigureAwait(false) as JsonArray ?? [];
        var text = targets.ToJsonString();
        if (text != _published || DateTime.UtcNow - _publishedAt >= RepublishEvery)
        {
            await transport.PublishAsync(targets, ct).ConfigureAwait(false);
            _published = text;
            _publishedAt = DateTime.UtcNow;
            Shared = targets.Count;
        }
        if (targets.Count == 0) return IdleCheck;
        var calls = await transport.ClaimAsync(ClaimWaitMs, ct).ConfigureAwait(false);
        foreach (var call in calls) Start(transport, centerId, call, ct);
        return TimeSpan.Zero;
    }

    private void Start(IConnectorTransport transport, string centerId, ConnectorCall call, CancellationToken ct)
    {
        lock (_gate)
        {
            if (_active.ContainsKey(call.Id)) return;
            var task = Task.Run(() => RunOneAsync(transport, centerId, call, ct), CancellationToken.None);
            _active[call.Id] = task;
            _ = task.ContinueWith(_ => { lock (_gate) _active.Remove(call.Id); }, TaskScheduler.Default);
        }
    }

    /// <summary>The core's answer for one call; a failure of this app is an error result, never an exception.</summary>
    public async Task<JsonNode> HandleAsync(string centerId, ConnectorCall call)
    {
        try
        {
            var result = await core.CallAsync("mcp.remoteCall", new
            {
                callId = call.Id,
                centerId,
                client = call.Client,
                tool = call.Tool,
                args = call.Args,
                approved = call.Approved,
            }).ConfigureAwait(false);
            if (result is JsonObject o && o["ok"] is JsonValue) return o;
        }
        catch (CoreException) { }
        catch (Exception e) { log?.Invoke(e); }
        // English: this text goes to the AI client, not to the person.
        return new JsonObject { ["ok"] = false, ["error"] = "connector_error", ["message"] = "WECOMMANDER on the person's computer could not run this call; try again." };
    }

    private async Task RunOneAsync(IConnectorTransport transport, string centerId, ConnectorCall call, CancellationToken ct)
    {
        var result = await HandleAsync(centerId, call).ConfigureAwait(false);
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                await transport.PostResultAsync(call.Id, result, ct).ConfigureAwait(false);
                return;
            }
            catch (GatewayException e) when (e.Kind == GatewayErrorKind.Network && attempt < 2)
            {
                try { await Task.Delay(TimeSpan.FromSeconds(1 + attempt * 2), ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }
            }
            catch (GatewayException) { return; } // the call is over (answered too late): nothing to retry
            catch (OperationCanceledException) { return; }
            catch (Exception e) { log?.Invoke(e); return; }
        }
    }
}

/// <summary>The connector routes of the gateway with this app's Center token.</summary>
public sealed class GatewayConnectorTransport(GatewayClient gateway, string token) : IConnectorTransport
{
    public Task PublishAsync(JsonArray targets, CancellationToken ct) => gateway.PublishConnectorTargetsAsync(token, targets, ct);
    public Task<List<ConnectorCall>> ClaimAsync(int waitMs, CancellationToken ct) => gateway.ClaimConnectorCallsAsync(token, waitMs, ct);
    public Task PostResultAsync(string callId, JsonNode result, CancellationToken ct) => gateway.PostConnectorResultAsync(token, callId, result, ct);
}
