import Foundation

// Errors must never be silent (parity with center-windows App.CrashGuard.cs
// and App.LogCrash/SendErrorReport):
// - every error the app catches but did not expect goes to errors.log and to
//   the server (POST /api/center/errors, at most one a minute, never the same
//   one twice in a row);
// - a marker file is written at start and removed on every orderly exit, so
//   the next start knows the last run ended unexpectedly and reports it;
// - fatal signals and uncaught NSExceptions write what they can to crash.log
//   synchronously (the signal path only with async-signal-safe calls), and
//   the next start sends that along with the report.

/// Report text without the user's folder name, bounded like the gateway expects (UTF-16 units).
public enum ErrorText {
    public static func scrub(_ text: String, max: Int, home: String = NSHomeDirectory(), user: String = NSUserName()) -> String {
        var t = text
        if home.count > 1 {
            let parent = (home as NSString).deletingLastPathComponent
            t = t.replacingOccurrences(of: home, with: (parent as NSString).appendingPathComponent("…"))
        }
        if user.count >= 3 { t = t.replacingOccurrences(of: "/" + user + "/", with: "/…/") }
        let units = Array(t.utf16)
        return units.count <= max ? t : String(decoding: units.prefix(max), as: UTF16.self)
    }

    /// "0.1.512" → "512" (the build number, like the Windows app sends); anything else as it is.
    public static func build(from version: String) -> String {
        version.hasPrefix("0.1.") ? String(version.dropFirst(4)) : version
    }

    /// One caught error: "Type: context: description" and a stack whose first frame is the
    /// context, so the server groups errors by where they were caught even in a stripped build.
    public static func caught(_ error: Error, context: String, stack: [String]) -> (message: String, detail: String) {
        let ns = error as NSError
        var type = String(describing: Swift.type(of: error))
        if type.hasPrefix("__") || type == "NSError" { type = ns.domain.isEmpty ? "NSError" : ns.domain }
        type = type.replacingOccurrences(of: " ", with: "")
        let message = "\(type): \(context): \(error.localizedDescription) (\(ns.domain) \(ns.code))"
        return (message, ([message, "   at \(context)"] + stack).joined(separator: "\n"))
    }

    /// The record an uncaught NSException leaves in crash.log.
    public static func exceptionRecord(name: String, reason: String?, stack: [String]) -> String {
        let reason = (reason ?? "").replacingOccurrences(of: "\n", with: " ")
        return "\(name): \(reason)\n" + stack.joined(separator: "\n") + "\n"
    }
}

/// At most one report a minute and never the same text twice in a row.
public struct ErrorReportGate {
    private var lastText: String?
    private var lastAt = Date.distantPast
    public init() {}

    public mutating func allow(_ text: String, now: Date = Date()) -> Bool {
        if text == lastText || now.timeIntervalSince(lastAt) < 60 { return false }
        lastText = text
        lastAt = now
        return true
    }
}

/// errors.log: newest last, started over past 512 KB.
public enum ErrorLog {
    public static func append(_ entry: String, to url: URL, maxBytes: Int = 512 * 1024, now: Date = Date()) {
        let fm = FileManager.default
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let size = (try? fm.attributesOfItem(atPath: url.path))?[.size] as? Int, size > maxBytes {
            try? fm.removeItem(at: url)
        }
        let line = Data("--- \(ISO8601DateFormatter().string(from: now))\n\(entry)\n".utf8)
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: line)
        } else {
            try? line.write(to: url)
        }
    }
}

/// What the previous run left behind when it did not end in order.
public struct PreviousRun: Equatable {
    /// "build 512, started 2026-11-19T08:00:00Z" from the marker (nil when only a crash log was found).
    public let run: String?
    /// crash.log: the signal or exception and its stack, when the crash handlers got to write it.
    public let crash: String?

    private var headline: String? {
        crash?.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
    }

    public var message: String {
        if let headline {
            return "\(headline) (the app ended unexpectedly in its previous run\(run.map { ", " + $0 } ?? ""))"
        }
        return "PreviousRunEnded: The app ended unexpectedly in its previous run\(run.map { " (" + $0 + ")" } ?? ""). "
            + "Console.app → Crash Reports has the details."
    }

    public var detail: String { crash.map { message + "\n" + $0 } ?? message }
}

/// running.marker and crash.log in the app's support folder.
public struct RunMarker {
    public let marker: URL
    public let crashLog: URL

    public init(directory: URL) {
        marker = directory.appendingPathComponent("running.marker")
        crashLog = directory.appendingPathComponent("crash.log")
    }

    /// CI starts and kills the app on purpose (the snapshot run): no marker,
    /// no reports there. Mirrors WECOMMANDER_DEBUG_LAYOUT=1 on Windows.
    public static func disabled(environment: [String: String] = ProcessInfo.processInfo.environment,
                                arguments: [String] = CommandLine.arguments) -> Bool {
        environment["WECOMMANDER_DEBUG_LAYOUT"] == "1"
            || !(environment["WECOMMANDER_SNAPSHOT_DIR"] ?? "").isEmpty
            || arguments.contains("--snapshot")
    }

