using System.Runtime.InteropServices;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;

namespace Wecommander.Center;

/// <summary>
/// "WECOMMANDER güncelleniyor": a small window in the middle of the screen,
/// on top, from the moment an update starts until the app quits for the
/// swap (the swap helper then shows its own window in the same place).
/// The update never runs unseen in a tab of the panel.
/// </summary>
public sealed class UpdateWindow : Window
{
    private readonly TextBlock _step = new() { TextTrimming = TextTrimming.CharacterEllipsis };
    private readonly TextBlock _percent = new() { HorizontalAlignment = HorizontalAlignment.Right };
    private readonly ProgressBar _bar = new() { Maximum = 100, IsIndeterminate = true };

    public UpdateWindow(int build)
    {
        Title = "WECOMMANDER güncelleniyor";
        SystemBackdrop = new DesktopAcrylicBackdrop();
        ExtendsContentIntoTitleBar = true;
        AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico"));
        if (AppWindow.Presenter is OverlappedPresenter p)
        {
            p.IsResizable = false;
            p.IsMaximizable = false;
            p.IsMinimizable = false;
            p.IsAlwaysOnTop = true;
            p.SetBorderAndTitleBar(true, false);
        }
        // Closing it would not stop the update; it closes by itself.
        AppWindow.Closing += (_, e) => { if (!_done) e.Cancel = true; };

        var title = new TextBlock { Text = $"WECOMMANDER 0.1.{build} kuruluyor", Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"] };
        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(_step);
        Grid.SetColumn(_percent, 1);
        row.Children.Add(_percent);
        var hint = new TextBlock
        {
            Text = "Bitince uygulama kendiliğinden yeniden açılır.",
            Style = (Style)Application.Current.Resources["CaptionTextBlockStyle"],
            Foreground = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"],
        };
        var body = new StackPanel { Spacing = 10, Padding = new Thickness(24, 20, 24, 20) };
        body.Children.Add(title);
        body.Children.Add(row);
        body.Children.Add(_bar);
        body.Children.Add(hint);
        Content = body;
    }

    private bool _done;

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    public void ShowCentered()
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var scale = GetDpiForWindow(hwnd) / 96.0;
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var width = (int)Math.Round(440 * scale);
        var height = (int)Math.Round(170 * scale);
        AppWindow.MoveAndResize(new RectInt32(area.X + (area.Width - width) / 2, area.Y + (area.Height - height) / 2, width, height));
        AppWindow.Show();
        Activate();
    }

    /// <summary>The step and how far it is (null: still measuring).</summary>
    public void Report(string step, double? percent)
    {
        _step.Text = step;
        _bar.IsIndeterminate = percent is null;
        if (percent is { } value)
        {
            _bar.Value = value;
            _percent.Text = $"%{(int)Math.Round(value)}";
        }
        else _percent.Text = "";
    }

    public void CloseNow()
    {
        _done = true;
        try { Close(); } catch (Exception) { }
    }
}
