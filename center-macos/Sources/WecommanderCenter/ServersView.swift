import AppKit
import CenterCore
import SwiftTerm
import SwiftUI
import UniformTypeIdentifiers

/// The main window (Termius-class): a sidebar with Sunucular (host cards
/// in groups, search, quick connect), Parçacıklar, Tüneller, Bilinen
/// sunucular and Geçmiş, then the open terminals (SwiftTerm), with Files and
/// Tunnels for the selected terminal. Onaylar opens the menu bar panel.
struct ServersView: View {
    @ObservedObject var model: ServersModel
    @State private var editing: EditRequest?
    @State private var showTunnels = false
    var showPanel: () -> Void = {}

    static let hostsPage = "page:hosts"
    static let terminalsPage = "page:terminals"
    static let scheduledPage = "page:scheduled"
    static let aiPage = "page:ai"
    static let settingsPage = "page:settings"

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 240)
        } detail: {
            detail
                .overlay(alignment: .topTrailing) {
                    if tutorialShown {
                        TutorialCard(model: model, step: model.tutorial, showPanel: showPanel)
                    }
                }
        }
        .sheet(item: $editing) { request in EditHostSheet(model: model, host: request.host) }
        .sheet(item: $model.connect) { request in ConnectSheet(model: model, request: request) }
        .sheet(isPresented: $showTunnels) {
            if let s = model.selectedSession { TunnelsSheet(model: model, session: s) }
        }
        .alert("WECOMMANDER", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button(L.t("Tamam"), role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
        .alert("WECOMMANDER", isPresented: Binding(get: { model.rootSetupDone != nil }, set: { if !$0 { model.rootSetupDone = nil } }),
               presenting: model.rootSetupDone) { done in
            if let url = done.permissionsURL {
                Button(L.t("Web'de yetkileri aç")) {
                    if let u = URL(string: url) { NSWorkspace.shared.open(u) }
                }
            }
            Button(L.t("Tamam"), role: .cancel) {}
        } message: { done in
            Text(done.allow
                ? L.t("Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ikinci anahtar: bir yönetici web panelinde root'u açar.")
                : L.t("Komut terminalde çalışıyor; sudo parolanı orada yaz. Bitince ajan yeniden bağlanır ve cihaz kullanıcı olarak çalışmaya döner."))
        }
        .frame(minWidth: 900, minHeight: 540)
        .onAppear { if model.selection == nil { model.selection = Self.hostsPage } }
    }

    private var sidebar: some View {
        List(selection: Binding(get: { model.selection }, set: { model.selection = $0 })) {
            // The Windows main window's order; settings last, as in its bottom bar.
            Section {
                Label(L.t("Sunucular"), icon: .server, active: model.selection == Self.hostsPage).tag(Self.hostsPage)
                Label(L.t("Terminaller"), icon: .terminal, active: model.selection == Self.terminalsPage).tag(Self.terminalsPage)
                Label(L.t("Anahtarlar"), icon: .key, active: model.selection == "page:keys").tag("page:keys")
                Label(L.t("Kimlikler"), icon: .identity, active: model.selection == "page:identities").tag("page:identities")
                Label(L.t("Parçacıklar"), icon: .snippet, active: model.selection == "page:snippets").tag("page:snippets")
                Label(L.t("Tüneller"), icon: .tunnel, active: model.selection == "page:tunnels").tag("page:tunnels")
                Label(L.t("Bilinen sunucular"), icon: .knownHosts, active: model.selection == "page:known").tag("page:known")
                Label(L.t("Geçmiş"), icon: .history, active: model.selection == "page:history").tag("page:history")
                Label(L.t("Zamanlanmış görevler"), icon: .calendar, active: model.selection == Self.scheduledPage).tag(Self.scheduledPage)
                Label(AiAccessText.sectionTitle, icon: .ai, active: model.selection == Self.aiPage).tag(Self.aiPage)
            }
            Section {
                Label(L.t("Ayarlar"), icon: .settings, active: model.selection == Self.settingsPage).tag(Self.settingsPage)
            }
            if !model.sessions.isEmpty {
                Section(L.t("Açık terminaller")) {
                    ForEach(model.sessions) { session in
                        // Bold: a live terminal, or the selected one.
                        Label(session.host.label, icon: .terminal, active: !session.closed || model.selection == session.id)
                            .foregroundStyle(session.closed ? .secondary : .primary)
                            .tag(session.id)
                            .contextMenu { Button(L.t("Terminali kapat")) { model.close(session) } }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 6) {
                Button { showPanel() } label: { Label(L.t("Onaylar ve bu Mac"), icon: .approvals) }
                    .buttonStyle(.borderless)
                    .tutorialRing(model.tutorial == Tutorial.ai)
                if !model.vaultLabel.isEmpty {
                    Label(L.f("Giriş bilgileri: {0}", model.vaultLabel), icon: .key)
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The tutorial card: adding and connecting a server are shown on the
    /// Servers page; the later steps anywhere but Settings.
    private var tutorialShown: Bool {
        switch model.tutorial {
        case Tutorial.addServer, Tutorial.connect:
            return model.selectedSession == nil && (model.selection == nil || model.selection == Self.hostsPage)
        case Tutorial.status, Tutorial.ai, Tutorial.finish:
            return model.selection != Self.settingsPage
        default:
            return false
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let error = model.coreError {
            ContentUnavailableCompat(title: L.t("Uygulama çekirdeği çalışmıyor"), icon: .warning, text: error)
        } else if let session = model.selectedSession {
            let primary = model.primaryId(of: session.id)
            let group = model.group(primary)
            HStack(spacing: 0) {
                if group.count > 1 {
                    SplitTerminals(model: model, group: group, vertical: model.splitVertical.contains(primary))
                        .id("split-" + primary)
                } else {
                    TerminalHost(model: model, session: session)
                        .id(session.id)
                }
                if model.showFiles {
                    Divider()
                    FilesPane(model: model, session: session)
                        .frame(width: 340)
                        .id("files-" + session.id)
                }
            }
            .navigationTitle(group.count > 1 ? group.map(\.host.label).joined(separator: " | ") : session.host.label)
            .navigationSubtitle(session.host.target)
            .toolbar {
                ToolbarItemGroup {
                    Menu {
                        ForEach([false, true], id: \.self) { vertical in
                            Menu(vertical ? L.t("Alt alta") : L.t("Yan yana")) {
                                Button(L.f("Aynı sunucu ({0})", session.host.label)) { model.split(primary, vertical: vertical, host: session.host) }
                                Divider()
                                ForEach(model.hosts) { h in
                                    Button(h.label) { model.split(primary, vertical: vertical, host: h) }
                                }
                            }
                        }
                    } label: { Label(L.t("Böl"), icon: .split) }
                        .help(L.t("Bu terminalin yanına ya da altına ikinci bir terminal aç (en fazla 4)"))
                        .disabled(group.count >= 4)
                    Toggle(isOn: Binding(get: { model.broadcast.contains(primary) },
                                         set: { on in if on { model.broadcast.insert(primary) } else { model.broadcast.remove(primary) } })) {
                        Label(L.t("Tümüne yaz"), icon: .broadcast, active: model.broadcast.contains(primary))
                    }
                    .help(L.t("Yazdığın her şey bu bölmedeki tüm terminallere gider"))
                    .disabled(group.count < 2)
                    if model.watching[session.id] == nil {
                        Menu {
                            if let share = model.hosting[session.id] {
                                Toggle(L.t("Misafirler yazabilsin"), isOn: Binding(get: { share.allowInput }, set: { share.allowInput = $0 }))
                                Divider()
                                if share.guests.isEmpty { Text(L.t("Henüz izleyen yok")) }
                                ForEach(Array(share.guests.keys), id: \.self) { g in
                                    Button(L.f("Çıkar: {0}", share.guests[g] ?? "")) { share.kick(g) }
                                }
                                Divider()
                                Button(L.t("Paylaşmayı durdur")) { model.stopSharing(session) }
                            } else {
                                Button(L.t("Paylaş: yalnız izlesinler")) { Task { await model.startSharing(session, allowInput: false) } }
                                Button(L.t("Paylaş: yazabilsinler de")) { Task { await model.startSharing(session, allowInput: true) } }
                            }
                        } label: {
                            Label(model.hosting[session.id] != nil ? L.t("Paylaşılıyor") : L.t("Ekiple paylaş"), icon: .share)
                        }
                        .disabled(session.closed)
                    }
                    Button { ServerWindows.show(model, session: session) } label: {
                        Label(L.t("Sunucu yönetimi"), icon: .activity)
                    }
                    .help(L.t("Bu sunucunun disk, bellek, süreç ve temizlik ekranı"))
                    .disabled(session.closed || model.watching[session.id] != nil || !session.host.isSsh)
                    SnippetMenu(model: model, session: session)
                    Button { showTunnels = true } label: { Label(L.t("Tüneller"), icon: .tunnel) }
                        .disabled(session.closed)
                    Toggle(isOn: $model.showFiles) { Label(L.t("Dosyalar"), icon: .folder, active: model.showFiles) }
                        .disabled(session.closed)
                    Button { model.close(session) } label: { Label(L.t("Terminali kapat"), icon: .close) }
                }
            }
        } else {
            switch model.selection ?? "" {
            case "page:snippets": SnippetsPage(model: model)
            case "page:keys": KeysPage(model: model)
            case "page:identities": IdentitiesPage(model: model)
            case "page:settings": SettingsPage(model: model)
            case "page:tunnels": TunnelsPage(model: model)
            case "page:known": KnownHostsPage(model: model)
            case "page:history": HistoryPage(model: model)
            case "page:terminals": TerminalsPage(model: model)
            case "page:scheduled":
                if let scheduled = model.scheduled { ScheduledTasksPage(model: scheduled) }
            case "page:ai":
                if let connector = model.connector { AiAccessPage(model: model, connector: connector) }
            default: HostsPage(model: model, edit: { editing = EditRequest(host: $0) })
            }
        }
    }
}

/// "Terminaller": the open terminals (each opens on a click); empty until a server is connected.
struct TerminalsPage: View {
    @ObservedObject var model: ServersModel

    var body: some View {
        Group {
            if model.sessions.isEmpty {
                ContentUnavailableCompat(title: L.t("Açık terminal yok"), icon: .terminal,
                                         text: L.t("Sunucular'dan birine tıkla; terminal açılır ve kenar çubuğunda \"Açık terminaller\" altında görünür."))
            } else {
                List {
                    ForEach(model.sessions) { session in
                        TerminalListRow(model: model, session: session)
                    }
                }
            }
        }
        .navigationTitle(L.t("Terminaller"))
        .toolbar {
            Button { model.selection = ServersView.hostsPage } label: { Label(L.t("Sunucular"), icon: .server) }
        }
    }
}

struct TerminalListRow: View {
    @ObservedObject var model: ServersModel
    @ObservedObject var session: TerminalSession

    var body: some View {
        HStack(spacing: 10) {
            WCIcon(.terminal, active: !session.closed)
                .foregroundStyle(session.closed ? Color.secondary : Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.host.label).fontWeight(.semibold).lineLimit(1).truncationMode(.tail)
                Text(session.host.target).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 8)
            if session.closed {
                Text(L.t("Terminal kapalı.")).font(.caption).foregroundStyle(.secondary)
            }
            Button(L.t("Terminal aç")) { model.selection = session.id }
            Button { model.close(session) } label: { WCIcon(.close) }
                .buttonStyle(.borderless)
                .help(L.t("Terminali kapat"))
                .accessibilityLabel(L.t("Terminali kapat"))
                .accessibilityLabel(L.t("Terminali kapat"))
        }
        .padding(.vertical, 4)
    }
}

struct RootSetupRequest: Identifiable {
    let id = UUID()
    let host: CoreHost
    let allow: Bool
}

/// "Yapay zekâya root izni ver (bu sunucuda)" / "Root iznini kaldır": what the
/// command does and the exact command, before a new terminal runs it. The
/// person types their sudo password in that terminal; the app never sees it.
struct RootSetupSheet: View {
    @ObservedObject var model: ServersModel
    let request: RootSetupRequest
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(request.allow ? L.f("{0}: yapay zekâya root izni verilsin mi?", request.host.label) : L.f("{0}: root izni kaldırılsın mı?", request.host.label))
                .font(.headline)
            Text(request.allow
                ? L.t("Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, WECOMMANDER ajanının servis kullanıcısına sudo izni veren bir sudoers dosyası yazar (/etc/sudoers.d/wecommander-agent) ve servisin sudo'yu engelleyen kısıtlamalarını gevşetir. Ajan kurulu değilse önce kurar.")
                : L.t("Bu sunucuda yeni bir terminal açılır ve aşağıdaki komut çalışır. Komut, ajanın sudoers dosyasını siler ve servisin kısıtlamalarını geri getirir. Yapay zekâ bu cihazda artık root olarak çalışamaz."))
                .fixedSize(horizontal: false, vertical: true)
            Text(L.t("sudo parolanı terminalde kendin yazarsın; WECOMMANDER parolayı görmez ve saklamaz."))
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if request.allow {
                Text(L.t("Bu yalnız ilk anahtardır: root, bir yönetici web panelinde parolasıyla açana kadar kapalı kalır. Geri almak için: sunucuya sağ tıkla → Root iznini kaldır."))
                    .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Text(L.t("Çalışacak komut")).font(.body.weight(.semibold))
            Text(RootSetup.command(allow: request.allow))
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.secondary.opacity(0.1)))
            HStack {
                Spacer()
                Button(L.t("Vazgeç")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(L.t("Terminalde çalıştır")) {
                    dismiss()
                    model.runRootSetup(request.host, allow: request.allow)
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}

struct EditRequest: Identifiable {
    let id = UUID()
    /// nil: a new host.
    let host: CoreHost?
}

// MARK: - hosts

struct HostsPage: View {
    @ObservedObject var model: ServersModel
    let edit: (CoreHost?) -> Void
    @State private var query = ""
    @State private var showShares = false
    @State private var rootSetup: RootSetupRequest?

    private var filtered: [CoreHost] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return model.hosts }
        return model.hosts.filter {
            $0.label.localizedCaseInsensitiveContains(q) || $0.target.localizedCaseInsensitiveContains(q)
                || ($0.group ?? "").localizedCaseInsensitiveContains(q)
        }
    }

    private var groups: [(String, [CoreHost])] {
        Dictionary(grouping: filtered, by: \.groupName)
            .map { ($0.key, $0.value.sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }) }
            .sorted { a, b in
                if a.0 == CoreHost.noGroup { return false }
                if b.0 == CoreHost.noGroup { return true }
                return a.0.localizedCaseInsensitiveCompare(b.0) == .orderedAscending
            }
    }

    /// The first card on the page (the tutorial's "connect" ring).
    private var firstHostId: String? { groups.first?.1.first?.id }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if model.hosts.isEmpty {
                    ContentUnavailableCompat(title: L.t("Henüz sunucu yok"), icon: .server,
                                             text: L.t("\"Yeni sunucu\" ile ekle ya da ~/.ssh/config dosyandan içe aktar."))
                        .frame(maxWidth: .infinity).padding(.top, 60)
                } else if filtered.isEmpty {
                    Text(query.contains("@") ? L.t("Eşleşen sunucu yok. Return'e basarsan bu adrese hızlı bağlanırım.") : L.t("Eşleşen sunucu yok."))
                        .foregroundStyle(.secondary)
                }
                ForEach(groups, id: \.0) { group in
                    Text("\(group.0)  ·  \(group.1.count)").font(.headline)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), spacing: 10)], spacing: 10) {
                        ForEach(group.1) { host in
                            HostCard(host: host, via: model.hosts.first { $0.id == host.jumpId }?.label)
                                .tutorialRing(model.tutorial == Tutorial.connect && host.id == firstHostId, cornerRadius: 10)
                                .onTapGesture { model.open(host) }
                                .contextMenu {
                                    Button(L.t("Bağlan")) { model.open(host) }
                                    Button(L.t("Düzenle…")) { edit(host) }
                                    Button(host.team == true ? L.t("Ekipten çıkar (yalnız bende kalsın)") : L.t("Ekiple paylaş")) {
                                        Task { await model.setTeam(kind: "host", id: host.id, team: host.team != true) }
                                    }
                                    if host.savedSecret {
                                        Button(L.t("Kayıtlı giriş bilgisini unut")) { Task { await model.forgetSecret(host) } }
                                    }
                                    if RootSetup.applies(host) {
                                        Divider()
                                        Button(L.t("Yapay zekâya root izni ver (bu sunucuda)")) { rootSetup = RootSetupRequest(host: host, allow: true) }
                                        Button(L.t("Root iznini kaldır")) { rootSetup = RootSetupRequest(host: host, allow: false) }
                                    }
                                    Divider()
                                    Button(L.t("Sil"), role: .destructive) { Task { await model.deleteHost(host) } }
                                }
                        }
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle(L.t("Sunucular"))
        .sheet(isPresented: $showShares) { SharesSheet(model: model) }
        .sheet(item: $rootSetup) { request in RootSetupSheet(model: model, request: request) }
        .searchable(text: $query, prompt: L.t("Sunucu ara ya da kullanıcı@adres"))
        .onSubmit(of: .search) { Task { await quickConnect() } }
        .toolbar {
            ToolbarItemGroup {
                Button { showShares = true } label: { Label(L.t("Ortak terminaller"), icon: .team) }
                Button { Task { await model.importSSHConfig() } } label: { Label(L.t("İçe aktar"), icon: .import) }
                Button { edit(nil) } label: { Label(L.t("Yeni sunucu"), icon: .add) }
                    .tutorialRing(model.tutorial == Tutorial.addServer)
            }
        }
    }

    /// "user@host[:port]": saved as a host, then connected.
    private func quickConnect() async {
        let text = query.trimmingCharacters(in: .whitespaces)
        if let match = model.hosts.first(where: { $0.label.caseInsensitiveCompare(text) == .orderedSame || $0.target == text }) {
            model.open(match)
            return
        }
        let parts = text.split(separator: "@", maxSplits: 1).map(String.init)
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return }
        let hostPort = parts[1].split(separator: ":", maxSplits: 1).map(String.init)
        let port = hostPort.count == 2 ? Int(hostPort[1]) ?? 22 : 22
        do {
            try await model.addHost(label: hostPort[0], host: hostPort[0], port: port, user: parts[0], authKind: "key", jumpId: nil)
            query = ""
            if let added = model.hosts.last(where: { $0.host == hostPort[0] && $0.user == parts[0] && ($0.port ?? 22) == port }) {
                model.open(added)
            }
        } catch {
            model.notice = error.localizedDescription
        }
    }
}

/// A27: teammates' shared terminals; joining opens it here.
struct SharesSheet: View {
    @ObservedObject var model: ServersModel
    @Environment(\.dismiss) private var dismiss
    @State private var shares: [ShareInfo] = []
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L.t("Ortak terminaller")).font(.headline)
            if loaded && shares.isEmpty {
                Text(L.t("Şu an ekipte paylaşılan terminal yok. Bir terminalde \"Ekiple paylaş\" ile başlatılır.")).foregroundStyle(.secondary)
            }
            ForEach(shares) { s in
                HStack {
                    VStack(alignment: .leading) {
                        Text(s.title).fontWeight(.semibold)
                        Text(L.f("{0} · {1} izleyen", s.hostEmail, s.guests)).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(L.t("Katıl")) { model.join(s); dismiss() }
                }
            }
            HStack { Spacer(); Button(L.t("Kapat")) { dismiss() }.keyboardShortcut(.cancelAction) }
        }
        .padding(20)
        .frame(width: 460)
        .task { shares = await model.shares(); loaded = true }
    }
}

