using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using Wecommander.Center.Core;
using Windows.Graphics;

namespace Wecommander.Center;

/// <summary>
/// WECOMMANDER Dock: our own bar on a screen edge (or floating), not the
/// Windows taskbar. Fixed: a Windows AppBar that takes its strip from the
/// work area. Auto-hide: slides out of sight and back when the mouse reaches
/// the edge. Floating: dragged anywhere, offers to fix itself to an edge it is
/// left near. It shows the watched server's live CPU / RAM / Disk (the same
/// meters and data as the server box, no second connection) and opens the
/// management screens; nothing risky runs from a single click here.
/// </summary>
public sealed class DockWindow : Window
{
    private readonly ServerMonitor _monitor;
    private readonly MeterHistory _history = new();
    private readonly Grid _root = new();
    private readonly AppBar _bar;
    private readonly IntPtr _hwnd;
    private readonly SubclassProc _proc;
    private readonly DispatcherQueueTimer _fast, _slow, _reapply;

    private MonitorSpec _screen = Monitors.Pick(null);
    private DockMode _mode;
    private DockEdge _edge;
    private bool _compact, _built, _horizontal;
    private int _thickness;
    private PixelRect _shown, _hidden;
    private double _t = 1, _target = 1;
    private bool _wantShown = true;
    private DateTime _wantSince = DateTime.UtcNow;
    private bool _abnFullscreen, _fullscreen, _menuOpen, _on;
    private string? _lastApplied;
    private string? _builtModules;

    // The parts shown (rebuilt when the edge or size changes).
    private LiveMeter[] _meters = [];
    private TextBlock _serverName = new() { FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis };
    private TextBlock _serverState = new() { FontSize = 11 };
    private Ellipse _serverDot = new() { Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock _badge = new() { FontSize = 10, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(Colors.White), HorizontalAlignment = HorizontalAlignment.Center };
    private readonly Border _badgeBox = new() { CornerRadius = new CornerRadius(8), MinWidth = 16, Height = 16, Padding = new Thickness(4, 0, 4, 0),
        Background = new SolidColorBrush(ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44)), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top,
        Margin = new Thickness(0, 2, 2, 0), Visibility = Visibility.Collapsed, IsHitTestVisible = false };
    private FrameworkElement? _appButton, _grip;

    public const string WindowTitle = "WECOMMANDER Dock";

    public DockWindow(ServerMonitor monitor)
    {
        _monitor = monitor;
        Title = WindowTitle;
        SystemBackdrop = new DesktopAcrylicBackdrop();
        // No title bar at all: extending content into it made the top ~32 px a
        // drag area that swallowed clicks (see DeskChip).
        ExtendsContentIntoTitleBar = false;
        AppWindow.IsShownInSwitchers = false; // not in Alt+Tab, no taskbar button
        try { AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico")); } catch (Exception) { }
        if (AppWindow.Presenter is OverlappedPresenter p)
        {
            p.IsResizable = false;
            p.IsMaximizable = false;
            p.IsMinimizable = false;
            p.SetBorderAndTitleBar(false, false);
        }
        // Alt+F4 on the Dock turns it off (and gives the work area back), it does not destroy it.
        AppWindow.Closing += (_, e) =>
        {
            e.Cancel = true;
            App.Current.SetDock(false);
        };
        Content = _root;
        _root.ContextFlyout = Menu();
        // Esc while a module button is dragged: it goes back where it was.
        _root.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler((_, e) =>
        {
            if (_reordering && e.Key == Windows.System.VirtualKey.Escape) { CancelReorder("escape"); e.Handled = true; }
        }), true);

        var hwnd = Hwnd;
        _hwnd = hwnd;
        _bar = new AppBar(hwnd);
        _proc = WndProc; // kept alive as long as the window
        SetWindowSubclass(hwnd, _proc, (UIntPtr)0x5743, IntPtr.Zero);

        var queue = DispatcherQueue.GetForCurrentThread();
        _fast = queue.CreateTimer();
        _fast.Interval = TimeSpan.FromMilliseconds(30);
        _fast.Tick += (_, _) => { try { AutoHideTick(); } catch (Exception e) { App.LogCrash(e); _fast.Stop(); } };
        _slow = queue.CreateTimer();
        _slow.Interval = TimeSpan.FromSeconds(1);
        _slow.Tick += (_, _) => { try { SlowTick(); } catch (Exception e) { App.LogCrash(e); } };
        _reapply = queue.CreateTimer();
        _reapply.Interval = TimeSpan.FromMilliseconds(200);
        _reapply.IsRepeating = false;
        _reapply.Tick += (_, _) => { if (_on) { _lastApplied = null; Apply(); } };

        _monitor.Changed += () => { try { if (_on) Refresh(); } catch (Exception e) { App.LogCrash(e); } };
    }

    // ---- Win32 ----

