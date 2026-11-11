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
    @State private var showFiles = false
    @State private var showTunnels = false
    var showPanel: () -> Void = {}

    static let hostsPage = "page:hosts"

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 240)
        } detail: {
            detail
        }
        .sheet(item: $editing) { request in EditHostSheet(model: model, host: request.host) }
        .sheet(item: $model.connect) { request in ConnectSheet(model: model, request: request) }
        .sheet(isPresented: $showTunnels) {
            if let s = model.selectedSession { TunnelsSheet(model: model, session: s) }
        }
        .alert("WECOMMANDER", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button("Tamam", role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
        .frame(minWidth: 900, minHeight: 540)
        .onAppear { if model.selection == nil { model.selection = Self.hostsPage } }
    }

    private var sidebar: some View {
        List(selection: Binding(get: { model.selection }, set: { model.selection = $0 })) {
            Section {
                Label("Sunucular", systemImage: "server.rack").tag(Optional(Self.hostsPage))
                Label("Anahtarlar", systemImage: "key").tag(Optional("page:keys"))
                Label("Kimlikler", systemImage: "person.crop.circle.badge.checkmark").tag(Optional("page:identities"))
                Label("Parçacıklar", systemImage: "text.badge.plus").tag(Optional("page:snippets"))
                Label("Tüneller", systemImage: "point.3.connected.trianglepath.dotted").tag(Optional("page:tunnels"))
                Label("Bilinen sunucular", systemImage: "checkmark.shield").tag(Optional("page:known"))
                Label("Geçmiş", systemImage: "clock.arrow.circlepath").tag(Optional("page:history"))
                Label("Ayarlar", systemImage: "gearshape").tag(Optional("page:settings"))
            }
            if !model.sessions.isEmpty {
                Section("Açık terminaller") {
                    ForEach(model.sessions) { session in
                        Label(session.host.label, systemImage: session.closed ? "terminal" : "terminal.fill")
                            .foregroundStyle(session.closed ? .secondary : .primary)
                            .tag(Optional(session.id))
                            .contextMenu { Button("Terminali kapat") { model.close(session) } }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            VStack(alignment: .leading, spacing: 6) {
                Button { showPanel() } label: { Label("Onaylar ve bu Mac", systemImage: "checkmark.seal") }
                    .buttonStyle(.borderless)
                if !model.vaultLabel.isEmpty {
                    Label("Giriş bilgileri: \(model.vaultLabel)", systemImage: "key")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let error = model.coreError {
            ContentUnavailableCompat(title: "Uygulama çekirdeği çalışmıyor", systemImage: "exclamationmark.triangle", text: error)
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
                if showFiles {
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
                            Menu(vertical ? "Alt alta" : "Yan yana") {
                                Button("Aynı sunucu (\(session.host.label))") { model.split(primary, vertical: vertical, host: session.host) }
                                Divider()
                                ForEach(model.hosts) { h in
                                    Button(h.label) { model.split(primary, vertical: vertical, host: h) }
                                }
                            }
                        }
                    } label: { Label("Böl", systemImage: "rectangle.split.2x1") }
                        .help("Bu terminalin yanına ya da altına ikinci bir terminal aç (en fazla 4)")
                        .disabled(group.count >= 4)
                    Toggle(isOn: Binding(get: { model.broadcast.contains(primary) },
                                         set: { on in if on { model.broadcast.insert(primary) } else { model.broadcast.remove(primary) } })) {
                        Label("Tümüne yaz", systemImage: "dot.radiowaves.left.and.right")
                    }
                    .help("Yazdığın her şey bu bölmedeki tüm terminallere gider")
                    .disabled(group.count < 2)
                    SnippetMenu(model: model, session: session)
                    Button { showTunnels = true } label: { Label("Tüneller", systemImage: "point.3.connected.trianglepath.dotted") }
                        .disabled(session.closed)
                    Toggle(isOn: $showFiles) { Label("Dosyalar", systemImage: "folder") }
                        .disabled(session.closed)
                    Button { model.close(session) } label: { Label("Terminali kapat", systemImage: "xmark") }
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
            default: HostsPage(model: model, edit: { editing = EditRequest(host: $0) })
            }
        }
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if model.hosts.isEmpty {
                    ContentUnavailableCompat(title: "Henüz sunucu yok", systemImage: "server.rack",
                                             text: "\"Yeni sunucu\" ile ekle ya da ~/.ssh/config dosyandan içe aktar.")
                        .frame(maxWidth: .infinity).padding(.top, 60)
                } else if filtered.isEmpty {
                    Text(query.contains("@") ? "Eşleşen sunucu yok. Return'e basarsan bu adrese hızlı bağlanırım." : "Eşleşen sunucu yok.")
                        .foregroundStyle(.secondary)
                }
                ForEach(groups, id: \.0) { group in
                    Text("\(group.0)  ·  \(group.1.count)").font(.headline)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), spacing: 10)], spacing: 10) {
                        ForEach(group.1) { host in
                            HostCard(host: host, via: model.hosts.first { $0.id == host.jumpId }?.label)
                                .onTapGesture { model.open(host) }
                                .contextMenu {
                                    Button("Bağlan") { model.open(host) }
                                    Button("Düzenle…") { edit(host) }
                                    if host.savedSecret {
                                        Button("Kayıtlı giriş bilgisini unut") { Task { await model.forgetSecret(host) } }
                                    }
                                    Divider()
                                    Button("Sil", role: .destructive) { Task { await model.deleteHost(host) } }
                                }
                        }
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Sunucular")
        .searchable(text: $query, prompt: "Sunucu ara ya da kullanıcı@adres")
        .onSubmit(of: .search) { Task { await quickConnect() } }
        .toolbar {
            ToolbarItemGroup {
                Button { Task { await model.importSSHConfig() } } label: { Label("İçe aktar", systemImage: "square.and.arrow.down") }
                Button { edit(nil) } label: { Label("Yeni sunucu", systemImage: "plus") }
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

struct HostCard: View {
    let host: CoreHost
    let via: String?
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "server.rack")
                .font(.system(size: 17))
                .foregroundStyle(.white)
                .frame(width: 38, height: 38)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(host.label).font(.body.weight(.semibold)).lineLimit(1)
                Text(host.target + (via.map { " ↪ \($0)" } ?? "")).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Text(host.savedSecret || (host.authKind == "key" && host.keyPath != nil)
                     ? (host.authKind == "password" ? "Parola kayıtlı" : "Anahtar hazır") : "Giriş bilgisi sorulacak")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .help(host.target + (host.trustedKey.map { "\nSunucu anahtarı: \($0)" } ?? ""))
    }
}

// MARK: - snippets, tunnels, trusted keys, history

struct SnippetMenu: View {
    @ObservedObject var model: ServersModel
    let session: TerminalSession
    @State private var snippets: [Snippet] = []
    var body: some View {
        Menu {
            if snippets.isEmpty { Text("Kayıtlı parçacık yok") }
            ForEach(snippets) { s in Button(s.label) { model.send(s, to: session) } }
        } label: { Label("Parçacık", systemImage: "text.badge.plus") }
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
                Text("Sık kullandığın komutları burada sakla; açık terminalin araç çubuğundaki \"Parçacık\" ile gönder.")
                    .foregroundStyle(.secondary)
            }
            ForEach(snippets) { s in
                VStack(alignment: .leading, spacing: 3) {
                    Text(s.label).font(.body.weight(.semibold))
                    Text(s.command).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2)
                }
                .contextMenu {
                    Button("Düzenle…") { editing = s }
                    Button("Sil", role: .destructive) { Task { snippets = await model.deleteSnippet(s) } }
                }
            }
        }
        .navigationTitle("Parçacıklar")
        .toolbar { Button { adding = true } label: { Label("Yeni parçacık", systemImage: "plus") } }
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
            TextField("Ad", text: $label, prompt: Text("Disk kullanımı"))
            TextEditor(text: $command).font(.body.monospaced()).frame(height: 110)
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
        }
        .formStyle(.grouped)
        .frame(width: 440)
        .onAppear { label = snippet?.label ?? ""; command = snippet?.command ?? "" }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Kaydet") {
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
                Text("Henüz anahtar yok. \"Yeni anahtar\" ile oluştur; genel anahtarını sunucunun ~/.ssh/authorized_keys dosyasına ekle, sonra sunucuyu düzenleyip bu anahtarı seç.")
                    .foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red) }
            ForEach(keys) { k in
                let used = model.hosts.filter { $0.keyId == k.id }.map(\.label)
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(k.label).font(.body.weight(.semibold))
                        Text("\(k.algorithm)  ·  \(k.fingerprint)").font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        Text(used.isEmpty ? "Henüz bir sunucuda kullanılmıyor" : "Kullanan: " + used.joined(separator: ", "))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Genel anahtarı kopyala") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(k.publicKey, forType: .string)
                        model.notice = "Genel anahtar kopyalandı. Sunucuda ~/.ssh/authorized_keys dosyasına ekle."
                    }
                }
                .contextMenu { Button("Sil", role: .destructive) { Task { keys = await model.deleteKey(k) } } }
            }
        }
        .navigationTitle("Anahtarlar")
        .toolbar {
            ToolbarItemGroup {
                Button { importing = true } label: { Label("İçe aktar", systemImage: "square.and.arrow.down") }
                Button {
                    Task {
                        do { keys = try await model.generateKey(label: (Host.current().localizedName ?? "Mac") + " anahtarı"); error = nil }
                        catch { self.error = error.localizedDescription }
                    }
                } label: { Label("Yeni anahtar", systemImage: "plus") }
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
            TextField("Ad", text: $label, prompt: Text("İş anahtarı"))
            Button("Dosyadan seç…") {
                let panel = NSOpenPanel()
                panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh")
                panel.showsHiddenFiles = true
                if panel.runModal() == .OK, let url = panel.url, let text = try? String(contentsOf: url, encoding: .utf8) {
                    key = text
                    if label.isEmpty { label = url.lastPathComponent }
                }
            }
            TextEditor(text: $key).font(.caption.monospaced()).frame(height: 120)
            SecureField("Anahtar parolası (varsa)", text: $passphrase)
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
        }
        .formStyle(.grouped)
        .frame(width: 460)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("İçe aktar") {
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
                Text("Kayıtlı tünel yok. Bir terminalde \"Tüneller\" ile açıp \"kaydet\"i işaretle. Yerel (ssh -L), uzak (ssh -R) ve SOCKS (ssh -D) tünelleri kaydedilebilir.").foregroundStyle(.secondary)
            }
            ForEach(model.savedTunnels) { tunnel in
                Toggle(isOn: Binding(get: { tunnel.running }, set: { _ in Task { await model.toggleTunnel(tunnel) } })) {
                    VStack(alignment: .leading) {
                        Text(tunnel.hostLabel)
                        Text("\(tunnelKindLabel(tunnel.kind))   \(tunnel.local) → \(tunnel.remote)").font(.caption.monospaced()).foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.switch)
                .contextMenu { Button("Tüneli sil", role: .destructive) { Task { await model.deleteTunnel(tunnel) } } }
            }
        }
        .navigationTitle("Tüneller")
    }
}