struct HostCard: View {
    let host: CoreHost
    let via: String?
    var body: some View {
        HStack(spacing: 12) {
            WCIcon(.server, size: 20)
                .foregroundStyle(.white)
                .frame(width: 38, height: 38)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(host.label).font(.body.weight(.semibold)).lineLimit(1)
                Text(host.target + (via.map { " ↪ \($0)" } ?? "")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                HStack(spacing: 6) {
                    Text(host.savedSecret || (host.authKind == "key" && host.keyPath != nil)
                         ? (host.authKind == "password" ? L.t("Parola kayıtlı") : L.t("Anahtar hazır")) : L.t("Giriş bilgisi sorulacak"))
                        .font(.caption2).foregroundStyle(.secondary)
                    // Shared with remote AI (Hybrid Access): the badge of the Windows host card.
                    if AiAccessRules.of(host).remote {
                        Text(L.t("Uzak YZ"))
                            .font(.caption2).foregroundStyle(.white)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 4))
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .help(host.target + (host.trustedKey.map { L.f("\nSunucu anahtarı: {0}", $0) } ?? ""))
    }
}

// MARK: - snippets, tunnels, trusted keys, history

struct SnippetMenu: View {
    @ObservedObject var model: ServersModel
    let session: TerminalSession
    @State private var snippets: [Snippet] = []
    var body: some View {
        Menu {
            if snippets.isEmpty { Text(L.t("Kayıtlı parçacık yok")) }
            ForEach(snippets) { s in Button(s.label) { model.send(s, to: session) } }
        } label: { Label(L.t("Parçacık"), icon: .snippet) }
        .disabled(session.closed)
        .task { snippets = await model.snippets() }
    }
}

struct SnippetsPage: View {
    @ObservedObject var model: ServersModel
    @State private var snippets: [Snippet] = []
    @State private var editing: Snippet?
    @State private var adding = false
    var body: some View {
        List {
            if snippets.isEmpty {
                Text(L.t("Sık kullandığın komutları burada sakla; açık terminalin araç çubuğundaki \"Parçacık\" ile gönder."))
                    .foregroundStyle(.secondary)
            }
            ForEach(snippets) { s in
                VStack(alignment: .leading, spacing: 3) {
                    Text(s.label).font(.body.weight(.semibold))
                    Text(s.command).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2)
                }
                .contextMenu {
                    Button(L.t("Düzenle…")) { editing = s }
                    Button(s.team == true ? L.t("Ekipten çıkar") : L.t("Ekiple paylaş")) {
                        Task {
                            await model.setTeam(kind: "snippet", id: s.id, team: s.team != true)
                            snippets = await model.snippets()
                        }
                    }
                    Button(L.t("Sil"), role: .destructive) { Task { snippets = await model.deleteSnippet(s) } }
                }
            }
        }
        .navigationTitle(L.t("Parçacıklar"))
        .toolbar { Button { adding = true } label: { Label(L.t("Yeni parçacık"), icon: .add) } }
        .sheet(item: $editing) { s in SnippetSheet(model: model, snippet: s) { snippets = $0 } }
        .sheet(isPresented: $adding) { SnippetSheet(model: model, snippet: nil) { snippets = $0 } }
        .task { snippets = await model.snippets() }
    }
}

struct SnippetSheet: View {
    @ObservedObject var model: ServersModel
    let snippet: Snippet?
    let saved: ([Snippet]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var command = ""
    @State private var error: String?
    var body: some View {
        Form {
            TextField(L.t("Ad"), text: $label, prompt: Text(L.t("Disk kullanımı")))
            TextEditor(text: $command).font(.body.monospaced()).frame(height: 110)
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
        }
        .formStyle(.grouped)
        .frame(width: 440)
        .onAppear { label = snippet?.label ?? ""; command = snippet?.command ?? "" }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(L.t("Vazgeç")) { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(L.t("Kaydet")) {
                    Task {
                        do { saved(try await model.saveSnippet(id: snippet?.id, label: label, command: command)); dismiss() }
                        catch { self.error = error.localizedDescription }
                    }
                }
                .disabled(label.isEmpty || command.isEmpty)
            }
        }
    }
}

struct KeysPage: View {
    @ObservedObject var model: ServersModel
    @State private var keys: [KeyMeta] = []
    @State private var importing = false
    @State private var error: String?
    var body: some View {
        List {
            if keys.isEmpty {
                Text(L.t("Henüz anahtar yok. \"Yeni anahtar\" ile oluştur; genel anahtarını sunucunun ~/.ssh/authorized_keys dosyasına ekle, sonra sunucuyu düzenleyip bu anahtarı seç."))
                    .foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(keys) { k in
                let used = model.hosts.filter { $0.keyId == k.id }.map(\.label)
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(k.label).font(.body.weight(.semibold))
                        Text("\(k.algorithm)  ·  \(k.fingerprint)").font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        Text(used.isEmpty ? L.t("Henüz bir sunucuda kullanılmıyor") : L.t("Kullanan: ") + used.joined(separator: ", "))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(L.t("Genel anahtarı kopyala")) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(k.publicKey, forType: .string)
                        model.notice = L.t("Genel anahtar kopyalandı. Sunucuda ~/.ssh/authorized_keys dosyasına ekle.")
                    }
                }
                .contextMenu { Button(L.t("Sil"), role: .destructive) { Task { keys = await model.deleteKey(k) } } }
            }
        }
        .navigationTitle(L.t("Anahtarlar"))
        .toolbar {
            ToolbarItemGroup {
                Button { importing = true } label: { Label(L.t("İçe aktar"), icon: .import) }
                Button {
                    Task {
                        do { keys = try await model.generateKey(label: (Host.current().localizedName ?? "Mac") + L.t(" anahtarı")); error = nil }
                        catch { self.error = error.localizedDescription }
                    }
                } label: { Label(L.t("Yeni anahtar"), icon: .add) }
            }
        }
        .sheet(isPresented: $importing) { ImportKeySheet(model: model) { keys = $0 } }
        .task { keys = await model.keys() }
    }
}

