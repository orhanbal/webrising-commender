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
public sealed record DiskUsage(string Path, ulong TotalKb, List<UsageEntry> Entries, List<DockerUsage> Docker, bool Complete,
    List<DockerStore>? DockerStores = null);

/// <summary>A Docker daemon's storage folder (the system one, or a user's rootless one).</summary>
public sealed record DockerStore(string Id, string Kind, string Label, string User, string Socket, string RootDir, string Error);

/// <summary>
/// One Docker daemon on the server, as the cleanup reads it: what it stores,
/// what it frees, what it protects (running containers), or why it could not
/// be read (then its sizes are unknown, not zero).
/// </summary>
public sealed record DockerEnv(
    string Id, string Kind, string Label, string User, uint Uid, string Socket, string RootDir,
    ulong ImagesBytes, ulong ImagesReclaimableBytes, ulong BuildCacheBytes, ulong BuildCacheReclaimableBytes,
    ulong ContainersBytes, ulong VolumesBytes, ulong DanglingBytes,
    uint ImagesTotal, uint ImagesActive, uint ContainersTotal, uint ContainersRunning,
    List<string> Running, string Error)
{
    public ulong TotalBytes => ImagesBytes + BuildCacheBytes + ContainersBytes + VolumesBytes;
    /// <summary>The most a cleanup can free here: build cache plus unused images (dangling ones are part of those).</summary>
    public ulong ReclaimableBytes => BuildCacheReclaimableBytes + ImagesReclaimableBytes;
    public bool Rootless => Kind == "rootless";
}

/// <param name="Docker">The daemon this cleanup is for (system, u1000); empty for the rest.</param>
/// <param name="Group">Items of one group overlap: only one of them can be chosen.</param>
public sealed record CleanupItem(string Id, string Title, string Detail, ulong Kb, string Command, string Warning,
    string Docker = "", string Group = "");
public sealed record CleanupScan(List<CleanupItem> Items, string Privilege, ServerDisk? Disk = null, List<DockerEnv>? Dockers = null);

/// <summary>What the cleanup page shows: the server's own items, then each Docker daemon with its items.</summary>
public sealed record CleanupSection(DockerEnv? Docker, List<CleanupItem> Items);

public static class CleanupLayout
{
    /// <summary>The server's own items first, then every Docker daemon (system, then rootless ones), each with its own items; a daemon that could not be read has none and shows why.</summary>
    public static List<CleanupSection> Sections(CleanupScan scan)
    {
        var sections = new List<CleanupSection> { new(null, scan.Items.Where(i => string.IsNullOrEmpty(i.Docker)).OrderByDescending(i => i.Kb).ToList()) };
        var dockers = scan.Dockers ?? [];
        foreach (var env in dockers)
            sections.Add(new(env, scan.Items.Where(i => i.Docker == env.Id).ToList()));
        // An older core: Docker items without a daemon list stay with the rest.
        var known = dockers.Select(d => d.Id).ToHashSet();
        sections[0].Items.AddRange(scan.Items.Where(i => !string.IsNullOrEmpty(i.Docker) && !known.Contains(i.Docker)));
        return sections;
    }

    /// <summary>The daemon whose data is in (or is) <paramref name="path"/>, for the Disk page.</summary>
    public static DockerStore? StoreFor(string path, IEnumerable<DockerStore>? stores)
    {
        if (stores is null) return null;
        var p = path.TrimEnd('/');
        foreach (var s in stores.Where(s => !string.IsNullOrEmpty(s.RootDir)))
        {
            var root = s.RootDir.TrimEnd('/');
            if (root == p || root.StartsWith(p + "/", StringComparison.Ordinal) || p.StartsWith(root + "/", StringComparison.Ordinal))
                return s;
        }
        return null;
    }

    /// <summary>After a cleanup: the space really freed against the estimate, and why they can differ.</summary>
    public static string Freed(ulong estimateKb, ulong? beforeFreeKb, ulong? afterFreeKb)
    {
        if (beforeFreeKb is not { } before || afterFreeKb is not { } after) return "";
        var freed = after > before ? after - before : 0;
        var text = $"Diskte gerçekten {Sizes.Kb(freed)} yer açıldı (tahmin {Sizes.Kb(estimateKb)}).";
        var gap = Math.Abs((double)freed - estimateKb);
        if (estimateKb > 0 && gap > estimateKb * 0.15)
            text += " Fark normaldir: Docker paylaşılan katmanları ayrı sayar, başka bir diskteki depolama buradaki boş alanı değiştirmez ve bu sırada sunucuda yazılan dosyalar da boş alanı etkiler.";
        return text;
    }
}
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
