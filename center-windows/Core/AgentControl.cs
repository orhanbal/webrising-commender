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
    /// <summary>Shipped inside the app and run by it as a hidden child process.</summary>
    Embedded,
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
public sealed class AgentControl(ICommandRunner runner, string userSid, string? agentExe = null)
{
    /// <summary>Where the WECOMMANDER Setup installs the agent.</summary>
    public string AgentExe { get; } = agentExe ?? Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WECOMMANDER", "webrising-commender.exe");

    /// <summary>"0.1.1651" from `webrising-commender --version`, or null when unknown.</summary>
    public async Task<string?> InstalledVersionAsync()
    {
        try
        {
            var (code, output) = await runner.RunAsync(AgentExe, "--version").ConfigureAwait(false);
            return code == 0 ? ParseVersion(output) : null;
        }
        catch (Exception) { return null; }
    }

    public static string? ParseVersion(string output)
    {
        var parts = output.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length >= 2 && parts[^1].Length > 0 && char.IsDigit(parts[^1][0]) ? parts[^1] : null;
    }

    /// <summary>
    /// The official one-line agent installer for this server: it downloads the
    /// newest checked Setup, asks for Windows UAC and keeps the device's
    /// enrollment. Output is UTF-8 so the Center can show it.
    /// </summary>
    public static string UpdateArguments(string server) =>
        $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"[Console]::OutputEncoding=[Text.Encoding]::UTF8; & ([scriptblock]::Create((irm {server.TrimEnd('/')}/install.ps1)))\"";

