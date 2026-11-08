import AppKit
import CenterCore
import SwiftUI

/// The menu bar item: a click opens the panel (a native popover), a right
/// click or Control-click shows the menu, like the Windows tray icon.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    nonisolated static let showPanelNotification = Notification.Name("app.wecommander.center.showPanel")

    let model = AppModel()
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let menu = NSMenu()

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = Self.menuBarImage()
            button.imagePosition = .imageLeading
            button.action = #selector(statusItemClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.setAccessibilityLabel("WECOMMANDER Yönetim Merkezi")
        }

        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = NSSize(width: 380, height: 560)
        popover.contentViewController = NSHostingController(rootView: PanelView(model: model))

        menu.delegate = self

        model.onChange = { [weak self] in self?.updateStatusItem() }
        model.showPanel = { [weak self] in self?.showPanel() }
        model.start()

        DistributedNotificationCenter.default().addObserver(
            forName: Self.showPanelNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.showPanel() }
        }

        updateStatusItem()
        if model.phase != .signedIn { showPanel() }
    }

    static func menuBarImage() -> NSImage {
        let image = NSImage(named: "menubar")
            ?? NSImage(systemSymbolName: "checkmark.shield", accessibilityDescription: "WECOMMANDER")!
        image.isTemplate = true
        image.size = NSSize(width: 18, height: 18)
        return image
    }

    @objc private func statusItemClicked(_ sender: NSStatusBarButton) {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
        } else {
            togglePanel()
        }
    }

    func togglePanel() {
        if popover.isShown { popover.performClose(nil) } else { showPanel() }
    }

    func showPanel() {
        guard let button = statusItem.button else { return }
        model.requestSync()
        if !popover.isShown {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
        NSApp.activate(ignoringOtherApps: true)
        popover.contentViewController?.view.window?.makeKey()
    }

    private func updateStatusItem() {
        guard let button = statusItem?.button else { return }
        let pending = model.pending.count
        let autonomy = model.autonomy.count
        var title = ""
        if pending > 0 { title += " \(pending)" }
        if autonomy > 0 { title += " ⚡︎" }
        button.title = title
        var tooltip = model.phase != .signedIn
            ? "WECOMMANDER Yönetim Merkezi — oturum açılmadı"
            : (pending == 0 ? "WECOMMANDER — bekleyen onay yok" : "WECOMMANDER — \(pending) bekleyen onay")
        if autonomy > 0 { tooltip += " · otonom mod açık (\(autonomy) cihaz)" }
        if model.notificationsBlocked { tooltip += " · macOS bildirimleri kapalı" }
        if let agent = model.agent, agent.state == .stopped { tooltip += " · " + Texts.agentStateLabel(agent).lowercased() }
        button.toolTip = tooltip
    }

    // MARK: menu (rebuilt each time it opens)

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let signedIn = model.phase == .signedIn
        menu.addItem(item("Yönetim Merkezini aç", #selector(menuOpen)))
        menu.addItem(.separator())
        let pending = model.pending.count
        menu.addItem(item(!signedIn ? "Oturum açılmadı" : pending == 0 ? "Bekleyen onay yok" : "Bekleyen onaylar: \(pending)", #selector(menuOpen)))
        menu.addItem(item(model.autonomy.isEmpty ? "Otonom mod kapalı" : "Otonom mod açık: \(model.autonomy.count) cihaz", #selector(menuOpen)))
        let stop = item("Otonom modu durdur (tüm cihazlar)", #selector(menuStopAutonomy))
        stop.isEnabled = signedIn && !model.autonomy.isEmpty
        menu.addItem(stop)
        menu.addItem(.separator())
        menu.addItem(item("Paneli tarayıcıda aç", #selector(menuDashboard)))
        let notify = item("Bildirimler", #selector(menuToggleNotifications))
        notify.state = model.settings.notifications ? .on : .off
        menu.addItem(notify)
        if model.notificationsBlocked {
            menu.addItem(item("macOS bildirimlerine izin ver…", #selector(menuAllowNotifications)))
        }
        menu.addItem(.separator())
        let agentItem = item("Ajan çalışsın — " + Texts.agentStateLabel(model.agent).lowercased(), #selector(menuToggleAgent))
        agentItem.state = model.agent?.running == true ? .on : .off
        agentItem.isEnabled = !model.agentBusy && model.agent != nil && model.agent?.state != .notInstalled
        menu.addItem(agentItem)
        menu.addItem(.separator())
        let account = !signedIn ? "Oturum aç…" : model.me?.email.map { "Oturumu kapat (\($0))" } ?? "Oturumu kapat"
        menu.addItem(item(account, #selector(menuAccount)))
        menu.addItem(item("Çıkış", #selector(menuQuit), key: "q"))
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func menuOpen() { showPanel() }
    @objc private func menuDashboard() { model.openDashboard() }
    @objc private func menuAllowNotifications() { Notifier.openSettings() }
    @objc private func menuToggleNotifications() { model.update { $0.notifications.toggle() } }
    @objc private func menuQuit() { NSApp.terminate(nil) }

    @objc private func menuToggleAgent() {
        if model.agent?.running == true {
            // Same confirmation as in the panel.
            showPanel()
            return
        }
        Task { await model.setAgentEnabled(true) }
    }

    @objc private func menuStopAutonomy() {
        Task {
            do {
                try await model.stopAutonomy()
                model.notifier.showPlain("WECOMMANDER", "Otonom mod durduruldu. Onaylar yeniden isteniyor.")
            } catch {
                model.notifier.showPlain("WECOMMANDER", error.localizedDescription)
            }
        }
    }

    @objc private func menuAccount() {
        if model.phase != .signedIn { showPanel(); return }
        Task {
            await model.signOut()
            model.notifier.showPlain("WECOMMANDER", "Oturum kapatıldı. Yeniden açmak için menü çubuğundaki simgeye tıkla.")
        }
    }
}
