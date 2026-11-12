import Foundation
import XCTest
@testable import CenterCore

/// Runs against the real `wecommander-core` when CI builds it and sets
/// WECOMMANDER_CORE_BIN; skipped otherwise.
final class CoreClientTests: XCTestCase {
    func testTalksToTheRealCore() async throws {
        guard let path = ProcessInfo.processInfo.environment["WECOMMANDER_CORE_BIN"] else {
            throw XCTSkip("WECOMMANDER_CORE_BIN not set")
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wc-core-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let core = try CoreClient(executable: URL(fileURLWithPath: path), dataDirectory: dir, keyringService: "app.wecommander.test")
        defer { core.stop() }

        let info = try await core.call("app.info")
        XCTAssertNotNil((info as? [String: Any])?["version"])
        let hosts = try await core.call("hosts.add", [
            "label": "Prod web", "host": "web.example.com", "port": 2222, "user": "deploy", "authKind": "key",
        ], as: [CoreHost].self)
        XCTAssertEqual(hosts.map(\.target), ["deploy@web.example.com:2222"])
        let listed = try await core.call("hosts.list", as: [CoreHost].self)
        XCTAssertEqual(listed.first?.label, "Prod web")
        let tunnels = try await core.call("tunnels.saved", as: [SavedTunnel].self)
        XCTAssertEqual(tunnels, [])
        do {
            _ = try await core.call("no.such.method")
            XCTFail("expected an error")
        } catch let error as CoreClient.Failure {
            XCTAssertEqual(error, .core("unknown method no.such.method"))
        }
        // Concurrent requests are matched by id.
        async let a = core.call("hosts.list", as: [CoreHost].self)
        async let b = core.call("tunnels.saved", as: [SavedTunnel].self)
        let (x, y) = try await (a, b)
        XCTAssertEqual(x.count, 1)
        XCTAssertEqual(y.count, 0)
        // A stopped core fails calls instead of hanging.
        core.stop()
        do {
            _ = try await core.call("hosts.list")
            XCTFail("expected stopped")
        } catch let error as CoreClient.Failure {
            XCTAssertEqual(error, .stopped)
        }
    }

    func testTurkishErrorTexts() {
        XCTAssertEqual(CoreText.turkish("authentication failed"), "Giriş reddedildi. Anahtarı veya parolayı kontrol et.")
        XCTAssertTrue(CoreText.turkish("authentication failed (server accepts: publickey)").contains("yalnız SSH anahtarı kabul ediyor"))
        XCTAssertEqual(CoreText.turkish("jump host Bastion: no saved credential; connect to it once and save it"), "Bu sunucu için kayıtlı giriş bilgisi yok; bir kez gir.")
        XCTAssertEqual(CoreText.turkish("something new"), "something new")
    }
}

final class AgentUpdateTests: XCTestCase {
    func testNewestMacBuild() {
        let json = """
        [{"tag_name":"macos-preview-120","draft":false,"assets":[{"name":"WECOMMANDER-macos-universal.pkg"}]},
         {"tag_name":"macos-preview-130","draft":true,"assets":[{"name":"WECOMMANDER-macos-universal.pkg"}]},
         {"tag_name":"macos-preview-125","assets":[{"name":"other.zip"}]},
         {"tag_name":"ubuntu-preview-999","assets":[{"name":"WECOMMANDER-macos-universal.pkg"}]}]
        """
        XCTAssertEqual(AgentUpdate.latestMacBuild(Data(json.utf8)), 120)
        XCTAssertNil(AgentUpdate.latestMacBuild(Data("{}".utf8)))
        XCTAssertTrue(AgentUpdate.isNewer(120, than: "0.1.58"))
        XCTAssertFalse(AgentUpdate.isNewer(120, than: "0.1.120"))
        XCTAssertFalse(AgentUpdate.isNewer(nil, than: "0.1.1"))
        XCTAssertEqual(AgentUpdate.build("0.1.58"), 58)
    }
}
