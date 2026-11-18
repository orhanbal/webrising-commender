import Foundation
import XCTest
@testable import CenterCore

/// The getting-started tutorial's steps (the same cases as the Windows TutorialTests).
final class TutorialTests: XCTestCase {
    func testStartsWithAddingAServerUnlessThereAreServers() {
        XCTAssertEqual(Tutorial.current(Tutorial.notStarted, off: false, hostCount: 0), Tutorial.addServer)
        XCTAssertEqual(Tutorial.current(Tutorial.notStarted, off: false, hostCount: 2), Tutorial.connect)
    }

    func testMovesOnWithWhatThePersonDoes() {
        var step = Tutorial.current(0, off: false, hostCount: 0)
        step = Tutorial.hostAdded(step)
        XCTAssertEqual(step, Tutorial.connect)
        step = Tutorial.terminalOpened(step)
        XCTAssertEqual(step, Tutorial.status)
        step = Tutorial.next(step)
        XCTAssertEqual(step, Tutorial.ai)
        step = Tutorial.next(Tutorial.next(step))
        XCTAssertEqual(step, Tutorial.done)
        // Later events do not bring it back.
        XCTAssertEqual(Tutorial.terminalOpened(Tutorial.hostAdded(step)), Tutorial.done)
    }

    func testServersFromSyncSkipTheFirstStepAndOffMeansDone() {
        XCTAssertEqual(Tutorial.current(Tutorial.addServer, off: false, hostCount: 1), Tutorial.connect)
        XCTAssertEqual(Tutorial.current(Tutorial.connect, off: true, hostCount: 1), Tutorial.done)
        XCTAssertEqual(Tutorial.restart(hostCount: 0), Tutorial.addServer)
    }

    func testStepAndOffAreSavedInTheSettings() throws {
        var s = CenterSettings()
        XCTAssertEqual(s.tutorialStep, Tutorial.notStarted)
        XCTAssertFalse(s.tutorialOff)
        s.tutorialStep = Tutorial.ai
        s.tutorialOff = true
        let back = try JSONDecoder().decode(CenterSettings.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back.tutorialStep, Tutorial.ai)
        XCTAssertTrue(back.tutorialOff)
        let old = try JSONDecoder().decode(CenterSettings.self, from: Data(#"{"server":"https://x"}"#.utf8))
        XCTAssertEqual(old.tutorialStep, Tutorial.notStarted)
        XCTAssertFalse(old.tutorialOff)
    }
}