struct ImportKeySheet: View {
    @ObservedObject var model: ServersModel
    let imported: ([KeyMeta]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var key = ""
    @State private var passphrase = ""
    @State private var error: String?
    var body: some View {
        Form {
            TextField(L.t("Ad"), text: $label, prompt: Text(L.t("İş anahtarı")))
            Button(L.t("Dosyadan seç…")) {
                let panel = NSOpenPanel()
                panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh")
                panel.showsHiddenFiles = true
                if panel.runModal() == .OK, let url = panel.url, let text = try? String(contentsOf: url, encoding: .utf8) {
                    key = text
                    if label.isEmpty { label = url.lastPathComponent }
                }
            }
            TextEditor(text: $key).font(.caption.monospaced()).frame(height: 120)
            SecureField(L.t("Anahtar parolası (varsa)"), text: $passphrase)
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(L.t("Vazgeç")) { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(L.t("İçe aktar")) {
                    Task {
                        do { imported(try await model.importKey(label: label, privateKey: key, passphrase: passphrase)); dismiss() }
                        catch { self.error = error.localizedDescription }
                    }
                }
                .disabled(key.isEmpty)
            }
        }
    }
}

struct TunnelsPage: View {
    @ObservedObject var model: ServersModel
    var body: some View {
        List {
            if model.savedTunnels.isEmpty {
                Text(L.t("Kayıtlı tünel yok. Bir terminalde \"Tüneller\" ile açıp \"kaydet\"i işaretle. Yerel (ssh -L), uzak (ssh -R) ve SOCKS (ssh -D) tünelleri kaydedilebilir.")).foregroundStyle(.secondary)
            }
            ForEach(model.savedTunnels) { tunnel in
                Toggle(isOn: Binding(get: { tunnel.running }, set: { _ in Task { await model.toggleTunnel(tunnel) } })) {
                    VStack(alignment: .leading) {
                        Text(tunnel.hostLabel)
                        Text("\(tunnelKindLabel(tunnel.kind))   \(tunnel.local) → \(tunnel.remote)").font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.switch)
                .contextMenu { Button(L.t("Tüneli sil"), role: .destructive) { Task { await model.deleteTunnel(tunnel) } } }
            }
        }
        .navigationTitle(L.t("Tüneller"))
    }
}

struct KnownHostsPage: View {
    @ObservedObject var model: ServersModel
    @State private var known: [KnownHost] = []
    var body: some View {
        List {
            if known.isEmpty { Text(L.t("Henüz güvenilen sunucu anahtarı yok.")).foregroundStyle(.secondary) }
            ForEach(known) { k in
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(k.target + (k.labels.isEmpty ? "" : "  ·  " + k.labels.joined(separator: ", "))).font(.body.weight(.semibold))
                        Text(k.fingerprint).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    Spacer()
                    Button(L.t("Unut")) { Task { known = await model.forgetKnownHost(k) } }
                        .help(L.t("Bir sonraki bağlantıda anahtar yeniden sorulur."))
                }
            }
        }
        .navigationTitle(L.t("Bilinen sunucular"))
        .task { known = await model.knownHosts() }
    }
}

struct HistoryPage: View {
    @ObservedObject var model: ServersModel
    @State private var history: [HistoryEntry] = []
    var body: some View {
        List {
            if history.isEmpty { Text(L.t("Henüz bağlantı yok.")).foregroundStyle(.secondary) }
            ForEach(history) { h in
                HStack {
                    Text("\(h.label)  ·  \(h.target)").lineLimit(1)
                    Spacer()
                    Text(h.date, format: .dateTime.day().month().year().hour().minute()).foregroundStyle(.secondary)
                    if let host = model.hosts.first(where: { $0.id == h.hostId }) {
                        Button(L.t("Bağlan")) { model.open(host) }
                    }
                }
            }
        }
        .navigationTitle(L.t("Geçmiş"))
        .toolbar { Button { Task { await model.clearHistory(); history = [] } } label: { Label(L.t("Temizle"), icon: .delete) } }
        .task { history = await model.history() }
    }
}

/// `ContentUnavailableView` is macOS 14+; this works on 13.
struct ContentUnavailableCompat: View {
    let title: String
    let icon: WCIconName
    let text: String
    var body: some View {
        VStack(spacing: 10) {
            WCIcon(icon, size: 44).foregroundStyle(.secondary)
            Text(title).font(.title3.weight(.semibold))
            Text(text).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 380)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct HostRow: View {
    let host: CoreHost
    let via: String?
    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(host.label).fontWeight(.medium)
                Text(host.target).font(.caption.monospaced()).foregroundStyle(.secondary)
                if let via { Text(L.f("↪ {0} üzerinden", via)).font(.caption2).foregroundStyle(.secondary) }
            }
            Spacer()
            if host.savedSecret || host.keyPath != nil {
                WCIcon(.key).foregroundStyle(.secondary).help(L.t("Giriş bilgisi kayıtlı"))
                    .accessibilityLabel(L.t("Giriş bilgisi kayıtlı"))
            }
        }
        .help(host.trustedKey.map { L.f("Sunucu anahtarı: {0}", $0) } ?? L.t("Sunucu anahtarı henüz onaylanmadı"))
    }
}

