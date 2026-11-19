import Foundation
import XCTest
@testable import CenterCore

/// Hybrid Access H3 on the Mac: this computer as the connector for its shared
/// SSH hosts (the Windows RemoteConnectorTests, plus backoff and status).
final class RemoteConnectorTests: XCTestCase {
    override func tearDown() { L.use("tr") }

    private let callId = "11111111-1111-4111-8111-111111111111"

    private final class FakeCore: ConnectorCore, @unchecked Sendable {
        private let lock = NSLock()
        private var log: [(method: String, params: [String: Any])] = []
        let answer: (String, [String: Any]) throws -> Any?

        init(_ answer: @escaping (String, [String: Any]) throws -> Any?) { self.answer = answer }

        var calls: [(method: String, params: [String: Any])] { lock.lock(); defer { lock.unlock() }; return log }

        func call(_ method: String, _ params: [String: Any]) async throws -> Any? {
            lock.lock(); log.append((method, params)); lock.unlock()
            return try answer(method, params)
        }
    }

    private final class FakeGateway: ConnectorTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var _published: [[[String: Any]]] = []
        private var _results: [(id: String, result: [String: Any])] = []
        private var _claims: [[ConnectorCall]] = []
        private var _claimCount = 0
        /// Errors thrown by the next publish calls, in order.
        var publishErrors: [Error] = []
        var postFailures = 0

        var published: [[[String: Any]]] { lock.lock(); defer { lock.unlock() }; return _published }
        var results: [(id: String, result: [String: Any])] { lock.lock(); defer { lock.unlock() }; return _results }
        var claimCount: Int { lock.lock(); defer { lock.unlock() }; return _claimCount }

        func queue(_ calls: [ConnectorCall]) { lock.lock(); _claims.append(calls); lock.unlock() }

        func publish(_ targets: [[String: Any]]) async throws {
            lock.lock(); defer { lock.unlock() }
            if !publishErrors.isEmpty { throw publishErrors.removeFirst() }
            _published.append(targets)
        }

        func claim(waitMs: Int) async throws -> [ConnectorCall] {
            lock.lock(); defer { lock.unlock() }
            _claimCount += 1
            return _claims.isEmpty ? [] : _claims.removeFirst()
        }

