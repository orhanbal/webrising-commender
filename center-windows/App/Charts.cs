using Microsoft.UI;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Windows.UI;

namespace Wecommander.Center;

/// <summary>Small native charts for the server screens (no chart library).</summary>
public static class Charts
{
    /// <summary>Distinct series colours that read on light and dark backgrounds.</summary>
    public static readonly Color[] Palette =
    [
        Color.FromArgb(255, 0x3B, 0x82, 0xF6), // blue
        Color.FromArgb(255, 0x10, 0xB9, 0x81), // green
        Color.FromArgb(255, 0xF5, 0x9E, 0x0B), // amber
        Color.FromArgb(255, 0x8B, 0x5C, 0xF6), // violet
        Color.FromArgb(255, 0xEC, 0x48, 0x99), // pink
        Color.FromArgb(255, 0x06, 0xB6, 0xD4), // cyan
        Color.FromArgb(255, 0xEF, 0x44, 0x44), // red
        Color.FromArgb(255, 0x84, 0xCC, 0x16), // lime
        Color.FromArgb(255, 0x94, 0xA3, 0xB8), // slate (others)
    ];

    public static readonly Color Ok = Color.FromArgb(255, 0x10, 0xB9, 0x81);
    public static readonly Color Warn = Color.FromArgb(255, 0xF5, 0x9E, 0x0B);
    public static readonly Color Bad = Color.FromArgb(255, 0xEF, 0x44, 0x44);
    public static readonly Color Accent = Palette[0];

