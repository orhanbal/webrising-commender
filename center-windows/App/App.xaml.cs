using H.NotifyIcon;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Windows.AppLifecycle;
using Microsoft.Windows.AppNotifications;
using Microsoft.Windows.AppNotifications.Builder;
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
    private TaskbarIcon? _tray;
    private MenuFlyoutItem? _pendingItem, _autonomyItem, _stopAutonomyItem, _accountItem, _allowNotifyItem;
    private ToggleMenuFlyoutItem? _notifyItem;
    private DispatcherQueueTimer? _timer;
    private DateTime _lastSync = DateTime.MinValue;
    private bool _syncing;
    private readonly HashSet<string> _seen = [];
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
    public DateTime? LastSync => _lastSync == DateTime.MinValue ? null : _lastSync;

    /// <summary>Windows' own notification setting for this app (Settings, System, Notifications).</summary>
    public AppNotificationSetting NotificationSetting { get; private set; } = AppNotificationSetting.Enabled;

    /// <summary>True when the owner wants notifications but Windows will not show them.</summary>
    public bool NotificationsBlocked => Settings.Notifications && NotificationSetting is
        AppNotificationSetting.DisabledForApplication or AppNotificationSetting.DisabledForUser or
        AppNotificationSetting.DisabledByGroupPolicy or AppNotificationSetting.DisabledByManifest;

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

        // Notification buttons arrive here while the app runs. Must be set
        // before Register().
        AppNotificationManager.Default.NotificationInvoked += (_, e) =>
            _ui.TryEnqueue(() => HandleNotification(e.Arguments));
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "icon.png");
        AppNotificationManager.Default.Register("WECOMMANDER Yönetim Merkezi", new Uri(icon));
        RefreshNotificationSetting();

        // A second start is redirected here (see Program).
        AppInstance.GetCurrent().Activated += (_, e) => _ui.TryEnqueue(() => HandleActivation(e));

        _window = new MainWindow();
        BuildTray();

        var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
        var hidden = Environment.GetCommandLineArgs().Contains("--hidden");
        if (activation.Kind == ExtendedActivationKind.AppNotification)
            HandleNotification(((AppNotificationActivatedEventArgs)activation.Data).Arguments);
        else if (!hidden || Token is null)
            _window.ShowPanel();

        _timer = _ui.CreateTimer();
        _timer.Interval = TimeSpan.FromSeconds(2);
        _timer.Tick += async (_, _) => await TickAsync();
        _timer.Start();
        _ = TickAsync();
        Publish();
    }

    private void HandleActivation(AppActivationArguments e)
    {
        if (e.Kind == ExtendedActivationKind.AppNotification)
            HandleNotification(((AppNotificationActivatedEventArgs)e.Data).Arguments);
        else
            _window?.ShowPanel();
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

    private static void Toast(string text) =>
        AppNotificationManager.Default.Show(new AppNotificationBuilder().AddText("WECOMMANDER").AddText(text).BuildNotification());

    /// <summary>One request as a Windows notification with Approve / Deny that stays until answered.</summary>
    private void NotifyRequest(ApprovalRequest item, string device)
    {
        var what = string.IsNullOrEmpty(item.Summary) ? Texts.KindLabel(item.ActionKind) : item.Summary;
        var builder = new AppNotificationBuilder()
            .AddArgument("action", "open")
            .AddText($"Onay bekliyor · {device}")
            .AddText(what)
            .AddText($"{Texts.KindLabel(item.ActionKind)} · yalnız bu işlem, bir kez")
            // Urgent (Windows 11 22H2+) shows the banner even with Do not disturb
            // on; elsewhere Reminder keeps it on screen until answered.
            .SetScenario(AppNotificationBuilder.IsUrgentScenarioSupported() ? AppNotificationScenario.Urgent : AppNotificationScenario.Reminder)
            .AddButton(new AppNotificationButton("Onayla").AddArgument("action", "approve").AddArgument("id", item.Id).AddArgument("device", device))
            .AddButton(new AppNotificationButton("Reddet").AddArgument("action", "deny").AddArgument("id", item.Id).AddArgument("device", device));
        var notification = builder.BuildNotification();
        notification.Tag = item.Id;
        notification.Group = NotificationGroup;
        notification.Priority = AppNotificationPriority.High;
        AppNotificationManager.Default.Show(notification);
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
        }
        finally { _syncing = false; }
    }

    public void RequestSync() => _lastSync = DateTime.MinValue;

    public async Task SyncAsync()
    {
        if (Token is not { } token) return;
        var gateway = Gateway;
        try
        {
            Me ??= await gateway.MeAsync(token);
            var pending = gateway.PendingAsync(token);
            var devices = gateway.DevicesAsync(token);
            var autonomy = gateway.AutonomyAsync(token);
            await Task.WhenAll(pending, devices, autonomy);
            var previous = Pending.Select(p => p.Id).ToHashSet();
            Pending = pending.Result;
            Devices = devices.Result;
            Autonomy = autonomy.Result;
            Error = null;
            _lastSync = DateTime.UtcNow;

            // Requests decided elsewhere (panel, dashboard, another center) or
            // expired: take their notification away.
            foreach (var gone in previous.Except(Pending.Select(p => p.Id)))
                _ = AppNotificationManager.Default.RemoveByTagAndGroupAsync(gone, NotificationGroup);

            var fresh = Pending.Where(p => _seen.Add(p.Id)).ToList();
            if (fresh.Count > 0)
            {
                if (Settings.Notifications)
                {
                    var names = Devices.ToDictionary(d => d.Id, d => d.Name);
                    foreach (var item in fresh.Take(5))
                        NotifyRequest(item, names.GetValueOrDefault(item.DeviceId, "bilinmeyen cihaz"));
                }
                // Owner request: the panel opens by itself on the Approvals tab
                // when a request arrives (the notification comes as well). If
                // Windows blocks our notifications, the panel is the only way
                // the owner sees the request, so it opens regardless.
                if (Settings.OpenOnRequest || NotificationsBlocked)
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

    public async Task DecideAsync(string id, bool approve)
    {
        if (Token is not { } token) throw new GatewayException(GatewayErrorKind.Unauthorized, 401, "", "Önce oturum aç.");
        try
        {
            await Gateway.DecideAsync(token, id, approve);
            _ = AppNotificationManager.Default.RemoveByTagAndGroupAsync(id, NotificationGroup);
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
        Error = message;
        LocalStore.DeleteToken();
        _ = AppNotificationManager.Default.RemoveByGroupAsync(NotificationGroup);
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
        AppNotificationSetting current;
        try { current = AppNotificationManager.Default.Setting; }
        catch (Exception) { current = AppNotificationSetting.Unsupported; }
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
        menu.Items.Add(new MenuFlyoutItem { Text = "Yönetim Merkezini aç", Command = new RelayCommand(() => _window?.ShowPanel()) });
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(_pendingItem);
        menu.Items.Add(_autonomyItem);
        menu.Items.Add(_stopAutonomyItem);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(new MenuFlyoutItem { Text = "Paneli tarayıcıda aç", Command = new RelayCommand(OpenDashboard) });
        menu.Items.Add(_notifyItem);
        menu.Items.Add(_allowNotifyItem);
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
    }

    private void Quit()
    {
        _timer?.Stop();
        AppNotificationManager.Default.Unregister();
        _tray?.Dispose();
        _window?.Quit();
        Exit();
    }
}
