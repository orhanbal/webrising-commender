import Foundation
import XCTest
@testable import CenterCore

/// The timers page: the core's JSON (a disabled DEVAGENT timer included), its
/// badges, schedule text, form checks and the commands it confirms (the same
/// cases as the Windows app's ServerTimersTests).
final class ServerTimersTests: XCTestCase {
    override func setUp() { L.use("tr") }
    override func tearDown() { L.use("tr") }

    private let json = """
    {"privilege":"sudo","loginUser":"wecommander","systemd":true,
     "timers":[
      {"unit":"devagent-local-ci.timer","scope":"system","description":"Check DEVAGENT branch for new commits every 15 minutes","unitFileState":"disabled","activeState":"inactive","subState":"dead",
       "calendar":[],"monotonic":["OnUnitInactiveUSec=15min","OnBootUSec=3min"],"schedule":"OnUnitInactiveUSec=15min ; OnBootUSec=3min","nextRun":null,"lastRun":null,
       "service":"devagent-local-ci.service","serviceDescription":"DEVAGENT offline-safe local CI acceptance (no GitHub Actions)","command":"/usr/local/libexec/devagent-ci-poll","user":"devagent-ci",
       "result":"success","exitStatus":0,"lastExit":null,"serviceState":"inactive","fragmentPath":"/etc/systemd/system/devagent-local-ci.timer","persistent":true,"managed":null},
      {"unit":"logrotate.timer","scope":"system","description":"Daily rotation of log files","unitFileState":"enabled","activeState":"active","subState":"waiting",
       "calendar":["*-*-* 00:00:00"],"monotonic":[],"schedule":"OnCalendar=*-*-* 00:00:00","nextRun":1794960000,"lastRun":1794873601,
       "service":"logrotate.service","serviceDescription":"Rotate log files","command":"/usr/sbin/logrotate /etc/logrotate.conf","user":"root",
       "result":"exit-code","exitStatus":1,"lastExit":1794873602,"serviceState":"failed","fragmentPath":"/usr/lib/systemd/system/logrotate.timer","persistent":true,"managed":null},
      {"unit":"nightly-backup.timer","scope":"system","description":"Nightly backup","unitFileState":"enabled","activeState":"active","subState":"waiting",
       "calendar":["*-*-* 03:00:00"],"monotonic":[],"schedule":"OnCalendar=*-*-* 03:00:00","nextRun":1794970800,"lastRun":null,
       "service":"nightly-backup.service","serviceDescription":"Nightly backup","command":"/bin/sh -c echo hi","user":"backup",
       "result":"success","exitStatus":0,"lastExit":null,"serviceState":"activating","fragmentPath":"/etc/systemd/system/nightly-backup.timer","persistent":true,
       "managed":{"name":"nightly-backup","description":"Nightly backup","command":"echo hi","user":"backup","calendar":"*-*-* 03:00:00"}},
      {"unit":"mine.timer","scope":"user","description":"","unitFileState":"enabled","activeState":"active","subState":"waiting","calendar":["hourly"],"monotonic":[],"schedule":"","nextRun":null,"lastRun":null,
       "service":"mine.service","serviceDescription":"","command":"","user":"","result":"","exitStatus":null,"lastExit":null,"serviceState":"inactive","fragmentPath":"","persistent":false,"managed":null}
     ],
     "cron":[
      {"source":"/etc/cron.d/certbot","schedule":"0 */12 * * *","user":"root","command":"certbot -q renew"},
      {"source":"/etc/cron.d/secret","schedule":"","user":"","command":""},
      {"source":"/etc/cron.daily","schedule":"daily","user":"root","command":"/etc/cron.daily/logrotate"}
     ],
     "crontab":"not-readable","crontabMessage":"fopen: Permission denied"}
    """

    private func read() throws -> ServerTimers {
        try JSONDecoder().decode(ServerTimers.self, from: Data(json.utf8))
    }

