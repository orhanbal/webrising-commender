import AppKit
import CenterCore
import SwiftUI

// The menu bar is the Mac's Dock: the server monitor's panel ends with the
// same quick tiles as the Windows Dock's quick panel. Every tile only opens a
// screen (servers, terminals, files, Task Manager, scheduled tasks, server
// timers, disk, approvals, settings); nothing risky runs from here.

/// What each tile opens (set by the app delegate).
struct QuickActions {
    var servers: () -> Void = {}
    var terminals: () -> Void = {}
    var files: () -> Void = {}
    var taskManager: () -> Void = {}
    var scheduled: () -> Void = {}
    var timers: () -> Void = {}
    var disk: () -> Void = {}
    var approvals: () -> Void = {}
    var settings: () -> Void = {}
    var openMain: () -> Void = {}
}

struct QuickTile: Identifiable {
    let id: String
    let icon: WCIconName
    let title: String
    var detail: String?
    var alert = false
    let action: () -> Void
}

struct QuickTiles: View {
    @ObservedObject var app: AppModel
    let actions: QuickActions

    private var tiles: [QuickTile] {
        let pending = app.pending.count
        let waiting: String = pending == 0 ? L.t("Bekleyen onay yok") : L.f("{0} onay bekliyor", pending)
        return [
            QuickTile(id: "servers", icon: .server, title: L.t("Sunucularım"), action: actions.servers),
            QuickTile(id: "terminals", icon: .terminal, title: L.t("Terminaller"), action: actions.terminals),
            QuickTile(id: "files", icon: .folder, title: L.t("Dosyalar"), action: actions.files),
            QuickTile(id: "tasks", icon: .activity, title: L.t("Görev Yöneticisi"), action: actions.taskManager),
            QuickTile(id: "scheduled", icon: .calendar, title: L.t("Zamanlanmış görevler"), action: actions.scheduled),
            QuickTile(id: "timers", icon: .timer, title: L.t("Sunucu zamanlayıcıları"), action: actions.timers),
            QuickTile(id: "disk", icon: .disk, title: L.t("Disk ve temizlik"), action: actions.disk),
            QuickTile(id: "approvals", icon: .approvals, title: L.t("Onaylar"), detail: waiting, alert: pending > 0, action: actions.approvals),
            QuickTile(id: "settings", icon: .settings, title: L.t("Ayarlar"), action: actions.settings),
        ]
    }

    var body: some View {
        let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
        VStack(spacing: 10) {
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(tiles) { tile in QuickTileButton(tile: tile) }
            }
            Button(action: actions.openMain) {
                Text(L.t("WECOMMANDER'ı aç")).lineLimit(1).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
    }
}

private struct QuickTileButton: View {
    let tile: QuickTile
    @State private var hover = false

    var body: some View {
        Button(action: tile.action) {
            VStack(alignment: .leading, spacing: 5) {
                WCIcon(tile.icon, size: 20)
                    .foregroundStyle(Color.accentColor)
                Text(tile.title)
                    .font(.callout)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = tile.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(tile.alert ? Color.red : Color.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .topLeading)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor).opacity(hover ? 1 : 0.7)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(hover ? 0.35 : 0.15)))
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(tile.title)
        .accessibilityLabel(tile.title)
    }
}