    /// <summary>
    /// Runs the agent installer without a console window; the Center reads its
    /// output and shows it in the agent card (no window left to close). With a
    /// pairing code (a signed-in Center installing a new agent) the code and
    /// server go in the child's environment, never on its command line, and
    /// the installer pairs without a second browser sign-in.
    /// </summary>
    public static ProcessStartInfo InstallerStartInfo(string server, string? pairingCode)
    {
        var info = new ProcessStartInfo("powershell.exe", UpdateArguments(server))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
        };
        info.Environment["WECOMMANDER_FROM_CENTER"] = "1";
        if (pairingCode is not null)
        {
            info.Environment["WECOMMANDER_PAIRING_CODE"] = pairingCode;
            info.Environment["WECOMMANDER_SERVER"] = server.TrimEnd('/');
        }
        return info;
    }

    /// <summary>A line of installer output worth showing (no blank lines, no logo art).</summary>
    public static string? InstallerLine(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return null;
        var text = line.TrimEnd();
        // The banner's block-art rows carry no letters; the title rows do.
        return text.Any(char.IsLetterOrDigit) ? text.Trim() : null;
    }

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
                await EnsureHeadlessTaskAsync().ConfigureAwait(false);
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

    /// <summary>
    /// Agents installed before the headless task action (conhost --headless)
    /// run their task action directly, which Windows 11 opens in a visible
    /// terminal window that stops the agent when closed. Rewrites such a task
    /// in place before starting it; best effort (the update button
    /// re-registers it anyway).
    /// </summary>
    public async Task<bool> EnsureHeadlessTaskAsync()
    {
        var (code, xml) = await runner.RunAsync("schtasks.exe", $"/Query /TN \"{TaskName}\" /XML ONE").ConfigureAwait(false);
        if (code != 0 || HeadlessTaskCommand(xml, ConhostPath) is not { } command) return false;
        var (changed, _) = await runner.RunAsync("schtasks.exe", $"/Change /TN \"{TaskName}\" /TR \"{command.Replace("\"", "\\\"")}\"").ConfigureAwait(false);
        return changed == 0;
    }

    private static string ConhostPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System) is { Length: > 0 } sys ? sys : @"C:\Windows\System32", "conhost.exe");

    /// <summary>
    /// The headless command line for a task's XML, or null when the task
    /// already runs through conhost (or has no command).
    /// </summary>
    public static string? HeadlessTaskCommand(string taskXml, string conhost)
    {
        static string? Tag(string xml, string name)
        {
            var m = System.Text.RegularExpressions.Regex.Match(xml, $"<{name}>(.*?)</{name}>", System.Text.RegularExpressions.RegexOptions.Singleline);
            return m.Success ? System.Net.WebUtility.HtmlDecode(m.Groups[1].Value).Trim() : null;
        }
        var command = Tag(taskXml, "Command");
        if (string.IsNullOrEmpty(command) || command.Contains("conhost", StringComparison.OrdinalIgnoreCase)) return null;
        var arguments = Tag(taskXml, "Arguments");
        var exe = command.Trim('"');
        return $"\"{conhost}\" --headless \"{exe}\"" + (string.IsNullOrEmpty(arguments) ? "" : " " + arguments);
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

/// <summary>
/// Removes what earlier versions installed outside the app (the per-user
/// scheduled task, the legacy service and the Program Files setup) once the
/// app runs the agent itself. The pairing (agent.json) is kept. Whatever the
/// user may not remove alone goes into one UAC prompt.
/// </summary>
public sealed class LegacyAgentCleanup(ICommandRunner runner, string userSid, string? programFiles = null, Func<string, bool>? fileExists = null)
{
    private readonly Func<string, bool> _exists = fileExists ?? File.Exists;
    public string TaskName => "WECOMMANDER-Agent-" + userSid;
    public string Uninstaller => Path.Combine(programFiles ?? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "WECOMMANDER", "unins000.exe");

    /// <summary>What is still there: (task, service, setup).</summary>
    public async Task<(bool Task, bool Service, bool Setup)> FindAsync()
    {
        var (taskCode, _) = await runner.RunAsync("schtasks.exe", $"/Query /TN \"{TaskName}\"").ConfigureAwait(false);
        var (svcCode, _) = await runner.RunAsync("sc.exe", $"query {AgentControl.ServiceName}").ConfigureAwait(false);
        return (taskCode == 0, svcCode == 0, _exists(Uninstaller));
    }

    /// <summary>
    /// The elevated command for what is left, or null when nothing needs admin.
    /// </summary>
    public string? ElevatedCommand(bool task, bool service, bool setup)
    {
        var steps = new List<string>();
        if (task) { steps.Add($"schtasks.exe /End /TN \"{TaskName}\""); steps.Add($"schtasks.exe /Delete /TN \"{TaskName}\" /F"); }
        if (service) { steps.Add($"sc.exe stop {AgentControl.ServiceName}"); steps.Add($"sc.exe delete {AgentControl.ServiceName}"); }
        if (setup) steps.Add($"\"{Uninstaller}\" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART");
        return steps.Count == 0 ? null : "/c " + string.Join(" & ", steps);
    }

    /// <summary>
    /// Returns true when nothing of the old install is left. Stops old agent
    /// processes first so the embedded agent is the only one connected.
    /// </summary>
    public async Task<bool> RunAsync(bool allowPrompt)
    {
        var (task, service, setup) = await FindAsync().ConfigureAwait(false);
        if (!task && !service && !setup) return true;
        if (task)
        {
            await runner.RunAsync("schtasks.exe", $"/End /TN \"{TaskName}\"").ConfigureAwait(false);
            var (deleted, _) = await runner.RunAsync("schtasks.exe", $"/Delete /TN \"{TaskName}\" /F").ConfigureAwait(false);
            task = deleted != 0;
        }
        runner.KillAgentProcesses();
        if (ElevatedCommand(task, service, setup) is not { } command) return true;
        if (!allowPrompt) return false;
        var (code, _) = await runner.RunAsync("cmd.exe", command, elevated: true).ConfigureAwait(false);
        if (code != 0) return false;
        // The Inno uninstaller finishes from a temp copy after it returns;
        // the task and the service are what would run a second agent.
        var left = await FindAsync().ConfigureAwait(false);
        return !left.Task && !left.Service;
    }
}
