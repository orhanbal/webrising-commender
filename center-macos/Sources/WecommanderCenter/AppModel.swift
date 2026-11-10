import AppKit
import CenterCore
import Foundation

enum Phase { case signedOut, linking, signedIn }

/// The Management Center state: signs in through the browser, keeps pending
/// approvals, devices and autonomous mode in sync every few seconds, posts a
/// notification with Onayla / Reddet for each new request. Same behaviour as
/// the Windows app. Everything runs on the main actor.
@MainActor
final class AppModel: ObservableObject {
    private static let syncEvery: TimeInterval = 4

    @Published private(set) var settings: CenterSettings
    @Published private(set) var token: String?
    @Published private(set) var me: CenterMe?
    @Published private(set) var pending: [ApprovalRequest] = []
    @Published private(set) var devices: [Device] = []
    @Published private(set) var autonomy: [AutonomyItem] = []
    @Published var error: String?
    @Published private(set) var lastSync: Date?
    @Published private(set) var link: (id: String, secret: String, url: String, deadline: Date)?
    @Published private(set) var notificationState = "authorized"
    @Published private(set) var busy = false
    @Published var now = Date()
    /// The WECOMMANDER agent on this Mac (nil until first read).
    @Published private(set) var agent: AgentStatus?
    @Published private(set) var agentBusy = false
    /// Installed agent version ("0.1.58"), read every few minutes.
    @Published private(set) var agentVersion: String?
    private var lastVersionCheck = Date.distantPast
    /// Newest published agent build (the N of 0.1.N), checked every 6 hours.
    @Published private(set) var latestAgentBuild: Int?
    private var lastReleaseCheck = Date.distantPast
    private var announcedBuild: Int?
    var agentUpdateAvailable: Bool { AgentUpdate.isNewer(latestAgentBuild, than: agentVersion) }

    private let agentControl = AgentControl(uid: getuid(), home: NSHomeDirectory(), runner: ProcessRunner())
    private var watchdog = AgentWatchdog()
    private var lastAgentCheck = Date.distantPast

    let notifier = Notifier()
    var onChange: (() -> Void)?
    var showPanel: (() -> Void)?

    private let store = SettingsStore(directory: SettingsStore.defaultDirectory)
    private var seen = Set<String>()
    /// Requests this app approved or denied, so they are not announced as
    /// "decided elsewhere" when they leave the pending list.
    private var decidedHere = Set<String>()
    private var syncing = false
    private var timer: Timer?
    private var linkStartedName = ""

    var phase: Phase { token != nil ? .signedIn : link != nil ? .linking : .signedOut }
    var notificationsBlocked: Bool { settings.notifications && notifier.blocked }
    var gateway: GatewayClient { GatewayClient(baseURL: settings.server) }

    init() {
        let (loaded, existed) = store.load()
        settings = loaded
        token = Keychain.load(server: loaded.server)
        if !existed {
            try? store.save(loaded)
            LoginItem.set(true) // first start: come back after each sign-in
        }
    }

