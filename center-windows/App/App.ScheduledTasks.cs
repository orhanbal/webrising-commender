using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// WECOMMANDER's own scheduled tasks: runs queued for this Center's saved SSH
/// hosts are claimed every 30 seconds while signed in and run in the
/// background (never on the UI thread); the page lives in the main window.
/// </summary>
public partial class App
{
    private ScheduledRunner? _scheduledRunner;
    private DateTime _lastScheduledClaim = DateTime.MinValue;

    /// <summary>From the tick: claim now if 30 s passed (and right after start / sign-in). Never waits.</summary>
    private void PollScheduledRuns()
    {
        if (Token is not { } token || DateTime.UtcNow - _lastScheduledClaim < ScheduledRunner.PollEvery) return;
        _lastScheduledClaim = DateTime.UtcNow;
        _scheduledRunner ??= new ScheduledRunner(Servers, LogCrash);
        var runner = _scheduledRunner;
        var transport = new GatewayRunTransport(Gateway, token);
        _ = Task.Run(async () =>
        {
            try { await runner.PollOnceAsync(transport); }
            catch (Exception e) { LogCrash(e); }
        });
    }

    /// <summary>"Şimdi çalıştır" on an SSH task: claim on the next tick instead of waiting up to 30 s.</summary>
    public void RequestScheduledClaim() => _lastScheduledClaim = DateTime.MinValue;

    /// <summary>The main window on its "Zamanlanmış görevler" page (Dock, tray).</summary>
    public void ShowScheduledTasks()
    {
        ShowServers();
        _servers?.OpenScheduledTasks();
    }
}
