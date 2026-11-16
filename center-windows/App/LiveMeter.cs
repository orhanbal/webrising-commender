using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Shapes;

namespace Wecommander.Center;

/// <summary>
/// One live meter (CPU, RAM or Disk) as on the server box: the value, a bar,
/// and the line chart that flows in from the right, green / amber / red by
/// level. The server box and the Dock use the same one, so they look and
/// move the same.
/// </summary>
public sealed class LiveMeter
{
    public const int ChartPoints = 20; // a minute at one sample every 3 s

    private readonly double _width, _height;
    private readonly TextBlock _text = new() { FontSize = 11 };
    private readonly ColumnDefinition _fill = new() { Width = new GridLength(0, GridUnitType.Star) };
    private readonly ColumnDefinition _empty = new() { Width = new GridLength(100, GridUnitType.Star) };
    private readonly Rectangle _bar = new() { RadiusX = 2, RadiusY = 2 };
    private readonly Grid _track;
    private readonly Canvas _chart;
    private readonly Polyline _line = new() { StrokeThickness = 1.6, StrokeLineJoin = PenLineJoin.Round };
    private readonly Polygon _area = new() { Opacity = 0.18 };
    private readonly Ellipse _dot = new() { Width = 5, Height = 5 };
    private readonly TranslateTransform _shift = new();

    public string Name { get; }
    public StackPanel Root { get; } = new();

    public LiveMeter(string name, double width = 90, double height = 26, double fontSize = 11)
    {
        Name = name;
        _width = width;
        _height = height;
        _text.FontSize = fontSize;
        _track = new Grid
        {
            Height = 4, Width = width, Margin = new Thickness(0, 3, 0, 0), CornerRadius = new CornerRadius(2),
            Background = new SolidColorBrush(ColorHelper.FromArgb(60, 128, 128, 128)),
        };
        _track.ColumnDefinitions.Add(_fill);
        _track.ColumnDefinitions.Add(_empty);
        _track.Children.Add(_bar);
        _chart = new Canvas { Width = width, Height = height, Margin = new Thickness(0, 2, 0, 0) };
        _chart.Clip = new RectangleGeometry { Rect = new Windows.Foundation.Rect(0, 0, width, height) };
        // One transform on a layer holding both shapes (a transform cannot be shared between elements).
        var layer = new Canvas { Width = width, Height = height, RenderTransform = _shift };
        layer.Children.Add(_area);
        layer.Children.Add(_line);
        layer.Children.Add(_dot);
        _chart.Children.Add(layer);
        Root.Children.Add(_text);
        Root.Children.Add(_track);
        Root.Children.Add(_chart);
    }

    public static Windows.UI.Color Level(double percent) =>
        percent >= 90 ? ColorHelper.FromArgb(255, 0xEF, 0x44, 0x44)
        : percent >= 80 ? ColorHelper.FromArgb(255, 0xF5, 0x9E, 0x0B)
        : ColorHelper.FromArgb(255, 0x10, 0xB9, 0x81);

    /// <summary>Line chart (true) or bar (false).</summary>
    public void SetLine(bool line)
    {
        _track.Visibility = line ? Visibility.Collapsed : Visibility.Visible;
        _chart.Visibility = line ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>The value now (null: no numbers yet), and the history to draw; <paramref name="fresh"/>: a new sample arrived, slide it in.</summary>
    public void Show(double? value, IReadOnlyList<double> points, bool fresh, bool animate)
    {
        var live = value is not null;
        var v = live ? Math.Clamp(value!.Value, 0, 100) : 0;
        var c = live ? Level(v) : Colors.Gray;
        _text.Text = live ? $"{Name} %{v:0}" : $"{Name} –";
        _fill.Width = new GridLength(v, GridUnitType.Star);
        _empty.Width = new GridLength(100 - v, GridUnitType.Star);
        _bar.Fill = new SolidColorBrush(c);
        Draw(points, fresh && animate);
    }

    private void Draw(IReadOnlyList<double> points, bool slide)
    {
        var step = _width / (ChartPoints - 1);
        var line = new PointCollection();
        var area = new PointCollection();
        // The newest point sits at the right edge; older ones to its left.
        var start = _width - (points.Count - 1) * step;
        // Scaled to the recent range (at least 8 points tall), not 0–100:
        // values that move by a few percent showed as a flat line.
        var lo = points.Count > 0 ? points.Min() : 0;
        var hi = points.Count > 0 ? points.Max() : 100;
        var span = Math.Max(8, hi - lo);
        var mid = (hi + lo) / 2;
        lo = Math.Clamp(mid - span / 2 - 2, 0, 100);
        hi = Math.Clamp(lo + span + 4, 0, 100);
        if (hi - lo < span) lo = Math.Max(0, hi - span - 4);
        double Y(double v) => _height - 3 - (v - lo) / Math.Max(1, hi - lo) * (_height - 6);
        for (var k = 0; k < points.Count; k++)
        {
            var p = new Windows.Foundation.Point(start + k * step, Y(points[k]));
            line.Add(p);
            area.Add(p);
        }
        if (points.Count > 0)
        {
            Canvas.SetLeft(_dot, _width - 2.5);
            Canvas.SetTop(_dot, Y(points[^1]) - 2.5);
            area.Add(new Windows.Foundation.Point(_width, _height));
            area.Add(new Windows.Foundation.Point(start, _height));
        }
        var color = points.Count > 0 ? Level(points[^1]) : Colors.Gray;
        _line.Points = line;
        _line.Stroke = new SolidColorBrush(color);
        _area.Points = area;
        _area.Fill = new SolidColorBrush(color);
        _dot.Fill = new SolidColorBrush(color);
        _dot.Visibility = points.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (slide && points.Count > 1)
        {
            // Flows all the time: the chart moves one step left steadily over the
            // 3 s until the next sample (not a short jump and then a stop).
            var anim = new DoubleAnimation { From = step, To = 0, Duration = TimeSpan.FromMilliseconds(2900) };
            Storyboard.SetTarget(anim, _shift);
            Storyboard.SetTargetProperty(anim, "X");
            var story = new Storyboard();
            story.Children.Add(anim);
            story.Begin();
        }
    }
}

/// <summary>The last minute of CPU / RAM / Disk per watched server, one point per new sample (shared by the server box and the Dock).</summary>
public sealed class MeterHistory
{
    private readonly Dictionary<string, List<double>[]> _history = [];
    private readonly Dictionary<string, int> _seen = [];

    /// <summary>Adds the server's newest sample once; returns its three histories and whether a new point was added.</summary>
    public (List<double>[] Points, bool Fresh) Take(WatchedServer s)
    {
        if (!_history.TryGetValue(s.HostId, out var history))
            _history[s.HostId] = history = [new(), new(), new()];
        var fresh = s.Live && (!_seen.TryGetValue(s.HostId, out var seen) || seen != s.Samples);
        if (fresh)
        {
            _seen[s.HostId] = s.Samples;
            var values = new[] { s.Cpu, s.Mem, s.Disk };
            for (var i = 0; i < 3; i++)
            {
                history[i].Add(Math.Clamp(values[i], 0, 100));
                if (history[i].Count > LiveMeter.ChartPoints) history[i].RemoveAt(0);
            }
        }
        return (history, fresh);
    }
}
