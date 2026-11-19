import CenterCore
import Foundation
import SwiftUI

/// The core calls of the connector through the Servers model (the core can restart, e.g. on a language change).
struct ServersConnectorCore: ConnectorCore {
    let servers: ServersModel

    func call(_ method: String, _ params: [String: Any]) async throws -> Any? {
        try await servers.coreCallRaw(method, params)
    }
}

/// "SSH ile, kurulum yok" (Hybrid Access H3) on the Mac: while signed in, a
/// background loop (CenterCore RemoteConnector) publishes the saved SSH
/// hosts shared with remote AI and runs the calls Claude/ChatGPT make
/// through wecommander.app in wecommander-core. It stops on sign-out and
/// starts again when the account or server changes. Approvals are never
/// given here: they come from the person's click on the approval
/// notification or the web panel (AppModel lists them like any other).
@MainActor
final class RemoteConnectorModel: ObservableObject {
    @Published private(set) var status = ConnectorStatus()

    private weak var app: AppModel?
    private weak var servers: ServersModel?
    private var task: Task<Void, Never>?
    private var token: String?
    private var server: String?
    private var timer: Timer?
    /// Status updates of a stopped loop are dropped.
    private var generation = 0

    init(app: AppModel, servers: ServersModel) {
        self.app = app
        self.servers = servers
    }

    var signedIn: Bool { app?.token != nil }
    var centerId: String? { app?.me?.centerId }

    /// Checks every two seconds whether the loop should run (signed in) and for which account.
    func start() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.ensure() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        ensure()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        stopLoop()
    }

    private func ensure() {
        let current = app?.token
        let base = app?.settings.server
        if task != nil, current == token, base == server { return }
        if task == nil, current == nil { return } // signed out and already stopped
        stopLoop()
        guard let current, let app, let servers else { return }
        let connector = RemoteConnector(core: ServersConnectorCore(servers: servers))
        let transport = GatewayConnectorTransport(gateway: app.gateway, token: current)
        token = current
        server = base
        generation += 1
        let mine = generation
        task = Task.detached { [weak self, weak app] in
            await connector.observe { status in
                Task { @MainActor [weak self] in
                    if self?.generation == mine { self?.status = status }
                }
            }
            await connector.run(transport, centerId: { await MainActor.run { app?.me?.centerId } })
        }
    }

    private func stopLoop() {
        generation += 1
        task?.cancel()
        task = nil
        token = nil
        server = nil
        status = ConnectorStatus()
    }
}

/// Main window → "Yapay zekâ erişimi": which saved SSH hosts remote AI
/// (Claude.ai, ChatGPT) may use through this Mac, how much it may do and
/// whether sudo is allowed, with the same explanations as the Windows host
/// editor, and the connector's status.
struct AiAccessPage: View {
    @ObservedObject var model: ServersModel
    @ObservedObject var connector: RemoteConnectorModel

