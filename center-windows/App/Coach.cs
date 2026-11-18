using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// One tutorial step on screen: a teaching tip next to the control to use and
/// a green ring around that control that grows outward and fades, again and
/// again (a still ring when Windows animations are off). The ring never takes
/// clicks. Right-click on the tip: "Öğreticiyi kapat".
/// </summary>
/// <remarks>
/// The tip is a card of our own and the ring a plain border, both drawn in a
/// transparent layer (a <see cref="Canvas"/>) on top of the host panel: no
/// <see cref="TeachingTip"/> and no <see cref="Microsoft.UI.Xaml.Controls.Primitives.Popup"/>.
/// A TeachingTip made in code and opened in this unpackaged desktop window threw
/// "InvalidCastException: No such interface supported" from inside WinUI a few
/// milliseconds after opening (its own popup and open animation), out of the
/// app's reach. The layer is in the window's own tree, so it shares the
/// target's XamlRoot, follows layout and is seen by UI Automation; it lets
/// clicks through everywhere except on the card.
/// </remarks>
public sealed class Coach
{
    public static readonly Windows.UI.Color Green = Windows.UI.Color.FromArgb(255, 34, 197, 94);

    private const double Gap = 12;
    private const double Pad = 4;
    private const double CardWidth = 340;

    private readonly Panel _host;
    private Canvas? _layer;
    private Border? _card;
    private Grid? _ring;
    private FrameworkElement? _target;
    private Storyboard? _story;
    private bool _pulsing;

    /// <param name="host">A panel in the window's tree; the tip and ring are drawn in a layer on top of it.</param>
    public Coach(Panel host) => _host = host;

    public bool IsShown => _card is { Parent: Canvas layer } && ReferenceEquals(layer.Parent, _host);

    /// <summary>
    /// Shows a step. <paramref name="target"/> null: the tip in the middle of the window, no ring.
    /// <paramref name="primary"/>: the step's own button (null: none); "Atla" is always there.
    /// </summary>
    public void Show(FrameworkElement? target, string title, string text, string? primary, Action? onPrimary, Action onSkip, Action onOff)
    {
        Hide();
        var layer = Layer();
        var card = Card(title, text, primary,
            primary is null ? null : () => Run(() => { Hide(); onPrimary?.Invoke(); }),
            () => Run(() => { Hide(); onSkip(); }),
            () => Run(() => { Hide(); onOff(); }));
        _target = target;
        if (target is not null) Ring(target);
        _card = card;
        layer.Children.Add(card);
        Track();
        Place();
        App.DebugLayout($"tutorial: tip '{title}' open={IsShown} target={(target is null ? "none" : target.GetType().Name)}");
    }

    /// <summary>Only the ring (the tip is shown elsewhere): the Dock's meters.</summary>
    public void RingOnly(FrameworkElement target)
    {
        Hide();
        Layer();
        _target = target;
        Ring(target);
        Track();
        Place();
    }

    public void Hide()
    {
        try
        {
            _story?.Stop();
            if (_layer is { } layer)
            {
                layer.LayoutUpdated -= Follow;
                layer.Children.Clear();
            }
        }
        catch (Exception e) { App.LogCrash(e); }
        _card = null;
        _ring = null;
        _target = null;
        _story = null;
        _pulsing = false;
    }

    /// <summary>The transparent layer on top of the host (made again when the host was rebuilt, as the Dock's is).</summary>
    private Canvas Layer()
    {
        if (_layer is { } existing && ReferenceEquals(existing.Parent, _host)) return existing;
        // No background: clicks pass through the layer; only the card takes them.
        var layer = new Canvas { HorizontalAlignment = HorizontalAlignment.Stretch, VerticalAlignment = VerticalAlignment.Stretch };
        Canvas.SetZIndex(layer, 1000);
        // Over every row and column of a Grid host (spans past the last one are clamped).
        Grid.SetRowSpan(layer, 100);
        Grid.SetColumnSpan(layer, 100);
        _host.Children.Add(layer);
        _layer = layer;
        return layer;
    }

    private void Track()
    {
        if (_layer is { } layer) layer.LayoutUpdated += Follow;
    }

