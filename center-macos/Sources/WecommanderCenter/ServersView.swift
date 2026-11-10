import AppKit
import CenterCore
import SwiftTerm
import SwiftUI
import UniformTypeIdentifiers

/// The Servers window: a native sidebar of saved hosts and terminal tabs
/// (SwiftTerm), with Files and Tunnels as inspector sheets.
struct ServersView: View {
    @ObservedObject var model: ServersModel
    @State private var addingHost = false
    @State private var showFiles = false
    @State private var showTunnels = false

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 260)
        } detail: {
            detail
        }
        .sheet(isPresented: $addingHost) { AddHostSheet(model: model) }
        .sheet(item: $model.connect) { request in ConnectSheet(model: model, request: request) }
        .sheet(isPresented: $showTunnels) {
            if let s = model.selectedSession { TunnelsSheet(model: model, session: s) }
        }
        .alert("WECOMMANDER", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button("Tamam", role: .cancel) {}
        } message: {
            Text(model.notice ?? "")
        }
        .frame(minWidth: 820, minHeight: 480)
    }

    private var sidebar: some View {
        List(selection: Binding(get: { model.selection }, set: { model.selection = $0 })) {
            Section("Sunucular") {
                ForEach(model.hosts) { host in
                    HostRow(host: host, via: model.hosts.first { $0.id == host.jumpId }?.label)
                        .contentShape(Rectangle())
                        .onTapGesture(count: 2) { model.open(host) }
                        .contextMenu {
                            Button("Terminal aç") { model.open(host) }
                            if host.savedSecret {
                                Button("Kayıtlı giriş bilgisini unut") { Task { await model.forgetSecret(host) } }
                            }
                            Divider()
                            Button("Sunucuyu sil", role: .destructive) { Task { await model.deleteHost(host) } }
                        }
                }
                if model.hosts.isEmpty {
                    Text("Henüz sunucu yok. + ile ekle ya da ~/.ssh/config'den içe aktar.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            if !model.sessions.isEmpty {
                Section("Açık terminaller") {
                    ForEach(model.sessions) { session in
                        Label(session.host.label, systemImage: session.closed ? "terminal" : "terminal.fill")
                            .foregroundStyle(session.closed ? .secondary : .primary)
                            .tag(Optional(session.id))
                    }
                }
            }
            if !model.savedTunnels.isEmpty {
                Section("Tüneller") {
                    ForEach(model.savedTunnels) { tunnel in
                        Toggle(isOn: Binding(get: { tunnel.running }, set: { _ in Task { await model.toggleTunnel(tunnel) } })) {
                            VStack(alignment: .leading) {
                                Text(tunnel.hostLabel)
                                Text("\(tunnel.local) → \(tunnel.remote)").font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                        }
                        .toggleStyle(.switch)
                        .contextMenu { Button("Tüneli sil", role: .destructive) { Task { await model.deleteTunnel(tunnel) } } }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            if !model.vaultLabel.isEmpty {
                Label("Giriş bilgileri: \(model.vaultLabel)", systemImage: "key")
                    .font(.caption).foregroundStyle(.secondary).padding(8)
            }
        }
        .toolbar {
            ToolbarItem {
                Menu {
                    Button("Sunucu ekle…") { addingHost = true }
                    Button("~/.ssh/config'den içe aktar") { Task { await model.importSSHConfig() } }
                } label: { Label("Ekle", systemImage: "plus") }
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let error = model.coreError {
            ContentUnavailableCompat(title: "Uygulama çekirdeği çalışmıyor", systemImage: "exclamationmark.triangle", text: error)
        } else if let session = model.selectedSession {
            HStack(spacing: 0) {
                TerminalHost(model: model, session: session)
                    .id(session.id)
                if showFiles {
                    Divider()
                    FilesPane(model: model, session: session)
                        .frame(width: 340)
                        .id("files-" + session.id)
                }
            }
            .navigationTitle(session.host.label)
            .navigationSubtitle(session.host.target)
            .toolbar {
                ToolbarItemGroup {
                    Button { showTunnels = true } label: { Label("Tüneller", systemImage: "point.3.connected.trianglepath.dotted") }
                        .disabled(session.closed)
                    Toggle(isOn: $showFiles) { Label("Dosyalar", systemImage: "folder") }
                        .disabled(session.closed)
                    Button { model.close(session) } label: { Label("Terminali kapat", systemImage: "xmark") }
                }
            }
        } else {
            ContentUnavailableCompat(
                title: "Bir sunucu seç",
                systemImage: "terminal",
                text: "Soldaki listeden bir sunucuya çift tıkla; terminal burada açılır.")
        }
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

// MARK: - terminal (SwiftTerm)

struct TerminalHost: NSViewRepresentable {
    @ObservedObject var model: ServersModel
    @ObservedObject var session: TerminalSession

    func makeCoordinator() -> Coordinator { Coordinator(model: model, session: session) }

    func makeNSView(context: Context) -> TerminalView {
        let view = TerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        view.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
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

struct AddHostSheet: View {
    @ObservedObject var model: ServersModel
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var host = ""
    @State private var user = ""
    @State private var port = "22"
    @State private var authKind = "key"
    @State private var jumpId = ""
    @State private var error: String?

    var body: some View {
        Form {
            TextField("Ad", text: $label, prompt: Text("Prod web"))
            TextField("Adres", text: $host, prompt: Text("sunucu.ornek.com"))
            TextField("Kullanıcı", text: $user)
            TextField("Port", text: $port)
            Picker("Giriş", selection: $authKind) {
                Text("Özel anahtar").tag("key")
                Text("Parola").tag("password")
            }
            Picker("Atlama sunucusu", selection: $jumpId) {
                Text("Doğrudan bağlan").tag("")
                ForEach(model.hosts) { Text($0.label).tag($0.id) }
            }
            if let error { Text(error).foregroundStyle(.red).font(.callout) }
        }
        .formStyle(.grouped)
        .frame(width: 420)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Vazgeç") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Kaydet") {
                    Task {
                        do {
                            try await model.addHost(label: label, host: host, port: Int(port) ?? 0, user: user,
                                                    authKind: authKind, jumpId: jumpId.isEmpty ? nil : jumpId)
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
                .disabled(label.isEmpty || host.isEmpty || user.isEmpty)
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

struct TunnelsSheet: View {
    @ObservedObject var model: ServersModel
    @ObservedObject var session: TerminalSession
    @Environment(\.dismiss) private var dismiss
    @State private var forwards: [ForwardInfo] = []
    @State private var localPort = ""
    @State private var remoteHost = "127.0.0.1"
    @State private var remotePort = ""
    @State private var save = false
    @State private var status: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Tüneller · \(session.host.label)").font(.headline)
            Text("Bu Mac'teki bir portu sunucunun erişebildiği bir adrese bağlar (ssh -L). Yalnızca bu Mac'ten (127.0.0.1) erişilebilir.")
                .font(.callout).foregroundStyle(.secondary)
            ForEach(forwards, id: \.local) { f in
                HStack {
                    Text("\(f.local) → \(f.remote)").font(.callout.monospaced())
                    Spacer()
                    Button("Kapat") { Task { forwards = await model.stopForward(session, local: f.local) } }
                }
            }
            HStack {
                TextField("Yerel port (0 = boş)", text: $localPort).frame(width: 140)
                Image(systemName: "arrow.right")
                TextField("Uzak adres", text: $remoteHost)
                TextField("Port", text: $remotePort).frame(width: 70)
            }
            Toggle("Bu tüneli kaydet (menü çubuğundan da açılır)", isOn: $save)
            if let status { Text(status).font(.callout).foregroundStyle(.secondary) }
            HStack {
                Spacer()
                Button("Kapat") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Tünel aç") {
                    Task {
                        do {
                            forwards = try await model.startForward(session, localPort: Int(localPort) ?? 0,
                                                                    remoteHost: remoteHost, remotePort: Int(remotePort) ?? 0, save: save)
                            status = forwards.last.map { "Açıldı: \($0.local) adresine bağlan." }
                        } catch {
                            status = error.localizedDescription
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(Int(remotePort) == nil)
            }
        }
        .padding(20)
        .frame(width: 520)
        .task { forwards = await model.forwards(session) }
    }
}
