using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.Web.WebView2.Core;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// The terminal surface: xterm.js (Assets\terminal) in a WebView2, wired to a
/// session of wecommander-core. One implementation for the main window's
/// terminal tabs and the Dock's terminal panel.
/// </summary>
public static class TerminalSurface
{
    /// <summary>Font size and colours for the page (the same for every terminal).</summary>
    public static string SettingsJson() => JsonSerializer.Serialize(new
    {
        type = "settings",
        fontSize = App.Current.Settings.TerminalFontSize,
        theme = App.Current.Settings.TerminalTheme,
    });

    /// <summary>Loads the page into the tab's WebView2; <paramref name="input"/> sends what is typed (the window broadcasts to split panes).</summary>
    public static async Task InitAsync(TerminalTab tab, ServersController c, DispatcherQueue ui, Action<TerminalTab, string> input)
    {
        await tab.View.EnsureCoreWebView2Async();
        var core = tab.View.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.SetVirtualHostNameToFolderMapping("wecommander.terminal",
            Path.Combine(AppContext.BaseDirectory, "Assets", "terminal"), CoreWebView2HostResourceAccessKind.Allow);
        core.PermissionRequested += (_, e) =>
        {
            if (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead) e.State = CoreWebView2PermissionState.Allow;
        };
        core.WebMessageReceived += (sender, e) =>
        {
            JsonObject? m;
            try { m = JsonNode.Parse(e.TryGetWebMessageAsString()) as JsonObject; } catch (JsonException) { return; }
            switch ((string?)m?["type"])
            {
                case "ready":
                    tab.Ready = true;
                    tab.Post(SettingsJson());
                    c.Resize(tab, (int?)m!["cols"] ?? 100, (int?)m["rows"] ?? 30);
                    tab.Flush();
                    _ = SendCommands(tab, c);
                    break;
                case "command":
                    _ = c.AddCommand(tab.Host.Id, (string?)m!["line"] ?? "", (string?)m["prompt"] ?? "");
                    break;
                case "input":
                    input(tab, (string?)m!["data"] ?? "");
                    break;
                case "resize":
                    c.Resize(tab, (int?)m!["cols"] ?? 100, (int?)m["rows"] ?? 30);
                    break;
                case "fontSize":
                    // Ctrl+= / Ctrl+- in a terminal: remembered for the next ones.
                    var size = (int?)m!["size"] ?? 13;
                    ui.TryEnqueue(() => { App.Current.Settings.TerminalFontSize = size; App.Current.SaveSettings(); });
                    break;
            }
        };
        core.Navigate("https://wecommander.terminal/index.html");
    }

    /// <summary>Autocomplete: this host's commands and the snippets, for the terminal page.</summary>
    private static async Task SendCommands(TerminalTab tab, ServersController c)
    {
        if (tab.Guest is not null) return; // a teammate's terminal: not ours to remember
        try
        {
            var list = await c.Commands(tab.Host.Id);
            var snippets = (await c.Snippets()).Select(s => s.Command.Trim()).Where(x => x.Length > 0).ToList();
            tab.Post(JsonSerializer.Serialize(new { type = "commands", list, snippets }));
        }
        catch (Exception) { /* autocomplete is a convenience: the terminal works without it */ }
    }
}

