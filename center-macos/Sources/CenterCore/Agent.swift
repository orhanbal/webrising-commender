import Foundation

public enum AgentRunState: Equatable { case running, stopped, notInstalled }

public struct AgentStatus: Equatable {
    public let state: AgentRunState
    /// Not disabled in launchd (switched off here stays off at the next login).
    public let enabled: Bool
    public var running: Bool { state == .running }
    public init(state: AgentRunState, enabled: Bool) { self.state = state; self.enabled = enabled }
}

/// Runs a program and returns its exit status and standard output.
public protocol CommandRunning: Sendable {
    func run(_ path: String, _ arguments: [String]) async -> (status: Int32, output: String)
}

/// The WECOMMANDER agent on this Mac: the per-user LaunchAgent
/// tr.webrising.commender that scripts/install-macos.sh installs. Starting and
/// stopping it needs no administrator password.
public struct AgentControl: Sendable {
    public static let label = "tr.webrising.commender"
    public let uid: UInt32
    public let plistPath: String
    public let runner: CommandRunning
    public let plistExists: @Sendable () -> Bool

    public init(uid: UInt32, home: String, runner: CommandRunning,
                plistExists: (@Sendable () -> Bool)? = nil) {
        self.uid = uid
        self.plistPath = home + "/Library/LaunchAgents/\(AgentControl.label).plist"
        self.runner = runner
        let path = self.plistPath
        self.plistExists = plistExists ?? { FileManager.default.fileExists(atPath: path) }
    }

    private var domain: String { "gui/\(uid)" }
    private var service: String { "gui/\(uid)/\(AgentControl.label)" }
    private let launchctl = "/bin/launchctl"

    public func status() async -> AgentStatus {
        let installed = plistExists()
        let (code, printed) = await runner.run(launchctl, ["print", service])
        let (_, disabledList) = await runner.run(launchctl, ["print-disabled", domain])
        let enabled = !AgentControl.isDisabled(disabledList)
        if code == 0 && AgentControl.isRunning(printed) {
            return AgentStatus(state: .running, enabled: enabled)
        }
        return AgentStatus(state: installed || code == 0 ? .stopped : .notInstalled, enabled: enabled)
    }

    /// On: enable, load if needed, start. Off: disable (stays off at the next
    /// login) and unload (KeepAlive would otherwise start it again).
    public func setEnabled(_ on: Bool) async throws {
        if on {
            guard plistExists() else { throw AgentError(Texts.agentNotInstalled) }
            _ = await runner.run(launchctl, ["enable", service])
            let (loaded, _) = await runner.run(launchctl, ["print", service])
            if loaded != 0 {
                let (code, out) = await runner.run(launchctl, ["bootstrap", domain, plistPath])
                // 37 / "already loaded" is fine.
                if code != 0 && code != 37 && !out.contains("already") {
                    throw AgentError("Ajan yüklenemedi (launchctl \(code)).")
                }
            }
            let (code, _) = await runner.run(launchctl, ["kickstart", service])
            if code != 0 { throw AgentError("Ajan başlatılamadı (launchctl \(code)).") }
        } else {
            _ = await runner.run(launchctl, ["disable", service])
            _ = await runner.run(launchctl, ["bootout", service])
        }
    }

    /// Where the WECOMMANDER PKG installs the agent.
    public static let agentBinary = "/usr/local/bin/webrising-commender"

    /// "0.1.58" from `webrising-commender --version`, or nil when unknown.
    public func installedVersion() async -> String? {
        let (code, out) = await runner.run(AgentControl.agentBinary, ["--version"])
        return code == 0 ? AgentControl.parseVersion(out) : nil
    }

    public static func parseVersion(_ output: String) -> String? {
        guard let last = output.split(whereSeparator: { $0 == " " || $0 == "\n" }).last,
              last.first?.isNumber == true else { return nil }
        return String(last)
    }

    /// The official one-line installer for this server; it asks for the
    /// administrator password in Terminal and keeps the device's enrollment.
    public static func updateCommand(server: String) -> String {
        var origin = server
        while origin.hasSuffix("/") { origin.removeLast() }
        return "curl -fsSL \(origin)/install.sh | sh"
    }

    /// The installer for a new agent from a signed-in Center: the one-time
    /// pairing code is in a private file (never on the command line), which
    /// the installer reads once and deletes.
    public static func installCommand(server: String, pairingCodeFile: String) -> String {
        let quoted = "'" + pairingCodeFile.replacingOccurrences(of: "'", with: "'\\''") + "'"
        return updateCommand(server: server) + " -s -- --pairing-code-file " + quoted
    }

    /// Writes the code to a new owner-only (0600) file and returns its path.
    public static func writePairingCodeFile(_ code: String, directory: String = NSTemporaryDirectory()) throws -> String {
        let path = (directory as NSString).appendingPathComponent("wecommander-pairing-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: path, contents: Data(code.utf8),
                                             attributes: [.posixPermissions: 0o600]) else {
            throw AgentError("Eşleştirme kodu dosyası yazılamadı.")
        }
        return path
    }

    /// `launchctl print` of a running job has "state = running".
    public static func isRunning(_ printed: String) -> Bool {
        printed.split(separator: "\n").contains { line in
            let t = line.trimmingCharacters(in: .whitespaces)
            return t == "state = running"
        }
    }

    /// `launchctl print-disabled gui/<uid>` lists `"label" => disabled` (macOS 13+)
    /// or `"label" => true` (older).
    public static func isDisabled(_ list: String) -> Bool {
        list.split(separator: "\n").contains { line in
            let t = line.trimmingCharacters(in: .whitespaces)
            return t.hasPrefix("\"\(label)\"") && (t.hasSuffix("disabled") || t.hasSuffix("true"))
        }
    }
}

public struct AgentError: Error, LocalizedError, Equatable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public enum WatchdogAction: Equatable { case none, start, giveUp }

/// Keeps the agent running while "Ajan çalışsın" is on: starts it again after
/// 0 s, 30 s and 2 min, then gives up and says so once, until it runs again.
public struct AgentWatchdog {
    private static let backoff: [TimeInterval] = [0, 30, 120]
    public private(set) var failures = 0
    private var lastAttempt = Date.distantPast
    private var gaveUp = false

    public init() {}

    public mutating func next(keepRunning: Bool, status: AgentStatus, now: Date) -> WatchdogAction {
        if status.running || !keepRunning || status.state == .notInstalled {
            if status.running { failures = 0; gaveUp = false }
            return .none
        }
        if failures >= Self.backoff.count {
            if gaveUp { return .none }
            gaveUp = true
            return .giveUp
        }
        if now.timeIntervalSince(lastAttempt) < Self.backoff[failures] { return .none }
        lastAttempt = now
        failures += 1
        return .start
    }

    public mutating func reset() { failures = 0; gaveUp = false; lastAttempt = .distantPast }
}
