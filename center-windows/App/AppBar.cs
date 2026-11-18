using System.Runtime.InteropServices;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>One monitor: its device name, full bounds, work area (without the taskbar and other AppBars) and DPI.</summary>
public sealed record MonitorSpec(string Device, PixelRect Bounds, PixelRect Work, bool Primary, uint Dpi)
{
    public double Scale => Dpi / 96.0;
}

/// <summary>The monitors as Windows lists them (EnumDisplayMonitors).</summary>
public static class Monitors
{
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    private delegate bool MonitorEnumProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
    [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);

    private static PixelRect Rect(RECT r) => PixelRect.FromEdges(r.Left, r.Top, r.Right, r.Bottom);

    public static List<MonitorSpec> All()
    {
        var list = new List<MonitorSpec>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (h, _, _, _) =>
        {
            var info = new MONITORINFOEX { cbSize = Marshal.SizeOf<MONITORINFOEX>() };
            if (!GetMonitorInfo(h, ref info)) return true;
            uint dpi = 96;
            try { if (GetDpiForMonitor(h, 0 /* MDT_EFFECTIVE_DPI */, out var x, out _) == 0 && x > 0) dpi = x; } catch (Exception) { }
            list.Add(new MonitorSpec(info.szDevice, Rect(info.rcMonitor), Rect(info.rcWork), (info.dwFlags & 1) != 0, dpi));
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /// <summary>The monitor saved in the settings; gone (unplugged) or none: the primary one.</summary>
    public static MonitorSpec Pick(string? device)
    {
        var all = All();
        return all.FirstOrDefault(m => device is not null && m.Device == device)
            ?? all.FirstOrDefault(m => m.Primary)
            ?? all.FirstOrDefault()
            ?? new MonitorSpec("", new PixelRect(0, 0, 1920, 1080), new PixelRect(0, 0, 1920, 1040), true, 96);
    }
}

/// <summary>
/// The Windows AppBar registration (SHAppBarMessage) for one window: a fixed
/// bar takes its strip from the work area, an auto-hide bar registers for its
/// edge. Only documented shell messages; nothing is injected into Explorer.
/// </summary>
public sealed class AppBar
{
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct APPBARDATA
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uCallbackMessage;
        public uint uEdge;
        public RECT rc;
        public IntPtr lParam;
    }

    [DllImport("shell32.dll")] private static extern UIntPtr SHAppBarMessage(uint message, ref APPBARDATA data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessage(string name);

    private const uint AbmNew = 0, AbmRemove = 1, AbmQueryPos = 2, AbmSetPos = 3, AbmActivate = 6, AbmWindowPosChanged = 9, AbmGetAutoHideBarEx = 11, AbmSetAutoHideBarEx = 12;
    public const int AbnStateChange = 0, AbnPosChanged = 1, AbnFullScreenApp = 2, AbnWindowArrange = 3;

    private readonly IntPtr _hwnd;

    /// <summary>The message the shell sends us its notifications with.</summary>
    public uint CallbackMessage { get; } = RegisterWindowMessage("WECOMMANDER_DOCK_APPBAR");
    /// <summary>Broadcast when Explorer (re)starts: every AppBar registers again.</summary>
    public static uint TaskbarCreated { get; } = RegisterWindowMessage("TaskbarCreated");

    public bool Registered { get; private set; }
    public bool AutoHideRegistered { get; private set; }
    private DockEdge _autoHideEdge;
    private PixelRect _autoHideMonitor;

    public AppBar(IntPtr hwnd) => _hwnd = hwnd;

    private APPBARDATA Data() => new() { cbSize = (uint)Marshal.SizeOf<APPBARDATA>(), hWnd = _hwnd };

    private static uint Abe(DockEdge edge) => edge switch
    {
        DockEdge.Left => 0,
        DockEdge.Top => 1,
        DockEdge.Right => 2,
        _ => 3,
    };

    private static RECT ToRect(PixelRect r) => new() { Left = r.X, Top = r.Y, Right = r.Right, Bottom = r.Bottom };

    /// <summary>ABM_NEW (once).</summary>
    public bool Register()
    {
        if (Registered) return true;
        var d = Data();
        d.uCallbackMessage = CallbackMessage;
        Registered = SHAppBarMessage(AbmNew, ref d) != UIntPtr.Zero;
        App.DebugLayout($"dock: appbar register {(Registered ? "ok" : "refused")}");
        return Registered;
    }

    /// <summary>
    /// ABM_QUERYPOS + ABM_SETPOS: proposes the whole edge of <paramref name="monitor"/>,
    /// lets the shell move it off other AppBars (the taskbar), and reserves the
    /// strip; returns where the window must go.
    /// </summary>
    public PixelRect Reserve(PixelRect monitor, DockEdge edge, int thickness) =>
        // The work area changes: Explorer lays the desktop icons out again (and may push them
        // onto another monitor). They are put back where they were, off the Dock's strip.
        DesktopIcons.Keep(() => ReserveNow(monitor, edge, thickness), strip => strip, edge);

    private PixelRect ReserveNow(PixelRect monitor, DockEdge edge, int thickness)
    {
        var d = Data();
        d.uEdge = Abe(edge);
        d.rc = ToRect(monitor);
        SHAppBarMessage(AbmQueryPos, ref d);
        var proposed = PixelRect.FromEdges(d.rc.Left, d.rc.Top, d.rc.Right, d.rc.Bottom);
        var want = DockLayout.AfterQuery(proposed, edge, thickness);
        d.rc = ToRect(want);
        SHAppBarMessage(AbmSetPos, ref d);
        var final = PixelRect.FromEdges(d.rc.Left, d.rc.Top, d.rc.Right, d.rc.Bottom);
        // SETPOS may trim it again; keep our thickness from the edge it left.
        final = DockLayout.AfterQuery(final, edge, thickness);
        App.DebugLayout($"dock: appbar reserve {edge} {final.X},{final.Y} {final.Width}x{final.Height}");
        return final;
    }

    /// <summary>
    /// ABM_SETAUTOHIDEBAREX for this edge of this monitor. Windows allows one
    /// auto-hide bar per edge: false when another one (the taskbar set to
    /// auto-hide, another tool) already has it.
    /// </summary>
    public bool SetAutoHide(bool on, PixelRect monitor, DockEdge edge)
    {
        var d = Data();
        d.uEdge = Abe(edge);
        d.rc = ToRect(monitor);
        if (on)
        {
            var other = Data();
            other.uEdge = d.uEdge;
            other.rc = d.rc;
            var holder = (IntPtr)(long)(ulong)SHAppBarMessage(AbmGetAutoHideBarEx, ref other);
            if (holder != IntPtr.Zero && holder != _hwnd)
            {
                App.DebugLayout($"dock: autohide {edge} taken by another bar");
                return false;
            }
        }
        d.lParam = on ? new IntPtr(1) : IntPtr.Zero;
        var ok = SHAppBarMessage(AbmSetAutoHideBarEx, ref d) != UIntPtr.Zero;
        if (on && ok) { AutoHideRegistered = true; _autoHideEdge = edge; _autoHideMonitor = monitor; }
        if (!on) AutoHideRegistered = false;
        App.DebugLayout($"dock: autohide {edge} {(on ? "on" : "off")} {(ok ? "ok" : "refused")}");
        return ok;
    }

    public void Activated()
    {
        if (!Registered) return;
        var d = Data();
        SHAppBarMessage(AbmActivate, ref d);
    }

    public void WindowPosChanged()
    {
        if (!Registered) return;
        var d = Data();
        SHAppBarMessage(AbmWindowPosChanged, ref d);
    }

    /// <summary>ABM_REMOVE: gives the work area back (the Dock was closed, the mode changed, the app quits).</summary>
    public void Remove()
    {
        try
        {
            if (AutoHideRegistered) SetAutoHide(false, _autoHideMonitor, _autoHideEdge);
            if (!Registered) return;
            var d = Data();
            DesktopIcons.Keep(() => SHAppBarMessage(AbmRemove, ref d), _ => null, DockEdge.Top);
            Registered = false;
            App.DebugLayout("dock: appbar removed");
        }
        catch (Exception e) { App.LogCrash(e); }
    }

    /// <summary>Explorer restarted: the shell forgot every AppBar.</summary>
    public void Forget()
    {
        Registered = false;
        AutoHideRegistered = false;
    }
}