// MARK: - split view

/// Up to four terminals side by side (or one above the other), each with a
/// small header to close it.
struct SplitTerminals: View {
    @ObservedObject var model: ServersModel
    let group: [TerminalSession]
    let vertical: Bool

    var body: some View {
        if vertical {
            VSplitView { panes }
        } else {
            HSplitView { panes }
        }
    }

    @ViewBuilder private var panes: some View {
        ForEach(group) { session in
            VStack(spacing: 0) {
                HStack {
                    Text(session.host.label + (session.closed ? L.t(" (kapandı)") : "")).font(.caption).lineLimit(1)
                    Spacer()
                    Button { model.close(session) } label: { WCIcon(.close) }
                        .buttonStyle(.borderless)
                        .help(L.t("Bu bölmeyi kapat"))
                        .accessibilityLabel(L.t("Bu bölmeyi kapat"))
                }
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(.bar)
                TerminalHost(model: model, session: session).id(session.id)
            }
            .frame(minWidth: 200, minHeight: 120)
        }
    }
}

// MARK: - identities

struct IdentitiesPage: View {
    @ObservedObject var model: ServersModel
    @State private var identities: [Identity] = []
    @State private var keys: [KeyMeta] = []
    @State private var editing: IdentityEdit?

    var body: some View {
        List {
            if identities.isEmpty {
                Text(L.t("Kimlik, bir kullanıcı adı ile anahtarı ya da parolasıdır; birçok sunucuda kullanılır (örneğin \"deploy + ekip anahtarı\"). Bir kez oluştur, sunucuyu düzenlerken seç."))
                    .foregroundStyle(.secondary)
            }
            ForEach(identities) { i in
                let used = model.hosts.filter { $0.identityId == i.id }.map(\.label)
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(i.label).font(.body.weight(.semibold))
                        Text(i.user + "  ·  " + (i.authKind == "password" ? L.t("Parola") : L.t("Anahtar: ") + (keys.first { $0.id == i.keyId }?.label ?? L.t("seçilmemiş"))))
                            .foregroundStyle(.secondary)
                        Text(used.isEmpty ? L.t("Henüz bir sunucuda kullanılmıyor") : L.t("Kullanan: ") + used.joined(separator: ", "))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(L.t("Düzenle")) { editing = IdentityEdit(identity: i) }
                    Button(role: .destructive) { Task { identities = await model.deleteIdentity(i) } } label: { WCIcon(.delete) }
                        .accessibilityLabel(L.t("Sil"))
                }
            }
        }
        .navigationTitle(L.t("Kimlikler"))
        .toolbar { Button { editing = IdentityEdit(identity: nil) } label: { Label(L.t("Yeni kimlik"), icon: .add) } }
        .sheet(item: $editing) { e in
            IdentitySheet(model: model, identity: e.identity, keys: keys) { identities = $0 }
        }
        .task { identities = await model.identities(); keys = await model.keys() }
    }
}

struct IdentityEdit: Identifiable {
    let id = UUID()
    let identity: Identity?
}

