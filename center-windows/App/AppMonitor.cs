using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>The watched servers and their panel (opened from the Dock).</summary>
public partial class App
{
    private ServerMonitor? _monitor;
    private MonitorFlyout? _monitorFlyout;

    public ServerMonitor Monitor => _monitor ??= new ServerMonitor(Servers, _ui!);

    /// <summary>
    /// Starts watching the saved servers (after the core started). The live
    /// servers show in the Dock; the notification area keeps only the
    /// Management Center icon.
    /// </summary>
    private void StartMonitor()
    {
        Monitor.Start();
        try { StartDock(); }
        catch (Exception e) { LogCrash(e); }
    }

    public void ToggleMonitorPanel()
    {
        _monitorFlyout ??= new MonitorFlyout(Monitor);
        _monitorFlyout.Toggle();
    }

    /// <summary>Server management for a watched server, on the monitor's own connection.</summary>
    public void OpenServerManagement(WatchedServer s)
    {
        if (s.MonitorId is not { } id)
        {
            Toast(L.F("{0}: bağlantı henüz kurulmadı; birkaç saniye sonra yeniden dene.", s.Label));
            return;
        }
        new ServerWindow(Servers, id, s.Label).Bring();
    }

    public void OpenHostTerminal(string hostId)
    {
        ShowServers();
        _servers?.ConnectHost(hostId);
    }

    private void StopMonitor() => StopDock();
}
