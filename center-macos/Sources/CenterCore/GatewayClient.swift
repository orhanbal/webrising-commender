import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum GatewayErrorKind: Equatable { case unauthorized, http, network }

public struct GatewayError: Error, Equatable, LocalizedError {
    public let kind: GatewayErrorKind
    public let status: Int
    public let code: String
    public let message: String
    public var errorDescription: String? { message }

    public init(_ kind: GatewayErrorKind, _ status: Int, _ code: String, _ message: String) {
        self.kind = kind; self.status = status; self.code = code; self.message = message
    }
}

/// How requests leave the app; URLSession in the app, a fake in tests.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, Int)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession
    public init(timeout: TimeInterval = 20) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }
    public func send(_ request: URLRequest) async throws -> (Data, Int) {
        let (data, response) = try await session.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

/// Gateway calls of the Management Center. Every call except sign-in carries
/// the center token; the gateway lets it reach only approvals, autonomous
/// mode, the device list and /api/center/*. Same contract as the Windows app.
public struct GatewayClient: Sendable {
    public let base: String
    private let transport: HTTPTransport

    public init(baseURL: String, transport: HTTPTransport = URLSessionTransport()) {
        var b = baseURL
        while b.hasSuffix("/") { b.removeLast() }
        base = b
        self.transport = transport
    }

    private func send(_ method: String, _ path: String, token: String?, body: [String: Any]?) async throws -> Any? {
        guard let url = URL(string: base + path) else {
            throw GatewayError(.network, 0, "bad_url", "Sunucu adresi geçersiz.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let status: Int
        do {
            (data, status) = try await transport.send(request)
        } catch let error as URLError where error.code == .timedOut {
            throw GatewayError(.network, 0, "timeout", "Sunucuya ulaşılamıyor (zaman aşımı).")
        } catch is GatewayError {
            throw GatewayError(.network, 0, "network", "Sunucuya ulaşılamıyor (bağlantı kurulamadı).")
        } catch {
            throw GatewayError(.network, 0, "network", "Sunucuya ulaşılamıyor (bağlantı kurulamadı).")
        }
        let json = data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data)
        if status == 401 {
            throw GatewayError(.unauthorized, status, "unauthorized", Texts.signedOutByServer)
        }
        guard (200..<300).contains(status) else {
            let code = ((json as? [String: Any])?["error"] as? String) ?? ""
            throw GatewayError(.http, status, code, Texts.forErrorCode(code, status: status))
        }
        return json
    }

    private func decode<T: Decodable>(_ type: T.Type, _ value: Any?) throws -> T {
        guard let value, JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let result = try? GatewayDates.decoder().decode(T.self, from: data) else {
            throw GatewayError(.network, 0, "bad_response", "Sunucudan beklenmeyen yanıt.")
        }
        return result
    }

    private func items<T: Decodable>(_ path: String, token: String) async throws -> [T] {
        let json = try await send("GET", path, token: token, body: nil)
        guard let items = (json as? [String: Any])?["items"] else { return [] }
        return try decode([T].self, items)
    }

    public func linkStart(name: String) async throws -> LinkStart {
        try decode(LinkStart.self, try await send("POST", "/api/center-link/start", token: nil, body: ["name": name]))
    }

    public func linkPoll(id: String, secret: String) async throws -> LinkPoll {
        try decode(LinkPoll.self, try await send("POST", "/api/center-link/poll", token: nil,
                                                 body: ["requestId": id, "requestSecret": secret]))
    }

    public func me(token: String) async throws -> CenterMe {
        try decode(CenterMe.self, try await send("GET", "/api/center/me", token: token, body: nil))
    }

    public func pending(token: String) async throws -> [ApprovalRequest] {
        try await items("/api/approval-requests?status=pending&limit=100", token: token)
    }

    public func devices(token: String) async throws -> [Device] {
        let all: [Device] = try await items("/api/devices", token: token)
        return all.filter { $0.revokedAt == nil }
    }

    public func autonomy(token: String) async throws -> [AutonomyItem] {
        try await items("/api/trust/autonomy", token: token)
    }

    public func decide(token: String, id: String, approve: Bool) async throws {
        guard let uuid = UUID(uuidString: id) else {
            throw GatewayError(.http, 400, "invalid_request", Texts.forErrorCode("invalid_request", status: 400))
        }
        let path = "/api/approval-requests/\(uuid.uuidString.lowercased())/\(approve ? "approve" : "deny")"
        _ = try await send("POST", path, token: token, body: [:])
    }

    public func setAutonomy(token: String, enable: Bool, minutes: Int?, deviceIds: [String]?, password: String?) async throws {
        var body: [String: Any] = ["enable": enable]
        if enable {
            body["minutes"] = minutes.map { $0 as Any } ?? NSNull()
            body["currentPassword"] = password ?? ""
        }
        if let deviceIds { body["deviceIds"] = deviceIds }
        _ = try await send("POST", "/api/trust/autonomy", token: token, body: body)
    }

    public func disconnect(token: String) async throws {
        _ = try await send("POST", "/api/center/disconnect", token: token, body: [:])
    }
}
