using H.NotifyIcon;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Windows.AppLifecycle;
using Microsoft.Win32;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;
using Wecommander.Center.Core;

namespace Wecommander.Center;

public enum Phase { SignedOut, Linking, SignedIn }

/// <summary>
/// The Management Center: signs in through the browser, keeps the pending
/// approvals, devices and autonomous mode in sync every few seconds, shows a
/// Windows notification with Approve / Deny for each new request, and owns
/// the tray icon and the panel. All state lives on the UI thread.
/// </summary>
public partial class App : Application
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };
    private static readonly TimeSpan SyncEvery = TimeSpan.FromSeconds(4);
    private const string NotificationGroup = "approvals";

    private readonly SettingsStore _settingsStore = new(LocalStore.Directory);
    private DispatcherQueue _ui = null!;
    private MainWindow? _window;
    /// <summary>SSH, SFTP and tunnels (wecommander-core), for the app's lifetime.</summary>
    public ServersController Servers { get; } = new();
    private ServersWindow? _servers;
    private MenuFlyoutSubItem? _connectMenu, _tunnelMenu;
    private TaskbarIcon? _tray;
    private MenuFlyoutItem? _pendingItem, _autonomyItem, _stopAutonomyItem, _accountItem, _allowNotifyItem;
    private ToggleMenuFlyoutItem? _notifyItem, _agentItem;
    private readonly AgentControl _agent = new(new ProcessRunner(),
        System.Security.Principal.WindowsIdentity.GetCurrent().User?.Value ?? "");
    private readonly AgentWatchdog _watchdog = new();
    private DateTime _lastAgentCheck = DateTime.MinValue;
    private bool _agentBusy;
    private bool _serviceStopNoticeShown;
    private DispatcherQueueTimer? _timer;
    private DateTime _lastSync = DateTime.MinValue;
    private bool _syncing;
    private readonly HashSet<string> _seen = [];
    // Requests this app approved or denied, so they are not announced as
    // "decided elsewhere" when they leave the pending list.
    private readonly HashSet<string> _decidedHere = [];
    // Requests whose notification is on screen, for the live countdown.
    private readonly Dictionary<string, (DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt, uint Sequence)> _shown = [];
    private DispatcherQueueTimer? _countdownTimer;
    private (string Id, string Secret, string Url, DateTime Deadline)? _link;

    public Settings Settings { get; private set; } = new();
    public string? Token { get; private set; }
    public Phase Phase => Token is not null ? Phase.SignedIn : _link is not null ? Phase.Linking : Phase.SignedOut;
    public string? ApproveUrl => _link?.Url;
    public CenterMe? Me { get; private set; }
    public IReadOnlyList<ApprovalRequest> Pending { get; private set; } = [];
    public IReadOnlyList<Device> Devices { get; private set; } = [];
    public IReadOnlyList<AutonomyItem> Autonomy { get; private set; } = [];
    public string? Error { get; set; }
    /// <summary>The WECOMMANDER agent on this computer (null until first read).</summary>
    public AgentStatus? Agent { get; private set; }
    public bool AgentBusy => _agentBusy;
    /// <summary>Installed agent version ("0.1.1651"), read every few minutes.</summary>
    public string? AgentVersion { get; private set; }
    /// <summary>Newest published agent build (the N of 0.1.N), checked every 6 hours.</summary>
    public int? LatestAgentBuild { get; private set; }
    public bool AgentUpdateAvailable => Embedded ? AppUpdateAvailable : AgentUpdate.IsNewer(LatestAgentBuild, AgentVersion);
    private DateTime _lastReleaseCheck = DateTime.MinValue;
    private int? _announcedBuild;
    private DateTime _lastVersionCheck = DateTime.MinValue;

    /// <summary>Installer output shown in the agent card (newest last).</summary>
    public IReadOnlyList<string> InstallerLog => _installerLog;
    private readonly List<string> _installerLog = [];
    public bool InstallerRunning { get; private set; }
    /// <summary>null while running or never run; true when the last run ended well.</summary>
    public bool? InstallerSucceeded { get; private set; }

    public void ClearInstallerLog()
    {
        if (InstallerRunning) return;
        _installerLog.Clear();
        InstallerSucceeded = null;
        Publish();
    }

    /// <summary>
    /// Runs the official agent installer without a window and shows its output
    /// in the agent card ("mini terminal"); Windows still asks for UAC.
    /// </summary>
    public async void UpdateAgent()
    {
        if (Embedded) { UpdateApp(); return; }
        if (InstallerRunning) return;
        try
        {
            // Signed in: a one-time pairing code goes with every install and
            // update, so the installer never asks for a second browser sign-in
            // (it uses the code only if the existing pairing cannot be kept).
            string? code = null;
            if (Token is { } token)
            {
                try { code = await Gateway.PairingCodeAsync(token); }
                catch (GatewayException) { /* the installer falls back to account sign-in */ }
            }
            _installerLog.Clear();
            InstallerSucceeded = null;
            InstallerRunning = true;
            AddInstallerLine(Agent is { State: AgentRunState.NotInstalled } ? "Ajan kurulumu başladı (bu hesapla otomatik bağlanacak)…" : "Ajan güncellemesi başladı…");
            Publish();

            using var process = new System.Diagnostics.Process { StartInfo = AgentControl.InstallerStartInfo(Settings.Server, code) };
            process.OutputDataReceived += (_, e) => OnInstallerOutput(e.Data);
            process.ErrorDataReceived += (_, e) => OnInstallerOutput(e.Data);
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync();
            InstallerSucceeded = process.ExitCode == 0;
            AddInstallerLine(InstallerSucceeded == true ? "Tamamlandı." : $"Kurulum bitmedi (çıkış kodu {process.ExitCode}).");
            Toast(InstallerSucceeded == true ? "Ajan kurulumu/güncellemesi tamamlandı." : "Ajan kurulumu tamamlanamadı; ayrıntı Cihazlar sekmesinde.");
        }
        catch (Exception e)
        {
            InstallerSucceeded = false;
            AddInstallerLine(e.Message);
        }
        finally
        {
            InstallerRunning = false;
            _lastVersionCheck = DateTime.MinValue;
            Publish();
            await CheckAgentAsync();
        }
    }

    private void OnInstallerOutput(string? data)
    {
        if (AgentControl.InstallerLine(data) is not { } line) return;
        _ui.TryEnqueue(() => { AddInstallerLine(line); Publish(); });
    }

    private void AddInstallerLine(string line)
    {
        _installerLog.Add(line);
        if (_installerLog.Count > 200) _installerLog.RemoveAt(0);
    }

    public DateTime? LastSync => _lastSync == DateTime.MinValue ? null : _lastSync;

    /// <summary>Windows' own notification setting for this app (Settings, System, Notifications).</summary>
    public NotificationSetting NotificationSetting { get; private set; } = NotificationSetting.Enabled;

    /// <summary>True when the owner wants notifications but Windows will not show them.</summary>
    public bool NotificationsBlocked => Settings.Notifications && NotificationSetting is
        NotificationSetting.DisabledForApplication or NotificationSetting.DisabledForUser or
        NotificationSetting.DisabledByGroupPolicy or NotificationSetting.DisabledByManifest;

    private ToastNotifier? _notifier;
    private ToastNotifier Notifier => _notifier ??= ToastNotificationManager.CreateToastNotifier(Program.AppUserModelId);

    /// <summary>Raised on the UI thread after every state change.</summary>
    public event Action? Changed;

    public static new App Current => (App)Application.Current;

    public App()
    {
        InitializeComponent();
    }

    private GatewayClient Gateway => new(Http, Settings.Server);

    protected override void OnLaunched(Microsoft.UI.Xaml.LaunchActivatedEventArgs args)
    {
        _ui = DispatcherQueue.GetForCurrentThread();
        var (settings, existed) = _settingsStore.Load();
        Settings = settings;
        if (!existed)
        {
            _settingsStore.Save(Settings);
            LocalStore.AutostartEnabled = true; // first start: come back after each sign-in
        }
        Token = LocalStore.LoadToken(Settings.Server);

        RegisterNotificationIdentity();
        RefreshNotificationSetting();

        // A second start is redirected here (see Program).
        AppInstance.GetCurrent().Activated += (_, e) => _ui.TryEnqueue(() => HandleActivation(e));

        // WebView2 keeps its profile outside the app folder, so its helper
        // processes never hold files that an update has to replace.
        Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WECOMMANDER", "WebView2"));
        _window = new MainWindow();
        BuildTray();
        Servers.Changed += () => _ui.TryEnqueue(UpdateServersMenu);
        Servers.Start();
        StartEmbeddedAgent();

        var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
        var hidden = Environment.GetCommandLineArgs().Contains("--hidden");
        // Opened by the person: the main window (hosts and terminals); not
        // signed in yet: the sign-in panel. At login (--hidden) only the tray.
        if (Environment.GetCommandLineArgs().Contains("--open-main")) ShowServers(); // CI smoke test
        else if (Token is null) _window.ShowPanel();
        else if (!hidden) ShowServers();

        _timer = _ui.CreateTimer();
        _timer.Interval = TimeSpan.FromSeconds(2);
        _timer.Tick += async (_, _) => await TickAsync();
        _timer.Start();
        _ = TickAsync();
        Publish();
    }

    /// <summary>Started again (Start menu, shortcut): the main window; signed out: the sign-in panel.</summary>
    private void HandleActivation(AppActivationArguments e)
    {
        if (Token is null) _window?.ShowPanel();
        else ShowServers();
    }

    /// <summary>The Management Center panel (approvals, autonomous mode, this computer, settings).</summary>
    public void ShowPanel() => _window?.ShowPanel();

    /// <summary>
    /// Registers app.wecommander.center (name and icon shown on the
    /// notification and in Settings) for the current user; no admin rights.
    /// </summary>
    private static void RegisterNotificationIdentity()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey($@"Software\Classes\AppUserModelId\{Program.AppUserModelId}");
            key.SetValue("DisplayName", "WECOMMANDER Yönetim Merkezi");
            var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "icon.png");
            if (File.Exists(icon)) key.SetValue("IconUri", icon);
        }
        catch (Exception) { /* notifications still work, with a generic name */ }
    }

    /// <summary>Shows a toast; its body and buttons come back through Activated while the app runs.</summary>
    private void ShowToast(string xml, string? tag = null, NotificationData? data = null, DateTimeOffset? expires = null)
    {
        var doc = new XmlDocument();
        doc.LoadXml(xml);
        var toast = new ToastNotification(doc);
        if (tag is not null) { toast.Tag = tag; toast.Group = NotificationGroup; }
        if (data is not null) toast.Data = data;
        if (expires is { } e && e > DateTimeOffset.UtcNow) toast.ExpirationTime = e;
        toast.Activated += (_, args) =>
        {
            if (args is ToastActivatedEventArgs a)
            {
                var parsed = ToastContent.DecodeArgs(a.Arguments);
                _ui.TryEnqueue(() => HandleNotification(parsed));
            }
        };
        try { Notifier.Show(toast); }
        catch (Exception) { /* Windows refused (blocked or unavailable): the panel still has the request */ }
    }

    private void RemoveToast(string tag)
    {
        try { ToastNotificationManager.History.Remove(tag, NotificationGroup, Program.AppUserModelId); }
        catch (Exception) { }
    }

    private async void HandleNotification(IDictionary<string, string> arguments)
    {
        arguments.TryGetValue("action", out var action);
        arguments.TryGetValue("id", out var id);
        if (action is "approve" or "deny" && id is not null)
        {
            var approve = action == "approve";
            var device = arguments.TryGetValue("device", out var d) ? d : "";
            try
            {
                await DecideAsync(id, approve);
                Toast($"{device} · {(approve ? "onaylandı, yapay zekâ bir kez çalıştırabilir" : "reddedildi")}");
            }
            catch (GatewayException e)
            {
                Toast(e.Message);
            }
        }
        else
        {
            _window?.ShowPanel();
        }
    }

    private void Toast(string text) => ShowToast(ToastContent.Simple("WECOMMANDER", text));

    /// <summary>Shows a notification on demand so the owner can see where approvals will appear.</summary>
    public void SendTestNotification() =>
        ShowToast(ToastContent.Simple(Texts.NotificationTestTitle, Texts.NotificationTestText));

    /// <summary>
    /// Once per install, right after sign-in: a first notification, so Windows
    /// asks now whether to allow ours instead of on the first real request.
    /// </summary>
    private void ShowNotificationIntroOnce()
    {
        if (Settings.NotificationIntroShown || !Settings.Notifications) return;
        ShowToast(ToastContent.Simple(Texts.NotificationIntroTitle, Texts.NotificationIntroText));
        Settings.NotificationIntroShown = true;
        SaveSettings();
    }

    /// <summary>One request as a Windows notification with Approve / Deny that stays until answered.</summary>
    private void NotifyRequest(ApprovalRequest item, string device)
    {
        var what = string.IsNullOrEmpty(item.Summary) ? Texts.KindLabel(item.ActionKind) : item.Summary;
        // Urgent (Windows 11 22H2, build 22621+) breaks through Do not disturb.
        var urgent = Environment.OSVersion.Version.Build >= 22621;
        ShowToast(ToastContent.Approval(item.Id, device, what, Texts.KindLabel(item.ActionKind), urgent),
            item.Id, CountdownData(item.CreatedAt, item.ExpiresAt, 1), item.ExpiresAt.AddSeconds(30));
        _shown[item.Id] = (item.CreatedAt, item.ExpiresAt, 1);
        StartCountdown();
    }

    private static NotificationData CountdownData(DateTimeOffset createdAt, DateTimeOffset expiresAt, uint sequence)
    {
        var data = new NotificationData { SequenceNumber = sequence };
        foreach (var (key, value) in ToastContent.Countdown(createdAt, expiresAt, DateTimeOffset.UtcNow))
            data.Values[key] = value;
        return data;
    }

    private void StartCountdown()
    {
        if (_countdownTimer is null)
        {
            _countdownTimer = _ui.CreateTimer();
            _countdownTimer.Interval = TimeSpan.FromSeconds(1);
            _countdownTimer.Tick += async (_, _) => await UpdateCountdownsAsync();
        }
        if (!_countdownTimer.IsRunning) _countdownTimer.Start();
    }

    /// <summary>Moves every on-screen countdown one second on; drops dismissed and expired ones.</summary>
    private async Task UpdateCountdownsAsync()
    {
        if (_shown.Count == 0) { _countdownTimer?.Stop(); return; }
        foreach (var (id, (created, expires, sequence)) in _shown.ToList())
        {
            var next = sequence + 1;
            _shown[id] = (created, expires, next);
            NotificationUpdateResult result;
            try { result = Notifier.Update(CountdownData(created, expires, next), id, NotificationGroup); }
            catch (Exception) { result = NotificationUpdateResult.NotificationNotFound; }
            // Dismissed by the owner, or answered here: stop updating it.
            if (result != NotificationUpdateResult.Succeeded) { _shown.Remove(id); continue; }
            if (expires <= DateTimeOffset.UtcNow.AddSeconds(-5))
            {
                // Leave "Süresi doldu" visible a moment, then take it away.
                _shown.Remove(id);
                RemoveToast(id);
            }
        }
        await Task.CompletedTask;
    }

    private async Task TickAsync()
    {
        if (_syncing) return;
        _syncing = true;
        try
        {
            // The owner can turn notifications off (or back on) in Windows at
            // any time; pick that up without a restart.
            if (RefreshNotificationSetting()) Publish();
            if (_link is not null) await PollLinkAsync();
            else if (Token is not null && DateTime.UtcNow - _lastSync >= SyncEvery) await SyncAsync();
            if (DateTime.UtcNow - _lastAgentCheck >= TimeSpan.FromSeconds(10)) await CheckAgentAsync();
        }
        finally { _syncing = false; }
    }

    public void RequestSync() => _lastSync = DateTime.MinValue;

    /// <summary>
    /// Reads the agent's state and, while "Ajan çalışsın" is on, starts it
    /// again when it stopped (scheduled task: no prompt). A Windows service is
    /// not restarted silently, since that needs a UAC prompt: the owner gets a
    /// notification instead.
    /// </summary>
    private async Task CheckAgentAsync()
    {
        if (_agentBusy) return;
        _lastAgentCheck = DateTime.UtcNow;
        if (Embedded) { await CheckEmbeddedAsync(); return; }
        AgentStatus status;
        try { status = await _agent.StatusAsync(); }
        catch (Exception) { return; }
        var changed = status != Agent;
        Agent = status;
        if (status.State != AgentRunState.NotInstalled && DateTime.UtcNow - _lastVersionCheck >= TimeSpan.FromMinutes(5))
        {
            _lastVersionCheck = DateTime.UtcNow;
            var version = await _agent.InstalledVersionAsync();
            if (version != AgentVersion) { AgentVersion = version; changed = true; }
        }
        if (status.State != AgentRunState.NotInstalled && DateTime.UtcNow - _lastReleaseCheck >= TimeSpan.FromHours(6))
        {
            _lastReleaseCheck = DateTime.UtcNow;
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, AgentUpdate.ReleasesUrl);
                request.Headers.UserAgent.ParseAdd("WECOMMANDER-Center");
                request.Headers.Accept.ParseAdd("application/vnd.github+json");
                using var response = await Http.SendAsync(request);
                if (response.IsSuccessStatusCode && AgentUpdate.LatestWindowsBuild(await response.Content.ReadAsStringAsync()) is { } latest)
                {
                    if (latest != LatestAgentBuild) { LatestAgentBuild = latest; changed = true; }
                }
            }
            catch (Exception) { _lastReleaseCheck = DateTime.UtcNow - TimeSpan.FromHours(5); /* retry in an hour */ }
            if (AgentUpdateAvailable && _announcedBuild != LatestAgentBuild)
            {
                _announcedBuild = LatestAgentBuild;
                Toast($"Ajan için yeni sürüm var (0.1.{LatestAgentBuild}). Yönetim Merkezinde \"Ajanı güncelle\" ile kurabilirsin.");
            }
        }
        if (status.Running) _serviceStopNoticeShown = false;
        if (status.Mode == AgentMode.Service)
        {
            if (!status.Running && Settings.AgentKeepRunning && status.Enabled && !_serviceStopNoticeShown)
            {
                _serviceStopNoticeShown = true;
                Toast(Texts.AgentServiceStoppedText);
            }
        }
        else
        {
            // While the installer runs, Setup stops the agent on purpose; a
            // restart here would hold the files Setup is replacing.
            switch (InstallerRunning ? WatchdogAction.None : _watchdog.Next(Settings.AgentKeepRunning && status.Enabled, status, DateTimeOffset.UtcNow))
            {
                case WatchdogAction.Start:
                    try
                    {
                        await _agent.SetEnabledAsync(true);
                        Agent = await _agent.StatusAsync();
                        if (Agent.Running) Toast(Texts.AgentRestartedText);
                    }
                    catch (Exception) { /* next check tries again, then gives up */ }
                    changed = true;
                    break;
                case WatchdogAction.GiveUp:
                    Toast(Texts.AgentGaveUpText);
                    break;
            }
        }
        if (changed) Publish();
    }

    /// <summary>"Ajan çalışsın" in the panel and the tray menu.</summary>
    public async Task SetAgentEnabledAsync(bool on)
    {
        if (Embedded) { SetEmbeddedEnabled(on); return; }
        if (_agentBusy) return;
        _agentBusy = true;
        Publish();
        try
        {
            await _agent.SetEnabledAsync(on);
            Settings.AgentKeepRunning = on;
            SaveSettings();
            _watchdog.Reset();
            // A started agent needs a moment before its process shows up.
            for (var i = 0; i < 10; i++)
            {
                Agent = await _agent.StatusAsync();
                if (Agent.Running == on) break;
                await Task.Delay(500);
            }
            Error = null;
        }
        catch (Exception e)
        {
            Error = e.Message;
        }
        finally
        {
            _agentBusy = false;
            _lastAgentCheck = DateTime.UtcNow;
            Publish();
        }
    }

    public async Task SyncAsync()
    {
        if (Token is not { } token) return;
        var gateway = Gateway;
        try
        {
            Me ??= await gateway.MeAsync(token);
            ShowNotificationIntroOnce();
            var pending = gateway.PendingAsync(token);
            var devices = gateway.DevicesAsync(token);
            var autonomy = gateway.AutonomyAsync(token);
            await Task.WhenAll(pending, devices, autonomy);
            var previous = Pending.ToDictionary(p => p.Id);
            Pending = pending.Result;
            Devices = devices.Result;
            Autonomy = autonomy.Result;
            Error = null;
            _lastSync = DateTime.UtcNow;

            // Requests decided elsewhere (panel, dashboard, another center) or
            // expired: take their notification away, and say where one was
            // decided ("macOS'tan onaylandı").
            var gone = previous.Keys.Except(Pending.Select(p => p.Id)).ToList();
            foreach (var id in gone)
            {
                _shown.Remove(id);
                RemoveToast(id);
            }
            AnnounceDecidedElsewhere(gone.Select(id => previous[id]).ToList(), token);

            var fresh = Pending.Where(p => _seen.Add(p.Id)).ToList();
            if (fresh.Count > 0)
            {
                if (Settings.Notifications)
                {
                    var names = Devices.ToDictionary(d => d.Id, d => d.Name);
                    foreach (var item in fresh.Take(5))
                        NotifyRequest(item, names.GetValueOrDefault(item.DeviceId, "bilinmeyen cihaz"));
                }
                // By default only the small Windows notification appears. The
                // panel opens by itself when the owner asked for it, or when no
                // notification can be shown (blocked in Windows or turned off
                // here), since otherwise the request would go unseen.
                if (Settings.OpenOnRequest || NotificationsBlocked || !Settings.Notifications)
                {
                    _window?.ShowApprovals();
                }
            }
        }
        catch (GatewayException e) when (e.Kind == GatewayErrorKind.Unauthorized)
        {
            SignOutLocally(e.Message);
        }
        catch (GatewayException e)
        {
            Error = e.Message;
            _lastSync = DateTime.UtcNow;
        }
        Publish();
    }

    public async Task StartLinkAsync(string server, string name)
    {
        var normalized = ServerUrl.Normalize(server);
        name = new string(name.Trim().Where(c => !char.IsControl(c) && c is not '<' and not '>').Take(80).ToArray());
        if (name.Length == 0) name = "Yönetim Merkezi";
        Settings.Server = normalized;
        _settingsStore.Save(Settings);
        var start = await Gateway.LinkStartAsync(name);
        _link = (start.RequestId, start.RequestSecret, start.ApproveUrl, DateTime.UtcNow.AddSeconds(Math.Min(start.ExpiresInSeconds, 600)));
        Error = null;
        OpenUrl(start.ApproveUrl);
        Publish();
    }

    public void CancelLink()
    {
        _link = null;
        Publish();
    }

    private async Task PollLinkAsync()
    {
        if (_link is not { } link) return;
        if (DateTime.UtcNow > link.Deadline)
        {
            _link = null;
            Error = "Oturum açma isteğinin süresi doldu. Yeniden dene.";
            Publish();
            return;
        }
        try
        {
            var poll = await Gateway.LinkPollAsync(link.Id, link.Secret);
            switch (poll.Status)
            {
                case "approved" when poll.CenterToken is { } token:
                    _link = null;
                    Token = token;
                    LocalStore.SaveToken(Settings.Server, token);
                    Toast("Yönetim Merkezi hesabına bağlandı.");
                    _window?.ShowPanel();
                    await SyncAsync();
                    await EnsurePairedAsync();
                    break;
                case "pending":
                    break;
                default:
                    _link = null;
                    Error = "Oturum açma isteği geçersiz ya da kullanılmış. Yeniden dene.";
                    Publish();
                    break;
            }
        }
        catch (GatewayException e)
        {
            Error = e.Message;
            Publish();
        }
    }

    private void AnnounceDecidedElsewhere(List<ApprovalRequest> items, string token)
    {
        var others = items.Where(item => !_decidedHere.Remove(item.Id)).ToList();
        if (!Settings.Notifications || others.Count == 0) return;
        var gateway = Gateway;
        var names = Devices.ToDictionary(d => d.Id, d => d.Name);
        foreach (var item in others.Take(5))
        {
            var device = names.GetValueOrDefault(item.DeviceId, "bilinmeyen cihaz");
            var what = string.IsNullOrEmpty(item.Summary) ? Texts.KindLabel(item.ActionKind) : item.Summary;
            _ = AnnounceAsync(item.Id, device, what);
        }

        async Task AnnounceAsync(string id, string device, string what)
        {
            try
            {
                var outcome = await gateway.OutcomeAsync(token, id);
                if (Texts.DecidedElsewhere(outcome) is { } text)
                    ShowToast(ToastContent.Simple($"{text} · {device}", what));
            }
            catch (GatewayException) { /* the request notification is already gone; nothing else to say */ }
        }
    }

    public async Task DecideAsync(string id, bool approve)
    {
        if (Token is not { } token) throw new GatewayException(GatewayErrorKind.Unauthorized, 401, "", "Önce oturum aç.");
        _decidedHere.Add(id);
        try
        {
            await Gateway.DecideAsync(token, id, approve);
            _shown.Remove(id);
            RemoveToast(id);
        }
        catch
        {
            _decidedHere.Remove(id);
            throw;
        }
        finally
        {
            await SyncAsync();
        }
    }

    public async Task StartAutonomyAsync(int? minutes, IReadOnlyList<string>? deviceIds, string password)
    {
        if (Token is not { } token) return;
        await Gateway.SetAutonomyAsync(token, true, minutes, deviceIds, password);
        await SyncAsync();
    }

    public async Task StopAutonomyAsync()
    {
        if (Token is not { } token) return;
        await Gateway.SetAutonomyAsync(token, false, null, null, null);
        await SyncAsync();
    }

    /// <summary>Revoke the token on the server and forget it here.</summary>
    public async Task SignOutAsync()
    {
        if (Token is { } token)
        {
            try { await Gateway.DisconnectAsync(token); } catch (GatewayException) { }
        }
        SignOutLocally(null);
        Publish();
    }

    private void SignOutLocally(string? message)
    {
        Token = null;
        Me = null;
        Pending = [];
        Devices = [];
        Autonomy = [];
        _seen.Clear();
        _shown.Clear();
        _decidedHere.Clear();
        Error = message;
        LocalStore.DeleteToken();
        try { ToastNotificationManager.History.RemoveGroup(NotificationGroup, Program.AppUserModelId); }
        catch (Exception) { }
    }

    public void SaveSettings() => _settingsStore.Save(Settings);

    public static void OpenUrl(string url) =>
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });

    public void OpenDashboard() => OpenUrl(Settings.Server + "/approvals");

    /// <summary>Opens Settings, System, Notifications, where the owner allows this app.</summary>
    public static void OpenNotificationSettings() => OpenUrl("ms-settings:notifications");

    /// <summary>Reads Windows' notification setting; returns true when it changed.</summary>
    private bool RefreshNotificationSetting()
    {
        NotificationSetting current;
        try { current = Notifier.Setting; }
        catch (Exception) { current = NotificationSetting.Enabled; }
        if (current == NotificationSetting) return false;
        NotificationSetting = current;
        return true;
    }

    public void Publish()
    {
        UpdateTray();
        Changed?.Invoke();
    }

    // ---- tray icon ----

    private static System.Drawing.Icon LoadIcon(string name) =>
        new(Path.Combine(AppContext.BaseDirectory, "Assets", name));

    private void BuildTray()
    {
        _pendingItem = new MenuFlyoutItem { Text = "Oturum açılmadı", Command = new RelayCommand(() => _window?.ShowPanel()) };
        _autonomyItem = new MenuFlyoutItem { Text = "Otonom mod kapalı", Command = new RelayCommand(() => _window?.ShowPanel()) };
        _stopAutonomyItem = new MenuFlyoutItem
        {
            Text = "Otonom modu durdur (tüm cihazlar)",
            IsEnabled = false,
            Command = new RelayCommand(async () =>
            {
                try
                {
                    await StopAutonomyAsync();
                    Toast("Otonom mod durduruldu. Onaylar yeniden isteniyor.");
                }
                catch (GatewayException e) { Toast(e.Message); }
            }),
        };
        _notifyItem = new ToggleMenuFlyoutItem
        {
            Text = "Bildirimler",
            IsChecked = Settings.Notifications,
            Command = new RelayCommand(() =>
            {
                Settings.Notifications = !Settings.Notifications;
                SaveSettings();
                Publish();
            }),
        };
        _allowNotifyItem = new MenuFlyoutItem
        {
            Text = "Windows bildirimlerine izin ver…",
            Visibility = Visibility.Collapsed,
            Command = new RelayCommand(OpenNotificationSettings),
        };
        _agentItem = new ToggleMenuFlyoutItem
        {
            Text = "Ajan çalışsın",
            IsChecked = Settings.AgentKeepRunning,
            Command = new RelayCommand(async () => await SetAgentEnabledAsync(!(Agent?.Running ?? false))),
        };
        _accountItem = new MenuFlyoutItem
        {
            Text = "Oturum aç…",
            Command = new RelayCommand(async () =>
            {
                if (Token is null) { _window?.ShowPanel(); return; }
                await SignOutAsync();
                Toast("Oturum kapatıldı. Yeniden açmak için tepsi simgesine tıkla.");
            }),
        };
        var menu = new MenuFlyout();
        menu.Items.Add(new MenuFlyoutItem { Text = "WECOMMANDER'ı aç", Command = new RelayCommand(ShowServers) });
        menu.Items.Add(new MenuFlyoutItem { Text = "Onaylar ve otonom mod", Command = new RelayCommand(() => _window?.ShowPanel()) });
        _connectMenu = new MenuFlyoutSubItem { Text = "Bağlan", IsEnabled = false };
        _tunnelMenu = new MenuFlyoutSubItem { Text = "Tüneller", IsEnabled = false };
        menu.Items.Add(_connectMenu);
        menu.Items.Add(_tunnelMenu);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(_pendingItem);
        menu.Items.Add(_autonomyItem);
        menu.Items.Add(_stopAutonomyItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(new MenuFlyoutItem { Text = "Paneli tarayıcıda aç", Command = new RelayCommand(OpenDashboard) });
        menu.Items.Add(_notifyItem);
        menu.Items.Add(_allowNotifyItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(_agentItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(_accountItem);
        menu.Items.Add(new MenuFlyoutItem { Text = "Çıkış", Command = new RelayCommand(Quit) });

        _tray = new TaskbarIcon
        {
            ToolTipText = "WECOMMANDER Yönetim Merkezi",
            Icon = LoadIcon("tray.ico"),
            ContextMenuMode = ContextMenuMode.PopupMenu,
            ContextFlyout = menu,
            NoLeftClickDelay = true,
            LeftClickCommand = new RelayCommand(() => _window?.TogglePanel()),
        };
        _tray.ForceCreate(enablesEfficiencyMode: false);
    }

    private void UpdateTray()
    {
        if (_tray is null) return;
        var signedIn = Token is not null;
        var pending = Pending.Count;
        var autonomy = Autonomy.Count;
        _tray.Icon = LoadIcon((autonomy > 0, pending > 0) switch
        {
            (false, false) => "tray.ico",
            (false, true) => "tray-pending.ico",
            (true, false) => "tray-autonomy.ico",
            (true, true) => "tray-autonomy-pending.ico",
        });
        var tooltip = !signedIn
            ? "WECOMMANDER Yönetim Merkezi — oturum açılmadı"
            : (pending == 0 ? "WECOMMANDER — bekleyen onay yok" : $"WECOMMANDER — {pending} bekleyen onay")
              + (autonomy > 0 ? $" · otonom mod açık ({autonomy} cihaz)" : "");
        _tray.ToolTipText = tooltip;
        _pendingItem!.Text = !signedIn ? "Oturum açılmadı" : pending == 0 ? "Bekleyen onay yok" : $"Bekleyen onaylar: {pending}";
        _autonomyItem!.Text = autonomy > 0 ? $"Otonom mod açık: {autonomy} cihaz" : "Otonom mod kapalı";
        _stopAutonomyItem!.IsEnabled = signedIn && autonomy > 0;
        _notifyItem!.IsChecked = Settings.Notifications;
        _allowNotifyItem!.Visibility = NotificationsBlocked ? Visibility.Visible : Visibility.Collapsed;
        if (NotificationsBlocked) _tray.ToolTipText = tooltip + " · Windows bildirimleri kapalı";
        _accountItem!.Text = !signedIn ? "Oturum aç…" : Me?.Email is { } email ? $"Oturumu kapat ({email})" : "Oturumu kapat";
        _agentItem!.Text = Agent is null ? "Ajan çalışsın" : $"Ajan çalışsın ({Texts.AgentStateLabel(Agent).ToLowerInvariant()})";
        _agentItem.IsChecked = Agent?.Running ?? Settings.AgentKeepRunning;
        _agentItem.IsEnabled = !_agentBusy && Agent is not null && Agent.State != AgentRunState.NotInstalled;
        if (Agent is { Running: false, State: not AgentRunState.NotInstalled }) _tray.ToolTipText += " · " + Texts.AgentStateLabel(Agent).ToLowerInvariant();
    }

    /// <summary>The Servers window (hosts, terminals, files, tunnels).</summary>
    public void ShowServers()
    {
        Servers.Start();
        _servers ??= new ServersWindow(Servers);
        _servers.ShowWindow();
    }

    private void UpdateServersMenu()
    {
        if (_connectMenu is null || _tunnelMenu is null) return;
        _connectMenu.Items.Clear();
        foreach (var host in Servers.Hosts)
        {
            var h = host;
            _connectMenu.Items.Add(new MenuFlyoutItem
            {
                Text = h.Label,
                Command = new RelayCommand(async () => { ShowServers(); await _servers!.OpenHost(h); }),
            });
        }
        _connectMenu.IsEnabled = Servers.Hosts.Count > 0;
        _tunnelMenu.Items.Clear();
        foreach (var tunnel in Servers.SavedTunnels)
        {
            var t = tunnel;
            _tunnelMenu.Items.Add(new ToggleMenuFlyoutItem
            {
                Text = $"{t.HostLabel}  {t.Local} → {t.Remote}",
                IsChecked = t.Running,
                Command = new RelayCommand(async () => await Servers.ToggleTunnel(t)),
            });
        }
        _tunnelMenu.IsEnabled = Servers.SavedTunnels.Count > 0;
        var running = Servers.SavedTunnels.Count(t => t.Running);
        if (_tray is not null && running > 0) _tray.ToolTipText = $"WECOMMANDER · {running} tünel açık";
    }

    private void Quit()
    {
        Servers.Dispose();
        _embedded.Dispose();
        _timer?.Stop();
        _tray?.Dispose();
        _window?.Quit();
        Exit();
    }
}
