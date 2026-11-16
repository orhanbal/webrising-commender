using Wecommander.Center.Core;
using Xunit;

public class LocalProcessesTests
{
    private static readonly DateTime T0 = new(2026, 11, 16, 12, 0, 0, DateTimeKind.Utc);

    private static LocalProcessInfo P(uint pid, uint ppid, string name, ulong cpu = 0, ulong io = 0, uint session = 1,
        string? path = @"C:\x.exe", DateTime? started = null) =>
        new(pid, ppid, name, 1, session, cpu, 100 * 1024 * 1024, 0, io, 0, path, started ?? T0);

    [Fact]
    public void CpuAndDiskComeFromTwoReadingsOfTheSameProcess()
    {
        var before = new LocalSnapshot(T0, [P(10, 1, "a.exe", cpu: 0, io: 0), P(11, 1, "b.exe", cpu: 0)]);
        // Two seconds, four CPUs: 4 s of CPU time is half the machine.
        var now = new LocalSnapshot(T0.AddSeconds(2), [P(10, 1, "a.exe", cpu: 40_000_000, io: 2_000_000),
            P(11, 1, "b.exe", cpu: 5_000_000, started: T0.AddSeconds(1))]);
        var rows = LocalProcesses.Rows(before, now, 4, 999);
        Assert.Equal(50, rows[0].Cpu);
        Assert.Equal(1_000_000, rows[0].DiskBytesPerSecond);
        // PID 11 was reused by another process: no rate from the old one.
        Assert.Equal(0, rows[1].Cpu);
        // The first reading has no rates.
        Assert.All(LocalProcesses.Rows(null, now, 4, 999), r => Assert.Equal(0, r.Cpu));
    }

    [Theory]
    [InlineData(4u, "System")]
    [InlineData(700u, "lsass.exe")]
    [InlineData(701u, "csrss.exe")]
    [InlineData(702u, "svchost.exe")]
    [InlineData(703u, "explorer.exe")]
    [InlineData(704u, "sqlservr.exe")]
    [InlineData(705u, "postgres.exe")]
    [InlineData(706u, "webrising-commender.exe")]
    [InlineData(707u, "wecommander-core.exe")]
    public void CriticalProcessesCannotBeEnded(uint pid, string name)
    {
        var row = LocalProcesses.Rows(null, new LocalSnapshot(T0, [P(pid, 1, name)]), 4, 999)[0];
        Assert.False(row.CanEnd);
        Assert.False(string.IsNullOrWhiteSpace(row.Protected));
    }

    [Fact]
    public void OrdinaryProcessesCanBeEndedButNotThisApp()
    {
        var rows = LocalProcesses.Rows(null, new LocalSnapshot(T0, [P(500, 1, "notepad.exe"), P(999, 1, "Anything.exe"),
            P(501, 1, "secret.exe", session: 0, path: null)]), 4, 999);
        Assert.True(rows[0].CanEnd);
        Assert.False(rows[1].CanEnd); // this app's own PID, whatever its name
        Assert.False(rows[2].CanEnd); // a service Windows does not even let us read
    }

    [Fact]
    public void TheTreeNestsChildrenAndIgnoresReusedParents()
    {
        var rows = LocalProcesses.Rows(null, new LocalSnapshot(T0, [
            P(1, 0, "root.exe"),
            P(2, 1, "child.exe", cpu: 5),
            P(3, 2, "grandchild.exe"),
            // Its "parent" 1 started later: the PID was reused, so it is a root.
            P(4, 1, "orphan.exe", started: T0.AddSeconds(-10)),
            P(5, 5, "self-parent.exe"),
        ]), 1, 999);
        var tree = LocalProcesses.Tree(rows, LocalProcesses.Order("name"), false);
        Assert.Equal(["orphan.exe", "root.exe", "child.exe", "grandchild.exe", "self-parent.exe"], tree.Select(t => t.Row.Name));
        Assert.Equal([0, 0, 1, 2, 0], tree.Select(t => t.Depth));
    }

    [Fact]
    public void FilterAndSort()
    {
        var rows = LocalProcesses.Rows(null, new LocalSnapshot(T0, [P(10, 1, "Code.exe", path: @"C:\Apps\Code.exe"), P(20, 1, "node.exe")]), 1, 999);
        Assert.Single(LocalProcesses.Filter(rows, "apps"));
        Assert.Single(LocalProcesses.Filter(rows, "20"));
        Assert.Equal(2, LocalProcesses.Filter(rows, " ").Count());
        Assert.True(LocalProcesses.Descending("cpu"));
        Assert.False(LocalProcesses.Descending("name"));
    }
}
