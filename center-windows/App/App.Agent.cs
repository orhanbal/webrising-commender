using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// The agent inside the app: paired with the signed-in account, run as a
/// hidden child process and kept running by a watchdog. Updating the app
/// updates the agent too. Builds without webrising-commender.exe next to them
/// fall back to the separately installed agent (AgentControl).
/// </summary>
public partial class App
{
    private readonly EmbeddedAgent _embedded = EmbeddedAgent.ForThisApp();
    private bool _pairing;
    private DateTime _lastPairAttempt = DateTime.MinValue;
    private bool _cleanupDone;
    /// <summary>Set once the old install is out of the way; the watchdog waits for it.</summary>
    private bool _embeddedReady;
    private Core.AppUpdate.Release? _latestApp;
    private int? _announcedApp;

    /// <summary>This app carries the agent and runs it itself.</summary>
    public bool Embedded => _embedded.Available;
    /// <summary>This app's build (the N of 0.1.N), or null in a developer build.</summary>
    public int? AppBuild { get; } = Core.AppUpdate.CurrentBuild();
    public bool AppUpdateAvailable => Core.AppUpdate.IsNewer(_latestApp, AppBuild);
    public int? LatestAppBuild => _latestApp?.Build;
    /// <summary>When the releases were last read successfully (local time), for "güncel (21:45)".</summary>
    public DateTime? LastReleaseRead { get; private set; }

    /// <summary>Written by the update helper when the new version could not be put in place.</summary>
    private static string UpdateFailFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WECOMMANDER", "update-failed.txt");

    /// <summary>After an update: say whether it worked (the helper leaves a note when it did not).</summary>
    private void ReportUpdateResult()
    {
        if (!Environment.GetCommandLineArgs().Contains("--updated")) return;
        try
        {
            if (File.Exists(UpdateFailFile))
            {
                var why = File.ReadAllText(UpdateFailFile).Trim();
                File.Delete(UpdateFailFile);
                Error = "Güncelleme tamamlanamadı: " + (why.Length > 0 ? why : "dosyalar değiştirilemedi") + ". Paneldeki indirme dosyasıyla yeniden kurabilirsin.";
                Toast("Güncelleme tamamlanamadı; ayrıntı panelde.");
            }
            else if (AppBuild is { } b) Toast($"WECOMMANDER 0.1.{b} sürümüne güncellendi.");
        }
        catch (Exception) { }
    }

    /// <summary>At launch: end what an earlier copy left, remove the old install once, start.</summary>
    private async void StartEmbeddedAgent()
    {
        ReportUpdateResult();
        if (!Embedded) return;
        KillStrayEmbeddedAgents();
        await CleanupLegacyAgentAsync();
        _embeddedReady = true;
        if (_embedded.Paired && Settings.AgentKeepRunning) _embedded.Tick(true, DateTimeOffset.UtcNow);
        await EnsurePairedAsync();
        await CheckAgentAsync();
    }

    /// <summary>An agent from this folder that a crashed copy of the app left running.</summary>
    private void KillStrayEmbeddedAgents()
    {
        foreach (var p in Process.GetProcessesByName(ProcessRunner.AgentProcessName))
        {
            try
            {
                if (string.Equals(p.MainModule?.FileName, _embedded.AgentExe, StringComparison.OrdinalIgnoreCase))
                    p.Kill(entireProcessTree: true);
            }
            catch (Exception) { }
            finally { p.Dispose(); }
        }
    }

    /// <summary>
    /// Removes the scheduled task, service and Program Files setup of earlier
    /// versions (the pairing is kept). Windows asks for approval once, only
    /// when the old install cannot be removed without it.
    /// </summary>
    private async Task CleanupLegacyAgentAsync()
    {
        if (_cleanupDone) return;
        var cleanup = new LegacyAgentCleanup(new ProcessRunner(),
            System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value ?? "");
        try
        {
            var found = await cleanup.FindAsync();
            if (!found.Task && !found.Service && !found.Setup) { _cleanupDone = true; return; }
            var prompt = !Settings.LegacyCleanupPrompted;
            if (prompt && cleanup.ElevatedCommand(found.Task, found.Service, found.Setup) is not null && (found.Service || found.Setup))
                Toast("Eski ajan kurulumu kaldırılıyor; artık ajan bu uygulamanın içinde çalışıyor. Windows bir kez onay isteyebilir.");
            _cleanupDone = await cleanup.RunAsync(allowPrompt: prompt);
            if (prompt) { Settings.LegacyCleanupPrompted = true; SaveSettings(); }
        }
        catch (Exception) { /* tried again at the next start */ }
    }

