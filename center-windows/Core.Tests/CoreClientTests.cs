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
    public void HandlesRepliesAndEventsLine()
    {
        Assert.Equal("Giriş reddedildi. Anahtarı veya parolayı kontrol et.", CoreText.Turkish("authentication failed"));
        Assert.Equal("Atlama sunucusu: Bastion: no route", CoreText.Turkish("jump host Bastion: no route"));
        Assert.Equal("other", CoreText.Turkish("other"));
    }
}
