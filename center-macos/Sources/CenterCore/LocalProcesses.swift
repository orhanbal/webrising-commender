import Foundation

// Task Manager for this Mac: each process as macOS reports it, the CPU use
// worked out between two readings, the process tree and the rules that keep
// critical processes out of reach. The reading itself (libproc, with `ps` as
// the fallback) is in the app (LocalProcessReader); everything here is plain
// and tested. The same rules as the Windows app (center-windows/Core/LocalProcesses.cs).

/// One process as read at one moment.
public struct LocalProcessInfo: Equatable, Sendable {
    public var pid: Int32
    public var ppid: Int32
    public var name: String
    public var uid: UInt32
    public var user: String
    public var threads: Int
    /// User + system CPU time in nanoseconds; nil when macOS did not give it.
    public var cpuTimeNs: UInt64?
    /// Resident memory in bytes; nil when macOS did not give it.
    public var residentBytes: UInt64?
    public var path: String?
    /// Start time; nil when unknown (a reused PID is told apart by it).
    public var started: Date?

    public init(pid: Int32, ppid: Int32, name: String, uid: UInt32 = 501, user: String = "", threads: Int = 0,
                cpuTimeNs: UInt64? = nil, residentBytes: UInt64? = nil, path: String? = nil, started: Date? = nil) {
        self.pid = pid; self.ppid = ppid; self.name = name; self.uid = uid; self.user = user; self.threads = threads
        self.cpuTimeNs = cpuTimeNs; self.residentBytes = residentBytes; self.path = path; self.started = started
    }
}

/// A row of the Task Manager: the process and its CPU use since the previous reading.
public struct LocalProcessRow: Equatable, Identifiable, Sendable {
    public let info: LocalProcessInfo
    /// Percent of the whole machine (all cores together).
    public let cpu: Double
    /// Why it must not be ended from here, or nil.
    public let protectedReason: String?

    public var id: Int32 { info.pid }
    public var pid: Int32 { info.pid }
    public var name: String { info.name }
    public var canEnd: Bool { protectedReason == nil }
}

/// A reading of all processes.
public struct LocalSnapshot: Equatable, Sendable {
    public let at: Date
    public let processes: [LocalProcessInfo]

    public init(at: Date, processes: [LocalProcessInfo]) { self.at = at; self.processes = processes }
}

public enum LocalProcesses {
    struct Key: Hashable {
        let pid: Int32
        let started: Date?
    }

    /// Rows of `now`: CPU percent of the whole machine since `before`.
    public static func rows(before: LocalSnapshot?, now: LocalSnapshot, cpuCount: Int, selfPid: Int32, selfUid: UInt32) -> [LocalProcessRow] {
        let seconds = before.map { now.at.timeIntervalSince($0.at) } ?? 0
        var previous: [Key: LocalProcessInfo] = [:]
        for p in before?.processes ?? [] { previous[Key(pid: p.pid, started: p.started)] = p }
        let cores = Double(max(1, cpuCount))
        return now.processes.map { p -> LocalProcessRow in
            var cpu = 0.0
            // The same process only: a reused PID has another start time.
            if seconds > 0, let old = previous[Key(pid: p.pid, started: p.started)], let t1 = p.cpuTimeNs, let t0 = old.cpuTimeNs {
                let used = t1 >= t0 ? Double(t1 - t0) : 0
                let share = used / (seconds * 1_000_000_000 * cores) * 100
                cpu = min(100, max(0, share))
            }
            let rounded = (cpu * 10).rounded() / 10
            return LocalProcessRow(info: p, cpu: rounded, protectedReason: protectedReason(p, selfPid: selfPid, selfUid: selfUid))
        }
    }

    // macOS itself: ending these stops or crashes the system or the session.
    static let systemCore: Set<String> = [
        "kernel_task", "launchd", "windowserver", "loginwindow", "logd", "syslogd", "configd", "notifyd",
        "distnoted", "cfprefsd", "opendirectoryd", "securityd", "trustd", "coreservicesd", "powerd", "mds",
        "mds_stores", "fseventsd", "diskarbitrationd", "usereventagent", "watchdogd", "kextd", "kernelmanagerd",
        "coreaudiod", "bluetoothd", "airportd", "dock", "finder", "systemuiserver", "controlcenter",
        "launchservicesd", "runningboardd", "tccd", "sandboxd", "authd", "endpointsecurityd",
    ]

