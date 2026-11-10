using System.Diagnostics;

namespace Wecommander.Center.Core;

/// <summary>A started agent process (real or, in tests, fake).</summary>
public interface IAgentProcess : IDisposable
{
    bool HasExited { get; }
    int? ExitCode { get; }
    void Kill();
}

/// <summary>Starts agent processes; the real one never opens a window.</summary>
public interface IAgentLauncher
{
    IAgentProcess Start(ProcessStartInfo info);
    /// <summary>Runs to the end; returns the exit code and all output.</summary>
    Task<(int ExitCode, string Output)> RunAsync(ProcessStartInfo info, TimeSpan timeout);
}

public sealed class HiddenProcessLauncher : IAgentLauncher
{
    private sealed class Running(Process process) : IAgentProcess
    {
        public bool HasExited { get { try { return process.HasExited; } catch (Exception) { return true; } } }
        public int? ExitCode { get { try { return process.HasExited ? process.ExitCode : null; } catch (Exception) { return null; } } }
        public void Kill() { try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (Exception) { } }
        public void Dispose() => process.Dispose();
    }

    public IAgentProcess Start(ProcessStartInfo info)
    {
        var process = Process.Start(info) ?? throw new InvalidOperationException("agent did not start");
        // Its log goes to its own file; drain the pipes so it never blocks.
        if (info.RedirectStandardOutput) { process.OutputDataReceived += (_, _) => { }; process.BeginOutputReadLine(); }
        if (info.RedirectStandardError) { process.ErrorDataReceived += (_, _) => { }; process.BeginErrorReadLine(); }
        return new Running(process);
    }

    public async Task<(int ExitCode, string Output)> RunAsync(ProcessStartInfo info, TimeSpan timeout)
    {
        using var process = Process.Start(info) ?? throw new InvalidOperationException("agent did not start");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        using var cts = new CancellationTokenSource(timeout);
        try { await process.WaitForExitAsync(cts.Token).ConfigureAwait(false); }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch (Exception) { }
            return (-1, "timed out");
        }
        return (process.ExitCode, (await stdout.ConfigureAwait(false)) + (await stderr.ConfigureAwait(false)));
    }
}

/// <summary>
/// The WECOMMANDER agent shipped inside the app (webrising-commender.exe next
/// to it). The app pairs it with a one-time code from the signed-in account
/// and runs it as a hidden child process: no installer, no scheduled task, no
/// console window. Quitting the app stops it; the app starts with Windows.
/// </summary>
public sealed class EmbeddedAgent : IDisposable
{
    public const string ExeName = "webrising-commender.exe";

    private readonly IAgentLauncher _launcher;
    private readonly AgentWatchdog _watchdog = new();
    private readonly object _gate = new();
    private IAgentProcess? _process;

    public string AgentExe { get; }
    public string ConfigPath { get; }

    public EmbeddedAgent(string agentExe, string configPath, IAgentLauncher? launcher = null)
    {
        AgentExe = agentExe;
        ConfigPath = configPath;
        _launcher = launcher ?? new HiddenProcessLauncher();
    }