    func start() {
        notifier.onDecision = { [weak self] id, device, approve in
            Task { await self?.decideFromNotification(id: id, device: device, approve: approve) }
        }
        notifier.onOpen = { [weak self] in self?.showPanel?() }
        notifier.onStateChange = { [weak self] in
            guard let self else { return }
            self.notificationState = self.notifier.state
            self.publish()
        }
        notifier.start()
        if settings.notifications { notifier.requestPermission() }
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.tick() }
        }
        Task { await tick() }
    }

    private func publish() {
        onChange?()
    }

    // MARK: polling

    private func tick() async {
        now = Date()
        publish()
        if Date().timeIntervalSince(lastAgentCheck) >= 10 { await checkAgent() }
        guard !syncing else { return }
        syncing = true
        defer { syncing = false }
        notifier.refresh()
        if link != nil { await pollLink() }
        else if token != nil, Date().timeIntervalSince(lastSync ?? .distantPast) >= Self.syncEvery { await sync() }
    }

    func requestSync() { lastSync = nil }

    func sync() async {
        guard let token else { return }
        let gateway = self.gateway
        do {
            if me == nil { me = try await gateway.me(token: token) }
            showIntroOnce()
            async let p = gateway.pending(token: token)
            async let d = gateway.devices(token: token)
            async let a = gateway.autonomy(token: token)
            let (newPending, newDevices, newAutonomy) = try await (p, d, a)
            let previousItems = Dictionary(pending.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let previous = Set(previousItems.keys)
            pending = newPending.sorted { $0.createdAt < $1.createdAt }
            devices = newDevices
            autonomy = newAutonomy
            error = nil
            lastSync = Date()

            // Decided elsewhere (panel, dashboard, another center) or expired:
            // the request notification goes, and a short one says where it
            // was decided ("macOS'tan onaylandı").
            let vanished = previous.subtracting(newPending.map(\.id))
            notifier.remove(Array(vanished))
            announceDecidedElsewhere(vanished.compactMap { previousItems[$0] }, token: token)

            let fresh = newPending.filter { seen.insert($0.id).inserted }
            if !fresh.isEmpty {
                if settings.notifications {
                    let names = Dictionary(newDevices.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
                    for item in fresh.prefix(5) {
                        notifier.showApproval(item, device: names[item.deviceId] ?? "bilinmeyen cihaz")
                    }
                }
                // Only the notification by default; the panel opens when asked
                // for, or when no notification can be shown.
                if settings.openPanelOnRequest || notificationsBlocked || !settings.notifications {
                    showPanel?()
                }
            }
        } catch let e as GatewayError where e.kind == .unauthorized {
            signOutLocally(message: e.message)
        } catch let e as GatewayError {
            error = e.message
        } catch {
            self.error = error.localizedDescription
        }
        publish()
    }

    private func announceDecidedElsewhere(_ items: [ApprovalRequest], token: String) {
        let others = items.filter { decidedHere.remove($0.id) == nil }
        guard settings.notifications, !others.isEmpty else { return }
        let gateway = self.gateway
        for item in others.prefix(5) {
            let device = deviceName(item.deviceId)
            let what = item.summary.isEmpty ? Texts.kindLabel(item.actionKind) : item.summary
            Task { [weak self] in
                guard let outcome = try? await gateway.outcome(token: token, id: item.id),
                      let text = Texts.decidedElsewhere(outcome) else { return }
                self?.notifier.showPlain("\(text) · \(device)", what)
            }
        }
    }

    private func showIntroOnce() {
        guard !settings.notificationIntroShown, settings.notifications else { return }
        notifier.requestPermission { [weak self] in
            self?.notifier.showPlain(Texts.notificationIntroTitle, Texts.notificationIntroText)
        }
        settings.notificationIntroShown = true
        saveSettings()
    }

    // MARK: sign in / out

    func connect(server: String, name: String) async {
        do {
            let origin = try ServerURL.normalize(server)
            let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { error = "Bu bilgisayar için bir ad girin."; return }
            if origin != settings.server {
                settings.server = origin
                saveSettings()
            }
            busy = true
            defer { busy = false }
            let start = try await gateway.linkStart(name: String(trimmed.prefix(80)))
            link = (start.requestId, start.requestSecret, start.approveUrl,
                    Date().addingTimeInterval(TimeInterval(max(60, start.expiresInSeconds))))
            error = nil
            openURL(start.approveUrl)
        } catch let e as ServerURL.Invalid {
            error = e.message
        } catch let e as GatewayError {
            error = e.message
        } catch {
            self.error = error.localizedDescription
        }
        publish()
    }

    private func pollLink() async {
        guard let current = link else { return }
        if Date() > current.deadline {
            link = nil
            error = "Tarayıcıdaki onay zaman aşımına uğradı. Yeniden oturum aç."
            publish()
            return
        }
        do {
            let result = try await gateway.linkPoll(id: current.id, secret: current.secret)
            switch result.status {
            case "approved":
                guard let center = result.centerToken else { return }
                Keychain.save(center, server: settings.server)
                token = center
                link = nil
                me = nil
                seen.removeAll()
                error = nil
                notifier.showPlain("WECOMMANDER", "Yönetim Merkezi hesabına bağlandı.")
                requestSync()
            case "denied", "expired", "consumed":
                link = nil
                error = result.status == "denied" ? "Bağlantı tarayıcıda reddedildi." : "Bağlantı isteğinin süresi doldu. Yeniden oturum aç."
            default:
                break
            }
        } catch let e as GatewayError where e.kind == .network {
            // keep waiting; the browser step can take a while
        } catch let e as GatewayError {
            link = nil
            error = e.message
        } catch {}
        publish()
    }

    func cancelLink() {
        link = nil
        publish()
    }

    func reopenLink() {
        if let url = link?.url { openURL(url) }
    }

    func signOut() async {
        if let token { try? await gateway.disconnect(token: token) }
        signOutLocally(message: nil)
    }

    private func signOutLocally(message: String?) {
        Keychain.delete(server: settings.server)
        token = nil
        me = nil
        pending = []
        devices = []
        autonomy = []
        seen.removeAll()
        decidedHere.removeAll()
        error = message
        notifier.removeAllApprovals()
        publish()
    }

    // MARK: decisions and autonomy

    func decide(id: String, approve: Bool) async throws {
        guard let token else { throw GatewayError(.unauthorized, 401, "", "Önce oturum aç.") }
        decidedHere.insert(id)
        do {
            try await gateway.decide(token: token, id: id, approve: approve)
            notifier.remove([id])
        } catch {
            decidedHere.remove(id)
            requestSync()
            throw error
        }
        requestSync()
    }

    private func decideFromNotification(id: String, device: String, approve: Bool) async {
        do {
            try await decide(id: id, approve: approve)
            notifier.showPlain("WECOMMANDER", "\(device) · \(approve ? "onaylandı, yapay zekâ bir kez çalıştırabilir" : "reddedildi")")
        } catch let e as GatewayError {
            notifier.showPlain("WECOMMANDER", e.message)
        } catch {
            notifier.showPlain("WECOMMANDER", error.localizedDescription)
        }
    }

    func startAutonomy(choice: Int, deviceIds: [String]?, password: String) async throws {
        guard let token else { return }
        let minutes = Durations.minutes(forChoice: choice, now: Date())
        try await gateway.setAutonomy(token: token, enable: true, minutes: minutes, deviceIds: deviceIds, password: password)
        requestSync()
    }

    func stopAutonomy() async throws {
        guard let token else { return }
        try await gateway.setAutonomy(token: token, enable: false, minutes: nil, deviceIds: nil, password: nil)
        requestSync()
    }

    // MARK: the agent on this Mac

    /// Reads the agent's state and, while "Ajan çalışsın" is on, starts it
    /// again when it stopped; says so in a notification.
    private func checkAgent() async {
        guard !agentBusy else { return }
        lastAgentCheck = Date()
        let status = await agentControl.status()
        var changed = status != agent
        agent = status
        if status.state != .notInstalled && Date().timeIntervalSince(lastVersionCheck) >= 300 {
            lastVersionCheck = Date()
            let version = await agentControl.installedVersion()
            if version != agentVersion { agentVersion = version; changed = true }
        }
        if status.state != .notInstalled && Date().timeIntervalSince(lastReleaseCheck) >= 6 * 3600 {
            lastReleaseCheck = Date()
            var request = URLRequest(url: AgentUpdate.releasesURL, timeoutInterval: 20)
            request.setValue("WECOMMANDER-Center", forHTTPHeaderField: "User-Agent")
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            if let (data, response) = try? await URLSession.shared.data(for: request),
               (response as? HTTPURLResponse)?.statusCode == 200,
               let latest = AgentUpdate.latestMacBuild(data) {
                if latest != latestAgentBuild { latestAgentBuild = latest; changed = true }
            } else {
                lastReleaseCheck = Date().addingTimeInterval(-5 * 3600) // retry in an hour
            }
            if agentUpdateAvailable, announcedBuild != latestAgentBuild, let latest = latestAgentBuild {
                announcedBuild = latest
                notifier.showPlain("WECOMMANDER", "Ajan için yeni sürüm var (0.1.\(latest)). Yönetim Merkezinde \"Ajanı güncelle\" ile kurabilirsin.")
            }
        }
        switch watchdog.next(keepRunning: settings.agentKeepRunning && status.enabled, status: status, now: Date()) {
        case .start:
            do {
                try await agentControl.setEnabled(true)
                agent = await agentControl.status()
                if agent?.running == true { notifier.showPlain("WECOMMANDER", Texts.agentRestarted) }
            } catch {}
            publish()
        case .giveUp:
            notifier.showPlain("WECOMMANDER", Texts.agentGaveUp)
        case .none:
            if changed { publish() }
        }
    }

    /// Opens Terminal with the official agent installer (it asks for the
    /// administrator password there).
    func updateAgent() {
        Task { await runAgentInstaller() }
    }

    private func runAgentInstaller() async {
        // Installing a new agent while signed in: pair it with this account
        // through a one-time code, no second browser sign-in.
        var raw = AgentControl.updateCommand(server: settings.server)
        var installing = false
        if agent?.state == .notInstalled, let token,
           let code = try? await gateway.pairingCode(token: token),
           let file = try? AgentControl.writePairingCodeFile(code) {
            raw = AgentControl.installCommand(server: settings.server, pairingCodeFile: file)
            installing = true
        }
        // "&& exit" closes the Terminal session when the installer succeeds
        // (on failure it stays open so the reason can be read).
        let command = (raw + " && exit")
            .replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let script = "tell application \"Terminal\"\nactivate\ndo script \"\(command)\"\nend tell"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]
        do {
            try process.run()
            lastVersionCheck = .distantPast
            notifier.showPlain("WECOMMANDER", installing ? Texts.agentInstallStarted : Texts.agentUpdateStarted)
        } catch {
            self.error = error.localizedDescription
            publish()
        }
    }

    /// "Ajan çalışsın" in the panel and the menu.
    func setAgentEnabled(_ on: Bool) async {
        guard !agentBusy else { return }
        agentBusy = true
        publish()
        defer {
            agentBusy = false
            lastAgentCheck = Date()
            publish()
        }
        do {
            try await agentControl.setEnabled(on)
            settings.agentKeepRunning = on
            saveSettings()
            watchdog.reset()
            for _ in 0..<10 {
                agent = await agentControl.status()
                if agent?.running == on { break }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: settings and helpers

    func update(_ change: (inout CenterSettings) -> Void) {
        change(&settings)
        saveSettings()
        if settings.notifications { notifier.requestPermission() }
        publish()
    }

    private func saveSettings() {
        try? store.save(settings)
    }

    func sendTestNotification() {
        notifier.requestPermission { [weak self] in
            self?.notifier.showPlain(Texts.notificationTestTitle, Texts.notificationTestText)
        }
    }

    func openDashboard() { openURL(settings.server + "/approvals") }

    func openURL(_ text: String) {
        if let url = URL(string: text) { NSWorkspace.shared.open(url) }
    }

    func deviceName(_ id: String) -> String {
        devices.first { $0.id == id }?.name ?? "bilinmeyen cihaz"
    }
}
