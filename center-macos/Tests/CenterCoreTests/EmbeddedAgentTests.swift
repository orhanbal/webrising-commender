import Foundation
import XCTest
@testable import CenterCore

final class EmbeddedAgentTests: XCTestCase {
    final class FakeProcess: AgentProcess {
        var isRunning = true
        var terminated = false
        func terminate() { terminated = true; isRunning = false }
    }

    final class FakeLauncher: AgentLaunching {
        var started: [[String]] = []
        var processes: [FakeProcess] = []
        var runs: [[String]] = []
        /// Writes the config the agent would write on enroll.
        var enroll: ([String]) -> (Int32, String)
        init(enroll: @escaping ([String]) -> (Int32, String)) { self.enroll = enroll }
        func start(_ executable: String, _ arguments: [String]) throws -> AgentProcess {
            started.append(arguments)
            let p = FakeProcess()
            processes.append(p)
            return p
        }
        func run(_ executable: String, _ arguments: [String]) async -> (status: Int32, output: String) {
            runs.append(arguments)
            if arguments.first == "--version" { return (0, "webrising-commender 0.1.77\n") }
            return enroll(arguments)
        }
    }

    var dir = ""
    var exe: String { dir + "/App.app/Contents/MacOS/webrising-commender" }
    var config: String { dir + "/Support/webrising-commender/agent.json" }

    override func setUpWithError() throws {
        dir = NSTemporaryDirectory() + "wc-embedded-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: (exe as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: exe, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
    }

    override func tearDown() { try? FileManager.default.removeItem(atPath: dir) }

    func writesConfig(status: Int32 = 0, output: String = "", write: Bool = true) -> FakeLauncher {
        FakeLauncher { args in
            if write, let i = args.firstIndex(of: "--config") {
                let path = args[i + 1]
                try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
                FileManager.default.createFile(atPath: path, contents: Data("{}".utf8))
            }
            return (status, output)
        }
    }

    func testPairsAndRunsInTheBackground() async {
        let launcher = writesConfig()
        let agent = EmbeddedAgent(executable: exe, configPath: config, launcher: launcher)
        XCTAssertTrue(agent.available)
        XCTAssertEqual(agent.status(keepRunning: true).state, .notInstalled)
        XCTAssertFalse(agent.start()) // not paired yet

        let paired = await agent.pair(server: "https://wecommander.app/", pairingCode: "CODE-1", root: dir + "/root")
        XCTAssertTrue(paired)
        XCTAssertEqual(launcher.runs.last, ["--config", config, "enroll", "--control-url", "https://wecommander.app",
                                            "--pairing-code", "CODE-1", "--allowed-root", dir + "/root"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir + "/root"))

        XCTAssertTrue(agent.start())
        XCTAssertEqual(launcher.started, [["--config", config, "run"]])
        XCTAssertEqual(agent.status(keepRunning: true), AgentStatus(state: .running, enabled: true))
        agent.stop()
        XCTAssertTrue(launcher.processes[0].terminated)
        XCTAssertEqual(agent.status(keepRunning: true).state, .stopped)
        let version = await agent.version()
        XCTAssertEqual(version, "0.1.77")
    }

