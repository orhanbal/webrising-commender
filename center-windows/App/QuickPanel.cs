using System.Runtime.InteropServices;
using Microsoft.UI;
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
/// The Dock's quick panel: opens from the WECOMMANDER icon, away from the
/// Dock's edge, and closes when it loses the focus. Every tile only opens a
/// screen (servers, terminals, files, Task Manager, timers, disk, approvals,
/// settings); nothing risky runs from here.
/// </summary>
public sealed class QuickPanel : Window
{
    private readonly Grid _root = new();
    private readonly TranslateTransform _slide = new();
    private readonly TextBlock _server = new() { FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock _approvals = new() { FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis };
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
        _root.Padding = new Thickness(14, 12, 14, 14);
        _root.RowSpacing = 10;
        _root.KeyDown += (_, e) => { if (e.Key == Windows.System.VirtualKey.Escape) Hide(); };

        var head = new Grid { ColumnSpacing = 10 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.Children.Add(new Image
        {
            Source = new BitmapImage(new Uri(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.png"))),
            Width = 30, Height = 30, VerticalAlignment = VerticalAlignment.Center,
        });
        var title = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        title.Children.Add(new TextBlock { Text = "WECOMMANDER", FontSize = 16, FontWeight = FontWeights.SemiBold });
        _server.Foreground = Secondary;
        title.Children.Add(_server);
        Grid.SetColumn(title, 1);
        head.Children.Add(title);
        _root.Children.Add(head);

        var tiles = new Grid { ColumnSpacing = 8, RowSpacing = 8 };
        tiles.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        tiles.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var entries = new (string Glyph, string Text, Action Open, TextBlock? Detail)[]
        {
            ("", L.T("Sunucularım"), () => App.Current.ToggleMonitorPanelFromDock(_anchor, _side), null),
            ("", L.T("Terminaller"), () => App.Current.ShowTerminals(files: false), null),
            ("", L.T("Dosya yöneticisi"), () => App.Current.ShowTerminals(files: true), null),
            ("", L.T("Görev Yöneticisi"), () => TaskManagerWindow.Open(), null),
            ("", L.T("Zamanlayıcılar"), () => TaskSchedulerWindow.Open(), null),
            ("", L.T("Sunucu zamanlayıcıları"), () => OpenServer("timers"), null),
            ("", L.T("Disk ve temizlik"), () => OpenServer("disk"), null),
            ("", L.T("Bildirimler / Bekleyen onaylar"), () => App.Current.ShowApprovals(), _approvals),
            ("", L.T("Ayarlar"), () => App.Current.ShowDockSettings(), null),
        };
        for (var i = 0; i < entries.Length; i++)
        {
            var (glyph, text, open, detail) = entries[i];
            if (tiles.RowDefinitions.Count <= i / 2) tiles.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var tile = Tile(glyph, text, detail, open);
            Grid.SetRow(tile, i / 2);
            Grid.SetColumn(tile, i % 2);
            tiles.Children.Add(tile);
        }
        var scroll = new ScrollViewer { Content = tiles, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(scroll, 1);
        _root.Children.Add(scroll);

        var main = new Button { Content = L.T("WECOMMANDER'ı aç"), HorizontalAlignment = HorizontalAlignment.Stretch, Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        main.Click += (_, _) => { Hide(); App.Current.ShowServers(); };
        Grid.SetRow(main, 2);
        _root.Children.Add(main);
        Content = _root;
    }

    private Button Tile(string glyph, string text, TextBlock? detail, Action open)
    {
        var p = new StackPanel { Spacing = 6, HorizontalAlignment = HorizontalAlignment.Left };
        p.Children.Add(new FontIcon { Glyph = glyph, FontSize = 20, HorizontalAlignment = HorizontalAlignment.Left });
        p.Children.Add(new TextBlock { Text = text, FontSize = 13, TextWrapping = TextWrapping.Wrap });
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
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Padding = new Thickness(12, 10, 12, 10),
            MinHeight = 74,
        };
        ToolTipService.SetToolTip(button, text);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, text);
        button.Click += (_, _) =>
        {
            Hide();
            try { open(); } catch (Exception e) { App.LogCrash(e); App.Current.Toast(L.F("Açılamadı: {0}", e.Message)); }
        };
        return button;
    }

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
        Refresh();
        var display = DisplayArea.GetFromPoint(new PointInt32(anchor.X + anchor.Width / 2, anchor.Y + anchor.Height / 2), DisplayAreaFallback.Primary);
        var w = display.WorkArea;
        var work = new PixelRect(w.X, w.Y, w.Width, w.Height);
        var scale = GetDpiForWindow(WinRT.Interop.WindowNative.GetWindowHandle(this)) / 96.0;
        var rect = DockLayout.PanelAt(anchor, side, (int)Math.Round(380 * scale), (int)Math.Round(500 * scale), work, (int)Math.Round(8 * scale));
        AppWindow.MoveAndResize(new RectInt32(rect.X, rect.Y, rect.Width, rect.Height));
        App.DebugLayout($"quick panel: from dock at {rect.X},{rect.Y} {rect.Width}x{rect.Height} side={side}");
        Present(side == DockEdge.Bottom ? -30 : side == DockEdge.Top ? 30 : 0, side == DockEdge.Right ? -30 : side == DockEdge.Left ? 30 : 0);
    }

    public void Hide()
    {
        _hiddenAt = DateTime.UtcNow;
        AppWindow.Hide();
    }

    private void Refresh()
    {
        var s = _selected();
        _server.Text = s is null ? L.T("İzlenen sunucu yok") : L.F("Sunucu: {0}", s.Label);
        var pending = App.Current.Pending.Count;
        _approvals.Text = pending == 0 ? L.T("Bekleyen onay yok") : L.F("{0} onay bekliyor", pending);
        _approvals.Foreground = pending == 0 ? Secondary : new SolidColorBrush(ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44));
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
