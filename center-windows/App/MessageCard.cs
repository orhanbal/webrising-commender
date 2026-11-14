using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// A marketing message or survey from the console, bottom left of the
/// Servers window (like an app survey): faces 1–5, 0–10, or a button.
/// </summary>
internal static class MessageCard
{
    private static readonly string[] Faces = ["😩", "🙁", "🤔", "🙂", "😄"];

    /// <summary>Fetches the person's next message once per app run and shows it in <paramref name="host"/>.</summary>
    public static async Task ShowNextAsync(Border host)
    {
        if (App.Current.Credentials() is not { } c) return;
        InAppMessage? m;
        try { m = await c.Gateway.MessageAsync(c.Token); }
        catch (Exception) { return; } // offline or older server: nothing to show
        if (m is null) return;
        _ = Respond(m, "shown");
        host.Child = Build(m, () => { host.Child = null; host.Visibility = Visibility.Collapsed; });
        host.Visibility = Visibility.Visible;
    }

    private static async Task Respond(InAppMessage m, string action, int? score = null, string? comment = null)
    {
        if (App.Current.Credentials() is not { } c) return;
        try { await c.Gateway.RespondAsync(c.Token, m.Id, action, score, comment); } catch (Exception) { }
    }

    private static UIElement Build(InAppMessage m, Action close)
    {
        var secondary = (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];
        var p = new StackPanel { Spacing = 10, Width = 320 };
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var icon = m.Kind switch { "tip" => "💡 ", "announcement" => "📣 ", _ => "👋 " };
        head.Children.Add(new TextBlock { Text = icon + m.Title, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
        var x = new Button { Content = new SymbolIcon(Symbol.Cancel), Padding = new Thickness(4), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0) };
        ToolTipService.SetToolTip(x, "Kapat");
        x.Click += (_, _) => { _ = Respond(m, "dismissed"); close(); };
        Grid.SetColumn(x, 1);
        head.Children.Add(x);
        p.Children.Add(head);
        if (!string.IsNullOrWhiteSpace(m.Body)) p.Children.Add(new TextBlock { Text = m.Body, Foreground = secondary, TextWrapping = TextWrapping.Wrap });

        if (m.Kind is "csat" or "nps")
        {
            var answer = new StackPanel { Spacing = 8, Visibility = Visibility.Collapsed };
            var note = new TextBox { PlaceholderText = "Eklemek istediğin bir şey var mı? (isteğe bağlı)", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MaxLength = 1000, Height = 64 };
            var send = new Button { Content = "Gönder", HorizontalAlignment = HorizontalAlignment.Stretch, Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
            answer.Children.Add(note);
            answer.Children.Add(send);
            int? chosen = null;
            var choices = new Grid { ColumnSpacing = m.Kind == "csat" ? 6 : 2 };
            var buttons = new List<Button>();
            var count = m.Kind == "csat" ? 5 : 11;
            for (var i = 0; i < count; i++)
            {
                choices.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                var value = m.Kind == "csat" ? i + 1 : i;
                var b = new Button
                {
                    Content = m.Kind == "csat" ? Faces[i] : value.ToString(),
                    FontSize = m.Kind == "csat" ? 22 : 12,
                    Padding = new Thickness(m.Kind == "csat" ? 4 : 0, 4, m.Kind == "csat" ? 4 : 0, 4),
                    HorizontalAlignment = HorizontalAlignment.Stretch,
                    MinWidth = 0,
                };
                b.Click += (_, _) =>
                {
                    chosen = value;
                    foreach (var other in buttons) other.Style = null;
                    b.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
                    answer.Visibility = Visibility.Visible;
                };
                Grid.SetColumn(b, i);
                choices.Children.Add(b);
                buttons.Add(b);
            }
            p.Children.Add(choices);
            if (m.Kind == "nps")
            {
                var scale = new Grid();
                scale.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                scale.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                scale.Children.Add(new TextBlock { Text = "Hiç olası değil", FontSize = 11, Foreground = secondary });
                var high = new TextBlock { Text = "Çok olası", FontSize = 11, Foreground = secondary };
                Grid.SetColumn(high, 1);
                scale.Children.Add(high);
                p.Children.Add(scale);
            }
            p.Children.Add(answer);
            send.Click += async (_, _) =>
            {
                send.IsEnabled = false;
                await Respond(m, "answered", chosen, string.IsNullOrWhiteSpace(note.Text) ? null : note.Text.Trim());
                p.Children.Clear();
                p.Children.Add(new TextBlock { Text = "Teşekkürler! 🙏", FontWeight = FontWeights.SemiBold });
                await Task.Delay(1500);
                close();
            };
        }
        else if (!string.IsNullOrWhiteSpace(m.CtaLabel) && m.CtaUrl is { } url && url.StartsWith("https://", StringComparison.Ordinal))
        {
            var cta = new Button { Content = m.CtaLabel, Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
            cta.Click += async (_, _) =>
            {
                _ = Respond(m, "clicked");
                try { await Windows.System.Launcher.LaunchUriAsync(new Uri(url)); } catch (Exception) { }
                close();
            };
            p.Children.Add(cta);
        }
        return p;
    }
}
