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
    public async Task TelnetHostsKeepTheirConnectionType()
    {
        if (Bin is null) return; // not built in this run
        var dir = Path.Combine(Path.GetTempPath(), "wc-core-" + Guid.NewGuid());
        try
        {
            using var core = CoreClient.Start(Bin, dir, "app.wecommander.test");
            var host = Assert.Single(await core.CallAsync<List<CoreHost>>("hosts.add",
                new { label = "Router", host = "192.168.1.1", port = 23, user = "telnet", authKind = "password" }));
            Assert.True(host.IsSsh);
            var telnet = Assert.Single(await core.CallAsync<List<CoreHost>>("hosts.setConnection", new { id = host.Id, protocol = "telnet" }));
            Assert.Equal("telnet", telnet.Protocol);
            Assert.False(telnet.IsSsh);
            Assert.Equal("telnet://192.168.1.1", telnet.Target);
            var error = await Assert.ThrowsAsync<CoreException>(() =>
                core.CallAsync<List<CoreHost>>("hosts.setConnection", new { id = host.Id, protocol = "rlogin" }));
            Assert.Contains("unknown connection type", error.Raw);
            var back = Assert.Single(await core.CallAsync<List<CoreHost>>("hosts.setConnection", new { id = host.Id, protocol = "ssh" }));
            Assert.True(back.IsSsh);
        }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
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
            Assert.Empty(await core.CallAsync<List<Identity>>("identities.list"));

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

            // Identities: a password identity used by the host.
            var ids = await core.CallAsync<List<Identity>>("identities.save", new { label = "Team", user = "deploy", authKind = "password", password = "pw" });
            var team = Assert.Single(ids);
            hosts = await core.CallAsync<List<CoreHost>>("hosts.setIdentity", new { id = web.Id, identityId = team.Id });
            Assert.Equal((team.Id, "deploy", "password", true), (hosts[0].IdentityId, hosts[0].User, hosts[0].AuthKind, hosts[0].SavedSecret));
            await Assert.ThrowsAsync<CoreException>(() => core.CallAsync("identities.save", new { label = "K", user = "x", authKind = "key" }));

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
                Assert.Equal(team.Id, imported.IdentityId);
                Assert.False(imported.SavedSecret); // passwords never travel in a backup
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

    /// <summary>A20: two computers sync through a stand-in for /api/center/library.</summary>
    [Fact]
    public async Task LibrarySyncsBetweenTwoComputers()
    {
        if (Bin is null) return;
        var dirA = Path.Combine(Path.GetTempPath(), "wc-core-" + Guid.NewGuid());
        var dirB = Path.Combine(Path.GetTempPath(), "wc-core-" + Guid.NewGuid());
        var server = new LibraryState(0, null);
        Task<LibraryState> Get() => Task.FromResult(server);
        Task<(bool, LibraryState)> Put(long rev, string env)
        {
            if (rev != server.Revision) return Task.FromResult((false, server));
            Assert.DoesNotContain("web.example.com", env); // the server never sees the library
            server = new LibraryState(rev + 1, env);
            return Task.FromResult((true, server));
        }
        try
        {
            using var a = CoreClient.Start(Bin, dirA, "app.wecommander.sync-a");
            using var b = CoreClient.Start(Bin, dirB, "app.wecommander.sync-b");
            Assert.False((await a.CallAsync<SyncStatus>("sync.status")).Configured);
            await a.CallAsync<SyncStatus>("sync.setup", new { passphrase = "correct horse battery" });
            var hosts = await a.CallAsync<List<CoreHost>>("hosts.add", new { label = "Web", host = "web.example.com", port = 22, user = "deploy", authKind = "key" });
            await LibrarySync.RunAsync(a, Get, Put);
            Assert.Equal(1, server.Revision);

            // The second computer needs the same passphrase.
            await Assert.ThrowsAsync<CoreException>(() => b.CallAsync("sync.setup", new { passphrase = "wrong passphrase", remote = server.Envelope }));
            await b.CallAsync("snippets.save", new { label = "Disk", command = "df -h" });
            await b.CallAsync<SyncStatus>("sync.setup", new { passphrase = "correct horse battery", remote = server.Envelope });
            Assert.True(await LibrarySync.RunAsync(b, Get, Put));
            Assert.Equal("Web", Assert.Single(await b.CallAsync<List<CoreHost>>("hosts.list")).Label);

            // A gets B's snippet; then a deletion on A reaches B.
            Assert.True(await LibrarySync.RunAsync(a, Get, Put));
            Assert.Equal("Disk", Assert.Single(await a.CallAsync<List<Snippet>>("snippets.list")).Label);
            await a.CallAsync("hosts.delete", new { id = hosts[0].Id });
            await LibrarySync.RunAsync(a, Get, Put);
            await LibrarySync.RunAsync(b, Get, Put);
            Assert.Empty(await b.CallAsync<List<CoreHost>>("hosts.list"));
            Assert.Single(await b.CallAsync<List<Snippet>>("snippets.list"));
            // Nothing new: no upload.
            var rev = server.Revision;
            Assert.False(await LibrarySync.RunAsync(b, Get, Put));
            Assert.Equal(rev, server.Revision);
        }
        finally
        {
            foreach (var d in new[] { dirA, dirB }) try { Directory.Delete(d, true); } catch (Exception) { }
        }
    }

    /// <summary>A22: a stand-in for /api/center/team shared by two apps.</summary>
    private sealed class FakeTeam
    {
        public readonly Dictionary<string, (string Pub, string? Wrapped)> Keys = [];
        public LibraryState Library = new(0, null);
        public Server For(string centerId, string role) => new(this, centerId, role);

        public sealed class Server(FakeTeam t, string centerId, string role) : ITeamServer
        {
            public Task<TeamState> GetAsync() => Task.FromResult(new TeamState("Acme", role,
                t.Keys.TryGetValue(centerId, out var mine) ? mine.Wrapped : null,
                t.Keys.Select(k => new TeamMember(k.Key, k.Key + "@x", "operator", k.Key, k.Value.Pub, k.Value.Wrapped is not null)).ToList(),
                t.Library.Revision, t.Library.Envelope));
            public Task PutKeyAsync(string publicKey) { t.Keys[centerId] = (publicKey, null); return Task.CompletedTask; }
            public Task PutWrappedKeyAsync(string id, string wrapped) { t.Keys[id] = (t.Keys[id].Pub, wrapped); return Task.CompletedTask; }
            public Task<(bool, LibraryState)> PutLibraryAsync(long rev, string env)
            {
                if (rev != t.Library.Revision) return Task.FromResult((false, t.Library));
                Assert.DoesNotContain("db.example.com", env);
                t.Library = new LibraryState(rev + 1, env);
                return Task.FromResult((true, t.Library));
            }
        }
    }

    [Fact]
    public async Task TeamSharesHostsEndToEnd()
    {
        if (Bin is null) return;
        var dirA = Path.Combine(Path.GetTempPath(), "wc-core-" + Guid.NewGuid());
        var dirB = Path.Combine(Path.GetTempPath(), "wc-core-" + Guid.NewGuid());
        var team = new FakeTeam();
        try
        {
            using var a = CoreClient.Start(Bin, dirA, "app.wecommander.team-a");
            using var b = CoreClient.Start(Bin, dirB, "app.wecommander.team-b");
            var hosts = await a.CallAsync<List<CoreHost>>("hosts.add", new { label = "DB", host = "db.example.com", port = 22, user = "ops", authKind = "password" });
            await a.CallAsync("hosts.add", new { label = "Mine", host = "me.example.com", port = 22, user = "me", authKind = "key" });
            hosts = await a.CallAsync<List<CoreHost>>("library.setTeam", new { kind = "host", id = hosts[0].Id, team = true });
            Assert.True(hosts.Single(h => h.Label == "DB").Team);

            Assert.Equal(TeamSyncState.Ok, (await TeamSync.RunAsync(a, team.For("A", "admin"))).State);
            Assert.Equal(TeamSyncState.WaitingForKey, (await TeamSync.RunAsync(b, team.For("B", "operator"))).State);
            await TeamSync.RunAsync(a, team.For("A", "admin")); // gives B the key
            var (state, changed) = await TeamSync.RunAsync(b, team.For("B", "operator"));
            Assert.Equal((TeamSyncState.Ok, true), (state, changed));
            var shared = Assert.Single(await b.CallAsync<List<CoreHost>>("hosts.list"));
            Assert.Equal(("DB", true), (shared.Label, shared.Team)); // only the shared host

            // A27: a shared terminal frame sealed by A opens on B (same team key).
            var frame = (await a.CallAsync<JsonElement>("team.seal", new { data = "bHMgLWxh" })).GetProperty("data").GetString();
            Assert.DoesNotContain("bHMgLWxh", frame);
            Assert.Equal("bHMgLWxh", (await b.CallAsync<JsonElement>("team.open", new { data = frame })).GetProperty("data").GetString());

            // B renames it; A gets the change. A viewer never uploads.
            await b.CallAsync("hosts.update", new { id = shared.Id, label = "DB prod", host = "db.example.com", port = 22, user = "ops", authKind = "password", group = "Ekip" });
            await TeamSync.RunAsync(b, team.For("B", "operator"));
            await TeamSync.RunAsync(a, team.For("A", "admin"));
            Assert.Contains(await a.CallAsync<List<CoreHost>>("hosts.list"), h => h.Label == "DB prod");
            var rev = team.Library.Revision;
            await b.CallAsync("hosts.update", new { id = shared.Id, label = "viewer edit", host = "db.example.com", port = 22, user = "ops", authKind = "password" });
            await TeamSync.RunAsync(b, team.For("B", "viewer"));
            Assert.Equal(rev, team.Library.Revision);

            // Leaving the team removes the shared hosts only.
            await a.CallAsync("team.leave");
            Assert.Equal("Mine", Assert.Single(await a.CallAsync<List<CoreHost>>("hosts.list")).Label);
        }
        finally
        {
            foreach (var d in new[] { dirA, dirB }) try { Directory.Delete(d, true); } catch (Exception) { }
        }
    }

    [Fact]
    public void HandlesRepliesAndEventsLine()
    {
        Assert.Equal("Giriş reddedildi. Anahtarı veya parolayı kontrol et.", CoreText.Turkish("authentication failed"));
        Assert.Contains("yalnız SSH anahtarı", CoreText.Turkish("authentication failed (server accepts: publickey)"));
        Assert.Contains("password, publickey", CoreText.Turkish("authentication failed (server accepts: password, publickey)"));
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
