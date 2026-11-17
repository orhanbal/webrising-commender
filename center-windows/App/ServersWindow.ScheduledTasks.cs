using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// "Zamanlanmış görevler": WECOMMANDER's own scheduled tasks, stored on the
/// server. The server runs them when due: on a device through its agent, on a
/// saved SSH host through the app that saved the host (App.ScheduledTasks.cs).
/// Owner and admin change them; a viewer only reads (the API answers 403).
/// </summary>
public sealed partial class ServersWindow
{
    private static readonly FontFamily MonoFont = new("Cascadia Mono, Consolas");
    private int _scheduledVisit;

    /// <summary>From the Dock and the tray: the scheduled tasks page.</summary>
    public void OpenScheduledTasks() => Navigate("scheduled");

    private static string ScheduledReadOnly =>
        L.T("Zamanlanmış görevleri yalnız sahip ve yöneticiler değiştirebilir; sen yalnız görüntüleyebilirsin.");

    /// <summary>Owner and admin (an unknown role is left to the server, which answers 403).</summary>
    private static bool CanEditScheduledTasks =>
        App.Current.Me is not { Role: { Length: > 0 } role } || role is "owner" or "admin";

    private static string ScheduledError(GatewayException e) => e.Status switch
    {
        403 => ScheduledReadOnly,
        404 when e.Code.Length == 0 => L.T("Bu sunucu zamanlanmış görevleri henüz desteklemiyor."),
        400 when !string.IsNullOrWhiteSpace(e.ServerMessage) => e.Message + " " + e.ServerMessage,
        _ => e.Message,
    };

    private (GatewayClient Gateway, string Token)? ScheduledCredentials()
    {
        if (App.Current.Credentials() is { } c) return c;
        Show(L.T("Önce oturum aç."), InfoBarSeverity.Warning);
        return null;
    }

    private bool OnScheduledPage(int visit) =>
        visit == _scheduledVisit && (_nav.SelectedItem as NavigationViewItem)?.Tag as string == "scheduled";

    /// <summary>Runs a click handler; a gateway error goes to the message bar, anything else is logged.</summary>
    private async Task Scheduled(Func<Task> action)
    {
        try { await action(); }
        catch (GatewayException e) { Show(ScheduledError(e), InfoBarSeverity.Error); }
        catch (Exception e) { App.LogCrash(e); Show(L.T("İşlem yapılamadı: ") + e.Message, InfoBarSeverity.Error); }
    }

    private async Task ShowScheduledTasks()
    {
        var visit = ++_scheduledVisit;
        var title = L.T("Zamanlanmış görevler");
        var subtitle = L.T("WECOMMANDER bu görevleri zamanı gelince kendisi çalıştırır: cihazlarda ajan, kayıtlı SSH sunucularında bu uygulama (açık ve oturumu açık olmalı).");
        if (App.Current.Credentials() is not { } creds)
        {
            var signedOut = new TextBlock { Text = L.T("Zamanlanmış görevleri görmek için oturum aç."), TextWrapping = TextWrapping.Wrap, Foreground = Secondary };
            SetPage(Page(title, subtitle, signedOut, ActionButton(L.T("Oturum aç…"), IconName.SignIn, () => App.Current.ShowPanel(), accent: true)));
            return;
        }
        SetPage(Page(title, subtitle, new ProgressRing { IsActive = true, Width = 32, Height = 32, HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top }));
        List<ScheduledTask> tasks;
        try
        {
            tasks = await creds.Gateway.ScheduledTasksAsync(creds.Token);
        }
        catch (GatewayException e)
        {
            if (!OnScheduledPage(visit)) return;
            var failed = new TextBlock { Text = ScheduledError(e), TextWrapping = TextWrapping.Wrap, Foreground = Secondary };
            SetPage(Page(title, subtitle, failed, ActionButton(L.T("Yenile"), IconName.Refresh, () => _ = ShowScheduledTasks())));
            return;
        }
        if (!OnScheduledPage(visit)) return;

        var canEdit = CanEditScheduledTasks;
        var list = new StackPanel { Spacing = 8 };
        if (!canEdit)
            list.Children.Add(new InfoBar { IsOpen = true, IsClosable = false, Severity = InfoBarSeverity.Informational, Message = ScheduledReadOnly });
        if (tasks.Count == 0)
            list.Children.Add(new TextBlock
            {
                Text = L.T("Henüz zamanlanmış görev yok. Yedek, temizlik ya da rapor gibi düzenli işleri burada tanımla; zamanı gelince sunucu çalıştırır."),
                Foreground = Secondary,
                TextWrapping = TextWrapping.Wrap,
            });
        foreach (var t in tasks.OrderBy(t => t.Name, StringComparer.CurrentCultureIgnoreCase))
            list.Children.Add(ScheduledRow(t, canEdit));
        var actions = new List<UIElement> { ActionButton(L.T("Yenile"), IconName.Refresh, () => _ = ShowScheduledTasks()) };
        if (canEdit) actions.Add(ActionButton(L.T("Yeni görev"), IconName.Add, () => _ = EditScheduledTask(null), accent: true));
        SetPage(Page(title, subtitle, new ScrollViewer { Content = list }, actions.ToArray()));
    }

