using System.Text.Json;
using Wecommander.Center.Core;
using Xunit;

namespace Wecommander.Center.Core.Tests;

/// <summary>11 and 12: the cleanup page's categories per Docker daemon, from the core's JSON, and the space freed after a cleanup.</summary>
public class CleanupLayoutTests
{
    // What `server.cleanupScan` returns for the system daemon, DEVAGENT's rootless one and one it could not read.
    private const string Scan = """
    {"items":[
      {"id":"journal","title":"Sistem günlükleri","detail":"","kb":1000,"command":"journalctl --vacuum-time=7d","warning":"","docker":"","group":""},
      {"id":"docker-build","title":"Docker build önbelleği","detail":"","kb":0,"command":"docker -H unix:///var/run/docker.sock builder prune -af","warning":"","docker":"system","group":""},
      {"id":"docker-build@u1000","title":"DEVAGENT-CI — Rootless Docker — build önbelleği","detail":"","kb":32978515,"command":"docker -H unix:///run/user/1000/docker.sock builder prune -af","warning":"","docker":"u1000","group":""},
      {"id":"docker-dangling@u1000","title":"DEVAGENT-CI — Rootless Docker — etiketsiz imajlar","detail":"","kb":1953125,"command":"docker -H unix:///run/user/1000/docker.sock image prune -f","warning":"","docker":"u1000","group":"images@u1000"},
      {"id":"docker-unused@u1000","title":"DEVAGENT-CI — Rootless Docker — kullanılmayan tüm imajlar","detail":"","kb":13574218,"command":"docker -H unix:///run/user/1000/docker.sock image prune -af","warning":"Coolify…","docker":"u1000","group":"images@u1000"}
    ],
    "privilege":"root",
    "disk":null,
    "dockers":[
      {"id":"system","kind":"system","label":"Sistem Docker","user":"root","uid":0,"socket":"/var/run/docker.sock","rootDir":"/var/lib/docker","imagesBytes":2500000000,"imagesReclaimableBytes":0,"buildCacheBytes":0,"buildCacheReclaimableBytes":0,"containersBytes":0,"volumesBytes":0,"danglingBytes":0,"imagesTotal":2,"imagesActive":2,"containersTotal":2,"containersRunning":2,"running":["coolify (coolify:4)"],"error":""},
      {"id":"u1000","kind":"rootless","label":"DEVAGENT-CI — Rootless Docker","user":"devagent-ci","uid":1000,"socket":"/run/user/1000/docker.sock","rootDir":"/var/lib/devagent-ci/.local/share/docker","imagesBytes":15000000000,"imagesReclaimableBytes":13900000000,"buildCacheBytes":33770000000,"buildCacheReclaimableBytes":33770000000,"containersBytes":2000000,"volumesBytes":328000000,"danglingBytes":2000000000,"imagesTotal":31,"imagesActive":1,"containersTotal":2,"containersRunning":1,"running":["devagent-stage2-gpu-relay (devagent/relay:42)"],"error":""},
      {"id":"u1001","kind":"rootless","label":"CI2 — Rootless Docker","user":"ci2","uid":1001,"socket":"/run/user/1001/docker.sock","rootDir":"","imagesBytes":0,"imagesReclaimableBytes":0,"buildCacheBytes":0,"buildCacheReclaimableBytes":0,"containersBytes":0,"volumesBytes":0,"danglingBytes":0,"imagesTotal":0,"imagesActive":0,"containersTotal":0,"containersRunning":0,"running":[],"error":"Bu Docker'a erişim izni yok."}
    ]}
    """;

    [Fact]
    public void EachDockerDaemonIsItsOwnSectionWithItsOwnItems()
    {
        var scan = JsonSerializer.Deserialize<CleanupScan>(Scan, CoreClient.Json)!;
        var sections = CleanupLayout.Sections(scan);
        Assert.Equal(4, sections.Count);
        Assert.Null(sections[0].Docker);
        Assert.Equal(["journal"], sections[0].Items.Select(i => i.Id));
        Assert.Equal("system", sections[1].Docker!.Id);
        Assert.Equal(["docker-build"], sections[1].Items.Select(i => i.Id));

        var devagent = sections[2];
        Assert.Equal("DEVAGENT-CI — Rootless Docker", devagent.Docker!.Label);
        Assert.True(devagent.Docker.Rootless);
        Assert.Equal("/run/user/1000/docker.sock", devagent.Docker.Socket);
        Assert.Equal(33_770_000_000UL, devagent.Docker.BuildCacheBytes);
        Assert.Equal(["devagent-stage2-gpu-relay (devagent/relay:42)"], devagent.Docker.Running);
        Assert.Equal(["docker-build@u1000", "docker-dangling@u1000", "docker-unused@u1000"], devagent.Items.Select(i => i.Id));
        // Every DEVAGENT command goes to DEVAGENT's daemon, never the system one.
        Assert.All(devagent.Items, i => Assert.Contains("/run/user/1000/docker.sock", i.Command));
        // Untagged and unused images overlap: one group, never both added up.
        Assert.Equal(devagent.Items[1].Group, devagent.Items[2].Group);

        // A daemon that could not be read: shown, with its reason, and nothing to clean.
        Assert.Equal("u1001", sections[3].Docker!.Id);
        Assert.NotEmpty(sections[3].Docker!.Error);
        Assert.Empty(sections[3].Items);
    }

    [Fact]
    public void AnOlderCoreWithoutDaemonsStillListsItsItems()
    {
        var scan = JsonSerializer.Deserialize<CleanupScan>("""{"items":[{"id":"docker-build","title":"t","detail":"","kb":5,"command":"docker builder prune -af","warning":""}],"privilege":"root"}""", CoreClient.Json)!;
        var sections = CleanupLayout.Sections(scan);
        Assert.Single(sections);
        Assert.Equal("docker-build", sections[0].Items[0].Id);
    }

    [Fact]
    public void DiskFoldersAreMatchedToTheirDockerDaemon()
    {
        var stores = new List<DockerStore>
        {
            new("system", "system", "Sistem Docker", "root", "/var/run/docker.sock", "/var/lib/docker", ""),
            new("u1000", "rootless", "DEVAGENT-CI — Rootless Docker", "devagent-ci", "/run/user/1000/docker.sock", "/var/lib/devagent-ci/.local/share/docker", ""),
        };
        Assert.Equal("u1000", CleanupLayout.StoreFor("/var/lib/devagent-ci", stores)!.Id);
        Assert.Equal("u1000", CleanupLayout.StoreFor("/var/lib/devagent-ci/.local/share/docker/containerd", stores)!.Id);
        Assert.Equal("system", CleanupLayout.StoreFor("/var/lib/docker", stores)!.Id);
        Assert.Null(CleanupLayout.StoreFor("/var/lib/containerd", stores));
        Assert.Null(CleanupLayout.StoreFor("/var/lib/dock", stores));
        Assert.Null(CleanupLayout.StoreFor("/x", null));
    }

    [Fact]
    public void TheSpaceFreedIsMeasuredAndTheGapExplained()
    {
        Assert.Equal("", CleanupLayout.Freed(1000, null, 5000));
        var close = CleanupLayout.Freed(1_000_000, 10_000_000, 10_950_000);
        Assert.StartsWith("Diskte gerçekten", close);
        Assert.DoesNotContain("Fark normaldir", close);
        var far = CleanupLayout.Freed(33_000_000, 10_000_000, 30_000_000);
        Assert.Contains("Fark normaldir", far);
    }
}
