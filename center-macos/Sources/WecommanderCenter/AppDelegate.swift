import AppKit
import CenterCore
import SwiftUI

/// The menu bar item: a click opens the panel (a native popover), a right
/// click or Control-click shows the menu, like the Windows tray icon.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    nonisolated static let showPanelNotification = Notification.Name("app.wecommander.center.showPanel")

    let model = AppModel()
    /// SSH, SFTP and tunnels (wecommander-core); runs while the app runs, so
    /// saved tunnels keep working with the Servers window closed.
    let servers = ServersModel()
    private var serversWindow: NSWindow?
    /// The Servers window was built in an earlier language; rebuilt when no
    /// terminal is open in it (rebuilding would drop their scrollback).
    private var serversStale = false
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let menu = NSMenu()
    /// The live server monitor: its own menu bar item (shown while servers are watched).
    private lazy var monitor = ServerMonitor(model: servers, app: model)
    private var monitorItem: NSStatusItem?
    private let monitorPopover = NSPopover()
    private lazy var messages = MessageCenter(app: model)
    /// WECOMMANDER's scheduled tasks: the main window's page and the runner for this Mac's SSH hosts.
    private lazy var scheduled = ScheduledTasksModel(app: model, servers: servers)
    /// This Mac as the connector for the SSH hosts shared with remote AI (Hybrid Access).
    private lazy var connector = RemoteConnectorModel(app: model, servers: servers)

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = Self.menuBarImage()
            button.imagePosition = .imageLeading
            button.action = #selector(statusItemClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.setAccessibilityLabel(L.t("WECOMMANDER Yönetim Merkezi"))
        }

        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = NSSize(width: 380, height: 560)
        popover.contentViewController = NSHostingController(rootView: PanelView(model: model))

        menu.delegate = self

        model.onChange = { [weak self] in self?.updateStatusItem() }
        model.onLanguageChange = { [weak self] in DispatchQueue.main.async { self?.languageChanged() } }
        model.showPanel = { [weak self] in self?.showPanel() }
        model.start()
        servers.start()
        servers.credentials = { [weak self] in
            guard let self, let token = self.model.token else { return nil }
            return (self.model.gateway, token)
        }
        servers.startLibrarySync()
        servers.loadTutorial(step: model.settings.tutorialStep, off: model.settings.tutorialOff)
        servers.onTutorialChange = { [weak self] step, off in self?.model.rememberTutorial(step: step, off: off) }
        servers.scheduled = scheduled
        scheduled.start()
        servers.connector = connector
        connector.start()
        monitorPopover.behavior = .transient
        monitorPopover.animates = true
        monitorPopover.contentViewController = monitorController()
        monitor.onChange = { [weak self] in self?.updateMonitorItem() }
        monitor.start()

        DistributedNotificationCenter.default().addObserver(
            forName: Self.showPanelNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.showPanel() }
        }

        updateStatusItem()
        // Opened by the person: the main window (hosts and terminals); not
        // signed in yet: the sign-in panel. Started at login: menu bar only.
        if Snapshots.requested {
            let servers = self.servers
            Snapshots.run(servers: servers,
                          showServers: { [weak self] in self?.showServers(); return self?.serversWindow },
                          panel: { [weak self] in self?.showPanel(); return self?.popover.contentViewController?.view },
                          quick: { [weak self] in self?.showQuickPanel(); return self?.monitorPopover.contentViewController?.view },
                          windows: [
                              ("taskmanager", { TaskManagerWindows.show() }),
                              ("server-timers", { ServerWindows.show(servers, sessionId: "snapshot", label: "WECOMMANDER", page: .timers) }),
                          ])
        } else if model.phase != .signedIn { showPanel() }
        else if !CommandLine.arguments.contains("--hidden") && !Self.launchedAtLogin { showServers() }
        // "Yenilikler" once after an update (WhatsNew.swift); at login it waits for the main window.
        if !Snapshots.requested && !CommandLine.arguments.contains("--hidden") && !Self.launchedAtLogin {
            WhatsNew.showIfUpdated(model: model)
        }
    }

    /// Opened by macOS at login (Login Items) rather than by the person.
    static var launchedAtLogin: Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent else { return false }
        return event.eventID == kAEOpenApplication
            && event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    /// Opened again from Finder, Launchpad or the Dock: the main window.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if model.phase != .signedIn { showPanel() } else { showServers() }
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        scheduled.stop()
        connector.stop()
        monitor.stop()
        servers.stop()
        model.stopEmbeddedAgent()
    }

    /// The Servers window (sidebar of hosts, SwiftTerm terminals, files,
    /// tunnels). The app shows in the Dock while it is open.
    func showServers() {
        servers.start()
        if serversStale && servers.sessions.isEmpty, let old = serversWindow {
            old.delegate = nil
            old.close()
            serversWindow = nil
            serversStale = false
        }
        if serversWindow == nil {
            let hosting = NSHostingController(rootView: ServersView(model: servers, showPanel: { [weak self] in self?.showPanel() })
                .overlay(alignment: .bottomLeading) { MessageCard(center: self.messages) })
            let window = NSWindow(contentViewController: hosting)
            window.title = "WECOMMANDER"
            window.setContentSize(NSSize(width: 1100, height: 700))
            WindowChrome.apply(window, hosting: hosting, id: "servers")
            window.isReleasedWhenClosed = false
            window.setFrameAutosaveName("WecommanderServers")
            window.delegate = self
            serversWindow = window
        }
        NSApp.setActivationPolicy(.regular)
        serversWindow?.makeKeyAndOrderFront(nil)
        if model.phase == .signedIn { messages.fetchOnce() }
        NSApp.activate(ignoringOtherApps: true)
        if !Snapshots.requested { WhatsNew.showIfUpdated(model: model) }
    }

    /// The interface language changed: rebuild what is on screen in it.
    private func languageChanged() {
        statusItem.button?.setAccessibilityLabel(L.t("WECOMMANDER Yönetim Merkezi"))
        popover.contentViewController = NSHostingController(rootView: PanelView(model: model))
        monitorPopover.contentViewController = monitorController()
        updateMonitorItem()
        guard let window = serversWindow else { return }
        serversStale = true
        if servers.sessions.isEmpty {
            let visible = window.isVisible
            showServers() // rebuilds: no terminal to lose
            if !visible { serversWindow?.orderOut(nil); NSApp.setActivationPolicy(.accessory) }
        } else {
            servers.notice = L.t("Dil değişti. Açık terminaller kapanmasın diye bu pencerenin tamamı, terminaller kapandıktan sonraki açılışta yeni dile geçer.")
        }
    }

    func windowWillClose(_ notification: Notification) {
        guard (notification.object as? NSWindow) === serversWindow else { return }
        // Back to a menu bar app; terminals stay open until closed in the window.
        NSApp.setActivationPolicy(.accessory)
    }

    static func menuBarImage() -> NSImage {
        let image = NSImage(named: "menubar")
            ?? WCIcons.image(.knownHosts, size: 18)
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
            ? L.t("WECOMMANDER Yönetim Merkezi — oturum açılmadı")
            : (pending == 0 ? L.t("WECOMMANDER — bekleyen onay yok") : L.f("WECOMMANDER — {0} bekleyen onay", pending))
        if autonomy > 0 { tooltip += L.f(" · otonom mod açık ({0} cihaz)", autonomy) }
        if model.notificationsBlocked { tooltip += L.t(" · macOS bildirimleri kapalı") }
        if let agent = model.agent, agent.state == .stopped { tooltip += " · " + Texts.agentStateLabel(agent).lowercased() }
        button.toolTip = tooltip
    }

    // MARK: server monitor

    private func monitorController() -> NSViewController {
        NSHostingController(rootView: MonitorView(
            monitor: monitor, servers: servers, app: model,
            openTerminal: { [weak self] host in self?.monitorPopover.performClose(nil); self?.showServers(); self?.servers.open(host) },
            actions: quickActions()))
    }

    // MARK: quick panel (the menu bar is the Mac's Dock)

    /// What the quick tiles open; each closes the panel first.
    private func quickActions() -> QuickActions {
        var a = QuickActions()
        a.servers = { [weak self] in self?.quick { $0.openPage(ServersView.hostsPage) } }
        a.terminals = { [weak self] in self?.quick { $0.openTerminals() } }
        a.files = { [weak self] in self?.quick { $0.openFiles() } }
        a.taskManager = { [weak self] in self?.quick { _ in TaskManagerWindows.show() } }
        a.scheduled = { [weak self] in self?.quick { $0.openPage(ServersView.scheduledPage) } }
        a.timers = { [weak self] in self?.quick { $0.openServerSection(.timers) } }
        a.disk = { [weak self] in self?.quick { $0.openServerSection(.disk) } }
        a.approvals = { [weak self] in self?.quick { $0.showPanel() } }
        a.settings = { [weak self] in self?.quick { $0.openPage(ServersView.settingsPage) } }
        a.openMain = { [weak self] in self?.quick { $0.showServers() } }
        return a
    }

    private func quick(_ open: (AppDelegate) -> Void) {
        monitorPopover.performClose(nil)
        open(self)
    }

    /// The server monitor's panel with the quick tiles, under its own item (or the main one).
    func showQuickPanel() {
        guard let button = monitorItem?.button ?? statusItem.button else { return }
        if popover.isShown { popover.performClose(nil) }
        if !monitorPopover.isShown {
            monitorPopover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
        NSApp.activate(ignoringOtherApps: true)
        monitorPopover.contentViewController?.view.window?.makeKey()
    }

    /// A page of the main window.
    func openPage(_ page: String) {
        servers.selection = page
        showServers()
    }

    /// The newest terminal, or the terminals page when none is open.
    func openTerminals() {
        servers.selection = servers.sessions.last?.id ?? ServersView.terminalsPage
        showServers()
    }

    /// The file manager next to an open SSH terminal.
    func openFiles() {
        if let session = servers.liveSshSession {
            servers.selection = session.id
            servers.showFiles = true
            showServers()
        } else {
            servers.selection = ServersView.hostsPage
            showServers()
            servers.notice = L.t("Dosya yöneticisi açık bir terminalin bağlantısını kullanır: önce bir sunucuya bağlan.")
        }
    }

    /// A server management page for a watched server (its monitor connection) or an open terminal.
    func openServerSection(_ page: ServerManagementModel.Page) {
        if let watched = monitor.servers.first(where: { $0.live }), let id = watched.monitorId {
            ServerWindows.show(servers, sessionId: id, label: watched.label, page: page)
            return
        }
        if let session = servers.liveSshSession {
            ServerWindows.show(servers, session: session, page: page)
            return
        }
        model.notifier.showPlain("WECOMMANDER", L.t("İzlenen sunucu yok: Sunucularım panelinden bir sunucu ekle."))
        showQuickPanel()
    }

    /// "● 42%" next to the clock, coloured by the worst server; hidden when nothing is watched.
    private func updateMonitorItem() {
        guard let summary = monitor.summary else {
            if let item = monitorItem { NSStatusBar.system.removeStatusItem(item); monitorItem = nil }
            return
        }
        if monitorItem == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.action = #selector(monitorClicked(_:))
            item.button?.target = self
            monitorItem = item
        }
        guard let button = monitorItem?.button else { return }
        let live = monitor.servers.contains(where: \.live)
        let title = NSMutableAttributedString(string: "● ", attributes: [.foregroundColor: MonitorColors.nsTint(live ? summary.worst : nil)])
        title.append(NSAttributedString(string: summary.text, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize - 1, weight: .regular)]))
        button.attributedTitle = title
        let details = monitor.servers.map { s in
            s.live ? L.f("{0}: işlemci {1} · bellek {2} · disk {3}", s.label, Percent.text(s.reading.cpu), Percent.text(s.reading.mem), Percent.text(s.reading.disk))
                   : L.f("{0}: bağlanıyor", s.label)
        }
        button.toolTip = ([L.t("WECOMMANDER Sunucularım")] + details).joined(separator: "\n")
        button.setAccessibilityLabel(button.toolTip)
    }

    @objc private func monitorClicked(_ sender: NSStatusBarButton) {
        if monitorPopover.isShown { monitorPopover.performClose(nil); return }
        monitorPopover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
        monitorPopover.contentViewController?.view.window?.makeKey()
    }

    // MARK: menu (rebuilt each time it opens)

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let signedIn = model.phase == .signedIn
        menu.addItem(item(L.t("Yönetim Merkezini aç"), #selector(menuOpen)))
        menu.addItem(item(L.t("WECOMMANDER'ı aç"), #selector(menuServers), key: "s"))
        menu.addItem(.separator())
        // The same entries as the quick panel (the Windows Dock).
        menu.addItem(item(L.t("Sunucularım"), #selector(menuQuickPanel)))
        menu.addItem(item(L.t("Terminaller"), #selector(menuTerminals)))
        menu.addItem(item(L.t("Dosyalar"), #selector(menuFiles)))
        menu.addItem(item(L.t("Görev Yöneticisi"), #selector(menuTaskManager)))
        menu.addItem(item(L.t("Zamanlanmış görevler"), #selector(menuScheduled)))
        menu.addItem(item(L.t("Sunucu zamanlayıcıları"), #selector(menuServerTimers)))
        menu.addItem(item(L.t("Disk ve temizlik"), #selector(menuDisk)))
        menu.addItem(item(L.t("Onaylar"), #selector(menuOpen)))
        menu.addItem(item(L.t("Ayarlar"), #selector(menuSettings)))
        menu.addItem(item(L.t("Yenilikler"), #selector(menuWhatsNew)))
        menu.addItem(.separator())
        let connectMenu = NSMenu()
        for host in servers.hosts {
            let entry = item(host.label, #selector(menuConnectHost(_:)))
            entry.representedObject = host.id
            connectMenu.addItem(entry)
        }
        let connectItem = NSMenuItem(title: L.t("Bağlan"), action: nil, keyEquivalent: "")
        connectItem.submenu = connectMenu
        connectItem.isEnabled = !servers.hosts.isEmpty
        menu.addItem(connectItem)
        let tunnelMenu = NSMenu()
        for tunnel in servers.savedTunnels {
            let entry = item("\(tunnel.hostLabel)  \(tunnel.local) → \(tunnel.remote)", #selector(menuToggleTunnel(_:)))
            entry.representedObject = tunnel.id
            entry.state = tunnel.running ? .on : .off
            tunnelMenu.addItem(entry)
        }
        let tunnelItem = NSMenuItem(title: L.t("Tüneller"), action: nil, keyEquivalent: "")
        tunnelItem.submenu = tunnelMenu
        tunnelItem.isEnabled = !servers.savedTunnels.isEmpty
        menu.addItem(tunnelItem)
        menu.addItem(.separator())
        let pending = model.pending.count
        menu.addItem(item(!signedIn ? L.t("Oturum açılmadı") : pending == 0 ? L.t("Bekleyen onay yok") : L.f("Bekleyen onaylar: {0}", pending), #selector(menuOpen)))
        menu.addItem(item(model.autonomy.isEmpty ? L.t("Otonom mod kapalı") : L.f("Otonom mod açık: {0} cihaz", model.autonomy.count), #selector(menuOpen)))
        let stop = item(L.t("Otonom modu durdur (tüm cihazlar)"), #selector(menuStopAutonomy))
        stop.isEnabled = signedIn && !model.autonomy.isEmpty
        menu.addItem(stop)
        menu.addItem(.separator())
        menu.addItem(item(L.t("Paneli tarayıcıda aç"), #selector(menuDashboard)))
        if model.isEmbedded {
            let update = item(model.agentUpdateAvailable ? L.t("Yeni sürüm var — Uygulamayı güncelle") : L.t("Güncellemeleri denetle"), #selector(menuCheckUpdates))
            update.isEnabled = !model.updating
            menu.addItem(update)
        }
        let notify = item(L.t("Bildirimler"), #selector(menuToggleNotifications))
        notify.state = model.settings.notifications ? .on : .off
        menu.addItem(notify)
        if model.notificationsBlocked {
            menu.addItem(item(L.t("macOS bildirimlerine izin ver…"), #selector(menuAllowNotifications)))
        }
        menu.addItem(.separator())
        let agentItem = item(L.t("Ajan çalışsın — ") + Texts.agentStateLabel(model.agent).lowercased(), #selector(menuToggleAgent))
        agentItem.state = model.agent?.running == true ? .on : .off
        agentItem.isEnabled = !model.agentBusy && model.agent != nil && model.agent?.state != .notInstalled
        menu.addItem(agentItem)
        menu.addItem(.separator())
        let account = !signedIn ? L.t("Oturum aç…") : model.me?.email.map { L.f("Oturumu kapat ({0})", $0) } ?? L.t("Oturumu kapat")
        menu.addItem(item(account, #selector(menuAccount)))
        menu.addItem(item(L.t("Çıkış"), #selector(menuQuit), key: "q"))
    }

    private func item(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func menuOpen() { showPanel() }
    @objc private func menuServers() { showServers() }
    @objc private func menuQuickPanel() { showQuickPanel() }
    @objc private func menuTerminals() { openTerminals() }
    @objc private func menuFiles() { openFiles() }
    @objc private func menuTaskManager() { TaskManagerWindows.show() }
    @objc private func menuScheduled() { openPage(ServersView.scheduledPage) }
    @objc private func menuServerTimers() { openServerSection(.timers) }
    @objc private func menuDisk() { openServerSection(.disk) }
    @objc private func menuSettings() { openPage(ServersView.settingsPage) }
    @objc private func menuWhatsNew() { WhatsNew.showAll(model: model) }

    @objc private func menuConnectHost(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let host = servers.hosts.first(where: { $0.id == id }) else { return }
        showServers()
        servers.open(host)
    }

    @objc private func menuToggleTunnel(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String, let tunnel = servers.savedTunnels.first(where: { $0.id == id }) else { return }
        Task { await servers.toggleTunnel(tunnel) }
    }
    @objc private func menuDashboard() { model.openDashboard() }
    @objc private func menuCheckUpdates() { showPanel(); model.updateAgent() }
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
                model.notifier.showPlain("WECOMMANDER", L.t("Otonom mod durduruldu. Onaylar yeniden isteniyor."))
            } catch {
                model.notifier.showPlain("WECOMMANDER", error.localizedDescription)
            }
        }
    }

    @objc private func menuAccount() {
        if model.phase != .signedIn { showPanel(); return }
        Task {
            await model.signOut()
            model.notifier.showPlain("WECOMMANDER", L.t("Oturum kapatıldı. Yeniden açmak için menü çubuğundaki simgeye tıkla."))
        }
    }
}
