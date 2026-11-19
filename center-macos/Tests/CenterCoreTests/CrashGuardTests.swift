import Foundation
import XCTest
@testable import CenterCore

final class CrashGuardTests: XCTestCase {
    private func tempDir() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wc-crash-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    func testOrderlyRunLeavesNothingToReport() {
        let marker = RunMarker(directory: tempDir())
        XCTAssertNil(marker.begin(build: "512"), "first start ever")
        XCTAssertTrue(FileManager.default.fileExists(atPath: marker.marker.path))
        marker.end()
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.marker.path))
        XCTAssertNil(marker.begin(build: "513"), "the last run ended in order")
    }

    func testMarkerLeftBehindIsReportedOnce() {
        let marker = RunMarker(directory: tempDir())
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        _ = marker.begin(build: "512", now: start)
        // No end(): the process died.
        let previous = marker.begin(build: "512")
        XCTAssertEqual(previous?.run, "build 512, started 2027-01-15T08:00:00Z")
        XCTAssertNil(previous?.crash)
        XCTAssertTrue(previous!.message.hasPrefix("PreviousRunEnded: The app ended unexpectedly in its previous run (build 512"))
        marker.end()
        XCTAssertNil(marker.begin(build: "512"))
    }

    func testCrashLogIsSentAlongAndConsumed() throws {
        let marker = RunMarker(directory: tempDir())
        _ = marker.begin(build: "512")
        let record = ErrorText.exceptionRecord(name: "NSRangeException", reason: "index 5\nbeyond bounds",
                                               stack: ["0   CoreFoundation   0x0000000189640ec0 __exceptionPreprocess + 164"])
        try Data((record + "SIGABRT: fatal signal 6\n").utf8).write(to: marker.crashLog)
        let previous = try XCTUnwrap(marker.begin(build: "513"))
        XCTAssertTrue(previous.message.hasPrefix("NSRangeException: index 5 beyond bounds (the app ended unexpectedly in its previous run, build 512"))
        XCTAssertTrue(previous.detail.contains("__exceptionPreprocess"))
        XCTAssertTrue(previous.detail.contains("SIGABRT"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.crashLog.path), "each crash is reported once")
    }

    func testCrashLogWithoutMarkerIsStillReported() throws {
        let dir = tempDir()
        let marker = RunMarker(directory: dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("SIGSEGV: fatal signal 11\n1   WecommanderCenter   0x0000000102a3b4c0 main + 44\n".utf8).write(to: marker.crashLog)
        let previous = try XCTUnwrap(marker.begin(build: "512"))
        XCTAssertNil(previous.run)
        XCTAssertEqual(previous.message, "SIGSEGV: fatal signal 11 (the app ended unexpectedly in its previous run)")
    }

    func testDisabledInCI() {
        XCTAssertTrue(RunMarker.disabled(environment: ["WECOMMANDER_DEBUG_LAYOUT": "1"], arguments: []))
        XCTAssertTrue(RunMarker.disabled(environment: ["WECOMMANDER_SNAPSHOT_DIR": "/tmp/s"], arguments: []))
        XCTAssertTrue(RunMarker.disabled(environment: [:], arguments: ["app", "--snapshot"]))
        XCTAssertFalse(RunMarker.disabled(environment: ["WECOMMANDER_SNAPSHOT_DIR": ""], arguments: ["app", "--hidden"]))
    }

    func testGateAllowsOneAMinuteAndNoRepeats() {
        var gate = ErrorReportGate()
        let t = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertTrue(gate.allow("a", now: t))
        XCTAssertFalse(gate.allow("b", now: t.addingTimeInterval(30)))
        XCTAssertTrue(gate.allow("b", now: t.addingTimeInterval(61)))
        XCTAssertFalse(gate.allow("b", now: t.addingTimeInterval(500)), "never the same one twice in a row")
    }

    func testScrubBuildAndCaught() {
        XCTAssertEqual(ErrorText.scrub("at /Users/orhan/Library/x and /tmp/orhan/y", max: 100, home: "/Users/orhan", user: "orhan"),
                       "at /Users/…/Library/x and /tmp/…/y")
        XCTAssertEqual(ErrorText.scrub("abcdef", max: 3, home: "/Users/x", user: "x"), "abc")
        XCTAssertEqual(ErrorText.build(from: "0.1.512"), "512")
        XCTAssertEqual(ErrorText.build(from: "dev"), "dev")
        let caught = ErrorText.caught(CocoaError(.fileReadNoPermission), context: "AppModel.sync", stack: ["frame"])
        XCTAssertTrue(caught.detail.contains("\n   at AppModel.sync\nframe"))
        XCTAssertTrue(caught.message.contains(": AppModel.sync: "))
    }

    func testErrorLogStartsOverWhenLarge() throws {
        let url = tempDir().appendingPathComponent("errors.log")
        ErrorLog.append("one", to: url)
        ErrorLog.append("two", to: url)
        var text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(text.contains("one") && text.contains("two"))
        ErrorLog.append("three", to: url, maxBytes: 10)
        text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(text.contains("one"))
        XCTAssertTrue(text.contains("three"))
    }

    func testReportErrorPostsScrubbedReport() async throws {
        let transport = FakeTransport { _ in (202, "{\"ok\":true}") }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: transport)
        try await client.reportError(token: "t", build: "512", message: "E: boom", detail: "E: boom\n" + NSHomeDirectory() + "/x")
        XCTAssertEqual(transport.calls.first?.path, "/api/center/errors")
        XCTAssertEqual(transport.calls.first?.body?["platform"] as? String, "macos")
        XCTAssertFalse((transport.calls.first?.body?["detail"] as? String ?? "").contains(NSHomeDirectory() + "/"))
    }
}
