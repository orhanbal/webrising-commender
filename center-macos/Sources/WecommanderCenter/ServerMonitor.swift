import AppKit
import CenterCore
import Combine

/// One watched server: its own connection (no terminal) and the latest numbers.
struct WatchedServer: Identifiable, Equatable {
    let id: String // host id
    var label: String
    var monitorId: String?
    var last: ServerSample?
    var reading = MonitorReading()
    /// CPU history for the small chart (newest last).
    var cpuHistory: [Double] = []
    var error: String?
    var nextTry = Date.distantPast
    var live: Bool { monitorId != nil && last != nil && error == nil }
}

/// Watches the servers chosen for the menu bar: a sample every three seconds,
/// reconnecting when a connection drops. Like the Windows taskbar monitor.
@MainActor
final class ServerMonitor: ObservableObject {
    @Published private(set) var servers: [WatchedServer] = []
    var onChange: (() -> Void)?

    private let model: ServersModel
    private let app: AppModel
    private var timer: Timer?
    private var busy = Set<String>()
    private var hostsWatch: AnyCancellable?

    init(model: ServersModel, app: AppModel) {
        self.model = model
        self.app = app
    }

    func start() {
        servers = app.settings.watchedHosts.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
            .map { WatchedServer(id: $0, label: L.t("Sunucu")) }
        hostsWatch = model.$hosts.receive(on: RunLoop.main).sink { [weak self] hosts in
            self?.hostsChanged(hosts)
        }
        schedule()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        for s in servers { close(s.id) }
    }

    func isWatched(_ hostId: String) -> Bool { servers.contains { $0.id == hostId } }

    func watch(_ host: CoreHost) {
        guard !isWatched(host.id) else { return }
        servers.append(WatchedServer(id: host.id, label: host.label))
        save()
        schedule()
        Task { await tick() }
    }

    func unwatch(_ hostId: String) {
        close(hostId)
        servers.removeAll { $0.id == hostId }
        save()
        schedule()
        changed()
    }

    private func save() {
        let ids = servers.map(\.id)
        app.update { $0.watchChosen = true; $0.watchedHosts = ids }
    }

    private func schedule() {
        if servers.isEmpty { timer?.invalidate(); timer = nil; return }
        guard timer == nil else { return }
        let t = Timer(timeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in await self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func hostsChanged(_ hosts: [CoreHost]) {
        guard !hosts.isEmpty else { return }
        var gone: [String] = []
        for i in servers.indices {
            if let h = hosts.first(where: { $0.id == servers[i].id }) { servers[i].label = h.label } else { gone.append(servers[i].id) }
        }
        for id in gone { close(id); servers.removeAll { $0.id == id } } // deleted host
        if !gone.isEmpty { save() }
        // Nothing chosen yet: watch the first servers that connect without asking.
        if !app.settings.watchChosen && servers.isEmpty {
            let ids = MonitorMath.defaultWatch(hosts)
            if !ids.isEmpty {
                servers = ids.compactMap { id in hosts.first { $0.id == id }.map { WatchedServer(id: id, label: $0.label) } }
                save()
            }
        }
        schedule()
        changed()
        Task { await tick() }
    }

    private func close(_ hostId: String) {
        guard let i = servers.firstIndex(where: { $0.id == hostId }), let id = servers[i].monitorId else { return }
        servers[i].monitorId = nil
        servers[i].last = nil
        Task { [model] in try? await model.coreCall("monitor.close", ["monitorId": id]) }
    }

    private func tick() async {
        for id in servers.map(\.id) where !busy.contains(id) {
            busy.insert(id)
            await step(id)
            busy.remove(id)
        }
        changed()
    }

    private func step(_ hostId: String) async {
        guard let s = servers.first(where: { $0.id == hostId }) else { return }
        var monitorId = s.monitorId
        if monitorId == nil {
            guard Date() >= s.nextTry else { return }
            do {
                let opened = try await model.coreCall("monitor.open", ["hostId": hostId], as: String.self)
                monitorId = opened
                update(hostId) { $0.monitorId = opened; $0.error = nil }
            } catch {
                update(hostId) { $0.error = error.localizedDescription; $0.nextTry = Date().addingTimeInterval(30) }
                return
            }
        }
        guard let monitorId else { return }
        do {
            let now = try await model.coreCall("server.sample", ["sessionId": monitorId], as: ServerSample.self)
            update(hostId) { w in
                let hadPrevious = w.last != nil
                w.reading = MonitorMath.reading(previous: w.last, now: now, last: w.reading)
                if hadPrevious {
                    w.cpuHistory.append(w.reading.cpu)
                    if w.cpuHistory.count > 40 { w.cpuHistory.removeFirst(w.cpuHistory.count - 40) }
                }
                w.last = now
                w.error = nil
            }
        } catch {
            close(hostId)
            update(hostId) { $0.error = L.t("Bağlantı koptu; yeniden bağlanılıyor."); $0.nextTry = Date().addingTimeInterval(5) }
        }
    }

    private func update(_ hostId: String, _ change: (inout WatchedServer) -> Void) {
        guard let i = servers.firstIndex(where: { $0.id == hostId }) else { return } // unwatched meanwhile
        change(&servers[i])
    }

    private func changed() { onChange?() }

    /// The menu bar text: the worst live server, e.g. "▲ 42%".
    var summary: (text: String, worst: Double)? {
        let live = servers.filter(\.live)
        guard !servers.isEmpty else { return nil }
        guard let worst = live.map(\.reading.worst).max() else { return ("…", 0) }
        return (Percent.text(worst), worst)
    }
}