    private static Brush Track => (Brush)Application.Current.Resources["ControlStrokeColorDefaultBrush"];
    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];

    /// <summary>Green below 80 %, amber to 90 %, red above.</summary>
    public static Color Level(double percent) => percent >= 90 ? Bad : percent >= 80 ? Warn : Ok;

    /// <summary>An arc from 12 o'clock, <paramref name="fraction"/> of the way round.</summary>
    private static Geometry Arc(double size, double thickness, double fromFraction, double fraction)
    {
        var r = (size - thickness) / 2;
        var c = size / 2;
        fraction = Math.Clamp(fraction, 0, 0.9999);
        Point At(double f) => new(c + r * Math.Sin(f * 2 * Math.PI), c - r * Math.Cos(f * 2 * Math.PI));
        var figure = new PathFigure { StartPoint = At(fromFraction), IsClosed = false };
        figure.Segments.Add(new ArcSegment
        {
            Point = At(fromFraction + fraction),
            Size = new Size(r, r),
            IsLargeArc = fraction > 0.5,
            SweepDirection = SweepDirection.Clockwise,
        });
        var g = new PathGeometry();
        g.Figures.Add(figure);
        return g;
    }

    /// <summary>A ring gauge: "%91" in the middle, a caption and detail under it.</summary>
    public static FrameworkElement Ring(double percent, string caption, string detail, double size = 128)
    {
        const double thickness = 12;
        var ring = new Grid { Width = size, Height = size, HorizontalAlignment = HorizontalAlignment.Center };
        ring.Children.Add(new Ellipse { Stroke = Track, StrokeThickness = thickness });
        if (percent > 0.2)
            ring.Children.Add(new Microsoft.UI.Xaml.Shapes.Path
            {
                Data = Arc(size, thickness, 0, percent / 100),
                Stroke = new SolidColorBrush(Level(percent)),
                StrokeThickness = thickness,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
            });
        ring.Children.Add(new TextBlock
        {
            Text = $"%{percent:0}",
            FontSize = size / 4.6,
            FontWeight = FontWeights.SemiBold,
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        });
        var p = new StackPanel { Spacing = 6, HorizontalAlignment = HorizontalAlignment.Center };
        p.Children.Add(ring);
        p.Children.Add(new TextBlock { Text = caption, FontWeight = FontWeights.SemiBold, HorizontalAlignment = HorizontalAlignment.Center });
        p.Children.Add(new TextBlock { Text = detail, Foreground = Secondary, FontSize = 12, HorizontalAlignment = HorizontalAlignment.Center, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap });
        return p;
    }

    /// <summary>A donut of <paramref name="parts"/> with a legend beside it.</summary>
    public static FrameworkElement Donut(IReadOnlyList<(string Label, double Value, string Text)> parts, string centre, double size = 200)
    {
        const double thickness = 30;
        var total = parts.Sum(p => p.Value);
        var donut = new Grid { Width = size, Height = size, VerticalAlignment = VerticalAlignment.Top };
        donut.Children.Add(new Ellipse { Stroke = Track, StrokeThickness = thickness });
        var at = 0.0;
        var legend = new StackPanel { Spacing = 6, VerticalAlignment = VerticalAlignment.Center };
        for (var i = 0; i < parts.Count; i++)
        {
            var color = i == parts.Count - 1 && parts[i].Label == "Diğer" ? Palette[^1] : Palette[i % (Palette.Length - 1)];
            var f = total <= 0 ? 0 : parts[i].Value / total;
            if (f > 0.002)
                donut.Children.Add(new Microsoft.UI.Xaml.Shapes.Path
                {
                    Data = Arc(size, thickness, at, Math.Max(0.002, f - 0.004)),
                    Stroke = new SolidColorBrush(color),
                    StrokeThickness = thickness,
                });
            at += f;
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            row.Children.Add(new Rectangle { Width = 12, Height = 12, RadiusX = 3, RadiusY = 3, Fill = new SolidColorBrush(color), VerticalAlignment = VerticalAlignment.Center });
            row.Children.Add(new TextBlock { Text = parts[i].Label, MaxWidth = 260, TextTrimming = TextTrimming.CharacterEllipsis });
            row.Children.Add(new TextBlock { Text = parts[i].Text, Foreground = Secondary });
            legend.Children.Add(row);
        }
        donut.Children.Add(new TextBlock { Text = centre, FontWeight = FontWeights.SemiBold, FontSize = 18, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap, MaxWidth = size - 2 * thickness - 8 });
        var g = new Grid { ColumnSpacing = 28 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(donut);
        Grid.SetColumn(legend, 1);
        g.Children.Add(legend);
        return g;
    }

    /// <summary>Horizontal bars: label, bar, value; the longest bar is the largest value.</summary>
    public static FrameworkElement Bars(IReadOnlyList<(string Label, double Value, string Text)> items, Color color, string? tooltipPrefix = null)
    {
        var max = items.Count == 0 ? 1 : Math.Max(items.Max(i => i.Value), 1e-9);
        var g = new Grid { ColumnSpacing = 10, RowSpacing = 6 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(80) });
        for (var i = 0; i < items.Count; i++)
        {
            g.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            var label = new TextBlock { Text = items[i].Label, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
            if (tooltipPrefix is not null) ToolTipService.SetToolTip(label, tooltipPrefix + items[i].Label);
            Grid.SetRow(label, i);
            g.Children.Add(label);
            var track = new Grid { Height = 14, VerticalAlignment = VerticalAlignment.Center };
            track.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(items[i].Value / max, 0.004), GridUnitType.Star) });
            track.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(1 - items[i].Value / max, 0.0001), GridUnitType.Star) });
            track.Children.Add(new Rectangle { Fill = new SolidColorBrush(color), RadiusX = 4, RadiusY = 4 });
            Grid.SetRow(track, i); Grid.SetColumn(track, 1);
            g.Children.Add(track);
            var value = new TextBlock { Text = items[i].Text, Foreground = Secondary, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetRow(value, i); Grid.SetColumn(value, 2);
            g.Children.Add(value);
        }
        return g;
    }

    /// <summary>A stacked horizontal bar: each part's share of <paramref name="whole"/>.</summary>
    public static FrameworkElement Stack(IReadOnlyList<(double Value, Color Color, string Tip)> parts, double whole, double height = 22)
    {
        var g = new Grid { Height = height, CornerRadius = new CornerRadius(6), Background = Track };
        var used = 0.0;
        var col = 0;
        foreach (var (value, color, tip) in parts)
        {
            if (value <= 0 || whole <= 0) continue;
            var f = Math.Min(value / whole, 1 - used);
            if (f <= 0) break;
            used += f;
            g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(f, GridUnitType.Star) });
            var r = new Rectangle { Fill = new SolidColorBrush(color) };
            ToolTipService.SetToolTip(r, tip);
            Grid.SetColumn(r, col++);
            g.Children.Add(r);
        }
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(Math.Max(1 - used, 0.0001), GridUnitType.Star) });
        return g;
    }
}

