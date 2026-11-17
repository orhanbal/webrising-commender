using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Wecommander.Center.Core;
using Xunit;

namespace Wecommander.Center.Core.Tests;

/// <summary>Records the calls and answers like wecommander-core would (contract section 7).</summary>
internal sealed class FakeCore : ICoreTransport
{
    public List<(string Method, JsonNode? Params)> Calls { get; } = [];
    public Func<string, JsonNode?, JsonNode?> Answer { get; set; } = (_, _) => null;

    public Task<JsonNode?> CallAsync(string method, object? parameters = null)
    {
        var p = parameters is null ? null : JsonSerializer.SerializeToNode(parameters, CoreClient.Json);
        Calls.Add((method, p));
        try { return Task.FromResult(Answer(method, p)); }
        catch (CoreException e) { return Task.FromException<JsonNode?>(e); }
    }
}

public class AiAccessTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 17, 12, 0, 0, TimeSpan.Zero);

    private static CoreHost Host(string protocol = "ssh", string? trusted = "SHA256:abc", string auth = "key", bool saved = false,
        AiAccess? ai = null, string? keyId = null) =>
        new("h1", "Prod web", "deploy@web:22", auth, saved, null, null, trusted, Protocol: protocol, AiAccess: ai, KeyId: keyId,
            User: "deploy", Host: "web");

    [Fact]
    public void HostsWithoutAiAccessAreOffAndReadFromTheCoreJson()
    {
        var json = """
            [{"id":"a","label":"A","target":"u@a:22","authKind":"key","savedSecret":false,"protocol":"ssh"},
             {"id":"b","label":"B","target":"u@b:22","authKind":"key","savedSecret":true,"protocol":"ssh",
              "aiAccess":{"local":true,"remote":false,"connector":"this-computer","preset":"timed","timedUntil":"2026-11-17T15:00:00Z","sudo":"sudoers"}}]
            """;
        var hosts = JsonSerializer.Deserialize<List<CoreHost>>(json, CoreClient.Json)!;
        Assert.Equal(AiAccess.Off, AiAccessRules.Of(hosts[0]));
        Assert.False(AiAccessRules.Of(hosts[0]).Any);
        var b = AiAccessRules.Of(hosts[1]);
        Assert.True(b.Local);
        Assert.Equal(AiAccess.Timed, b.Preset);
        Assert.Equal(AiAccess.SudoSudoers, b.Sudo);
        Assert.Equal(new DateTimeOffset(2026, 11, 17, 15, 0, 0, TimeSpan.Zero), b.TimedUntilTime);
    }

    [Fact]
    public void DefaultsAreApprovalAndNoSudo()
    {
        var off = AiAccess.Off;
        Assert.False(off.Local);
        Assert.False(off.Remote);
        Assert.Equal(AiAccess.Approval, off.Preset);
        Assert.Equal(AiAccess.SudoNever, off.Sudo);
        Assert.Equal(AiAccess.ThisComputer, off.Connector);
    }

    [Fact]
    public void SerializesExactlyTheContractFields()
    {
        var node = JsonSerializer.SerializeToNode(new AiAccess(Local: true), CoreClient.Json)!.AsObject();
        Assert.Equal(["local", "remote", "connector", "preset", "timedUntil", "sudo"], node.Select(kv => kv.Key).ToArray());
    }

    [Fact]
    public void BlockersNameWhatToFixFirst()
    {
        Assert.Empty(AiAccessRules.Blockers(Host()));
        Assert.Equal([AiBlocker.NotSsh], AiAccessRules.Blockers(Host("telnet")));
        Assert.Equal([AiBlocker.NotSsh], AiAccessRules.Blockers(Host("serial")));
        Assert.Equal([AiBlocker.NotSsh], AiAccessRules.Blockers(Host("mosh")));
        Assert.Equal([AiBlocker.HostKeyUntrusted], AiAccessRules.Blockers(Host(trusted: null)));
        Assert.Equal([AiBlocker.HostKeyUntrusted, AiBlocker.NeedsCredential], AiAccessRules.Blockers(Host(trusted: null, auth: "password")));
        // A saved password, an app key or a key login (~/.ssh, SSH agent) can log in silently.
        Assert.Empty(AiAccessRules.Blockers(Host(auth: "password", saved: true)));
        Assert.Empty(AiAccessRules.Blockers(Host(auth: "password", keyId: "k1")));
    }

    [Fact]
    public void ValidatesPresetSudoAndTheEightHourLimit()
    {
        Assert.Null(AiAccessRules.Validate(new AiAccess(Local: true), Now));
        Assert.Equal(AiAccessRules.InvalidPreset, AiAccessRules.Validate(new AiAccess(Preset: "god"), Now));
        Assert.Equal(AiAccessRules.InvalidSudo, AiAccessRules.Validate(new AiAccess(Sudo: "always"), Now));
        Assert.Equal(AiAccessRules.InvalidConnector, AiAccessRules.Validate(new AiAccess(Remote: true, Connector: " "), Now));
        Assert.Equal(AiAccessRules.TimedNeedsUntil, AiAccessRules.Validate(new AiAccess(Preset: AiAccess.Timed), Now));
        Assert.Equal(AiAccessRules.TimedInPast, AiAccessRules.Validate(new AiAccess(Preset: AiAccess.Timed, TimedUntil: "2026-11-17T11:00:00Z"), Now));
        Assert.Equal(AiAccessRules.TimedTooLong, AiAccessRules.Validate(new AiAccess(Preset: AiAccess.Timed, TimedUntil: "2026-11-17T21:00:00Z"), Now));
        var eight = AiAccessRules.TimedFor(new AiAccess(Local: true), TimeSpan.FromHours(8), Now);
        Assert.Equal("2026-11-17T20:00:00Z", eight.TimedUntil);
        Assert.Null(AiAccessRules.Validate(eight, Now));
        // More than 8 hours is cut to 8.
        Assert.Equal("2026-11-17T20:00:00Z", AiAccessRules.TimedFor(AiAccess.Off, TimeSpan.FromHours(30), Now).TimedUntil);
    }

    [Fact]
    public void NormalizeDropsWhatDoesNotApply()
    {
        var n = AiAccessRules.Normalize(new AiAccess(Local: true, Connector: "dev-1", Preset: AiAccess.Approval, TimedUntil: "2026-11-17T13:00:00Z"));
        Assert.Equal(AiAccess.ThisComputer, n.Connector);
        Assert.Null(n.TimedUntil);
        Assert.Equal("dev-1", AiAccessRules.Normalize(new AiAccess(Remote: true, Connector: "dev-1")).Connector);
    }

    [Fact]
    public void RemoteIsSupportedOnlyWhenTheCoreSaysSo()
    {
        Assert.False(AiAccessRules.RemoteSupported(null));
        Assert.False(AiAccessRules.RemoteSupported(JsonNode.Parse("""{"version":"1"}""")));
        Assert.True(AiAccessRules.RemoteSupported(JsonNode.Parse("""{"remoteMcp":true}""")));
        Assert.True(AiAccessRules.RemoteSupported(JsonNode.Parse("""{"features":["x","remote-mcp"]}""")));
        Assert.True(AiAccessRules.RemoteSupported(null, JsonNode.Parse("""{"remoteSupported":true}""")));
    }

    [Fact]
    public void ErrorCodesBecomeClearSentences()
    {
        {
            Assert.Contains("host key", new CoreException("host_key_untrusted").Message);
            Assert.Equal(AiBlocker.HostKeyUntrusted, AiAccessRules.BlockerFromError("host_key_untrusted"));
            Assert.Equal(AiBlocker.NeedsCredential, AiAccessRules.BlockerFromError("error: needs_credential"));
            Assert.Equal(AiBlocker.NotSsh, AiAccessRules.BlockerFromError("not_ssh"));
            Assert.Null(AiAccessRules.BlockerFromError("timed out"));
            Assert.Equal(AiAccessText.RemoteNotYet, new CoreException("remote_not_supported").Message);
            foreach (var code in new[] { "needs_credential", "not_ssh", "timed_too_long", "connector_offline", "wecommander_not_running", "approval_expired" })
            {
                var text = new CoreException(code).Message;
                Assert.NotEqual(code, text);
                Assert.DoesNotContain("_", text);
            }
            // Other errors keep their old mapping.
            Assert.Equal(new CoreException("terminal closed").Message, L.T("Terminal kapalı."));
        }
    }

    [Fact]
    public void BadgesShowTheMethodAndTheAiRoute()
    {
        Assert.Equal(["SSH", L.T("Yalnız elle")], HostBadges.For(Host()).Select(b => b.Text));
        Assert.Equal("manual", HostBadges.For(Host())[1].Kind);
        Assert.Equal(["SSH", L.T("Ajan"), L.T("Yerel YZ")], HostBadges.For(Host(ai: new AiAccess(Local: true)), agentLinked: true).Select(b => b.Text));
        Assert.Equal(["SSH", L.T("Yerel YZ"), L.T("Uzak YZ")], HostBadges.For(Host(ai: new AiAccess(Local: true, Remote: true))).Select(b => b.Text));
        Assert.Equal(L.F("Uzak YZ · {0}", AiAccessText.ConnectorName("dev-7")), HostBadges.For(Host(ai: new AiAccess(Remote: true, Connector: "dev-7")))[1].Text);
        Assert.Equal("Telnet", HostBadges.For(Host("telnet"))[0].Text);

        Assert.Equal(L.T("Yapay zekâ bu sunucuyu göremez; yalnız sen elle bağlanırsın."), HostBadges.Explain(Host()));
        var tip = HostBadges.Explain(Host(ai: new AiAccess(Local: true)));
        Assert.Contains("SSH", tip);
        Assert.Contains(L.T("bu bilgisayar"), tip);
        Assert.Contains(L.T("komutlar onaylı"), tip);
        Assert.Contains(L.T("yalnız okuma"), HostBadges.Explain(Host(ai: new AiAccess(Local: true, Preset: AiAccess.ReadOnly))));
    }

    [Fact]
    public void EveryChoiceExplainsItself()
    {
        foreach (var p in AiAccess.Presets)
        {
            Assert.False(string.IsNullOrWhiteSpace(AiAccessText.PresetTitle(p)));
            Assert.True(AiAccessText.PresetHelp(p).Length > 40);
        }
        Assert.NotEqual(AiAccessText.PresetHelp(AiAccess.ReadOnly), AiAccessText.PresetHelp(AiAccess.Approval));
        foreach (var s in AiAccess.SudoModes) Assert.True(AiAccessText.SudoHelp(s).Length > 40);
        foreach (var b in Enum.GetValues<AiBlocker>())
        {
            Assert.True(AiAccessText.BlockerText(b).Length > 20);
            Assert.False(string.IsNullOrWhiteSpace(AiAccessText.BlockerFix(b)));
        }
        foreach (var c in AiAccessText.SetupClients)
        {
            Assert.NotEqual(c, AiAccessText.ClientName(c));
            Assert.True(AiAccessText.ClientHelp(c).Length > 20);
            Assert.Contains(AiAccessText.ClientName(c).Split(' ')[0], AiAccessText.AddTo(c));
        }
        Assert.Equal(4, AiAccessText.Guarantees.Count);
        Assert.Contains("Sunucuya ajan kurmak istemiyorsan bu yöntemi seç.", AiAccessText.MethodSshHelp);
        Assert.Equal("Uzak yapay zekâ erişimi bir sonraki sürümde gelecek; şimdilik yerel erişim açılabilir.", AiAccessText.RemoteNotYet);
        Assert.Equal("Bu dosyaya yalnızca WECOMMANDER girdisi eklenir; diğer ayarlarına dokunulmaz.", AiAccessText.ConfigNote);
    }
}

