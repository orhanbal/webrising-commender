import AppKit
import CenterCore
import SwiftUI

// "Zamanlanmış görevler": WECOMMANDER's own scheduled tasks, stored on the
// server. The server runs them when due: on a device through its agent, on a
// saved SSH host through the app that saved the host (the runner below).
// Owner and admin change them; a viewer only reads (the API answers 403).
// The Windows app's ServersWindow.ScheduledTasks.cs and App.ScheduledTasks.cs.

/// Runs one command on a saved SSH host through wecommander-core (`hosts.exec`).
struct CoreHostExecutor: RemoteExecutor {
    let servers: ServersModel

    func run(hostId: String, command: String, timeoutSec: Int) async throws -> RemoteExecResult {
        await servers.hostExec(hostId: hostId, command: command, timeoutSec: timeoutSec)
    }
}

/// A choice in the editor's target menu.
struct TargetChoice: Identifiable, Equatable {
    let id: String
    let label: String
    let target: TaskTarget
}

@MainActor
final class ScheduledTasksModel: ObservableObject {
    struct Message: Equatable {
        let text: String
        let kind: ServerManagementModel.Kind
    }

    struct EditorRequest: Equatable {
        let existing: ScheduledTask?
        let draft: ScheduledTaskDraft
        let error: String?
    }

    /// The one sheet of the page: the editor, the confirmation, or a task's runs.
    enum Sheet: Identifiable {
        case editor(UUID, EditorRequest)
        case confirm(UUID, EditorRequest)
        case history(UUID, ScheduledTask)

        var id: String {
            switch self {
            case .editor(let id, _): return "editor-" + id.uuidString
            case .confirm(let id, _): return "confirm-" + id.uuidString
            case .history(let id, _): return "history-" + id.uuidString
            }
        }
    }

    @Published private(set) var tasks: [ScheduledTask] = []
    @Published private(set) var loading = false
    @Published private(set) var loaded = false
    @Published private(set) var loadError: String?
    @Published var message: Message?
    @Published var sheet: Sheet?
    @Published var deleting: ScheduledTask?

    private weak var app: AppModel?
    private weak var servers: ServersModel?
    private let runner: ScheduledRunner
    private var timer: Timer?
    private var lastClaim = Date.distantPast

    init(app: AppModel, servers: ServersModel) {
        self.app = app
        self.servers = servers
        runner = ScheduledRunner(executor: CoreHostExecutor(servers: servers))
    }

    var signedIn: Bool { app?.token != nil }
    var canEdit: Bool { ScheduleText.canEdit(role: app?.me?.role) }

    private func credentials() -> (GatewayClient, String)? {
        guard let app, let token = app.token else {
            show(L.t("Önce oturum aç."), .warning)
            return nil
        }
        return (app.gateway, token)
    }

    func show(_ text: String, _ kind: ServerManagementModel.Kind) { message = Message(text: text, kind: kind) }

    func showPanel() { app?.showPanel?() }

    // MARK: the runner (saved SSH hosts of this Mac)

    /// Claims every 30 seconds while signed in, and right after start; never on the main thread's time.
    func start() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.pollIfDue() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        pollIfDue()
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func pollIfDue() {
        guard let app, let token = app.token else { return }
        guard Date().timeIntervalSince(lastClaim) >= ScheduledRunner.pollEvery else { return }
        lastClaim = Date()
        let transport = GatewayRunTransport(gateway: app.gateway, token: token)
        let runner = self.runner
        Task.detached { await runner.pollOnce(transport) }
    }

