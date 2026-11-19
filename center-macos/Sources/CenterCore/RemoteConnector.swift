import Foundation

/// A remote AI call the gateway queued for this computer (Hybrid Access H3).
public struct ConnectorCall: @unchecked Sendable {
    public let id: String
    public let hostId: String
    public let tool: String
    /// The tool's arguments as the AI sent them (JSON object); handed to the core unchanged.
    public let args: [String: Any]
    /// The owner approved this exact call (on the gateway); the core still checks everything else.
    public let approved: Bool
    public let client: String

    public init(id: String, hostId: String, tool: String, args: [String: Any] = [:], approved: Bool = false, client: String = "") {
        self.id = id; self.hostId = hostId; self.tool = tool; self.args = args; self.approved = approved; self.client = client
    }

    /// One item of the claim answer; nil without an id or a tool.
    public static func from(_ value: Any?) -> ConnectorCall? {
        guard let o = value as? [String: Any] else { return nil }
        let id = o["id"] as? String ?? ""
        let tool = o["tool"] as? String ?? ""
        if id.isEmpty || tool.isEmpty { return nil }
        return ConnectorCall(id: id, hostId: o["hostId"] as? String ?? "", tool: tool,
                             args: o["args"] as? [String: Any] ?? [:], approved: (o["approved"] as? Bool) == true,
                             client: o["client"] as? String ?? "")
    }
}

/// The gateway side of the connector (GatewayConnectorTransport; a fake in tests).
public protocol ConnectorTransport: Sendable {
    /// Replaces the hosts this computer shares with remote AI (name, preset, sudo; never an address or key).
    func publish(_ targets: [[String: Any]]) async throws
    /// Waits up to `waitMs` for calls queued for this computer.
    func claim(waitMs: Int) async throws -> [ConnectorCall]
    func postResult(callId: String, result: [String: Any]) async throws
}

/// The `wecommander-core` calls of the connector (CoreClient; a fake in tests).
public protocol ConnectorCore: Sendable {
    func call(_ method: String, _ params: [String: Any]) async throws -> Any?
}

extension CoreClient: ConnectorCore {}

/// One finished remote call, for the status line ("Son çağrı").
public struct ConnectorCallRecord: Equatable, Sendable {
    public let hostId: String
    public let tool: String
    public let ok: Bool
    /// The core's error code when not ok (approval_required, host_key_untrusted, connector_error…).
    public let error: String?
    public let at: Date

    public init(hostId: String, tool: String, ok: Bool, error: String?, at: Date) {
        self.hostId = hostId; self.tool = tool; self.ok = ok; self.error = error; self.at = at
    }
}

/// What the AI access page shows about this Mac as the connector.
public struct ConnectorStatus: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// Not running (signed out, app starting).
        case stopped
        /// Running, nothing shared: it only checks again now and then.
        case idle
        /// Publishing and waiting for calls.
        case connected
        /// The last round failed (offline, an older server, the core restarting); waiting to try again.
        case retrying
    }

    public var state: State = .stopped
    /// Hosts published last.
    public var shared = 0
    /// Calls running now.
    public var active = 0
    /// Calls answered since start.
    public var handled = 0
    /// The last time wecommander.app answered.
    public var lastContact: Date?
    public var lastCall: ConnectorCallRecord?
    /// Why the last round failed (cleared by the next good one).
    public var lastError: String?

    public init() {}
}

