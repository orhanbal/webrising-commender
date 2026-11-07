import Foundation
import ServiceManagement

/// Start at login through the system's own login items (System Settings,
/// General, Login Items), no launch agent file of ours.
enum LoginItem {
    static var enabled: Bool {
        SMAppService.mainApp.status == .enabled
    }

    static func set(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
        } catch {
            NSLog("WECOMMANDER Center: login item change failed: \(error.localizedDescription)")
        }
    }
}
