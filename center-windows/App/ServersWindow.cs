using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Microsoft.Web.WebView2.Core;
using Wecommander.Center.Core;
using Windows.Storage.Pickers;

namespace Wecommander.Center;

/// <summary>
/// The Servers window of the unified Windows app: saved hosts in a
/// NavigationView, terminals in a TabView (WebView2 surface with xterm.js),
/// SFTP files and tunnels. SSH itself runs in wecommander-core (Rust).
/// </summary>
public sealed class ServersWindow : Window
{
    private readonly ServersController _c;
    private readonly NavigationView _nav = new();
    private readonly TabView _tabs = new();
    private readonly Grid _filesPane = new() { Width = 340, Visibility = Visibility.Collapsed };
    private readonly ListView _fileList = new() { SelectionMode = ListViewSelectionMode.Single };
    private readonly TextBlock _filesPath = new() { VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly StackPanel _transfers = new() { Spacing = 4, Margin = new Thickness(8) };
    private readonly InfoBar _info = new() { IsClosable = true };
    private readonly AppBarToggleButton _filesButton = new() { Label = "Dosyalar", Icon = new SymbolIcon(Symbol.Folder) };
    private readonly AppBarButton _tunnelsButton = new() { Label = "Tüneller", Icon = new FontIcon { Glyph = "" } };
    private readonly StackPanel _empty = new() { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private RemoteListing? _listing;

    public ServersWindow(ServersController controller)
    {
        _c = controller;
        Title = "WECOMMANDER";
        SystemBackdrop = new MicaBackdrop();
        ExtendsContentIntoTitleBar = false;
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1180, 760));
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));

        _nav.PaneDisplayMode = NavigationViewPaneDisplayMode.Left;
        _nav.IsBackButtonVisible = NavigationViewBackButtonVisible.Collapsed;
        _nav.IsSettingsVisible = false;
        _nav.PaneTitle = "Sunucular";
        _nav.OpenPaneLength = 280;
        _nav.ItemInvoked += (_, e) => OnNavInvoked(e.InvokedItemContainer?.Tag);

        _tabs.IsAddTabButtonVisible = false;
        _tabs.TabWidthMode = TabViewWidthMode.SizeToContent;
        _tabs.TabCloseRequested += (_, e) => { if (e.Tab.Tag is TerminalTab t) CloseTab(t); };
        _tabs.SelectionChanged += (_, _) => { SyncCommands(); if (_filesPane.Visibility == Visibility.Visible) _ = LoadFiles(null); };

        _filesButton.Click += (_, _) =>
        {
            _filesPane.Visibility = _filesButton.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
            if (_filesButton.IsChecked == true) _ = LoadFiles(null);
        };
        _tunnelsButton.Click += async (_, _) => await ShowTunnels();
        var closeButton = new AppBarButton { Label = "Terminali kapat", Icon = new SymbolIcon(Symbol.Cancel) };
        closeButton.Click += (_, _) => { if (Current is { } t) CloseTab(t); };
        var bar = new CommandBar { DefaultLabelPosition = CommandBarDefaultLabelPosition.Right, IsOpen = false };
        bar.PrimaryCommands.Add(_tunnelsButton);
        bar.PrimaryCommands.Add(_filesButton);
        bar.PrimaryCommands.Add(closeButton);

        _empty.Children.Add(new FontIcon { Glyph = "", FontSize = 40, Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"] });
        _empty.Children.Add(new TextBlock { Text = "Bir sunucu seç", Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], HorizontalAlignment = HorizontalAlignment.Center });
        _empty.Children.Add(new TextBlock { Text = "Soldaki listeden bir sunucuya tıkla; terminal burada açılır.", Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"] });

        BuildFilesPane();

        var main = new Grid();
        main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        main.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        main.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumnSpan(bar, 2);
        main.Children.Add(bar);
        Grid.SetRow(_info, 1); Grid.SetColumnSpan(_info, 2);
        main.Children.Add(_info);
        Grid.SetRow(_tabs, 2);
        main.Children.Add(_tabs);
        Grid.SetRow(_empty, 2);
        main.Children.Add(_empty);
        Grid.SetRow(_filesPane, 2); Grid.SetColumn(_filesPane, 1);
        main.Children.Add(_filesPane);
        _nav.Content = main;
        Content = _nav;

        _c.Changed += () => DispatcherQueue.TryEnqueue(RebuildNav);
        _c.Notice += text => DispatcherQueue.TryEnqueue(() => Show(text, InfoBarSeverity.Warning));
        Closed += (_, e) => { e.Handled = true; AppWindow.Hide(); };
        RebuildNav();
        SyncCommands();
    }

    private TerminalTab? Current => (_tabs.SelectedItem as TabViewItem)?.Tag as TerminalTab;

    public void ShowWindow()
    {
        AppWindow.Show();
        Activate();
    }

    private void Show(string text, InfoBarSeverity severity)
    {
        _info.Message = text;
        _info.Severity = severity;
        _info.IsOpen = true;
    }

    private void SyncCommands()
    {
        var t = Current;
        var live = t is not null && !t.Closed;
        _filesButton.IsEnabled = live;
        _tunnelsButton.IsEnabled = live;
        _empty.Visibility = _tabs.TabItems.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (!live) { _filesPane.Visibility = Visibility.Collapsed; _filesButton.IsChecked = false; }
    }

    // ---- navigation ----

    private void RebuildNav()
    {
        _nav.MenuItems.Clear();
        foreach (var host in _c.Hosts)
        {
            var via = _c.Hosts.FirstOrDefault(h => h.Id == host.JumpId)?.Label;
            var item = new NavigationViewItem
            {
                Content = host.Label,
                Tag = host,
                Icon = new FontIcon { Glyph = host.CanConnectSilently ? "" : "" },
            };
            ToolTipService.SetToolTip(item, host.Target + (via is null ? "" : $"  ↪ {via} üzerinden")
                + (host.TrustedKey is null ? "" : $"\nSunucu anahtarı: {host.TrustedKey}"));
            var flyout = new MenuFlyout();
            flyout.Items.Add(Item("Terminal aç", () => _ = OpenHost(host)));
            if (host.SavedSecret) flyout.Items.Add(Item("Kayıtlı giriş bilgisini unut", () => _ = _c.ForgetSecret(host)));
            flyout.Items.Add(new MenuFlyoutSeparator());
            flyout.Items.Add(Item("Sunucuyu sil", () => _ = ConfirmDelete(host)));
            item.ContextFlyout = flyout;
            _nav.MenuItems.Add(item);
        }
        if (_c.Hosts.Count == 0)
            _nav.MenuItems.Add(new NavigationViewItem { Content = "Henüz sunucu yok", IsEnabled = false });

        _nav.FooterMenuItems.Clear();
        if (_c.SavedTunnels.Count > 0)
        {
            var tunnels = new NavigationViewItem { Content = "Kayıtlı tüneller", Icon = new FontIcon { Glyph = "" }, SelectsOnInvoked = false };
            foreach (var t in _c.SavedTunnels)
                tunnels.MenuItems.Add(new NavigationViewItem
                {
                    Content = $"{(t.Running ? "● " : "○ ")}{t.HostLabel}  {t.Local} → {t.Remote}",
                    Tag = t,
                    SelectsOnInvoked = false,
                });
            _nav.FooterMenuItems.Add(tunnels);
        }
        _nav.FooterMenuItems.Add(new NavigationViewItem { Content = "~/.ssh/config'den içe aktar", Icon = new SymbolIcon(Symbol.Import), Tag = "import", SelectsOnInvoked = false });
        _nav.FooterMenuItems.Add(new NavigationViewItem { Content = "Sunucu ekle", Icon = new SymbolIcon(Symbol.Add), Tag = "add", SelectsOnInvoked = false });
    }

    private static MenuFlyoutItem Item(string text, Action action)
    {
        var item = new MenuFlyoutItem { Text = text };
        item.Click += (_, _) => action();
        return item;
    }

    private async void OnNavInvoked(object? tag)
    {
        switch (tag)
        {
            case CoreHost host: await OpenHost(host); break;
            case SavedTunnel tunnel: await _c.ToggleTunnel(tunnel); break;
            case "add": await AddHost(); break;
            case "import":
                var text = await _c.ImportSshConfig();
                Show(text, InfoBarSeverity.Informational);
                break;
        }
    }

    private async Task ConfirmDelete(CoreHost host)
    {
        var dialog = Dialog($"{host.Label} silinsin mi?", new TextBlock { Text = "Kasadaki giriş bilgisi de silinir." }, "Sil");
        if (await dialog.ShowAsync() == ContentDialogResult.Primary) await _c.DeleteHost(host);
    }

    private ContentDialog Dialog(string title, UIElement content, string primary, string close = "Vazgeç") => new()
    {
        Title = title,
        Content = content,
        PrimaryButtonText = primary,
        CloseButtonText = close,
        DefaultButton = ContentDialogButton.Primary,
        XamlRoot = Content.XamlRoot,
    };

    // ---- add host ----

    private async Task AddHost()
    {
        var label = new TextBox { Header = "Ad", PlaceholderText = "Prod web" };
        var host = new TextBox { Header = "Adres", PlaceholderText = "sunucu.ornek.com" };
        var user = new TextBox { Header = "Kullanıcı" };
        var port = new NumberBox { Header = "Port", Value = 22, Minimum = 1, Maximum = 65535 };
        var kind = new ComboBox { Header = "Giriş", ItemsSource = new[] { "Özel anahtar", "Parola" }, SelectedIndex = 0, HorizontalAlignment = HorizontalAlignment.Stretch };
        var jumpNames = new List<string> { "Doğrudan bağlan" };
        jumpNames.AddRange(_c.Hosts.Select(h => h.Label + " üzerinden"));
        var jump = new ComboBox { Header = "Atlama sunucusu", ItemsSource = jumpNames, SelectedIndex = 0, HorizontalAlignment = HorizontalAlignment.Stretch };
        var error = new TextBlock { Foreground = new SolidColorBrush(Microsoft.UI.Colors.IndianRed), TextWrapping = TextWrapping.Wrap };
        var panel = new StackPanel { Spacing = 10, MinWidth = 380 };
        foreach (var e in new UIElement[] { label, host, user, port, kind, jump, error }) panel.Children.Add(e);
        var dialog = Dialog("Sunucu ekle", panel, "Kaydet");
        dialog.PrimaryButtonClick += async (d, args) =>
        {
            var deferral = args.GetDeferral();
            try
            {
                var jumpId = jump.SelectedIndex > 0 ? _c.Hosts[jump.SelectedIndex - 1].Id : null;
                await _c.AddHost(label.Text.Trim(), host.Text.Trim(), (int)port.Value, user.Text.Trim(),
                    kind.SelectedIndex == 1 ? "password" : "key", jumpId);
            }
            catch (CoreException e)
            {
                error.Text = e.Message;
                args.Cancel = true;
            }
            finally { deferral.Complete(); }
        };
        await dialog.ShowAsync();
    }

    // ---- connect ----

    public async Task OpenHost(CoreHost host)
    {
        if (host.CanConnectSilently)
        {
            await Connect(host, new { kind = host.AuthKind, secret = "", remember = false }, null, askOnCredentialError: true);
        }
        else
        {
            await AskCredentials(host, null);
        }
    }

    private async Task Connect(CoreHost host, object auth, string? accept, bool askOnCredentialError)
    {
        try
        {
            var result = await _c.Connect(host, auth, accept);
            if (result.NeedsHostKeyApproval)
            {
                if (await ApproveHostKey(host, result)) await Connect(host, auth, result.Fingerprint, askOnCredentialError);
                return;
            }
            if (result.SessionId is { } sid) AddTab(host, sid);
        }
        catch (CoreException e)
        {
            var credential = e.Raw.Contains("no saved credential") || e.Raw.Contains("authentication failed")
                || e.Raw.Contains("private key could not be used") || e.Raw.StartsWith("key file ");
            if (credential && askOnCredentialError) await AskCredentials(host, e.Message);
            else Show($"{host.Label}: {e.Message}", InfoBarSeverity.Error);
        }
    }

    private async Task<bool> ApproveHostKey(CoreHost host, ConnectResult result)
    {
        var changed = result.Status == "hostKeyChanged";
        var panel = new StackPanel { Spacing = 10, MaxWidth = 460 };
        panel.Children.Add(new InfoBar
        {
            IsOpen = true,
            IsClosable = false,
            Severity = changed ? InfoBarSeverity.Error : InfoBarSeverity.Informational,
            Title = changed ? "Bu sunucunun anahtarı değişti" : "Bu sunucuya ilk kez bağlanıyorsun",
            Message = changed
                ? $"Güvendiğin anahtar {result.Trusted} idi. Sunucuyu yeniden kurmadıysan bağlanma; araya biri girmiş olabilir."
                : $"{result.Algorithm} anahtarının parmak izi aşağıda. Sunucu yöneticisinden aldığın değerle aynıysa güven.",
        });
        panel.Children.Add(new TextBox { Text = result.Fingerprint ?? "", IsReadOnly = true, FontFamily = new FontFamily("Cascadia Mono, Consolas") });
        var dialog = Dialog($"{host.Label} · {host.Target}", panel, changed ? "Yeni anahtara yine de güven" : "Güven ve bağlan");
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    private async Task AskCredentials(CoreHost host, string? message)
    {
        var useKey = new RadioButtons { ItemsSource = new[] { "Özel anahtar", "Parola" }, SelectedIndex = host.AuthKind == "password" ? 1 : 0, MaxColumns = 2 };
        string? keyPath = host.KeyPath;
        var keyPathText = new TextBlock { Text = keyPath ?? "ya da anahtarı aşağıya yapıştır", Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"], TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
        var pick = new Button { Content = "Anahtar dosyası seç…" };
        var key = new TextBox { AcceptsReturn = true, Height = 110, FontFamily = new FontFamily("Cascadia Mono, Consolas"), PlaceholderText = "-----BEGIN OPENSSH PRIVATE KEY-----", TextWrapping = TextWrapping.NoWrap };
        var passphrase = new PasswordBox { PlaceholderText = "Anahtar parolası (varsa)" };
        var password = new PasswordBox { PlaceholderText = "Parola" };
        var remember = new CheckBox { Content = "Windows Kimlik Bilgisi Yöneticisi'nde sakla", IsChecked = true };
        var keyRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        keyRow.Children.Add(pick);
        keyRow.Children.Add(keyPathText);
        void Sync()
        {
            var k = useKey.SelectedIndex == 0;
            keyRow.Visibility = k ? Visibility.Visible : Visibility.Collapsed;
            key.Visibility = k && keyPath is null ? Visibility.Visible : Visibility.Collapsed;
            passphrase.Visibility = k ? Visibility.Visible : Visibility.Collapsed;
            password.Visibility = k ? Visibility.Collapsed : Visibility.Visible;
        }
        useKey.SelectionChanged += (_, _) => Sync();
        pick.Click += async (_, _) =>
        {
            var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.DocumentsLibrary };
            picker.FileTypeFilter.Add("*");
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var file = await picker.PickSingleFileAsync();
            if (file is null) return;
            keyPath = file.Path;
            keyPathText.Text = keyPath;
            Sync();
        };
        Sync();
        var panel = new StackPanel { Spacing = 10, MinWidth = 440 };
        if (message is not null) panel.Children.Add(new InfoBar { IsOpen = true, IsClosable = false, Severity = InfoBarSeverity.Error, Message = message });
        foreach (var e in new UIElement[] { useKey, keyRow, key, passphrase, password, remember }) panel.Children.Add(e);
        var dialog = Dialog($"{host.Label} · {host.Target}", panel, "Bağlan");
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        object auth = useKey.SelectedIndex == 0
            ? new { kind = "key", secret = key.Text, passphrase = passphrase.Password, remember = remember.IsChecked == true, keyPath = string.IsNullOrEmpty(key.Text) ? keyPath : null }
            : new { kind = "password", secret = password.Password, passphrase = (string?)null, remember = remember.IsChecked == true, keyPath = (string?)null };
        await Connect(host, auth, null, askOnCredentialError: true);
    }

    // ---- terminals ----

    private void AddTab(CoreHost host, string sessionId)
    {
        var view = new Microsoft.UI.Xaml.Controls.WebView2();
        var tab = new TerminalTab(sessionId, host, view);
        var item = new TabViewItem
        {
            Header = host.Label,
            Content = view,
            Tag = tab,
            IconSource = new FontIconSource { Glyph = "" },
        };
        tab.Item = item;
        _c.Register(tab, DispatcherQueue);
        _tabs.TabItems.Add(item);
        _tabs.SelectedItem = item;
        SyncCommands();
        _ = InitTerminal(tab);
    }

    private async Task InitTerminal(TerminalTab tab)
    {
        await tab.View.EnsureCoreWebView2Async();
        var core = tab.View.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.SetVirtualHostNameToFolderMapping("wecommander.terminal",
            Path.Combine(AppContext.BaseDirectory, "Assets", "terminal"), CoreWebView2HostResourceAccessKind.Allow);
        core.PermissionRequested += (_, e) =>
        {
            if (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead) e.State = CoreWebView2PermissionState.Allow;
        };
        core.WebMessageReceived += (_, e) =>
        {
            JsonObject? m;
            try { m = JsonNode.Parse(e.TryGetWebMessageAsString()) as JsonObject; } catch (JsonException) { return; }
            switch ((string?)m?["type"])
            {
                case "ready":
                    tab.Ready = true;
                    _c.Resize(tab, (int?)m!["cols"] ?? 100, (int?)m["rows"] ?? 30);
                    tab.Flush();
                    break;
                case "input":
                    _c.Write(tab, (string?)m!["data"] ?? "");
                    break;
                case "resize":
                    _c.Resize(tab, (int?)m!["cols"] ?? 100, (int?)m["rows"] ?? 30);
                    break;
            }
        };
        core.Navigate("https://wecommander.terminal/index.html");
    }

    private void CloseTab(TerminalTab tab)
    {
        _c.Close(tab);
        if (tab.Item is not null) _tabs.TabItems.Remove(tab.Item);
        tab.View.Close();
        SyncCommands();
    }

    // ---- files (SFTP) ----

    private void BuildFilesPane()
    {
        _filesPane.Background = (Brush)Application.Current.Resources["LayerFillColorDefaultBrush"];
        _filesPane.BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"];
        _filesPane.BorderThickness = new Thickness(1, 0, 0, 0);
        _filesPane.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _filesPane.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _filesPane.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var up = new Button { Content = new SymbolIcon(Symbol.Up) };
        ToolTipService.SetToolTip(up, "Üst klasör");
        up.Click += (_, _) => _ = LoadFiles(_listing?.Parent);
        var refresh = new Button { Content = new SymbolIcon(Symbol.Refresh) };
        refresh.Click += (_, _) => _ = LoadFiles(_listing?.Path);
        var upload = new Button { Content = new SymbolIcon(Symbol.Upload) };
        ToolTipService.SetToolTip(upload, "Dosya yükle");
        upload.Click += async (_, _) => await UploadPicked();
        var mkdir = new Button { Content = new SymbolIcon(Symbol.NewFolder) };
        ToolTipService.SetToolTip(mkdir, "Yeni klasör");
        mkdir.Click += async (_, _) => await NewFolder();
        var head = new Grid { Padding = new Thickness(8), ColumnSpacing = 6 };
        for (var i = 0; i < 5; i++) head.ColumnDefinitions.Add(new ColumnDefinition { Width = i == 1 ? new GridLength(1, GridUnitType.Star) : GridLength.Auto });
        head.Children.Add(up);
        Grid.SetColumn(_filesPath, 1); head.Children.Add(_filesPath);
        Grid.SetColumn(refresh, 2); head.Children.Add(refresh);
        Grid.SetColumn(upload, 3); head.Children.Add(upload);
        Grid.SetColumn(mkdir, 4); head.Children.Add(mkdir);
        _filesPane.Children.Add(head);
        Grid.SetRow(_fileList, 1);
        _fileList.DoubleTapped += (_, _) =>
        {
            if (_fileList.SelectedItem is ListViewItem { Tag: RemoteEntry e } && (e.IsFolder || e.Kind == "link")) _ = LoadFiles(e.Path);
        };
        _fileList.AllowDrop = true;
        _fileList.DragOver += (_, e) => e.AcceptedOperation = Windows.ApplicationModel.DataTransfer.DataPackageOperation.Copy;
        _fileList.Drop += async (_, e) =>
        {
            if (!e.DataView.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems)) return;
            foreach (var item in await e.DataView.GetStorageItemsAsync())
                if (item is Windows.Storage.StorageFile f) await Upload(f.Path);
        };
        _filesPane.Children.Add(_fileList);
        Grid.SetRow(_transfers, 2);
        _filesPane.Children.Add(_transfers);
    }

    private async Task LoadFiles(string? path)
    {
        if (Current is not { Closed: false } tab) return;
        try
        {
            _listing = await _c.ListFiles(tab, path);
            _filesPath.Text = _listing.Path;
            _fileList.Items.Clear();
            foreach (var e in _listing.Entries) _fileList.Items.Add(FileRow(tab, e));
        }
        catch (CoreException e)
        {
            _fileList.Items.Clear();
            _fileList.Items.Add(new ListViewItem { Content = new TextBlock { Text = e.Message, TextWrapping = TextWrapping.Wrap }, IsEnabled = false });
        }
    }

    private ListViewItem FileRow(TerminalTab tab, RemoteEntry e)
    {
        var row = new Grid { ColumnSpacing = 8 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(new FontIcon { Glyph = e.IsFolder ? "" : e.Kind == "link" ? "" : "", FontSize = 16 });
        var name = new TextBlock { Text = e.Name, TextTrimming = TextTrimming.CharacterEllipsis };
        Grid.SetColumn(name, 1); row.Children.Add(name);
        var size = new TextBlock { Text = e.IsFolder ? "" : Size(e.Size), Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"], FontSize = 12 };
        Grid.SetColumn(size, 2); row.Children.Add(size);
        var item = new ListViewItem { Content = row, Tag = e };
        ToolTipService.SetToolTip(item, $"{e.Permissions}  {e.Path}");
        var menu = new MenuFlyout();
        if (!e.IsFolder) menu.Items.Add(Item("İndir…", () => _ = Download(tab, e)));
        menu.Items.Add(Item("Yeniden adlandır…", () => _ = Rename(tab, e)));
        menu.Items.Add(Item("Sil", () => _ = Delete(tab, e)));
        item.ContextFlyout = menu;
        return item;
    }

    private static string Size(ulong n)
    {
        string[] u = ["B", "KB", "MB", "GB", "TB"];
        double v = n; var i = 0;
        while (v >= 1024 && i < u.Length - 1) { v /= 1024; i++; }
        return i == 0 ? $"{n} B" : $"{v:0.#} {u[i]}";
    }

    private static string Join(string dir, string name) => dir.EndsWith('/') ? dir + name : dir + "/" + name;

    private async Task<string?> AskText(string title, string value)
    {
        var box = new TextBox { Text = value, MinWidth = 320 };
        var dialog = Dialog(title, box, "Tamam");
        return await dialog.ShowAsync() == ContentDialogResult.Primary ? box.Text.Trim() : null;
    }

    private async Task NewFolder()
    {
        if (Current is not { } tab || _listing is null) return;
        var name = await AskText("Yeni klasör", "");
        if (string.IsNullOrEmpty(name)) return;
        await Guard(() => _c.FilesAction(tab, "files.mkdir", new { sessionId = tab.SessionId, path = Join(_listing.Path, name) }));
        await LoadFiles(_listing.Path);
    }

    private async Task Rename(TerminalTab tab, RemoteEntry e)
    {
        if (_listing is null) return;
        var name = await AskText("Yeniden adlandır", e.Name);
        if (string.IsNullOrEmpty(name) || name == e.Name) return;
        await Guard(() => _c.FilesAction(tab, "files.rename", new { sessionId = tab.SessionId, from = e.Path, to = Join(_listing.Path, name) }));
        await LoadFiles(_listing.Path);
    }

    private async Task Delete(TerminalTab tab, RemoteEntry e)
    {
        var dialog = Dialog($"{e.Name} silinsin mi?", new TextBlock { Text = e.IsFolder ? "Yalnızca boş klasörler silinebilir." : "Bu işlem geri alınamaz." }, "Sil");
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        await Guard(() => _c.FilesAction(tab, "files.delete", new { sessionId = tab.SessionId, path = e.Path }));
        await LoadFiles(_listing?.Path);
    }

    private async Task Guard(Func<Task> action)
    {
        try { await action(); }
        catch (CoreException e) { Show(e.Message, InfoBarSeverity.Error); }
    }

    private async Task Download(TerminalTab tab, RemoteEntry e)
    {
        var picker = new FileSavePicker { SuggestedFileName = e.Name, SuggestedStartLocation = PickerLocationId.Downloads };
        picker.FileTypeChoices.Add("Dosya", [Path.GetExtension(e.Name) is { Length: > 0 } ext ? ext : "."]);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var file = await picker.PickSaveFileAsync();
        if (file is null) return;
        await Transfer($"⬇ {e.Name}", id => _c.FilesAction(tab, "files.download", new { sessionId = tab.SessionId, remote = e.Path, local = file.Path, transferId = id }));
    }

    private async Task UploadPicked()
    {
        var picker = new FileOpenPicker();
        picker.FileTypeFilter.Add("*");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var files = await picker.PickMultipleFilesAsync();
        foreach (var f in files) await Upload(f.Path);
    }

    private async Task Upload(string local)
    {
        if (Current is not { } tab || _listing is null) return;
        var dir = _listing.Path;
        await Transfer($"⬆ {Path.GetFileName(local)}", id => _c.FilesAction(tab, "files.upload", new { sessionId = tab.SessionId, local, remoteDir = dir, transferId = id }));
        await LoadFiles(dir);
    }

    private async Task Transfer(string label, Func<string, Task> run)
    {
        var id = Guid.NewGuid().ToString();
        var bar = new ProgressBar { Maximum = 1, Value = 0 };
        var row = new StackPanel { Spacing = 2 };
        row.Children.Add(new TextBlock { Text = label, FontSize = 12 });
        row.Children.Add(bar);
        _transfers.Children.Add(row);
        _c.Progress[id] = (done, total) => DispatcherQueue.TryEnqueue(() => { bar.Maximum = Math.Max(1, total); bar.Value = done; });
        try { await run(id); }
        catch (CoreException e) { Show($"{label}: {e.Message}", InfoBarSeverity.Error); }
        finally
        {
            _c.Progress.TryRemove(id, out _);
            _transfers.Children.Remove(row);
        }
    }

    // ---- tunnels ----

    private async Task ShowTunnels()
    {
        if (Current is not { Closed: false } tab) return;
        var list = new StackPanel { Spacing = 6 };
        async Task Render(List<ForwardInfo> forwards)
        {
            list.Children.Clear();
            foreach (var f in forwards)
            {
                var row = new Grid();
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.Children.Add(new TextBlock { Text = $"{f.Local}  →  {f.Remote}", FontFamily = new FontFamily("Cascadia Mono, Consolas"), VerticalAlignment = VerticalAlignment.Center });
                var stop = new Button { Content = "Kapat" };
                stop.Click += async (_, _) => await Render(await _c.StopForward(tab, f.Local));
                Grid.SetColumn(stop, 1); row.Children.Add(stop);
                list.Children.Add(row);
            }
            await Task.CompletedTask;
        }
        await Render(await _c.Forwards(tab));
        var local = new NumberBox { Header = "Yerel port (0 = boş port)", Value = 0, Minimum = 0, Maximum = 65535 };
        var remoteHost = new TextBox { Header = "Uzak adres", Text = "127.0.0.1" };
        var remotePort = new NumberBox { Header = "Uzak port", Minimum = 1, Maximum = 65535 };
        var save = new CheckBox { Content = "Bu tüneli kaydet (tepsi simgesinden de açılır)" };
        var status = new TextBlock { TextWrapping = TextWrapping.Wrap };
        var panel = new StackPanel { Spacing = 10, MinWidth = 440 };
        panel.Children.Add(new TextBlock { Text = "Bu bilgisayardaki bir portu, sunucunun erişebildiği bir adrese bağlar (ssh -L). Yalnızca bu bilgisayardan (127.0.0.1) erişilebilir.", TextWrapping = TextWrapping.Wrap, Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"] });
        foreach (var e in new UIElement[] { list, local, remoteHost, remotePort, save, status }) panel.Children.Add(e);
        var dialog = Dialog($"Tüneller · {tab.Host.Label}", panel, "Tünel aç", "Kapat");
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            args.Cancel = true; // stay open to show the list
            var deferral = args.GetDeferral();
            try
            {
                var forwards = await _c.StartForward(tab, (int)local.Value, remoteHost.Text.Trim(), (int)remotePort.Value, save.IsChecked == true);
                await Render(forwards);
                status.Text = forwards.Count > 0 ? $"Açıldı: {forwards[^1].Local} adresine bağlan." : "";
            }
            catch (CoreException e) { status.Text = e.Message; }
            finally { deferral.Complete(); }
        };
        await dialog.ShowAsync();
    }
}

/// <summary>One terminal tab; output before the page is ready is buffered.</summary>
public sealed class TerminalTab(string sessionId, CoreHost host, Microsoft.UI.Xaml.Controls.WebView2 view)
{
    public string SessionId { get; } = sessionId;
    public CoreHost Host { get; } = host;
    public Microsoft.UI.Xaml.Controls.WebView2 View { get; } = view;
    public TabViewItem? Item { get; set; }
    public bool Ready { get; set; }
    public bool Closed { get; set; }
    private readonly List<string> _pending = [];

    public void Post(string json)
    {
        if (Ready && View.CoreWebView2 is not null) View.CoreWebView2.PostWebMessageAsString(json);
        else _pending.Add(json);
    }

    public void Flush()
    {
        foreach (var json in _pending) View.CoreWebView2?.PostWebMessageAsString(json);
        _pending.Clear();
    }
}
