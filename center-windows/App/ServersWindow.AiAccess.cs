using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// Hybrid Access (H1/H2) in the main window: the connection-method choice of
/// the add-server dialog, the host editor's "Yapay zekâ erişimi" section, the
/// AI badges of the host cards, the "Yapay zekâ" page (local MCP status, AI
/// apps, setup helper, activity) and the local MCP prompts. Every choice says
/// in plain words what it does, what it needs and what it does not protect.
/// </summary>
public sealed partial class ServersWindow
{
    private static readonly FontFamily AiMono = new("Cascadia Mono, Consolas");
    private StackPanel? _aiActivity;
    private int _aiVisit;
    private readonly HashSet<string> _mcpAsking = [];

    /// <summary>The window is on screen (not hidden to the tray).</summary>
    public bool IsShown => AppWindow.IsVisible;

    /// <summary>From the tray / notifications: the "Yapay zekâ" page.</summary>
    public void OpenAiPage() => Navigate("ai");

    private static TextBlock HelpText(string text) => new()
    {
        Text = text,
        TextWrapping = TextWrapping.Wrap,
        Foreground = Secondary,
        FontSize = 12,
    };

    private static TextBlock StrongText(string text) => new()
    {
        Text = text,
        TextWrapping = TextWrapping.Wrap,
        Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"],
    };

    /// <summary>A radio choice with its title and the explanation under it (visible, not a tooltip).</summary>
    private static RadioButton Choice(string group, string title, string help, bool enabled = true) => new()
    {
        GroupName = group,
        IsEnabled = enabled,
        HorizontalAlignment = HorizontalAlignment.Stretch,
        Content = new StackPanel
        {
            Spacing = 2,
            MaxWidth = 470,
            Children = { StrongText(title), HelpText(help) },
        },
    };

    // ---- add server: connection method ----

    /// <summary>The three ways to add a server, each with what it does and needs.</summary>
    private sealed class MethodChooser
    {
        public required RadioButton Ssh { get; init; }
        public required RadioButton Agent { get; init; }
        public required RadioButton Other { get; init; }
        public required UIElement View { get; init; }
        public required UIElement AgentPanel { get; init; }
    }