    /// <summary>Signed in and not paired yet: pair this computer with a one-time code, then start.</summary>
    private async Task EnsurePairedAsync()
    {
        if (!Embedded || _embedded.Paired || _pairing || Token is not { } token) return;
        _pairing = true;
        _lastPairAttempt = DateTime.UtcNow;
        Publish();
        try
        {
            var code = await Gateway.PairingCodeAsync(token);
            if (await _embedded.PairAsync(Settings.Server, code))
            {
                Settings.AgentKeepRunning = true;
                SaveSettings();
                _embedded.ResetWatchdog();
                _embedded.Tick(true, DateTimeOffset.UtcNow);
                Toast("Bu bilgisayar hesabına bağlandı. Ajan arka planda çalışıyor.");
                RequestSync();
            }
            else Error = _embedded.LastError;
        }
        catch (GatewayException e) { Error = "Bu bilgisayar hesaba bağlanamadı: " + e.Message; }
        finally
        {
            _pairing = false;
            Agent = _embedded.Status(Settings.AgentKeepRunning);
            Publish();
        }
    }

    public bool Pairing => _pairing;

    private async Task CheckEmbeddedAsync()
    {
        if (!_embeddedReady) return;
        var changed = false;
        switch (_embedded.Tick(Settings.AgentKeepRunning, DateTimeOffset.UtcNow))
        {
            case WatchdogAction.Start when _embedded.Running && Agent is { State: AgentRunState.Stopped }:
                Toast(Texts.AgentRestartedText);
                changed = true;
                break;
            case WatchdogAction.GiveUp:
                Toast(Texts.AgentGaveUpText + (_embedded.LastError is { } why ? " (" + why + ")" : ""));
                break;
        }
        var status = _embedded.Status(Settings.AgentKeepRunning);
        if (status != Agent) { Agent = status; changed = true; }
        if (AgentVersion is null || DateTime.UtcNow - _lastVersionCheck >= TimeSpan.FromHours(1))
        {
            _lastVersionCheck = DateTime.UtcNow;
            var version = await new AgentControl(new ProcessRunner(), "", _embedded.AgentExe).InstalledVersionAsync();
            if (version != AgentVersion) { AgentVersion = version; changed = true; }
        }
        if (!_embedded.Paired && Token is not null && DateTime.UtcNow - _lastPairAttempt >= TimeSpan.FromMinutes(5))
            await EnsurePairedAsync();
        if (DateTime.UtcNow - _lastReleaseCheck >= TimeSpan.FromHours(1))
        {
            _lastReleaseCheck = DateTime.UtcNow;
            try
            {
                var latest = Core.AppUpdate.Latest(await ReleasesJsonAsync());
                if (latest?.Build != _latestApp?.Build) { _latestApp = latest; changed = true; }
                LastReleaseRead = DateTime.Now; changed = true;
            }
            catch (Exception) { _lastReleaseCheck = DateTime.UtcNow - TimeSpan.FromMinutes(50); /* retry in ten minutes */ }
            if (AppUpdateAvailable && _announcedApp != _latestApp!.Build)
            {
                _announcedApp = _latestApp.Build;
                Toast($"WECOMMANDER için yeni sürüm var (0.1.{_latestApp.Build}). Panelde \"Uygulamayı güncelle\"ye bas.");
            }
        }
        if (changed) Publish();
    }

