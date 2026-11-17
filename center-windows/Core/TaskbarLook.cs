namespace Wecommander.Center.Core;

/// <summary>An opaque or translucent colour (alpha, red, green, blue).</summary>
public readonly record struct Argb(byte A, byte R, byte G, byte B)
{
    public static Argb Rgb(byte r, byte g, byte b) => new(255, r, g, b);

    /// <summary>From 0xRRGGBB (fully opaque).</summary>
    public static Argb Hex(uint rgb) => new(255, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb);

    /// <summary>WCAG relative luminance (0 black … 1 white), alpha ignored.</summary>
    public double Luminance
    {
        get
        {
            static double Channel(byte c)
            {
                var v = c / 255.0;
                return v <= 0.03928 ? v / 12.92 : Math.Pow((v + 0.055) / 1.055, 2.4);
            }
            return 0.2126 * Channel(R) + 0.7152 * Channel(G) + 0.0722 * Channel(B);
        }
    }

    /// <summary>WCAG contrast ratio between two colours (1 … 21).</summary>
    public static double Contrast(Argb a, Argb b)
    {
        var (hi, lo) = a.Luminance >= b.Luminance ? (a.Luminance, b.Luminance) : (b.Luminance, a.Luminance);
        return (hi + 0.05) / (lo + 0.05);
    }
}

/// <summary>
/// The acrylic the Dock and its panels are drawn with, and whether the text on
/// it is light (Dark) or dark (light theme).
/// </summary>
public sealed record TaskbarMaterial(bool Dark, Argb Tint, float TintOpacity, float LuminosityOpacity, Argb Fallback, bool Accent);

/// <summary>
/// The Windows 11 taskbar's look, as a pure decision (tested without a screen).
/// The taskbar is drawn with the "Base" acrylic (the same recipe as the Start
/// menu; WinUI's AcrylicBackgroundFillColorBase): a grey #F3F3F3 at 90 %
/// luminosity in light mode and #202020 (50 % tint) in dark mode. The plain
/// DesktopAcrylicBackdrop uses the lighter "Default" recipe (#FCFCFC) and turns
/// into its flat fallback colour whenever the window is not the active one,
/// which the Dock never is: that is why it looked whiter and flatter than the
/// taskbar. With "Show accent colour on Start and taskbar" (Windows allows it
/// only in dark mode) the taskbar is tinted with the dark accent shade.
/// </summary>
public static class TaskbarLook
{
    public static readonly TaskbarMaterial Light = new(false, Argb.Hex(0xF3F3F3), 0f, 0.90f, Argb.Hex(0xEEEEEE), false);
    public static readonly TaskbarMaterial Dark = new(true, Argb.Hex(0x202020), 0.50f, 0.96f, Argb.Hex(0x1C1C1C), false);

    /// <summary>
    /// The material for the Dock's theme setting ("system", "light", "dark"):
    /// "system" follows the taskbar (<paramref name="systemLight"/> is
    /// SystemUsesLightTheme, <paramref name="accentOnTaskbar"/> is ColorPrevalence,
    /// <paramref name="accentDark"/> the dark accent shade the taskbar uses).
    /// A forced theme is that theme's plain taskbar look, without the accent.
    /// </summary>
    public static TaskbarMaterial Pick(string? dockTheme, bool systemLight, bool accentOnTaskbar, Argb accentDark)
    {
        switch (dockTheme?.ToLowerInvariant())
        {
            case "light": return Light;
            case "dark": return Dark;
        }
        if (systemLight) return Light; // Windows shows the accent on the taskbar only in dark mode.
        if (!accentOnTaskbar) return Dark;
        var tint = accentDark with { A = 255 };
        // The text colour that reads best on that tint: white unless the accent is very light.
        var dark = Argb.Contrast(tint, Argb.Hex(0xFFFFFF)) >= Argb.Contrast(tint, Argb.Hex(0x000000));
        return new TaskbarMaterial(dark, tint, 0.80f, 0.90f, tint, true);
    }

    /// <summary>Whether a WM_SETTINGCHANGE (its lParam text) is the colour / theme change ("ImmersiveColorSet").</summary>
    public static bool IsColorChange(string? setting) =>
        string.Equals(setting, "ImmersiveColorSet", StringComparison.OrdinalIgnoreCase);

    /// <summary>A registry DWORD read as a switch (missing: <paramref name="fallback"/>).</summary>
    public static bool Flag(object? value, bool fallback) => value switch
    {
        int i => i != 0,
        long l => l != 0,
        uint u => u != 0,
        _ => fallback,
    };
}

/// <summary>The app's two modes: "dock" (the Dock is on and everything opens in panels from it) or "classic" (no Dock; windows).</summary>
public static class AppModes
{
    public const string Dock = "dock", Classic = "classic";

    public static string Parse(string? value) =>
        string.Equals(value, Classic, StringComparison.OrdinalIgnoreCase) ? Classic : Dock;

    /// <summary>The mode follows the Dock: on is dock mode, off is classic mode.</summary>
    public static string Of(bool dockOn) => dockOn ? Dock : Classic;
}
