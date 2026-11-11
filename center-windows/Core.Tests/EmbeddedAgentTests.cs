using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Wecommander.Center.Core;
using Xunit;

public class EmbeddedAgentTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "wc-embedded-" + Guid.NewGuid().ToString("N"));
    private string Exe => Path.Combine(_dir, "app", EmbeddedAgent.ExeName);
    private string Config => Path.Combine(_dir, "appdata", "webrising-commender", "agent.json");

    public EmbeddedAgentTests()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Exe)!);
        File.WriteAllText(Exe, "fake");
    }

    public void Dispose() { try { Directory.Delete(_dir, true); } catch (Exception) { } }

    private sealed class FakeProcess : IAgentProcess
    {
        public bool HasExited { get; set; }
        public int? ExitCode { get; set; }
        public bool Killed;
        public void Kill() { Killed = true; HasExited = true; }
        public void Dispose() { }
    }

    private sealed class FakeLauncher(Func<ProcessStartInfo, (int, string)> enroll) : IAgentLauncher
    {
        public readonly List<ProcessStartInfo> Started = [];
        public readonly List<FakeProcess> Processes = [];
        public IAgentProcess Start(ProcessStartInfo info)
        {
            Started.Add(info);
            var p = new FakeProcess();
            Processes.Add(p);
            return p;
        }
        public Task<(int ExitCode, string Output)> RunAsync(ProcessStartInfo info, TimeSpan timeout) => Task.FromResult(enroll(info));
    }

    private FakeLauncher Enrolls(string? config = "{}", int code = 0, string output = "") => new(info =>
    {
        if (config is not null)
        {
            var path = info.ArgumentList[1];
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, config);
        }
        return (code, output);
    });

    [Fact]
    public async Task PairsHiddenAndStartsWithoutAWindow()
    {
        var launcher = Enrolls();
        var agent = new EmbeddedAgent(Exe, Config, launcher);
        Assert.Equal(AgentRunState.NotInstalled, agent.Status(true).State);
        Assert.False(agent.Start()); // not paired yet: nothing to run

        Assert.True(await agent.PairAsync("https://wecommander.app/", "CODE-123", Path.Combine(_dir, "root")));
        Assert.True(agent.Paired);
        Assert.True(Directory.Exists(Path.Combine(_dir, "root")));

        Assert.True(agent.Start());
        var run = Assert.Single(launcher.Started);
        Assert.True(run.CreateNoWindow);
        Assert.False(run.UseShellExecute);
        Assert.Equal(["--config", Config, "run"], run.ArgumentList.ToArray());
        // The agent exits with the app however the app ends.
        Assert.Equal(Environment.ProcessId.ToString(), run.Environment[EmbeddedAgent.ParentEnv]);
        Assert.Equal(new AgentStatus(AgentRunState.Running, AgentMode.Embedded, true), agent.Status(true));

        agent.Stop();
        Assert.True(launcher.Processes[0].Killed);
        Assert.Equal(AgentRunState.Stopped, agent.Status(true).State);
    }

    [Fact]
    public void EnrollArgumentsUseTheServerAndCode()
    {
        var agent = new EmbeddedAgent(Exe, Config, Enrolls());
        var info = agent.EnrollStartInfo("https://wecommander.app/", "C1", @"C:\Users\x\WECOMMANDER");
        Assert.Equal(["--config", Config, "enroll", "--control-url", "https://wecommander.app", "--pairing-code", "C1", "--allowed-root", @"C:\Users\x\WECOMMANDER"],
            info.ArgumentList.ToArray());
        Assert.True(info.CreateNoWindow);
    }

    [Fact]
    public async Task FailedPairingKeepsTheOldPairingAndHidesTheCode()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Config)!);
        File.WriteAllText(Config, "old");
        var agent = new EmbeddedAgent(Exe, Config, Enrolls(config: null, code: 1, output: "pairing code SECRET-9 expired"));
        Assert.False(await agent.PairAsync("https://wecommander.app", "SECRET-9", Path.Combine(_dir, "root")));
        Assert.Equal("old", File.ReadAllText(Config));
        Assert.DoesNotContain("SECRET-9", agent.LastError);
        Assert.Contains("[REDACTED]", agent.LastError);
    }

    [Fact]
    public async Task WatchdogRestartsAStoppedAgentThenGivesUp()
    {
        var launcher = Enrolls();
        var agent = new EmbeddedAgent(Exe, Config, launcher);
        await agent.PairAsync("https://wecommander.app", "C", Path.Combine(_dir, "root"));
        var now = DateTimeOffset.UtcNow;
        Assert.Equal(WatchdogAction.Start, agent.Tick(true, now));
        Assert.True(agent.Running);
        Assert.Equal(WatchdogAction.None, agent.Tick(true, now)); // running: nothing to do

        // It keeps dying right away.
        launcher.Processes[^1].HasExited = true;
        Assert.Equal(WatchdogAction.Start, agent.Tick(true, now));
        launcher.Processes[^1].HasExited = true;
        Assert.Equal(WatchdogAction.None, agent.Tick(true, now.AddSeconds(5)));
        Assert.Equal(WatchdogAction.Start, agent.Tick(true, now.AddSeconds(31)));
        launcher.Processes[^1].HasExited = true;
        Assert.Equal(WatchdogAction.Start, agent.Tick(true, now.AddMinutes(3)));
        launcher.Processes[^1].HasExited = true;
        Assert.Equal(WatchdogAction.GiveUp, agent.Tick(true, now.AddMinutes(10)));
        Assert.Equal(WatchdogAction.None, agent.Tick(true, now.AddMinutes(20)));

        // Switched off: never started.
        var count = launcher.Started.Count;
        agent.ResetWatchdog();
        Assert.Equal(WatchdogAction.None, agent.Tick(false, now.AddMinutes(30)));
        Assert.Equal(count, launcher.Started.Count);
    }

    [Fact]
    public void MissingAgentExeIsReported()
    {
        File.Delete(Exe);
        Directory.CreateDirectory(Path.GetDirectoryName(Config)!);
        File.WriteAllText(Config, "{}");
        var agent = new EmbeddedAgent(Exe, Config, Enrolls());
        Assert.False(agent.Available);
        Assert.False(agent.Start());
        Assert.Contains("yeniden kur", agent.LastError);
    }

    private sealed class CleanupRunner : ICommandRunner
    {
        public bool Task = true, Service, TaskDeleteDenied;
        public readonly List<string> Calls = [];
        public int Killed;
        public Task<(int, string)> RunAsync(string file, string arguments, bool elevated = false)
        {
            Calls.Add((elevated ? "elevated " : "") + file + " " + arguments);
            if (elevated) { Task = false; Service = false; return System.Threading.Tasks.Task.FromResult((0, "")); }
            if (file == "schtasks.exe" && arguments.StartsWith("/Query")) return System.Threading.Tasks.Task.FromResult(Task ? (0, "") : (1, ""));
            if (file == "sc.exe" && arguments.StartsWith("query")) return System.Threading.Tasks.Task.FromResult(Service ? (0, "") : (1060, ""));
            if (file == "schtasks.exe" && arguments.StartsWith("/Delete"))
            {
                if (TaskDeleteDenied) return System.Threading.Tasks.Task.FromResult((1, "Access is denied."));
                Task = false;
            }
            return System.Threading.Tasks.Task.FromResult((0, ""));
        }
        public bool AgentProcessRunning() => false;
        public int KillAgentProcesses() { Killed++; return 0; }
    }

    [Fact]
    public async Task OldTaskIsRemovedWithoutAPromptWhenAllowed()
    {
        var runner = new CleanupRunner();
        var cleanup = new LegacyAgentCleanup(runner, "S-1", @"C:\PF", _ => false);
        Assert.True(await cleanup.RunAsync(allowPrompt: false));
        Assert.Contains("schtasks.exe /Delete /TN \"WECOMMANDER-Agent-S-1\" /F", runner.Calls);
        Assert.DoesNotContain(runner.Calls, c => c.StartsWith("elevated"));
        Assert.Equal(1, runner.Killed);
        Assert.True(await cleanup.RunAsync(allowPrompt: false)); // nothing left
    }

    [Fact]
    public async Task WhatNeedsAdminGoesIntoOnePrompt()
    {
        var runner = new CleanupRunner { TaskDeleteDenied = true, Service = true };
        var cleanup = new LegacyAgentCleanup(runner, "S-1", @"C:\PF", p => p.EndsWith("unins000.exe"));
        Assert.False(await cleanup.RunAsync(allowPrompt: false));
        Assert.DoesNotContain(runner.Calls, c => c.StartsWith("elevated"));
        Assert.True(await cleanup.RunAsync(allowPrompt: true));
        var elevated = Assert.Single(runner.Calls, c => c.StartsWith("elevated"));
        Assert.Contains("schtasks.exe /Delete /TN \"WECOMMANDER-Agent-S-1\" /F", elevated);
        Assert.Contains("sc.exe delete WebRisingCommender", elevated);
        Assert.Contains("unins000.exe\" /VERYSILENT", elevated);
    }

    private const string Releases = """
    [
      {"tag_name":"ubuntu-preview-1900","draft":false,"assets":[
        {"name":"WECOMMANDER-Center-windows-x64.zip","browser_download_url":"https://github.com/orhanbal/webrising-commender/releases/download/ubuntu-preview-1900/WECOMMANDER-Center-windows-x64.zip"},
        {"name":"SHA256SUMS.txt","browser_download_url":"https://github.com/orhanbal/webrising-commender/releases/download/ubuntu-preview-1900/SHA256SUMS.txt"}]},
      {"tag_name":"ubuntu-preview-1950","draft":false,"assets":[
        {"name":"WECOMMANDER-Center-windows-x64.zip","browser_download_url":"https://evil.example/WECOMMANDER-Center-windows-x64.zip"},
        {"name":"SHA256SUMS.txt","browser_download_url":"https://github.com/orhanbal/webrising-commender/releases/download/ubuntu-preview-1950/SHA256SUMS.txt"}]},
      {"tag_name":"ubuntu-preview-1960","draft":true,"assets":[]},
      {"tag_name":"center-linux-latest","draft":false,"assets":[]}
    ]
    """;

    [Fact]
    public void AppUpdatePicksTheNewestReleaseFromThisRepo()
    {
        var latest = AppUpdate.Latest(Releases);
        Assert.NotNull(latest);
        Assert.Equal(1900, latest!.Build);
        Assert.True(AppUpdate.IsNewer(latest, 1899));
        Assert.False(AppUpdate.IsNewer(latest, 1900));
        Assert.False(AppUpdate.IsNewer(latest, null)); // developer build: never replaced
        Assert.Null(AppUpdate.Latest("not json"));
    }

    [Fact]
    public void AppUpdateReadsTheBuildAndTheChecksum()
    {
        var app = Path.Combine(_dir, "app");
        Assert.Null(AppUpdate.CurrentBuild(app));
        File.WriteAllText(Path.Combine(app, "build.txt"), "1888\n");
        Assert.Equal(1888, AppUpdate.CurrentBuild(app));

        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("x"))).ToLowerInvariant();
        var sums = $"{hash.ToUpperInvariant()}  WECOMMANDER-Center-windows-x64.zip\n{new string('a', 64)} *other.exe\n";
        Assert.Equal(hash, AppUpdate.ExpectedHash(sums, AppUpdate.ZipAsset));
        Assert.Null(AppUpdate.ExpectedHash(sums + sums, AppUpdate.ZipAsset)); // not unique
        Assert.Null(AppUpdate.ExpectedHash(sums, "missing.zip"));
    }

    [Fact]
    public void SwapScriptKeepsTheOldCopyUntilTheNewOneIsIn()
    {
        var script = AppUpdate.SwapScript(@"C:\Users\o'b\AppData\Local\Programs\WECOMMANDER Center\", @"C:\Temp\new", 42, @"C:\Users\o'b\AppData\Local\WECOMMANDER\update-failed.txt");
        Assert.Contains("Wait-Process -Id 42", script);
        Assert.Contains("$app='C:\\Users\\o''b\\AppData\\Local\\Programs\\WECOMMANDER Center'", script);
        Assert.Contains("$old='C:\\Users\\o''b\\AppData\\Local\\Programs\\WECOMMANDER Center.old'", script);
        Assert.Contains("Rename-Item -LiteralPath $old -NewName", script);
        Assert.Contains("-ArgumentList '--updated'", script);
        // The helper must not sit in the folder it renames.
        Assert.StartsWith("$ErrorActionPreference='Stop'\nSet-Location -LiteralPath ([IO.Path]::GetTempPath())", script);
        Assert.Contains("Set-Content -LiteralPath $fail", script);

        // On Windows (CI), the helper must parse as PowerShell.
        if (OperatingSystem.IsWindows())
        {
            var file = Path.Combine(_dir, "swap.ps1");
            File.WriteAllText(file, script);
            var check = new System.Diagnostics.ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true,
            };
            var quoted = "'" + file.Replace("'", "''") + "'";
            foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-Command",
                "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(" + quoted + ",[ref]$null,[ref]$e); if($e.Count){ $e | ForEach-Object { $_.Message }; exit 1 }" })
                check.ArgumentList.Add(arg);
            using var p = System.Diagnostics.Process.Start(check)!;
            var output = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
            p.WaitForExit();
            Assert.True(p.ExitCode == 0, output);
        }
    }
}
