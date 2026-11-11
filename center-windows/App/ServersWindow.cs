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
/// The main window of the WECOMMANDER app (Termius-class): a left menu with
/// Sunucular (host cards in groups, search, quick connect), Terminaller
/// (tabs with xterm.js in WebView2, SFTP files, tunnels), Parçacıklar (saved
/// commands), Tüneller, Bilinen sunucular and Geçmiş; Onaylar and this
/// computer's agent open the Management Center panel. SSH itself runs in
/// wecommander-core (Rust).
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
    private readonly AppBarButton _tunnelsButton = new() { Label = "Tüneller", Icon = new FontIcon { Glyph = "\uE8AF" } };
    private readonly AppBarButton _snippetButton = new() { Label = "Parçacık", Icon = new FontIcon { Glyph = "\uE943" } };
    private readonly AppBarButton _splitButton = new() { Label = "Böl", Icon = new FontIcon { Glyph = "\uE70D" } };
    private readonly AppBarToggleButton _broadcastButton = new() { Label = "Tümüne yaz", Icon = new FontIcon { Glyph = "\uE789" } };
    private readonly StackPanel _empty = new() { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private readonly Grid _terminals = new();
    private readonly AutoSuggestBox _search = new() { PlaceholderText = "Sunucu ara ya da hızlı bağlan (kullanıcı@adres)", QueryIcon = new SymbolIcon(Symbol.Find), MinWidth = 360 };
    private readonly StackPanel _hostGroups = new() { Spacing = 18 };
    private readonly NavigationViewItem _hostsItem = new() { Content = "Sunucular", Tag = "hosts", Icon = new FontIcon { Glyph = "\uE968" } };
    private readonly NavigationViewItem _terminalsItem = new() { Content = "Terminaller", Tag = "terminals", Icon = new FontIcon { Glyph = "\uE756" } };
    private readonly InfoBadge _terminalsBadge = new() { Visibility = Visibility.Collapsed };
    private RemoteListing? _listing;
    private List<Snippet> _snippets = [];

    public ServersWindow(ServersController controller)
    {
        _c = controller;
        Title = "WECOMMANDER";
        SystemBackdrop = new MicaBackdrop();
        ExtendsContentIntoTitleBar = false;
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1240, 800));
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));

        _nav.PaneDisplayMode = NavigationViewPaneDisplayMode.Left;
        _nav.IsBackButtonVisible = NavigationViewBackButtonVisible.Collapsed;
        _nav.IsSettingsVisible = false;
        _nav.PaneTitle = "WECOMMANDER";
        _nav.OpenPaneLength = 240;
        _terminalsItem.InfoBadge = _terminalsBadge;
        _nav.MenuItems.Add(_hostsItem);
        _nav.MenuItems.Add(_terminalsItem);
        _nav.MenuItems.Add(new NavigationViewItem { Content = "Anahtarlar", Tag = "keys", Icon = new FontIcon { Glyph = "\uE8D7" } });
        _nav.MenuItems.Add(new NavigationViewItem { Content = "Parçacıklar", Tag = "snippets", Icon = new FontIcon { Glyph = "\uE943" } });
        _nav.MenuItems.Add(new NavigationViewItem { Content = "Tüneller", Tag = "tunnels", Icon = new FontIcon { Glyph = "\uE8AF" } });
        _nav.MenuItems.Add(new NavigationViewItem { Content = "Bilinen sunucular", Tag = "known", Icon = new FontIcon { Glyph = "\uE72E" } });
        _nav.MenuItems.Add(new NavigationViewItem { Content = "Geçmiş", Tag = "history", Icon = new FontIcon { Glyph = "\uE81C" } });
        _nav.FooterMenuItems.Add(new NavigationViewItem { Content = "Onaylar ve otonom mod", Tag = "approvals", SelectsOnInvoked = false, Icon = new FontIcon { Glyph = "\uE8FB" } });
        _nav.FooterMenuItems.Add(new NavigationViewItem { Content = "Bu bilgisayar (ajan)", Tag = "agent", SelectsOnInvoked = false, Icon = new FontIcon { Glyph = "\uE7F4" } });
        _nav.FooterMenuItems.Add(new NavigationViewItem { Content = "Ayarlar", Tag = "settings", Icon = new SymbolIcon(Symbol.Setting) });
        _nav.ItemInvoked += (_, e) => OnNavInvoked(e.InvokedItemContainer?.Tag);

        _tabs.IsAddTabButtonVisible = true;
        _tabs.AddTabButtonClick += (_, _) => Navigate("hosts");
        _tabs.TabWidthMode = TabViewWidthMode.SizeToContent;
        _tabs.TabCloseRequested += (_, e) => { if (e.Tab.Tag is TabPage page) ClosePage(page); };
        _tabs.SelectionChanged += (_, _) => { SyncCommands(); if (_filesPane.Visibility == Visibility.Visible) _ = LoadFiles(null); };

        _filesButton.Click += (_, _) =>
        {
            _filesPane.Visibility = _filesButton.IsChecked == true ? Visibility.Visible : Visibility.Collapsed;
            if (_filesButton.IsChecked == true) _ = LoadFiles(null);
        };
        _tunnelsButton.Click += async (_, _) => await ShowTunnels();
        _snippetButton.Click += async (_, _) => await PickSnippet();
        var closeButton = new AppBarButton { Label = "Terminali kapat", Icon = new SymbolIcon(Symbol.Cancel) };
        closeButton.Click += (_, _) => { if (Current is { } t) CloseTab(t); };
        _splitButton.Flyout = SplitMenu();
        ToolTipService.SetToolTip(_splitButton, "Bu sekmeye yan yana ya da alt alta ikinci bir terminal ekle");
        _broadcastButton.Click += (_, _) => { if (CurrentPage is { } page) page.Broadcast = _broadcastButton.IsChecked == true; };
        ToolTipService.SetToolTip(_broadcastButton, "Yazdığın her şey bu sekmedeki tüm terminallere gider");
        var bar = new CommandBar { DefaultLabelPosition = CommandBarDefaultLabelPosition.Right, IsOpen = false };
        bar.PrimaryCommands.Add(_splitButton);
        bar.PrimaryCommands.Add(_broadcastButton);
        bar.PrimaryCommands.Add(_snippetButton);
        bar.PrimaryCommands.Add(_tunnelsButton);
        bar.PrimaryCommands.Add(_filesButton);
        bar.PrimaryCommands.Add(closeButton);

        _empty.Children.Add(new FontIcon { Glyph = "\uE756", FontSize = 40, Foreground = Secondary });
        _empty.Children.Add(new TextBlock { Text = "Açık terminal yok", Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], HorizontalAlignment = HorizontalAlignment.Center });
        _empty.Children.Add(new TextBlock { Text = "Sunucular'dan birine tıkla; terminal burada, sekme olarak açılır.", Foreground = Secondary });

        BuildFilesPane();

        _terminals.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _terminals.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _terminals.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        _terminals.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumnSpan(bar, 2);
        _terminals.Children.Add(bar);
        Grid.SetRow(_tabs, 1);
        _terminals.Children.Add(_tabs);
        Grid.SetRow(_empty, 1);
        _terminals.Children.Add(_empty);
        Grid.SetRow(_filesPane, 1); Grid.SetColumn(_filesPane, 1);
        _terminals.Children.Add(_filesPane);

        _search.TextChanged += (_, e) => { if (e.Reason == AutoSuggestionBoxTextChangeReason.UserInput) RenderHosts(); };
        _search.QuerySubmitted += async (_, e) => await QuickConnect(e.QueryText);

        _c.Changed += () => DispatcherQueue.TryEnqueue(() => { RenderHosts(); });
        _c.Notice += text => DispatcherQueue.TryEnqueue(() => Show(text, InfoBarSeverity.Warning));
        Closed += (_, e) => { e.Handled = true; AppWindow.Hide(); };
        // The window shows the navigation (menu + current section).
        Content = _nav;
        RenderHosts();
        Navigate("hosts");
        SyncCommands();
    }

    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];

    private TabPage? CurrentPage => (_tabs.SelectedItem as TabViewItem)?.Tag as TabPage;
    private TerminalTab? Current => CurrentPage?.Focused ?? CurrentPage?.Panes.FirstOrDefault();

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
        _snippetButton.IsEnabled = live;
        var page = CurrentPage;
        _splitButton.IsEnabled = page is not null && page.Panes.Count < TabPage.MaxPanes;
        _broadcastButton.IsEnabled = page is { Panes.Count: > 1 };
        _broadcastButton.IsChecked = page?.Broadcast == true;
        _empty.Visibility = _tabs.TabItems.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        _terminalsBadge.Value = _tabs.TabItems.Count;
        _terminalsBadge.Visibility = _tabs.TabItems.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (!live) { _filesPane.Visibility = Visibility.Collapsed; _filesButton.IsChecked = false; }
    }

    // ---- sections ----

    /// <summary>A section page: title, optional actions, content; the notice bar on top.</summary>
    private UIElement Page(string title, string subtitle, UIElement body, params UIElement[] actions)
    {
        var grid = new Grid { Padding = new Thickness(28, 20, 28, 20), RowSpacing = 14 };
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        var head = new Grid { ColumnSpacing = 8 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var titles = new StackPanel { Spacing = 2 };
        titles.Children.Add(new TextBlock { Text = title, Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] });
        titles.Children.Add(new TextBlock { Text = subtitle, Foreground = Secondary, TextWrapping = TextWrapping.Wrap });
        head.Children.Add(titles);
        var i = 1;
        foreach (var a in actions)
        {
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            if (a is FrameworkElement fe) fe.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn((FrameworkElement)a, i++);
            head.Children.Add(a);
        }
        grid.Children.Add(head);
        Grid.SetRow(_info, 1);
        if (_info.Parent is Panel old) old.Children.Remove(_info);
        grid.Children.Add(_info);
        Grid.SetRow((FrameworkElement)body, 2);
        grid.Children.Add(body);
        return grid;
    }

    private static Button ActionButton(string text, Symbol icon, Action click, bool accent = false)
    {
        var panel = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        panel.Children.Add(new SymbolIcon(icon));
        panel.Children.Add(new TextBlock { Text = text });
        var b = new Button { Content = panel };
        if (accent) b.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        b.Click += (_, _) => click();
        return b;
    }

    private void Navigate(string section)
    {
        foreach (var item in _nav.MenuItems.OfType<NavigationViewItem>())
            if (item.Tag as string == section) _nav.SelectedItem = item;
        switch (section)
        {
            case "terminals":
                if (_info.Parent is Panel p) p.Children.Remove(_info);
                Grid.SetRow(_info, 0);
                _nav.Content = _terminals;
                break;
            case "snippets": _ = ShowSnippets(); break;
            case "keys": _ = ShowKeys(); break;
            case "tunnels": ShowTunnelsPage(); break;
            case "known": _ = ShowKnown(); break;
            case "history": _ = ShowHistory(); break;
            default:
                // The search box and the host list move into the new page.
                if (_search.Parent is Panel searchParent) searchParent.Children.Remove(_search);
                if (_hostGroups.Parent is ScrollViewer oldScroll) oldScroll.Content = null;
                var scroll = new ScrollViewer { Content = _hostGroups };
                _nav.Content = Page("Sunucular", "Bir sunucuya tıkla, terminal yeni sekmede açılsın. Sağ tık: düzenle, sil.", scroll,
                    _search,
                    ActionButton("İçe aktar", Symbol.Import, async () => Show(await _c.ImportSshConfig(), InfoBarSeverity.Informational)),
                    ActionButton("Yeni sunucu", Symbol.Add, () => _ = EditHost(null), accent: true));
                break;
        }
    }

    private async void OnNavInvoked(object? tag)
    {
        switch (tag)
        {
            case "approvals":
            case "agent":
                App.Current.ShowPanel();
                break;
            case "settings":
                ShowSettings();
                break;
            case string section: Navigate(section); break;
        }
        await Task.CompletedTask;
    }

    // ---- hosts ----

    private void RenderHosts()
    {
        _hostGroups.Children.Clear();
        var query = _search.Text?.Trim() ?? "";
        var hosts = _c.Hosts.Where(h => query.Length == 0
            || h.Label.Contains(query, StringComparison.OrdinalIgnoreCase)
            || h.Target.Contains(query, StringComparison.OrdinalIgnoreCase)
            || (h.Group ?? "").Contains(query, StringComparison.OrdinalIgnoreCase)).ToList();
        if (_c.Hosts.Count == 0)
        {
            var welcome = new StackPanel { Spacing = 10, Margin = new Thickness(0, 40, 0, 0), HorizontalAlignment = HorizontalAlignment.Center };
            welcome.Children.Add(new FontIcon { Glyph = "\uE968", FontSize = 44, Foreground = Secondary });
            welcome.Children.Add(new TextBlock { Text = "Henüz sunucu yok", Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"], HorizontalAlignment = HorizontalAlignment.Center });
            welcome.Children.Add(new TextBlock { Text = "\"Yeni sunucu\" ile ekle ya da ~/.ssh/config dosyandan içe aktar.", Foreground = Secondary, HorizontalAlignment = HorizontalAlignment.Center });
            _hostGroups.Children.Add(welcome);
            return;
        }
        if (hosts.Count == 0)
        {
            _hostGroups.Children.Add(new TextBlock { Text = query.Contains('@') ? "Eşleşen sunucu yok. Enter'a basarsan bu adrese hızlı bağlanırım." : "Eşleşen sunucu yok.", Foreground = Secondary });
            return;
        }
        foreach (var group in hosts.GroupBy(h => h.GroupName).OrderBy(g => g.Key == CoreHost.NoGroup ? "\uFFFF" : g.Key, StringComparer.CurrentCultureIgnoreCase))
        {
            _hostGroups.Children.Add(new TextBlock { Text = $"{group.Key}  ·  {group.Count()}", Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
            var wrap = new VariableSizedWrapGrid { Orientation = Orientation.Horizontal, ItemWidth = 260, ItemHeight = 86 };
            foreach (var host in group.OrderBy(h => h.Label, StringComparer.CurrentCultureIgnoreCase)) wrap.Children.Add(HostCard(host));
            _hostGroups.Children.Add(wrap);
        }
    }

    private UIElement HostCard(CoreHost host)
    {
        var via = _c.Hosts.FirstOrDefault(h => h.Id == host.JumpId)?.Label;
        var grid = new Grid { ColumnSpacing = 12 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var badge = new Border
        {
            Width = 40, Height = 40, CornerRadius = new CornerRadius(8),
            Background = (Brush)Application.Current.Resources["AccentFillColorDefaultBrush"],
            Child = new FontIcon { Glyph = "\uE968", Foreground = new SolidColorBrush(Microsoft.UI.Colors.White), FontSize = 18 },
        };
        grid.Children.Add(badge);
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Spacing = 2 };
        text.Children.Add(new TextBlock { Text = host.Label, Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"], TextTrimming = TextTrimming.CharacterEllipsis });
        text.Children.Add(new TextBlock { Text = host.Target + (via is null ? "" : $" ↪ {via}"), Foreground = Secondary, FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis });
        text.Children.Add(new TextBlock { Text = host.CanConnectSilently ? (host.AuthKind == "password" ? "Parola kayıtlı" : "Anahtar hazır") : "Giriş bilgisi sorulacak", Foreground = Secondary, FontSize = 11 });
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        var card = new Button
        {
            Content = grid,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Stretch,
            Margin = new Thickness(0, 0, 10, 10),
            Padding = new Thickness(12),
        };
        ToolTipService.SetToolTip(card, host.Target + (host.TrustedKey is null ? "" : $"\nSunucu anahtarı: {host.TrustedKey}"));
        card.Click += async (_, _) => await OpenHost(host);
        var flyout = new MenuFlyout();
        flyout.Items.Add(Item("Bağlan", () => _ = OpenHost(host)));
        flyout.Items.Add(Item("Düzenle…", () => _ = EditHost(host)));
        if (host.SavedSecret) flyout.Items.Add(Item("Kayıtlı giriş bilgisini unut", () => _ = _c.ForgetSecret(host)));
        flyout.Items.Add(new MenuFlyoutSeparator());
        flyout.Items.Add(Item("Sil", () => _ = ConfirmDelete(host)));
        card.ContextFlyout = flyout;
        return card;
    }

    /// <summary>"user@host[:port]" typed in the search box: saved as a host, then connected.</summary>
    private async Task QuickConnect(string text)
    {
        text = text.Trim();
        var match = _c.Hosts.FirstOrDefault(h => h.Label.Equals(text, StringComparison.OrdinalIgnoreCase) || h.Target.Equals(text, StringComparison.OrdinalIgnoreCase));
        if (match is not null) { await OpenHost(match); return; }
        var m = System.Text.RegularExpressions.Regex.Match(text, @"^(?<user>[^@\s]+)@(?<host>[^:\s]+)(:(?<port>\d{1,5}))?$");
        if (!m.Success) { RenderHosts(); return; }
        var port = m.Groups["port"].Success ? int.Parse(m.Groups["port"].Value) : 22;
        try
        {
            await _c.AddHost(m.Groups["host"].Value, m.Groups["host"].Value, port, m.Groups["user"].Value, "key", null);
            var added = _c.Hosts.LastOrDefault(h => h.Host == m.Groups["host"].Value && h.User == m.Groups["user"].Value && h.Port == port);
            _search.Text = "";
            RenderHosts();
            if (added is not null) await OpenHost(added);
        }
        catch (CoreException e) { Show(e.Message, InfoBarSeverity.Error); }
    }

    private static MenuFlyoutItem Item(string text, Action action)
    {
        var item = new MenuFlyoutItem { Text = text };
        item.Click += (_, _) => action();
        return item;
    }

    private async Task ConfirmDelete(CoreHost host)
    {
        var dialog = Dialog($"{host.Label} silinsin mi?", new TextBlock { Text = "Kasadaki giriş bilgisi de silinir." }, "Sil");
        if (await ShowDialog(dialog) == ContentDialogResult.Primary) await _c.DeleteHost(host);
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

    // ---- settings ----

    private string TerminalSettingsJson() => JsonSerializer.Serialize(new
    {
        type = "settings",
        fontSize = App.Current.Settings.TerminalFontSize,
        theme = App.Current.Settings.TerminalTheme,
    });

    private void ApplyTerminalSettings()
    {
        App.Current.SaveSettings();
        var json = TerminalSettingsJson();
        foreach (var item in _tabs.TabItems.OfType<TabViewItem>())
            if (item.Tag is TabPage page)
                foreach (var t in page.Panes) t.Post(json);
    }

    private void ShowSettings()
    {
        var settings = App.Current.Settings;
        var font = new NumberBox { Header = "Terminal yazı boyutu", Value = settings.TerminalFontSize, Minimum = 8, Maximum = 32, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Inline, Width = 220, HorizontalAlignment = HorizontalAlignment.Left };
        font.ValueChanged += (_, e) =>
        {
            if (double.IsNaN(e.NewValue)) return;
            settings.TerminalFontSize = (int)Math.Clamp(e.NewValue, 8, 32);
            ApplyTerminalSettings();
        };
        var theme = new RadioButtons { Header = "Terminal teması", ItemsSource = new[] { "Koyu", "Açık" }, SelectedIndex = settings.TerminalTheme == "light" ? 1 : 0 };
        theme.SelectionChanged += (_, _) => { settings.TerminalTheme = theme.SelectedIndex == 1 ? "light" : "dark"; ApplyTerminalSettings(); };
        var keys = new TextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            Foreground = Secondary,
            Text = "Terminal kısayolları: Ctrl+F ara · Ctrl+= / Ctrl+- yazı boyutu · Ctrl+0 varsayılan boyut · seçiliyken Ctrl+C kopyala · Ctrl+V yapıştır.",
        };
        var center = new HyperlinkButton { Content = "Bildirimler, otonom mod ve bu bilgisayarın ajanı: Yönetim Merkezi panelini aç" };
        center.Click += (_, _) => App.Current.ShowPanel();
        var backupTitle = new TextBlock { Text = "Yedekleme", Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"], Margin = new Thickness(0, 8, 0, 0) };
        var backupHelp = new TextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            Foreground = Secondary,
            Text = "Sunucular, gruplar, tüneller, parçacıklar ve güvenilen sunucu anahtarları tek bir dosyaya yazılır. Parolalar ve özel anahtarlar dosyaya girmez; yeni bilgisayarda ilk bağlantıda bir kez sorulur. İçe aktarma var olanları değiştirmez, yalnız yenileri ekler.",
        };
        var backupRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        backupRow.Children.Add(ActionButton("Dışa aktar…", Symbol.Save, () => _ = ExportBackup()));
        backupRow.Children.Add(ActionButton("İçe aktar…", Symbol.OpenFile, () => _ = ImportBackup()));
        var body = new StackPanel { Spacing = 18, MaxWidth = 640, HorizontalAlignment = HorizontalAlignment.Left };
        foreach (var e in new UIElement[] { font, theme, keys, backupTitle, backupHelp, backupRow, center }) body.Children.Add(e);
        _nav.Content = Page("Ayarlar", "Terminal görünümü; değişiklikler açık terminallere hemen uygulanır.", new ScrollViewer { Content = body });
    }

    private async Task ExportBackup()
    {
        try
        {
            var json = await _c.ExportLibrary();
            var picker = new FileSavePicker { SuggestedFileName = $"wecommander-yedek-{DateTime.Now:yyyy-MM-dd}", SuggestedStartLocation = PickerLocationId.DocumentsLibrary };
            picker.FileTypeChoices.Add("WECOMMANDER yedeği", [".json"]);
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var file = await picker.PickSaveFileAsync();
            if (file is null) return;
            await File.WriteAllTextAsync(file.Path, json);
            Show($"Yedek kaydedildi: {file.Path}", InfoBarSeverity.Success);
        }
        catch (Exception e) when (e is CoreException or IOException or UnauthorizedAccessException)
        {
            Show("Yedek kaydedilemedi: " + e.Message, InfoBarSeverity.Error);
        }
    }

    private async Task ImportBackup()
    {
        try
        {
            var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.DocumentsLibrary };
            picker.FileTypeFilter.Add(".json");
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var file = await picker.PickSingleFileAsync();
            if (file is null) return;
            var summary = await _c.ImportLibrary(await File.ReadAllTextAsync(file.Path));
            Show($"İçe aktarıldı: {summary.Hosts} sunucu, {summary.Snippets} parçacık, {summary.KnownHosts} sunucu anahtarı"
                + (summary.Skipped > 0 ? $" ({summary.Skipped} sunucu zaten vardı, atlandı)." : "."), InfoBarSeverity.Success);
            RenderHosts();
        }
        catch (Exception e) when (e is CoreException or IOException or UnauthorizedAccessException)
        {
            Show("Yedek içe aktarılamadı: " + e.Message, InfoBarSeverity.Error);
        }
    }

    // ---- keys ----

    private async Task ShowKeys()
    {
        var keys = await _c.Keys();
        var list = new StackPanel { Spacing = 8 };
        if (keys.Count == 0)
            list.Children.Add(new TextBlock { Text = "Henüz anahtar yok. \"Yeni anahtar\" ile oluştur; genel anahtarını sunucunun ~/.ssh/authorized_keys dosyasına ekle, sonra sunucuyu düzenleyip bu anahtarı seç.", Foreground = Secondary, TextWrapping = TextWrapping.Wrap });
        foreach (var k in keys)
        {
            var row = new Grid { ColumnSpacing = 8, Padding = new Thickness(12), CornerRadius = new CornerRadius(6), Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"] };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var used = _c.Hosts.Where(h => h.KeyId == k.Id).Select(h => h.Label).ToList();
            var text = new StackPanel { Spacing = 2 };
            text.Children.Add(new TextBlock { Text = k.Label, Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
            text.Children.Add(new TextBlock { Text = $"{k.Algorithm}  ·  {k.Fingerprint}", FontFamily = new FontFamily("Cascadia Mono, Consolas"), Foreground = Secondary, IsTextSelectionEnabled = true, TextTrimming = TextTrimming.CharacterEllipsis });
            text.Children.Add(new TextBlock { Text = used.Count > 0 ? "Kullanan: " + string.Join(", ", used) : "Henüz bir sunucuda kullanılmıyor", Foreground = Secondary, FontSize = 12 });
            row.Children.Add(text);
            var copy = new Button { Content = "Genel anahtarı kopyala" };
            copy.Click += (_, _) =>
            {
                var package = new Windows.ApplicationModel.DataTransfer.DataPackage();
                package.SetText(k.PublicKey);
                Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
                Show("Genel anahtar kopyalandı. Sunucuda ~/.ssh/authorized_keys dosyasına ekle.", InfoBarSeverity.Success);
            };
            Grid.SetColumn(copy, 1); row.Children.Add(copy);
            var del = new Button { Content = new SymbolIcon(Symbol.Delete) };
            del.Click += async (_, _) =>
            {
                var dialog = Dialog($"{k.Label} silinsin mi?", new TextBlock { Text = used.Count > 0 ? "Bu anahtarı kullanan sunucular bir dahaki bağlantıda giriş bilgisi ister." : "Özel anahtar kasadan da silinir.", TextWrapping = TextWrapping.Wrap }, "Sil");
                if (await ShowDialog(dialog) != ContentDialogResult.Primary) return;
                await Guard(() => _c.DeleteKey(k));
                await ShowKeys();
            };
            Grid.SetColumn(del, 2); row.Children.Add(del);
            list.Children.Add(row);
        }
        _nav.Content = Page("Anahtarlar", "SSH anahtarların. Özel anahtar Windows Kimlik Bilgisi Yöneticisi'nde saklanır; burada yalnız genel anahtar görünür.", new ScrollViewer { Content = list },
            ActionButton("İçe aktar", Symbol.Import, () => _ = ImportKey()),
            ActionButton("Yeni anahtar", Symbol.Add, () => _ = GenerateKey(), accent: true));
    }

    private async Task GenerateKey()
    {
        var label = new TextBox { Header = "Ad", Text = Environment.MachineName + " anahtarı", MinWidth = 360 };
        var dialog = Dialog("Yeni anahtar (Ed25519)", label, "Oluştur");
        if (await ShowDialog(dialog) != ContentDialogResult.Primary) return;
        await Guard(async () =>
        {
            await _c.GenerateKey(label.Text);
            Show("Anahtar oluşturuldu. \"Genel anahtarı kopyala\" ile sunucuya ekle.", InfoBarSeverity.Success);
        });
        await ShowKeys();
    }

    private async Task ImportKey()
    {
        var label = new TextBox { Header = "Ad", PlaceholderText = "İş dizüstü anahtarı" };
        var pick = new Button { Content = "Dosyadan seç…" };
        var key = new TextBox { Header = "Özel anahtar", AcceptsReturn = true, Height = 130, FontFamily = new FontFamily("Cascadia Mono, Consolas"), PlaceholderText = "-----BEGIN OPENSSH PRIVATE KEY-----", TextWrapping = TextWrapping.NoWrap };
        var passphrase = new PasswordBox { Header = "Anahtar parolası (varsa)" };
        var error = new TextBlock { Foreground = new SolidColorBrush(Microsoft.UI.Colors.IndianRed), TextWrapping = TextWrapping.Wrap };
        pick.Click += async (_, _) =>
        {
            var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.DocumentsLibrary };
            picker.FileTypeFilter.Add("*");
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
            var file = await picker.PickSingleFileAsync();
            if (file is null) return;
            key.Text = await File.ReadAllTextAsync(file.Path);
            if (string.IsNullOrWhiteSpace(label.Text)) label.Text = file.Name;
        };
        var panel = new StackPanel { Spacing = 10, MinWidth = 460 };
        foreach (var e in new UIElement[] { label, pick, key, passphrase, error }) panel.Children.Add(e);
        var dialog = Dialog("Anahtarı içe aktar", panel, "İçe aktar");
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            var deferral = args.GetDeferral();
            try { await _c.ImportKey(label.Text, key.Text, string.IsNullOrEmpty(passphrase.Password) ? null : passphrase.Password); }
            catch (CoreException e) { error.Text = e.Message; args.Cancel = true; }
            finally { deferral.Complete(); }
        };
        if (await ShowDialog(dialog) == ContentDialogResult.Primary) await ShowKeys();
    }

    // ---- snippets ----

    private async Task ShowSnippets()
    {
        _snippets = await _c.Snippets();
        var list = new StackPanel { Spacing = 8 };
        if (_snippets.Count == 0)
            list.Children.Add(new TextBlock { Text = "Sık kullandığın komutları burada sakla; açık terminale tek tıkla gönder.", Foreground = Secondary });
        foreach (var s in _snippets)
        {
            var row = new Grid { ColumnSpacing = 8, Padding = new Thickness(12), CornerRadius = new CornerRadius(6), Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"] };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var text = new StackPanel { Spacing = 2 };
            text.Children.Add(new TextBlock { Text = s.Label, Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
            text.Children.Add(new TextBlock { Text = s.Command, FontFamily = new FontFamily("Cascadia Mono, Consolas"), Foreground = Secondary, TextTrimming = TextTrimming.CharacterEllipsis });
            row.Children.Add(text);
            var run = new Button { Content = "Terminale gönder", IsEnabled = Current is { Closed: false } };
            run.Click += (_, _) => { SendSnippet(s); Navigate("terminals"); };
            Grid.SetColumn(run, 1); row.Children.Add(run);
            var edit = new Button { Content = new SymbolIcon(Symbol.Edit) };
            edit.Click += async (_, _) => { await EditSnippet(s); };
            Grid.SetColumn(edit, 2); row.Children.Add(edit);
            var del = new Button { Content = new SymbolIcon(Symbol.Delete) };
            del.Click += async (_, _) => { await Guard(async () => _snippets = await _c.DeleteSnippet(s)); await ShowSnippets(); };
            Grid.SetColumn(del, 3); row.Children.Add(del);
            list.Children.Add(row);
        }
        _nav.Content = Page("Parçacıklar", "Kayıtlı komutlar. Açık terminale gönderilir; Enter ile çalışır.", new ScrollViewer { Content = list },
            ActionButton("Yeni parçacık", Symbol.Add, () => _ = EditSnippet(null), accent: true));
    }

    private async Task EditSnippet(Snippet? snippet)
    {
        var label = new TextBox { Header = "Ad", Text = snippet?.Label ?? "", PlaceholderText = "Disk kullanımı" };
        var command = new TextBox { Header = "Komut", Text = snippet?.Command ?? "", AcceptsReturn = true, Height = 120, FontFamily = new FontFamily("Cascadia Mono, Consolas"), PlaceholderText = "df -h" };
        var error = new TextBlock { Foreground = new SolidColorBrush(Microsoft.UI.Colors.IndianRed), TextWrapping = TextWrapping.Wrap };
        var panel = new StackPanel { Spacing = 10, MinWidth = 420 };
        foreach (var e in new UIElement[] { label, command, error }) panel.Children.Add(e);
        var dialog = Dialog(snippet is null ? "Yeni parçacık" : "Parçacığı düzenle", panel, "Kaydet");
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            var deferral = args.GetDeferral();
            try { _snippets = await _c.SaveSnippet(snippet?.Id, label.Text, command.Text); }
            catch (CoreException e) { error.Text = e.Message; args.Cancel = true; }
            finally { deferral.Complete(); }
        };
        if (await ShowDialog(dialog) == ContentDialogResult.Primary) await ShowSnippets();
    }

    private void SendSnippet(Snippet s)
    {
        if (Current is not { Closed: false } tab) return;
        var text = s.Command.Replace("\r\n", "\r").Replace('\n', '\r') + "\r";
        if (tab.Page is { Broadcast: true } page)
            foreach (var pane in page.Panes) _c.Write(pane, text);
        else
            _c.Write(tab, text);
    }

    private async Task PickSnippet()
    {
        _snippets = await _c.Snippets();
        if (_snippets.Count == 0) { Navigate("snippets"); return; }
        var menu = new MenuFlyout();
        foreach (var s in _snippets) menu.Items.Add(Item(s.Label, () => SendSnippet(s)));
        menu.ShowAt(_snippetButton);
    }

    // ---- tunnels, trusted keys, history ----

    private void ShowTunnelsPage()
    {
        var list = new StackPanel { Spacing = 8 };
        if (_c.SavedTunnels.Count == 0)
            list.Children.Add(new TextBlock { Text = "Kayıtlı tünel yok. Bir terminalde \"Tüneller\" ile açıp \"kaydet\"i işaretle.", Foreground = Secondary, TextWrapping = TextWrapping.Wrap });
        foreach (var t in _c.SavedTunnels)
        {
            var row = new Grid { ColumnSpacing = 8, Padding = new Thickness(12), CornerRadius = new CornerRadius(6), Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"] };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var text = new StackPanel { Spacing = 2 };
            text.Children.Add(new TextBlock { Text = $"{(t.Running ? "● " : "○ ")}{t.HostLabel}", Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
            text.Children.Add(new TextBlock { Text = $"{KindLabel(t.Kind)}   {t.Local}  →  {t.Remote}", FontFamily = new FontFamily("Cascadia Mono, Consolas"), Foreground = Secondary });
            row.Children.Add(text);
            var toggle = new ToggleSwitch { IsOn = t.Running, OnContent = "Açık", OffContent = "Kapalı" };
            toggle.Toggled += async (_, _) => { await _c.ToggleTunnel(t); ShowTunnelsPage(); };
            Grid.SetColumn(toggle, 1); row.Children.Add(toggle);
            var del = new Button { Content = new SymbolIcon(Symbol.Delete) };
            del.Click += async (_, _) => { await _c.DeleteTunnel(t); ShowTunnelsPage(); };
            Grid.SetColumn(del, 2); row.Children.Add(del);
            list.Children.Add(row);
        }
        _nav.Content = Page("Tüneller", "Kayıtlı tüneller: yerel (ssh -L), uzak (ssh -R) ve SOCKS proxy (ssh -D). Uygulama açıkken arka planda çalışır.", new ScrollViewer { Content = list });
    }

    private async Task ShowKnown()
    {
        var known = await _c.KnownHosts();
        var list = new StackPanel { Spacing = 8 };
        if (known.Count == 0) list.Children.Add(new TextBlock { Text = "Henüz güvenilen sunucu anahtarı yok.", Foreground = Secondary });
        foreach (var k in known)
        {
            var row = new Grid { ColumnSpacing = 8, Padding = new Thickness(12), CornerRadius = new CornerRadius(6), Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"] };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var text = new StackPanel { Spacing = 2 };
            text.Children.Add(new TextBlock { Text = k.Target + (k.Labels.Count > 0 ? "  ·  " + string.Join(", ", k.Labels) : ""), Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
            text.Children.Add(new TextBlock { Text = k.Fingerprint, FontFamily = new FontFamily("Cascadia Mono, Consolas"), Foreground = Secondary, IsTextSelectionEnabled = true });
            row.Children.Add(text);
            var forget = new Button { Content = "Unut" };
            ToolTipService.SetToolTip(forget, "Bir sonraki bağlantıda anahtar yeniden sorulur.");
            forget.Click += async (_, _) => { await Guard(() => _c.ForgetKnownHost(k)); await ShowKnown(); };
            Grid.SetColumn(forget, 1); row.Children.Add(forget);
            list.Children.Add(row);
        }
        _nav.Content = Page("Bilinen sunucular", "Güvendiğin sunucu anahtarları (known_hosts). Anahtar değişirse bağlanmadan önce uyarılırsın.", new ScrollViewer { Content = list });
    }

    private async Task ShowHistory()
    {
        var history = await _c.History();
        var list = new StackPanel { Spacing = 6 };
        if (history.Count == 0) list.Children.Add(new TextBlock { Text = "Henüz bağlantı yok.", Foreground = Secondary });
        foreach (var h in history)
        {
            var row = new Grid { ColumnSpacing = 8, Padding = new Thickness(12, 8, 12, 8), CornerRadius = new CornerRadius(6), Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"] };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.Children.Add(new TextBlock { Text = $"{h.Label}  ·  {h.Target}", VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis });
            var when = new TextBlock { Text = h.When.ToLocalTime().ToString("dd.MM.yyyy HH:mm"), Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(when, 1); row.Children.Add(when);
            var host = _c.Hosts.FirstOrDefault(x => x.Id == h.HostId);
            var again = new Button { Content = "Bağlan", IsEnabled = host is not null };
            again.Click += async (_, _) => { if (host is not null) await OpenHost(host); };
            Grid.SetColumn(again, 2); row.Children.Add(again);
            list.Children.Add(row);
        }
        _nav.Content = Page("Geçmiş", "Son bağlantıların (en yenisi üstte).", new ScrollViewer { Content = list },
            ActionButton("Temizle", Symbol.Delete, async () => { await Guard(() => _c.ClearHistory()); await ShowHistory(); }));
    }

    // ---- add / edit host ----

    private async Task EditHost(CoreHost? existing)
    {
        var label = new TextBox { Header = "Ad", PlaceholderText = "Prod web", Text = existing?.Label ?? "" };
        var host = new TextBox { Header = "Adres", PlaceholderText = "sunucu.ornek.com", Text = existing?.Host ?? "" };
        var user = new TextBox { Header = "Kullanıcı", Text = existing?.User ?? "" };
        var port = new NumberBox { Header = "Port", Value = existing?.Port ?? 22, Minimum = 1, Maximum = 65535 };
        var groups = _c.Hosts.Select(h => h.Group).Where(g => !string.IsNullOrWhiteSpace(g)).Distinct().ToList();
        var group = new AutoSuggestBox { Header = "Grup (isteğe bağlı)", Text = existing?.Group ?? "", PlaceholderText = "Production", ItemsSource = groups };
        var kind = new ComboBox { Header = "Giriş", ItemsSource = new[] { "Özel anahtar", "Parola" }, SelectedIndex = existing?.AuthKind == "password" ? 1 : 0, HorizontalAlignment = HorizontalAlignment.Stretch };
        var candidates = _c.Hosts.Where(h => h.Id != existing?.Id).ToList();
        var jumpNames = new List<string> { "Doğrudan bağlan" };
        jumpNames.AddRange(candidates.Select(h => h.Label + " üzerinden"));
        var jumpIndex = existing?.JumpId is { } j ? candidates.FindIndex(h => h.Id == j) + 1 : 0;
        var jump = new ComboBox { Header = "Atlama sunucusu", ItemsSource = jumpNames, SelectedIndex = Math.Max(0, jumpIndex), HorizontalAlignment = HorizontalAlignment.Stretch };
        var appKeys = await _c.Keys();
        var keyNames = new List<string> { "Bağlanırken sor / anahtar dosyası" };
        keyNames.AddRange(appKeys.Select(k => k.Label));
        var keyIndex = existing?.KeyId is { } kid ? appKeys.FindIndex(k => k.Id == kid) + 1 : 0;
        var keyChoice = new ComboBox { Header = "Anahtar", ItemsSource = keyNames, SelectedIndex = Math.Max(0, keyIndex), HorizontalAlignment = HorizontalAlignment.Stretch };
        var startup = new TextBox { Header = "Bağlanınca çalışacak komut (isteğe bağlı)", Text = existing?.StartupCommand ?? "", PlaceholderText = "cd /var/www && git status", FontFamily = new FontFamily("Cascadia Mono, Consolas") };
        var envText = new TextBox
        {
            Header = "Ortam değişkenleri (her satıra AD=değer)",
            Text = existing?.Env is { Count: > 0 } env ? string.Join("\r", env.Select(kv => $"{kv.Key}={kv.Value}")) : "",
            PlaceholderText = "LANG=tr_TR.UTF-8",
            AcceptsReturn = true, Height = 80, FontFamily = new FontFamily("Cascadia Mono, Consolas"),
        };
        var agent = new CheckBox { Content = "SSH agent yönlendirme (ssh -A): sunucu, bu bilgisayardaki ssh-agent anahtarlarını kullanabilsin", IsChecked = existing?.AgentForwarding == true };
        ToolTipService.SetToolTip(agent, "Yalnız güvendiğin sunucularda aç: sunucuda yönetici yetkisi olan biri, bağlantı açıkken agent'taki anahtarlarını kullanabilir.");
        var terminalOptions = new Expander
        {
            Header = "Terminal seçenekleri",
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            IsExpanded = !string.IsNullOrEmpty(existing?.StartupCommand) || existing?.Env is { Count: > 0 } || existing?.AgentForwarding == true,
        };
        var optionsPanel = new StackPanel { Spacing = 10 };
        foreach (var e in new UIElement[] { startup, envText, agent }) optionsPanel.Children.Add(e);
        terminalOptions.Content = optionsPanel;
        var error = new TextBlock { Foreground = new SolidColorBrush(Microsoft.UI.Colors.IndianRed), TextWrapping = TextWrapping.Wrap };
        var panel = new StackPanel { Spacing = 10, MinWidth = 400 };
        foreach (var e in new UIElement[] { label, host, user, port, group, kind, keyChoice, jump, terminalOptions, error }) panel.Children.Add(e);
        var dialog = Dialog(existing is null ? "Yeni sunucu" : "Sunucuyu düzenle", new ScrollViewer { Content = panel, MaxHeight = 560 }, "Kaydet");
        dialog.PrimaryButtonClick += async (d, args) =>
        {
            var deferral = args.GetDeferral();
            try
            {
                var jumpId = jump.SelectedIndex > 0 ? candidates[jump.SelectedIndex - 1].Id : null;
                var keyId = keyChoice.SelectedIndex > 0 ? appKeys[keyChoice.SelectedIndex - 1].Id : null;
                var authKind = keyId is not null ? "key" : kind.SelectedIndex == 1 ? "password" : "key";
                if (existing is null)
                {
                    await _c.AddHost(label.Text.Trim(), host.Text.Trim(), (int)port.Value, user.Text.Trim(), authKind, jumpId);
                    // The new host is the last one; give it its group.
                    var added = _c.Hosts.LastOrDefault();
                    if (added is not null && !string.IsNullOrWhiteSpace(group.Text))
                        await _c.UpdateHost(added, added.Label, added.Host, added.Port, added.User, added.AuthKind, added.JumpId, group.Text.Trim());
                }
                else
                {
                    await _c.UpdateHost(existing, label.Text.Trim(), host.Text.Trim(), (int)port.Value, user.Text.Trim(), authKind, jumpId, group.Text.Trim());
                }
                var saved = existing is null ? _c.Hosts.LastOrDefault() : _c.Hosts.FirstOrDefault(h => h.Id == existing.Id);
                if (saved is not null && saved.KeyId != keyId) await _c.SetHostKey(saved, keyId);
                if (saved is not null)
                {
                    var vars = new Dictionary<string, string>();
                    foreach (var line in envText.Text.Split('\r', '\n'))
                    {
                        var t = line.Trim();
                        if (t.Length == 0 || t.StartsWith('#')) continue;
                        var eq = t.IndexOf('=');
                        if (eq <= 0) throw new CoreException($"Ortam değişkeni AD=değer biçiminde olmalı: {t}");
                        vars[t[..eq].Trim()] = t[(eq + 1)..];
                    }
                    var cmd = startup.Text.Trim();
                    var old = saved.Env ?? new Dictionary<string, string>();
                    var changed = (saved.StartupCommand ?? "") != cmd || saved.AgentForwarding != (agent.IsChecked == true)
                        || old.Count != vars.Count || old.Any(kv => !vars.TryGetValue(kv.Key, out var v) || v != kv.Value);
                    if (changed) await _c.SetHostOptions(saved, cmd.Length == 0 ? null : cmd, vars, agent.IsChecked == true);
                }
            }
            catch (CoreException e)
            {
                error.Text = e.Message;
                args.Cancel = true;
            }
            finally { deferral.Complete(); }
        };
        await ShowDialog(dialog);
        RenderHosts();
    }

    // ---- connect ----

    /// <summary>
    /// Windows allows one ContentDialog at a time; a second one (a double
    /// click on a host, a dialog over a dialog) throws inside XAML and closes
    /// the app. Every dialog goes through here and waits its turn.
    /// </summary>
    private readonly SemaphoreSlim _dialogGate = new(1, 1);
    private readonly HashSet<string> _connecting = [];

    private async Task<ContentDialogResult> ShowDialog(ContentDialog dialog)
    {
        await _dialogGate.WaitAsync();
        try
        {
            dialog.XamlRoot ??= Content.XamlRoot;
            return await dialog.ShowAsync();
        }
        catch (Exception e)
        {
            App.LogCrash(e);
            Show("Pencere açılamadı: " + e.Message, InfoBarSeverity.Error);
            return ContentDialogResult.None;
        }
        finally { _dialogGate.Release(); }
    }

    public async Task OpenHost(CoreHost host)
    {
        // A second click while this host is still connecting does nothing.
        if (!_connecting.Add(host.Id)) return;
        try { await OpenHostOnce(host); }
        catch (Exception e)
        {
            App.LogCrash(e);
            Show($"{host.Label}: {e.Message}", InfoBarSeverity.Error);
        }
        finally { _connecting.Remove(host.Id); }
    }

    private async Task OpenHostOnce(CoreHost host)
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
        return await ShowDialog(dialog) == ContentDialogResult.Primary;
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
        if (await ShowDialog(dialog) != ContentDialogResult.Primary) return;
        object auth = useKey.SelectedIndex == 0
            ? new { kind = "key", secret = key.Text, passphrase = passphrase.Password, remember = remember.IsChecked == true, keyPath = string.IsNullOrEmpty(key.Text) ? keyPath : null }
            : new { kind = "password", secret = password.Password, passphrase = (string?)null, remember = remember.IsChecked == true, keyPath = (string?)null };
        await Connect(host, auth, null, askOnCredentialError: true);
    }

    // ---- terminals ----

    /// <summary>Set while picking a host for a split: the next terminal opens in this tab.</summary>
    private (TabPage Page, bool Vertical)? _splitTarget;

    private void AddTab(CoreHost host, string sessionId)
    {
        var view = new Microsoft.UI.Xaml.Controls.WebView2();
        var tab = new TerminalTab(sessionId, host, view);
        tab.Exited = () => { tab.Caption.Text = host.Label + " (kapandı)"; if (tab.Page is { } p && p.Item is not null) p.Item.Header = p.Title; SyncCommands(); };
        view.GotFocus += (_, _) => { if (tab.Page is { } p) { p.Focused = tab; SyncCommands(); } };
        _c.Register(tab, DispatcherQueue);
        if (_splitTarget is { } target && _tabs.TabItems.Contains(target.Page.Item) && target.Page.Panes.Count < TabPage.MaxPanes)
        {
            _splitTarget = null;
            target.Page.Vertical = target.Vertical;
            AddPane(target.Page, tab);
            _tabs.SelectedItem = target.Page.Item;
        }
        else
        {
            _splitTarget = null;
            var page = new TabPage();
            var item = new TabViewItem
            {
                Header = host.Label,
                Content = page.Root,
                Tag = page,
                IconSource = new FontIconSource { Glyph = "\uE756" },
            };
            page.Item = item;
            AddPane(page, tab);
            _tabs.TabItems.Add(item);
            _tabs.SelectedItem = item;
        }
        Navigate("terminals");
        SyncCommands();
        _ = InitTerminal(tab);
    }

    private void AddPane(TabPage page, TerminalTab tab)
    {
        tab.Page = page;
        tab.Item = page.Item;
        page.Panes.Add(tab);
        page.Focused = tab;
        LayoutPage(page);
    }

    /// <summary>Lays the panes out side by side (or one above the other), each with a small header when split.</summary>
    private void LayoutPage(TabPage page)
    {
        var root = page.Root;
        foreach (var child in root.Children.OfType<Grid>()) child.Children.Clear();
        root.Children.Clear();
        root.RowDefinitions.Clear();
        root.ColumnDefinitions.Clear();
        var split = page.Panes.Count > 1;
        for (var i = 0; i < page.Panes.Count; i++)
        {
            var pane = page.Panes[i];
            if (page.Vertical) root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            else root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var cell = new Grid { Margin = split ? new Thickness(i == 0 || page.Vertical ? 0 : 2, i == 0 || !page.Vertical ? 0 : 2, 0, 0) : new Thickness(0) };
            cell.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            cell.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            if (split)
            {
                var head = new Grid { Padding = new Thickness(8, 2, 2, 2), ColumnSpacing = 4, Background = (Brush)Application.Current.Resources["LayerFillColorDefaultBrush"] };
                head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                head.Children.Add(pane.Caption);
                var close = new Button { Content = new SymbolIcon(Symbol.Cancel), Padding = new Thickness(4), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
                ToolTipService.SetToolTip(close, "Bu bölmeyi kapat");
                close.Click += (_, _) => CloseTab(pane);
                Grid.SetColumn(close, 1); head.Children.Add(close);
                cell.Children.Add(head);
            }
            if (pane.View.Parent is Panel old) old.Children.Remove(pane.View);
            Grid.SetRow(pane.View, 1);
            cell.Children.Add(pane.View);
            if (page.Vertical) Grid.SetRow(cell, i); else Grid.SetColumn(cell, i);
            root.Children.Add(cell);
        }
        if (page.Item is not null) page.Item.Header = page.Title;
    }

    private MenuFlyout SplitMenu()
    {
        var menu = new MenuFlyout();
        menu.Opening += (_, _) =>
        {
            menu.Items.Clear();
            if (CurrentPage is not { } page) return;
            foreach (var (vertical, title) in new[] { (false, "Yan yana"), (true, "Alt alta") })
            {
                var sub = new MenuFlyoutSubItem { Text = title };
                if (Current is { } cur) sub.Items.Add(Item($"Aynı sunucu ({cur.Host.Label})", () => Split(page, vertical, cur.Host)));
                if (sub.Items.Count > 0) sub.Items.Add(new MenuFlyoutSeparator());
                foreach (var h in _c.Hosts.OrderBy(h => h.Label, StringComparer.CurrentCultureIgnoreCase).Take(30))
                    sub.Items.Add(Item(h.Label, () => Split(page, vertical, h)));
                menu.Items.Add(sub);
            }
        };
        return menu;
    }

    private void Split(TabPage page, bool vertical, CoreHost host)
    {
        if (page.Panes.Count >= TabPage.MaxPanes) return;
        _splitTarget = (page, vertical);
        _ = OpenHost(host).ContinueWith(_ => DispatcherQueue.TryEnqueue(() => _splitTarget = null));
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
                    tab.Post(TerminalSettingsJson());
                    _c.Resize(tab, (int?)m!["cols"] ?? 100, (int?)m["rows"] ?? 30);
                    tab.Flush();
                    break;
                case "input":
                    var input = (string?)m!["data"] ?? "";
                    if (tab.Page is { Broadcast: true } bp)
                        foreach (var pane in bp.Panes) _c.Write(pane, input);
                    else
                        _c.Write(tab, input);
                    break;
                case "resize":
                    _c.Resize(tab, (int?)m!["cols"] ?? 100, (int?)m["rows"] ?? 30);
                    break;
                case "fontSize":
                    // Ctrl+= / Ctrl+- in a terminal: remembered for the next ones.
                    var size = (int?)m!["size"] ?? 13;
                    DispatcherQueue.TryEnqueue(() => { App.Current.Settings.TerminalFontSize = size; App.Current.SaveSettings(); });
                    break;
            }
        };
        core.Navigate("https://wecommander.terminal/index.html");
    }

    /// <summary>Closes one terminal; the tab goes when its last pane does.</summary>
    private void CloseTab(TerminalTab tab)
    {
        _c.Close(tab);
        if (tab.Page is { } page)
        {
            page.Panes.Remove(tab);
            if (page.Focused == tab) page.Focused = page.Panes.FirstOrDefault();
            if (page.Panes.Count == 0)
            {
                if (page.Item is not null) _tabs.TabItems.Remove(page.Item);
            }
            else
            {
                if (page.Panes.Count == 1) page.Broadcast = false;
                LayoutPage(page);
            }
        }
        tab.View.Close();
        SyncCommands();
    }

    private void ClosePage(TabPage page)
    {
        foreach (var pane in page.Panes.ToList()) CloseTab(pane);
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
        return await ShowDialog(dialog) == ContentDialogResult.Primary ? box.Text.Trim() : null;
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
        if (await ShowDialog(dialog) != ContentDialogResult.Primary) return;
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

    private static string KindLabel(string kind) => kind switch
    {
        "remote" => "Uzak (-R)",
        "dynamic" => "SOCKS (-D)",
        _ => "Yerel (-L)",
    };

    private async Task ShowTunnels()
    {
        if (Current is not { Closed: false } tab) return;
        var list = new StackPanel { Spacing = 6 };
        async Task Render(List<ForwardInfo> forwards)
        {
            list.Children.Clear();
            foreach (var f in forwards)
            {
                var row = new Grid { ColumnSpacing = 8 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.Children.Add(new TextBlock { Text = KindLabel(f.Kind), Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
                var text = new TextBlock { Text = $"{f.Local}  →  {f.Remote}", FontFamily = new FontFamily("Cascadia Mono, Consolas"), VerticalAlignment = VerticalAlignment.Center, IsTextSelectionEnabled = true };
                Grid.SetColumn(text, 1); row.Children.Add(text);
                var stop = new Button { Content = "Kapat" };
                stop.Click += async (_, _) => await Render(await _c.StopForward(tab, f.StopId));
                Grid.SetColumn(stop, 2); row.Children.Add(stop);
                list.Children.Add(row);
            }
            await Task.CompletedTask;
        }
        await Render(await _c.Forwards(tab));
        var kind = new RadioButtons { Header = "Tünel türü", ItemsSource = new[] { "Yerel (-L)", "Uzak (-R)", "SOCKS proxy (-D)" }, SelectedIndex = 0, MaxColumns = 3 };
        var help = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = Secondary };
        var local = new NumberBox { Header = "Bu bilgisayardaki port (0 = boş port)", Value = 0, Minimum = 0, Maximum = 65535 };
        var localHost = new TextBox { Header = "Bu taraftaki adres", Text = "127.0.0.1" };
        var remoteHost = new TextBox { Header = "Uzak adres (sunucudan görüldüğü gibi)", Text = "127.0.0.1" };
        var remotePort = new NumberBox { Header = "Uzak port", Minimum = 0, Maximum = 65535 };
        var save = new CheckBox { Content = "Bu tüneli kaydet (Tüneller sayfasından ve tepsi simgesinden açılır)" };
        var status = new TextBlock { TextWrapping = TextWrapping.Wrap };
        void Sync()
        {
            switch (kind.SelectedIndex)
            {
                case 1:
                    help.Text = "Sunucu bir port açar; oraya gelen bağlantılar bu bilgisayardaki bir servise (örneğin yerel web sunucun) gelir (ssh -R). Sunucu varsayılan olarak yalnız kendi içinden (localhost) dinler.";
                    local.Header = "Bu bilgisayardaki servis portu";
                    remoteHost.Header = "Sunucunun dinleyeceği adres";
                    remoteHost.Text = remoteHost.Text is "127.0.0.1" or "" ? "localhost" : remoteHost.Text;
                    remotePort.Header = "Sunucunun dinleyeceği port (0 = sunucu seçsin)";
                    localHost.Visibility = Visibility.Visible;
                    remoteHost.Visibility = remotePort.Visibility = Visibility.Visible;
                    break;
                case 2:
                    help.Text = "Bu bilgisayarda bir SOCKS5 proxy açar; tarayıcını ya da bir uygulamayı bu proxy'ye yönlendirirsen trafik sunucunun ağından çıkar (ssh -D). Yalnızca bu bilgisayardan (127.0.0.1) erişilebilir.";
                    local.Header = "Proxy portu (0 = boş port)";
                    localHost.Visibility = remoteHost.Visibility = remotePort.Visibility = Visibility.Collapsed;
                    break;
                default:
                    help.Text = "Bu bilgisayardaki bir portu, sunucunun erişebildiği bir adrese bağlar (ssh -L). Yalnızca bu bilgisayardan (127.0.0.1) erişilebilir.";
                    local.Header = "Bu bilgisayardaki port (0 = boş port)";
                    remoteHost.Header = "Uzak adres (sunucudan görüldüğü gibi)";
                    remoteHost.Text = remoteHost.Text is "localhost" or "" ? "127.0.0.1" : remoteHost.Text;
                    remotePort.Header = "Uzak port";
                    localHost.Visibility = Visibility.Collapsed;
                    remoteHost.Visibility = remotePort.Visibility = Visibility.Visible;
                    break;
            }
        }
        kind.SelectionChanged += (_, _) => Sync();
        Sync();
        var panel = new StackPanel { Spacing = 10, MinWidth = 460 };
        foreach (var e in new UIElement[] { list, kind, help, local, localHost, remoteHost, remotePort, save, status }) panel.Children.Add(e);
        var dialog = Dialog($"Tüneller · {tab.Host.Label}", new ScrollViewer { Content = panel, MaxHeight = 600 }, "Tünel aç", "Kapat");
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            args.Cancel = true; // stay open to show the list
            var deferral = args.GetDeferral();
            try
            {
                var k = kind.SelectedIndex switch { 1 => "remote", 2 => "dynamic", _ => "local" };
                var request = new TunnelRequest(k, (int)Num(local), remoteHost.Text.Trim(), (int)Num(remotePort), k == "remote" ? localHost.Text.Trim() : null);
                var forwards = await _c.StartForward(tab, request, save.IsChecked == true);
                await Render(forwards);
                var last = forwards.Count > 0 ? forwards[^1] : null;
                status.Text = last is null ? "" : k switch
                {
                    "remote" => $"Açıldı: sunucuda {last.Local} → bu bilgisayarda {last.Remote}.",
                    "dynamic" => $"Açıldı: uygulamanda SOCKS5 proxy olarak {last.Local} adresini kullan.",
                    _ => $"Açıldı: {last.Local} adresine bağlan.",
                };
            }
            catch (CoreException e) { status.Text = e.Message; }
            finally { deferral.Complete(); }
        };
        await ShowDialog(dialog);
    }

    private static double Num(NumberBox box) => double.IsNaN(box.Value) ? 0 : box.Value;
}

/// <summary>One terminal tab; output before the page is ready is buffered.</summary>
public sealed class TerminalTab(string sessionId, CoreHost host, Microsoft.UI.Xaml.Controls.WebView2 view)
{
    public string SessionId { get; } = sessionId;
    public CoreHost Host { get; } = host;
    public Microsoft.UI.Xaml.Controls.WebView2 View { get; } = view;
    public TabViewItem? Item { get; set; }
    /// <summary>The tab page this terminal is a pane of.</summary>
    public TabPage? Page { get; set; }
    /// <summary>Pane header (host name) shown when a tab is split.</summary>
    public TextBlock Caption { get; } = new() { Text = host.Label, FontSize = 12, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
    /// <summary>Set by the window: runs on the UI thread when the connection closes.</summary>
    public Action? Exited { get; set; }
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

/// <summary>
/// One tab of the Terminaller section: one terminal, or up to four side by
/// side / one above the other (split view). Typing can go to every pane at
/// once (broadcast).
/// </summary>
public sealed class TabPage
{
    public const int MaxPanes = 4;
    public List<TerminalTab> Panes { get; } = [];
    public TerminalTab? Focused { get; set; }
    public bool Vertical { get; set; }
    public bool Broadcast { get; set; }
    public Grid Root { get; } = new();
    public TabViewItem? Item { get; set; }
    public string Title => Panes.Count switch
    {
        0 => "",
        1 => Panes[0].Host.Label + (Panes[0].Closed ? " (kapandı)" : ""),
        _ => string.Join(" | ", Panes.Select(p => p.Host.Label)),
    };
}
