import AppKit
import CenterCore
import Charts
import SwiftUI

// Server management for one SSH terminal: overview, what fills the disk,
// safe cleanup, processes and zombies (the Windows app's ServerWindow).
// Everything runs over the terminal's own connection; nothing is installed
// on the server. Changes always show the exact command and ask first, and
// are off when the login is neither root nor passwordless sudo.

// MARK: - windows

/// One server management window per terminal; closing it stops the live sampling.
@MainActor
enum ServerWindows {
    private static var open: [String: (window: NSWindow, model: ServerManagementModel, delegate: ServerWindowDelegate)] = [:]

    /// Shows the window of `session` (a new one the first time), optionally on one page.
    static func show(_ servers: ServersModel, session: TerminalSession, page: ServerManagementModel.Page? = nil) {
        if let entry = open[session.id] {
            if let page { entry.model.go(page) }
            entry.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let model = ServerManagementModel(servers: servers, sessionId: session.id, label: session.host.label)
        let window = NSWindow(contentViewController: NSHostingController(rootView: ServerManagementView(model: model)))
        window.title = L.f("Sunucu yönetimi — {0}", session.host.label)
        window.setContentSize(NSSize(width: 1060, height: 780))
        window.toolbarStyle = .unified
        window.isReleasedWhenClosed = false
        let id = session.id
        let delegate = ServerWindowDelegate { ServerWindows.closed(id) }
        window.delegate = delegate
        open[id] = (window, model, delegate)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        model.go(page ?? .overview)
    }

    /// Closes the window of a terminal that was closed.
    static func close(_ sessionId: String) {
        open[sessionId]?.window.close()
    }

    fileprivate static func closed(_ sessionId: String) {
        guard let entry = open.removeValue(forKey: sessionId) else { return }
        entry.model.stop()
        entry.window.delegate = nil
    }
}

@MainActor
final class ServerWindowDelegate: NSObject, NSWindowDelegate {
    private let onClose: @MainActor () -> Void
    init(onClose: @escaping @MainActor () -> Void) { self.onClose = onClose }
    func windowWillClose(_ notification: Notification) { onClose() }
}

// MARK: - model

@MainActor
final class ServerManagementModel: ObservableObject {
    enum Page: String, CaseIterable, Identifiable {
        case overview, disk, cleanup, processes
        var id: String { rawValue }
        var title: String {
            switch self {
            case .overview: return L.t("Genel bakış")
            case .disk: return L.t("Disk")
            case .cleanup: return L.t("Temizlik")
            case .processes: return L.t("Süreçler")
            }
        }
        var symbol: String {
            switch self {
            case .overview: return "gauge.medium"
            case .disk: return "internaldrive"
            case .cleanup: return "sparkles"
            case .processes: return "list.bullet.rectangle"
            }
        }
    }

    enum Kind { case info, success, warning, error }

    struct Message: Equatable {
        let text: String
        let kind: Kind
    }

    /// A change waiting for the person's yes: what it does and the exact command.
    struct Confirmation: Identifiable {
        let id = UUID()
        let title: String
        let text: String
        var warning = ""
        let command: String
        let primary: String
        var destructive = true
        let run: @MainActor () async -> Void

        var message: String {
            var parts = [text]
            if !warning.isEmpty { parts.append(L.f("Dikkat: {0}", warning)) }
            parts.append(L.t("Sunucuda çalışacak komut:") + "\n" + command)
            return parts.joined(separator: "\n\n")
        }
    }

    struct TokenRequest: Identifiable {
        let id = UUID()
        let why: String
        let zombie: ZombieGroup
    }

    struct LivePoint: Identifiable, Equatable {
        let id: Int
        let value: Double
    }

    /// One live chart: the last 45 samples and what the newest one means.
    struct LiveSeries: Equatable {
        static let capacity = 45
        var points: [LivePoint] = []
        var detail = ""
        var latest: Double? { points.last?.value }

        mutating func push(_ value: Double, _ detail: String, _ index: Int) {
            points.append(LivePoint(id: index, value: value))
            if points.count > Self.capacity { points.removeFirst(points.count - Self.capacity) }
            self.detail = detail
        }
    }

    /// A cleanup running: each item waiting, working, done or failed.
    struct CleanupRun: Equatable {
        enum State { case waiting, working, done, failed }
        struct Row: Identifiable, Equatable {
            let item: CleanupItem
            var state: State
            var note: String
            var id: String { item.id }
        }
        var rows: [Row]
        var step: String
        var doneKb: UInt64 = 0
        let totalKb: UInt64
        let diskBefore: Double?
        var diskNow: Double?
        var finished = false
        var percent: Double { totalKb == 0 ? 0 : min(100, Double(doneKb) * 100 / Double(totalKb)) }
    }

    let sessionId: String
    let label: String
    private weak var servers: ServersModel?

    @Published private(set) var page: Page? = .overview
    @Published private(set) var overview: ServerOverview?
    @Published private(set) var disk: DiskUsage?
    @Published private(set) var diskPath = "/"
    @Published private(set) var diskProgress: Double?
    @Published private(set) var cleanup: CleanupScan?
    @Published private(set) var chosen: Set<String> = []
    @Published private(set) var processes: ProcessList?
    @Published var processFilter = ""
    @Published var processByMemory = false
    @Published private(set) var waiting: String?
    @Published private(set) var waitingSince = Date()
    @Published var message: Message?
    @Published var confirmation: Confirmation?
    @Published var tokenRequest: TokenRequest?
    @Published private(set) var cpu = LiveSeries()
    @Published private(set) var mem = LiveSeries()
    @Published private(set) var net = LiveSeries()
    @Published private(set) var io = LiveSeries()
    @Published private(set) var run: CleanupRun?

    private var generation = 0
    private var liveTask: Task<Void, Never>?
    private var liveStopped = false
    private var sampleIndex = 0

    init(servers: ServersModel, sessionId: String, label: String) {
        self.servers = servers
        self.sessionId = sessionId
        self.label = label
    }

    var isRunning: Bool { run.map { !$0.finished } ?? false }

    // MARK: navigation

    func go(_ page: Page) {
        guard !isRunning else { return }
        self.page = page
        load()
    }

    func openDisk(_ path: String) {
        diskPath = path
        go(.disk)
    }

    func diskUp() {
        guard let u = disk else { return }
        openDisk(DiskPaths.parent(u.path))
    }

    /// The window closed: no more sampling or late updates.
    func stop() {
        generation += 1
        liveTask?.cancel()
        liveTask = nil
    }

    /// (Re)reads the current page.
    func load() {
        guard !isRunning else { return }
        generation += 1
        let gen = generation
        liveTask?.cancel()
        liveTask = nil
        message = nil
        run = nil
        let page = self.page ?? .overview
        switch page {
        case .overview: overview = nil; waiting = L.t("Sunucu bilgileri okunuyor…")
        case .disk: disk = nil; waiting = L.f("{0} taranıyor", diskPath)
        case .cleanup: cleanup = nil; waiting = L.t("Silinebilecek dosyalar hesaplanıyor…")
        case .processes: processes = nil; waiting = L.t("Süreçler okunuyor…")
        }
        waitingSince = Date()
        diskProgress = nil
        Task { await fetch(page, gen) }
    }