struct IdentitySheet: View {
    @ObservedObject var model: ServersModel
    let identity: Identity?
    let keys: [KeyMeta]
    let saved: ([Identity]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var user = ""
    @State private var authKind = "key"
    @State private var keyId = ""
    @State private var password = ""
    @State private var error: String?

    var body: some View {
        Form {
            TextField(L.t("Ad"), text: $label, prompt: Text(L.t("Ekip deploy")))
            TextField(L.t("Kullanıcı"), text: $user)
            Picker(L.t("Giriş"), selection: $authKind) {
                Text(L.t("Anahtar")).tag("key")
                Text(L.t("Parola")).tag("password")
            }
            if authKind == "key" {
                Picker(L.t("Anahtar"), selection: $keyId) {
                    Text(keys.isEmpty ? L.t("Önce Anahtarlar'dan bir anahtar oluştur") : L.t("Seç")).tag("")
                    ForEach(keys) { Text($0.label).tag($0.id) }
                }
            } else {
                SecureField(identity == nil ? L.t("Parola") : L.t("Parola (boşsa kayıtlı parola kalır)"), text: $password)
            }
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
        }
        .formStyle(.grouped)
        .frame(width: 420)
        .onAppear {
            guard let identity else { return }
            label = identity.label
            user = identity.user
            authKind = identity.authKind
            keyId = identity.keyId ?? ""
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(L.t("Vazgeç")) { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(L.t("Kaydet")) {
                    Task {
                        do {
                            saved(try await model.saveIdentity(id: identity?.id, label: label, user: user, authKind: authKind,
                                                               keyId: keyId.isEmpty ? nil : keyId,
                                                               password: authKind == "password" ? password : nil))
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
                .disabled(user.isEmpty)
            }
        }
    }
}

// MARK: - settings (terminal, backup)

struct SettingsPage: View {
    @ObservedObject var model: ServersModel
    @AppStorage("terminalFontSize") private var fontSize = 13.0
    @AppStorage("terminalTheme") private var terminalTheme = "dark"
    @State private var status: String?

    var body: some View {
        Form {
            if let app = (NSApp.delegate as? AppDelegate)?.model {
                Section(L.t("Dil")) { LanguagePicker(model: app) }
                Section(L.t("Yenilikler")) {
                    Button(L.t("Yenilikler: bu sürümde neler değişti")) { WhatsNew.showAll(model: app) }
                }
            }
            Section(L.t("Öğretici")) {
                Toggle(L.t("Öğreticiyi göster"), isOn: Binding(get: { !model.tutorialOff }, set: { model.setTutorialOff(!$0) }))
                Button(L.t("Baştan başlat")) { model.restartTutorial() }
            }
            Section("Terminal") {
                Stepper(value: $fontSize, in: 8...32, step: 1) { Text(L.f("Yazı boyutu: {0}", Int(fontSize))) }
                Picker(L.t("Terminal teması"), selection: $terminalTheme) {
                    ForEach(TerminalTheme.all) { Text($0.name).tag($0.id) }
                }
                Button(L.t("Oturum kayıtları klasörünü aç")) {
                    Task {
                        guard let folder = await model.logsFolder() else { return }
                        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                        NSWorkspace.shared.open(folder)
                    }
                }
                Text(L.t("Yeni açılan terminallerde geçerli olur. Terminal kısayolları: ⌘F ara · ⌘G / ⇧⌘G sonraki / önceki · ⌘= / ⌘- yazı boyutu · ⌘0 varsayılan boyut.")).font(.caption).foregroundStyle(.secondary)
            }
            Section(L.t("Eşitleme (bilgisayarların arasında)")) {
                SyncSection(model: model)
            }
            Section(L.t("Ekip")) {
                TeamSection(model: model)
            }
            Section(L.t("Yedekleme")) {
                Text(L.t("Sunucular, gruplar, tüneller, parçacıklar, kimlikler ve güvenilen sunucu anahtarları tek bir dosyaya yazılır. Parolalar ve özel anahtarlar dosyaya girmez; yeni bilgisayarda ilk bağlantıda bir kez sorulur. İçe aktarma var olanları değiştirmez, yalnız yenileri ekler."))
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button(L.t("Dışa aktar…")) { Task { await exportBackup() } }
                    Button(L.t("İçe aktar…")) { Task { await importBackup() } }
                }
                if let status { Text(status).font(.callout) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(L.t("Ayarlar"))
        .task { await model.refreshSyncStatus() }
    }

    private func exportBackup() async {
        do {
            let json = try await model.exportLibrary()
            let panel = NSSavePanel()
            panel.allowedContentTypes = [.json]
            let day = ISO8601DateFormatter().string(from: Date()).prefix(10)
            panel.nameFieldStringValue = "wecommander-yedek-\(day).json"
            guard panel.runModal() == .OK, let url = panel.url else { return }
            try json.write(to: url, atomically: true, encoding: .utf8)
            status = L.f("Yedek kaydedildi: {0}", url.path)
        } catch {
            status = L.f("Yedek kaydedilemedi: {0}", error.localizedDescription)
        }
    }

    private func importBackup() async {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let s = try await model.importLibrary(try String(contentsOf: url, encoding: .utf8))
            status = L.f("İçe aktarıldı: {0} sunucu, {1} parçacık, {2} sunucu anahtarı", s.hosts, s.snippets, s.knownHosts)
                + (s.skipped > 0 ? L.f(" ({0} sunucu zaten vardı, atlandı).", s.skipped) : ".")
        } catch {
            status = L.f("Yedek içe aktarılamadı: {0}", error.localizedDescription)
        }
    }
}

struct TeamSection: View {
    @ObservedObject var model: ServersModel

    var body: some View {
        Text(L.t("Bir sunucuya ya da parçacığa sağ tıklayıp \"Ekiple paylaş\" dersen çalışma alanındaki herkesin uygulamasında görünür (kayıtlı parolasıyla). Ekip kütüphanesi ekip anahtarıyla uçtan uca şifrelenir. Üye eklemek ve rolleri değiştirmek panelde: Yönetim → Ekip. İzleyiciler ortak sunucuları kullanır ama değiştiremez."))
            .font(.callout).foregroundStyle(.secondary)
        if let name = model.teamName {
            Text(L.f("Çalışma alanı: {0} · rolün: {1}", name, roleName(model.teamRole)))
            if model.teamWaiting {
                Text(L.t("Ekip anahtarı bekleniyor: ekipten operatör ya da üstü biri uygulamasını açtığında bu Mac'e verilir.")).foregroundStyle(.orange)
            }
            ForEach(model.teamMembers, id: \.centerId) { m in
                Text("\(m.hasKey ? "●" : "○") \(m.email) · \(m.centerName)\(m.hasKey ? "" : L.t(" (anahtar bekliyor)"))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        if let e = model.teamError { Text(e).foregroundStyle(.red).font(.callout) }
        Button(L.t("Şimdi eşitle")) { Task { await model.syncAll() } }
    }

    private func roleName(_ role: String?) -> String {
        switch role {
        case "owner": return L.t("sahip")
        case "admin": return L.t("yönetici")
        case "operator": return L.t("operatör")
        default: return L.t("izleyici")
        }
    }
}

struct SyncSection: View {
    @ObservedObject var model: ServersModel
    @State private var passphrase = ""
    @State private var again = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        Text(L.t("Sunucular, gruplar, tüneller, parçacıklar, kimlikler, anahtarlar ve kayıtlı parolalar aynı hesapla oturum açtığın tüm bilgisayarlarda aynı olur. Her şey bu Mac'te, yalnız senin bildiğin eşitleme parolasıyla şifrelenir; WECOMMANDER sunucusu içeriği göremez. Parolayı unutursan eşitlenen kopya açılamaz."))
            .font(.callout).foregroundStyle(.secondary)
        if model.syncConfigured {
            Text(L.t("● Eşitleme açık. ") + (model.lastLibrarySync.map { L.f("Son eşitleme: {0}", $0.formatted(date: .omitted, time: .shortened)) } ?? L.t("Henüz eşitlenmedi")))
            if let e = model.librarySyncError { Text(e).foregroundStyle(.red).font(.callout) }
            HStack {
                Button(L.t("Şimdi eşitle")) { Task { await model.syncLibrary() } }
                Button(L.t("Bu Mac'te kapat")) { Task { await model.forgetSync() } }
            }
        } else {
            SecureField(L.t("Eşitleme parolası (en az 8 karakter)"), text: $passphrase)
            SecureField(L.t("Parolayı tekrar yaz"), text: $again)
            Text(L.t("Başka bir bilgisayarda eşitlemeyi zaten açtıysan oradaki parolayı gir.")).font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
            Button(L.t("Eşitlemeyi aç")) {
                guard passphrase == again else { error = L.t("Parolalar aynı değil."); return }
                busy = true
                Task {
                    do { try await model.setupSync(passphrase: passphrase); error = nil; passphrase = ""; again = "" }
                    catch { self.error = error.localizedDescription }
                    busy = false
                }
            }
            .disabled(busy || passphrase.count < 8)
        }
    }
}

// MARK: - terminal (SwiftTerm)

struct TerminalHost: NSViewRepresentable {
    @ObservedObject var model: ServersModel
    @ObservedObject var session: TerminalSession

    func makeCoordinator() -> Coordinator { Coordinator(model: model, session: session) }

    func makeNSView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        let suggest = Autosuggest(view: view)
        context.coordinator.autosuggest = suggest
        context.coordinator.shortcuts = TerminalShortcuts(view, onRightArrow: { [weak suggest] in suggest?.accept() ?? false })
        let hostId = session.host.id
        suggest.onCommand = { [weak model] command, prompt in model?.addCommand(hostId: hostId, command: command, prompt: prompt) }
        Task { @MainActor [weak suggest] in
            let history = await model.commands(hostId: hostId)
            let snippets = await model.snippets().map { $0.command.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            suggest?.history = history
            suggest?.snippets = snippets
        }
        view.terminalDelegate = context.coordinator
        let size = UserDefaults.standard.double(forKey: "terminalFontSize")
        view.font = NSFont.monospacedSystemFont(ofSize: size >= 8 ? size : 13, weight: .regular)
        TerminalTheme.named(UserDefaults.standard.string(forKey: "terminalTheme") ?? "dark").apply(to: view)
        session.feed = { [weak view] bytes in view?.feed(byteArray: bytes[...]) }
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return view
    }

    func updateNSView(_ view: TerminalView, context: Context) {}

    static func dismantleNSView(_ view: TerminalView, coordinator: Coordinator) {
        coordinator.session.feed = nil
        coordinator.shortcuts?.stop()
    }

    @MainActor
    final class Coordinator: NSObject, TerminalViewDelegate {
        let model: ServersModel
        let session: TerminalSession
        var shortcuts: TerminalShortcuts?
        var autosuggest: Autosuggest?
        init(model: ServersModel, session: TerminalSession) {
            self.model = model
            self.session = session
        }

        nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            MainActor.assumeIsolated { model.resize(session, cols: newCols, rows: newRows) }
        }
        nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
            let bytes = Array(data)
            MainActor.assumeIsolated { model.write(session, bytes[...]) }
            // Autocomplete follows the line on the next turn, outside this
            // callback (SwiftTerm may hold the terminal lock here).
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.autosuggest?.typed(bytes) }
            }
        }
        nonisolated func setTerminalTitle(source: TerminalView, title: String) {}
        nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        nonisolated func scrolled(source: TerminalView, position: Double) {}
        nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link), ["http", "https"].contains(url.scheme) { NSWorkspace.shared.open(url) }
        }
        nonisolated func bell(source: TerminalView) { NSSound.beep() }
        nonisolated func clipboardCopy(source: TerminalView, content: Data) {
            if let text = String(data: content, encoding: .utf8) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        }
        nonisolated func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
    }
}

/// The app lives in the menu bar and has no Edit menu, so the terminal
/// handles its own shortcuts: ⌘F find, ⌘G / ⇧⌘G next and previous match,
/// ⌘= / ⌘- / ⌘0 font size (remembered for the next terminals).
/// SwiftTerm does not let its key handling be overridden, so the keys are
/// read from the window's events while this terminal (or its find bar) has focus.
@MainActor
final class TerminalShortcuts {
    private var monitor: Any?
    private let onRightArrow: () -> Bool

