using Microsoft.UI.Composition;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Microsoft.Win32;
using Wecommander.Center.Core;
using Windows.UI.ViewManagement;

namespace Wecommander.Center;

/// <summary>
/// The Windows 11 taskbar's material for the Dock and every panel it opens:
/// a DesktopAcrylicController with the taskbar's own recipe (TaskbarLook) for
/// the taskbar's theme (SystemUsesLightTheme, accent with ColorPrevalence), kept
/// "active" so it never turns into the flat fallback colour while another window
/// has the focus (the Dock never takes it). The window's content gets the
/// matching text theme. It follows Windows live: the Dock calls
/// <see cref="RefreshAll"/> on WM_SETTINGCHANGE "ImmersiveColorSet".
/// </summary>
public sealed class TaskbarBackdrop : SystemBackdrop
{
    private static readonly List<WeakReference<TaskbarBackdrop>> Live = [];

    private DesktopAcrylicController? _controller;
    private SystemBackdropConfiguration? _config;
    private XamlRoot? _root;

    /// <summary>What it shows now (null until connected).</summary>
    public TaskbarMaterial? Material { get; private set; }

    public TaskbarBackdrop()
    {
        lock (Live)
        {
            Live.RemoveAll(w => !w.TryGetTarget(out _));
            Live.Add(new WeakReference<TaskbarBackdrop>(this));
        }
    }

    /// <summary>Windows' colours or the Dock's theme setting changed: every Dock surface follows.</summary>
    public static void RefreshAll()
    {
        List<TaskbarBackdrop> all;
        lock (Live) all = Live.Select(w => w.TryGetTarget(out var b) ? b : null).OfType<TaskbarBackdrop>().ToList();
        foreach (var b in all)
        {
            try { b.Update(); } catch (Exception e) { App.LogCrash(e); }
        }
    }

    /// <summary>The taskbar's look now, for the Dock's theme setting.</summary>
    public static TaskbarMaterial Current()
    {
        var light = false;
        var accent = false;
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            light = TaskbarLook.Flag(key?.GetValue("SystemUsesLightTheme"), false);
            accent = TaskbarLook.Flag(key?.GetValue("ColorPrevalence"), false);
        }
        catch (Exception) { }
        var dark = Argb.Hex(0x1F1F1F);
        if (accent)
        {
            try
            {
                var c = new UISettings().GetColorValue(UIColorType.AccentDark2);
                dark = new Argb(255, c.R, c.G, c.B);
            }
            catch (Exception) { }
        }
        return TaskbarLook.Pick(App.Current.Settings.DockTheme, light, accent, dark);
    }

    protected override void OnTargetConnected(ICompositionSupportsSystemBackdrop connectedTarget, XamlRoot xamlRoot)
    {
        base.OnTargetConnected(connectedTarget, xamlRoot);
        _root = xamlRoot;
        try
        {
            if (DesktopAcrylicController.IsSupported())
            {
                // Always "input active": the acrylic keeps its depth like the taskbar, focused or not.
                _config = new SystemBackdropConfiguration { IsInputActive = true };
                _controller = new DesktopAcrylicController();
                // The taskbar's kind of acrylic; the colours below are set explicitly in any case.
                try { _controller.Kind = DesktopAcrylicKind.Base; } catch (Exception) { }
                _controller.AddSystemBackdropTarget(connectedTarget);
                _controller.SetSystemBackdropConfiguration(_config);
            }
            Update();
        }
        catch (Exception e) { App.LogCrash(e); }
    }

    protected override void OnTargetDisconnected(ICompositionSupportsSystemBackdrop disconnectedTarget)
    {
        base.OnTargetDisconnected(disconnectedTarget);
        try
        {
            _controller?.RemoveSystemBackdropTarget(disconnectedTarget);
            _controller?.Dispose();
        }
        catch (Exception) { }
        _controller = null;
        _config = null;
        _root = null;
    }

    /// <summary>Reads the taskbar's look again and applies it (material and text theme).</summary>
    public void Update()
    {
        var m = Current();
        Material = m;
        if (_controller is { } c)
        {
            c.TintColor = Color(m.Tint);
            c.TintOpacity = m.TintOpacity;
            c.LuminosityOpacity = m.LuminosityOpacity;
            c.FallbackColor = Color(m.Fallback);
            if (_config is { } config) config.Theme = m.Dark ? SystemBackdropTheme.Dark : SystemBackdropTheme.Light;
        }
        if (_root?.Content is FrameworkElement content)
        {
            content.RequestedTheme = m.Dark ? ElementTheme.Dark : ElementTheme.Light;
            // No acrylic on this system (or it is off): the taskbar's solid colour instead of a blank window.
            if (_controller is null && content is Microsoft.UI.Xaml.Controls.Panel panel)
                panel.Background = new SolidColorBrush(Color(m.Fallback));
        }
    }

    private static Windows.UI.Color Color(Argb c) => Windows.UI.Color.FromArgb(c.A, c.R, c.G, c.B);
}