    private func fetch(_ page: Page, _ gen: Int) async {
        do {
            switch page {
            case .overview:
                let o = try await call("server.overview", as: ServerOverview.self)
                guard gen == generation else { return }
                overview = o
                startLive(gen)
            case .disk:
                let id = UUID().uuidString
                servers?.progress[id] = { [weak self] done, total in
                    guard let self, total > 0, gen == self.generation else { return }
                    self.diskProgress = min(100, Double(done) * 100 / Double(total))
                }
                defer { servers?.progress.removeValue(forKey: id) }
                let u = try await call("server.disk", ["path": diskPath, "transferId": id], as: DiskUsage.self)
                guard gen == generation else { return }
                disk = u
            case .cleanup:
                let scan = try await call("server.cleanupScan", as: CleanupScan.self)
                guard gen == generation else { return }
                cleanup = scan
                chosen = scan.defaultChoice()
            case .processes:
                let list = try await call("server.processes", as: ProcessList.self)
                guard gen == generation else { return }
                processes = list
            }
            waiting = nil
        } catch {
            guard gen == generation else { return }
            waiting = nil
            show(friendly(error), .error)
        }
    }

    func show(_ text: String, _ kind: Kind) { message = Message(text: text, kind: kind) }

    func friendly(_ error: Error) -> String {
        isTerminalClosed(error) ? L.t("Bu sunucunun terminali kapandı. Sunucu yönetimi için yeniden bağlan.") : error.localizedDescription
    }

    private func isTerminalClosed(_ error: Error) -> Bool {
        if let failure = error as? CoreClient.Failure, case .core(let text) = failure { return text == "terminal closed" }
        return false
    }

    private func call<T: Decodable>(_ method: String, _ extra: [String: Any] = [:], as type: T.Type) async throws -> T {
        guard let servers else { throw CoreClient.Failure.stopped }
        var params = extra
        params["sessionId"] = sessionId
        return try await servers.coreCall(method, params, as: type)
    }

    private func call(_ method: String, _ extra: [String: Any] = [:]) async throws {
        guard let servers else { throw CoreClient.Failure.stopped }
        var params = extra
        params["sessionId"] = sessionId
        try await servers.coreCall(method, params)
    }

    // MARK: live

