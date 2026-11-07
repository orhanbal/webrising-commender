import AppKit
import CenterCore
import UserNotifications

/// macOS notifications through UNUserNotificationCenter. An approval request
/// is a notification with Onayla / Reddet actions (category "approval"); the
/// actions call the gateway in-process, so no URL scheme or other program can
/// approve. macOS cannot update a delivered notification in place, so the
/// deadline is written into it and the menu bar and panel count down.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let approvalCategory = "approval"
    static let approveAction = "approve"
    static let denyAction = "deny"

    /// Authorization as the panel shows it: "authorized", "denied", "notDetermined", "noAlerts".
    private(set) var state = "authorized"

    var onDecision: ((_ id: String, _ device: String, _ approve: Bool) -> Void)?
    var onOpen: (() -> Void)?
    var onStateChange: (() -> Void)?

    private var center: UNUserNotificationCenter { .current() }

    func start() {
        center.delegate = self
        let approve = UNNotificationAction(identifier: Self.approveAction, title: "Onayla", options: [])
        let deny = UNNotificationAction(identifier: Self.denyAction, title: "Reddet", options: [.destructive])
        let category = UNNotificationCategory(
            identifier: Self.approvalCategory, actions: [approve, deny], intentIdentifiers: [],
            options: [.customDismissAction])
        center.setNotificationCategories([category])
        refresh()
    }

    /// Asks for permission when macOS has not asked yet; afterwards it only reads the state.
    func requestPermission(then done: (() -> Void)? = nil) {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] _, _ in
            DispatchQueue.main.async {
                self?.refresh()
                done?()
            }
        }
    }

    func refresh() {
        center.getNotificationSettings { [weak self] settings in
            let next: String
            switch settings.authorizationStatus {
            case .denied: next = "denied"
            case .notDetermined: next = "notDetermined"
            default: next = settings.alertSetting == .disabled || settings.alertStyle == UNAlertStyle.none ? "noAlerts" : "authorized"
            }
            DispatchQueue.main.async {
                guard let self, self.state != next else { return }
                self.state = next
                self.onStateChange?()
            }
        }
    }

    var blocked: Bool { state == "denied" || state == "noAlerts" }

    func showApproval(_ item: ApprovalRequest, device: String) {
        let content = UNMutableNotificationContent()
        let what = item.summary.isEmpty ? Texts.kindLabel(item.actionKind) : item.summary
        content.title = "Onay bekliyor · \(device)"
        content.subtitle = what
        content.body = "\(Texts.kindLabel(item.actionKind)) · yalnız bu işlem, bir kez\n" +
            Texts.deadline(item.expiresAt, now: Date())
        content.sound = .default
        content.categoryIdentifier = Self.approvalCategory
        content.threadIdentifier = "approvals"
        content.interruptionLevel = .active
        content.userInfo = ["id": item.id, "device": device]
        center.add(UNNotificationRequest(identifier: item.id, content: content, trigger: nil))
    }

    func showPlain(_ title: String, _ body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.threadIdentifier = "info"
        center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    func remove(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        center.removeDeliveredNotifications(withIdentifiers: ids)
        center.removePendingNotificationRequests(withIdentifiers: ids)
    }

    func removeAllApprovals() {
        center.getDeliveredNotifications { [weak self] delivered in
            let ids = delivered.filter { $0.request.content.categoryIdentifier == Self.approvalCategory }
                .map { $0.request.identifier }
            self?.remove(ids)
        }
    }

    /// Settings, Notifications, WECOMMANDER Yönetim Merkezi.
    static func openSettings() {
        let urls = [
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=app.wecommander.center",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ]
        for text in urls {
            if let url = URL(string: text), NSWorkspace.shared.open(url) { return }
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let id = info["id"] as? String ?? ""
        let device = info["device"] as? String ?? ""
        DispatchQueue.main.async { [weak self] in
            switch response.actionIdentifier {
            case Self.approveAction where !id.isEmpty: self?.onDecision?(id, device, true)
            case Self.denyAction where !id.isEmpty: self?.onDecision?(id, device, false)
            case UNNotificationDefaultActionIdentifier: self?.onOpen?()
            default: break
            }
            completionHandler()
        }
    }
}
