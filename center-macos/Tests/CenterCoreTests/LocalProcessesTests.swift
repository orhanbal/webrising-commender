import Foundation
import XCTest
@testable import CenterCore

/// Task Manager for this Mac: CPU between two readings, the protection rules,
/// the tree, search and sort, and the `ps` fallback reading.
final class LocalProcessesTests: XCTestCase {
    override func setUp() { L.use("tr") }
    override func tearDown() { L.use("tr") }

    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    private func p(_ pid: Int32, _ ppid: Int32, _ name: String, cpu: UInt64 = 0, uid: UInt32 = 501,
                   started: Date? = nil, memory: UInt64 = 100 * 1024 * 1024) -> LocalProcessInfo {
        LocalProcessInfo(pid: pid, ppid: ppid, name: name, uid: uid, user: "me", threads: 1, cpuTimeNs: cpu,
                         residentBytes: memory, path: "/Applications/" + name, started: started ?? t0)
    }

    func testCpuComesFromTwoReadingsOfTheSameProcess() {
        let before = LocalSnapshot(at: t0, processes: [p(10, 1, "a", cpu: 0), p(11, 1, "b", cpu: 0)])
        // Two seconds, four cores: 4 s of CPU time is half the machine.
        let now = LocalSnapshot(at: t0.addingTimeInterval(2), processes: [
            p(10, 1, "a", cpu: 4_000_000_000),
            p(11, 1, "b", cpu: 500_000_000, started: t0.addingTimeInterval(1)),
        ])
        let rows = LocalProcesses.rows(before: before, now: now, cpuCount: 4, selfPid: 999, selfUid: 501)
        XCTAssertEqual(rows[0].cpu, 50)
        // PID 11 was reused by another process: no rate from the old one.
        XCTAssertEqual(rows[1].cpu, 0)
        // The first reading has no rates.
        XCTAssertTrue(LocalProcesses.rows(before: nil, now: now, cpuCount: 4, selfPid: 999, selfUid: 501).allSatisfy { $0.cpu == 0 })
    }

    func testCriticalProcessesCannotBeEnded() {
        let critical: [LocalProcessInfo] = [
            p(0, 0, "kernel_task", uid: 0), p(1, 0, "launchd", uid: 0), p(300, 1, "WindowServer"),
            p(301, 1, "loginwindow"), p(302, 1, "postgres"), p(303, 1, "mysqld"), p(304, 1, "redis-server"),
            p(305, 1, "wecommander-core"), p(306, 1, "webrising-commender"), p(307, 1, "WecommanderCenter"),
            p(308, 1, "Finder"), p(309, 1, "cron", uid: 0),
        ]
        let rows = LocalProcesses.rows(before: nil, now: LocalSnapshot(at: t0, processes: critical), cpuCount: 4, selfPid: 999, selfUid: 501)
        for row in rows {
            XCTAssertFalse(row.canEnd, row.name)
            XCTAssertFalse((row.protectedReason ?? "").trimmingCharacters(in: .whitespaces).isEmpty, row.name)
        }
        XCTAssertTrue(rows[0].protectedReason?.contains("launchd") == true)
    }

    func testOrdinaryProcessesCanBeEndedButNotThisApp() {
        let list = [p(500, 1, "Safari"), p(999, 1, "Anything")]
        let rows = LocalProcesses.rows(before: nil, now: LocalSnapshot(at: t0, processes: list), cpuCount: 4, selfPid: 999, selfUid: 501)
        XCTAssertTrue(rows[0].canEnd)
        XCTAssertFalse(rows[1].canEnd) // this app's own PID, whatever its name
        // Running as root, another user's process may be ended.
        let asRoot = LocalProcesses.protectedReason(p(600, 1, "helper", uid: 502), selfPid: 1, selfUid: 0)
        XCTAssertNil(asRoot)
    }

