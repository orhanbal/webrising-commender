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
/// The Dock's terminal panel: terminals to saved servers in tabs, on the same
/// surface and core session type as the main window's tabs. "+" opens a new
/// tab with the server list; closing a tab ends its session. A tab connects
/// the way the main window does without asking (saved credentials, this
/// computer's keys, telnet / serial); a server that needs a password, a key
/// or a new host key to be trusted opens in the main window, which asks.
/// </summary>
public sealed class DockTerminalView : UserControl
{
    /// <summary>One tab: the server list, a connection in progress, or a terminal.</summary>
    private sealed class Slot
    {
        public required TabViewItem Item { get; init; }
        public required Grid Body { get; init; }
        public required TextBlock Title { get; init; }
        public TerminalTab? Term { get; set; }
        public string? Connecting { get; set; }
    }

    private readonly ServersController _c;
    private readonly Grid _root = new();
    private readonly TabView _tabs = new();
    private readonly InfoBar _info = new() { IsClosable = true, Margin = new Thickness(12, 0, 12, 8) };
    private readonly List<Slot> _slots = [];

    private static Brush Secondary => (Brush)Application.Current.Resources["TextFillColorSecondaryBrush"];

    public DockTerminalView(ServersController controller)
    {
        _c = controller;
        _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        _info.IsOpen = false;
        _root.Children.Add(_info);
        _tabs.IsAddTabButtonVisible = true;
        _tabs.TabWidthMode = TabViewWidthMode.SizeToContent;
        _tabs.CanReorderTabs = true;
        _tabs.VerticalAlignment = VerticalAlignment.Stretch;
        _tabs.HorizontalAlignment = HorizontalAlignment.Stretch;
        _tabs.AddTabButtonClick += (_, _) => Guard(() => ShowList(NewSlot()));
        _tabs.TabCloseRequested += (_, e) => Guard(() => { if (SlotOf(e.Tab) is { } s) CloseSlot(s); });
        _tabs.SelectionChanged += (_, _) => Guard(FocusTerminal);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(_tabs, L.T("Terminal sekmeleri"));
        Grid.SetRow(_tabs, 1);
        _root.Children.Add(_tabs);
        Content = _root;
    }

    /// <summary>Whether any tab is open (the panel shows the Dock's server only the first time).</summary>
    public bool HasTabs => _slots.Count > 0;

    /// <summary>The server of the terminal in the selected tab (null: a list or nothing).</summary>
    public CoreHost? Host => Current?.Term is { Closed: false } t ? t.Host : null;

    private Slot? Current => SlotOf(_tabs.SelectedItem as TabViewItem);

    private Slot? SlotOf(object? item) => _slots.FirstOrDefault(s => ReferenceEquals(s.Item, item));

    private static void Guard(Action a)
    {
        try { a(); } catch (Exception e) { App.LogCrash(e); }
    }

    /// <summary>
    /// Shows the terminal to <paramref name="hostId"/>: its open tab if there is one, else it
    /// connects in the selected list tab or a new tab. Null: a server list tab.
    /// </summary>
    public void Show(string? hostId)
    {
        var host = hostId is null ? null : _c.Hosts.FirstOrDefault(h => h.Id == hostId);
        if (host is not null && _slots.FirstOrDefault(s => s.Term is { Closed: false } t && t.Host.Id == host.Id) is { } open)
        {
            _tabs.SelectedItem = open.Item;
            FocusTerminal();
            return;
        }
        var slot = Current is { Term: null, Connecting: null } list ? list : NewSlot();
        if (host is null) ShowList(slot);
        else _ = Connect(slot, host);
    }

    /// <summary>The keyboard goes to the selected tab's terminal.</summary>
    public void FocusTerminal()
    {
        try { Current?.Term?.View.Focus(FocusState.Programmatic); } catch (Exception) { }
    }

    /// <summary>Closes the selected tab's session (the main window opens its own).</summary>
    public void Disconnect()
    {
        if (Current is { } s) CloseSlot(s);
    }

    /// <summary>Ends every tab's session (the panels are rebuilt, the app quits).</summary>
    public void DisconnectAll()
    {
        foreach (var s in _slots.ToList()) EndSession(s);
        _slots.Clear();
        _tabs.TabItems.Clear();
    }

    private Slot NewSlot()
    {
        var title = new TextBlock { Text = L.T("Yeni sekme"), VerticalAlignment = VerticalAlignment.Center, MaxWidth = 180, TextTrimming = TextTrimming.CharacterEllipsis };
        var header = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var icon = Icons.Make(IconName.Terminal);
        icon.VerticalAlignment = VerticalAlignment.Center;
        header.Children.Add(icon);
        header.Children.Add(title);
        var body = new Grid();
        var item = new TabViewItem { Header = header, Content = body };
        var slot = new Slot { Item = item, Body = body, Title = title };
        _slots.Add(slot);
        _tabs.TabItems.Add(item);
        _tabs.SelectedItem = item;
        return slot;
    }

    private void EndSession(Slot s)
    {
        if (s.Term is { } t)
        {
            try { _c.Close(t); } catch (Exception e) { App.LogCrash(e); }
            try { t.View.Close(); } catch (Exception) { }
        }
        s.Term = null;
    }