    private func startLive(_ gen: Int) {
        liveTask?.cancel()
        liveStopped = false
        cpu = LiveSeries(); mem = LiveSeries(); net = LiveSeries(); io = LiveSeries()
        liveTask = Task { [weak self] in
            var last: ServerSample?
            while !Task.isCancelled {
                guard let model = self, gen == model.generation, !model.liveStopped else { return }
                if let now = await model.sample(after: last, gen) { last = now }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    /// One sample: memory right away, CPU, network and disk as rates since the last one.
    private func sample(after last: ServerSample?, _ gen: Int) async -> ServerSample? {
        do {
            let now = try await call("server.sample", as: ServerSample.self)
            guard gen == generation else { return nil }
            sampleIndex += 1
            mem.push(now.memPercent, L.f("{0} kullanımda", Sizes.kb(now.memUsedKb)), sampleIndex)
            if let last, let r = ServerRates.between(last, now) {
                cpu.push(r.cpuPercent, L.f("yük {0}", Sizes.number(now.load1, digits: 2)), sampleIndex)
                net.push(r.netRx + r.netTx, "↓ " + Sizes.rate(r.netRx) + "  ↑ " + Sizes.rate(r.netTx), sampleIndex)
                io.push(r.diskRead + r.diskWrite, L.f("okuma {0}  yazma {1}", Sizes.rate(r.diskRead), Sizes.rate(r.diskWrite)), sampleIndex)
            }
            return now
        } catch {
            // A missed sample is skipped; a closed terminal ends the sampling.
            if isTerminalClosed(error), gen == generation {
                liveStopped = true
                show(friendly(error), .error)
            }
            return nil
        }
    }

    // MARK: cleanup

    func isChosen(_ id: String) -> Bool { chosen.contains(id) }

    func choose(_ id: String, _ on: Bool) {
        guard let scan = cleanup else { return }
        chosen = scan.choose(id, on, in: chosen)
    }

    var chosenItems: [CleanupItem] {
        guard let scan = cleanup else { return [] }
        return scan.items.filter { chosen.contains($0.id) && scan.allowed($0) && $0.kb > 0 }
    }

    func askCleanup() {
        let items = chosenItems
        if items.isEmpty { show(L.t("Temizlenecek bir şey seçilmedi."), .info); return }
        let total = items.reduce(UInt64(0)) { $0 &+ $1.kb }
        confirmation = Confirmation(
            title: L.t("Temizlik"),
            text: L.f("{0} kalem silinecek; yaklaşık {1} yer açılacak. Geri alınamaz.", items.count, Sizes.kb(total)),
            warning: items.map(\.warning).filter { !$0.isEmpty }.joined(separator: " "),
            command: items.map(\.command).joined(separator: "\n"),
            primary: L.t("Temizle")
        ) { [weak self] in await self?.runCleanup(items) }
    }

    /// Cleans the chosen items one by one and shows it happening: the space
    /// freed, the disk going down, and each item waiting, working, done or failed.
    private func runCleanup(_ items: [CleanupItem]) async {
        generation += 1
        let gen = generation
        liveTask?.cancel()
        message = nil
        let total = items.reduce(UInt64(0)) { $0 &+ $1.kb }
        run = CleanupRun(rows: items.map { CleanupRun.Row(item: $0, state: .waiting, note: L.t("Sırada")) },
                         step: L.t("Başlıyor…"), totalKb: total, diskBefore: nil, diskNow: nil)
        let root = await rootDisk()
        let before = root?.availKb
        let size = root?.usableKb ?? 0
        func used(_ free: UInt64) -> Double { Double(size > free ? size - free : 0) * 100 / Double(max(size, 1)) }
        if let before, size > 0 {
            run = CleanupRun(rows: run?.rows ?? [], step: run?.step ?? "", totalKb: total, diskBefore: used(before), diskNow: used(before))
        }
        var results: [CleanupResult] = []
        for (i, item) in items.enumerated() {
            run?.rows[i].state = .working
            run?.rows[i].note = L.t("Temizleniyor…")
            run?.step = String(i + 1) + "/" + String(items.count) + " · " + item.title
            let result: CleanupResult
            do {
                let one = try await call("server.cleanupRun", ["ids": [item.id]], as: [CleanupResult].self)
                result = one.first ?? CleanupResult(id: item.id, ok: false, message: L.t("yanıt yok"))
            } catch {
                result = CleanupResult(id: item.id, ok: false, message: friendly(error))
            }
            results.append(result)
            run?.rows[i].state = result.ok ? .done : .failed
            run?.rows[i].note = result.ok ? L.t("Temizlendi") : L.t("Temizlenemedi") + (result.message.isEmpty ? "" : ": " + result.message)
            run?.doneKb &+= item.kb
            run?.step = i + 1 < items.count ? L.f("{0}/{1} tamam", i + 1, items.count) : L.t("Bitti")
            // The disk going down as it happens.
            if size > 0, let free = await rootDisk()?.availKb { run?.diskNow = used(free) }
        }
        run?.finished = true
        let after = await rootDisk()?.availKb
        let failed = results.filter { !$0.ok }
        // Measured again after the cleanup, against the estimate.
        let measured = CleanupLayout.freed(total, before, after)
        let freed = measured.isEmpty ? "" : " " + measured
        let done: Message
        if failed.isEmpty {
            done = Message(text: L.t("Temizlik tamamlandı.") + freed, kind: .success)
        } else {
            let names = failed.map { f in
                (items.first { $0.id == f.id }?.title ?? f.id) + (f.message.isEmpty ? "" : " (" + f.message + ")")
            }
            done = Message(text: L.f("Bazı kalemler temizlenemedi: {0}.", names.joined(separator: "; ")) + freed, kind: .warning)
        }
        message = done
        // The finished list stays a moment, then the new scan.
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard gen == generation else { return }
        load()
        message = done
    }

    /// The root disk now (for the disk bar and "N GB freed").
    private func rootDisk() async -> ServerDisk? {
        let o = try? await call("server.overview", as: ServerOverview.self)
        return o?.disks.first { $0.mount == "/" }
    }

    // MARK: processes

    func askSignal(_ p: ServerProcess, kill: Bool) {
        let action = kill ? "kill" : "term"
        confirmation = Confirmation(
            title: kill ? L.f("{0} zorla durdurulsun mı?", p.name) : L.f("{0} sonlandırılsın mı?", p.name),
            text: kill
                ? L.t("Süreç anında durdurulur (SIGKILL); kaydedilmemiş işleri kaybolur. Önce kibarca sonlandırmayı dene.")
                : L.t("Sürece kapanması söylenir (SIGTERM); program açık işlerini bitirip kapanır. Bir servisin parçasıysa servis onu yeniden başlatabilir."),
            command: p.signalCommand(action),
            primary: kill ? L.t("Zorla durdur") : L.t("Sonlandır")
        ) { [weak self] in await self?.signal(p, action, confirmDatabase: false) }
    }

    private func signal(_ p: ServerProcess, _ action: String, confirmDatabase: Bool, then: (@MainActor () async -> Void)? = nil) async {
        do {
            try await call("server.signal", ["pid": Int(p.pid), "name": p.name, "action": action, "confirmDatabase": confirmDatabase])
            if let then { await then(); return }
            try? await Task.sleep(nanoseconds: 800_000_000)
            load()
            show(action == "kill" ? L.f("{0} durduruldu.", p.name) : L.f("{0} için kapanma isteği gönderildi.", p.name), .success)
        } catch CoreClient.Failure.core(let text) where text == "database" && !confirmDatabase {
            confirmation = Confirmation(
                title: L.t("Bu bir veritabanı"),
                text: L.f("{0} bir veritabanı. Durdurulursa yazılmakta olan veriler kaybolabilir ve ona bağlı uygulamalar hata verir. Yine de devam edilsin mi?", p.name),
                command: p.signalCommand(action),
                primary: L.t("Yine de durdur")
            ) { [weak self] in await self?.signal(p, action, confirmDatabase: true, then: then) }
        } catch {
            show(friendly(error), .error)
        }
    }

    func askReap(_ z: ZombieGroup) {
        confirmation = Confirmation(
            title: L.t("Zombileri toplamasını iste"),
            text: L.f("{0} sürecine SIGCHLD gönderilir: \"bitmiş alt süreçlerin var, topla\" demektir. Süreci durdurmaz, zararsızdır.", z.parent.name),
            command: z.parent.signalCommand("reap"),
            primary: L.t("Gönder"),
            destructive: false
        ) { [weak self] in
            await self?.signal(z.parent, "reap", confirmDatabase: false) { await self?.afterReap(z) }
        }
    }

    private func afterReap(_ z: ZombieGroup) async {
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        do {
            let list = try await call("server.processes", as: ProcessList.self)
            processes = list
            let now = list.zombies.first { $0.parent.pid == z.parent.pid }?.count ?? 0
            let before = z.count
            if now == 0 {
                show(L.t("Zombilerin hepsi toplandı."), .success)
            } else if now < before {
                show(L.f("{0} zombi toplandı; {1} kaldı.", before - now, now), .warning)
            } else {
                show(L.t("Süreç hatırlatmaya yanıt vermedi (program zombileri toplamıyor). Kalıcı çözüm için servisini ya da konteynerini yeniden başlat."), .warning)
            }
        } catch {
            show(friendly(error), .error)
        }
    }

    func askRestart(_ z: ZombieGroup) {
        guard z.canRestartOwner else { return }
        let container = z.owner.kind == "container"
        confirmation = Confirmation(
            title: L.f("{0} yeniden başlatılsın mı?", z.owner.name),
            text: container
                ? L.t("Bu konteyner birkaç saniye kapanıp açılır; o sürede hizmet vermez. Yeniden başlayınca zombiler de gider.")
                : L.t("Bu servis birkaç saniye kapanıp açılır; o sürede hizmet vermez. Yeniden başlayınca zombiler de gider."),
            command: z.restartCommand,
            primary: L.t("Yeniden başlat")
        ) { [weak self] in await self?.restart(z) }
    }

    private func restart(_ z: ZombieGroup) async {
        waiting = L.t("Yeniden başlatılıyor…")
        waitingSince = Date()
        do {
            try await call("server.restartOwner", ["kind": z.owner.kind, "id": z.owner.id])
            load()
            show(L.f("{0} yeniden başlatıldı.", z.owner.name), .success)
        } catch {
            load()
            show(friendly(error), .error)
        }
    }

    /// "Öneriyi uygula": --init in the app's Coolify settings, then a redeploy.
    func askInit(_ z: ZombieGroup) {
        confirmation = Confirmation(
            title: L.t("Öneriyi uygula"),
            text: L.f("{0} konteynerinin uygulamasına Coolify'da --init seçeneği eklenir ve uygulama Coolify üzerinden yeniden dağıtılır. ", z.owner.name)
                + L.t("Dağıtım birkaç dakika sürer; eski konteyner yenisi hazır olunca kapanır. Ayar kalıcıdır; sonraki dağıtımlarda da geçerli olur."),
            command: "Coolify API: custom_docker_run_options += \"--init\"\nCoolify API: deploy",
            primary: L.t("Uygula"),
            destructive: false
        ) { [weak self] in await self?.applyInit(z, token: nil) }
    }

    func applyInit(_ z: ZombieGroup, token: String?) async {
        do {
            let r = try await call("server.coolifyInit", ["containerId": z.owner.id, "token": token ?? NSNull()], as: InitFix.self)
            switch r.status {
            case "needs-token":
                tokenRequest = TokenRequest(why: r.message, zombie: z)
            case "applied", "already":
                show(L.f("{0}: --init {1}, yeniden dağıtım başladı. Birkaç dakika sonra Yenile'ye bas; zombiler gitmiş olmalı.",
                         r.app, r.status == "already" ? L.t("zaten açıktı") : L.t("eklendi")), .success)
            default:
                show(r.message, .info)
            }
        } catch {
            show(friendly(error), .error)
        }
    }
}

// MARK: - colours

enum ServerColors {
    static func rgb(_ r: Int, _ g: Int, _ b: Int) -> Color {
        Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
    }

    /// Distinct series colours that read on light and dark backgrounds (as on Windows).
    static let palette: [Color] = [
        rgb(0x3B, 0x82, 0xF6), rgb(0x10, 0xB9, 0x81), rgb(0xF5, 0x9E, 0x0B), rgb(0x8B, 0x5C, 0xF6),
        rgb(0xEC, 0x48, 0x99), rgb(0x06, 0xB6, 0xD4), rgb(0xEF, 0x44, 0x44), rgb(0x84, 0xCC, 0x16),
        rgb(0x94, 0xA3, 0xB8),
    ]
    static let ok = rgb(0x10, 0xB9, 0x81)
    static let warn = rgb(0xF5, 0x9E, 0x0B)
    static let bad = rgb(0xEF, 0x44, 0x44)
    static let stays = rgb(0x64, 0x74, 0x8B)

    /// Green below 80 %, amber to 90 %, red above.
    static func level(_ percent: Double) -> Color { percent >= 90 ? bad : percent >= 80 ? warn : ok }

    /// A colour for the n-th item (never the grey kept for "others").
    static func item(_ n: Int) -> Color { palette[n % (palette.count - 1)] }
}

// MARK: - the window's view

struct ServerManagementView: View {
    @ObservedObject var model: ServerManagementModel

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { model.page }, set: { if let p = $0 { model.go(p) } })) {
                ForEach(ServerManagementModel.Page.allCases) { p in
                    Label(p.title, systemImage: p.symbol).tag(Optional(p))
                }
            }
            .listStyle(.sidebar)
            .disabled(model.isRunning)
            .navigationSplitViewColumnWidth(min: 170, ideal: 190, max: 260)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let m = model.message {
                        ServerNotice(title: nil, text: m.text, kind: m.kind, onClose: { model.message = nil })
                    }
                    content
                }
                .padding(24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(model.page?.title ?? "")
            .navigationSubtitle(model.label)
            .toolbar {
                ToolbarItem {
                    Button { model.load() } label: { Label(L.t("Yenile"), systemImage: "arrow.clockwise") }
                        .keyboardShortcut("r", modifiers: .command)
                        .disabled(model.isRunning)
                }
            }
        }
        .confirmationDialog(model.confirmation?.title ?? "",
                            isPresented: Binding(get: { model.confirmation != nil }, set: { if !$0 { model.confirmation = nil } }),
                            titleVisibility: .visible,
                            presenting: model.confirmation) { c in
            Button(c.primary, role: c.destructive ? ButtonRole.destructive : nil) { Task { await c.run() } }
            Button(L.t("Vazgeç"), role: .cancel) {}
        } message: { c in
            Text(c.message)
        }
        .sheet(item: $model.tokenRequest) { request in
            CoolifyTokenSheet(why: request.why) { token in
                Task { await model.applyInit(request.zombie, token: token) }
            }
        }
        .frame(minWidth: 820, minHeight: 560)
    }

