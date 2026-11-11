import Foundation

/// Talks to `wecommander-core`, the shared Rust app core (saved hosts,
/// keyring, SSH terminals, SFTP, tunnels), over its JSON-lines protocol
/// (docs/CORE_PROTOCOL.md). One process per app; requests run concurrently
/// and are matched by id; events arrive through `onEvent`.
public final class CoreClient: @unchecked Sendable {
    public enum Failure: LocalizedError, Equatable {
        case stopped
        case core(String)
        case badReply

        public var errorDescription: String? {
            switch self {
            case .stopped: return "Uygulama çekirdeği çalışmıyor."
            case .core(let text): return CoreText.turkish(text)
            case .badReply: return "Uygulama çekirdeğinden beklenmeyen yanıt."
            }
        }
    }

    /// Event name and its `data` (a JSON object, decoded with `JSONSerialization`).
    public var onEvent: (@Sendable (String, Any?) -> Void)?
    public private(set) var info: [String: Any] = [:]

    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let lock = NSLock()
    private var nextID = 0
    private var waiting: [Int: CheckedContinuation<Any?, Error>] = [:]
    private var buffer = Data()
    private var running = true

    /// Starts the core. `executable` is normally `Contents/MacOS/wecommander-core`.
    public init(executable: URL, dataDirectory: URL, keyringService: String = "app.wecommander") throws {
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        process.executableURL = executable
        process.arguments = ["--data-dir", dataDirectory.path, "--keyring-service", keyringService]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            self?.receive(handle.availableData)
        }
        process.terminationHandler = { [weak self] _ in self?.stopAll() }
        try process.run()
    }

    deinit { stop() }

    public func stop() {
        lock.lock()
        let wasRunning = running
        running = false
        lock.unlock()
        guard wasRunning else { return }
        try? input.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
        stopAll()
    }

    /// Calls `method`; returns the JSON `result` (nil for `null`).
    @discardableResult
    public func call(_ method: String, _ params: [String: Any] = [:]) async throws -> Any? {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Any?, Error>) in
            lock.lock()
            guard running else {
                lock.unlock()
                continuation.resume(throwing: Failure.stopped)
                return
            }
            nextID += 1
            let id = nextID
            waiting[id] = continuation
            lock.unlock()
            let message: [String: Any] = ["id": id, "method": method, "params": params]
            guard var line = try? JSONSerialization.data(withJSONObject: message) else {
                finish(id, .failure(Failure.badReply))
                return
            }
            line.append(0x0A)
            do {
                try input.fileHandleForWriting.write(contentsOf: line)
            } catch {
                finish(id, .failure(Failure.stopped))
            }
        }
    }

    /// Calls `method` and decodes its result.
    public func call<T: Decodable>(_ method: String, _ params: [String: Any] = [:], as type: T.Type) async throws -> T {
        let result = try await call(method, params)
        let data = try JSONSerialization.data(withJSONObject: result ?? NSNull(), options: [.fragmentsAllowed])
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw Failure.badReply
        }
    }

    // MARK: - reading

    private func receive(_ data: Data) {
        if data.isEmpty { return }
        var lines: [Data] = []
        lock.lock()
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            lines.append(buffer.subdata(in: buffer.startIndex..<newline))
            buffer.removeSubrange(buffer.startIndex...newline)
        }
        lock.unlock()
        lines.forEach(handle)
    }

    func handle(_ line: Data) {
        guard let object = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { return }
        if let event = object["event"] as? String {
            let data = object["data"]
            if event == "ready", let info = data as? [String: Any] {
                lock.lock(); self.info = info; lock.unlock()
            }
            onEvent?(event, data is NSNull ? nil : data)
            return
        }
        guard let id = (object["id"] as? NSNumber)?.intValue else { return }
        if let error = object["error"] as? String {
            finish(id, .failure(Failure.core(error)))
        } else {
            let result = object["result"]
            finish(id, .success(result is NSNull ? nil : result))
        }
    }

    private func finish(_ id: Int, _ result: Result<Any?, Error>) {
        lock.lock()
        let continuation = waiting.removeValue(forKey: id)
        lock.unlock()
        continuation?.resume(with: result)
    }

    private func stopAll() {
        lock.lock()
        running = false
        let all = waiting
        waiting.removeAll()
        lock.unlock()
        all.values.forEach { $0.resume(throwing: Failure.stopped) }
    }
}

