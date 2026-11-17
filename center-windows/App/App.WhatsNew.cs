using Wecommander.Center.Core;

namespace Wecommander.Center;

/// <summary>
/// "Yenilikler" (what's new): once after an update the notes added since the
/// last one shown open in a small window; "Tamam" (or closing it) remembers
/// the newest. A fresh install only remembers the newest. The settings page
/// and the tray menu show every note. Nothing here may disturb the start.
/// </summary>
public partial class App
{
    /// <summary>settings.json was there at start (false: first start after installing).</summary>
    private bool _settingsExisted = true;
    private bool _whatsNewChecked;

    /// <summary>At start (not at sign-in) and when the main window opens: at most once per run.</summary>
    private void MaybeShowWhatsNew()
    {
        if (_whatsNewChecked) return;
        _whatsNewChecked = true;
        try
        {
            var notes = ReleaseNotes.For(ReleaseNotes.Embedded, ReleaseNotes.Windows);
            var decision = ReleaseNotes.AtStart(notes, Settings.LastSeenNotes, _settingsExisted);
            if (decision.Show.Count == 0)
            {
                if (decision.Remember is { } id) { Settings.LastSeenNotes = id; SaveSettings(); }
                return;
            }
            var remember = decision.Remember;
            // After the windows of the start are up, so it opens in front of them.
            _ui.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () =>
            {
                try
                {
                    WhatsNewWindow.Show(decision.Show, () =>
                    {
                        if (remember is null) return;
                        Settings.LastSeenNotes = remember;
                        SaveSettings();
                    });
                }
                catch (Exception e) { LogCrash(e); }
            });
        }
        catch (Exception e) { LogCrash(e); }
    }

    /// <summary>"Yenilikler" in the settings page and the tray menu: every note for Windows.</summary>
    public void ShowWhatsNew()
    {
        try
        {
            var notes = ReleaseNotes.For(ReleaseNotes.Embedded, ReleaseNotes.Windows);
            WhatsNewWindow.Show(notes, () =>
            {
                if (notes.Count == 0 || Settings.LastSeenNotes == notes[0].Id) return;
                Settings.LastSeenNotes = notes[0].Id;
                SaveSettings();
            });
        }
        catch (Exception e) { LogCrash(e); }
    }
}