    @ViewBuilder
    private var content: some View {
        if let run = model.run {
            CleanupRunView(run: run)
        } else if let waiting = model.waiting {
            WaitingCard(text: waiting, since: model.waitingSince, percent: model.page == .disk ? model.diskProgress : nil,
                        note: model.page == .disk ? L.t("Klasörler tek tek ölçülüyor; büyük disklerde bir iki dakika sürebilir.") : nil)
        } else {
            switch model.page ?? .overview {
            case .overview:
                if let o = model.overview { OverviewPage(model: model, o: o) }
            case .disk:
                if let u = model.disk { DiskPage(model: model, u: u) }
            case .cleanup:
                if let scan = model.cleanup { CleanupPage(model: model, scan: scan) }
            case .processes:
                if let list = model.processes { ProcessesPage(model: model, list: list) }
            }
        }
    }
}

// MARK: - building blocks

/// A coloured note: info, success, warning or error, with an optional action.
struct ServerNotice: View {
    let title: String?
    let text: String
    let kind: ServerManagementModel.Kind
    var actionTitle: String?
    var action: (() -> Void)?
    var onClose: (() -> Void)?

    private var color: Color {
        switch kind {
        case .info: return .accentColor
        case .success: return .green
        case .warning: return .orange
        case .error: return .red
        }
    }

    private var symbol: String {
        switch kind {
        case .info: return "info.circle.fill"
        case .success: return "checkmark.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        case .error: return "xmark.octagon.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(color).font(.title3)
            VStack(alignment: .leading, spacing: 4) {
                if let title { Text(title).fontWeight(.semibold) }
                Text(text).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                if let actionTitle, let action {
                    Button(actionTitle, action: action).padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
            if let onClose {
                Button(action: onClose) { Image(systemName: "xmark") }.buttonStyle(.borderless)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(color.opacity(0.1)))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(color.opacity(0.35)))
    }
}

/// Waiting for the server: a bar and the seconds so far (or the scan's percent).
struct WaitingCard: View {
    let text: String
    let since: Date
    let percent: Double?
    let note: String?

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Text(text).font(.headline)
                if let percent {
                    Text(Sizes.percent(percent)).font(.title.weight(.semibold)).monospacedDigit()
                    ProgressView(value: percent, total: 100)
                } else {
                    ProgressView().progressViewStyle(.linear)
                }
                TimelineView(.periodic(from: since, by: 1)) { context in
                    Text(L.f("{0} sn", max(0, Int(context.date.timeIntervalSince(since)))))
                        .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
                if let note { Text(note).foregroundStyle(.secondary) }
            }
            .padding(6)
            .frame(maxWidth: 520, alignment: .leading)
        }
        .frame(maxWidth: 560, alignment: .leading)
        .padding(.top, 12)
    }
}

/// A labelled bar: "Bellek  5,9 GB / 15 GB (%39)".
struct UsageMeter: View {
    let label: String
    let usedKb: UInt64
    let totalKb: UInt64
    var extra: String?

    var body: some View {
        let percent = totalKb == 0 ? 0 : Double(usedKb) * 100 / Double(totalKb)
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label).fontWeight(.semibold).lineLimit(1).truncationMode(.middle)
                Spacer()
                Text(summary(percent))
                    .foregroundStyle(.secondary).monospacedDigit()
            }
            ProgressView(value: min(100, max(0, percent)), total: 100)
                .tint(ServerColors.level(percent))
        }
    }

    private func summary(_ percent: Double) -> String {
        let used: String = Sizes.kb(usedKb)
        let total: String = Sizes.kb(totalKb)
        let share: String = Sizes.percent(percent)
        var text: String = used + " / " + total + "  (" + share + ")"
        if let extra { text += "  ·  " + extra }
        return text
    }
}

/// How full one resource is: a ring with the percent, a title and a detail.
struct RingGauge: View {
    let percent: Double
    let title: String
    let detail: String

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle().stroke(Color.secondary.opacity(0.2), lineWidth: 10)
                Circle()
                    .trim(from: 0, to: min(1, max(0, percent / 100)))
                    .stroke(ServerColors.level(percent), style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.6), value: percent)
                Text(Sizes.percent(percent)).font(.title3.weight(.semibold)).monospacedDigit()
            }
            .frame(width: 92, height: 92)
            Text(title).fontWeight(.semibold)
            Text(detail).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
    }
}

/// A live column chart: one column a sample, the newest value large.
struct LiveChart: View {
    let title: String
    let series: ServerManagementModel.LiveSeries
    let color: Color
    let format: (Double) -> String
    var fixedMax: Double?