// MARK: - Models (docs/CORE_PROTOCOL.md)

public struct CoreHost: Decodable, Identifiable, Equatable, Hashable {
    public let id: String
    public let label: String
    public let target: String
    public let authKind: String
    public let savedSecret: Bool
    public let keyPath: String?
    public let jumpId: String?
    public let trustedKey: String?
    public let group: String?
    public let user: String?
    public let host: String?
    public let port: Int?
    public let keyId: String?

    /// Hosts without a group are listed under this name.
    public static let noGroup = "Gruplanmamış"
    public var groupName: String {
        let g = (group ?? "").trimmingCharacters(in: .whitespaces)
        return g.isEmpty ? CoreHost.noGroup : g
    }
}

public struct KnownHost: Decodable, Identifiable, Equatable, Hashable {
    public let target: String
    public let fingerprint: String
    public let labels: [String]
    public var id: String { target }
}

/// A key made or imported in the app; the private half is in the Keychain.
public struct KeyMeta: Decodable, Identifiable, Equatable, Hashable {
    public let id: String
    public let label: String
    public let algorithm: String
    public let fingerprint: String
    public let publicKey: String
    public let created: Int64
}

public struct Snippet: Decodable, Identifiable, Equatable, Hashable {
    public let id: String
    public let label: String
    public let command: String
}

public struct HistoryEntry: Decodable, Identifiable, Equatable, Hashable {
    public let hostId: String
    public let label: String
    public let target: String
    public let at: Int64
    public var id: String { "\(hostId)@\(at)" }
    public var date: Date { Date(timeIntervalSince1970: TimeInterval(at)) }
}

public struct ConnectResult: Decodable, Equatable {
    public let status: String
    public let sessionId: String?
    public let fingerprint: String?
    public let algorithm: String?
    public let trusted: String?
    public let output: String?

    public var needsHostKeyApproval: Bool { status == "hostKeyUnknown" || status == "hostKeyChanged" }
}

public struct RemoteEntry: Decodable, Identifiable, Equatable, Hashable {
    public let name: String
    public let path: String
    public let kind: String
    public let size: UInt64
    public let modified: UInt64?
    public let permissions: String
    public var id: String { path }
    public var isFolder: Bool { kind == "dir" }
}

public struct RemoteListing: Decodable, Equatable {
    public let path: String
    public let parent: String
    public let entries: [RemoteEntry]
}

public struct ForwardInfo: Decodable, Equatable, Hashable {
    public let local: String
    public let remote: String
}

public struct SavedTunnel: Decodable, Identifiable, Equatable, Hashable {
    public let hostId: String
    public let hostLabel: String
    public let index: Int
    public let local: String
    public let remote: String
    public let running: Bool
    public var id: String { "\(hostId)#\(index)" }
}

public struct ImportResult: Decodable, Equatable {
    public let added: Int
    public let skipped: Int
    public let hosts: [CoreHost]
}

/// Turkish texts for the core's English error prefixes.
public enum CoreText {
    public static func turkish(_ text: String) -> String {
        if text.contains("no saved credential") { return "Bu sunucu için kayıtlı giriş bilgisi yok; bir kez gir." }
        if text.contains("authentication failed") { return "Giriş reddedildi. Anahtarı veya parolayı kontrol et." }
        if text.contains("private key could not be used") { return "Özel anahtar okunamadı (biçim veya anahtar parolası yanlış)." }
        if text.contains("timed out") { return "Sunucu yanıt vermedi (zaman aşımı)." }
        if text.contains("did not start SFTP") { return "Bu sunucu SFTP'yi açmadı (sshd_config içinde 'Subsystem sftp' olmalı)." }
        if text.hasPrefix("key file ") { return "Anahtar dosyası okunamadı: " + text.dropFirst("key file ".count) }
        if text.hasPrefix("jump host ") { return "Atlama sunucusu: " + text.dropFirst("jump host ".count) }
        if text.hasPrefix("cannot listen on") { return "Port dinlenemiyor: " + text.dropFirst("cannot listen on".count) }
        if text.hasPrefix("connection failed: ") { return "Bağlanılamadı: " + text.dropFirst("connection failed: ".count) }
        return text
    }
}
