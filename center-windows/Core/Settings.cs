using System.Text.Json;
using System.Text.Json.Serialization;

namespace Wecommander.Center.Core;

public sealed class Settings
{
    public const string DefaultServer = "https://wecommander.app";

    [JsonPropertyName("server")] public string Server { get; set; } = DefaultServer;
    /// <summary>Windows notification with Approve/Deny for each new request.</summary>
    [JsonPropertyName("notifications")] public bool Notifications { get; set; } = true;
    /// <summary>
    /// The one-time "notifications are ready" message was shown. Windows 11
    /// asks whether to allow an app's notifications on its first one; until
    /// the owner answers, approvals would only reach the notification center.
    /// </summary>
    [JsonPropertyName("notificationIntroShown")] public bool NotificationIntroShown { get; set; }
    /// <summary>
    /// Also open the full panel when a new request arrives. Off by default: the
    /// small Windows notification is enough (owner decision 2026-11-07). The
    /// JSON name changed from "openOnRequest" so earlier installs, where this
    /// was on, start with it off. The panel still opens when Windows blocks
    /// our notifications or the owner turned them off, since otherwise the
    /// request would not be seen at all.
    /// </summary>
    [JsonPropertyName("openPanelOnRequest")] public bool OpenOnRequest { get; set; }
    /// <summary>
    /// "Ajan çalışsın": keep the agent on this computer running, restarting it
    /// when it stops. Switched off, the agent is stopped and stays off.
    /// </summary>
    [JsonPropertyName("agentKeepRunning")] public bool AgentKeepRunning { get; set; } = true;
    /// <summary>
    /// The one UAC prompt that removes an earlier, separately installed agent
    /// (scheduled task, service, Program Files setup) was already shown.
    /// </summary>
    [JsonPropertyName("legacyCleanupPrompted")] public bool LegacyCleanupPrompted { get; set; }
    /// <summary>Terminal text size in points (8–32).</summary>
    [JsonPropertyName("terminalFontSize")] public int TerminalFontSize { get; set; } = 13;
    /// <summary>"dark" or "light".</summary>
    [JsonPropertyName("terminalTheme")] public string TerminalTheme { get; set; } = "dark";
    /// <summary>Saved hosts watched from the taskbar (live icon and panel).</summary>
    [JsonPropertyName("watchedHosts")] public List<string> WatchedHosts { get; set; } = [];
    /// <summary>The owner picked what the taskbar monitor watches (until then it watches the first saved servers by itself).</summary>
    [JsonPropertyName("watchChosen")] public bool WatchChosen { get; set; }
    /// <summary>The server box at the bottom left of the screen, above the taskbar.</summary>
    [JsonPropertyName("deskChip")] public bool DeskChip { get; set; } = true;
    /// <summary>The Management Center icon was put next to the clock once (later the person decides).</summary>
    [JsonPropertyName("trayShown")] public bool TrayShown { get; set; }
    /// <summary>On: in front of every window. Off: only on the desktop (behind the windows).</summary>
    [JsonPropertyName("deskChipOnTop")] public bool DeskChipOnTop { get; set; } = true;
    /// <summary>Hidden while a full-screen app (game, video, presentation) runs.</summary>
    /// <summary>The box's meters: live line charts (true) or bars (false); a click on them switches.</summary>
    [JsonPropertyName("deskChipLine")] public bool DeskChipLine { get; set; } = true;
    [JsonPropertyName("deskChipHideFullscreen")] public bool DeskChipHideFullscreen { get; set; } = true;
    /// <summary>Where the owner dragged it: from the left and from the bottom of the work area (96-dpi pixels); null: the bottom left corner.</summary>
    [JsonPropertyName("deskChipLeft")] public int? DeskChipLeft { get; set; }
    [JsonPropertyName("deskChipBottom")] public int? DeskChipBottom { get; set; }

    /// <summary>Interface language ("en", "tr", "de", "pt-BR", "es", "fr"); null: the Windows display language.</summary>
    [JsonPropertyName("language")] public string? Language { get; set; }

