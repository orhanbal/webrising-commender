using System.Text.Json;
using System.Text.Json.Nodes;
using Wecommander.Center.Core;
using Xunit;

/// <summary>Runs against the real wecommander-core when WECOMMANDER_CORE_BIN is set (CI).</summary>
public class CoreClientTests
{
    private static string? Bin => Environment.GetEnvironmentVariable("WECOMMANDER_CORE_BIN");

    [Fact]
    public async Task TalksToTheRealCore()
    {
        if (Bin is null) return; // not built in this run
        var dir = Path.Combine(Path.GetTempPath(), "wc-core-" + Guid.NewGuid());
        try
        {
            var events = new List<string>();
            using var core = CoreClient.Start(Bin, dir, "app.wecommander.test");
            core.Event += (name, _) => { lock (events) events.Add(name); };

            var info = await core.CallAsync("app.info");
            Assert.NotNull(info?["version"]);
            var hosts = await core.CallAsync<List<CoreHost>>("hosts.add",
                new { label = "Prod web", host = "web.example.com", port = 2222, user = "deploy", authKind = "key" });
            Assert.Equal("deploy@web.example.com:2222", Assert.Single(hosts).Target);
            Assert.False(hosts[0].CanConnectSilently);
            Assert.Empty(await core.CallAsync<List<SavedTunnel>>("tunnels.saved"));

            var error = await Assert.ThrowsAsync<CoreException>(() => core.CallAsync("no.such.method"));
            Assert.Equal("unknown method no.such.method", error.Raw);

            // Concurrent requests are matched by id.
            var a = core.CallAsync<List<CoreHost>>("hosts.list");
            var b = core.CallAsync<List<SavedTunnel>>("tunnels.saved");
            await Task.WhenAll(a, b);
            Assert.Single(a.Result);
            Assert.Empty(b.Result);

            // 'changed' event after a change.
            await core.CallAsync("hosts.delete", new { id = hosts[0].Id });
            for (var i = 0; i < 50 && !events.Contains("changed"); i++) await Task.Delay(20);
            lock (events) Assert.Contains("changed", events);

            core.Dispose();
            var stopped = await Assert.ThrowsAsync<CoreException>(() => core.CallAsync("hosts.list"));
            Assert.Equal(CoreException.Stopped, stopped.Raw);
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch (Exception) { }
        }
    }

