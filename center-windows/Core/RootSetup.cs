namespace Wecommander.Center.Core;

/// <summary>
/// The machine-side key of "run as root" (docs/AI_PERMISSIONS.md) from the
/// app: a new terminal to a saved Linux host runs one fixed command, and the
/// person types their own sudo password there. Nothing of the host or the
/// person is put into the command, and the app never sees the password. The
/// web panel's switch (the admin's password) stays the second key.
/// </summary>
public static class RootSetup
{
    private const string Installed = "/opt/wecommander/libexec/install-linux.sh";

    /// <summary>Allows root on the machine: the installed agent's script, else the online installer.</summary>
    public const string AllowCommand =
        "if [ -f " + Installed + " ]; then sudo bash " + Installed + " --allow-root; " +
        "else curl -fsSL https://wecommander.app/install.sh | sh -s -- --allow-root; fi";

    /// <summary>Takes it back (removes the sudoers drop-in, restores the unit hardening).</summary>
    public const string DisallowCommand =
        "if [ -f " + Installed + " ]; then sudo bash " + Installed + " --disallow-root; " +
        "else curl -fsSL https://wecommander.app/install.sh | sh -s -- --disallow-root; fi";

    public static string Command(bool allow) => allow ? AllowCommand : DisallowCommand;

    /// <summary>Hosts with a shell the command can be typed into (SSH and Mosh).</summary>
    public static bool Applies(CoreHost host) => host.IsSsh;

    /// <summary>
    /// The agent device on that server, when exactly one Linux device's name
    /// is the host's address, its short name or its label (case ignored).
    /// </summary>
    public static string? MatchDevice(CoreHost host, IEnumerable<Device> devices)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var n in new[] { host.Host, host.Label })
        {
            if (string.IsNullOrWhiteSpace(n)) continue;
            names.Add(n.Trim());
            var dot = n.Trim().IndexOf('.');
            if (dot > 0 && !char.IsDigit(n.Trim()[0])) names.Add(n.Trim()[..dot]);
        }
        var found = devices
            .Where(d => d.RevokedAt is null && (d.Platform ?? "").Contains("linux", StringComparison.OrdinalIgnoreCase))
            .Where(d => names.Contains(d.Name.Trim()))
            .Select(d => d.Id)
            .Distinct()
            .ToList();
        return found.Count == 1 ? found[0] : null;
    }

    /// <summary>The web page where an admin turns root on: the device's permissions, else the device list.</summary>
    public static string PermissionsUrl(string server, string? deviceId) =>
        server.TrimEnd('/') + (deviceId is null ? "/devices" : "/devices?permissions=" + Uri.EscapeDataString(deviceId));
}
