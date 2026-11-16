using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>The WECOMMANDER Dock: on, off and what it opens.</summary>
public partial class App
{
    private DockWindow? _dock;
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
        _deskChip?.Apply();
        UpdateMonitorTray();
    }

    /// <summary>From the Dock: the panel opens next to the clicked button, away from the edge.</summary>
    public void ToggleMonitorPanelFromDock(PixelRect anchor, DockEdge side)
    {
        _monitorFlyout ??= new MonitorFlyout(Monitor);
        _monitorFlyout.ToggleFrom(anchor, side);
    }

    /// <summary>The panel is on screen (an auto-hidden Dock stays out meanwhile).</summary>
    public bool MonitorPanelOpen => _monitorFlyout?.AppWindow.IsVisible == true;

    /// <summary>Server management for a watched server, opened on one section (processes, disk, cleanup).</summary>
    public void OpenServerManagement(WatchedServer s, string section)
    {
        if (s.MonitorId is not { } id)
        {
            Toast($"{s.Label}: bağlantı henüz kurulmadı; birkaç saniye sonra yeniden dene.");
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
}