    var body: some View {
        let top = fixedMax ?? max(1, (series.points.map(\.value).max() ?? 0) * 1.15)
        let last = series.points.last?.id ?? 0
        let high = max(last, ServerManagementModel.LiveSeries.capacity)
        let low = high - ServerManagementModel.LiveSeries.capacity + 1
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(title).fontWeight(.semibold)
                    Spacer()
                    Text(format(top)).font(.caption).foregroundStyle(.secondary)
                }
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(series.latest.map(format) ?? "—").font(.title2.weight(.semibold)).monospacedDigit()
                    Text(series.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Chart(series.points) { p in
                    BarMark(x: .value("t", p.id), y: .value("v", p.value), width: .fixed(5))
                        .foregroundStyle(color)
                        .cornerRadius(2)
                }
                .chartXScale(domain: low...high)
                .chartYScale(domain: 0...top)
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .frame(height: 96)
            }
            .padding(4)
        }
    }
}

/// A ring of parts with a legend (the disk page's biggest folders).
struct DonutChart: View {
    struct Part: Identifiable {
        let id: Int
        let label: String
        let value: Double
        let text: String
        let color: Color
    }

    let parts: [Part]
    let center: String

    var body: some View {
        let total = max(1, parts.reduce(0) { $0 + $1.value })
        HStack(alignment: .center, spacing: 28) {
            ZStack {
                ForEach(parts) { part in
                    let start = parts.prefix(part.id).reduce(0) { $0 + $1.value } / total
                    Circle()
                        .trim(from: start, to: min(1, start + part.value / total))
                        .stroke(part.color, style: StrokeStyle(lineWidth: 24))
                        .rotationEffect(.degrees(-90))
                }
                Text(center).font(.headline).monospacedDigit()
            }
            .frame(width: 150, height: 150)
            .padding(12)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(parts) { part in
                    HStack(spacing: 8) {
                        RoundedRectangle(cornerRadius: 3).fill(part.color).frame(width: 12, height: 12)
                        Text(part.label).font(.body.monospaced()).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 12)
                        Text(part.text).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            }
            .frame(maxWidth: 420)
        }
    }
}

// MARK: - overview

struct OverviewPage: View {
    @ObservedObject var model: ServerManagementModel
    let o: ServerOverview

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(o.hostname.isEmpty ? model.label : o.hostname).font(.largeTitle.weight(.semibold))
            Text(L.f("{0}  ·  {1}  ·  açık kalma süresi {2}", o.os, o.kernel, Sizes.duration(o.uptimeSecs)))
                .foregroundStyle(.secondary).textSelection(.enabled)
            attention
            GroupBox {
                HStack(alignment: .top, spacing: 12) {
                    RingGauge(percent: o.cpuPercent, title: L.t("İşlemci"),
                              detail: L.f("{0} çekirdek · yük {1}", o.cpus, Sizes.number(o.load.first ?? 0, digits: 2)))
                    RingGauge(percent: o.memTotalKb == 0 ? 0 : Double(o.memUsedKb) * 100 / Double(o.memTotalKb), title: L.t("Bellek"),
                              detail: Sizes.kb(o.memUsedKb) + " / " + Sizes.kb(o.memTotalKb))
                    if o.swapTotalKb > 0 {
                        RingGauge(percent: Double(o.swapUsedKb) * 100 / Double(o.swapTotalKb), title: L.t("Takas (swap)"),
                                  detail: Sizes.kb(o.swapUsedKb) + " / " + Sizes.kb(o.swapTotalKb))
                    }
                    if let root = o.rootDisk {
                        RingGauge(percent: root.usedPercent, title: L.f("Disk {0}", root.mount),
                                  detail: Sizes.kb(root.usedKb) + " / " + Sizes.kb(root.usableKb))
                    }
                }
                .padding(8)
            }
            HStack(spacing: 8) {
                Text(L.t("Canlı")).font(.title2.weight(.semibold))
                Circle().fill(ServerColors.bad).frame(width: 8, height: 8)
                Text(L.f("2 saniyede bir · {0} süreç", o.processes)).foregroundStyle(.secondary)
            }
            .padding(.top, 8)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
                LiveChart(title: L.t("İşlemci"), series: model.cpu, color: ServerColors.palette[0], format: { Sizes.percent($0) }, fixedMax: 100)
                LiveChart(title: L.t("Bellek"), series: model.mem, color: ServerColors.palette[3], format: { Sizes.percent($0) }, fixedMax: 100)
                LiveChart(title: L.t("Ağ trafiği"), series: model.net, color: ServerColors.palette[1], format: { Sizes.rate($0) })
                LiveChart(title: L.t("Disk okuma + yazma"), series: model.io, color: ServerColors.palette[2], format: { Sizes.rate($0) })
            }
            Text(L.t("Diskler")).font(.title2.weight(.semibold)).padding(.top, 8)
            GroupBox {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(o.disks) { d in
                        Button { model.openDisk(d.mount) } label: {
                            UsageMeter(label: d.mount + "   (" + d.device + ", " + d.fsType + ")", usedKb: d.usedKb, totalKb: d.usableKb,
                                       extra: L.f("boş {0}", Sizes.kb(d.availKb)))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(L.t("Bu diskte neyin yer kapladığını gör"))
                    }
                }
                .padding(8)
            }
        }
    }

    /// What needs attention first.
    @ViewBuilder
    private var attention: some View {
        ForEach(o.disks.filter { $0.usedPercent >= 85 }) { d in
            ServerNotice(title: L.f("{0} {1} dolu", d.mount, Sizes.percent(d.usedPercent)),
                         text: L.f("Boş yer: {0}. Disk dolarsa veritabanları ve Docker durur.", Sizes.kb(d.availKb)),
                         kind: d.usedPercent >= 90 ? .error : .warning,
                         actionTitle: L.t("Neyin yer kapladığını gör"), action: { model.openDisk(d.mount) })
        }
        if o.zombies > 0 {
            ServerNotice(title: L.f("{0} zombi süreç", o.zombies),
                         text: L.t("Bitmiş ama üst süreçleri tarafından toplanmamış süreçler. Hangi programdan geldiklerini Süreçler'de gör."),
                         kind: o.zombies >= 20 ? .warning : .info,
                         actionTitle: L.t("Zombileri gör"), action: { model.go(.processes) })
        }
        if o.rebootRequired {
            ServerNotice(title: L.t("Yeniden başlatma bekleniyor"),
                         text: L.t("Kurulan güncellemelerin bir kısmı sunucu yeniden başlatılınca devreye girer."), kind: .info)
        }
        if !o.updates.isEmpty {
            ServerNotice(title: L.t("Güncellemeler var"),
                         text: o.updates.replacingOccurrences(of: "updates can be applied immediately.", with: L.t("güncelleme hemen kurulabilir.")),
                         kind: .info)
        }
        if !o.canChange {
            ServerNotice(title: L.t("Yalnız görüntüleme"),
                         text: L.t("Bu kullanıcı root değil ve parolasız sudo yok: bilgiler görünür ama temizlik ve süreç işlemleri yapılamaz."),
                         kind: .info)
        }
    }
}

// MARK: - disk

struct DiskPage: View {
    @ObservedObject var model: ServerManagementModel
    let u: DiskUsage