public class LocalMcpTests
{
    private static readonly DateTimeOffset Now = new(2026, 11, 17, 12, 0, 0, TimeSpan.Zero);

    private static CoreHost Host(string? trusted = "SHA256:abc", string protocol = "ssh") =>
        new("h1", "Prod web", "deploy@web:22", "key", false, null, null, trusted, Protocol: protocol);

    [Fact]
    public async Task SavesAiAccessWithTheContractShapeAndReturnsTheHosts()
    {
        var core = new FakeCore
        {
            Answer = (method, p) => JsonNode.Parse("""[{"id":"h1","label":"Prod web","target":"deploy@web:22","authKind":"key","savedSecret":false,"protocol":"ssh","aiAccess":{"local":true}}]"""),
        };
        var hosts = await new LocalMcpService(core).SetAiAccess(Host(), new AiAccess(Local: true, Connector: "x", TimedUntil: "y"), remoteSupported: false, Now);
        var (method, sent) = Assert.Single(core.Calls);
        Assert.Equal("hosts.setAiAccess", method);
        Assert.Equal("h1", (string?)sent!["id"]);
        var ai = sent["aiAccess"]!;
        Assert.True((bool)ai["local"]!);
        Assert.False((bool)ai["remote"]!);
        Assert.Equal("this-computer", (string?)ai["connector"]);
        Assert.Equal("approval", (string?)ai["preset"]);
        Assert.Null(ai["timedUntil"]);
        Assert.Equal("never", (string?)ai["sudo"]);
        Assert.True(AiAccessRules.Of(Assert.Single(hosts)).Local);
    }

