using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// The Task Manager window: <see cref="TaskManagerView"/> in a window of its
/// own (classic mode, "Pencerede aç" from the Dock's panel).
/// </summary>
public sealed class TaskManagerWindow : Window
{
    private static TaskManagerWindow? _open;
    private readonly TaskManagerView _view = new(showTitle: true);

    /// <summary>Opens the Task Manager (one window; a second call brings it forward).</summary>
    public static void Open()
    {
        _open ??= new TaskManagerWindow();
        _open.AppWindow.Show();
        _open.Activate();
    }

    private TaskManagerWindow()
    {
        Title = L.T("Görev Yöneticisi");
        SystemBackdrop = new Microsoft.UI.Xaml.Media.MicaBackdrop();
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1080, 760));
        try { AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico")); } catch (Exception) { }
        Content = _view;
        _view.Resume();
        Closed += (_, _) => { _view.Pause(); _open = null; };
    }
}

/// <summary>
/// Task Manager: the watched servers' processes (live, over their monitor
/// connection) and this computer's (live CPU, memory, disk, tree, details,
/// end with guards). The device list puts the servers first and this computer
/// last; local and remote are never one list. Ending or zombie fixes on a
/// server open its server management. One implementation for the window and
/// the Dock's drop-down panel.
/// </summary>
public sealed class TaskManagerView : UserControl
{
    private readonly ComboBox _device = new() { MinWidth = 280 };
    private readonly TextBlock _summary = new() { VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBox _search = new() { Width = 260 };
    private readonly ComboBox _sort = new() { Width = 170 };
    private readonly ToggleSwitch _treeSwitch = new() { OnContent = null, OffContent = null };
    private readonly StackPanel _rows = new();
    private readonly List<RowView> _views = [];
    private readonly InfoBar _info = new() { IsClosable = true, Margin = new Thickness(0, 0, 0, 8) };
    private readonly StackPanel _details = new() { Spacing = 6 };
    private readonly DispatcherQueueTimer _timer;
    private LocalSnapshot? _previous;
    private List<LocalProcessRow> _current = [];
    private (ulong Idle, ulong Total) _cpuBefore;
    private uint? _selected;
    private DateTime? _selectedStarted;
    private string _order = "cpu";
    private bool _tree;
    private bool _reading;
    // A watched server's processes (null host: this computer).
    private string? _hostId;
    private ProcessList? _remote;
    private uint? _remoteSelected;
    private bool _remoteReading;
    private readonly StackPanel _remoteRows = new();
    private readonly List<RowView> _remoteViews = [];
    private readonly StackPanel _remoteDetails = new() { Spacing = 6 };
    private UIElement? _localTools, _localList, _localDetails, _remoteList, _remoteDetailsCard, _treeLabel, _windowsTm;

    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];
    private const int MaxRows = 250;

    public TaskManagerView(bool showTitle)
    {
        var root = new Grid { Padding = showTitle ? new Thickness(24, 16, 24, 16) : new Thickness(12, 4, 12, 12), RowSpacing = 10 };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        // Which device: a watched server (first) or this computer (last).
        var top = new Grid { ColumnSpacing = 12 };
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var title = new StackPanel { Spacing = 2 };
        // In the Dock's panel its header already names it.
        if (showTitle) title.Children.Add(new TextBlock { Text = L.T("Görev Yöneticisi"), Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] });
        title.Children.Add(_summary);
        _summary.Foreground = Secondary;
        top.Children.Add(title);
        var deviceBox = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
        deviceBox.Children.Add(new TextBlock { Text = L.T("Cihaz"), VerticalAlignment = VerticalAlignment.Center, Foreground = Secondary });
        deviceBox.Children.Add(_device);
        Grid.SetColumn(deviceBox, 1);
        top.Children.Add(deviceBox);
        root.Children.Add(top);
        _device.SelectionChanged += (_, _) => DeviceChosen();

