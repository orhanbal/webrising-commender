using Wecommander.Center.Core;
using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Graphics;

namespace Wecommander.Center;

/// <summary>
/// The server box at the bottom left of the screen, just above the taskbar
/// (where the weather sits): the busiest watched server with its processor,
/// memory and disk, live. A click opens "Sunucularım" upward from it; it can
/// be dragged elsewhere. Right click: in front of every window or only on
/// the desktop, hide during full-screen apps, back to the corner, close.
/// </summary>
public sealed class DeskChip : Window
{
    private readonly ServerMonitor _monitor;
    private readonly Grid _root = new() { ColumnSpacing = 12, Padding = new Thickness(12, 8, 14, 8) };
    private readonly Rectangle[] _iconBars = [new(), new(), new()];
    private readonly TextBlock _name = new() { FontWeight = FontWeights.SemiBold, FontSize = 13, TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 120 };
    private readonly Ellipse _dot = new() { Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _status = new() { FontSize = 11 };
    // The live meters (shared with the Dock): value, bar and the line chart moving in from the right.
    private readonly LiveMeter[] _meters = [new("CPU"), new("RAM"), new("Disk")];
    private readonly MeterHistory _history = new();
    private StackPanel? _meterPanel;
    private bool _pressOnMeters;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private bool _pressed, _hiddenForFullscreen, _shown;
    private POINT _pressAt;

    public const int WidthDip = 490, HeightDip = 64;

    public DeskChip(ServerMonitor monitor)
    {
        _monitor = monitor;
        Title = L.T("WECOMMANDER Sunucu kutusu");
        SystemBackdrop = new DesktopAcrylicBackdrop();
        // No title bar at all (the presenter removes it). Extending content into
        // it made the top ~32 px a drag area that swallowed clicks there.
        ExtendsContentIntoTitleBar = false;
        AppWindow.IsShownInSwitchers = false; // no taskbar button, not in Alt+Tab
        if (AppWindow.Presenter is OverlappedPresenter p)
        {
            p.IsResizable = false;
            p.IsMaximizable = false;
            p.IsMinimizable = false;
            p.SetBorderAndTitleBar(false, false);
        }
        AppWindow.Closing += (_, e) => e.Cancel = true;
        Activated += (_, e) =>
        {
            // Only on the desktop: back behind the windows once it is left.
            if (e.WindowActivationState == WindowActivationState.Deactivated && !App.Current.Settings.DeskChipOnTop) SendToBack();
        };

        _root.Background = new SolidColorBrush(Colors.Transparent);
        _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        // The 3D server icon: three bars on a dark rounded tile (like the tray icon).
        var tile = new Border
        {
            Width = 32, Height = 32, CornerRadius = new CornerRadius(8), Padding = new Thickness(6, 6, 6, 5),
            Background = new LinearGradientBrush
            {
                StartPoint = new Windows.Foundation.Point(0, 0), EndPoint = new Windows.Foundation.Point(0, 1),
                GradientStops = { new GradientStop { Color = ColorHelper.FromArgb(255, 0x47, 0x55, 0x69), Offset = 0 }, new GradientStop { Color = ColorHelper.FromArgb(255, 0x0F, 0x17, 0x2A), Offset = 1 } },
            },
            BorderThickness = new Thickness(0, 1, 0, 0),
            BorderBrush = new SolidColorBrush(ColorHelper.FromArgb(90, 255, 255, 255)),
            VerticalAlignment = VerticalAlignment.Center,
        };
        var bars = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 3, VerticalAlignment = VerticalAlignment.Bottom, HorizontalAlignment = HorizontalAlignment.Center };
        foreach (var bar in _iconBars)
        {
            bar.Width = 5; bar.RadiusX = 1; bar.RadiusY = 1; bar.VerticalAlignment = VerticalAlignment.Bottom;
            bars.Children.Add(bar);
        }
        tile.Child = bars;
        _root.Children.Add(tile);

        var who = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        who.Children.Add(_name);
        var state = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5 };
        state.Children.Add(_dot);
        state.Children.Add(_status);
        who.Children.Add(state);
        Grid.SetColumn(who, 1);
        _root.Children.Add(who);