/// "Bu bilgisayar" as the connector (docs/HYBRID_ACCESS.md §8, phase H3), as
/// in the Windows app (center-windows/Core/RemoteConnector.cs): while the app
/// runs and is signed in, it publishes the saved SSH hosts shared with remote
/// AI (`mcp.remoteTargets`), long-polls for the calls Claude/ChatGPT make
/// through wecommander.app and hands each to the core (`mcp.remoteCall`),
/// which connects from this Mac: SSH keys and passwords never leave it.
/// Approvals are decided on the gateway (the person approves in this app's
/// notification or on the web); this loop never approves anything. When no
/// host is shared it only checks again now and then; after an error it waits
/// longer each time (5 s up to a minute).
public actor RemoteConnector {
    public static let republishEvery: TimeInterval = 60
    public static let idleCheck: TimeInterval = 15
    public static let retryAfter: TimeInterval = 5
    public static let maxRetry: TimeInterval = 60
    /// The token was refused: the app signs out; until then, slowly.
    public static let unauthorizedWait: TimeInterval = 30
    /// Long-poll wait; under the app's 20 s HTTP timeout.
    public static let claimWaitMs = 12_000

    public typealias Sleep = @Sendable (TimeInterval) async throws -> Void

    private let core: ConnectorCore
    private let clock: @Sendable () -> Date
    private let sleep: Sleep
    private var active: [String: Task<Void, Never>] = [:]
    private var published: String?
    private var publishedAt = Date.distantPast
    private var onStatus: (@Sendable (ConnectorStatus) -> Void)?
    public private(set) var status = ConnectorStatus()

    public init(core: ConnectorCore, clock: @escaping @Sendable () -> Date = { Date() },
                sleep: @escaping Sleep = { seconds in try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000)) }) {
        self.core = core
        self.clock = clock
        self.sleep = sleep
    }

    /// Called with each new status (on the connector's executor; hop to the main actor to show it).
    public func observe(_ handler: @escaping @Sendable (ConnectorStatus) -> Void) {
        onStatus = handler
        handler(status)
    }

    /// Calls running now.
    public var activeCount: Int { active.count }

    /// How long to wait after `failures` failed rounds in a row: 5, 10, 20, 40, then 60 seconds.
    public static func backoff(failures: Int) -> TimeInterval {
        min(maxRetry, retryAfter * pow(2, Double(max(0, failures - 1))))
    }

    /// Runs until its task is cancelled (sign-out, quit). `centerId` is this app's Management Center id (nil while unknown).
    public func run(_ transport: ConnectorTransport, centerId: @escaping @Sendable () async -> String?) async {
        var failures = 0
        while !Task.isCancelled {
            var wait: TimeInterval
            do {
                let id = await centerId()
                wait = try await step(transport, centerId: id)
                failures = 0
            } catch {
                if Task.isCancelled || error is CancellationError { break }
                if let e = error as? GatewayError, e.kind == .unauthorized {
                    wait = Self.unauthorizedWait
                } else {
                    failures += 1
                    wait = Self.backoff(failures: failures)
                }
                let text = error.localizedDescription
                update { $0.state = .retrying; $0.lastError = text }
            }
            if Task.isCancelled { break }
            if wait > 0 {
                do { try await sleep(wait) } catch { break }
            }
        }
        await whenIdle()
        published = nil
        update { $0.state = .stopped }
    }

    /// One round: publish if changed (or a minute passed), then claim and start the calls. Returns how long to wait.
    public func step(_ transport: ConnectorTransport, centerId: String?) async throws -> TimeInterval {
        guard let centerId, !centerId.isEmpty else {
            update { $0.state = .idle }
            return Self.idleCheck
        }
        let answer = try await core.call("mcp.remoteTargets", ["centerId": centerId])
        let targets = (answer as? [Any] ?? []).compactMap { $0 as? [String: Any] }
        let text = Self.canonical(targets)
        let now = clock()
        if text != published || now.timeIntervalSince(publishedAt) >= Self.republishEvery {
            try await transport.publish(targets)
            published = text
            publishedAt = now
            update { $0.shared = targets.count; $0.lastContact = now }
        }
        if targets.isEmpty {
            update { $0.state = .idle; $0.lastError = nil }
            return Self.idleCheck
        }
        let calls = try await transport.claim(waitMs: Self.claimWaitMs)
        let contact = clock()
        update { $0.state = .connected; $0.lastContact = contact; $0.lastError = nil }
        for call in calls { start(transport, centerId: centerId, call) }
        return 0
    }

    /// The core's answer for one call; a failure of this app is an error result, never a throw.
    public func handle(centerId: String, _ call: ConnectorCall) async -> [String: Any] {
        do {
            let result = try await core.call("mcp.remoteCall", [
                "callId": call.id,
                "centerId": centerId,
                "client": call.client,
                "tool": call.tool,
                "args": call.args,
                "approved": call.approved,
            ])
            if let o = result as? [String: Any], (o["ok"] as? Bool) != nil { return o }
        } catch {}
        // English: this text goes to the AI client, not to the person.
        return ["ok": false, "error": "connector_error", "message": "WECOMMANDER on the person's computer could not run this call; try again."]
    }

    /// Waits for the calls running now (tests, sign-out).
    public func whenIdle() async {
        while !active.isEmpty {
            for task in Array(active.values) { await task.value }
        }
    }

    // MARK: -

    private func start(_ transport: ConnectorTransport, centerId: String, _ call: ConnectorCall) {
        guard active[call.id] == nil else { return }
        let id = call.id
        let task = Task.detached { [weak self] in
            guard let self else { return }
            await self.runOne(transport, centerId: centerId, call)
            await self.finished(id)
        }
        active[id] = task
        update { _ in }
    }

    private func finished(_ id: String) {
        active.removeValue(forKey: id)
        update { _ in }
    }

    private func runOne(_ transport: ConnectorTransport, centerId: String, _ call: ConnectorCall) async {
        let result = await handle(centerId: centerId, call)
        let record = ConnectorCallRecord(hostId: call.hostId, tool: call.tool, ok: (result["ok"] as? Bool) == true,
                                         error: result["error"] as? String, at: clock())
        update { $0.lastCall = record; $0.handled += 1 }
        for attempt in 0..<3 {
            do {
                try await transport.postResult(callId: call.id, result: result)
                return
            } catch let e as GatewayError where e.kind == .network && attempt < 2 {
                do { try await sleep(TimeInterval(1 + attempt * 2)) } catch { return }
            } catch {
                return // the call is over (answered too late, signed out): nothing to retry
            }
        }
    }

    private func update(_ change: (inout ConnectorStatus) -> Void) {
        var next = status
        change(&next)
        next.active = active.count
        guard next != status else { return }
        status = next
        onStatus?(next)
    }

    /// The published list as text, to send it again only when it changed.
    static func canonical(_ targets: [[String: Any]]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: targets, options: [.sortedKeys]) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }
}

