using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>The WECOMMANDER Dock: on, off and what it opens.</summary>
public partial class App
{
    private DockWindow? _dock;

    /// <summary>The tutorial's status step on the Dock (a ring around its meters); false when there is no Dock.</summary>
    public bool DockTutorialRing(bool on)
    {
        if (_dock is null || !Settings.Dock) return false;
        _dock.TutorialRing(on);
        return true;
    }
    private QuickPanel? _quickPanel;
    private bool _dockExitHooked;

    /// <summary>Creates the Dock when it is turned on (it is off until the owner turns it on).</summary>
    private void StartDock()
    {
        if (!Settings.Dock) return;
        EnsureDock().Apply();
    }

    private DockWindow EnsureDock()
    {
        if (_dock is not null) return _dock;
        _dock = new DockWindow(Monitor);
        if (!_dockExitHooked)
        {
            _dockExitHooked = true;
            // However the process ends, the reserved strip goes back to Windows.
            AppDomain.CurrentDomain.ProcessExit += (_, _) => _dock?.RemoveAppBarOnExit();
        }
        return _dock;
    }

    /// <summary>The Dock on or off (settings page, its own menu); the server box steps aside while it is on.</summary>
    public void SetDock(bool on)
    {
        Settings.Dock = on;
        Settings.AppMode = AppModes.Of(on);
        SaveSettings();
        ApplyDock();
    }

    /// <summary>After a Dock setting changed.</summary>
    public void ApplyDock()
    {
        try
        {
            if (Settings.Dock) EnsureDock().Apply();
            else _dock?.Apply();
        }
        catch (Exception e) { LogCrash(e); ReportError(e); }
    }

    /// <summary>From the Dock: the panel opens next to the clicked button, away from the edge.</summary>
    public void ToggleMonitorPanelFromDock(PixelRect anchor, DockEdge side)
    {
        _monitorFlyout ??= new MonitorFlyout(Monitor);
        _monitorFlyout.ToggleFrom(anchor, side);
    }

    /// <summary>The panel is on screen (an auto-hidden Dock stays out meanwhile).</summary>
    public bool MonitorPanelOpen => _monitorFlyout?.AppWindow.IsVisible == true;

    /// <summary>From the Dock's WECOMMANDER icon: the quick panel, next to the icon and away from the Dock's edge.</summary>
    public void ToggleQuickPanelFromDock(PixelRect anchor, DockEdge side, Func<WatchedServer?> selected)
    {
        _quickPanel ??= new QuickPanel();
        _quickPanel.ToggleFrom(anchor, side, selected);
    }

    /// <summary>The quick panel is on screen (an auto-hidden Dock stays out meanwhile).</summary>
    public bool QuickPanelOpen => _quickPanel?.AppWindow.IsVisible == true;

    /// <summary>The main window on its terminals page; with <paramref name="files"/> the current terminal's files open beside it.</summary>
    public void ShowTerminals(bool files)
    {
        ShowServers();
        _servers?.ShowTerminals(files);
    }

    /// <summary>Server management for a watched server, opened on one section (processes, disk, cleanup).</summary>
    public void OpenServerManagement(WatchedServer s, string section)
    {
        if (s.MonitorId is not { } id)
        {
            Toast(L.F("{0}: bağlantı henüz kurulmadı; birkaç saniye sonra yeniden dene.", s.Label));
            return;
        }
        var window = new ServerWindow(Servers, id, s.Label);
        window.GoTo(section);
        window.Bring();
    }

    /// <summary>The main window on its settings page, at the Dock section.</summary>
    public void ShowDockSettings()
    {
        ShowServers();
        _servers?.OpenSettings();
    }

    private void StopDock() => _dock?.Shutdown();

    /// <summary>
    /// Settings → Language: everything shown next is in the new language. The
    /// main window and the panel are built again now; with terminal tabs open
    /// the main window waits until the person agrees (closing it ends them).
    /// </summary>
    public void SetLanguage(string? code)
    {
        Settings.Language = code;
        SaveSettings();
        var before = L.Current;
        L.Use(L.Resolve(code));
        if (L.Current == before) return;
        try
        {
            _tray?.Dispose();
            BuildTray();
            UpdateServersMenu();
            UpdateTray();
        }
        catch (Exception e) { LogCrash(e); }
        try { _dock?.RebuildTexts(); } catch (Exception e) { LogCrash(e); }
        try { _monitorFlyout?.Retire(); } catch (Exception) { }
        _monitorFlyout = null;
        try { _quickPanel?.Retire(); } catch (Exception) { }
        _quickPanel = null;
        try { ForgetDockPanels(); } catch (Exception e) { LogCrash(e); }
        try
        {
            var oldPanel = _window;
            var wasVisible = oldPanel?.AppWindow.IsVisible == true;
            _window = new MainWindow();
            oldPanel?.Quit();
            if (wasVisible && _servers is null) _window.ShowPanel();
        }
        catch (Exception e) { LogCrash(e); }
        ReopenServersInLanguage(force: false);
    }

    /// <summary>Builds the main window again in the current language (with terminals open only when <paramref name="force"/>).</summary>
    public void ReopenServersInLanguage(bool force)
    {
        if (_servers is not { } old) return;
        if (old.HasTerminals && !force)
        {
            old.ShowLanguagePending();
            return;
        }
        try
        {
            _servers = null;
            old.CloseForLanguage();
            ShowServers();
            _servers?.OpenSettings();
        }
        catch (Exception e) { LogCrash(e); }
    }
}
