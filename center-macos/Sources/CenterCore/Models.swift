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
    /// A saved SSH server shared through a computer (Hybrid Access H3): no device, a label instead.
    public let targetLabel: String?
    public let actionKind: String
    public let action: JSONValue?
    public let expiresAt: Date
    public let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, action
        case deviceId = "device_id"
        case targetLabel = "target_label"
        case actionKind = "action_kind"
        case expiresAt = "expires_at"
        case createdAt = "created_at"
    }

    public init(id: String, deviceId: String, actionKind: String, action: JSONValue?, expiresAt: Date, createdAt: Date, targetLabel: String? = nil) {
        self.id = id; self.deviceId = deviceId; self.actionKind = actionKind
        self.action = action; self.expiresAt = expiresAt; self.createdAt = createdAt
        self.targetLabel = targetLabel
    }

    /// The exact thing the approval allows: command, path or name.
    public var summary: String { ActionSummary.from(action) }

    /// Where it runs: the device's name, or the SSH server's ("web-1 · SSH").
    public func placeName(_ devices: [String: String]) -> String {
        if !deviceId.isEmpty, let name = devices[deviceId] { return name }
        if let label = targetLabel?.trimmingCharacters(in: .whitespaces), !label.isEmpty { return label + " · SSH" }
        return L.t("bilinmeyen cihaz")
    }
}

public struct Device: Decodable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let platform: String?
    public let online: Bool
    public let trustLevel: String?
    public let trustFullUntil: Date?
    public let revokedAt: Date?
    /// "user" or "root": who the AI's commands run as.
    public let runAs: String?
    /// The machine owner allowed root when installing the agent.
    public let rootCapable: Bool?
    public let safetyNet: Bool?

    enum CodingKeys: String, CodingKey {
        case id, name, platform, online
        case trustLevel = "trust_level"
        case trustFullUntil = "trust_full_until"
        case revokedAt = "revoked_at"
        case runAs = "run_as"
        case rootCapable = "root_capable"
        case safetyNet = "safety_net"
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
        runAs = try c.decodeIfPresent(String.self, forKey: .runAs)
        rootCapable = try c.decodeIfPresent(Bool.self, forKey: .rootCapable)
        safetyNet = try c.decodeIfPresent(Bool.self, forKey: .safetyNet)
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

/// Where a request was decided: a Management Center (with its name and the
/// kind of computer) or the web panel. `isSelf` is this center.
public struct DecidedVia: Decodable, Equatable {
    public let kind: String
    public let name: String?
    public let platform: String?
    public let isSelf: Bool

    enum CodingKeys: String, CodingKey {
        case kind, name, platform
        case isSelf = "self"
    }

    public init(kind: String, name: String?, platform: String?, isSelf: Bool) {
        self.kind = kind; self.name = name; self.platform = platform; self.isSelf = isSelf
    }
}

/// The outcome of one approval request (GET /api/approval-requests/{id}).
public struct ApprovalOutcome: Decodable, Equatable {
    public let id: String
    public let status: String
    public let decidedVia: DecidedVia?

    enum CodingKeys: String, CodingKey {
        case id, status
        case decidedVia = "decided_via"
    }

    public init(id: String, status: String, decidedVia: DecidedVia?) {
        self.id = id; self.status = status; self.decidedVia = decidedVia
    }
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
        if case .string(let data)? = fields["dataBase64"] { return terminalInput(data) }
        // SSH targets (Hybrid Access H4): a move shows both ends, a write its size and content hash.
        if case .string(let from)? = fields["source"], case .string(let to)? = fields["destination"] { return "\(from) → \(to)" }
        if case .string(let path)? = fields["path"], case .string(let hash)? = fields["sha256"], case .number(let size)? = fields["size"] {
            let bytes = size == size.rounded() ? String(Int64(size)) : String(size)
            return "\(path) (\(bytes) B, sha256 \(hash.prefix(12))…)"
        }
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

    /// What an AI wants to type into a terminal: printable, one line, bounded.
    public static func terminalInput(_ base64: String) -> String {
        guard let data = Data(base64Encoded: base64) else { return "" }
        let text = String(decoding: data, as: UTF8.self)
            .replacingOccurrences(of: "\r\n", with: "⏎")
            .replacingOccurrences(of: "\n", with: "⏎")
            .replacingOccurrences(of: "\r", with: "⏎")
        let printable = String(String.UnicodeScalarView(text.unicodeScalars.map {
            $0.value < 0x20 || $0.value == 0x7f ? "·" : $0
        }))
        return String(printable.prefix(300))
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

/// A marketing message or survey from the console: kind is message, tip,
/// announcement, csat (faces 1–5) or nps (0–10).
public struct InAppMessage: Decodable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let title: String
    public let body: String
    public let ctaLabel: String?
    public let ctaUrl: String?

    public init(id: String, kind: String, title: String, body: String, ctaLabel: String? = nil, ctaUrl: String? = nil) {
        self.id = id; self.kind = kind; self.title = title; self.body = body; self.ctaLabel = ctaLabel; self.ctaUrl = ctaUrl
    }

    public var isSurvey: Bool { kind == "csat" || kind == "nps" }
    /// Score buttons: 1–5 for csat, 0–10 for nps.
    public var scores: [Int] { kind == "csat" ? Array(1...5) : kind == "nps" ? Array(0...10) : [] }
    /// The call to action opens only https links.
    public var cta: (label: String, url: URL)? {
        guard let label = ctaLabel?.trimmingCharacters(in: .whitespaces), !label.isEmpty,
              let raw = ctaUrl, raw.hasPrefix("https://"), let url = URL(string: raw) else { return nil }
        return (label, url)
    }
}
