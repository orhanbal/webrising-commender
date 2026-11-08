import Foundation
import XCTest
@testable import CenterCore

final class FakeTransport: HTTPTransport, @unchecked Sendable {
    var calls: [(method: String, path: String, auth: String?, body: [String: Any]?)] = []
    let respond: (URLRequest) -> (Int, String)
    init(_ respond: @escaping (URLRequest) -> (Int, String)) { self.respond = respond }

    func send(_ request: URLRequest) async throws -> (Data, Int) {
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let path = request.url!.path + (request.url!.query.map { "?" + $0 } ?? "")
        calls.append((request.httpMethod ?? "", path, request.value(forHTTPHeaderField: "Authorization"), body))
        let (status, json) = respond(request)
        return (Data(json.utf8), status)
    }
}

final class CenterCoreTests: XCTestCase {
    func testServerURLAcceptsHttpsOriginsOnly() throws {
        XCTAssertEqual(try ServerURL.normalize("https://wecommander.app/"), "https://wecommander.app")
        XCTAssertEqual(try ServerURL.normalize(" https://Example.com:8443 "), "https://example.com:8443")
        XCTAssertEqual(try ServerURL.normalize("http://localhost:8080"), "http://localhost:8080")
        XCTAssertThrowsError(try ServerURL.normalize("http://wecommander.app"))
        XCTAssertThrowsError(try ServerURL.normalize("https://wecommander.app/path"))
        XCTAssertThrowsError(try ServerURL.normalize("https://u:p@wecommander.app"))
        XCTAssertThrowsError(try ServerURL.normalize("not a url"))
    }

    func testTextsAndCountdowns() {
        XCTAssertEqual(Texts.kindLabel("process_exec"), "Komut çalıştır")
        XCTAssertEqual(Texts.kindLabel("other"), "other")
        XCTAssertEqual(Texts.forErrorCode("approval_request_expired", status: 409).prefix(13), "Bu onay isteğ")
        XCTAssertTrue(Texts.forErrorCode("", status: 500).contains("500"))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(Texts.remaining(now.addingTimeInterval(492), now: now), "8 dk 12 sn")
        XCTAssertEqual(Texts.remaining(now.addingTimeInterval(-1), now: now), "süresi doldu")
        XCTAssertEqual(Texts.remaining(now.addingTimeInterval(45), now: now), "45 sn")
        XCTAssertEqual(Texts.countdown(now.addingTimeInterval(247), now: now), "4:07")
        XCTAssertEqual(Texts.countdown(now.addingTimeInterval(3725), now: now), "1:02:05")
        XCTAssertEqual(Texts.countdown(now.addingTimeInterval(-5), now: now), "0:00")
        XCTAssertEqual(Texts.remainingFraction(created: now.addingTimeInterval(-120), expires: now.addingTimeInterval(480), now: now), 0.8, accuracy: 0.001)
        let utc = TimeZone(identifier: "UTC")!
        XCTAssertEqual(Texts.clock(Date(timeIntervalSince1970: 0), timeZone: utc), "00:00")
        XCTAssertEqual(Texts.deadline(now.addingTimeInterval(540), now: now, timeZone: utc).prefix(11), "Süre: 9 dk ")
        XCTAssertEqual(Texts.until(nil), "süresiz")
        XCTAssertFalse(Texts.notificationBlockedMessage("denied").isEmpty)
        XCTAssertFalse(Texts.notificationBlockedMessage("noAlerts").isEmpty)
        XCTAssertEqual(Texts.notificationBlockedMessage("authorized"), "")
    }

