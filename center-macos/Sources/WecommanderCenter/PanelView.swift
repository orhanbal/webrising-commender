import AppKit
import CenterCore
import SwiftUI

/// The panel in the menu bar popover: macOS controls only (segmented tabs,
/// grouped forms, bordered buttons, system colours), light and dark mode.
struct PanelView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Header(model: model)
            Banners(model: model)
            switch model.phase {
            case .signedOut: SignedOutView(model: model)
            case .linking: LinkingView(model: model)
            case .signedIn: SignedInView(model: model)
            }
            Spacer(minLength: 0)
            if model.phase == .signedIn, let last = model.lastSync {
                Text(L.f("Son eşitleme: {0} sn önce", max(0, Int(model.now.timeIntervalSince(last)))))
                    .font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(14)
        .frame(width: 380, height: 560, alignment: .top)
    }
}

private struct Header: View {
    @ObservedObject var model: AppModel
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                if let image = NSImage(named: scheme == .dark ? "wordmark-light-text" : "wordmark-dark-text") {
                    Image(nsImage: image).resizable().scaledToFit().frame(height: 15)
                } else {
                    Text("WECOMMANDER").font(.headline)
                }
                Text(L.t("Yönetim Merkezi")).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if model.phase == .signedIn {
                VStack(alignment: .trailing, spacing: 1) {
                    if let me = model.me {
                        Text([me.email, me.organizationName].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    Button(L.t("Oturumu kapat")) { Task { await model.signOut() } }
                        .buttonStyle(.link).font(.caption)
                }
            }
        }
    }
}

private struct Banners: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 6) {
            if model.phase == .signedIn && model.notificationsBlocked {
                Callout(icon: .notification, tint: .orange, title: L.t("macOS bildirimleri kapalı"),
                        text: Texts.notificationBlockedMessage(model.notificationState)) {
                    Button(L.t("Bildirimlere izin ver")) { Notifier.openSettings() }
                }
            } else if model.phase == .signedIn && model.settings.notifications && model.notificationState == "notDetermined" {
                Callout(icon: .notificationBadge, tint: .blue, title: L.t("Bildirim izni"),
                        text: Texts.notificationBlockedMessage("notDetermined")) {
                    Button(L.t("Bildirimlere izin ver")) { model.notifier.requestPermission() }
                }
            }
            if model.phase == .signedIn, let agent = model.agent, agent.state == .stopped, !model.agentBusy {
                Callout(icon: .flashOff, tint: .red,
                        title: agent.enabled ? L.t("Bu Mac'teki ajan çalışmıyor") : L.t("Bu Mac'teki ajan kapalı"),
                        text: Texts.agentOffWarning) {
                    Button(L.t("Ajanı başlat")) { Task { await model.setAgentEnabled(true) } }
                }
            }
            if model.phase == .signedIn && !model.autonomy.isEmpty {
                Callout(icon: .flash, tint: .orange, title: L.t("Otonom mod açık"),
                        text: L.f("{0} cihazda onay istenmiyor.", model.autonomy.count)) { EmptyView() }
            }
            if let error = model.error {
                Callout(icon: .warning, tint: .red, title: L.t("Hata"), text: error) {
                    Button(L.t("Kapat")) { model.error = nil }
                }
            }
        }
    }
}

private struct Callout<Actions: View>: View {
    let icon: WCIconName
    let tint: Color
    let title: String
    let text: String
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            WCIcon(icon, size: 15).foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.callout.weight(.semibold))
                if !text.isEmpty { Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                actions().controlSize(.small)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: signed out / linking

private struct SignedOutView: View {
    @ObservedObject var model: AppModel
    @State private var server = ""
    @State private var name = Host.current().localizedName ?? "Mac"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L.t("Oturum aç")).font(.title3.weight(.semibold))
            Text(L.t("Bu Mac tüm cihazlarındaki onay isteklerini bildirim olarak alır; onaylar, reddeder ve otonom modu yönetirsin. Şifren bu uygulamaya girmez: oturumu tarayıcıda açarsın."))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Form {
                TextField(L.t("Sunucu adresi"), text: $server)
                TextField(L.t("Bu bilgisayarın adı"), text: $name)
            }
            .formStyle(.grouped)
            .frame(height: 120)
            Button {
                Task { await model.connect(server: server, name: name) }
            } label: {
                Text(L.t("Tarayıcıda oturum aç")).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .disabled(model.busy)
        }
        .onAppear { if server.isEmpty { server = model.settings.server } }
    }
}