        Grid.SetRow(_info, 1);
        root.Children.Add(_info);

        // Search, sort, tree, Windows' own Task Manager.
        var tools = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        _search.PlaceholderText = L.T("Ara (ad, PID, konum)");
        _search.TextChanged += (_, _) => { if (_hostId is null) Render(); else RenderRemote(); };
        foreach (var (tag, text) in new[] { ("cpu", L.T("İşlemciye göre")), ("memory", L.T("Belleğe göre")), ("disk", L.T("Diske göre")), ("name", L.T("Ada göre")), ("pid", L.T("PID'e göre")) })
            _sort.Items.Add(new ComboBoxItem { Content = text, Tag = tag });
        _sort.SelectedIndex = 0;
        _sort.SelectionChanged += (_, _) => { _order = (_sort.SelectedItem as ComboBoxItem)?.Tag as string ?? "cpu"; if (_hostId is null) Render(); else RenderRemote(); };
        var treeLabel = new TextBlock { Text = L.T("Ağaç görünümü"), VerticalAlignment = VerticalAlignment.Center };
        _treeSwitch.Toggled += (_, _) => { _tree = _treeSwitch.IsOn; Render(); };
        var windowsTm = new Button { Content = L.T("Windows Görev Yöneticisi") };
        windowsTm.Click += (_, _) => Launch("taskmgr.exe", "");
        tools.Children.Add(_search);
        tools.Children.Add(_sort);
        tools.Children.Add(treeLabel);
        tools.Children.Add(_treeSwitch);
        tools.Children.Add(windowsTm);
        Grid.SetRow(tools, 2);
        root.Children.Add(tools);
        _localTools = tools;
        _treeLabel = treeLabel;
        _windowsTm = windowsTm;