struct KnownHostsPage: View {
    @ObservedObject var model: ServersModel
    @State private var known: [KnownHost] = []
    var body: some View {
        List {
            if known.isEmpty { Text("Henüz güvenilen sunucu anahtarı yok.").foregroundStyle(.secondary) }
            ForEach(known) { k in
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(k.target + (k.labels.isEmpty ? "" : "  ·  " + k.labels.joined(separator: ", "))).font(.body.weight(.semibold))
                        Text(k.fingerprint).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                    Spacer()
                    Button("Unut") { Task { known = await model.forgetKnownHost(k) } }
                        .help("Bir sonraki bağlantıda anahtar yeniden sorulur.")
                }
            }
        }
        .navigationTitle("Bilinen sunucular")
        .task { known = await model.knownHosts() }
    }
}

struct HistoryPage: View {
    @ObservedObject var model: ServersModel
    @State private var history: [HistoryEntry] = []
    var body: some View {
        List {
            if history.isEmpty { Text("Henüz bağlantı yok.").foregroundStyle(.secondary) }
            ForEach(history) { h in
                HStack {
                    Text("\(h.label)  ·  \(h.target)").lineLimit(1)
                    Spacer()
                    Text(h.date, format: .dateTime.day().month().year().hour().minute()).foregroundStyle(.secondary)
                    if let host = model.hosts.first(where: { $0.id == h.hostId }) {
                        Button("Bağlan") { model.open(host) }
                    }
                }
            }
        }
        .navigationTitle("Geçmiş")
        .toolbar { Button { Task { await model.clearHistory(); history = [] } } label: { Label("Temizle", systemImage: "trash") } }
        .task { history = await model.history() }
    }
}

