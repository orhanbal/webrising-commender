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
    /// Split view: a terminal and the ones shown next to it.
    @Published var splits: [String: [String]] = [:]
    /// Split groups laid out one above the other (else side by side).
    @Published var splitVertical: Set<String> = []
    /// Split groups where typing goes to every terminal.
    @Published var broadcast: Set<String> = []
    /// Set while connecting a host for a split: it joins this terminal.
    private var splitTarget: (primary: String, vertical: Bool)?

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

    private var syncTimer: Timer?
    private var soonSync: Task<Void, Never>?

    /// A change here goes to the other computers a few seconds later.
    func scheduleLibrarySync() {
        soonSync?.cancel()
        soonSync = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if !Task.isCancelled { await self?.syncAll() }
        }
    }

    /// Every 5 minutes, plus right away.
    func startLibrarySync() {
        guard syncTimer == nil else { return }
        syncTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.syncAll() }
        }
        Task { await syncAll() }
    }

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
            scheduleLibrarySync()
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
                if let target = splitTarget, sessions.contains(where: { $0.id == target.primary }) {
                    splits[target.primary, default: []].append(sid)
                    if target.vertical { splitVertical.insert(target.primary) } else { splitVertical.remove(target.primary) }
                    selection = target.primary
                } else {
                    selection = sid
                }
                splitTarget = nil
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
        let primary = primaryId(of: session.id)
        let targets = broadcast.contains(primary) ? group(primary) : [session]
        let text = String(decoding: bytes, as: UTF8.self)
        for t in targets where !t.closed {
            guard let core else { return }
            Task { try? await core.call("terminal.write", ["sessionId": t.id, "data": text]) }
        }
    }

    // MARK: split view

    /// The terminal a split pane belongs to (itself when it is not a pane).
    func primaryId(of id: String) -> String {
        splits.first { $0.value.contains(id) }?.key ?? id
    }

    /// A terminal with the panes shown next to it, in order.
    func group(_ primary: String) -> [TerminalSession] {
        let ids = [primary] + (splits[primary] ?? [])
        return ids.compactMap { id in sessions.first { $0.id == id } }
    }

    /// Opens `host` in a new terminal next to `primary`.
    func split(_ primary: String, vertical: Bool, host: CoreHost) {
        guard group(primary).count < 4 else { return }
        splitTarget = (primary, vertical)
        open(host)
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
        // A pane leaves its group; a group whose main terminal closes keeps
        // its next pane as the main one.
        for (key, panes) in splits { splits[key] = panes.filter { $0 != session.id } }
        if let panes = splits.removeValue(forKey: session.id), let next = panes.first {
            splits[next] = Array(panes.dropFirst())
            if splitVertical.remove(session.id) != nil { splitVertical.insert(next) }
            if broadcast.remove(session.id) != nil { broadcast.insert(next) }
            if selection == session.id { selection = next }
        }
        splits = splits.filter { !$0.value.isEmpty }
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

    /// `kind`: local (ssh -L), remote (ssh -R) or dynamic (ssh -D, SOCKS5).
    func startForward(_ session: TerminalSession, kind: String = "local", localPort: Int, localHost: String? = nil,
                      remoteHost: String, remotePort: Int, save: Bool) async throws -> [ForwardInfo] {
        guard let core else { throw CoreClient.Failure.stopped }
        var params: [String: Any] = [
            "sessionId": session.id, "kind": kind, "localPort": localPort, "remoteHost": remoteHost, "remotePort": remotePort,
        ]
        if let localHost { params["localHost"] = localHost }
        let list = try await core.call("forward.start", params, as: [ForwardInfo].self)
        if save, let opened = list.last {
            var local = localPort
            var remote = remotePort
            // A port the system picked is saved as that port.
            if kind != "remote", local == 0, let p = Int(opened.local.split(separator: ":").last ?? "") { local = p }
            if kind == "remote", remote == 0,
               let p = Int(opened.local.split(separator: " ").first?.split(separator: ":").last ?? "") { remote = p }
            var saveParams: [String: Any] = [
                "hostId": session.host.id, "kind": kind, "localPort": local, "remoteHost": remoteHost, "remotePort": remote,
            ]
            if let localHost { saveParams["localHost"] = localHost }
            savedTunnels = try await core.call("tunnels.save", saveParams, as: [SavedTunnel].self)
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

    // MARK: identities, terminal options, backup

    func identities() async -> [Identity] {
        guard let core else { return [] }
        return (try? await core.call("identities.list", as: [Identity].self)) ?? []
    }

    func saveIdentity(id: String?, label: String, user: String, authKind: String, keyId: String?, password: String?) async throws -> [Identity] {
        guard let core else { throw CoreClient.Failure.stopped }
        var params: [String: Any] = ["label": label, "user": user, "authKind": authKind]
        if let id { params["id"] = id }
        if let keyId { params["keyId"] = keyId }
        if let password, !password.isEmpty { params["password"] = password }
        let list = try await core.call("identities.save", params, as: [Identity].self)
        await reload()
        return list
    }

    func deleteIdentity(_ identity: Identity) async -> [Identity] {
        guard let core else { return [] }
        let list = (try? await core.call("identities.delete", ["id": identity.id], as: [Identity].self)) ?? []
        await reload()
        return list
    }

    func setIdentity(_ host: CoreHost, identityId: String?) async throws {
        guard let core else { throw CoreClient.Failure.stopped }
        var params: [String: Any] = ["id": host.id]
        if let identityId { params["identityId"] = identityId }
        hosts = try await core.call("hosts.setIdentity", params, as: [CoreHost].self)
        onChange?()
    }

    func setOptions(_ host: CoreHost, startupCommand: String?, env: [String: String], agentForwarding: Bool) async throws {
        guard let core else { throw CoreClient.Failure.stopped }
        var params: [String: Any] = ["id": host.id, "env": env, "agentForwarding": agentForwarding]
        if let startupCommand, !startupCommand.isEmpty { params["startupCommand"] = startupCommand }
        hosts = try await core.call("hosts.setOptions", params, as: [CoreHost].self)
        onChange?()
    }

    /// The library as JSON (hosts, groups, tunnels, snippets, identities, trusted keys; no secrets).
    func exportLibrary() async throws -> String {
        guard let core else { throw CoreClient.Failure.stopped }
        let reply = try await core.call("library.export") as? [String: Any]
        return reply?["json"] as? String ?? "{}"
    }

    func importLibrary(_ json: String) async throws -> ImportSummary {
        guard let core else { throw CoreClient.Failure.stopped }
        let summary = try await core.call("library.import", ["json": json], as: ImportSummary.self)
        await reload()
        return summary
    }

    // MARK: A20 sync between the user's computers

    /// The gateway and the signed-in token, set by the app delegate.
    var credentials: (() -> (GatewayClient, String)?)?
    @Published private(set) var syncConfigured = false
    @Published private(set) var syncPersistent = true
    @Published private(set) var lastLibrarySync: Date?
    @Published var librarySyncError: String?
    private var syncing = false

    func refreshSyncStatus() async {
        guard let core, let reply = try? await core.call("sync.status") as? [String: Any] else { return }
        syncConfigured = reply["configured"] as? Bool ?? false
        syncPersistent = reply["persistent"] as? Bool ?? true
    }

    /// Turns sync on with the passphrase (checked against the server's library when there is one).
    func setupSync(passphrase: String) async throws {
        guard let core else { throw CoreClient.Failure.stopped }
        guard let creds = credentials?() else { throw CoreClient.Failure.core("Önce oturum aç.") }
        let (gateway, token) = creds
        let remote = try await gateway.library(token: token)
        var params: [String: Any] = ["passphrase": passphrase]
        if let envelope = remote.envelope { params["remote"] = envelope }
        _ = try await core.call("sync.setup", params)
        await refreshSyncStatus()
        await syncLibrary()
        if let error = librarySyncError { throw CoreClient.Failure.core(error) }
    }

    func forgetSync() async {
        guard let core else { return }
        _ = try? await core.call("sync.forget")
        await refreshSyncStatus()
    }

    /// One sync round: merge the server's library here, upload the result;
    /// when another computer uploaded in between, merge again.
    func syncLibrary() async {
        guard !syncing, let core, let creds = credentials?() else { return }
        let (gateway, token) = creds
        await refreshSyncStatus()
        guard syncConfigured else { return }
        syncing = true
        defer { syncing = false }
        do {
            var state = try await gateway.library(token: token)
            var changed = false
            for _ in 0..<4 {
                var params: [String: Any] = [:]
                if let envelope = state.envelope { params["remote"] = envelope }
                let merge = try await core.call("sync.merge", params) as? [String: Any] ?? [:]
                changed = changed || (merge["changedHere"] as? Bool ?? false)
                guard let upload = merge["envelope"] as? String else { break }
                let put = try await gateway.putLibrary(token: token, baseRevision: state.revision, envelope: upload)
                if put.accepted {
                    _ = try await core.call("sync.committed")
                    break
                }
                state = put.state
            }
            lastLibrarySync = Date()
            librarySyncError = nil
            if changed { await reload() }
        } catch {
            librarySyncError = error.localizedDescription
        }
    }

    /// Personal library (when set up) and the team library.
    func syncAll() async {
        await syncLibrary()
        await syncTeam()
    }

    // MARK: A22 team

    @Published private(set) var teamName: String?
    @Published private(set) var teamRole: String?
    @Published private(set) var teamMembers: [TeamMember] = []
    @Published private(set) var teamWaiting = false
    @Published var teamError: String?
    private var teamSyncing = false

    func setTeam(kind: String, id: String, team: Bool) async {
        guard let core else { return }
        do {
            hosts = try await core.call("library.setTeam", ["kind": kind, "id": id, "team": team], as: [CoreHost].self)
            onChange?()
            scheduleLibrarySync()
        } catch {
            notice = error.localizedDescription
        }
    }

    /// One team round: publish this app's public key, get (or make) the team
    /// key, give it to team apps without it, merge the shared library.
    func syncTeam() async {
        guard !teamSyncing, let core, let creds = credentials?() else { return }
        let (gateway, token) = creds
        teamSyncing = true
        defer { teamSyncing = false }
        do {
            var me = try await core.call("team.status") as? [String: Any] ?? [:]
            let myPub = me["publicKey"] as? String ?? ""
            var hasKey = me["hasKey"] as? Bool ?? false
            var team = try await gateway.team(token: token)
            if !team.members.contains(where: { $0.publicKey == myPub }) {
                try await gateway.putTeamKey(token: token, publicKey: myPub)
                team = try await gateway.team(token: token)
            }
            teamName = team.organizationName
            teamRole = team.role
            teamMembers = team.members
            let mine = team.members.first { $0.publicKey == myPub }
            if let sealed = team.myWrappedKey {
                me = try await core.call("team.accept", ["sealed": sealed]) as? [String: Any] ?? [:]
                hasKey = me["hasKey"] as? Bool ?? true
            } else if hasKey, let mine, team.canEdit, team.members.contains(where: { $0.hasKey }) {
                let again = try await core.call("team.share", ["publicKey": myPub]) as? [String: Any]
                if let s = again?["sealed"] as? String { try await gateway.putWrappedKey(token: token, centerId: mine.centerId, wrappedKey: s) }
            } else if !team.members.contains(where: { $0.hasKey }), team.canEdit, let mine {
                let created = try await core.call("team.create") as? [String: Any]
                if let s = created?["sealed"] as? String { try await gateway.putWrappedKey(token: token, centerId: mine.centerId, wrappedKey: s) }
                hasKey = true
            } else if !hasKey {
                teamWaiting = true
                return
            }
            teamWaiting = false
            if team.canEdit {
                for m in team.members where !m.hasKey && m.publicKey != myPub {
                    let shared = try await core.call("team.share", ["publicKey": m.publicKey]) as? [String: Any]
                    if let s = shared?["sealed"] as? String { try await gateway.putWrappedKey(token: token, centerId: m.centerId, wrappedKey: s) }
                }
            }
            var state = LibraryState(revision: team.revision, envelope: team.envelope)
            var changed = false
            for _ in 0..<4 {
                var params: [String: Any] = [:]
                if let envelope = state.envelope { params["remote"] = envelope }
                let merge = try await core.call("team.merge", params) as? [String: Any] ?? [:]
                changed = changed || (merge["changedHere"] as? Bool ?? false)
                guard let upload = merge["envelope"] as? String, team.canEdit else { break }
                let put = try await gateway.putTeamLibrary(token: token, baseRevision: state.revision, envelope: upload)
                if put.accepted {
                    _ = try await core.call("team.committed")
                    break
                }
                state = put.state
            }
            teamError = nil
            if changed { await reload() }
        } catch let error as GatewayError where error.code == "not_a_member" {
            _ = try? await core.call("team.leave")
            teamName = nil; teamRole = nil; teamMembers = []
            await reload()
        } catch {
            teamError = error.localizedDescription
        }
    }
}
