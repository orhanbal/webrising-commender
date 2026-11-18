import AppKit
import CenterCore
import Darwin
import SwiftUI

// Task Manager for this Mac: every process with CPU, memory and user, as a
// list or a tree, searchable and sortable, with details. Critical processes
// (kernel_task, launchd, WindowServer, loginwindow, WECOMMANDER itself,
// databases, other users' processes) cannot be ended from here; anything else
// ends only after a confirmation (SIGTERM first, SIGKILL offered if it stays).
// The Windows app's TaskManagerWindow.

@MainActor
enum TaskManagerWindows {
    private static var window: NSWindow?
    private static var model: TaskManagerModel?
    private static var delegate: ServerWindowDelegate?

    @discardableResult
    static func show() -> NSWindow {
        if let window {
            model?.start()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return window
        }
        let m = TaskManagerModel()
        let hosting = NSHostingController(rootView: TaskManagerView(model: m))
        let w = NSWindow(contentViewController: hosting)
        w.title = L.t("Görev Yöneticisi")
        w.setContentSize(NSSize(width: 1040, height: 680))
        w.contentMinSize = NSSize(width: 760, height: 460)
        WindowChrome.apply(w, hosting: hosting, id: "taskmanager")
        w.isReleasedWhenClosed = false
        w.setFrameAutosaveName("WecommanderTaskManager")
        let d = ServerWindowDelegate { TaskManagerWindows.model?.stop() }
        w.delegate = d
        window = w
        model = m
        delegate = d
        w.center()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        m.start()
        return w
    }
}

@MainActor
final class TaskManagerModel: ObservableObject {
    /// A process waiting for the person's yes: end (SIGTERM) or, when it stayed, stop at once (SIGKILL).
    struct EndRequest: Identifiable {
        let id = UUID()
        let row: LocalProcessRow
        let force: Bool
        let children: Int
    }

    @Published private(set) var rows: [LocalProcessRow] = []
    @Published var filter = ""
    @Published var column = "cpu"
    @Published var tree = false
    @Published var selection: Int32?
    @Published var message: ScheduledTasksModel.Message?
    @Published var ending: EndRequest?
    @Published private(set) var memoryUsed: UInt64?
    @Published private(set) var loaded = false

    let cpuCount = ProcessInfo.processInfo.activeProcessorCount
    let memoryTotal = ProcessInfo.processInfo.physicalMemory
    private let selfPid = ProcessInfo.processInfo.processIdentifier
    private let selfUid = getuid()
    private var last: LocalSnapshot?
    private var timer: Timer?
    private var reading = false

    func start() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refresh() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        refresh()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    /// Reads off the main thread; the rows are rates since the previous reading.
    func refresh() {
        if reading { return }
        reading = true
        Task.detached(priority: .utility) { [weak self] in
            let snapshot = LocalProcessReader.read()
            let used = TaskManagerModel.usedMemory()
            await self?.apply(snapshot, used)
        }
    }

    private func apply(_ snapshot: LocalSnapshot, _ used: UInt64?) {
        reading = false
        rows = LocalProcesses.rows(before: last, now: snapshot, cpuCount: cpuCount, selfPid: selfPid, selfUid: selfUid)
        last = snapshot
        memoryUsed = used
        loaded = true
    }

    /// One line of the list: a process and its indent in the tree.
    struct Shown: Identifiable {
        let row: LocalProcessRow
        let depth: Int
        var id: Int32 { row.pid }
    }

    /// The rows as shown: searched, sorted, flat or as a tree (depth for the indent).
    var shown: [Shown] {
        let matching = LocalProcesses.filter(rows, filter)
        if tree && filter.trimmingCharacters(in: .whitespaces).isEmpty {
            return LocalProcesses.tree(matching, column: column).map { Shown(row: $0.row, depth: $0.depth) }
        }
        return LocalProcesses.sorted(matching, column: column).map { Shown(row: $0, depth: 0) }
    }

    var selected: LocalProcessRow? { rows.first { $0.pid == selection } }

    var summary: String {
        let cpu: Double = min(100, rows.reduce(0) { $0 + $1.cpu })
        let used: String = memoryUsed.map { Sizes.bytes($0) } ?? "—"
        let total: String = Sizes.bytes(memoryTotal)
        return L.f("İşlemci {0} · Bellek {1} / {2} · {3} süreç", Sizes.percent(cpu), used, total, rows.count)
    }

    func parentName(_ row: LocalProcessRow) -> String {
        guard let parent = rows.first(where: { $0.pid == row.info.ppid && $0.pid != row.pid }) else { return String(row.info.ppid) }
        return parent.name + " (" + String(parent.pid) + ")"
    }

    func askEnd(_ row: LocalProcessRow) {
        guard row.canEnd else { return }
        ending = EndRequest(row: row, force: false, children: LocalProcesses.childCount(rows, of: row.pid))
    }