    private static Border Card(string title, string text, string? primary, Action? onPrimary, Action onSkip, Action onOff)
    {
        var heading = new TextBlock
        {
            Text = title,
            Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"],
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 28, 0),
        };
        var body = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 0, 0) };

        var skip = new Button { Content = L.T("Atla") };
        skip.Click += (_, _) => onSkip();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 14, 0, 0) };
        if (primary is not null)
        {
            var go = new Button { Content = primary, Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
            go.Click += (_, _) => onPrimary?.Invoke();
            buttons.Children.Add(go);
        }
        buttons.Children.Add(skip);

        // The X and "Atla" both move on; closing for good is the right-click menu (or Settings).
        var x = new Button
        {
            Content = Icons.Make(IconName.Close, size: 16),
            Padding = new Thickness(4),
            Background = new SolidColorBrush(Colors.Transparent),
            BorderThickness = new Thickness(0),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, -6, -8, 0),
        };
        AutomationProperties.SetName(x, L.T("Atla"));
        ToolTipService.SetToolTip(x, L.T("Atla"));
        x.Click += (_, _) => onSkip();

        var stack = new StackPanel();
        stack.Children.Add(heading);
        stack.Children.Add(body);
        stack.Children.Add(buttons);
        var content = new Grid();
        content.Children.Add(stack);
        content.Children.Add(x);

        var card = new Border
        {
            Width = CardWidth,
            Padding = new Thickness(16, 14, 16, 14),
            CornerRadius = new CornerRadius(8),
            BorderThickness = new Thickness(1.5),
            BorderBrush = new SolidColorBrush(Green),
            Background = Brush("SolidBackgroundFillColorBaseBrush") ?? Brush("ApplicationPageBackgroundThemeBrush"),
            Child = content,
            Opacity = 0,
        };
        AutomationProperties.SetName(card, title);
        var off = new MenuFlyoutItem { Text = L.T("Öğreticiyi kapat") };
        off.Click += (_, _) => onOff();
        var menu = new MenuFlyout();
        menu.Items.Add(off);
        card.ContextFlyout = menu;
        return card;
    }

    private static Brush? Brush(string key) =>
        Application.Current.Resources.TryGetValue(key, out var value) ? value as Brush : null;

    private void Ring(FrameworkElement target)
    {
        var still = new Border { BorderBrush = new SolidColorBrush(Green), BorderThickness = new Thickness(2), CornerRadius = new CornerRadius(8) };
        var wave = new Border
        {
            BorderBrush = new SolidColorBrush(Green), BorderThickness = new Thickness(3), CornerRadius = new CornerRadius(8),
            RenderTransformOrigin = new Windows.Foundation.Point(0.5, 0.5),
        };
        var scale = new ScaleTransform { ScaleX = 1, ScaleY = 1 };
        wave.RenderTransform = scale;
        var ring = new Grid { IsHitTestVisible = false, Visibility = Visibility.Collapsed };
        ring.Children.Add(wave);
        ring.Children.Add(still);
        _ring = ring;
        Layer().Children.Insert(0, ring);

        if (!AnimationsOn()) { wave.Opacity = 0; return; }
        try
        {
            Pulse(scale, wave);
        }
        catch (Exception e) { App.DebugLayout($"tutorial: ring still ({e.GetType().Name}: {e.Message})"); wave.Opacity = 0; }
    }

    /// <summary>Windows "Animation effects" (Settings → Accessibility → Visual effects); on when it cannot be read.</summary>
    private static bool AnimationsOn()
    {
        try { return new Windows.UI.ViewManagement.UISettings().AnimationsEnabled; }
        catch (Exception) { return true; }
    }

    private void Pulse(ScaleTransform scale, Border wave)
    {
        var story = new Storyboard { RepeatBehavior = RepeatBehavior.Forever };
        var duration = new Duration(TimeSpan.FromMilliseconds(1300));
        foreach (var property in new[] { "ScaleX", "ScaleY" })
        {
            var grow = new DoubleAnimation { From = 1, To = 1.22, Duration = duration, EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut } };
            Storyboard.SetTarget(grow, scale);
            Storyboard.SetTargetProperty(grow, property);
            story.Children.Add(grow);
        }
        var fade = new DoubleAnimation { From = 0.9, To = 0, Duration = duration };
        Storyboard.SetTarget(fade, wave);
        Storyboard.SetTargetProperty(fade, "Opacity");
        story.Children.Add(fade);
        _story = story;
        story.Begin();
        _pulsing = true;
    }

    /// <summary>Puts the ring around the target and the card next to it (or in the middle). Runs after every layout pass.</summary>
    private void Place()
    {
        if (_layer is not { } layer) return;
        try
        {
            var target = TargetRect(layer);
            if (_ring is { } ring)
            {
                if (target is { } r)
                {
                    Set(ring, r.X - Pad, r.Y - Pad);
                    SetSize(ring, Math.Max(8, r.Width + Pad * 2), Math.Max(8, r.Height + Pad * 2));
                    SetShown(ring, true);
                }
                else SetShown(ring, false);
                // No animation while the ring is away (its page is hidden, the target left the tree).
                if (_story is { } story && _pulsing != target.HasValue)
                {
                    if (target.HasValue) story.Resume(); else story.Pause();
                    _pulsing = target.HasValue;
                }
            }
            if (_card is { } card)
            {
                // A step that points at something waits (hidden) while that is off screen.
                if (_target is not null && target is null) { SetShown(card, false); return; }
                if (card.Visibility == Visibility.Collapsed)
                {
                    // Measured on the next pass, placed after it.
                    card.Opacity = 0;
                    SetShown(card, true);
                    return;
                }
                var w = card.ActualWidth;
                var h = card.ActualHeight;
                if (h <= 0) return; // not laid out yet: the next pass places it
                var at = target is { } t ? Beside(t, w, h, layer.ActualWidth, layer.ActualHeight)
                    : new Windows.Foundation.Point((layer.ActualWidth - w) / 2, (layer.ActualHeight - h) / 2);
                Set(card, Math.Max(0, at.X), Math.Max(0, at.Y));
                if (card.Opacity != 1) card.Opacity = 1;
            }
        }
        catch (Exception e) { App.DebugLayout($"tutorial: place ({e.GetType().Name}: {e.Message})"); }
    }

    /// <summary>The target's rectangle in the layer, or null when it is not on screen.</summary>
    private Windows.Foundation.Rect? TargetRect(Canvas layer)
    {
        if (_target is not { } t || !OnScreen(t) || layer.XamlRoot is null) return null;
        // Both against the window's root (works wherever the target sits in the window's tree).
        var a = t.TransformToVisual(null).TransformPoint(new Windows.Foundation.Point(0, 0));
        var b = layer.TransformToVisual(null).TransformPoint(new Windows.Foundation.Point(0, 0));
        return new Windows.Foundation.Rect(a.X - b.X, a.Y - b.Y, t.ActualWidth, t.ActualHeight);
    }

    private static bool OnScreen(FrameworkElement t)
    {
        if (t.XamlRoot is null || !t.IsLoaded || t.ActualWidth <= 0 || t.ActualHeight <= 0) return false;
        for (DependencyObject? e = t; e is not null; e = VisualTreeHelper.GetParent(e))
            if (e is UIElement { Visibility: Visibility.Collapsed }) return false;
        return true;
    }

    /// <summary>Below the target, else above, right or left (right first for something at the left edge, like the menu).</summary>
    private static Windows.Foundation.Point Beside(Windows.Foundation.Rect r, double w, double h, double width, double height)
    {
        double ClampX(double x) => Math.Clamp(x, Gap, Math.Max(Gap, width - w - Gap));
        double ClampY(double y) => Math.Clamp(y, Gap, Math.Max(Gap, height - h - Gap));
        var below = (Fits: r.Bottom + Gap + h <= height, At: new Windows.Foundation.Point(ClampX(r.X + r.Width / 2 - w / 2), r.Bottom + Gap));
        var above = (Fits: r.Top - Gap - h >= 0, At: new Windows.Foundation.Point(ClampX(r.X + r.Width / 2 - w / 2), r.Top - Gap - h));
        var right = (Fits: r.Right + Gap + w <= width, At: new Windows.Foundation.Point(r.Right + Gap, ClampY(r.Y + r.Height / 2 - h / 2)));
        var left = (Fits: r.Left - Gap - w >= 0, At: new Windows.Foundation.Point(r.Left - Gap - w, ClampY(r.Y + r.Height / 2 - h / 2)));
        var order = r.X + r.Width / 2 < width / 4 ? new[] { right, below, above, left } : new[] { below, above, right, left };
        foreach (var o in order) if (o.Fits) return o.At;
        return below.At with { Y = ClampY(below.At.Y) };
    }

    // Set only on change: placing runs on LayoutUpdated, and an unchanged value must not start another pass.
    private static void Set(UIElement e, double x, double y)
    {
        if (Math.Abs(Canvas.GetLeft(e) - x) > 0.5) Canvas.SetLeft(e, x);
        if (Math.Abs(Canvas.GetTop(e) - y) > 0.5) Canvas.SetTop(e, y);
    }

    private static void SetSize(FrameworkElement e, double w, double h)
    {
        if (double.IsNaN(e.Width) || Math.Abs(e.Width - w) > 0.5) e.Width = w;
        if (double.IsNaN(e.Height) || Math.Abs(e.Height - h) > 0.5) e.Height = h;
    }

    private static void SetShown(UIElement e, bool on)
    {
        var v = on ? Visibility.Visible : Visibility.Collapsed;
        if (e.Visibility != v) e.Visibility = v;
    }

    private void Follow(object? sender, object e) => Place();

    private static void Run(Action a)
    {
        try { a(); } catch (Exception e) { App.LogCrash(e); }
    }
}
