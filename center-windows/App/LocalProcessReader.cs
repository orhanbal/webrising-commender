using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Reads this computer's processes from Windows (Toolhelp snapshot plus what
/// each process lets a normal user read) and ends one when allowed. Protected
/// processes and a PID that now belongs to another process are refused.
/// </summary>
public static class LocalProcessReader
{
    private const uint SnapProcess = 0x2;
    private const uint QueryLimited = 0x1000;
    private const uint Terminate = 0x0001;
    private const uint Synchronize = 0x00100000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_MEMORY_COUNTERS_EX
    {
        public uint cb, PageFaultCount;
        public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
            QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage, PrivateUsage;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength, dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] private static extern bool K32GetProcessMemoryInfo(IntPtr h, ref PROCESS_MEMORY_COUNTERS_EX c, uint size);
    [DllImport("kernel32.dll")] private static extern bool GetProcessIoCounters(IntPtr h, out IO_COUNTERS c);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] private static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] private static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
    [DllImport("kernel32.dll")] private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX m);

    public static uint SelfPid { get; } = (uint)Environment.ProcessId;

    /// <summary>All processes now. What a process does not let us read stays zero or null.</summary>
    public static LocalSnapshot Read()
    {
        var list = new List<LocalProcessInfo>(300);
        var snap = CreateToolhelp32Snapshot(SnapProcess, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return new LocalSnapshot(DateTime.UtcNow, list);
        try
        {
            var e = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
            var ok = Process32FirstW(snap, ref e);
            while (ok)
            {
                list.Add(Describe(e));
                e.dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>();
                ok = Process32NextW(snap, ref e);
            }
        }
        finally { CloseHandle(snap); }
        return new LocalSnapshot(DateTime.UtcNow, list);
    }

    private static LocalProcessInfo Describe(PROCESSENTRY32W e)
    {
        var pid = e.th32ProcessID;
        var name = pid == 0 ? "System Idle Process" : e.szExeFile ?? "";
        _ = ProcessIdToSessionId(pid, out var session);
        ulong cpu = 0, ws = 0, priv = 0, read = 0, write = 0;
        string? path = null;
        DateTime? started = null;
        var h = pid == 0 ? IntPtr.Zero : OpenProcess(QueryLimited, false, pid);
        if (h != IntPtr.Zero)
        {
            try
            {
                if (GetProcessTimes(h, out var creation, out _, out var kernel, out var user))
                {
                    cpu = (ulong)(kernel + user);
                    if (creation > 0) started = DateTime.FromFileTimeUtc(creation);
                }
                var mem = new PROCESS_MEMORY_COUNTERS_EX { cb = (uint)Marshal.SizeOf<PROCESS_MEMORY_COUNTERS_EX>() };
                if (K32GetProcessMemoryInfo(h, ref mem, mem.cb))
                {
                    ws = (ulong)mem.WorkingSetSize;
                    priv = (ulong)mem.PrivateUsage;
                }
                if (GetProcessIoCounters(h, out var io)) { read = io.ReadBytes; write = io.WriteBytes; }
                var sb = new StringBuilder(1024);
                var size = (uint)sb.Capacity;
                if (QueryFullProcessImageNameW(h, 0, sb, ref size)) path = sb.ToString();
            }
            finally { CloseHandle(h); }
        }
        return new LocalProcessInfo(pid, e.th32ParentProcessID, name, e.cntThreads, session, cpu, ws, priv, read, write, path, started);
    }

    /// <summary>Whole-machine CPU counters (idle, total) for the usage line.</summary>
    public static (ulong Idle, ulong Total) CpuTimes()
    {
        if (!GetSystemTimes(out var idle, out var kernel, out var user)) return (0, 0);
        return ((ulong)idle, (ulong)(kernel + user)); // kernel time includes idle time
    }

    /// <summary>Physical memory: total and in use, in bytes.</summary>
    public static (ulong Total, ulong Used) Memory()
    {
        var m = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        return GlobalMemoryStatusEx(ref m) ? (m.ullTotalPhys, m.ullTotalPhys - m.ullAvailPhys) : (0, 0);
    }

    /// <summary>
    /// Ends the process of <paramref name="row"/>. Refused for protected processes and
    /// when the PID now belongs to another process; null on success, else why not.
    /// </summary>
    public static string? End(LocalProcessRow row)
    {
        if (row.Protected is { } reason) return reason;
        var h = OpenProcess(Terminate | QueryLimited | Synchronize, false, row.Pid);
        if (h == IntPtr.Zero)
        {
            var error = Marshal.GetLastWin32Error();
            return error == 5 ? L.T("Bu süreci sonlandırmak için yönetici izni gerekiyor.") : L.T("Süreç artık çalışmıyor.");
        }
        try
        {
            if (row.Info.Started is { } expected && GetProcessTimes(h, out var creation, out _, out _, out _)
                && creation > 0 && DateTime.FromFileTimeUtc(creation) != expected)
                return L.T("Bu PID artık başka bir sürecin; liste yenilendi, yeniden seç.");
            if (!TerminateProcess(h, 1))
            {
                var error = Marshal.GetLastWin32Error();
                return error == 5 ? L.T("Bu süreci sonlandırmak için yönetici izni gerekiyor.") : new System.ComponentModel.Win32Exception(error).Message;
            }
            _ = WaitForSingleObject(h, 3000);
            return null;
        }
        finally { CloseHandle(h); }
    }

    /// <summary>
    /// CI: proves the reader and the guards on the real machine. Starts a child,
    /// finds it under this process, refuses lsass and this app, ends the child.
    /// Writes PASS/FAIL lines to <paramref name="logPath"/>; true when all pass.
    /// </summary>
    public static bool SelfTest(string logPath)
    {
        var lines = new List<string>();
        var ok = true;
        void Check(bool pass, string what) { lines.Add((pass ? "PASS " : "FAIL ") + what); ok &= pass; }
        Process? child = null;
        try
        {
            child = Process.Start(new ProcessStartInfo("ping.exe", "-n 120 127.0.0.1") { CreateNoWindow = true, UseShellExecute = false });
            Check(child is not null, "a child process starts");
            Thread.Sleep(500);
            var first = Read();
            Thread.Sleep(1500);
            var second = Read();
            var rows = LocalProcesses.Rows(first, second, Environment.ProcessorCount, SelfPid);
            Check(rows.Count >= 20, $"processes listed ({rows.Count})");
            var self = rows.FirstOrDefault(r => r.Pid == SelfPid);
            Check(self is not null && self.Info.WorkingSetBytes > 0 && self.Info.Path is not null, "this app is listed with its memory and path");
            Check(self is { CanEnd: false }, "this app is protected from itself");
            var ping = rows.FirstOrDefault(r => r.Pid == (uint)(child?.Id ?? 0));
            Check(ping is { CanEnd: true } && ping.Info.ParentPid == SelfPid, "the child is listed under this app and may be ended");
            var tree = LocalProcesses.Tree(rows, LocalProcesses.Order("name"), false);
            var selfAt = tree.FindIndex(t => t.Row.Pid == SelfPid);
            var pingAt = tree.FindIndex(t => t.Row.Pid == ping?.Pid);
            Check(selfAt >= 0 && pingAt > selfAt && tree[pingAt].Depth == tree[selfAt].Depth + 1, "the tree puts the child right under this app");
            Check(rows.Sum(r => r.Cpu) is >= 0 and <= 100.5, $"CPU shares add up to at most 100% ({rows.Sum(r => r.Cpu):0.0})");
            var lsass = rows.FirstOrDefault(r => r.Name.Equals("lsass.exe", StringComparison.OrdinalIgnoreCase));
            Check(lsass is { CanEnd: false } && End(lsass) == lsass.Protected, "lsass.exe is protected and End refuses it");
            Check(self is not null && End(self) is not null, "End refuses this app");
            var (total, used) = Memory();
            Check(total > 0 && used > 0 && used <= total, "machine memory is read");
            if (ping is not null)
            {
                var stale = ping with { Info = ping.Info with { Started = ping.Info.Started?.AddSeconds(-30) } };
                Check(End(stale) is not null && !child!.HasExited, "a PID that belongs to another process is not ended");
                Check(End(ping) is null && child!.WaitForExit(5000), "the child is ended");
            }
        }
        catch (Exception e)
        {
            Check(false, "self-test crashed: " + e.Message);
        }
        finally
        {
            try { if (child is { HasExited: false }) child.Kill(); } catch (Exception) { }
        }
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
            File.WriteAllLines(logPath, lines);
        }
        catch (Exception) { }
        return ok;
    }
}