    func testMinutesUntilNine() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul")!
        let eight = calendar.date(from: DateComponents(year: 2026, month: 11, day: 7, hour: 8))!
        let six = calendar.date(from: DateComponents(year: 2026, month: 11, day: 7, hour: 18))!
        let nine = calendar.date(from: DateComponents(year: 2026, month: 11, day: 7, hour: 9))!
        XCTAssertEqual(Durations.minutesUntilNine(eight, calendar: calendar), 60)
        XCTAssertEqual(Durations.minutesUntilNine(six, calendar: calendar), 15 * 60)
        XCTAssertEqual(Durations.minutesUntilNine(nine, calendar: calendar), 24 * 60)
        XCTAssertEqual(Durations.minutes(forChoice: 0, now: eight, calendar: calendar), 30)
        XCTAssertNil(Durations.minutes(forChoice: 4, now: eight, calendar: calendar))
    }

    func testSettingsRoundTripAndDefaults() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wmc-\(UUID().uuidString)")
        let store = SettingsStore(directory: dir)
        let (initial, existed) = store.load()
        XCTAssertFalse(existed)
        XCTAssertEqual(initial.server, CenterSettings.defaultServer)
        XCTAssertFalse(initial.openPanelOnRequest)
        var changed = initial
        changed.notifications = false
        try store.save(changed)
        let (loaded, existedNow) = store.load()
        XCTAssertTrue(existedNow)
        XCTAssertFalse(loaded.notifications)
        XCTAssertFalse(loaded.notificationIntroShown)
        try Data("{\"server\":\"https://x.example\"}".utf8).write(to: dir.appendingPathComponent("settings.json"))
        XCTAssertEqual(store.load().settings.server, "https://x.example")
        XCTAssertTrue(store.load().settings.notifications)
        try? FileManager.default.removeItem(at: dir)
    }

    func testListsParseGatewayShapes() async throws {
        let fake = FakeTransport { request in
            switch request.url!.path {
            case "/api/approval-requests":
                return (200, #"{"items":[{"id":"99413e59-492a-4b60-b53a-9c36d5433112","device_id":"d","requested_by":"token:x","action_kind":"process_exec","action":{"command":"whoami"},"status":"pending","expires_at":"2026-11-07T11:14:18.026Z","created_at":"2026-11-07T11:04:18Z"}]}"#)
            case "/api/devices":
                return (200, #"{"items":[{"id":"a","name":"content","platform":"windows","online":true,"trust_level":"standard","trust_full_until":null,"revoked_at":null},{"id":"b","name":"old","revoked_at":"2026-11-01T00:00:00Z"}]}"#)
            case "/api/trust/autonomy":
                return (200, #"{"items":[{"id":"a","name":"content","trust_full_until":null}]}"#)
            case "/api/center/me":
                return (200, #"{"centerId":"c","name":"Mac","email":"o@example.com","role":"owner","organizationName":"Org"}"#)
            default:
                return (404, #"{"error":"not_found"}"#)
            }
        }
        let client = GatewayClient(baseURL: "https://wecommander.app/", transport: fake)
        let pending = try await client.pending(token: "wmc_t")
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].summary, "whoami")
        XCTAssertEqual(pending[0].expiresAt.timeIntervalSince(pending[0].createdAt), 600.026, accuracy: 0.01)
        let devices = try await client.devices(token: "wmc_t")
        XCTAssertEqual(devices.map(\.name), ["content"])
        XCTAssertTrue(devices[0].online)
        let autonomy = try await client.autonomy(token: "wmc_t")
        XCTAssertEqual(autonomy.first?.name, "content")
        let me = try await client.me(token: "wmc_t")
        XCTAssertEqual(me.email, "o@example.com")
        XCTAssertEqual(fake.calls[0].path, "/api/approval-requests?status=pending&limit=100")
        XCTAssertEqual(fake.calls[0].auth, "Bearer wmc_t")
    }

    func testDecideAndAutonomyBodies() async throws {
        let fake = FakeTransport { _ in (200, "{}") }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: fake)
        try await client.decide(token: "t", id: "99413E59-492A-4B60-B53A-9C36D5433112", approve: true)
        XCTAssertEqual(fake.calls[0].path, "/api/approval-requests/99413e59-492a-4b60-b53a-9c36d5433112/approve")
        do {
            try await client.decide(token: "t", id: "../../x", approve: false)
            XCTFail("non-UUID id must be refused")
        } catch let error as GatewayError {
            XCTAssertEqual(error.code, "invalid_request")
        }
        try await client.setAutonomy(token: "t", enable: true, minutes: 30, deviceIds: ["a"], password: "pw")
        XCTAssertEqual(fake.calls[1].body?["minutes"] as? Int, 30)
        XCTAssertEqual(fake.calls[1].body?["currentPassword"] as? String, "pw")
        XCTAssertEqual(fake.calls[1].body?["deviceIds"] as? [String], ["a"])
        try await client.setAutonomy(token: "t", enable: true, minutes: nil, deviceIds: nil, password: "pw")
        XCTAssertTrue(fake.calls[2].body?["minutes"] is NSNull)
        XCTAssertNil(fake.calls[2].body?["deviceIds"])
        try await client.setAutonomy(token: "t", enable: false, minutes: nil, deviceIds: nil, password: nil)
        XCTAssertNil(fake.calls[3].body?["currentPassword"])
    }

    func testErrorsMapToTexts() async {
        let fake = FakeTransport { request in
            request.url!.path.hasSuffix("/me") ? (401, "{}") : (409, #"{"error":"approval_request_expired"}"#)
        }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: fake)
        do { _ = try await client.me(token: "t"); XCTFail() } catch let e as GatewayError {
            XCTAssertEqual(e.kind, .unauthorized)
            XCTAssertEqual(e.message, Texts.signedOutByServer)
        } catch { XCTFail("\(error)") }
        do { try await client.decide(token: "t", id: UUID().uuidString, approve: true); XCTFail() } catch let e as GatewayError {
            XCTAssertEqual(e.kind, .http)
            XCTAssertEqual(e.status, 409)
            XCTAssertEqual(e.code, "approval_request_expired")
        } catch { XCTFail("\(error)") }
    }

    func testLinkFlow() async throws {
        let fake = FakeTransport { request in
            request.url!.path.hasSuffix("/start")
                ? (200, #"{"requestId":"r","requestSecret":"s","approveUrl":"https://wecommander.app/connect-center?requestId=r","expiresInSeconds":600}"#)
                : (200, #"{"status":"approved","centerToken":"wmc_x"}"#)
        }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: fake)
        let start = try await client.linkStart(name: "Mac")
        XCTAssertEqual(start.requestId, "r")
        XCTAssertEqual(fake.calls[0].body?["name"] as? String, "Mac")
        XCTAssertEqual(fake.calls[0].body?["platform"] as? String, "macos")
        let poll = try await client.linkPoll(id: "r", secret: "s")
        XCTAssertEqual(poll.centerToken, "wmc_x")
        XCTAssertEqual(fake.calls[1].body?["requestSecret"] as? String, "s")
    }

    func testActionSummary() throws {
        let data = Data(#"{"pid":42,"name":""}"#.utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        XCTAssertEqual(ActionSummary.from(value), "pid 42")
        XCTAssertEqual(ActionSummary.from(nil), "")
    }

    func testOutcomeAndDecidedElsewhereText() async throws {
        let fake = FakeTransport { _ in
            (200, #"{"item":{"id":"99413e59-492a-4b60-b53a-9c36d5433112","status":"consumed","decided_via":{"kind":"center","name":"Ofis-PC","platform":"windows","self":false}}}"#)
        }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: fake)
        let outcome = try await client.outcome(token: "t", id: "99413E59-492A-4B60-B53A-9C36D5433112")
        XCTAssertEqual(fake.calls[0].path, "/api/approval-requests/99413e59-492a-4b60-b53a-9c36d5433112")
        XCTAssertEqual(outcome.decidedVia?.platform, "windows")
        XCTAssertEqual(Texts.decidedElsewhere(outcome), "Windows'tan onaylandı")

        func text(_ status: String, _ via: DecidedVia?) -> String? {
            Texts.decidedElsewhere(ApprovalOutcome(id: "x", status: status, decidedVia: via))
        }
        XCTAssertEqual(text("approved", DecidedVia(kind: "center", name: "Mac", platform: "macos", isSelf: false)), "macOS'tan onaylandı")
        XCTAssertEqual(text("denied", DecidedVia(kind: "panel", name: nil, platform: nil, isSelf: false)), "Web panelinden reddedildi")
        XCTAssertEqual(text("approved", DecidedVia(kind: "center", name: "Ev", platform: nil, isSelf: false)), "Ev üzerinden onaylandı")
        XCTAssertNil(text("approved", DecidedVia(kind: "center", name: "Mac", platform: "macos", isSelf: true)))
        XCTAssertNil(text("expired", nil))
        XCTAssertNil(text("pending", nil))
    }

    func testTerminalInputShowsWhatWillBeTyped() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"kind":"terminal_input","sessionId":"s","dataBase64":"ZWNobyBoaQoHeA=="}"#.utf8))
        XCTAssertEqual(ActionSummary.from(value), "echo hi⏎·x")
        XCTAssertEqual(ActionSummary.terminalInput("%%"), "")
        XCTAssertEqual(Texts.kindLabel("terminal_input"), "Terminale yaz")
    }

    final class FakeLaunchctl: CommandRunning, @unchecked Sendable {
        var loaded = true
        var running = false
        var disabled = false
        var calls: [[String]] = []
        func run(_ path: String, _ arguments: [String]) async -> (status: Int32, output: String) {
            calls.append(arguments)
            switch arguments.first {
            case "print": return loaded ? (0, running ? "\tstate = running\n\tpid = 42\n" : "\tstate = not running\n") : (113, "")
            case "print-disabled": return (0, disabled ? "\t\"tr.webrising.commender\" => disabled\n" : "\t\"other\" => disabled\n")
            case "enable": disabled = false
            case "disable": disabled = true
            case "bootstrap": loaded = true
            case "bootout": loaded = false; running = false
            case "kickstart": running = loaded
            default: break
            }
            return (0, "")
        }
    }

    func testAgentControlSwitchesTheLaunchAgent() async throws {
        let fake = FakeLaunchctl()
        let control = AgentControl(uid: 501, home: "/Users/o", runner: fake, plistExists: { true })
        var status = await control.status()
        XCTAssertEqual(status, AgentStatus(state: .stopped, enabled: true))
        XCTAssertEqual(Texts.agentStateLabel(status), "Ajan durdu")
        try await control.setEnabled(true)
        status = await control.status()
        XCTAssertTrue(status.running)
        XCTAssertTrue(fake.calls.contains(["kickstart", "gui/501/tr.webrising.commender"]))
        try await control.setEnabled(false)
        status = await control.status()
        XCTAssertEqual(status, AgentStatus(state: .stopped, enabled: false))
        XCTAssertEqual(Texts.agentStateLabel(status), "Ajan kapalı")
        try await control.setEnabled(true)
        XCTAssertTrue(fake.calls.contains(["bootstrap", "gui/501", "/Users/o/Library/LaunchAgents/tr.webrising.commender.plist"]))
        let current = await control.status()
        XCTAssertTrue(current.running)

        let missing = AgentControl(uid: 501, home: "/Users/o", runner: FakeLaunchctl(), plistExists: { false })
        (missing.runner as! FakeLaunchctl).loaded = false
        let missingStatus = await missing.status()
        XCTAssertEqual(missingStatus.state, .notInstalled)
        do { try await missing.setEnabled(true); XCTFail("must refuse") } catch {}
    }

    func testAgentWatchdogBacksOffThenGivesUpOnce() {
        var dog = AgentWatchdog()
        let stopped = AgentStatus(state: .stopped, enabled: true)
        let running = AgentStatus(state: .running, enabled: true)
        let t = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(dog.next(keepRunning: false, status: stopped, now: t), .none)
        XCTAssertEqual(dog.next(keepRunning: true, status: stopped, now: t), .start)
        XCTAssertEqual(dog.next(keepRunning: true, status: stopped, now: t + 10), .none)
        XCTAssertEqual(dog.next(keepRunning: true, status: stopped, now: t + 31), .start)
        XCTAssertEqual(dog.next(keepRunning: true, status: stopped, now: t + 200), .start)
        XCTAssertEqual(dog.next(keepRunning: true, status: stopped, now: t + 400), .giveUp)
        XCTAssertEqual(dog.next(keepRunning: true, status: stopped, now: t + 800), .none)
        XCTAssertEqual(dog.next(keepRunning: true, status: running, now: t + 900), .none)
        XCTAssertEqual(dog.failures, 0)
        XCTAssertTrue(AgentControl.isDisabled("  \"tr.webrising.commender\" => true"))
        XCTAssertFalse(AgentControl.isDisabled("  \"tr.webrising.commender\" => enabled"))
    }

    func testAgentVersionAndUpdateCommand() {
        XCTAssertEqual(AgentControl.parseVersion("webrising-commender 0.1.58\n"), "0.1.58")
        XCTAssertNil(AgentControl.parseVersion("error: no such file"))
        XCTAssertNil(AgentControl.parseVersion(""))
        XCTAssertEqual(AgentControl.updateCommand(server: "https://wecommander.app/"), "curl -fsSL https://wecommander.app/install.sh | sh")
    }
}
