using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Dock mode: with the Dock on, its buttons open drop-down panels anchored to
/// it instead of windows (one panel at a time; a second click closes it).
/// Each panel hosts the same content as its window and can still open that
/// window ("Pencerede aç"). Classic mode keeps the windows.
/// </summary>
public partial class App
{
    private readonly Dictionary<string, DockPanel> _dockPanels = [];
    private Func<WatchedServer?> _dockSelected = () => null;
    private TaskManagerView? _taskManagerView;
    private DockTerminalView? _terminalView;
    private CenterPanel? _approvalsView;
    private TasksPanelView? _tasksView;
    private ServerManagementView? _serverView;
    private string _serverSection = "processes";
    private PixelRect _panelAnchor;
    private DockEdge _panelSide;

    /// <summary>Dock buttons open panels (the Dock is on and the app mode is "dock").</summary>
    public bool PanelsFromDock => AppModes.PanelsFromDock(Settings.Dock, Settings.AppMode) && _dock is not null;

    /// <summary>A Dock panel is on screen (an auto-hidden Dock stays out meanwhile).</summary>
    public bool DockPanelOpen => _dockPanels.Values.Any(p => p.IsOpen);

    /// <summary>Settings → app mode ("dock" or "classic"): saved; open panels close in classic mode.</summary>
    public void SetAppMode(string mode)
    {
        Settings.AppMode = AppModes.Parse(mode);
        SaveSettings();
        if (Settings.AppMode == AppModes.Classic) CloseDockPanels();
    }

    /// <summary>Every Dock panel closes (one opens, the quick panel opens, the language changes).</summary>
    public void CloseDockPanels(DockPanel? except = null)
    {
        foreach (var p in _dockPanels.Values)
        {
            if (ReferenceEquals(p, except)) continue;
            try { p.Hide(); } catch (Exception e) { LogCrash(e); }
        }
    }

    /// <summary>
    /// From a Dock button (or a quick panel tile): the panel <paramref name="kind"/>
    /// next to <paramref name="anchor"/>, toward <paramref name="side"/>.
    /// <paramref name="arg"/>: the tab ("scheduled", "windows", "server") or the server section.
    /// </summary>
    public void ToggleDockPanel(string kind, PixelRect anchor, DockEdge side, Func<WatchedServer?> selected, string? arg = null, bool toggle = true)
    {
        try
        {
            _dockSelected = selected;
            _panelAnchor = anchor;
            _panelSide = side;
            var panel = DockPanelFor(kind, arg, anchor, side);
            if (panel is null) return;
            CloseDockPanels(except: panel);
            if (_quickPanel?.AppWindow.IsVisible == true) _quickPanel.Hide();
            if (_monitorFlyout?.AppWindow.IsVisible == true) _monitorFlyout.Hide();
            panel.Open(anchor, side, toggle);
        }
        catch (Exception e) { LogCrash(e); ReportError(e); }
    }

    /// <summary>From the quick panel's tiles: the same panel, at its Dock button.</summary>
    public void OpenDockPanel(string kind, string? arg = null)
    {
        if (_dock is null) return;
        var (anchor, side) = _dock.AnchorFor(kind);
        ToggleDockPanel(kind, anchor, side, _dock.SelectedServer, arg, toggle: false);
    }

    /// <summary>Tray left click in dock mode: the quick panel at the Dock's icon (signed out: the sign-in panel).</summary>
    private void TrayClicked()
    {
        try
        {
            if (Token is not null && PanelsFromDock && _dock is { } dock && dock.IsOn)
            {
                dock.OpenQuickPanelFromTray();
                return;
            }
            _window?.TogglePanel();
        }
        catch (Exception e) { LogCrash(e); ReportError(e); }
    }

    /// <summary>Panels are built in the current language: a language change drops them.</summary>
    private void ForgetDockPanels()
    {
        CloseDockPanels();
        try { _terminalView?.Disconnect(); } catch (Exception) { }
        try { _serverView?.Stop(); } catch (Exception) { }
        foreach (var p in _dockPanels.Values)
        {
            try { p.Close(); } catch (Exception) { }
        }
        _dockPanels.Clear();
        _taskManagerView = null;
        _terminalView = null;
        _approvalsView = null;
        _tasksView = null;
        _serverView = null;
    }

    private DockPanel Panel(string kind, string title, Func<PixelRect, (int, int)> size, bool resizable = false)
    {
        if (_dockPanels.TryGetValue(kind, out var panel)) return panel;
        panel = new DockPanel(kind, title, size, resizable);
        _dockPanels[kind] = panel;
        return panel;
    }

    private static Func<PixelRect, (int, int)> Fixed(int width, int height) => _ => (width, height);

