using Microsoft.UI.Dispatching;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>One watched server: its connection and the latest numbers.</summary>
public sealed class WatchedServer(string hostId)
{
    public string HostId { get; } = hostId;
    public string Label { get; set; } = "";
    public string? MonitorId { get; set; }
    public ServerSample? Last { get; set; }
    /// <summary>Samples so far (charts add a column per new one).</summary>
    public int Samples { get; set; }
    public double Cpu { get; set; }
    public double Mem { get; set; }
    public double Swap { get; set; }
    public double Disk { get; set; }
    public double Rx { get; set; }
    public double Tx { get; set; }
    public double Read { get; set; }
    public double Write { get; set; }
    public string? Error { get; set; }
    public DateTime NextTry { get; set; }
    public bool Busy { get; set; }
    public bool Live => MonitorId is not null && Last is not null && Error is null;
    /// <summary>The worst of CPU, memory and disk (colour of the icon).</summary>
    public double Worst => Math.Max(Cpu, Math.Max(Mem, Disk));
}

/// <summary>
/// Watches the servers chosen for the taskbar: a connection each (no
/// terminal), a sample every three seconds, reconnecting when one drops.
/// </summary>
public sealed class ServerMonitor
{
    private readonly ServersController _c;
    private readonly DispatcherQueue _ui;
    private readonly DispatcherQueueTimer _timer;

    public List<WatchedServer> Servers { get; } = [];
    /// <summary>New numbers or a change in the list (UI thread).</summary>
    public event Action? Changed;

    public ServerMonitor(ServersController controller, DispatcherQueue ui)
    {
        _c = controller;
        _ui = ui;
        _timer = ui.CreateTimer();
        _timer.Interval = TimeSpan.FromSeconds(3);
        _timer.Tick += (_, _) => _ = Tick();
        _c.Changed += () => _ui.TryEnqueue(RefreshLabels);
    }

    public void Start()
    {
        foreach (var id in App.Current.Settings.WatchedHosts.Distinct())
            Servers.Add(new WatchedServer(id));
        RefreshLabels();
        if (Servers.Count > 0) _timer.Start();
        _ = Tick();
    }

    public bool IsWatched(string hostId) => Servers.Any(s => s.HostId == hostId);

    public void Watch(CoreHost host)
    {
        if (IsWatched(host.Id)) return;
        Servers.Add(new WatchedServer(host.Id) { Label = host.Label });
        Save();
        // The watch must come back after each sign-in.
        if (Servers.Count == 1)
            try { LocalStore.AutostartEnabled = true; } catch (Exception) { }
        _timer.Start();
        Changed?.Invoke();
        _ = Tick();
    }

    public void Unwatch(string hostId)
    {
        foreach (var s in Servers.Where(s => s.HostId == hostId).ToList())
        {
            Close(s);
            Servers.Remove(s);
        }
        Save();
        if (Servers.Count == 0) _timer.Stop();
        Changed?.Invoke();
    }

    private void Save()
    {
        App.Current.Settings.WatchedHosts = Servers.Select(s => s.HostId).ToList();
        App.Current.SaveSettings();
    }

    private void RefreshLabels()
    {
        var gone = new List<WatchedServer>();
        foreach (var s in Servers)
        {
            var host = _c.Hosts.FirstOrDefault(h => h.Id == s.HostId);
            if (host is not null) s.Label = host.Label;
            else if (_c.Hosts.Count > 0) gone.Add(s); // deleted host: stop watching it
            else if (s.Label.Length == 0) s.Label = "Sunucu";
        }
        foreach (var s in gone) { Close(s); Servers.Remove(s); }
        if (gone.Count > 0) Save();
        Changed?.Invoke();
    }

    private void Close(WatchedServer s)
    {
        if (s.MonitorId is { } id) _ = _c.CloseMonitor(id);
        s.MonitorId = null;
        s.Last = null;
    }

    private async Task Tick()
    {
        foreach (var s in Servers.ToList())
        {
            if (s.Busy) continue;
            s.Busy = true;
            try { await Step(s); }
            finally { s.Busy = false; }
        }
        Changed?.Invoke();
    }

    private async Task Step(WatchedServer s)
    {
        if (s.MonitorId is null)
        {
            if (DateTime.UtcNow < s.NextTry) return;
            try
            {
                s.MonitorId = await _c.OpenMonitor(s.HostId);
                s.Error = null;
            }
            catch (Exception e)
            {
                s.Error = e.Message;
                s.NextTry = DateTime.UtcNow + TimeSpan.FromSeconds(30);
                return;
            }
        }
        try
        {
            var now = await _c.Server<ServerSample>("server.sample", new { sessionId = s.MonitorId });
            if (!Servers.Contains(s)) return; // unwatched meanwhile
            s.Mem = now.MemTotalKb == 0 ? 0 : (now.MemTotalKb - now.MemAvailableKb) * 100.0 / now.MemTotalKb;
            s.Swap = now.SwapTotalKb == 0 ? 0 : (now.SwapTotalKb - now.SwapFreeKb) * 100.0 / now.SwapTotalKb;
            s.Disk = now.RootUsedKb + now.RootAvailKb == 0 ? 0 : now.RootUsedKb * 100.0 / (now.RootUsedKb + now.RootAvailKb);
            if (s.Last is { } prev && now.Uptime > prev.Uptime)
            {
                var secs = now.Uptime - prev.Uptime;
                var total = (double)(now.CpuTotal - prev.CpuTotal);
                s.Cpu = total <= 0 ? 0 : (total - (now.CpuIdle - prev.CpuIdle)) * 100.0 / total;
                double Delta(ulong a, ulong b) => a >= b ? (a - b) / secs : 0;
                s.Rx = Delta(now.NetRxBytes, prev.NetRxBytes);
                s.Tx = Delta(now.NetTxBytes, prev.NetTxBytes);
                s.Read = Delta(now.DiskReadBytes, prev.DiskReadBytes);
                s.Write = Delta(now.DiskWriteBytes, prev.DiskWriteBytes);
                s.Samples++;
            }
            s.Last = now;
            s.Error = null;
        }
        catch (Exception e)
        {
            Close(s);
            s.Error = e.Message.Contains("yeniden bağlanılıyor") ? e.Message : "Bağlantı koptu; yeniden bağlanılıyor.";
            s.NextTry = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        }
    }
}
