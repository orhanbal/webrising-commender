using Wecommander.Center.Core;
using Xunit;

namespace Wecommander.Center.Core.Tests;

public class RootSetupTests
{
    private static CoreHost Host(string label, string address, string protocol = "ssh") =>
        new("h1", label, $"root@{address}", "key", false, null, null, null, Host: address, Protocol: protocol);

    private static Device Linux(string id, string name) => new() { Id = id, Name = name, Platform = "linux" };

    [Fact]
    public void TheCommandsAreFixedAndPreferTheInstalledScript()
    {
        Assert.Equal("if [ -f /opt/wecommander/libexec/install-linux.sh ]; then sudo bash /opt/wecommander/libexec/install-linux.sh --allow-root; else curl -fsSL https://wecommander.app/install.sh | sh -s -- --allow-root; fi", RootSetup.Command(true));
        Assert.Equal("if [ -f /opt/wecommander/libexec/install-linux.sh ]; then sudo bash /opt/wecommander/libexec/install-linux.sh --disallow-root; else curl -fsSL https://wecommander.app/install.sh | sh -s -- --disallow-root; fi", RootSetup.Command(false));
    }

    [Fact]
    public void OnlyHostsWithAShellGetTheAction()
    {
        Assert.True(RootSetup.Applies(Host("web", "web-1")));
        Assert.True(RootSetup.Applies(Host("web", "web-1", "mosh")));
        Assert.False(RootSetup.Applies(Host("switch", "10.0.0.1", "telnet")));
        Assert.False(RootSetup.Applies(Host("board", "COM3", "serial")));
    }

    [Fact]
    public void ADeviceIsMatchedOnlyWhenOneLinuxDeviceHasTheHostsName()
    {
        var devices = new[] { Linux("d1", "web-1"), Linux("d2", "db"), new Device { Id = "w", Name = "web-2", Platform = "windows" } };
        Assert.Equal("d1", RootSetup.MatchDevice(Host("Web", "web-1.example.com"), devices));
        Assert.Equal("d2", RootSetup.MatchDevice(Host("DB", "10.0.0.5"), devices));
        Assert.Null(RootSetup.MatchDevice(Host("web-2", "10.0.0.6"), devices));
        Assert.Null(RootSetup.MatchDevice(Host("x", "10.0.0.7"), devices));
        Assert.Null(RootSetup.MatchDevice(Host("web-1", "web-1"), [Linux("a", "web-1"), Linux("b", "WEB-1")]));
        Assert.Null(RootSetup.MatchDevice(Host("web-1", "web-1"), [new Device { Id = "r", Name = "web-1", Platform = "linux", RevokedAt = DateTimeOffset.UnixEpoch }]));
    }

    [Fact]
    public void ThePermissionsLinkOpensTheDeviceOrTheList()
    {
        Assert.Equal("https://wecommander.app/devices?permissions=d%201", RootSetup.PermissionsUrl("https://wecommander.app/", "d 1"));
        Assert.Equal("https://wecommander.app/devices", RootSetup.PermissionsUrl("https://wecommander.app", null));
    }
}
