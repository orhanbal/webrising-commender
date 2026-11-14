using System.Runtime.InteropServices;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Media.Imaging;
using Wecommander.Center.Core;
using Windows.Graphics;

namespace Wecommander.Center;

/// <summary>
/// The taskbar panel: opens upward from the bottom of the screen when the
/// live server icon is clicked (like the weather panel), one card per
/// watched server with every live number.
/// </summary>
public sealed class MonitorFlyout : Window
{
    private readonly ServerMonitor _monitor;
    private readonly StackPanel _cards = new() { Spacing = 12 };
    private readonly Dictionary<string, ServerCard> _byHost = [];
    private readonly Grid _root = new();
    private readonly TranslateTransform _slide = new();
    private DateTime _hiddenAt;

    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];

    public MonitorFlyout(ServerMonitor monitor)
    {
        _monitor = monitor;
        Title = "WECOMMANDER Sunucularım";
        SystemBackdrop = new DesktopAcrylicBackdrop();
        AppWindow.IsShownInSwitchers = false;
        ExtendsContentIntoTitleBar = true;
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
            if (e.WindowActivationState == WindowActivationState.Deactivated && AppWindow.IsVisible) Hide();
        };

        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _root.RenderTransform = _slide;
        _root.Padding = new Thickness(16, 14, 16, 16);
        _root.KeyDown += (_, e) => { if (e.Key == Windows.System.VirtualKey.Escape) Hide(); };

        var head = new Grid { ColumnSpacing = 10, Margin = new Thickness(0, 0, 0, 12) };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(Icon("chart_increasing", 34));
        var title = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        title.Children.Add(new TextBlock { Text = "Sunucularım", FontSize = 18, FontWeight = FontWeights.SemiBold });
        title.Children.Add(new TextBlock { Text = "Canlı · 3 saniyede bir", Foreground = Secondary, FontSize = 12 });
        Grid.SetColumn(title, 1);
        head.Children.Add(title);
        var add = new Button { Content = new SymbolIcon(Symbol.Add), Padding = new Thickness(8) };
        ToolTipService.SetToolTip(add, "İzlenecek sunucu ekle");
        add.Flyout = AddMenu();
        Grid.SetColumn(add, 2);
        head.Children.Add(add);
        _root.Children.Add(head);

        var scroll = new ScrollViewer { Content = _cards, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(scroll, 1);
        _root.Children.Add(scroll);
        Content = _root;
        _monitor.Changed += Refresh;
        Refresh();
    }

    internal static Image Icon(string name, double size) => new()
    {
        Source = new BitmapImage(new Uri(Path.Combine(AppContext.BaseDirectory, "Assets", "monitor", name + ".png"))),
        Width = size,
        Height = size,
        VerticalAlignment = VerticalAlignment.Center,
    };

    private MenuFlyout AddMenu()
    {
        var menu = new MenuFlyout();
        menu.Opening += (_, _) =>
        {
            menu.Items.Clear();
            var hosts = App.Current.Servers.Hosts
                .Where(h => !_monitor.IsWatched(h.Id) && h.IsSsh)
                .OrderBy(h => h.Label, StringComparer.CurrentCultureIgnoreCase).Take(40).ToList();
            foreach (var h in hosts)
            {
                var item = new MenuFlyoutItem { Text = h.Label };
                item.Click += (_, _) => _monitor.Watch(h);
                menu.Items.Add(item);
            }
            if (hosts.Count == 0) menu.Items.Add(new MenuFlyoutItem { Text = "Eklenecek başka sunucu yok", IsEnabled = false });
        };
        return menu;
    }

    public void Toggle()
    {
        if (AppWindow.IsVisible) Hide();
        else if (DateTime.UtcNow - _hiddenAt > TimeSpan.FromMilliseconds(400)) ShowPanel();
    }

    public void Hide()
    {
        _hiddenAt = DateTime.UtcNow;
        AppWindow.Hide();
    }

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    public void ShowPanel()
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var scale = GetDpiForWindow(hwnd) / 96.0;
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var margin = (int)Math.Round(12 * scale);
        var width = Math.Min((int)Math.Round(440 * scale), area.Width - 2 * margin);
        var wanted = (int)Math.Round((96 + Math.Max(1, _monitor.Servers.Count) * 372) * scale);
        var height = Math.Min(wanted, area.Height - 2 * margin);
        // Bottom right, just above the taskbar: it opens upward from there.
        AppWindow.MoveAndResize(new RectInt32(area.X + area.Width - width - margin, area.Y + area.Height - height - margin, width, height));
        AppWindow.Show();
        Activate();
        Refresh();
        var rise = new DoubleAnimation { From = 40, To = 0, Duration = TimeSpan.FromMilliseconds(220), EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } };
        var fade = new DoubleAnimation { From = 0, To = 1, Duration = TimeSpan.FromMilliseconds(180) };
        Storyboard.SetTarget(rise, _slide);
        Storyboard.SetTargetProperty(rise, "Y");
        Storyboard.SetTarget(fade, _root);
        Storyboard.SetTargetProperty(fade, "Opacity");
        var story = new Storyboard();
        story.Children.Add(rise);
        story.Children.Add(fade);
        story.Begin();
    }

    private void Refresh()
    {
        foreach (var gone in _byHost.Keys.Where(k => !_monitor.IsWatched(k)).ToList())
        {
            _cards.Children.Remove(_byHost[gone].Root);
            _byHost.Remove(gone);
        }
        foreach (var s in _monitor.Servers)
        {
            if (!_byHost.TryGetValue(s.HostId, out var card))
            {
                card = new ServerCard(s, _monitor, this);
                _byHost[s.HostId] = card;
                _cards.Children.Add(card.Root);
            }
            card.Update(s);
        }
        if (_monitor.Servers.Count == 0 && _cards.Children.Count == 0)
        {
            var empty = new StackPanel { Spacing = 8, Margin = new Thickness(0, 24, 0, 0) };
            empty.Children.Add(Icon("desktop_computer", 64));
            empty.Children.Add(new TextBlock { Text = "İzlenen sunucu yok", HorizontalAlignment = HorizontalAlignment.Center, FontWeight = FontWeights.SemiBold });
            empty.Children.Add(new TextBlock { Text = "Yukarıdaki + ile ya da Sunucular listesinde sağ tık > \"Görev çubuğunda izle\" ile ekle.", Foreground = Secondary, TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center });
            _cards.Children.Add(empty);
        }
        else if (_monitor.Servers.Count > 0)
        {
            foreach (var stray in _cards.Children.Where(c => !_byHost.Values.Any(v => v.Root == c)).ToList())
                _cards.Children.Remove(stray);
        }
    }
}

