namespace Wecommander.Center.Core;

/// <summary>
/// The getting-started tutorial's steps. A step moves on when the person does
/// the thing it shows (adds a server, opens a terminal), not with a Next
/// button; the status and AI steps have their own buttons. The same steps on
/// Windows and macOS.
/// </summary>
public static class Tutorial
{
    public const int NotStarted = 0, AddServer = 1, Connect = 2, Status = 3, Ai = 4, Finish = 5, Done = 6;

    /// <summary>Where it starts: a person who already has servers skips adding one.</summary>
    public static int Start(int hostCount) => hostCount > 0 ? Connect : AddServer;

    /// <summary>The step to show now (it may move on by itself: servers appeared through sync or import).</summary>
    public static int Current(int step, bool off, int hostCount)
    {
        if (off || step >= Done) return Done;
        if (step <= NotStarted) return Start(hostCount);
        if (step == AddServer && hostCount > 0) return Connect;
        return step;
    }

    /// <summary>A server was added.</summary>
    public static int HostAdded(int step) => step == AddServer ? Connect : step;

    /// <summary>A terminal opened.</summary>
    public static int TerminalOpened(int step) => step is AddServer or Connect ? Status : step;

    /// <summary>The step's own button (or "skip") was pressed.</summary>
    public static int Next(int step) => step >= Finish ? Done : step + 1;

    /// <summary>Settings → "Baştan başlat".</summary>
    public static int Restart(int hostCount) => Start(hostCount);
}
