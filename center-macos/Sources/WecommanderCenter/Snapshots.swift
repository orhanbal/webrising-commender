import AppKit
import CenterCore

/// `--snapshot`: opens every page of the main window, the panel, the quick
/// panel (the server monitor's panel with its tiles), the Task Manager and the
/// server timers page, saves a PNG of each and a text list of what each shows,
/// then keeps running.
/// The app draws its own windows, so no Screen Recording permission is needed.
/// Used by the macOS CI and to look at the app on a person's Mac.
@MainActor
enum Snapshots {
    static var requested: Bool { CommandLine.arguments.contains("--snapshot") }

    static var directory: URL {
        if let dir = ProcessInfo.processInfo.environment["WECOMMANDER_SNAPSHOT_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: dir, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents/WECOMMANDER/snapshots", isDirectory: true)
    }

    static let pages = ["page:hosts", "page:terminals", "page:keys", "page:identities", "page:snippets", "page:tunnels",
                        "page:known", "page:history", "page:scheduled", "page:ai", "page:settings"]

    static func run(servers: ServersModel, showServers: @escaping () -> NSWindow?, panel: @escaping () -> NSView?,
                    quick: @escaping () -> NSView?, windows: [(String, () -> NSWindow?)]) {
        Task { @MainActor in
            let dir = directory
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var report = ["language: \(L.current)", "macOS: \(ProcessInfo.processInfo.operatingSystemVersionString)"]
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            for page in pages {
                servers.selection = page
                guard let window = showServers() else { report.append("\(page): no window"); continue }
                try? await Task.sleep(nanoseconds: 1_200_000_000)
                let name = page.replacingOccurrences(of: "page:", with: "")
                let ok = save(window.contentView, to: dir.appendingPathComponent("\(L.current)-\(name).png"))
                let shown = servers.selection == page
                report.append("\(page): selected=\(shown) image=\(ok) texts=\(texts(window.contentView).joined(separator: " | "))")
            }
            if let view = panel() {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                let ok = save(view, to: dir.appendingPathComponent("\(L.current)-panel.png"))
                report.append("panel: image=\(ok) texts=\(texts(view).joined(separator: " | "))")
            }
            if let view = quick() {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                let ok = save(view, to: dir.appendingPathComponent("\(L.current)-quick.png"))
                report.append("quick: image=\(ok) texts=\(texts(view).joined(separator: " | "))")
            } else {
                report.append("quick: image=false")
            }
            for (name, open) in windows {
                guard let window = open() else { report.append("\(name): image=false"); continue }
                // Two readings (the Task Manager's CPU) or the core's answer (the server page).
                try? await Task.sleep(nanoseconds: 4_500_000_000)
                let ok = save(window.contentView, to: dir.appendingPathComponent("\(L.current)-\(name).png"))
                report.append("\(name): image=\(ok) texts=\(texts(window.contentView).joined(separator: " | "))")
                window.close()
            }
            servers.selection = pages[0]
            try? report.joined(separator: "\n").appending("\n")
                .write(to: dir.appendingPathComponent("\(L.current)-report.txt"), atomically: true, encoding: .utf8)
            if ProcessInfo.processInfo.environment["WECOMMANDER_SNAPSHOT_QUIT"] == "1" { NSApp.terminate(nil) }
        }
    }

    /// The view as the app draws it (PNG); false when it could not be drawn.
    private static func save(_ view: NSView?, to url: URL) -> Bool {
        guard let view, view.bounds.width > 0, view.bounds.height > 0,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return false }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: url)) != nil
    }

    /// The texts the page shows to assistive technology (titles, labels, buttons).
    private static func texts(_ view: NSView?) -> [String] {
        guard let view else { return [] }
        var out: [String] = []
        func walk(_ element: Any, depth: Int) {
            guard depth < 40, out.count < 200, let obj = element as? NSObject else { return }
            for attribute in [NSAccessibility.Attribute.title, .description, .value] {
                if let t = (obj.accessibilityAttributeValue(attribute) as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !t.isEmpty, !out.contains(t) { out.append(t) }
            }
            for child in (obj.accessibilityAttributeValue(.children) as? [Any]) ?? [] { walk(child, depth: depth + 1) }
        }
        walk(view, depth: 0)
        return out
    }
}
