using Wecommander.Center.Core;
using Xunit;

namespace Wecommander.Center.Core.Tests;

public class TaskbarLookTests
{
    private static readonly Argb Blue = Argb.Hex(0x003E92); // a typical dark accent shade
    private static readonly Argb Yellow = Argb.Hex(0xFFE36B); // a very light "dark" shade

    [Fact]
    public void SystemFollowsTheTaskbarTheme()
    {
        Assert.Same(TaskbarLook.Light, TaskbarLook.Pick("system", systemLight: true, accentOnTaskbar: false, Blue));
        Assert.Same(TaskbarLook.Dark, TaskbarLook.Pick("system", systemLight: false, accentOnTaskbar: false, Blue));
        Assert.Same(TaskbarLook.Dark, TaskbarLook.Pick(null, systemLight: false, accentOnTaskbar: false, Blue));
    }

    [Fact]
    public void TheTaskbarRecipeIsTheBaseAcrylicNotTheLighterDefault()
    {
        Assert.Equal(Argb.Hex(0xF3F3F3), TaskbarLook.Light.Tint);
        Assert.Equal(0.90f, TaskbarLook.Light.LuminosityOpacity);
        Assert.False(TaskbarLook.Light.Dark);
        Assert.Equal(Argb.Hex(0x202020), TaskbarLook.Dark.Tint);
        Assert.Equal(0.50f, TaskbarLook.Dark.TintOpacity);
        Assert.True(TaskbarLook.Dark.Dark);
    }

    [Fact]
    public void AccentOnTheTaskbarTintsItInDarkModeOnly()
    {
        var accent = TaskbarLook.Pick("system", systemLight: false, accentOnTaskbar: true, Blue);
        Assert.True(accent.Accent);
        Assert.Equal(Blue, accent.Tint);
        Assert.Equal(Blue, accent.Fallback);
        Assert.True(accent.Dark); // white text on a dark blue
        // Windows ignores the accent switch in light mode.
        Assert.Same(TaskbarLook.Light, TaskbarLook.Pick("system", systemLight: true, accentOnTaskbar: true, Blue));
    }

    [Fact]
    public void AVeryLightAccentGetsDarkText()
    {
        var accent = TaskbarLook.Pick("system", systemLight: false, accentOnTaskbar: true, Yellow);
        Assert.True(accent.Accent);
        Assert.False(accent.Dark);
        Assert.True(Argb.Contrast(accent.Tint, Argb.Hex(0x000000)) >= 4.5);
    }

    [Theory]
    [InlineData("light", false)]
    [InlineData("LIGHT", false)]
    [InlineData("dark", true)]
    public void AForcedThemeIgnoresTheSystemAndTheAccent(string theme, bool dark)
    {
        foreach (var light in new[] { true, false })
        {
            var m = TaskbarLook.Pick(theme, light, accentOnTaskbar: true, Blue);
            Assert.Equal(dark, m.Dark);
            Assert.False(m.Accent);
        }
    }

    [Fact]
    public void TextOnTheTaskbarLooksIsReadable()
    {
        Assert.True(Argb.Contrast(TaskbarLook.Light.Fallback, Argb.Hex(0x000000)) >= 7);
        Assert.True(Argb.Contrast(TaskbarLook.Dark.Fallback, Argb.Hex(0xFFFFFF)) >= 7);
    }

    [Theory]
    [InlineData("ImmersiveColorSet", true)]
    [InlineData("immersivecolorset", true)]
    [InlineData("Policy", false)]
    [InlineData(null, false)]
    public void RecognisesTheColourChangeNotice(string? setting, bool expected) =>
        Assert.Equal(expected, TaskbarLook.IsColorChange(setting));

    [Fact]
    public void RegistryFlags()
    {
        Assert.True(TaskbarLook.Flag(1, false));
        Assert.False(TaskbarLook.Flag(0, true));
        Assert.True(TaskbarLook.Flag(null, true));
        Assert.False(TaskbarLook.Flag("x", false));
    }

    [Theory]
    [InlineData(null, "dock")]
    [InlineData("", "dock")]
    [InlineData("dock", "dock")]
    [InlineData("Classic", "classic")]
    [InlineData("other", "dock")]
    public void AppModeDefaultsToDock(string? value, string expected) => Assert.Equal(expected, AppModes.Parse(value));

    [Fact]
    public void PanelsOpenFromTheDockOnlyWhenItIsOnInDockMode()
    {
        Assert.True(AppModes.PanelsFromDock(true, "dock"));
        Assert.True(AppModes.PanelsFromDock(true, null));
        Assert.False(AppModes.PanelsFromDock(true, "classic"));
        Assert.False(AppModes.PanelsFromDock(false, "dock"));
    }

    [Fact]
    public void SettingsDefaultToDockMode() => Assert.Equal("dock", new Settings().AppMode);

    [Fact]
    public void TerminalPanelIsAShareOfTheWorkArea()
    {
        var work = new PixelRect(0, 60, 1920, 1020);
        Assert.Equal((1152, 510), DockLayout.PanelSize(work, 0.6, 0.5, 640, 400));
        // A small screen: the minimum, but never more than the work area.
        Assert.Equal((640, 400), DockLayout.PanelSize(new PixelRect(0, 0, 800, 600), 0.6, 0.5, 640, 400));
        Assert.Equal((500, 300), DockLayout.PanelSize(new PixelRect(0, 0, 500, 300), 0.6, 0.5, 640, 400));
    }
}
