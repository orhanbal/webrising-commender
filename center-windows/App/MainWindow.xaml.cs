using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Shapes;
using Windows.Graphics;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// The panel: opens on the right edge of the screen above the taskbar, like
/// the Windows notification center, and hides when it loses focus.
/// </summary>
public sealed partial class MainWindow : Window
{
    private static App Center => App.Current;
    private readonly DispatcherTimer _clock = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly List<(TextBlock Text, DateTimeOffset ExpiresAt)> _countdowns = [];
    private DateTime _hiddenAt = DateTime.MinValue;
    private bool _quitting, _rendering, _dialogOpen;

    public MainWindow()
    {
        InitializeComponent();
        AppWindow.Title = "WECOMMANDER Yönetim Merkezi";
        AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));
        AppWindow.IsShownInSwitchers = false;
        ExtendsContentIntoTitleBar = true;
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.IsResizable = false;
            presenter.IsMaximizable = false;
            presenter.IsMinimizable = false;
            presenter.IsAlwaysOnTop = true;
            presenter.SetBorderAndTitleBar(true, false);
        }
        AppWindow.Closing += (_, e) =>
        {
            if (_quitting) return;
            e.Cancel = true; // closing keeps the app in the tray; "Çıkış" quits
            HidePanel();
        };
        Activated += (_, e) =>
        {
            if (e.WindowActivationState == WindowActivationState.Deactivated && !_dialogOpen && AppWindow.IsVisible)
                HidePanel();
        };
        Root.KeyDown += (_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Escape) HidePanel();
        };
        Root.ActualThemeChanged += (_, _) => UpdateWordmark();
        UpdateWordmark();

        ServerBox.Text = Center.Settings.Server;
        NameBox.Text = Environment.MachineName;
        ErrorBar.Closed += (_, _) => Center.Error = null;
        _clock.Tick += (_, _) =>
        {
            foreach (var (text, expiresAt) in _countdowns) text.Text = Texts.Remaining(expiresAt, DateTimeOffset.UtcNow);
            UpdateStatus();
        };
        _clock.Start();
        Center.Changed += Render;
        Render();
    }

    private void UpdateWordmark()
    {
        var dark = Root.ActualTheme == ElementTheme.Dark;
        var file = dark ? "wordmark-light-text.png" : "wordmark-dark-text.png";
        Wordmark.Source = new BitmapImage(new Uri(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", file)));
    }

    // ---- placement ----

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    private void PlaceOnRightEdge()
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var scale = GetDpiForWindow(hwnd) / 96.0;
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var margin = (int)Math.Round(12 * scale);
        var width = Math.Min((int)Math.Round(400 * scale), area.Width - 2 * margin);
        var height = area.Height - 2 * margin;
        AppWindow.MoveAndResize(new RectInt32(area.X + area.Width - width - margin, area.Y + margin, width, height));
    }

    public void ShowPanel()
    {
        PlaceOnRightEdge();
        AppWindow.Show();
        Activate();
        Render();
    }

    public void HidePanel()
    {
        _hiddenAt = DateTime.UtcNow;
        AppWindow.Hide();
    }

    /// <summary>Tray click: open, or close when open. The click that just took the focus away does not reopen it.</summary>
    public void TogglePanel()
    {
        if (AppWindow.IsVisible) HidePanel();
        else if (DateTime.UtcNow - _hiddenAt > TimeSpan.FromMilliseconds(400)) ShowPanel();
    }

    public void Quit()
    {
        _quitting = true;
        Close();
    }

    // ---- rendering ----

    private static Brush ThemeBrush(string key) => (Brush)Application.Current.Resources[key];

    private void Render()
    {
        _rendering = true;
        try
        {
            var phase = Center.Phase;
            SignedOutPanel.Visibility = phase == Phase.SignedOut ? Visibility.Visible : Visibility.Collapsed;
            LinkingPanel.Visibility = phase == Phase.Linking ? Visibility.Visible : Visibility.Collapsed;
            SignedInPanel.Visibility = phase == Phase.SignedIn ? Visibility.Visible : Visibility.Collapsed;
            SignOutLink.Visibility = phase == Phase.SignedIn ? Visibility.Visible : Visibility.Collapsed;
            AccountText.Text = phase == Phase.SignedIn && Center.Me is { } me
                ? $"{me.Email}{(me.OrganizationName is { } org ? " · " + org : "")}"
                : "";
            ErrorBar.Message = Center.Error ?? "";
            ErrorBar.IsOpen = Center.Error is not null;
            AutonomyBar.IsOpen = phase == Phase.SignedIn && Center.Autonomy.Count > 0;
            AutonomyBar.Message = $"{Center.Autonomy.Count} cihazda onay istenmiyor.";
            if (phase == Phase.SignedIn)
            {
                RenderPending();
                RenderAutonomy();
                RenderDevices();
                NotifySwitch.IsOn = Center.Settings.Notifications;
                OpenSwitch.IsOn = Center.Settings.OpenOnRequest;
                AutostartSwitch.IsOn = LocalStore.AutostartEnabled;
                AboutText.Text = $"Sürüm {typeof(App).Assembly.GetName().Version?.ToString(3)}" +
                                 (Center.Me is { } m ? $" · bu merkez: {m.Name}" : "") + $" · {Center.Settings.Server}";
                ApprovalsTab.Text = Center.Pending.Count > 0 ? $"Onaylar ({Center.Pending.Count})" : "Onaylar";
            }
            UpdateStatus();
        }
        finally { _rendering = false; }
    }

    private void UpdateStatus()
    {
        StatusText.Text = Center.Phase == Phase.SignedIn && Center.LastSync is { } last
            ? $"Son eşitleme: {(int)(DateTime.UtcNow - last).TotalSeconds} sn önce"
            : "";
    }

    private void RenderPending()
    {
        _countdowns.Clear();
        PendingList.Children.Clear();
        PendingEmpty.Visibility = Center.Pending.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        var names = Center.Devices.ToDictionary(d => d.Id, d => d.Name);
        foreach (var item in Center.Pending)
        {
            var device = names.GetValueOrDefault(item.DeviceId, "bilinmeyen cihaz");
            var expired = item.ExpiresAt <= DateTimeOffset.UtcNow;
            var time = new TextBlock
            {
                Text = Texts.Remaining(item.ExpiresAt, DateTimeOffset.UtcNow),
                Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
                Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Center,
            };
            _countdowns.Add((time, item.ExpiresAt));
            var header = new Grid { ColumnSpacing = 8 };
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            header.Children.Add(new TextBlock { Text = device, FontWeight = FontWeights.SemiBold });
            var kind = new TextBlock { Text = Texts.KindLabel(item.ActionKind), Foreground = ThemeBrush("TextFillColorSecondaryBrush") };
            Grid.SetColumn(kind, 1);
            header.Children.Add(kind);
            Grid.SetColumn(time, 2);
            header.Children.Add(time);

            var body = new StackPanel { Spacing = 8 };
            body.Children.Add(header);
            if (!string.IsNullOrEmpty(item.Summary))
            {
                body.Children.Add(new Border
                {
                    Background = ThemeBrush("SubtleFillColorSecondaryBrush"),
                    CornerRadius = new CornerRadius(4),
                    Padding = new Thickness(8, 6, 8, 6),
                    Child = new TextBlock
                    {
                        Text = item.Summary,
                        FontFamily = new FontFamily("Cascadia Mono, Consolas"),
                        FontSize = 12,
                        TextWrapping = TextWrapping.Wrap,
                        IsTextSelectionEnabled = true,
                    },
                });
            }
            var approve = new Button { Content = "Onayla", Style = (Style)Application.Current.Resources["AccentButtonStyle"], IsEnabled = !expired };
            var deny = new Button { Content = "Reddet", IsEnabled = !expired };
            approve.Click += async (_, _) => await ConfirmDecisionAsync(item, device, true);
            deny.Click += async (_, _) => await ConfirmDecisionAsync(item, device, false);
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            buttons.Children.Add(approve);
            buttons.Children.Add(deny);
            body.Children.Add(buttons);

            PendingList.Children.Add(new Border
            {
                Background = ThemeBrush("CardBackgroundFillColorDefaultBrush"),
                BorderBrush = ThemeBrush("CardStrokeColorDefaultBrush"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Padding = new Thickness(12),
                Child = body,
            });
        }
    }

    private async Task<bool> ConfirmAsync(string title, string text, string primary)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = Root.XamlRoot,
            Title = title,
            Content = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap },
            PrimaryButtonText = primary,
            CloseButtonText = "Vazgeç",
            DefaultButton = ContentDialogButton.Primary,
        };
        _dialogOpen = true;
        try { return await dialog.ShowAsync() == ContentDialogResult.Primary; }
        finally { _dialogOpen = false; }
    }

    private async Task ConfirmDecisionAsync(ApprovalRequest item, string device, bool approve)
    {
        var what = string.IsNullOrEmpty(item.Summary) ? Texts.KindLabel(item.ActionKind) : item.Summary;
        var ok = await ConfirmAsync(
            approve ? "Bu işlemi onayla?" : "Bu işlemi reddet?",
            $"{device}\n{what}\n\n" + (approve ? "Onay yalnız bu işlem için ve bir kez geçerlidir." : "Yapay zekâ bu işlemi çalıştıramaz."),
            approve ? "Onayla" : "Reddet");
        if (!ok) return;
        await RunAsync(() => Center.DecideAsync(item.Id, approve));
    }

    private void RenderAutonomy()
    {
        AutonomyActive.Visibility = Center.Autonomy.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        AutonomyList.Children.Clear();
        foreach (var a in Center.Autonomy)
            AutonomyList.Children.Add(new TextBlock { Text = $"{a.Name} · {Texts.Until(a.TrustFullUntil)}" });
        var selected = ScopeDevices.Children.OfType<CheckBox>().Where(c => c.IsChecked == true).Select(c => (string)c.Tag).ToHashSet();
        ScopeDevices.Children.Clear();
        foreach (var d in Center.Devices)
        {
            var box = new CheckBox { Content = d.Name, Tag = d.Id, IsChecked = selected.Contains(d.Id) };
            box.Click += (_, _) => UpdateStartButton();
            ScopeDevices.Children.Add(box);
        }
        UpdateStartButton();
    }

    private IReadOnlyList<string>? SelectedDevices() => ScopeRadios.SelectedIndex == 0
        ? null
        : ScopeDevices.Children.OfType<CheckBox>().Where(c => c.IsChecked == true).Select(c => (string)c.Tag).ToList();

    private void UpdateStartButton()
    {
        var devices = SelectedDevices();
        StartAutonomyButton.IsEnabled = AutonomyPassword.Password.Length > 0 && (devices is null || devices.Count > 0);
    }

    private void RenderDevices()
    {
        DevicesPanel.Children.Clear();
        if (Center.Devices.Count == 0)
        {
            DevicesPanel.Children.Add(new TextBlock { Text = "Henüz cihaz yok.", Foreground = ThemeBrush("TextFillColorSecondaryBrush") });
            return;
        }
        foreach (var d in Center.Devices)
        {
            var platform = d.Platform switch { "windows" => "Windows", "macos" => "macOS", "linux" => "Linux", var p => p ?? "" };
            var trust = d.TrustLevel switch
            {
                "full" => $"otonom ({Texts.Until(d.TrustFullUntil)})",
                "strict" => "sıkı",
                _ => "standart",
            };
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
            row.Children.Add(new Ellipse
            {
                Width = 8,
                Height = 8,
                VerticalAlignment = VerticalAlignment.Center,
                Fill = d.Online ? ThemeBrush("SystemFillColorSuccessBrush") : ThemeBrush("ControlStrongFillColorDisabledBrush"),
            });
            var text = new StackPanel();
            text.Children.Add(new TextBlock { Text = d.Name, FontWeight = FontWeights.SemiBold });
            text.Children.Add(new TextBlock
            {
                Text = string.Join(" · ", new[] { platform, d.Online ? "çevrimiçi" : "çevrimdışı", trust }.Where(s => s.Length > 0)),
                Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
                Foreground = ThemeBrush("TextFillColorSecondaryBrush"),
            });
            row.Children.Add(text);
            DevicesPanel.Children.Add(new Border
            {
                Background = ThemeBrush("CardBackgroundFillColorDefaultBrush"),
                BorderBrush = ThemeBrush("CardStrokeColorDefaultBrush"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Padding = new Thickness(12, 10, 12, 10),
                Child = row,
            });
        }
    }

    // ---- actions ----

    private async Task RunAsync(Func<Task> action)
    {
        try
        {
            await action();
            Center.Error = null;
        }
        catch (GatewayException e) { Center.Error = e.Message; }
        catch (ArgumentException e) { Center.Error = e.Message; }
        Center.Publish();
    }

    private async void Connect_Click(object sender, RoutedEventArgs e) =>
        await RunAsync(() => Center.StartLinkAsync(ServerBox.Text, NameBox.Text));

    private void OpenLink_Click(object sender, RoutedEventArgs e)
    {
        if (Center.ApproveUrl is { } url) App.OpenUrl(url);
    }

    private void CancelLink_Click(object sender, RoutedEventArgs e) => Center.CancelLink();

    private void Close_Click(object sender, RoutedEventArgs e) => HidePanel();

    private async void SignOut_Click(object sender, RoutedEventArgs e)
    {
        if (await ConfirmAsync("Oturum kapatılsın mı?",
                "Bu bilgisayar onay bildirimlerini almayı bırakır. Yeniden açmak için tarayıcıda onay gerekir.", "Oturumu kapat"))
            await RunAsync(Center.SignOutAsync);
    }

    private void Tabs_SelectionChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        var selected = sender.SelectedItem;
        ApprovalsPanel.Visibility = selected == ApprovalsTab ? Visibility.Visible : Visibility.Collapsed;
        AutonomyPanel.Visibility = selected == AutonomyTab ? Visibility.Visible : Visibility.Collapsed;
        DevicesPanel.Visibility = selected == DevicesTab ? Visibility.Visible : Visibility.Collapsed;
        SettingsPanel.Visibility = selected == SettingsTab ? Visibility.Visible : Visibility.Collapsed;
    }

    private void Scope_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        ScopeDevices.Visibility = ScopeRadios.SelectedIndex == 1 ? Visibility.Visible : Visibility.Collapsed;
        UpdateStartButton();
    }

    private void AutonomyInput_Changed(object sender, RoutedEventArgs e) => UpdateStartButton();

    private async void StartAutonomy_Click(object sender, RoutedEventArgs e)
    {
        int? minutes = DurationRadios.SelectedIndex switch
        {
            0 => 30,
            1 => 60,
            2 => 240,
            3 => Durations.MinutesUntilNine(DateTime.Now),
            _ => null,
        };
        var password = AutonomyPassword.Password;
        await RunAsync(() => Center.StartAutonomyAsync(minutes, SelectedDevices(), password));
        if (Center.Error is null) AutonomyPassword.Password = "";
    }

    private async void StopAll_Click(object sender, RoutedEventArgs e) => await RunAsync(Center.StopAutonomyAsync);

    private void Settings_Toggled(object sender, RoutedEventArgs e)
    {
        if (_rendering) return;
        Center.Settings.Notifications = NotifySwitch.IsOn;
        Center.Settings.OpenOnRequest = OpenSwitch.IsOn;
        Center.SaveSettings();
        Center.Publish();
    }

    private void Autostart_Toggled(object sender, RoutedEventArgs e)
    {
        if (_rendering) return;
        LocalStore.AutostartEnabled = AutostartSwitch.IsOn;
    }

    private void Dashboard_Click(object sender, RoutedEventArgs e) => Center.OpenDashboard();
}
