using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Wecommander.Center.Core;
using Windows.Graphics;

namespace Wecommander.Center;

/// <summary>
/// A drop-down panel opened from a Dock button (dock mode), like the Windows
/// Start menu and the Dock's quick panel: it opens next to the button, away
/// from the Dock's edge, inside the work area, in the taskbar's material; it
/// closes on a click outside, on Esc, on its close button and on a second
/// click of the same button. Its header names it and has "Pencerede aç",
/// which opens the same content in its own window and closes the panel.
/// </summary>
public sealed class DockPanel : Window
{
    private readonly Grid _root = new();
    private readonly ContentControl _body = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private readonly TextBlock _title = new() { FontWeight = FontWeights.SemiBold, FontSize = 14, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TranslateTransform _slide = new();
    private readonly Button _openWindow;
    private readonly Func<PixelRect, (int Width, int Height)> _sizeDip;
    private readonly bool _resizable;
    private (int Width, int Height)? _resized;
    private DateTime _hiddenAt, _shownAt;
    private bool _placing;

    /// <summary>The kind ("taskmanager", "tasks", …): App keeps one panel per kind.</summary>
    public string Kind { get; }
    /// <summary>"Pencerede aç": the same content in its own window.</summary>
    public Action? OpenInWindow { get; set; }
    /// <summary>Shown (start reading) and hidden (stop) for the content.</summary>
    public Action? Shown { get; set; }
    public Action? Hidden { get; set; }
    /// <summary>The content takes the keyboard itself when shown (the terminal); otherwise the header's first button has it.</summary>
    public bool FocusContent { get; set; }
    /// <summary>Set while the content needs the panel to stay open (a dialog of its own is open).</summary>
    public Func<bool>? KeepOpen { get; set; }

    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);

    /// <param name="sizeDip">The panel's size in 96-dpi pixels for a work area (also in 96-dpi pixels).</param>
    public DockPanel(string kind, string title, Func<PixelRect, (int Width, int Height)> sizeDip, bool resizable = false)
    {
        Kind = kind;
        _sizeDip = sizeDip;
        _resizable = resizable;
        Title = "WECOMMANDER " + title;
        SystemBackdrop = new TaskbarBackdrop();
        AppWindow.IsShownInSwitchers = false;
        ExtendsContentIntoTitleBar = false;
        try { AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico")); } catch (Exception) { }
        if (AppWindow.Presenter is OverlappedPresenter p)
        {
            p.IsResizable = resizable;
            p.IsMaximizable = false;
            p.IsMinimizable = false;
            p.IsAlwaysOnTop = true;
            p.SetBorderAndTitleBar(true, false);
        }
        AppWindow.Closing += (_, e) => { e.Cancel = true; Hide(); };
        Closed += (_, _) => _retired = true;
        // The person resized it (the terminal): that size is kept while the app runs.
        AppWindow.Changed += (_, e) =>
        {
            if (!_resizable || _placing || !e.DidSizeChange || !AppWindow.IsVisible) return;
            var scale = Scale;
            _resized = ((int)Math.Round(AppWindow.Size.Width / scale), (int)Math.Round(AppWindow.Size.Height / scale));
        };
        Activated += (_, e) =>
        {
            try
            {
                if (_retired || e.WindowActivationState != WindowActivationState.Deactivated || !AppWindow.IsVisible) return;
                if (KeepOpen?.Invoke() == true) return;
                // The click that opened it can activate the Dock a moment later: take the focus back.
                if (DateTime.UtcNow - _shownAt < TimeSpan.FromMilliseconds(800))
                {
                    DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, () => { try { if (!_retired && AppWindow.IsVisible) Activate(); } catch (Exception) { } });
                    return;
                }
                Hide();
            }
            catch (Exception ex) { App.LogCrash(ex); }
        };

        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _root.RenderTransform = _slide;
        AutomationProperties.SetName(_root, title);
        // Esc closes it from anywhere inside, unless a control used it (closing its own drop-down).
        // A terminal keeps Esc for the server (vim, less): its page gets the keys, not this.
        _root.KeyDown += (_, e) =>
        {
            if (e.Key != Windows.System.VirtualKey.Escape) return;
            Hide();
            e.Handled = true;
        };

        var header = new Grid { Padding = new Thickness(14, 8, 6, 6), ColumnSpacing = 4 };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _title.Text = title;
        AutomationProperties.SetHeadingLevel(_title, Microsoft.UI.Xaml.Automation.Peers.AutomationHeadingLevel.Level1);
        header.Children.Add(_title);

        var openRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
        openRow.Children.Add(Icons.Make(IconName.OpenWindow, size: 13));
        openRow.Children.Add(new TextBlock { Text = L.T("Pencerede aç"), FontSize = 12, VerticalAlignment = VerticalAlignment.Center });
        _openWindow = new Button { Content = openRow, Padding = new Thickness(8, 4, 8, 4), Background = new SolidColorBrush(Colors.Transparent), BorderThickness = new Thickness(0) };
        ToolTipService.SetToolTip(_openWindow, L.T("Pencerede aç"));
        AutomationProperties.SetName(_openWindow, L.T("Pencerede aç"));
        _openWindow.Click += (_, _) =>
        {
            Hide();
            try { OpenInWindow?.Invoke(); }
            catch (Exception ex) { App.LogCrash(ex); App.Current.Toast(L.F("Açılamadı: {0}", ex.Message)); }
        };
        Grid.SetColumn(_openWindow, 1);
        header.Children.Add(_openWindow);

        var close = new Button { Content = Icons.Make(IconName.Close, size: 12), Width = 32, Height = 32, Padding = new Thickness(0),
            Background = new SolidColorBrush(Colors.Transparent), BorderThickness = new Thickness(0) };
        ToolTipService.SetToolTip(close, L.T("Kapat"));
        AutomationProperties.SetName(close, L.T("Kapat"));
        close.Click += (_, _) => Hide();
        Grid.SetColumn(close, 2);
        header.Children.Add(close);
        _root.Children.Add(header);

        Grid.SetRow(_body, 1);
        _root.Children.Add(_body);
        Content = _root;
    }