    // ---- WECOMMANDER Dock (off until the owner turns it on) ----
    [JsonPropertyName("dock")] public bool Dock { get; set; }
    /// <summary>"fixed" (takes its strip from the work area), "autohide" or "floating".</summary>
    [JsonPropertyName("dockMode")] public string DockModeName { get; set; } = "fixed";
    /// <summary>"top", "bottom", "left" or "right".</summary>
    [JsonPropertyName("dockEdge")] public string DockEdgeName { get; set; } = "top";
    /// <summary>The monitor's device name (\\.\DISPLAY2); null or gone: the primary monitor.</summary>
    [JsonPropertyName("dockMonitor")] public string? DockMonitor { get; set; }
    [JsonPropertyName("dockCompact")] public bool DockCompact { get; set; }
    /// <summary>Floating: where it was left, from the top left of that monitor's work area (96-dpi pixels).</summary>
    [JsonPropertyName("dockFloatX")] public int? DockFloatX { get; set; }
    [JsonPropertyName("dockFloatY")] public int? DockFloatY { get; set; }
    /// <summary>Floating: in front of every window.</summary>
    [JsonPropertyName("dockOnTop")] public bool DockOnTop { get; set; } = true;
    /// <summary>Out of the way while a full-screen app or game runs.</summary>
    [JsonPropertyName("dockHideFullscreen")] public bool DockHideFullscreen { get; set; } = true;
    /// <summary>Auto-hide: how long the mouse rests at the edge before it comes out, and how long after leaving before it hides (ms).</summary>
    [JsonPropertyName("dockShowDelay")] public int DockShowDelay { get; set; } = 150;
    [JsonPropertyName("dockHideDelay")] public int DockHideDelay { get; set; } = 700;
    /// <summary>"system", "dark" or "light".</summary>
    [JsonPropertyName("dockTheme")] public string DockTheme { get; set; } = "system";
    /// <summary>The order of the Dock's parts and the ones turned off.</summary>
    [JsonPropertyName("dockModules")] public List<string> DockModules { get; set; } = [];
    [JsonPropertyName("dockHiddenModules")] public List<string> DockHiddenModules { get; set; } = [];
    /// <summary>The watched server shown in the Dock (null: the busiest).</summary>
    [JsonPropertyName("dockServer")] public string? DockServer { get; set; }
    /// <summary>Like a locked Windows taskbar: the Dock is not moved and its buttons are not reordered by dragging.</summary>
    [JsonPropertyName("dockLocked")] public bool DockLocked { get; set; } = true;
    /// <summary>
    /// "dock": with the Dock on, its buttons open drop-down panels anchored to it
    /// (no separate windows); "classic": they open the windows as before.
    /// </summary>
    [JsonPropertyName("appMode")] public string AppMode { get; set; } = AppModes.Dock;
    /// <summary>The newest "Yenilikler" entry already shown (ReleaseNotes); null: none yet.</summary>
    [JsonPropertyName("lastSeenNotes")] public string? LastSeenNotes { get; set; }
    /// <summary>The getting-started tutorial: its step (0 not started yet, see <see cref="Tutorial"/>) and whether it is turned off.</summary>
    [JsonPropertyName("tutorialStep")] public int TutorialStep { get; set; }
    [JsonPropertyName("tutorialOff")] public bool TutorialOff { get; set; }
}

public sealed class SettingsStore(string directory)
{
    private string FilePath => Path.Combine(directory, "settings.json");

    /// <summary>The settings, and whether they existed (first run enables autostart).</summary>
    public (Settings Settings, bool Existed) Load()
    {
        try
        {
            var loaded = JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath));
            return (loaded ?? new Settings(), true);
        }
        catch (FileNotFoundException) { return (new Settings(), false); }
        catch (DirectoryNotFoundException) { return (new Settings(), false); }
        catch (JsonException) { return (new Settings(), true); }
    }

    public void Save(Settings settings)
    {
        Directory.CreateDirectory(directory);
        var json = JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true });
        // Another program (antivirus, backup, search indexer, a test reading the
        // file) can hold settings.json open for a moment: the replace then fails
        // with "access denied". Retry briefly; never lose the change.
        Exception? last = null;
        for (var attempt = 0; attempt < 6; attempt++)
        {
            var tmp = FilePath + "." + Environment.ProcessId + "." + attempt + ".tmp";
            try
            {
                File.WriteAllText(tmp, json);
                File.Move(tmp, FilePath, overwrite: true);
                return;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                last = e;
                try { File.Delete(tmp); } catch (Exception) { }
                Thread.Sleep(40 * (attempt + 1));
            }
        }
        // Last resort: write in place (not atomic, but the setting is kept).
        try { File.WriteAllText(FilePath, json); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException) { throw last ?? e; }
    }
}