    /// "Şimdi çalıştır" on an SSH task: claim on the next tick instead of waiting up to 30 s.
    func requestClaim() {
        lastClaim = .distantPast
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            self?.pollIfDue()
        }
    }

    // MARK: the list

    func reload() {
        guard let app, let token = app.token else {
            tasks = []
            loaded = true
            return
        }
        loading = true
        let gateway = app.gateway
        Task {
            do {
                let list = try await gateway.scheduledTasks(token: token)
                tasks = list.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                loadError = nil
            } catch {
                loadError = ScheduleText.error(error)
            }
            loading = false
            loaded = true
        }
    }

    func targetLabel(_ target: TaskTarget) -> String {
        if target.isSsh {
            let name = target.hostLabel ?? target.hostId ?? "?"
            let label = L.f("Sunucu (SSH): {0}", name)
            let mine = app?.me?.centerId ?? ""
            if mine.isEmpty || target.centerId == mine { return label }
            return label + L.t(" (başka bir bilgisayardan çalışır)")
        }
        let device = app?.devices.first { $0.id == target.deviceId }
        return L.f("Cihaz: {0}", device?.name ?? L.t("bilinmeyen cihaz"))
    }

    func setEnabled(_ task: ScheduledTask, _ on: Bool) {
        guard let creds = credentials() else { return }
        let (gateway, token) = creds
        Task {
            do {
                let saved = try await gateway.updateScheduledTask(token: token, id: task.id, changes: ["enabled": on])
                if let i = tasks.firstIndex(where: { $0.id == task.id }) { tasks[i] = saved }
                show(on ? L.f("{0} açıldı.", task.name) : L.f("{0} kapatıldı; zamanında çalışmayacak.", task.name), .success)
            } catch {
                show(ScheduleText.error(error), .error)
            }
        }
    }

    func runNow(_ task: ScheduledTask) {
        guard let creds = credentials() else { return }
        let (gateway, token) = creds
        Task {
            do {
                _ = try await gateway.runScheduledTask(token: token, id: task.id)
                if task.target.isSsh {
                    show(L.f("{0} sıraya alındı; bu uygulama birkaç saniye içinde çalıştırır.", task.name), .success)
                    requestClaim()
                } else {
                    show(L.f("{0} sıraya alındı; cihazdaki ajan birazdan çalıştırır.", task.name), .success)
                }
            } catch {
                show(ScheduleText.error(error), .error)
            }
        }
    }

    func delete(_ task: ScheduledTask) {
        guard let creds = credentials() else { return }
        let (gateway, token) = creds
        Task {
            do {
                try await gateway.deleteScheduledTask(token: token, id: task.id)
                tasks.removeAll { $0.id == task.id }
                show(L.f("{0} silindi.", task.name), .success)
                reload()
            } catch {
                show(ScheduleText.error(error), .error)
            }
        }
    }

    // MARK: create / edit

    func edit(_ existing: ScheduledTask?) {
        guard credentials() != nil else { return }
        let draft = existing.map { ScheduledTaskDraft($0) } ?? ScheduledTaskDraft()
        sheet = .editor(UUID(), EditorRequest(existing: existing, draft: draft, error: nil))
    }

    /// The editor's "Devam": the confirmation with the exact command and target.
    func confirm(_ existing: ScheduledTask?, _ draft: ScheduledTaskDraft) {
        sheet = .confirm(UUID(), EditorRequest(existing: existing, draft: draft, error: nil))
    }

    /// "Geri dön": the editor again with what was typed.
    func backToEditor(_ existing: ScheduledTask?, _ draft: ScheduledTaskDraft, error: String? = nil) {
        sheet = .editor(UUID(), EditorRequest(existing: existing, draft: draft, error: error))
    }

    func save(_ existing: ScheduledTask?, _ draft: ScheduledTaskDraft) {
        guard let creds = credentials() else { sheet = nil; return }
        let (gateway, token) = creds
        Task {
            do {
                if let existing {
                    _ = try await gateway.updateScheduledTask(token: token, id: existing.id, changes: draft.json())
                } else {
                    _ = try await gateway.createScheduledTask(token: token, draft: draft)
                }
                sheet = nil
                let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
                show(existing == nil ? L.f("{0} oluşturuldu.", name) : L.f("{0} kaydedildi.", name), .success)
                reload()
            } catch let e as GatewayError where e.status != 403 && e.kind != .unauthorized {
                // Refused by the server: the editor again with the same fields and why.
                backToEditor(existing, draft, error: ScheduleText.error(e))
            } catch {
                sheet = nil
                show(ScheduleText.error(error), .error)
            }
        }
    }

    /// Targets: agent devices of the workspace, then this Mac's saved SSH hosts.
    func targets(keeping current: TaskTarget?) async -> [TargetChoice] {
        guard let app else { return [] }
        var centerId = app.me?.centerId ?? ""
        var devices = app.devices
        if let token = app.token {
            if centerId.isEmpty, let me = try? await app.gateway.me(token: token) { centerId = me.centerId }
            if devices.isEmpty, let list = try? await app.gateway.devices(token: token) { devices = list }
        }
        var out: [TargetChoice] = []
        let sortedDevices = devices.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        for d in sortedDevices {
            out.append(TargetChoice(id: "device:" + d.id, label: L.f("Cihaz: {0}", d.name), target: .device(d.id)))
        }
        if !centerId.isEmpty, let servers {
            let hosts = servers.hosts.filter(\.isSsh).sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
            for h in hosts {
                let target = TaskTarget.ssh(centerId: centerId, hostId: h.id, hostLabel: h.label)
                out.append(TargetChoice(id: "ssh:" + centerId + ":" + h.id, label: L.f("Sunucu (SSH): {0}", h.label), target: target))
            }
        }
        if let current, !out.contains(where: { $0.target.sameAs(current) }) {
            let key = current.isSsh ? "ssh:" + (current.centerId ?? "") + ":" + (current.hostId ?? "") : "device:" + (current.deviceId ?? "")
            out.insert(TargetChoice(id: key, label: targetLabel(current), target: current), at: 0)
        }
        return out
    }

    enum Preview: Equatable {
        case times([Date])
        case problem(String)
    }

    func preview(_ schedule: TaskSchedule, timezone: String) async -> Preview {
        guard let app, let token = app.token else { return .problem(L.t("Önce oturum aç.")) }
        do {
            let next = try await app.gateway.previewSchedule(token: token, schedule: schedule, timezone: timezone)
            return .times(next)
        } catch let e as GatewayError where e.status == 400 {
            return .problem(L.t("Zamanlama geçersiz: ") + (e.serverMessage ?? e.message))
        } catch {
            return .problem(ScheduleText.error(error))
        }
    }

    func runs(_ task: ScheduledTask) async -> Result<[TaskRun], Error> {
        guard let app, let token = app.token else { return .success([]) }
        do {
            return .success(try await app.gateway.scheduledTaskRuns(token: token, id: task.id))
        } catch {
            return .failure(error)
        }
    }
}

