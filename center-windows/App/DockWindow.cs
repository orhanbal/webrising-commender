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
/// the edge. Floating: anywhere on the screen. Unlocked, it is dragged like the
/// Windows taskbar: dropped near an edge it is fixed there, elsewhere it floats.
/// It shows the watched server's live CPU / RAM / Disk (the same
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
    private TextBlock _badge = new() { FontSize = 10, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(Colors.White), HorizontalAlignment = HorizontalAlignment.Center };
    private Border _badgeBox = new() { CornerRadius = new CornerRadius(8), MinWidth = 16, Height = 16, Padding = new Thickness(4, 0, 4, 0),
        Background = new SolidColorBrush(ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44)), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top,
        Margin = new Thickness(0, 2, 2, 0), Visibility = Visibility.Collapsed, IsHitTestVisible = false };
    private FrameworkElement? _appButton;

    public const string WindowTitle = "WECOMMANDER Dock";

    public DockWindow(ServerMonitor monitor)
    {
        _monitor = monitor;
        Title = WindowTitle;
        // The Windows 11 taskbar's own material and theme (TaskbarBackdrop), not the lighter default acrylic.
        SystemBackdrop = new TaskbarBackdrop();
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
        // Esc while a module button or the Dock itself is dragged: it goes back where it was.
        _root.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler((_, e) =>
        {
            if (e.Key != Windows.System.VirtualKey.Escape) return;
            if (_reordering) { CancelReorder("escape"); e.Handled = true; }
            else if (_moving) { CancelMove("escape"); e.Handled = true; }
        }), true);
        // Moving the Dock (unlocked): a press anywhere but on a module button. The buttons
        // handle their presses themselves, so these see them anyway (handledEventsToo).
        _root.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler(OnRootPressed), true);
        _root.AddHandler(UIElement.PointerMovedEvent, new PointerEventHandler(OnRootMoved), true);
        _root.AddHandler(UIElement.PointerReleasedEvent, new PointerEventHandler(OnRootReleased), true);
        _root.AddHandler(UIElement.PointerCaptureLostEvent, new PointerEventHandler(OnRootCaptureLost), true);

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
        // Not while the Dock is being dragged: the drop applies the new place itself.
        _reapply.Tick += (_, _) => { if (_on && !_moving) { _lastApplied = null; Apply(); } };

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
            // The taskbar's colours changed (light / dark, accent on the taskbar): the Dock and its panels follow.
            if (msg == WmSettingChange && l != IntPtr.Zero && TaskbarLook.IsColorChange(Marshal.PtrToStringUni(l)))
                DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, () => { try { TaskbarBackdrop.RefreshAll(); } catch (Exception e) { App.LogCrash(e); } });
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
        // "system" follows the taskbar (not the apps' theme); a chosen theme is kept. The panels follow too.
        TaskbarBackdrop.RefreshAll();
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

    /// <summary>A floating Dock's size in physical pixels at <paramref name="scale"/>: as long as its parts need.</summary>
    private (int Width, int Height) FloatingSize(double scale)
    {
        var thicknessDip = DockLayout.ThicknessDip(_edge, _compact);
        _root.Measure(_horizontal
            ? new Windows.Foundation.Size(double.PositiveInfinity, thicknessDip)
            : new Windows.Foundation.Size(thicknessDip, double.PositiveInfinity));
        var desired = _root.DesiredSize;
        var thickness = (int)Math.Round(thicknessDip * scale);
        return _horizontal
            ? ((int)Math.Round(Math.Max(360, desired.Width + 8) * scale), thickness)
            : (thickness, (int)Math.Round(Math.Max(300, desired.Height + 8) * scale));
    }

    private void PlaceFloating()
    {
        var s = App.Current.Settings;
        var scale = _screen.Scale;
        var (width, height) = FloatingSize(scale);
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
        var want = over || _menuOpen || _reorderDown || _moveDown || App.Current.MonitorPanelOpen || App.Current.QuickPanelOpen || App.Current.DockPanelOpen;
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

        // Left / top: the WECOMMANDER icon (a start menu) and the server. Unlocked, the Dock
        // is moved by dragging any of these, the meters or the background (no separate grip).
        var start = new StackPanel { Orientation = orientation, Spacing = 6, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
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
                hit.Click += (_, _) => Run(() =>
                {
                    var section = index == 2 && Selected() is { Disk: >= 90 } ? "cleanup" : sections[index];
                    // Dock mode: the server management content in a panel under the meter.
                    if (App.Current.PanelsFromDock) Panel("server", hit, section);
                    else OpenSection(section);
                });
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
        _anchors.Clear();
        var end = new StackPanel { Orientation = orientation, Spacing = 2, VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
        foreach (var m in modules)
        {
            switch (m)
            {
                case "processes":
                    var procs = IconButton(new FontIcon { Glyph = "", FontSize = 16 }, L.T("Görev Yöneticisi"), _horizontal && !_compact ? L.T("Görev Yöneticisi") : null);
                    procs.Click += (_, _) => Run(() =>
                    {
                        if (App.Current.PanelsFromDock) Panel("taskmanager", procs);
                        else TaskManagerWindow.Open();
                    });
                    _anchors["taskmanager"] = procs;
                    AddModule(end, m, procs, procs);
                    break;
                case "terminal":
                    var term = IconButton(new FontIcon { Glyph = "", FontSize = 16 }, "Terminal", _horizontal && !_compact ? "Terminal" : null);
                    term.Click += (_, _) => Run(() =>
                    {
                        if (App.Current.PanelsFromDock) Panel("terminal", term);
                        else OpenTerminal();
                    });
                    _anchors["terminal"] = term;
                    AddModule(end, m, term, term);
                    break;
                case "tasks":
                    // One button for both kinds of schedule (it replaced separate timers and tasks buttons).
                    var tasks = IconButton(new FontIcon { Glyph = "\uE787", FontSize = 16 }, L.T("Görevler"), _horizontal && !_compact ? L.T("Görevler") : null);
                    var tasksMenu = TasksMenu();
                    tasks.Click += (_, _) =>
                    {
                        // Dock mode: a panel with the three as tabs; classic: the menu that opens their windows.
                        if (App.Current.PanelsFromDock) { Run(() => Panel("tasks", tasks)); return; }
                        try { tasksMenu.ShowAt(tasks, new FlyoutShowOptions { Placement = MenuPlacement() }); }
                        catch (Exception ex) { App.LogCrash(ex); }
                    };
                    _anchors["tasks"] = tasks;
                    AddModule(end, m, tasks, tasks);
                    break;
                case "approvals":
                    var bell = new Grid();
                    var approvals = IconButton(new FontIcon { Glyph = "", FontSize = 16 }, L.T("Bekleyen onaylar"));
                    approvals.Click += (_, _) => Run(() =>
                    {
                        if (App.Current.PanelsFromDock) Panel("approvals", approvals);
                        else App.Current.ShowApprovals();
                    });
                    _anchors["approvals"] = approvals;
                    bell.Children.Add(approvals);
                    // Fresh badge on every build (an element that still has a parent cannot be added again).
                    _badge = new TextBlock { Text = _badge.Text, FontSize = 10, FontWeight = FontWeights.Bold, Foreground = new SolidColorBrush(Colors.White), HorizontalAlignment = HorizontalAlignment.Center };
                    _badgeBox = new Border { CornerRadius = new CornerRadius(8), MinWidth = 16, Height = 16, Padding = new Thickness(4, 0, 4, 0),
                        Background = new SolidColorBrush(ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44)), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top,
                        Margin = new Thickness(0, 2, 2, 0), Visibility = _badgeBox.Visibility, IsHitTestVisible = false, Child = _badge };
                    bell.Children.Add(_badgeBox);
                    AddModule(end, m, bell, approvals);
                    break;
            }
        }
        var settings = IconButton(new FontIcon { Glyph = "", FontSize = 16 }, L.T("Dock ayarları"));
        settings.Click += (_, _) => Run(() =>
        {
            if (App.Current.PanelsFromDock) Panel("settings", settings);
            else App.Current.ShowDockSettings();
        });
        _anchors["settings"] = settings;
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

    /// <summary>The "Görevler" button's menu: WECOMMANDER's own scheduled tasks and the timers (this computer, the server).</summary>
    private MenuFlyout TasksMenu()
    {
        var menu = new MenuFlyout();
        Hold(menu);
        void Add(string glyph, string text, Action open)
        {
            var item = new MenuFlyoutItem { Text = text, Icon = new FontIcon { Glyph = glyph } };
            item.Click += (_, _) => { try { open(); } catch (Exception ex) { App.LogCrash(ex); } };
            menu.Items.Add(item);
        }
        Add("\uE787", L.T("WECOMMANDER görevleri"), () => App.Current.ShowScheduledTasks());
        Add("\uE823", L.T("Windows zamanlayıcıları"), () => TaskSchedulerWindow.Open());
        Add("\uE968", L.T("Sunucu zamanlayıcıları"), () => OpenSection("timers"));
        return menu;
    }

    /// <summary>A menu opened from a Dock button goes away from the Dock's edge.</summary>
    private FlyoutPlacementMode MenuPlacement() => PanelSide() switch
    {
        DockEdge.Top => FlyoutPlacementMode.TopEdgeAlignedLeft,
        DockEdge.Bottom => FlyoutPlacementMode.BottomEdgeAlignedLeft,
        DockEdge.Left => FlyoutPlacementMode.LeftEdgeAlignedTop,
        _ => FlyoutPlacementMode.RightEdgeAlignedTop,
    };

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
            // Radio items: one choice is checked (a toggle item checks itself on every click).
            var busiest = new RadioMenuFlyoutItem { Text = L.T("En yoğun sunucu (kendiliğinden)"), GroupName = "dock-server", IsChecked = App.Current.Settings.DockServer is null };
            busiest.Click += (_, _) => { App.Current.Settings.DockServer = null; App.Current.SaveSettings(); Refresh(); };
            menu.Items.Add(busiest);
            menu.Items.Add(new MenuFlyoutSeparator());
            foreach (var s in _monitor.Servers)
            {
                var item = new RadioMenuFlyoutItem { Text = s.Label, GroupName = "dock-server", IsChecked = App.Current.Settings.DockServer == s.HostId };
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

    // ---- dock mode: drop-down panels ----

    /// <summary>The button each panel opens from (rebuilt with the Dock).</summary>
    private readonly Dictionary<string, FrameworkElement> _anchors = [];

    /// <summary>The Dock is on screen (turned on).</summary>
    public bool IsOn => _on;

    /// <summary>The server the Dock shows (for the panels).</summary>
    public WatchedServer? SelectedServer() => Selected();

    /// <summary>Runs a button's action; an error is logged and told, never thrown.</summary>
    private static void Run(Action action)
    {
        try { action(); }
        catch (Exception e) { App.LogCrash(e); App.Current.Toast(L.F("Açılamadı: {0}", e.Message)); }
    }

    /// <summary>A panel under (beside) a Dock button; a second click of the button closes it.</summary>
    private void Panel(string kind, FrameworkElement from, string? arg = null) =>
        App.Current.ToggleDockPanel(kind, ScreenRect(from), PanelSide(), Selected, arg);

    /// <summary>Where the panel <paramref name="kind"/> opens from: its button, or the WECOMMANDER icon when that part is hidden.</summary>
    public (PixelRect Anchor, DockEdge Side) AnchorFor(string kind)
    {
        var from = kind == "server" && _meters.Length > 0 ? _meters[0].Root.Parent as FrameworkElement : null;
        from ??= _anchors.TryGetValue(kind, out var b) ? b : _appButton;
        return (ScreenRect(from), PanelSide());
    }

    /// <summary>The tray icon's left click in dock mode: the quick panel at the WECOMMANDER icon.</summary>
    public void OpenQuickPanelFromTray()
    {
        if (_appButton is { } app) OpenQuickPanel(app);
    }

    /// <summary>The WECOMMANDER icon, like the Start button: the start panel (server search, tiles, account, settings, exit).</summary>
    private void OpenQuickPanel(FrameworkElement from)
    {
        App.Current.CloseDockPanels();
        App.Current.ToggleQuickPanelFromDock(ScreenRect(from), PanelSide(), Selected);
    }

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

    // ---- moving the Dock like the Windows taskbar (unlocked only) ----

    private bool _moveDown, _moving, _moveStealing;
    private uint _movePointerId;
    private POINT _moveAt;
    private PointInt32 _moveGrab;
    private ButtonBase? _movePressed;
    private DockMode _moveFrom;
    private DockEdge? _moveEdge;
    private bool? _moveWasFloating;
    private MonitorSpec? _moveScreen;
    private (string Key, int Width, int Height) _moveFloatSize;

    /// <summary>
    /// A left press anywhere on the Dock but a module button (those keep their
    /// reorder drag): the app icon, the server picker, the meters, the background.
    /// Nothing happens yet; a plain click stays the button's click.
    /// </summary>
    private void OnRootPressed(object sender, PointerRoutedEventArgs e)
    {
        try
        {
            if (!_on || _moveDown || _moving || _reordering || App.Current.Settings.DockLocked) return;
            if (!e.GetCurrentPoint(_root).Properties.IsLeftButtonPressed) return;
            if (InModule(e.OriginalSource as DependencyObject, out var pressed)) return;
            _moveDown = true;
            _movePressed = pressed;
            _movePointerId = e.Pointer.PointerId;
            GetCursorPos(out _moveAt);
            _moveGrab = new PointInt32(_moveAt.X - AppWindow.Position.X, _moveAt.Y - AppWindow.Position.Y);
        }
        catch (Exception ex) { App.LogCrash(ex); _moveDown = false; }
    }

    /// <summary>Whether <paramref name="source"/> is inside a module button's holder; also the button it is in, if any.</summary>
    private bool InModule(DependencyObject? source, out ButtonBase? button)
    {
        button = null;
        for (var e = source; e is not null && !ReferenceEquals(e, _root); e = VisualTreeHelper.GetParent(e))
        {
            if (button is null && e is ButtonBase b) button = b;
            foreach (var m in _moduleItems)
                if (ReferenceEquals(m.Item, e)) return true;
        }
        return false;
    }

    private void OnRootMoved(object sender, PointerRoutedEventArgs e)
    {
        if (!_moveDown || e.Pointer.PointerId != _movePointerId) return;
        try
        {
            if (!e.GetCurrentPoint(_root).Properties.IsLeftButtonPressed)
            {
                // The release was missed (it happened elsewhere).
                if (_moving) CancelMove("button up"); else _moveDown = false;
                return;
            }
            GetCursorPos(out var now);
            if (!_moving)
            {
                var threshold = Math.Max(4, (int)Math.Round(6 * Scale));
                if (Math.Abs(now.X - _moveAt.X) < threshold && Math.Abs(now.Y - _moveAt.Y) < threshold) return;
                StartMove(e.Pointer);
            }
            if ((GetAsyncKeyState(0x1B /* VK_ESCAPE */) & 0x8000) != 0) { CancelMove("escape"); e.Handled = true; return; }
            FollowMove(now);
            e.Handled = true;
        }
        catch (Exception ex) { App.LogCrash(ex); CancelMove("error"); }
    }

    private void StartMove(Pointer pointer)
    {
        _moving = true;
        _moveFrom = _mode;
        _moveEdge = null;
        _moveWasFloating = null;
        _moveScreen = _screen;
        _moveFloatSize = ("", 0, 0);
        // The old place is left at once (the work area grows back), as the taskbar does.
        _fast.Stop();
        _reapply.Stop();
        _bar.Remove();
        _moveStealing = true;
        try
        {
            // The pressed button lets go of the pointer (so its click does not fire); the Dock takes it.
            _movePressed?.ReleasePointerCaptures();
            if (!_root.CapturePointer(pointer)) App.DebugLayout("dock: move could not capture the pointer");
        }
        finally { _moveStealing = false; }
        SetTopMost(true);
        App.DebugLayout($"dock: move started at {_moveAt.X},{_moveAt.Y} from {_mode} {_edge}");
    }

    /// <summary>
    /// Live preview: near an edge of the monitor under the pointer, the Dock lies
    /// along that edge (as it will once dropped); elsewhere it floats under the
    /// pointer, held where it was grabbed.
    /// </summary>
    private void FollowMove(POINT now)
    {
        var screen = Monitors.All().FirstOrDefault(m => m.Bounds.Contains(now.X, now.Y)) ?? _moveScreen ?? _screen;
        var edge = DockLayout.DragTarget(now.X, now.Y, screen.Bounds, (int)Math.Round(72 * screen.Scale));
        _moveScreen = screen;
        _moveEdge = edge;
        _screen = screen;
        // Floating, it is a row.
        _edge = edge ?? (DockLayout.IsHorizontal(_edge) ? _edge : DockEdge.Top);
        var horizontal = DockLayout.IsHorizontal(_edge);
        if (horizontal != _horizontal)
        {
            // Build only replaces _root's children: the pointer captured by _root stays captured.
            _horizontal = horizontal;
            Build();
            Refresh();
            _moveFloatSize = ("", 0, 0);
        }
        _thickness = (int)Math.Round(DockLayout.ThicknessDip(_edge, _compact) * screen.Scale);
        var floating = edge is null;
        if (_moveWasFloating != floating)
        {
            _moveWasFloating = floating;
            Rounded(floating);
        }
        if (edge is { } at)
        {
            Place(DockLayout.Strip(screen.Work, at, _thickness));
            return;
        }
        var key = $"{screen.Dpi}|{_horizontal}";
        if (_moveFloatSize.Key != key)
        {
            var (w, h) = FloatingSize(screen.Scale);
            _moveFloatSize = (key, w, h);
        }
        var (_, width, height) = _moveFloatSize;
        // Held where it was grabbed (inside it, when it was a longer strip before).
        var gx = Math.Clamp(_moveGrab.X, 0, Math.Max(0, width - 1));
        var gy = Math.Clamp(_moveGrab.Y, 0, Math.Max(0, height - 1));
        Place(new PixelRect(now.X - gx, now.Y - gy, width, height));
    }

    private void OnRootReleased(object sender, PointerRoutedEventArgs e)
    {
        if (!_moveDown || e.Pointer.PointerId != _movePointerId) return;
        _moveDown = false;
        if (!_moving) return; // a plain click: the button handles it
        e.Handled = true;
        _moving = false;
        try { _root.ReleasePointerCapture(e.Pointer); } catch (Exception) { }
        try { DropMove(); }
        catch (Exception ex)
        {
            App.LogCrash(ex);
            try { _lastApplied = null; Apply(); } catch (Exception again) { App.LogCrash(again); }
        }
    }

    /// <summary>Dropped: near an edge it is fixed there (an auto-hide Dock stays auto-hide), elsewhere it floats where it was left.</summary>
    private void DropMove()
    {
        GetCursorPos(out var now);
        FollowMove(now);
        var s = App.Current.Settings;
        var screen = _moveScreen ?? _screen;
        s.DockMonitor = screen.Device;
        if (_moveEdge is { } edge)
        {
            s.DockModeName = DockLayout.Name(_moveFrom == DockMode.AutoHide ? DockMode.AutoHide : DockMode.Fixed);
            s.DockEdgeName = DockLayout.Name(edge);
            App.DebugLayout($"dock: dropped at edge {edge} on {screen.Device}");
        }
        else
        {
            var rect = DockLayout.Clamp(new PixelRect(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height), screen.Work);
            s.DockModeName = DockLayout.Name(DockMode.Floating);
            // The preview floated as a row: a side edge saved before would make it a column again.
            if (!DockLayout.IsHorizontal(DockLayout.ParseEdge(s.DockEdgeName))) s.DockEdgeName = DockLayout.Name(DockEdge.Top);
            s.DockFloatX = (int)Math.Round((rect.X - screen.Work.X) / screen.Scale);
            s.DockFloatY = (int)Math.Round((rect.Y - screen.Work.Y) / screen.Scale);
            App.DebugLayout($"dock: dropped floating at {rect.X},{rect.Y} on {screen.Device}");
        }
        App.Current.SaveSettings();
        _lastApplied = null;
        Apply();
    }

    private void OnRootCaptureLost(object sender, PointerRoutedEventArgs e)
    {
        if (!_moving || _moveStealing || e.Pointer.PointerId != _movePointerId) return;
        // A child's capture going away bubbles here too: only the Dock's own counts.
        if (_root.PointerCaptures?.Any(p => p.PointerId == _movePointerId) == true) return;
        CancelMove("capture lost");
    }

    /// <summary>Esc, a lost pointer or an error mid-drag: the Dock goes back to its saved place.</summary>
    private void CancelMove(string why)
    {
        var was = _moving;
        _moveDown = false;
        _moving = false;
        if (!was) return;
        try { _root.ReleasePointerCaptures(); } catch (Exception) { }
        App.DebugLayout($"dock: move cancelled ({why})");
        try { _lastApplied = null; Apply(); } catch (Exception ex) { App.LogCrash(ex); }
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
        if (_reordering || _moving || sender is not FrameworkElement holder) return;
        // Locked (like the Windows taskbar): the order does not change by dragging (Alt + arrows still works).
        if (App.Current.Settings.DockLocked) return;
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
        // A choice that moves or resizes the Dock runs once the menu has closed: moving the
        // window (an AppBar) under the open menu left its submenu stranded on the screen.
        void Later(Action change)
        {
            menu.Hide();
            DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, () =>
            {
                try { change(); App.Current.SaveSettings(); Apply(); }
                catch (Exception ex) { App.LogCrash(ex); }
            });
        }
        menu.Opening += (_, _) =>
        {
            var s = App.Current.Settings;
            menu.Items.Clear();
            // Mutually exclusive choices are radio items in a group (a toggle item checks itself on every click).
            var mode = new MenuFlyoutSubItem { Text = L.T("Görünüm"), Icon = new FontIcon { Glyph = "" } };
            foreach (var (m, text) in new[] { (DockMode.Fixed, L.T("Sabit")), (DockMode.AutoHide, L.T("Otomatik gizlenen")), (DockMode.Floating, L.T("Yüzen")) })
            {
                var item = new RadioMenuFlyoutItem { Text = text, GroupName = "dock-mode", IsChecked = DockLayout.ParseMode(s.DockModeName) == m };
                item.Click += (_, _) => Later(() => s.DockModeName = DockLayout.Name(m));
                mode.Items.Add(item);
            }
            menu.Items.Add(mode);
            var edge = new MenuFlyoutSubItem { Text = L.T("Konum"), Icon = new FontIcon { Glyph = "" } };
            foreach (var (e, text) in new[] { (DockEdge.Top, L.T("Üst")), (DockEdge.Bottom, L.T("Alt")), (DockEdge.Left, L.T("Sol")), (DockEdge.Right, L.T("Sağ")) })
            {
                var item = new RadioMenuFlyoutItem { Text = text, GroupName = "dock-edge", IsChecked = DockLayout.ParseEdge(s.DockEdgeName) == e };
                item.Click += (_, _) => Later(() => s.DockEdgeName = DockLayout.Name(e));
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
                    var item = new RadioMenuFlyoutItem { GroupName = "dock-screen", Text = $"Ekran {number}{(m.Primary ? " (ana)" : "")} · {m.Bounds.Width}×{m.Bounds.Height}", IsChecked = m.Device == _screen.Device };
                    var device = m.Device;
                    item.Click += (_, _) => Later(() => { s.DockMonitor = device; s.DockFloatX = null; s.DockFloatY = null; });
                    screen.Items.Add(item);
                }
                menu.Items.Add(screen);
            }
            var compact = new ToggleMenuFlyoutItem { Text = L.T("Kompakt"), IsChecked = s.DockCompact };
            compact.Click += (_, _) => { var on = compact.IsChecked; Later(() => s.DockCompact = on); };
            menu.Items.Add(compact);
            if (DockLayout.ParseMode(s.DockModeName) == DockMode.Floating)
            {
                var onTop = new ToggleMenuFlyoutItem { Text = L.T("Her zaman üstte"), IsChecked = s.DockOnTop };
                onTop.Click += (_, _) => { var on = onTop.IsChecked; Later(() => s.DockOnTop = on); };
                menu.Items.Add(onTop);
            }
            var fullscreen = new ToggleMenuFlyoutItem { Text = L.T("Tam ekran uygulamalarda gizle"), IsChecked = s.DockHideFullscreen };
            fullscreen.Click += (_, _) => { s.DockHideFullscreen = fullscreen.IsChecked; App.Current.SaveSettings(); };
            menu.Items.Add(fullscreen);
            // Like the Windows taskbar: locked, it is not moved and its buttons keep their order.
            var locked = new ToggleMenuFlyoutItem { Text = L.T("Dock'u kilitle"), IsChecked = s.DockLocked };
            locked.Click += (_, _) => { s.DockLocked = locked.IsChecked; App.Current.SaveSettings(); };
            menu.Items.Add(locked);
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
                // Hidden after the menu has closed (the same reason as Later).
                menu.Hide();
                DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, () =>
                {
                    try
                    {
                        App.Current.SetDock(false);
                        App.Current.Toast(L.T("Dock kapandı ve ekran alanı geri verildi. Yeniden açmak için: Ayarlar → Dock."));
                    }
                    catch (Exception ex) { App.LogCrash(ex); }
                });
            };
            menu.Items.Add(off);
        };
        return menu;
    }
}
