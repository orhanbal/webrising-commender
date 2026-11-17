using Wecommander.Center.Core;
using Xunit;

namespace Wecommander.Center.Core.Tests;

public class DockLayoutTests
{
    private static readonly PixelRect Monitor = new(0, 0, 1920, 1080);
    private static readonly PixelRect Second = new(1920, -200, 2560, 1440);

    [Theory]
    [InlineData(DockEdge.Top, 0, 0, 1920, 60)]
    [InlineData(DockEdge.Bottom, 0, 1020, 1920, 60)]
    [InlineData(DockEdge.Left, 0, 0, 60, 1080)]
    [InlineData(DockEdge.Right, 1860, 0, 60, 1080)]
    public void StripRunsAlongTheWholeEdge(DockEdge edge, int x, int y, int w, int h) =>
        Assert.Equal(new PixelRect(x, y, w, h), DockLayout.Strip(Monitor, edge, 60));

    [Fact]
    public void StripOnASecondMonitorWithNegativeOrigin() =>
        Assert.Equal(new PixelRect(1920, -200, 2560, 90), DockLayout.Strip(Second, DockEdge.Top, 90));

    [Fact]
    public void AfterQueryKeepsTheThicknessFromWhereTheShellLeftUs()
    {
        // The taskbar sits on the bottom edge (48 px): the shell moves our proposed rect up.
        var proposed = PixelRect.FromEdges(0, 0, 1920, 1032);
        Assert.Equal(PixelRect.FromEdges(0, 972, 1920, 1032), DockLayout.AfterQuery(proposed, DockEdge.Bottom, 60));
        Assert.Equal(PixelRect.FromEdges(0, 0, 1920, 60), DockLayout.AfterQuery(proposed, DockEdge.Top, 60));
        Assert.Equal(PixelRect.FromEdges(1860, 0, 1920, 1032), DockLayout.AfterQuery(proposed, DockEdge.Right, 60));
    }

    [Theory]
    [InlineData(DockEdge.Top, 0, -58)]
    [InlineData(DockEdge.Bottom, 0, 1078)]
    [InlineData(DockEdge.Left, -58, 0)]
    [InlineData(DockEdge.Right, 1918, 0)]
    public void HiddenLeavesOnlyThePeekOnScreen(DockEdge edge, int x, int y)
    {
        var shown = DockLayout.Strip(Monitor, edge, 60);
        var hidden = DockLayout.Hidden(shown, edge, 2);
        Assert.Equal(x, hidden.X);
        Assert.Equal(y, hidden.Y);
        Assert.Equal(shown.Width, hidden.Width);
        Assert.Equal(shown.Height, hidden.Height);
    }

    [Fact]
    public void BetweenSlidesFromHiddenToShown()
    {
        var shown = DockLayout.Strip(Monitor, DockEdge.Top, 60);
        var hidden = DockLayout.Hidden(shown, DockEdge.Top, 2);
        Assert.Equal(hidden, DockLayout.Between(hidden, shown, 0));
        Assert.Equal(shown, DockLayout.Between(hidden, shown, 1));
        Assert.Equal(-29, DockLayout.Between(hidden, shown, 0.5).Y);
        Assert.Equal(shown, DockLayout.Between(hidden, shown, 7));
    }

    [Fact]
    public void WakesOnlyAtItsEdgeOfItsMonitor()
    {
        Assert.True(DockLayout.Wakes(Monitor, DockEdge.Top, 500, 0, 2));
        Assert.True(DockLayout.Wakes(Monitor, DockEdge.Top, 500, 1, 2));
        Assert.False(DockLayout.Wakes(Monitor, DockEdge.Top, 500, 2, 2));
        Assert.True(DockLayout.Wakes(Monitor, DockEdge.Bottom, 10, 1079, 2));
        Assert.True(DockLayout.Wakes(Monitor, DockEdge.Right, 1919, 400, 2));
        Assert.False(DockLayout.Wakes(Monitor, DockEdge.Left, 1919, 400, 2));
        // The same row on the other monitor does not wake a Dock on the first one.
        Assert.False(DockLayout.Wakes(Monitor, DockEdge.Top, 2500, 0, 2));
        Assert.True(DockLayout.Wakes(Second, DockEdge.Top, 2500, -200, 2));
    }

    [Fact]
    public void SnapEdgeOffersTheNearestEdgeWithinTheThreshold()
    {
        var work = new PixelRect(0, 0, 1920, 1032);
        Assert.Equal(DockEdge.Top, DockLayout.SnapEdge(new PixelRect(400, 10, 800, 60), work, 24));
        Assert.Equal(DockEdge.Bottom, DockLayout.SnapEdge(new PixelRect(400, 960, 800, 60), work, 24));
        Assert.Equal(DockEdge.Right, DockLayout.SnapEdge(new PixelRect(1800, 400, 110, 400), work, 24));
        Assert.Null(DockLayout.SnapEdge(new PixelRect(400, 400, 800, 60), work, 24));
    }

    [Fact]
    public void ClampBringsAFloatingDockBackOnScreen()
    {
        var work = new PixelRect(0, 0, 1920, 1032);
        Assert.Equal(new PixelRect(1120, 972, 800, 60), DockLayout.Clamp(new PixelRect(3000, 2000, 800, 60), work));
        Assert.Equal(new PixelRect(0, 0, 800, 60), DockLayout.Clamp(new PixelRect(-500, -90, 800, 60), work));
        Assert.Equal(new PixelRect(0, 10, 1920, 60), DockLayout.Clamp(new PixelRect(10, 10, 3000, 60), work));
    }

