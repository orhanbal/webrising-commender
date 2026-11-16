import Foundation
import XCTest
@testable import CenterCore

final class MessageAndMonitorTests: XCTestCase {
    override func tearDown() { L.use("tr") }

    func testInAppMessage() throws {
        let json = #"{"id":"m1","kind":"nps","title":"T","body":"B","ctaLabel":null,"ctaUrl":null}"#
        let m = try JSONDecoder().decode(InAppMessage.self, from: Data(json.utf8))
        XCTAssertTrue(m.isSurvey)
        XCTAssertEqual(m.scores, Array(0...10))
        XCTAssertEqual(InAppMessage(id: "c", kind: "csat", title: "", body: "").scores, [1, 2, 3, 4, 5])
        XCTAssertNil(m.cta)
        XCTAssertEqual(InAppMessage(id: "x", kind: "tip", title: "", body: "", ctaLabel: "Aç", ctaUrl: "https://wecommander.app/x").cta?.url.absoluteString,
                       "https://wecommander.app/x")
        // Only https links open.
        XCTAssertNil(InAppMessage(id: "x", kind: "tip", title: "", body: "", ctaLabel: "Aç", ctaUrl: "javascript:alert(1)").cta)
        XCTAssertNil(InAppMessage(id: "x", kind: "tip", title: "", body: "", ctaLabel: " ", ctaUrl: "https://a.b").cta)
    }

    func testPercentFollowsTheLanguage() {
        L.use("tr")
        XCTAssertEqual(Percent.text(42.4).filter { $0.isNumber || $0 == "%" }, "%42")
        L.use("en")
        XCTAssertEqual(Percent.text(42.4), "42%")
    }

    func testMonitorReading() {
        func sample(_ up: Double, total: UInt64, idle: UInt64, rx: UInt64) -> ServerSample {
            ServerSample(uptime: up, cpuTotal: total, cpuIdle: idle, memTotalKb: 1000, memAvailableKb: 250,
                         swapTotalKb: 0, swapFreeKb: 0, load1: 0.5, netRxBytes: rx, netTxBytes: 0,
                         diskReadBytes: 0, diskWriteBytes: 0, rootUsedKb: 90, rootAvailKb: 10, zombies: 0)
        }
        let first = MonitorMath.reading(previous: nil, now: sample(100, total: 1000, idle: 800, rx: 0))
        XCTAssertFalse(first.hasRates)
        XCTAssertEqual(first.mem, 75, accuracy: 0.01)
        XCTAssertEqual(first.disk, 90, accuracy: 0.01)
        XCTAssertEqual(first.swap, 0)
        let second = MonitorMath.reading(previous: sample(100, total: 1000, idle: 800, rx: 0),
                                         now: sample(102, total: 1200, idle: 850, rx: 4096), last: first)
        XCTAssertTrue(second.hasRates)
        XCTAssertEqual(second.cpu, 75, accuracy: 0.01)
        XCTAssertEqual(second.rx, 2048, accuracy: 0.01)
        XCTAssertEqual(second.worst, 90, accuracy: 0.01)
        // A restarted server (uptime went back) keeps the old rates.
        let reboot = MonitorMath.reading(previous: sample(102, total: 1200, idle: 850, rx: 4096),
                                         now: sample(5, total: 10, idle: 9, rx: 0), last: second)
        XCTAssertEqual(reboot.cpu, 75, accuracy: 0.01)
    }
}