        func postResult(callId: String, result: [String: Any]) async throws {
            lock.lock(); defer { lock.unlock() }
            if postFailures > 0 {
                postFailures -= 1
                throw GatewayError(.network, 0, "network", "offline")
            }
            _results.append((callId, result))
        }
    }

    /// Records each wait; stops the loop (as a cancelled sleep would) after `limit` waits.
    private final class FakeSleep: @unchecked Sendable {
        private let lock = NSLock()
        private var _waits: [TimeInterval] = []
        let limit: Int
        init(limit: Int) { self.limit = limit }
        var waits: [TimeInterval] { lock.lock(); defer { lock.unlock() }; return _waits }

        func sleep(_ seconds: TimeInterval) throws {
            lock.lock(); defer { lock.unlock() }
            _waits.append(seconds)
            if _waits.count >= limit { throw CancellationError() }
        }
    }

    private static let shared: [[String: Any]] = [["hostId": "h1", "name": "web-1", "preset": "approval", "sudo": "never"]]

    func testNothingHappensBeforeSignInAndEmptyIsPublishedOnceWithoutClaiming() async throws {
        let core = FakeCore { _, _ in [Any]() }
        let gw = FakeGateway()
        let c = RemoteConnector(core: core)
        let first = try await c.step(gw, centerId: nil)
        XCTAssertEqual(first, RemoteConnector.idleCheck)
        XCTAssertTrue(core.calls.isEmpty)
        let second = try await c.step(gw, centerId: "center-1")
        let third = try await c.step(gw, centerId: "center-1")
        XCTAssertEqual(second, RemoteConnector.idleCheck)
        XCTAssertEqual(third, RemoteConnector.idleCheck)
        XCTAssertEqual(gw.published.count, 1) // unchanged: not sent again
        XCTAssertEqual(gw.claimCount, 0)
        XCTAssertEqual(core.calls[0].method, "mcp.remoteTargets")
        XCTAssertEqual(core.calls[0].params["centerId"] as? String, "center-1")
        let status = await c.status
        XCTAssertEqual(status.state, .idle)
        XCTAssertEqual(status.shared, 0)
    }

    func testClaimedCallsRunInTheCoreAndTheirResultsArePosted() async throws {
        let core = FakeCore { method, params in
            if method == "mcp.remoteTargets" { return RemoteConnectorTests.shared }
            let inner: [String: Any] = ["tool": params["tool"] as? String ?? "", "approved": params["approved"] as? Bool ?? false]
            let answer: [String: Any] = ["ok": true, "result": inner]
            return answer
        }
        let gw = FakeGateway()
        let item: [String: Any] = ["id": callId, "hostId": "h1", "tool": "process_exec",
                                   "args": ["target": "h1", "command": "uptime"], "approved": true, "client": "chatgpt"]
        gw.queue([ConnectorCall.from(item)!])
        let c = RemoteConnector(core: core)
        let wait = try await c.step(gw, centerId: "center-1")
        XCTAssertEqual(wait, 0)
        XCTAssertEqual(gw.published.first?.first?["name"] as? String, "web-1")
        await c.whenIdle()
        XCTAssertEqual(gw.results.count, 1)
        XCTAssertEqual(gw.results.first?.id, callId)
        XCTAssertEqual(gw.results.first?.result["ok"] as? Bool, true)
        let call = try XCTUnwrap(core.calls.first { $0.method == "mcp.remoteCall" }?.params)
        XCTAssertEqual(call["centerId"] as? String, "center-1")
        XCTAssertEqual(call["callId"] as? String, callId)
        XCTAssertEqual(call["client"] as? String, "chatgpt")
        XCTAssertEqual((call["args"] as? [String: Any])?["command"] as? String, "uptime")
        XCTAssertEqual(call["approved"] as? Bool, true)
        let status = await c.status
        XCTAssertEqual(status.state, .connected)
        XCTAssertEqual(status.shared, 1)
        XCTAssertEqual(status.handled, 1)
        XCTAssertEqual(status.active, 0)
        XCTAssertEqual(status.lastCall?.hostId, "h1")
        XCTAssertEqual(status.lastCall?.tool, "process_exec")
        XCTAssertEqual(status.lastCall?.ok, true)
    }

    func testAnUnapprovedChangeIsSentAsItCameTheLoopNeverApproves() async throws {
        let core = FakeCore { method, _ in
            if method == "mcp.remoteTargets" { return RemoteConnectorTests.shared }
            let refused: [String: Any] = ["ok": false, "error": "approval_required", "message": "needs approval"]
            return refused
        }
        let gw = FakeGateway()
        gw.queue([ConnectorCall(id: callId, hostId: "h1", tool: "fs_delete", args: ["path": "/tmp/x"], approved: false, client: "claude")])
        let c = RemoteConnector(core: core)
        _ = try await c.step(gw, centerId: "center-1")
        await c.whenIdle()
        let call = try XCTUnwrap(core.calls.first { $0.method == "mcp.remoteCall" }?.params)
        XCTAssertEqual(call["approved"] as? Bool, false)
        XCTAssertEqual(gw.results.first?.result["error"] as? String, "approval_required")
        let status = await c.status
        XCTAssertEqual(status.lastCall?.ok, false)
        XCTAssertEqual(status.lastCall?.error, "approval_required")
        L.use("tr")
        XCTAssertEqual(AiAccessText.lastCall(status.lastCall!, hostName: "web-1"), "Son çağrı: web-1 · fs_delete · onay bekliyor")
    }

    func testACoreFailureBecomesAnErrorResult() async {
        let core = FakeCore { _, _ in throw CoreClient.Failure.stopped }
        let c = RemoteConnector(core: core)
        let result = await c.handle(centerId: "center-1", ConnectorCall(id: "id", hostId: "h1", tool: "fs_read"))
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertEqual(result["error"] as? String, "connector_error")
        // An answer without "ok" is not passed on either.
        let odd = await RemoteConnector(core: FakeCore { _, _ in ["result": 1] }).handle(centerId: "c", ConnectorCall(id: "id", hostId: "h", tool: "t"))
        XCTAssertEqual(odd["error"] as? String, "connector_error")
        XCTAssertNil(ConnectorCall.from(["tool": "x"]))
        XCTAssertNil(ConnectorCall.from(["id": "x"]))
        XCTAssertNil(ConnectorCall.from("x"))
    }

    func testTargetsArePublishedAgainWhenChangedOrAfterAMinute() async throws {
        let targets = TargetBox(RemoteConnectorTests.shared)
        let core = FakeCore { method, _ in
            if method == "mcp.remoteTargets" { return targets.value }
            return ["ok": true]
        }
        let clock = ClockBox(Date(timeIntervalSince1970: 1_800_000_000))
        let gw = FakeGateway()
        let c = RemoteConnector(core: core, clock: { clock.now })
        _ = try await c.step(gw, centerId: "center-1")
        _ = try await c.step(gw, centerId: "center-1")
        XCTAssertEqual(gw.published.count, 1)
        clock.advance(RemoteConnector.republishEvery)
        _ = try await c.step(gw, centerId: "center-1")
        XCTAssertEqual(gw.published.count, 2) // the gateway's "online" mark stays fresh
        targets.value = []
        _ = try await c.step(gw, centerId: "center-1")
        XCTAssertEqual(gw.published.count, 3) // unshared: the empty list replaces it
        XCTAssertEqual(gw.published.last?.count, 0)
        let status = await c.status
        XCTAssertEqual(status.state, .idle)
    }

    func testErrorsBackOffLongerEachTimeAndTheLoopStopsWhenCancelled() async {
        XCTAssertEqual((1...7).map { RemoteConnector.backoff(failures: $0) }, [5, 10, 20, 40, 60, 60, 60])
        let core = FakeCore { _, _ in RemoteConnectorTests.shared }
        let gw = FakeGateway()
        gw.publishErrors = (0..<4).map { _ in GatewayError(.network, 0, "network", "offline") }
            + [GatewayError(.unauthorized, 401, "unauthorized", "signed out")]
        // The fifth wait ends the loop, as a cancelled sleep does.
        let sleep = FakeSleep(limit: 5)
        let c = RemoteConnector(core: core, sleep: { try sleep.sleep($0) })
        await c.run(gw, centerId: { "center-1" })
        // Four network errors (longer each time), then a refused token.
        XCTAssertEqual(sleep.waits, [5, 10, 20, 40, RemoteConnector.unauthorizedWait])
        let status = await c.status
        XCTAssertEqual(status.state, .stopped)
    }

    func testWithNothingSharedItOnlyChecksNowAndThen() async {
        let flip = TargetBox([])
        let core = FakeCore { _, _ in flip.value }
        let gw = FakeGateway()
        gw.publishErrors = [GatewayError(.network, 0, "network", "offline"), GatewayError(.network, 0, "network", "offline")]
        let sleep = FakeSleep(limit: 4)
        let c = RemoteConnector(core: core, sleep: { try sleep.sleep($0) })
        await c.run(gw, centerId: { "center-1" })
        // 5, 10, then the empty list is published once and only the idle check follows.
        XCTAssertEqual(sleep.waits, [5, 10, RemoteConnector.idleCheck, RemoteConnector.idleCheck])
        XCTAssertEqual(gw.published.count, 1)
    }

    func testTheRetryingStatusSaysWhy() async throws {
        let core = FakeCore { _, _ in RemoteConnectorTests.shared }
        let gw = FakeGateway()
        gw.publishErrors = [GatewayError(.network, 0, "network", "Sunucuya ulaşılamıyor")]
        let sleep = FakeSleep(limit: 1)
        let c = RemoteConnector(core: core, sleep: { try sleep.sleep($0) })
        let seen = StatusLog()
        await c.observe { seen.add($0) }
        await c.run(gw, centerId: { "center-1" })
        XCTAssertTrue(seen.all.contains { $0.state == .retrying && $0.lastError == "Sunucuya ulaşılamıyor" })
        XCTAssertEqual(seen.all.last?.state, .stopped)
    }

    func testTheResultIsPostedAgainAfterANetworkError() async throws {
        let core = FakeCore { method, _ in
            if method == "mcp.remoteTargets" { return RemoteConnectorTests.shared }
            return ["ok": true]
        }
        let gw = FakeGateway()
        gw.postFailures = 1
        gw.queue([ConnectorCall(id: callId, hostId: "h1", tool: "fs_list")])
        let sleep = FakeSleep(limit: 100)
        let c = RemoteConnector(core: core, sleep: { try sleep.sleep($0) })
        _ = try await c.step(gw, centerId: "center-1")
        await c.whenIdle()
        XCTAssertEqual(gw.results.count, 1)
        XCTAssertEqual(sleep.waits, [1])
    }

    func testTheRealLoopStopsOnCancel() async {
        let core = FakeCore { _, _ in [Any]() }
        let gw = FakeGateway()
        let c = RemoteConnector(core: core)
        let task = Task { await c.run(gw, centerId: { "center-1" }) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        task.cancel()
        await task.value
        let status = await c.status
        XCTAssertEqual(status.state, .stopped)
    }

    func testGatewayRoutes() async throws {
        let claim = #"{"items":[{"id":"11111111-1111-4111-8111-111111111111","hostId":"h1","tool":"fs_read","args":{"target":"ssh-x","path":"/etc/hosts"},"approved":false,"client":"claude"},{"tool":"bad"}]}"#
        let fake = FakeTransport { request in request.httpMethod == "GET" ? (200, claim) : (200, #"{"ok":true}"#) }
        let client = GatewayClient(baseURL: "https://wecommander.app", transport: fake)
        try await client.publishConnectorTargets(token: "tok", targets: RemoteConnectorTests.shared)
        XCTAssertEqual(fake.calls[0].method, "PUT")
        XCTAssertEqual(fake.calls[0].path, "/api/center/connector/targets")
        XCTAssertEqual(fake.calls[0].auth, "Bearer tok")
        XCTAssertEqual((fake.calls[0].body?["targets"] as? [[String: Any]])?.first?["hostId"] as? String, "h1")
        let calls = try await client.claimConnectorCalls(token: "tok", waitMs: 99_000)
        XCTAssertEqual(fake.calls[1].path, "/api/center/connector/claim?waitMs=15000")
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls[0].args["path"] as? String, "/etc/hosts")
        XCTAssertEqual(calls[0].client, "claude")
        XCTAssertFalse(calls[0].approved)
        try await client.postConnectorResult(token: "tok", callId: callId.uppercased(), result: ["ok": true, "result": ["x": 1]])
        XCTAssertEqual(fake.calls[2].method, "POST")
        XCTAssertEqual(fake.calls[2].path, "/api/center/connector/calls/" + callId + "/result")
        XCTAssertEqual(fake.calls[2].body?["ok"] as? Bool, true)
        do {
            try await client.postConnectorResult(token: "tok", callId: "../x", result: [:])
            XCTFail("expected invalid_request")
        } catch let e as GatewayError {
            XCTAssertEqual(e.code, "invalid_request")
        }
        XCTAssertEqual(fake.calls.count, 3)
    }

    // MARK: AI access rules

    func testRemoteAccessIsStoredWithThisComputersId() {
        let off = AiAccess.off
        XCTAssertEqual(AiAccessRules.connectorFor(off, remote: true, centerId: "center-1"), "center-1")
        XCTAssertEqual(AiAccessRules.connectorFor(off, remote: false, centerId: "center-1"), AiAccess.thisComputer)
        XCTAssertEqual(AiAccessRules.connectorFor(off, remote: true, centerId: nil), AiAccess.thisComputer)
        // Already served by another computer: kept.
        let other = AiAccess(remote: true, connector: "6f0c9b3e-0000-4000-8000-000000000001")
        XCTAssertEqual(AiAccessRules.connectorFor(other, remote: true, centerId: "center-1"), other.connector)
        XCTAssertTrue(AiAccessRules.servedHere(AiAccess(remote: true, connector: "center-1"), centerId: "center-1"))
        XCTAssertTrue(AiAccessRules.servedHere(AiAccess(remote: true), centerId: nil))
        XCTAssertFalse(AiAccessRules.servedHere(other, centerId: "center-1"))
        L.use("tr")
        XCTAssertEqual(AiAccessText.connectorName(other.connector, centerId: "center-1"), "başka bir bilgisayar")
        XCTAssertEqual(AiAccessText.connectorName("center-1", centerId: "center-1"), "bu bilgisayar")
    }

    private func host(_ json: String) throws -> CoreHost {
        try JSONDecoder().decode(CoreHost.self, from: Data(json.utf8))
    }

    func testHostsDecodeTheirAccessAndBlockersSayWhatToFix() throws {
        let shared = try host(#"{"id":"a","label":"Web","target":"t","authKind":"key","savedSecret":false,"trustedKey":"SHA256:x","aiAccess":{"local":false,"remote":true,"connector":"center-1","preset":"readonly","timedUntil":null,"sudo":"sudoers"}}"#)
        XCTAssertEqual(AiAccessRules.of(shared), AiAccess(remote: true, connector: "center-1", preset: AiAccess.readOnly, sudo: AiAccess.sudoSudoers))
        XCTAssertEqual(AiAccessRules.blockers(shared), [])
        XCTAssertEqual(AiAccessRules.sharedHere([shared], centerId: "center-1").map(\.id), ["a"])
        XCTAssertEqual(AiAccessRules.sharedHere([shared], centerId: "center-2").map(\.id), [])
        let older = try host(#"{"id":"b","label":"Old","target":"t","authKind":"password","savedSecret":false}"#)
        XCTAssertEqual(AiAccessRules.of(older), .off)
        XCTAssertEqual(AiAccessRules.blockers(older), [.hostKeyUntrusted, .needsCredential])
        let partial = try host(#"{"id":"c","label":"P","target":"t","authKind":"password","savedSecret":true,"trustedKey":"k","aiAccess":{"remote":true}}"#)
        XCTAssertEqual(AiAccessRules.of(partial).preset, AiAccess.approval)
        XCTAssertEqual(AiAccessRules.of(partial).sudo, AiAccess.sudoNever)
        XCTAssertEqual(AiAccessRules.blockers(partial), [])
        let mosh = try host(#"{"id":"d","label":"M","target":"t","authKind":"key","savedSecret":false,"protocol":"mosh"}"#)
        XCTAssertEqual(AiAccessRules.blockers(mosh), [.notSsh])
    }

    func testSettingsAreValidatedAndNormalized() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertNil(AiAccessRules.validate(AiAccess(remote: true, connector: "center-1"), now: now))
        XCTAssertEqual(AiAccessRules.validate(AiAccess(preset: "anything"), now: now), AiAccessRules.invalidPreset)
        XCTAssertEqual(AiAccessRules.validate(AiAccess(sudo: "always"), now: now), AiAccessRules.invalidSudo)
        XCTAssertEqual(AiAccessRules.validate(AiAccess(remote: true, connector: " "), now: now), AiAccessRules.invalidConnector)
        XCTAssertEqual(AiAccessRules.validate(AiAccess(preset: AiAccess.timed), now: now), AiAccessRules.timedNeedsUntil)
        XCTAssertEqual(AiAccessRules.validate(AiAccess(preset: AiAccess.timed, timedUntil: "2027-01-15T08:00:00Z"), now: now), AiAccessRules.timedInPast)
        XCTAssertEqual(AiAccessRules.validate(AiAccess(preset: AiAccess.timed, timedUntil: "2027-01-15T18:00:00Z"), now: now), AiAccessRules.timedTooLong)
        XCTAssertNil(AiAccessRules.validate(AiAccess(preset: AiAccess.timed, timedUntil: "2027-01-15T10:00:00Z"), now: now))
        let normalized = AiAccessRules.normalize(AiAccess(remote: false, connector: "center-1", preset: AiAccess.readOnly, timedUntil: "x"))
        XCTAssertEqual(normalized.connector, AiAccess.thisComputer)
        XCTAssertNil(normalized.timedUntil)
        let json = AiAccess(remote: true, connector: "center-1").json
        XCTAssertEqual(json["remote"] as? Bool, true)
        XCTAssertTrue(json["timedUntil"] is NSNull)
        XCTAssertTrue(AiAccessRules.remoteSupported(info: nil, status: ["remoteSupported": true]))
        XCTAssertTrue(AiAccessRules.remoteSupported(info: ["features": ["remote-mcp"]]))
        XCTAssertFalse(AiAccessRules.remoteSupported(info: ["version": "1"], status: ["enabled": true]))
    }

    func testCoreErrorCodesBecomeClearTexts() {
        L.use("tr")
        XCTAssertEqual(CoreText.turkish("host_key_untrusted: web"), AiAccessText.blockerText(.hostKeyUntrusted))
        XCTAssertEqual(CoreText.turkish("needs_credential: web"), AiAccessText.blockerText(.needsCredential))
        XCTAssertEqual(AiAccessText.error("invalid_timed_until: x"), "Süreli otonom için geçerli bir süre seç.")
        XCTAssertNil(AiAccessText.error("something else"))
        L.use("en")
        XCTAssertEqual(AiAccessText.state(ConnectorStatus(), signedIn: false), AiAccessText.remoteNeedsSignIn)
        var s = ConnectorStatus()
        s.state = .connected
        s.shared = 2
        XCTAssertEqual(AiAccessText.state(s, signedIn: true), "Connected · 2 servers shared with remote AI.")
    }

    // MARK: approvals of SSH servers

    func testApprovalsOfSshServersNameTheServer() throws {
        let item = try GatewayDates.decoder().decode(ApprovalRequest.self, from: Data(
            #"{"id":"a","device_id":"","target_label":"web-1","action_kind":"fs_move","action":{"kind":"fs_move","source":"/a","destination":"/b"},"expires_at":"2026-11-17T10:00:00Z","created_at":"2026-11-17T09:55:00Z"}"#.utf8))
        XCTAssertEqual(item.placeName([:]), "web-1 · SSH")
        XCTAssertEqual(item.summary, "/a → /b")
        let write = try GatewayDates.decoder().decode(ApprovalRequest.self, from: Data(
            #"{"id":"b","device_id":"d1","action_kind":"fs_write","action":{"kind":"fs_write","path":"/srv/x","size":11,"sha256":"0123456789abcdef0123"},"expires_at":"2026-11-17T10:00:00Z","created_at":"2026-11-17T09:55:00Z"}"#.utf8))
        XCTAssertEqual(write.placeName(["d1": "PC"]), "PC")
        XCTAssertEqual(write.summary, "/srv/x (11 B, sha256 0123456789ab…)")
        L.use("tr")
        let unknown = ApprovalRequest(id: "c", deviceId: "zz", actionKind: "process_exec", action: nil, expiresAt: Date(), createdAt: Date())
        XCTAssertEqual(unknown.placeName([:]), "bilinmeyen cihaz")
    }
}

private final class TargetBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: [[String: Any]]
    init(_ value: [[String: Any]]) { _value = value }
    var value: [[String: Any]] {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); _value = newValue; lock.unlock() }
    }
}

private final class ClockBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _now: Date
    init(_ now: Date) { _now = now }
    var now: Date { lock.lock(); defer { lock.unlock() }; return _now }
    func advance(_ seconds: TimeInterval) { lock.lock(); _now = _now.addingTimeInterval(seconds); lock.unlock() }
}

private final class StatusLog: @unchecked Sendable {
    private let lock = NSLock()
    private var _all: [ConnectorStatus] = []
    func add(_ s: ConnectorStatus) { lock.lock(); _all.append(s); lock.unlock() }
    var all: [ConnectorStatus] { lock.lock(); defer { lock.unlock() }; return _all }
}
