using System.Diagnostics;

namespace Wecommander.Center.Core;

public enum AgentRunState { Running, Stopped, NotInstalled }

/// <summary>How the WECOMMANDER agent is installed on this Windows computer.</summary>
public enum AgentMode
{
    /// <summary>Per-user scheduled task WECOMMANDER-Agent-&lt;SID&gt; (current installer, no admin needed).</summary>
    Task,
    /// <summary>Legacy Windows service WebRisingCommender (start/stop needs administrator approval).</summary>
    Service,
    None,
}

public sealed record AgentStatus(AgentRunState State, AgentMode Mode, bool Enabled)
{
    public bool Running => State == AgentRunState.Running;
}

/// <summary>Runs a program and returns its exit code and standard output.</summary>
public interface ICommandRunner
{
    Task<(int ExitCode, string Output)> RunAsync(string file, string arguments, bool elevated = false);
    /// <summary>Whether an agent process (webrising-commender.exe) runs on this computer.</summary>
    bool AgentProcessRunning();
    /// <summary>Ends the agent processes this user may end; returns how many.</summary>
    int KillAgentProcesses();
}

public sealed class ProcessRunner : ICommandRunner
{
    public const string AgentProcessName = "webrising-commender";

    public async Task<(int ExitCode, string Output)> RunAsync(string file, string arguments, bool elevated = false)
    {
        var info = new ProcessStartInfo(file, arguments) { CreateNoWindow = true };
        if (elevated)
        {
            // UAC prompt; no output can be captured from an elevated child.
            info.UseShellExecute = true;
            info.Verb = "runas";
            info.WindowStyle = ProcessWindowStyle.Hidden;
        }
        else
        {
            info.UseShellExecute = false;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
        }
        using var process = Process.Start(info) ?? throw new InvalidOperationException(file + " could not start");
        var output = elevated ? "" : await process.StandardOutput.ReadToEndAsync().ConfigureAwait(false);
        await process.WaitForExitAsync().ConfigureAwait(false);
        return (process.ExitCode, output);
    }

    public bool AgentProcessRunning()
    {
        var found = Process.GetProcessesByName(AgentProcessName);
        foreach (var p in found) p.Dispose();
        return found.Length > 0;
    }

    public int KillAgentProcesses()
    {
        var killed = 0;
        foreach (var p in Process.GetProcessesByName(AgentProcessName))
        {
            try { p.Kill(entireProcessTree: true); killed++; }
            catch (Exception) { /* another user's or a service process */ }
            finally { p.Dispose(); }
        }
        return killed;
    }
}

/// <summary>
/// Shows and switches the agent on this computer: the per-user scheduled task
/// (start/stop without admin; disabled while switched off so it does not come
/// back at the next sign-in) or the legacy service (through a UAC prompt).
/// </summary>
public sealed class AgentControl(ICommandRunner runner, string userSid)
{
    public const string ServiceName = "WebRisingCommender";
    public string TaskName => "WECOMMANDER-Agent-" + userSid;

    public async Task<AgentStatus> StatusAsync()
    {
        var running = runner.AgentProcessRunning();
        var (taskCode, taskOut) = await runner.RunAsync("schtasks.exe", $"/Query /TN \"{TaskName}\" /FO CSV /NH").ConfigureAwait(false);
        if (taskCode == 0 && ParseTaskStatus(taskOut) is { } taskStatus)
        {
            var enabled = !taskStatus.Equals("Disabled", StringComparison.OrdinalIgnoreCase);
            return new AgentStatus(running ? AgentRunState.Running : AgentRunState.Stopped, AgentMode.Task, enabled);
        }
        var (svcCode, svcOut) = await runner.RunAsync("sc.exe", $"query {ServiceName}").ConfigureAwait(false);
        if (svcCode == 0 && ParseServiceState(svcOut) is { } svcState)
        {
            var (_, configOut) = await runner.RunAsync("sc.exe", $"qc {ServiceName}").ConfigureAwait(false);
            var enabled = !configOut.Contains("DISABLED", StringComparison.OrdinalIgnoreCase);
            var state = svcState == "RUNNING" || running ? AgentRunState.Running : AgentRunState.Stopped;
            return new AgentStatus(state, AgentMode.Service, enabled);
        }
        return new AgentStatus(running ? AgentRunState.Running : AgentRunState.NotInstalled, AgentMode.None, running);
    }