/// The connector routes of the gateway with this app's Center token.
public struct GatewayConnectorTransport: ConnectorTransport {
    public let gateway: GatewayClient
    public let token: String

    public init(gateway: GatewayClient, token: String) { self.gateway = gateway; self.token = token }

    public func publish(_ targets: [[String: Any]]) async throws {
        try await gateway.publishConnectorTargets(token: token, targets: targets)
    }

    public func claim(waitMs: Int) async throws -> [ConnectorCall] {
        try await gateway.claimConnectorCalls(token: token, waitMs: waitMs)
    }

    public func postResult(callId: String, result: [String: Any]) async throws {
        try await gateway.postConnectorResult(token: token, callId: callId, result: result)
    }
}

// MARK: - gateway calls (gateway/src/ssh-connector.ts)

extension GatewayClient {
    public func publishConnectorTargets(token: String, targets: [[String: Any]]) async throws {
        _ = try await sendJSON("PUT", "/api/center/connector/targets", token: token, body: ["targets": targets])
    }

    /// Long poll: the gateway answers at once when calls wait, else after `waitMs` (at most 15 s).
    public func claimConnectorCalls(token: String, waitMs: Int) async throws -> [ConnectorCall] {
        let wait = min(15_000, max(0, waitMs))
        let json = try await sendJSON("GET", "/api/center/connector/claim?waitMs=" + String(wait), token: token, body: nil) as? [String: Any]
        return (json?["items"] as? [Any] ?? []).compactMap(ConnectorCall.from)
    }

    public func postConnectorResult(token: String, callId: String, result: [String: Any]) async throws {
        let uuid = try Self.uuid(callId)
        _ = try await sendJSON("POST", "/api/center/connector/calls/" + uuid + "/result", token: token, body: result)
    }
}
