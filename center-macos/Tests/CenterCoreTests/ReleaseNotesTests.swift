import Foundation
import XCTest
@testable import CenterCore

/// "Yenilikler": the notes shipped in the app and which of them to show after an update.
final class ReleaseNotesTests: XCTestCase {
    private static let sample = """
    {"releases":[
     {"id":"2026-12-02","date":"2026-12-02","items":{"tr":["c"],"en":["C"]}},
     {"id":"2026-11-20-mac","date":"2026-11-20","platforms":["macos"],"items":{"tr":["m"],"en":["M"],"de":["Md"]}},
     {"id":"2026-11-20-win","date":"2026-11-20","platforms":["windows"],"items":{"tr":["b"],"en":["B"]}},
     {"id":"2026-11-17","date":"2026-11-17","platforms":["macos"],"items":{"tr":["a1","a2"],"en":["A1","A2"]}},
     {"date":"2026-11-01","items":{"tr":["no id"]}}
    ]}
    """

    private var mac: [ReleaseNote] { ReleaseNotes.filter(ReleaseNotes.parse(Self.sample), platform: ReleaseNotes.macOS) }
    private func ids(_ notes: [ReleaseNote]) -> [String] { notes.map(\.id) }

    func testParsesAndFiltersByPlatform() {
        let all = ReleaseNotes.parse(Self.sample)
        XCTAssertEqual(all.count, 4)
        XCTAssertEqual(ids(mac), ["2026-12-02", "2026-11-20-mac", "2026-11-17"])
        XCTAssertEqual(ids(ReleaseNotes.filter(all, platform: ReleaseNotes.windows)), ["2026-12-02", "2026-11-20-win"])
        XCTAssertEqual(ReleaseNotes.parse("{"), [])
        XCTAssertEqual(ReleaseNotes.parse("[]"), [])
    }

    func testSinceTheLastSeenEntry() {
        XCTAssertEqual(ids(ReleaseNotes.since(mac, lastSeen: "2026-11-17")), ["2026-12-02", "2026-11-20-mac"])
        XCTAssertEqual(ids(ReleaseNotes.since(mac, lastSeen: "2026-12-02")), [])
        XCTAssertEqual(ReleaseNotes.since(mac, lastSeen: nil).count, 3)
        XCTAssertEqual(ids(ReleaseNotes.since(mac, lastSeen: "2026-11-20-removed")), ["2026-12-02"])
        XCTAssertEqual(ids(ReleaseNotes.since(mac, lastSeen: "garbage")), [])
    }

    func testAtStart() {
        let fresh = ReleaseNotes.atStart(mac, lastSeen: nil, settingsExisted: false)
        XCTAssertEqual(fresh.show, [])
        XCTAssertEqual(fresh.remember, "2026-12-02")
        let updated = ReleaseNotes.atStart(mac, lastSeen: "2026-11-17", settingsExisted: true)
        XCTAssertEqual(ids(updated.show), ["2026-12-02", "2026-11-20-mac"])
        XCTAssertEqual(updated.remember, "2026-12-02")
        let again = ReleaseNotes.atStart(mac, lastSeen: "2026-12-02", settingsExisted: true)
        XCTAssertEqual(again.show, [])
        XCTAssertNil(again.remember)
        XCTAssertEqual(ReleaseNotes.atStart(mac, lastSeen: nil, settingsExisted: true).show.count, 3)
    }

    func testAtMostFiveAreShown() {
        let many = (1...9).reversed().map { ReleaseNote(id: "2026-12-0\($0)", date: "2026-12-0\($0)", items: [:]) }
        XCTAssertEqual(ReleaseNotes.since(many, lastSeen: nil).count, ReleaseNotes.maxShown)
        XCTAssertEqual(ReleaseNotes.since(many, lastSeen: "2026-12-01").count, ReleaseNotes.maxShown)
    }

    func testLanguageFallbackAndDate() {
        let m = mac[1]
        XCTAssertEqual(m.lines("de"), ["Md"])
        XCTAssertEqual(m.lines("fr"), ["M"])
        XCTAssertTrue(mac[2].dateText(Locale(identifier: "en_US")).contains("2026"))
        XCTAssertEqual(ReleaseNote(id: "x", date: "someday", items: [:]).dateText(Locale(identifier: "en_US")), "someday")
    }

    func testEmbeddedNotesAreCompleteForBothApps() {
        let all = ReleaseNotes.embedded
        XCTAssertFalse(all.isEmpty)
        XCTAssertEqual(Set(all.map(\.id)).count, all.count)
        XCTAssertFalse(ReleaseNotes.filter(all, platform: ReleaseNotes.macOS).isEmpty)
        XCTAssertFalse(ReleaseNotes.filter(all, platform: ReleaseNotes.windows).isEmpty)
        for note in all {
            let count = note.lines("tr").count
            XCTAssertGreaterThan(count, 0, note.id)
            for code in L.languages.map(\.code) { XCTAssertEqual(note.items[code]?.count, count, "\(note.id) \(code)") }
        }
    }

    func testSettingsKeepTheLastSeenNotes() throws {
        var s = CenterSettings()
        XCTAssertNil(s.lastSeenNotes)
        s.lastSeenNotes = "2026-11-17-macos"
        let back = try JSONDecoder().decode(CenterSettings.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back.lastSeenNotes, "2026-11-17-macos")
        let old = try JSONDecoder().decode(CenterSettings.self, from: Data(#"{"server":"https://x"}"#.utf8))
        XCTAssertNil(old.lastSeenNotes)
    }
}