/// `ContentUnavailableView` is macOS 14+; this works on 13.
struct ContentUnavailableCompat: View {
    let title: String
    let systemImage: String
    let text: String
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage).font(.system(size: 38)).foregroundStyle(.secondary)
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
                if let via { Text("↪ \(via) üzerinden").font(.caption2).foregroundStyle(.secondary) }
            }
            Spacer()
            if host.savedSecret || host.keyPath != nil {
                Image(systemName: "key.fill").foregroundStyle(.secondary).help("Giriş bilgisi kayıtlı")
            }
        }
        .help(host.trustedKey.map { "Sunucu anahtarı: \($0)" } ?? "Sunucu anahtarı henüz onaylanmadı")
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
                    Text(session.host.label + (session.closed ? " (kapandı)" : "")).font(.caption).lineLimit(1)
                    Spacer()
                    Button { model.close(session) } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .help("Bu bölmeyi kapat")
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
                Text("Kimlik, bir kullanıcı adı ile anahtarı ya da parolasıdır; birçok sunucuda kullanılır (örneğin \"deploy + ekip anahtarı\"). Bir kez oluştur, sunucuyu düzenlerken seç.")
                    .foregroundStyle(.secondary)
            }
            ForEach(identities) { i in
                let used = model.hosts.filter { $0.identityId == i.id }.map(\.label)
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(i.label).font(.body.weight(.semibold))
                        Text(i.user + "  ·  " + (i.authKind == "password" ? "Parola" : "Anahtar: " + (keys.first { $0.id == i.keyId }?.label ?? "seçilmemiş")))
                            .foregroundStyle(.secondary)
                        Text(used.isEmpty ? "Henüz bir sunucuda kullanılmıyor" : "Kullanan: " + used.joined(separator: ", "))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Düzenle") { editing = IdentityEdit(identity: i) }
                    Button(role: .destructive) { Task { identities = await model.deleteIdentity(i) } } label: { Image(systemName: "trash") }
                }
            }
        }
        .navigationTitle("Kimlikler")
        .toolbar { Button { editing = IdentityEdit(identity: nil) } label: { Label("Yeni kimlik", systemImage: "plus") } }
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
            TextField("Ad", text: $label, prompt: Text("Ekip deploy"))
            TextField("Kullanıcı", text: $user)
            Picker("Giriş", selection: $authKind) {
                Text("Anahtar").tag("key")
                Text("Parola").tag("password")
            }
            if authKind == "key" {
                Picker("Anahtar", selection: $keyId) {
                    Text(keys.isEmpty ? "Önce Anahtarlar'dan bir anahtar oluştur" : "Seç").tag("")
                    ForEach(keys) { Text($0.label).tag($0.id) }
                }
            } else {
                SecureField(identity == nil ? "Parola" : "Parola (boşsa kayıtlı parola kalır)", text: $password)
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
            ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Kaydet") {
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
    @State private var status: String?

    var body: some View {
        Form {
            Section("Terminal") {
                Stepper(value: $fontSize, in: 8...32, step: 1) { Text("Yazı boyutu: \(Int(fontSize))") }
                Text("Yeni açılan terminallerde geçerli olur.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Eşitleme (bilgisayarların arasında)") {
                SyncSection(model: model)
            }
            Section("Yedekleme") {
                Text("Sunucular, gruplar, tüneller, parçacıklar, kimlikler ve güvenilen sunucu anahtarları tek bir dosyaya yazılır. Parolalar ve özel anahtarlar dosyaya girmez; yeni bilgisayarda ilk bağlantıda bir kez sorulur. İçe aktarma var olanları değiştirmez, yalnız yenileri ekler.")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button("Dışa aktar…") { Task { await exportBackup() } }
                    Button("İçe aktar…") { Task { await importBackup() } }
                }
                if let status { Text(status).font(.callout) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Ayarlar")
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
            status = "Yedek kaydedildi: \(url.path)"
        } catch {
            status = "Yedek kaydedilemedi: \(error.localizedDescription)"
        }
    }

    private func importBackup() async {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let s = try await model.importLibrary(try String(contentsOf: url, encoding: .utf8))
            status = "İçe aktarıldı: \(s.hosts) sunucu, \(s.snippets) parçacık, \(s.knownHosts) sunucu anahtarı"
                + (s.skipped > 0 ? " (\(s.skipped) sunucu zaten vardı, atlandı)." : ".")
        } catch {
            status = "Yedek içe aktarılamadı: \(error.localizedDescription)"
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
        Text("Sunucular, gruplar, tüneller, parçacıklar, kimlikler, anahtarlar ve kayıtlı parolalar aynı hesapla oturum açtığın tüm bilgisayarlarda aynı olur. Her şey bu Mac'te, yalnız senin bildiğin eşitleme parolasıyla şifrelenir; WECOMMANDER sunucusu içeriği göremez. Parolayı unutursan eşitlenen kopya açılamaz.")
            .font(.callout).foregroundStyle(.secondary)
        if model.syncConfigured {
            Text("● Eşitleme açık. " + (model.lastLibrarySync.map { "Son eşitleme: \($0.formatted(date: .omitted, time: .shortened))" } ?? "Henüz eşitlenmedi"))
            if let e = model.librarySyncError { Text(e).foregroundStyle(.red).font(.callout) }
            HStack {
                Button("Şimdi eşitle") { Task { await model.syncLibrary() } }
                Button("Bu Mac'te kapat") { Task { await model.forgetSync() } }
            }
        } else {
            SecureField("Eşitleme parolası (en az 8 karakter)", text: $passphrase)
            SecureField("Parolayı tekrar yaz", text: $again)
            Text("Başka bir bilgisayarda eşitlemeyi zaten açtıysan oradaki parolayı gir.").font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
            Button("Eşitlemeyi aç") {
                guard passphrase == again else { error = "Parolalar aynı değil."; return }
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
        view.terminalDelegate = context.coordinator
        let size = UserDefaults.standard.double(forKey: "terminalFontSize")
        view.font = NSFont.monospacedSystemFont(ofSize: size >= 8 ? size : 13, weight: .regular)
        view.nativeBackgroundColor = NSColor(red: 0.07, green: 0.07, blue: 0.075, alpha: 1)
        view.nativeForegroundColor = NSColor(white: 0.9, alpha: 1)
        session.feed = { [weak view] bytes in view?.feed(byteArray: bytes[...]) }
        DispatchQueue.main.async { view.window?.makeFirstResponder(view) }
        return view
    }

    func updateNSView(_ view: TerminalView, context: Context) {}

    static func dismantleNSView(_ view: TerminalView, coordinator: Coordinator) {
        coordinator.session.feed = nil
    }

    @MainActor
    final class Coordinator: NSObject, TerminalViewDelegate {
        let model: ServersModel
        let session: TerminalSession
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
    @State private var error: String?

    var body: some View {
        Form {
            TextField("Ad", text: $label, prompt: Text("Prod web"))
            TextField("Adres", text: $address, prompt: Text("sunucu.ornek.com"))
            Picker("Kimlik", selection: $identityId) {
                Text("Yok (bu sunucunun kendi kullanıcısı ve giriş bilgisi)").tag("")
                ForEach(identities) { Text("\($0.label) (\($0.user))").tag($0.id) }
            }
            .onChange(of: identityId) { id in
                if let i = identities.first(where: { $0.id == id }) { user = i.user }
            }
            TextField("Kullanıcı", text: $user).disabled(!identityId.isEmpty)
            TextField("Port", text: $port)
            TextField("Grup (isteğe bağlı)", text: $group, prompt: Text("Production"))
            if identityId.isEmpty {
                Picker("Giriş", selection: $authKind) {
                    Text("Özel anahtar").tag("key")
                    Text("Parola").tag("password")
                }
                Picker("Anahtar", selection: $keyId) {
                    Text("Bağlanırken sor / anahtar dosyası").tag("")
                    ForEach(keys) { Text($0.label).tag($0.id) }
                }
            }
            Picker("Atlama sunucusu", selection: $jumpId) {
                Text("Doğrudan bağlan").tag("")
                ForEach(model.hosts.filter { $0.id != host?.id }) { Text($0.label).tag($0.id) }
            }
            Section("Terminal seçenekleri") {
                TextField("Bağlanınca çalışacak komut", text: $startup, prompt: Text("cd /var/www && git status"))
                    .font(.body.monospaced())
                VStack(alignment: .leading, spacing: 4) {
                    Text("Ortam değişkenleri (her satıra AD=değer)").font(.callout)
                    TextEditor(text: $envText).font(.body.monospaced()).frame(height: 60)
                }
                Toggle("SSH agent yönlendirme (ssh -A)", isOn: $agentForwarding)
                    .help("Yalnız güvendiğin sunucularda aç: sunucuda yönetici yetkisi olan biri, bağlantı açıkken agent'taki anahtarlarını kullanabilir.")
            }
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .task { keys = await model.keys(); identities = await model.identities() }
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
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Kaydet") {
                    Task {
                        do {
                            let jump = jumpId.isEmpty ? nil : jumpId
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
                            var env: [String: String] = [:]
                            for line in envText.split(whereSeparator: \.isNewline) {
                                let t = line.trimmingCharacters(in: .whitespaces)
                                if t.isEmpty || t.hasPrefix("#") { continue }
                                guard let eq = t.firstIndex(of: "="), eq != t.startIndex else {
                                    throw CoreClient.Failure.core("Ortam değişkeni AD=değer biçiminde olmalı: \(t)")
                                }
                                env[String(t[..<eq]).trimmingCharacters(in: .whitespaces)] = String(t[t.index(after: eq)...])
                            }
                            let command = startup.trimmingCharacters(in: .whitespaces)
                            if let s = saved, (s.startupCommand ?? "") != command || (s.env ?? [:]) != env || (s.agentForwarding ?? false) != agentForwarding {
                                try await model.setOptions(s, startupCommand: command, env: env, agentForwarding: agentForwarding)
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
                Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.callout)
            }
            HStack {
                Spacer()
                Button("Vazgeç") { model.connect = nil }.keyboardShortcut(.cancelAction)
                if let hostKey = request.hostKey {
                    Button(hostKey.status == "hostKeyChanged" ? "Yeni anahtara yine de güven" : "Güven ve bağlan") {
                        busy = true
                        Task { await model.run(request.host, auth: request.auth ?? [:], accept: hostKey.fingerprint) }
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(busy)
                } else {
                    Button("Bağlan") {
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
        }
        return a
    }

    private var credentialForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("", selection: $kind) {
                Text("Özel anahtar").tag("key")
                Text("Parola").tag("password")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            if kind == "key" {
                HStack {
                    Button("Anahtar dosyası seç…") { pickKey() }
                    Text(keyPath ?? "ya da anahtarı aşağıya yapıştır")
                        .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                }
                if keyPath == nil {
                    TextEditor(text: $key)
                        .font(.caption.monospaced())
                        .frame(height: 110)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                }
                SecureField("Anahtar parolası (varsa)", text: $passphrase)
            } else {
                SecureField("Parola", text: $password)
            }
            Toggle("macOS Anahtar Zinciri'nde sakla", isOn: $remember)
        }
    }

    private func hostKeyBox(_ result: ConnectResult) -> some View {
        let changed = result.status == "hostKeyChanged"
        return VStack(alignment: .leading, spacing: 8) {
            Label(changed ? "Bu sunucunun anahtarı değişti" : "Bu sunucuya ilk kez bağlanıyorsun",
                  systemImage: changed ? "exclamationmark.octagon.fill" : "lock.shield")
                .font(.headline)
                .foregroundStyle(changed ? .red : .primary)
            Text(changed
                 ? "Güvendiğin anahtar \(result.trusted ?? "") idi. Sunucuyu yeniden kurmadıysan bağlanma; araya biri girmiş olabilir."
                 : "\(result.algorithm ?? "") anahtarının parmak izi aşağıda. Sunucu yöneticisinden aldığın değerle aynıysa güven.")
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
        panel.message = "Özel anahtar dosyası (ör. ~/.ssh/id_ed25519)"
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
                Button { load(listing?.parent) } label: { Image(systemName: "arrow.up") }.help("Üst klasör")
                Text(listing?.path ?? "…").font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
                Spacer()
                Button { load(listing?.path) } label: { Image(systemName: "arrow.clockwise") }.help("Yenile")
                Menu {
                    Button("Dosya yükle…") { upload() }
                    Button("Yeni klasör…") { newFolder() }
                } label: { Image(systemName: "plus") }
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
                        Image(systemName: entry.isFolder ? "folder.fill" : entry.kind == "link" ? "link" : "doc")
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
                        if !entry.isFolder { Button("İndir…") { download(entry) } }
                        Button("Yeniden adlandır…") { rename(entry) }
                        Button("Sil", role: .destructive) { delete(entry) }
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
            Text("Dosyaları buraya sürükleyip bırakarak da yükleyebilirsin.")
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
        alert.addButton(withTitle: "Tamam")
        alert.addButton(withTitle: "Vazgeç")
        return alert.runModal() == .alertFirstButtonReturn ? field.stringValue.trimmingCharacters(in: .whitespaces) : nil
    }

    private func join(_ dir: String, _ name: String) -> String { dir.hasSuffix("/") ? dir + name : dir + "/" + name }

    private func newFolder() {
        guard let dir = listing?.path, let name = ask("Yeni klasör", ""), !name.isEmpty else { return }
        Task {
            do { try await model.filesAction("files.mkdir", session, ["path": join(dir, name)]); load(dir) }
            catch { model.notice = error.localizedDescription }
        }
    }

    private func rename(_ entry: RemoteEntry) {
        guard let dir = listing?.path, let name = ask("Yeniden adlandır", entry.name), !name.isEmpty, name != entry.name else { return }
        Task {
            do { try await model.filesAction("files.rename", session, ["from": entry.path, "to": join(dir, name)]); load(dir) }
            catch { model.notice = error.localizedDescription }
        }
    }

    private func delete(_ entry: RemoteEntry) {
        let alert = NSAlert()
        alert.messageText = "\(entry.name) silinsin mi?"
        alert.informativeText = entry.isFolder ? "Yalnızca boş klasörler silinebilir." : "Bu işlem geri alınamaz."
        alert.addButton(withTitle: "Sil")
        alert.addButton(withTitle: "Vazgeç")
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
    case "remote": return "Uzak (-R)"
    case "dynamic": return "SOCKS (-D)"
    default: return "Yerel (-L)"
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
        case "remote": return "Sunucu bir port açar; oraya gelen bağlantılar bu Mac'teki bir servise gelir (ssh -R). Sunucu varsayılan olarak yalnız kendi içinden (localhost) dinler."
        case "dynamic": return "Bu Mac'te bir SOCKS5 proxy açar; tarayıcını bu proxy'ye yönlendirirsen trafik sunucunun ağından çıkar (ssh -D). Yalnızca bu Mac'ten erişilebilir."
        default: return "Bu Mac'teki bir portu sunucunun erişebildiği bir adrese bağlar (ssh -L). Yalnızca bu Mac'ten (127.0.0.1) erişilebilir."
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
            Text("Tüneller · \(session.host.label)").font(.headline)
            ForEach(forwards, id: \.stopId) { f in
                HStack {
                    Text(tunnelKindLabel(f.kind)).foregroundStyle(.secondary)
                    Text("\(f.local) → \(f.remote)").font(.callout.monospaced()).textSelection(.enabled)
                    Spacer()
                    Button("Kapat") { Task { forwards = await model.stopForward(session, local: f.stopId) } }
                }
            }
            Picker("Tür", selection: $kind) {
                Text("Yerel (-L)").tag("local")
                Text("Uzak (-R)").tag("remote")
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
                    TextField("Sunucu adresi", text: $remoteHost)
                    TextField("Sunucu portu (0 = seçsin)", text: $remotePort).frame(width: 170)
                    Image(systemName: "arrow.right")
                    TextField("Bu Mac'teki adres", text: $localHost)
                    TextField("Port", text: $localPort).frame(width: 70)
                }
            case "dynamic":
                TextField("Proxy portu (0 = boş)", text: $localPort).frame(width: 180)
            default:
                HStack {
                    TextField("Yerel port (0 = boş)", text: $localPort).frame(width: 140)
                    Image(systemName: "arrow.right")
                    TextField("Uzak adres", text: $remoteHost)
                    TextField("Port", text: $remotePort).frame(width: 70)
                }
            }
            Toggle("Bu tüneli kaydet (Tüneller sayfasından ve menü çubuğundan açılır)", isOn: $save)
            if let status { Text(status).font(.callout).foregroundStyle(.secondary) }
            HStack {
                Spacer()
                Button("Kapat") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Tünel aç") {
                    Task {
                        do {
                            forwards = try await model.startForward(
                                session, kind: kind, localPort: Int(localPort) ?? 0,
                                localHost: kind == "remote" ? localHost : nil,
                                remoteHost: kind == "dynamic" ? "" : remoteHost, remotePort: Int(remotePort) ?? 0, save: save)
                            status = forwards.last.map { f in
                                switch kind {
                                case "remote": return "Açıldı: sunucuda \(f.local) → bu Mac'te \(f.remote)."
                                case "dynamic": return "Açıldı: uygulamanda SOCKS5 proxy olarak \(f.local) adresini kullan."
                                default: return "Açıldı: \(f.local) adresine bağlan."
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
