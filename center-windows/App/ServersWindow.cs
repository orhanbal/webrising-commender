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
    private readonly AppBarButton _shareButton = new() { Label = "Ekiple paylaş", Icon = new FontIcon { Glyph = "\uE72D" } };
    private readonly StackPanel _empty = new() { Spacing = 8, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private readonly Grid _terminals = new();
    private readonly AutoSuggestBox _search = new() { PlaceholderText = "Sunucu ara ya da hızlı bağlan (kullanıcı@adres)", QueryIcon = new SymbolIcon(Symbol.Find), MinWidth = 360 };
    private readonly StackPanel _hostGroups = new() { Spacing = 18 };
    /// <summary>The Sunucular page, made the first time it is shown.</summary>
    private Grid? _hostsPage;
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
        _nav.MenuItems.Add(new NavigationViewItem { Content = "Kimlikler", Tag = "identities", Icon = new FontIcon { Glyph = "\uE77B" } });
        _nav.MenuItems.Add(new NavigationViewItem { Content = "Parçacıklar", Tag = "snippets", Icon = new FontIcon { Glyph = "\uE943" } });
        _nav.MenuItems.Add(new NavigationViewItem { Content = "Tüneller", Tag = "tunnels", Icon = new FontIcon { Glyph = "\uE8AF" } });
        _nav.MenuItems.Add(new NavigationViewItem { Content = "Bilinen sunucular", Tag = "known", Icon = new FontIcon { Glyph = "\uE72E" } });
        _nav.MenuItems.Add(new NavigationViewItem { Content = "Geçmiş", Tag = "history", Icon = new FontIcon { Glyph = "\uE81C" } });
        _nav.FooterMenuItems.Add(new NavigationViewItem { Content = "Onaylar ve otonom mod", Tag = "approvals", SelectsOnInvoked = false, Icon = new FontIcon { Glyph = "\uE8FB" } });
        _nav.FooterMenuItems.Add(new NavigationViewItem { Content = "Bu bilgisayar (ajan)", Tag = "agent", SelectsOnInvoked = false, Icon = new FontIcon { Glyph = "\uE7F4" } });
        _nav.FooterMenuItems.Add(new NavigationViewItem { Content = "Ayarlar", Tag = "settings", Icon = new SymbolIcon(Symbol.Setting) });
        _nav.ItemInvoked += (_, e) => OnNavInvoked(e.InvokedItemContainer?.Tag);

        _tabs.IsAddTabButtonVisible = true;
        _tabs.AddTabButtonClick += (_, _) =>
        {
            Navigate("hosts");
            DispatcherQueue.TryEnqueue(() => Show("Yeni terminal için bir sunucuya tıkla (ya da arama kutusuna kullanıcı@adres yazıp Enter'a bas).", InfoBarSeverity.Informational));
        };
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
        _shareButton.Flyout = ShareMenu();
        ToolTipService.SetToolTip(_shareButton, "Bu terminali ekipten birine canlı göster (uçtan uca şifreli)");
        bar.PrimaryCommands.Add(_shareButton);
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
        // Pages never move between parents (WinUI may still hold an element in
        // its old parent: blank page or "already the child of another
        // element"). The page host stays the navigation content; the message
        // bar sits on top of every page.
        _info.Margin = new Thickness(28, 12, 28, 0);
        _pageHost.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _pageHost.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _pageHost.Children.Add(_info);
        _nav.Content = _pageHost;
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
        var own = live && t!.Guest is null; // a teammate's shared terminal has no files or tunnels here
        _filesButton.IsEnabled = own;
        _tunnelsButton.IsEnabled = own;
        _snippetButton.IsEnabled = live;
        _shareButton.IsEnabled = live && t!.Guest is null;
        _shareButton.Label = t?.Hosting is { } hs ? $"Paylaşılıyor ({hs.Guests.Count})" : "Ekiple paylaş";
        var page = CurrentPage;
        _splitButton.IsEnabled = page is not null && page.Panes.Count < TabPage.MaxPanes;
        _broadcastButton.IsEnabled = page is { Panes.Count: > 1 };
        _broadcastButton.IsChecked = page?.Broadcast == true;
        _empty.Visibility = _tabs.TabItems.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        _terminalsBadge.Value = _tabs.TabItems.Count;
        _terminalsBadge.Visibility = _tabs.TabItems.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (!own) { _filesPane.Visibility = Visibility.Collapsed; _filesButton.IsChecked = false; }
    }

    // ---- sections ----

    private readonly Grid _pageHost = new();
    /// <summary>The section page built for this visit (Anahtarlar, Ayarlar, ...); replaced on the next one.</summary>
    private UIElement? _transientPage;

    /// <summary>Shows a page: the Sunucular and Terminaller pages are added
    /// once and only shown or hidden; other pages replace the previous one.</summary>
    private void SetPage(UIElement page)
    {
        var persistent = page == _terminals || page == _hostsPage;
        if (_transientPage is not null && _transientPage != page)
        {
            _pageHost.Children.Remove(_transientPage);
            _transientPage = null;
        }
        if (!persistent) _transientPage = page;
        if (!_pageHost.Children.Contains(page))
        {
            Grid.SetRow((FrameworkElement)page, 1);
            _pageHost.Children.Add(page);
        }
        foreach (var child in _pageHost.Children)
            if (child != _info) child.Visibility = child == page ? Visibility.Visible : Visibility.Collapsed;
    }

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

    /// <summary>
    /// Switches the section after the current event finishes: a click inside the
    /// terminals view (the tab strip's "+", a snippet's button) must not pull its
    /// own control out of the window while WinUI is still handling it.
    /// </summary>
    private void Navigate(string section)
    {
        if (!DispatcherQueue.TryEnqueue(() =>
        {
            try { NavigateNow(section); }
            catch (Exception e) { App.LogCrash(e); Show("Sayfa açılamadı: " + e.Message, InfoBarSeverity.Error); }
        })) NavigateNow(section);
    }

    private void NavigateNow(string section)
    {
        foreach (var item in _nav.MenuItems.OfType<NavigationViewItem>())
            if (item.Tag as string == section) _nav.SelectedItem = item;
        switch (section)
        {
            case "terminals":
                SetPage(_terminals);
                break;
            case "snippets": _ = ShowSnippets(); break;
            case "keys": _ = ShowKeys(); break;
            case "identities": _ = ShowIdentities(); break;
            case "tunnels": ShowTunnelsPage(); break;
            case "known": _ = ShowKnown(); break;
            case "history": _ = ShowHistory(); break;
            default:
                // Built once: the search box and the host list never move to
                // another parent (WinUI may still hold them in the old one).
                if (_hostsPage is null)
                {
                    _hostsPage = (Grid)Page("Sunucular", "Bir sunucuya tıkla, terminal yeni sekmede açılsın. Sağ tık: düzenle, sil.",
                        new ScrollViewer { Content = _hostGroups },
                        _search,
                        ActionButton("Ortak terminaller", Symbol.People, () => _ = ShowShares()),
                        ActionButton("İçe aktar", Symbol.Import, async () => Show(await _c.ImportSshConfig(), InfoBarSeverity.Informational)),
                        ActionButton("Yeni sunucu", Symbol.Add, () => _ = EditHost(null), accent: true));
                }
                SetPage(_hostsPage);
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
        text.Children.Add(new TextBlock { Text = (host.Team ? "👥 Ekip · " : "") + (host.CanConnectSilently ? (host.AuthKind == "password" ? "Parola kayıtlı" : "Anahtar hazır") : "Giriş bilgisi sorulacak"), Foreground = Secondary, FontSize = 11 });
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
        flyout.Items.Add(Item(host.Team ? "Ekipten çıkar (yalnız bende kalsın)" : "Ekiple paylaş", () => _ = ShareWithTeam("host", host.Id, !host.Team)));
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

    private async Task ShareWithTeam(string kind, string id, bool team)
    {
        await Guard(() => _c.SetTeam(kind, id, team));
        App.Current.RequestLibrarySync();
        Show(team
            ? "Ekiple paylaşıldı. Ekipteki herkesin uygulamasına birkaç saniye içinde gelir; kayıtlı parolası da şifreli olarak paylaşılır."
            : "Artık yalnız sende. Ekipteki diğer uygulamalardan kaldırılır.", InfoBarSeverity.Success);
        if (kind == "snippet") await ShowSnippets();
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
        var themes = new[] { ("dark", "Koyu"), ("light", "Açık"), ("solarized-dark", "Solarized koyu"), ("solarized-light", "Solarized açık"),
            ("nord", "Nord"), ("gruvbox", "Gruvbox"), ("monokai", "Monokai"), ("dracula", "Dracula") };
        var theme = new ComboBox { Header = "Terminal teması", ItemsSource = themes.Select(t => t.Item2).ToList(), MinWidth = 220,
            SelectedIndex = Math.Max(0, Array.FindIndex(themes, t => t.Item1 == settings.TerminalTheme)) };
        theme.SelectionChanged += (_, _) => { settings.TerminalTheme = themes[Math.Max(0, theme.SelectedIndex)].Item1; ApplyTerminalSettings(); };
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
        var syncTitle = new TextBlock { Text = "Eşitleme (bilgisayarların arasında)", Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"], Margin = new Thickness(0, 8, 0, 0) };
        var syncPanel = new StackPanel { Spacing = 8 };
        _ = RenderSync(syncPanel);
        var teamTitle = new TextBlock { Text = "Ekip", Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"], Margin = new Thickness(0, 8, 0, 0) };
        var teamPanel = new StackPanel { Spacing = 8 };
        RenderTeam(teamPanel);
        var body = new StackPanel { Spacing = 18, MaxWidth = 640, HorizontalAlignment = HorizontalAlignment.Left };
        var logsButton = ActionButton("Oturum kayıtları klasörünü aç", Symbol.Folder, async () =>
        {
            if (await _c.LogsFolder() is not { } folder) { Show("Kayıt klasörü bulunamadı.", InfoBarSeverity.Warning); return; }
            Directory.CreateDirectory(folder);
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", "\"" + folder + "\"") { UseShellExecute = true });
        });
        foreach (var e in new UIElement[] { font, theme, keys, logsButton, syncTitle, syncPanel, teamTitle, teamPanel, backupTitle, backupHelp, backupRow, center }) body.Children.Add(e);
        SetPage(Page("Ayarlar", "Terminal görünümü; değişiklikler açık terminallere hemen uygulanır.", new ScrollViewer { Content = body }));
    }

    private async Task RenderSync(StackPanel panel)
    {
        panel.Children.Clear();
        var status = await _c.SyncStatus();
        var help = new TextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            Foreground = Secondary,
            Text = "Sunucular, gruplar, tüneller, parçacıklar, kimlikler, anahtarlar ve kayıtlı parolalar aynı hesapla oturum açtığın tüm bilgisayarlarda aynı olur. "
                + "Her şey bu bilgisayarda, yalnız senin bildiğin eşitleme parolasıyla şifrelenir; WECOMMANDER sunucusu içeriği göremez. Parolayı unutursan eşitlenen kopya açılamaz.",
        };
        panel.Children.Add(help);
        var error = new TextBlock { Foreground = new SolidColorBrush(Microsoft.UI.Colors.IndianRed), TextWrapping = TextWrapping.Wrap };
        if (!status.Configured)
        {
            var pass = new PasswordBox { Header = "Eşitleme parolası (en az 8 karakter)", Width = 320, HorizontalAlignment = HorizontalAlignment.Left };
            var again = new PasswordBox { Header = "Parolayı tekrar yaz", Width = 320, HorizontalAlignment = HorizontalAlignment.Left };
            var note = new TextBlock { Text = "Başka bir bilgisayarda eşitlemeyi zaten açtıysan oradaki parolayı gir.", Foreground = Secondary, TextWrapping = TextWrapping.Wrap };
            var start = ActionButton("Eşitlemeyi aç", Symbol.Sync, async () =>
            {
                error.Text = "";
                if (pass.Password != again.Password) { error.Text = "Parolalar aynı değil."; return; }
                try
                {
                    await App.Current.SetupLibrarySync(pass.Password);
                    Show("Eşitleme açıldı.", InfoBarSeverity.Success);
                    await RenderSync(panel);
                }
                catch (Exception e) when (e is CoreException or GatewayException) { error.Text = e.Message; }
            }, accent: true);
            foreach (var e in new UIElement[] { pass, again, note, start, error }) panel.Children.Add(e);
            return;
        }
        var last = _c.LastLibrarySync is { } t ? $"Son eşitleme: {t:HH:mm}" : "Henüz eşitlenmedi";
        panel.Children.Add(new TextBlock { Text = "● Eşitleme açık. " + last + (status.Persistent ? "" : " (anahtar zinciri yok: eşitleme anahtarı uygulama kapanınca unutulur)") });
        if (App.Current.LibrarySyncError is { } problem) error.Text = problem;
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        row.Children.Add(ActionButton("Şimdi eşitle", Symbol.Sync, async () =>
        {
            await App.Current.LibrarySyncAsync();
            await RenderSync(panel);
            if (App.Current.LibrarySyncError is null) Show("Eşitlendi.", InfoBarSeverity.Success);
        }));
        row.Children.Add(ActionButton("Bu bilgisayarda kapat", Symbol.Cancel, async () =>
        {
            var dialog = Dialog("Eşitleme bu bilgisayarda kapatılsın mı?", new TextBlock { Text = "Buradaki sunucular silinmez; yalnız artık diğer bilgisayarlarla eşitlenmez. Sunucudaki şifreli kopya kalır.", TextWrapping = TextWrapping.Wrap }, "Kapat");
            if (await ShowDialog(dialog) != ContentDialogResult.Primary) return;
            await Guard(() => _c.ForgetSync());
            await RenderSync(panel);
        }));
        panel.Children.Add(row);
        panel.Children.Add(error);
    }

    private void RenderTeam(StackPanel panel)
    {
        panel.Children.Clear();
        panel.Children.Add(new TextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            Foreground = Secondary,
            Text = "Bir sunucuya ya da parçacığa sağ tıklayıp \"Ekiple paylaş\" dersen, çalışma alanındaki herkesin uygulamasında görünür (kayıtlı parolasıyla). "
                + "Ekip kütüphanesi ekip anahtarıyla uçtan uca şifrelenir; anahtar yalnız ekip üyelerinin uygulamalarına, onların açık anahtarıyla şifrelenerek verilir. "
                + "Üye eklemek ve rolleri değiştirmek panelde: Yönetim → Ekip. İzleyiciler ortak sunucuları kullanır ama değiştiremez.",
        });
        if (_c.TeamName is { } name)
        {
            var role = _c.TeamRole switch { "owner" => "sahip", "admin" => "yönetici", "operator" => "operatör", _ => "izleyici" };
            panel.Children.Add(new TextBlock { Text = $"Çalışma alanı: {name} · rolün: {role}" });
            if (_c.TeamState == TeamSyncState.WaitingForKey)
                panel.Children.Add(new TextBlock { Text = "Ekip anahtarı bekleniyor: ekipten operatör ya da üstü biri uygulamasını açtığında bu bilgisayara verilir.", TextWrapping = TextWrapping.Wrap, Foreground = new SolidColorBrush(Microsoft.UI.Colors.DarkOrange) });
            foreach (var m in _c.TeamMembers)
                panel.Children.Add(new TextBlock { Text = $"{(m.HasKey ? "●" : "○")} {m.Email} · {m.CenterName}" + (m.HasKey ? "" : " (anahtar bekliyor)"), Foreground = Secondary, FontSize = 12 });
        }
        if (App.Current.TeamSyncError is { } problem)
            panel.Children.Add(new TextBlock { Text = problem, Foreground = new SolidColorBrush(Microsoft.UI.Colors.IndianRed), TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(ActionButton("Şimdi eşitle", Symbol.Sync, async () => { await App.Current.LibrarySyncAsync(); RenderTeam(panel); }));
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
        SetPage(Page("Anahtarlar", "SSH anahtarların. Özel anahtar Windows Kimlik Bilgisi Yöneticisi'nde saklanır; burada yalnız genel anahtar görünür.", new ScrollViewer { Content = list },
            ActionButton("İçe aktar", Symbol.Import, () => _ = ImportKey()),
            ActionButton("Yeni anahtar", Symbol.Add, () => _ = GenerateKey(), accent: true)));
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

    // ---- identities ----

    private async Task ShowIdentities()
    {
        var identities = await _c.Identities();
        var keys = await _c.Keys();
        var list = new StackPanel { Spacing = 8 };
        if (identities.Count == 0)
            list.Children.Add(new TextBlock { Text = "Kimlik, bir kullanıcı adı ile anahtarı ya da parolasıdır; birçok sunucuda kullanılır. Örneğin \"deploy + ekip anahtarı\". Bir kez oluştur, sunucuyu düzenlerken seç; değiştirince hepsi güncellenir.", Foreground = Secondary, TextWrapping = TextWrapping.Wrap });
        foreach (var i in identities)
        {
            var row = new Grid { ColumnSpacing = 8, Padding = new Thickness(12), CornerRadius = new CornerRadius(6), Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"] };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var used = _c.Hosts.Where(h => h.IdentityId == i.Id).Select(h => h.Label).ToList();
            var keyName = keys.FirstOrDefault(k => k.Id == i.KeyId)?.Label;
            var text = new StackPanel { Spacing = 2 };
            text.Children.Add(new TextBlock { Text = i.Label, Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
            text.Children.Add(new TextBlock { Text = i.User + "  ·  " + (i.AuthKind == "password" ? "Parola" : keyName is null ? "Anahtar seçilmemiş" : "Anahtar: " + keyName), Foreground = Secondary });
            text.Children.Add(new TextBlock { Text = used.Count > 0 ? "Kullanan: " + string.Join(", ", used) : "Henüz bir sunucuda kullanılmıyor", Foreground = Secondary, FontSize = 12 });
            row.Children.Add(text);
            var edit = new Button { Content = new SymbolIcon(Symbol.Edit) };
            edit.Click += async (_, _) => await EditIdentity(i);
            Grid.SetColumn(edit, 1); row.Children.Add(edit);
            var del = new Button { Content = new SymbolIcon(Symbol.Delete) };
            del.Click += async (_, _) =>
            {
                var dialog = Dialog($"{i.Label} silinsin mi?", new TextBlock { Text = used.Count > 0 ? "Bu kimliği kullanan sunucular kendi giriş bilgilerine döner." : "Kayıtlı parolası da silinir.", TextWrapping = TextWrapping.Wrap }, "Sil");
                if (await ShowDialog(dialog) != ContentDialogResult.Primary) return;
                await Guard(() => _c.DeleteIdentity(i));
                await ShowIdentities();
            };
            Grid.SetColumn(del, 2); row.Children.Add(del);
            list.Children.Add(row);
        }
        SetPage(Page("Kimlikler", "Birçok sunucuda kullanılan kullanıcı + anahtar ya da parola. Parola Windows Kimlik Bilgisi Yöneticisi'nde saklanır.", new ScrollViewer { Content = list },
            ActionButton("Yeni kimlik", Symbol.Add, () => _ = EditIdentity(null), accent: true)));
    }

    private async Task EditIdentity(Identity? existing)
    {
        var keys = await _c.Keys();
        var label = new TextBox { Header = "Ad", Text = existing?.Label ?? "", PlaceholderText = "Ekip deploy" };
        var user = new TextBox { Header = "Kullanıcı", Text = existing?.User ?? "" };
        var kind = new RadioButtons { Header = "Giriş", ItemsSource = new[] { "Anahtar", "Parola" }, SelectedIndex = existing?.AuthKind == "password" ? 1 : 0, MaxColumns = 2 };
        var keyNames = keys.Select(k => k.Label).ToList();
        var key = new ComboBox { Header = "Anahtar", ItemsSource = keyNames, SelectedIndex = existing?.KeyId is { } kid ? keys.FindIndex(k => k.Id == kid) : keys.Count > 0 ? 0 : -1, HorizontalAlignment = HorizontalAlignment.Stretch, PlaceholderText = keys.Count == 0 ? "Önce Anahtarlar'dan bir anahtar oluştur" : "" };
        var password = new PasswordBox { Header = existing is null ? "Parola" : "Parola (boş bırakırsan kayıtlı parola kalır)" };
        var error = new TextBlock { Foreground = new SolidColorBrush(Microsoft.UI.Colors.IndianRed), TextWrapping = TextWrapping.Wrap };
        void Sync()
        {
            key.Visibility = kind.SelectedIndex == 0 ? Visibility.Visible : Visibility.Collapsed;
            password.Visibility = kind.SelectedIndex == 1 ? Visibility.Visible : Visibility.Collapsed;
        }
        kind.SelectionChanged += (_, _) => Sync();
        Sync();
        var panel = new StackPanel { Spacing = 10, MinWidth = 420 };
        foreach (var e in new UIElement[] { label, user, kind, key, password, error }) panel.Children.Add(e);
        var dialog = Dialog(existing is null ? "Yeni kimlik" : "Kimliği düzenle", panel, "Kaydet");
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            var deferral = args.GetDeferral();
            try
            {
                var authKind = kind.SelectedIndex == 1 ? "password" : "key";
                var keyId = authKind == "key" && key.SelectedIndex >= 0 ? keys[key.SelectedIndex].Id : null;
                await _c.SaveIdentity(existing?.Id, label.Text, user.Text, authKind, keyId, authKind == "password" && password.Password.Length > 0 ? password.Password : null);
                await _c.Reload();
            }
            catch (CoreException e) { error.Text = e.Message; args.Cancel = true; }
            finally { deferral.Complete(); }
        };
        if (await ShowDialog(dialog) == ContentDialogResult.Primary) await ShowIdentities();
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
            text.Children.Add(new TextBlock { Text = s.Team ? "👥 Ekiple paylaşılıyor" : "", Foreground = Secondary, FontSize = 11, Visibility = s.Team ? Visibility.Visible : Visibility.Collapsed });
            var edit = new Button { Content = new SymbolIcon(Symbol.Edit) };
            edit.Click += async (_, _) => { await EditSnippet(s); };
            var shareMenu = new MenuFlyout();
            shareMenu.Items.Add(Item(s.Team ? "Ekipten çıkar" : "Ekiple paylaş", () => _ = ShareWithTeam("snippet", s.Id, !s.Team)));
            edit.ContextFlyout = shareMenu;
            ToolTipService.SetToolTip(edit, "Düzenle (sağ tık: ekiple paylaş)");
            Grid.SetColumn(edit, 2); row.Children.Add(edit);
            var del = new Button { Content = new SymbolIcon(Symbol.Delete) };
            del.Click += async (_, _) => { await Guard(async () => _snippets = await _c.DeleteSnippet(s)); await ShowSnippets(); };
            Grid.SetColumn(del, 3); row.Children.Add(del);
            list.Children.Add(row);
        }
        SetPage(Page("Parçacıklar", "Kayıtlı komutlar. Açık terminale gönderilir; Enter ile çalışır.", new ScrollViewer { Content = list },
            ActionButton("Yeni parçacık", Symbol.Add, () => _ = EditSnippet(null), accent: true)));
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
        SetPage(Page("Tüneller", "Kayıtlı tüneller: yerel (ssh -L), uzak (ssh -R) ve SOCKS proxy (ssh -D). Uygulama açıkken arka planda çalışır.", new ScrollViewer { Content = list }));
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
        SetPage(Page("Bilinen sunucular", "Güvendiğin sunucu anahtarları (known_hosts). Anahtar değişirse bağlanmadan önce uyarılırsın.", new ScrollViewer { Content = list }));
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
        SetPage(Page("Geçmiş", "Son bağlantıların (en yenisi üstte).", new ScrollViewer { Content = list },
            ActionButton("Temizle", Symbol.Delete, async () => { await Guard(() => _c.ClearHistory()); await ShowHistory(); })));
    }

    // ---- add / edit host ----

    private async Task EditHost(CoreHost? existing)
    {
        var protocols = new[] { ("ssh", "SSH"), ("mosh", "Mosh (SSH ile giriş, UDP ile kesintisiz)"), ("telnet", "Telnet"), ("serial", "Seri port") };
        var protocol = new ComboBox
        {
            Header = "Bağlantı türü",
            ItemsSource = protocols.Select(p => p.Item2).ToList(),
            SelectedIndex = Math.Max(0, Array.FindIndex(protocols, p => p.Item1 == (existing?.Protocol ?? "ssh"))),
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
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
        var identities = await _c.Identities();
        var identityNames = new List<string> { "Yok (bu sunucunun kendi kullanıcısı ve giriş bilgisi)" };
        identityNames.AddRange(identities.Select(i => $"{i.Label} ({i.User})"));
        var identityIndex = existing?.IdentityId is { } iid ? identities.FindIndex(i => i.Id == iid) + 1 : 0;
        var identity = new ComboBox { Header = "Kimlik", ItemsSource = identityNames, SelectedIndex = Math.Max(0, identityIndex), HorizontalAlignment = HorizontalAlignment.Stretch };
        ToolTipService.SetToolTip(identity, "Seçersen kullanıcı adı ve giriş bilgisi kimlikten gelir.");
        void SyncIdentity()
        {
            var own = identity.SelectedIndex <= 0;
            kind.IsEnabled = keyChoice.IsEnabled = own;
            user.IsEnabled = own;
            if (!own) user.Text = identities[identity.SelectedIndex - 1].User;
        }
        identity.SelectionChanged += (_, _) => SyncIdentity();
        SyncIdentity();
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
        var sessionLog = new CheckBox { Content = "Oturumu kaydet: terminalde görünenler bir metin dosyasına yazılır (Ayarlar → Oturum kayıtları)", IsChecked = existing?.SessionLog == true };
        var terminalOptions = new Expander
        {
            Header = "Terminal seçenekleri",
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            IsExpanded = !string.IsNullOrEmpty(existing?.StartupCommand) || existing?.Env is { Count: > 0 } || existing?.AgentForwarding == true || existing?.SessionLog == true,
        };
        var optionsPanel = new StackPanel { Spacing = 10 };
        foreach (var e in new UIElement[] { startup, envText, agent, sessionLog }) optionsPanel.Children.Add(e);
        terminalOptions.Content = optionsPanel;
        var error = new TextBlock { Foreground = new SolidColorBrush(Microsoft.UI.Colors.IndianRed), TextWrapping = TextWrapping.Wrap };
        // Serial line settings.
        var serialNow = existing?.Serial;
        var serialDevice = new ComboBox { Header = "Seri port", IsEditable = true, ItemsSource = await _c.SerialPorts(), Text = serialNow?.Device ?? "", PlaceholderText = "COM3", HorizontalAlignment = HorizontalAlignment.Stretch };
        var bauds = new List<string> { "1200", "2400", "4800", "9600", "19200", "38400", "57600", "115200", "230400", "460800", "921600" };
        var baud = new ComboBox { Header = "Hız (baud)", IsEditable = true, ItemsSource = bauds, Text = (serialNow?.Baud ?? 9600).ToString(), HorizontalAlignment = HorizontalAlignment.Stretch };
        var dataBits = new ComboBox { Header = "Veri bitleri", ItemsSource = new[] { "8", "7", "6", "5" }, SelectedItem = (serialNow?.DataBits ?? 8).ToString(), HorizontalAlignment = HorizontalAlignment.Stretch };
        var parities = new[] { ("none", "Yok"), ("even", "Çift"), ("odd", "Tek") };
        var parity = new ComboBox { Header = "Eşlik", ItemsSource = parities.Select(x => x.Item2).ToList(), SelectedIndex = Math.Max(0, Array.FindIndex(parities, x => x.Item1 == (serialNow?.Parity ?? "none"))), HorizontalAlignment = HorizontalAlignment.Stretch };
        var stopBits = new ComboBox { Header = "Durdurma bitleri", ItemsSource = new[] { "1", "2" }, SelectedItem = (serialNow?.StopBits ?? 1).ToString(), HorizontalAlignment = HorizontalAlignment.Stretch };
        var flows = new[] { ("none", "Yok"), ("hardware", "Donanım (RTS/CTS)"), ("software", "Yazılım (XON/XOFF)") };
        var flow = new ComboBox { Header = "Akış denetimi", ItemsSource = flows.Select(x => x.Item2).ToList(), SelectedIndex = Math.Max(0, Array.FindIndex(flows, x => x.Item1 == (serialNow?.Flow ?? "none"))), HorizontalAlignment = HorizontalAlignment.Stretch };
        var serialPanel = new StackPanel { Spacing = 10 };
        foreach (var e in new UIElement[] { serialDevice, baud, dataBits, parity, stopBits, flow }) serialPanel.Children.Add(e);
        // Telnet logs in inside the terminal; a serial port has no address at all.
        void SyncProtocol()
        {
            var chosenKind = protocols[Math.Max(0, protocol.SelectedIndex)].Item1;
            // Mosh logs in with SSH, so it keeps the login fields (not the jump host: UDP cannot go through it).
            var ssh = chosenKind is "ssh" or "mosh";
            var isSerial = chosenKind == "serial";
            foreach (var e in new UIElement[] { user, identity, kind, keyChoice, startup, envText, agent })
                e.Visibility = ssh ? Visibility.Visible : Visibility.Collapsed;
            jump.Visibility = chosenKind == "ssh" ? Visibility.Visible : Visibility.Collapsed;
            host.Visibility = port.Visibility = isSerial ? Visibility.Collapsed : Visibility.Visible;
            serialPanel.Visibility = isSerial ? Visibility.Visible : Visibility.Collapsed;
            if (chosenKind == "telnet" && port.Value == 22) port.Value = 23;
            if (ssh && port.Value == 23) port.Value = 22;
        }
        protocol.SelectionChanged += (_, _) => SyncProtocol();
        SyncProtocol();
        var panel = new StackPanel { Spacing = 10, MinWidth = 400 };
        foreach (var e in new UIElement[] { protocol, label, host, serialPanel, user, port, group, identity, kind, keyChoice, jump, terminalOptions, error }) panel.Children.Add(e);
        var dialog = Dialog(existing is null ? "Yeni sunucu" : "Sunucuyu düzenle", new ScrollViewer { Content = panel, MaxHeight = 560 }, "Kaydet");
        dialog.PrimaryButtonClick += async (d, args) =>
        {
            var deferral = args.GetDeferral();
            try
            {
                var chosen = protocols[Math.Max(0, protocol.SelectedIndex)].Item1;
                var ssh = chosen is "ssh" or "mosh";
                if (!ssh && string.IsNullOrWhiteSpace(user.Text)) user.Text = chosen;
                SerialSettings? serialSettings = null;
                if (chosen == "serial")
                {
                    var device = (serialDevice.Text ?? serialDevice.SelectedItem as string ?? "").Trim();
                    if (device.Length == 0) throw new CoreException("Seri portu seç ya da yaz (ör. COM3).");
                    if (!int.TryParse((baud.Text ?? baud.SelectedItem as string ?? "").Trim(), out var baudValue)) throw new CoreException("Hız (baud) bir sayı olmalı.");
                    serialSettings = new SerialSettings(device, baudValue, int.Parse((string)dataBits.SelectedItem), parities[Math.Max(0, parity.SelectedIndex)].Item1,
                        int.Parse((string)stopBits.SelectedItem), flows[Math.Max(0, flow.SelectedIndex)].Item1);
                    // The profile still needs an address; the port is the real target.
                    host.Text = "serial";
                    port.Value = 1;
                }
                var jumpId = chosen == "ssh" && jump.SelectedIndex > 0 ? candidates[jump.SelectedIndex - 1].Id : null;
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
                if (saved is not null && ((saved.Protocol ?? "ssh") != chosen || saved.Serial != serialSettings))
                {
                    await _c.SetHostConnection(saved, chosen, serialSettings);
                    saved = _c.Hosts.FirstOrDefault(h => h.Id == saved.Id) ?? saved;
                }
                var identityId = identity.SelectedIndex > 0 ? identities[identity.SelectedIndex - 1].Id : null;
                if (identityId is null && saved is not null && saved.KeyId != keyId) await _c.SetHostKey(saved, keyId);
                if (saved is not null && saved.IdentityId != identityId) await _c.SetHostIdentity(saved, identityId);
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
                        || saved.SessionLog != (sessionLog.IsChecked == true)
                        || old.Count != vars.Count || old.Any(kv => !vars.TryGetValue(kv.Key, out var v) || v != kv.Value);
                    if (changed) await _c.SetHostOptions(saved, cmd.Length == 0 ? null : cmd, vars, agent.IsChecked == true, sessionLog.IsChecked == true);
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
        // Telnet, serial and Mosh hosts have no SSH login to ask for.
        if (!host.IsSsh)
        {
            await Connect(host, new { kind = "password", secret = "", remember = false }, null, askOnCredentialError: false);
            return;
        }
        // Key hosts are tried first: the core also tries this computer's ~/.ssh keys.
        if (host.CanConnectSilently || host.AuthKind == "key")
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
        var installKey = new CheckBox { Content = "Bir dahaki sefere parola sorma (bu bilgisayarın anahtarını sunucuya ekle)", IsChecked = true };
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
            installKey.Visibility = k ? Visibility.Collapsed : Visibility.Visible;
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
        foreach (var e in new UIElement[] { useKey, keyRow, key, passphrase, password, installKey, remember }) panel.Children.Add(e);
        // A server that takes keys only: this computer's key and the one line
        // that puts it on the server (the hosting panel's web console works too).
        var keyOnly = message is not null && message.Contains("yalnız SSH anahtarı");
        KeyMeta? appKey = null;
        if (keyOnly)
        {
            try { appKey = await AppKey(); }
            catch (CoreException e) { Show(e.Message, InfoBarSeverity.Error); }
        }
        if (appKey is not null)
        {
            var line = $"mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '{appKey.PublicKey.Trim()}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys";
            var steps = new StackPanel { Spacing = 8 };
            steps.Children.Add(new TextBlock
            {
                TextWrapping = TextWrapping.Wrap,
                Text = "Bir kez yapılır: aşağıdaki satırı sunucuda çalıştır (sunucu sağlayıcının web konsolundan ya da sunucuya girebilen başka bir kullanıcıyla), sonra \"Bu bilgisayarın anahtarıyla bağlan\"a bas.",
            });
            steps.Children.Add(new TextBox { Text = line, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Cascadia Mono, Consolas") });
            var copy = new Button { Content = "Satırı kopyala" };
            copy.Click += (_, _) =>
            {
                var package = new Windows.ApplicationModel.DataTransfer.DataPackage();
                package.SetText(line);
                Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
                copy.Content = "Kopyalandı";
            };
            steps.Children.Add(copy);
            panel.Children.Insert(1, new Expander { Header = "Bu bilgisayarın anahtarını sunucuya ekle", Content = steps, IsExpanded = true, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch });
            useKey.SelectedIndex = 0;
        }
        var dialog = Dialog($"{host.Label} · {host.Target}", panel, "Bağlan");
        if (appKey is not null) dialog.SecondaryButtonText = "Bu bilgisayarın anahtarıyla bağlan";
        var choice = await ShowDialog(dialog);
        if (choice == ContentDialogResult.Secondary && appKey is not null)
        {
            await _c.SetHostKey(host, appKey.Id);
            var keyed = _c.Hosts.FirstOrDefault(h => h.Id == host.Id) ?? host;
            await Connect(keyed, new { kind = "key", secret = "", remember = false }, null, askOnCredentialError: true);
            return;
        }
        if (choice != ContentDialogResult.Primary) return;
        object auth = useKey.SelectedIndex == 0
            ? new { kind = "key", secret = key.Text, passphrase = passphrase.Password, remember = remember.IsChecked == true, keyPath = string.IsNullOrEmpty(key.Text) ? keyPath : null }
            : new { kind = "password", secret = password.Password, passphrase = (string?)null, remember = remember.IsChecked == true, keyPath = (string?)null, installKey = installKey.IsChecked == true };
        await Connect(host, auth, null, askOnCredentialError: true);
    }

    /// <summary>This computer's own key ("WECOMMANDER &lt;computer&gt;"), made the first time.</summary>
    private async Task<KeyMeta> AppKey()
    {
        var label = "WECOMMANDER " + Environment.MachineName;
        var found = (await _c.Keys()).FirstOrDefault(k => k.Label == label);
        return found ?? (await _c.GenerateKey(label)).First(k => k.Label == label);
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

    private MenuFlyout ShareMenu()
    {
        var menu = new MenuFlyout();
        menu.Opening += (_, _) =>
        {
            menu.Items.Clear();
            if (Current is not { Closed: false } tab) return;
            if (tab.Hosting is { } share)
            {
                var allow = new ToggleMenuFlyoutItem { Text = "Misafirler yazabilsin", IsChecked = share.AllowInput };
                allow.Click += (_, _) => share.AllowInput = allow.IsChecked;
                menu.Items.Add(allow);
                menu.Items.Add(new MenuFlyoutSeparator());
                if (share.Guests.Count == 0) menu.Items.Add(new MenuFlyoutItem { Text = "Henüz izleyen yok", IsEnabled = false });
                foreach (var (id, email) in share.Guests.ToList())
                    menu.Items.Add(Item($"Çıkar: {email}", () => _ = share.KickAsync(id)));
                menu.Items.Add(new MenuFlyoutSeparator());
                menu.Items.Add(Item("Paylaşmayı durdur", async () => { await _c.StopSharing(tab); SyncCommands(); Show("Paylaşım durduruldu.", InfoBarSeverity.Informational); }));
                return;
            }
            menu.Items.Add(Item("Paylaş: yalnız izlesinler", () => _ = StartShare(tab, false)));
            menu.Items.Add(Item("Paylaş: yazabilsinler de", () => _ = StartShare(tab, true)));
        };
        return menu;
    }

    private async Task StartShare(TerminalTab tab, bool allowInput)
    {
        try
        {
            await _c.StartSharing(tab, allowInput);
            tab.Hosting!.GuestsChanged += () => DispatcherQueue.TryEnqueue(() =>
            {
                SyncCommands();
                Show($"Bu terminali izleyen: {tab.Hosting?.Guests.Count ?? 0} kişi.", InfoBarSeverity.Informational);
            });
            SyncCommands();
            Show("Terminal ekiple paylaşılıyor. Ekiptekiler Sunucular → \"Ortak terminaller\"den katılabilir.", InfoBarSeverity.Success);
        }
        catch (Exception e) when (e is CoreException or GatewayException or System.Net.WebSockets.WebSocketException)
        {
            Show("Paylaşılamadı: " + e.Message, InfoBarSeverity.Error);
        }
    }

    /// <summary>Teammates' shared terminals; joining opens a tab here.</summary>
    private async Task ShowShares()
    {
        List<ShareInfo> shares;
        try { shares = await _c.Shares(); }
        catch (GatewayException e) { Show(e.Message, InfoBarSeverity.Error); return; }
        var list = new StackPanel { Spacing = 8, MinWidth = 420 };
        if (shares.Count == 0) list.Children.Add(new TextBlock { Text = "Şu an ekipte paylaşılan terminal yok. Bir terminalde \"Ekiple paylaş\" ile başlatılır.", TextWrapping = TextWrapping.Wrap, Foreground = Secondary });
        var dialog = Dialog("Ortak terminaller", list, "Kapat", "Vazgeç");
        dialog.PrimaryButtonText = "";
        dialog.CloseButtonText = "Kapat";
        foreach (var s in shares)
        {
            var row = new Grid { ColumnSpacing = 8 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var text = new StackPanel();
            text.Children.Add(new TextBlock { Text = s.Title, Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
            text.Children.Add(new TextBlock { Text = $"{s.HostEmail} · {s.Guests} izleyen", Foreground = Secondary, FontSize = 12 });
            row.Children.Add(text);
            var join = new Button { Content = "Katıl" };
            join.Click += async (_, _) => { dialog.Hide(); await JoinShare(s); };
            Grid.SetColumn(join, 1); row.Children.Add(join);
            list.Children.Add(row);
        }
        await ShowDialog(dialog);
    }

    private async Task JoinShare(ShareInfo info)
    {
        try
        {
            var share = await _c.JoinShare(info);
            var host = new CoreHost("share:" + info.Id, $"{info.Title} · {info.HostEmail}", info.HostEmail, "key", false, null, null, null);
            AddTab(host, "share:" + info.Id);
            var tab = CurrentPage?.Panes.LastOrDefault(p => p.SessionId == "share:" + info.Id);
            if (tab is null) { await share.DisposeAsync(); return; }
            tab.Guest = share;
            share.Output += b64 => DispatcherQueue.TryEnqueue(() => tab.Post(JsonSerializer.Serialize(new { type = "output", data = b64 })));
            share.Ended += reason => DispatcherQueue.TryEnqueue(() =>
            {
                tab.Closed = true;
                tab.Post(JsonSerializer.Serialize(new { type = "text", data = $"\r\n\u001b[90m[{reason}]\u001b[0m\r\n" }));
                tab.Caption.Text = tab.Host.Label + " (bitti)";
                SyncCommands();
            });
        }
        catch (Exception e) when (e is CoreException or GatewayException or System.Net.WebSockets.WebSocketException)
        {
            Show("Katılamadın: " + e.Message, InfoBarSeverity.Error);
        }
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
        core.WebMessageReceived += (sender, e) =>
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
                    _ = SendCommands(tab);
                    break;
                case "command":
                    _ = _c.AddCommand(tab.Host.Id, (string?)m!["line"] ?? "", (string?)m["prompt"] ?? "");
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

    /// <summary>Autocomplete: this host's commands and the snippets, for the terminal page.</summary>
    private async Task SendCommands(TerminalTab tab)
    {
        if (tab.Guest is not null) return; // a teammate's terminal: not ours to remember
        var list = await _c.Commands(tab.Host.Id);
        var snippets = (await _c.Snippets()).Select(s => s.Command.Trim()).Where(c => c.Length > 0).ToList();
        tab.Post(JsonSerializer.Serialize(new { type = "commands", list, snippets }));
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

    // Two-pane mode: this computer's folder on the left, the server on the right.
    private readonly Grid _localPane = new() { Visibility = Visibility.Collapsed };
    private readonly ListView _localList = new() { SelectionMode = ListViewSelectionMode.Extended };
    private readonly TextBox _localPath = new() { VerticalAlignment = VerticalAlignment.Center };
    private readonly AppBarToggleButton _twoPane = new() { Label = "İki panel", Icon = new FontIcon { Glyph = "\uE89F" }, LabelPosition = CommandBarLabelPosition.Collapsed };
    private string _localDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    private void BuildFilesPane()
    {
        _filesPane.Background = (Brush)Application.Current.Resources["LayerFillColorDefaultBrush"];
        _filesPane.BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"];
        _filesPane.BorderThickness = new Thickness(1, 0, 0, 0);
        _filesPane.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _filesPane.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var remote = new Grid();
        Grid.SetColumn(remote, 1);
        remote.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        remote.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        remote.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
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
        ToolTipService.SetToolTip(_twoPane, "Bu bilgisayarı yanında göster (yerel ↔ sunucu)");
        _twoPane.Click += (_, _) => SetTwoPane(_twoPane.IsChecked == true);
        var head = new Grid { Padding = new Thickness(8), ColumnSpacing = 6 };
        for (var i = 0; i < 6; i++) head.ColumnDefinitions.Add(new ColumnDefinition { Width = i == 1 ? new GridLength(1, GridUnitType.Star) : GridLength.Auto });
        head.Children.Add(up);
        Grid.SetColumn(_filesPath, 1); head.Children.Add(_filesPath);
        Grid.SetColumn(refresh, 2); head.Children.Add(refresh);
        Grid.SetColumn(upload, 3); head.Children.Add(upload);
        Grid.SetColumn(mkdir, 4); head.Children.Add(mkdir);
        Grid.SetColumn(_twoPane, 5); head.Children.Add(_twoPane);
        remote.Children.Add(head);
        Grid.SetRow(_fileList, 1);
        _fileList.DoubleTapped += (_, _) =>
        {
            if (_fileList.SelectedItem is ListViewItem { Tag: RemoteEntry e } && (e.IsFolder || e.Kind == "link")) _ = LoadFiles(e.Path);
        };
        _fileList.AllowDrop = true;
        _fileList.DragOver += (_, e) => e.AcceptedOperation = Windows.ApplicationModel.DataTransfer.DataPackageOperation.Copy;
        _fileList.Drop += async (_, e) =>
        {
            // From the local pane: paths as text, one per line.
            if (e.DataView.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.Text) && !e.DataView.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems))
            {
                var text = await e.DataView.GetTextAsync();
                foreach (var path in text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    if (File.Exists(path)) await Upload(path);
                return;
            }
            if (!e.DataView.Contains(Windows.ApplicationModel.DataTransfer.StandardDataFormats.StorageItems)) return;
            foreach (var item in await e.DataView.GetStorageItemsAsync())
                if (item is Windows.Storage.StorageFile f) await Upload(f.Path);
        };
        remote.Children.Add(_fileList);
        Grid.SetRow(_transfers, 2);
        remote.Children.Add(_transfers);
        _filesPane.Children.Add(remote);
        BuildLocalPane();
        _filesPane.Children.Add(_localPane);
    }

    private void BuildLocalPane()
    {
        _localPane.Width = 340;
        _localPane.BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"];
        _localPane.BorderThickness = new Thickness(0, 0, 1, 0);
        _localPane.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _localPane.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _localPane.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var up = new Button { Content = new SymbolIcon(Symbol.Up) };
        ToolTipService.SetToolTip(up, "Üst klasör");
        up.Click += (_, _) => { if (Directory.GetParent(_localDir) is { } parent) LoadLocal(parent.FullName); };
        _localPath.KeyDown += (_, e) => { if (e.Key == Windows.System.VirtualKey.Enter) LoadLocal(_localPath.Text.Trim()); };
        var head = new Grid { Padding = new Thickness(8), ColumnSpacing = 6 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.Children.Add(up);
        Grid.SetColumn(_localPath, 1); head.Children.Add(_localPath);
        _localPane.Children.Add(head);
        Grid.SetRow(_localList, 1);
        _localList.DoubleTapped += (_, _) =>
        {
            if (_localList.SelectedItem is ListViewItem { Tag: FileSystemInfo { } info } && info is DirectoryInfo d) LoadLocal(d.FullName);
        };
        _localList.CanDragItems = true;
        _localList.DragItemsStarting += (_, e) =>
        {
            var paths = e.Items.OfType<ListViewItem>().Select(i => i.Tag).OfType<FileInfo>().Select(f => f.FullName).ToList();
            if (paths.Count == 0) { e.Cancel = true; return; }
            e.Data.SetText(string.Join("\n", paths));
            e.Data.RequestedOperation = Windows.ApplicationModel.DataTransfer.DataPackageOperation.Copy;
        };
        _localList.AllowDrop = true;
        _localList.DragOver += (_, e) =>
        {
            if (e.DataView.Properties.TryGetValue("wc-remote", out _)) e.AcceptedOperation = Windows.ApplicationModel.DataTransfer.DataPackageOperation.Copy;
        };
        _localList.Drop += async (_, e) =>
        {
            if (Current is not { Closed: false } tab || !e.DataView.Properties.TryGetValue("wc-remote", out var value) || value is not string remotePaths) return;
            foreach (var path in remotePaths.Split('\n', StringSplitOptions.RemoveEmptyEntries))
                await DownloadHere(tab, path, path[(path.LastIndexOf('/') + 1)..]);
        };
        _localPane.Children.Add(_localList);
        var send = new Button { Content = "Seçilenleri sunucuya yükle →", HorizontalAlignment = HorizontalAlignment.Stretch, Margin = new Thickness(8) };
        send.Click += async (_, _) =>
        {
            foreach (var f in _localList.SelectedItems.OfType<ListViewItem>().Select(i => i.Tag).OfType<FileInfo>().ToList())
                await Upload(f.FullName);
        };
        Grid.SetRow(send, 2);
        _localPane.Children.Add(send);
        _fileList.CanDragItems = true;
        _fileList.SelectionMode = ListViewSelectionMode.Extended;
        _fileList.DragItemsStarting += (_, e) =>
        {
            var paths = e.Items.OfType<ListViewItem>().Select(i => i.Tag).OfType<RemoteEntry>().Where(r => !r.IsFolder).Select(r => r.Path).ToList();
            if (paths.Count == 0) { e.Cancel = true; return; }
            e.Data.Properties["wc-remote"] = string.Join("\n", paths);
            e.Data.RequestedOperation = Windows.ApplicationModel.DataTransfer.DataPackageOperation.Copy;
        };
    }

    private void SetTwoPane(bool on)
    {
        _twoPane.IsChecked = on;
        _localPane.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        _filesPane.Width = on ? 720 : 340;
        if (on) LoadLocal(_localDir);
    }

    private void LoadLocal(string dir)
    {
        _localList.Items.Clear();
        try
        {
            var info = new DirectoryInfo(dir);
            var entries = info.EnumerateFileSystemInfos()
                .Where(e => !e.Attributes.HasFlag(FileAttributes.Hidden) && !e.Attributes.HasFlag(FileAttributes.System))
                .OrderBy(e => e is FileInfo).ThenBy(e => e.Name, StringComparer.CurrentCultureIgnoreCase)
                .Take(2000).ToList();
            _localDir = info.FullName;
            _localPath.Text = _localDir;
            foreach (var e in entries)
            {
                var row = new Grid { ColumnSpacing = 8 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.Children.Add(new FontIcon { Glyph = e is DirectoryInfo ? "\uE8B7" : "\uE8A5", FontSize = 16 });
                var name = new TextBlock { Text = e.Name, TextTrimming = TextTrimming.CharacterEllipsis };
                Grid.SetColumn(name, 1); row.Children.Add(name);
                var size = new TextBlock { Text = e is FileInfo f ? Size((ulong)f.Length) : "", Foreground = Secondary, FontSize = 12 };
                Grid.SetColumn(size, 2); row.Children.Add(size);
                var item = new ListViewItem { Content = row, Tag = e };
                if (e is FileInfo file)
                {
                    var menu = new MenuFlyout();
                    menu.Items.Add(Item("Sunucuya yükle →", () => _ = Upload(file.FullName)));
                    item.ContextFlyout = menu;
                }
                _localList.Items.Add(item);
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException or ArgumentException)
        {
            _localPath.Text = _localDir;
            _localList.Items.Add(new ListViewItem { Content = new TextBlock { Text = "Klasör açılamadı: " + e.Message, TextWrapping = TextWrapping.Wrap }, IsEnabled = false });
        }
    }

    /// <summary>Downloads a server file into the folder open in the local pane.</summary>
    private async Task DownloadHere(TerminalTab tab, string remotePath, string name)
    {
        var target = Path.Combine(_localDir, name);
        if (File.Exists(target))
        {
            var dialog = Dialog($"{name} zaten var", new TextBlock { Text = "Bu bilgisayardaki dosyanın üzerine yazılsın mı?" }, "Üzerine yaz");
            if (await ShowDialog(dialog) != ContentDialogResult.Primary) return;
        }
        await Transfer($"⬇ {name}", id => _c.FilesAction(tab, "files.download", new { sessionId = tab.SessionId, remote = remotePath, local = target, transferId = id }));
        LoadLocal(_localDir);
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
        if (!e.IsFolder) menu.Items.Add(Item("← Açık yerel klasöre indir", () => { if (_localPane.Visibility != Visibility.Visible) SetTwoPane(true); _ = DownloadHere(tab, e.Path, e.Name); }));
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
    /// <summary>A27: this terminal is shared with the team (host side).</summary>
    public TerminalShare? Hosting { get; set; }
    /// <summary>A27: a teammate's shared terminal watched here (guest side).</summary>
    public TerminalShare? Guest { get; set; }
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
