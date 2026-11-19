import Foundation

/// The machine-side key of "run as root" (docs/AI_PERMISSIONS.md) from the
/// app: a new terminal to a saved Linux host runs one fixed command, and the
/// person types their own sudo password there. Nothing of the host or the
/// person is put into the command, and the app never sees the password. The
/// web panel's switch (the admin's password) stays the second key. Same as
/// the Windows app (center-windows/Core/RootSetup.cs).
public enum RootSetup {
    private static let installed = "/opt/wecommander/libexec/install-linux.sh"

    /// Allows root on the machine: the installed agent's script, else the online installer.
    public static let allowCommand =
        "if [ -f \(installed) ]; then sudo bash \(installed) --allow-root; "
        + "else curl -fsSL https://wecommander.app/install.sh | sh -s -- --allow-root; fi"

    /// Takes it back (removes the sudoers drop-in, restores the unit hardening).
    public static let disallowCommand =
        "if [ -f \(installed) ]; then sudo bash \(installed) --disallow-root; "
        + "else curl -fsSL https://wecommander.app/install.sh | sh -s -- --disallow-root; fi"

    public static func command(allow: Bool) -> String { allow ? allowCommand : disallowCommand }

    /// Hosts with a shell the command can be typed into (SSH and Mosh).
    public static func applies(_ host: CoreHost) -> Bool { host.isSsh }

    /// The agent device on that server, when exactly one Linux device's name
    /// is the host's address, its short name or its label (case ignored).
    public static func matchDevice(_ host: CoreHost, in devices: [Device]) -> String? {
        var names = Set<String>()
        for raw in [host.host, host.label] {
            let n = (raw ?? "").trimmingCharacters(in: .whitespaces)
            guard !n.isEmpty else { continue }
            names.insert(n.lowercased())
            if let dot = n.firstIndex(of: "."), dot != n.startIndex, !(n.first?.isNumber ?? false) {
                names.insert(String(n[..<dot]).lowercased())
            }
        }
        let found = Set(devices
            .filter { $0.revokedAt == nil && ($0.platform ?? "").lowercased().contains("linux") }
            .filter { names.contains($0.name.trimmingCharacters(in: .whitespaces).lowercased()) }
            .map(\.id))
        return found.count == 1 ? found.first : nil
    }

    /// The web page where an admin turns root on: the device's permissions, else the device list.
    public static func permissionsURL(server: String, deviceId: String?) -> String {
        var base = server
        while base.hasSuffix("/") { base.removeLast() }
        guard let deviceId else { return base + "/devices" }
        let escaped = deviceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? deviceId
        return base + "/devices?permissions=" + escaped
    }
}