    func testTheTreeNestsChildrenAndIgnoresReusedParents() {
        let list = [
            p(1, 0, "launchd", uid: 0),
            p(20, 1, "Terminal", cpu: 0),
            p(21, 20, "zsh"),
            p(22, 21, "vim"),
            // Its "parent" 23 started later: a reused PID, so it is a root of its own.
            p(24, 23, "orphan", started: t0),
            p(23, 1, "late", started: t0.addingTimeInterval(60)),
        ]
        let rows = LocalProcesses.rows(before: nil, now: LocalSnapshot(at: t0, processes: list), cpuCount: 4, selfPid: 999, selfUid: 501)
        let tree = LocalProcesses.tree(rows, column: "pid")
        let shape = tree.map { "\($0.row.name):\($0.depth)" }
        XCTAssertEqual(shape, ["launchd:0", "Terminal:1", "zsh:2", "vim:3", "late:1", "orphan:0"])
        XCTAssertEqual(LocalProcesses.childCount(rows, of: 20), 1)
    }

    func testSearchAndSort() {
        let list = [p(5, 1, "Safari", memory: 300), p(6, 1, "Mail", memory: 900), p(7, 1, "Notes", memory: 100)]
        let rows = LocalProcesses.rows(before: nil, now: LocalSnapshot(at: t0, processes: list), cpuCount: 4, selfPid: 999, selfUid: 501)
        XCTAssertEqual(LocalProcesses.filter(rows, "saf").map(\.pid), [5])
        XCTAssertEqual(LocalProcesses.filter(rows, "7").map(\.pid), [7])
        XCTAssertEqual(LocalProcesses.filter(rows, "/Applications/Mail").map(\.pid), [6])
        XCTAssertEqual(LocalProcesses.filter(rows, " ").count, 3)
        XCTAssertEqual(LocalProcesses.sorted(rows, column: "memory").map(\.pid), [6, 5, 7])
        XCTAssertEqual(LocalProcesses.sorted(rows, column: "name").map(\.pid), [6, 7, 5])
        XCTAssertEqual(LocalProcesses.sorted(rows, column: "pid").map(\.pid), [5, 6, 7])
        XCTAssertTrue(LocalProcesses.descending("cpu"))
        XCTAssertFalse(LocalProcesses.descending("name"))
    }

    func testPsFallbackReading() {
        XCTAssertEqual(PsOutput.cpuSeconds("0:01.50"), 1.5)
        XCTAssertEqual(PsOutput.cpuSeconds("123:45.67")!, 7425.67, accuracy: 0.001)
        XCTAssertEqual(PsOutput.cpuSeconds("1:02:03.00"), 3723)
        XCTAssertEqual(PsOutput.cpuSeconds("2-01:00:00"), 2 * 86400 + 3600)
        XCTAssertNil(PsOutput.cpuSeconds("x"))
        let text = """
            1     0     0   12345   1:02.00 /sbin/launchd
          412     1   501  204800   0:10.50 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
          bad line
          413   412   501      12   0:00.01 zsh
        """
        let list = PsOutput.parse(text)
        XCTAssertEqual(list.map(\.pid), [1, 412, 413])
        XCTAssertEqual(list[1].name, "Google Chrome")
        XCTAssertEqual(list[1].path, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        XCTAssertEqual(list[1].residentBytes, 204_800 * 1024)
        XCTAssertEqual(list[1].cpuTimeNs, 10_500_000_000)
        XCTAssertEqual(list[0].uid, 0)
        XCTAssertNil(list[2].path)

        // libproc gave no task info for root's launchd and missed PID 413: ps fills both.
        let libproc = [LocalProcessInfo(pid: 1, ppid: 0, name: "launchd", uid: 0), p(412, 1, "Google Chrome")]
        let merged = PsOutput.merge(libproc, with: list)
        XCTAssertEqual(merged.map(\.pid), [1, 412, 413])
        XCTAssertEqual(merged[0].residentBytes, 12_345 * 1024)
        XCTAssertEqual(merged[1].cpuTimeNs, 0) // libproc's own value is kept
    }
}