    [Theory]
    [InlineData(DockEdge.Top, DockEdge.Bottom)]
    [InlineData(DockEdge.Bottom, DockEdge.Top)]
    [InlineData(DockEdge.Left, DockEdge.Right)]
    [InlineData(DockEdge.Right, DockEdge.Left)]
    public void PanelOpensAwayFromTheDock(DockEdge dock, DockEdge side) => Assert.Equal(side, DockLayout.PanelSide(dock));

    [Fact]
    public void PanelOpensBelowATopDockButton()
    {
        var work = new PixelRect(0, 60, 1920, 972);
        var panel = DockLayout.PanelAt(new PixelRect(8, 6, 40, 48), DockEdge.Bottom, 440, 600, work, 8);
        Assert.Equal(new PixelRect(8, 62, 440, 600), panel);
    }

    [Fact]
    public void PanelOpensAboveABottomDockButtonAndShortensWhenThereIsNoRoom()
    {
        var work = new PixelRect(0, 0, 1920, 1020);
        var panel = DockLayout.PanelAt(new PixelRect(8, 1026, 40, 48), DockEdge.Top, 440, 1500, work, 8);
        Assert.Equal(1018, panel.Bottom);
        Assert.Equal(0, panel.Y);
        var normal = DockLayout.PanelAt(new PixelRect(8, 1026, 40, 48), DockEdge.Top, 440, 600, work, 8);
        Assert.Equal(new PixelRect(8, 418, 440, 600), normal);
    }

    [Fact]
    public void PanelBesideSideDocksStaysOnTheWorkArea()
    {
        var work = new PixelRect(118, 0, 1802, 1032);
        var right = DockLayout.PanelAt(new PixelRect(8, 900, 100, 40), DockEdge.Right, 440, 600, work, 8);
        Assert.Equal(118, right.X); // just past the Dock, on the work area
        Assert.Equal(1032, right.Bottom); // moved up so it fits
        var leftWork = new PixelRect(0, 0, 1802, 1032);
        var left = DockLayout.PanelAt(new PixelRect(1812, 10, 100, 40), DockEdge.Left, 440, 600, leftWork, 8);
        Assert.Equal(1802 - 440, left.X); // kept on the work area, beside the Dock
    }

    [Fact]
    public void SettingsNamesRoundTrip()
    {
        foreach (var e in Enum.GetValues<DockEdge>()) Assert.Equal(e, DockLayout.ParseEdge(DockLayout.Name(e)));
        foreach (var m in Enum.GetValues<DockMode>()) Assert.Equal(m, DockLayout.ParseMode(DockLayout.Name(m)));
        Assert.Equal(DockEdge.Top, DockLayout.ParseEdge(null));
        Assert.Equal(DockMode.Fixed, DockLayout.ParseMode("nonsense"));
    }

    [Fact]
    public void ModulesKeepTheOrderDropUnknownAndAddNewOnes()
    {
        Assert.Equal(DockLayout.AllModules, DockLayout.Modules(null, null));
        Assert.Equal(["terminal", "servers", "processes", "timers", "tasks", "approvals"], DockLayout.Modules(["terminal", "bogus", "servers", "terminal"], null));
        Assert.Equal(["servers", "terminal"], DockLayout.Modules(null, ["processes", "timers", "tasks", "approvals"]));
        // An order saved before the timers shortcut existed gets it at the end.
        Assert.Equal(["approvals", "terminal", "processes", "servers", "timers", "tasks"], DockLayout.Modules(["approvals", "terminal", "processes", "servers"], null));
    }

    [Fact]
    public void MoveTakesOnePartToItsNewPlace()
    {
        string[] order = ["servers", "processes", "timers", "terminal", "approvals"];
        Assert.Equal(["processes", "timers", "servers", "terminal", "approvals"], DockLayout.Move(order, 0, 2));
        Assert.Equal(["approvals", "servers", "processes", "timers", "terminal"], DockLayout.Move(order, 4, 0));
        Assert.Equal(["servers", "processes", "timers", "approvals", "terminal"], DockLayout.Move(order, 3, 99));
        Assert.Equal(order, DockLayout.Move(order, 2, 2));
        Assert.Equal(order, DockLayout.Move(order, -1, 0));
        Assert.Equal(order, DockLayout.Move(order, 5, 0));
        Assert.Empty(DockLayout.Move([], 0, 1));
        // The input is not changed.
        Assert.Equal("servers", order[0]);
    }

    [Fact]
    public void DockIsOffByDefaultAndSettingsSurviveARoundTrip()
    {
        var dir = Path.Combine(Path.GetTempPath(), "wc-dock-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new SettingsStore(dir);
            var (fresh, _) = store.Load();
            Assert.False(fresh.Dock);
            Assert.Equal("fixed", fresh.DockModeName);
            Assert.Equal("top", fresh.DockEdgeName);
            fresh.Dock = true; fresh.DockModeName = "floating"; fresh.DockEdgeName = "left"; fresh.DockFloatX = 300; fresh.DockFloatY = 40;
            fresh.DockModules = ["approvals", "servers"]; fresh.DockHiddenModules = ["terminal"]; fresh.DockMonitor = @"\\.\DISPLAY2";
            store.Save(fresh);
            var (back, existed) = store.Load();
            Assert.True(existed);
            Assert.True(back.Dock);
            Assert.Equal(DockMode.Floating, DockLayout.ParseMode(back.DockModeName));
            Assert.Equal(DockEdge.Left, DockLayout.ParseEdge(back.DockEdgeName));
            Assert.Equal(300, back.DockFloatX);
            Assert.Equal(@"\\.\DISPLAY2", back.DockMonitor);
            Assert.Equal(["approvals", "servers", "processes", "timers", "tasks"], DockLayout.Modules(back.DockModules, back.DockHiddenModules));
        }
        finally { try { Directory.Delete(dir, true); } catch (IOException) { } }
    }
}