    [Fact]
    public async Task RemoteWaitsForACoreThatSupportsIt()
    {
        var core = new FakeCore { Answer = (_, _) => new JsonArray() };
        var svc = new LocalMcpService(core);
        var e = await Assert.ThrowsAsync<CoreException>(() => svc.SetAiAccess(Host(), new AiAccess(Remote: true), remoteSupported: false, Now));
        Assert.Equal(AiAccessRules.RemoteNotSupported, e.Raw);
        Assert.Equal(AiAccessText.RemoteNotYet, e.Message);
        Assert.Empty(core.Calls);
        await svc.SetAiAccess(Host(), new AiAccess(Remote: true), remoteSupported: true, Now);
        Assert.Single(core.Calls);
    }

    [Fact]
    public async Task RefusesBeforeCallingWhenAPreconditionIsMissing()
    {
        var core = new FakeCore();
        var svc = new LocalMcpService(core);
        var e = await Assert.ThrowsAsync<CoreException>(() => svc.SetAiAccess(Host(trusted: null), new AiAccess(Local: true), false, Now));
        Assert.Equal(AiAccessRules.HostKeyUntrusted, e.Raw);
        e = await Assert.ThrowsAsync<CoreException>(() => svc.SetAiAccess(Host(protocol: "telnet"), new AiAccess(Local: true), false, Now));
        Assert.Equal(AiAccessRules.NotSsh, e.Raw);
        e = await Assert.ThrowsAsync<CoreException>(() => svc.SetAiAccess(Host(), new AiAccess(Local: true, Preset: AiAccess.Timed, TimedUntil: "2026-11-18T12:00:00Z"), false, Now));
        Assert.Equal(AiAccessRules.TimedTooLong, e.Raw);
        Assert.Empty(core.Calls);
        // Switching off always goes through, whatever the host lacks.
        await svc.SetAiAccess(Host(trusted: null), AiAccess.Off, false, Now);
        Assert.Single(core.Calls);
    }