    /// <summary>Closes a tab; the last one closed leaves a fresh server list.</summary>
    private void CloseSlot(Slot s)
    {
        EndSession(s);
        _slots.Remove(s);
        _tabs.TabItems.Remove(s.Item);
        if (_slots.Count == 0) ShowList(NewSlot());
        FocusTerminal();
    }

    private static void SetBody(Slot s, UIElement body)
    {
        s.Body.Children.Clear();
        s.Body.Children.Add(body);
    }

    private void SetTitle(Slot s, string text)
    {
        s.Title.Text = text;
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(s.Item, text);
    }

    private void Tell(string text, InfoBarSeverity severity)
    {
        _info.Message = text;
        _info.Severity = severity;
        _info.IsOpen = true;
    }

    /// <summary>The saved servers in a tab: a click opens the terminal in that tab.</summary>
    private void ShowList(Slot slot)
    {
        EndSession(slot);
        SetTitle(slot, L.T("Yeni sekme"));
        var list = new StackPanel { Spacing = 2, Padding = new Thickness(12, 8, 12, 12) };
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
            button.Click += (_, _) => _ = Connect(slot, h);
            list.Children.Add(button);
        }
        SetBody(slot, new ScrollViewer { Content = list, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
    }

    private async Task Connect(Slot slot, CoreHost host)
    {
        if (slot.Connecting is not null) return;
        slot.Connecting = host.Id;
        EndSession(slot);
        _info.IsOpen = false;
        SetTitle(slot, host.Label);
        var waiting = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Margin = new Thickness(16), VerticalAlignment = VerticalAlignment.Top };
        waiting.Children.Add(new ProgressRing { IsActive = true, Width = 20, Height = 20 });
        waiting.Children.Add(new TextBlock { Text = L.F("{0}: bağlanılıyor…", host.Label), VerticalAlignment = VerticalAlignment.Center });
        SetBody(slot, waiting);
        try
        {
            // The main window's order: telnet / serial need no login; saved ones and this computer's keys go silently.
            var kind = !host.IsSsh || host.CanConnectSilently ? host.AuthKind : "key";
            var result = await _c.Connect(host, new { kind = host.IsSsh ? kind : "password", secret = "", remember = false }, null);
            if (!_slots.Contains(slot))
            {
                // The tab was closed while connecting: end the session it would have shown.
                if (result.SessionId is { } orphan) { try { _c.Close(new TerminalTab(orphan, host, new WebView2())); } catch (Exception) { } }
                return;
            }
            if (result.NeedsHostKeyApproval || result.SessionId is not { } sid)
            {
                NeedsWindow(slot, host, L.T("Bu sunucunun anahtarını onaylamak gerekiyor; onay ana pencerede sorulur."));
                return;
            }
            var view = new WebView2();
            var tab = new TerminalTab(sid, host, view);
            tab.Exited = () => Tell(L.F("{0}: bağlantı kapandı.", host.Label), InfoBarSeverity.Informational);
            _c.Register(tab, DispatcherQueue);
            slot.Term = tab;
            SetBody(slot, view);
            await TerminalSurface.InitAsync(tab, _c, DispatcherQueue, (t, input) => _c.Write(t, input));
            if (ReferenceEquals(Current, slot)) FocusTerminal();
        }
        catch (CoreException e)
        {
            var credential = e.Raw.Contains("no saved credential") || e.Raw.Contains("authentication failed")
                || e.Raw.Contains("private key could not be used") || e.Raw.StartsWith("key file ");
            if (!_slots.Contains(slot)) return;
            if (credential) NeedsWindow(slot, host, L.T("Bu sunucu için giriş bilgisi gerekiyor; ana pencerede sorulur."));
            else { ShowList(slot); Tell($"{host.Label}: {e.Message}", InfoBarSeverity.Error); }
        }
        catch (Exception e)
        {
            App.LogCrash(e);
            if (!_slots.Contains(slot)) return;
            ShowList(slot);
            Tell($"{host.Label}: {e.Message}", InfoBarSeverity.Error);
        }
        finally { slot.Connecting = null; }
    }

    /// <summary>A login or a host key must be asked: the main window does that (same server, its own terminal).</summary>
    private void NeedsWindow(Slot slot, CoreHost host, string why)
    {
        var body = new StackPanel { Spacing = 10, Margin = new Thickness(16) };
        body.Children.Add(new TextBlock { Text = why, TextWrapping = TextWrapping.Wrap });
        var open = new Button { Content = L.T("Pencerede aç"), Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        open.Click += (_, _) =>
        {
            try { CloseSlot(slot); App.Current.CloseDockPanels(); App.Current.OpenHostTerminal(host.Id); }
            catch (Exception e) { App.LogCrash(e); }
        };
        var back = new Button { Content = L.T("Başka sunucu seç") };
        back.Click += (_, _) => ShowList(slot);
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        buttons.Children.Add(open);
        buttons.Children.Add(back);
        body.Children.Add(buttons);
        SetBody(slot, body);
    }
}