    func testTheDisabledDevagentTimerIsPassiveWithItsMonotonicSchedule() throws {
        let s = try read()
        XCTAssertTrue(s.canChange)
        let d = s.timers[0]
        XCTAssertEqual(TimerView.state(d), "passive")
        XCTAssertEqual(TimerView.stateText(d), "Pasif")
        XCTAssertFalse(d.isEnabled)
        XCTAssertTrue(TimerView.canEnable(d))
        XCTAssertFalse(TimerView.canDisable(d))
        XCTAssertFalse(TimerView.canStop(d))
        XCTAssertEqual(TimerView.schedule(d), "son çalışma bitince 15min sonra · açılıştan 3min sonra")
        XCTAssertEqual(TimerView.time(d.nextRun), "—")
        XCTAssertEqual(TimerView.relative(d.lastRun, now: Date()), "")
        XCTAssertEqual(d.user, "devagent-ci")
        XCTAssertEqual(d.command, "/usr/local/libexec/devagent-ci-poll")
        XCTAssertFalse(d.isManaged)
    }

    func testBadgesActionsAndTimes() throws {
        let s = try read()
        var l = s.timers[1]
        XCTAssertEqual(TimerView.state(l), "active")
        XCTAssertFalse(TimerView.canEnable(l))
        XCTAssertTrue(TimerView.canDisable(l))
        XCTAssertEqual(TimerView.schedule(l), "*-*-* 00:00:00")
        XCTAssertEqual(TimerView.result(l), "exit-code (1)")
        XCTAssertEqual(TimerView.result(s.timers[0]), "success")
        let istanbul = TimeZone(secondsFromGMT: 3 * 3600)!
        XCTAssertTrue(TimerView.time(l.nextRun, timeZone: istanbul).contains("03:00"))
        XCTAssertEqual(TimerView.relative(l.nextRun, now: Date(timeIntervalSince1970: 1_794_960_000 - 7200)), "2 sa 0 dk sonra")
        XCTAssertEqual(TimerView.relative(1000, now: Date(timeIntervalSince1970: 1040)), "40 sn önce")
        XCTAssertTrue(TimerView.canStop(s.timers[2]))
        XCTAssertTrue(s.timers[2].isManaged)
        let user = s.timers[3]
        XCTAssertFalse(user.isSystem)
        XCTAssertFalse(TimerView.canEnable(user) || TimerView.canDisable(user) || TimerView.canRunNow(user))
        l.unitFileState = "masked"
        XCTAssertEqual(TimerView.state(l), "masked")
        l = s.timers[1]
        l.activeState = "failed"
        XCTAssertEqual(TimerView.state(l), "failed")
        l = s.timers[1]
        l.unitFileState = "static"
        l.activeState = "inactive"
        XCTAssertFalse(TimerView.canEnable(l))
    }

    func testOrderAndFilter() throws {
        let s = try read()
        XCTAssertEqual(TimerView.ordered(s.timers.reversed()).map(\.unit),
                       ["devagent-local-ci.timer", "logrotate.timer", "nightly-backup.timer", "mine.timer"])
        XCTAssertEqual(TimerView.ordered(s.timers, filter: "DEVAGENT-ci").map(\.unit), ["devagent-local-ci.timer"])
        XCTAssertEqual(TimerView.ordered(s.timers, filter: "backup").map(\.unit), ["nightly-backup.timer"])
    }

    func testCronIsReadOnlyAndTheCrontabStateIsSaid() throws {
        var s = try read()
        XCTAssertEqual(s.cron.count, 3)
        XCTAssertTrue(s.cron[1].unreadable)
        XCTAssertFalse(s.cron[0].unreadable)
        XCTAssertEqual(TimerView.crontabNote(s), "wecommander kullanıcısının crontab'ı okunamadı (izin yok).")
        s.crontab = "ok"
        XCTAssertEqual(TimerView.crontabNote(s), "")
    }

    private let spec = TimerSpec(name: "nightly-backup", description: "Nightly backup 100%", command: "echo 'it''s' > /tmp/x",
                                 user: "backup", calendar: "*-*-* 03:00:00")

