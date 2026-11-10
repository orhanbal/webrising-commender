import Foundation

/// A started agent process (real or, in tests, fake).
public protocol AgentProcess: AnyObject {
    var isRunning: Bool { get }
    func terminate()
}

/// Starts agent processes and runs one-off agent commands.
public protocol AgentLaunching: AnyObject {
    func start(_ executable: String, _ arguments: [String]) throws -> AgentProcess
    func run(_ executable: String, _ arguments: [String]) async -> (status: Int32, output: String)
}

/// Runs the agent as a background child process of the app (no Terminal).
public final class ChildProcessLauncher: AgentLaunching {
    private final class Running: AgentProcess {
        let process: Process
        init(_ process: Process) { self.process = process }
        var isRunning: Bool { process.isRunning }
        func terminate() {
            guard process.isRunning else { return }
            process.terminate()
            // SIGKILL if it has not stopped after two seconds.
            let pid = process.processIdentifier
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [process] in
                if process.isRunning { kill(pid, SIGKILL) }
            }
        }
    }

    public init() {}

    public func start(_ executable: String, _ arguments: [String]) throws -> AgentProcess {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        // The agent writes its own log; its output is not needed here.
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        try process.run()
        return Running(process)
    }

    public func run(_ executable: String, _ arguments: [String]) async -> (status: Int32, output: String) {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = arguments
                let pipe = Pipe()
                process.standardOutput = pipe
                process.standardError = pipe
                process.standardInput = FileHandle.nullDevice
                do { try process.run() } catch {
                    continuation.resume(returning: (-1, error.localizedDescription))
                    return
                }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                continuation.resume(returning: (process.terminationStatus, String(decoding: data, as: UTF8.self)))
            }
        }
    }
}

/// The WECOMMANDER agent shipped inside the app (Contents/MacOS/
/// webrising-commender). The app pairs it with a one-time code from the
/// signed-in account and runs it as a child process: no PKG, no
/// LaunchAgent, no administrator password. Quitting the app stops it; the
/// app opens at login.
public final class EmbeddedAgent {
    public static let executableName = "webrising-commender"

    public let executable: String
    public let configPath: String
    private let launcher: AgentLaunching
    private let fileManager = FileManager.default
    private var process: AgentProcess?
    private var watchdog = AgentWatchdog()
    /// Why the last start or pairing failed (Turkish), or nil.
    public private(set) var lastError: String?

    public init(executable: String, configPath: String, launcher: AgentLaunching = ChildProcessLauncher()) {
        self.executable = executable
        self.configPath = configPath
        self.launcher = launcher
    }

    /// The agent next to the app; the pairing where the agent keeps it.
    public static func forThisApp(bundle: Bundle = .main, home: String = NSHomeDirectory()) -> EmbeddedAgent {
        let exe = bundle.bundleURL.appendingPathComponent("Contents/MacOS/\(executableName)").path
        return EmbeddedAgent(executable: exe, configPath: defaultConfigPath(home: home))
    }

    public static func defaultConfigPath(home: String) -> String {
        home + "/Library/Application Support/webrising-commender/agent.json"
    }

    /// Folder the agent may use by default (~/WECOMMANDER).
    public static func defaultRoot(home: String = NSHomeDirectory()) -> String { home + "/WECOMMANDER" }

    public var available: Bool { fileManager.isExecutableFile(atPath: executable) }
    public var paired: Bool { fileManager.fileExists(atPath: configPath) }
    public var running: Bool { process?.isRunning == true }

    public func status(keepRunning: Bool) -> AgentStatus {
        AgentStatus(state: running ? .running : paired ? .stopped : .notInstalled, enabled: keepRunning)
    }

    public var runArguments: [String] { ["--config", configPath, "run"] }

    public func enrollArguments(server: String, pairingCode: String, root: String) -> [String] {
        var origin = server
        while origin.hasSuffix("/") { origin.removeLast() }
        return ["--config", configPath, "enroll", "--control-url", origin,
                "--pairing-code", pairingCode, "--allowed-root", root]
    }

    /// Pairs this Mac with the signed-in account. An existing pairing is kept
    /// as agent.json.bak and put back when the new one fails. The code never
    /// appears in errors.
    public func pair(server: String, pairingCode: String, root: String? = nil) async -> Bool {
        let folder = root ?? EmbeddedAgent.defaultRoot()
        let backup = configPath + ".bak"
        let wasRunning = running
        do {
            try fileManager.createDirectory(atPath: folder, withIntermediateDirectories: true)
            try fileManager.createDirectory(atPath: (configPath as NSString).deletingLastPathComponent,
                                            withIntermediateDirectories: true)
            stop()
            if paired {
                try? fileManager.removeItem(atPath: backup)
                try fileManager.copyItem(atPath: configPath, toPath: backup)
                try fileManager.removeItem(atPath: configPath)
            }
        } catch {
            restore(backup)
            lastError = "Bu Mac hesaba bağlanamadı: " + EmbeddedAgent.redact(error.localizedDescription, pairingCode)
            return false
        }
        let (status, output) = await launcher.run(executable, enrollArguments(server: server, pairingCode: pairingCode, root: folder))
        if status != 0 || !paired {
            restore(backup)
            lastError = "Bu Mac hesaba bağlanamadı: " + EmbeddedAgent.redact(output, pairingCode)
            if wasRunning { _ = start() }
            return false
        }
        lastError = nil
        watchdog.reset()
        return true
    }

    private func restore(_ backup: String) {
        if !paired && fileManager.fileExists(atPath: backup) {
            try? fileManager.moveItem(atPath: backup, toPath: configPath)
        }
    }

