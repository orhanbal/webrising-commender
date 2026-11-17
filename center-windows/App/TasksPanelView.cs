using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// The Dock's "Görevler" panel: three tabs for what the Dock's Tasks button
/// offered as a menu. "Windows zamanlayıcıları" hosts the Zamanlayıcılar
/// content itself (TaskSchedulerView); "Sunucu zamanlayıcıları" hosts the
/// server management content on its timers section (ServerManagementView) for
/// the Dock's server; "WECOMMANDER görevleri" lives in the main window (its
/// page is part of that window), so the tab lists the tasks and opens the page
/// for changes.
/// </summary>
public sealed class TasksPanelView : UserControl
{
    private readonly ServersController _servers;
    private readonly Func<WatchedServer?> _selected;
    private readonly SelectorBar _bar = new();
    private readonly ContentControl _body = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private readonly Dictionary<string, SelectorBarItem> _items = [];
    private TaskSchedulerView? _windows;
    private ServerManagementView? _server;
    private string _tab = "scheduled";
    private int _scheduledVisit;

    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];

    /// <summary>No watched server for the server timers: the Dock's server panel opens to add one.</summary>
    public Action? ServerPanelRequested { get; set; }

    public TasksPanelView(ServersController servers, Func<WatchedServer?> selected)
    {
        _servers = servers;
        _selected = selected;
        foreach (var (tag, glyph, text) in new[]
        {
            ("scheduled", "", L.T("WECOMMANDER görevleri")),
            ("windows", "", L.T("Windows zamanlayıcıları")),
            ("server", "", L.T("Sunucu zamanlayıcıları")),
        })
        {
            var item = new SelectorBarItem { Text = text, Icon = new FontIcon { Glyph = glyph }, Tag = tag };
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(item, text);
            _items[tag] = item;
            _bar.Items.Add(item);
        }
        _bar.SelectionChanged += (_, _) =>
        {
            try
            {
                if (_bar.SelectedItem?.Tag is string tag && tag != _tab) { _tab = tag; ShowTab(); }
            }
            catch (Exception e) { App.LogCrash(e); }
        };
        var root = new Grid { RowSpacing = 4 };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _bar.Margin = new Thickness(8, 0, 8, 0);
        root.Children.Add(_bar);
        Grid.SetRow(_body, 1);
        root.Children.Add(_body);
        Content = root;
        _bar.SelectedItem = _items[_tab];
    }

    /// <summary>Opens on a tab ("scheduled", "windows", "server"); null: the one shown last.</summary>
    public void Select(string? tab)
    {
        if (tab is null || !_items.ContainsKey(tab) || tab == _tab) return;
        _tab = tab;
        _bar.SelectedItem = _items[tab];
        // Already on screen (opened from a quick panel tile): the tab changes now.
        if (XamlRoot?.IsHostVisible == true) Shown();
    }

    public void Shown()
    {
        try { ShowTab(); } catch (Exception e) { App.LogCrash(e); }
    }

    public void Hidden() => _server?.Stop();

    /// <summary>"Pencerede aç": the window of the tab shown.</summary>
    public void OpenInWindow()
    {
        switch (_tab)
        {
            case "windows": TaskSchedulerWindow.Open(); break;
            case "server":
                if (_selected() is { } s) App.Current.OpenServerManagement(s, "timers");
                else ServerPanelRequested?.Invoke();
                break;
            default: App.Current.ShowScheduledTasks(); break;
        }
    }

    private void ShowTab()
    {
        switch (_tab)
        {
            case "windows":
                if (_windows is null) _windows = new TaskSchedulerView(showTitle: false);
                _body.Content = _windows;
                _windows.Reload();
                break;
            case "server":
                ShowServerTimers();
                break;
            default:
                _ = ShowScheduled();
                break;
        }
    }

    private void ShowServerTimers()
    {
        var s = _selected();
        if (s?.MonitorId is not { } id)
        {
            var empty = new StackPanel { Spacing = 10, Margin = new Thickness(16) };
            empty.Children.Add(new TextBlock
            {
                Text = s is null ? L.T("İzlenen sunucu yok: Sunucularım panelinden bir sunucu ekle.") : L.F("{0}: bağlantı henüz kurulmadı; birkaç saniye sonra yeniden dene.", s.Label),
                TextWrapping = TextWrapping.Wrap,
                Foreground = Secondary,
            });
            if (s is null)
            {
                var add = new Button { Content = L.T("Sunucularım") };
                add.Click += (_, _) => { try { ServerPanelRequested?.Invoke(); } catch (Exception e) { App.LogCrash(e); } };
                empty.Children.Add(add);
            }
            _body.Content = empty;
            return;
        }
        if (_server is null || _server.SessionId != id)
        {
            _server?.Stop();
            _server = new ServerManagementView(_servers, id, s.Label);
        }
        _body.Content = _server;
        _server.GoTo("timers");
    }

    /// <summary>
    /// WECOMMANDER's own scheduled tasks: the list (name, schedule, next run);
    /// adding, changing and running them is done on the main window's page.
    /// </summary>
    private async Task ShowScheduled()
    {
        var visit = ++_scheduledVisit;
        var body = new StackPanel { Spacing = 8, Padding = new Thickness(16, 8, 16, 16) };
        var open = new Button { Content = L.T("Zamanlanmış görevler"), Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        ToolTipService.SetToolTip(open, L.T("Pencerede aç"));
        open.Click += (_, _) => { try { App.Current.ShowScheduledTasks(); } catch (Exception e) { App.LogCrash(e); } };
        body.Children.Add(new TextBlock
        {
            Text = L.T("WECOMMANDER bu görevleri zamanı gelince kendisi çalıştırır: cihazlarda ajan, kayıtlı SSH sunucularında bu uygulama (açık ve oturumu açık olmalı)."),
            TextWrapping = TextWrapping.Wrap,
            Foreground = Secondary,
        });
        _body.Content = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        if (App.Current.Credentials() is not { } creds)
        {
            body.Children.Add(new TextBlock { Text = L.T("Zamanlanmış görevleri görmek için oturum aç."), TextWrapping = TextWrapping.Wrap });
            return;
        }
        var ring = new ProgressRing { IsActive = true, Width = 24, Height = 24, HorizontalAlignment = HorizontalAlignment.Left };
        body.Children.Add(ring);
        List<ScheduledTask> tasks;
        try { tasks = await creds.Gateway.ScheduledTasksAsync(creds.Token); }
        catch (Exception e)
        {
            if (visit != _scheduledVisit) return;
            body.Children.Remove(ring);
            body.Children.Add(new TextBlock { Text = e is GatewayException { Status: 403 } ? L.T("Zamanlanmış görevleri yalnız sahip ve yöneticiler değiştirebilir; sen yalnız görüntüleyebilirsin.") : e.Message, TextWrapping = TextWrapping.Wrap });
            body.Children.Add(open);
            return;
        }
        if (visit != _scheduledVisit) return;
        body.Children.Remove(ring);
        if (tasks.Count == 0)
            body.Children.Add(new TextBlock { Text = L.T("Henüz zamanlanmış görev yok. Yedek, temizlik ya da rapor gibi düzenli işleri burada tanımla; zamanı gelince sunucu çalıştırır."), TextWrapping = TextWrapping.Wrap });
        foreach (var t in tasks)
        {
            var row = new StackPanel { Spacing = 2, Padding = new Thickness(12, 8, 12, 8), CornerRadius = new CornerRadius(6),
                Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"] };
            row.Children.Add(new TextBlock { Text = t.Name, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis });
            row.Children.Add(new TextBlock { Text = ScheduleText.Describe(t.Schedule), Foreground = Secondary, TextWrapping = TextWrapping.Wrap });
            row.Children.Add(new TextBlock
            {
                Text = !t.Enabled ? L.T("Kapalı: zamanında çalışmaz.")
                    : t.NextRunAt is { } next ? L.F("Sonraki çalışma: {0}", ScheduleText.LocalTime(next))
                    : L.T("Sonraki çalışma yok."),
                Foreground = Secondary,
                FontSize = 12,
            });
            body.Children.Add(row);
        }
        body.Children.Add(open);
    }
}