    /// <summary>Switches the agent on (enable + start) or off (stop + disable).</summary>
    public async Task SetEnabledAsync(bool on)
    {
        var status = await StatusAsync().ConfigureAwait(false);
        switch (status.Mode)
        {
            case AgentMode.Task when on:
                await Must(runner.RunAsync("schtasks.exe", $"/Change /TN \"{TaskName}\" /ENABLE"), "Görev etkinleştirilemedi.").ConfigureAwait(false);
                if (!runner.AgentProcessRunning())
                    await Must(runner.RunAsync("schtasks.exe", $"/Run /TN \"{TaskName}\""), "Ajan başlatılamadı.").ConfigureAwait(false);
                break;
            case AgentMode.Task:
                await runner.RunAsync("schtasks.exe", $"/End /TN \"{TaskName}\"").ConfigureAwait(false);
                runner.KillAgentProcesses();
                await Must(runner.RunAsync("schtasks.exe", $"/Change /TN \"{TaskName}\" /DISABLE"), "Görev kapatılamadı.").ConfigureAwait(false);
                break;
            case AgentMode.Service:
                // One UAC prompt for both steps.
                var command = on
                    ? $"/c sc.exe config {ServiceName} start= auto & sc.exe start {ServiceName}"
                    : $"/c sc.exe stop {ServiceName} & sc.exe config {ServiceName} start= disabled";
                await Must(runner.RunAsync("cmd.exe", command, elevated: true), "Yönetici onayı verilmedi.").ConfigureAwait(false);
                break;
            default:
                throw new InvalidOperationException(Texts.AgentNotInstalled);
        }
    }

    private static async Task Must(Task<(int ExitCode, string Output)> run, string message)
    {
        var (code, _) = await run.ConfigureAwait(false);
        if (code != 0) throw new InvalidOperationException(message);
    }

    /// <summary>Status column of `schtasks /Query /FO CSV /NH`: "Ready", "Running", "Disabled", ...</summary>
    public static string? ParseTaskStatus(string csv)
    {
        foreach (var line in csv.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var fields = line.Split("\",\"");
            if (fields.Length >= 3) return fields[^1].Trim('"', ' ', '\r');
        }
        return null;
    }

    /// <summary>"RUNNING", "STOPPED", ... from `sc query`.</summary>
    public static string? ParseServiceState(string output)
    {
        foreach (var line in output.Split('\n'))
        {
            var trimmed = line.Trim();
            if (!trimmed.StartsWith("STATE", StringComparison.OrdinalIgnoreCase)) continue;
            var parts = trimmed.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            return parts.Length > 0 ? parts[^1].ToUpperInvariant() : null;
        }
        return null;
    }
}

public enum WatchdogAction { None, Start, GiveUp }

/// <summary>
/// Keeps the agent running while the owner wants it on: restarts it after
/// 0 s, 30 s and 2 min, then gives up and says so once, until it runs again.
/// </summary>
public sealed class AgentWatchdog
{
    private static readonly TimeSpan[] Backoff = [TimeSpan.Zero, TimeSpan.FromSeconds(30), TimeSpan.FromMinutes(2)];
    public int Failures { get; private set; }
    private DateTimeOffset _lastAttempt = DateTimeOffset.MinValue;
    private bool _gaveUp;

    public WatchdogAction Next(bool keepRunning, AgentStatus status, DateTimeOffset now)
    {
        if (status.Running || !keepRunning || status.State == AgentRunState.NotInstalled)
        {
            if (status.Running) { Failures = 0; _gaveUp = false; }
            return WatchdogAction.None;
        }
        if (Failures >= Backoff.Length)
        {
            if (_gaveUp) return WatchdogAction.None;
            _gaveUp = true;
            return WatchdogAction.GiveUp;
        }
        if (now - _lastAttempt < Backoff[Failures]) return WatchdogAction.None;
        _lastAttempt = now;
        Failures++;
        return WatchdogAction.Start;
    }

    /// <summary>The owner switched it on by hand: try again from the start.</summary>
    public void Reset() { Failures = 0; _gaveUp = false; _lastAttempt = DateTimeOffset.MinValue; }
}