    /// <summary>The content under the header.</summary>
    public UIElement? Body
    {
        get => _body.Content as UIElement;
        set => _body.Content = value;
    }

    /// <summary>The header's title (e.g. the server's name in it).</summary>
    public string Heading
    {
        set
        {
            _title.Text = value;
            AutomationProperties.SetName(_root, value);
        }
    }

    public bool IsOpen => AppWindow.IsVisible;

    private double Scale
    {
        get
        {
            try { return Math.Max(1, GetDpiForWindow(WinRT.Interop.WindowNative.GetWindowHandle(this))) / 96.0; }
            catch (Exception) { return 1; }
        }
    }

    /// <summary>
    /// From a Dock button: opens next to it toward <paramref name="side"/>; when
    /// open, a second click of the button closes it (<paramref name="toggle"/>).
    /// </summary>
    public void Open(PixelRect anchor, DockEdge side, bool toggle)
    {
        if (AppWindow.IsVisible)
        {
            if (toggle) { Hide(); return; }
        }
        // The click on the Dock button that just closed it (it lost the focus) does not open it again.
        else if (toggle && DateTime.UtcNow - _hiddenAt <= TimeSpan.FromMilliseconds(400)) return;
        var display = DisplayArea.GetFromPoint(new PointInt32(anchor.X + anchor.Width / 2, anchor.Y + anchor.Height / 2), DisplayAreaFallback.Primary);
        var w = display.WorkArea;
        var work = new PixelRect(w.X, w.Y, w.Width, w.Height);
        var scale = Scale;
        var (widthDip, heightDip) = _resized ?? _sizeDip(new PixelRect(0, 0, (int)Math.Round(work.Width / scale), (int)Math.Round(work.Height / scale)));
        var rect = DockLayout.PanelAt(anchor, side, (int)Math.Round(widthDip * scale), (int)Math.Round(heightDip * scale), work, (int)Math.Round(8 * scale));
        _placing = true;
        try { AppWindow.MoveAndResize(new RectInt32(rect.X, rect.Y, rect.Width, rect.Height)); }
        finally { _placing = false; }
        App.DebugLayout($"dock panel {Kind}: at {rect.X},{rect.Y} {rect.Width}x{rect.Height} side={side}");
        var wasOpen = AppWindow.IsVisible;
        _shownAt = DateTime.UtcNow;
        AppWindow.Show();
        Activate();
        if (!wasOpen)
        {
            Animate(side == DockEdge.Bottom ? -30 : side == DockEdge.Top ? 30 : 0, side == DockEdge.Right ? -30 : side == DockEdge.Left ? 30 : 0);
            try { Shown?.Invoke(); } catch (Exception e) { App.LogCrash(e); }
            App.Current.DockPanelOpenChanged(Kind, true);
        }
        // The keyboard starts in the panel: on "Pencerede aç" (Tab goes on into the content, Esc closes it).
        if (!FocusContent)
            DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, () =>
            {
                try { if (AppWindow.IsVisible) _openWindow.Focus(FocusState.Programmatic); }
                catch (Exception) { }
            });
    }

    /// <summary>
    /// The language changed (or the panel is rebuilt): hidden and left alone, never Close()d.
    /// Closing it let its own deactivation handler touch a destroyed window, and
    /// Microsoft.UI.Windowing ends the whole app for that (no exception to catch).
    /// </summary>
    public void Retire()
    {
        _retired = true;
        try { if (AppWindow.IsVisible) AppWindow.Hide(); } catch (Exception) { }
    }

    private bool _retired;

    public void Hide()
    {
        if (_retired || !AppWindow.IsVisible) return;
        _hiddenAt = DateTime.UtcNow;
        AppWindow.Hide();
        App.DebugLayout($"dock panel {Kind}: closed");
        App.Current.DockPanelOpenChanged(Kind, false);
        try { Hidden?.Invoke(); } catch (Exception e) { App.LogCrash(e); }
    }

    private void Animate(double fromY, double fromX)
    {
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
