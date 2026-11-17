using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Zamanlayıcılar: this computer's Windows Task Scheduler. Lists the tasks
/// (Windows' own hidden unless asked for), shows a task's triggers, actions
/// and history, and runs, turns off/on, creates, edits and deletes tasks —
/// each after a confirmation that shows the exact command. Only tasks in
/// \WECOMMANDER\ are edited or deleted. Tasks keep running on their schedule
/// when WECOMMANDER is closed: Windows runs them.
/// </summary>
public sealed class TaskSchedulerWindow : Window
{
    private static TaskSchedulerWindow? _open;
    private readonly TaskSchedulerView _view = new(showTitle: true);

    /// <summary>Opens the window (one window; a second call brings it forward).</summary>
    public static void Open()
    {
        _open ??= new TaskSchedulerWindow();
        _open.AppWindow.Show();
        _open.Activate();
    }

    private TaskSchedulerWindow()
    {
        Title = L.T("Zamanlayıcılar");
        SystemBackdrop = new MicaBackdrop();
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1120, 780));
        try { AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico")); } catch (Exception) { }
        Content = _view;
        _view.Reload();
        Closed += (_, _) => _open = null;
    }
}

/// <summary>
/// The Zamanlayıcılar content (this computer's Windows Task Scheduler): one
/// implementation for its window and the Dock's "Görevler" panel.
/// </summary>
public sealed class TaskSchedulerView : UserControl
{
    private readonly TextBlock _summary = new() { VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBox _search = new() { Width = 260 };
    private readonly ToggleSwitch _windowsSwitch = new() { OnContent = null, OffContent = null };
    private readonly StackPanel _rows = new();
    private readonly InfoBar _info = new() { IsClosable = true, Margin = new Thickness(0, 0, 0, 8) };
    private readonly StackPanel _details = new() { Spacing = 6 };
    private readonly ProgressRing _busy = new() { Width = 20, Height = 20, IsActive = false };
    private List<LocalTask> _all = [];
    private string? _selected;
    private bool _reading;

    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];
    private static readonly FontFamily Mono = new("Cascadia Mono, Consolas");

