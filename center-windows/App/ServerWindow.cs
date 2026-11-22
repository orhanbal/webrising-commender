using Microsoft.UI.Dispatching;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Server management for one SSH terminal: overview, what fills the disk,
/// safe cleanup, processes and zombies. Everything runs over the terminal's
/// own connection; nothing is installed on the server. Changes always show
/// the exact command and ask first.
/// </summary>
public sealed class ServerWindow : Window
{
    private readonly ServerManagementView _view;

    public ServerWindow(ServersController controller, string sessionId, string label)
    {
        Title = L.F("Sunucu yönetimi — {0}", label);
        SystemBackdrop = new MicaBackdrop();
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1060, 780));
        try { AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico")); } catch (Exception) { }
        _view = new ServerManagementView(controller, sessionId, label);
        Content = _view;
        Closed += (_, _) => _view.Stop();
    }

    /// <summary>Shows the window for another visit (or the first).</summary>
    public void Bring()
    {
        AppWindow.Show();
        Activate();
    }

    /// <summary>Opens on one section (from the Dock: processes, disk, cleanup, timers).</summary>
    public void GoTo(string section) => _view.GoTo(section);
}

/// <summary>
/// The server management content (overview, disk, cleanup, processes, timers)
/// for one connection: one implementation for <see cref="ServerWindow"/> and
/// the Dock's drop-down panel.
/// </summary>
public sealed class ServerManagementView : UserControl
{
    private readonly ServersController _c;
    private readonly string _sessionId;
    private readonly string _label;
    private readonly NavigationView _nav = new();
    private readonly InfoBar _info = new() { IsClosable = true };
    private readonly ScrollViewer _scroll = new() { Padding = new Thickness(28, 16, 28, 28) };
    private string _section = "overview";
    private string _diskPath = "/";
    private string _processSort = "cpu";
    private string _processFilter = "";
    private string _timerFilter = "";
    private ProcessList? _processes;
    private int _generation;
    private DispatcherQueueTimer? _live;
    private bool _sampling;

    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];
    private static readonly FontFamily Mono = new("Cascadia Mono, Consolas");

    public ServerManagementView(ServersController controller, string sessionId, string label)
    {
        _c = controller;
        _sessionId = sessionId;
        _label = label;

        _nav.PaneDisplayMode = NavigationViewPaneDisplayMode.Top;
        _nav.IsBackButtonVisible = NavigationViewBackButtonVisible.Collapsed;
        _nav.IsSettingsVisible = false;
        foreach (var (tag, text, icon) in new[]
        {
            ("overview", L.T("Genel bakış"), IconName.Activity),
            ("disk", "Disk", IconName.Disk),
            ("cleanup", L.T("Temizlik"), IconName.Cleanup),
            ("processes", L.T("Süreçler"), IconName.Cpu),
            ("timers", L.T("Zamanlayıcılar"), IconName.Timer),
        })
            _nav.MenuItems.Add(new NavigationViewItem { Content = text, Tag = tag, Icon = Icons.Make(icon) });
        var refresh = new NavigationViewItem { Content = L.T("Yenile"), Tag = "refresh", SelectsOnInvoked = false, Icon = Icons.Make(IconName.Refresh) };
        _nav.FooterMenuItems.Add(refresh);
        _nav.ItemInvoked += (sender, e) =>
        {
            var tag = e.InvokedItemContainer?.Tag as string;
            if (tag is null) return;
            if (tag != "refresh") _section = tag;
            _ = Load();
        };

        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _info.Margin = new Thickness(28, 8, 28, 0);
        root.Children.Add(_info);
        Grid.SetRow(_scroll, 1);
        root.Children.Add(_scroll);
        _nav.Content = root;
        Content = _nav;
        Icons.FollowSelection(_nav);
        _nav.SelectedItem = _nav.MenuItems[0];
        _ = Load();
    }

    /// <summary>The connection this view uses (the monitor's or a terminal's).</summary>
    public string SessionId => _sessionId;

    /// <summary>Closed or hidden for good: live sampling stops and pending reads are dropped.</summary>
    public void Stop() { _live?.Stop(); _generation++; }

    private void Show(string text, InfoBarSeverity severity)
    {
        _info.Message = text;
        _info.Severity = severity;
        _info.IsOpen = true;
    }

    /// <summary>Opens on one section (from the Dock: processes, disk, cleanup, timers).</summary>
    public void GoTo(string section) => Go(section);

    private void Go(string section)
    {
        _section = section;
        foreach (var item in _nav.MenuItems.OfType<NavigationViewItem>())
            if (item.Tag as string == section) _nav.SelectedItem = item;
        _ = Load();
    }

    private async Task Load()
    {
        var generation = ++_generation;
        _live?.Stop();
        _info.IsOpen = false;
        if (_section == "disk") { await LoadDisk(generation); return; }
        _scroll.Content = Waiting(_section switch
        {
            "disk" => L.T("Disk taranıyor. Büyük disklerde bir iki dakika sürebilir…"),
            "cleanup" => L.T("Silinebilecek dosyalar hesaplanıyor…"),
            "processes" => L.T("Süreçler okunuyor…"),
            "timers" => L.T("Zamanlayıcılar okunuyor…"),
            _ => L.T("Sunucu bilgileri okunuyor…"),
        });
        try
        {
            UIElement page = _section switch
            {
                "disk" => DiskPage(await _c.Server<DiskUsage>("server.disk", new { sessionId = _sessionId, path = _diskPath })),
                "cleanup" => CleanupPage(await _c.Server<CleanupScan>("server.cleanupScan", new { sessionId = _sessionId })),
                "processes" => ProcessesPage(_processes = await _c.Server<ProcessList>("server.processes", new { sessionId = _sessionId })),
                "timers" => TimersPage(await _c.Server<ServerTimers>("server.timers", new { sessionId = _sessionId })),
                _ => OverviewPage(await _c.Server<ServerOverview>("server.overview", new { sessionId = _sessionId })),
            };
            if (generation == _generation) _scroll.Content = page;
        }
        catch (Exception ex)
        {
            if (generation != _generation) return;
            _scroll.Content = null;
            Show(Friendly(ex), InfoBarSeverity.Error);
        }
    }

    /// <summary>The disk scan, with a bar and percentage while it runs.</summary>
    private async Task LoadDisk(int generation)
    {
        var bar = new ProgressBar { Maximum = 100, Value = 0, IsIndeterminate = true, Width = 420, HorizontalAlignment = HorizontalAlignment.Left };
        var percent = new TextBlock { Text = "%0", FontSize = 28, FontWeight = FontWeights.SemiBold };
        var waiting = new StackPanel { Spacing = 10, Margin = new Thickness(0, 24, 0, 0) };
        waiting.Children.Add(new TextBlock { Text = L.F("{0} taranıyor", _diskPath), Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"] });
        waiting.Children.Add(percent);
        waiting.Children.Add(bar);
        waiting.Children.Add(Note(L.T("Klasörler tek tek ölçülüyor; büyük disklerde bir iki dakika sürebilir.")));
        _scroll.Content = waiting;
        var id = Guid.NewGuid().ToString("N");
        _c.Progress[id] = (done, total) => DispatcherQueue.TryEnqueue(() =>
        {
            if (total == 0) return;
            var v = Math.Min(100, done * 100.0 / total);
            bar.IsIndeterminate = false;
            bar.Value = v;
            percent.Text = $"%{v:0}";
        });
        try
        {
            var usage = await _c.Server<DiskUsage>("server.disk", new { sessionId = _sessionId, path = _diskPath, transferId = id });
            if (generation == _generation) _scroll.Content = DiskPage(usage);
        }
        catch (Exception ex)
        {
            if (generation != _generation) return;
            _scroll.Content = null;
            Show(Friendly(ex), InfoBarSeverity.Error);
        }
        finally
        {
            _c.Progress.TryRemove(id, out _);
        }
    }

    private static string Friendly(Exception ex) =>
        ex.Message == L.T("Terminal kapalı.") ? L.T("Bu sunucunun terminali kapandı. Sunucu yönetimi için yeniden bağlan.") : ex.Message;

    // ---- building blocks ----

    /// <summary>Waiting for the server: a moving bar and the seconds so far, in a card (not a lone spinner).</summary>
    private UIElement Waiting(string text)
    {
        var card = new StackPanel { Spacing = 12, MaxWidth = 560, HorizontalAlignment = HorizontalAlignment.Left, Margin = new Thickness(0, 24, 0, 0) };
        card.Children.Add(new TextBlock { Text = text, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
        card.Children.Add(new ProgressBar { IsIndeterminate = true, MinWidth = 420 });
        var elapsed = new TextBlock { Foreground = Secondary, FontSize = 12, Text = L.T("0 sn") };
        card.Children.Add(elapsed);
        var started = DateTime.UtcNow;
        var timer = DispatcherQueue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(1);
        timer.Tick += (_, _) =>
        {
            if (card.XamlRoot is null && (DateTime.UtcNow - started).TotalSeconds > 2) { timer.Stop(); return; }
            elapsed.Text = $"{(int)(DateTime.UtcNow - started).TotalSeconds} sn";
        };
        timer.Start();
        return Card(card);
    }

    /// <summary>Moves a bar to a new value smoothly (not in a jump).</summary>
    private static void AnimateTo(ProgressBar bar, double value, int ms = 600)
    {
        var animation = new Microsoft.UI.Xaml.Media.Animation.DoubleAnimation
        {
            To = value,
            Duration = TimeSpan.FromMilliseconds(ms),
            EnableDependentAnimation = true,
            EasingFunction = new Microsoft.UI.Xaml.Media.Animation.CubicEase { EasingMode = Microsoft.UI.Xaml.Media.Animation.EasingMode.EaseOut },
        };
        Microsoft.UI.Xaml.Media.Animation.Storyboard.SetTarget(animation, bar);
        Microsoft.UI.Xaml.Media.Animation.Storyboard.SetTargetProperty(animation, "Value");
        var story = new Microsoft.UI.Xaml.Media.Animation.Storyboard();
        story.Children.Add(animation);
        story.Begin();
    }

    private static TextBlock Heading(string text) => new()
    {
        Text = text,
        Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"],
        Margin = new Thickness(0, 12, 0, 0),
    };

    private static TextBlock Note(string text) => new() { Text = text, Foreground = Secondary, TextWrapping = TextWrapping.Wrap };

    private static Border Card(UIElement content) => new()
    {
        Child = content,
        Padding = new Thickness(16),
        CornerRadius = new CornerRadius(8),
        Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"],
        BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
        BorderThickness = new Thickness(1),
    };

    private static InfoBar Banner(string title, string message, InfoBarSeverity severity, UIElement? action = null) => new()
    {
        Title = title,
        Message = message,
        Severity = severity,
        IsOpen = true,
        IsClosable = false,
        ActionButton = action as ButtonBase,
    };

    /// <summary>A labelled bar: "Bellek  5,9 GB / 15 GB (%39)".</summary>
    private static UIElement Meter(string label, ulong usedKb, ulong totalKb, string? extra = null)
    {
        var percent = totalKb == 0 ? 0 : usedKb * 100.0 / totalKb;
        var p = new StackPanel { Spacing = 4 };
        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(new TextBlock { Text = label, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis });
        var value = new TextBlock { Text = $"{Sizes.Kb(usedKb)} / {Sizes.Kb(totalKb)}  (%{percent:0})" + (extra is null ? "" : "  ·  " + extra), Foreground = Secondary };
        Grid.SetColumn(value, 1);
        row.Children.Add(value);
        p.Children.Add(row);
        p.Children.Add(Bar(percent));
        return p;
    }

    private static ProgressBar Bar(double percent) => new()
    {
        Value = Math.Clamp(percent, 0, 100),
        Maximum = 100,
        Height = 6,
        ShowError = percent >= 90,
        ShowPaused = percent >= 80 && percent < 90,
    };

    private static Button Action(string text, Func<Task> run, bool accent = false)
    {
        var b = new Button { Content = text };
        if (accent) b.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        b.Click += async (_, _) =>
        {
            b.IsEnabled = false;
            try { await run(); } finally { b.IsEnabled = true; }
        };
        return b;
    }

    private async Task<bool> Confirm(string title, string text, string command, string primary, string? warning = null)
    {
        var body = new StackPanel { Spacing = 10, MaxWidth = 560 };
        body.Children.Add(new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap });
        if (!string.IsNullOrEmpty(warning))
            body.Children.Add(new InfoBar { Title = L.T("Dikkat"), Message = warning, Severity = InfoBarSeverity.Warning, IsOpen = true, IsClosable = false });
        body.Children.Add(new TextBlock { Text = L.T("Sunucuda çalışacak komut:"), Foreground = Secondary });
        body.Children.Add(new TextBlock { Text = command, FontFamily = Mono, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
        var dialog = new ContentDialog
        {
            Title = title,
            Content = new ScrollViewer { Content = body, MaxHeight = 460 },
            PrimaryButtonText = primary,
            CloseButtonText = L.T("Vazgeç"),
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = Content.XamlRoot,
        };
        try { return await dialog.ShowAsync() == ContentDialogResult.Primary; }
        catch (Exception) { return false; }
    }

    // ---- overview ----

    private UIElement OverviewPage(ServerOverview o)
    {
        var page = new StackPanel { Spacing = 14 };
        var title = new TextBlock { Text = string.IsNullOrEmpty(o.Hostname) ? _label : o.Hostname, Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] };
        page.Children.Add(title);
        page.Children.Add(Note(L.F("{0}  ·  {1}  ·  açık kalma süresi {2}", o.Os, o.Kernel, Sizes.Duration(o.UptimeSecs))));

        // What needs attention first.
        foreach (var d in o.Disks.Where(d => d.UsedPercent >= 85))
            page.Children.Add(Banner($"{d.Mount} %{d.UsedPercent:0} dolu",
                L.F("Boş yer: {0}. Disk dolarsa veritabanları ve Docker durur.", Sizes.Kb(d.AvailKb)),
                d.UsedPercent >= 90 ? InfoBarSeverity.Error : InfoBarSeverity.Warning,
                ButtonFor(L.T("Neyin yer kapladığını gör"), () => { _diskPath = d.Mount; Go("disk"); })));
        if (o.Zombies > 0)
            page.Children.Add(Banner(L.F("{0} zombi süreç", o.Zombies),
                L.T("Bitmiş ama üst süreçleri tarafından toplanmamış süreçler. Hangi programdan geldiklerini Süreçler'de gör."),
                o.Zombies >= 20 ? InfoBarSeverity.Warning : InfoBarSeverity.Informational,
                ButtonFor(L.T("Zombileri gör"), () => Go("processes"))));
        if (o.RebootRequired)
            page.Children.Add(Banner(L.T("Yeniden başlatma bekleniyor"), L.T("Kurulan güncellemelerin bir kısmı sunucu yeniden başlatılınca devreye girer."), InfoBarSeverity.Informational));
        if (!string.IsNullOrEmpty(o.Updates))
            page.Children.Add(Banner(L.T("Güncellemeler var"), o.Updates.Replace("updates can be applied immediately.", L.T("güncelleme hemen kurulabilir.")), InfoBarSeverity.Informational));
        if (!o.CanChange)
            page.Children.Add(Banner(L.T("Yalnız görüntüleme"), L.T("Bu kullanıcı root değil ve parolasız sudo yok: bilgiler görünür ama temizlik ve süreç işlemleri yapılamaz."), InfoBarSeverity.Informational));

        // Gauges: how full each resource is right now.
        var gauges = new Grid { ColumnSpacing = 12 };
        var rings = new List<FrameworkElement>
        {
            Charts.Ring(o.CpuPercent, L.T("İşlemci"), L.F("{0} çekirdek · yük {1:0.00}", o.Cpus, o.Load[0])),
            Charts.Ring(o.MemTotalKb == 0 ? 0 : (o.MemTotalKb - o.MemAvailableKb) * 100.0 / o.MemTotalKb, L.T("Bellek"), $"{Sizes.Kb(o.MemTotalKb - o.MemAvailableKb)} / {Sizes.Kb(o.MemTotalKb)}"),
        };
        if (o.SwapTotalKb > 0)
            rings.Add(Charts.Ring((o.SwapTotalKb - o.SwapFreeKb) * 100.0 / o.SwapTotalKb, "Takas (swap)", $"{Sizes.Kb(o.SwapTotalKb - o.SwapFreeKb)} / {Sizes.Kb(o.SwapTotalKb)}"));
        if ((o.Disks.FirstOrDefault(d => d.Mount == "/") ?? o.Disks.FirstOrDefault()) is { } root)
            rings.Add(Charts.Ring(root.UsedPercent, $"Disk {root.Mount}", $"{Sizes.Kb(root.UsedKb)} / {Sizes.Kb(root.UsedKb + root.AvailKb)}"));
        for (var i = 0; i < rings.Count; i++)
        {
            gauges.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn(rings[i], i);
            gauges.Children.Add(rings[i]);
        }
        page.Children.Add(Card(gauges));

        // Live: one column a sample, every two seconds.
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 12, 0, 0) };
        head.Children.Add(new TextBlock { Text = L.T("Canlı"), Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"] });
        head.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse { Width = 8, Height = 8, Fill = new SolidColorBrush(Charts.Bad), VerticalAlignment = VerticalAlignment.Center });
        head.Children.Add(new TextBlock { Text = L.F("2 saniyede bir · {0} süreç", o.Processes), Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
        page.Children.Add(head);
        var cpuChart = new ColumnChart(L.T("İşlemci"), Charts.Palette[0], v => $"%{v:0}", fixedMax: 100);
        var memChart = new ColumnChart(L.T("Bellek"), Charts.Palette[3], v => $"%{v:0}", fixedMax: 100);
        var netChart = new ColumnChart(L.T("Ağ trafiği"), Charts.Palette[1], v => Sizes.Rate(v));
        var ioChart = new ColumnChart(L.T("Disk okuma + yazma"), Charts.Palette[2], v => Sizes.Rate(v));
        var live = new Grid { ColumnSpacing = 14, RowSpacing = 14 };
        live.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        live.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        live.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        live.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var cells = new[] { cpuChart.Root, memChart.Root, netChart.Root, ioChart.Root };
        for (var i = 0; i < cells.Length; i++)
        {
            var card = Card(cells[i]);
            Grid.SetRow(card, i / 2);
            Grid.SetColumn(card, i % 2);
            live.Children.Add(card);
        }
        page.Children.Add(live);
        StartLive(cpuChart, memChart, netChart, ioChart);

        page.Children.Add(Heading(L.T("Diskler")));
        var disks = new StackPanel { Spacing = 16 };
        foreach (var d in o.Disks)
        {
            var b = new Button { HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Padding = new Thickness(0) };
            b.Content = Meter($"{d.Mount}   ({d.Device}, {d.FsType})", d.UsedKb, d.UsedKb + d.AvailKb, L.F("boş {0}", Sizes.Kb(d.AvailKb)));
            ToolTipService.SetToolTip(b, L.T("Bu diskte neyin yer kapladığını gör"));
            var mount = d.Mount;
            b.Click += (_, _) => { _diskPath = mount; Go("disk"); };
            disks.Children.Add(b);
        }
        page.Children.Add(Card(disks));
        return page;
    }

    private void StartLive(ColumnChart cpu, ColumnChart mem, ColumnChart net, ColumnChart io)
    {
        var generation = _generation;
        ServerSample? last = null;
        async Task Tick()
        {
            if (_sampling || generation != _generation) return;
            _sampling = true;
            try
            {
                var now = await _c.Server<ServerSample>("server.sample", new { sessionId = _sessionId });
                if (generation != _generation) return;
                var mp = now.MemTotalKb == 0 ? 0 : (now.MemTotalKb - now.MemAvailableKb) * 100.0 / now.MemTotalKb;
                mem.Push(mp, L.F("{0} kullanımda", Sizes.Kb(now.MemTotalKb - now.MemAvailableKb)));
                if (last is { } prev && now.Uptime > prev.Uptime)
                {
                    var secs = now.Uptime - prev.Uptime;
                    var total = (double)(now.CpuTotal - prev.CpuTotal);
                    var busy = total <= 0 ? 0 : (total - (now.CpuIdle - prev.CpuIdle)) * 100.0 / total;
                    cpu.Push(busy, L.F("yük {0:0.00}", now.Load1));
                    double Delta(ulong a, ulong b) => a >= b ? (a - b) / secs : 0;
                    var rx = Delta(now.NetRxBytes, prev.NetRxBytes);
                    var tx = Delta(now.NetTxBytes, prev.NetTxBytes);
                    net.Push(rx + tx, $"↓ {Sizes.Rate(rx)}  ↑ {Sizes.Rate(tx)}");
                    var rd = Delta(now.DiskReadBytes, prev.DiskReadBytes);
                    var wr = Delta(now.DiskWriteBytes, prev.DiskWriteBytes);
                    io.Push(rd + wr, $"okuma {Sizes.Rate(rd)}  yazma {Sizes.Rate(wr)}");
                }
                last = now;
            }
            catch (Exception)
            {
                // A missed sample is skipped; the next tick tries again.
            }
            finally
            {
                _sampling = false;
            }
        }
        _live?.Stop();
        _live = DispatcherQueue.CreateTimer();
        _live.Interval = TimeSpan.FromSeconds(2);
        _live.Tick += (_, _) => _ = Tick();
        _live.Start();
        _ = Tick();
    }

    private static Button ButtonFor(string text, Action run)
    {
        var b = new Button { Content = text };
        b.Click += (_, _) => run();
        return b;
    }

    // ---- disk ----

    private UIElement DiskPage(DiskUsage u)
    {
        var page = new StackPanel { Spacing = 12 };
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var up = new Button { Content = Icons.Make(IconName.ArrowUp, size: 20), IsEnabled = u.Path != "/" };
        ToolTipService.SetToolTip(up, L.T("Üst klasör"));
        up.Click += (_, _) =>
        {
            var p = u.Path.TrimEnd('/');
            var i = p.LastIndexOf('/');
            _diskPath = i <= 0 ? "/" : p[..i];
            _ = Load();
        };
        head.Children.Add(up);
        head.Children.Add(new TextBlock { Text = u.Path, FontFamily = Mono, FontSize = 16, VerticalAlignment = VerticalAlignment.Center });
        head.Children.Add(new TextBlock { Text = $"toplam {Sizes.Kb(u.TotalKb)}", Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
        page.Children.Add(head);
        if (!u.Complete)
            page.Children.Add(Banner(L.T("Bazı klasörler okunamadı"), L.T("Bu kullanıcının erişemediği klasörler sayılmadı; boyutlar gerçekte daha büyük olabilir (root ile bağlan)."), InfoBarSeverity.Informational));
        if (u.Entries.Count > 0)
        {
            var top = u.Entries.Take(7).Select(e => (EntryName(u.Path, e.Path), (double)e.Kb, Sizes.Kb(e.Kb))).ToList();
            var rest = u.TotalKb > (ulong)u.Entries.Take(7).Sum(e => (decimal)e.Kb) ? u.TotalKb - (ulong)u.Entries.Take(7).Sum(e => (decimal)e.Kb) : 0;
            if (rest > 0) top.Add((L.T("Diğer"), rest, Sizes.Kb(rest)));
            page.Children.Add(Card(Charts.Donut(top, Sizes.Kb(u.TotalKb))));
        }
        page.Children.Add(Note(L.T("En çok yer kaplayanlar. Bir klasöre tıklayınca içine girer. Bu ekran yalnız ölçer; silme Temizlik'ten yapılır.")));

        var list = new StackPanel { Spacing = 2 };
        var max = u.Entries.Count == 0 ? 1 : Math.Max(1, u.Entries.Max(e => e.Kb));
        foreach (var e in u.Entries)
        {
            var row = new Grid { ColumnSpacing = 12, Padding = new Thickness(8, 6, 8, 6) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(90) });
            var name = EntryName(u.Path, e.Path);
            var nameCell = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            nameCell.Children.Add(new TextBlock { Text = name, FontFamily = Mono, TextTrimming = TextTrimming.CharacterEllipsis });
            // A Docker daemon's storage (or the folder holding it): say whose, so its cleanup is found.
            if (CleanupLayout.StoreFor(e.Path, u.DockerStores) is { } store)
                nameCell.Children.Add(new TextBlock { Text = "Docker: " + store.Label, FontSize = 11, Foreground = (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"] });
            row.Children.Add(nameCell);
            var bar = new ProgressBar { Value = e.Kb * 100.0 / max, Maximum = 100, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(bar, 1);
            row.Children.Add(bar);
            var size = new TextBlock { Text = Sizes.Kb(e.Kb), HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(size, 2);
            row.Children.Add(size);
            var b = new Button { Content = row, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Padding = new Thickness(0), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
            var path = e.Path;
            b.Click += (_, _) => { _diskPath = path; _ = Load(); };
            list.Children.Add(b);
        }
        if (u.Entries.Count == 0) list.Children.Add(Note(L.T("Bu klasörde alt klasör yok.")));
        // Inside (or at) a Docker daemon's storage: its data is cleaned through that daemon, never by deleting folders.
        if (CleanupLayout.StoreFor(u.Path, u.DockerStores) is { } here && (here.RootDir.TrimEnd('/') == u.Path.TrimEnd('/') || u.Path.StartsWith(here.RootDir.TrimEnd('/') + "/", StringComparison.Ordinal)))
        {
            var info = new StackPanel { Spacing = 6 };
            info.Children.Add(new TextBlock { Text = here.Label, Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
            info.Children.Add(Note(L.F("Bu klasör {0} ortamının depolaması ({1}, soket {2}). İçindeki dosyalar elle silinmemeli: build önbelleği ve kullanılmayan imajlar Temizlik'ten, bu Docker'ın kendisi üzerinden güvenle temizlenir; çalışan konteynerler ve volume'ler korunur.", here.Label, here.RootDir, here.Socket)));
            var go = new Button { Content = L.T("Bu ortamın temizliğine git"), Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
            go.Click += (_, _) => Go("cleanup");
            info.Children.Add(go);
            page.Children.Add(Card(info));
        }
        page.Children.Add(Card(list));

        if (u.Docker.Count > 0)
        {
            page.Children.Add(Heading("Docker"));
            var docker = new StackPanel { Spacing = 8 };
            foreach (var d in u.Docker)
            {
                var kind = d.Kind switch { "Images" => L.T("İmajlar"), "Containers" => L.T("Konteynerler"), "Local Volumes" => "Birimler (veriler)", "Build Cache" => L.T("Build önbelleği"), _ => d.Kind };
                docker.Children.Add(new TextBlock { Text = $"{kind} ({d.Count}): {Sizes.Bytes(d.SizeBytes)}" + (d.ReclaimableBytes > 0 && d.Kind != "Local Volumes" ? L.F("  ·  {0} geri kazanılabilir", Sizes.Bytes(d.ReclaimableBytes)) : "") });
            }
            docker.Children.Add(Note(L.T("Birimlere (uygulama verileri) hiçbir zaman dokunulmaz.")));
            var clean = new Button { Content = L.T("Temizlik'e git") };
            clean.Click += (_, _) => Go("cleanup");
            docker.Children.Add(clean);
            page.Children.Add(Card(docker));
        }
        return page;
    }

    private static string EntryName(string parent, string path) =>
        path.Length > parent.Length && path.StartsWith(parent) ? path[parent.Length..].TrimStart('/') : path;

    // ---- cleanup ----

    /// <summary>A Docker daemon at the top of its cleanup card: which one it is, what it stores and frees, and the running containers a cleanup never touches.</summary>
    private static UIElement DockerHeader(DockerEnv env)
    {
        var p = new StackPanel { Spacing = 4 };
        var title = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        title.Children.Add(Icons.Make(env.Rootless ? IconName.User : IconName.Docker, size: 18));
        title.Children.Add(new TextBlock { Text = env.Label, Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"] });
        p.Children.Add(title);
        var kind = env.Rootless ? "Rootless Docker" : L.T("Sistem Docker");
        p.Children.Add(new TextBlock { Text = L.F("{0} · kullanıcı: {1} · soket: {2}", kind, env.User, string.IsNullOrEmpty(env.Socket) ? L.T("varsayılan") : env.Socket), FontFamily = Mono, FontSize = 12, Foreground = Secondary, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
        if (string.IsNullOrEmpty(env.Error))
        {
            if (!string.IsNullOrEmpty(env.RootDir))
                p.Children.Add(new TextBlock { Text = "Depolama: " + env.RootDir, FontFamily = Mono, FontSize = 12, Foreground = Secondary, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
            p.Children.Add(new TextBlock
            {
                Text = L.F("Kullanım: {0}  ·  Build önbelleği: {1}  ·  Geri kazanılabilir: {2}", Sizes.Bytes(env.TotalBytes), Sizes.Bytes(env.BuildCacheBytes), Sizes.Bytes(env.ReclaimableBytes)),
                FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap,
            });
            p.Children.Add(new TextBlock
            {
                Text = L.F("İmajlar: {0} ({1} kullanımda) · Konteynerler: {2} ({3} çalışıyor) · Volume'ler: {4}", env.ImagesTotal, env.ImagesActive, env.ContainersTotal, env.ContainersRunning, Sizes.Bytes(env.VolumesBytes)),
                Foreground = Secondary, TextWrapping = TextWrapping.Wrap,
            });
            var protectedText = env.Running.Count > 0
                ? L.T("Korunur (dokunulmaz): ") + string.Join(", ", env.Running.Take(6)) + (env.Running.Count > 6 ? L.F(" ve {0} konteyner daha", env.Running.Count - 6) : "") + L.T("; bunların ve durmuş konteynerlerin imajları, tüm volume'ler.")
                : L.T("Korunur (dokunulmaz): durmuş konteynerlerin imajları ve tüm volume'ler.");
            p.Children.Add(new TextBlock { Text = protectedText, TextWrapping = TextWrapping.Wrap, Foreground = (Brush)Application.Current.Resources["SystemFillColorSuccessBrush"] });
        }
        return p;
    }

    private UIElement CleanupPage(CleanupScan scan)
    {
        var page = new StackPanel { Spacing = 12 };
        page.Children.Add(new TextBlock { Text = L.T("Güvenle silinebilecekler"), Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] });
        page.Children.Add(Note(L.T("Yalnız bilinen, yeniden oluşturulabilen dosyalar listelenir. Uygulama verilerine, veritabanlarına ve Docker birimlerine dokunulmaz. Silmeden önce çalışacak komutlar gösterilir.")));
        var canChange = scan.Privilege is "root" or "sudo";
        if (!canChange)
            page.Children.Add(Banner(L.T("Temizlik için yetki yok"), L.T("Bu kullanıcı root değil ve parolasız sudo yok. Boyutlar eksik ölçülmüş olabilir; temizlik için root ile bağlan."), InfoBarSeverity.Warning));

        var boxes = new List<(CheckBox Box, CleanupItem Item, Windows.UI.Color Color)>();
        var total = new TextBlock { FontWeight = FontWeights.SemiBold };
        // The disk now and after the chosen cleanup: grey = stays, colours = freed.
        var visual = new Border();
        if (scan.Disk is { } disk) page.Children.Add(Card(visual));
        void Sum()
        {
            var chosenKb = (ulong)boxes.Where(b => b.Box.IsChecked == true).Sum(b => (decimal)b.Item.Kb);
            total.Text = L.F("Seçilenler: {0}", Sizes.Kb(chosenKb));
            if (scan.Disk is not { } d) return;
            var size = (double)(d.UsedKb + d.AvailKb);
            if (size <= 0) return;
            var freed = Math.Min(chosenKb, d.UsedKb);
            var before = d.UsedKb * 100.0 / size;
            var after = (d.UsedKb - freed) * 100.0 / size;
            var parts = new List<(double, Windows.UI.Color, string)> { (d.UsedKb - freed, Windows.UI.Color.FromArgb(255, 0x64, 0x74, 0x8B), $"Kalacak: {Sizes.Kb(d.UsedKb - freed)}") };
            parts.AddRange(boxes.Where(b => b.Box.IsChecked == true && b.Item.Kb > 0).Select(b => ((double)Math.Min(b.Item.Kb, d.UsedKb), b.Color, $"{b.Item.Title}: {Sizes.Kb(b.Item.Kb)}")));
            var v = new StackPanel { Spacing = 10 };
            var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
            line.Children.Add(new TextBlock { Text = $"Disk {d.Mount}", FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
            line.Children.Add(new TextBlock { Text = $"%{before:0}", FontSize = 22, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Charts.Level(before)) });
            line.Children.Add(new TextBlock { Text = "→", FontSize = 22, Foreground = Secondary });
            line.Children.Add(new TextBlock { Text = $"%{after:0}", FontSize = 22, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Charts.Level(after)) });
            line.Children.Add(new TextBlock { Text = L.F("temizlikten sonra boş: {0}", Sizes.Kb(d.AvailKb + freed)), Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
            v.Children.Add(line);
            v.Children.Add(Charts.Stack(parts, size));
            visual.Child = v;
        }
        var colorIndex = 0;
        // The server's own items, then every Docker daemon on its own card:
        // the system one and each user's rootless one, with what they store,
        // protect and free, or why they could not be read.
        foreach (var section in CleanupLayout.Sections(scan))
        {
            var list = new StackPanel { Spacing = 14 };
            if (section.Docker is { } env)
            {
                list.Children.Add(DockerHeader(env));
                if (!string.IsNullOrEmpty(env.Error))
                    list.Children.Add(Banner(L.T("Bu Docker okunamadı"), env.Error + L.T(" Boyutları bilinmiyor; bu ortam için temizlik önerilmiyor."), InfoBarSeverity.Warning));
            }
            else if (section.Items.Count == 0) continue;
            foreach (var item in section.Items)
            {
                var color = Charts.Palette[colorIndex++ % (Charts.Palette.Length - 1)];
                var row = new Grid { ColumnSpacing = 12 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                // Docker cleanups go through the daemon itself: no root needed when this login can reach it.
                var allowed = canChange || !string.IsNullOrEmpty(item.Docker);
                var box = new CheckBox
                {
                    MinWidth = 0,
                    IsEnabled = allowed && item.Kb > 0,
                    IsChecked = allowed && item.Kb > 0 && string.IsNullOrEmpty(item.Warning),
                    VerticalAlignment = VerticalAlignment.Top,
                };
                var group = item.Group;
                box.Checked += (_, _) =>
                {
                    // Untagged images are part of the unused ones: one of the two, never both.
                    if (!string.IsNullOrEmpty(group))
                        foreach (var other in boxes.Where(b => b.Item.Group == group && !ReferenceEquals(b.Box, box)))
                            other.Box.IsChecked = false;
                    Sum();
                };
                box.Unchecked += (_, _) => Sum();
                row.Children.Add(box);
                var text = new StackPanel { Spacing = 2 };
                var titleRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                titleRow.Children.Add(new Microsoft.UI.Xaml.Shapes.Rectangle { Width = 12, Height = 12, RadiusX = 3, RadiusY = 3, Fill = new SolidColorBrush(color), VerticalAlignment = VerticalAlignment.Center });
                titleRow.Children.Add(new TextBlock { Text = item.Title, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
                text.Children.Add(titleRow);
                text.Children.Add(Note(item.Detail));
                if (!string.IsNullOrEmpty(item.Warning))
                    text.Children.Add(new TextBlock { Text = "Dikkat: " + item.Warning, TextWrapping = TextWrapping.Wrap, Foreground = (Brush)Application.Current.Resources["SystemFillColorCautionBrush"] });
                text.Children.Add(new TextBlock { Text = item.Command, FontFamily = Mono, FontSize = 12, Foreground = Secondary, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
                Grid.SetColumn(text, 1);
                row.Children.Add(text);
                var size = new TextBlock { Text = item.Kb > 0 ? Sizes.Kb(item.Kb) : L.T("boş"), FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Top };
                Grid.SetColumn(size, 2);
                row.Children.Add(size);
                list.Children.Add(row);
                boxes.Add((box, item, color));
            }
            page.Children.Add(Card(list));
        }
        Sum();

        var bottom = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 16 };
        bottom.Children.Add(total);
        bottom.Children.Add(Action(L.T("Seçilenleri temizle"), async () =>
        {
            var chosen = boxes.Where(b => b.Box.IsChecked == true).Select(b => b.Item).ToList();
            if (chosen.Count == 0) { Show(L.T("Temizlenecek bir şey seçilmedi."), InfoBarSeverity.Informational); return; }
            var warning = string.Join(" ", chosen.Where(c => !string.IsNullOrEmpty(c.Warning)).Select(c => c.Warning));
            if (!await Confirm(L.T("Temizlik"), L.F("{0} kalem silinecek; yaklaşık {1} yer açılacak. Geri alınamaz.", chosen.Count, Sizes.Kb((ulong)chosen.Sum(c => (decimal)c.Kb))),
                    string.Join("\n", chosen.Select(c => c.Command)), L.T("Temizle"), warning)) return;
            await RunCleanup(chosen);
        }, accent: true));
        page.Children.Add(bottom);
        return page;
    }

    /// <summary>
    /// Cleans the chosen items one by one and shows it happening: an overall
    /// bar that fills by the space freed, the disk going down, and each item
    /// waiting, working, done or failed.
    /// </summary>
    private async Task RunCleanup(List<CleanupItem> chosen)
    {
        var generation = ++_generation;
        _live?.Stop();
        var before = await RootFree();
        var size = (await RootSize()) ?? 0;
        var totalKb = Math.Max(1m, chosen.Sum(c => (decimal)c.Kb));

        var page = new StackPanel { Spacing = 16 };
        page.Children.Add(new TextBlock { Text = L.T("Temizleniyor"), Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] });
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var step = new TextBlock { FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis };
        var percent = new TextBlock { FontSize = 28, FontWeight = FontWeights.SemiBold, Foreground = (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"] };
        head.Children.Add(step);
        Grid.SetColumn(percent, 1);
        head.Children.Add(percent);
        var overall = new ProgressBar { Maximum = 100, Height = 10, CornerRadius = new CornerRadius(5) };
        var freedText = new TextBlock { Foreground = Secondary };
        var top = new StackPanel { Spacing = 8 };
        top.Children.Add(head);
        top.Children.Add(overall);
        top.Children.Add(freedText);
        // The disk of / before and now, going down as items are cleaned.
        TextBlock? diskNow = null;
        ProgressBar? diskBar = null;
        if (before is { } free0 && size > 0)
        {
            var used0 = (size - free0) * 100.0 / size;
            var diskRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Margin = new Thickness(0, 8, 0, 0) };
            diskRow.Children.Add(new TextBlock { Text = "Disk /", FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
            diskRow.Children.Add(new TextBlock { Text = $"%{used0:0}", FontSize = 20, Foreground = new SolidColorBrush(Charts.Level(used0)), VerticalAlignment = VerticalAlignment.Center });
            diskRow.Children.Add(new TextBlock { Text = "→", FontSize = 20, Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
            diskNow = new TextBlock { Text = $"%{used0:0}", FontSize = 20, FontWeight = FontWeights.SemiBold, Foreground = new SolidColorBrush(Charts.Level(used0)), VerticalAlignment = VerticalAlignment.Center };
            diskRow.Children.Add(diskNow);
            top.Children.Add(diskRow);
            diskBar = new ProgressBar { Maximum = 100, Value = used0, Height = 6 };
            top.Children.Add(diskBar);
        }
        page.Children.Add(Card(top));

        var rows = new StackPanel { Spacing = 10 };
        var states = new List<(CleanupItem Item, ContentControl State, TextBlock Note, ProgressBar Bar)>();
        foreach (var item in chosen)
        {
            var row = new Grid { ColumnSpacing = 12 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(28) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var state = new ContentControl { Content = Icons.Make(IconName.Clock, foreground: Secondary), VerticalAlignment = VerticalAlignment.Center };
            row.Children.Add(state);
            var text = new StackPanel { Spacing = 4 };
            text.Children.Add(new TextBlock { Text = item.Title, FontWeight = FontWeights.SemiBold });
            var note = new TextBlock { Text = L.T("Sırada"), Foreground = Secondary, FontSize = 12 };
            text.Children.Add(note);
            var bar = new ProgressBar { IsIndeterminate = true, Visibility = Visibility.Collapsed };
            text.Children.Add(bar);
            Grid.SetColumn(text, 1);
            row.Children.Add(text);
            var amount = new TextBlock { Text = Sizes.Kb(item.Kb), FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(amount, 2);
            row.Children.Add(amount);
            rows.Children.Add(row);
            states.Add((item, state, note, bar));
        }
        page.Children.Add(Card(rows));
        _scroll.Content = page;

        decimal doneKb = 0;
        var results = new List<CleanupResult>();
        void Overall(string text)
        {
            var value = (double)(doneKb * 100 / totalKb);
            step.Text = text;
            percent.Text = $"%{value:0}";
            AnimateTo(overall, value);
            freedText.Text = $"{Sizes.Kb((ulong)doneKb)} / {Sizes.Kb((ulong)totalKb)} temizlendi";
        }
        Overall(L.T("Başlıyor…"));
        try
        {
            for (var i = 0; i < states.Count; i++)
            {
                var (item, state, note, bar) = states[i];
                state.Content = new ProgressRing { IsActive = true, Width = 18, Height = 18 };
                note.Text = L.T("Temizleniyor…");
                bar.Visibility = Visibility.Visible;
                Overall($"{i + 1}/{states.Count} · {item.Title}");
                CleanupResult result;
                try
                {
                    var one = await _c.Server<List<CleanupResult>>("server.cleanupRun", new { sessionId = _sessionId, ids = new List<string> { item.Id } });
                    result = one.FirstOrDefault() ?? new CleanupResult(item.Id, false, L.T("yanıt yok"));
                }
                catch (Exception ex) { result = new CleanupResult(item.Id, false, Friendly(ex)); }
                results.Add(result);
                bar.Visibility = Visibility.Collapsed;
                state.Content = Icons.Make(result.Ok ? IconName.Check : IconName.Error,
                    foreground: (Brush)Application.Current.Resources[result.Ok ? "SystemFillColorSuccessBrush" : "SystemFillColorCriticalBrush"]);
                note.Text = result.Ok ? L.T("Temizlendi") : L.T("Temizlenemedi") + (string.IsNullOrEmpty(result.Message) ? "" : ": " + result.Message);
                doneKb += item.Kb;
                Overall(i + 1 < states.Count ? L.F("{0}/{1} tamam", i + 1, states.Count) : L.T("Bitti"));
                // The disk going down as it happens.
                if (diskNow is not null && diskBar is not null && size > 0 && await RootFree() is { } freeNow)
                {
                    var usedNow = (size - freeNow) * 100.0 / size;
                    diskNow.Text = $"%{usedNow:0}";
                    diskNow.Foreground = new SolidColorBrush(Charts.Level(usedNow));
                    AnimateTo(diskBar, usedNow);
                }
            }
            if (generation != _generation) return;
            var after = await RootFree();
            var failed = results.Where(r => !r.Ok).ToList();
            // Measured again after the cleanup, against the estimate.
            var measured = CleanupLayout.Freed((ulong)chosen.Sum(c => (decimal)c.Kb), before, after);
            var freed = measured.Length > 0 ? " " + measured : "";
            if (failed.Count == 0) Show(L.T("Temizlik tamamlandı.") + freed, InfoBarSeverity.Success);
            else Show(L.F("Bazı kalemler temizlenemedi: {0}.", string.Join("; ", failed.Select(f => chosen.First(c => c.Id == f.Id).Title + (string.IsNullOrEmpty(f.Message) ? "" : $" ({f.Message})")))) + freed, InfoBarSeverity.Warning);
            // The finished list stays a moment, then the new scan.
            await Task.Delay(1500);
            if (generation != _generation) return;
            var message = _info.Message; var severity = _info.Severity;
            await Load();
            Show(message, severity);
        }
        catch (Exception ex)
        {
            await Load();
            Show(Friendly(ex), InfoBarSeverity.Error);
        }
    }

    /// <summary>Size of / (KB), for the disk bar while cleaning.</summary>
    private async Task<double?> RootSize()
    {
        try
        {
            var o = await _c.Server<ServerOverview>("server.overview", new { sessionId = _sessionId });
            return o.Disks.FirstOrDefault(d => d.Mount == "/") is { } d ? (double)(d.UsedKb + d.AvailKb) : null;
        }
        catch (Exception) { return null; }
    }

    /// <summary>Free space on / (KB), for "N GB freed".</summary>
    private async Task<ulong?> RootFree()
    {
        try
        {
            var o = await _c.Server<ServerOverview>("server.overview", new { sessionId = _sessionId });
            return o.Disks.FirstOrDefault(d => d.Mount == "/")?.AvailKb;
        }
        catch (Exception) { return null; }
    }

    // ---- processes ----

    private UIElement ProcessesPage(ProcessList list)
    {
        var page = new StackPanel { Spacing = 12 };
        var canChange = list.Privilege is "root" or "sudo";

        if (list.Zombies.Count > 0)
        {
            page.Children.Add(new TextBlock { Text = L.F("Zombi süreçler ({0})", list.Zombies.Sum(z => z.Count)), Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] });
            page.Children.Add(Note(L.T("Zombi süreç zaten bitmiştir; bellek ya da işlemci kullanmaz, doğrudan sonlandırılamaz. Onu yalnız kendisini başlatan üst süreç toplayabilir. Önce üst sürece zararsız bir hatırlatma gönder; işe yaramazsa üst sürecin servisini ya da konteynerini yeniden başlat.")));
            foreach (var z in list.Zombies) page.Children.Add(ZombieCard(z, canChange));
        }
        else
        {
            page.Children.Add(Banner(L.T("Zombi süreç yok"), L.T("Bütün bitmiş süreçler toplanmış."), InfoBarSeverity.Success));
        }

        // Who uses the machine: the ten heaviest by CPU and by memory.
        var live = list.Processes.Where(p => !p.State.StartsWith('Z')).ToList();
        var charts = new Grid { ColumnSpacing = 14, Margin = new Thickness(0, 12, 0, 0) };
        charts.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        charts.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        FrameworkElement Top(string title, IEnumerable<ServerProcess> procs, Func<ServerProcess, double> value, Func<ServerProcess, string> text, Windows.UI.Color color)
        {
            var box = new StackPanel { Spacing = 10 };
            box.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.SemiBold });
            box.Children.Add(Charts.Bars(procs.Take(10).Select(p => ($"{p.Name} ({p.Pid})", value(p), text(p))).ToList(), color));
            return Card(box);
        }
        var cpuTop = Top(L.T("En çok işlemci kullanan 10 süreç"), live.OrderByDescending(p => p.Cpu), p => p.Cpu, p => $"%{p.Cpu:0.0}", Charts.Palette[0]);
        var memTop = Top(L.T("En çok bellek kullanan 10 süreç"), live.OrderByDescending(p => p.RssKb), p => p.RssKb, p => Sizes.Kb(p.RssKb), Charts.Palette[3]);
        Grid.SetColumn(memTop, 1);
        charts.Children.Add(cpuTop);
        charts.Children.Add(memTop);
        page.Children.Add(charts);

        page.Children.Add(Heading(L.T("Süreçler")));
        var tools = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var search = new TextBox { PlaceholderText = L.T("Ara (ad, komut, kullanıcı, PID)"), Width = 320, Text = _processFilter };
        var sort = new ComboBox { Width = 180 };
        sort.Items.Add(new ComboBoxItem { Content = L.T("İşlemciye göre"), Tag = "cpu" });
        sort.Items.Add(new ComboBoxItem { Content = L.T("Belleğe göre"), Tag = "mem" });
        sort.SelectedIndex = _processSort == "mem" ? 1 : 0;
        tools.Children.Add(search);
        tools.Children.Add(sort);
        page.Children.Add(tools);
        var rows = new StackPanel { Spacing = 0 };
        page.Children.Add(Card(rows));
        void Fill()
        {
            rows.Children.Clear();
            var f = _processFilter.Trim();
            var shown = list.Processes
                .Where(p => !p.State.StartsWith('Z'))
                .Where(p => f.Length == 0 || p.Name.Contains(f, StringComparison.OrdinalIgnoreCase) || p.Command.Contains(f, StringComparison.OrdinalIgnoreCase)
                    || p.User.Contains(f, StringComparison.OrdinalIgnoreCase) || p.Pid.ToString() == f)
                .OrderByDescending(p => _processSort == "mem" ? p.RssKb : p.Cpu)
                .Take(100)
                .ToList();
            rows.Children.Add(ProcessRow(null, canChange));
            foreach (var p in shown) rows.Children.Add(ProcessRow(p, canChange));
            if (shown.Count == 0) rows.Children.Add(Note(L.T("Eşleşen süreç yok.")));
        }
        search.TextChanged += (_, _) => { _processFilter = search.Text; Fill(); };
        sort.SelectionChanged += (_, _) => { _processSort = (sort.SelectedItem as ComboBoxItem)?.Tag as string ?? "cpu"; Fill(); };
        Fill();
        return page;
    }

    private UIElement ZombieCard(ZombieGroup z, bool canChange)
    {
        var p = new StackPanel { Spacing = 8 };
        p.Children.Add(new TextBlock { Text = $"{z.Count} zombi  ←  {z.Parent.Name} (PID {z.Parent.Pid})", FontWeight = FontWeights.SemiBold, FontSize = 16 });
        p.Children.Add(new TextBlock { Text = z.Parent.Command, FontFamily = Mono, FontSize = 12, Foreground = Secondary, TextTrimming = TextTrimming.CharacterEllipsis });
        var owner = z.Owner.Kind switch
        {
            "container" => L.F("Docker konteyneri: {0}", z.Owner.Name),
            "service" => $"Servis: {z.Owner.Name}",
            _ => "",
        };
        if (owner.Length > 0) p.Children.Add(Note(owner + L.F("  ·  çalışma süresi {0}", Sizes.Duration(z.Parent.ElapsedSecs))));
        if (z.Owner.Kind == "container")
            p.Children.Add(Note(L.T("Kalıcı çözüm: konteyner küçük bir init süreciyle (--init) çalışsın; o, bitmiş süreçleri kendiliğinden toplar. \"Öneriyi uygula\" bunu Coolify'daki ayarına ekleyip uygulamayı yeniden dağıtır.")));

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        if (canChange && z.Owner.Kind == "container")
            buttons.Children.Add(Action(L.T("Öneriyi uygula"), () => ApplyInit(z, null), accent: true));
        if (canChange)
        {
            buttons.Children.Add(Action(L.T("Toplamasını iste"), async () =>
            {
                if (!await Confirm(L.T("Zombileri toplamasını iste"), L.F("{0} sürecine SIGCHLD gönderilir: \"bitmiş alt süreçlerin var, topla\" demektir. Süreci durdurmaz, zararsızdır.", z.Parent.Name),
                        $"kill -CHLD {z.Parent.Pid}", L.T("Gönder"))) return;
                await Signal(z.Parent, "reap", false, then: async () =>
                {
                    await Task.Delay(1500);
                    var before = z.Count;
                    _processes = await _c.Server<ProcessList>("server.processes", new { sessionId = _sessionId });
                    var now = _processes.Zombies.FirstOrDefault(x => x.Parent.Pid == z.Parent.Pid)?.Count ?? 0;
                    _scroll.Content = ProcessesPage(_processes);
                    Show(now == 0 ? L.T("Zombilerin hepsi toplandı.") : now < before ? L.F("{0} zombi toplandı; {1} kaldı.", before - now, now) :
                        L.T("Süreç hatırlatmaya yanıt vermedi (program zombileri toplamıyor). Kalıcı çözüm için servisini ya da konteynerini yeniden başlat."),
                        now == 0 ? InfoBarSeverity.Success : InfoBarSeverity.Warning);
                });
            }));
            if (z.Owner.Kind is "container" or "service" && z.Protected.Length == 0)
            {
                var container = z.Owner.Kind == "container";
                var command = z.Owner.Kind == "container" ? $"docker restart {z.Owner.Id}" : $"systemctl restart {z.Owner.Id}";
                buttons.Children.Add(Action(container ? L.T("Konteyneri yeniden başlat") : L.T("Servisi yeniden başlat"), async () =>
                {
                    if (!await Confirm(L.F("{0} yeniden başlatılsın mı?", z.Owner.Name),
                            container ? L.T("Bu konteyner birkaç saniye kapanıp açılır; o sürede hizmet vermez. Yeniden başlayınca zombiler de gider.") : L.T("Bu servis birkaç saniye kapanıp açılır; o sürede hizmet vermez. Yeniden başlayınca zombiler de gider."),
                            command, L.T("Yeniden başlat"))) return;
                    try
                    {
                        _scroll.Content = Waiting(L.T("Yeniden başlatılıyor…"));
                        await _c.Server<string>("server.restartOwner", new { sessionId = _sessionId, kind = z.Owner.Kind, id = z.Owner.Id });
                        await Load();
                        Show(L.F("{0} yeniden başlatıldı.", z.Owner.Name), InfoBarSeverity.Success);
                    }
                    catch (Exception ex) { await Load(); Show(Friendly(ex), InfoBarSeverity.Error); }
                }));
            }
        }
        if (z.Protected.Length > 0) p.Children.Add(Note(z.Protected));
        if (buttons.Children.Count > 0) p.Children.Add(buttons);
        return Card(p);
    }

    /// <summary>"Öneriyi uygula": --init in the app's Coolify settings, then a redeploy.</summary>
    private async Task ApplyInit(ZombieGroup z, string? token)
    {
        if (token is null && !await Confirm(L.T("Öneriyi uygula"),
                L.F("{0} konteynerinin uygulamasına Coolify'da --init seçeneği eklenir ve uygulama Coolify üzerinden yeniden dağıtılır. ", z.Owner.Name) +
                L.T("Dağıtım birkaç dakika sürer; eski konteyner yenisi hazır olunca kapanır. Ayar kalıcıdır; sonraki dağıtımlarda da geçerli olur."),
                "Coolify API: custom_docker_run_options += \"--init\"\nCoolify API: deploy", L.T("Uygula")))
            return;
        try
        {
            var r = await _c.Server<InitFix>("server.coolifyInit", new { sessionId = _sessionId, containerId = z.Owner.Id, token });
            switch (r.Status)
            {
                case "needs-token":
                    if (await AskToken(r.Message) is { } t) await ApplyInit(z, t);
                    break;
                case "applied":
                case "already":
                    Show(L.F("{0}: --init {1}, yeniden dağıtım başladı. Birkaç dakika sonra Yenile'ye bas; zombiler gitmiş olmalı.", r.App, r.Status == "already" ? L.T("zaten açıktı") : L.T("eklendi"))
                        + (string.IsNullOrEmpty(r.Message) ? "" : " " + r.Message), InfoBarSeverity.Success);
                    break;
                default:
                    Show(r.Message, InfoBarSeverity.Informational);
                    break;
            }
        }
        catch (Exception ex) { Show(Friendly(ex), InfoBarSeverity.Error); }
    }

    /// <summary>Asks once for a Coolify API token (kept in this computer's keychain for this server).</summary>
    private async Task<string?> AskToken(string why)
    {
        var body = new StackPanel { Spacing = 10, MaxWidth = 520 };
        if (!string.IsNullOrEmpty(why)) body.Children.Add(new InfoBar { Message = why, Severity = InfoBarSeverity.Warning, IsOpen = true, IsClosable = false });
        body.Children.Add(new TextBlock { TextWrapping = TextWrapping.Wrap, Text = L.T("Bu ayarı Coolify'a yazmak için bir kez Coolify API anahtarı gerekiyor:") });
        body.Children.Add(new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = Secondary, Text = L.T("1. Coolify'da Ayarlar > Gelişmiş > API erişimi açık olsun.\n2. Keys & Tokens > API tokens > yeni anahtar oluştur; \"write\" ve \"deploy\" yetkilerini seç.\n3. Anahtarı buraya yapıştır.") });
        var box = new PasswordBox { PlaceholderText = L.T("Coolify API anahtarı") };
        body.Children.Add(box);
        body.Children.Add(new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = Secondary, FontSize = 12, Text = L.T("Anahtar bu bilgisayarın anahtar zincirinde saklanır. Coolify'a sunucunun kendi içinden bağlanılır; anahtar internete çıkmaz.") });
        var dialog = new ContentDialog
        {
            Title = L.T("Coolify API anahtarı"),
            Content = body,
            PrimaryButtonText = L.T("Devam"),
            CloseButtonText = L.T("Vazgeç"),
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = Content.XamlRoot,
        };
        try
        {
            return await dialog.ShowAsync() == ContentDialogResult.Primary && !string.IsNullOrWhiteSpace(box.Password) ? box.Password.Trim() : null;
        }
        catch (Exception) { return null; }
    }

    private UIElement ProcessRow(ServerProcess? p, bool canChange)
    {
        var row = new Grid { ColumnSpacing = 12, Padding = new Thickness(4, 4, 4, 4) };
        foreach (var w in new[] { 160.0, 80, 100, 60, 80, -1, 40 })
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = w < 0 ? new GridLength(1, GridUnitType.Star) : new GridLength(w) });
        var cells = p is null
            ? new[] { L.T("Ad"), "PID", L.T("Kullanıcı"), L.T("İşlemci"), L.T("Bellek"), L.T("Komut") }
            : new[] { p.Name, p.Pid.ToString(), p.User, $"%{p.Cpu:0.0}", Sizes.Kb(p.RssKb), p.Command };
        for (var i = 0; i < cells.Length; i++)
        {
            var t = new TextBlock { Text = cells[i], TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
            if (p is null) { t.Foreground = Secondary; t.FontWeight = FontWeights.SemiBold; }
            if (i == 5 && p is not null) { t.FontFamily = Mono; t.FontSize = 12; t.Foreground = Secondary; ToolTipService.SetToolTip(t, p.Command); }
            Grid.SetColumn(t, i);
            row.Children.Add(t);
        }
        if (p is not null && canChange)
        {
            var more = new Button { Content = Icons.Make(IconName.More, size: 20), Padding = new Thickness(6), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
            var menu = new MenuFlyout();
            var stop = new MenuFlyoutItem { Text = L.T("Sonlandır (kibarca)"), Icon = Icons.Make(IconName.Stop) };
            stop.Click += async (_, _) =>
            {
                if (await Confirm(L.F("{0} sonlandırılsın mı?", p.Name), L.T("Sürece kapanması söylenir (SIGTERM); program açık işlerini bitirip kapanır. Bir servisin parçasıysa servis onu yeniden başlatabilir."), $"kill -TERM {p.Pid}", L.T("Sonlandır")))
                    await Signal(p, "term", false);
            };
            var kill = new MenuFlyoutItem { Text = L.T("Zorla durdur"), Icon = Icons.Make(IconName.CloseCircle) };
            kill.Click += async (_, _) =>
            {
                if (await Confirm(L.F("{0} zorla durdurulsun mı?", p.Name), L.T("Süreç anında durdurulur (SIGKILL); kaydedilmemiş işleri kaybolur. Önce kibarca sonlandırmayı dene."), $"kill -KILL {p.Pid}", L.T("Zorla durdur")))
                    await Signal(p, "kill", false);
            };
            menu.Items.Add(stop);
            menu.Items.Add(kill);
            more.Flyout = menu;
            Grid.SetColumn(more, 6);
            row.Children.Add(more);
        }
        return row;
    }

    private async Task Signal(ServerProcess p, string action, bool confirmDatabase, Func<Task>? then = null)
    {
        try
        {
            await _c.Server<string>("server.signal", new { sessionId = _sessionId, pid = p.Pid, name = p.Name, action, confirmDatabase });
            if (then is not null) { await then(); return; }
            await Task.Delay(800);
            await Load();
            Show(action == "kill" ? $"{p.Name} durduruldu." : L.F("{0} için kapanma isteği gönderildi.", p.Name), InfoBarSeverity.Success);
        }
        catch (Exception ex) when (ex.Message == "database" && !confirmDatabase)
        {
            if (await Confirm(L.T("Bu bir veritabanı"), L.F("{0} bir veritabanı. Durdurulursa yazılmakta olan veriler kaybolabilir ve ona bağlı uygulamalar hata verir. Yine de devam edilsin mi?", p.Name),
                    $"kill -{(action == "kill" ? "KILL" : "TERM")} {p.Pid}", L.T("Yine de durdur")))
                await Signal(p, action, true, then);
        }
        catch (Exception ex)
        {
            Show(Friendly(ex), InfoBarSeverity.Error);
        }
    }

    // ---- timers ----

    /// <summary>
    /// systemd timers (disabled ones too, shown as "Pasif") with their next and
    /// last run, the service's user and command, its journal; enable, disable,
    /// run now, stop; WECOMMANDER's own timers can be created, edited and
    /// deleted. Cron is listed read only. Every change shows the exact command.
    /// </summary>
    private UIElement TimersPage(ServerTimers s)
    {
        var page = new StackPanel { Spacing = 12 };
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(new TextBlock { Text = L.T("Zamanlayıcılar"), Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] });
        var create = Action(L.T("Yeni zamanlayıcı"), () => EditTimer(null), accent: true);
        create.IsEnabled = s.CanChange && s.Systemd;
        create.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(create, 1);
        head.Children.Add(create);
        page.Children.Add(head);
        page.Children.Add(Note(L.T("Sunucudaki systemd zamanlayıcıları; devre dışı (pasif) olanlar da listelenir. Her değişiklikten önce sunucuda çalışacak komut gösterilir. Yalnız WECOMMANDER'ın oluşturduğu zamanlayıcılar düzenlenip silinebilir.")));
        if (!s.CanChange)
            page.Children.Add(Banner(L.T("Yalnız görüntüleme"), L.T("Bu kullanıcı root değil ve parolasız sudo yok: zamanlayıcılar görünür ama etkinleştirme, çalıştırma ve düzenleme yapılamaz."), InfoBarSeverity.Informational));

        if (!s.Systemd)
        {
            page.Children.Add(Banner(L.T("systemd bulunamadı"), L.T("Bu sunucuda systemctl yok; yalnız cron görevleri listelenir."), InfoBarSeverity.Informational));
        }
        else
        {
            var search = new TextBox { PlaceholderText = L.T("Ara (ad, açıklama, komut, kullanıcı)"), Width = 360, Text = _timerFilter, HorizontalAlignment = HorizontalAlignment.Left };
            page.Children.Add(search);
            var rows = new StackPanel { Spacing = 10 };
            page.Children.Add(rows);
            void Fill()
            {
                rows.Children.Clear();
                var shown = TimerView.Ordered(s.Timers, _timerFilter);
                var system = shown.Where(t => t.IsSystem).ToList();
                var user = shown.Where(t => !t.IsSystem).ToList();
                var passive = system.Count(t => TimerView.State(t) == "passive");
                rows.Children.Add(Heading(L.F("Sistem zamanlayıcıları ({0})", system.Count)));
                if (passive > 0) rows.Children.Add(Note(L.F("{0} zamanlayıcı pasif: kendiliğinden çalışmaz.", passive)));
                foreach (var t in system) rows.Children.Add(TimerCard(t, s.CanChange));
                if (user.Count > 0)
                {
                    rows.Children.Add(Heading(L.F("{0} kullanıcısının zamanlayıcıları ({1})", s.LoginUser, user.Count)));
                    rows.Children.Add(Note(L.T("systemctl --user ile çalışan zamanlayıcılar; burada yalnız gösterilir.")));
                    foreach (var t in user) rows.Children.Add(TimerCard(t, false));
                }
                if (shown.Count == 0) rows.Children.Add(Note(L.T("Eşleşen zamanlayıcı yok.")));
            }
            search.TextChanged += (_, _) => { _timerFilter = search.Text; Fill(); };
            Fill();
        }

        page.Children.Add(Heading(L.T("Cron (salt okunur)")));
        page.Children.Add(Note(L.T("Cron görevleri yalnız gösterilir; buradan değiştirilmez.")));
        var crontab = TimerView.CrontabNote(s);
        if (crontab.Length > 0)
            page.Children.Add(Note(crontab + (string.IsNullOrEmpty(s.CrontabMessage) ? "" : "  ·  " + s.CrontabMessage)));
        var cron = new StackPanel { Spacing = 0 };
        cron.Children.Add(CronRow(null));
        foreach (var e in s.Cron) cron.Children.Add(CronRow(e));
        if (s.Cron.Count == 0) cron.Children.Add(Note(L.T("Cron görevi bulunamadı.")));
        page.Children.Add(Card(cron));
        return page;
    }

    private static Border Badge(string text, Brush brush) => new()
    {
        Child = new TextBlock { Text = text, Foreground = brush, FontSize = 12, FontWeight = FontWeights.SemiBold },
        BorderBrush = brush,
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(4),
        Padding = new Thickness(6, 1, 6, 1),
        VerticalAlignment = VerticalAlignment.Center,
    };

    private static Brush StateBrush(ServerTimer t) => TimerView.State(t) switch
    {
        "active" => (Brush)Application.Current.Resources["SystemFillColorSuccessBrush"],
        "failed" => (Brush)Application.Current.Resources["SystemFillColorCriticalBrush"],
        "passive" => (Brush)Application.Current.Resources["SystemFillColorCautionBrush"],
        _ => Secondary,
    };

    private UIElement TimerCard(ServerTimer t, bool canChange)
    {
        var p = new StackPanel { Spacing = 6 };
        var title = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        title.Children.Add(new TextBlock { Text = t.Unit, FontFamily = Mono, FontSize = 15, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center, IsTextSelectionEnabled = true });
        title.Children.Add(Badge(TimerView.StateText(t), StateBrush(t)));
        if (t.IsManaged) title.Children.Add(Badge("WECOMMANDER", (Brush)Application.Current.Resources["AccentTextFillColorPrimaryBrush"]));
        p.Children.Add(title);
        if (!string.IsNullOrEmpty(t.Description))
            p.Children.Add(new TextBlock { Text = t.Description, TextWrapping = TextWrapping.Wrap });
        p.Children.Add(new TextBlock { Text = L.F("Zamanlama: {0}", TimerView.Schedule(t)), TextWrapping = TextWrapping.Wrap });
        var now = DateTimeOffset.UtcNow;
        string When(long? unix)
        {
            var relative = TimerView.Relative(unix, now);
            return TimerView.Time(unix) + (relative.Length > 0 ? $" ({relative})" : "");
        }
        p.Children.Add(Note(L.F("Sonraki çalışma: {0}  ·  Son çalışma: {1}  ·  Son sonuç: {2}", When(t.NextRun), When(t.LastRun), TimerView.Result(t))));
        p.Children.Add(new TextBlock
        {
            Text = L.F("Kullanıcı: {0}  ·  Servis: {1}  ·  Birim dosyası: {2}", string.IsNullOrEmpty(t.User) ? "—" : t.User, t.Service, string.IsNullOrEmpty(t.UnitFileState) ? "—" : t.UnitFileState),
            FontFamily = Mono, FontSize = 12, Foreground = Secondary, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true,
        });
        if (!string.IsNullOrEmpty(t.Command))
            p.Children.Add(new TextBlock { Text = t.Command, FontFamily = Mono, FontSize = 12, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });

        // Details: where it is defined, the service's state and its journal (loaded when opened).
        var details = new StackPanel { Spacing = 6, Visibility = Visibility.Collapsed, Margin = new Thickness(0, 6, 0, 0) };
        details.Children.Add(new TextBlock
        {
            Text = L.F("Dosya: {0}  ·  Kaçırılanı telafi et (Persistent): {1}  ·  Servis durumu: {2}  ·  Son bitiş: {3}",
                string.IsNullOrEmpty(t.FragmentPath) ? "—" : t.FragmentPath, t.Persistent ? L.T("evet") : L.T("hayır"),
                string.IsNullOrEmpty(t.ServiceState) ? "—" : t.ServiceState, TimerView.Time(t.LastExit)),
            FontFamily = Mono, FontSize = 12, Foreground = Secondary, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true,
        });
        if (!string.IsNullOrEmpty(t.ServiceDescription) && t.ServiceDescription != t.Description)
            details.Children.Add(Note(t.ServiceDescription));
        var logNote = new TextBlock { Foreground = Secondary, FontSize = 12, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
        var logText = new TextBlock { FontFamily = Mono, FontSize = 12, TextWrapping = TextWrapping.NoWrap, IsTextSelectionEnabled = true };
        var logs = new ScrollViewer
        {
            Content = logText,
            MaxHeight = 320,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        };
        if (t.IsSystem)
        {
            var logHead = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            logHead.Children.Add(new TextBlock { Text = L.T("Günlük (son 200 satır)"), FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
            logHead.Children.Add(Action(L.T("Yenile"), () => LoadTimerLogs(t, logText, logNote)));
            details.Children.Add(logHead);
            details.Children.Add(logNote);
            details.Children.Add(Card(logs));
        }

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 4, 0, 0) };
        var logsLoaded = false;
        buttons.Children.Add(Action(L.T("Ayrıntılar ve günlük"), async () =>
        {
            details.Visibility = details.Visibility == Visibility.Visible ? Visibility.Collapsed : Visibility.Visible;
            if (details.Visibility == Visibility.Visible && t.IsSystem && !logsLoaded)
            {
                logsLoaded = true;
                await LoadTimerLogs(t, logText, logNote);
            }
        }));
        if (t.IsSystem)
        {
            Button Act(string text, string action, bool accent = false)
            {
                var b = Action(text, () => TimerAction(t, action), accent);
                b.IsEnabled = canChange;
                if (!canChange) ToolTipService.SetToolTip(b, L.T("Bu işlem için sunucuda root ya da parolasız sudo gerekir."));
                return b;
            }
            if (TimerView.CanEnable(t)) buttons.Children.Add(Act(L.T("Etkinleştir"), "enable", accent: TimerView.State(t) == "passive"));
            if (TimerView.CanDisable(t)) buttons.Children.Add(Act(L.T("Devre dışı bırak"), "disable"));
            if (TimerView.CanRunNow(t)) buttons.Children.Add(Act(L.T("Şimdi çalıştır"), "start-now"));
            if (TimerView.CanStop(t)) buttons.Children.Add(Act(L.T("Durdur"), "stop"));
            if (t.IsManaged)
            {
                var edit = Action(L.T("Düzenle"), () => EditTimer(t));
                edit.IsEnabled = canChange;
                buttons.Children.Add(edit);
                var delete = Action(L.T("Sil"), () => DeleteTimer(t));
                delete.IsEnabled = canChange;
                buttons.Children.Add(delete);
            }
        }
        p.Children.Add(buttons);
        p.Children.Add(details);
        return Card(p);
    }

    private async Task LoadTimerLogs(ServerTimer t, TextBlock text, TextBlock note)
    {
        note.Text = L.T("Günlük okunuyor…");
        try
        {
            var r = await _c.Server<TimerLogs>("server.timerLogs", new { sessionId = _sessionId, unit = t.Unit, lines = 200 });
            text.Text = string.Join("\n", r.Lines);
            note.Text = (r.Note.Length > 0 ? r.Note + "\n" : "") + "$ " + r.Command;
        }
        catch (Exception ex)
        {
            note.Text = Friendly(ex);
        }
    }

    private void ShowTimerResult(TimerResult r, string success)
    {
        if (r.Ok) Show(success, InfoBarSeverity.Success);
        else Show(L.F("Komut başarısız oldu: {0}", string.IsNullOrEmpty(r.Output) ? r.Command : r.Output), InfoBarSeverity.Error);
    }

    private async Task TimerAction(ServerTimer t, string action)
    {
        var command = TimerView.ActionCommand(t, action);
        var (title, text, primary) = action switch
        {
            "enable" => (L.F("{0} etkinleştirilsin mi?", t.Unit), L.T("Zamanlayıcı hemen başlar ve sunucu açılışında da başlar; görev takvimine göre kendiliğinden çalışır."), L.T("Etkinleştir")),
            "disable" => (L.F("{0} devre dışı bırakılsın mı?", t.Unit), L.T("Zamanlayıcı durdurulur ve açılışta başlamaz; görev artık kendiliğinden çalışmaz. O anda çalışan iş yarıda kesilmez."), L.T("Devre dışı bırak")),
            "start-now" => (L.F("{0} şimdi çalıştırılsın mı?", t.Service), L.T("Görev beklemeden bir kez başlatılır; zamanlayıcının takvimi değişmez."), L.T("Şimdi çalıştır")),
            _ => (L.F("{0} durdurulsun mu?", t.Service), L.T("Çalışmakta olan görev durdurulur; zamanlayıcı olduğu gibi kalır ve görev bir sonraki zamanında yeniden çalışır."), L.T("Durdur")),
        };
        if (!await Confirm(title, text, command, primary)) return;
        try
        {
            var r = await _c.Server<TimerResult>("server.timerAction", new { sessionId = _sessionId, unit = t.Unit, action });
            await Load();
            ShowTimerResult(r, L.F("{0}: tamamlandı.", action == "start-now" || action == "stop" ? t.Service : t.Unit));
        }
        catch (Exception ex)
        {
            Show(Friendly(ex), InfoBarSeverity.Error);
        }
    }

    /// <summary>Creates a timer (existing = null) or edits one WECOMMANDER created: the form, its checks, the exact commands, then the core.</summary>
    private async Task EditTimer(ServerTimer? existing)
    {
        var m = existing?.Managed;
        var edit = existing is not null;
        if (edit && m is null) return;
        var spec = new TimerSpec(m?.Name ?? "", m?.Description ?? "", m?.Command ?? "", m?.User ?? "root", m?.Calendar ?? "daily");
        string? error = null;
        while (true)
        {
            if (await TimerForm(spec, edit, error) is not { } next) return;
            spec = TimerView.Trimmed(next);
            error = TimerView.Check(spec);
            if (error is not null) continue;
            var unit = spec.Name + ".timer";
            if (!await Confirm(edit ? L.F("{0} düzenlensin mi?", unit) : L.F("{0} oluşturulsun mu?", unit),
                    edit ? L.T("İki birim dosyası yeniden yazılır ve systemd yeniden yüklenir; zamanlayıcı çalışıyorsa yeni takvimle yeniden başlar.")
                         : L.T("/etc/systemd/system içine WECOMMANDER işaretli bir .service ve bir .timer dosyası yazılır, systemd yeniden yüklenir ve zamanlayıcı etkinleştirilir. Takvim önce systemd-analyze ile denetlenir."),
                    TimerView.WriteCommand(spec, edit), edit ? L.T("Kaydet") : L.T("Oluştur")))
                return;
            try
            {
                _scroll.Content = Waiting(L.T("Zamanlayıcı yazılıyor…"));
                var r = await _c.Server<TimerResult>(edit ? "server.timerEdit" : "server.timerCreate",
                    new { sessionId = _sessionId, name = spec.Name, description = spec.Description, command = spec.Command, user = spec.User, calendar = spec.Calendar });
                await Load();
                ShowTimerResult(r, edit ? L.F("{0} güncellendi.", unit) : L.F("{0} oluşturuldu ve etkinleştirildi.", unit));
                return;
            }
            catch (Exception ex)
            {
                // Refused by the server (calendar, user, name taken…): the form again, with why.
                error = Friendly(ex);
                await Load();
            }
        }
    }

    private async Task<TimerSpec?> TimerForm(TimerSpec spec, bool edit, string? error)
    {
        var body = new StackPanel { Spacing = 10, MaxWidth = 560 };
        if (!string.IsNullOrEmpty(error))
            body.Children.Add(new InfoBar { Message = error, Severity = InfoBarSeverity.Error, IsOpen = true, IsClosable = false });
        var name = new TextBox { Header = L.T("Ad (birim dosyalarının adı)"), Text = spec.Name, IsEnabled = !edit, PlaceholderText = "nightly-backup", FontFamily = Mono };
        var description = new TextBox { Header = L.T("Açıklama"), Text = spec.Description };
        var command = new TextBox { Header = L.T("Komut"), Text = spec.Command, PlaceholderText = "/usr/local/bin/backup.sh --full", FontFamily = Mono };
        var user = new TextBox { Header = L.T("Çalıştıran kullanıcı"), Text = spec.User, PlaceholderText = "root", FontFamily = Mono };
        var calendar = new TextBox { Header = L.T("Takvim (OnCalendar)"), Text = spec.Calendar, PlaceholderText = "daily", FontFamily = Mono };
        body.Children.Add(name);
        body.Children.Add(description);
        body.Children.Add(command);
        body.Children.Add(Note(L.T("Komut /bin/sh -c ile çalışır; | ve && kullanılabilir.")));
        body.Children.Add(user);
        body.Children.Add(calendar);
        body.Children.Add(Note(L.T("Örnekler: hourly, daily, weekly, Mon..Fri *-*-* 03:00, *-*-* 04:30:00, *:0/15 (15 dakikada bir).")));
        var dialog = new ContentDialog
        {
            Title = edit ? L.F("{0} düzenle", spec.Name + ".timer") : L.T("Yeni zamanlayıcı"),
            Content = new ScrollViewer { Content = body, MaxHeight = 520 },
            PrimaryButtonText = L.T("Devam"),
            CloseButtonText = L.T("Vazgeç"),
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = Content.XamlRoot,
        };
        try
        {
            if (await dialog.ShowAsync() != ContentDialogResult.Primary) return null;
        }
        catch (Exception) { return null; }
        return new TimerSpec(edit ? spec.Name : name.Text, description.Text, command.Text, user.Text, calendar.Text);
    }

    private async Task DeleteTimer(ServerTimer t)
    {
        if (!t.IsManaged) return;
        if (!await Confirm(L.F("{0} silinsin mi?", t.Unit), L.T("Zamanlayıcı durdurulur, devre dışı bırakılır ve iki birim dosyası silinir. Geri alınamaz."),
                TimerView.DeleteCommand(TimerView.NameOf(t)), L.T("Sil")))
            return;
        try
        {
            var r = await _c.Server<TimerResult>("server.timerDelete", new { sessionId = _sessionId, unit = t.Unit });
            await Load();
            ShowTimerResult(r, L.F("{0} silindi.", t.Unit));
        }
        catch (Exception ex)
        {
            Show(Friendly(ex), InfoBarSeverity.Error);
        }
    }

    private static UIElement CronRow(CronEntry? e)
    {
        var row = new Grid { ColumnSpacing = 12, Padding = new Thickness(4, 4, 4, 4) };
        foreach (var w in new[] { 130.0, 100, -1, 190 })
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = w < 0 ? new GridLength(1, GridUnitType.Star) : new GridLength(w) });
        var cells = e is null
            ? new[] { L.T("Zaman"), L.T("Kullanıcı"), L.T("Komut"), L.T("Kaynak") }
            : e.Unreadable
                ? new[] { "—", "—", L.T("okunamadı (izin yok)"), e.Source }
                : new[] { e.Schedule, e.User, e.Command, e.Source };
        for (var i = 0; i < cells.Length; i++)
        {
            var t = new TextBlock { Text = cells[i], TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center, IsTextSelectionEnabled = e is not null };
            if (e is null) { t.Foreground = Secondary; t.FontWeight = FontWeights.SemiBold; }
            else if (i != 1) { t.FontFamily = Mono; t.FontSize = 12; }
            if (e is not null && i == 2) ToolTipService.SetToolTip(t, cells[i]);
            if (e is not null && i == 3) t.Foreground = Secondary;
            Grid.SetColumn(t, i);
            row.Children.Add(t);
        }
        return row;
    }
}