    private static MethodChooser BuildMethodChooser(string? protocol)
    {
        var group = "method-" + Guid.NewGuid().ToString("N");
        var ssh = Choice(group, AiAccessText.MethodSshTitle, AiAccessText.MethodSshHelp);
        var agent = Choice(group, AiAccessText.MethodAgentTitle, AiAccessText.MethodAgentHelp);
        var other = Choice(group, AiAccessText.MethodOtherTitle, AiAccessText.MethodOtherHelp);
        if (protocol is null or "" or "ssh") ssh.IsChecked = true; else other.IsChecked = true;
        var view = new StackPanel { Spacing = 6 };
        view.Children.Add(StrongText(L.T("Bağlantı yöntemi")));
        view.Children.Add(ssh);
        view.Children.Add(agent);
        view.Children.Add(other);
        // The agent is installed with the existing flow: the command on the web panel's Devices page.
        var agentPanel = new StackPanel { Spacing = 8, Visibility = Visibility.Collapsed };
        agentPanel.Children.Add(new InfoBar
        {
            IsOpen = true,
            IsClosable = false,
            Severity = InfoBarSeverity.Informational,
            Message = AiAccessText.MethodAgentSteps,
        });
        var open = new Button { Content = AiAccessText.MethodAgentOpen, Style = (Style)Application.Current.Resources["AccentButtonStyle"] };
        open.Click += (_, _) => App.OpenUrl(App.Current.Settings.Server + "/devices");
        var panel = new Button { Content = L.T("Yönetim Merkezi'nde Cihazlar") };
        panel.Click += (_, _) => { App.Current.ShowPanel(); App.Current.PanelWindow?.SelectDevices(); };
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { open, panel } };
        agentPanel.Children.Add(row);
        return new MethodChooser { Ssh = ssh, Agent = agent, Other = other, View = view, AgentPanel = agentPanel };
    }

    // ---- host editor: AI access ----

    /// <summary>
    /// The "Yapay zekâ erişimi" section of an existing host. <paramref name="afterClose"/>
    /// runs a fix (connect once, save the login) once the dialog has closed.
    /// Save returns without a call when nothing changed.
    /// </summary>
    private (UIElement View, Func<CoreHost, Task> Save) BuildAiAccessEditor(CoreHost host, ContentDialog dialog,
        Action<Func<Task>> afterClose, Action switchToSsh)
    {
        var stored = AiAccessRules.Of(host);
        var blockers = AiAccessRules.Blockers(host);
        var panel = new StackPanel { Spacing = 10 };
        panel.Children.Add(HelpText(AiAccessText.Header));

        // Blocking pre-conditions, each with its fix.
        if (blockers.Count > 0)
        {
            var list = new StackPanel { Spacing = 8, Margin = new Thickness(0, 0, 0, 8) };
            foreach (var blocker in blockers)
            {
                var row = new StackPanel { Spacing = 4 };
                row.Children.Add(new TextBlock { Text = AiAccessText.BlockerText(blocker), TextWrapping = TextWrapping.Wrap });
                var fix = new Button { Content = AiAccessText.BlockerFix(blocker) };
                fix.Click += (_, _) =>
                {
                    switch (blocker)
                    {
                        case AiBlocker.NotSsh:
                            switchToSsh();
                            break;
                        case AiBlocker.HostKeyUntrusted:
                            afterClose(async () =>
                            {
                                await OpenHost(host);
                                Show(L.T("Sunucunun kimliğini onayladıktan sonra Düzenle → Yapay zekâ erişimi'nden açabilirsin."), InfoBarSeverity.Informational);
                            });
                            dialog.Hide();
                            break;
                        default:
                            afterClose(() => AskCredentials(host, null));
                            dialog.Hide();
                            break;
                    }
                };
                row.Children.Add(fix);
                list.Children.Add(row);
            }
            panel.Children.Add(new InfoBar
            {
                IsOpen = true,
                IsClosable = false,
                Severity = InfoBarSeverity.Warning,
                Title = AiAccessText.BlockedTitle,
                Content = list,
            });
        }
        var canEnable = blockers.Count == 0;

        var local = new ToggleSwitch { Header = AiAccessText.LocalTitle, IsOn = stored.Local, IsEnabled = canEnable || stored.Local, OnContent = L.T("Açık"), OffContent = L.T("Kapalı") };
        panel.Children.Add(local);
        panel.Children.Add(HelpText(AiAccessText.LocalHelp));

        var remote = new ToggleSwitch { Header = AiAccessText.RemoteTitle, IsOn = stored.Remote, IsEnabled = canEnable || stored.Remote, OnContent = L.T("Açık"), OffContent = L.T("Kapalı"), Margin = new Thickness(0, 6, 0, 0) };
        panel.Children.Add(remote);
        panel.Children.Add(HelpText(AiAccessText.RemoteHelp));
        if (!_c.RemoteAiSupported)
            panel.Children.Add(new TextBlock { Text = AiAccessText.RemoteNotYet, TextWrapping = TextWrapping.Wrap, FontSize = 12, FontStyle = Windows.UI.Text.FontStyle.Italic });

        // Connector: who opens the connection for remote AI (only "this computer" for now).
        var connectorGroup = "connector-" + Guid.NewGuid().ToString("N");
        var thisComputer = Choice(connectorGroup, AiAccessText.ConnectorThisTitle, AiAccessText.ConnectorThisHelp);
        thisComputer.IsChecked = true;
        var alwaysOn = Choice(connectorGroup, AiAccessText.ConnectorAlwaysTitle, AiAccessText.ConnectorAlwaysHelp, enabled: false);
        var connector = new StackPanel { Spacing = 4, Margin = new Thickness(24, 0, 0, 0) };
        connector.Children.Add(StrongText(AiAccessText.ConnectorHeader));
        connector.Children.Add(thisComputer);
        connector.Children.Add(alwaysOn);
        void SyncConnector() => connector.Visibility = remote.IsOn ? Visibility.Visible : Visibility.Collapsed;
        remote.Toggled += (_, _) => SyncConnector();
        SyncConnector();
        panel.Children.Add(connector);

        // What the AI may do.
        var presetGroup = "preset-" + Guid.NewGuid().ToString("N");
        var presets = AiAccess.Presets.Select(p => (Id: p, Button: Choice(presetGroup, AiAccessText.PresetTitle(p), AiAccessText.PresetHelp(p)))).ToList();
        foreach (var p in presets) p.Button.IsChecked = p.Id == stored.Preset;
        if (presets.All(p => p.Button.IsChecked != true)) presets.First(p => p.Id == AiAccess.Approval).Button.IsChecked = true;
        var hours = new ComboBox
        {
            Header = AiAccessText.TimedDuration,
            ItemsSource = AiAccessText.TimedHours.Select(AiAccessText.Hours).ToList(),
            SelectedIndex = 0,
            Margin = new Thickness(28, 0, 0, 0),
            MinWidth = 160,
        };
        var timedChanged = false;
        hours.SelectionChanged += (_, _) => timedChanged = true;
        var timedEnds = new TextBlock { Margin = new Thickness(28, 0, 0, 0), FontSize = 12, Foreground = Secondary };
        if (stored.Preset == AiAccess.Timed && stored.TimedUntilTime is { } until && until > DateTimeOffset.UtcNow)
            timedEnds.Text = AiAccessText.TimedEnds(until);
        var presetPanel = new StackPanel { Spacing = 4, Margin = new Thickness(0, 6, 0, 0) };
        presetPanel.Children.Add(StrongText(AiAccessText.PresetHeader));
        foreach (var p in presets)
        {
            presetPanel.Children.Add(p.Button);
            p.Button.Checked += (_, _) => SyncPreset();
            if (p.Id == AiAccess.Timed) { presetPanel.Children.Add(hours); presetPanel.Children.Add(timedEnds); }
        }
        string Preset() => presets.First(p => p.Button.IsChecked == true).Id;
        void SyncPreset()
        {
            var timed = Preset() == AiAccess.Timed;
            hours.Visibility = timed ? Visibility.Visible : Visibility.Collapsed;
            timedEnds.Visibility = timed && timedEnds.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        SyncPreset();
        panel.Children.Add(presetPanel);

        // Sudo.
        var sudoGroup = "sudo-" + Guid.NewGuid().ToString("N");
        var sudos = AiAccess.SudoModes.Select(s => (Id: s, Button: Choice(sudoGroup, AiAccessText.SudoTitle(s), AiAccessText.SudoHelp(s)))).ToList();
        foreach (var s in sudos) s.Button.IsChecked = s.Id == stored.Sudo;
        if (sudos.All(s => s.Button.IsChecked != true)) sudos[0].Button.IsChecked = true;
        var sudoPanel = new StackPanel { Spacing = 4, Margin = new Thickness(0, 6, 0, 0) };
        sudoPanel.Children.Add(StrongText(AiAccessText.SudoHeader));
        foreach (var s in sudos) sudoPanel.Children.Add(s.Button);
        panel.Children.Add(sudoPanel);

        // Always on, not switchable.
        var guarantees = new StackPanel { Spacing = 4 };
        guarantees.Children.Add(StrongText(AiAccessText.GuaranteesTitle));
        foreach (var line in AiAccessText.Guarantees)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            var lockIcon = Icons.Make(IconName.Lock, size: 12);
            lockIcon.VerticalAlignment = VerticalAlignment.Top;
            lockIcon.Margin = new Thickness(0, 3, 0, 0);
            row.Children.Add(lockIcon);
            row.Children.Add(new TextBlock { Text = line, TextWrapping = TextWrapping.Wrap, MaxWidth = 440 });
            guarantees.Children.Add(row);
        }
        panel.Children.Add(new Border
        {
            Padding = new Thickness(12),
            CornerRadius = new CornerRadius(8),
            BorderThickness = new Thickness(1),
            Background = Res("CardBackgroundFillColorDefaultBrush"),
            BorderBrush = Res("CardStrokeColorDefaultBrush"),
            Child = guarantees,
        });

        // The honest limit of SSH, always shown.
        panel.Children.Add(new InfoBar
        {
            IsOpen = true,
            IsClosable = false,
            Severity = InfoBarSeverity.Warning,
            Title = AiAccessText.LimitTitle,
            Message = AiAccessText.SshLimit,
        });

        var view = new Expander
        {
            Header = AiAccessText.SectionTitle,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            IsExpanded = stored.Any,
            Content = panel,
        };

        async Task Save(CoreHost saved)
        {
            var now = DateTimeOffset.UtcNow;
            var current = AiAccessRules.Normalize(AiAccessRules.Of(saved));
            var sudo = sudos.First(s => s.Button.IsChecked == true).Id;
            var access = new AiAccess(local.IsOn, remote.IsOn, AiAccess.ThisComputer, Preset(), current.TimedUntil, sudo);
            if (access.Preset == AiAccess.Timed && (timedChanged || access.TimedUntilTime is not { } end || end <= now))
                access = AiAccessRules.TimedFor(access, TimeSpan.FromHours(AiAccessText.TimedHours[Math.Max(0, hours.SelectedIndex)]), now);
            access = AiAccessRules.Normalize(access);
            if (access == current) return;
            await _c.SetAiAccess(saved, access);
        }

        return (view, Save);
    }

    // ---- host cards ----

    /// <summary>"SSH", "Yerel YZ"… under a host card's address; the tooltip says the route in one sentence.</summary>
    private static UIElement HostBadgeRow(CoreHost host)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, Margin = new Thickness(0, 2, 0, 0) };
        foreach (var badge in HostBadges.For(host))
        {
            var ai = badge.Kind is "ai-local" or "ai-remote";
            row.Children.Add(new Border
            {
                CornerRadius = new CornerRadius(4),
                Padding = new Thickness(6, 1, 6, 1),
                Background = ai ? Res("AccentFillColorDefaultBrush") : Res("ControlFillColorSecondaryBrush"),
                Child = new TextBlock
                {
                    Text = badge.Text,
                    FontSize = 10,
                    Foreground = ai ? Res("TextOnAccentFillColorPrimaryBrush") : Secondary,
                },
            });
        }
        ToolTipService.SetToolTip(row, HostBadges.Explain(host));
        return row;
    }

    // ---- Settings → Yapay zekâ ----

    private async Task ShowAiPage()
    {
        var visit = ++_aiVisit;
        var body = new StackPanel { Spacing = 18, MaxWidth = 720, HorizontalAlignment = HorizontalAlignment.Left };
        SetPage(Page(AiAccessText.PageTitle, AiAccessText.PageSubtitle, new ScrollViewer { Content = body },
            ActionButton(L.T("Yenile"), IconName.Refresh, () => _ = ShowAiPage())));
        body.Children.Add(new TextBlock { Text = AiAccessText.WhatIsLocal, TextWrapping = TextWrapping.Wrap });

        // Status of local MCP.
        var status = new StackPanel { Spacing = 6 };
        body.Children.Add(status);
        McpStatus? state = null;
        try { state = await _c.GetMcpStatus(); }
        catch (CoreException e) { status.Children.Add(new TextBlock { Text = L.T("Yerel MCP durumu okunamadı: ") + e.Message, TextWrapping = TextWrapping.Wrap }); }
        if (visit != _aiVisit) return;
        if (state is not null)
        {
            status.Children.Add(StrongText(state.Enabled
                ? L.T("● Yerel MCP açık: bu bilgisayardaki yapay zekâ uygulamaları bağlanabilir.")
                : L.T("○ Yerel MCP kapalı: yapay zekâ uygulamaları şu an bağlanamaz.")));
            if (state.BridgeCommand.Count > 0)
            {
                status.Children.Add(HelpText(L.T("Yapay zekâ uygulamalarının başlattığı komut (kurulum düğmeleri bunu yazar):")));
                status.Children.Add(new TextBox
                {
                    Text = string.Join(" ", state.BridgeCommand.Select(a => a.Contains(' ') ? "\"" + a + "\"" : a)),
                    IsReadOnly = true,
                    FontFamily = AiMono,
                    TextWrapping = TextWrapping.Wrap,
                });
            }
        }
        var exposed = _c.Hosts.Count(h => AiAccessRules.Of(h).Local);
        status.Children.Add(HelpText(exposed > 0
            ? L.F("{0} sunucuda yerel yapay zekâ erişimi açık.", exposed)
            : L.T("Henüz hiçbir sunucuda açık değil: Sunucular → sağ tık → Düzenle… → Yapay zekâ erişimi.")));

        // Setup helper.
        body.Children.Add(StrongText(L.T("Yapay zekâ uygulamasına ekle")));
        foreach (var client in AiAccessText.SetupClients)
        {
            var grid = new Grid { ColumnSpacing = 12 };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(200) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var add = new Button { Content = AiAccessText.AddTo(client), HorizontalAlignment = HorizontalAlignment.Stretch };
            var id = client;
            add.Click += async (_, _) => await SetupClient(id);
            grid.Children.Add(add);
            var help = HelpText(AiAccessText.ClientHelp(client));
            help.VerticalAlignment = VerticalAlignment.Center;
            Grid.SetColumn(help, 1);
            grid.Children.Add(help);
            body.Children.Add(grid);
        }

        // AI apps that connected.
        body.Children.Add(StrongText(L.T("Bağlanan yapay zekâ uygulamaları")));
        var clients = new StackPanel { Spacing = 8 };
        body.Children.Add(clients);
        await RenderAiClients(clients, state?.Clients);

        // Activity.
        body.Children.Add(StrongText(L.T("Son etkinlik")));
        _aiActivity = new StackPanel { Spacing = 4 };
        body.Children.Add(_aiActivity);
        RenderAiActivity();
    }

    private async Task RenderAiClients(StackPanel panel, IReadOnlyList<McpClient>? known)
    {
        panel.Children.Clear();
        IReadOnlyList<McpClient> list;
        try { list = known ?? await _c.GetMcpClients(); }
        catch (CoreException e) { panel.Children.Add(HelpText(e.Message)); return; }
        if (list.Count == 0)
        {
            panel.Children.Add(HelpText(L.T("Henüz bağlanan bir yapay zekâ uygulaması yok. Yukarıdaki düğmelerle ekleyebilirsin; ilk bağlandığında burada izin istenir.")));
            return;
        }
        var now = DateTimeOffset.UtcNow;
        foreach (var client in list)
        {
            var grid = new Grid { ColumnSpacing = 8 };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            var text = new StackPanel { Spacing = 2 };
            text.Children.Add(StrongText(client.Version is null ? client.Name : $"{client.Name} {client.Version}"));
            text.Children.Add(HelpText((client.Allowed ? L.T("İzinli") : L.T("Engelli")) + " · " + L.F("son görülme: {0}", AiAccessText.Ago(client.LastSeen, now))));
            grid.Children.Add(text);
            var toggle = new Button { Content = client.Allowed ? L.T("Engelle") : L.T("İzin ver"), VerticalAlignment = VerticalAlignment.Center };
            var c = client;
            toggle.Click += async (_, _) =>
            {
                await Guard(() => _c.AllowMcpClient(c.Id, !c.Allowed));
                await RenderAiClients(panel, null);
            };
            Grid.SetColumn(toggle, 1);
            grid.Children.Add(toggle);
            var forget = new Button { Content = L.T("Unut"), VerticalAlignment = VerticalAlignment.Center };
            ToolTipService.SetToolTip(forget, L.T("Kararı unutur; uygulama yeniden bağlanırsa izin yeniden sorulur."));
            forget.Click += async (_, _) =>
            {
                await Guard(() => _c.ForgetMcpClient(c.Id));
                await RenderAiClients(panel, null);
            };
            Grid.SetColumn(forget, 2);
            grid.Children.Add(forget);
            panel.Children.Add(grid);
        }
    }

    private void RenderAiActivity()
    {
        if (_aiActivity is not { } panel || panel.XamlRoot is null && panel.Parent is null) return;
        panel.Children.Clear();
        var items = _c.McpLog.Items;
        if (items.Count == 0)
        {
            panel.Children.Add(HelpText(L.T("Henüz etkinlik yok. Bir yapay zekâ uygulaması bu bilgisayardan bir sunucuyu kullandığında burada görünür.")));
            return;
        }
        foreach (var a in items.Take(50))
            panel.Children.Add(new TextBlock
            {
                Text = $"{a.At.ToLocalTime():HH:mm:ss} · {a.ClientName} → {a.TargetLabel} · {Texts.KindLabel(a.Tool)} · {AiAccessText.Outcome(a.Outcome)}",
                TextWrapping = TextWrapping.Wrap,
                FontSize = 12,
            });
    }

    /// <summary>The setup helper: shows exactly what changes in the AI app's config, then writes it.</summary>
    private async Task SetupClient(string client)
    {
        var name = AiAccessText.ClientName(client);
        McpConfigPreview preview;
        try { preview = await _c.McpConfigFor(client); }
        catch (CoreException e) { Show(e.Message, InfoBarSeverity.Error); return; }
        var lines = ConfigDiff.Lines(preview.Before, preview.After);
        if (preview.Before is not null && lines.All(l => l.Kind == ' '))
        {
            Show(L.F("{0} zaten ayarlı; değişiklik gerekmiyor.", name), InfoBarSeverity.Success);
            return;
        }
        var panel = new StackPanel { Spacing = 10, MaxWidth = 640 };
        panel.Children.Add(HelpText(AiAccessText.ClientHelp(client)));
        panel.Children.Add(StrongText(AiAccessText.ConfigNote));
        panel.Children.Add(new TextBlock { Text = L.F("Dosya: {0}", preview.Path), TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, FontSize = 12 });
        panel.Children.Add(new TextBlock { Text = ConfigDiff.Summary(preview.Before, preview.After), TextWrapping = TextWrapping.Wrap });
        var diff = new StackPanel();
        foreach (var line in ConfigDiff.Compact(lines))
        {
            diff.Children.Add(new TextBlock
            {
                Text = (line.Kind == '…' ? "  " : line.Kind + " ") + line.Text,
                FontFamily = AiMono,
                FontSize = 12,
                IsTextSelectionEnabled = true,
                Foreground = line.Kind switch
                {
                    '+' => new SolidColorBrush(Microsoft.UI.Colors.SeaGreen),
                    '-' => new SolidColorBrush(Microsoft.UI.Colors.IndianRed),
                    _ => Secondary,
                },
            });
        }
        panel.Children.Add(new Border
        {
            Padding = new Thickness(8),
            CornerRadius = new CornerRadius(6),
            BorderThickness = new Thickness(1),
            BorderBrush = Res("CardStrokeColorDefaultBrush"),
            Child = new ScrollViewer { Content = diff, MaxHeight = 280, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto },
        });
        var full = new StackPanel { Spacing = 8 };
        full.Children.Add(new TextBox { Header = L.T("Önce"), Text = preview.Before ?? L.T("(dosya yok)"), IsReadOnly = true, AcceptsReturn = true, FontFamily = AiMono, MaxHeight = 200, TextWrapping = TextWrapping.NoWrap });
        full.Children.Add(new TextBox { Header = L.T("Sonra"), Text = preview.After, IsReadOnly = true, AcceptsReturn = true, FontFamily = AiMono, MaxHeight = 200, TextWrapping = TextWrapping.NoWrap });
        panel.Children.Add(new Expander { Header = L.T("Dosyanın tamamı (önce / sonra)"), Content = full, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch });
        var dialog = Dialog(L.F("{0}: WECOMMANDER eklensin mi?", name), new ScrollViewer { Content = panel, MaxHeight = 560 }, L.T("Ekle"));
        if (await ShowDialog(dialog) != ContentDialogResult.Primary) return;
        try
        {
            await _c.McpWriteConfig(client);
            Show(L.F("{0} için WECOMMANDER eklendi. Uygulamayı yeniden başlatınca WECOMMANDER araçları görünür.", name), InfoBarSeverity.Success);
        }
        catch (CoreException e) { Show(e.Message, InfoBarSeverity.Error); }
    }

    // ---- local MCP prompts ----

    /// <summary>An unknown AI app asks to connect: İzin ver / Reddet (nothing is allowed without a click).</summary>
    public async Task AskMcpClient(McpClientRequest request)
    {
        if (!_mcpAsking.Add("client:" + request.Id)) return;
        try
        {
            var panel = new StackPanel { Spacing = 10, MaxWidth = 460 };
            panel.Children.Add(new TextBlock { Text = AiAccessText.ClientRequestHelp, TextWrapping = TextWrapping.Wrap });
            if (request.Version is { } version) panel.Children.Add(HelpText(L.F("Sürüm: {0}", version)));
            var dialog = Dialog(AiAccessText.ClientRequestTitle(request.Name), panel, L.T("İzin ver"), L.T("Sonra"));
            dialog.SecondaryButtonText = L.T("Reddet");
            dialog.DefaultButton = ContentDialogButton.None;
            Action<string> closed = id => DispatcherQueue.TryEnqueue(() => { if (id == request.Id) dialog.Hide(); });
            _c.McpClientClosed += closed;
            ContentDialogResult choice;
            try { choice = await ShowDialog(dialog, () => _c.PendingMcpClients.ContainsKey(request.Id)); }
            finally { _c.McpClientClosed -= closed; }
            if (choice == ContentDialogResult.None || !_c.PendingMcpClients.ContainsKey(request.Id)) return;
            var allow = choice == ContentDialogResult.Primary;
            await Guard(() => _c.AllowMcpClient(request.Id, allow));
            Show(allow ? L.F("{0} artık bu bilgisayardan WECOMMANDER'a bağlanabilir.", request.Name) : L.F("{0} reddedildi.", request.Name),
                allow ? InfoBarSeverity.Success : InfoBarSeverity.Informational);
        }
        finally { _mcpAsking.Remove("client:" + request.Id); }
    }

    /// <summary>A local AI app's risky action: client, server, tool, the exact command and the time left; Onayla / Reddet.</summary>
    public async Task AskMcpApproval(McpApproval approval)
    {
        if (!_mcpAsking.Add("approval:" + approval.ApprovalId)) return;
        try
        {
            var panel = new StackPanel { Spacing = 8, MaxWidth = 520 };
            panel.Children.Add(new InfoBar
            {
                IsOpen = true,
                IsClosable = false,
                Severity = InfoBarSeverity.Warning,
                Message = L.T("Yalnız bu komut, bu sunucuda, bir kez çalışır. Komutu tanımıyorsan reddet."),
            });
            void Field(string label, string value)
            {
                var row = new StackPanel { Spacing = 0 };
                row.Children.Add(HelpText(label));
                row.Children.Add(new TextBlock { Text = value, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true });
                panel.Children.Add(row);
            }
            Field(L.T("Yapay zekâ uygulaması"), approval.ClientName);
            Field(L.T("Sunucu"), approval.TargetLabel);
            Field(L.T("İşlem"), Texts.KindLabel(approval.Tool) == approval.Tool ? approval.Tool : $"{Texts.KindLabel(approval.Tool)} ({approval.Tool})");
            if (!string.IsNullOrWhiteSpace(approval.Summary) && approval.Summary != approval.Command) Field(L.T("Açıklama"), approval.Summary);
            panel.Children.Add(HelpText(L.T("Tam komut")));
            panel.Children.Add(new TextBox { Text = approval.Command, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, AcceptsReturn = true, FontFamily = AiMono });
            var remaining = new TextBlock { FontSize = 12, Foreground = Secondary };
            panel.Children.Add(remaining);
            var dialog = Dialog(L.F("{0} onay istiyor", approval.ClientName), panel, L.T("Onayla"), L.T("Sonra"));
            dialog.SecondaryButtonText = L.T("Reddet");
            dialog.DefaultButton = ContentDialogButton.None;
            var timer = DispatcherQueue.CreateTimer();
            timer.Interval = TimeSpan.FromSeconds(1);
            void Tick()
            {
                var now = DateTimeOffset.UtcNow;
                if (approval.ExpiresAt <= now)
                {
                    remaining.Text = L.T("Süresi doldu; bu istek artık onaylanamaz.");
                    dialog.IsPrimaryButtonEnabled = false;
                    timer.Stop();
                    return;
                }
                remaining.Text = L.F("Kalan süre: {0}", Texts.Countdown(approval.ExpiresAt, now));
            }
            timer.Tick += (_, _) => Tick();
            Tick();
            timer.Start();
            Action<string> closed = id => DispatcherQueue.TryEnqueue(() => { if (id == approval.ApprovalId) dialog.Hide(); });
            _c.McpApprovalClosed += closed;
            ContentDialogResult choice;
            try { choice = await ShowDialog(dialog, () => _c.PendingMcpApproval(approval.ApprovalId) is not null); }
            finally
            {
                _c.McpApprovalClosed -= closed;
                timer.Stop();
            }
            if (choice == ContentDialogResult.None) return;
            if (_c.PendingMcpApproval(approval.ApprovalId) is null)
            {
                Show(L.T("Bu onay artık geçerli değil (karar verilmiş ya da süresi dolmuş)."), InfoBarSeverity.Warning);
                return;
            }
            var approve = choice == ContentDialogResult.Primary;
            await Guard(() => _c.DecideMcp(approval.ApprovalId, approve));
            Show(approve
                ? L.F("{0} · onaylandı; yapay zekâ bu komutu bir kez çalıştırabilir.", approval.TargetLabel)
                : L.F("{0} · reddedildi.", approval.TargetLabel), approve ? InfoBarSeverity.Success : InfoBarSeverity.Informational);
        }
        finally { _mcpAsking.Remove("approval:" + approval.ApprovalId); }
    }
}