private struct LinkingView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L.t("Tarayıcıda onayla")).font(.title3.weight(.semibold))
            Text(L.t("Açılan sayfada hesabınla giriş yap ve \"Bu Yönetim Merkezini bağla\"ya bas. Onaylayınca burası kendiliğinden açılır."))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            ProgressView().controlSize(.small)
            HStack {
                Button(L.t("Sayfayı yeniden aç")) { model.reopenLink() }
                Button(L.t("Vazgeç")) { model.cancelLink() }
            }
        }
    }
}

// MARK: signed in

private enum Tab: String, CaseIterable, Identifiable {
    case approvals = "Onaylar", autonomy = "Otonom mod", devices = "Cihazlar", settings = "Ayarlar"
    var id: String { rawValue }
}

private struct SignedInView: View {
    @ObservedObject var model: AppModel
    @State private var tab: Tab = .approvals

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("", selection: $tab) {
                ForEach(Tab.allCases) { t in
                    Text(t == .approvals && !model.pending.isEmpty ? L.f("Onaylar ({0})", model.pending.count) : L.t(t.rawValue)).tag(t)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            ScrollView {
                switch tab {
                case .approvals: ApprovalsView(model: model)
                case .autonomy: AutonomyView(model: model)
                case .devices: DevicesView(model: model)
                case .settings: SettingsView(model: model)
                }
            }
        }
    }
}

private struct ApprovalsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 8) {
            if model.pending.isEmpty {
                VStack(spacing: 8) {
                    WCIcon(.check, size: 32).foregroundStyle(.secondary)
                    Text(L.t("Bekleyen onay yok. Yapay zekâ yüksek riskli bir işlem istediğinde bildirim gelir; oradan ya da buradan onaylarsın."))
                        .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .padding(.top, 40).padding(.horizontal, 12)
            }
            ForEach(model.pending) { item in
                ApprovalCard(model: model, item: item)
            }
        }
    }
}

private struct ApprovalCard: View {
    @ObservedObject var model: AppModel
    let item: ApprovalRequest
    @State private var confirming: Bool?
    @State private var working = false
    @State private var failure: String?

    var body: some View {
        let expired = item.expiresAt <= model.now
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(model.placeName(item)).font(.callout.weight(.semibold))
                Text(Texts.kindLabel(item.actionKind)).font(.callout).foregroundStyle(.secondary)
                Spacer()
                Text(Texts.remaining(item.expiresAt, now: model.now))
                    .font(.caption.monospacedDigit()).foregroundStyle(expired ? .red : .secondary)
            }
            if !item.summary.isEmpty {
                Text(item.summary)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: 6))
            }
            ProgressView(value: Texts.remainingFraction(created: item.createdAt, expires: item.expiresAt, now: model.now))
                .progressViewStyle(.linear).tint(expired ? .red : .accentColor)
            if let failure {
                Text(failure).font(.caption).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            if let approve = confirming {
                Text(approve ? L.t("Bu işlemi bir kez çalıştırmasına izin veriyor musun?") : L.t("Bu isteği reddetmek istiyor musun?"))
                    .font(.caption)
                HStack {
                    Button(approve ? L.t("Evet, onayla") : L.t("Evet, reddet")) { decide(approve) }
                        .buttonStyle(.borderedProminent).tint(approve ? .accentColor : .red)
                    Button(L.t("Vazgeç")) { confirming = nil }
                }
                .disabled(working)
            } else {
                HStack {
                    Button(L.t("Onayla")) { confirming = true }.buttonStyle(.borderedProminent)
                    Button(L.t("Reddet")) { confirming = false }
                }
                .disabled(expired || working)
            }
        }
        .padding(12)
        .background(.background.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))
    }

    private func decide(_ approve: Bool) {
        working = true
        failure = nil
        Task {
            do {
                try await model.decide(id: item.id, approve: approve)
            } catch {
                failure = error.localizedDescription
            }
            working = false
            confirming = nil
        }
    }
}