/// <summary>
/// A live column chart: one vertical bar per sample, newest on the right,
/// with a title, the current value and a scale. <see cref="Push"/> adds one.
/// </summary>
public sealed class ColumnChart
{
    private readonly Grid _bars = new() { Height = 96, ColumnSpacing = 2 };
    private readonly TextBlock _value = new() { FontSize = 22, FontWeight = FontWeights.SemiBold };
    private readonly TextBlock _detail = new() { FontSize = 12 };
    private readonly TextBlock _scale = new() { FontSize = 11 };
    private readonly List<double> _values = [];
    private readonly int _capacity;
    private readonly Func<double, string> _format;
    private readonly double? _fixedMax;
    private readonly Color _color;

    public FrameworkElement Root { get; }

    public ColumnChart(string title, Color color, Func<double, string> format, double? fixedMax = null, int capacity = 45)
    {
        _capacity = capacity;
        _format = format;
        _fixedMax = fixedMax;
        _color = color;
        var secondary = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];
        _detail.Foreground = secondary;
        _scale.Foreground = secondary;
        for (var i = 0; i < capacity; i++)
        {
            _bars.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var r = new Rectangle { VerticalAlignment = VerticalAlignment.Bottom, Height = 0, RadiusX = 2, RadiusY = 2, Fill = new SolidColorBrush(color) };
            Grid.SetColumn(r, i);
            _bars.Children.Add(r);
        }
        var p = new StackPanel { Spacing = 6 };
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        Grid.SetColumn(_scale, 1);
        head.Children.Add(_scale);
        p.Children.Add(head);
        var now = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
        now.Children.Add(_value);
        _detail.VerticalAlignment = VerticalAlignment.Bottom;
        _detail.Margin = new Thickness(0, 0, 0, 4);
        now.Children.Add(_detail);
        p.Children.Add(now);
        var frame = new Border { Child = _bars, BorderBrush = (Brush)Application.Current.Resources["ControlStrokeColorDefaultBrush"], BorderThickness = new Thickness(0, 0, 0, 1), Padding = new Thickness(0, 4, 0, 0) };
        p.Children.Add(frame);
        _value.Text = "…";
        Root = p;
    }

    public void Push(double value, string detail = "")
    {
        _values.Add(Math.Max(0, value));
        if (_values.Count > _capacity) _values.RemoveAt(0);
        var max = _fixedMax ?? Math.Max(_values.Max() * 1.15, 1e-9);
        var offset = _capacity - _values.Count;
        for (var i = 0; i < _capacity; i++)
        {
            var r = (Rectangle)_bars.Children[i];
            var j = i - offset;
            var v = j >= 0 ? _values[j] : 0;
            r.Height = j >= 0 ? Math.Max(2, v / max * _bars.Height) : 0;
            r.Opacity = j == _values.Count - 1 ? 1 : 0.55;
            if (_fixedMax is not null) r.Fill = new SolidColorBrush(v >= 90 ? Charts.Bad : v >= 80 ? Charts.Warn : _color);
        }
        _value.Text = _format(value);
        _detail.Text = detail;
        _scale.Text = "üst: " + _format(max);
    }
}