    public static func redact(_ text: String, _ secret: String) -> String {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !secret.isEmpty { t = t.replacingOccurrences(of: secret, with: "[REDACTED]") }
        if t.count > 300 { t = String(t.prefix(300)) + "…" }
        return t.isEmpty ? "bilinmeyen hata" : t
    }

    /// Starts the paired agent in the background; true while it runs.
    @discardableResult
    public func start() -> Bool {
        if running { return true }
        process = nil
        guard available else {
            lastError = "Uygulamanın içindeki ajan bulunamadı; uygulamayı yeniden kur."
            return false
        }
        guard paired else { lastError = nil; return false }
        do {
            process = try launcher.start(executable, runArguments)
            lastError = nil
            return true
        } catch {
            lastError = "Ajan başlatılamadı: " + error.localizedDescription
            return false
        }
    }

    public func stop() {
        process?.terminate()
        process = nil
    }

    /// Called every few seconds: while the owner wants it on and it is
    /// paired, starts it again after it stopped (0 s, 30 s, 2 min, then
    /// gives up and says so once).
    @discardableResult
    public func tick(keepRunning: Bool, now: Date = Date()) -> WatchdogAction {
        let action = watchdog.next(keepRunning: keepRunning, status: status(keepRunning: keepRunning), now: now)
        if action == .start { start() }
        return action
    }

    public func resetWatchdog() { watchdog.reset() }

    /// `webrising-commender --version` of the bundled agent.
    public func version() async -> String? {
        let (status, output) = await launcher.run(executable, ["--version"])
        return status == 0 ? AgentControl.parseVersion(output) : nil
    }
}

/// Removes the LaunchAgent of the earlier PKG install (tr.webrising.commender)
/// once the app runs the agent itself. It is per user: no password. The
/// pairing (agent.json) and the old binary are kept.
public struct LegacyAgentCleanup {
    public let control: AgentControl
    public let removePlist: () -> Void

    public init(control: AgentControl, removePlist: (() -> Void)? = nil) {
        self.control = control
        let path = control.plistPath
        self.removePlist = removePlist ?? { try? FileManager.default.removeItem(atPath: path) }
    }

    /// True when something was removed.
    @discardableResult
    public func run() async -> Bool {
        let installed = control.plistExists()
        let (loaded, _) = await control.runner.run("/bin/launchctl", ["print", "gui/\(control.uid)/\(AgentControl.label)"])
        guard installed || loaded == 0 else { return false }
        _ = await control.runner.run("/bin/launchctl", ["bootout", "gui/\(control.uid)/\(AgentControl.label)"])
        if installed { removePlist() }
        return true
    }
}

/// Updates the whole app (which carries the agent): the newest
/// macos-preview-N with the app zip, checked against SHA256SUMS.txt, is
/// unpacked and swapped in by a small helper after the app quits. The app's
/// own build is the N of its version 0.1.N.
public enum AppUpdate {
    public static let zipAsset = "WECOMMANDER-Center-macos.zip"
    public static let sumsAsset = "SHA256SUMS.txt"
    public static let repo = "orhanbal/webrising-commender"

    public struct Release: Equatable {
        public let build: Int
        public let zipURL: URL
        public let sumsURL: URL
    }

    public static func latest(_ json: Data) -> Release? {
        guard let releases = (try? JSONSerialization.jsonObject(with: json)) as? [[String: Any]] else { return nil }
        var best: Release?
        for release in releases {
            if release["draft"] as? Bool == true { continue }
            guard let tag = release["tag_name"] as? String, tag.hasPrefix("macos-preview-"),
                  let build = Int(tag.dropFirst("macos-preview-".count)) else { continue }
            let prefix = "https://github.com/\(repo)/releases/download/\(tag)/"
            var zip: URL?
            var sums: URL?
            for asset in release["assets"] as? [[String: Any]] ?? [] {
                guard let name = asset["name"] as? String,
                      let link = asset["browser_download_url"] as? String, link.hasPrefix(prefix),
                      let url = URL(string: link) else { continue }
                if name == zipAsset { zip = url } else if name == sumsAsset { sums = url }
            }
            if let zip, let sums, best == nil || build > best!.build {
                best = Release(build: build, zipURL: zip, sumsURL: sums)
            }
        }
        return best
    }

    public static func isNewer(_ latest: Release?, than current: Int?) -> Bool {
        guard let latest, let current else { return false }
        return latest.build > current
    }

    /// The SHA-256 (lowercase hex) for `asset` in a SHA256SUMS.txt, or nil
    /// when missing or not unique.
    public static func expectedHash(_ sums: String, asset: String) -> String? {
        var found: String?
        for raw in sums.split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            guard parts.count == 2, parts[0].count == 64,
                  parts[0].allSatisfy({ $0.isHexDigit }) else { continue }
            var name = parts[1].trimmingCharacters(in: .whitespaces)
            if name.hasPrefix("*") { name.removeFirst() }
            guard name == asset else { continue }
            if found != nil { return nil }
            found = parts[0].lowercased()
        }
        return found
    }

    /// The helper (sh, in the background) that waits for the app to quit,
    /// moves the new bundle in (keeping the old one until it is in place)
    /// and opens the app again.
    public static func swapScript(appPath: String, newAppPath: String, pid: Int32) -> String {
        func q(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let old = appPath + ".old"
        return """
        #!/bin/sh
        app=\(q(appPath)); new=\(q(newAppPath)); old=\(q(old))
        i=0; while kill -0 \(pid) 2>/dev/null && [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done
        rm -rf "$old"
        if mv "$app" "$old"; then
          if mv "$new" "$app"; then rm -rf "$old"; else mv "$old" "$app"; fi
        fi
        open "$app" --args --updated
        """
    }
}