    [Fact]
    public async Task TheCoresRefusalKeepsItsCodeAndGetsAClearMessage()
    {
        var core = new FakeCore { Answer = (_, _) => throw new CoreException("needs_credential") };
        var e = await Assert.ThrowsAsync<CoreException>(() => new LocalMcpService(core).SetAiAccess(Host(), new AiAccess(Local: true), false, Now));
        Assert.Equal(AiBlocker.NeedsCredential, AiAccessRules.BlockerFromError(e.Raw));
        Assert.Equal(AiAccessText.BlockerText(AiBlocker.NeedsCredential), e.Message);
    }

    [Fact]
    public async Task McpCallsUseTheContractNames()
    {
        var core = new FakeCore
        {
            Answer = (method, p) => method switch
            {
                "mcp.status" => JsonNode.Parse("""{"enabled":true,"endpoint":"\\\\.\\pipe\\wecommander-mcp","bridgeCommand":["C:\\app\\wecommander-core.exe","--mcp-stdio"],"clients":[{"id":"c1","name":"Claude Desktop","version":"1.2","allowed":true,"firstSeen":"2026-11-17T10:00:00Z","lastSeen":1763380000}]}"""),
                "mcp.clients" => JsonNode.Parse("""[{"id":"c1","name":"Cursor","allowed":false}]"""),
                "mcp.configFor" => JsonNode.Parse("""{"path":"C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json","before":null,"after":"{}"}"""),
                _ => null,
            },
        };
        var svc = new LocalMcpService(core);
        var status = await svc.Status();
        Assert.True(status.Enabled);
        Assert.Equal(["C:\\app\\wecommander-core.exe", "--mcp-stdio"], status.BridgeCommand);
        var client = Assert.Single(status.Clients);
        Assert.Equal("Claude Desktop", client.Name);
        Assert.True(client.Allowed);
        Assert.Equal(new DateTimeOffset(2026, 11, 17, 10, 0, 0, TimeSpan.Zero), client.FirstSeen);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1763380000), client.LastSeen);
        Assert.False(status.RemoteSupported);
        Assert.False(Assert.Single(await svc.Clients()).Allowed);
        await svc.AllowClient("c1", false);
        await svc.ForgetClient("c1");
        var preview = await svc.ConfigFor("claude-desktop");
        Assert.Null(preview.Before);
        Assert.Equal("{}", preview.After);
        await svc.WriteConfig("claude-desktop");
        await svc.Decide("a1", true);
        Assert.Equal(["mcp.status", "mcp.clients", "mcp.allowClient", "mcp.forgetClient", "mcp.configFor", "mcp.writeConfig", "mcp.decide"], core.Calls.Select(c => c.Method));
        Assert.False((bool)core.Calls[2].Params!["allow"]!);
        Assert.Equal("claude-desktop", (string?)core.Calls[4].Params!["client"]);
        Assert.Equal("a1", (string?)core.Calls[6].Params!["approvalId"]);
        Assert.True((bool)core.Calls[6].Params!["approve"]!);
        await Assert.ThrowsAsync<CoreException>(() => svc.ConfigFor("notepad"));
    }

    [Fact]
    public void ParsesTheEvents()
    {
        var req = McpParse.ClientRequest(JsonNode.Parse("""{"id":"c9","name":"Claude Code","version":"2.0"}"""));
        Assert.Equal(new McpClientRequest("c9", "Claude Code", "2.0"), req);
        var approval = McpParse.Approval(JsonNode.Parse("""{"approvalId":"a1","clientName":"Cursor","targetId":"t1","targetLabel":"Prod web","tool":"process_exec","summary":"restart nginx","command":"sudo systemctl restart nginx","expiresAt":"2026-11-17T12:05:00Z"}"""), Now);
        Assert.Equal("sudo systemctl restart nginx", approval.Command);
        Assert.Equal(Now.AddMinutes(5), approval.ExpiresAt);
        Assert.Equal(Now.AddMinutes(5), McpParse.Approval(JsonNode.Parse("""{"approvalId":"a2"}"""), Now).ExpiresAt);
        var act = McpParse.Activity(JsonNode.Parse("""{"clientName":"Codex","targetLabel":"db","tool":"fs_read","outcome":"ok"}"""), Now);
        Assert.Equal(Now, act.At);
        Assert.Equal(L.T("tamamlandı"), AiAccessText.Outcome(act.Outcome));
    }

    [Fact]
    public void ActivityLogKeepsTheNewestFirst()
    {
        var log = new McpActivityLog(3);
        for (var i = 0; i < 5; i++) log.Add(new McpActivity("c", "t", "tool" + i, "ok", Now.AddSeconds(i)));
        Assert.Equal(["tool4", "tool3", "tool2"], log.Items.Select(a => a.Tool));
    }

    [Fact]
    public void ApprovalToastShowsTheExactCommandAndNeverApprovesByItself()
    {
        var item = new McpApproval("a&1", "Claude <Desktop>", "t1", "Prod web", "process_exec", "", "rm -rf \"/tmp/x\" && echo ok", Now.AddMinutes(5));
        var doc = XDocument.Parse(ToastContent.McpApproval(item, urgent: true));
        Assert.Equal("urgent", doc.Root!.Attribute("scenario")!.Value);
        Assert.Contains(doc.Descendants("text"), t => t.Value == "rm -rf \"/tmp/x\" && echo ok");
        var actions = doc.Descendants("action").Select(a => ToastContent.DecodeArgs(a.Attribute("arguments")!.Value)).ToList();
        Assert.Equal(["mcp-approve", "mcp-deny"], actions.Select(a => a["action"]));
        Assert.All(actions, a => Assert.Equal("a&1", a["id"]));
        // A click on the toast body only opens the app.
        Assert.Equal("mcp-open", ToastContent.DecodeArgs(doc.Root.Attribute("launch")!.Value)["action"]);

        var request = XDocument.Parse(ToastContent.McpClientRequest(new McpClientRequest("c1", "Cursor", null)));
        Assert.Equal(["mcp-allow", "mcp-block"], request.Descendants("action").Select(a => ToastContent.DecodeArgs(a.Attribute("arguments")!.Value)["action"]));
        Assert.Contains(request.Descendants("text"), t => t.Value == AiAccessText.ClientRequestTitle("Cursor"));
    }
}

