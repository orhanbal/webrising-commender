using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using H.NotifyIcon;
using Microsoft.UI.Xaml.Controls;

namespace Wecommander.Center;

/// <summary>The taskbar server monitor: a live icon next to the clock and its panel.</summary>
public partial class App
{
    private ServerMonitor? _monitor;
    private MonitorFlyout? _monitorFlyout;
    private TaskbarIcon? _monitorTray;
    private Icon? _monitorIcon;
    private IntPtr _monitorIconHandle;

    public ServerMonitor Monitor => _monitor ??= new ServerMonitor(Servers, _ui!);

    /// <summary>Starts watching the saved servers (after the core started).</summary>
    private DeskChip? _deskChip;

    private void StartMonitor()
    {
        Monitor.Changed += UpdateMonitorTray;
        Monitor.Start();
        UpdateMonitorTray();
        // The server box at the bottom left (it shows itself once a server is watched).
        try { _deskChip = new DeskChip(Monitor); }
        catch (Exception e) { LogCrash(e); }
    }

    public void ToggleMonitorPanel()
    {
        _monitorFlyout ??= new MonitorFlyout(Monitor);
        _monitorFlyout.Toggle();
    }

    /// <summary>From the server box: the panel opens upward from it.</summary>
    public void ToggleMonitorPanelAt(Windows.Graphics.RectInt32 anchor)
    {
        _monitorFlyout ??= new MonitorFlyout(Monitor);
        _monitorFlyout.Toggle(anchor);
    }

    /// <summary>The server box on or off (its own menu, the tray menu).</summary>
    public void SetDeskChip(bool on)
    {
        Settings.DeskChip = on;
        SaveSettings();
        _deskChip?.Apply();
    }

    /// <summary>Server management for a watched server, on the monitor's own connection.</summary>
    public void OpenServerManagement(WatchedServer s)
    {
        if (s.MonitorId is not { } id)
        {
            Toast($"{s.Label}: bağlantı henüz kurulmadı; birkaç saniye sonra yeniden dene.");
            return;
        }
        new ServerWindow(Servers, id, s.Label).Bring();
    }

    public void OpenHostTerminal(string hostId)
    {
        ShowServers();
        _servers?.ConnectHost(hostId);
    }

    private void UpdateMonitorTray()
    {
        try { UpdateMonitorTrayNow(); }
        catch (ObjectDisposedException) { }
    }

    private void UpdateMonitorTrayNow()
    {
        var servers = Monitor.Servers;
        if (servers.Count == 0)
        {
            _monitorTray?.Dispose();
            _monitorTray = null;
            return;
        }
        if (_monitorTray is null)
        {
            _monitorTray = new TaskbarIcon
            {
                ToolTipText = "WECOMMANDER Sunucularım",
                NoLeftClickDelay = true,
                LeftClickCommand = new RelayCommand(ToggleMonitorPanel),
                ContextMenuMode = ContextMenuMode.PopupMenu,
                ContextFlyout = MonitorMenu(),
            };
            SetMonitorIcon(servers);
            _monitorTray.ForceCreate(enablesEfficiencyMode: false);
        }
        else SetMonitorIcon(servers);
        _monitorTray.ToolTipText = Trim(string.Join("\n", servers.Select(s =>
            s.Error is not null ? $"{s.Label}: {s.Error}"
            : !s.Live ? $"{s.Label}: bağlanıyor"
            : $"{s.Label}: işlemci %{s.Cpu:0} · bellek %{s.Mem:0} · disk %{s.Disk:0}")));
    }

    private MenuFlyout MonitorMenu()
    {
        var menu = new MenuFlyout();
        menu.Items.Add(new MenuFlyoutItem { Text = "Sunucularım panelini aç", Command = new RelayCommand(ToggleMonitorPanel) });
        menu.Items.Add(new MenuFlyoutItem { Text = "Sunucular penceresi", Command = new RelayCommand(ShowServers) });
        var chip = new ToggleMenuFlyoutItem { Text = "Masaüstü kutusunu göster (sol alt)", IsChecked = Settings.DeskChip };
        chip.Command = new RelayCommand(() => SetDeskChip(!Settings.DeskChip));
        menu.Opening += (_, _) => chip.IsChecked = Settings.DeskChip;
        menu.Items.Add(chip);
        return menu;
    }

    // The notification area cuts tooltips at 127 characters.
    private static string Trim(string text) => text.Length <= 120 ? text : text[..119] + "…";

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr handle);

    /// <summary>
    /// Draws the icon: three bars (CPU, memory, disk) of the busiest
    /// server, green / amber / red by how full each is; grey when no
    /// server answers.
    /// </summary>
    private void SetMonitorIcon(List<WatchedServer> servers)
    {
        var live = servers.Where(s => s.Live).ToList();
        var worst = live.OrderByDescending(s => s.Worst).FirstOrDefault();
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using (var bg = Rounded(new RectangleF(1, 1, 30, 30), 7))
            using (var fill = new LinearGradientBrush(new PointF(0, 0), new PointF(0, 32), Color.FromArgb(255, 0x33, 0x41, 0x55), Color.FromArgb(255, 0x0F, 0x17, 0x2A)))
                g.FillPath(fill, bg);
            var values = worst is null ? new double[] { 0, 0, 0 } : new[] { worst.Cpu, worst.Mem, worst.Disk };
            for (var i = 0; i < 3; i++)
            {
                var x = 6 + i * 7.5f;
                using (var track = new SolidBrush(Color.FromArgb(70, 255, 255, 255)))
                    g.FillRectangle(track, x, 6, 5, 20);
                var h = worst is null ? 0 : (float)Math.Max(3, Math.Clamp(values[i], 0, 100) / 100 * 20);
                var c = worst is null ? Color.Gray : Level(values[i]);
                using var bar = new LinearGradientBrush(new PointF(x, 26 - h), new PointF(x, 26), Lighter(c), c);
                g.FillRectangle(bar, x, 26 - h, 5, h);
            }
            if (servers.Any(s => s.Error is not null))
            {
                using var dot = new SolidBrush(live.Count == 0 ? Color.Gray : Color.FromArgb(255, 0xF5, 0x9E, 0x0B));
                g.FillEllipse(dot, 22, 1, 9, 9);
            }
        }
        var handle = bmp.GetHicon();
        var icon = Icon.FromHandle(handle);
        _monitorTray!.Icon = icon;
        _monitorIcon?.Dispose();
        if (_monitorIconHandle != IntPtr.Zero) DestroyIcon(_monitorIconHandle);
        _monitorIcon = icon;
        _monitorIconHandle = handle;
    }

    private static Color Level(double percent) =>
        percent >= 90 ? Color.FromArgb(255, 0xEF, 0x44, 0x44) : percent >= 80 ? Color.FromArgb(255, 0xF5, 0x9E, 0x0B) : Color.FromArgb(255, 0x10, 0xB9, 0x81);

    private static Color Lighter(Color c) => Color.FromArgb(255, Math.Min(255, c.R + 60), Math.Min(255, c.G + 60), Math.Min(255, c.B + 60));

    private static GraphicsPath Rounded(RectangleF r, float radius)
    {
        var p = new GraphicsPath();
        var d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    private void StopMonitor()
    {
        _monitorTray?.Dispose();
        if (_monitorIconHandle != IntPtr.Zero) DestroyIcon(_monitorIconHandle);
    }
}