private struct AutonomyView: View {
    @ObservedObject var model: AppModel
    @State private var scopeAll = true
    @State private var selected = Set<String>()
    @State private var duration = 1
    @State private var password = ""
    @State private var working = false
    @State private var message: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !model.autonomy.isEmpty {
                GroupBox(L.t("Şu an açık")) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(model.autonomy) { a in
                            HStack {
                                Text(a.name)
                                Spacer()
                                Text(Texts.until(a.trustFullUntil)).foregroundStyle(.secondary)
                            }
                            .font(.callout)
                        }
                        Button(L.t("Hepsini durdur")) { run { try await model.stopAutonomy() } }
                            .padding(.top, 4)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Text(L.t("Seçilen cihazlarda yüksek riskli işlemler onay istemeden çalışır. Cihazın kendi sınırları (izinli klasörler, yazma/komut kapalı, sır gizleme) yine geçerlidir; her işlem denetim kaydına girer. Süre bitince onaylar kendiliğinden geri gelir."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Picker(L.t("Kapsam"), selection: $scopeAll) {
                Text(L.t("Tüm cihazlar")).tag(true)
                Text(L.t("Seçtiğim cihazlar")).tag(false)
            }
            .pickerStyle(.radioGroup)
            if !scopeAll {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(model.devices) { d in
                        Toggle(d.name, isOn: Binding(
                            get: { selected.contains(d.id) },
                            set: { if $0 { selected.insert(d.id) } else { selected.remove(d.id) } }))
                    }
                }
                .padding(.leading, 18)
            }
            Picker(L.t("Süre"), selection: $duration) {
                ForEach(Array(Durations.choices.enumerated()), id: \.offset) { i, label in
                    Text(label).tag(i)
                }
            }
            SecureField(L.t("Hesap şifren"), text: $password)
                .textFieldStyle(.roundedBorder)
            if let message { Text(message).font(.caption).foregroundStyle(.red) }
            Button {
                let ids = scopeAll ? nil : Array(selected)
                run {
                    try await model.startAutonomy(choice: duration, deviceIds: ids, password: password)
                    password = ""
                }
            } label: { Text(L.t("Otonom modu başlat")).frame(maxWidth: .infinity) }
            .buttonStyle(.borderedProminent)
            .disabled(password.isEmpty || working || (!scopeAll && selected.isEmpty))
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        working = true
        message = nil
        Task {
            do { try await action() } catch { message = error.localizedDescription }
            working = false
        }
    }
}

private struct DevicesView: View {
    @ObservedObject var model: AppModel
    @State private var editing: Device?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            AgentCard(model: model)
                .padding(.bottom, 6)
            if model.devices.isEmpty {
                Text(L.t("Henüz cihaz yok.")).font(.callout).foregroundStyle(.secondary)
            }
            ForEach(model.devices) { d in
                HStack(spacing: 10) {
                    Circle().fill(d.online ? Color.green : Color.secondary.opacity(0.4)).frame(width: 8, height: 8)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(d.name).font(.callout.weight(.medium))
                        Text([d.platform ?? "", d.online ? L.t("çevrimiçi") : L.t("çevrimdışı"), Texts.trustLabel(d.trustLevel),
                              d.runAs == "root" ? "root" : "", d.safetyNet == false ? L.t("güvenlik ağı kapalı") : ""]
                                .filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    // AI permissions (trust, run as root, safety net) are changed right here; widening asks for the password.
                    Button(L.t("Agent Yetkilendirme")) { editing = d }
                        .buttonStyle(.link).font(.caption)
                }
                .padding(8)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            }
        }
        .sheet(item: $editing) { device in
            DevicePermissionsView(model: model, device: device) { editing = nil }
        }
    }
}

/// Agent permissions of one device, edited in the app (docs/AI_PERMISSIONS.md).
private struct DevicePermissionsView: View {
    @ObservedObject var model: AppModel
    let device: Device
    let close: () -> Void

    private static let order = ["strict": 0, "standard": 1, "full": 2]
    private static let durations: [Int?] = [60, 8 * 60, 24 * 60, 7 * 24 * 60, nil]

    @State private var level = "standard"
    @State private var duration: Int? = 60
    @State private var durationTouched = false
    @State private var root = false
    @State private var safetyNet = true
    @State private var password = ""
    @State private var working = false
    @State private var failure: String?

    private var currentLevel: String {
        if device.trustLevel == "full", let until = device.trustFullUntil, until <= Date() { return "standard" }
        return device.trustLevel == "strict" || device.trustLevel == "full" ? device.trustLevel! : "standard"
    }
    private var wasRoot: Bool { device.runAs == "root" }
    private var hadNet: Bool { device.safetyNet != false }
    private var trustChanged: Bool { level != currentLevel || (level == "full" && durationTouched) }
    private var widens: Bool {
        (trustChanged && (level == "full" || (Self.order[level] ?? 1) > (Self.order[currentLevel] ?? 1)))
            || (!wasRoot && root) || (hadNet && !safetyNet)
    }
    private var changed: Bool { trustChanged || root != wasRoot || safetyNet != hadNet }