    var body: some View {
        Form {
            Section(AiAccessText.connectorTitle) {
                Text(AiAccessText.connectorExplain).font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ConnectorStatusView(model: model, connector: connector)
            }
            Section {
                Text(AiAccessText.header).font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(AiAccessText.remoteTitle).font(.callout.weight(.semibold))
                    Text(AiAccessText.remoteHelp).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if model.remoteAiSupported != false {
                        Text(AiAccessText.remoteThisComputerHelp).font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(AiAccessText.connectorHeader).font(.callout.weight(.semibold))
                    Label(AiAccessText.connectorThisTitle, icon: .check, active: true).font(.callout)
                    Text(AiAccessText.connectorThisHelp).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(AiAccessText.connectorAlwaysTitle).font(.callout).foregroundStyle(.tertiary)
                    Text(AiAccessText.connectorAlwaysHelp).font(.caption).foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if model.remoteAiSupported == false {
                    Text(AiAccessText.remoteNotYet).font(.callout).foregroundStyle(.orange)
                } else if !connector.signedIn {
                    Text(AiAccessText.remoteNeedsSignIn).font(.callout).foregroundStyle(.orange)
                }
            }
            Section(L.t("Sunucular")) {
                let ssh = model.hosts.sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
                if ssh.isEmpty {
                    Text(L.t("Henüz sunucu yok")).foregroundStyle(.secondary)
                }
                ForEach(ssh) { host in
                    AiHostRow(model: model, host: host, centerId: connector.centerId,
                              canTurnOn: connector.signedIn && model.remoteAiSupported != false)
                }
            }
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(AiAccessText.guaranteesTitle).font(.callout.weight(.semibold))
                    ForEach(AiAccessText.guarantees, id: \.self) { line in
                        HStack(alignment: .top, spacing: 8) {
                            WCIcon(.lock, size: 12).padding(.top, 2)
                            Text(line).font(.callout).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Label(AiAccessText.limitTitle, icon: .warning).font(.callout.weight(.semibold)).foregroundStyle(.orange)
                    Text(AiAccessText.sshLimit).font(.caption).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(AiAccessText.sectionTitle)
        .task { await model.refreshRemoteAiSupport() }
    }
}

/// "Bağlı · 2 sunucu…", the last answer from wecommander.app, the last call and the last error.
private struct ConnectorStatusView: View {
    @ObservedObject var model: ServersModel
    @ObservedObject var connector: RemoteConnectorModel

    var body: some View {
        let s = connector.status
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(color(s)).frame(width: 8, height: 8)
                Text(AiAccessText.state(s, signedIn: connector.signedIn)).font(.callout)
            }
            if let contact = s.lastContact {
                Text(L.f("Son bağlantı: {0}", contact.formatted(date: .omitted, time: .standard)))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let call = s.lastCall {
                let name = model.hosts.first { $0.id == call.hostId }?.label ?? call.hostId
                Text(AiAccessText.lastCall(call, hostName: name) + " · " + call.at.formatted(date: .omitted, time: .shortened))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = s.lastError, s.state == .retrying {
                Text(L.f("Son hata: {0}", error)).font(.caption).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func color(_ s: ConnectorStatus) -> Color {
        guard connector.signedIn else { return .secondary }
        switch s.state {
        case .connected: return .green
        case .retrying: return .orange
        case .idle, .stopped: return .secondary
        }
    }
}

/// One saved host: share it with remote AI or not, what the AI may do, sudo.
/// Each change is saved at once (`hosts.setAiAccess`); the core checks it again.
private struct AiHostRow: View {
    @ObservedObject var model: ServersModel
    let host: CoreHost
    let centerId: String?
    let canTurnOn: Bool
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        let stored = AiAccessRules.of(host)
        let blockers = AiAccessRules.blockers(host)
        let otherComputer = stored.remote && !AiAccessRules.servedHere(stored, centerId: centerId)
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(get: { stored.remote }, set: { on in save { $0.remote = on } })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(host.label).font(.body.weight(.semibold))
                    Text(host.target).font(.caption).foregroundStyle(.secondary)
                }
            }
            .toggleStyle(.switch)
            .disabled(saving || (!stored.remote && (!blockers.isEmpty || !canTurnOn)))
            if !stored.remote, !blockers.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(AiAccessText.blockedTitle).font(.caption.weight(.semibold))
                    ForEach(blockers.indices, id: \.self) { i in
                        let blocker = blockers[i]
                        HStack(alignment: .top) {
                            Text(AiAccessText.blockerText(blocker)).font(.caption)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 8)
                            // Connecting once approves the host key and offers to save the login.
                            if blocker != .notSsh {
                                Button(AiAccessText.blockerFix(blocker)) { model.open(host) }.controlSize(.small)
                            }
                        }
                    }
                }
                .padding(8)
                .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
            }
            if otherComputer {
                Text(AiAccessText.remoteOtherComputer).font(.caption).italic()
            }
            if stored.remote {
                presetPicker(stored)
                sudoPicker(stored)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func presetPicker(_ stored: AiAccess) -> some View {
        // Timed autonomy is local only; it is kept when set elsewhere, not offered here.
        let choices = stored.preset == AiAccess.timed ? AiAccess.presets : [AiAccess.readOnly, AiAccess.approval]
        VStack(alignment: .leading, spacing: 4) {
            Picker(AiAccessText.presetHeader, selection: Binding(get: { stored.preset }, set: { p in save { $0.preset = p } })) {
                ForEach(choices, id: \.self) { Text(AiAccessText.presetTitle($0)).tag($0) }
            }
            .pickerStyle(.radioGroup)
            .disabled(saving)
            Text(AiAccessText.presetHelp(stored.preset)).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if stored.preset == AiAccess.timed {
                if let until = stored.timedUntilDate, until > Date() {
                    Text(AiAccessText.timedEnds(until)).font(.caption).foregroundStyle(.secondary)
                }
                Text(AiAccessText.timedRemoteNote).font(.caption).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.leading, 12)
    }

    private func sudoPicker(_ stored: AiAccess) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Picker(AiAccessText.sudoHeader, selection: Binding(get: { stored.sudo }, set: { s in save { $0.sudo = s } })) {
                ForEach(AiAccess.sudoModes, id: \.self) { Text(AiAccessText.sudoTitle($0)).tag($0) }
            }
            .pickerStyle(.radioGroup)
            .disabled(saving)
            Text(AiAccessText.sudoHelp(stored.sudo)).font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 12)
    }

    /// The stored access with one change, saved; local MCP and its timed preset stay as they are.
    private func save(_ change: (inout AiAccess) -> Void) {
        let stored = AiAccessRules.normalize(AiAccessRules.of(host))
        var next = stored
        change(&next)
        next.connector = AiAccessRules.connectorFor(stored, remote: next.remote, centerId: centerId)
        // A timed preset that already ended counts as approval again.
        if next.preset == AiAccess.timed, (next.timedUntilDate ?? .distantPast) <= Date() { next.preset = AiAccess.approval }
        next = AiAccessRules.normalize(next)
        guard next != stored else { return }
        saving = true
        Task {
            do {
                try await model.setAiAccess(host, next)
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }
}