    func end(_ request: EndRequest) {
        let row = request.row
        if let failure = LocalProcessReader.signal(row.pid, kill: request.force) {
            message = .init(text: L.f("{0} sonlandırılamadı: {1}", row.name, failure), kind: .error)
            return
        }
        if request.force {
            message = .init(text: L.f("{0} durduruldu.", row.name), kind: .success)
            refresh()
            return
        }
        message = .init(text: L.f("{0} için kapanma isteği gönderildi.", row.name), kind: .info)
        // Still there after a few seconds: offer to stop it at once.
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard let self else { return }
            if LocalProcessReader.isRunning(row.pid) {
                self.ending = EndRequest(row: row, force: true, children: 0)
            } else {
                self.message = .init(text: L.f("{0} sonlandırıldı.", row.name), kind: .success)
            }
            self.refresh()
        }
    }

    func revealInFinder(_ row: LocalProcessRow) {
        guard let path = row.info.path else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    /// Memory in use on this Mac (active, wired and compressed pages).
    nonisolated static func usedMemory() -> UInt64? {
        var stats = vm_statistics64()
        var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
        let result: kern_return_t = withUnsafeMutablePointer(to: &stats) { pointer -> kern_return_t in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { reboundPointer -> kern_return_t in
                host_statistics64(mach_host_self(), HOST_VM_INFO64, reboundPointer, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        let page = UInt64(vm_kernel_page_size)
        let pages: UInt64 = UInt64(stats.active_count) + UInt64(stats.wire_count) + UInt64(stats.compressor_page_count)
        return pages * page
    }
}

// MARK: - view

struct TaskManagerView: View {
    @ObservedObject var model: TaskManagerModel

    var body: some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 8) {
                header
                if let m = model.message {
                    ServerNotice(title: nil, text: m.text, kind: m.kind, onClose: { model.message = nil })
                }
                ProcessTable(model: model)
            }
            .padding(12)
            .frame(minWidth: 480, maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            ProcessDetails(model: model)
                .frame(minWidth: 260, idealWidth: 300, maxWidth: 380, maxHeight: .infinity, alignment: .top)
        }
        .frame(minWidth: 760, minHeight: 460)
        .confirmationDialog(endTitle,
                            isPresented: Binding(get: { model.ending != nil }, set: { if !$0 { model.ending = nil } }),
                            titleVisibility: .visible,
                            presenting: model.ending) { request in
            Button(request.force ? L.t("Zorla durdur") : L.t("Sonlandır"), role: .destructive) { model.end(request) }
            Button(L.t("Vazgeç"), role: .cancel) {}
        } message: { request in
            Text(endMessage(request))
        }
    }

    private var endTitle: String {
        guard let request = model.ending else { return "" }
        return request.force ? L.f("{0} zorla durdurulsun mı?", request.row.name) : L.t("Süreç sonlandırılsın mı?")
    }

    private func endMessage(_ request: TaskManagerModel.EndRequest) -> String {
        let row = request.row
        if request.force {
            return L.f("{0} (PID {1}) kapanma isteğine yanıt vermedi. Zorla durdurulursa (SIGKILL) kaydedilmemiş işleri kaybolur.", row.name, row.pid)
        }
        var text: String = L.f("{0} (PID {1}) kapanmaya çağrılır (SIGTERM); program açık işlerini bitirip kapanır. Kapanmazsa zorla durdurmayı önereceğim.", row.name, row.pid)
        if request.children > 0 {
            text += "\n\n" + L.f("Bu sürecin {0} alt süreci var; onlar çalışmaya devam eder ama üst süreçleri olmadan düzgün çalışmayabilir.", request.children)
        }
        return text
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(L.t("Görev Yöneticisi")).font(.title.weight(.semibold)).lineLimit(1)
                Text(L.f("Bu bilgisayar ({0})", Host.current().localizedName ?? "Mac"))
                    .foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 8)
            }
            Text(model.summary).font(.callout.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: 8) {
                TextField(L.t("Ara (ad, PID, konum)"), text: $model.filter)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 280)
                Picker("", selection: $model.column) {
                    Text(L.t("İşlemciye göre")).tag("cpu")
                    Text(L.t("Belleğe göre")).tag("memory")
                    Text(L.t("Ada göre")).tag("name")
                    Text(L.t("PID'e göre")).tag("pid")
                    Text(L.t("Kullanıcıya göre")).tag("user")
                }
                .labelsHidden()
                .frame(width: 170)
                Toggle(L.t("Ağaç görünümü"), isOn: $model.tree).toggleStyle(.checkbox)
                Spacer(minLength: 0)
                Button { model.refresh() } label: { Label(L.t("Yenile"), icon: .refresh) }
            }
        }
    }
}

