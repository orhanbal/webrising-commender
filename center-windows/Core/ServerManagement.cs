namespace Wecommander.Center.Core;

// Server management (server.* in the core): what a server's overview, disk,
// cleanup and process screens show. Sizes are in KB unless named Bytes.

public sealed record ServerDisk(string Device, string FsType, string Mount, ulong SizeKb, ulong UsedKb, ulong AvailKb)
{
    public double UsedPercent => SizeKb == 0 ? 0 : Math.Round(UsedKb * 100.0 / (UsedKb + AvailKb == 0 ? SizeKb : UsedKb + AvailKb), 1);
}

public sealed record ServerOverview(
    string Hostname, string Os, string Kernel, ulong UptimeSecs, double[] Load, uint Cpus, double CpuPercent,
    ulong MemTotalKb, ulong MemAvailableKb, ulong SwapTotalKb, ulong SwapFreeKb, List<ServerDisk> Disks,
    bool RebootRequired, string Updates, uint Processes, uint Zombies, string Privilege, bool Docker)
{
    public bool CanChange => Privilege is "root" or "sudo";
}

public sealed record UsageEntry(string Path, ulong Kb);
public sealed record DockerUsage(string Kind, string Count, ulong SizeBytes, ulong ReclaimableBytes);
public sealed record DiskUsage(string Path, ulong TotalKb, List<UsageEntry> Entries, List<DockerUsage> Docker, bool Complete);

public sealed record CleanupItem(string Id, string Title, string Detail, ulong Kb, string Command, string Warning);
public sealed record CleanupScan(List<CleanupItem> Items, string Privilege, ServerDisk? Disk = null);
public sealed record CleanupResult(string Id, bool Ok, string Message);

public sealed record ServerProcess(uint Pid, uint Ppid, string User, string State, double Cpu, double Mem, ulong RssKb, ulong ElapsedSecs, string Name, string Command);
public sealed record ProcessOwner(string Kind, string Id, string Name);
public sealed record ZombieGroup(ServerProcess Parent, uint Count, ProcessOwner Owner, string Protected);
public sealed record ServerSample(double Uptime, ulong CpuTotal, ulong CpuIdle, ulong MemTotalKb, ulong MemAvailableKb, ulong SwapTotalKb, ulong SwapFreeKb,
    double Load1, ulong NetRxBytes, ulong NetTxBytes, ulong DiskReadBytes, ulong DiskWriteBytes,
    ulong RootUsedKb = 0, ulong RootAvailKb = 0, uint Zombies = 0);

/// <summary>What "Öneriyi uygula" did: applied, already, needs-token, compose, not-coolify.</summary>
public sealed record InitFix(string Status, string App, string Message);

public sealed record ProcessList(List<ServerProcess> Processes, List<ZombieGroup> Zombies, string Privilege);

public static class Sizes
{
    /// <summary>"118 GB", "512 MB", "3,4 KB" from KB.</summary>
    public static string Kb(ulong kb) => Bytes(kb * 1024);

    public static string Bytes(ulong bytes)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        double v = bytes;
        var i = 0;
        while (v >= 1024 && i < units.Length - 1) { v /= 1024; i++; }
        return (v >= 100 || i == 0 ? v.ToString("0") : v.ToString("0.#")) + " " + units[i];
    }

    /// <summary>"1,2 MB/sn" for a rate in bytes per second.</summary>
    public static string Rate(double bytesPerSecond) => Bytes((ulong)Math.Max(0, bytesPerSecond)) + "/sn";

    /// <summary>"42 gün 12 sa", "3 sa 5 dk", "40 sn".</summary>
    public static string Duration(ulong secs)
    {
        var d = secs / 86400; var h = secs % 86400 / 3600; var m = secs % 3600 / 60;
        if (d > 0) return $"{d} gün {h} sa";
        if (h > 0) return $"{h} sa {m} dk";
        if (m > 0) return $"{m} dk";
        return $"{secs} sn";
    }
}