        // The list: a header and pooled rows (updated in place every two seconds).
        var list = new Grid();
        list.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        list.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        list.Children.Add(Header());
        var scroll = new ScrollViewer { Content = _rows, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(scroll, 1);
        list.Children.Add(scroll);
        var listCard = Card(list, new Thickness(0));
        Grid.SetRow(listCard, 3);
        root.Children.Add(listCard);
        _localList = listCard;

        var detailsCard = Card(_details, new Thickness(16, 12, 16, 12));
        Grid.SetRow(detailsCard, 4);
        root.Children.Add(detailsCard);
        _localDetails = detailsCard;
        ShowDetails();

        // A server's list: name, PID, CPU, memory, user (no disk per process over SSH).
        var remote = new Grid();
        remote.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        remote.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        remote.Children.Add(Header(remote: true));
        var remoteScroll = new ScrollViewer { Content = _remoteRows, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(remoteScroll, 1);
        remote.Children.Add(remoteScroll);
        var remoteCard = Card(remote, new Thickness(0));
        remoteCard.Visibility = Visibility.Collapsed;
        Grid.SetRow(remoteCard, 3);
        root.Children.Add(remoteCard);
        _remoteList = remoteCard;
        var remoteDetailsCard = Card(_remoteDetails, new Thickness(16, 12, 16, 12));
        remoteDetailsCard.Visibility = Visibility.Collapsed;
        Grid.SetRow(remoteDetailsCard, 4);
        root.Children.Add(remoteDetailsCard);
        _remoteDetailsCard = remoteDetailsCard;

        Content = root;
        FillDevices();
        _timer = DispatcherQueue.CreateTimer();
        _timer.Interval = TimeSpan.FromSeconds(2);
        _timer.Tick += (_, _) => _ = Refresh();
    }

    /// <summary>On screen: reads every two seconds (and once now).</summary>
    public void Resume()
    {
        if (_timer.IsRunning) return;
        FillDevices();
        _timer.Start();
        _ = Refresh();
    }

    /// <summary>Hidden or closed: stops reading.</summary>
    public void Pause() => _timer.Stop();

    private static Border Card(UIElement content, Thickness padding) => new()
    {
        Child = content,
        Padding = padding,
        CornerRadius = new CornerRadius(8),
        Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"],
        BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
        BorderThickness = new Thickness(1),
    };

    // ---- devices ----

    private bool _filling, _filledOnce;

    /// <summary>The watched servers first, this computer last; keeps the current choice when it is still there.</summary>
    private void FillDevices()
    {
        _filling = true;
        try
        {
            var keep = _hostId;
            var servers = App.Current.Monitor.Servers.ToList();
            _device.Items.Clear();
            foreach (var s in servers)
                _device.Items.Add(new ComboBoxItem { Content = L.F("Sunucu: {0}", s.Label), Tag = s.HostId });
            _device.Items.Add(new ComboBoxItem { Content = L.F("Bu bilgisayar ({0})", Environment.MachineName), Tag = "" });
            // First time: the first server. Later: the choice stays (this computer stays this
            // computer); a server no longer watched falls back to the first one.
            string? pick = !_filledOnce || (keep is not null && servers.All(s => s.HostId != keep))
                ? servers.FirstOrDefault()?.HostId
                : keep;
            _filledOnce = true;
            _device.SelectedItem = _device.Items.OfType<ComboBoxItem>().First(i => (i.Tag as string) == (pick ?? ""));
            Use(pick);
        }
        finally { _filling = false; }
    }

    private void DeviceChosen()
    {
        if (_filling) return;
        var tag = (_device.SelectedItem as ComboBoxItem)?.Tag as string;
        Use(string.IsNullOrEmpty(tag) ? null : tag);
        _ = Refresh();
    }

    /// <summary>Shows a server's list (hostId) or this computer's (null).</summary>
    private void Use(string? hostId)
    {
        if (hostId != _hostId) { _remote = null; _remoteSelected = null; _info.IsOpen = false; }
        _hostId = hostId;
        var remote = hostId is not null;
        _localList!.Visibility = remote ? Visibility.Collapsed : Visibility.Visible;
        _localDetails!.Visibility = remote ? Visibility.Collapsed : Visibility.Visible;
        _remoteList!.Visibility = remote ? Visibility.Visible : Visibility.Collapsed;
        _remoteDetailsCard!.Visibility = remote ? Visibility.Visible : Visibility.Collapsed;
        _treeLabel!.Visibility = remote ? Visibility.Collapsed : Visibility.Visible;
        _treeSwitch.Visibility = remote ? Visibility.Collapsed : Visibility.Visible;
        _windowsTm!.Visibility = remote ? Visibility.Collapsed : Visibility.Visible;
        _search.PlaceholderText = remote ? L.T("Ara (ad, PID, komut)") : L.T("Ara (ad, PID, konum)");
        if (remote) { _summary.Text = "…"; RenderRemote(); ShowRemoteDetails(); }
    }

    private WatchedServer? CurrentServer => _hostId is null ? null : App.Current.Monitor.Servers.FirstOrDefault(s => s.HostId == _hostId);

    // ---- reading ----

    private async Task Refresh()
    {
        if (_hostId is not null) { await RefreshRemote(); return; }
        if (_reading) return;
        _reading = true;
        try
        {
            var before = _previous;
            var cpuBefore = _cpuBefore;
            var (snapshot, rows, cpuNow, memory) = await Task.Run(() =>
            {
                var snap = LocalProcessReader.Read();
                return (snap, LocalProcesses.Rows(before, snap, Environment.ProcessorCount, LocalProcessReader.SelfPid),
                    LocalProcessReader.CpuTimes(), LocalProcessReader.Memory());
            });
            _previous = snapshot;
            _current = rows;
            _cpuBefore = cpuNow;
            var total = cpuNow.Total - cpuBefore.Total;
            var cpu = cpuBefore.Total == 0 || total == 0 ? (double?)null : Math.Clamp((total - (cpuNow.Idle - cpuBefore.Idle)) * 100.0 / total, 0, 100);
            _summary.Text = L.F("İşlemci {0} · Bellek {1} / {2} · {3} süreç",
                cpu is { } c ? $"%{c:0}" : "…", Sizes.Bytes(memory.Used), Sizes.Bytes(memory.Total), rows.Count);
            Render();
            ShowDetails();
        }
        catch (Exception e)
        {
            App.LogCrash(e);
        }
        finally { _reading = false; }
    }

    // ---- list ----

    private static readonly GridLength[] Columns =
    [
        new(1, GridUnitType.Star), new(80), new(80), new(110), new(110), new(28),
    ];

    private static Grid Columned()
    {
        var g = new Grid { Padding = new Thickness(12, 5, 12, 5), ColumnSpacing = 8 };
        foreach (var w in Columns) g.ColumnDefinitions.Add(new ColumnDefinition { Width = w });
        return g;
    }

    private UIElement Header(bool remote = false)
    {
        var g = Columned();
        g.Padding = new Thickness(12, 10, 12, 8);
        var names = new[] { (L.T("Ad"), "name"), ("PID", "pid"), (L.T("İşlemci"), "cpu"), (L.T("Bellek"), "memory"), remote ? (L.T("Kullanıcı"), "user") : ("Disk", "disk") };
        for (var i = 0; i < names.Length; i++)
        {
            var (text, tag) = names[i];
            var b = new HyperlinkButton
            {
                Content = new TextBlock { Text = text, FontWeight = FontWeights.SemiBold },
                Padding = new Thickness(0),
                HorizontalAlignment = i == 0 ? HorizontalAlignment.Left : HorizontalAlignment.Right,
            };
            b.Click += (_, _) =>
            {
                foreach (var item in _sort.Items.OfType<ComboBoxItem>())
                    if (item.Tag as string == tag) _sort.SelectedItem = item;
            };
            Grid.SetColumn(b, i);
            g.Children.Add(b);
        }
        return g;
    }

    private sealed class RowView
    {
        public readonly Grid Root = Columned();
        public readonly TextBlock Name = new() { TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
        public readonly TextBlock Pid = Num();
        public readonly TextBlock Cpu = Num();
        public readonly TextBlock Memory = Num();
        public readonly TextBlock Disk = Num();
        public readonly PathIcon Lock = LockIcon();
        public LocalProcessRow? Row;
        public uint? RemotePid;

        private static TextBlock Num() => new() { HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center, };

        private static PathIcon LockIcon()
        {
            var icon = Icons.Make(IconName.Lock, size: 12);
            icon.Opacity = 0.6;
            icon.Visibility = Visibility.Collapsed;
            return icon;
        }

        public RowView(Action<RowView> select)
        {
            Root.Background = new SolidColorBrush(Colors.Transparent);
            UIElement[] cells = [Name, Pid, Cpu, Memory, Disk, Lock];
            for (var i = 0; i < cells.Length; i++)
            {
                Grid.SetColumn((FrameworkElement)cells[i], i);
                Root.Children.Add(cells[i]);
            }
            Root.Tapped += (_, _) => select(this);
        }
    }

    private void Render()
    {
        var shown = LocalProcesses.Filter(_current, _search.Text).ToList();
        var order = LocalProcesses.Order(_order);
        var descending = LocalProcesses.Descending(_order);
        List<(LocalProcessRow Row, int Depth)> lines = _tree && _search.Text.Trim().Length == 0
            ? LocalProcesses.Tree(shown, order, descending)
            : (descending ? shown.OrderByDescending(order).ThenBy(r => r.Pid) : shown.OrderBy(order).ThenBy(r => r.Pid)).Select(r => (r, 0)).ToList();
        if (lines.Count > MaxRows) lines = lines.Take(MaxRows).ToList();

        while (_views.Count < lines.Count)
        {
            var view = new RowView(Select);
            _views.Add(view);
            _rows.Children.Add(view.Root);
        }
        var accent = (Brush)Application.Current.Resources["SubtleFillColorSecondaryBrush"];
        for (var i = 0; i < _views.Count; i++)
        {
            var v = _views[i];
            if (i >= lines.Count) { v.Root.Visibility = Visibility.Collapsed; v.Row = null; continue; }
            var (row, depth) = lines[i];
            v.Row = row;
            v.Root.Visibility = Visibility.Visible;
            v.Name.Text = row.Name;
            v.Name.Margin = new Thickness(depth * 16, 0, 0, 0);
            v.Pid.Text = row.Pid.ToString();
            v.Cpu.Text = $"%{row.Cpu:0.0}";
            v.Memory.Text = row.Info.WorkingSetBytes == 0 ? "—" : Sizes.Bytes(row.Info.WorkingSetBytes);
            v.Disk.Text = row.DiskBytesPerSecond < 1 ? "0" : Sizes.Rate(row.DiskBytesPerSecond);
            v.Lock.Visibility = row.CanEnd ? Visibility.Collapsed : Visibility.Visible;
            ToolTipService.SetToolTip(v.Lock, row.Protected);
            v.Root.Background = row.Pid == _selected ? accent : new SolidColorBrush(Colors.Transparent);
        }
        if (lines.Count == 0 && _current.Count > 0) Show(L.T("Eşleşen süreç yok."), InfoBarSeverity.Informational);
    }

    private void Select(RowView view)
    {
        if (view.Row is not { } row) return;
        _selected = row.Pid;
        _selectedStarted = row.Info.Started;
        Render();
        ShowDetails();
    }

    // ---- a server ----

    private async Task RefreshRemote()
    {
        if (_remoteReading) return;
        var server = CurrentServer;
        if (server is null) { FillDevices(); return; }
        if (server.MonitorId is not { } id)
        {
            _summary.Text = server.Error ?? L.F("{0}: bağlanılıyor…", server.Label);
            return;
        }
        _remoteReading = true;
        var host = _hostId;
        try
        {
            var list = await App.Current.Servers.Server<ProcessList>("server.processes", new { sessionId = id });
            if (host != _hostId) return; // another device was chosen meanwhile
            _remote = list;
            var used = server.Last is { } l ? (l.MemTotalKb - Math.Min(l.MemTotalKb, l.MemAvailableKb)) * 1024 : 0;
            var total = server.Last is { } t ? t.MemTotalKb * 1024 : 0;
            _summary.Text = L.F("İşlemci {0} · Bellek {1} / {2} · {3} süreç",
                server.Samples > 1 ? $"%{server.Cpu:0}" : "…", total == 0 ? "…" : Sizes.Bytes(used), total == 0 ? "…" : Sizes.Bytes(total), list.Processes.Count);
            var zombies = list.Zombies.Sum(z => (long)z.Count);
            if (zombies > 0) Show(L.F("{0} zombi süreç", zombies), InfoBarSeverity.Warning);
            RenderRemote();
            ShowRemoteDetails();
        }
        catch (Exception e)
        {
            if (host == _hostId) _summary.Text = $"{server.Label}: {e.Message}";
        }
        finally { _remoteReading = false; }
    }

    private void RenderRemote()
    {
        var all = _remote?.Processes ?? [];
        var q = _search.Text.Trim();
        IEnumerable<ServerProcess> shown = q.Length == 0 ? all : all.Where(p =>
            p.Name.Contains(q, StringComparison.OrdinalIgnoreCase) || p.Command.Contains(q, StringComparison.OrdinalIgnoreCase)
            || p.Pid.ToString() == q || p.User.Contains(q, StringComparison.OrdinalIgnoreCase));
        shown = _order switch
        {
            "memory" => shown.OrderByDescending(p => p.RssKb),
            "name" => shown.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase),
            "pid" => shown.OrderBy(p => p.Pid),
            _ => shown.OrderByDescending(p => p.Cpu).ThenByDescending(p => p.RssKb),
        };
        var lines = shown.Take(MaxRows).ToList();
        while (_remoteViews.Count < lines.Count)
        {
            var view = new RowView(SelectRemote);
            _remoteViews.Add(view);
            _remoteRows.Children.Add(view.Root);
        }
        var accent = (Brush)Application.Current.Resources["SubtleFillColorSecondaryBrush"];
        for (var i = 0; i < _remoteViews.Count; i++)
        {
            var v = _remoteViews[i];
            if (i >= lines.Count) { v.Root.Visibility = Visibility.Collapsed; v.RemotePid = null; continue; }
            var p = lines[i];
            v.RemotePid = p.Pid;
            v.Root.Visibility = Visibility.Visible;
            v.Name.Text = p.State.StartsWith('Z') ? L.F("{0} (zombi)", p.Name) : p.Name;
            v.Pid.Text = p.Pid.ToString();
            v.Cpu.Text = $"%{p.Cpu:0.0}";
            v.Memory.Text = p.RssKb == 0 ? "—" : Sizes.Kb(p.RssKb);
            v.Disk.Text = p.User;
            v.Root.Background = p.Pid == _remoteSelected ? accent : new SolidColorBrush(Colors.Transparent);
        }
    }

    private void SelectRemote(RowView view)
    {
        if (view.RemotePid is not { } pid) return;
        _remoteSelected = pid;
        RenderRemote();
        ShowRemoteDetails();
    }

    private void ShowRemoteDetails()
    {
        _remoteDetails.Children.Clear();
        var server = CurrentServer;
        var row = _remote?.Processes.FirstOrDefault(p => p.Pid == _remoteSelected);
        if (row is null)
            _remoteDetails.Children.Add(new TextBlock { Text = L.T("Ayrıntılar ve işlemler için bir süreç seç."), Foreground = Secondary });
        else
        {
            _remoteDetails.Children.Add(new TextBlock { Text = $"{row.Name}  ·  PID {row.Pid}", FontWeight = FontWeights.SemiBold, FontSize = 16 });
            _remoteDetails.Children.Add(new TextBlock
            {
                Text = L.F("Kullanıcı: {0}", row.User) + "   ·   " + L.F("Durum: {0}", row.State) + L.F("  ·  çalışma süresi {0}", Sizes.Duration(row.ElapsedSecs)),
                Foreground = Secondary, TextWrapping = TextWrapping.Wrap,
            });
            _remoteDetails.Children.Add(new TextBlock
            {
                Text = row.Command, Foreground = Secondary, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12,
                TextTrimming = TextTrimming.CharacterEllipsis, IsTextSelectionEnabled = true,
            });
        }
        if (server is not null)
        {
            // Ending a process and zombie fixes are done (with their checks) in the server management.
            var open = new Button { Content = L.T("Sunucu yönetimini aç") };
            open.Click += (_, _) => { try { App.Current.OpenServerManagement(server, "processes"); } catch (Exception e) { App.LogCrash(e); } };
            _remoteDetails.Children.Add(open);
        }
    }

    // ---- details and actions ----

    private LocalProcessRow? Selected() =>
        _current.FirstOrDefault(r => r.Pid == _selected && (r.Info.Started == _selectedStarted || _selectedStarted is null));

    private void ShowDetails()
    {
        _details.Children.Clear();
        if (Selected() is not { } row)
        {
            _details.Children.Add(new TextBlock { Text = L.T("Ayrıntılar ve işlemler için bir süreç seç."), Foreground = Secondary });
            return;
        }
        var head = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        head.Children.Add(new TextBlock { Text = $"{row.Name}  ·  PID {row.Pid}", FontWeight = FontWeights.SemiBold, FontSize = 16, VerticalAlignment = VerticalAlignment.Center });
        _details.Children.Add(head);
        var parent = _current.FirstOrDefault(r => r.Pid == row.Info.ParentPid);
        var facts = new List<string>
        {
            L.F("Üst süreç: {0}", parent is null ? row.Info.ParentPid.ToString() : $"{parent.Name} ({parent.Pid})"),
            L.F("İş parçacığı: {0}", row.Info.Threads),
            L.F("Özel bellek: {0}", row.Info.PrivateBytes == 0 ? "—" : Sizes.Bytes(row.Info.PrivateBytes)),
        };
        if (row.Info.Started is { } started) facts.Add(L.F("Başlangıç: {0}", started.ToLocalTime().ToString("g", L.Culture)));
        _details.Children.Add(new TextBlock { Text = string.Join("   ·   ", facts), Foreground = Secondary, TextWrapping = TextWrapping.Wrap });
        _details.Children.Add(new TextBlock
        {
            Text = row.Info.Path ?? L.T("Konum okunamadı (Windows bu süreci korur ya da yönetici izni gerekir)."),
            Foreground = Secondary, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12,
            TextTrimming = TextTrimming.CharacterEllipsis, IsTextSelectionEnabled = true,
        });
        if (row.Protected is { } why)
            _details.Children.Add(new TextBlock { Text = "🔒 " + why, TextWrapping = TextWrapping.Wrap });

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var end = new Button { Content = L.T("Sonlandır"), IsEnabled = row.CanEnd };
        if (row.CanEnd) end.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        else ToolTipService.SetToolTip(end, row.Protected);
        end.Click += async (_, _) => await EndProcess(row);
        buttons.Children.Add(end);
        if (row.Info.Path is { } path)
        {
            var folder = new Button { Content = L.T("Dosya konumunu aç") };
            folder.Click += (_, _) => Launch("explorer.exe", $"/select,\"{path}\"");
            buttons.Children.Add(folder);
        }
        _details.Children.Add(buttons);
    }

    private async Task EndProcess(LocalProcessRow row)
    {
        var children = _current.Count(r => r.Info.ParentPid == row.Pid && r.Pid != row.Pid);
        var body = new StackPanel { Spacing = 10, MaxWidth = 520 };
        body.Children.Add(new TextBlock
        {
            Text = L.F("{0} (PID {1}) hemen kapanır; kaydedilmemiş işleri kaybolabilir.", row.Name, row.Pid),
            TextWrapping = TextWrapping.Wrap,
        });
        if (children > 0)
            body.Children.Add(new InfoBar
            {
                Title = L.T("Dikkat"), Severity = InfoBarSeverity.Warning, IsOpen = true, IsClosable = false,
                Message = L.F("Bu sürecin {0} alt süreci var; onlar çalışmaya devam eder ama üst süreçleri olmadan düzgün çalışmayabilir.", children),
            });
        var dialog = new ContentDialog
        {
            Title = L.T("Süreç sonlandırılsın mı?"),
            Content = body,
            PrimaryButtonText = L.T("Sonlandır"),
            CloseButtonText = L.T("Vazgeç"),
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = Content.XamlRoot,
        };
        ContentDialogResult answer;
        try { answer = await dialog.ShowAsync(); } catch (Exception) { return; }
        if (answer != ContentDialogResult.Primary) return;
        var error = await Task.Run(() => LocalProcessReader.End(row));
        if (error is null)
        {
            Show(L.F("{0} sonlandırıldı.", row.Name), InfoBarSeverity.Success);
            _selected = null;
        }
        else Show(error, InfoBarSeverity.Error);
        await Refresh();
    }

    private void Show(string text, InfoBarSeverity severity)
    {
        _info.Message = text;
        _info.Severity = severity;
        _info.IsOpen = true;
    }

    private void Launch(string file, string args)
    {
        try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(file, args) { UseShellExecute = true }); }
        catch (Exception e) { Show(e.Message, InfoBarSeverity.Error); }
    }
}