private struct ProcessTable: View {
    @ObservedObject var model: TaskManagerModel

    var body: some View {
        let shown = model.shown
        VStack(spacing: 0) {
            LocalProcessRowView(row: nil, depth: 0, column: model.column) { model.column = $0 }
                .padding(.horizontal, 8)
            Divider()
            if !model.loaded {
                ProgressView().controlSize(.small).padding()
                Spacer()
            } else if shown.isEmpty {
                Text(L.t("Eşleşen süreç yok.")).foregroundStyle(.secondary).padding()
                Spacer()
            } else {
                List(selection: $model.selection) {
                    ForEach(shown) { item in
                        LocalProcessRowView(row: item.row, depth: item.depth, column: model.column) { _ in }
                            .tag(item.row.pid)
                            .contextMenu {
                                Button(L.t("Sonlandır")) { model.askEnd(item.row) }.disabled(!item.row.canEnd)
                            }
                    }
                }
                .listStyle(.inset)
            }
        }
    }
}

/// A process row, or (row nil) the column headers that sort the list.
private struct LocalProcessRowView: View {
    let row: LocalProcessRow?
    let depth: Int
    let column: String
    let sort: (String) -> Void

    var body: some View {
        HStack(spacing: 10) {
            nameCell
                .frame(minWidth: 160, maxWidth: .infinity, alignment: .leading)
            cell("PID", row.map { String($0.pid) }, key: "pid", width: 64)
            cell(L.t("İşlemci"), row.map { Sizes.percent($0.cpu) }, key: "cpu", width: 64)
            cell(L.t("Bellek"), row.map { r in r.info.residentBytes.map { Sizes.bytes($0) } ?? "—" }, key: "memory", width: 84)
            cell(L.t("Kullanıcı"), row.map { $0.info.user }, key: "user", width: 110)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var nameCell: some View {
        if let row {
            HStack(spacing: 4) {
                if depth > 0 { Color.clear.frame(width: CGFloat(min(depth, 12)) * 12, height: 1) }
                WCIcon(row.canEnd ? .app : .lock, size: 12)
                    .foregroundStyle(.secondary)
                Text(row.name).lineLimit(1).truncationMode(.tail)
            }
        } else {
            Button(L.t("Ad")) { sort("name") }
                .buttonStyle(.plain).fontWeight(column == "name" ? .bold : .semibold).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func cell(_ title: String, _ value: String?, key: String, width: CGFloat) -> some View {
        if row == nil {
            Button(title) { sort(key) }
                .buttonStyle(.plain)
                .fontWeight(column == key ? .bold : .semibold)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(width: width, alignment: .leading)
        } else {
            Text(value ?? "").monospacedDigit().lineLimit(1).truncationMode(.tail)
                .frame(width: width, alignment: .leading)
        }
    }
}

private struct ProcessDetails: View {
    @ObservedObject var model: TaskManagerModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let row = model.selected {
                    details(row)
                } else {
                    Text(L.t("Ayrıntılar ve işlemler için bir süreç seç.")).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func facts(_ row: LocalProcessRow) -> [String] {
        var out: [String] = [
            "PID " + String(row.pid),
            L.f("Üst süreç: {0}", model.parentName(row)),
            L.f("Kullanıcı: {0}", row.info.user.isEmpty ? String(row.info.uid) : row.info.user),
        ]
        if row.info.threads > 0 { out.append(L.f("İş parçacığı: {0}", row.info.threads)) }
        out.append(L.f("Bellek: {0}", row.info.residentBytes.map { Sizes.bytes($0) } ?? "—"))
        out.append(L.f("İşlemci: {0}", Sizes.percent(row.cpu)))
        if let started = row.info.started {
            let f = DateFormatter()
            f.locale = L.locale
            f.dateStyle = .short
            f.timeStyle = .short
            out.append(L.f("Başlangıç: {0}", f.string(from: started)))
        }
        return out
    }

    @ViewBuilder
    private func details(_ row: LocalProcessRow) -> some View {
        Text(row.name).font(.title2.weight(.semibold)).lineLimit(2).textSelection(.enabled)
        ForEach(facts(row), id: \.self) { line in
            Text(line).foregroundStyle(.secondary).textSelection(.enabled)
        }
        Text(row.info.path ?? L.t("Konum okunamadı (macOS bu süreci korur ya da yönetici izni gerekir)."))
            .font(.caption.monospaced())
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        if let reason = row.protectedReason {
            ServerNotice(title: nil, text: reason, kind: .info)
        }
        HStack(spacing: 8) {
            Button(L.t("Sonlandır")) { model.askEnd(row) }
                .disabled(!row.canEnd)
            if row.info.path != nil {
                Button(L.t("Finder'da göster")) { model.revealInFinder(row) }
            }
        }
    }
}
