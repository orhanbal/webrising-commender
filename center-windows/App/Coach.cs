using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
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
public sealed class Coach
{
    public static readonly Windows.UI.Color Green = Windows.UI.Color.FromArgb(255, 34, 197, 94);

    private readonly Panel _host;
    private TeachingTip? _tip;
    private Popup? _ring;
    private FrameworkElement? _target;
    private Storyboard? _story;

    /// <param name="host">A panel in the window's tree the tip is added to (it shows as a popup).</param>
    public Coach(Panel host) => _host = host;

    public bool IsShown => _tip is { IsOpen: true };

    /// <summary>
    /// Shows a step. <paramref name="target"/> null: the tip in the middle of the window, no ring.
    /// <paramref name="primary"/>: the step's own button (null: none); "Atla" is always there.
    /// </summary>
    public void Show(FrameworkElement? target, string title, string text, string? primary, Action? onPrimary, Action onSkip, Action onOff)
    {
        Hide();
        var tip = new TeachingTip
        {
            Title = title,
            Subtitle = text,
            IsLightDismissEnabled = false,
            PreferredPlacement = TeachingTipPlacementMode.Auto,
            CloseButtonContent = L.T("Atla"),
        };
        if (primary is not null)
        {
            tip.ActionButtonContent = primary;
            tip.ActionButtonStyle = (Style)Application.Current.Resources["AccentButtonStyle"];
            tip.ActionButtonClick += (_, _) => Run(() => { Hide(); onPrimary?.Invoke(); });
        }
        // The X and "Atla" both move on; closing for good is the right-click menu (or Settings).
        tip.CloseButtonClick += (_, _) => Run(() => { Hide(); onSkip(); });
        var off = new MenuFlyoutItem { Text = L.T("Öğreticiyi kapat") };
        off.Click += (_, _) => Run(() => { Hide(); onOff(); });
        var menu = new MenuFlyout();
        menu.Items.Add(off);
        tip.ContextFlyout = menu;
        tip.HeroContentPlacement = TeachingTipHeroContentPlacementMode.Auto;
        if (target is not null) tip.Target = target;
        _host.Children.Add(tip);
        _tip = tip;
        tip.IsOpen = true;
        App.DebugLayout($"tutorial: tip '{title}' open={tip.IsOpen} target={(target is null ? "none" : target.GetType().Name)}");
        if (target is not null) Ring(target);
    }

    /// <summary>Only the ring (the tip is shown elsewhere): the Dock's meters.</summary>
    public void RingOnly(FrameworkElement target)
    {
        Hide();
        Ring(target);
    }

    public void Hide()
    {
        try
        {
            if (_tip is { } tip)
            {
                tip.IsOpen = false;
                _host.Children.Remove(tip);
            }
            _story?.Stop();
            if (_ring is { } ring) ring.IsOpen = false;
            if (_target is { } t) { t.LayoutUpdated -= Follow; t.Unloaded -= TargetGone; }
        }
        catch (Exception e) { App.LogCrash(e); }
        _tip = null;
        _ring = null;
        _target = null;
        _story = null;
    }

    private void Ring(FrameworkElement target)
    {
        if (target.XamlRoot is null) return;
        var still = new Border { BorderBrush = new SolidColorBrush(Green), BorderThickness = new Thickness(2), CornerRadius = new CornerRadius(8) };
        var wave = new Border
        {
            BorderBrush = new SolidColorBrush(Green), BorderThickness = new Thickness(3), CornerRadius = new CornerRadius(8),
            RenderTransformOrigin = new Windows.Foundation.Point(0.5, 0.5),
        };
        var scale = new ScaleTransform { ScaleX = 1, ScaleY = 1 };
        wave.RenderTransform = scale;
        var grid = new Grid { IsHitTestVisible = false };
        grid.Children.Add(wave);
        grid.Children.Add(still);
        Popup popup;
        try
        {
            popup = new Popup { Child = grid, XamlRoot = target.XamlRoot, IsHitTestVisible = false };
            _ring = popup;
            _target = target;
            Place();
            popup.IsOpen = true;
            target.LayoutUpdated += Follow;
            target.Unloaded += TargetGone;
        }
        catch (Exception e) { App.DebugLayout($"tutorial: ring not shown ({e.GetType().Name}: {e.Message})"); return; }

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
    }

    private void Place()
    {
        if (_ring is not { } ring || _target is not { } t || t.XamlRoot is null) return;
        try
        {
            var at = t.TransformToVisual(null).TransformPoint(new Windows.Foundation.Point(0, 0));
            const double pad = 4;
            ring.HorizontalOffset = at.X - pad;
            ring.VerticalOffset = at.Y - pad;
            if (ring.Child is FrameworkElement child)
            {
                child.Width = Math.Max(8, t.ActualWidth + pad * 2);
                child.Height = Math.Max(8, t.ActualHeight + pad * 2);
            }
            ring.Visibility = t.Visibility;
        }
        catch (Exception) { /* the target left the tree: TargetGone hides it */ }
    }

    private void Follow(object? sender, object e) => Place();

    private void TargetGone(object sender, RoutedEventArgs e)
    {
        _story?.Stop();
        if (_ring is { } ring) ring.IsOpen = false;
    }

    private static void Run(Action a)
    {
        try { a(); } catch (Exception e) { App.LogCrash(e); }
    }
}
