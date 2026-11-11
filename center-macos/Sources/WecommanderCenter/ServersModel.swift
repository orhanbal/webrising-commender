import AppKit
import CenterCore
import Foundation

/// One open terminal tab.
@MainActor
final class TerminalSession: ObservableObject, Identifiable {
    let id: String
    let host: CoreHost
    @Published var closed = false
    @Published var exitCode: Int?
    /// Set by the terminal view; output that arrives earlier is buffered.
    var feed: (([UInt8]) -> Void)? {
        didSet { if let feed, !pending.isEmpty { feed(pending); pending.removeAll() } }
    }
    private var pending: [UInt8] = []

    init(id: String, host: CoreHost) {
        self.id = id
        self.host = host
    }

    func receive(_ bytes: [UInt8]) {
        if let feed { feed(bytes) } else { pending.append(contentsOf: bytes) }
    }
}

/// What the connect sheet is asking for.
struct ConnectRequest: Identifiable {
    let id = UUID()
    let host: CoreHost
    var message: String?
    /// Set when the server's host key needs approval.
    var hostKey: ConnectResult?
    var auth: [String: Any]?
}

/// The Servers window state: saved hosts, terminals, file transfers and
/// tunnels, all through wecommander-core.
@MainActor
final class ServersModel: ObservableObject {
    @Published private(set) var hosts: [CoreHost] = []
    @Published private(set) var sessions: [TerminalSession] = []
    @Published var selection: String?
    @Published var connect: ConnectRequest?
    @Published var notice: String?
    @Published private(set) var savedTunnels: [SavedTunnel] = []
    @Published private(set) var transfers: [String: (label: String, done: UInt64, total: UInt64)] = [:]
    @Published private(set) var vaultLabel = ""
    @Published private(set) var coreError: String?

    var onChange: (() -> Void)?
    private var core: CoreClient?

    var selectedSession: TerminalSession? { sessions.first { $0.id == selection } }