    private static async Task<string> ReleasesJsonAsync()
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, AgentUpdate.ReleasesUrl);
        request.Headers.UserAgent.ParseAdd("WECOMMANDER-Center");
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        using var response = await Http.SendAsync(request);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync();
    }

    private void SetEmbeddedEnabled(bool on)
    {
        Settings.AgentKeepRunning = on;
        SaveSettings();
        _embedded.ResetWatchdog();
        if (on)
        {
            if (!_embedded.Paired) { _ = EnsurePairedAsync(); return; }
            if (!_embedded.Start()) Error = _embedded.LastError;
            else Error = null;
        }
        else _embedded.Stop();
        Agent = _embedded.Status(on);
        _lastAgentCheck = DateTime.UtcNow;
        Publish();
    }

    /// <summary>
    /// Downloads the newest app (with its agent), checks it against
    /// SHA256SUMS.txt, unpacks it next to this copy and lets a hidden helper
    /// swap it in after the app quits; the app then starts again by itself.
    /// </summary>
    private async void UpdateApp()
    {
        if (InstallerRunning) return;
        _installerLog.Clear();
        InstallerSucceeded = null;
        InstallerRunning = true;
        AddInstallerLine("Yeni sürüm aranıyor…");
        Publish();
        var temp = Path.Combine(Path.GetTempPath(), "wecommander-update-" + Guid.NewGuid().ToString("N"));
        try
        {
            var latest = Core.AppUpdate.Latest(await ReleasesJsonAsync())
                ?? throw new InvalidOperationException("Yayımlanmış bir sürüm bulunamadı.");
            _latestApp = latest;
            LastReleaseRead = DateTime.Now;
            if (AppBuild is { } current && latest.Build <= current)
            {
                AddInstallerLine($"Uygulama güncel (0.1.{current}).");
                InstallerSucceeded = true;
                return;
            }
            Directory.CreateDirectory(temp);
            AddInstallerLine($"0.1.{latest.Build} indiriliyor…");
            Publish();
            var zip = Path.Combine(temp, Core.AppUpdate.ZipAsset);
            using (var download = await Http.GetAsync(latest.ZipUrl, HttpCompletionOption.ResponseHeadersRead))
            {
                download.EnsureSuccessStatusCode();
                await using var file = File.Create(zip);
                await download.Content.CopyToAsync(file);
            }
            var sums = await Http.GetStringAsync(latest.SumsUrl);
            var expected = Core.AppUpdate.ExpectedHash(sums, Core.AppUpdate.ZipAsset)
                ?? throw new InvalidOperationException("Sağlama listesinde bu paket yok; güncelleme durduruldu.");
            string actual;
            await using (var read = File.OpenRead(zip)) actual = Convert.ToHexString(await SHA256.HashDataAsync(read)).ToLowerInvariant();
            if (actual != expected) throw new InvalidOperationException("İndirilen paket doğrulanamadı (SHA-256 uyuşmuyor); güncelleme durduruldu.");
            AddInstallerLine("SHA-256 doğrulandı. Hazırlanıyor…");
            Publish();

            var appDir = AppContext.BaseDirectory.TrimEnd('\\', '/');
            var staged = appDir + ".update";
            if (Directory.Exists(staged)) Directory.Delete(staged, true);
            ZipFile.ExtractToDirectory(zip, staged);
            foreach (var needed in new[] { "WecommanderCenter.exe", EmbeddedAgent.ExeName, "wecommander-core.exe" })
                if (!File.Exists(Path.Combine(staged, needed)))
                    throw new InvalidOperationException($"Pakette {needed} yok; güncelleme durduruldu.");

            var script = Path.Combine(Path.GetTempPath(), "wecommander-swap-" + Guid.NewGuid().ToString("N") + ".ps1");
            await File.WriteAllTextAsync(script, Core.AppUpdate.SwapScript(appDir, staged, Environment.ProcessId, UpdateFailFile));
            var info = new ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                // Not the app folder: a process in it would block the swap.
                WorkingDirectory = Path.GetTempPath(),
            };
            foreach (var a in new[] { "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", script })
                info.ArgumentList.Add(a);
            Process.Start(info)?.Dispose();
            AddInstallerLine("Uygulama yeniden başlatılıyor…");
            InstallerSucceeded = true;
            Publish();
            await Task.Delay(500);
            Quit();
        }
        catch (Exception e)
        {
            InstallerSucceeded = false;
            AddInstallerLine(e.Message);
            Toast("Güncelleme tamamlanamadı; ayrıntı panelde.");
        }
        finally
        {
            try { Directory.Delete(temp, true); } catch (Exception) { }
            InstallerRunning = false;
            Publish();
        }
    }
}