    private var donut: [DonutChart.Part] {
        let top = Array(u.entries.prefix(7))
        var parts = top.enumerated().map { i, e in
            DonutChart.Part(id: i, label: DiskPaths.name(u.path, e.path), value: Double(e.kb), text: Sizes.kb(e.kb), color: ServerColors.item(i))
        }
        let shown = top.reduce(UInt64(0)) { $0 &+ $1.kb }
        if u.totalKb > shown {
            let rest = u.totalKb - shown
            parts.append(DonutChart.Part(id: parts.count, label: L.t("Diğer"), value: Double(rest), text: Sizes.kb(rest),
                                         color: ServerColors.palette[ServerColors.palette.count - 1]))
        }
        return parts
    }

    var body: some View {
        let biggest = max(1, u.entries.map(\.kb).max() ?? 1)
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Button { model.diskUp() } label: { Image(systemName: "arrow.up") }
                    .help(L.t("Üst klasör"))
                    .disabled(u.path == "/")
                Text(u.path).font(.title3.monospaced()).textSelection(.enabled)
                Text(L.f("toplam {0}", Sizes.kb(u.totalKb))).foregroundStyle(.secondary)
            }
            if !u.complete {
                ServerNotice(title: L.t("Bazı klasörler okunamadı"),
                             text: L.t("Bu kullanıcının erişemediği klasörler sayılmadı; boyutlar gerçekte daha büyük olabilir (root ile bağlan)."),
                             kind: .info)
            }
            if !u.entries.isEmpty {
                GroupBox { DonutChart(parts: donut, center: Sizes.kb(u.totalKb)).padding(8) }
            }
            Text(L.t("En çok yer kaplayanlar. Bir klasöre tıklayınca içine girer. Bu ekran yalnız ölçer; silme Temizlik'ten yapılır."))
                .foregroundStyle(.secondary)
            // Inside (or at) a Docker daemon's storage: its data is cleaned through that daemon, never by deleting folders.
            if let here = CleanupLayout.storeInside(u.path, u.dockerStores) {
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(here.label).fontWeight(.semibold)
                        Text(L.f("Bu klasör {0} ortamının depolaması ({1}, soket {2}). İçindeki dosyalar elle silinmemeli: build önbelleği ve kullanılmayan imajlar Temizlik'ten, bu Docker'ın kendisi üzerinden güvenle temizlenir; çalışan konteynerler ve volume'ler korunur.",
                                 here.label, here.rootDir, here.socket))
                            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        Button(L.t("Bu ortamın temizliğine git")) { model.go(.cleanup) }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            GroupBox {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(u.entries) { e in
                        Button { model.openDisk(e.path) } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(DiskPaths.name(u.path, e.path)).font(.body.monospaced()).lineLimit(1).truncationMode(.middle)
                                    // A Docker daemon's storage (or the folder holding it): say whose, so its cleanup is found.
                                    if let store = CleanupLayout.storeFor(e.path, u.dockerStores) {
                                        Text("Docker: " + store.label).font(.caption).foregroundStyle(Color.accentColor)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                ProgressView(value: Double(e.kb), total: Double(biggest))
                                    .frame(maxWidth: .infinity)
                                Text(Sizes.kb(e.kb)).monospacedDigit().frame(width: 90, alignment: .trailing)
                            }
                            .padding(.vertical, 6)
                            .padding(.horizontal, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    if u.entries.isEmpty {
                        Text(L.t("Bu klasörde alt klasör yok.")).foregroundStyle(.secondary).padding(8)
                    }
                }
            }
            if !u.docker.isEmpty {
                Text("Docker").font(.title2.weight(.semibold)).padding(.top, 8)
                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(u.docker) { d in
                            Text(dockerLine(d))
                        }
                        Text(L.t("Birimlere (uygulama verileri) hiçbir zaman dokunulmaz.")).foregroundStyle(.secondary)
                        Button(L.t("Temizlik'e git")) { model.go(.cleanup) }
                    }
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func dockerLine(_ d: DockerUsage) -> String {
        let name: String = kindName(d.kind)
        let size: String = Sizes.bytes(d.sizeBytes)
        var text: String = name + " (" + d.count + "): " + size
        if d.reclaimableBytes > 0 && d.kind != "Local Volumes" {
            text += L.f("  ·  {0} geri kazanılabilir", Sizes.bytes(d.reclaimableBytes))
        }
        return text
    }

    private func kindName(_ kind: String) -> String {
        switch kind {
        case "Images": return L.t("İmajlar")
        case "Containers": return L.t("Konteynerler")
        case "Local Volumes": return L.t("Birimler (veriler)")
        case "Build Cache": return L.t("Build önbelleği")
        default: return kind
        }
    }
}

// MARK: - cleanup

/// A Docker daemon at the top of its cleanup card: which one it is, what it
/// stores and frees, and the running containers a cleanup never touches.
struct DockerHeader: View {
    let env: DockerEnv

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(env.label, systemImage: env.rootless ? "person.crop.square" : "shippingbox")
                .font(.title3.weight(.semibold))
            Text(L.f("{0} · kullanıcı: {1} · soket: {2}", env.rootless ? "Rootless Docker" : L.t("Sistem Docker"), env.user,
                     env.socket.isEmpty ? L.t("varsayılan") : env.socket))
                .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            if env.error.isEmpty {
                if !env.rootDir.isEmpty {
                    Text(L.f("Depolama: {0}", env.rootDir)).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Text(L.f("Kullanım: {0}  ·  Build önbelleği: {1}  ·  Geri kazanılabilir: {2}",
                         Sizes.bytes(env.totalBytes), Sizes.bytes(env.buildCacheBytes), Sizes.bytes(env.reclaimableBytes)))
                    .fontWeight(.semibold)
                Text(L.f("İmajlar: {0} ({1} kullanımda) · Konteynerler: {2} ({3} çalışıyor) · Volume'ler: {4}",
                         env.imagesTotal, env.imagesActive, env.containersTotal, env.containersRunning, Sizes.bytes(env.volumesBytes)))
                    .foregroundStyle(.secondary)
                Text(protectedText).foregroundStyle(.green).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var protectedText: String {
        guard !env.running.isEmpty else { return L.t("Korunur (dokunulmaz): durmuş konteynerlerin imajları ve tüm volume'ler.") }
        return L.t("Korunur (dokunulmaz): ") + env.running.prefix(6).joined(separator: ", ")
            + (env.running.count > 6 ? L.f(" ve {0} konteyner daha", env.running.count - 6) : "")
            + L.t("; bunların ve durmuş konteynerlerin imajları, tüm volume'ler.")
    }
}

struct CleanupPage: View {
    @ObservedObject var model: ServerManagementModel
    let scan: CleanupScan

    var body: some View {
        let sections = CleanupLayout.sections(scan)
        let colors = Dictionary(sections.flatMap(\.items).enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { a, _ in a })
        let chosen = model.chosenItems
        let chosenKb = chosen.reduce(UInt64(0)) { $0 &+ $1.kb }
        VStack(alignment: .leading, spacing: 12) {
            Text(L.t("Güvenle silinebilecekler")).font(.largeTitle.weight(.semibold))
            Text(L.t("Yalnız bilinen, yeniden oluşturulabilen dosyalar listelenir. Uygulama verilerine, veritabanlarına ve Docker birimlerine dokunulmaz. Silmeden önce çalışacak komutlar gösterilir."))
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !scan.canChange {
                ServerNotice(title: L.t("Temizlik için yetki yok"),
                             text: L.t("Bu kullanıcı root değil ve parolasız sudo yok. Boyutlar eksik ölçülmüş olabilir; temizlik için root ile bağlan."),
                             kind: .warning)
            }
            if let d = scan.disk {
                GroupBox { AfterCleanup(disk: d, chosen: chosen, colors: colors).padding(8) }
            }
            ForEach(sections) { section in
                if section.docker != nil || !section.items.isEmpty {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 14) {
                            if let env = section.docker {
                                DockerHeader(env: env)
                                if !env.error.isEmpty {
                                    ServerNotice(title: L.t("Bu Docker okunamadı"),
                                                 text: env.error + L.t(" Boyutları bilinmiyor; bu ortam için temizlik önerilmiyor."), kind: .warning)
                                }
                            }
                            ForEach(section.items) { item in
                                CleanupRow(model: model, item: item, allowed: scan.allowed(item), color: ServerColors.item(colors[item.id] ?? 0))
                            }
                        }
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            HStack(spacing: 16) {
                Text(L.f("Seçilenler: {0}", Sizes.kb(chosenKb))).fontWeight(.semibold)
                Button(L.t("Seçilenleri temizle")) { model.askCleanup() }
                    .buttonStyle(.borderedProminent)
                    .disabled(chosen.isEmpty)
            }
            .padding(.top, 4)
        }
    }
}

struct CleanupRow: View {
    @ObservedObject var model: ServerManagementModel
    let item: CleanupItem
    let allowed: Bool
    let color: Color

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Toggle(isOn: Binding(get: { model.isChosen(item.id) }, set: { model.choose(item.id, $0) })) { EmptyView() }
                .toggleStyle(.checkbox)
                .labelsHidden()
                .disabled(!allowed || item.kb == 0)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 3).fill(color).frame(width: 12, height: 12)
                    Text(item.title).fontWeight(.semibold)
                }
                if !item.detail.isEmpty {
                    Text(item.detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if !item.warning.isEmpty {
                    Text(L.f("Dikkat: {0}", item.warning)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
                Text(item.command).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Text(item.kb > 0 ? Sizes.kb(item.kb) : L.t("boş")).fontWeight(.semibold).monospacedDigit()
        }
    }
}

/// The disk now and after the chosen cleanup: grey = stays, colours = freed.
struct AfterCleanup: View {
    let disk: ServerDisk
    let chosen: [CleanupItem]
    let colors: [String: Int]

    var body: some View {
        let size = Double(disk.usableKb)
        let chosenKb = chosen.reduce(UInt64(0)) { $0 &+ $1.kb }
        let freed = min(chosenKb, disk.usedKb)
        let stays = disk.usedKb - freed
        let before = size > 0 ? Double(disk.usedKb) * 100 / size : 0
        let after = size > 0 ? Double(stays) * 100 / size : 0
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(L.f("Disk {0}", disk.mount)).fontWeight(.semibold)
                Text(Sizes.percent(before)).font(.title2.weight(.semibold)).foregroundStyle(ServerColors.level(before))
                Text("→").font(.title2).foregroundStyle(.secondary)
                Text(Sizes.percent(after)).font(.title2.weight(.semibold)).foregroundStyle(ServerColors.level(after))
                Text(L.f("temizlikten sonra boş: {0}", Sizes.kb(disk.availKb &+ freed))).foregroundStyle(.secondary)
            }
            GeometryReader { geo in
                HStack(spacing: 0) {
                    Rectangle().fill(ServerColors.stays)
                        .frame(width: share(stays, of: size, in: geo.size.width))
                        .help(L.f("Kalacak: {0}", Sizes.kb(stays)))
                    ForEach(chosen.filter { $0.kb > 0 }) { item in
                        Rectangle().fill(ServerColors.item(colors[item.id] ?? 0))
                            .frame(width: share(min(item.kb, disk.usedKb), of: size, in: geo.size.width))
                            .help(item.title + ": " + Sizes.kb(item.kb))
                    }
                    Spacer(minLength: 0)
                }
                .background(Color.secondary.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 5))
            }
            .frame(height: 14)
        }
    }

    private func share(_ kb: UInt64, of size: Double, in width: CGFloat) -> CGFloat {
        size > 0 ? width * CGFloat(Double(kb) / size) : 0
    }
}

struct CleanupRunView: View {
    let run: ServerManagementModel.CleanupRun

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L.t("Temizleniyor")).font(.largeTitle.weight(.semibold))
            GroupBox {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(run.step).fontWeight(.semibold).lineLimit(1)
                        Spacer()
                        Text(Sizes.percent(run.percent)).font(.title.weight(.semibold)).foregroundStyle(Color.accentColor).monospacedDigit()
                    }
                    ProgressView(value: run.percent, total: 100).animation(.easeOut(duration: 0.6), value: run.percent)
                    Text(L.f("{0} / {1} temizlendi", Sizes.kb(run.doneKb), Sizes.kb(run.totalKb))).foregroundStyle(.secondary)
                    if let before = run.diskBefore {
                        let now = run.diskNow ?? before
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text(L.f("Disk {0}", "/")).fontWeight(.semibold)
                            Text(Sizes.percent(before)).font(.title3).foregroundStyle(ServerColors.level(before))
                            Text("→").font(.title3).foregroundStyle(.secondary)
                            Text(Sizes.percent(now)).font(.title3.weight(.semibold)).foregroundStyle(ServerColors.level(now))
                        }
                        .padding(.top, 8)
                        ProgressView(value: min(100, max(0, now)), total: 100)
                            .tint(ServerColors.level(now))
                            .animation(.easeOut(duration: 0.6), value: now)
                    }
                }
                .padding(8)
            }
            GroupBox {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(run.rows) { row in
                        HStack(spacing: 12) {
                            stateIcon(row.state).frame(width: 24)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(row.item.title).fontWeight(.semibold)
                                Text(row.note).font(.caption).foregroundStyle(.secondary)
                                if row.state == .working { ProgressView().progressViewStyle(.linear) }
                            }
                            Spacer()
                            Text(Sizes.kb(row.item.kb)).fontWeight(.semibold).monospacedDigit()
                        }
                    }
                }
                .padding(8)
            }
        }
    }

    @ViewBuilder
    private func stateIcon(_ state: ServerManagementModel.CleanupRun.State) -> some View {
        switch state {
        case .waiting: Image(systemName: "clock").foregroundStyle(.secondary)
        case .working: ProgressView().controlSize(.small)
        case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed: Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        }
    }
}

