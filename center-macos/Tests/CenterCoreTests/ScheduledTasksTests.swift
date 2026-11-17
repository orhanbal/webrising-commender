import Foundation
import XCTest
@testable import CenterCore

/// WECOMMANDER's scheduled tasks (docs/SCHEDULED_TASKS.md): the gateway
/// routes, the editor's checks and words, the run output cap, the core's
/// `hosts.exec` errors and the Center runner. The same cases as the Windows
/// app's ScheduledTasksTests.
final class ScheduledTasksTests: XCTestCase {
    override func setUp() { L.use("tr") }
    override func tearDown() { L.use("tr") }

    private let taskId = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
    private let runId = "11111111-2222-4333-8444-555555555555"

    private var taskJSON: String {
        """
        {"id":"\(taskId)","name":"Yedek","target":{"kind":"ssh","centerId":"c1","hostId":"h1","hostLabel":"web-1"},
         "command":"/usr/local/bin/backup.sh","schedule":{"kind":"cron","expr":"0 3 * * *"},"timezone":"Europe/Istanbul",
         "enabled":true,"timeoutSec":900,"notify":"always","nextRunAt":"2026-11-18T00:00:00Z",
         "lastRun":{"id":"\(runId)","taskId":"\(taskId)","scheduledFor":"2026-11-17T00:00:00Z","status":"failed","exitCode":2,"runner":"center","trigger":"schedule"}}
        """
    }

    func testListsTasksWithTargetScheduleAndLastRun() async throws {
        let json = "{\"items\":[" + taskJSON + "]}"
        let fake = FakeTransport { _ in (200, json) }
        let client = GatewayClient(baseURL: "https://wecommander.app/", transport: fake)
        let items = try await client.scheduledTasks(token: "tok")
        XCTAssertEqual(fake.calls[0].path, "/api/scheduled-tasks")
        XCTAssertEqual(fake.calls[0].auth, "Bearer tok")
        XCTAssertEqual(items.count, 1)
        let t = items[0]
        XCTAssertTrue(t.target.isSsh)
        XCTAssertEqual(t.target.centerId, "c1")
        XCTAssertEqual(t.target.hostId, "h1")
        XCTAssertEqual(t.target.hostLabel, "web-1")
        XCTAssertEqual(t.schedule.expr, "0 3 * * *")
        XCTAssertEqual(t.timeoutSec, 900)
        XCTAssertEqual(t.nextRunAt, GatewayDates.parse("2026-11-18T00:00:00Z"))
        XCTAssertEqual(t.lastRun?.status, "failed")
        XCTAssertEqual(t.lastRun?.exitCode, 2)
    }

    func testCreateUpdateDeleteRunAndRunsUseTheContractRoutes() async throws {
        let item = "{\"item\":" + taskJSON + "}"
        let run = "{\"run\":{\"id\":\"\(runId)\",\"taskId\":\"\(taskId)\",\"status\":\"queued\",\"trigger\":\"manual\"}}"
        let runs = "{\"items\":[{\"id\":\"\(runId)\",\"taskId\":\"\(taskId)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}]}"
        let fake = FakeTransport { request in
            let path = request.url!.path
            if path.hasSuffix("/run") { return (200, run) }
            if path.hasSuffix("/runs") { return (200, runs) }
            if request.httpMethod == "DELETE" { return (200, "{\"ok\":true}") }
            return (200, item)
        }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: fake)
        var draft = ScheduledTaskDraft()
        draft.name = "  Yedek "
        draft.target = .ssh(centerId: "c1", hostId: "h1", hostLabel: "web-1")
        draft.command = "/usr/local/bin/backup.sh"
        draft.schedule = .daily(hour: 3, minute: 5)
        draft.timezone = "Europe/Istanbul"
        draft.timeoutSec = 900
        draft.notify = "always"
        let created = try await client.createScheduledTask(token: "tok", draft: draft)
        XCTAssertEqual(created.id, taskId)
        let body = fake.calls[0].body ?? [:]
        XCTAssertEqual(fake.calls[0].method, "POST")
        XCTAssertEqual(body["name"] as? String, "Yedek")
        let target = body["target"] as? [String: Any]
        XCTAssertEqual(target?["kind"] as? String, "ssh")
        XCTAssertEqual(target?["hostId"] as? String, "h1")
        XCTAssertEqual(target?["centerId"] as? String, "c1")
        XCTAssertEqual((body["schedule"] as? [String: Any])?["expr"] as? String, "5 3 * * *")
        XCTAssertEqual(body["timeoutSec"] as? Int, 900)
        XCTAssertEqual(body["notify"] as? String, "always")
        XCTAssertEqual(body["enabled"] as? Bool, true)
        XCTAssertTrue(body["description"] is NSNull)