/// <summary>One server in the taskbar panel.</summary>
internal sealed class ServerCard
{
    private readonly TextBlock _name = new() { FontSize = 16, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock _status = new() { FontSize = 12, TextWrapping = TextWrapping.Wrap };
    private readonly Microsoft.UI.Xaml.Shapes.Ellipse _dot = new() { Width = 10, Height = 10 };
    private readonly Tile _cpu = new("high_voltage", "İşlemci");
    private readonly Tile _mem = new("brain", "Bellek");
    private readonly Tile _disk = new("floppy_disk", "Disk /");
    private readonly TextBlock _net = new() { FontSize = 13 };
    private readonly TextBlock _io = new() { FontSize = 13 };
    private readonly TextBlock _zombies = new() { FontSize = 13 };
    private readonly StackPanel _zombieRow = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
    private readonly ColumnChart _chart = new("İşlemci geçmişi", Charts.Palette[0], v => $"%{v:0}", fixedMax: 100, capacity: 40, height: 56);
    private int _drawn;

    public Border Root { get; }

    public ServerCard(WatchedServer s, ServerMonitor monitor, MonitorFlyout flyout)
    {
        var secondary = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];
        _status.Foreground = secondary;
        var p = new StackPanel { Spacing = 12 };

        var head = new Grid { ColumnSpacing = 10 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(MonitorFlyout.Icon("desktop_computer", 40));
        var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        var nameRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        nameRow.Children.Add(_name);
        _dot.VerticalAlignment = VerticalAlignment.Center;
        nameRow.Children.Add(_dot);
        names.Children.Add(nameRow);
        names.Children.Add(_status);
        Grid.SetColumn(names, 1);
        head.Children.Add(names);
        var more = new Button { Content = new SymbolIcon(Symbol.More), Padding = new Thickness(6), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
        var menu = new MenuFlyout();
        var manage = new MenuFlyoutItem { Text = "Sunucu yönetimini aç", Icon = new FontIcon { Glyph = "" } };
        manage.Click += (_, _) => { flyout.Hide(); App.Current.OpenServerManagement(s); };
        var terminal = new MenuFlyoutItem { Text = "Terminal aç", Icon = new FontIcon { Glyph = "" } };
        terminal.Click += (_, _) => { flyout.Hide(); App.Current.OpenHostTerminal(s.HostId); };
        var stop = new MenuFlyoutItem { Text = "İzlemeyi bırak", Icon = new SymbolIcon(Symbol.Cancel) };
        stop.Click += (_, _) => monitor.Unwatch(s.HostId);
        menu.Items.Add(manage);
        menu.Items.Add(terminal);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(stop);
        more.Flyout = menu;
        Grid.SetColumn(more, 2);
        head.Children.Add(more);
        p.Children.Add(head);

        var tiles = new Grid { ColumnSpacing = 8 };
        var tileList = new[] { _cpu, _mem, _disk };
        for (var i = 0; i < tileList.Length; i++)
        {
            tiles.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn(tileList[i].Root, i);
            tiles.Children.Add(tileList[i].Root);
        }
        p.Children.Add(tiles);

        var lines = new StackPanel { Spacing = 6 };
        var netRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        netRow.Children.Add(MonitorFlyout.Icon("globe_with_meridians", 22));
        netRow.Children.Add(_net);
        var ioRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        ioRow.Children.Add(MonitorFlyout.Icon("gear", 22));
        ioRow.Children.Add(_io);
        _zombieRow.Children.Add(MonitorFlyout.Icon("ghost", 22));
        _zombieRow.Children.Add(_zombies);
        lines.Children.Add(netRow);
        lines.Children.Add(ioRow);
        lines.Children.Add(_zombieRow);
        p.Children.Add(lines);
        p.Children.Add(_chart.Root);

        var open = new Button { Content = "Sunucu yönetimi", HorizontalAlignment = HorizontalAlignment.Stretch, Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        open.Click += (_, _) => { flyout.Hide(); App.Current.OpenServerManagement(s); };
        p.Children.Add(open);

        Root = new Border
        {
            Child = p,
            Padding = new Thickness(14),
            CornerRadius = new CornerRadius(10),
            Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"],
            BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
            BorderThickness = new Thickness(1),
        };
    }

    public void Update(WatchedServer s)
    {
        _name.Text = s.Label;
        var color = s.Error is not null ? Microsoft.UI.Colors.Gray : !s.Live ? Charts.Warn : Charts.Level(s.Worst);
        _dot.Fill = new SolidColorBrush(color);
        if (s.Error is not null) _status.Text = s.Error;
        else if (!s.Live) _status.Text = "Bağlanıyor…";
        else _status.Text = $"Çalışıyor · yük {s.Last!.Load1:0.00}" + (s.Swap > 0 ? $" · swap %{s.Swap:0}" : "");
        if (s.Last is { } last)
        {
            _cpu.Set(s.Cpu, s.Samples > 0 ? "" : "ölçülüyor");
            _mem.Set(s.Mem, Sizes.Kb(last.MemTotalKb - last.MemAvailableKb));
            _disk.Set(s.Disk, "boş " + Sizes.Kb(last.RootAvailKb));
            _net.Text = $"Ağ  ↓ {Sizes.Rate(s.Rx)}   ↑ {Sizes.Rate(s.Tx)}";
            _io.Text = $"Disk  okuma {Sizes.Rate(s.Read)}   yazma {Sizes.Rate(s.Write)}";
            _zombies.Text = last.Zombies == 0 ? "Zombi süreç yok" : $"{last.Zombies} zombi süreç";
            _zombies.Foreground = last.Zombies >= 20 ? new SolidColorBrush(Charts.Warn) : (Brush)Application.Current.Resources["TextFillColorPrimaryBrush"];
        }
        while (_drawn < s.Samples)
        {
            _chart.Push(s.Cpu, $"yük {s.Last?.Load1:0.00}");
            _drawn++;
        }
    }

    /// <summary>A 3D icon, a big percentage and a coloured bar.</summary>
    private sealed class Tile
    {
        private readonly TextBlock _value = new() { FontSize = 22, FontWeight = FontWeights.SemiBold, Text = "–" };
        private readonly TextBlock _detail = new() { FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis };
        private readonly ProgressBar _bar = new() { Maximum = 100, Height = 6, Margin = new Thickness(0, 4, 0, 0) };

        public Border Root { get; }

        public Tile(string icon, string label)
        {
            _detail.Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];
            var p = new StackPanel { Spacing = 2 };
            var top = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
            top.Children.Add(MonitorFlyout.Icon(icon, 26));
            top.Children.Add(new TextBlock { Text = label, FontSize = 12, VerticalAlignment = VerticalAlignment.Center });
            p.Children.Add(top);
            p.Children.Add(_value);
            p.Children.Add(_detail);
            p.Children.Add(_bar);
            Root = new Border
            {
                Child = p,
                Padding = new Thickness(10),
                CornerRadius = new CornerRadius(8),
                Background = (Brush)Application.Current.Resources["SubtleFillColorSecondaryBrush"],
            };
        }

        public void Set(double percent, string detail)
        {
            _value.Text = $"%{percent:0}";
            _value.Foreground = new SolidColorBrush(Charts.Level(percent));
            _detail.Text = detail;
            _bar.Value = Math.Clamp(percent, 0, 100);
            _bar.Foreground = new SolidColorBrush(Charts.Level(percent));
        }
    }
}
