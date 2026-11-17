using System.Runtime.InteropServices;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;
using Windows.Graphics;

namespace Wecommander.Center;

/// <summary>
/// "Yenilikler": a small window in the middle of the screen with the release
/// notes (ReleaseNotes, shipped in the app). Shown once after an update and
/// whenever the person asks for it (settings page, tray menu). It stands on
/// its own, so it works in Dock mode and Classic mode, with or without the
/// main window.
/// </summary>
public sealed class WhatsNewWindow : Window
{
    private static WhatsNewWindow? _open;

    /// <summary>Shows <paramref name="notes"/> (newest first); <paramref name="closed"/> runs once when it closes.</summary>
    public static void Show(IReadOnlyList<ReleaseNote> notes, Action? closed = null)
    {
        try
        {
            _open?.Close();
        }
        catch (Exception) { }
        var window = new WhatsNewWindow(notes);
        window.Closed += (_, _) =>
        {
            if (_open == window) _open = null;
            try { closed?.Invoke(); } catch (Exception e) { App.LogCrash(e); }
        };
        _open = window;
        window.ShowCentered();
    }

    private WhatsNewWindow(IReadOnlyList<ReleaseNote> notes)
    {
        Title = L.T("Yenilikler");
        SystemBackdrop = new DesktopAcrylicBackdrop();
        ExtendsContentIntoTitleBar = true;
        try { AppWindow.SetIcon(System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "icon.ico")); } catch (Exception) { }
        if (AppWindow.Presenter is OverlappedPresenter p)
        {
            p.IsMaximizable = false;
            p.IsMinimizable = false;
        }

        var secondary = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];
        var list = new StackPanel { Spacing = 18 };
        foreach (var note in notes)
        {
            var entry = new StackPanel { Spacing = 6 };
            entry.Children.Add(new TextBlock
            {
                Text = note.DateText(L.Culture),
                Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"],
            });
            foreach (var line in note.In(L.Current))
            {
                var row = new Grid { ColumnSpacing = 8 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.Children.Add(new TextBlock { Text = "•", Foreground = secondary });
                var text = new TextBlock { Text = line, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
                Grid.SetColumn(text, 1);
                row.Children.Add(text);
                entry.Children.Add(row);
            }
            list.Children.Add(entry);
        }
        if (notes.Count == 0) list.Children.Add(new TextBlock { Text = L.T("Henüz yenilik notu yok."), Foreground = secondary });

        var ok = new Button
        {
            Content = L.T("Tamam"),
            MinWidth = 120,
            HorizontalAlignment = HorizontalAlignment.Right,
            Style = (Style)Application.Current.Resources["AccentButtonStyle"],
        };
        ok.Click += (_, _) => { try { Close(); } catch (Exception) { } };

        var root = new Grid { Padding = new Thickness(24, 36, 24, 20), RowSpacing = 14 };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.Children.Add(new TextBlock
        {
            Text = L.T("WECOMMANDER'da yenilikler"),
            Style = (Style)Application.Current.Resources["SubtitleTextBlockStyle"],
            FontWeight = FontWeights.SemiBold,
        });
        var scroll = new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        Grid.SetRow(scroll, 1);
        root.Children.Add(scroll);
        Grid.SetRow(ok, 2);
        root.Children.Add(ok);
        Content = root;
    }

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    private void ShowCentered()
    {
        var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
        var scale = GetDpiForWindow(hwnd) / 96.0;
        if (scale <= 0) scale = 1;
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        var width = Math.Min((int)Math.Round(520 * scale), area.Width);
        var height = Math.Min((int)Math.Round(500 * scale), area.Height);
        AppWindow.MoveAndResize(new RectInt32(area.X + (area.Width - width) / 2, area.Y + (area.Height - height) / 2, width, height));
        AppWindow.Show();
        Activate();
    }
}