    func start() {
        guard core == nil else { return }
        guard let exe = Bundle.main.url(forAuxiliaryExecutable: "wecommander-core") else {
            coreError = "Uygulama çekirdeği (wecommander-core) paketin içinde bulunamadı."
            return
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("app.wecommander", isDirectory: true)
        do {
            let client = try CoreClient(executable: exe, dataDirectory: support)
            client.onEvent = { [weak self] name, data in
                Task { @MainActor in self?.event(name, data) }
            }
            core = client
            Task { await reload() }
        } catch {
            coreError = "Uygulama çekirdeği başlatılamadı: \(error.localizedDescription)"
        }
    }

    func stop() { core?.stop() }

    private func event(_ name: String, _ data: Any?) {
        let object = data as? [String: Any] ?? [:]
        switch name {
        case "ready":
            vaultLabel = object["vaultBackend"] as? String ?? ""
        case "terminal-output":
            guard let sid = object["sessionId"] as? String,
                  let b64 = object["data"] as? String,
                  let bytes = Data(base64Encoded: b64) else { return }
            sessions.first { $0.id == sid }?.receive([UInt8](bytes))
        case "terminal-exit":
            guard let sid = object["sessionId"] as? String, let s = sessions.first(where: { $0.id == sid }) else { return }
            s.closed = true
            s.exitCode = (object["code"] as? NSNumber)?.intValue
            let text = s.exitCode.map { "\r\n\u{1b}[90m[Bağlantı kapandı, çıkış kodu \($0).]\u{1b}[0m\r\n" }
                ?? "\r\n\u{1b}[90m[Bağlantı kapandı.]\u{1b}[0m\r\n"
            s.receive(Array(text.utf8))
        case "transfer-progress":
            guard let id = object["transferId"] as? String, var t = transfers[id] else { return }
            t.done = (object["done"] as? NSNumber)?.uint64Value ?? t.done
            t.total = (object["total"] as? NSNumber)?.uint64Value ?? t.total
            transfers[id] = t
        case "changed", "tunnels-changed":
            Task { await reload() }
        default:
            break
        }
    }

    func reload() async {
        guard let core else { return }
        do {
            hosts = try await core.call("hosts.list", as: [CoreHost].self)
            savedTunnels = try await core.call("tunnels.saved", as: [SavedTunnel].self)
            onChange?()
        } catch {
            notice = error.localizedDescription
        }
    }

    // MARK: hosts

    func addHost(label: String, host: String, port: Int, user: String, authKind: String, jumpId: String?) async throws {
        guard let core else { throw CoreClient.Failure.stopped }
        var params: [String: Any] = ["label": label, "host": host, "port": port, "user": user, "authKind": authKind]
        if let jumpId { params["jumpId"] = jumpId }
        hosts = try await core.call("hosts.add", params, as: [CoreHost].self)
        onChange?()
    }

    func deleteHost(_ host: CoreHost) async {
        guard let core else { return }
        do { hosts = try await core.call("hosts.delete", ["id": host.id], as: [CoreHost].self); onChange?() }
        catch { notice = error.localizedDescription }
    }

    func forgetSecret(_ host: CoreHost) async {
        guard let core else { return }
        do { hosts = try await core.call("secret.forget", ["id": host.id], as: [CoreHost].self) }
        catch { notice = error.localizedDescription }
    }

    func importSSHConfig() async {
        guard let core else { return }
        do {
            let result = try await core.call("hosts.import", as: ImportResult.self)
            hosts = result.hosts
            notice = result.added > 0
                ? "\(result.added) sunucu içe aktarıldı" + (result.skipped > 0 ? ", \(result.skipped) zaten vardı." : ".")
                : "Yeni sunucu bulunamadı."
            onChange?()
        } catch {
            notice = "~/.ssh/config okunamadı: \(error.localizedDescription)"
        }
    }

    // MARK: connect

    /// Uses the saved credential or key file when there is one, else asks.
    func open(_ host: CoreHost) {
        if host.savedSecret || (host.authKind == "key" && host.keyPath != nil) {
            Task { await run(host, auth: ["kind": host.authKind, "secret": "", "remember": false], accept: nil) }
        } else {
            connect = ConnectRequest(host: host)
        }
    }

    func run(_ host: CoreHost, auth: [String: Any], accept: String?) async {
        guard let core else { return }
        var params: [String: Any] = ["id": host.id, "auth": auth, "mode": "terminal", "cols": 100, "rows": 30]
        if let accept { params["acceptFingerprint"] = accept }
        do {
            let result = try await core.call("connect", params, as: ConnectResult.self)
            if result.needsHostKeyApproval {
                connect = ConnectRequest(host: host, message: nil, hostKey: result, auth: auth)
                return
            }
            connect = nil
            if let sid = result.sessionId {
                let session = TerminalSession(id: sid, host: host)
                sessions.append(session)
                selection = sid
            }
            await reload()
        } catch {
            let text = error.localizedDescription
            let needsCredential = text.contains("giriş bilgisi") || text.contains("reddedildi") || text.contains("Anahtar")
            if connect != nil || needsCredential {
                connect = ConnectRequest(host: host, message: text)
            } else {
                notice = "\(host.label): \(text)"
            }
        }
    }

    // MARK: terminal

    func write(_ session: TerminalSession, _ bytes: ArraySlice<UInt8>) {
        guard !session.closed, let core else { return }
        let text = String(decoding: bytes, as: UTF8.self)
        Task { try? await core.call("terminal.write", ["sessionId": session.id, "data": text]) }
    }

    func resize(_ session: TerminalSession, cols: Int, rows: Int) {
        guard !session.closed, let core else { return }
        Task { try? await core.call("terminal.resize", ["sessionId": session.id, "cols": cols, "rows": rows]) }
    }

    func close(_ session: TerminalSession) {
        if !session.closed, let core {
            Task { try? await core.call("terminal.close", ["sessionId": session.id]) }
        }
        sessions.removeAll { $0.id == session.id }
        if selection == session.id { selection = sessions.last?.id }
    }

    // MARK: files

    func list(_ session: TerminalSession, path: String?) async throws -> RemoteListing {
        guard let core else { throw CoreClient.Failure.stopped }
        var params: [String: Any] = ["sessionId": session.id]
        if let path { params["path"] = path }
        return try await core.call("files.list", params, as: RemoteListing.self)
    }

    func filesAction(_ method: String, _ session: TerminalSession, _ params: [String: Any]) async throws {
        guard let core else { throw CoreClient.Failure.stopped }
        var all = params
        all["sessionId"] = session.id
        try await core.call(method, all)
    }

    func transfer(_ method: String, _ session: TerminalSession, label: String, _ params: [String: Any]) async throws {
        guard let core else { throw CoreClient.Failure.stopped }
        let id = UUID().uuidString
        transfers[id] = (label, 0, 0)
        defer { transfers.removeValue(forKey: id) }
        var all = params
        all["sessionId"] = session.id
        all["transferId"] = id
        try await core.call(method, all)
    }

    // MARK: tunnels

    func forwards(_ session: TerminalSession) async -> [ForwardInfo] {
        guard let core else { return [] }
        return (try? await core.call("forward.list", ["sessionId": session.id], as: [ForwardInfo].self)) ?? []
    }

    func startForward(_ session: TerminalSession, localPort: Int, remoteHost: String, remotePort: Int, save: Bool) async throws -> [ForwardInfo] {
        guard let core else { throw CoreClient.Failure.stopped }
        let list = try await core.call("forward.start", [
            "sessionId": session.id, "localPort": localPort, "remoteHost": remoteHost, "remotePort": remotePort,
        ], as: [ForwardInfo].self)
        if save, let opened = list.last, let port = Int(opened.local.split(separator: ":").last ?? "") {
            savedTunnels = try await core.call("tunnels.save", [
                "hostId": session.host.id, "localPort": port, "remoteHost": remoteHost, "remotePort": remotePort,
            ], as: [SavedTunnel].self)
        }
        return list
    }

    func stopForward(_ session: TerminalSession, local: String) async -> [ForwardInfo] {
        guard let core else { return [] }
        return (try? await core.call("forward.stop", ["sessionId": session.id, "local": local], as: [ForwardInfo].self)) ?? []
    }

    func toggleTunnel(_ tunnel: SavedTunnel) async {
        guard let core else { return }
        do {
            savedTunnels = try await core.call("tunnels.toggle", ["hostId": tunnel.hostId, "index": tunnel.index], as: [SavedTunnel].self)
            onChange?()
        } catch {
            notice = "Tünel açılamadı: \(error.localizedDescription)"
        }
    }

    func deleteTunnel(_ tunnel: SavedTunnel) async {
        guard let core else { return }
        savedTunnels = (try? await core.call("tunnels.delete", ["hostId": tunnel.hostId, "index": tunnel.index], as: [SavedTunnel].self)) ?? savedTunnels
        onChange?()
    }

    // MARK: host library (edit, groups, trusted keys, snippets, history)

    func updateHost(_ host: CoreHost, label: String, address: String, port: Int, user: String,
                    authKind: String, jumpId: String?, group: String?) async throws {
        guard let core else { throw CoreClient.Failure.stopped }
        var params: [String: Any] = ["id": host.id, "label": label, "host": address, "port": port,
                                     "user": user, "authKind": authKind]
        if let jumpId { params["jumpId"] = jumpId }
        if let group { params["group"] = group }
        hosts = try await core.call("hosts.update", params, as: [CoreHost].self)
        onChange?()
    }

    func knownHosts() async -> [KnownHost] {
        guard let core else { return [] }
        return (try? await core.call("known.list", as: [KnownHost].self)) ?? []
    }

    func forgetKnownHost(_ known: KnownHost) async -> [KnownHost] {
        guard let core else { return [] }
        let list = (try? await core.call("known.forget", ["target": known.target], as: [KnownHost].self)) ?? []
        await reload()
        return list
    }

    func snippets() async -> [Snippet] {
        guard let core else { return [] }
        return (try? await core.call("snippets.list", as: [Snippet].self)) ?? []
    }

    func saveSnippet(id: String?, label: String, command: String) async throws -> [Snippet] {
        guard let core else { throw CoreClient.Failure.stopped }
        var params: [String: Any] = ["label": label, "command": command]
        if let id { params["id"] = id }
        return try await core.call("snippets.save", params, as: [Snippet].self)
    }

    func deleteSnippet(_ snippet: Snippet) async -> [Snippet] {
        guard let core else { return [] }
        return (try? await core.call("snippets.delete", ["id": snippet.id], as: [Snippet].self)) ?? []
    }

    /// Sends a saved command to the open terminal and runs it.
    func send(_ snippet: Snippet, to session: TerminalSession) {
        let text = snippet.command.replacingOccurrences(of: "\r\n", with: "\r").replacingOccurrences(of: "\n", with: "\r") + "\r"
        write(session, ArraySlice(Array(text.utf8)))
    }

    func history() async -> [HistoryEntry] {
        guard let core else { return [] }
        return (try? await core.call("history.list", as: [HistoryEntry].self)) ?? []
    }

    func clearHistory() async {
        guard let core else { return }
        _ = try? await core.call("history.clear")
    }

    // MARK: keys

    func keys() async -> [KeyMeta] {
        guard let core else { return [] }
        return (try? await core.call("keys.list", as: [KeyMeta].self)) ?? []
    }

    func generateKey(label: String) async throws -> [KeyMeta] {
        guard let core else { throw CoreClient.Failure.stopped }
        return try await core.call("keys.generate", ["label": label], as: [KeyMeta].self)
    }

    func importKey(label: String, privateKey: String, passphrase: String?) async throws -> [KeyMeta] {
        guard let core else { throw CoreClient.Failure.stopped }
        var params: [String: Any] = ["label": label, "private": privateKey]
        if let passphrase, !passphrase.isEmpty { params["passphrase"] = passphrase }
        return try await core.call("keys.import", params, as: [KeyMeta].self)
    }

    func deleteKey(_ key: KeyMeta) async -> [KeyMeta] {
        guard let core else { return [] }
        let list = (try? await core.call("keys.delete", ["id": key.id], as: [KeyMeta].self)) ?? []
        await reload()
        return list
    }

    func setKey(_ host: CoreHost, keyId: String?) async throws {
        guard let core else { throw CoreClient.Failure.stopped }
        var params: [String: Any] = ["id": host.id]
        if let keyId { params["keyId"] = keyId }
        hosts = try await core.call("hosts.setKey", params, as: [CoreHost].self)
        onChange?()
    }
}