    init(_ view: TerminalView, onRightArrow: @escaping () -> Bool = { false }) {
        self.onRightArrow = onRightArrow
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak view, weak self] event in
            MainActor.assumeIsolated {
                guard let view, event.window === view.window,
                      let focused = view.window?.firstResponder as? NSView, focused.isDescendant(of: view) else { return event }
                // → with an autocomplete suggestion on screen accepts it.
                let plain = event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty
                if event.keyCode == 124, plain, self?.onRightArrow() == true { return nil }
                return TerminalShortcuts.handle(event, in: view) ? nil : event
            }
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    private static func handle(_ event: NSEvent, in view: TerminalView) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard mods.contains(.command), !mods.contains(.control), !mods.contains(.option),
              let key = event.charactersIgnoringModifiers?.lowercased() else { return false }
        switch key {
        case "f": find(.showFindPanel, view)
        case "g": find(mods.contains(.shift) ? .previous : .next, view)
        case "=", "+": setFontSize(view.font.pointSize + 1, view)
        case "-": setFontSize(view.font.pointSize - 1, view)
        case "0": setFontSize(13, view)
        default: return false
        }
        return true
    }

    private static func find(_ action: NSFindPanelAction, _ view: TerminalView) {
        let item = NSMenuItem()
        item.tag = Int(action.rawValue)
        view.performFindPanelAction(item)
    }

    private static func setFontSize(_ size: CGFloat, _ view: TerminalView) {
        let clamped = min(max(size, 8), 32)
        view.font = NSFont.monospacedSystemFont(ofSize: clamped, weight: .regular)
        UserDefaults.standard.set(Double(clamped), forKey: "terminalFontSize")
    }
}

// MARK: - add host

struct EditHostSheet: View {
    @ObservedObject var model: ServersModel
    /// nil: a new host.
    let host: CoreHost?
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var address = ""
    @State private var user = ""
    @State private var port = "22"
    @State private var group = ""
    @State private var authKind = "key"
    @State private var jumpId = ""
    @State private var keyId = ""
    @State private var keys: [KeyMeta] = []
    @State private var identities: [Identity] = []
    @State private var identityId = ""
    @State private var startup = ""
    @State private var envText = ""
    @State private var agentForwarding = false
    @State private var kind = "ssh"
    @State private var sessionLog = false
    @State private var serialPorts: [String] = []
    @State private var serialDevice = ""
    @State private var baud = "9600"
    @State private var dataBits = 8
    @State private var parity = "none"
    @State private var stopBits = 1
    @State private var flow = "none"
    @State private var error: String?