        _ = try await client.updateScheduledTask(token: "tok", id: taskId, changes: ["enabled": false])
        XCTAssertEqual(fake.calls[1].method, "PATCH")
        XCTAssertEqual(fake.calls[1].path, "/api/scheduled-tasks/" + taskId)
        XCTAssertEqual(fake.calls[1].body?["enabled"] as? Bool, false)
        XCTAssertEqual(fake.calls[1].body?.count, 1)

        let queued = try await client.runScheduledTask(token: "tok", id: taskId)
        XCTAssertEqual(queued.status, "queued")
        XCTAssertEqual(queued.trigger, "manual")
        XCTAssertEqual(fake.calls[2].path, "/api/scheduled-tasks/" + taskId + "/run")

        let list = try await client.scheduledTaskRuns(token: "tok", id: taskId)
        XCTAssertEqual(list.map(\.output), ["ok"])
        XCTAssertEqual(fake.calls[3].path, "/api/scheduled-tasks/" + taskId + "/runs?limit=50")

        try await client.deleteScheduledTask(token: "tok", id: taskId)
        XCTAssertEqual(fake.calls[4].method, "DELETE")

        // An id that is not a uuid never reaches the URL.
        do {
            try await client.deleteScheduledTask(token: "tok", id: "../devices")
            XCTFail("expected a refusal")
        } catch let e as GatewayError {
            XCTAssertEqual(e.code, "invalid_request")
        }
        XCTAssertEqual(fake.calls.count, 5)
    }

    func testPreviewReturnsFiveTimesAndExplainsAnInvalidSchedule() async throws {
        let fake = FakeTransport { request in
            let body = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
            if body.contains("\"bad\"") {
                return (400, #"{"error":"invalid_schedule","message":"cron: expected 5 fields"}"#)
            }
            return (200, #"{"next":["2026-11-18T00:00:00Z","2026-11-19T00:00:00Z","2026-11-20T00:00:00Z","2026-11-21T00:00:00Z","2026-11-22T00:00:00Z"]}"#)
        }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: fake)
        let next = try await client.previewSchedule(token: "tok", schedule: .interval(30), timezone: "Europe/Istanbul")
        XCTAssertEqual(next.count, 5)
        let schedule = fake.calls[0].body?["schedule"] as? [String: Any]
        XCTAssertEqual(schedule?["kind"] as? String, "interval")
        XCTAssertEqual(schedule?["minutes"] as? Int, 30)
        XCTAssertEqual(fake.calls[0].body?["timezone"] as? String, "Europe/Istanbul")
        do {
            _ = try await client.previewSchedule(token: "tok", schedule: .cron("bad"), timezone: "UTC")
            XCTFail("expected 400")
        } catch let e as GatewayError {
            XCTAssertEqual(e.status, 400)
            XCTAssertEqual(e.serverMessage, "cron: expected 5 fields")
            XCTAssertTrue(ScheduleText.error(e).hasSuffix("cron: expected 5 fields"))
        }
    }

    func testViewerAndOlderServersGetClearMessages() async {
        let fake = FakeTransport { request in
            request.url!.path.hasSuffix("/run") ? (403, #"{"error":"forbidden"}"#) : (404, "{}")
        }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: fake)
        do {
            _ = try await client.runScheduledTask(token: "tok", id: taskId)
            XCTFail("expected 403")
        } catch {
            XCTAssertEqual(ScheduleText.error(error), ScheduleText.readOnly)
        }
        do {
            _ = try await client.scheduledTasks(token: "tok")
            XCTFail("expected 404")
        } catch {
            XCTAssertTrue(ScheduleText.error(error).contains("desteklemiyor"))
        }
        XCTAssertTrue(ScheduleText.canEdit(role: "owner"))
        XCTAssertTrue(ScheduleText.canEdit(role: "admin"))
        XCTAssertTrue(ScheduleText.canEdit(role: nil))
        XCTAssertFalse(ScheduleText.canEdit(role: "viewer"))
        XCTAssertFalse(ScheduleText.canEdit(role: "operator"))
    }

    func testClaimAndResultUseTheCenterRoutes() async throws {
        let claim = "{\"items\":[{\"run\":{\"id\":\"\(runId)\",\"taskId\":\"\(taskId)\",\"status\":\"running\"},\"task\":" + taskJSON + "}]}"
        let fake = FakeTransport { request in request.httpMethod == "GET" ? (200, claim) : (200, #"{"ok":true}"#) }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: fake)
        let claimed = try await client.claimScheduledRuns(token: "tok")
        XCTAssertEqual(claimed.count, 1)
        XCTAssertEqual(claimed[0].run.id, runId)
        XCTAssertEqual(claimed[0].task.command, "/usr/local/bin/backup.sh")
        XCTAssertEqual(fake.calls[0].path, "/api/center/scheduled-runs/claim")

        let result = ScheduledRunResult(status: "failed", exitCode: 1, output: "boom", error: "exit 1")
        try await client.postScheduledRunResult(token: "tok", runId: runId, result: result)
        XCTAssertEqual(fake.calls[1].path, "/api/center/scheduled-runs/" + runId + "/result")
        let body = fake.calls[1].body ?? [:]
        XCTAssertEqual(body["status"] as? String, "failed")
        XCTAssertEqual(body["exitCode"] as? Int, 1)
        XCTAssertEqual(body["output"] as? String, "boom")
        XCTAssertEqual(body["error"] as? String, "exit 1")
        let ok = ScheduledRunResult(status: "succeeded", exitCode: nil, output: "", error: nil).json()
        XCTAssertNil(ok["error"])
        XCTAssertTrue(ok["exitCode"] is NSNull)
    }

    func testCronSchedulesInWords() {
        let cases: [(String, String)] = [
            ("0 3 * * *", "Her gün saat 03:00"),
            ("30 22 * * 1", "Her pazartesi saat 22:30"),
            ("0 9 * * 0", "Her pazar saat 09:00"),
            ("0 9 * * 7", "Her pazar saat 09:00"),
            ("15 8 * * 1-5", "Hafta içi her gün saat 08:15"),
            ("0 10 * * 0,6", "Hafta sonu her gün saat 10:00"),
            ("0 4 1 * *", "Her ayın 1. günü saat 04:00"),
            ("*/10 * * * *", "Her 10 dakikada bir"),
            ("5 * * * *", "Her saat, 5. dakikada"),
            ("0 0 1 1 *", "Gelişmiş (cron): 0 0 1 1 *"),
            ("0 3 * *", "Gelişmiş (cron): 0 3 * *"),
        ]
        for (expr, words) in cases {
            XCTAssertEqual(ScheduleText.describe(.cron(expr)), words, expr)
        }
    }

    func testIntervalAndOnceInWords() {
        XCTAssertEqual(ScheduleText.describe(.interval(15)), "Her 15 dakikada bir")
        XCTAssertEqual(ScheduleText.describe(.interval(120)), "Her 2 saatte bir")
        XCTAssertEqual(ScheduleText.describe(.interval(1440)), "Her 1 günde bir")
        XCTAssertEqual(ScheduleText.describe(.interval(90)), "Her 90 dakikada bir")
        let at = GatewayDates.parse("2026-11-20T06:00:00Z")!
        let istanbul = TimeZone(secondsFromGMT: 3 * 3600)!
        XCTAssertEqual(ScheduleText.describe(.once(at), timeZone: istanbul), "Bir kez: 20.11.2026 09:00")
        XCTAssertEqual(TaskSchedule.once(at).json()["at"] as? String, "2026-11-20T06:00:00Z")
        XCTAssertEqual(TaskSchedule.once(at).json()["kind"] as? String, "once")
        XCTAssertEqual(ScheduleText.localTime(nil), "—")
        L.use("en")
        XCTAssertEqual(ScheduleText.describe(.cron("0 3 * * *")), "Every day at 03:00")
    }

    func testTheFormReadsBackWhatItWrote() {
        let weekly = ScheduleText.form(.weekly(weekday: 3, hour: 7, minute: 45))
        XCTAssertEqual(weekly.mode, 1)
        XCTAssertEqual(weekly.hour, 7)
        XCTAssertEqual(weekly.minute, 45)
        XCTAssertEqual(weekly.weekday, 3)
        let daily = ScheduleText.form(.daily(hour: 23, minute: 5))
        XCTAssertEqual(daily.mode, 0)
        XCTAssertEqual(daily.hour, 23)
        XCTAssertEqual(daily.minute, 5)
        XCTAssertEqual(ScheduleText.form(.interval(45)).mode, 2)
        XCTAssertEqual(ScheduleText.form(.interval(45)).minutes, 45)
        XCTAssertEqual(ScheduleText.form(.once(Date())).mode, 3)
        let advanced = ScheduleText.form(.cron("0 0 1 1 *"))
        XCTAssertEqual(advanced.mode, 4)
        XCTAssertEqual(advanced.expr, "0 0 1 1 *")
        XCTAssertEqual(ScheduleText.form(.weekly(weekday: 0, hour: 9, minute: 0)).weekday, 0)
        XCTAssertEqual(ScheduleText.weekOrder.first, 1)
        XCTAssertEqual(ScheduleText.day(0), "pazar")
    }

    func testRunStatusBadges() {
        XCTAssertEqual(ScheduleText.status("succeeded"), "Başarılı")
        XCTAssertEqual(ScheduleText.status("failed"), "Başarısız")
        XCTAssertEqual(ScheduleText.status("missed"), "Kaçırıldı")
        XCTAssertEqual(ScheduleText.status("running"), "Çalışıyor")
        XCTAssertEqual(ScheduleText.status(nil), "Henüz çalışmadı")
        XCTAssertEqual(ScheduleText.tone("failed"), "bad")
        XCTAssertEqual(ScheduleText.tone("queued"), "busy")
        XCTAssertEqual(ScheduleText.tone(nil), "none")
        XCTAssertEqual(ScheduleText.notifyLabel("never"), "Bildirme")
    }

    func testDraftValidation() {
        let now = GatewayDates.parse("2026-11-17T12:00:00Z")!
        var ok = ScheduledTaskDraft()
        ok.name = "x"
        ok.target = .device("d1")
        ok.command = "uptime"
        XCTAssertNil(ok.validate(now: now))
        func with(_ change: (inout ScheduledTaskDraft) -> Void) -> String? {
            var d = ok
            change(&d)
            return d.validate(now: now)
        }
        XCTAssertNotNil(with { $0.name = "" })
        XCTAssertNotNil(with { $0.name = String(repeating: "a", count: 81) })
        XCTAssertNotNil(with { $0.target = nil })
        XCTAssertNotNil(with { $0.command = "  " })
        XCTAssertNotNil(with { $0.command = String(repeating: "a", count: 4001) })
        XCTAssertNotNil(with { $0.timeoutSec = 5 })
        XCTAssertNotNil(with { $0.notify = "sometimes" })
        XCTAssertNotNil(with { $0.schedule = .interval(4) })
        XCTAssertNotNil(with { $0.schedule = .once(now.addingTimeInterval(-60)) })
        XCTAssertNotNil(with { $0.schedule = .cron("* * *") })
        XCTAssertNil(with { $0.schedule = .cron("*/5 1-3 * * MON") })
        XCTAssertNil(with { $0.schedule = .once(now.addingTimeInterval(3600)) })
        let device = TaskTarget.device("d1").json()
        XCTAssertEqual(device["kind"] as? String, "device")
        XCTAssertEqual(device["deviceId"] as? String, "d1")
        XCTAssertTrue(TaskTarget.ssh(centerId: "c", hostId: "h", hostLabel: "a").sameAs(.ssh(centerId: "c", hostId: "h", hostLabel: "b")))
        XCTAssertFalse(TaskTarget.device("d1").sameAs(.device("d2")))
    }

    func testOutputIsCappedAt64KiBKeepingTheEnd() {
        XCTAssertEqual(RunOutput.cap("short"), "short")
        let big = String(repeating: "a", count: 70_000) + "THE END"
        let capped = RunOutput.cap(big)
        XCTAssertLessThanOrEqual(capped.utf8.count, RunOutput.maxBytes)
        XCTAssertTrue(capped.hasSuffix("THE END"))
        XCTAssertTrue(capped.hasPrefix("…"))
        // Multi-byte text is never cut inside a character.
        let turkish = String(repeating: "ğüş😀", count: 10_000)
        let t = RunOutput.cap(turkish, maxBytes: 1000)
        XCTAssertLessThanOrEqual(t.utf8.count, 1000)
        XCTAssertFalse(t.contains("\u{FFFD}"))
        XCTAssertTrue(t.hasSuffix("😀"))
    }

    func testResultMapping() {
        XCTAssertEqual(ScheduledRunResult.from(RemoteExecResult(exitCode: 0, output: "ok", error: nil)).status, "succeeded")
        XCTAssertEqual(ScheduledRunResult.from(RemoteExecResult(exitCode: 3, output: "x", error: nil)).status, "failed")
        XCTAssertEqual(ScheduledRunResult.from(RemoteExecResult(exitCode: 0, output: "x", error: nil, timedOut: true)).status, "failed")
        let noConnect = ScheduledRunResult.from(RemoteExecResult(exitCode: nil, output: "", error: "no login"))
        XCTAssertEqual(noConnect.status, "failed")
        XCTAssertNil(noConnect.exitCode)
        XCTAssertEqual(noConnect.error, "no login")
    }

    func testHostExecErrorsBecomeClearTexts() {
        let split = HostExecText.split("needs_credential: web: no saved credential; connect to it once and save it")
        XCTAssertEqual(split.code, "needs_credential")
        XCTAssertEqual(split.detail, "web: no saved credential; connect to it once and save it")
        XCTAssertEqual(HostExecText.split("core stopped").code, "")
        XCTAssertEqual(HostExecText.split("Web: x").code, "")
        XCTAssertEqual(HostExecText.split("Web: x").detail, "Web: x")
        XCTAssertTrue(HostExecText.error("needs_credential: web: no saved credential; connect to it once and save it").hasPrefix(HostExecText.needsSavedLogin))
        XCTAssertTrue(HostExecText.error("host_key_unknown: web: connect to it once in a terminal to approve its host key").contains("onaylanmadı"))
        XCTAssertTrue(HostExecText.error("host_key_changed: web: HOST KEY CHANGED: trusted A, server presented B").contains("değişti"))
        XCTAssertTrue(HostExecText.error("host_not_found: host not found").contains("kayıtlı sunucuları"))
        XCTAssertTrue(HostExecText.error("not_ssh: telnet hosts cannot run commands").contains("SSH"))
        XCTAssertTrue(HostExecText.error("connect_failed: web: connection failed: refused").hasPrefix("Sunucuya bağlanılamadı: "))
        XCTAssertTrue(HostExecText.error("exec_failed: ssh error: x").hasPrefix("Komut çalıştırılamadı: "))
    }

    func testHostExecResultsMapToRunResults() {
        XCTAssertEqual(HostExecText.result(exitCode: 0, output: "ok", timedOut: false, timeoutSec: 600), RemoteExecResult(exitCode: 0, output: "ok", error: nil))
        XCTAssertEqual(HostExecText.result(exitCode: 2, output: "bad", timedOut: false, timeoutSec: 600), RemoteExecResult(exitCode: 2, output: "bad", error: nil))
        let slow = HostExecText.result(exitCode: nil, output: "started", timedOut: true, timeoutSec: 30)
        XCTAssertTrue(slow.timedOut)
        XCTAssertTrue(slow.error?.contains("30") == true)
        XCTAssertEqual(ScheduledRunResult.from(slow).status, "failed")
        let killed = HostExecText.result(exitCode: nil, output: "", timedOut: false, timeoutSec: 30)
        XCTAssertNotNil(killed.error)
        XCTAssertEqual(ScheduledRunResult.from(killed).status, "failed")
        let reply = try? JSONDecoder().decode(HostExecReply.self, from: Data(#"{"exitCode":null,"output":"x","timedOut":true,"truncated":false}"#.utf8))
        XCTAssertNil(reply?.exitCode)
        XCTAssertEqual(reply?.timedOut, true)
    }

    // MARK: the runner

    private actor FakeRunTransport: ScheduledRunTransport {
        var claims: [ClaimedRun]
        var claimFails = false
        var failPosts = 0
        var posted: [(id: String, result: ScheduledRunResult)] = []
        var claimCount = 0

        init(_ claims: [ClaimedRun], failPosts: Int = 0) {
            self.claims = claims
            self.failPosts = failPosts
        }

        func setClaimFails() { claimFails = true }

        func claim() async throws -> [ClaimedRun] {
            claimCount += 1
            if claimFails { throw GatewayError(.network, 0, "network", "offline") }
            return claims
        }

        func postResult(runId: String, result: ScheduledRunResult) async throws {
            if failPosts > 0 {
                failPosts -= 1
                throw GatewayError(.network, 0, "network", "offline")
            }
            posted.append((id: runId, result: result))
        }
    }

    private actor CallLog {
        var calls: [(host: String, command: String, timeout: Int)] = []
        func add(_ host: String, _ command: String, _ timeout: Int) { calls.append((host, command, timeout)) }
    }

    private struct Boom: LocalizedError {
        var errorDescription: String? { "core crashed" }
    }

    private struct FakeExecutor: RemoteExecutor {
        let log: CallLog
        let delay: UInt64
        func run(hostId: String, command: String, timeoutSec: Int) async throws -> RemoteExecResult {
            await log.add(hostId, command, timeoutSec)
            if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
            if hostId == "boom" { throw Boom() }
            if hostId == "locked" { return RemoteExecResult(exitCode: nil, output: "", error: "needs a password") }
            return RemoteExecResult(exitCode: 0, output: "up 3 days", error: nil)
        }
    }

    private func claim(_ id: String, _ target: TaskTarget, timeout: Int = 600) -> ClaimedRun {
        ClaimedRun(run: TaskRun(id: id, status: "running"),
                   task: ScheduledTask(id: taskId, target: target, command: "uptime", timeoutSec: timeout))
    }

    func testRunnerRunsEachClaimedSshRunOnceAndPostsItsResult() async {
        let log = CallLog()
        let transport = FakeRunTransport([claim(runId, .ssh(centerId: "c1", hostId: "h1", hostLabel: "web-1"), timeout: 5000)])
        let runner = ScheduledRunner(executor: FakeExecutor(log: log, delay: 300_000_000))
        let first = await runner.pollOnce(transport)
        XCTAssertEqual(first, 1)
        // Claimed again while it still runs: not started twice.
        let second = await runner.pollOnce(transport)
        XCTAssertEqual(second, 0)
        await runner.whenIdle()
        let calls = await log.calls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.host, "h1")
        XCTAssertEqual(calls.first?.command, "uptime")
        XCTAssertEqual(calls.first?.timeout, 3600)
        let posted = await transport.posted
        XCTAssertEqual(posted.count, 1)
        XCTAssertEqual(posted.first?.id, runId)
        XCTAssertEqual(posted.first?.result.status, "succeeded")
        XCTAssertEqual(posted.first?.result.exitCode, 0)
        XCTAssertEqual(posted.first?.result.output, "up 3 days")
        let active = await runner.activeCount
        XCTAssertEqual(active, 0)
    }

    func testRunnerReportsFailuresAndNeverThrows() async {
        let other = "22222222-2222-4333-8444-555555555555"
        let third = "33333333-2222-4333-8444-555555555555"
        let transport = FakeRunTransport([
            claim(runId, .device("d1")),
            claim(other, .ssh(centerId: "c1", hostId: "boom", hostLabel: "x")),
            claim(third, .ssh(centerId: "c1", hostId: "locked", hostLabel: "y")),
        ], failPosts: 1)
        let runner = ScheduledRunner(executor: FakeExecutor(log: CallLog(), delay: 0))
        let started = await runner.pollOnce(transport)
        XCTAssertEqual(started, 3)
        await runner.whenIdle()
        let posted = await transport.posted
        XCTAssertEqual(posted.count, 3) // one post failed once and was sent again
        XCTAssertTrue(posted.allSatisfy { $0.result.status == "failed" })
        XCTAssertTrue(posted.first(where: { $0.id == other })?.result.error?.contains("core crashed") == true)
        XCTAssertEqual(posted.first(where: { $0.id == third })?.result.error, "needs a password")
        XCTAssertNotNil(posted.first(where: { $0.id == runId })?.result.error)

        await transport.setClaimFails()
        let none = await runner.pollOnce(transport)
        XCTAssertEqual(none, 0)
    }
}

/// The console's usage breakdown reads the app's version and language from /api/center/me.
final class CenterMeQueryTests: XCTestCase {
    override func tearDown() { L.use("tr") }

    func testMeCarriesVersionAndLanguage() async throws {
        L.use("pt-BR")
        let fake = FakeTransport { _ in (200, #"{"centerId":"c1","name":"Mac","role":"owner"}"#) }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: fake)
        _ = try await client.me(token: "t", version: "0.1.58")
        XCTAssertEqual(fake.calls[0].path, "/api/center/me?platform=macos&version=0.1.58&lang=pt-BR")
        XCTAssertEqual(GatewayClient.mePath(version: "dev build", language: "en"), "/api/center/me?platform=macos&version=dev%20build&lang=en")
        XCTAssertFalse(GatewayClient.appVersion.isEmpty)
    }
}
