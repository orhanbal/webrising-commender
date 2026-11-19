import Foundation
import XCTest
@testable import CenterCore

final class RootSetupTests: XCTestCase {
    private func host(_ label: String, _ address: String, _ proto: String = "ssh") throws -> CoreHost {
        let json = #"{"id":"h","label":"\#(label)","target":"root@\#(address)","authKind":"key","savedSecret":false,"host":"\#(address)","protocol":"\#(proto)"}"#
        return try JSONDecoder().decode(CoreHost.self, from: Data(json.utf8))
    }

    private func devices(_ json: String) throws -> [Device] {
        try JSONDecoder().decode([Device].self, from: Data(json.utf8))
    }

    func testTheCommandsAreFixedAndPreferTheInstalledScript() {
        XCTAssertEqual(RootSetup.command(allow: true), "if [ -f /opt/wecommander/libexec/install-linux.sh ]; then sudo bash /opt/wecommander/libexec/install-linux.sh --allow-root; else curl -fsSL https://wecommander.app/install.sh | sh -s -- --allow-root; fi")
        XCTAssertEqual(RootSetup.command(allow: false), "if [ -f /opt/wecommander/libexec/install-linux.sh ]; then sudo bash /opt/wecommander/libexec/install-linux.sh --disallow-root; else curl -fsSL https://wecommander.app/install.sh | sh -s -- --disallow-root; fi")
    }

    func testOnlyHostsWithAShellGetTheAction() throws {
        XCTAssertTrue(RootSetup.applies(try host("web", "web-1")))
        XCTAssertTrue(RootSetup.applies(try host("web", "web-1", "mosh")))
        XCTAssertFalse(RootSetup.applies(try host("switch", "10.0.0.1", "telnet")))
    }

    func testADeviceIsMatchedOnlyWhenOneLinuxDeviceHasTheHostsName() throws {
        let list = try devices(#"[{"id":"d1","name":"web-1","platform":"linux"},{"id":"d2","name":"db","platform":"linux"},{"id":"w","name":"web-2","platform":"windows"}]"#)
        XCTAssertEqual(RootSetup.matchDevice(try host("Web", "web-1.example.com"), in: list), "d1")
        XCTAssertEqual(RootSetup.matchDevice(try host("DB", "10.0.0.5"), in: list), "d2")
        XCTAssertNil(RootSetup.matchDevice(try host("web-2", "10.0.0.6"), in: list))
        XCTAssertNil(RootSetup.matchDevice(try host("x", "10.0.0.7"), in: list))
        let twice = try devices(#"[{"id":"a","name":"web-1","platform":"linux"},{"id":"b","name":"WEB-1","platform":"linux"}]"#)
        XCTAssertNil(RootSetup.matchDevice(try host("web-1", "web-1"), in: twice))
    }

    func testThePermissionsLinkOpensTheDeviceOrTheList() {
        XCTAssertEqual(RootSetup.permissionsURL(server: "https://wecommander.app/", deviceId: "d 1"), "https://wecommander.app/devices?permissions=d%201")
        XCTAssertEqual(RootSetup.permissionsURL(server: "https://wecommander.app", deviceId: nil), "https://wecommander.app/devices")
    }
}