    [Fact]
    public async Task HostLibraryRoundTrips()
    {
        if (Bin is null) return; // not built in this run
        var dir = Path.Combine(Path.GetTempPath(), "wc-core-" + Guid.NewGuid());
        try
        {
            using var core = CoreClient.Start(Bin, dir, "app.wecommander.test");
            var hosts = await core.CallAsync<List<CoreHost>>("hosts.add",
                new { label = "Web", host = "web.example.com", port = 22, user = "deploy", authKind = "key" });
            var web = Assert.Single(hosts);
            Assert.Equal(CoreHost.NoGroup, web.GroupName);
            Assert.Equal(("deploy", "web.example.com", 22), (web.User, web.Host, web.Port));

            hosts = await core.CallAsync<List<CoreHost>>("hosts.update", new
            {
                id = web.Id, label = "Web 1", host = "web1.example.com", port = 2222, user = "ops",
                authKind = "password", jumpId = web.Id, group = "  Production ",
            });
            web = Assert.Single(hosts);
            Assert.Equal(("Web 1", "ops@web1.example.com:2222", "password", "Production"), (web.Label, web.Target, web.AuthKind, web.Group));
            Assert.Null(web.JumpId); // a host is never its own jump host

            var snippets = await core.CallAsync<List<Snippet>>("snippets.save", new { label = "Disk", command = "df -h" });
            var disk = Assert.Single(snippets);
            snippets = await core.CallAsync<List<Snippet>>("snippets.save", new { id = disk.Id, label = "Disk", command = "df -h /" });
            Assert.Equal("df -h /", Assert.Single(snippets).Command);
            await Assert.ThrowsAsync<CoreException>(() => core.CallAsync("snippets.save", new { label = "", command = "x" }));
            Assert.Empty(await core.CallAsync<List<Snippet>>("snippets.delete", new { id = disk.Id }));

            // Keys: made here, imported, used by a host, deleted.
            var keys = await core.CallAsync<List<KeyMeta>>("keys.generate", new { label = "Laptop" });
            var made = Assert.Single(keys);
            Assert.StartsWith("ssh-ed25519 AAAA", made.PublicKey);
            Assert.StartsWith("SHA256:", made.Fingerprint);
            await Assert.ThrowsAsync<CoreException>(() => core.CallAsync("keys.import", new { label = "Bad", @private = "not a key" }));
            hosts = await core.CallAsync<List<CoreHost>>("hosts.setKey", new { id = web.Id, keyId = made.Id });
            Assert.Equal((made.Id, "key", true), (hosts[0].KeyId, hosts[0].AuthKind, hosts[0].CanConnectSilently));
            Assert.Empty(await core.CallAsync<List<KeyMeta>>("keys.delete", new { id = made.Id }));
            Assert.Null(Assert.Single(await core.CallAsync<List<CoreHost>>("hosts.list")).KeyId);

            Assert.Empty(await core.CallAsync<List<KnownHost>>("known.list"));
            Assert.Empty(await core.CallAsync<List<HistoryEntry>>("history.list"));

            // Terminal options of a host.
            hosts = await core.CallAsync<List<CoreHost>>("hosts.setOptions", new
            {
                id = web.Id, startupCommand = "cd /srv", env = new Dictionary<string, string> { ["LANG"] = "tr_TR.UTF-8" }, agentForwarding = true,
            });
            Assert.Equal(("cd /srv", "tr_TR.UTF-8", true), (hosts[0].StartupCommand, hosts[0].Env!["LANG"], hosts[0].AgentForwarding));
            await Assert.ThrowsAsync<CoreException>(() => core.CallAsync("hosts.setOptions", new
            {
                id = web.Id, env = new Dictionary<string, string> { ["BAD NAME"] = "x" },
            }));

            // Saved tunnels of every kind.
            var tunnels = await core.CallAsync<List<SavedTunnel>>("tunnels.save", new { hostId = web.Id, kind = "dynamic", localPort = 1080 });
            Assert.Equal(("dynamic", "127.0.0.1:1080", "SOCKS5"), (tunnels[0].Kind, tunnels[0].Local, tunnels[0].Remote));
            tunnels = await core.CallAsync<List<SavedTunnel>>("tunnels.save", new { hostId = web.Id, kind = "remote", localPort = 3000, remotePort = 8080 });
            Assert.Equal(("remote", "localhost:8080 (sunucu)", "127.0.0.1:3000"), (tunnels[1].Kind, tunnels[1].Local, tunnels[1].Remote));
            await Assert.ThrowsAsync<CoreException>(() => core.CallAsync("tunnels.save", new { hostId = web.Id, kind = "local", localPort = 1080, remoteHost = "db", remotePort = 5432 }));

            // Backup: export, then import into a fresh library.
            var json = (await core.CallAsync<JsonElement>("library.export")).GetProperty("json").GetString()!;
            Assert.Contains("wecommander-library", json);
            var dir2 = Path.Combine(Path.GetTempPath(), "wc-core-" + Guid.NewGuid());
            try
            {
                using var other = CoreClient.Start(Bin, dir2, "app.wecommander.test2");
                var summary = await other.CallAsync<ImportSummary>("library.import", new { json });
                Assert.Equal(1, summary.Hosts);
                var imported = Assert.Single(await other.CallAsync<List<CoreHost>>("hosts.list"));
                Assert.Equal(("Web 1", "cd /srv"), (imported.Label, imported.StartupCommand));
                Assert.Equal(2, (await other.CallAsync<List<SavedTunnel>>("tunnels.saved")).Count);
                Assert.Equal(0, (await other.CallAsync<ImportSummary>("library.import", new { json })).Hosts);
                await Assert.ThrowsAsync<CoreException>(() => other.CallAsync("library.import", new { json = "{}" }));
            }
            finally
            {
                try { Directory.Delete(dir2, true); } catch (Exception) { }
            }
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch (Exception) { }
        }
    }

    [Fact]
    public void HandlesRepliesAndEventsLine()
    {
        Assert.Equal("Giriş reddedildi. Anahtarı veya parolayı kontrol et.", CoreText.Turkish("authentication failed"));
        Assert.Equal("Atlama sunucusu: Bastion: no route", CoreText.Turkish("jump host Bastion: no route"));
        Assert.Equal("other", CoreText.Turkish("other"));
    }
}

public class AgentUpdateTests
{
    [Fact]
    public void FindsTheNewestWindowsBuild()
    {
        const string json = """
        [
          {"tag_name":"ubuntu-preview-1765","draft":false,"assets":[{"name":"WECOMMANDER-Setup-windows-x64.exe"}]},
          {"tag_name":"ubuntu-preview-1770","draft":true,"assets":[{"name":"WECOMMANDER-Setup-windows-x64.exe"}]},
          {"tag_name":"ubuntu-preview-1768","draft":false,"assets":[{"name":"other.deb"}]},
          {"tag_name":"macos-preview-1800","draft":false,"assets":[{"name":"WECOMMANDER-Setup-windows-x64.exe"}]},
          {"tag_name":"ubuntu-preview-1740","assets":[{"name":"WECOMMANDER-Setup-windows-x64.exe"}]}
        ]
        """;
        Assert.Equal(1765, AgentUpdate.LatestWindowsBuild(json));
        Assert.Null(AgentUpdate.LatestWindowsBuild("{\"message\":\"rate limited\"}"));
        Assert.Null(AgentUpdate.LatestWindowsBuild("not json"));
        Assert.True(AgentUpdate.IsNewer(1765, "0.1.1725"));
        Assert.False(AgentUpdate.IsNewer(1765, "0.1.1765"));
        Assert.False(AgentUpdate.IsNewer(null, "0.1.1"));
        Assert.False(AgentUpdate.IsNewer(1765, null));
        Assert.Equal(1725, AgentUpdate.Build("0.1.1725"));
    }
}
