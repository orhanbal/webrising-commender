using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;
using Point = Windows.Foundation.Point;

namespace Wecommander.Center;

/// <summary>
/// The app's icons: the Vuesax (Iconsax) set, Linear by default and Bold for a
/// selected / active state (the selected navigation item or tab, a toggled
/// button, a Dock button whose panel is open). The outlines come from
/// Core/IconData.g.cs (scripts/gen-icons.py); a <see cref="PathIcon"/> fills
/// them with the theme's foreground like a font glyph. Built in code from the
/// parsed commands (no XAML parsing, nothing reflected: trim / AOT safe).
/// </summary>
internal static class Icons
{
    /// <summary>What an icon made here is, kept in its Tag so its variant can be switched.</summary>
    private sealed record Info(IconName Name, double Size, bool Active);

    /// <summary>The icon <paramref name="name"/>, <paramref name="size"/> DIPs square (like a FontIcon's FontSize).
    /// Never throws: a geometry that cannot be built is logged and the icon stays empty.</summary>
    public static PathIcon Make(IconName name, bool active = false, double size = 16, Brush? foreground = null)
    {
        var icon = new PathIcon { Width = size, Height = size, Tag = new Info(name, size, active) };
        try { icon.Data = Geometry(name, active, size); }
        catch (Exception e) { App.LogCrash(e); }
        if (foreground is not null) icon.Foreground = foreground;
        return icon;
    }

    // No IconSource on purpose: a PathIconSource gives its one geometry to every
    // icon element made from it, and WinUI does not let two elements share a
    // geometry (the CI's terminal tab with a PathIconSource was never laid out:
    // the app went down). Put a Make() icon in the content instead.

    /// <summary>Linear or Bold for an icon made by <see cref="Make"/>; any other icon is left alone. Never throws.</summary>
    public static void SetActive(IconElement? icon, bool active)
    {
        try
        {
            if (icon is not PathIcon { Tag: Info info } path || info.Active == active) return;
            path.Data = Geometry(info.Name, active, info.Size);
            path.Tag = info with { Active = active };
        }
        catch (Exception e) { App.LogCrash(e); }
    }

    /// <summary>The selected item of <paramref name="nav"/> shows its Bold icon, the others Linear.</summary>
    public static void FollowSelection(NavigationView nav)
    {
        void Sync()
        {
            try
            {
                foreach (var item in nav.MenuItems.Concat(nav.FooterMenuItems).OfType<NavigationViewItem>())
                    SetActive(item.Icon, ReferenceEquals(item, nav.SelectedItem));
            }
            catch (Exception e) { App.LogCrash(e); }
        }
        nav.SelectionChanged += (_, _) => Sync();
        Sync();
    }

    /// <summary>The selected tab of <paramref name="bar"/> shows its Bold icon.</summary>
    public static void FollowSelection(SelectorBar bar)
    {
        void Sync()
        {
            try
            {
                foreach (var item in bar.Items)
                    SetActive(item.Icon, ReferenceEquals(item, bar.SelectedItem));
            }
            catch (Exception e) { App.LogCrash(e); }
        }
        bar.SelectionChanged += (_, _) => Sync();
        Sync();
    }

    /// <summary>A toggle button shows its Bold icon while it is on.</summary>
    public static void FollowChecked(AppBarToggleButton button)
    {
        void Sync() => SetActive(button.Icon, button.IsChecked == true);
        button.Checked += (_, _) => Sync();
        button.Unchecked += (_, _) => Sync();
        Sync();
    }

    /// <summary>A geometry of its own each time: WinUI does not share one between elements.</summary>
    private static PathGeometry Geometry(IconName name, bool active, double size)
    {
        var scale = size / IconPath.Box;
        var geometry = new PathGeometry { FillRule = FillRule.Nonzero };
        PathFigure? figure = null;
        Point P(double[] p, int i) => new(p[i] * scale, p[i + 1] * scale);
        foreach (var c in IconPath.Commands(name, active))
        {
            switch (c.Kind)
            {
                case 'M':
                    figure = new PathFigure { StartPoint = P(c.Points, 0), IsFilled = true, IsClosed = false };
                    geometry.Figures.Add(figure);
                    break;
                case 'L':
                    figure?.Segments.Add(new LineSegment { Point = P(c.Points, 0) });
                    break;
                case 'Q':
                    figure?.Segments.Add(new QuadraticBezierSegment { Point1 = P(c.Points, 0), Point2 = P(c.Points, 2) });
                    break;
                case 'C':
                    figure?.Segments.Add(new BezierSegment { Point1 = P(c.Points, 0), Point2 = P(c.Points, 2), Point3 = P(c.Points, 4) });
                    break;
                case 'Z':
                    if (figure is not null) figure.IsClosed = true;
                    break;
            }
        }
        return geometry;
    }
}