public class ConfigDiffTests
{
    [Fact]
    public void ShowsOnlyTheAddedEntry()
    {
        var before = "{\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"other\": {}\n  }\n}";
        var after = "{\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"other\": {},\n    \"wecommander\": {\"command\": \"x\"}\n  }\n}";
        var lines = ConfigDiff.Lines(before, after);
        Assert.Equal(["    \"other\": {},", "    \"wecommander\": {\"command\": \"x\"}"], lines.Where(l => l.Kind == '+').Select(l => l.Text));
        Assert.Equal(["    \"other\": {}"], lines.Where(l => l.Kind == '-').Select(l => l.Text));
        Assert.Equal(L.F("{0} satır eklenir, {1} satır değişir (yalnız WECOMMANDER girdisi ve çevresindeki biçim).", 2, 1), ConfigDiff.Summary(before, after));
        // Every original line is still there, in order.
        Assert.Equal(before.Split('\n').Where(l => l != "    \"other\": {}"), lines.Where(l => l.Kind == ' ').Select(l => l.Text));
    }

    [Fact]
    public void SummarizesNewUnchangedAndPureAdditions()
    {
        Assert.Equal(L.F("Dosya yok; WECOMMANDER girdisiyle yeni oluşturulur ({0} satır).", 3), ConfigDiff.Summary(null, "{\n  \"a\": 1\n}\n"));
        Assert.Equal(L.T("Değişiklik yok: WECOMMANDER zaten ekli."), ConfigDiff.Summary("a\r\nb", "a\nb\n"));
        Assert.Equal(L.F("{0} satır eklenir; mevcut satırların hiçbiri silinmez.", 2), ConfigDiff.Summary("[a]\nx = 1", "[a]\nx = 1\n[mcp_servers.wecommander]\ncommand = \"c\""));
        Assert.All(ConfigDiff.Lines(null, "a\nb"), l => Assert.Equal('+', l.Kind));
    }

    [Fact]
    public void CompactKeepsContextAroundChanges()
    {
        var before = string.Join("\n", Enumerable.Range(0, 40).Select(i => "line" + i));
        var after = before.Replace("line20", "line20\nNEW");
        var compact = ConfigDiff.Compact(ConfigDiff.Lines(before, after), context: 2);
        Assert.Equal('…', compact[0].Kind);
        Assert.Equal(L.F("{0} satır değişmeden kalır", 19), compact[0].Text);
        Assert.Equal(["line19", "line20", "NEW", "line21", "line22"], compact.Skip(1).Take(5).Select(l => l.Text));
        Assert.Equal('…', compact[^1].Kind);
    }

    [Fact]
    public void VeryLargeFilesStillDiff()
    {
        var a = string.Join("\n", Enumerable.Range(0, 3000).Select(i => "a" + i));
        var b = string.Join("\n", Enumerable.Range(0, 3000).Select(i => "b" + i));
        var lines = ConfigDiff.Lines(a, b);
        Assert.Equal(3000, lines.Count(l => l.Kind == '-'));
        Assert.Equal(3000, lines.Count(l => l.Kind == '+'));
    }
}