    /// <summary>The panel for <paramref name="kind"/>, made the first time and set up for this opening; null: nothing to show (handled).</summary>
    private DockPanel? DockPanelFor(string kind, string? arg, PixelRect anchor, DockEdge side)
    {
        switch (kind)
        {
            case "taskmanager":
            {
                var panel = Panel(kind, L.T("Görev Yöneticisi"), Fixed(940, 660));
                if (_taskManagerView is null)
                {
                    _taskManagerView = new TaskManagerView(showTitle: false);
                    var view = _taskManagerView;
                    panel.Body = view;
                    panel.Shown = view.Resume;
                    panel.Hidden = view.Pause;
                    panel.OpenInWindow = TaskManagerWindow.Open;
                }
                return panel;
            }
            case "tasks":
            {
                var panel = Panel(kind, L.T("Görevler"), Fixed(1000, 700));
                if (_tasksView is null)
                {
                    _tasksView = new TasksPanelView(Servers, () => _dockSelected());
                    var view = _tasksView;
                    panel.Body = view;
                    panel.Shown = view.Shown;
                    panel.Hidden = view.Hidden;
                    panel.OpenInWindow = view.OpenInWindow;
                    view.ServerPanelRequested = () => ToggleMonitorPanelFromDock(_panelAnchor, _panelSide);
                }
                _tasksView.Select(arg);
                return panel;
            }
            case "terminal":
            {
                Servers.Start();
                var panel = Panel(kind, "Terminal", work => DockLayout.PanelSize(work, 0.6, 0.5, 640, 400), resizable: true);
                if (_terminalView is null)
                {
                    _terminalView = new DockTerminalView(Servers);
                    var view = _terminalView;
                    panel.Body = view;
                    panel.FocusContent = true;
                    panel.Shown = () =>
                    {
                        // A terminal still open stays; otherwise the Dock's server (or the list).
                        if (view.Host is null) view.Show(_dockSelected()?.HostId);
                        else view.FocusTerminal();
                    };
                    panel.OpenInWindow = () =>
                    {
                        if (view.Host is { } host)
                        {
                            view.Disconnect();
                            OpenHostTerminal(host.Id);
                        }
                        else ShowTerminals(files: false);
                    };
                }
                return panel;
            }
            case "approvals":
            {
                var panel = Panel(kind, L.T("Bildirimler"), Fixed(420, 640));
                if (_approvalsView is null)
                {
                    // The same approvals UI as the tray panel and the main window's right side.
                    _approvalsView = new CenterPanel { ShowClose = false, Docked = true };
                    var view = _approvalsView;
                    view.CloseRequested += () => panel.Hide();
                    panel.Body = view;
                    panel.KeepOpen = () => view.DialogOpen;
                    panel.OpenInWindow = ShowApprovals;
                }
                var approvals = _approvalsView;
                panel.Shown = () => { approvals.SelectApprovals(); approvals.Refresh(); };
                return panel;
            }
            case "settings":
            {
                var panel = Panel(kind, L.T("Dock ayarları"), Fixed(540, 700));
                panel.OpenInWindow = ShowDockSettings;
                // Built again on every opening: it shows the settings as they are now.
                if (!panel.IsOpen) panel.Body = SettingsBody();
                return panel;
            }
            case "server":
            {
                var section = arg ?? "processes";
                if (_dockSelected() is not { } s)
                {
                    ToggleMonitorPanelFromDock(anchor, side);
                    return null;
                }
                if (s.MonitorId is not { } id)
                {
                    Toast(L.F("{0}: bağlantı henüz kurulmadı; birkaç saniye sonra yeniden dene.", s.Label));
                    return null;
                }
                var panel = Panel(kind, L.F("Sunucu yönetimi — {0}", s.Label), Fixed(1040, 740));
                if (_serverView is null || _serverView.SessionId != id)
                {
                    _serverView?.Stop();
                    _serverView = new ServerManagementView(Servers, id, s.Label);
                    panel.Body = _serverView;
                    panel.Heading = L.F("Sunucu yönetimi — {0}", s.Label);
                }
                var view = _serverView;
                _serverSection = section;
                panel.Shown = () => view.GoTo(_serverSection);
                panel.Hidden = view.Stop;
                panel.OpenInWindow = () => OpenServerManagement(s, _serverSection);
                if (panel.IsOpen) view.GoTo(section);
                return panel;
            }
        }
        return null;
    }

    /// <summary>The Dock settings and a link to every setting.</summary>
    private UIElement SettingsBody()
    {
        var body = new StackPanel { Spacing = 10, Padding = new Thickness(16, 4, 16, 16) };
        body.Children.Add(DockSettingsPanel.Build());
        var all = new HyperlinkButton { Content = L.T("Tüm ayarlar…") };
        all.Click += (_, _) =>
        {
            CloseDockPanels();
            try { ShowDockSettings(); } catch (Exception e) { LogCrash(e); ReportError(e); }
        };
        body.Children.Add(all);
        return new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    }
}
