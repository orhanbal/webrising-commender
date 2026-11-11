import Foundation
import XCTest
@testable import CenterCore

final class HostLibraryTests: XCTestCase {
    func testHostsDecodeWithAndWithoutGroups() throws {
        let json = """
        [{"id":"a","label":"Web","target":"deploy@web:22","authKind":"key","savedSecret":false,
          "group":"Production","user":"deploy","host":"web","port":22},
         {"id":"b","label":"Old","target":"x@y:22","authKind":"password","savedSecret":true}]
        """
        let hosts = try JSONDecoder().decode([CoreHost].self, from: Data(json.utf8))
        XCTAssertEqual(hosts[0].groupName, "Production")
        XCTAssertEqual(hosts[0].port, 22)
        XCTAssertEqual(hosts[1].groupName, CoreHost.noGroup) // older core: no group fields
        XCTAssertNil(hosts[1].host)
    }

    func testLibraryModelsDecode() throws {
        let known = try JSONDecoder().decode([KnownHost].self, from: Data(#"[{"target":"web:22","fingerprint":"SHA256:x","labels":["Web"]}]"#.utf8))
        XCTAssertEqual(known[0].id, "web:22")
        let snippets = try JSONDecoder().decode([Snippet].self, from: Data(#"[{"id":"s","label":"Disk","command":"df -h"}]"#.utf8))
        XCTAssertEqual(snippets[0].command, "df -h")
        let history = try JSONDecoder().decode([HistoryEntry].self, from: Data(#"[{"hostId":"a","label":"Web","target":"web","at":1800000000}]"#.utf8))
        XCTAssertEqual(history[0].date, Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertEqual(history[0].id, "a@1800000000")
        let keys = try JSONDecoder().decode([KeyMeta].self, from: Data(#"[{"id":"k","label":"Mac","algorithm":"ssh-ed25519","fingerprint":"SHA256:x","publicKey":"ssh-ed25519 AAAA Mac","created":1800000000}]"#.utf8))
        XCTAssertEqual(keys[0].publicKey, "ssh-ed25519 AAAA Mac")
    }
}
