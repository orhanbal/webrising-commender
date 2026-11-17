using Microsoft.Win32;

namespace Wecommander.Center;

/// <summary>Windows 11's per-icon notification area settings (HKCU\Control Panel\NotifyIconSettings).</summary>
internal static class TrayIconSettings
{
    private const string Root = @"Control Panel\NotifyIconSettings";

    /// <summary>Marks this executable's icon as shown next to the clock; false when Windows has not listed it yet.</summary>
    public static bool Show(string exePath)
    {
        if (exePath.Length == 0) return false;
        using var root = Registry.CurrentUser.OpenSubKey(Root);
        if (root is null) return true; // Windows 10: icons are not hidden this way
        var found = false;
        foreach (var name in root.GetSubKeyNames())
        {
            using var key = Registry.CurrentUser.OpenSubKey($@"{Root}\{name}", writable: true);
            if (key?.GetValue("ExecutablePath") is not string path) continue;
            if (!string.Equals(Path.GetFullPath(path), Path.GetFullPath(exePath), StringComparison.OrdinalIgnoreCase)) continue;
            key.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
            found = true;
        }
        return found;
    }
}