    private static string TargetLabel(TaskTarget target)
    {
        if (target.IsSsh)
        {
            var label = L.F("Sunucu (SSH): {0}", target.HostLabel ?? target.HostId ?? "?");
            var mine = App.Current.Me?.CenterId;
            return string.IsNullOrEmpty(mine) || target.CenterId == mine ? label : label + L.T(" (başka bir bilgisayardan çalışır)");
        }
        var device = App.Current.Devices.FirstOrDefault(d => d.Id == target.DeviceId);
        return L.F("Cihaz: {0}", device?.Name ?? L.T("bilinmeyen cihaz"));
    }

    private static Border RunBadge(string? status)
    {
        var color = ScheduleText.Tone(status) switch
        {
            "good" => Microsoft.UI.Colors.SeaGreen,
            "bad" => Microsoft.UI.Colors.IndianRed,
            "warn" => Microsoft.UI.Colors.DarkOrange,
            "busy" => Microsoft.UI.Colors.SteelBlue,
            _ => Microsoft.UI.Colors.Gray,
        };
        return new Border
        {
            Background = new SolidColorBrush(color),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(8, 2, 8, 2),
            VerticalAlignment = VerticalAlignment.Center,
            Child = new TextBlock { Text = ScheduleText.Status(status), FontSize = 12, Foreground = new SolidColorBrush(Microsoft.UI.Colors.White) },
        };
    }

    private static Button IconAction(IconName icon, string tip, bool enabled = true)
    {
        var b = new Button { Content = Icons.Make(icon, size: 20), IsEnabled = enabled, VerticalAlignment = VerticalAlignment.Center };
        ToolTipService.SetToolTip(b, tip);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(b, tip);
        return b;
    }