// MARK: - the page

struct ScheduledTasksPage: View {
    @ObservedObject var model: ScheduledTasksModel

    private var subtitle: String {
        L.t("WECOMMANDER bu görevleri zamanı gelince kendisi çalıştırır: cihazlarda ajan, kayıtlı SSH sunucularında bu uygulama (açık ve oturumu açık olmalı).")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(subtitle).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let m = model.message {
                    ServerNotice(title: nil, text: m.text, kind: m.kind, onClose: { model.message = nil })
                }
                content
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(L.t("Zamanlanmış görevler"))
        .toolbar {
            ToolbarItemGroup {
                Button { model.reload() } label: { Label(L.t("Yenile"), icon: .refresh) }
                    .disabled(model.loading)
                Button { model.edit(nil) } label: { Label(L.t("Yeni görev"), icon: .add) }
                    .disabled(!model.signedIn || !model.canEdit)
            }
        }
        .onAppear { model.reload() }
        .sheet(item: $model.sheet) { sheet in
            switch sheet {
            case .editor(_, let request): ScheduledTaskEditor(model: model, request: request)
            case .confirm(_, let request): ScheduledTaskConfirm(model: model, request: request)
            case .history(_, let task): ScheduledRunsSheet(model: model, task: task)
            }
        }
        .confirmationDialog(L.f("{0} silinsin mi?", model.deleting?.name ?? ""),
                            isPresented: Binding(get: { model.deleting != nil }, set: { if !$0 { model.deleting = nil } }),
                            titleVisibility: .visible,
                            presenting: model.deleting) { task in
            Button(L.t("Sil"), role: .destructive) { model.delete(task) }
            Button(L.t("Vazgeç"), role: .cancel) {}
        } message: { _ in
            Text(L.t("Görev ve çalışma geçmişi silinir; bu geri alınamaz."))
        }
    }