    var body: some View {
        Form {
            Picker(L.t("Bağlantı türü"), selection: $kind) {
                Text("SSH").tag("ssh")
                Text(L.t("Mosh (SSH ile giriş, UDP ile kesintisiz)")).tag("mosh")
                Text("Telnet").tag("telnet")
                Text(L.t("Seri port")).tag("serial")
            }
            .onChange(of: kind) { k in
                if k == "telnet", port == "22" { port = "23" }
                if k == "ssh" || k == "mosh", port == "23" { port = "22" }
            }
            TextField(L.t("Ad"), text: $label, prompt: Text("Prod web"))
            if kind == "serial" {
                Section(L.t("Seri port")) {
                    HStack {
                        TextField("Port", text: $serialDevice, prompt: Text("/dev/cu.usbserial-1410"))
                        Menu(L.t("Seç")) { ForEach(serialPorts, id: \.self) { p in Button(p) { serialDevice = p } } }
                            .disabled(serialPorts.isEmpty).fixedSize()
                    }
                    Picker(L.t("Hız (baud)"), selection: $baud) {
                        ForEach(["1200", "2400", "4800", "9600", "19200", "38400", "57600", "115200", "230400", "460800", "921600"], id: \.self) { Text($0).tag($0) }
                    }
                    Picker(L.t("Veri bitleri"), selection: $dataBits) { ForEach([8, 7, 6, 5], id: \.self) { Text("\($0)").tag($0) } }
                    Picker(L.t("Eşlik"), selection: $parity) {
                        Text(L.t("Yok")).tag("none"); Text(L.t("Çift")).tag("even"); Text(L.t("Tek")).tag("odd")
                    }
                    Picker(L.t("Durdurma bitleri"), selection: $stopBits) { Text("1").tag(1); Text("2").tag(2) }
                    Picker(L.t("Akış denetimi"), selection: $flow) {
                        Text(L.t("Yok")).tag("none"); Text(L.t("Donanım (RTS/CTS)")).tag("hardware"); Text(L.t("Yazılım (XON/XOFF)")).tag("software")
                    }
                }
            } else {
            TextField(L.t("Adres"), text: $address, prompt: Text(L.t("sunucu.ornek.com")))
            }
            if kind == "ssh" || kind == "mosh" {
            Picker(L.t("Kimlik"), selection: $identityId) {
                Text(L.t("Yok (bu sunucunun kendi kullanıcısı ve giriş bilgisi)")).tag("")
                ForEach(identities) { Text("\($0.label) (\($0.user))").tag($0.id) }
            }
            .onChange(of: identityId) { id in
                if let i = identities.first(where: { $0.id == id }) { user = i.user }
            }
            TextField(L.t("Kullanıcı"), text: $user).disabled(!identityId.isEmpty)
            }
            if kind != "serial" { TextField("Port", text: $port) }
            TextField(L.t("Grup (isteğe bağlı)"), text: $group, prompt: Text("Production"))
            if kind == "ssh" || kind == "mosh" {
            if identityId.isEmpty {
                Picker(L.t("Giriş"), selection: $authKind) {
                    Text(L.t("Özel anahtar")).tag("key")
                    Text(L.t("Parola")).tag("password")
                }
                Picker(L.t("Anahtar"), selection: $keyId) {
                    Text(L.t("Bağlanırken sor / anahtar dosyası")).tag("")
                    ForEach(keys) { Text($0.label).tag($0.id) }
                }
            }
            if kind == "ssh" {
            Picker(L.t("Atlama sunucusu"), selection: $jumpId) {
                Text(L.t("Doğrudan bağlan")).tag("")
                ForEach(model.hosts.filter { $0.id != host?.id }) { Text($0.label).tag($0.id) }
            }
            }
            Section(L.t("Terminal seçenekleri")) {
                TextField(L.t("Bağlanınca çalışacak komut"), text: $startup, prompt: Text(L.t("cd /var/www && git status")))
                    .font(.body.monospaced())
                VStack(alignment: .leading, spacing: 4) {
                    Text(L.t("Ortam değişkenleri (her satıra AD=değer)")).font(.callout)
                    TextEditor(text: $envText).font(.body.monospaced()).frame(height: 60)
                }
                Toggle(L.t("SSH agent yönlendirme (ssh -A)"), isOn: $agentForwarding)
                    .help(L.t("Yalnız güvendiğin sunucularda aç: sunucuda yönetici yetkisi olan biri, bağlantı açıkken agent'taki anahtarlarını kullanabilir."))
            }
            }
            Toggle(L.t("Oturumu kaydet"), isOn: $sessionLog)
                .help(L.t("Terminalde görünenler bir metin dosyasına yazılır (Ayarlar → Oturum kayıtları)."))
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .task { keys = await model.keys(); identities = await model.identities(); serialPorts = await model.serialPorts() }
        .onAppear {
            guard let host else { return }
            keyId = host.keyId ?? ""
            label = host.label
            address = host.host ?? ""
            user = host.user ?? ""
            port = String(host.port ?? 22)
            group = host.group ?? ""
            authKind = host.authKind
            jumpId = host.jumpId ?? ""
            identityId = host.identityId ?? ""
            startup = host.startupCommand ?? ""
            envText = (host.env ?? [:]).sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "\n")
            agentForwarding = host.agentForwarding ?? false
            kind = host.`protocol` ?? "ssh"
            sessionLog = host.sessionLog ?? false
            if let serial = host.serial {
                serialDevice = serial.device; baud = String(serial.baud); dataBits = serial.dataBits
                parity = serial.parity; stopBits = serial.stopBits; flow = serial.flow
            }
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button(L.t("Vazgeç")) { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button(L.t("Kaydet")) {
                    Task {
                        do {
                            if kind != "ssh", kind != "mosh", user.trimmingCharacters(in: .whitespaces).isEmpty { user = kind }
                            var serialSettings: SerialSettings?
                            if kind == "serial" {
                                let device = serialDevice.trimmingCharacters(in: .whitespaces)
                                guard !device.isEmpty else { throw CoreClient.Failure.core(L.t("Seri portu seç ya da yaz.")) }
                                serialSettings = SerialSettings(device: device, baud: Int(baud) ?? 9600, dataBits: dataBits,
                                                                parity: parity, stopBits: stopBits, flow: flow)
                                // The profile still needs an address; the port is the real target.
                                address = "serial"
                                port = "1"
                            }
                            let jump = jumpId.isEmpty || kind != "ssh" ? nil : jumpId
                            let portNumber = Int(port) ?? 0
                            if let host {
                                try await model.updateHost(host, label: label, address: address, port: portNumber, user: user,
                                                           authKind: authKind, jumpId: jump, group: group)
                            } else {
                                try await model.addHost(label: label, host: address, port: portNumber, user: user,
                                                        authKind: authKind, jumpId: jump)
                                if !group.trimmingCharacters(in: .whitespaces).isEmpty, let added = model.hosts.last {
                                    try await model.updateHost(added, label: added.label, address: added.host ?? address,
                                                               port: added.port ?? portNumber, user: added.user ?? user,
                                                               authKind: added.authKind, jumpId: added.jumpId, group: group)
                                }
                            }
                            let chosen = keyId.isEmpty ? nil : keyId
                            var saved = host.flatMap { h in model.hosts.first { $0.id == h.id } } ?? model.hosts.last
                            let identity = identityId.isEmpty ? nil : identityId
                            if identity == nil, let s = saved, s.keyId != chosen { try await model.setKey(s, keyId: chosen) }
                            if let s = saved, s.identityId != identity { try await model.setIdentity(s, identityId: identity) }
                            saved = saved.flatMap { h in model.hosts.first { $0.id == h.id } }
                            if let s = saved, (s.`protocol` ?? "ssh") != kind || s.serial != serialSettings {
                                try await model.setConnection(s, protocol: kind, serial: serialSettings)
                                saved = model.hosts.first { $0.id == s.id }
                            }
                            var env: [String: String] = [:]
                            for line in envText.split(whereSeparator: \.isNewline) {
                                let t = line.trimmingCharacters(in: .whitespaces)
                                if t.isEmpty || t.hasPrefix("#") { continue }
                                guard let eq = t.firstIndex(of: "="), eq != t.startIndex else {
                                    throw CoreClient.Failure.core(L.f("Ortam değişkeni AD=değer biçiminde olmalı: {0}", t))
                                }
                                env[String(t[..<eq]).trimmingCharacters(in: .whitespaces)] = String(t[t.index(after: eq)...])
                            }
                            let command = startup.trimmingCharacters(in: .whitespaces)
                            if let s = saved, (s.startupCommand ?? "") != command || (s.env ?? [:]) != env || (s.agentForwarding ?? false) != agentForwarding
                                || (s.sessionLog ?? false) != sessionLog {
                                try await model.setOptions(s, startupCommand: command, env: env, agentForwarding: agentForwarding, sessionLog: sessionLog)
                            }
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
                .disabled(label.isEmpty || address.isEmpty || user.isEmpty)
            }
        }
    }
}

// MARK: - connect (credentials and host key approval)

struct ConnectSheet: View {
    @ObservedObject var model: ServersModel
    let request: ConnectRequest
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "key"
    @State private var key = ""
    @State private var keyPath: String?
    @State private var passphrase = ""
    @State private var password = ""
    @State private var remember = true
    @State private var installKey = true
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(request.host.label) · \(request.host.target)").font(.headline)
            if let hostKey = request.hostKey {
                hostKeyBox(hostKey)
            } else {
                credentialForm
            }
            if let message = request.message {
                Label(message, icon: .warning).foregroundStyle(.red).font(.callout)
            }
            HStack {
                Spacer()
                Button(L.t("Vazgeç")) { model.connect = nil }.keyboardShortcut(.cancelAction)
                if let hostKey = request.hostKey {
                    Button(hostKey.status == "hostKeyChanged" ? L.t("Yeni anahtara yine de güven") : L.t("Güven ve bağlan")) {
                        busy = true
                        Task { await model.run(request.host, auth: request.auth ?? [:], accept: hostKey.fingerprint) }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy)
                } else {
                    Button(L.t("Bağlan")) {
                        busy = true
                        Task { await model.run(request.host, auth: auth, accept: nil); busy = false }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy || (kind == "key" ? key.isEmpty && keyPath == nil : password.isEmpty))
                }
            }
        }
        .padding(20)
        .frame(width: 520)
        .onAppear {
            kind = request.host.authKind
            keyPath = request.host.keyPath
        }
    }

    private var auth: [String: Any] {
        var a: [String: Any] = ["kind": kind, "remember": remember]
        if kind == "key" {
            a["secret"] = key
            a["passphrase"] = passphrase
            if key.isEmpty, let keyPath { a["keyPath"] = keyPath }
        } else {
            a["secret"] = password
            a["installKey"] = installKey
        }
        return a
    }

    private var credentialForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("", selection: $kind) {
                Text(L.t("Özel anahtar")).tag("key")
                Text(L.t("Parola")).tag("password")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if kind == "key" {
                HStack {
                    Button(L.t("Anahtar dosyası seç…")) { pickKey() }
                    Text(keyPath ?? L.t("ya da anahtarı aşağıya yapıştır"))
                        .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                if keyPath == nil {
                    TextEditor(text: $key)
                        .font(.caption.monospaced())
                        .frame(height: 110)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                }
                SecureField(L.t("Anahtar parolası (varsa)"), text: $passphrase)
            } else {
                SecureField(L.t("Parola"), text: $password)
                Toggle(L.t("Bir dahaki sefere parola sorma (bu Mac'in anahtarını sunucuya ekle)"), isOn: $installKey)
            }
            Toggle(L.t("macOS Anahtar Zinciri'nde sakla"), isOn: $remember)
        }
    }

    private func hostKeyBox(_ result: ConnectResult) -> some View {
        let changed = result.status == "hostKeyChanged"
        return VStack(alignment: .leading, spacing: 8) {
            Label(changed ? L.t("Bu sunucunun anahtarı değişti") : L.t("Bu sunucuya ilk kez bağlanıyorsun"),
                  icon: changed ? .error : .shieldLock)
                .font(.headline)
                .foregroundStyle(changed ? .red : .primary)
            Text(changed
                 ? L.f("Güvendiğin anahtar {0} idi. Sunucuyu yeniden kurmadıysan bağlanma; araya biri girmiş olabilir.", result.trusted ?? "")
                 : L.f("{0} anahtarının parmak izi aşağıda. Sunucu yöneticisinden aldığın değerle aynıysa güven.", result.algorithm ?? ""))
                .font(.callout)
            Text(result.fingerprint ?? "").font(.body.monospaced()).textSelection(.enabled)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(changed ? Color.red.opacity(0.08) : Color.secondary.opacity(0.08)))
    }

    private func pickKey() {
        let panel = NSOpenPanel()
        panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".ssh")
        panel.showsHiddenFiles = true
        panel.canChooseDirectories = false
        panel.message = L.t("Özel anahtar dosyası (ör. ~/.ssh/id_ed25519)")
        if panel.runModal() == .OK, let url = panel.url {
            keyPath = url.path
            key = ""
        }
    }
}

// MARK: - files (SFTP)