    private Grid ScheduledRow(ScheduledTask t, bool canEdit)
    {
        var row = new Grid { ColumnSpacing = 8, Padding = new Thickness(12), CornerRadius = new CornerRadius(6), Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"] };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        for (var i = 0; i < 6; i++) row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        var text = new StackPanel { Spacing = 2 };
        text.Children.Add(new TextBlock { Text = t.Name, Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"], TextTrimming = TextTrimming.CharacterEllipsis });
        text.Children.Add(new TextBlock { Text = $"{TargetLabel(t.Target)} · {ScheduleText.Describe(t.Schedule)}", Foreground = Secondary, TextWrapping = TextWrapping.Wrap });
        text.Children.Add(new TextBlock
        {
            Text = !t.Enabled ? L.T("Kapalı: zamanında çalışmaz.")
                : t.NextRunAt is { } next ? L.F("Sonraki çalışma: {0}", ScheduleText.LocalTime(next))
                : L.T("Sonraki çalışma yok."),
            Foreground = Secondary,
            FontSize = 12,
        });
        text.Children.Add(new TextBlock { Text = t.Command, FontFamily = MonoFont, FontSize = 12, Foreground = Secondary, TextTrimming = TextTrimming.CharacterEllipsis, IsTextSelectionEnabled = true });
        row.Children.Add(text);

        var badge = RunBadge(t.LastRun?.Status);
        if (t.LastRun is { } last)
            ToolTipService.SetToolTip(badge, L.F("Son çalışma: {0}", ScheduleText.LocalTime(last.FinishedAt ?? last.StartedAt ?? last.ScheduledFor)));
        Grid.SetColumn(badge, 1); row.Children.Add(badge);

        var toggle = new ToggleSwitch { IsOn = t.Enabled, OnContent = L.T("Açık"), OffContent = L.T("Kapalı"), IsEnabled = canEdit, MinWidth = 0, VerticalAlignment = VerticalAlignment.Center };
        var reverting = false;
        toggle.Toggled += async (_, _) =>
        {
            if (reverting) return;
            var on = toggle.IsOn;
            if (ScheduledCredentials() is not { } c) return;
            try
            {
                var saved = await c.Gateway.UpdateScheduledTaskAsync(c.Token, t.Id, new JsonObject { ["enabled"] = on });
                t.Enabled = saved.Enabled;
                Show(on ? L.F("{0} açıldı.", t.Name) : L.F("{0} kapatıldı; zamanında çalışmayacak.", t.Name), InfoBarSeverity.Success);
            }
            catch (Exception e)
            {
                reverting = true;
                toggle.IsOn = !on;
                reverting = false;
                if (e is GatewayException g) Show(ScheduledError(g), InfoBarSeverity.Error);
                else { App.LogCrash(e); Show(L.T("İşlem yapılamadı: ") + e.Message, InfoBarSeverity.Error); }
            }
        };
        Grid.SetColumn(toggle, 2); row.Children.Add(toggle);

        var run = IconAction(IconName.Play, L.T("Şimdi çalıştır"), canEdit);
        run.Click += async (_, _) => await Scheduled(async () =>
        {
            if (ScheduledCredentials() is not { } c) return;
            await c.Gateway.RunScheduledTaskAsync(c.Token, t.Id);
            Show(t.Target.IsSsh
                ? L.F("{0} sıraya alındı; bu uygulama birkaç saniye içinde çalıştırır.", t.Name)
                : L.F("{0} sıraya alındı; cihazdaki ajan birazdan çalıştırır.", t.Name), InfoBarSeverity.Success);
            if (t.Target.IsSsh) App.Current.RequestScheduledClaim();
        });
        Grid.SetColumn(run, 3); row.Children.Add(run);

        var history = IconAction(IconName.History, L.T("Çalışma geçmişi"));
        history.Click += async (_, _) => await Scheduled(() => ShowScheduledRuns(t));
        Grid.SetColumn(history, 4); row.Children.Add(history);

        var edit = IconAction(IconName.Edit, L.T("Düzenle"), canEdit);
        edit.Click += async (_, _) => await Scheduled(() => EditScheduledTask(t));
        Grid.SetColumn(edit, 5); row.Children.Add(edit);

        var del = IconAction(IconName.Delete, L.T("Sil"), canEdit);
        del.Click += async (_, _) => await Scheduled(async () =>
        {
            var dialog = Dialog(L.F("{0} silinsin mi?", t.Name), new TextBlock { Text = L.T("Görev ve çalışma geçmişi silinir; bu geri alınamaz."), TextWrapping = TextWrapping.Wrap }, L.T("Sil"));
            if (await ShowDialog(dialog) != ContentDialogResult.Primary) return;
            if (ScheduledCredentials() is not { } c) return;
            await c.Gateway.DeleteScheduledTaskAsync(c.Token, t.Id);
            Show(L.F("{0} silindi.", t.Name), InfoBarSeverity.Success);
            await ShowScheduledTasks();
        });
        Grid.SetColumn(del, 6); row.Children.Add(del);
        return row;
    }

    // ---- create / edit ----

    private async Task EditScheduledTask(ScheduledTask? existing, ScheduledTaskDraft? start = null, string? startError = null)
    {
        if (ScheduledCredentials() is not { } creds) return;
        var draft = start ?? (existing is null ? new ScheduledTaskDraft() : ScheduledTaskDraft.From(existing));

        // Targets: agent devices of the workspace, then this computer's saved SSH hosts.
        var centerId = App.Current.Me?.CenterId;
        if (string.IsNullOrEmpty(centerId))
        {
            try { centerId = (await creds.Gateway.MeAsync(creds.Token)).CenterId; } catch (GatewayException) { }
        }
        var devices = App.Current.Devices.ToList();
        if (devices.Count == 0)
        {
            try { devices = await creds.Gateway.DevicesAsync(creds.Token); } catch (GatewayException) { }
        }
        var targets = new List<(string Label, TaskTarget Target)>();
        foreach (var d in devices.OrderBy(d => d.Name, StringComparer.CurrentCultureIgnoreCase))
            targets.Add((L.F("Cihaz: {0}", d.Name), TaskTarget.Device(d.Id)));
        if (!string.IsNullOrEmpty(centerId))
            foreach (var h in _c.Hosts.Where(h => h.IsSsh).OrderBy(h => h.Label, StringComparer.CurrentCultureIgnoreCase))
                targets.Add((L.F("Sunucu (SSH): {0}", h.Label), TaskTarget.Ssh(centerId!, h.Id, h.Label)));
        if (draft.Target is { } current && !targets.Any(x => x.Target.SameAs(current)))
            targets.Insert(0, (TargetLabel(current), current));

        var name = new TextBox { Header = L.T("Ad"), Text = draft.Name, MaxLength = 80, PlaceholderText = L.T("Gece yedeği") };
        var description = new TextBox { Header = L.T("Açıklama (isteğe bağlı)"), Text = draft.Description ?? "" };
        var target = new ComboBox
        {
            Header = L.T("Hedef"),
            ItemsSource = targets.Select(x => x.Label).ToList(),
            SelectedIndex = draft.Target is { } t0 ? targets.FindIndex(x => x.Target.SameAs(t0)) : (targets.Count > 0 ? 0 : -1),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            PlaceholderText = targets.Count == 0 ? L.T("Hedef yok: önce bir cihaz bağla ya da sunucu ekle") : "",
        };
        var targetHint = new TextBlock { Foreground = Secondary, FontSize = 12, TextWrapping = TextWrapping.Wrap };
        var command = new TextBox
        {
            Header = L.T("Komut"),
            Text = draft.Command,
            AcceptsReturn = true,
            Height = 110,
            MaxLength = 4000,
            FontFamily = MonoFont,
            TextWrapping = TextWrapping.Wrap,
            PlaceholderText = "/usr/local/bin/backup.sh",
        };

        var form = ScheduleText.Form(draft.Schedule);
        var mode = new ComboBox
        {
            Header = L.T("Zamanlama"),
            ItemsSource = new List<string> { L.T("Her gün saat …"), L.T("Her hafta …"), L.T("Her N dakikada bir"), L.T("Bir kez …"), L.T("Gelişmiş: cron") },
            SelectedIndex = form.Mode,
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        var time = new TimePicker { Header = L.T("Saat"), ClockIdentifier = "24HourClock", Time = form.Time };
        var day = new ComboBox
        {
            Header = L.T("Gün"),
            ItemsSource = ScheduleText.WeekOrder.Select(ScheduleText.Day).ToList(),
            SelectedIndex = Array.IndexOf(ScheduleText.WeekOrder, form.Day),
            MinWidth = 200,
        };
        var minutes = new NumberBox { Header = L.T("Kaç dakikada bir (5–10080)"), Value = form.Minutes, Minimum = 5, Maximum = 10080, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Inline, Width = 240, HorizontalAlignment = HorizontalAlignment.Left };
        var onceLocal = form.At is { } at ? TimeZoneInfo.ConvertTime(at, TimeZoneInfo.Local) : DateTimeOffset.Now.AddHours(1);
        var onceDate = new DatePicker { Header = L.T("Tarih"), Date = onceLocal };
        var onceTime = new TimePicker { Header = L.T("Saat"), ClockIdentifier = "24HourClock", Time = new TimeSpan(onceLocal.Hour, onceLocal.Minute, 0) };
        var cron = new TextBox { Header = L.T("Cron ifadesi (dakika saat gün ay haftanın günü)"), Text = form.Expr, FontFamily = MonoFont, PlaceholderText = "0 3 * * *" };
        var timezone = new TextBox { Header = L.T("Saat dilimi (IANA, ör. Europe/Istanbul)"), Text = draft.Timezone };
        var previewTitle = new TextBlock { Text = L.T("Sonraki 5 çalışma (bu bilgisayarın saatiyle)"), Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] };
        var preview = new TextBlock { FontFamily = MonoFont, FontSize = 12, Foreground = Secondary, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
        var timeout = new NumberBox { Header = L.T("Zaman aşımı (saniye, 10–3600)"), Value = draft.TimeoutSec, Minimum = 10, Maximum = 3600, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Inline, Width = 240, HorizontalAlignment = HorizontalAlignment.Left };
        var notify = new ComboBox
        {
            Header = L.T("Bildirim (e-posta ve uygulama içi)"),
            ItemsSource = ScheduleText.NotifyValues.Select(ScheduleText.NotifyLabel).ToList(),
            SelectedIndex = Math.Max(0, Array.IndexOf(ScheduleText.NotifyValues, draft.Notify)),
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        var enabled = new CheckBox { Content = L.T("Etkin (zamanı gelince çalışsın)"), IsChecked = draft.Enabled };
        var error = new TextBlock { Text = startError ?? "", Foreground = new SolidColorBrush(Microsoft.UI.Colors.IndianRed), TextWrapping = TextWrapping.Wrap };

        TaskSchedule CurrentSchedule()
        {
            var clock = new TimeSpan(time.Time.Hours, time.Time.Minutes, 0);
            switch (mode.SelectedIndex)
            {
                case 0: return TaskSchedule.Daily(clock);
                case 1: return TaskSchedule.Weekly(ScheduleText.WeekOrder[Math.Max(0, day.SelectedIndex)], clock);
                case 2: return TaskSchedule.Interval((int)Num(minutes));
                case 3:
                    var local = onceDate.Date.Date + new TimeSpan(onceTime.Time.Hours, onceTime.Time.Minutes, 0);
                    return TaskSchedule.Once(new DateTimeOffset(local, TimeZoneInfo.Local.GetUtcOffset(local)));
                default: return TaskSchedule.Cron(cron.Text ?? "");
            }
        }

        void SyncVisibility()
        {
            var m = mode.SelectedIndex;
            time.Visibility = m is 0 or 1 ? Visibility.Visible : Visibility.Collapsed;
            day.Visibility = m == 1 ? Visibility.Visible : Visibility.Collapsed;
            minutes.Visibility = m == 2 ? Visibility.Visible : Visibility.Collapsed;
            onceDate.Visibility = onceTime.Visibility = m == 3 ? Visibility.Visible : Visibility.Collapsed;
            cron.Visibility = m == 4 ? Visibility.Visible : Visibility.Collapsed;
            var chosen = target.SelectedIndex >= 0 && target.SelectedIndex < targets.Count ? targets[target.SelectedIndex].Target : null;
            targetHint.Text = chosen is null ? ""
                : chosen.IsSsh
                    ? L.T("Kayıtlı SSH sunucusundaki görevi bu bilgisayardaki uygulama çalıştırır: o sırada uygulama açık ve oturumu açık olmalı, sunucuya parola sorulmadan bağlanabilmeli. 15 dakika içinde çalıştırılamazsa Kaçırıldı sayılır.")
                    : L.T("Görevi cihazdaki ajan çalıştırır (bilgisayarın kapalı olsa da). Ajanın kendi kuralları (kısıtlı mod, izin listesi) yine geçerlidir; cihaz o sırada çevrimdışıysa Kaçırıldı sayılır.");
        }

        // The live preview asks the server (it knows cron and time zones); a short pause after typing.
        var previewTimer = DispatcherQueue.CreateTimer();
        previewTimer.Interval = TimeSpan.FromMilliseconds(500);
        previewTimer.IsRepeating = false;
        var previewSeq = 0;
        previewTimer.Tick += async (_, _) =>
        {
            var seq = ++previewSeq;
            var schedule = CurrentSchedule();
            var words = ScheduleText.Describe(schedule);
            if (schedule.Kind == "cron" && !Cron.LooksValid(schedule.Expr))
            {
                preview.Text = L.T("Cron ifadesi beş alandan oluşmalı (dakika saat gün ay haftanın günü).");
                return;
            }
            preview.Text = words + "\n" + L.T("Hesaplanıyor…");
            try
            {
                var next = await creds.Gateway.PreviewScheduleAsync(creds.Token, schedule, (timezone.Text ?? "").Trim());
                if (seq != previewSeq) return;
                preview.Text = next.Count == 0
                    ? words + "\n" + L.T("Bu zamanlamayla bir daha çalışmaz.")
                    : words + "\n" + string.Join("\n", next.Select(n => ScheduleText.LocalTime(n)));
            }
            catch (GatewayException e)
            {
                if (seq != previewSeq) return;
                preview.Text = e.Status == 400
                    ? L.T("Zamanlama geçersiz: ") + (e.ServerMessage ?? e.Message)
                    : ScheduledError(e);
            }
            catch (Exception e) { App.LogCrash(e); }
        };
        void Changed() { previewTimer.Stop(); previewTimer.Start(); }
        mode.SelectionChanged += (_, _) => { SyncVisibility(); Changed(); };
        target.SelectionChanged += (_, _) => SyncVisibility();
        time.TimeChanged += (_, _) => Changed();
        day.SelectionChanged += (_, _) => Changed();
        minutes.ValueChanged += (_, _) => Changed();
        onceDate.DateChanged += (_, _) => Changed();
        onceTime.TimeChanged += (_, _) => Changed();
        cron.TextChanged += (_, _) => Changed();
        timezone.TextChanged += (_, _) => Changed();
        SyncVisibility();
        Changed();

        var when = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        foreach (var e in new UIElement[] { day, time, minutes, onceDate, onceTime }) when.Children.Add(e);
        var panel = new StackPanel { Spacing = 10, MinWidth = 460 };
        foreach (var e in new UIElement[] { name, description, target, targetHint, command, mode, when, cron, timezone, previewTitle, preview, timeout, notify, enabled, error })
            panel.Children.Add(e);

        ScheduledTaskDraft? result = null;
        var dialog = Dialog(existing is null ? L.T("Yeni zamanlanmış görev") : L.T("Zamanlanmış görevi düzenle"), new ScrollViewer { Content = panel, MaxHeight = 620 }, L.T("Devam"));
        dialog.PrimaryButtonClick += (_, args) =>
        {
            var chosen = target.SelectedIndex >= 0 && target.SelectedIndex < targets.Count ? targets[target.SelectedIndex].Target : null;
            var next = new ScheduledTaskDraft
            {
                Name = name.Text ?? "",
                Description = description.Text,
                Target = chosen,
                Command = command.Text ?? "",
                Schedule = CurrentSchedule(),
                Timezone = string.IsNullOrWhiteSpace(timezone.Text) ? ScheduleText.DefaultTimeZone() : timezone.Text.Trim(),
                Enabled = enabled.IsChecked == true,
                TimeoutSec = (int)Num(timeout),
                Notify = ScheduleText.NotifyValues[Math.Max(0, notify.SelectedIndex)],
            };
            if (next.Validate(DateTimeOffset.UtcNow) is { } problem)
            {
                error.Text = problem;
                args.Cancel = true;
                return;
            }
            result = next;
        };
        var answer = await ShowDialog(dialog);
        previewTimer.Stop();
        if (answer != ContentDialogResult.Primary || result is null) return;
        await ConfirmAndSaveScheduledTask(existing, result);
    }

    /// <summary>Shows the exact command and target before anything is saved; on a server error the editor opens again with the same fields.</summary>
    private async Task ConfirmAndSaveScheduledTask(ScheduledTask? existing, ScheduledTaskDraft draft)
    {
        var panel = new StackPanel { Spacing = 10, MaxWidth = 520 };
        panel.Children.Add(new TextBlock
        {
            Text = L.T("Bu komut aşağıdaki hedefte, zamanı geldikçe her seferinde onay sorulmadan çalışacak. Kaydetmeden önce kontrol et."),
            TextWrapping = TextWrapping.Wrap,
        });
        panel.Children.Add(new TextBlock { Text = L.F("Hedef: {0}", TargetLabel(draft.Target!)), TextWrapping = TextWrapping.Wrap, Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"] });
        panel.Children.Add(new TextBlock { Text = L.F("Zamanlama: {0} ({1})", ScheduleText.Describe(draft.Schedule), draft.Timezone), TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = L.T("Komut:"), Foreground = Secondary });
        panel.Children.Add(new Border
        {
            Padding = new Thickness(10),
            CornerRadius = new CornerRadius(6),
            Background = (Brush)Application.Current.Resources["CardBackgroundFillColorSecondaryBrush"],
            Child = new TextBlock { Text = draft.Command, FontFamily = MonoFont, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true },
        });
        panel.Children.Add(new TextBlock { Text = L.F("Zaman aşımı: {0} sn · {1}", draft.TimeoutSec, ScheduleText.NotifyLabel(draft.Notify)), Foreground = Secondary, FontSize = 12 });
        if (!draft.Enabled)
            panel.Children.Add(new TextBlock { Text = L.T("Görev kapalı kaydedilecek; açana kadar zamanında çalışmaz."), Foreground = Secondary, FontSize = 12, TextWrapping = TextWrapping.Wrap });
        var dialog = Dialog(L.T("Komutu onayla"), panel, existing is null ? L.T("Oluştur") : L.T("Kaydet"), L.T("Geri dön"));
        var answer = await ShowDialog(dialog);
        if (answer != ContentDialogResult.Primary)
        {
            // "Geri dön": back to the editor with what was typed.
            if (answer == ContentDialogResult.None) await EditScheduledTask(existing, draft);
            return;
        }
        if (ScheduledCredentials() is not { } c) return;
        try
        {
            if (existing is null) await c.Gateway.CreateScheduledTaskAsync(c.Token, draft);
            else await c.Gateway.UpdateScheduledTaskAsync(c.Token, existing.Id, draft.ToJson());
        }
        catch (GatewayException e) when (e.Status != 403 && e.Kind != GatewayErrorKind.Unauthorized)
        {
            await EditScheduledTask(existing, draft, ScheduledError(e));
            return;
        }
        Show(existing is null ? L.F("{0} oluşturuldu.", draft.Name.Trim()) : L.F("{0} kaydedildi.", draft.Name.Trim()), InfoBarSeverity.Success);
        await ShowScheduledTasks();
    }

    // ---- runs ----

    private async Task ShowScheduledRuns(ScheduledTask t)
    {
        if (ScheduledCredentials() is not { } c) return;
        var runs = await c.Gateway.ScheduledTaskRunsAsync(c.Token, t.Id);
        var output = new TextBox
        {
            IsReadOnly = true,
            AcceptsReturn = true,
            TextWrapping = TextWrapping.NoWrap,
            FontFamily = MonoFont,
            FontSize = 12,
            Height = 260,
        };
        ScrollViewer.SetHorizontalScrollBarVisibility(output, ScrollBarVisibility.Auto);
        ScrollViewer.SetVerticalScrollBarVisibility(output, ScrollBarVisibility.Auto);
        var list = new ListView { SelectionMode = ListViewSelectionMode.Single, MaxHeight = 220 };
        foreach (var r in runs)
        {
            var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
            line.Children.Add(RunBadge(r.Status));
            line.Children.Add(new TextBlock { Text = ScheduleText.LocalTime(r.StartedAt ?? r.ScheduledFor), VerticalAlignment = VerticalAlignment.Center });
            line.Children.Add(new TextBlock { Text = r.Trigger == "manual" ? L.T("Elle başlatıldı") : L.T("Zamanında"), Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
            if (r.ExitCode is { } code)
                line.Children.Add(new TextBlock { Text = L.F("çıkış kodu {0}", code), Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
            if (r.StartedAt is { } s && r.FinishedAt is { } f)
                line.Children.Add(new TextBlock { Text = L.F("{0} sn", Math.Max(0, (int)Math.Round((f - s).TotalSeconds))), Foreground = Secondary, VerticalAlignment = VerticalAlignment.Center });
            list.Items.Add(line);
        }
        string Details(TaskRun r)
        {
            var parts = new List<string>();
            if (!string.IsNullOrWhiteSpace(r.Error)) parts.Add(L.T("Hata: ") + r.Error);
            parts.Add(string.IsNullOrEmpty(r.Output) ? L.T("(çıktı yok)") : r.Output!);
            return string.Join("\n\n", parts);
        }
        list.SelectionChanged += (_, _) =>
        {
            if (list.SelectedIndex >= 0 && list.SelectedIndex < runs.Count) output.Text = Details(runs[list.SelectedIndex]);
        };
        var panel = new StackPanel { Spacing = 10, MinWidth = 540 };
        if (runs.Count == 0)
            panel.Children.Add(new TextBlock { Text = L.T("Bu görev henüz hiç çalışmadı."), Foreground = Secondary });
        else
        {
            panel.Children.Add(list);
            panel.Children.Add(new TextBlock { Text = L.T("Çıktı (stdout ve stderr, en fazla 64 KiB, sonu tutulur)"), Foreground = Secondary, FontSize = 12 });
            panel.Children.Add(output);
            list.SelectedIndex = 0;
        }
        var dialog = new ContentDialog
        {
            Title = L.F("{0}: çalışma geçmişi", t.Name),
            Content = panel,
            CloseButtonText = L.T("Kapat"),
            DefaultButton = ContentDialogButton.Close,
            XamlRoot = Content.XamlRoot,
        };
        await ShowDialog(dialog);
    }
}