    func testFailedPairingKeepsTheOldOneAndHidesTheCode() async throws {
        try FileManager.default.createDirectory(atPath: (config as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: config, contents: Data("old".utf8))
        let agent = EmbeddedAgent(executable: exe, configPath: config,
                                  launcher: writesConfig(status: 1, output: "code SECRET-9 expired", write: false))
        let paired = await agent.pair(server: "https://wecommander.app", pairingCode: "SECRET-9", root: dir + "/root")
        XCTAssertFalse(paired)
        XCTAssertEqual(try String(contentsOfFile: config, encoding: .utf8), "old")
        XCTAssertFalse(agent.lastError?.contains("SECRET-9") ?? true)
        XCTAssertTrue(agent.lastError?.contains("[REDACTED]") ?? false)
    }

    func testWatchdogRestartsThenGivesUp() async {
        let launcher = writesConfig()
        let agent = EmbeddedAgent(executable: exe, configPath: config, launcher: launcher)
        _ = await agent.pair(server: "https://wecommander.app", pairingCode: "C", root: dir + "/root")
        let now = Date()
        XCTAssertEqual(agent.tick(keepRunning: true, now: now), .start)
        XCTAssertTrue(agent.running)
        XCTAssertEqual(agent.tick(keepRunning: true, now: now), .none)
        launcher.processes.last!.isRunning = false
        XCTAssertEqual(agent.tick(keepRunning: true, now: now), .start)
        launcher.processes.last!.isRunning = false
        XCTAssertEqual(agent.tick(keepRunning: true, now: now.addingTimeInterval(5)), .none)
        XCTAssertEqual(agent.tick(keepRunning: true, now: now.addingTimeInterval(31)), .start)
        launcher.processes.last!.isRunning = false
        XCTAssertEqual(agent.tick(keepRunning: true, now: now.addingTimeInterval(180)), .start)
        launcher.processes.last!.isRunning = false
        XCTAssertEqual(agent.tick(keepRunning: true, now: now.addingTimeInterval(600)), .giveUp)
        XCTAssertEqual(agent.tick(keepRunning: true, now: now.addingTimeInterval(900)), .none)
        let count = launcher.started.count
        agent.resetWatchdog()
        XCTAssertEqual(agent.tick(keepRunning: false, now: now.addingTimeInterval(1000)), .none)
        XCTAssertEqual(launcher.started.count, count)
    }

    func testMissingAgentIsReported() throws {
        try FileManager.default.removeItem(atPath: exe)
        let agent = EmbeddedAgent(executable: exe, configPath: config, launcher: writesConfig())
        XCTAssertFalse(agent.available)
        XCTAssertFalse(agent.start())
        XCTAssertTrue(agent.lastError?.contains("yeniden kur") ?? false)
    }

    final class Launchctl: CommandRunning, @unchecked Sendable {
        var loaded = true
        var calls: [[String]] = []
        func run(_ path: String, _ arguments: [String]) async -> (status: Int32, output: String) {
            calls.append(arguments)
            if arguments.first == "print" { return loaded ? (0, "") : (113, "") }
            if arguments.first == "bootout" { loaded = false }
            return (0, "")
        }
    }

    func testOldLaunchAgentIsRemovedOnce() async {
        let runner = Launchctl()
        final class Box: @unchecked Sendable { var plist = true }
        let box = Box()
        let control = AgentControl(uid: 501, home: "/Users/o", runner: runner, plistExists: { box.plist })
        let cleanup = LegacyAgentCleanup(control: control, removePlist: { box.plist = false })
        let removed = await cleanup.run()
        XCTAssertTrue(removed)
        XCTAssertTrue(runner.calls.contains(["bootout", "gui/501/tr.webrising.commender"]))
        XCTAssertFalse(box.plist)
        let again = await cleanup.run()
        XCTAssertFalse(again)
    }

    func testAppUpdatePicksTheNewestReleaseFromThisRepo() {
        let json = """
        [
          {"tag_name":"macos-preview-80","draft":false,"assets":[
            {"name":"WECOMMANDER-Center-macos.zip","browser_download_url":"https://github.com/orhanbal/webrising-commender/releases/download/macos-preview-80/WECOMMANDER-Center-macos.zip"},
            {"name":"SHA256SUMS.txt","browser_download_url":"https://github.com/orhanbal/webrising-commender/releases/download/macos-preview-80/SHA256SUMS.txt"}]},
          {"tag_name":"macos-preview-90","draft":false,"assets":[
            {"name":"WECOMMANDER-Center-macos.zip","browser_download_url":"https://evil.example/WECOMMANDER-Center-macos.zip"},
            {"name":"SHA256SUMS.txt","browser_download_url":"https://github.com/orhanbal/webrising-commender/releases/download/macos-preview-90/SHA256SUMS.txt"}]},
          {"tag_name":"macos-preview-95","draft":true,"assets":[]},
          {"tag_name":"macos-center-latest","draft":false,"assets":[]}
        ]
        """
        let latest = AppUpdate.latest(Data(json.utf8))
        XCTAssertEqual(latest?.build, 80)
        XCTAssertTrue(AppUpdate.isNewer(latest, than: 79))
        XCTAssertFalse(AppUpdate.isNewer(latest, than: 80))
        XCTAssertFalse(AppUpdate.isNewer(latest, than: nil))
        XCTAssertNil(AppUpdate.latest(Data("x".utf8)))
    }

    func testChecksumAndSwapScript() {
        let hash = String(repeating: "ab", count: 32)
        let sums = "\(hash.uppercased())  WECOMMANDER-Center-macos.zip\n\(String(repeating: "c", count: 64)) *other.pkg\n"
        XCTAssertEqual(AppUpdate.expectedHash(sums, asset: AppUpdate.zipAsset), hash)
        XCTAssertNil(AppUpdate.expectedHash(sums + sums, asset: AppUpdate.zipAsset))
        XCTAssertNil(AppUpdate.expectedHash(sums, asset: "missing.zip"))

        let script = AppUpdate.swapScript(appPath: "/Users/o'b/Applications/WECOMMANDER Center.app", newAppPath: "/tmp/new.app", pid: 42)
        XCTAssertTrue(script.contains("kill -0 42"))
        XCTAssertTrue(script.contains("app='/Users/o'\\''b/Applications/WECOMMANDER Center.app'"))
        XCTAssertTrue(script.contains("mv \"$old\" \"$app\""))
        XCTAssertTrue(script.contains("open \"$app\" --args --updated"))
    }
}