    // Databases: ending one can lose or corrupt data.
    static let databases: Set<String> = [
        "postgres", "postmaster", "pg_ctl", "mysqld", "mysqld_safe", "mariadbd", "mongod", "redis-server",
        "valkey-server", "memcached", "influxd", "clickhouse-server", "etcd", "couchdb", "cockroach", "sqlservr",
    ]

    // WECOMMANDER itself: the app, its core, the agent and the connection to the server.
    static let ours: Set<String> = [
        "wecommandercenter", "wecommander-core", "webrising-commender", "webrising-commender-agent", "wecommander center",
    ]

    /// Why a process must not be ended from here, or nil when it may be.
    public static func protectedReason(_ p: LocalProcessInfo, selfPid: Int32, selfUid: UInt32) -> String? {
        let name = p.name.lowercased()
        if p.pid == 0 || p.pid == 1 || name == "kernel_task" || name == "launchd" {
            return L.t("macOS çekirdeği ya da launchd: sonlandırılamaz.")
        }
        if p.pid == selfPid || ours.contains(name) {
            return L.t("WECOMMANDER'ın kendi süreci: bağlantı ve onaylar bunun üzerinden çalışır.")
        }
        if systemCore.contains(name) {
            return L.t("macOS sistem süreci: sonlandırılırsa macOS kararsız kalabilir ya da oturum kapanabilir.")
        }
        if databases.contains(name) {
            return L.t("Veritabanı: sonlandırılırsa veri kaybolabilir. Servisini kendi aracıyla durdur.")
        }
        if selfUid != 0 && p.uid != selfUid {
            return L.t("Başka bir kullanıcının ya da sistemin süreci: sonlandırmak için yönetici izni gerekir.")
        }
        return nil
    }

    /// Sort columns: cpu, memory, name, pid, user.
    public static let columns = ["cpu", "memory", "name", "pid", "user"]

    /// Name, user and PID sort up, the numbers down.
    public static func descending(_ column: String) -> Bool { column == "cpu" || column == "memory" }

    /// Whether `a` comes before `b` in `column`'s order (ties by PID).
    public static func before(_ a: LocalProcessRow, _ b: LocalProcessRow, column: String) -> Bool {
        switch column {
        case "memory":
            let x = a.info.residentBytes ?? 0
            let y = b.info.residentBytes ?? 0
            if x != y { return x > y }
        case "name":
            let r = a.name.localizedCaseInsensitiveCompare(b.name)
            if r != .orderedSame { return r == .orderedAscending }
        case "user":
            let r = a.info.user.localizedCaseInsensitiveCompare(b.info.user)
            if r != .orderedSame { return r == .orderedAscending }
        case "pid":
            break
        default:
            if a.cpu != b.cpu { return a.cpu > b.cpu }
        }
        return a.pid < b.pid
    }

    public static func sorted(_ rows: [LocalProcessRow], column: String) -> [LocalProcessRow] {
        rows.sorted { before($0, $1, column: column) }
    }

    /// The rows as a tree: each process under its parent (depth for the indent).
    /// A parent that started after its child is a reused PID, not the parent.
    public static func tree(_ rows: [LocalProcessRow], column: String) -> [(row: LocalProcessRow, depth: Int)] {
        var byPid: [Int32: LocalProcessRow] = [:]
        for r in rows where byPid[r.pid] == nil { byPid[r.pid] = r }
        func hasParent(_ r: LocalProcessRow) -> Bool {
            guard r.info.ppid != r.pid, let parent = byPid[r.info.ppid] else { return false }
            guard let ps = parent.info.started, let cs = r.info.started else { return true }
            return ps <= cs
        }
        var children: [Int32: [LocalProcessRow]] = [:]
        for r in rows where hasParent(r) { children[r.info.ppid, default: []].append(r) }
        var result: [(row: LocalProcessRow, depth: Int)] = []
        var seen = Set<Int32>()
        func add(_ r: LocalProcessRow, _ depth: Int) {
            if seen.contains(r.pid) { return } // a loop of reused PIDs
            seen.insert(r.pid)
            result.append((row: r, depth: depth))
            for k in sorted(children[r.pid] ?? [], column: column) { add(k, depth + 1) }
        }
        for root in sorted(rows.filter { !hasParent($0) }, column: column) { add(root, 0) }
        for r in rows where !seen.contains(r.pid) { add(r, 0) }
        return result
    }

