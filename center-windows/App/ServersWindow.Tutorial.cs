using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// The getting-started tutorial in the main window (see <see cref="Tutorial"/>):
/// add the first server, connect, the live status on the Dock, AI (optional),
/// done. Each step points at the control to use with <see cref="Coach"/>.
/// </summary>
public sealed partial class ServersWindow
{
    private Coach? _coach;
    private Button? _newHostButton;
    private FrameworkElement? _firstHostCard;
    private int _shownStep = -1;
    private int _tutorialTicket;

    private static int TutorialStep
    {
        get => App.Current.Settings.TutorialStep;
        set
        {
            if (App.Current.Settings.TutorialStep == value) return;
            App.Current.Settings.TutorialStep = value;
            App.Current.SaveSettings();
        }
    }

    /// <summary>After the page settles (the target must be on screen to point at it).</summary>
    private void TutorialSoon()
    {
        // Only the latest request runs (one made before the window was shown must not swallow later ones).
        var ticket = ++_tutorialTicket;
        DispatcherQueue.TryEnqueue(DispatcherQueuePriority.Low, async () =>
        {
            await Task.Delay(400);
            if (ticket != _tutorialTicket) return;
            try { TutorialShow(); } catch (Exception e) { App.LogCrash(e); }
        });
    }

    private void TutorialTerminalOpened()
    {
        var next = Tutorial.TerminalOpened(Tutorial.Current(TutorialStep, App.Current.Settings.TutorialOff, _c.Hosts.Count));
        if (next != TutorialStep) { TutorialStep = next; TutorialSoon(); }
    }

    private void TutorialShow()
    {
        if (_coach is null || !AppWindow.IsVisible) { App.DebugLayout("tutorial: window not shown yet"); return; }
        var settings = App.Current.Settings;
        // CI walks the window with UI Automation, which the tip's popup gets in the way of.
        if (Environment.GetEnvironmentVariable("WECOMMANDER_NO_TUTORIAL") == "1") { _coach.Hide(); return; }
        var step = Tutorial.Current(TutorialStep, settings.TutorialOff, _c.Hosts.Count);
        TutorialStep = step;
        var target = step switch
        {
            Tutorial.AddServer => Visible(_newHostButton),
            Tutorial.Connect => Visible(_firstHostCard),
            Tutorial.Ai => Visible(_nav.MenuItems.OfType<NavigationViewItem>().FirstOrDefault(i => i.Tag as string == "ai")),
            _ => null,
        };
        // The first two steps point at things on the Servers page: shown when it is on screen.
        App.DebugLayout($"tutorial: step {step}, target {(target is null ? "none" : target.GetType().Name)}");
        if (step is Tutorial.AddServer or Tutorial.Connect && target is null) { _coach.Hide(); _shownStep = -1; return; }
        if (step == _shownStep && _coach.IsShown) return;
        _shownStep = step;
        if (step != Tutorial.Status) App.Current.DockTutorialRing(false);

        void Next() { TutorialStep = Tutorial.Next(Tutorial.Current(TutorialStep, settings.TutorialOff, _c.Hosts.Count)); App.Current.DockTutorialRing(false); TutorialSoon(); }
        void Off()
        {
            settings.TutorialOff = true;
            TutorialStep = Tutorial.Done;
            App.Current.DockTutorialRing(false);
            Show(L.T("Öğretici kapandı. Ayarlar'dan yeniden açabilirsin."), InfoBarSeverity.Informational);
        }

        switch (step)
        {
            case Tutorial.AddServer:
                _coach.Show(target, L.T("İlk sunucunu ekleyelim"),
                    L.T("\"Yeni sunucu\"ya bas; adresini ve giriş bilgini yaz, gerisini WECOMMANDER halleder."), null, null, Next, Off);
                break;
            case Tutorial.Connect:
                _coach.Show(target, L.T("Şimdi bağlan"), L.T("Sunucuya tıkla; terminal yeni sekmede açılır."), null, null, Next, Off);
                break;
            case Tutorial.Status:
                var onDock = App.Current.DockTutorialRing(true);
                _coach.Show(null, onDock ? L.T("Sunucunun durumu Dock'ta") : L.T("Sunucunun durumu"),
                    onDock
                        ? L.T("Ekranın kenarındaki Dock işlemci, bellek ve disk durumunu canlı gösterir; Görev Yöneticisi, Görevler ve Terminal oradan açılır.")
                        : L.T("Bildirim alanındaki WECOMMANDER simgesi sunucunun işlemci, bellek ve disk durumunu canlı gösterir; tıklayınca ayrıntılar açılır."),
                    L.T("Tamam"), Next, Next, Off);
                break;
            case Tutorial.Ai:
                _coach.Show(target, L.T("İstersen yapay zekânı bağla"),
                    L.T("Claude, ChatGPT ya da Cursor'a sunucularını onayınla kullandırabilirsin. İstemezsen atla."),
                    L.T("Göster"), () => { Next(); Navigate("ai"); }, Next, Off);
                break;
            case Tutorial.Finish:
                _coach.Show(null, L.T("Hazırsın"), L.T("Öğreticiyi istediğin zaman Ayarlar'dan yeniden başlatabilirsin."), L.T("Bitir"), Next, Next, Off);
                break;
            default:
                _coach.Hide();
                App.Current.DockTutorialRing(false);
                break;
        }
    }

    private static FrameworkElement? Visible(FrameworkElement? e) =>
        e is { IsLoaded: true, Visibility: Visibility.Visible, ActualWidth: > 0 } ? e : null;

    /// <summary>Settings: show the tutorial or not; start it again.</summary>
    private IEnumerable<UIElement> TutorialSettings()
    {
        var settings = App.Current.Settings;
        var title = new TextBlock { Text = L.T("Öğretici"), Style = (Style)Application.Current.Resources["BodyStrongTextBlockStyle"], Margin = new Thickness(0, 8, 0, 0) };
        var show = new ToggleSwitch { Header = L.T("Öğreticiyi göster"), IsOn = !settings.TutorialOff };
        show.Toggled += (_, _) =>
        {
            settings.TutorialOff = !show.IsOn;
            if (show.IsOn && TutorialStep >= Tutorial.Done) TutorialStep = Tutorial.Restart(_c.Hosts.Count);
            App.Current.SaveSettings();
            if (!show.IsOn) { _coach?.Hide(); App.Current.DockTutorialRing(false); }
        };
        var again = new Button { Content = L.T("Baştan başlat") };
        again.Click += (_, _) =>
        {
            settings.TutorialOff = false;
            TutorialStep = Tutorial.Restart(_c.Hosts.Count);
            App.Current.SaveSettings();
            _shownStep = -1;
            Navigate("hosts");
        };
        return [title, show, again];
    }
}