    public TaskSchedulerView(bool showTitle)
    {
        var root = new Grid { Padding = showTitle ? new Thickness(24, 16, 24, 16) : new Thickness(12, 4, 12, 12), RowSpacing = 10 };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var title = new StackPanel { Spacing = 2 };
        if (showTitle) title.Children.Add(new TextBlock { Text = L.T("Zamanlayıcılar"), Style = (Style)Application.Current.Resources["TitleTextBlockStyle"] });
        title.Children.Add(_summary);
        _summary.Foreground = Secondary;
        _summary.Text = L.F("Görev Zamanlayıcı · bu bilgisayar ({0})", Environment.MachineName);
        root.Children.Add(title);

        Grid.SetRow(_info, 1);
        root.Children.Add(_info);

        var tools = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        _search.PlaceholderText = L.T("Ara (ad, klasör, komut)");
        _search.TextChanged += (_, _) => Render();
        var windowsLabel = new TextBlock { Text = L.T("Windows görevlerini göster"), VerticalAlignment = VerticalAlignment.Center };
        _windowsSwitch.Toggled += (_, _) => Render();
        var refresh = new Button { Content = new SymbolIcon(Symbol.Refresh) };
        ToolTipService.SetToolTip(refresh, L.T("Yenile"));
        refresh.Click += (_, _) => _ = Refresh();
        var create = new Button { Content = L.T("Yeni görev"), Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        create.Click += async (_, _) => await Edit(null);
        var windows = new Button { Content = L.T("Windows Görev Zamanlayıcı") };
        windows.Click += (_, _) => Launch("mmc.exe", "taskschd.msc");
        foreach (var e in new UIElement[] { _search, windowsLabel, _windowsSwitch, refresh, create, windows, _busy }) tools.Children.Add(e);
        Grid.SetRow(tools, 2);
        root.Children.Add(tools);

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

        var detailsScroll = new ScrollViewer { Content = _details, MaxHeight = 300, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        var detailsCard = Card(detailsScroll, new Thickness(16, 12, 16, 12));
        Grid.SetRow(detailsCard, 4);
        root.Children.Add(detailsCard);
        ShowDetails();

        Content = root;
    }

    /// <summary>Reads the tasks again (when it is shown).</summary>
    public void Reload() => _ = Refresh();

    private static Border Card(UIElement content, Thickness padding) => new()
    {
        Child = content,
        Padding = padding,
        CornerRadius = new CornerRadius(8),
        Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"],
        BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"],
        BorderThickness = new Thickness(1),
    };

    // ---- reading ----

    private async Task Refresh()
    {
        if (_reading) return;
        _reading = true;
        _busy.IsActive = true;
        try
        {
            _all = await Task.Run(() => LocalTaskReader.Read());
            var ours = _all.Count(t => t.IsOurs);
            _summary.Text = L.F("Görev Zamanlayıcı · bu bilgisayar ({0}) · {1} görev, {2} tanesi WECOMMANDER'ın", Environment.MachineName, _all.Count, ours);
            Render();
            ShowDetails();
        }
        catch (Exception e)
        {
            App.LogCrash(e);
            Show(L.F("Görevler okunamadı: {0}", e.Message), InfoBarSeverity.Error);
        }
        finally
        {
            _reading = false;
            _busy.IsActive = false;
        }
    }

    // ---- list ----

    private static readonly GridLength[] Columns =
    [
        new(1.4, GridUnitType.Star), new(1, GridUnitType.Star), new(100), new(150), new(150), new(1, GridUnitType.Star), new(28),
    ];

    private static Grid Columned()
    {
        var g = new Grid { Padding = new Thickness(12, 6, 12, 6), ColumnSpacing = 8 };
        foreach (var w in Columns) g.ColumnDefinitions.Add(new ColumnDefinition { Width = w });
        return g;
    }

    private static UIElement Header()
    {
        var g = Columned();
        g.Padding = new Thickness(12, 10, 12, 8);
        var names = new[] { L.T("Ad"), L.T("Klasör"), L.T("Durum"), L.T("Sonraki çalışma"), L.T("Son çalışma"), L.T("Son sonuç") };
        for (var i = 0; i < names.Length; i++)
        {
            var t = new TextBlock { Text = names[i], FontWeight = FontWeights.SemiBold };
            Grid.SetColumn(t, i);
            g.Children.Add(t);
        }
        return g;
    }

    private static TextBlock Cell(string text, int column, bool dim = false)
    {
        var t = new TextBlock { Text = text, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
        if (dim) t.Foreground = Secondary;
        Grid.SetColumn(t, column);
        return t;
    }

    private void Render()
    {
        _rows.Children.Clear();
        var shown = LocalTasks.Filter(_all, _search.Text, _windowsSwitch.IsOn);
        var accent = (Brush)Application.Current.Resources["SubtleFillColorSecondaryBrush"];
        foreach (var t in shown)
        {
            var g = Columned();
            g.Background = t.Path == _selected ? accent : new SolidColorBrush(Colors.Transparent);
            g.Children.Add(Cell(t.Name, 0));
            g.Children.Add(Cell(t.Folder, 1, true));
            var state = Cell(LocalTasks.StateText(t.State), 2);
            if (t.State == LocalTaskState.Disabled) state.Foreground = Secondary;
            if (t.State == LocalTaskState.Running) state.Foreground = new SolidColorBrush(Charts.Level(0));
            g.Children.Add(state);
            g.Children.Add(Cell(t.NextRun ?? "—", 3, true));
            g.Children.Add(Cell(t.LastRun ?? "—", 4, true));
            var result = Cell(LocalTasks.ResultText(t.LastResult), 5, true);
            ToolTipService.SetToolTip(result, LocalTasks.ResultText(t.LastResult));
            g.Children.Add(result);
            var mark = new FontIcon { FontSize = 12, Opacity = 0.7, Glyph = t.IsOurs ? "\uE73E" : "\uE72E", Visibility = t.IsOurs || LocalTaskReader.NeedsAdmin(t) ? Visibility.Visible : Visibility.Collapsed };
            ToolTipService.SetToolTip(mark, t.IsOurs ? L.T("WECOMMANDER'ın oluşturduğu görev") : L.T("Değiştirmek için yönetici izni gerekiyor"));
            Grid.SetColumn(mark, 6);
            g.Children.Add(mark);
            var path = t.Path;
            g.Tapped += (_, _) => { _selected = path; Render(); ShowDetails(); };
            _rows.Children.Add(g);
        }
        if (shown.Count == 0 && !_reading)
            _rows.Children.Add(new TextBlock
            {
                Margin = new Thickness(12),
                Foreground = Secondary,
                TextWrapping = TextWrapping.Wrap,
                Text = _all.Count == 0 ? L.T("Görev okunmadı.") : L.T("Gösterilecek görev yok. Windows'un kendi görevleri için \"Windows görevlerini göster\"i aç ya da \"Yeni görev\" ile bir tane oluştur."),
            });
    }

    // ---- details and actions ----

    private LocalTask? Selected() => _all.FirstOrDefault(t => t.Path == _selected);

    private void ShowDetails()
    {
        _details.Children.Clear();
        if (Selected() is not { } t)
        {
            _details.Children.Add(new TextBlock { Text = L.T("Ayrıntılar ve işlemler için bir görev seç."), Foreground = Secondary });
            return;
        }
        _details.Children.Add(new TextBlock { Text = t.Name, FontWeight = FontWeights.SemiBold, FontSize = 16 });
        var facts = new List<string>
        {
            L.F("Klasör: {0}", t.Folder),
            L.F("Durum: {0}", LocalTasks.StateText(t.State)),
            L.F("Son sonuç: {0}", LocalTasks.ResultText(t.LastResult)),
        };
        if (t.Author is { Length: > 0 } author) facts.Add(L.F("Oluşturan: {0}", author));
        if ((t.UserId ?? t.GroupId) is { } account) facts.Add(L.F("Hesap: {0}", account));
        _details.Children.Add(new TextBlock { Text = string.Join("   ·   ", facts), Foreground = Secondary, TextWrapping = TextWrapping.Wrap });
        if (t.Description is { Length: > 0 } description)
            _details.Children.Add(new TextBlock { Text = description, Foreground = Secondary, TextWrapping = TextWrapping.Wrap });
        _details.Children.Add(new TextBlock { Text = L.F("Tetikleyiciler: {0}", t.TriggerSummary), TextWrapping = TextWrapping.Wrap });
        _details.Children.Add(new TextBlock { Text = L.T("Eylemler:"), Margin = new Thickness(0, 4, 0, 0) });
        foreach (var a in t.Actions)
            _details.Children.Add(new TextBlock
            {
                Text = a.Display + (a.WorkingDirectory is { Length: > 0 } wd ? "   (" + L.F("çalışma klasörü: {0}", wd) + ")" : ""),
                FontFamily = Mono, FontSize = 12, Foreground = Secondary, IsTextSelectionEnabled = true, TextWrapping = TextWrapping.Wrap,
            });
        if (t.Actions.Count == 0) _details.Children.Add(new TextBlock { Text = "—", Foreground = Secondary });

        var admin = LocalTaskReader.NeedsAdmin(t);
        if (admin)
            _details.Children.Add(new TextBlock
            {
                Text = "🔒 " + L.T("Bu görev başka bir hesapla ya da en yüksek yetkiyle çalışıyor: çalıştırmak ve değiştirmek için yönetici izni gerekiyor."),
                TextWrapping = TextWrapping.Wrap,
            });

        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(0, 6, 0, 0) };
        var run = new Button { Content = L.T("Şimdi çalıştır"), IsEnabled = t.Enabled && !admin };
        run.Click += async (_, _) => await Act(t, L.T("Görev şimdi çalıştırılsın mı?"), L.F("{0} hemen bir kez çalışır.", t.Name), L.T("Çalıştır"),
            LocalTasks.Run(t.Path), L.F("{0} çalıştırıldı.", t.Name));
        buttons.Children.Add(run);
        var toggle = new Button { Content = t.Enabled ? L.T("Devre dışı bırak") : L.T("Etkinleştir"), IsEnabled = !admin };
        toggle.Click += async (_, _) => await Act(t,
            t.Enabled ? L.T("Görev devre dışı bırakılsın mı?") : L.T("Görev etkinleştirilsin mi?"),
            t.Enabled ? L.F("{0} zamanı gelince çalışmaz; yeniden etkinleştirene kadar bekler.", t.Name) : L.F("{0} zamanlamasına göre yeniden çalışır.", t.Name),
            t.Enabled ? L.T("Devre dışı bırak") : L.T("Etkinleştir"),
            LocalTasks.SetEnabled(t.Path, !t.Enabled),
            t.Enabled ? L.F("{0} devre dışı bırakıldı.", t.Name) : L.F("{0} etkinleştirildi.", t.Name));
        buttons.Children.Add(toggle);
        if (t.IsOurs)
        {
            var edit = new Button { Content = L.T("Düzenle") };
            var spec = LocalTasks.SpecFrom(t);
            edit.IsEnabled = spec is not null;
            if (spec is null) ToolTipService.SetToolTip(edit, L.T("Bu görevin biçimi burada düzenlenemiyor; Windows Görev Zamanlayıcı ile düzenle."));
            edit.Click += async (_, _) => await Edit(spec);
            buttons.Children.Add(edit);
            var delete = new Button { Content = L.T("Sil") };
            delete.Click += async (_, _) =>
            {
                if (LocalTasks.Delete(t.Path) is not { } args) { Show(LocalTasks.DeleteRefusal(t.Path)!, InfoBarSeverity.Warning); return; }
                await Act(t, L.T("Görev silinsin mi?"), L.F("{0} kalıcı olarak silinir ve bir daha çalışmaz.", t.Name), L.T("Sil"), args, L.F("{0} silindi.", t.Name));
            };
            buttons.Children.Add(delete);
        }
        var history = new Button { Content = L.T("Geçmişi göster") };
        var historyList = new StackPanel { Spacing = 2 };
        history.Click += async (_, _) =>
        {
            history.IsEnabled = false;
            historyList.Children.Clear();
            var events = await Task.Run(() => LocalTaskReader.History(t));
            if (events.Count == 0)
                historyList.Children.Add(new TextBlock { Text = L.T("Geçmiş yok. Windows görev geçmişini varsayılan olarak tutmaz (Görev Zamanlayıcı → Tüm görevlerin geçmişini etkinleştir)."), Foreground = Secondary, TextWrapping = TextWrapping.Wrap });
            foreach (var e in events)
                historyList.Children.Add(new TextBlock
                {
                    Text = $"{e.At?.ToLocalTime().ToString("g", L.Culture) ?? "?"}   {e.Text}" + (e.Result is { } r ? "   " + LocalTasks.ResultText(r) : ""),
                    FontSize = 12, Foreground = Secondary,
                });
            history.IsEnabled = true;
        };
        buttons.Children.Add(history);
        _details.Children.Add(buttons);
        _details.Children.Add(historyList);
    }

    /// <summary>Asks first, showing the exact command; then runs it and reads the list again.</summary>
    private async Task Act(LocalTask t, string title, string text, string confirm, IReadOnlyList<string> args, string done)
    {
        if (!await Confirm(title, text, confirm, args)) return;
        var error = await Task.Run(() => LocalTaskReader.Do(args));
        if (error is null) Show(done, InfoBarSeverity.Success);
        else Show(error, InfoBarSeverity.Error);
        if (error is null && args.Count > 0 && args[0] == "/delete" && _selected == t.Path) _selected = null;
        await Refresh();
    }

    private async Task<bool> Confirm(string title, string text, string confirm, IReadOnlyList<string> args)
    {
        var body = new StackPanel { Spacing = 10, MaxWidth = 560 };
        body.Children.Add(new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap });
        body.Children.Add(new TextBlock { Text = L.T("Çalışacak komut:"), Foreground = Secondary });
        body.Children.Add(new TextBlock
        {
            Text = LocalTasks.CommandLine("schtasks", args),
            FontFamily = Mono, FontSize = 12, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true,
        });
        var dialog = new ContentDialog
        {
            Title = title,
            Content = body,
            PrimaryButtonText = confirm,
            CloseButtonText = L.T("Vazgeç"),
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = Content.XamlRoot,
        };
        try { return await dialog.ShowAsync() == ContentDialogResult.Primary; }
        catch (Exception) { return false; }
    }

    /// <summary>New task (null) or a task of ours again: name, program, arguments, schedule; the command is shown as it is typed.</summary>
    private async Task Edit(LocalTaskSpec? existing)
    {
        var name = new TextBox { Header = L.T("Görev adı"), Text = existing?.Name ?? "", IsReadOnly = existing is not null, PlaceholderText = L.T("ör. gece-yedegi") };
        var program = new TextBox { Header = L.T("Program"), Text = existing?.Program ?? "", PlaceholderText = @"C:\Tools\backup.exe" };
        var arguments = new TextBox { Header = L.T("Argümanlar (isteğe bağlı)"), Text = existing?.Arguments ?? "" };
        var schedules = new[] { ("once", L.T("Bir kez")), ("daily", L.T("Her gün")), ("weekly", L.T("Her hafta")), ("logon", L.T("Oturum açılınca")) };
        var schedule = new ComboBox { Header = L.T("Zamanlama"), ItemsSource = schedules.Select(s => s.Item2).ToList(), MinWidth = 200,
            SelectedIndex = Math.Max(0, Array.FindIndex(schedules, s => s.Item1 == (existing?.Schedule ?? "daily"))) };
        var time = new TimePicker { Header = L.T("Başlangıç saati"), ClockIdentifier = "24HourClock", MinuteIncrement = 1,
            SelectedTime = TimeSpan.TryParseExact(existing?.Time ?? "09:00", @"hh\:mm", System.Globalization.CultureInfo.InvariantCulture, out var at) ? at : new TimeSpan(9, 0, 0) };
        var days = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4 };
        var dayBoxes = new List<(DayOfWeek Day, CheckBox Box)>();
        foreach (var d in new[] { DayOfWeek.Monday, DayOfWeek.Tuesday, DayOfWeek.Wednesday, DayOfWeek.Thursday, DayOfWeek.Friday, DayOfWeek.Saturday, DayOfWeek.Sunday })
        {
            var box = new CheckBox { Content = L.Culture.DateTimeFormat.AbbreviatedDayNames[(int)d], MinWidth = 0, IsChecked = existing?.Days.Contains(d) == true };
            dayBoxes.Add((d, box));
            days.Children.Add(box);
        }
        var command = new TextBlock { FontFamily = Mono, FontSize = 12, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
        var error = new TextBlock { TextWrapping = TextWrapping.Wrap, Foreground = new SolidColorBrush(ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44)) };
        var note = new TextBlock
        {
            Text = L.T("Görev \\WECOMMANDER\\ klasöründe, senin hesabınla oluşturulur ve oturumun açıkken çalışır. WECOMMANDER kapalı olsa da Windows çalıştırır."),
            Foreground = Secondary, TextWrapping = TextWrapping.Wrap, FontSize = 12,
        };

        LocalTaskSpec Spec() => new(name.Text.Trim(), program.Text.Trim(), arguments.Text.Trim(),
            schedules[Math.Max(0, schedule.SelectedIndex)].Item1,
            (time.SelectedTime ?? new TimeSpan(9, 0, 0)).ToString(@"hh\:mm", System.Globalization.CultureInfo.InvariantCulture),
            dayBoxes.Where(x => x.Box.IsChecked == true).Select(x => x.Day).ToList());
        void Update()
        {
            var s = Spec();
            time.Visibility = s.Schedule == "logon" ? Visibility.Collapsed : Visibility.Visible;
            days.Visibility = s.Schedule == "weekly" ? Visibility.Visible : Visibility.Collapsed;
            command.Text = LocalTasks.CommandLine("schtasks", LocalTasks.Create(s));
            error.Text = "";
        }
        name.TextChanged += (_, _) => Update();
        program.TextChanged += (_, _) => Update();
        arguments.TextChanged += (_, _) => Update();
        schedule.SelectionChanged += (_, _) => Update();
        time.SelectedTimeChanged += (_, _) => Update();
        foreach (var (_, box) in dayBoxes) box.Click += (_, _) => Update();
        Update();

        var body = new StackPanel { Spacing = 10, MinWidth = 480, MaxWidth = 600 };
        foreach (var e in new UIElement[] { name, program, arguments, schedule, time, days, note })
            body.Children.Add(e);
        body.Children.Add(new TextBlock { Text = L.T("Çalışacak komut:"), Foreground = Secondary });
        body.Children.Add(command);
        body.Children.Add(error);
        var dialog = new ContentDialog
        {
            Title = existing is null ? L.T("Yeni görev") : L.T("Görevi düzenle"),
            Content = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto },
            PrimaryButtonText = existing is null ? L.T("Oluştur") : L.T("Kaydet"),
            CloseButtonText = L.T("Vazgeç"),
            DefaultButton = ContentDialogButton.Primary,
            XamlRoot = Content.XamlRoot,
        };
        dialog.PrimaryButtonClick += (_, e) =>
        {
            if (LocalTasks.Check(Spec()) is { } problem) { error.Text = problem; e.Cancel = true; }
        };
        ContentDialogResult answer;
        try { answer = await dialog.ShowAsync(); } catch (Exception) { return; }
        if (answer != ContentDialogResult.Primary) return;
        var spec = Spec();
        var failed = await Task.Run(() => LocalTaskReader.Create(spec));
        if (failed is null)
        {
            Show(existing is null ? L.F("{0} oluşturuldu.", spec.Name) : L.F("{0} güncellendi.", spec.Name), InfoBarSeverity.Success);
            _selected = LocalTasks.OurFolder + spec.Name;
        }
        else Show(failed, InfoBarSeverity.Error);
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