    /// Writes this run's marker and returns the previous run when it ended unexpectedly.
    /// The crash log is consumed: each crash is reported once.
    public func begin(build: String, now: Date = Date()) -> PreviousRun? {
        let fm = FileManager.default
        let previous = (try? String(contentsOf: marker, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        let crash = (try? String(contentsOf: crashLog, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
        try? fm.removeItem(at: crashLog)
        try? fm.createDirectory(at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? Data("build \(build), started \(ISO8601DateFormatter().string(from: now))".utf8).write(to: marker)
        let crashText = (crash?.isEmpty ?? true) ? nil : String(crash!.prefix(16_000))
        if previous == nil && crashText == nil { return nil }
        return PreviousRun(run: (previous?.isEmpty ?? true) ? nil : previous, crash: crashText)
    }

    /// Every orderly end (Quit, update, sign-out) removes the marker; a crash does not.
    public func end() {
        try? FileManager.default.removeItem(at: marker)
    }
}

#if canImport(Darwin)
import Darwin

/// C strings and buffers the signal handler uses: prepared at install, so the
/// handler itself only calls open/write/backtrace_symbols_fd/close/unlink/raise.
private enum CrashState {
    static var crashLogPath: UnsafeMutablePointer<CChar>?
    static var markerPath: UnsafeMutablePointer<CChar>?
    static let signalLines = UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>.allocate(capacity: 64)
    static let frames = UnsafeMutablePointer<UnsafeMutableRawPointer?>.allocate(capacity: 128)
    static var installed = false
}

private let fatalSignalHandler: @convention(c) (Int32) -> Void = { sig in
    if let path = CrashState.crashLogPath {
        let fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        if fd >= 0 {
            if sig > 0 && sig < 64, let line = CrashState.signalLines[Int(sig)] { _ = write(fd, line, strlen(line)) }
            let count = backtrace(CrashState.frames, 128)
            // Frame 0 is this handler, frame 1 _sigtramp.
            if count > 2 { backtrace_symbols_fd(CrashState.frames + 2, count - 2, fd) }
            close(fd)
        }
    }
    signal(sig, SIG_DFL)
    raise(sig)
}

/// SIGTERM asks the app to quit: an orderly end, not a crash.
private let terminateHandler: @convention(c) (Int32) -> Void = { sig in
    if let marker = CrashState.markerPath { unlink(marker) }
    signal(sig, SIG_DFL)
    raise(sig)
}

public enum CrashHandlers {
    private static let fatal: [(Int32, String)] = [
        (SIGSEGV, "SIGSEGV"), (SIGBUS, "SIGBUS"), (SIGILL, "SIGILL"), (SIGFPE, "SIGFPE"),
        (SIGABRT, "SIGABRT"), (SIGTRAP, "SIGTRAP"), (SIGSYS, "SIGSYS"),
    ]

    /// Fatal signals and uncaught NSExceptions write to `crashLog`. Call once,
    /// early, and only in the instance that keeps running.
    public static func install(crashLog: URL) {
        guard !CrashState.installed else { return }
        CrashState.installed = true
        try? FileManager.default.createDirectory(at: crashLog.deletingLastPathComponent(), withIntermediateDirectories: true)
        CrashState.crashLogPath = strdup(crashLog.path)
        CrashState.signalLines.initialize(repeating: nil, count: 64)
        for (sig, name) in fatal { CrashState.signalLines[Int(sig)] = strdup("\(name): fatal signal \(sig)\n") }
        // Warm up backtrace (it may load libraries on first use) outside the handler.
        _ = backtrace(CrashState.frames, 128)

        // A stack overflow needs its own stack to run the handler on.
        let size = 256 * 1024
        var stack = stack_t(ss_sp: UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 16), ss_size: size, ss_flags: 0)
        sigaltstack(&stack, nil)

        for (sig, _) in fatal { set(sig, fatalSignalHandler) }
        set(SIGTERM, terminateHandler)

        NSSetUncaughtExceptionHandler { exception in
            CrashHandlers.write(ErrorText.exceptionRecord(name: exception.name.rawValue, reason: exception.reason,
                                                          stack: exception.callStackSymbols))
        }
    }

    /// From now on an orderly exit (exit(), SIGTERM) removes `marker`.
    public static func arm(marker: URL) {
        guard CrashState.markerPath == nil else { return }
        CrashState.markerPath = strdup(marker.path)
        atexit {
            if let marker = CrashState.markerPath { unlink(marker) }
        }
    }

    private static func set(_ sig: Int32, _ handler: @escaping @convention(c) (Int32) -> Void) {
        var action = sigaction()
        action.__sigaction_u.__sa_handler = handler
        action.sa_flags = SA_ONSTACK
        sigemptyset(&action.sa_mask)
        sigaction(sig, &action, nil)
    }

    /// Not in a signal handler: plain file I/O is fine here.
    static func write(_ record: String) {
        guard let path = CrashState.crashLogPath else { return }
        let url = URL(fileURLWithPath: String(cString: path))
        if let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(record.utf8))
        } else {
            try? Data(record.utf8).write(to: url)
        }
    }
}
#endif