    @ViewBuilder
    private var content: some View {
        if !model.signedIn {
            ServerNotice(title: nil, text: L.t("Zamanlanmış görevleri görmek için oturum aç."), kind: .info,
                         actionTitle: L.t("Oturum aç…"), action: { model.showPanel() })
        } else if !model.loaded {
            ProgressView().controlSize(.small)
        } else if let error = model.loadError {
            ServerNotice(title: nil, text: error, kind: .error, actionTitle: L.t("Yenile"), action: { model.reload() })
        } else {
            if !model.canEdit {
                ServerNotice(title: nil, text: ScheduleText.readOnly, kind: .info)
            }
            if model.tasks.isEmpty {
                Text(L.t("Henüz zamanlanmış görev yok. Yedek, temizlik ya da rapor gibi düzenli işleri burada tanımla; zamanı gelince sunucu çalıştırır."))
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(model.tasks) { task in
                ScheduledTaskRow(model: model, task: task)
            }
        }
    }
}

/// The last run's status as a coloured badge.
struct RunBadge: View {
    let status: String?

    private var color: Color {
        switch ScheduleText.tone(status) {
        case "good": return .green
        case "bad": return .red
        case "warn": return .orange
        case "busy": return .blue
        default: return .gray
        }
    }

    var body: some View {
        Text(ScheduleText.status(status))
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(color))
    }
}

struct ScheduledTaskRow: View {
    @ObservedObject var model: ScheduledTasksModel
    let task: ScheduledTask

    private var nextText: String {
        if !task.enabled { return L.t("Kapalı: zamanında çalışmaz.") }
        guard let next = task.nextRunAt else { return L.t("Sonraki çalışma yok.") }
        return L.f("Sonraki çalışma: {0}", ScheduleText.localTime(next))
    }

    private var lastText: String {
        guard let last = task.lastRun else { return "" }
        return L.f("Son çalışma: {0}", ScheduleText.localTime(last.shownAt))
    }

    var body: some View {
        let canEdit = model.canEdit
        let where_: String = model.targetLabel(task.target)
        let when: String = ScheduleText.describe(task.schedule)
        GroupBox {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(task.name).font(.body.weight(.semibold)).lineLimit(1).truncationMode(.tail)
                    Text(where_ + " · " + when).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Text(nextText).font(.caption).foregroundStyle(.secondary)
                    Text(task.command).font(.caption.monospaced()).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.tail).textSelection(.enabled).help(task.command)
                }
                Spacer(minLength: 8)
                RunBadge(status: task.lastRun?.status).help(lastText)
                Toggle("", isOn: Binding(get: { task.enabled }, set: { model.setEnabled(task, $0) }))
                    .toggleStyle(.switch).labelsHidden().disabled(!canEdit)
                    .help(task.enabled ? L.t("Açık") : L.t("Kapalı"))
                icon(.play, L.t("Şimdi çalıştır"), enabled: canEdit) { model.runNow(task) }
                icon(.history, L.t("Çalışma geçmişi"), enabled: true) { model.sheet = .history(UUID(), task) }
                icon(.edit, L.t("Düzenle"), enabled: canEdit) { model.edit(task) }
                icon(.delete, L.t("Sil"), enabled: canEdit) { model.deleting = task }
            }
            .padding(6)
        }
    }

    private func icon(_ name: WCIconName, _ tip: String, enabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { WCIcon(name) }
            .buttonStyle(.borderless)
            .help(tip)
            .accessibilityLabel(tip)
            .disabled(!enabled)
    }
}

// MARK: - editor

struct ScheduledTaskEditor: View {
    @ObservedObject var model: ScheduledTasksModel
    let request: ScheduledTasksModel.EditorRequest
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var about: String
    @State private var targetId = ""
    @State private var choices: [TargetChoice] = []
    @State private var command: String
    @State private var mode: Int
    @State private var clock: Date
    @State private var weekday: Int
    @State private var minutes: Int
    @State private var onceAt: Date
    @State private var expr: String
    @State private var timezone: String
    @State private var timeout: Int
    @State private var notify: String
    @State private var enabled: Bool
    @State private var error: String?
    @State private var preview = ""

