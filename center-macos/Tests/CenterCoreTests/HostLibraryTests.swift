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

    func testParityModelsDecode() throws {
        let host = try JSONDecoder().decode(CoreHost.self, from: Data(#"{"id":"a","label":"Web","target":"t","authKind":"key","savedSecret":true,"startupCommand":"cd /srv","env":{"LANG":"tr_TR.UTF-8"},"agentForwarding":true,"identityId":"i"}"#.utf8))
        XCTAssertEqual(host.startupCommand, "cd /srv")
        XCTAssertEqual(host.env?["LANG"], "tr_TR.UTF-8")
        XCTAssertEqual(host.agentForwarding, true)
        XCTAssertEqual(host.identityId, "i")
        let forwards = try JSONDecoder().decode([ForwardInfo].self, from: Data(#"[{"id":"remote:localhost:8080","kind":"remote","local":"localhost:8080 (sunucu)","remote":"127.0.0.1:3000"},{"local":"127.0.0.1:5000","remote":"db:5432"}]"#.utf8))
        XCTAssertEqual(forwards[0].stopId, "remote:localhost:8080")
        XCTAssertEqual(forwards[1].stopId, "127.0.0.1:5000") // older core: no id
        let ids = try JSONDecoder().decode([Identity].self, from: Data(#"[{"id":"i","label":"Team","user":"deploy","authKind":"password"}]"#.utf8))
        XCTAssertNil(ids[0].keyId)
        let summary = try JSONDecoder().decode(ImportSummary.self, from: Data(#"{"hosts":1,"snippets":2,"knownHosts":3,"skipped":0}"#.utf8))
        XCTAssertEqual(summary.snippets, 2)
        XCTAssertEqual(CoreText.turkish("not a WECOMMANDER backup file"), "Bu dosya bir WECOMMANDER yedeği değil.")
    }
}
