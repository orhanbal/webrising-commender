namespace Wecommander.Center.Core;

// Task Manager for this computer: what Windows reports for each process,
// the numbers worked out between two readings, the process tree and the
// rules that keep critical processes out of reach. The Win32 reading itself
// is in the app (LocalProcessReader); everything here is plain and tested.

/// <summary>One process as read from Windows at one moment.</summary>
/// <param name="CpuTime">Kernel + user time in 100 ns units.</param>
/// <param name="Started">Creation time (UTC); null when Windows did not give it (protected processes).</param>
public sealed record LocalProcessInfo(
    uint Pid, uint ParentPid, string Name, uint Threads, uint Session,
    ulong CpuTime, ulong WorkingSetBytes, ulong PrivateBytes, ulong ReadBytes, ulong WriteBytes,
    string? Path, DateTime? Started);

/// <summary>A row of the Task Manager: the process and its rates since the previous reading.</summary>
public sealed record LocalProcessRow(LocalProcessInfo Info, double Cpu, double DiskBytesPerSecond, string? Protected)
{
    public uint Pid => Info.Pid;
    public string Name => Info.Name;
    public bool CanEnd => Protected is null;
}

/// <summary>A reading of all processes, with the machine totals.</summary>
public sealed record LocalSnapshot(DateTime At, IReadOnlyList<LocalProcessInfo> Processes);

public static class LocalProcesses
{
    /// <summary>Rows of <paramref name="now"/>: CPU percent of the whole machine and disk bytes per second since <paramref name="before"/>.</summary>
    public static List<LocalProcessRow> Rows(LocalSnapshot? before, LocalSnapshot now, int cpuCount, uint selfPid)
    {
        var seconds = before is null ? 0 : (now.At - before.At).TotalSeconds;
        var previous = new Dictionary<(uint, DateTime?), LocalProcessInfo>();
        if (before is not null)
            foreach (var p in before.Processes) previous[(p.Pid, p.Started)] = p;
        var rows = new List<LocalProcessRow>(now.Processes.Count);
        foreach (var p in now.Processes)
        {
            double cpu = 0, disk = 0;
            // The same process only: a reused PID has another creation time.
            if (seconds > 0 && previous.TryGetValue((p.Pid, p.Started), out var old))
            {
                var used = p.CpuTime >= old.CpuTime ? p.CpuTime - old.CpuTime : 0;
                cpu = Math.Clamp(used / (seconds * 10_000_000.0 * Math.Max(1, cpuCount)) * 100, 0, 100);
                var io = p.ReadBytes + p.WriteBytes;
                var oldIo = old.ReadBytes + old.WriteBytes;
                disk = io >= oldIo ? (io - oldIo) / seconds : 0;
            }
            rows.Add(new LocalProcessRow(p, Math.Round(cpu, 1), disk, ProtectedReason(p, selfPid)));
        }
        return rows;
    }

    // Windows itself: ending these stops or crashes the system or the session.
    private static readonly HashSet<string> WindowsCore = new(StringComparer.OrdinalIgnoreCase)
    {
        "system", "idle", "system idle process", "registry", "memory compression", "secure system",
        "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe", "lsaiso.exe",
        "svchost.exe", "dwm.exe", "fontdrvhost.exe", "sihost.exe", "ctfmon.exe", "explorer.exe",
        "msmpeng.exe", "nissrv.exe", "securityhealthservice.exe", "audiodg.exe", "spoolsv.exe", "wudfhost.exe",
        "taskhostw.exe", "runtimebroker.exe", "startmenuexperiencehost.exe", "searchhost.exe", "conhost.exe",
    };

    // Databases: ending one can lose or corrupt data.
    private static readonly HashSet<string> Databases = new(StringComparer.OrdinalIgnoreCase)
    {
        "sqlservr.exe", "postgres.exe", "pg_ctl.exe", "mysqld.exe", "mariadbd.exe", "mongod.exe",
        "redis-server.exe", "memurai.exe", "oracle.exe", "influxd.exe", "clickhouse-server.exe",
    };