    init(model: ScheduledTasksModel, request: ScheduledTasksModel.EditorRequest) {
        self.model = model
        self.request = request
        let d = request.draft
        let form = ScheduleText.form(d.schedule)
        let calendar = Calendar.current
        let clockDate: Date = calendar.date(bySettingHour: form.hour, minute: form.minute, second: 0, of: Date()) ?? Date()
        _name = State(initialValue: d.name)
        _about = State(initialValue: d.description ?? "")
        _command = State(initialValue: d.command)
        _mode = State(initialValue: form.mode)
        _clock = State(initialValue: clockDate)
        _weekday = State(initialValue: form.weekday)
        _minutes = State(initialValue: form.minutes)
        _onceAt = State(initialValue: form.at ?? Date().addingTimeInterval(3600))
        _expr = State(initialValue: form.expr)
        _timezone = State(initialValue: d.timezone)
        _timeout = State(initialValue: d.timeoutSec)
        _notify = State(initialValue: d.notify)
        _enabled = State(initialValue: d.enabled)
        _error = State(initialValue: request.error)
    }

    private var chosen: TaskTarget? { choices.first { $0.id == targetId }?.target }

    private func currentSchedule() -> TaskSchedule {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: clock)
        let hour = parts.hour ?? 3
        let minute = parts.minute ?? 0
        switch mode {
        case 0: return .daily(hour: hour, minute: minute)
        case 1: return .weekly(weekday: weekday, hour: hour, minute: minute)
        case 2: return .interval(minutes)
        case 3:
            let whole = floor(onceAt.timeIntervalSince1970 / 60) * 60
            return .once(Date(timeIntervalSince1970: whole))
        default: return .cron(expr)
        }
    }

    private var previewKey: String {
        let s = currentSchedule()
        let at: String = s.at.map { ScheduleText.utc($0) } ?? ""
        let parts: [String] = [s.kind, s.expr ?? "", String(s.minutes ?? 0), at, timezone]
        return parts.joined(separator: "|")
    }

    private var targetHint: String {
        guard let t = chosen else { return "" }
        if t.isSsh {
            return L.t("Kayıtlı SSH sunucusundaki görevi bu bilgisayardaki uygulama çalıştırır: o sırada uygulama açık ve oturumu açık olmalı, sunucuya parola sorulmadan bağlanabilmeli. 15 dakika içinde çalıştırılamazsa Kaçırıldı sayılır.")
        }
        return L.t("Görevi cihazdaki ajan çalıştırır (bilgisayarın kapalı olsa da). Ajanın kendi kuralları (kısıtlı mod, izin listesi) yine geçerlidir; cihaz o sırada çevrimdışıysa Kaçırıldı sayılır.")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(request.existing == nil ? L.t("Yeni zamanlanmış görev") : L.t("Zamanlanmış görevi düzenle"))
                .font(.title2.weight(.semibold))
            if let error {
                ServerNotice(title: nil, text: error, kind: .error)
            }
            Form {
                Section {
                    TextField(L.t("Ad"), text: $name, prompt: Text(L.t("Gece yedeği")))
                    TextField(L.t("Açıklama (isteğe bağlı)"), text: $about)
                    Picker(L.t("Hedef"), selection: $targetId) {
                        if choices.isEmpty {
                            Text(L.t("Hedef yok: önce bir cihaz bağla ya da sunucu ekle")).tag("")
                        }
                        ForEach(choices) { c in Text(c.label).tag(c.id) }
                    }
                    if !targetHint.isEmpty {
                        Text(targetHint).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L.t("Komut"))
                        TextEditor(text: $command)
                            .font(.body.monospaced())
                            .frame(minHeight: 80, maxHeight: 120)
                            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.secondary.opacity(0.3)))
                    }
                }
                Section {
                    scheduleFields
                    TextField(L.t("Saat dilimi (IANA, ör. Europe/Istanbul)"), text: $timezone)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L.t("Sonraki 5 çalışma (bu bilgisayarın saatiyle)")).fontWeight(.semibold)
                        Text(preview).font(.caption.monospaced()).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                }
                Section {
                    Stepper(value: $timeout, in: 10...3600, step: 10) {
                        Text(L.t("Zaman aşımı (saniye, 10–3600)") + ": " + String(timeout))
                    }
                    Picker(L.t("Bildirim (e-posta ve uygulama içi)"), selection: $notify) {
                        ForEach(ScheduleText.notifyValues, id: \.self) { v in Text(ScheduleText.notifyLabel(v)).tag(v) }
                    }
                    Toggle(L.t("Etkin (zamanı gelince çalışsın)"), isOn: $enabled)
                }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button(L.t("Vazgeç")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(L.t("Devam")) { proceed() }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 600, height: 680)
        .task {
            choices = await model.targets(keeping: request.draft.target)
            if let current = request.draft.target, let match = choices.first(where: { $0.target.sameAs(current) }) {
                targetId = match.id
            } else if targetId.isEmpty, let first = choices.first {
                targetId = first.id
            }
        }
        .task(id: previewKey) { await refreshPreview() }
    }

    @ViewBuilder
    private var scheduleFields: some View {
        Picker(L.t("Zamanlama"), selection: $mode) {
            Text(L.t("Her gün saat …")).tag(0)
            Text(L.t("Her hafta …")).tag(1)
            Text(L.t("Her N dakikada bir")).tag(2)
            Text(L.t("Bir kez …")).tag(3)
            Text(L.t("Gelişmiş: cron")).tag(4)
        }
        if mode == 1 {
            Picker(L.t("Gün"), selection: $weekday) {
                ForEach(ScheduleText.weekOrder, id: \.self) { d in Text(ScheduleText.day(d)).tag(d) }
            }
        }
        if mode == 0 || mode == 1 {
            DatePicker(L.t("Saat"), selection: $clock, displayedComponents: .hourAndMinute)
        }
        if mode == 2 {
            Stepper(value: $minutes, in: 5...10080, step: 5) {
                Text(L.t("Kaç dakikada bir (5–10080)") + ": " + String(minutes))
            }
        }
        if mode == 3 {
            DatePicker(L.t("Tarih"), selection: $onceAt, displayedComponents: [.date, .hourAndMinute])
        }
        if mode == 4 {
            TextField(L.t("Cron ifadesi (dakika saat gün ay haftanın günü)"), text: $expr, prompt: Text("0 3 * * *"))
                .font(.body.monospaced())
        }
    }

    private func refreshPreview() async {
        try? await Task.sleep(nanoseconds: 500_000_000)
        if Task.isCancelled { return }
        let schedule = currentSchedule()
        let words = ScheduleText.describe(schedule)
        if schedule.kind == "cron" && !CronShape.looksValid(schedule.expr) {
            preview = L.t("Cron ifadesi beş alandan oluşmalı (dakika saat gün ay haftanın günü).")
            return
        }
        preview = words + "\n" + L.t("Hesaplanıyor…")
        let zone = timezone.trimmingCharacters(in: .whitespaces)
        let answer = await model.preview(schedule, timezone: zone)
        if Task.isCancelled { return }
        switch answer {
        case .times(let next):
            if next.isEmpty {
                preview = words + "\n" + L.t("Bu zamanlamayla bir daha çalışmaz.")
            } else {
                let lines: [String] = next.map { ScheduleText.localTime($0) }
                preview = words + "\n" + lines.joined(separator: "\n")
            }
        case .problem(let text):
            preview = text
        }
    }

    private func proceed() {
        var next = ScheduledTaskDraft()
        next.name = name
        next.description = about
        next.target = chosen
        next.command = command
        next.schedule = currentSchedule()
        let zone = timezone.trimmingCharacters(in: .whitespaces)
        next.timezone = zone.isEmpty ? ScheduleText.defaultTimeZone() : zone
        next.enabled = enabled
        next.timeoutSec = timeout
        next.notify = notify
        if let problem = next.validate(now: Date()) {
            error = problem
            return
        }
        model.confirm(request.existing, next)
    }
}

