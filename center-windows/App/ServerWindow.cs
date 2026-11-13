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
    private ProcessList? _processes;
    private int _generation;
    private DispatcherQueueTimer? _live;
    private bool _sampling;

    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];
    private static readonly FontFamily Mono = new("Cascadia Mono, Consolas");

    public ServerWindow(ServersController controller, string sessionId, string label)
    {
        _c = controller;
        _sessionId = sessionId;
        _label = label;
        Title = $"Sunucu yönetimi — {label}";
        SystemBackdrop = new MicaBackdrop();
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1060, 780));
        try { AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico")); } catch (Exception) { }

        _nav.PaneDisplayMode = NavigationViewPaneDisplayMode.Top;
        _nav.IsBackButtonVisible = NavigationViewBackButtonVisible.Collapsed;
        _nav.IsSettingsVisible = false;
        foreach (var (tag, text, glyph) in new[]
        {
            ("overview", "Genel bakış", ""),
            ("disk", "Disk", ""),
            ("cleanup", "Temizlik", ""),
            ("processes", "Süreçler", ""),
        })
            _nav.MenuItems.Add(new NavigationViewItem { Content = text, Tag = tag, Icon = new FontIcon { Glyph = glyph } });
        var refresh = new NavigationViewItem { Content = "Yenile", Tag = "refresh", SelectsOnInvoked = false, Icon = new SymbolIcon(Symbol.Refresh) };
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
        _nav.SelectedItem = _nav.MenuItems[0];
        Closed += (_, _) => { _live?.Stop(); _generation++; };
        _ = Load();
    }

    /// <summary>Shows the window for another visit (or the first).</summary>
    public void Bring()
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
            "disk" => "Disk taranıyor. Büyük disklerde bir iki dakika sürebilir…",
            "cleanup" => "Silinebilecek dosyalar hesaplanıyor…",
            "processes" => "Süreçler okunuyor…",
            _ => "Sunucu bilgileri okunuyor…",
        });
        try
        {
            UIElement page = _section switch
            {
                "disk" => DiskPage(await _c.Server<DiskUsage>("server.disk", new { sessionId = _sessionId, path = _diskPath })),
                "cleanup" => CleanupPage(await _c.Server<CleanupScan>("server.cleanupScan", new { sessionId = _sessionId })),
                "processes" => ProcessesPage(_processes = await _c.Server<ProcessList>("server.processes", new { sessionId = _sessionId })),
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
        waiting.Children.Add(new TextBlock { Text = $"{_diskPath} taranıyor", Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"] });
        waiting.Children.Add(percent);
        waiting.Children.Add(bar);
        waiting.Children.Add(Note("Klasörler tek tek ölçülüyor; büyük disklerde bir iki dakika sürebilir."));
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
        ex.Message == "Terminal kapalı." ? "Bu sunucunun terminali kapandı. Sunucu yönetimi için yeniden bağlan." : ex.Message;

    // ---- building blocks ----

    private static UIElement Waiting(string text)
    {
        var p = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12, Margin = new Thickness(0, 24, 0, 0) };
        p.Children.Add(new ProgressRing { IsActive = true, Width = 20, Height = 20 });
        p.Children.Add(new TextBlock { Text = text, Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
        return p;
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
            body.Children.Add(new InfoBar { Title = "Dikkat", Message = warning, Severity = InfoBarSeverity.Warning, IsOpen = true, IsClosable = false });
        body.Children.Add(new TextBlock { Text = "Sunucuda çalışacak komut:", Foreground = Secondary });
        body.Children.Add(new TextBlock { Text = command, FontFamily = Mono, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
        var dialog = new ContentDialog
        {
            Title = title,
            Content = new ScrollViewer { Content = body, MaxHeight = 460 },
            PrimaryButtonText = primary,
            CloseButtonText = "Vazgeç",
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
        page.Children.Add(Note($"{o.Os}  ·  {o.Kernel}  ·  açık kalma süresi {Sizes.Duration(o.UptimeSecs)}"));

        // What needs attention first.
        foreach (var d in o.Disks.Where(d => d.UsedPercent >= 85))
            page.Children.Add(Banner($"{d.Mount} %{d.UsedPercent:0} dolu",
                $"Boş yer: {Sizes.Kb(d.AvailKb)}. Disk dolarsa veritabanları ve Docker durur.",
                d.UsedPercent >= 90 ? InfoBarSeverity.Error : InfoBarSeverity.Warning,
                ButtonFor("Neyin yer kapladığını gör", () => { _diskPath = d.Mount; Go("disk"); })));
        if (o.Zombies > 0)
            page.Children.Add(Banner($"{o.Zombies} zombi süreç",
                "Bitmiş ama üst süreçleri tarafından toplanmamış süreçler. Hangi programdan geldiklerini Süreçler'de gör.",
                o.Zombies >= 20 ? InfoBarSeverity.Warning : InfoBarSeverity.Informational,
                ButtonFor("Zombileri gör", () => Go("processes"))));
        if (o.RebootRequired)
            page.Children.Add(Banner("Yeniden başlatma bekleniyor", "Kurulan güncellemelerin bir kısmı sunucu yeniden başlatılınca devreye girer.", InfoBarSeverity.Informational));
        if (!string.IsNullOrEmpty(o.Updates))
            page.Children.Add(Banner("Güncellemeler var", o.Updates.Replace("updates can be applied immediately.", "güncelleme hemen kurulabilir."), InfoBarSeverity.Informational));
        if (!o.CanChange)
            page.Children.Add(Banner("Yalnız görüntüleme", "Bu kullanıcı root değil ve parolasız sudo yok: bilgiler görünür ama temizlik ve süreç işlemleri yapılamaz.", InfoBarSeverity.Informational));

        // Gauges: how full each resource is right now.
        var gauges = new Grid { ColumnSpacing = 12 };
        var rings = new List<FrameworkElement>
        {
            Charts.Ring(o.CpuPercent, $"İşlemci", $"{o.Cpus} çekirdek · yük {o.Load[0]:0.00}"),
            Charts.Ring(o.MemTotalKb == 0 ? 0 : (o.MemTotalKb - o.MemAvailableKb) * 100.0 / o.MemTotalKb, "Bellek", $"{Sizes.Kb(o.MemTotalKb - o.MemAvailableKb)} / {Sizes.Kb(o.MemTotalKb)}"),
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
        head.Children.Add(new TextBlock { Text = "Canlı", Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"] });
        head.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse { Width = 8, Height = 8, Fill = new SolidColorBrush(Charts.Bad), VerticalAlignment = VerticalAlignment.Center });
        head.Children.Add(new TextBlock { Text = $"2 saniyede bir · {o.Processes} süreç", Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
        page.Children.Add(head);
        var cpuChart = new ColumnChart("İşlemci", Charts.Palette[0], v => $"%{v:0}", fixedMax: 100);
        var memChart = new ColumnChart("Bellek", Charts.Palette[3], v => $"%{v:0}", fixedMax: 100);
        var netChart = new ColumnChart("Ağ trafiği", Charts.Palette[1], v => Sizes.Rate(v));
        var ioChart = new ColumnChart("Disk okuma + yazma", Charts.Palette[2], v => Sizes.Rate(v));
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

        page.Children.Add(Heading("Diskler"));
        var disks = new StackPanel { Spacing = 16 };
        foreach (var d in o.Disks)
        {
            var b = new Button { HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Padding = new Thickness(0) };
            b.Content = Meter($"{d.Mount}   ({d.Device}, {d.FsType})", d.UsedKb, d.UsedKb + d.AvailKb, $"boş {Sizes.Kb(d.AvailKb)}");
            ToolTipService.SetToolTip(b, "Bu diskte neyin yer kapladığını gör");
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
                mem.Push(mp, $"{Sizes.Kb(now.MemTotalKb - now.MemAvailableKb)} kullanımda");
                if (last is { } prev && now.Uptime > prev.Uptime)
                {
                    var secs = now.Uptime - prev.Uptime;
                    var total = (double)(now.CpuTotal - prev.CpuTotal);
                    var busy = total <= 0 ? 0 : (total - (now.CpuIdle - prev.CpuIdle)) * 100.0 / total;
                    cpu.Push(busy, $"yük {now.Load1:0.00}");
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
        var up = new Button { Content = new SymbolIcon(Symbol.Up), IsEnabled = u.Path != "/" };
        ToolTipService.SetToolTip(up, "Üst klasör");
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
            page.Children.Add(Banner("Bazı klasörler okunamadı", "Bu kullanıcının erişemediği klasörler sayılmadı; boyutlar gerçekte daha büyük olabilir (root ile bağlan).", InfoBarSeverity.Informational));
        if (u.Entries.Count > 0)
        {
            var top = u.Entries.Take(7).Select(e => (Name(u.Path, e.Path), (double)e.Kb, Sizes.Kb(e.Kb))).ToList();
            var rest = u.TotalKb > (ulong)u.Entries.Take(7).Sum(e => (decimal)e.Kb) ? u.TotalKb - (ulong)u.Entries.Take(7).Sum(e => (decimal)e.Kb) : 0;
            if (rest > 0) top.Add(("Diğer", rest, Sizes.Kb(rest)));
            page.Children.Add(Card(Charts.Donut(top, Sizes.Kb(u.TotalKb))));
        }
        page.Children.Add(Note("En çok yer kaplayanlar. Bir klasöre tıklayınca içine girer. Bu ekran yalnız ölçer; silme Temizlik'ten yapılır."));

        var list = new StackPanel { Spacing = 2 };
        var max = u.Entries.Count == 0 ? 1 : Math.Max(1, u.Entries.Max(e => e.Kb));
        foreach (var e in u.Entries)
        {
            var row = new Grid { ColumnSpacing = 12, Padding = new Thickness(8, 6, 8, 6) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(90) });
            var name = Name(u.Path, e.Path);
            row.Children.Add(new TextBlock { Text = name, FontFamily = Mono, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center });
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
        if (u.Entries.Count == 0) list.Children.Add(Note("Bu klasörde alt klasör yok."));
        page.Children.Add(Card(list));

        if (u.Docker.Count > 0)
        {
            page.Children.Add(Heading("Docker"));
            var docker = new StackPanel { Spacing = 8 };
            foreach (var d in u.Docker)
            {
                var kind = d.Kind switch { "Images" => "İmajlar", "Containers" => "Konteynerler", "Local Volumes" => "Birimler (veriler)", "Build Cache" => "Build önbelleği", _ => d.Kind };
                docker.Children.Add(new TextBlock { Text = $"{kind} ({d.Count}): {Sizes.Bytes(d.SizeBytes)}" + (d.ReclaimableBytes > 0 && d.Kind != "Local Volumes" ? $"  ·  {Sizes.Bytes(d.ReclaimableBytes)} geri kazanılabilir" : "") });
            }
            docker.Children.Add(Note("Birimlere (uygulama verileri) hiçbir zaman dokunulmaz."));
            var clean = new Button { Content = "Temizlik'e git" };
            clean.Click += (_, _) => Go("cleanup");
            docker.Children.Add(clean);
            page.Children.Add(Card(docker));
        }
        return page;
    }

    private static string Name(string parent, string path) =>
        path.Length > parent.Length && path.StartsWith(parent) ? path[parent.Length..].TrimStart('/') : path;

    // ---- cleanup ----

    private UIElement CleanupPage(CleanupScan scan)
    {
        var page = new StackPanel { Spacing = 12 };
        page.Children.Add(new TextBlock { Text = "Güvenle silinebilecekler", Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] });
        page.Children.Add(Note("Yalnız bilinen, yeniden oluşturulabilen dosyalar listelenir. Uygulama verilerine, veritabanlarına ve Docker birimlerine dokunulmaz. Silmeden önce çalışacak komutlar gösterilir."));
        var canChange = scan.Privilege is "root" or "sudo";
        if (!canChange)
            page.Children.Add(Banner("Temizlik için yetki yok", "Bu kullanıcı root değil ve parolasız sudo yok. Boyutlar eksik ölçülmüş olabilir; temizlik için root ile bağlan.", InfoBarSeverity.Warning));

        var boxes = new List<(CheckBox Box, CleanupItem Item, Windows.UI.Color Color)>();
        var total = new TextBlock { FontWeight = FontWeights.SemiBold };
        // The disk now and after the chosen cleanup: grey = stays, colours = freed.
        var visual = new Border();
        if (scan.Disk is { } disk) page.Children.Add(Card(visual));
        void Sum()
        {
            var chosenKb = (ulong)boxes.Where(b => b.Box.IsChecked == true).Sum(b => (decimal)b.Item.Kb);
            total.Text = $"Seçilenler: {Sizes.Kb(chosenKb)}";
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
            line.Children.Add(new TextBlock { Text = $"temizlikten sonra boş: {Sizes.Kb(d.AvailKb + freed)}", Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
            v.Children.Add(line);
            v.Children.Add(Charts.Stack(parts, size));
            visual.Child = v;
        }
        var list = new StackPanel { Spacing = 14 };
        var colorIndex = 0;
        foreach (var item in scan.Items.OrderByDescending(i => i.Kb))
        {
            var color = Charts.Palette[colorIndex++ % (Charts.Palette.Length - 1)];
            var row = new Grid { ColumnSpacing = 12 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var box = new CheckBox
            {
                MinWidth = 0,
                IsEnabled = canChange && item.Kb > 0,
                IsChecked = canChange && item.Kb > 0 && string.IsNullOrEmpty(item.Warning),
                VerticalAlignment = VerticalAlignment.Top,
            };
            box.Checked += (_, _) => Sum();
            box.Unchecked += (_, _) => Sum();
            row.Children.Add(box);
            var text = new StackPanel { Spacing = 2 };
            var titleRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            titleRow.Children.Add(new Microsoft.UI.Xaml.Shapes.Rectangle { Width = 12, Height = 12, RadiusX = 3, RadiusY = 3, Fill = new SolidColorBrush(color), VerticalAlignment = VerticalAlignment.Center });
            titleRow.Children.Add(new TextBlock { Text = item.Title, FontWeight = FontWeights.SemiBold });
            text.Children.Add(titleRow);
            text.Children.Add(Note(item.Detail));
            if (!string.IsNullOrEmpty(item.Warning))
                text.Children.Add(new TextBlock { Text = "Dikkat: " + item.Warning, TextWrapping = TextWrapping.Wrap, Foreground = (Brush)Application.Current.Resources["SystemFillColorCautionBrush"] });
            text.Children.Add(new TextBlock { Text = item.Command, FontFamily = Mono, FontSize = 12, Foreground = Secondary, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
            Grid.SetColumn(text, 1);
            row.Children.Add(text);
            var size = new TextBlock { Text = item.Kb > 0 ? Sizes.Kb(item.Kb) : "boş", FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Top };
            Grid.SetColumn(size, 2);
            row.Children.Add(size);
            list.Children.Add(row);
            boxes.Add((box, item, color));
        }
        page.Children.Add(Card(list));
        Sum();

        var bottom = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 16 };
        bottom.Children.Add(total);
        bottom.Children.Add(Action("Seçilenleri temizle", async () =>
        {
            var chosen = boxes.Where(b => b.Box.IsChecked == true).Select(b => b.Item).ToList();
            if (chosen.Count == 0) { Show("Temizlenecek bir şey seçilmedi.", InfoBarSeverity.Informational); return; }
            var warning = string.Join(" ", chosen.Where(c => !string.IsNullOrEmpty(c.Warning)).Select(c => c.Warning));
            if (!await Confirm("Temizlik", $"{chosen.Count} kalem silinecek; yaklaşık {Sizes.Kb((ulong)chosen.Sum(c => (decimal)c.Kb))} yer açılacak. Geri alınamaz.",
                    string.Join("\n", chosen.Select(c => c.Command)), "Temizle", warning)) return;
            await RunCleanup(chosen);
        }, accent: true));
        page.Children.Add(bottom);
        return page;
    }

    private async Task RunCleanup(List<CleanupItem> chosen)
    {
        var before = await RootFree();
        _scroll.Content = Waiting("Temizleniyor…");
        try
        {
            var results = await _c.Server<List<CleanupResult>>("server.cleanupRun", new { sessionId = _sessionId, ids = chosen.Select(c => c.Id).ToList() });
            var after = await RootFree();
            var failed = results.Where(r => !r.Ok).ToList();
            var freed = before is { } b && after is { } a && a > b ? $" {Sizes.Kb(a - b)} yer açıldı." : "";
            if (failed.Count == 0) Show("Temizlik tamamlandı." + freed, InfoBarSeverity.Success);
            else Show($"Bazı kalemler temizlenemedi: {string.Join("; ", failed.Select(f => chosen.First(c => c.Id == f.Id).Title + (string.IsNullOrEmpty(f.Message) ? "" : $" ({f.Message})")))}." + freed, InfoBarSeverity.Warning);
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
            page.Children.Add(new TextBlock { Text = $"Zombi süreçler ({list.Zombies.Sum(z => z.Count)})", Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] });
            page.Children.Add(Note("Zombi süreç zaten bitmiştir; bellek ya da işlemci kullanmaz, doğrudan sonlandırılamaz. Onu yalnız kendisini başlatan üst süreç toplayabilir. Önce üst sürece zararsız bir hatırlatma gönder; işe yaramazsa üst sürecin servisini ya da konteynerini yeniden başlat."));
            foreach (var z in list.Zombies) page.Children.Add(ZombieCard(z, canChange));
        }
        else
        {
            page.Children.Add(Banner("Zombi süreç yok", "Bütün bitmiş süreçler toplanmış.", InfoBarSeverity.Success));
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
        var cpuTop = Top("En çok işlemci kullanan 10 süreç", live.OrderByDescending(p => p.Cpu), p => p.Cpu, p => $"%{p.Cpu:0.0}", Charts.Palette[0]);
        var memTop = Top("En çok bellek kullanan 10 süreç", live.OrderByDescending(p => p.RssKb), p => p.RssKb, p => Sizes.Kb(p.RssKb), Charts.Palette[3]);
        Grid.SetColumn(memTop, 1);
        charts.Children.Add(cpuTop);
        charts.Children.Add(memTop);
        page.Children.Add(charts);

        page.Children.Add(Heading("Süreçler"));
        var tools = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var search = new TextBox { PlaceholderText = "Ara (ad, komut, kullanıcı, PID)", Width = 320, Text = _processFilter };
        var sort = new ComboBox { Width = 180 };
        sort.Items.Add(new ComboBoxItem { Content = "İşlemciye göre", Tag = "cpu" });
        sort.Items.Add(new ComboBoxItem { Content = "Belleğe göre", Tag = "mem" });
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
            if (shown.Count == 0) rows.Children.Add(Note("Eşleşen süreç yok."));
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
            "container" => $"Docker konteyneri: {z.Owner.Name}",
            "service" => $"Servis: {z.Owner.Name}",
            _ => "",
        };
        if (owner.Length > 0) p.Children.Add(Note(owner + $"  ·  çalışma süresi {Sizes.Duration(z.Parent.ElapsedSecs)}"));
        if (z.Owner.Kind == "container")
            p.Children.Add(Note("Kalıcı çözüm: konteyner küçük bir init süreciyle (--init) çalışsın; o, bitmiş süreçleri kendiliğinden toplar. \"Öneriyi uygula\" bunu Coolify'daki ayarına ekleyip uygulamayı yeniden dağıtır."));

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        if (canChange && z.Owner.Kind == "container")
            buttons.Children.Add(Action("Öneriyi uygula", () => ApplyInit(z, null), accent: true));
        if (canChange)
        {
            buttons.Children.Add(Action("Toplamasını iste", async () =>
            {
                if (!await Confirm("Zombileri toplamasını iste", $"{z.Parent.Name} sürecine SIGCHLD gönderilir: \"bitmiş alt süreçlerin var, topla\" demektir. Süreci durdurmaz, zararsızdır.",
                        $"kill -CHLD {z.Parent.Pid}", "Gönder")) return;
                await Signal(z.Parent, "reap", false, then: async () =>
                {
                    await Task.Delay(1500);
                    var before = z.Count;
                    _processes = await _c.Server<ProcessList>("server.processes", new { sessionId = _sessionId });
                    var now = _processes.Zombies.FirstOrDefault(x => x.Parent.Pid == z.Parent.Pid)?.Count ?? 0;
                    _scroll.Content = ProcessesPage(_processes);
                    Show(now == 0 ? "Zombilerin hepsi toplandı." : now < before ? $"{before - now} zombi toplandı; {now} kaldı." :
                        "Süreç hatırlatmaya yanıt vermedi (program zombileri toplamıyor). Kalıcı çözüm için servisini ya da konteynerini yeniden başlat.",
                        now == 0 ? InfoBarSeverity.Success : InfoBarSeverity.Warning);
                });
            }));
            if (z.Owner.Kind is "container" or "service" && z.Protected.Length == 0)
            {
                var what = z.Owner.Kind == "container" ? "konteyneri" : "servisi";
                var command = z.Owner.Kind == "container" ? $"docker restart {z.Owner.Id}" : $"systemctl restart {z.Owner.Id}";
                buttons.Children.Add(Action($"{char.ToUpper(what[0])}{what[1..]} yeniden başlat", async () =>
                {
                    if (!await Confirm($"{z.Owner.Name} yeniden başlatılsın mı?",
                            $"Bu {what} birkaç saniye kapanıp açılır; o sürede hizmet vermez. Yeniden başlayınca zombiler de gider.",
                            command, "Yeniden başlat")) return;
                    try
                    {
                        _scroll.Content = Waiting("Yeniden başlatılıyor…");
                        await _c.Server<string>("server.restartOwner", new { sessionId = _sessionId, kind = z.Owner.Kind, id = z.Owner.Id });
                        await Load();
                        Show($"{z.Owner.Name} yeniden başlatıldı.", InfoBarSeverity.Success);
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
        if (token is null && !await Confirm("Öneriyi uygula",
                $"{z.Owner.Name} konteynerinin uygulamasına Coolify'da --init seçeneği eklenir ve uygulama Coolify üzerinden yeniden dağıtılır. " +
                "Dağıtım birkaç dakika sürer; eski konteyner yenisi hazır olunca kapanır. Ayar kalıcıdır; sonraki dağıtımlarda da geçerli olur.",
                "Coolify API: custom_docker_run_options += \"--init\"\nCoolify API: deploy", "Uygula"))
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
                    Show($"{r.App}: --init {(r.Status == "already" ? "zaten açıktı" : "eklendi")}, yeniden dağıtım başladı. Birkaç dakika sonra Yenile'ye bas; zombiler gitmiş olmalı.", InfoBarSeverity.Success);
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
        body.Children.Add(new TextBlock { TextWrapping = TextWrapping.Wrap, Text = "Bu ayarı Coolify'a yazmak için bir kez Coolify API anahtarı gerekiyor:" });
        body.Children.Add(new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = Secondary, Text = "1. Coolify'da Ayarlar > Gelişmiş > API erişimi açık olsun.\n2. Keys & Tokens > API tokens > yeni anahtar oluştur; \"write\" ve \"deploy\" yetkilerini seç.\n3. Anahtarı buraya yapıştır." });
        var box = new PasswordBox { PlaceholderText = "Coolify API anahtarı" };
        body.Children.Add(box);
        body.Children.Add(new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = Secondary, FontSize = 12, Text = "Anahtar bu bilgisayarın anahtar zincirinde saklanır. Coolify'a sunucunun kendi içinden bağlanılır; anahtar internete çıkmaz." });
        var dialog = new ContentDialog
        {
            Title = "Coolify API anahtarı",
            Content = body,
            PrimaryButtonText = "Devam",
            CloseButtonText = "Vazgeç",
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
            ? new[] { "Ad", "PID", "Kullanıcı", "İşlemci", "Bellek", "Komut" }
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
            var more = new Button { Content = new SymbolIcon(Symbol.More), Padding = new Thickness(6), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
            var menu = new MenuFlyout();
            var stop = new MenuFlyoutItem { Text = "Sonlandır (kibarca)", Icon = new SymbolIcon(Symbol.Stop) };
            stop.Click += async (_, _) =>
            {
                if (await Confirm($"{p.Name} sonlandırılsın mı?", "Sürece kapanması söylenir (SIGTERM); program açık işlerini bitirip kapanır. Bir servisin parçasıysa servis onu yeniden başlatabilir.", $"kill -TERM {p.Pid}", "Sonlandır"))
                    await Signal(p, "term", false);
            };
            var kill = new MenuFlyoutItem { Text = "Zorla durdur", Icon = new SymbolIcon(Symbol.Cancel) };
            kill.Click += async (_, _) =>
            {
                if (await Confirm($"{p.Name} zorla durdurulsun mı?", "Süreç anında durdurulur (SIGKILL); kaydedilmemiş işleri kaybolur. Önce kibarca sonlandırmayı dene.", $"kill -KILL {p.Pid}", "Zorla durdur"))
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
            Show(action == "kill" ? $"{p.Name} durduruldu." : $"{p.Name} için kapanma isteği gönderildi.", InfoBarSeverity.Success);
        }
        catch (Exception ex) when (ex.Message == "database" && !confirmDatabase)
        {
            if (await Confirm("Bu bir veritabanı", $"{p.Name} bir veritabanı. Durdurulursa yazılmakta olan veriler kaybolabilir ve ona bağlı uygulamalar hata verir. Yine de devam edilsin mi?",
                    $"kill -{(action == "kill" ? "KILL" : "TERM")} {p.Pid}", "Yine de durdur"))
                await Signal(p, action, true, then);
        }
        catch (Exception ex)
        {
            Show(Friendly(ex), InfoBarSeverity.Error);
        }
    }
}
