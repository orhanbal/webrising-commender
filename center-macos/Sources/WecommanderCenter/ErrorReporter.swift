import AppKit
import CenterCore

/// Errors must never be silent: the macOS side of center-windows'
/// App.LogCrash / SendErrorReport and App.CrashGuard (see CenterCore/CrashGuard.swift).
/// errors.log, running.marker and crash.log live in the settings folder
/// (~/Library/Application Support/WECOMMANDER Center).
@MainActor
enum ErrorReporter {
    static let directory = SettingsStore.defaultDirectory
    static var logURL: URL { directory.appendingPathComponent("errors.log") }
    static let marker = RunMarker(directory: directory)

    private static weak var model: AppModel?
    private static var gate = ErrorReportGate()
    private static var build: String { ErrorText.build(from: GatewayClient.appVersion) }

    /// Before anything else that could crash (main.swift, after the single-instance check).
    nonisolated static func installCrashHandlers() {
        CrashHandlers.install(crashLog: RunMarker(directory: SettingsStore.defaultDirectory).crashLog)
    }

    /// After a crash the app comes back and says so: the marker is written now
    /// and removed on every orderly exit; one left behind means the last run
    /// ended unexpectedly, reported 20 s later (the token and network are ready by then).
    static func startCrashGuard(model: AppModel) {
        self.model = model
        // CI starts and kills the app on purpose: no marker, no reports there.
        if RunMarker.disabled() { return }
        let previous = marker.begin(build: build)
        CrashHandlers.arm(marker: marker.marker)
        guard let previous else { return }
        ErrorLog.append("\(build)\n\(previous.detail)", to: logURL)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 20_000_000_000)
            // Not held back by the one-a-minute limit: this one matters most.
            send(message: previous.message, detail: previous.detail, gated: false)
        }
    }

    /// Quit, update, sign-out: not a crash.
    static func orderlyExit() {
        if !RunMarker.disabled() { marker.end() }
    }

    /// An error the app caught but did not expect: errors.log and the server.
    /// Expected conditions (no network, signed out) are not bugs and are skipped.
    static func record(_ error: Error, _ context: String) {
        if let e = error as? GatewayError, e.kind != .http { return }
        if error is CancellationError { return }
        let report = ErrorText.caught(error, context: context, stack: Array(Thread.callStackSymbols.dropFirst()))
        ErrorLog.append("\(build)\n\(report.detail)", to: logURL)
        send(message: report.message, detail: report.detail)
    }

    /// An Objective-C exception AppKit caught (the app keeps running).
    static func record(exception: NSException, stack: [String]? = nil) {
        let detail = ErrorText.exceptionRecord(name: exception.name.rawValue, reason: exception.reason,
                                               stack: stack ?? exception.callStackSymbols)
        let message = String(detail.prefix { $0 != "\n" })
        ErrorLog.append("\(build)\n\(detail)", to: logURL)
        send(message: message, detail: detail)
    }

    /// At most one a minute, never the same one twice in a row. Sending never throws and never logs.
    private static func send(message: String, detail: String, gated: Bool = true) {
        guard let model, let token = model.token else { return }
        if gated && !gate.allow(detail) { return }
        let gateway = model.gateway
        let build = self.build
        Task.detached {
            try? await gateway.reportError(token: token, build: build, message: message, detail: detail)
        }
    }
}

/// AppKit catches exceptions thrown on the main thread, logs them and keeps
/// the app running (like Windows' UnhandledException with Handled = true);
/// here they are also recorded and reported.
final class WecommanderApplication: NSApplication {
    override func reportException(_ exception: NSException) {
        if Thread.isMainThread {
            MainActor.assumeIsolated { ErrorReporter.record(exception: exception) }
        } else {
            let name = exception.name, reason = exception.reason, stack = exception.callStackSymbols
            Task { @MainActor in
                ErrorReporter.record(exception: NSException(name: name, reason: reason, userInfo: nil), stack: stack)
            }
        }
        super.reportException(exception)
    }
}