// MARK: - confirmation

/// Shows the exact command and target before anything is saved.
struct ScheduledTaskConfirm: View {
    @ObservedObject var model: ScheduledTasksModel
    let request: ScheduledTasksModel.EditorRequest
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false

    var body: some View {
        let d = request.draft
        let target: String = d.target.map { model.targetLabel($0) } ?? "?"
        let schedule: String = ScheduleText.describe(d.schedule)
        VStack(alignment: .leading, spacing: 12) {
            Text(L.t("Komutu onayla")).font(.title2.weight(.semibold))
            Text(L.t("Bu komut aşağıdaki hedefte, zamanı geldikçe her seferinde onay sorulmadan çalışacak. Kaydetmeden önce kontrol et."))
                .fixedSize(horizontal: false, vertical: true)
            Text(L.f("Hedef: {0}", target)).fontWeight(.semibold).fixedSize(horizontal: false, vertical: true)
            Text(L.f("Zamanlama: {0} ({1})", schedule, d.timezone)).fixedSize(horizontal: false, vertical: true)
            Text(L.t("Komut:")).foregroundStyle(.secondary)
            ScrollView {
                Text(d.command)
                    .font(.body.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
            }
            .frame(maxHeight: 180)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.12)))
            Text(L.f("Zaman aşımı: {0} sn · {1}", d.timeoutSec, ScheduleText.notifyLabel(d.notify)))
                .font(.caption).foregroundStyle(.secondary)
            if !d.enabled {
                Text(L.t("Görev kapalı kaydedilecek; açana kadar zamanında çalışmaz."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button(L.t("Geri dön")) { model.backToEditor(request.existing, d) }
                Spacer()
                Button(L.t("Vazgeç")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(request.existing == nil ? L.t("Oluştur") : L.t("Kaydet")) {
                    saving = true
                    model.save(request.existing, d)
                }
                .keyboardShortcut(.defaultAction)
                .buttonStyle(.borderedProminent)
                .disabled(saving)
            }
        }
        .padding(20)
        .frame(width: 560)
    }
}

// MARK: - runs

struct ScheduledRunsSheet: View {
    @ObservedObject var model: ScheduledTasksModel
    let task: ScheduledTask
    @Environment(\.dismiss) private var dismiss
    @State private var runs: [TaskRun] = []
    @State private var loaded = false
    @State private var failure: String?
    @State private var selected = ""

