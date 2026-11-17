using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Wecommander.Center.Core;
using Windows.Graphics;

namespace Wecommander.Center;

/// <summary>
/// The Dock's start panel: opens from the WECOMMANDER icon like the Windows
/// Start menu, away from the Dock's edge, and closes when it loses the focus.
/// On top a search over the saved servers (Enter or a click opens a terminal
/// to it), then tiles that open screens (servers, terminals, files, Task
/// Manager, tasks and timers, disk, approvals), and at the bottom the account,
/// settings and exit. Nothing risky runs from here.
/// </summary>
public sealed class QuickPanel : Window
{
    private readonly Grid _root = new();
    private readonly TranslateTransform _slide = new();
    private readonly AutoSuggestBox _search = new() { QueryIcon = new SymbolIcon(Symbol.Find) };
    private readonly ScrollViewer _tiles = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    private readonly StackPanel _results = new() { Spacing = 2, XYFocusKeyboardNavigation = XYFocusKeyboardNavigationMode.Enabled };
    private readonly ScrollViewer _resultsScroll = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Visibility = Visibility.Collapsed };
    private readonly TextBlock _approvals = new() { FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis, HorizontalAlignment = HorizontalAlignment.Center };
    private readonly TextBlock _account = new() { FontSize = 13, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
    private readonly PersonPicture _avatar = new() { Width = 28, Height = 28 };
    private List<CoreHost> _matches = [];
    private Func<WatchedServer?> _selected = () => null;
    private PixelRect _anchor;
    private DockEdge _side;
    private DateTime _hiddenAt, _shownAt;

    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    public QuickPanel()
    {
        Title = L.T("WECOMMANDER hızlı panel");
        SystemBackdrop = new DesktopAcrylicBackdrop();
        AppWindow.IsShownInSwitchers = false;
        ExtendsContentIntoTitleBar = false;
        if (AppWindow.Presenter is OverlappedPresenter p)
        {
            p.IsResizable = false;
            p.IsMaximizable = false;
            p.IsMinimizable = false;
            p.IsAlwaysOnTop = true;
            p.SetBorderAndTitleBar(true, false);
        }
        AppWindow.Closing += (_, e) => { e.Cancel = true; Hide(); };
        Activated += (_, e) =>
        {
            if (e.WindowActivationState != WindowActivationState.Deactivated || !AppWindow.IsVisible) return;
            // The click that opened it can activate the Dock a moment later: take the focus back.
            if (DateTime.UtcNow - _shownAt < TimeSpan.FromMilliseconds(800))
            {
                DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () => Activate());
                return;
            }
            Hide();
        };

        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RenderTransform = _slide;
        _root.Padding = new Thickness(14, 14, 14, 10);
        _root.RowSpacing = 12;
        _root.KeyDown += (_, e) => { if (e.Key == Windows.System.VirtualKey.Escape) Hide(); };

        // Search, as in the Start menu: typing finds a saved server, Enter connects.
        _search.PlaceholderText = L.T("Sunucu ara (ad, adres, grup)");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(_search, L.T("Sunucu ara (ad, adres, grup)"));
        _search.TextChanged += (_, _) => { try { Search(); } catch (Exception e) { App.LogCrash(e); } };
        _search.QuerySubmitted += (_, _) => { if (_matches.Count > 0) Connect(_matches[0]); };
        _search.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler((_, e) =>
        {
            if (e.Key == Windows.System.VirtualKey.Escape && !string.IsNullOrEmpty(_search.Text))
            {
                // Esc clears the search first, a second Esc closes the panel.
                _search.Text = "";
                e.Handled = true;
            }
            else if (e.Key == Windows.System.VirtualKey.Down && _results.Children.OfType<Button>().FirstOrDefault() is { } first && _resultsScroll.Visibility == Visibility.Visible)
            {
                first.Focus(FocusState.Keyboard);
                e.Handled = true;
            }
        }), true);
        _root.Children.Add(_search);

        var tiles = new Grid { ColumnSpacing = 6, RowSpacing = 6 };
        for (var c = 0; c < 3; c++) tiles.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var entries = new (string Glyph, string Text, Action Open, TextBlock? Detail)[]
        {
            ("", L.T("Sunucularım"), () => App.Current.ToggleMonitorPanelFromDock(_anchor, _side), null),
            ("", L.T("Terminaller"), () => App.Current.ShowTerminals(files: false), null),
            ("", L.T("Dosya yöneticisi"), () => App.Current.ShowTerminals(files: true), null),
            ("", L.T("Görev Yöneticisi"), () => TaskManagerWindow.Open(), null),
            ("", L.T("WECOMMANDER görevleri"), () => App.Current.ShowScheduledTasks(), null),
            ("", L.T("Windows zamanlayıcıları"), () => TaskSchedulerWindow.Open(), null),
            ("", L.T("Sunucu zamanlayıcıları"), () => OpenServer("timers"), null),
            ("", L.T("Disk ve temizlik"), () => OpenServer("disk"), null),
            ("", L.T("Bildirimler / Bekleyen onaylar"), () => App.Current.ShowApprovals(), _approvals),
        };
        for (var i = 0; i < entries.Length; i++)
        {
            var (glyph, text, open, detail) = entries[i];
            if (tiles.RowDefinitions.Count <= i / 3) tiles.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var tile = Tile(glyph, text, detail, open);
            Grid.SetRow(tile, i / 3);
            Grid.SetColumn(tile, i % 3);
            tiles.Children.Add(tile);
        }
        _tiles.Content = tiles;
        Grid.SetRow(_tiles, 1);
        _root.Children.Add(_tiles);
        _resultsScroll.Content = _results;
        Grid.SetRow(_resultsScroll, 1);
        _root.Children.Add(_resultsScroll);

        // Bottom bar, as in the Start menu: the account (opens WECOMMANDER), settings, exit.
        var bar = new Grid { ColumnSpacing = 4, Padding = new Thickness(0, 8, 0, 0), BorderThickness = new Thickness(0, 1, 0, 0),
            BorderBrush = (Brush)Application.Current.Resources["DividerStrokeColorDefaultBrush"] };
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var who = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        who.Children.Add(_avatar);
        who.Children.Add(_account);
        var account = BarButton(who, L.T("WECOMMANDER'ı aç"), () => App.Current.ShowServers());
        account.HorizontalAlignment = HorizontalAlignment.Left;
        account.HorizontalContentAlignment = HorizontalAlignment.Left;
        account.Padding = new Thickness(6, 4, 10, 4);
        bar.Children.Add(account);
        var settings = BarButton(new FontIcon { Glyph = "", FontSize = 16 }, L.T("Ayarlar"), () => App.Current.ShowDockSettings());
        Grid.SetColumn(settings, 1);
        bar.Children.Add(settings);
        var power = new Button { Content = new FontIcon { Glyph = "", FontSize = 16 }, Width = 40, Height = 40, Padding = new Thickness(0),
            Background = new SolidColorBrush(Colors.Transparent), BorderThickness = new Thickness(0) };
        ToolTipService.SetToolTip(power, L.T("WECOMMANDER'dan çık"));
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(power, L.T("WECOMMANDER'dan çık"));
        // A menu, not a direct exit (one stray click must not close the app); kept inside the panel's window.
        var powerMenu = new MenuFlyout { ShouldConstrainToRootBounds = true };
        var quit = new MenuFlyoutItem { Text = L.T("WECOMMANDER'dan çık"), Icon = new FontIcon { Glyph = "" } };
        quit.Click += (_, _) =>
        {
            Hide();
            try { App.Current.QuitApp(); } catch (Exception e) { App.LogCrash(e); }
        };
        powerMenu.Items.Add(quit);
        power.Flyout = powerMenu;
        Grid.SetColumn(power, 2);
        bar.Children.Add(power);
        Grid.SetRow(bar, 2);
        _root.Children.Add(bar);
        Content = _root;
    }

    private Button Tile(string glyph, string text, TextBlock? detail, Action open)
    {
        var p = new StackPanel { Spacing = 6, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        p.Children.Add(new FontIcon { Glyph = glyph, FontSize = 20, HorizontalAlignment = HorizontalAlignment.Center });
        p.Children.Add(new TextBlock { Text = text, FontSize = 12, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center });
        if (detail is not null)
        {
            detail.Foreground = Secondary;
            p.Children.Add(detail);
        }
        var button = new Button
        {
            Content = p,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            VerticalAlignment = VerticalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Center,
            Padding = new Thickness(6, 10, 6, 10),
            MinHeight = 80,
            Background = new SolidColorBrush(Colors.Transparent),
            BorderThickness = new Thickness(0),
        };
        ToolTipService.SetToolTip(button, text);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, text);
        button.Click += (_, _) => Run(open);
        return button;
    }

    private Button BarButton(UIElement content, string tip, Action open)
    {
        var button = new Button { Content = content, MinWidth = 40, Height = 40, Padding = new Thickness(0),
            Background = new SolidColorBrush(Colors.Transparent), BorderThickness = new Thickness(0) };
        ToolTipService.SetToolTip(button, tip);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, tip);
        button.Click += (_, _) => Run(open);
        return button;
    }

    /// <summary>Closes the panel, then opens the screen (an error is logged and told, never thrown).</summary>
    private void Run(Action open)
    {
        Hide();
        try { open(); } catch (Exception e) { App.LogCrash(e); App.Current.Toast(L.F("Açılamadı: {0}", e.Message)); }
    }

    // ---- search ----

    /// <summary>The saved servers matching the search (name, address, group), shown in place of the tiles.</summary>
    private void Search()
    {
        var query = _search.Text?.Trim() ?? "";
        _results.Children.Clear();
        _matches = [];
        var searching = query.Length > 0;
        _tiles.Visibility = searching ? Visibility.Collapsed : Visibility.Visible;
        _resultsScroll.Visibility = searching ? Visibility.Visible : Visibility.Collapsed;
        if (!searching) return;
        var hosts = App.Current.Servers.Hosts;
        // The same fields as the main window's server search (and the bare address); names starting with it first.
        _matches = hosts.Where(h => (h.Label ?? "").Contains(query, StringComparison.CurrentCultureIgnoreCase)
                || (h.Target ?? "").Contains(query, StringComparison.OrdinalIgnoreCase)
                || (h.Host ?? "").Contains(query, StringComparison.OrdinalIgnoreCase)
                || (h.Group ?? "").Contains(query, StringComparison.CurrentCultureIgnoreCase))
            .OrderBy(h => (h.Label ?? "").StartsWith(query, StringComparison.CurrentCultureIgnoreCase) ? 0 : 1)
            .ThenBy(h => h.Label ?? "", StringComparer.CurrentCultureIgnoreCase)
            .Take(30)
            .ToList();
        if (_matches.Count == 0)
        {
            _results.Children.Add(new TextBlock
            {
                Text = hosts.Count == 0 ? L.T("Henüz sunucu yok") : L.T("Eşleşen sunucu yok."),
                Foreground = Secondary,
                Margin = new Thickness(4, 8, 4, 0),
            });
            return;
        }
        foreach (var host in _matches) _results.Children.Add(Result(host));
    }

    private Button Result(CoreHost host)
    {
        var row = new Grid { ColumnSpacing = 12 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.Children.Add(new FontIcon { Glyph = "", FontSize = 16, VerticalAlignment = VerticalAlignment.Center });
        var text = new StackPanel();
        text.Children.Add(new TextBlock { Text = host.Label, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis });
        text.Children.Add(new TextBlock { Text = host.Target, FontSize = 12, Foreground = Secondary, TextTrimming = TextTrimming.CharacterEllipsis });
        Grid.SetColumn(text, 1);
        row.Children.Add(text);
        var button = new Button
        {
            Content = row,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Padding = new Thickness(8, 6, 8, 6),
            Background = new SolidColorBrush(Colors.Transparent),
            BorderThickness = new Thickness(0),
        };
        ToolTipService.SetToolTip(button, L.F("{0}: terminal aç", host.Label));
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, host.Label);
        button.Click += (_, _) => Connect(host);
        return button;
    }

    /// <summary>The same as connecting from the server list: a terminal to the saved server in the main window.</summary>
    private void Connect(CoreHost host) => Run(() => App.Current.OpenHostTerminal(host.Id));

    /// <summary>A server screen (timers, disk) for the server the Dock shows; without one the server panel opens to add it.</summary>
    private void OpenServer(string section)
    {
        if (_selected() is { } s) App.Current.OpenServerManagement(s, section);
        else
        {
            App.Current.Toast(L.T("İzlenen sunucu yok: Sunucularım panelinden bir sunucu ekle."));
            App.Current.ToggleMonitorPanelFromDock(_anchor, _side);
        }
    }

    /// <summary>From the Dock's icon: next to it, toward <paramref name="side"/> (away from the Dock's edge); a second click closes it.</summary>
    public void ToggleFrom(PixelRect anchor, DockEdge side, Func<WatchedServer?> selected)
    {
        if (AppWindow.IsVisible) { Hide(); return; }
        if (DateTime.UtcNow - _hiddenAt <= TimeSpan.FromMilliseconds(400)) return;
        _anchor = anchor;
        _side = side;
        _selected = selected;
        _search.Text = "";
        Search();
        Refresh();
        var display = DisplayArea.GetFromPoint(new PointInt32(anchor.X + anchor.Width / 2, anchor.Y + anchor.Height / 2), DisplayAreaFallback.Primary);
        var w = display.WorkArea;
        var work = new PixelRect(w.X, w.Y, w.Width, w.Height);
        var scale = GetDpiForWindow(WinRT.Interop.WindowNative.GetWindowHandle(this)) / 96.0;
        var rect = DockLayout.PanelAt(anchor, side, (int)Math.Round(400 * scale), (int)Math.Round(540 * scale), work, (int)Math.Round(8 * scale));
        AppWindow.MoveAndResize(new RectInt32(rect.X, rect.Y, rect.Width, rect.Height));
        App.DebugLayout($"quick panel: from dock at {rect.X},{rect.Y} {rect.Width}x{rect.Height} side={side}");
        Present(side == DockEdge.Bottom ? -30 : side == DockEdge.Top ? 30 : 0, side == DockEdge.Right ? -30 : side == DockEdge.Left ? 30 : 0);
        // Typing goes straight to the search, as in the Start menu.
        DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () =>
        {
            try { _search.Focus(FocusState.Programmatic); } catch (Exception e) { App.LogCrash(e); }
        });
    }

    public void Hide()
    {
        _hiddenAt = DateTime.UtcNow;
        AppWindow.Hide();
    }

    private void Refresh()
    {
        var pending = App.Current.Pending.Count;
        _approvals.Text = pending == 0 ? L.T("Bekleyen onay yok") : L.F("{0} onay bekliyor", pending);
        _approvals.Foreground = pending == 0 ? Secondary : new SolidColorBrush(ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44));
        var center = App.Current;
        if (center.Phase == Phase.SignedIn && center.Me is { } me)
        {
            var name = string.IsNullOrWhiteSpace(me.Email) ? me.Name : me.Email!;
            _account.Text = name;
            _avatar.DisplayName = name;
        }
        else
        {
            _account.Text = L.T("Oturum açılmadı");
            _avatar.DisplayName = "";
        }
    }

    private void Present(double fromY, double fromX)
    {
        _shownAt = DateTime.UtcNow;
        AppWindow.Show();
        Activate();
        var y = new DoubleAnimation { From = fromY, To = 0, Duration = TimeSpan.FromMilliseconds(200), EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } };
        var x = new DoubleAnimation { From = fromX, To = 0, Duration = TimeSpan.FromMilliseconds(200), EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } };
        var fade = new DoubleAnimation { From = 0, To = 1, Duration = TimeSpan.FromMilliseconds(160) };
        Storyboard.SetTarget(y, _slide);
        Storyboard.SetTargetProperty(y, "Y");
        Storyboard.SetTarget(x, _slide);
        Storyboard.SetTargetProperty(x, "X");
        Storyboard.SetTarget(fade, _root);
        Storyboard.SetTargetProperty(fade, "Opacity");
        var story = new Storyboard();
        story.Children.Add(y);
        story.Children.Add(x);
        story.Children.Add(fade);
        story.Begin();
    }
}