struct FilesPane: View {
    @ObservedObject var model: ServersModel
    @ObservedObject var session: TerminalSession
    @State private var listing: RemoteListing?
    @State private var error: String?
    @State private var dropTarget = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Button { load(listing?.parent) } label: { WCIcon(.arrowUp) }.help(L.t("Üst klasör")).accessibilityLabel(L.t("Üst klasör"))
                Text(listing?.path ?? "…").font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
                Spacer()
                Button { load(listing?.path) } label: { WCIcon(.refresh) }.help(L.t("Yenile")).accessibilityLabel(L.t("Yenile"))
                Menu {
                    Button(L.t("Dosya yükle…")) { upload() }
                    Button(L.t("Yeni klasör…")) { newFolder() }
                } label: { WCIcon(.add) }
                .menuStyle(.borderlessButton).fixedSize()
            }
            .padding(8)
            Divider()
            if let error {
                Text(error).foregroundStyle(.red).font(.callout).padding()
                Spacer()
            } else {
                List(listing?.entries ?? []) { entry in
                    HStack {
                        WCIcon(entry.isFolder ? .folder : entry.kind == "link" ? .link : .file)
                            .foregroundStyle(entry.isFolder ? Color.accentColor : .secondary)
                        Text(entry.name).lineLimit(1)
                        Spacer()
                        if !entry.isFolder {
                            Text(ByteCountFormatter.string(fromByteCount: Int64(entry.size), countStyle: .file))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture(count: 2) { if entry.isFolder || entry.kind == "link" { load(entry.path) } }
                    .contextMenu {
                        if !entry.isFolder { Button(L.t("İndir…")) { download(entry) } }
                        Button(L.t("Yeniden adlandır…")) { rename(entry) }
                        Button(L.t("Sil"), role: .destructive) { delete(entry) }
                    }
                    .help("\(entry.permissions)  \(entry.path)")
                }
                .listStyle(.inset)
            }
            ForEach(Array(model.transfers.keys), id: \.self) { id in
                if let t = model.transfers[id] {
                    ProgressView(value: Double(t.done), total: Double(max(t.total, 1))) {
                        Text(t.label).font(.caption)
                    }
                    .padding(.horizontal, 8)
                }
            }
            Text(L.t("Dosyaları buraya sürükleyip bırakarak da yükleyebilirsin."))
                .font(.caption2).foregroundStyle(.secondary).padding(6)
        }
        .background(dropTarget ? Color.accentColor.opacity(0.08) : Color.clear)
        .onDrop(of: [.fileURL], isTargeted: $dropTarget) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    Task { @MainActor in send(url) }
                }
            }
            return true
        }
        .onAppear { load(nil) }
    }

    private func load(_ path: String?) {
        Task {
            do {
                listing = try await model.list(session, path: path)
                error = nil
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func send(_ url: URL) {
        guard let dir = listing?.path else { return }
        Task {
            do {
                try await model.transfer("files.upload", session, label: "⬆ \(url.lastPathComponent)",
                                         ["local": url.path, "remoteDir": dir])
                load(dir)
            } catch {
                model.notice = "\(url.lastPathComponent): \(error.localizedDescription)"
            }
        }
    }

    private func upload() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        if panel.runModal() == .OK { panel.urls.forEach(send) }
    }

    private func download(_ entry: RemoteEntry) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = entry.name
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                try await model.transfer("files.download", session, label: "⬇ \(entry.name)",
                                         ["remote": entry.path, "local": url.path])
            } catch {
                model.notice = "\(entry.name): \(error.localizedDescription)"
            }
        }
    }

    private func ask(_ title: String, _ value: String) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        let field = NSTextField(string: value)
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: L.t("Tamam"))
        alert.addButton(withTitle: L.t("Vazgeç"))
        return alert.runModal() == .alertFirstButtonReturn ? field.stringValue.trimmingCharacters(in: .whitespaces) : nil
    }

    private func join(_ dir: String, _ name: String) -> String { dir.hasSuffix("/") ? dir + name : dir + "/" + name }

    private func newFolder() {
        guard let dir = listing?.path, let name = ask(L.t("Yeni klasör"), ""), !name.isEmpty else { return }
        Task {
            do { try await model.filesAction("files.mkdir", session, ["path": join(dir, name)]); load(dir) }
            catch { model.notice = error.localizedDescription }
        }
    }

    private func rename(_ entry: RemoteEntry) {
        guard let dir = listing?.path, let name = ask(L.t("Yeniden adlandır"), entry.name), !name.isEmpty, name != entry.name else { return }
        Task {
            do { try await model.filesAction("files.rename", session, ["from": entry.path, "to": join(dir, name)]); load(dir) }
            catch { model.notice = error.localizedDescription }
        }
    }

    private func delete(_ entry: RemoteEntry) {
        let alert = NSAlert()
        alert.messageText = L.f("{0} silinsin mi?", entry.name)
        alert.informativeText = entry.isFolder ? L.t("Yalnızca boş klasörler silinebilir.") : L.t("Bu işlem geri alınamaz.")
        alert.addButton(withTitle: L.t("Sil"))
        alert.addButton(withTitle: L.t("Vazgeç"))
        guard alert.runModal() == .alertFirstButtonReturn, let dir = listing?.path else { return }
        Task {
            do { try await model.filesAction("files.delete", session, ["path": entry.path]); load(dir) }
            catch { model.notice = error.localizedDescription }
        }
    }
}

// MARK: - tunnels

func tunnelKindLabel(_ kind: String?) -> String {
    switch kind {
    case "remote": return L.t("Uzak (-R)")
    case "dynamic": return "SOCKS (-D)"
    default: return L.t("Yerel (-L)")
    }
}

struct TunnelsSheet: View {
    @ObservedObject var model: ServersModel
    @ObservedObject var session: TerminalSession
    @Environment(\.dismiss) private var dismiss
    @State private var forwards: [ForwardInfo] = []
    @State private var kind = "local"
    @State private var localPort = ""
    @State private var localHost = "127.0.0.1"
    @State private var remoteHost = "127.0.0.1"
    @State private var remotePort = ""
    @State private var save = false
    @State private var status: String?

    private var help: String {
        switch kind {
        case "remote": return L.t("Sunucu bir port açar; oraya gelen bağlantılar bu Mac'teki bir servise gelir (ssh -R). Sunucu varsayılan olarak yalnız kendi içinden (localhost) dinler.")
        case "dynamic": return L.t("Bu Mac'te bir SOCKS5 proxy açar; tarayıcını bu proxy'ye yönlendirirsen trafik sunucunun ağından çıkar (ssh -D). Yalnızca bu Mac'ten erişilebilir.")
        default: return L.t("Bu Mac'teki bir portu sunucunun erişebildiği bir adrese bağlar (ssh -L). Yalnızca bu Mac'ten (127.0.0.1) erişilebilir.")
        }
    }

    private var ready: Bool {
        switch kind {
        case "remote": return Int(localPort) ?? 0 > 0
        case "dynamic": return true
        default: return Int(remotePort) ?? 0 > 0
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L.f("Tüneller · {0}", session.host.label)).font(.headline)
            ForEach(forwards, id: \.stopId) { f in
                HStack {
                    Text(tunnelKindLabel(f.kind)).foregroundStyle(.secondary)
                    Text("\(f.local) → \(f.remote)").font(.callout.monospaced()).textSelection(.enabled)
                    Spacer()
                    Button(L.t("Kapat")) { Task { forwards = await model.stopForward(session, local: f.stopId) } }
                }
            }
            Picker(L.t("Tür"), selection: $kind) {
                Text(L.t("Yerel (-L)")).tag("local")
                Text(L.t("Uzak (-R)")).tag("remote")
                Text("SOCKS (-D)").tag("dynamic")
            }
            .pickerStyle(.segmented)
            .onChange(of: kind) { k in
                if k == "remote", remoteHost == "127.0.0.1" { remoteHost = "localhost" }
                if k == "local", remoteHost == "localhost" { remoteHost = "127.0.0.1" }
            }
            Text(help).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            switch kind {
            case "remote":
                HStack {
                    TextField(L.t("Sunucu adresi"), text: $remoteHost)
                    TextField(L.t("Sunucu portu (0 = seçsin)"), text: $remotePort).frame(width: 170)
                    WCIcon(.arrowRight)
                    TextField(L.t("Bu Mac'teki adres"), text: $localHost)
                    TextField("Port", text: $localPort).frame(width: 70)
                }
            case "dynamic":
                TextField(L.t("Proxy portu (0 = boş)"), text: $localPort).frame(width: 180)
            default:
                HStack {
                    TextField(L.t("Yerel port (0 = boş)"), text: $localPort).frame(width: 140)
                    WCIcon(.arrowRight)
                    TextField(L.t("Uzak adres"), text: $remoteHost)
                    TextField("Port", text: $remotePort).frame(width: 70)
                }
            }
            Toggle(L.t("Bu tüneli kaydet (Tüneller sayfasından ve menü çubuğundan açılır)"), isOn: $save)
            if let status { Text(status).font(.callout).foregroundStyle(.secondary) }
            HStack {
                Spacer()
                Button(L.t("Kapat")) { dismiss() }.keyboardShortcut(.cancelAction)
                Button(L.t("Tünel aç")) {
                    Task {
                        do {
                            forwards = try await model.startForward(
                                session, kind: kind, localPort: Int(localPort) ?? 0,
                                localHost: kind == "remote" ? localHost : nil,
                                remoteHost: kind == "dynamic" ? "" : remoteHost, remotePort: Int(remotePort) ?? 0, save: save)
                            status = forwards.last.map { f in
                                switch kind {
                                case "remote": return L.f("Açıldı: sunucuda {0} → bu Mac'te {1}.", f.local, f.remote)
                                case "dynamic": return L.f("Açıldı: uygulamanda SOCKS5 proxy olarak {0} adresini kullan.", f.local)
                                default: return L.f("Açıldı: {0} adresine bağlan.", f.local)
                                }
                            }
                        } catch {
                            status = error.localizedDescription
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!ready)
            }
        }
        .padding(20)
        .frame(width: 600)
        .task { forwards = await model.forwards(session) }
    }
}