// MARK: - processes

struct ProcessesPage: View {
    @ObservedObject var model: ServerManagementModel
    let list: ProcessList

    struct Top: Identifiable {
        let id: UInt32
        let label: String
        let value: Double
        let text: String
    }

    var body: some View {
        let canChange = list.canChange
        let byCpu = top(byMemory: false)
        let byMem = top(byMemory: true)
        let shown = list.shown(filter: model.processFilter, byMemory: model.processByMemory)
        VStack(alignment: .leading, spacing: 12) {
            if list.zombies.isEmpty {
                ServerNotice(title: L.t("Zombi süreç yok"), text: L.t("Bütün bitmiş süreçler toplanmış."), kind: .success)
            } else {
                Text(L.f("Zombi süreçler ({0})", list.zombieCount)).font(.largeTitle.weight(.semibold))
                Text(L.t("Zombi süreç zaten bitmiştir; bellek ya da işlemci kullanmaz, doğrudan sonlandırılamaz. Onu yalnız kendisini başlatan üst süreç toplayabilir. Önce üst sürece zararsız bir hatırlatma gönder; işe yaramazsa üst sürecin servisini ya da konteynerini yeniden başlat."))
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                ForEach(list.zombies) { z in ZombieCard(model: model, z: z, canChange: canChange) }
            }
            // Who uses the machine: the ten heaviest by CPU and by memory.
            HStack(alignment: .top, spacing: 14) {
                topChart(L.t("En çok işlemci kullanan 10 süreç"), byCpu, ServerColors.palette[0])
                topChart(L.t("En çok bellek kullanan 10 süreç"), byMem, ServerColors.palette[3])
            }
            .padding(.top, 8)
            Text(L.t("Süreçler")).font(.title2.weight(.semibold)).padding(.top, 8)
            HStack(spacing: 8) {
                TextField(L.t("Ara (ad, komut, kullanıcı, PID)"), text: $model.processFilter)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 320)
                Picker("", selection: $model.processByMemory) {
                    Text(L.t("İşlemciye göre")).tag(false)
                    Text(L.t("Belleğe göre")).tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 260)
            }
            GroupBox {
                VStack(alignment: .leading, spacing: 0) {
                    ProcessRow(model: model, p: nil, canChange: canChange)
                    Divider()
                    ForEach(shown) { p in
                        ProcessRow(model: model, p: p, canChange: canChange)
                    }
                    if shown.isEmpty {
                        Text(L.t("Eşleşen süreç yok.")).foregroundStyle(.secondary).padding(8)
                    }
                }
            }
        }
    }

    /// The ten heaviest running processes by CPU or by memory.
    private func top(byMemory: Bool) -> [Top] {
        let sorted: [ServerProcess] = list.shown(filter: "", byMemory: byMemory, limit: 10)
        return sorted.map { p -> Top in
            let label = p.name + " (" + String(p.pid) + ")"
            return byMemory
                ? Top(id: p.pid, label: label, value: Double(p.rssKb), text: Sizes.kb(p.rssKb))
                : Top(id: p.pid, label: label, value: p.cpu, text: Sizes.percent(p.cpu))
        }
    }

    private func topChart(_ title: String, _ items: [Top], _ color: Color) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Text(title).fontWeight(.semibold)
                Chart(items) { t in
                    BarMark(x: .value("v", t.value), y: .value("p", t.label))
                        .foregroundStyle(color)
                        .annotation(position: .trailing) {
                            Text(t.text).font(.caption2).foregroundStyle(.secondary)
                        }
                }
                .chartXAxis(.hidden)
                .frame(height: CGFloat(max(1, items.count)) * 24 + 8)
            }
            .padding(4)
        }
        .frame(maxWidth: .infinity)
    }
}