    private static func label(_ minutes: Int?) -> String {
        switch minutes {
        case 60: return L.t("1 saat")
        case 480: return L.t("8 saat")
        case 1440: return L.t("24 saat")
        case 10080: return L.t("7 gün")
        default: return L.t("Süresiz")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("\(L.t("Agent Yetkilendirme")) · \(device.name)").font(.headline)
            Picker(L.t("Onay düzeyi"), selection: $level) {
                Text(L.t("Sıkı: okuma dahil her işlem onay ister")).tag("strict")
                Text(L.t("Standart: okuma serbest, değişiklikler onay ister")).tag("standard")
                Text(L.t("Otonom: onay istenmez")).tag("full")
            }
            .pickerStyle(.radioGroup)
            if level == "full" {
                Picker(L.t("Otonom süresi"), selection: Binding(get: { duration }, set: { duration = $0; durationTouched = true })) {
                    ForEach(Self.durations, id: \.self) { m in Text(Self.label(m)).tag(m) }
                }
                .frame(maxWidth: 260)
            }
            Toggle(L.t("Komutları root olarak çalıştır"), isOn: $root)
                .disabled(!wasRoot && device.rootCapable != true)
            if !wasRoot && device.rootCapable != true {
                Text(L.t("Bu bilgisayarda root izni verilmemiş. Önce o makinede ajan root izniyle kurulmalı."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Toggle(L.t("Güvenlik ağı (yıkıcı komutları her zaman engeller)"), isOn: $safetyNet)
            if widens {
                SecureField(L.t("Hesap şifren (yetkiyi genişletmek için)"), text: $password)
                    .textFieldStyle(.roundedBorder)
            }
            if let failure {
                Text(failure).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Button(L.t("Web panelinde aç")) { model.openDevicePermissions(device.id) }
                    .buttonStyle(.link)
                Spacer()
                Button(L.t("Vazgeç"), action: close).keyboardShortcut(.cancelAction)
                Button(L.t("Kaydet")) { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(working || !changed || (widens && password.isEmpty))
            }
        }
        .padding(20)
        .frame(width: 420)
        .onAppear {
            level = currentLevel
            root = wasRoot
            safetyNet = hadNet
        }
        .onChange(of: password) { _ in failure = nil }
    }

    private func save() {
        working = true
        failure = nil
        let lvl = trustChanged ? level : nil
        let pw = widens ? password : nil
        Task {
            do {
                try await model.setDevicePermissions(device, level: lvl, minutes: duration, root: root, safetyNet: safetyNet, password: pw)
                close()
            } catch {
                failure = error.localizedDescription
            }
            working = false
        }
    }
}

/// L.t("Bu Mac'teki ajan"): state and the "Ajan çalışsın" switch.
private struct AgentCard: View {
    @ObservedObject var model: AppModel
    @State private var confirmOff = false

    private var color: Color {
        switch model.agent?.state {
        case .running: return .green
        case .stopped: return .red
        default: return .secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L.t("Bu Mac'teki ajan")).font(.callout.weight(.semibold))
            HStack(spacing: 8) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(model.agentBusy ? L.t("İşleniyor…") : Texts.agentStateLabel(model.agent)).font(.callout)
                if model.agentBusy { ProgressView().controlSize(.small) }
                Spacer()
                Toggle(L.t("Ajan çalışsın"), isOn: Binding(
                    get: { model.agent?.running ?? model.settings.agentKeepRunning },
                    set: { on in
                        if on { Task { await model.setAgentEnabled(true) } } else { confirmOff = true }
                    }))
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .disabled(model.agentBusy || model.agent == nil || model.agent?.state == .notInstalled)
            }
            Text(help).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if model.isEmbedded {
                // The agent ships with the app: one version, one update button.
                HStack(spacing: 8) {
                    if model.agentUpdateAvailable {
                        Button(L.t("Yeni sürüm var — Uygulamayı güncelle")) { model.updateAgent() }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.updating)
                    } else {
                        Button(L.t("Güncellemeleri denetle")) { model.updateAgent() }
                            .disabled(model.updating)
                    }
                    if model.updating { ProgressView().controlSize(.small) }
                    Text(L.t("Sürüm: ") + (model.appBuild.map(AppVersion.of) ?? model.agentVersion ?? L.t("geliştirici sürümü"))
                         + (model.agentUpdateAvailable ? L.f(" · yeni: {0}", AppVersion.of(model.latestApp?.build ?? 0)) : model.latestApp != nil ? L.t(" · güncel") : ""))
                        .font(.caption).foregroundStyle(.secondary)
                }
                // A real bar while the update runs: the percent while it downloads, moving while it waits.
                if model.updating {
                    if let progress = model.updateProgress { ProgressView(value: progress) } else { ProgressView().progressViewStyle(.linear) }
                }
                if let message = model.updateMessage {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
            } else {
            HStack(spacing: 8) {
                if model.agent?.state == .notInstalled || model.agentUpdateAvailable {
                    Button(model.agent?.state == .notInstalled ? L.t("Ajanı kur") : L.t("Yeni sürüm var — Ajanı güncelle")) { model.updateAgent() }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.agentBusy)
                } else {
                    Button(L.t("Ajanı güncelle")) { model.updateAgent() }
                        .disabled(model.agentBusy)
                }
                if let version = model.agentVersion {
                    Text(L.f("Kurulu sürüm: {0}", version) + (model.agentUpdateAvailable ? L.f(" · yeni: {0}", AppVersion.of(model.latestAgentBuild ?? 0)) : model.latestAgentBuild != nil ? L.t(" · güncel") : ""))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        .confirmationDialog(L.t("Ajan kapatılsın mı?"), isPresented: $confirmOff) {
            Button(L.t("Ajanı kapat"), role: .destructive) { Task { await model.setAgentEnabled(false) } }
            Button(L.t("Vazgeç"), role: .cancel) {}
        } message: {
            Text(Texts.agentOffWarning + L.t(" Yeniden açana kadar oturum açılışında da başlamaz."))
        }
    }

    private var help: String {
        if model.isEmbedded {
            switch model.agent?.state {
            case .notInstalled: return model.pairing ? L.t("Bu Mac hesabına bağlanıyor…") : Texts.embeddedNotPaired
            case .running: return Texts.embeddedRunning
            default: return Texts.agentOffWarning
            }
        }
        switch model.agent?.state {
        case .notInstalled: return Texts.agentNotInstalled
        case .running: return L.t("Açıkken ajan durursa Yönetim Merkezi onu kendiliğinden yeniden başlatır ve bildirim gösterir.")
        default: return Texts.agentOffWarning
        }
    }
}

private struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var loginItem = LoginItem.enabled

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            LanguagePicker(model: model).frame(maxWidth: 260)
            Toggle(L.t("Yeni onay isteğinde bildirim (Onayla / Reddet)"), isOn: Binding(
                get: { model.settings.notifications }, set: { v in model.update { $0.notifications = v } }))
            Toggle(L.t("Yeni onay isteğinde paneli de aç"), isOn: Binding(
                get: { model.settings.openPanelOnRequest }, set: { v in model.update { $0.openPanelOnRequest = v } }))
            Toggle(L.t("Oturum açılışında başlat"), isOn: Binding(
                get: { loginItem }, set: { v in LoginItem.set(v); loginItem = LoginItem.enabled }))
            HStack {
                Button(L.t("Test bildirimi gönder")) { model.sendTestNotification() }
                Button(L.t("Bildirim ayarlarını aç")) { Notifier.openSettings() }
            }
            Text(L.t("Bildirimin ekranda kalması için Sistem Ayarları › Bildirimler › WECOMMANDER Yönetim Merkezi'nde stili \"Uyarılar\" yap. Onayla / Reddet bildirimin \"Seçenekler\" düğmesinde de görünür."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Divider()
            if model.isEmbedded {
                // Also here, not only under Devices: where people look for it first.
                HStack(spacing: 8) {
                    Button(model.agentUpdateAvailable ? L.t("Yeni sürüm var — Uygulamayı güncelle") : L.t("Güncellemeleri denetle")) { model.updateAgent() }
                        .disabled(model.updating)
                    if model.updating { ProgressView().controlSize(.small) }
                }
                if let message = model.updateMessage {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
                Divider()
            }
            HStack {
                Button(L.t("Paneli tarayıcıda aç")) { model.openDashboard() }
                Button(L.t("Oturumu kapat")) { Task { await model.signOut() } }
                Button(L.t("Yenilikler")) { WhatsNew.showAll(model: model) }
            }
            let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
            Text(L.f("Sürüm {0}{1} · {2}", version, model.me.map { L.f(" · bu merkez: {0}", $0.name) } ?? "", model.settings.server))
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .onAppear { loginItem = LoginItem.enabled }
    }
}
