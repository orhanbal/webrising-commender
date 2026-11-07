import AppKit

// `--version` prints the version and exits: the CI smoke test uses it to prove
// the universal binary loads its frameworks on the runner.
if CommandLine.arguments.contains("--version") {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    print("WECOMMANDER Center \(version)")
    exit(0)
}

// Single instance: a second start hands over to the running one and quits.
let bundleId = Bundle.main.bundleIdentifier ?? "app.wecommander.center"
let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
    .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
if let running = others.first {
    DistributedNotificationCenter.default().postNotificationName(
        AppDelegate.showPanelNotification, object: nil, userInfo: nil, deliverImmediately: true)
    running.activate(options: [])
    exit(0)
}

let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.setActivationPolicy(.accessory) // menu bar only, no Dock icon
app.run()
