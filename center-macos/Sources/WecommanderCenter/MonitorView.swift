import AppKit
import CenterCore
import SwiftUI

/// The menu bar server monitor's panel: each watched server with live
/// CPU, memory, disk and network, and a CPU history line; then the quick
/// tiles of the Windows Dock's quick panel.
struct MonitorView: View {
    @ObservedObject var monitor: ServerMonitor
    @ObservedObject var servers: ServersModel
    @ObservedObject var app: AppModel
    var openTerminal: (CoreHost) -> Void
    var actions: QuickActions

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L.t("WECOMMANDER Sunucularım")).font(.headline)
                    Text(L.t("Canlı · 3 saniyede bir")).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                addMenu
            }
            if monitor.servers.isEmpty {
                Text(L.t("İzlenen sunucu yok")).font(.callout.weight(.semibold))
                Text(L.t("Sağ üstteki + ile izlenecek sunucuyu seç; işlemci, bellek ve disk burada canlı görünür."))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                ScrollView {
                    VStack(spacing: 10) {
                        ForEach(monitor.servers) { s in ServerCard(server: s, host: servers.hosts.first { $0.id == s.id },
                                                                    unwatch: { monitor.unwatch(s.id) }, openTerminal: openTerminal) }
                    }
                }
                .frame(maxHeight: 300)
            }
            Divider()
            QuickTiles(app: app, actions: actions)
        }
        .padding(14)
        .frame(width: 360)
    }

    private var addMenu: some View {
        let candidates = servers.hosts.filter { $0.isSsh && !monitor.isWatched($0.id) }
        return Menu {
            if candidates.isEmpty {
                Text(L.t("Eklenecek başka sunucu yok"))
            } else {
                ForEach(candidates) { h in Button(h.label) { monitor.watch(h) } }
            }
        } label: {
            WCIcon(.add)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help(L.t("İzlenecek sunucu ekle"))
        .accessibilityLabel(L.t("İzlenecek sunucu ekle"))
    }
}

private struct ServerCard: View {
    let server: WatchedServer
    let host: CoreHost?
    let unwatch: () -> Void
    let openTerminal: (CoreHost) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Circle().fill(MonitorColors.tint(server.live ? server.reading.worst : nil)).frame(width: 8, height: 8)
                Text(server.label).font(.callout.weight(.semibold)).lineLimit(1).truncationMode(.tail)
                Spacer()
                Menu {
                    if let host { Button(L.t("Terminal aç")) { openTerminal(host) } }
                    Button(L.t("İzlemeyi bırak"), role: .destructive) { unwatch() }
                } label: { WCIcon(.more) }
                .menuStyle(.borderlessButton).fixedSize()
            }
            if let error = server.error {
                Text(error).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else if let last = server.last {
                Text(L.f("Çalışıyor · yük {0}", String(format: "%.2f", last.load1)))
                    .font(.caption).foregroundStyle(.secondary)
                Meter(title: L.t("İşlemci"), value: server.reading.hasRates ? server.reading.cpu : nil)
                Meter(title: L.t("Bellek"), value: server.reading.mem)
                Meter(title: L.t("Disk"), value: server.reading.disk)
                if server.reading.hasRates {
                    Text(L.f("Ağ  ↓ {0}   ↑ {1}", Sizes.rate(server.reading.rx), Sizes.rate(server.reading.tx)))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                if server.cpuHistory.count > 1 {
                    Sparkline(values: server.cpuHistory).frame(height: 28)
                        .accessibilityLabel(L.t("İşlemci geçmişi"))
                }
                Text(last.zombies > 0 ? L.f("{0} zombi süreç", last.zombies) : L.t("Zombi süreç yok"))
                    .font(.caption).foregroundStyle(last.zombies > 0 ? Color.orange : Color.secondary)
            } else {
                Text(L.t("Bağlanıyor…")).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
    }
}

private struct Meter: View {
    let title: String
    /// nil while it is still being measured.
    let value: Double?

    var body: some View {
        HStack(spacing: 8) {
            Text(title).font(.caption).lineLimit(1).truncationMode(.tail).frame(width: 78, alignment: .leading)
            ProgressView(value: min(max(value ?? 0, 0), 100), total: 100)
                .tint(MonitorColors.tint(value))
            Text(value.map { Percent.text($0) } ?? L.t("ölçülüyor"))
                .font(.caption.monospacedDigit()).frame(width: 64, alignment: .trailing)
        }
    }
}

private struct Sparkline: View {
    let values: [Double]
    var body: some View {
        GeometryReader { geo in
            Path { p in
                let step = geo.size.width / CGFloat(max(values.count - 1, 1))
                for (i, v) in values.enumerated() {
                    let pt = CGPoint(x: CGFloat(i) * step, y: geo.size.height * (1 - CGFloat(min(max(v, 0), 100)) / 100))
                    if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
                }
            }
            .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
        }
    }
}

enum MonitorColors {
    /// Green under 70 %, orange under 90 %, red above; grey when unknown.
    static func tint(_ percent: Double?) -> Color {
        guard let p = percent else { return .gray }
        return p < 70 ? .green : p < 90 ? .orange : .red
    }

    static func nsTint(_ percent: Double?) -> NSColor {
        guard let p = percent else { return .secondaryLabelColor }
        return p < 70 ? .systemGreen : p < 90 ? .systemOrange : .systemRed
    }
}