        var meters = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 14, VerticalAlignment = VerticalAlignment.Center };
        foreach (var m in _meters) meters.Children.Add(m.Root);
        _meterPanel = meters;
        ApplyMode();
        Grid.SetColumn(meters, 2);
        _root.Children.Add(meters);

        _root.PointerPressed += OnPressed;
        _root.PointerMoved += OnMoved;
        _root.PointerReleased += OnReleased;
        _root.ContextFlyout = Menu();
        ToolTipService.SetToolTip(_root, L.T("Tıkla: Sunucularım · Göstergelere tıkla: çizgi / çubuk · Sürükle: taşı · Sağ tık: ayarlar"));
        Content = _root;

        _monitor.Changed += () => { try { Refresh(); } catch (Exception e) { App.LogCrash(e); } };
        _timer.Tick += (_, _) => Watch();
        _timer.Start();
        Refresh();
    }

    // ---- what it shows ----

    private static Windows.UI.Color Level(double percent) => LiveMeter.Level(percent);

    private void Refresh()
    {
        var servers = _monitor.Servers;
        // The Dock carries the same meters: no second box while it is on.
        if (servers.Count == 0 || !App.Current.Settings.DeskChip || App.Current.Settings.Dock) { HideChip(); return; }
        // The busiest live server, else the first one.
        var s = servers.Where(x => x.Live).OrderByDescending(x => x.Worst).FirstOrDefault() ?? servers[0];
        _name.Text = s.Label + (servers.Count > 1 ? $"  +{servers.Count - 1}" : "");
        var (status, color) = s.Error is not null ? (L.T("bağlanamadı"), ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44))
            : !s.Live ? (L.T("bağlanıyor…"), Colors.Gray)
            : s.Worst >= 90 ? ("dikkat", ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44))
            : s.Worst >= 80 ? (L.T("yüksek kullanım"), ColorHelper.FromArgb(255, 0xF5, 0x9E, 0x0B))
            : (L.T("çevrimiçi"), ColorHelper.FromArgb(255, 0x16, 0xA3, 0x4A));
        _status.Text = status;
        _dot.Fill = new SolidColorBrush(color);
        var values = new[] { s.Cpu, s.Mem, s.Disk };
        for (var i = 0; i < 3; i++)
        {
            var v = s.Live ? Math.Clamp(values[i], 0, 100) : 0;
            var c = s.Live ? Level(v) : Colors.Gray;
            _iconBars[i].Height = Math.Max(3, v / 100 * 19);
            _iconBars[i].Fill = new SolidColorBrush(c);
        }
        var (points, fresh) = _history.Take(s);
        for (var i = 0; i < 3; i++)
            _meters[i].Show(s.Live ? values[i] : null, points[i], fresh, App.Current.Settings.DeskChipLine);
        if (!_hiddenForFullscreen) ShowChip();
    }

    private void ApplyMode()
    {
        var line = App.Current.Settings.DeskChipLine;
        foreach (var m in _meters) m.SetLine(line);
        ToolTipService.SetToolTip(_meterPanel, line ? L.T("Tıkla: çubuklar") : L.T("Tıkla: canlı çizgi grafik"));
    }

    // ---- where and in front of what ----

    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int max);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] private static extern bool ReleaseCapture();
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr w, IntPtr l);
    [DllImport("shell32.dll")] private static extern int SHQueryUserNotificationState(out int state);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }

    private static readonly IntPtr HwndBottom = new(1), HwndTop = IntPtr.Zero;
    private const uint SwpNoSize = 0x1, SwpNoMove = 0x2, SwpNoActivate = 0x10;

    private IntPtr Hwnd => WinRT.Interop.WindowNative.GetWindowHandle(this);
    private double Scale => GetDpiForWindow(Hwnd) / 96.0;
    private RectInt32 WorkArea => DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;

    /// <summary>Where it sits now, in screen pixels (the panel opens above it).</summary>
    public RectInt32 Bounds => new(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height);

    private void Place()
    {
        var settings = App.Current.Settings;
        var scale = Scale;
        var area = WorkArea;
        var width = (int)Math.Round(WidthDip * scale);
        var height = (int)Math.Round(HeightDip * scale);
        var left = (int)Math.Round((settings.DeskChipLeft ?? 12) * scale);
        var bottom = (int)Math.Round((settings.DeskChipBottom ?? 8) * scale);
        var x = Math.Clamp(area.X + left, area.X, area.X + area.Width - width);
        var y = Math.Clamp(area.Y + area.Height - bottom - height, area.Y, area.Y + area.Height - height);
        AppWindow.MoveAndResize(new RectInt32(x, y, width, height));
    }

    private void ShowChip()
    {
        if (_shown) return;
        _shown = true;
        Place();
        App.DebugLayout($"chip: show at {AppWindow.Position.X},{AppWindow.Position.Y} {AppWindow.Size.Width}x{AppWindow.Size.Height} onTop={App.Current.Settings.DeskChipOnTop}");
        ApplyLayer();
        AppWindow.Show(false); // never takes the focus from what the owner is doing
        var round = 2; // DWMWCP_ROUND
        try { DwmSetWindowAttribute(Hwnd, 33, ref round, sizeof(int)); } catch (Exception) { }
        if (!App.Current.Settings.DeskChipOnTop) SendToBack();
    }

    private void HideChip()
    {
        if (!_shown) return;
        _shown = false;
        App.DebugLayout("chip: hide");
        AppWindow.Hide();
    }

    private void ApplyLayer()
    {
        if (AppWindow.Presenter is OverlappedPresenter p) p.IsAlwaysOnTop = App.Current.Settings.DeskChipOnTop;
    }

    private void SendToBack() => SetWindowPos(Hwnd, HwndBottom, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);

    /// <summary>Every second: hide during full-screen apps; "only on the desktop" comes forward when the desktop is shown.</summary>
    private void Watch()
    {
        var settings = App.Current.Settings;
        if (!settings.DeskChip || settings.Dock || _monitor.Servers.Count == 0) return;
        var fullscreen = false;
        if (settings.DeskChipHideFullscreen)
            // QUERY_USER_NOTIFICATION_STATE: 2 busy (a full-screen app), 3 a full-screen
            // game (Direct3D), 4 presentation mode. 5 is the normal desktop
            // ("accepts notifications"): counting it hid the box all the time.
            try { fullscreen = SHQueryUserNotificationState(out var q) == 0 && q is 2 or 3 or 4; } catch (Exception) { }
        if (fullscreen != _hiddenForFullscreen)
        {
            _hiddenForFullscreen = fullscreen;
            if (fullscreen) HideChip(); else ShowChip();
        }
        if (!settings.DeskChipOnTop && _shown && ForegroundIsDesktop())
            SetWindowPos(Hwnd, HwndTop, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);
    }

    private static bool ForegroundIsDesktop()
    {
        var name = new System.Text.StringBuilder(64);
        GetClassName(GetForegroundWindow(), name, name.Capacity);
        return name.ToString() is "Progman" or "WorkerW";
    }

    // ---- click opens the panel, a drag moves it ----

    private void OnPressed(object sender, PointerRoutedEventArgs e)
    {
        App.DebugLayout($"chip: pressed left={e.GetCurrentPoint(_root).Properties.IsLeftButtonPressed}");
        if (!e.GetCurrentPoint(_root).Properties.IsLeftButtonPressed) return;
        _pressed = true;
        // On the meters a click switches bars / line charts; elsewhere it opens the panel.
        _pressOnMeters = false;
        if (_meterPanel is { } m)
        {
            var p = e.GetCurrentPoint(m).Position;
            _pressOnMeters = p.X >= -4 && p.Y >= -6 && p.X <= m.ActualWidth + 4 && p.Y <= m.ActualHeight + 6;
        }
        GetCursorPos(out _pressAt);
    }

    private void OnMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_pressed) return;
        GetCursorPos(out var now);
        if (Math.Abs(now.X - _pressAt.X) < 5 && Math.Abs(now.Y - _pressAt.Y) < 5) return;
        _pressed = false;
        // Windows' own window move (like dragging a title bar), then remember where it was left.
        ReleaseCapture();
        SendMessage(Hwnd, 0xA1 /* WM_NCLBUTTONDOWN */, new IntPtr(2) /* HTCAPTION */, IntPtr.Zero);
        SavePosition();
    }

    private void OnReleased(object sender, PointerRoutedEventArgs e)
    {
        App.DebugLayout($"chip: released pressed={_pressed} onMeters={_pressOnMeters}");
        if (!_pressed) return;
        _pressed = false;
        if (_pressOnMeters)
        {
            App.Current.Settings.DeskChipLine = !App.Current.Settings.DeskChipLine;
            App.Current.SaveSettings();
            ApplyMode();
            return;
        }
        App.Current.ToggleMonitorPanelAt(Bounds);
    }

    private void SavePosition()
    {
        var scale = Scale;
        var area = WorkArea;
        var settings = App.Current.Settings;
        settings.DeskChipLeft = (int)Math.Round((AppWindow.Position.X - area.X) / scale);
        settings.DeskChipBottom = (int)Math.Round((area.Y + area.Height - AppWindow.Position.Y - AppWindow.Size.Height) / scale);
        App.Current.SaveSettings();
        if (!settings.DeskChipOnTop) SendToBack();
    }

    // ---- right click: the settings ----

    private MenuFlyout Menu()
    {
        var menu = new MenuFlyout();
        var open = new MenuFlyoutItem { Text = L.T("Sunucularım panelini aç"), Icon = new FontIcon { Glyph = "" } };
        open.Click += (_, _) => App.Current.ToggleMonitorPanelAt(Bounds);
        var onTop = new ToggleMenuFlyoutItem { Text = L.T("Tüm pencerelerin üzerinde göster") };
        onTop.Click += (_, _) =>
        {
            App.Current.Settings.DeskChipOnTop = onTop.IsChecked;
            App.Current.SaveSettings();
            ApplyLayer();
            if (!onTop.IsChecked) SendToBack();
        };
        var fullscreen = new ToggleMenuFlyoutItem { Text = L.T("Tam ekran uygulamalarda gizle") };
        fullscreen.Click += (_, _) =>
        {
            App.Current.Settings.DeskChipHideFullscreen = fullscreen.IsChecked;
            App.Current.SaveSettings();
            if (!fullscreen.IsChecked && _hiddenForFullscreen) { _hiddenForFullscreen = false; ShowChip(); }
        };
        var corner = new MenuFlyoutItem { Text = L.T("Sol alt köşeye geri al"), Icon = new FontIcon { Glyph = "" } };
        corner.Click += (_, _) =>
        {
            App.Current.Settings.DeskChipLeft = null;
            App.Current.Settings.DeskChipBottom = null;
            App.Current.SaveSettings();
            Place();
        };
        var hint = new MenuFlyoutItem { Text = L.T("Taşımak için kutuyu sürükle"), IsEnabled = false };
        var servers = new MenuFlyoutItem { Text = L.T("Sunucular penceresi"), Icon = new FontIcon { Glyph = "" } };
        servers.Click += (_, _) => App.Current.ShowServers();
        var close = new MenuFlyoutItem { Text = L.T("Kutuyu kapat"), Icon = new FontIcon { Glyph = "" } };
        close.Click += (_, _) =>
        {
            App.Current.SetDeskChip(false);
            App.Current.Toast(L.T("Sunucu kutusu kapandı. Geri açmak için: saatin yanındaki sunucu simgesine sağ tıkla > \"Masaüstü kutusunu göster\"."));
        };
        menu.Opening += (_, _) =>
        {
            onTop.IsChecked = App.Current.Settings.DeskChipOnTop;
            fullscreen.IsChecked = App.Current.Settings.DeskChipHideFullscreen;
        };
        menu.Items.Add(open);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(onTop);
        menu.Items.Add(fullscreen);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(hint);
        menu.Items.Add(corner);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(servers);
        menu.Items.Add(close);
        return menu;
    }

    /// <summary>Turned on or off from the tray menu or its own menu.</summary>
    public void Apply()
    {
        if (App.Current.Settings.DeskChip && !App.Current.Settings.Dock) Refresh();
        else HideChip();
    }
}
