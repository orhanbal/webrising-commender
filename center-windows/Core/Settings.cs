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
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, FilePath, overwrite: true);
    }
}