/// <summary>
/// The Dock's terminal panel: one terminal to a saved server, on the same
/// surface and core session type as the main window's tabs. It connects the
/// way the main window does without asking (saved credentials, this
/// computer's keys, telnet / serial); a server that needs a password, a key
/// or a new host key to be trusted opens in the main window, which asks.
/// With no server chosen it lists the saved servers.
/// </summary>
public sealed class DockTerminalView : UserControl
{
    private readonly ServersController _c;
    private readonly Grid _root = new();
    private readonly InfoBar _info = new() { IsClosable = true, Margin = new Thickness(12, 0, 12, 8) };
    private TerminalTab? _tab;
    private string? _connecting;

    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];

    public DockTerminalView(ServersController controller)
    {
        _c = controller;
        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _info.IsOpen = false;
        _root.Children.Add(_info);
        Content = _root;
    }

    /// <summary>The server of the terminal on screen (null: the list).</summary>
    public CoreHost? Host => _tab is { Closed: false } t ? t.Host : null;

    /// <summary>Shows the terminal to <paramref name="hostId"/> (connects once); null: the server list.</summary>
    public void Show(string? hostId)
    {
        if (hostId is not null && _tab is { Closed: false } open && open.Host.Id == hostId) { FocusTerminal(); return; }
        var host = hostId is null ? null : _c.Hosts.FirstOrDefault(h => h.Id == hostId);
        if (host is null) { ShowList(); return; }
        _ = Connect(host);
    }

    /// <summary>The keyboard goes to the terminal.</summary>
    public void FocusTerminal()
    {
        try { _tab?.View.Focus(FocusState.Programmatic); } catch (Exception) { }
    }

    /// <summary>Ends the panel's session (the main window opens its own).</summary>
    public void Disconnect()
    {
        if (_tab is { } t)
        {
            try { _c.Close(t); } catch (Exception e) { App.LogCrash(e); }
            try { t.View.Close(); } catch (Exception) { }
        }
        _tab = null;
    }

    private void SetBody(UIElement body)
    {
        foreach (var old in _root.Children.Where(c => !ReferenceEquals(c, _info)).ToList()) _root.Children.Remove(old);
        Grid.SetRow((FrameworkElement)body, 1);
        _root.Children.Add(body);
    }

    private void Tell(string text, InfoBarSeverity severity)
    {
        _info.Message = text;
        _info.Severity = severity;
        _info.IsOpen = true;
    }

    /// <summary>The saved servers: a click opens the terminal here.</summary>
    private void ShowList()
    {
        Disconnect();
        var list = new StackPanel { Spacing = 2, Padding = new Thickness(12, 4, 12, 12) };
        list.Children.Add(new TextBlock { Text = L.T("Terminal açılacak sunucuyu seç"), Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"], Margin = new Thickness(4, 0, 0, 6) });
        var hosts = _c.Hosts.OrderBy(h => h.Label, StringComparer.CurrentCultureIgnoreCase).ToList();
        if (hosts.Count == 0)
            list.Children.Add(new TextBlock { Text = L.T("Henüz sunucu yok"), Foreground = Secondary, Margin = new Thickness(4, 0, 0, 0) });
        foreach (var host in hosts)
        {
            var row = new StackPanel();
            row.Children.Add(new TextBlock { Text = host.Label, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis });
            row.Children.Add(new TextBlock { Text = host.Target, FontSize = 12, Foreground = Secondary, TextTrimming = TextTrimming.CharacterEllipsis });
            var button = new Button
            {
                Content = row,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Left,
                Padding = new Thickness(8, 6, 8, 6),
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                BorderThickness = new Thickness(0),
            };
            ToolTipService.SetToolTip(button, L.F("{0}: terminal aç", host.Label));
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, host.Label);
            var h = host;
            button.Click += (_, _) => _ = Connect(h);
            list.Children.Add(button);
        }
        SetBody(new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
    }

    private async Task Connect(CoreHost host)
    {
        if (_connecting == host.Id) return;
        _connecting = host.Id;
        Disconnect();
        _info.IsOpen = false;
        var waiting = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Margin = new Thickness(16), VerticalAlignment = VerticalAlignment.Top };
        waiting.Children.Add(new ProgressRing { IsActive = true, Width = 20, Height = 20 });
        waiting.Children.Add(new TextBlock { Text = L.F("{0}: bağlanılıyor…", host.Label), VerticalAlignment = VerticalAlignment.Center });
        SetBody(waiting);
        try
        {
            // The main window's order: telnet / serial need no login; saved ones and this computer's keys go silently.
            var kind = !host.IsSsh || host.CanConnectSilently ? host.AuthKind : "key";
            var result = await _c.Connect(host, new { kind = host.IsSsh ? kind : "password", secret = "", remember = false }, null);
            if (result.NeedsHostKeyApproval || result.SessionId is not { } sid)
            {
                NeedsWindow(host, L.T("Bu sunucunun anahtarını onaylamak gerekiyor; onay ana pencerede sorulur."));
                return;
            }
            var view = new WebView2();
            var tab = new TerminalTab(sid, host, view);
            tab.Exited = () => Tell(L.T("Bağlantı kapandı."), InfoBarSeverity.Informational);
            _c.Register(tab, DispatcherQueue);
            _tab = tab;
            SetBody(view);
            await TerminalSurface.InitAsync(tab, _c, DispatcherQueue, (t, input) => _c.Write(t, input));
            FocusTerminal();
        }
        catch (CoreException e)
        {
            var credential = e.Raw.Contains("no saved credential") || e.Raw.Contains("authentication failed")
                || e.Raw.Contains("private key could not be used") || e.Raw.StartsWith("key file ");
            if (credential) NeedsWindow(host, L.T("Bu sunucu için giriş bilgisi gerekiyor; ana pencerede sorulur."));
            else { ShowList(); Tell($"{host.Label}: {e.Message}", InfoBarSeverity.Error); }
        }
        catch (Exception e)
        {
            App.LogCrash(e);
            ShowList();
            Tell($"{host.Label}: {e.Message}", InfoBarSeverity.Error);
        }
        finally { _connecting = null; }
    }

    /// <summary>A login or a host key must be asked: the main window does that (same server, its own terminal).</summary>
    private void NeedsWindow(CoreHost host, string why)
    {
        var body = new StackPanel { Spacing = 10, Margin = new Thickness(16) };
        body.Children.Add(new TextBlock { Text = why, TextWrapping = TextWrapping.Wrap });
        var open = new Button { Content = L.T("Pencerede aç"), Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        open.Click += (_, _) =>
        {
            try { App.Current.CloseDockPanels(); App.Current.OpenHostTerminal(host.Id); }
            catch (Exception e) { App.LogCrash(e); }
        };
        var back = new Button { Content = L.T("Başka sunucu seç") };
        back.Click += (_, _) => ShowList();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        buttons.Children.Add(open);
        buttons.Children.Add(back);
        body.Children.Add(buttons);
        SetBody(body);
    }
}
