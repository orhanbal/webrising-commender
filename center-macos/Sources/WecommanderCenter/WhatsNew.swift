import AppKit
import CenterCore
import SwiftUI

/// "Yenilikler" (what's new): once after an update the notes added since the
/// last one shown open in a small window; "Tamam" (or closing it) remembers the
/// newest. A fresh install only remembers the newest. The menu bar menu, the
/// panel and the settings page show every note.
@MainActor
enum WhatsNew {
    private static var window: NSWindow?
    private static var delegate: ServerWindowDelegate?
    private static var checked = false

    /// At start: at most once per run.
    static func showIfUpdated(model: AppModel) {
        if checked { return }
        checked = true
        let notes = ReleaseNotes.filter(ReleaseNotes.embedded, platform: ReleaseNotes.macOS)
        let decision = ReleaseNotes.atStart(notes, lastSeen: model.settings.lastSeenNotes, settingsExisted: model.settingsExisted)
        guard !decision.show.isEmpty else {
            if let id = decision.remember { model.rememberNotes(id) }
            return
        }
        let remember = decision.remember
        // After the windows of the start are up, so it opens in front of them.
        DispatchQueue.main.async {
            show(decision.show) {
                if let id = remember { model.rememberNotes(id) }
            }
        }
    }

    /// Every note for macOS (menu, panel, settings).
    static func showAll(model: AppModel) {
        let notes = ReleaseNotes.filter(ReleaseNotes.embedded, platform: ReleaseNotes.macOS)
        show(notes) {
            if let newest = notes.first?.id { model.rememberNotes(newest) }
        }
    }

    private static func show(_ notes: [ReleaseNote], closed: @escaping @MainActor () -> Void) {
        if let old = window {
            old.delegate = nil
            old.close()
            window = nil
        }
        let view = WhatsNewView(notes: notes) { WhatsNew.window?.close() }
        let created = NSWindow(contentViewController: NSHostingController(rootView: view))
        created.title = L.t("Yenilikler")
        created.styleMask = [.titled, .closable]
        created.setContentSize(NSSize(width: 480, height: 440))
        created.isReleasedWhenClosed = false
        // The window and its delegate stay referenced until the next one replaces them.
        let d = ServerWindowDelegate { closed() }
        created.delegate = d
        window = created
        delegate = d
        created.center()
        created.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct WhatsNewView: View {
    let notes: [ReleaseNote]
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L.t("WECOMMANDER'da yenilikler")).font(.title2).bold()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if notes.isEmpty {
                        Text(L.t("Henüz yenilik notu yok.")).foregroundStyle(.secondary)
                    }
                    ForEach(notes, id: \.id) { note in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(note.dateText(L.locale)).font(.headline)
                            ForEach(Array(note.lines(L.current).enumerated()), id: \.offset) { _, line in
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text("•").foregroundStyle(.secondary)
                                    Text(line).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                                }
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Spacer()
                Button(L.t("Tamam"), action: done)
                    .keyboardShortcut(.defaultAction)
                    .controlSize(.large)
            }
        }
        .padding(20)
        .frame(minWidth: 420, minHeight: 360)
    }
}
