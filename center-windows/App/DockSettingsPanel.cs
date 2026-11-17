using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>Settings → Dock: every choice is saved at once and applied to the Dock on screen.</summary>
public static class DockSettingsPanel
{
    public static StackPanel Build()
    {
        var s = App.Current.Settings;
        var body = new StackPanel { Spacing = 10 };
        body.Children.Add(new TextBlock { Text = "Dock", Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
        body.Children.Add(new TextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
            Text = L.T("Ekranın bir kenarında WECOMMANDER'a ait bir çubuk: canlı CPU, RAM ve disk; süreçler, terminal ve onaylara tek tıkla geçiş. Windows görev çubuğuna dokunmaz; kapatınca ekran alanı geri verilir."),
        });
        var details = new StackPanel { Spacing = 10 };
        var on = new ToggleSwitch { Header = L.T("Dock'u göster"), IsOn = s.Dock };
        void Save() { App.Current.SaveSettings(); App.Current.ApplyDock(); }
        on.Toggled += (_, _) => { details.Visibility = on.IsOn ? Visibility.Visible : Visibility.Collapsed; App.Current.SetDock(on.IsOn); };
        body.Children.Add(on);

        var modes = new[] { ("fixed", L.T("Sabit: kenarda durur, pencereler altına girmez")), ("autohide", L.T("Otomatik gizlenen: fare kenara gelince açılır")), ("floating", L.T("Yüzen: istediğin yere sürükle")) };
        var mode = Combo(L.T("Görünüm"), modes.Select(m => m.Item2), Array.FindIndex(modes, m => m.Item1 == s.DockModeName));
        var onTop = new CheckBox { Content = L.T("Her zaman üstte (yüzen)"), IsChecked = s.DockOnTop };
        void ModeChanged()
        {
            onTop.Visibility = s.DockModeName == "floating" ? Visibility.Visible : Visibility.Collapsed;
        }
        mode.SelectionChanged += (_, _) => { s.DockModeName = modes[Math.Max(0, mode.SelectedIndex)].Item1; ModeChanged(); Save(); };
        onTop.Click += (_, _) => { s.DockOnTop = onTop.IsChecked == true; Save(); };
        ModeChanged();

        var edges = new[] { ("top", L.T("Üst")), ("bottom", L.T("Alt")), ("left", L.T("Sol")), ("right", L.T("Sağ")) };
        var edge = Combo(L.T("Konum"), edges.Select(e => e.Item2), Array.FindIndex(edges, e => e.Item1 == s.DockEdgeName));
        edge.SelectionChanged += (_, _) => { s.DockEdgeName = edges[Math.Max(0, edge.SelectedIndex)].Item1; Save(); };

        var monitors = Monitors.All();
        var names = monitors.Select((m, i) => $"Ekran {i + 1}{(m.Primary ? " (ana)" : "")} · {m.Bounds.Width}×{m.Bounds.Height}").ToList();
        var current = monitors.FindIndex(m => m.Device == s.DockMonitor);
        if (current < 0) current = Math.Max(0, monitors.FindIndex(m => m.Primary));
        var screen = Combo(L.T("Ekran"), names, current);
        screen.SelectionChanged += (_, _) =>
        {
            if (screen.SelectedIndex < 0 || screen.SelectedIndex >= monitors.Count) return;
            s.DockMonitor = monitors[screen.SelectedIndex].Device;
            s.DockFloatX = null; s.DockFloatY = null;
            Save();
        };

        var size = Combo(L.T("Boyut"), ["Normal", L.T("Kompakt")], s.DockCompact ? 1 : 0);
        size.SelectionChanged += (_, _) => { s.DockCompact = size.SelectedIndex == 1; Save(); };

        var showDelay = Number(L.T("Açılma gecikmesi (ms, otomatik gizlenen)"), s.DockShowDelay, 0, 2000);
        showDelay.ValueChanged += (_, e) => { if (!double.IsNaN(e.NewValue)) { s.DockShowDelay = (int)e.NewValue; App.Current.SaveSettings(); } };
        var hideDelay = Number("Gizlenme gecikmesi (ms)", s.DockHideDelay, 0, 5000);
        hideDelay.ValueChanged += (_, e) => { if (!double.IsNaN(e.NewValue)) { s.DockHideDelay = (int)e.NewValue; App.Current.SaveSettings(); } };

        var fullscreen = new CheckBox { Content = L.T("Tam ekran uygulama ve oyunlarda gizle (kapalıysa arkaya geçer)"), IsChecked = s.DockHideFullscreen };
        fullscreen.Click += (_, _) => { s.DockHideFullscreen = fullscreen.IsChecked == true; App.Current.SaveSettings(); };

        var themes = new[] { ("system", L.T("Windows ile aynı")), ("dark", L.T("Koyu tema")), ("light", L.T("Açık tema")) };
        var theme = Combo(L.T("Tema"), themes.Select(t => t.Item2), Array.FindIndex(themes, t => t.Item1 == s.DockTheme));
        theme.SelectionChanged += (_, _) => { s.DockTheme = themes[Math.Max(0, theme.SelectedIndex)].Item1; Save(); };

        // The parts and their order: drag a row (or use the arrows), untick to hide. Saved and applied to the Dock at once.
        var modulesTitle = new TextBlock { Text = L.T("Gösterilecek bölümler ve sırası (sürükleyip bırak)"), Margin = new Thickness(0, 6, 0, 0) };
        var modulesList = new ListView
        {
            SelectionMode = ListViewSelectionMode.None,
            CanDragItems = true,
            CanReorderItems = true,
            AllowDrop = true,
            MaxWidth = 460,
            HorizontalAlignment = HorizontalAlignment.Left,
        };
        void SaveOrder(List<string> order)
        {
            s.DockModules = order;
            Save();
        }
        void RenderModules()
        {
            modulesList.Items.Clear();
            var order = DockLayout.Modules(s.DockModules, null);
            for (var i = 0; i < order.Count; i++)
            {
                var name = order[i];
                var index = i;
                var row = new Grid { ColumnSpacing = 6 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                var grip = new FontIcon { Glyph = "\uE76F", FontSize = 14, Opacity = 0.6, VerticalAlignment = VerticalAlignment.Center };
                ToolTipService.SetToolTip(grip, L.T("Sürükle: sırayı değiştir"));
                var check = new CheckBox { Content = ModuleName(name), IsChecked = !s.DockHiddenModules.Contains(name) };
                check.Click += (_, _) =>
                {
                    s.DockHiddenModules.Remove(name);
                    if (check.IsChecked != true) s.DockHiddenModules.Add(name);
                    Save();
                };
                var up = new Button { Content = new FontIcon { Glyph = "\uE70E", FontSize = 12 }, IsEnabled = index > 0 };
                ToolTipService.SetToolTip(up, L.T("Yukarı / sola"));
                var down = new Button { Content = new FontIcon { Glyph = "\uE70D", FontSize = 12 }, IsEnabled = index < order.Count - 1 };
                ToolTipService.SetToolTip(down, L.T("Aşağı / sağa"));
                up.Click += (_, _) => { SaveOrder(DockLayout.Move(order, index, index - 1)); RenderModules(); };
                down.Click += (_, _) => { SaveOrder(DockLayout.Move(order, index, index + 1)); RenderModules(); };
                Grid.SetColumn(check, 1);
                Grid.SetColumn(up, 2);
                Grid.SetColumn(down, 3);
                row.Children.Add(grip);
                row.Children.Add(check);
                row.Children.Add(up);
                row.Children.Add(down);
                modulesList.Items.Add(new ListViewItem { Content = row, Tag = name, HorizontalContentAlignment = HorizontalAlignment.Stretch });
            }
        }
        // After a drag the rows are already in their new place: read the order from them.
        modulesList.DragItemsCompleted += (_, e) =>
        {
            if (e.DropResult == Windows.ApplicationModel.DataTransfer.DataPackageOperation.None) return;
            var order = modulesList.Items.OfType<ListViewItem>().Select(i => i.Tag as string).OfType<string>().ToList();
            if (order.SequenceEqual(DockLayout.Modules(s.DockModules, null))) return;
            SaveOrder(DockLayout.Modules(order, null));
            // The arrows' enabled state follows the new places.
            modulesList.DispatcherQueue.TryEnqueue(RenderModules);
        };
        RenderModules();

        var startup = new CheckBox { Content = L.T("Windows ile başlat (oturum açınca WECOMMANDER ve Dock açılır)") };
        try { startup.IsChecked = LocalStore.AutostartEnabled; } catch (Exception) { startup.IsEnabled = false; }
        startup.Click += (_, _) => { try { LocalStore.AutostartEnabled = startup.IsChecked == true; } catch (Exception e) { App.LogCrash(e); } };

        foreach (var e in new UIElement[] { mode, onTop, edge, screen, size, showDelay, hideDelay, fullscreen, theme, modulesTitle, modulesList, startup })
            details.Children.Add(e);
        details.Visibility = s.Dock ? Visibility.Visible : Visibility.Collapsed;
        body.Children.Add(details);
        return body;
    }

    private static string ModuleName(string module) => module switch
    {
        "servers" => L.T("Sunucu ve canlı grafikler"),
        "processes" => L.T("Görev Yöneticisi kısayolu"),
        "timers" => L.T("Zamanlayıcılar kısayolu"),
        "terminal" => L.T("Terminal kısayolu"),
        "approvals" => L.T("Bildirimler ve onaylar"),
        _ => module,
    };

    private static ComboBox Combo(string header, IEnumerable<string> items, int selected) => new()
    {
        Header = header,
        ItemsSource = items.ToList(),
        SelectedIndex = Math.Max(0, selected),
        MinWidth = 320,
    };

    private static NumberBox Number(string header, int value, int min, int max) => new()
    {
        Header = header,
        Value = value,
        Minimum = min,
        Maximum = max,
        SmallChange = 50,
        SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Inline,
        Width = 260,
        HorizontalAlignment = HorizontalAlignment.Left,
    };
}