    func testTheFormIsChecked() {
        XCTAssertNil(TimerView.check(spec))
        var ok = spec
        ok.name = "db-dump_2.nightly"
        ok.calendar = "Mon..Fri *-*-* 03:00:00"
        XCTAssertNil(TimerView.check(ok))
        for bad in ["", "-x", "Backup", "a b", "a;rm", "x.timer", "x.service", String(repeating: "a", count: 65)] {
            var s = spec
            s.name = bad
            XCTAssertNotNil(TimerView.check(s), bad)
        }
        for bad in ["", "daily; rm -rf /", "$(id)", "-1"] {
            var s = spec
            s.calendar = bad
            XCTAssertNotNil(TimerView.check(s), bad)
        }
        var s = spec
        s.user = "Root"
        XCTAssertNotNil(TimerView.check(s))
        s = spec
        s.command = "a\nb"
        XCTAssertNotNil(TimerView.check(s))
        s = spec
        s.command = " "
        XCTAssertNotNil(TimerView.check(s))
        s = spec
        s.description = "a\nb"
        XCTAssertNotNil(TimerView.check(s))
    }

    func testCommandsMatchWhatTheCoreRuns() throws {
        let s = try read()
        XCTAssertEqual(TimerView.actionCommand(s.timers[0], "enable"), "systemctl enable --now devagent-local-ci.timer")
        XCTAssertEqual(TimerView.actionCommand(s.timers[1], "disable"), "systemctl disable --now logrotate.timer")
        XCTAssertEqual(TimerView.actionCommand(s.timers[0], "start-now"), "systemctl start --no-block devagent-local-ci.service")
        XCTAssertEqual(TimerView.actionCommand(s.timers[0], "stop"), "systemctl stop devagent-local-ci.service")
        var odd = s.timers[0]
        odd.unit = "dev-x\\x2dy.timer"
        XCTAssertEqual(TimerView.actionCommand(odd, "enable"), "systemctl enable --now 'dev-x\\x2dy.timer'")
        XCTAssertNil(TimerView.actionCommand(s.timers[0], "rm"))
        XCTAssertEqual(TimerView.logsCommand(s.timers[0], lines: 200), "journalctl -u devagent-local-ci.service -n 200 --no-pager -o short-iso")

        XCTAssertEqual(TimerView.execStart("cd /srv && pg_dump \"$DB\" | gzip > /backup/db-$(date +%F).gz \\ end"),
                       "/bin/sh -c \"cd /srv && pg_dump \\\"$$DB\\\" | gzip > /backup/db-$$(date +%%F).gz \\\\ end\"")
        let service = TimerView.serviceFile(spec)
        XCTAssertTrue(service.hasPrefix("# Managed by WECOMMANDER\n"))
        XCTAssertTrue(service.contains("Description=Nightly backup 100%%\n"))
        XCTAssertTrue(service.contains("\nUser=backup\n"))
        let timer = TimerView.timerFile(spec)
        XCTAssertTrue(timer.contains("\nOnCalendar=*-*-* 03:00:00\nPersistent=true\nUnit=nightly-backup.service\n"))

        let write = TimerView.writeCommand(spec, edit: false)
        XCTAssertTrue(write.hasPrefix("printf '%s' '# Managed by WECOMMANDER"))
        XCTAssertTrue(write.contains("echo '\\''it'\\'''\\''s'\\'' > /tmp/x"))
        XCTAssertTrue(write.contains("| tee /etc/systemd/system/nightly-backup.service >/dev/null"))
        XCTAssertTrue(write.hasSuffix("systemctl daemon-reload\nsystemctl enable --now nightly-backup.timer"))
        XCTAssertTrue(TimerView.writeCommand(spec, edit: true).hasSuffix("systemctl try-restart nightly-backup.timer"))
        XCTAssertEqual(TimerView.deleteCommand("nightly-backup"),
                       "systemctl disable --now nightly-backup.timer\nrm -f /etc/systemd/system/nightly-backup.timer /etc/systemd/system/nightly-backup.service\nsystemctl daemon-reload")
        XCTAssertEqual(TimerView.nameOf(s.timers[2]), "nightly-backup")
        XCTAssertEqual(TimerView.nameOf(s.timers[1]), "logrotate")
    }

    func testOlderCoresWithFewerFieldsStillDecode() throws {
        let s = try JSONDecoder().decode(ServerTimers.self, from: Data(#"{"privilege":"user","timers":[{"unit":"a.timer"}]}"#.utf8))
        XCTAssertFalse(s.canChange)
        XCTAssertEqual(s.timers.first?.unit, "a.timer")
        XCTAssertTrue(s.timers.first?.isSystem == true)
        XCTAssertEqual(s.cron, [])
    }
}
