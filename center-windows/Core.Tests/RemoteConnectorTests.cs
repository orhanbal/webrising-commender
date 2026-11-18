using System.Text.Json;
using System.Text.Json.Nodes;
using Wecommander.Center.Core;
using Xunit;

namespace Wecommander.Center.Core.Tests;

/// <summary>Hybrid Access H3: this computer as the connector for its shared SSH hosts.</summary>
public class RemoteConnectorTests
{
    private sealed class FakeGateway : IConnectorTransport
    {
        public List<JsonArray> Published { get; } = [];
        public Queue<List<ConnectorCall>> Claims { get; } = new();
        public List<(string Id, JsonNode Result)> Results { get; } = [];
        public int ClaimCount;

        public Task PublishAsync(JsonArray targets, CancellationToken ct)
        {
            Published.Add((JsonArray)targets.DeepClone());
            return Task.CompletedTask;
        }

        public Task<List<ConnectorCall>> ClaimAsync(int waitMs, CancellationToken ct)
        {
            ClaimCount++;
            return Task.FromResult(Claims.Count > 0 ? Claims.Dequeue() : []);
        }

        public Task PostResultAsync(string callId, JsonNode result, CancellationToken ct)
        {
            lock (Results) Results.Add((callId, result));
            return Task.CompletedTask;
        }
    }

    private static readonly JsonArray Shared = JsonNode.Parse("""[{"hostId":"h1","name":"web-1","preset":"approval","sudo":"never"}]""")!.AsArray();

    [Fact]
    public async Task NothingHappensBeforeSignInAndEmptyIsPublishedOnceWithoutClaiming()
    {
        var core = new FakeCore { Answer = (_, _) => new JsonArray() };
        var gw = new FakeGateway();
        var c = new RemoteConnector(core);
        Assert.Equal(RemoteConnector.IdleCheck, await c.StepAsync(gw, null, default));
        Assert.Empty(core.Calls);
        Assert.Equal(RemoteConnector.IdleCheck, await c.StepAsync(gw, "center-1", default));
        Assert.Equal(RemoteConnector.IdleCheck, await c.StepAsync(gw, "center-1", default));
        Assert.Single(gw.Published); // unchanged: not sent again
        Assert.Equal(0, gw.ClaimCount);
        Assert.Equal("center-1", (string?)core.Calls[0].Params?["centerId"]);
    }

    [Fact]
    public async Task ClaimedCallsRunInTheCoreAndTheirResultsArePosted()
    {
        var core = new FakeCore
        {
            Answer = (method, p) => method == "mcp.remoteTargets"
                ? Shared.DeepClone()
                : new JsonObject { ["ok"] = true, ["result"] = new JsonObject { ["tool"] = (string?)p?["tool"], ["approved"] = (bool?)p?["approved"] } },
        };
        var gw = new FakeGateway();
        gw.Claims.Enqueue([
            ConnectorCall.From(JsonNode.Parse("""{"id":"11111111-1111-1111-1111-111111111111","hostId":"h1","tool":"process_exec","args":{"target":"h1","command":"uptime"},"approved":true,"client":"chatgpt"}"""))!,
        ]);
        var c = new RemoteConnector(core);
        Assert.Equal(TimeSpan.Zero, await c.StepAsync(gw, "center-1", default));
        Assert.Equal("web-1", (string?)gw.Published.Single()[0]?["name"]);
        for (var i = 0; i < 100 && gw.Results.Count == 0; i++) await Task.Delay(20);
        var (id, result) = Assert.Single(gw.Results);
        Assert.Equal("11111111-1111-1111-1111-111111111111", id);
        Assert.True((bool?)result["ok"]);
        var call = core.Calls.Single(x => x.Method == "mcp.remoteCall").Params!;
        Assert.Equal("center-1", (string?)call["centerId"]);
        Assert.Equal("uptime", (string?)call["args"]?["command"]);
        Assert.True((bool?)call["approved"]);
    }

    [Fact]
    public async Task ACoreFailureBecomesAnErrorResult()
    {
        var core = new FakeCore { Answer = (_, _) => throw new CoreException(CoreException.Stopped) };
        var c = new RemoteConnector(core);
        var call = new ConnectorCall("id", "h1", "fs_read", new JsonObject(), false, "claude");
        var result = await c.HandleAsync("center-1", call);
        Assert.False((bool?)result["ok"]);
        Assert.Equal("connector_error", (string?)result["error"]);
        Assert.Null(ConnectorCall.From(JsonNode.Parse("""{"tool":"x"}""")));
    }

    [Fact]
    public void RemoteAccessIsStoredWithThisComputersId()
    {
        var off = AiAccess.Off;
        Assert.Equal("center-1", AiAccessRules.ConnectorFor(off, remote: true, "center-1"));
        Assert.Equal(AiAccess.ThisComputer, AiAccessRules.ConnectorFor(off, remote: false, "center-1"));
        Assert.Equal(AiAccess.ThisComputer, AiAccessRules.ConnectorFor(off, remote: true, null));
        // Already served by another computer: kept.
        var other = new AiAccess(Remote: true, Connector: "6f0c9b3e-0000-4000-8000-000000000001");
        Assert.Equal(other.Connector, AiAccessRules.ConnectorFor(other, remote: true, "center-1"));
        var saved = AiAccessRules.CurrentCenterId;
        try
        {
            AiAccessRules.CurrentCenterId = "center-1";
            Assert.True(AiAccessRules.ServedHere(new AiAccess(Remote: true, Connector: "center-1")));
            Assert.False(AiAccessRules.ServedHere(other));
            Assert.Equal(L.T("başka bir bilgisayar"), AiAccessText.ConnectorName(other.Connector));
            Assert.Equal(L.T("bu bilgisayar"), AiAccessText.ConnectorName("center-1"));
        }
        finally { AiAccessRules.CurrentCenterId = saved; }
    }

    [Fact]
    public void ApprovalsOfSshServersNameTheServer()
    {
        var item = JsonSerializer.Deserialize<ApprovalRequest>(
            """{"id":"a","device_id":"","target_label":"web-1","action_kind":"fs_move","action":{"kind":"fs_move","source":"/a","destination":"/b"},"expires_at":"2026-11-17T10:00:00Z","created_at":"2026-11-17T09:55:00Z"}""")!;
        Assert.Equal("web-1 · SSH", item.PlaceName(new Dictionary<string, string>()));
        Assert.Equal("/a → /b", item.Summary);
        var write = JsonSerializer.Deserialize<ApprovalRequest>(
            """{"id":"b","device_id":"d1","action_kind":"fs_write","action":{"kind":"fs_write","path":"/srv/x","size":11,"sha256":"0123456789abcdef0123"},"expires_at":"2026-11-17T10:00:00Z","created_at":"2026-11-17T09:55:00Z"}""")!;
        Assert.Equal("PC", write.PlaceName(new Dictionary<string, string> { ["d1"] = "PC" }));
        Assert.Equal("/srv/x (11 B, sha256 0123456789ab…)", write.Summary);
    }
}