    /// Rows whose name, PID, user or path contain `text`.
    public static func filter(_ rows: [LocalProcessRow], _ text: String) -> [LocalProcessRow] {
        let f = text.trimmingCharacters(in: .whitespaces)
        if f.isEmpty { return rows }
        return rows.filter { r in
            if r.name.range(of: f, options: .caseInsensitive) != nil { return true }
            if String(r.pid) == f { return true }
            if r.info.user.range(of: f, options: .caseInsensitive) != nil { return true }
            return (r.info.path ?? "").range(of: f, options: .caseInsensitive) != nil
        }
    }

    /// The PIDs of `pid`'s children in the reading.
    public static func childCount(_ rows: [LocalProcessRow], of pid: Int32) -> Int {
        rows.filter { $0.info.ppid == pid && $0.pid != pid }.count
    }
}

/// The fallback reading: `ps -axww -o pid=,ppid=,uid=,rss=,time=,comm=`.
public enum PsOutput {
    public static let arguments = ["-axww", "-o", "pid=,ppid=,uid=,rss=,time=,comm="]

    /// CPU time as ps prints it ("0:01.23", "123:45.67", "1:02:03.45", "2-01:02:03") in seconds.
    public static func cpuSeconds(_ text: String) -> Double? {
        var rest = Substring(text.trimmingCharacters(in: .whitespaces))
        var days = 0.0
        if let dash = rest.firstIndex(of: "-") {
            guard let d = Double(rest[rest.startIndex..<dash]) else { return nil }
            days = d
            rest = rest[rest.index(after: dash)...]
        }
        let parts = rest.split(separator: ":", omittingEmptySubsequences: false)
        guard !parts.isEmpty, parts.count <= 3 else { return nil }
        var total = 0.0
        for part in parts {
            guard let v = Double(part) else { return nil }
            total = total * 60 + v
        }
        return days * 86400 + total
    }

    /// One process per line; lines that do not parse are skipped.
    public static func parse(_ text: String) -> [LocalProcessInfo] {
        var out: [LocalProcessInfo] = []
        for line in text.split(separator: "\n") {
            let fields = line.split(separator: " ", maxSplits: 5, omittingEmptySubsequences: true)
            guard fields.count == 6, let pid = Int32(fields[0]), let ppid = Int32(fields[1]), let uid = UInt32(fields[2]),
                  let rss = UInt64(fields[3]), let cpu = cpuSeconds(String(fields[4])) else { continue }
            let command = String(fields[5]).trimmingCharacters(in: .whitespaces)
            let name = (command as NSString).lastPathComponent
            let ns = UInt64(max(0, cpu) * 1_000_000_000)
            var p = LocalProcessInfo(pid: pid, ppid: ppid, name: name.isEmpty ? command : name, uid: uid)
            p.cpuTimeNs = ns
            p.residentBytes = rss * 1024
            p.path = command.hasPrefix("/") ? command : nil
            out.append(p)
        }
        return out
    }

    /// Fills what libproc could not read (other users' processes) from a ps
    /// reading of the same moment, and adds the processes only ps listed.
    public static func merge(_ list: [LocalProcessInfo], with ps: [LocalProcessInfo]) -> [LocalProcessInfo] {
        var byPid: [Int32: LocalProcessInfo] = [:]
        for p in ps { byPid[p.pid] = p }
        var seen = Set<Int32>()
        var out: [LocalProcessInfo] = []
        for p in list {
            seen.insert(p.pid)
            guard let other = byPid[p.pid] else { out.append(p); continue }
            var filled = p
            if filled.cpuTimeNs == nil { filled.cpuTimeNs = other.cpuTimeNs }
            if filled.residentBytes == nil { filled.residentBytes = other.residentBytes }
            if filled.path == nil { filled.path = other.path }
            out.append(filled)
        }
        for p in ps where !seen.contains(p.pid) { out.append(p) }
        return out
    }
}
