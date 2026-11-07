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