    // WECOMMANDER itself: the app, its core, the agent and the connection to the server.
    private static readonly HashSet<string> Ours = new(StringComparer.OrdinalIgnoreCase)
    {
        "wecommandercenter.exe", "wecommander-core.exe", "webrising-commender.exe", "webrising-commender-agent.exe",
    };

    /// <summary>Why a process must not be ended from here, or null when it may be.</summary>
    public static string? ProtectedReason(LocalProcessInfo p, uint selfPid)
    {
        if (p.Pid is 0 or 4 || p.Session == 0 && p.Path is null)
            return L.T("Windows sistem süreci: sonlandırılamaz.");
        if (p.Pid == selfPid || Ours.Contains(p.Name))
            return L.T("WECOMMANDER'ın kendi süreci: bağlantı ve onaylar bunun üzerinden çalışır.");
        if (WindowsCore.Contains(p.Name))
            return L.T("Windows sistem süreci: sonlandırılırsa Windows kararsız kalabilir.");
        if (Databases.Contains(p.Name))
            return L.T("Veritabanı: sonlandırılırsa veri kaybolabilir. Servisini kendi aracıyla durdur.");
        return null;
    }

    /// <summary>
    /// The rows as a tree: each process under its parent (depth for the indent).
    /// A parent that started after its child is a reused PID, not the parent.
    /// </summary>
    public static List<(LocalProcessRow Row, int Depth)> Tree(IReadOnlyList<LocalProcessRow> rows, Func<LocalProcessRow, object> order, bool descending)
    {
        var byPid = rows.GroupBy(r => r.Pid).ToDictionary(g => g.Key, g => g.First());
        bool HasParent(LocalProcessRow r) =>
            r.Info.ParentPid != r.Pid && byPid.TryGetValue(r.Info.ParentPid, out var parent)
            && (parent.Info.Started is null || r.Info.Started is null || parent.Info.Started <= r.Info.Started);
        var children = rows.Where(HasParent).GroupBy(r => r.Info.ParentPid).ToDictionary(g => g.Key, g => g.ToList());
        IEnumerable<LocalProcessRow> Sorted(IEnumerable<LocalProcessRow> list) =>
            descending ? list.OrderByDescending(order).ThenBy(r => r.Pid) : list.OrderBy(order).ThenBy(r => r.Pid);
        var result = new List<(LocalProcessRow, int)>();
        var seen = new HashSet<uint>();
        void Add(LocalProcessRow r, int depth)
        {
            if (!seen.Add(r.Pid)) return; // a loop of reused PIDs
            result.Add((r, depth));
            if (children.TryGetValue(r.Pid, out var kids))
                foreach (var k in Sorted(kids)) Add(k, depth + 1);
        }
        foreach (var root in Sorted(rows.Where(r => !HasParent(r)))) Add(root, 0);
        foreach (var r in rows) if (!seen.Contains(r.Pid)) Add(r, 0);
        return result;
    }

    /// <summary>Rows whose name, PID or path contain <paramref name="filter"/>.</summary>
    public static IEnumerable<LocalProcessRow> Filter(IEnumerable<LocalProcessRow> rows, string filter)
    {
        var f = filter.Trim();
        if (f.Length == 0) return rows;
        return rows.Where(r => r.Name.Contains(f, StringComparison.OrdinalIgnoreCase)
            || r.Pid.ToString() == f
            || (r.Info.Path?.Contains(f, StringComparison.OrdinalIgnoreCase) ?? false));
    }

    /// <summary>Sort key of a column: cpu, memory, disk, name or pid.</summary>
    public static Func<LocalProcessRow, object> Order(string column) => column switch
    {
        "memory" => r => r.Info.WorkingSetBytes,
        "disk" => r => r.DiskBytesPerSecond,
        "name" => r => r.Name.ToLowerInvariant(),
        "pid" => r => r.Pid,
        _ => r => r.Cpu,
    };

    /// <summary>Name and PID sort up, the numbers down.</summary>
    public static bool Descending(string column) => column is not ("name" or "pid");
}