    private delegate IntPtr SubclassProc(IntPtr hwnd, uint msg, IntPtr w, IntPtr l, UIntPtr id, IntPtr data);
    [DllImport("comctl32.dll")] private static extern bool SetWindowSubclass(IntPtr hwnd, SubclassProc proc, UIntPtr id, IntPtr data);
    [DllImport("comctl32.dll")] private static extern IntPtr DefSubclassProc(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int max);
    [DllImport("shell32.dll")] private static extern int SHQueryUserNotificationState(out int state);
    [DllImport("user32.dll")] private static extern short GetKeyState(int vk);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int vk);
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct MINMAXINFO { public POINT ptReserved, ptMaxSize, ptMaxPosition, ptMinTrackSize, ptMaxTrackSize; }

    private static readonly IntPtr HwndTopMost = new(-1), HwndNoTopMost = new(-2), HwndBottom = new(1);
    private const uint SwpNoSize = 0x1, SwpNoMove = 0x2, SwpNoActivate = 0x10;
    private const uint WmGetMinMaxInfo = 0x0024;
    private const uint WmActivate = 0x0006, WmEndSession = 0x0016, WmSettingChange = 0x001A, WmWindowPosChanged = 0x0047,
        WmDisplayChange = 0x007E, WmDpiChanged = 0x02E0;

    private IntPtr Hwnd => WinRT.Interop.WindowNative.GetWindowHandle(this);

    private IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr w, IntPtr l, UIntPtr id, IntPtr data)
    {
        try
        {
            if (msg == _bar.CallbackMessage)
            {
                OnShellNotice((int)w, l);
                return IntPtr.Zero;
            }
            if (msg == AppBar.TaskbarCreated)
            {
                // Explorer restarted: it forgot every AppBar; register again.
                App.DebugLayout("dock: explorer restarted, registering again");
                _bar.Forget();
                ScheduleApply();
            }
            if (msg == WmGetMinMaxInfo)
            {
                // WinUI keeps windows at least ~136 px wide; a side Dock is thinner.
                var result = DefSubclassProc(hwnd, msg, w, l);
                var info = Marshal.PtrToStructure<MINMAXINFO>(l);
                info.ptMinTrackSize = new POINT { X = 1, Y = 1 };
                Marshal.StructureToPtr(info, l, false);
                return result;
            }
            switch (msg)
            {
                case WmActivate: _bar.Activated(); break;
                case WmWindowPosChanged: _bar.WindowPosChanged(); break;
                case WmDisplayChange:
                case WmDpiChanged:
                    App.DebugLayout($"dock: display change 0x{msg:X}");
                    ScheduleApply();
                    break;
                // The work area changed (a floating Dock may now be off it); the fixed one causes this itself.
                case WmSettingChange when (long)w == 0x2F /* SPI_SETWORKAREA */ && _mode == DockMode.Floating: ScheduleApply(); break;
                // Signing out / shutting down: give the work area back now.
                case WmEndSession when w != IntPtr.Zero: _bar.Remove(); break;
            }
        }
        catch (Exception e) { App.LogCrash(e); }
        return DefSubclassProc(hwnd, msg, w, l);
    }

    private void OnShellNotice(int notice, IntPtr l)
    {
        switch (notice)
        {
            case AppBar.AbnPosChanged:
            case AppBar.AbnStateChange:
                // Another AppBar or the taskbar moved: take our strip again.
                if (_mode == DockMode.Fixed) ScheduleApply();
                break;
            case AppBar.AbnFullScreenApp:
                _abnFullscreen = l != IntPtr.Zero;
                App.DebugLayout($"dock: shell says full-screen {_abnFullscreen}");
                UpdateFullscreen();
                break;
        }
    }

    private void ScheduleApply()
    {
        _reapply.Stop();
        _reapply.Start();
    }

    // ---- on / off ----

    /// <summary>Applies the settings (turned on, mode, edge, monitor, size); off: gives the work area back and hides.</summary>
    public void Apply()
    {
        var s = App.Current.Settings;
        if (!s.Dock) { TurnOff(); return; }
        var mode = DockLayout.ParseMode(s.DockModeName);
        var edge = DockLayout.ParseEdge(s.DockEdgeName);
        var key = $"{mode}|{edge}|{s.DockMonitor}|{s.DockCompact}|{s.DockTheme}|{s.DockFloatX},{s.DockFloatY}|{s.DockOnTop}|{string.Join(",", DockLayout.Modules(s.DockModules, s.DockHiddenModules))}";
        if (_on && key == _lastApplied) return;
        _lastApplied = key;
        _on = true;

        // Leave the previous mode first (the work area then grows back before it is measured).
        if (mode != DockMode.Fixed && _bar.Registered && !_bar.AutoHideRegistered) _bar.Remove();
        if (mode != DockMode.AutoHide && _bar.AutoHideRegistered) _bar.Remove();
        if (mode == DockMode.Floating && _bar.Registered) _bar.Remove();

        _mode = mode;
        _edge = edge;
        _screen = Monitors.Pick(s.DockMonitor);
        var horizontal = DockLayout.IsHorizontal(edge);
        // The parts were reordered or hidden (settings): built again at once.
        var modules = string.Join(",", DockLayout.Modules(s.DockModules, s.DockHiddenModules));
        if (!_built || horizontal != _horizontal || s.DockCompact != _compact || modules != _builtModules)
        {
            _builtModules = modules;
            _horizontal = horizontal;
            _compact = s.DockCompact;
            Build();
        }
        _root.RequestedTheme = s.DockTheme switch { "dark" => ElementTheme.Dark, "light" => ElementTheme.Light, _ => ElementTheme.Default };
        _thickness = (int)Math.Round(DockLayout.ThicknessDip(edge, _compact) * _screen.Scale);
        Rounded(mode == DockMode.Floating);

        switch (mode)
        {
            case DockMode.Fixed:
                if (_bar.Register())
                {
                    var rect = _bar.Reserve(_screen.Bounds, edge, _thickness);
                    Place(rect);
                }
                else
                {
                    // The shell refused the AppBar: an ordinary window on that edge, no work area reserved.
                    App.DebugLayout("dock: AppBar refused, plain window on the edge");
                    Place(DockLayout.Strip(_screen.Work, edge, _thickness));
                }
                SetTopMost(true);
                _fast.Stop();
                break;
            case DockMode.AutoHide:
                _bar.Register();
                if (!_bar.SetAutoHide(true, _screen.Bounds, edge))
                    App.DebugLayout("dock: auto-hide edge taken; sliding without the shell registration");
                _shown = DockLayout.Strip(_screen.Work, edge, _thickness);
                _hidden = DockLayout.Hidden(_shown, edge, Math.Max(2, (int)Math.Round(2 * _screen.Scale)));
                _t = 1; _target = 1; _wantShown = true; _wantSince = DateTime.UtcNow;
                Place(_shown);
                SetTopMost(true);
                _fast.Start();
                break;
            default:
                _fast.Stop();
                PlaceFloating();
                SetTopMost(s.DockOnTop);
                break;
        }
        App.DebugLayout($"dock: on mode={mode} edge={edge} monitor={_screen.Device} dpi={_screen.Dpi} thickness={_thickness} at {AppWindow.Position.X},{AppWindow.Position.Y} {AppWindow.Size.Width}x{AppWindow.Size.Height}");
        if (!_fullscreen || !s.DockHideFullscreen) AppWindow.Show(false); // never takes the focus
        _slow.Start();
        Refresh();
    }

    private void TurnOff()
    {
        _bar.Remove();
        _fast.Stop();
        _slow.Stop();
        if (_on) App.DebugLayout("dock: off");
        _on = false;
        _lastApplied = null;
        AppWindow.Hide();
    }

    /// <summary>The interface language changed: build the parts again.</summary>
    public void RebuildTexts()
    {
        _built = false;
        _lastApplied = null;
        _root.ContextFlyout = Menu();
        if (_on) Apply();
    }

    /// <summary>The app quits: the work area goes back to Windows.</summary>
    public void Shutdown()
    {
        _bar.Remove();
        _fast.Stop();
        _slow.Stop();
    }

    /// <summary>Last resort when the process ends without Shutdown (it runs on another thread).</summary>
    public void RemoveAppBarOnExit() => _bar.Remove();

    private void Place(PixelRect r) => AppWindow.MoveAndResize(new RectInt32(r.X, r.Y, Math.Max(1, r.Width), Math.Max(1, r.Height)));

    private void Rounded(bool round)
    {
        var value = round ? 2 /* DWMWCP_ROUND */ : 1 /* DWMWCP_DONOTROUND */;
        try { DwmSetWindowAttribute(Hwnd, 33, ref value, sizeof(int)); } catch (Exception) { }
    }

    private void SetTopMost(bool on)
    {
        if (AppWindow.Presenter is OverlappedPresenter p) p.IsAlwaysOnTop = on;
        SetWindowPos(Hwnd, on ? HwndTopMost : HwndNoTopMost, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);
    }

    private void PlaceFloating()
    {
        var s = App.Current.Settings;
        var scale = _screen.Scale;
        _root.Measure(_horizontal
            ? new Windows.Foundation.Size(double.PositiveInfinity, DockLayout.ThicknessDip(_edge, _compact))
            : new Windows.Foundation.Size(DockLayout.ThicknessDip(_edge, _compact), double.PositiveInfinity));
        var desired = _root.DesiredSize;
        var width = _horizontal ? (int)Math.Round(Math.Max(360, desired.Width + 8) * scale) : _thickness;
        var height = _horizontal ? _thickness : (int)Math.Round(Math.Max(300, desired.Height + 8) * scale);
        var work = _screen.Work;
        var x = s.DockFloatX is { } fx ? work.X + (int)Math.Round(fx * scale) : work.X + (work.Width - width) / 2;
        var y = s.DockFloatY is { } fy ? work.Y + (int)Math.Round(fy * scale) : work.Y + (int)Math.Round(12 * scale);
        Place(DockLayout.Clamp(new PixelRect(x, y, width, height), work));
    }

    // ---- full screen, auto-hide ----

    private void SlowTick()
    {
        UpdateFullscreen();
        var pending = App.Current.Pending.Count;
        _badge.Text = pending > 9 ? "9+" : pending.ToString();
        _badgeBox.Visibility = pending > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void UpdateFullscreen()
    {
        if (!_on) return;
        var polled = false;
        // QUERY_USER_NOTIFICATION_STATE 2 busy (a full-screen app), 3 a full-screen game, 4 presentation mode.
        try { polled = SHQueryUserNotificationState(out var q) == 0 && q is 2 or 3 or 4; } catch (Exception) { }
        // Only when the full-screen window is on the Dock's own monitor.
        var now = (_abnFullscreen || polled) && ForegroundCovers(_screen.Bounds);
        if (now == _fullscreen) return;
        _fullscreen = now;
        App.DebugLayout($"dock: full-screen app {(now ? "started" : "ended")}");
        if (now)
        {
            if (App.Current.Settings.DockHideFullscreen) AppWindow.Hide();
            else { SetTopMost(false); SetWindowPos(Hwnd, HwndBottom, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate); }
        }
        else
        {
            AppWindow.Show(false);
            SetTopMost(_mode != DockMode.Floating || App.Current.Settings.DockOnTop);
        }
    }

    private bool ForegroundCovers(PixelRect monitor)
    {
        var fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || fg == Hwnd) return false;
        GetWindowThreadProcessId(fg, out var pid);
        if (pid == (uint)Environment.ProcessId) return false;
        var name = new System.Text.StringBuilder(64);
        GetClassName(fg, name, name.Capacity);
        if (name.ToString() is "Progman" or "WorkerW" or "Shell_TrayWnd") return false;
        if (!GetWindowRect(fg, out var r)) return false;
        return r.Left <= monitor.X && r.Top <= monitor.Y && r.Right >= monitor.Right && r.Bottom >= monitor.Bottom;
    }

    private void AutoHideTick()
    {
        if (_mode != DockMode.AutoHide || !_on) { _fast.Stop(); return; }
        GetCursorPos(out var p);
        var now = new PixelRect(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height);
        var over = now.Contains(p.X, p.Y) || DockLayout.Wakes(_screen.Work, _edge, p.X, p.Y, Math.Max(2, (int)Math.Round(2 * _screen.Scale)));
        var want = over || _menuOpen || _reorderDown || App.Current.MonitorPanelOpen || App.Current.QuickPanelOpen;
        if (want != _wantShown) { _wantShown = want; _wantSince = DateTime.UtcNow; }
        var delay = want ? App.Current.Settings.DockShowDelay : App.Current.Settings.DockHideDelay;
        if ((DateTime.UtcNow - _wantSince).TotalMilliseconds >= Math.Clamp(delay, 0, 5000)) _target = want ? 1 : 0;
        if (Math.Abs(_t - _target) < 0.001) return;
        _t = _target > _t ? Math.Min(_target, _t + 0.2) : Math.Max(_target, _t - 0.2);
        var eased = 1 - Math.Pow(1 - _t, 3);
        Place(DockLayout.Between(_hidden, _shown, eased));
        if (_t is 0 or 1) App.DebugLayout($"dock: auto-hide {(_t == 1 ? "shown" : "hidden")} at {AppWindow.Position.X},{AppWindow.Position.Y}");
    }

    // ---- what it shows ----

    private void Build()
    {
        _built = true;
        _root.Children.Clear();
        _root.RowDefinitions.Clear();
        _root.ColumnDefinitions.Clear();
        _root.Background = new SolidColorBrush(Colors.Transparent);
        _root.Padding = _horizontal ? new Thickness(8, 4, 8, 4) : new Thickness(6, 8, 6, 8);
        void Track(int i, GridLength size)
        {
            if (_horizontal) _root.ColumnDefinitions.Add(new ColumnDefinition { Width = size });
            else _root.RowDefinitions.Add(new RowDefinition { Height = size });
        }
        void Put(UIElement e, int i)
        {
            if (_horizontal) Grid.SetColumn((FrameworkElement)e, i); else Grid.SetRow((FrameworkElement)e, i);
            _root.Children.Add(e);
        }
        Track(0, GridLength.Auto);
        Track(1, new GridLength(1, GridUnitType.Star));
        Track(2, GridLength.Auto);
        var orientation = _horizontal ? Orientation.Horizontal : Orientation.Vertical;
        var modules = DockLayout.Modules(App.Current.Settings.DockModules, App.Current.Settings.DockHiddenModules);

        // Left / top: the grip (floating), the WECOMMANDER icon and the server.
        var start = new StackPanel { Orientation = orientation, Spacing = 6, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        var grip = new Border { Width = _horizontal ? 14 : double.NaN, Height = _horizontal ? double.NaN : 14, Background = new SolidColorBrush(Colors.Transparent),
            Child = new FontIcon { Glyph = _horizontal ? "" : "", FontSize = 12, Opacity = 0.6, Rotation = _horizontal ? 0 : 90 } };
        ToolTipService.SetToolTip(grip, L.T("Sürükle: taşı"));
        grip.PointerPressed += OnGripPressed;
        grip.PointerMoved += OnGripMoved;
        grip.PointerReleased += OnGripReleased;
        grip.PointerCaptureLost += (_, _) => { if (_gripDown && _dragging) { _gripDown = false; _dragging = false; try { DroppedFloating(); } catch (Exception ex) { App.LogCrash(ex); } } else _gripDown = false; };
        _grip = grip;
        start.Children.Add(grip);
        var app = IconButton(AppIcon(), L.T("WECOMMANDER: hızlı panel"));
        app.Click += (_, _) => OpenQuickPanel(app);
        _appButton = app;
        start.Children.Add(app);
        if (modules.Contains("servers")) start.Children.Add(ServerPicker());
        Put(start, 0);

        // Middle: the live meters (click: the matching management screen).
        var middle = new StackPanel { Orientation = orientation, Spacing = _horizontal ? 14 : 8, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        var meterWidth = _horizontal ? (_compact ? 64 : 90) : (_compact ? 74 : 98);
        var meterHeight = _compact ? 16 : 22;
        _meters = [new("CPU", meterWidth, meterHeight), new("RAM", meterWidth, meterHeight), new("Disk", meterWidth, meterHeight)];
        if (modules.Contains("servers"))
        {
            var sections = new[] { "processes", "processes", "disk" };
            var tips = new[] { L.T("İşlemci: Süreçler"), L.T("Bellek: Süreçler"), "Disk: disk analizi (kritikse temizlik)" };
            for (var i = 0; i < 3; i++)
            {
                var meter = _meters[i];
                meter.SetLine(true);
                var index = i;
                var hit = new Button { Content = meter.Root, Padding = new Thickness(4, 0, 4, 0), Background = new SolidColorBrush(Colors.Transparent), BorderThickness = new Thickness(0) };
                ToolTipService.SetToolTip(hit, tips[i]);
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(hit, meter.Name);
                hit.Click += (_, _) => OpenSection(index == 2 && Selected() is { Disk: >= 90 } ? "cleanup" : sections[index]);
                middle.Children.Add(hit);
            }
        }
        var scroll = new ScrollViewer
        {
            Content = middle,
            HorizontalScrollMode = _horizontal ? ScrollMode.Auto : ScrollMode.Disabled,
            HorizontalScrollBarVisibility = _horizontal ? ScrollBarVisibility.Hidden : ScrollBarVisibility.Disabled,
            VerticalScrollMode = _horizontal ? ScrollMode.Disabled : ScrollMode.Auto,
            VerticalScrollBarVisibility = _horizontal ? ScrollBarVisibility.Disabled : ScrollBarVisibility.Hidden,
        };
        Put(scroll, 1);

        // Right / bottom: quick access (the module buttons move along the Dock by drag or Alt + arrows).
        ResetReorder();
        _moduleItems.Clear();
        var end = new StackPanel { Orientation = orientation, Spacing = 2, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        foreach (var m in modules)
        {
            switch (m)
            {
                case "processes":
                    var procs = IconButton(new FontIcon { Glyph = "", FontSize = 16 }, L.T("Görev Yöneticisi"), _horizontal && !_compact ? L.T("Görev Yöneticisi") : null);
                    procs.Click += (_, _) => TaskManagerWindow.Open();
                    AddModule(end, m, procs, procs);
                    break;
                case "timers":
                    var timers = IconButton(new FontIcon { Glyph = "\uE823", FontSize = 16 }, L.T("Zamanlayıcılar"), _horizontal && !_compact ? L.T("Zamanlayıcılar") : null);
                    timers.Click += (_, _) => TaskSchedulerWindow.Open();
                    AddModule(end, m, timers, timers);
                    break;
                case "terminal":
                    var term = IconButton(new FontIcon { Glyph = "", FontSize = 16 }, "Terminal", _horizontal && !_compact ? "Terminal" : null);
                    term.Click += (_, _) => OpenTerminal();
                    AddModule(end, m, term, term);
                    break;
                case "tasks":
                    var tasks = IconButton(new FontIcon { Glyph = "", FontSize = 16 }, L.T("Zamanlanmış görevler"));
                    tasks.Click += (_, _) => App.Current.ShowScheduledTasks();
                    AddModule(end, m, tasks, tasks);
                    break;
                case "approvals":
                    var bell = new Grid();
                    var approvals = IconButton(new FontIcon { Glyph = "", FontSize = 16 }, L.T("Bekleyen onaylar"));
                    approvals.Click += (_, _) => App.Current.ShowApprovals();
                    bell.Children.Add(approvals);
                    if (_badgeBox.Parent is Panel old) old.Children.Remove(_badgeBox);
                    _badgeBox.Child = _badge;
                    bell.Children.Add(_badgeBox);
                    AddModule(end, m, bell, approvals);
                    break;
            }
        }
        var settings = IconButton(new FontIcon { Glyph = "", FontSize = 16 }, L.T("Dock ayarları"));
        settings.Click += (_, _) => App.Current.ShowDockSettings();
        end.Children.Add(settings);
        _end = end;
        Put(end, 2);
    }

    private static Image AppIcon() => new()
    {
        // The WECOMMANDER mark (the same picture as the site's favicon and the app icon).
        Source = new BitmapImage(new Uri(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "icon.png"))),
        Width = 26,
        Height = 26,
    };

    private Button IconButton(UIElement icon, string tip, string? label = null)
    {
        object content = icon;
        if (label is not null)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
            row.Children.Add(icon);
            row.Children.Add(new TextBlock { Text = label, FontSize = 13, VerticalAlignment = VerticalAlignment.Center });
            content = row;
        }
        var button = new Button
        {
            Content = content,
            MinWidth = 38, Height = 38, Padding = new Thickness(label is null ? 0 : 10, 0, label is null ? 0 : 10, 0),
            Background = new SolidColorBrush(Colors.Transparent),
            BorderThickness = new Thickness(0),
        };
        ToolTipService.SetToolTip(button, tip);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, tip);
        return button;
    }

    private Button ServerPicker()
    {
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        _serverName.FontSize = _compact ? 12 : 13;
        _serverName.MaxWidth = _horizontal ? 140 : 90;
        // Fresh elements on every build: a rebuild (e.g. after a module drag) can run while the
        // old tree still holds the previous ones, and WinUI refuses an element with a parent.
        _serverName = new TextBlock { Text = _serverName.Text, FontSize = _serverName.FontSize, MaxWidth = _serverName.MaxWidth,
            FontWeight = _serverName.FontWeight, TextTrimming = _serverName.TextTrimming, VerticalAlignment = _serverName.VerticalAlignment };
        _serverDot = new Ellipse { Width = 8, Height = 8, VerticalAlignment = VerticalAlignment.Center, Fill = _serverDot.Fill };
        _serverState = new TextBlock { Text = _serverState.Text, FontSize = 11, Foreground = _serverState.Foreground };
        text.Children.Add(_serverName);
        var state = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 5 };
        state.Children.Add(_serverDot);
        if (!_compact) state.Children.Add(_serverState);
        text.Children.Add(state);
        var button = new Button { Content = text, Padding = new Thickness(8, 2, 8, 2), Background = new SolidColorBrush(Colors.Transparent), BorderThickness = new Thickness(0) };
        ToolTipService.SetToolTip(button, L.T("Gösterilen sunucu"));
        var menu = new MenuFlyout();
        menu.Opening += (_, _) =>
        {
            menu.Items.Clear();
            var busiest = new ToggleMenuFlyoutItem { Text = L.T("En yoğun sunucu (kendiliğinden)"), IsChecked = App.Current.Settings.DockServer is null };
            busiest.Click += (_, _) => { App.Current.Settings.DockServer = null; App.Current.SaveSettings(); Refresh(); };
            menu.Items.Add(busiest);
            menu.Items.Add(new MenuFlyoutSeparator());
            foreach (var s in _monitor.Servers)
            {
                var item = new ToggleMenuFlyoutItem { Text = s.Label, IsChecked = App.Current.Settings.DockServer == s.HostId };
                var id = s.HostId;
                item.Click += (_, _) => { App.Current.Settings.DockServer = id; App.Current.SaveSettings(); Refresh(); };
                menu.Items.Add(item);
            }
            if (_monitor.Servers.Count == 0) menu.Items.Add(new MenuFlyoutItem { Text = L.T("İzlenen sunucu yok: Sunucularım panelinden ekle"), IsEnabled = false });
        };
        Hold(menu);
        button.Flyout = menu;
        return button;
    }

    private WatchedServer? Selected()
    {
        var servers = _monitor.Servers;
        if (servers.Count == 0) return null;
        var chosen = App.Current.Settings.DockServer;
        return servers.FirstOrDefault(x => x.HostId == chosen)
            ?? servers.Where(x => x.Live).OrderByDescending(x => x.Worst).FirstOrDefault()
            ?? servers[0];
    }

    private void Refresh()
    {
        if (!_on || _meters.Length == 0) return;
        var s = Selected();
        if (s is null)
        {
            _serverName.Text = L.T("Sunucu yok");
            _serverState.Text = "izlenmiyor";
            _serverDot.Fill = new SolidColorBrush(Colors.Gray);
            foreach (var m in _meters) m.Show(null, [], false, false);
            return;
        }
        _serverName.Text = s.Label;
        // A dropped connection is never shown as live: no numbers until it answers again.
        var (state, color) = s.Error is not null ? (L.T("bağlanamadı"), ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44))
            : !s.Live ? (L.T("bağlanıyor…"), Colors.Gray)
            : s.Worst >= 90 ? ("kritik", ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44))
            : s.Worst >= 80 ? (L.T("yüksek kullanım"), ColorHelper.FromArgb(255, 0xF5, 0x9E, 0x0B))
            : (L.T("çevrimiçi"), ColorHelper.FromArgb(255, 0x16, 0xA3, 0x4A));
        _serverState.Text = state;
        _serverDot.Fill = new SolidColorBrush(color);
        var (points, fresh) = _history.Take(s);
        var values = new[] { s.Cpu, s.Mem, s.Disk };
        for (var i = 0; i < 3; i++)
            _meters[i].Show(s.Live ? values[i] : null, s.Live ? points[i] : [], fresh, true);
    }

    // ---- actions (they open screens; nothing risky runs from here) ----

    private void OpenSection(string section)
    {
        if (Selected() is not { } s) { App.Current.ToggleMonitorPanelFromDock(ScreenRect(_appButton), PanelSide()); return; }
        App.Current.OpenServerManagement(s, section);
    }

    private void OpenTerminal()
    {
        if (Selected() is { } s) App.Current.OpenHostTerminal(s.HostId);
        else App.Current.ShowServers();
    }

    private DockEdge PanelSide() => _mode == DockMode.Floating ? FloatingSide() : DockLayout.PanelSide(_edge);

    /// <summary>The WECOMMANDER icon: the quick panel (servers, terminals, files, timers, approvals, settings).</summary>
    private void OpenQuickPanel(FrameworkElement from) =>
        App.Current.ToggleQuickPanelFromDock(ScreenRect(from), PanelSide(), Selected);

    /// <summary>A floating Dock opens its panel toward the larger free side of the screen.</summary>
    private DockEdge FloatingSide()
    {
        var work = _screen.Work;
        if (_horizontal) return AppWindow.Position.Y - work.Y > work.Bottom - (AppWindow.Position.Y + AppWindow.Size.Height) ? DockEdge.Top : DockEdge.Bottom;
        return AppWindow.Position.X - work.X > work.Right - (AppWindow.Position.X + AppWindow.Size.Width) ? DockEdge.Left : DockEdge.Right;
    }

    /// <summary>An element's place on the screen in physical pixels.</summary>
    private PixelRect ScreenRect(FrameworkElement? e)
    {
        if (e?.XamlRoot is null) return new PixelRect(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height);
        var scale = e.XamlRoot.RasterizationScale;
        var p = e.TransformToVisual(null).TransformPoint(new Windows.Foundation.Point(0, 0));
        return new PixelRect(AppWindow.Position.X + (int)Math.Round(p.X * scale), AppWindow.Position.Y + (int)Math.Round(p.Y * scale),
            (int)Math.Round(e.ActualWidth * scale), (int)Math.Round(e.ActualHeight * scale));
    }

    // ---- floating: drag, remember, offer an edge ----

    private bool _gripDown, _dragging;
    private POINT _gripAt;
    private PointInt32 _windowAt;

    // The Dock moves itself while the grip is held (no modal move loop: the
    // pointer stays captured by the grip, so every move and the release arrive here).
    private void OnGripPressed(object sender, PointerRoutedEventArgs e)
    {
        if (_mode != DockMode.Floating || !e.GetCurrentPoint(_root).Properties.IsLeftButtonPressed) return;
        _gripDown = true;
        _dragging = false;
        GetCursorPos(out _gripAt);
        _windowAt = AppWindow.Position;
        if (sender is UIElement grip) grip.CapturePointer(e.Pointer);
        App.DebugLayout($"dock: grip pressed at {_gripAt.X},{_gripAt.Y}");
        e.Handled = true;
    }

    private void OnGripMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_gripDown) return;
        GetCursorPos(out var now);
        if (!_dragging && Math.Abs(now.X - _gripAt.X) < 4 && Math.Abs(now.Y - _gripAt.Y) < 4) return;
        _dragging = true;
        AppWindow.Move(new PointInt32(_windowAt.X + now.X - _gripAt.X, _windowAt.Y + now.Y - _gripAt.Y));
        e.Handled = true;
    }

    private void OnGripReleased(object sender, PointerRoutedEventArgs e)
    {
        if (!_gripDown) return;
        _gripDown = false;
        if (sender is UIElement grip) grip.ReleasePointerCapture(e.Pointer);
        if (!_dragging) return;
        _dragging = false;
        try { DroppedFloating(); } catch (Exception ex) { App.LogCrash(ex); }
    }

    private void DroppedFloating()
    {
        // Where Windows' move left it, read from the window itself (the move loop just ended).
        if (!GetWindowRect(_hwnd, out var r)) return;
        var rect = PixelRect.FromEdges(r.Left, r.Top, r.Right, r.Bottom);
        // The monitor it was dropped on becomes its monitor.
        var cx = rect.X + rect.Width / 2;
        var cy = rect.Y + rect.Height / 2;
        var screen = Monitors.All().FirstOrDefault(m => m.Bounds.Contains(cx, cy)) ?? _screen;
        _screen = screen;
        var s = App.Current.Settings;
        s.DockMonitor = screen.Device;
        s.DockFloatX = (int)Math.Round((rect.X - screen.Work.X) / screen.Scale);
        s.DockFloatY = (int)Math.Round((rect.Y - screen.Work.Y) / screen.Scale);
        App.Current.SaveSettings();
        _lastApplied = null;
        App.DebugLayout($"dock: floating moved to {rect.X},{rect.Y} on {screen.Device}");
        if (DockLayout.SnapEdge(rect, screen.Work, (int)Math.Round(24 * screen.Scale)) is { } edge) OfferEdge(edge);
    }

    private static string SnapQuestion(DockEdge e) => e switch
    {
        DockEdge.Top => L.T("Dock üst kenara sabitlensin mi?"),
        DockEdge.Bottom => L.T("Dock alt kenara sabitlensin mi?"),
        DockEdge.Left => L.T("Dock sol kenara sabitlensin mi?"),
        _ => L.T("Dock sağ kenara sabitlensin mi?"),
    };

    private void OfferEdge(DockEdge edge)
    {
        App.DebugLayout($"dock: snap offer {edge}");
        var panel = new StackPanel { Spacing = 8, MaxWidth = 260 };
        panel.Children.Add(new TextBlock { Text = SnapQuestion(edge), TextWrapping = TextWrapping.Wrap });
        var yes = new Button { Content = L.T("Sabitle"), Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        panel.Children.Add(yes);
        var flyout = new Flyout { Content = panel };
        yes.Click += (_, _) =>
        {
            flyout.Hide();
            App.Current.Settings.DockModeName = DockLayout.Name(DockMode.Fixed);
            App.Current.Settings.DockEdgeName = DockLayout.Name(edge);
            App.Current.SaveSettings();
            Apply();
        };
        Hold(flyout);
        if (_grip is not null) flyout.ShowAt(_grip);
    }

    // ---- module buttons: drag along the Dock (or Alt + arrows) to change their order ----

    private readonly List<(string Name, FrameworkElement Item, Button Button)> _moduleItems = [];
    private StackPanel? _end;
    private bool _reorderDown, _reordering, _reorderStealing;
    private int _reorderFrom = -1;
    private uint _reorderPointerId;
    private POINT _reorderAt;
    private (int Start, int Length)[] _reorderExtents = [];

    /// <summary>
    /// One module button on the Dock. It sits in its own holder: a press and a
    /// move beyond a few pixels takes the pointer from the button (no click
    /// then) and drags the holder along the Dock; a plain click stays the button's.
    /// The app icon, the server picker and the settings button are not module buttons.
    /// </summary>
    private void AddModule(StackPanel end, string name, FrameworkElement content, Button button)
    {
        var holder = new Grid { Background = new SolidColorBrush(Colors.Transparent), RenderTransform = new TranslateTransform() };
        holder.Children.Add(content);
        _moduleItems.Add((name, holder, button));
        end.Children.Add(holder);
        // The button handles the press itself: these see it anyway.
        holder.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler(OnModulePressed), true);
        holder.AddHandler(UIElement.PointerMovedEvent, new PointerEventHandler(OnModuleMoved), true);
        holder.AddHandler(UIElement.PointerReleasedEvent, new PointerEventHandler(OnModuleReleased), true);
        holder.AddHandler(UIElement.PointerCaptureLostEvent, new PointerEventHandler(OnModuleCaptureLost), true);
        holder.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler(OnModuleKey), true);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetHelpText(button, L.T("Sürükle veya Alt + ok tuşları: Dock'taki sırasını değiştir"));
    }

    private double Scale => _root.XamlRoot is { RasterizationScale: > 0 } root ? root.RasterizationScale : _screen.Scale;
    private int Along(POINT p) => _horizontal ? p.X : p.Y;
    private int Across(POINT p) => _horizontal ? p.Y : p.X;

    private void OnModulePressed(object sender, PointerRoutedEventArgs e)
    {
        if (_reordering || sender is not FrameworkElement holder) return;
        if (!e.GetCurrentPoint(holder).Properties.IsLeftButtonPressed) return;
        var index = _moduleItems.FindIndex(x => x.Item == holder);
        if (index < 0) return;
        _reorderDown = true;
        _reorderFrom = index;
        _reorderPointerId = e.Pointer.PointerId;
        GetCursorPos(out _reorderAt);
        // Not handled: a press and release without moving stays a click on the button.
    }

    private void OnModuleMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_reorderDown || e.Pointer.PointerId != _reorderPointerId || _reorderFrom < 0 || _reorderFrom >= _moduleItems.Count) return;
        var holder = _moduleItems[_reorderFrom].Item;
        if (!ReferenceEquals(sender, holder)) return;
        if (!e.GetCurrentPoint(holder).Properties.IsLeftButtonPressed)
        {
            // The release was missed (it happened elsewhere): nothing moves.
            if (_reordering) CancelReorder("button up"); else ResetReorder();
            return;
        }
        GetCursorPos(out var now);
        if (!_reordering)
        {
            var threshold = Math.Max(4, (int)Math.Round(6 * Scale));
            if (Math.Abs(Along(now) - Along(_reorderAt)) < threshold && Math.Abs(Across(now) - Across(_reorderAt)) < threshold) return;
            StartReorder(holder, e.Pointer);
        }
        if ((GetAsyncKeyState(0x1B /* VK_ESCAPE */) & 0x8000) != 0) { CancelReorder("escape"); e.Handled = true; return; }
        FollowPointer(now);
        e.Handled = true;
    }

    private void StartReorder(FrameworkElement holder, Pointer pointer)
    {
        // Where every module button is now (screen pixels along the Dock), before anything moves.
        _reorderExtents = _moduleItems.Select(x =>
        {
            var r = ScreenRect(x.Item);
            return _horizontal ? (r.X, r.Width) : (r.Y, r.Height);
        }).ToArray();
        _reordering = true;
        _reorderStealing = true;
        try
        {
            // The button lets go of the pointer (so its click does not fire); the holder takes it.
            _moduleItems[_reorderFrom].Button.ReleasePointerCaptures();
            if (!holder.CapturePointer(pointer)) App.DebugLayout("dock: module drag could not capture the pointer");
        }
        finally { _reorderStealing = false; }
        Canvas.SetZIndex(holder, 10);
        holder.Opacity = 0.8;
        App.DebugLayout($"dock: module drag {_moduleItems[_reorderFrom].Name} from {_reorderFrom} at {_reorderAt.X},{_reorderAt.Y}");
    }

    /// <summary>The dragged button follows the pointer along the Dock; the others step aside to show where it lands.</summary>
    private void FollowPointer(POINT now)
    {
        if (_reorderExtents.Length != _moduleItems.Count || _reorderExtents.Length == 0) return;
        var scale = Scale;
        var from = _reorderFrom;
        var (start, length) = _reorderExtents[from];
        var first = _reorderExtents[0].Start;
        var last = _reorderExtents[^1].Start + _reorderExtents[^1].Length;
        var delta = Math.Clamp(Along(now) - Along(_reorderAt), Math.Min(0, first - start), Math.Max(0, last - (start + length)));
        Shift(_moduleItems[from].Item, delta / scale);
        var slot = DockLayout.DropSlot(_reorderExtents, from, Along(now));
        var step = length / scale + (_end?.Spacing ?? 0);
        for (var i = 0; i < _moduleItems.Count; i++)
        {
            if (i == from) continue;
            var offset = from < slot && i > from && i <= slot ? -step
                : from > slot && i >= slot && i < from ? step
                : 0;
            Shift(_moduleItems[i].Item, offset);
        }
    }

    private void Shift(FrameworkElement e, double by)
    {
        if (e.RenderTransform is not TranslateTransform t)
        {
            t = new TranslateTransform();
            e.RenderTransform = t;
        }
        if (_horizontal) { t.X = by; t.Y = 0; } else { t.X = 0; t.Y = by; }
    }

    private void OnModuleReleased(object sender, PointerRoutedEventArgs e)
    {
        if (!_reorderDown || e.Pointer.PointerId != _reorderPointerId) return;
        if (!_reordering) { ResetReorder(); return; } // a plain click: the button handles it
        e.Handled = true;
        GetCursorPos(out var now);
        var from = _reorderFrom;
        var slot = DockLayout.DropSlot(_reorderExtents, from, Along(now));
        var holder = _moduleItems[from].Item;
        ResetReorder();
        try { holder.ReleasePointerCapture(e.Pointer); } catch (Exception) { }
        App.DebugLayout($"dock: module drag dropped at {now.X},{now.Y} slot {slot}");
        MoveModule(from, slot, keyboard: false);
    }

    private void OnModuleCaptureLost(object sender, PointerRoutedEventArgs e)
    {
        if (!_reordering || _reorderStealing || e.Pointer.PointerId != _reorderPointerId) return;
        // The button's own capture going away (handed to the holder) bubbles here too: only the holder's counts.
        if (_reorderFrom >= 0 && _reorderFrom < _moduleItems.Count
            && _moduleItems[_reorderFrom].Item.PointerCaptures?.Any(p => p.PointerId == _reorderPointerId) == true) return;
        CancelReorder("capture lost");
    }

    private void CancelReorder(string why)
    {
        if (!_reordering) { ResetReorder(); return; }
        var holder = _reorderFrom >= 0 && _reorderFrom < _moduleItems.Count ? _moduleItems[_reorderFrom].Item : null;
        ResetReorder();
        try { holder?.ReleasePointerCaptures(); } catch (Exception) { }
        App.DebugLayout($"dock: module drag cancelled ({why})");
    }

    /// <summary>No drag going on: every module button back in its own place.</summary>
    private void ResetReorder()
    {
        _reorderDown = false;
        _reordering = false;
        _reorderFrom = -1;
        _reorderExtents = [];
        foreach (var (_, item, _) in _moduleItems)
        {
            Shift(item, 0);
            item.Opacity = 1;
            Canvas.SetZIndex(item, 0);
        }
    }

    /// <summary>Alt + Left / Right (a row) or Alt + Up / Down (a column) on a focused module button moves it one place.</summary>
    private void OnModuleKey(object sender, KeyRoutedEventArgs e)
    {
        if (_reordering || GetKeyState(0x12 /* VK_MENU */) >= 0) return;
        var step = (e.Key, _horizontal) switch
        {
            (Windows.System.VirtualKey.Left, true) or (Windows.System.VirtualKey.Up, false) => -1,
            (Windows.System.VirtualKey.Right, true) or (Windows.System.VirtualKey.Down, false) => 1,
            _ => 0,
        };
        if (step == 0) return;
        var index = _moduleItems.FindIndex(x => ReferenceEquals(x.Item, sender));
        if (index < 0) return;
        e.Handled = true;
        MoveModule(index, index + step, keyboard: true);
    }

    /// <summary>
    /// The same move as Settings → Dock: the saved order changes (hidden parts
    /// keep their places), it is saved and the Dock is built again.
    /// </summary>
    private void MoveModule(int from, int to, bool keyboard)
    {
        var shown = _moduleItems.Select(x => x.Name).ToList();
        if (from < 0 || from >= shown.Count) return;
        to = Math.Clamp(to, 0, shown.Count - 1);
        if (from == to) return;
        var name = shown[from];
        var s = App.Current.Settings;
        s.DockModules = DockLayout.MoveShown(s.DockModules, shown, from, to);
        App.Current.SaveSettings();
        App.DebugLayout($"dock: module {name} moved {from} -> {to}; order {string.Join(",", s.DockModules)}");
        // Built again after this pointer or key event is over (its element is replaced).
        DispatcherQueue.TryEnqueue(() =>
        {
            App.Current.ApplyDock();
            if (!keyboard) return;
            var moved = _moduleItems.FirstOrDefault(x => x.Name == name).Button;
            moved?.Focus(FocusState.Keyboard);
        });
    }

    // ---- right click ----

    /// <summary>An auto-hidden Dock stays out while its menus are open.</summary>
    private void Hold(FlyoutBase flyout)
    {
        flyout.Opening += (_, _) => _menuOpen = true;
        flyout.Closed += (_, _) => _menuOpen = false;
    }

    private MenuFlyout Menu()
    {
        var menu = new MenuFlyout();
        Hold(menu);
        menu.Opening += (_, _) =>
        {
            var s = App.Current.Settings;
            menu.Items.Clear();
            var mode = new MenuFlyoutSubItem { Text = L.T("Görünüm"), Icon = new FontIcon { Glyph = "" } };
            foreach (var (m, text) in new[] { (DockMode.Fixed, L.T("Sabit")), (DockMode.AutoHide, L.T("Otomatik gizlenen")), (DockMode.Floating, L.T("Yüzen")) })
            {
                var item = new ToggleMenuFlyoutItem { Text = text, IsChecked = DockLayout.ParseMode(s.DockModeName) == m };
                item.Click += (_, _) => { s.DockModeName = DockLayout.Name(m); App.Current.SaveSettings(); Apply(); };
                mode.Items.Add(item);
            }
            menu.Items.Add(mode);
            var edge = new MenuFlyoutSubItem { Text = L.T("Konum"), Icon = new FontIcon { Glyph = "" } };
            foreach (var (e, text) in new[] { (DockEdge.Top, L.T("Üst")), (DockEdge.Bottom, L.T("Alt")), (DockEdge.Left, L.T("Sol")), (DockEdge.Right, L.T("Sağ")) })
            {
                var item = new ToggleMenuFlyoutItem { Text = text, IsChecked = DockLayout.ParseEdge(s.DockEdgeName) == e };
                item.Click += (_, _) => { s.DockEdgeName = DockLayout.Name(e); App.Current.SaveSettings(); Apply(); };
                edge.Items.Add(item);
            }
            menu.Items.Add(edge);
            var monitors = Monitors.All();
            if (monitors.Count > 1)
            {
                var screen = new MenuFlyoutSubItem { Text = L.T("Ekran"), Icon = new FontIcon { Glyph = "" } };
                var number = 0;
                foreach (var m in monitors)
                {
                    number++;
                    var item = new ToggleMenuFlyoutItem { Text = $"Ekran {number}{(m.Primary ? " (ana)" : "")} · {m.Bounds.Width}×{m.Bounds.Height}", IsChecked = m.Device == _screen.Device };
                    var device = m.Device;
                    item.Click += (_, _) => { s.DockMonitor = device; s.DockFloatX = null; s.DockFloatY = null; App.Current.SaveSettings(); Apply(); };
                    screen.Items.Add(item);
                }
                menu.Items.Add(screen);
            }
            var compact = new ToggleMenuFlyoutItem { Text = L.T("Kompakt"), IsChecked = s.DockCompact };
            compact.Click += (_, _) => { s.DockCompact = compact.IsChecked; App.Current.SaveSettings(); Apply(); };
            menu.Items.Add(compact);
            if (DockLayout.ParseMode(s.DockModeName) == DockMode.Floating)
            {
                var onTop = new ToggleMenuFlyoutItem { Text = L.T("Her zaman üstte"), IsChecked = s.DockOnTop };
                onTop.Click += (_, _) => { s.DockOnTop = onTop.IsChecked; App.Current.SaveSettings(); Apply(); };
                menu.Items.Add(onTop);
            }
            var fullscreen = new ToggleMenuFlyoutItem { Text = L.T("Tam ekran uygulamalarda gizle"), IsChecked = s.DockHideFullscreen };
            fullscreen.Click += (_, _) => { s.DockHideFullscreen = fullscreen.IsChecked; App.Current.SaveSettings(); };
            menu.Items.Add(fullscreen);
            menu.Items.Add(new MenuFlyoutSeparator());
            var settings = new MenuFlyoutItem { Text = L.T("Dock ayarları…"), Icon = new FontIcon { Glyph = "" } };
            settings.Click += (_, _) => App.Current.ShowDockSettings();
            menu.Items.Add(settings);
            var app = new MenuFlyoutItem { Text = L.T("WECOMMANDER penceresi"), Icon = new FontIcon { Glyph = "" } };
            app.Click += (_, _) => App.Current.ShowServers();
            menu.Items.Add(app);
            var off = new MenuFlyoutItem { Text = L.T("Dock'u gizle"), Icon = new FontIcon { Glyph = "" } };
            off.Click += (_, _) =>
            {
                App.Current.SetDock(false);
                App.Current.Toast(L.T("Dock kapandı ve ekran alanı geri verildi. Yeniden açmak için: Ayarlar → Dock."));
            };
            menu.Items.Add(off);
        };
        return menu;
    }
}
