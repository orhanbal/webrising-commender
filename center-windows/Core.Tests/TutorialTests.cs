using Wecommander.Center.Core;
using Xunit;

public class TutorialTests
{
    [Fact]
    public void StartsWithAddingAServerUnlessThereAreServers()
    {
        Assert.Equal(Tutorial.AddServer, Tutorial.Current(Tutorial.NotStarted, off: false, hostCount: 0));
        Assert.Equal(Tutorial.Connect, Tutorial.Current(Tutorial.NotStarted, off: false, hostCount: 2));
    }

    [Fact]
    public void MovesOnWithWhatThePersonDoes()
    {
        var step = Tutorial.Current(0, false, 0);
        step = Tutorial.HostAdded(step);
        Assert.Equal(Tutorial.Connect, step);
        step = Tutorial.TerminalOpened(step);
        Assert.Equal(Tutorial.Status, step);
        step = Tutorial.Next(step);
        Assert.Equal(Tutorial.Ai, step);
        step = Tutorial.Next(Tutorial.Next(step));
        Assert.Equal(Tutorial.Done, step);
        // Later events do not bring it back.
        Assert.Equal(Tutorial.Done, Tutorial.TerminalOpened(Tutorial.HostAdded(step)));
    }

    [Fact]
    public void ServersFromSyncSkipTheFirstStepAndOffMeansDone()
    {
        Assert.Equal(Tutorial.Connect, Tutorial.Current(Tutorial.AddServer, false, 1));
        Assert.Equal(Tutorial.Done, Tutorial.Current(Tutorial.Connect, off: true, hostCount: 1));
        Assert.Equal(Tutorial.AddServer, Tutorial.Restart(0));
    }
}
