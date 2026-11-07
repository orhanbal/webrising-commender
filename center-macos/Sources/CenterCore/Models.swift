import Foundation

/// Any JSON value; used for the approval's `action` object.
public enum JSONValue: Decodable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
}

/// A pending approval request as the gateway lists it.
public struct ApprovalRequest: Decodable, Identifiable, Equatable {
    public let id: String
    public let deviceId: String
    public let actionKind: String
    public let action: JSONValue?
    public let expiresAt: Date
    public let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, action
        case deviceId = "device_id"
        case actionKind = "action_kind"
        case expiresAt = "expires_at"
        case createdAt = "created_at"
    }

    public init(id: String, deviceId: String, actionKind: String, action: JSONValue?, expiresAt: Date, createdAt: Date) {
        self.id = id; self.deviceId = deviceId; self.actionKind = actionKind
        self.action = action; self.expiresAt = expiresAt; self.createdAt = createdAt
    }

    /// The exact thing the approval allows: command, path or name.
    public var summary: String { ActionSummary.from(action) }
}

public struct Device: Decodable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let platform: String?
    public let online: Bool
    public let trustLevel: String?
    public let trustFullUntil: Date?
    public let revokedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, name, platform, online
        case trustLevel = "trust_level"
        case trustFullUntil = "trust_full_until"
        case revokedAt = "revoked_at"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        platform = try c.decodeIfPresent(String.self, forKey: .platform)
        online = try c.decodeIfPresent(Bool.self, forKey: .online) ?? false
        trustLevel = try c.decodeIfPresent(String.self, forKey: .trustLevel)
        trustFullUntil = try c.decodeIfPresent(Date.self, forKey: .trustFullUntil)
        revokedAt = try c.decodeIfPresent(Date.self, forKey: .revokedAt)
    }
}

public struct AutonomyItem: Decodable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let trustFullUntil: Date?

    enum CodingKeys: String, CodingKey {
        case id, name
        case trustFullUntil = "trust_full_until"
    }
}

public struct CenterMe: Decodable, Equatable {
    public let centerId: String
    public let name: String
    public let email: String?
    public let role: String
    public let organizationName: String?
}

public struct LinkStart: Decodable, Equatable {
    public let requestId: String
    public let requestSecret: String
    public let approveUrl: String
    public let expiresInSeconds: Int
}

public struct LinkPoll: Decodable, Equatable {
    public let status: String
    public let centerToken: String?
}

public enum ActionSummary {
    public static func from(_ action: JSONValue?) -> String {
        guard case .object(let fields)? = action else { return "" }
        for key in ["command", "path", "source", "name", "pid", "taskId", "sessionId"] {
            switch fields[key] {
            case .string(let s)? where !s.isEmpty: return s
            case .number(let n)?:
                let text = n == n.rounded() ? String(Int64(n)) : String(n)
                return "\(key) \(text)"
            default: continue
            }
        }
        return ""
    }
}

/// Gateway timestamps: RFC 3339 with or without fractional seconds.
public enum GatewayDates {
    private static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    public static func parse(_ text: String) -> Date? {
        fractional.date(from: text) ?? plain.date(from: text)
    }

    public static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            let text = try c.decode(String.self)
            guard let date = parse(text) else {
                throw DecodingError.dataCorruptedError(in: c, debugDescription: "bad date \(text)")
            }
            return date
        }
        return d
    }
}