    private func details(_ r: TaskRun) -> String {
        var parts: [String] = []
        if let e = r.error, !e.trimmingCharacters(in: .whitespaces).isEmpty { parts.append(L.t("Hata: ") + e) }
        let output = r.output ?? ""
        parts.append(output.isEmpty ? L.t("(çıktı yok)") : output)
        return parts.joined(separator: "\n\n")
    }

    private var selectedDetails: String {
        guard let run = runs.first(where: { $0.id == selected }) else { return "" }
        return details(run)
    }

    private func line(_ r: TaskRun) -> String {
        var parts: [String] = [ScheduleText.localTime(r.startedAt ?? r.scheduledFor)]
        parts.append(r.trigger == "manual" ? L.t("Elle başlatıldı") : L.t("Zamanında"))
        if let code = r.exitCode { parts.append(L.f("çıkış kodu {0}", code)) }
        if let s = r.startedAt, let f = r.finishedAt {
            let secs = max(0, Int(f.timeIntervalSince(s).rounded()))
            parts.append(L.f("{0} sn", secs))
        }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L.f("{0}: çalışma geçmişi", task.name)).font(.title2.weight(.semibold)).lineLimit(2)
            if let failure {
                ServerNotice(title: nil, text: failure, kind: .error)
            } else if !loaded {
                ProgressView().controlSize(.small)
            } else if runs.isEmpty {
                Text(L.t("Bu görev henüz hiç çalışmadı.")).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(runs) { r in
                            Button { selected = r.id } label: {
                                HStack(spacing: 10) {
                                    RunBadge(status: r.status)
                                    Text(line(r)).foregroundStyle(.secondary).lineLimit(1)
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 4).padding(.horizontal, 6)
                                .background(RoundedRectangle(cornerRadius: 5).fill(selected == r.id ? Color.accentColor.opacity(0.18) : Color.clear))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(height: 170)
                Text(L.t("Çıktı (stdout ve stderr, en fazla 64 KiB, sonu tutulur)"))
                    .font(.caption).foregroundStyle(.secondary)
                ScrollView([.vertical, .horizontal]) {
                    Text(selectedDetails)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(minHeight: 220)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.10)))
            }
            HStack { Spacer(); Button(L.t("Kapat")) { dismiss() }.keyboardShortcut(.cancelAction) }
        }
        .padding(20)
        .frame(width: 680, height: 560, alignment: .top)
        .task {
            switch await model.runs(task) {
            case .success(let list):
                runs = list
                selected = list.first?.id ?? ""
            case .failure(let e):
                failure = ScheduleText.error(e)
            }
            loaded = true
        }
    }
}
