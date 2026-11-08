import Foundation

public struct CenterSettings: Codable, Equatable {
    public static let defaultServer = "https://wecommander.app"

    public var server: String = CenterSettings.defaultServer
    /// macOS notification with Onayla / Reddet for each new request.
    public var notifications: Bool = true
    /// The one-time "notifications are ready" notification was shown; it makes
    /// macOS ask for permission right after sign-in.
    public var notificationIntroShown: Bool = false
    /// Also open the panel when a new request arrives. Off by default: the
    /// notification is enough. The panel still opens when notifications can
    /// not be shown (denied in macOS or turned off here).
    public var openPanelOnRequest: Bool = false
    /// "Ajan çalışsın": keep the agent on this Mac running, starting it again
    /// when it stops. Switched off, the agent is stopped and stays off.
    public var agentKeepRunning: Bool = true

    public init() {}

    enum CodingKeys: String, CodingKey { case server, notifications, notificationIntroShown, openPanelOnRequest, agentKeepRunning }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        server = try c.decodeIfPresent(String.self, forKey: .server) ?? CenterSettings.defaultServer
        notifications = try c.decodeIfPresent(Bool.self, forKey: .notifications) ?? true
        notificationIntroShown = try c.decodeIfPresent(Bool.self, forKey: .notificationIntroShown) ?? false
        openPanelOnRequest = try c.decodeIfPresent(Bool.self, forKey: .openPanelOnRequest) ?? false
        agentKeepRunning = try c.decodeIfPresent(Bool.self, forKey: .agentKeepRunning) ?? true
    }
}

public struct SettingsStore {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }

    private var file: URL { directory.appendingPathComponent("settings.json") }

    /// The settings, and whether they existed (first run enables start at login).
    public func load() -> (settings: CenterSettings, existed: Bool) {
        guard let data = try? Data(contentsOf: file) else { return (CenterSettings(), false) }
        return ((try? JSONDecoder().decode(CenterSettings.self, from: data)) ?? CenterSettings(), true)
    }

    public func save(_ settings: CenterSettings) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(settings).write(to: file, options: .atomic)
    }

    /// ~/Library/Application Support/WECOMMANDER Center
    public static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("WECOMMANDER Center", isDirectory: true)
    }
}