    /// <summary>The agent next to the app; the pairing where the agent keeps it (%APPDATA%).</summary>
    public static EmbeddedAgent ForThisApp() => new(
        Path.Combine(AppContext.BaseDirectory, ExeName),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "webrising-commender", "agent.json"));

    /// <summary>Folder the agent may use by default (~/WECOMMANDER).</summary>
    public static string DefaultRoot =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "WECOMMANDER");

    /// <summary>This app build carries the agent.</summary>
    public bool Available => File.Exists(AgentExe);
    public bool Paired => File.Exists(ConfigPath);
    public bool Running { get { lock (_gate) return _process is { HasExited: false }; } }
    /// <summary>Why the last start or pairing failed (Turkish), or null.</summary>
    public string? LastError { get; private set; }

    public AgentStatus Status(bool keepRunning) => new(
        Running ? AgentRunState.Running : Paired ? AgentRunState.Stopped : AgentRunState.NotInstalled,
        AgentMode.Embedded, keepRunning);

    public static ProcessStartInfo HiddenStartInfo(string exe, IEnumerable<string> arguments, bool capture)
    {
        var info = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = capture,
            RedirectStandardError = capture,
            RedirectStandardInput = false,
            WorkingDirectory = Path.GetDirectoryName(exe) ?? "",
        };
        foreach (var a in arguments) info.ArgumentList.Add(a);
        return info;
    }

    public ProcessStartInfo RunStartInfo() => HiddenStartInfo(AgentExe, ["--config", ConfigPath, "run"], capture: true);

    public ProcessStartInfo EnrollStartInfo(string server, string pairingCode, string allowedRoot) =>
        HiddenStartInfo(AgentExe, ["--config", ConfigPath, "enroll", "--control-url", server.TrimEnd('/'),
            "--pairing-code", pairingCode, "--allowed-root", allowedRoot], capture: true);

    /// <summary>
    /// Pairs this computer with the signed-in account. An existing pairing is
    /// kept as agent.json.bak and put back when the new one fails. The code
    /// never appears in errors.
    /// </summary>
    public async Task<bool> PairAsync(string server, string pairingCode, string? allowedRoot = null)
    {
        var root = allowedRoot ?? DefaultRoot;
        var backup = ConfigPath + ".bak";
        try
        {
            Directory.CreateDirectory(root);
            Directory.CreateDirectory(Path.GetDirectoryName(ConfigPath)!);
            var wasRunning = Running;
            Stop();
            if (Paired) File.Copy(ConfigPath, backup, overwrite: true);
            if (Paired) File.Delete(ConfigPath);
            var (code, output) = await _launcher.RunAsync(EnrollStartInfo(server, pairingCode, root), TimeSpan.FromSeconds(60)).ConfigureAwait(false);
            if (code != 0 || !Paired)
            {
                Restore(backup);
                LastError = "Bu bilgisayar hesaba bağlanamadı: " + Redact(output, pairingCode);
                if (wasRunning) Start();
                return false;
            }
            LastError = null;
            _watchdog.Reset();
            return true;
        }
        catch (Exception e)
        {
            Restore(backup);
            LastError = "Bu bilgisayar hesaba bağlanamadı: " + Redact(e.Message, pairingCode);
            return false;
        }
    }

    private void Restore(string backup)
    {
        try { if (!Paired && File.Exists(backup)) File.Move(backup, ConfigPath); } catch (Exception) { }
    }

    public static string Redact(string text, string secret)
    {
        var t = (text ?? "").Trim();
        if (!string.IsNullOrEmpty(secret)) t = t.Replace(secret, "[REDACTED]");
        if (t.Length > 300) t = t[..300] + "…";
        return t.Length == 0 ? "bilinmeyen hata" : t;
    }

    /// <summary>Starts the paired agent hidden; no-op while it runs.</summary>
    public bool Start()
    {
        lock (_gate)
        {
            if (_process is { HasExited: false }) return true;
            _process?.Dispose();
            _process = null;
            if (!Available) { LastError = "Uygulamanın içindeki ajan bulunamadı; uygulamayı yeniden kur."; return false; }
            if (!Paired) { LastError = null; return false; }
            try
            {
                _process = _launcher.Start(RunStartInfo());
                LastError = null;
                return true;
            }
            catch (Exception e)
            {
                LastError = "Ajan başlatılamadı: " + e.Message;
                return false;
            }
        }
    }

    public void Stop()
    {
        lock (_gate)
        {
            _process?.Kill();
            _process?.Dispose();
            _process = null;
        }
    }

    /// <summary>
    /// Called every few seconds: while the owner wants it on and it is paired,
    /// starts it again after it stopped (0 s, 30 s, 2 min, then gives up).
    /// </summary>
    public WatchdogAction Tick(bool keepRunning, DateTimeOffset now)
    {
        var action = _watchdog.Next(keepRunning, Status(keepRunning), now);
        if (action == WatchdogAction.Start) Start();
        return action;
    }

    public void ResetWatchdog() => _watchdog.Reset();

    public void Dispose() => Stop();
}