struct ProcessRow: View {
    @ObservedObject var model: ServerManagementModel
    let p: ServerProcess?
    let canChange: Bool

    var body: some View {
        HStack(spacing: 12) {
            cell(p?.name ?? L.t("Ad"), width: 160)
            cell(p.map { String($0.pid) } ?? "PID", width: 80)
            cell(p?.user ?? L.t("Kullanıcı"), width: 100)
            cell(p.map { Sizes.percent($0.cpu) } ?? L.t("İşlemci"), width: 64)
            cell(p.map { Sizes.kb($0.rssKb) } ?? L.t("Bellek"), width: 80)
            Group {
                if let p {
                    Text(p.command).font(.caption.monospaced()).foregroundStyle(.secondary).help(p.command)
                } else {
                    Text(L.t("Komut")).fontWeight(.semibold).foregroundStyle(.secondary)
                }
            }
            .lineLimit(1).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
            if let p, canChange {
                Menu {
                    Button(L.t("Sonlandır (kibarca)")) { model.askSignal(p, kill: false) }
                    Button(L.t("Zorla durdur"), role: .destructive) { model.askSignal(p, kill: true) }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .frame(width: 32)
            } else {
                Color.clear.frame(width: 32, height: 1)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 6)
    }

    private func cell(_ text: String, width: CGFloat) -> some View {
        Text(text)
            .fontWeight(p == nil ? .semibold : .regular)
            .foregroundStyle(p == nil ? Color.secondary : Color.primary)
            .lineLimit(1).truncationMode(.tail)
            .monospacedDigit()
            .frame(width: width, alignment: .leading)
    }
}

struct ZombieCard: View {
    @ObservedObject var model: ServerManagementModel
    let z: ZombieGroup
    let canChange: Bool

    private var owner: String {
        switch z.owner.kind {
        case "container": return L.f("Docker konteyneri: {0}", z.owner.name)
        case "service": return L.f("Servis: {0}", z.owner.name)
        default: return ""
        }
    }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                Text(L.f("{0} zombi  ←  {1} (PID {2})", z.count, z.parent.name, z.parent.pid)).font(.title3.weight(.semibold))
                Text(z.parent.command).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                    .textSelection(.enabled)
                if !owner.isEmpty {
                    Text(owner + L.f("  ·  çalışma süresi {0}", Sizes.duration(z.parent.elapsedSecs))).foregroundStyle(.secondary)
                }
                if z.owner.kind == "container" {
                    Text(L.t("Kalıcı çözüm: konteyner küçük bir init süreciyle (--init) çalışsın; o, bitmiş süreçleri kendiliğinden toplar. \"Öneriyi uygula\" bunu Coolify'daki ayarına ekleyip uygulamayı yeniden dağıtır."))
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if !z.protected.isEmpty {
                    Text(z.protected).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if canChange {
                    HStack(spacing: 8) {
                        if z.owner.kind == "container" {
                            Button(L.t("Öneriyi uygula")) { model.askInit(z) }.buttonStyle(.borderedProminent)
                        }
                        Button(L.t("Toplamasını iste")) { model.askReap(z) }
                        if z.canRestartOwner {
                            Button(z.owner.kind == "container" ? L.t("Konteyneri yeniden başlat") : L.t("Servisi yeniden başlat")) { model.askRestart(z) }
                        }
                    }
                }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Asks once for a Coolify API token (kept by the app core for this server).
struct CoolifyTokenSheet: View {
    let why: String
    let onDone: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var token = ""

    private var trimmed: String { token.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L.t("Coolify API anahtarı")).font(.headline)
            if !why.isEmpty { ServerNotice(title: nil, text: why, kind: .warning) }
            Text(L.t("Bu ayarı Coolify'a yazmak için bir kez Coolify API anahtarı gerekiyor:"))
                .fixedSize(horizontal: false, vertical: true)
            Text(L.t("1. Coolify'da Ayarlar > Gelişmiş > API erişimi açık olsun.\n2. Keys & Tokens > API tokens > yeni anahtar oluştur; \"write\" ve \"deploy\" yetkilerini seç.\n3. Anahtarı buraya yapıştır."))
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            SecureField(L.t("Coolify API anahtarı"), text: $token).textFieldStyle(.roundedBorder)
            Text(L.t("Anahtar bu bilgisayarın anahtar zincirinde saklanır. Coolify'a sunucunun kendi içinden bağlanılır; anahtar internete çıkmaz."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button(L.t("Vazgeç")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(L.t("Devam")) {
                    let value = trimmed
                    dismiss()
                    onDone(value)
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(trimmed.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 480)
    }
}
