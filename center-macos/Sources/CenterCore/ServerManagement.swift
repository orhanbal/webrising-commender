import Foundation

// Server management (server.* in the core): what a server's overview, disk,
// cleanup and process screens show. Sizes are in KB unless named Bytes.
// The same models as the Windows app (center-windows/Core/ServerManagement.cs);
// the core sends them camelCase.

/// `a - b`, or 0 when `b` is larger (counters never go below zero here).
@inline(__always) func minus(_ a: UInt64, _ b: UInt64) -> UInt64 { a > b ? a - b : 0 }

/// "root" and "sudo" may change things; anything else only looks.
public enum ServerPrivilege {
    public static func canChange(_ privilege: String) -> Bool { privilege == "root" || privilege == "sudo" }
}

public struct ServerDisk: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let device: String
    public let fsType: String
    public let mount: String
    public let sizeKb: UInt64
    public let usedKb: UInt64
    public let availKb: UInt64
    public var id: String { mount + "|" + device }

    public init(device: String, fsType: String, mount: String, sizeKb: UInt64, usedKb: UInt64, availKb: UInt64) {
        self.device = device; self.fsType = fsType; self.mount = mount
        self.sizeKb = sizeKb; self.usedKb = usedKb; self.availKb = availKb
    }

    /// Used + available: what `df` counts as the disk's size for its percent.
    public var usableKb: UInt64 { usedKb &+ availKb }

    public var usedPercent: Double {
        if sizeKb == 0 { return 0 }
        let base = usableKb == 0 ? sizeKb : usableKb
        return (Double(usedKb) * 100.0 / Double(base) * 10).rounded() / 10
    }
}

public struct ServerOverview: Decodable, Equatable, Sendable {
    public let hostname: String
    public let os: String
    public let kernel: String
    public let uptimeSecs: UInt64
    public let load: [Double]
    public let cpus: UInt32
    public let cpuPercent: Double
    public let memTotalKb: UInt64
    public let memAvailableKb: UInt64
    public let swapTotalKb: UInt64
    public let swapFreeKb: UInt64
    public let disks: [ServerDisk]
    public let rebootRequired: Bool
    public let updates: String
    public let processes: UInt32
    public let zombies: UInt32
    public let privilege: String
    public let docker: Bool

    public var canChange: Bool { ServerPrivilege.canChange(privilege) }
    public var memUsedKb: UInt64 { minus(memTotalKb, memAvailableKb) }
    public var swapUsedKb: UInt64 { minus(swapTotalKb, swapFreeKb) }
    /// The root disk, else the first one.
    public var rootDisk: ServerDisk? { disks.first { $0.mount == "/" } ?? disks.first }
}

public struct UsageEntry: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let path: String
    public let kb: UInt64
    public var id: String { path }
    public init(path: String, kb: UInt64) { self.path = path; self.kb = kb }
}

public struct DockerUsage: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let kind: String
    public let count: String
    public let sizeBytes: UInt64
    public let reclaimableBytes: UInt64
    public var id: String { kind }
}

/// A Docker daemon's storage folder (the system one, or a user's rootless one).
public struct DockerStore: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let label: String
    public let user: String
    public let socket: String
    public let rootDir: String
    public let error: String

    public init(id: String, kind: String, label: String, user: String, socket: String, rootDir: String, error: String) {
        self.id = id; self.kind = kind; self.label = label; self.user = user
        self.socket = socket; self.rootDir = rootDir; self.error = error
    }
}

public struct DiskUsage: Decodable, Equatable, Sendable {
    public let path: String
    public let totalKb: UInt64
    public let entries: [UsageEntry]
    public let docker: [DockerUsage]
    public let complete: Bool
    /// Missing from older cores.
    public let dockerStores: [DockerStore]?

    enum CodingKeys: String, CodingKey { case path, totalKb, entries, docker, complete, dockerStores }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        totalKb = try c.decodeIfPresent(UInt64.self, forKey: .totalKb) ?? 0
        entries = try c.decodeIfPresent([UsageEntry].self, forKey: .entries) ?? []
        docker = try c.decodeIfPresent([DockerUsage].self, forKey: .docker) ?? []
        complete = try c.decodeIfPresent(Bool.self, forKey: .complete) ?? true
        dockerStores = try c.decodeIfPresent([DockerStore].self, forKey: .dockerStores)
    }
}

/// One Docker daemon on the server, as the cleanup reads it: what it stores,
/// what it frees, what it protects (running containers), or why it could not
/// be read (then its sizes are unknown, not zero).
public struct DockerEnv: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let label: String
    public let user: String
    public let uid: UInt32
    public let socket: String
    public let rootDir: String
    public let imagesBytes: UInt64
    public let imagesReclaimableBytes: UInt64
    public let buildCacheBytes: UInt64
    public let buildCacheReclaimableBytes: UInt64
    public let containersBytes: UInt64
    public let volumesBytes: UInt64
    public let danglingBytes: UInt64
    public let imagesTotal: UInt32
    public let imagesActive: UInt32
    public let containersTotal: UInt32
    public let containersRunning: UInt32
    public let running: [String]
    public let error: String

    public var totalBytes: UInt64 { imagesBytes &+ buildCacheBytes &+ containersBytes &+ volumesBytes }
    /// The most a cleanup can free here: build cache plus unused images (dangling ones are part of those).
    public var reclaimableBytes: UInt64 { buildCacheReclaimableBytes &+ imagesReclaimableBytes }
    public var rootless: Bool { kind == "rootless" }
}

/// `docker`: the daemon this cleanup is for (system, u1000); empty for the rest.
/// `group`: items of one group overlap; only one of them can be chosen.
public struct CleanupItem: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let detail: String
    public let kb: UInt64
    public let command: String
    public let warning: String
    public let docker: String
    public let group: String

    enum CodingKeys: String, CodingKey { case id, title, detail, kb, command, warning, docker, group }

    public init(id: String, title: String, detail: String = "", kb: UInt64, command: String, warning: String = "", docker: String = "", group: String = "") {
        self.id = id; self.title = title; self.detail = detail; self.kb = kb
        self.command = command; self.warning = warning; self.docker = docker; self.group = group
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
        kb = try c.decodeIfPresent(UInt64.self, forKey: .kb) ?? 0
        command = try c.decodeIfPresent(String.self, forKey: .command) ?? ""
        warning = try c.decodeIfPresent(String.self, forKey: .warning) ?? ""
        docker = try c.decodeIfPresent(String.self, forKey: .docker) ?? ""
        group = try c.decodeIfPresent(String.self, forKey: .group) ?? ""
    }
}

public struct CleanupScan: Decodable, Equatable, Sendable {
    public let items: [CleanupItem]
    public let privilege: String
    public let disk: ServerDisk?
    public let dockers: [DockerEnv]?

    enum CodingKeys: String, CodingKey { case items, privilege, disk, dockers }

    public init(items: [CleanupItem], privilege: String, disk: ServerDisk? = nil, dockers: [DockerEnv]? = nil) {
        self.items = items; self.privilege = privilege; self.disk = disk; self.dockers = dockers
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        items = try c.decodeIfPresent([CleanupItem].self, forKey: .items) ?? []
        privilege = try c.decodeIfPresent(String.self, forKey: .privilege) ?? ""
        disk = try c.decodeIfPresent(ServerDisk.self, forKey: .disk)
        dockers = try c.decodeIfPresent([DockerEnv].self, forKey: .dockers)
    }

    public var canChange: Bool { ServerPrivilege.canChange(privilege) }

    /// Docker cleanups go through the daemon itself: no root needed when this login can reach it.
    public func allowed(_ item: CleanupItem) -> Bool { canChange || !item.docker.isEmpty }

    /// What is ticked at first: what may be cleaned, has a size and carries no
    /// warning; of a group (overlapping items) only the first.
    public func defaultChoice() -> Set<String> {
        var chosen = Set<String>()
        var groups = Set<String>()
        for item in items where allowed(item) && item.kb > 0 && item.warning.isEmpty {
            if !item.group.isEmpty {
                if groups.contains(item.group) { continue }
                groups.insert(item.group)
            }
            chosen.insert(item.id)
        }
        return chosen
    }

    /// Ticks or unticks one item; ticking one of a group unticks the others
    /// (untagged images are part of the unused ones: one of the two, never both).
    public func choose(_ id: String, _ on: Bool, in chosen: Set<String>) -> Set<String> {
        var next = chosen
        guard on else { next.remove(id); return next }
        guard let item = items.first(where: { $0.id == id }), allowed(item), item.kb > 0 else { return next }
        if !item.group.isEmpty {
            for other in items where other.group == item.group && other.id != id { next.remove(other.id) }
        }
        next.insert(id)
        return next
    }
}

/// What the cleanup page shows: the server's own items, then each Docker daemon with its items.
public struct CleanupSection: Equatable, Sendable, Identifiable {
    public let docker: DockerEnv?
    public let items: [CleanupItem]
    public var id: String { docker.map { "docker:" + $0.id } ?? "server" }
}

public enum CleanupLayout {
    /// The server's own items first, then every Docker daemon (system, then
    /// rootless ones), each with its own items; a daemon that could not be
    /// read has none and shows why.
    public static func sections(_ scan: CleanupScan) -> [CleanupSection] {
        let dockers = scan.dockers ?? []
        let known = Set(dockers.map { $0.id })
        var own = scan.items.enumerated()
            .filter { $0.element.docker.isEmpty }
            .sorted { $0.element.kb != $1.element.kb ? $0.element.kb > $1.element.kb : $0.offset < $1.offset }
            .map { $0.element }
        // An older core: Docker items without a daemon list stay with the rest.
        own += scan.items.filter { !$0.docker.isEmpty && !known.contains($0.docker) }
        var sections = [CleanupSection(docker: nil, items: own)]
        for env in dockers {
            sections.append(CleanupSection(docker: env, items: scan.items.filter { $0.docker == env.id }))
        }
        return sections
    }

    /// The daemon whose data is in (or is) `path`, for the Disk page.
    public static func storeFor(_ path: String, _ stores: [DockerStore]?) -> DockerStore? {
        guard let stores else { return nil }
        let p = DiskPaths.trimmed(path)
        for s in stores where !s.rootDir.isEmpty {
            let root = DiskPaths.trimmed(s.rootDir)
            if root == p || root.hasPrefix(p + "/") || p.hasPrefix(root + "/") { return s }
        }
        return nil
    }

    /// The daemon whose storage `path` is, or is inside (not a folder that only holds it).
    public static func storeInside(_ path: String, _ stores: [DockerStore]?) -> DockerStore? {
        guard let here = storeFor(path, stores) else { return nil }
        let root = DiskPaths.trimmed(here.rootDir), p = DiskPaths.trimmed(path)
        return root == p || p.hasPrefix(root + "/") ? here : nil
    }

    /// After a cleanup: the space really freed against the estimate, and why they can differ.
    public static func freed(_ estimateKb: UInt64, _ beforeFreeKb: UInt64?, _ afterFreeKb: UInt64?) -> String {
        guard let before = beforeFreeKb, let after = afterFreeKb else { return "" }
        let freed = minus(after, before)
        var text = L.f("Diskte gerçekten {0} yer açıldı (tahmin {1}).", Sizes.kb(freed), Sizes.kb(estimateKb))
        let gap = abs(Double(freed) - Double(estimateKb))
        if estimateKb > 0 && gap > Double(estimateKb) * 0.15 {
            text += L.t(" Fark normaldir: Docker paylaşılan katmanları ayrı sayar, başka bir diskteki depolama buradaki boş alanı değiştirmez ve bu sırada sunucuda yazılan dosyalar da boş alanı etkiler.")
        }
        return text
    }
}

public struct CleanupResult: Decodable, Equatable, Sendable {
    public let id: String
    public let ok: Bool
    public let message: String

    public init(id: String, ok: Bool, message: String) { self.id = id; self.ok = ok; self.message = message }
}

public struct ServerProcess: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let pid: UInt32
    public let ppid: UInt32
    public let user: String
    public let state: String
    public let cpu: Double
    public let mem: Double
    public let rssKb: UInt64
    public let elapsedSecs: UInt64
    public let name: String
    public let command: String
    public var id: UInt32 { pid }

    public init(pid: UInt32, ppid: UInt32 = 1, user: String, state: String = "S", cpu: Double, mem: Double = 0,
                rssKb: UInt64, elapsedSecs: UInt64 = 0, name: String, command: String) {
        self.pid = pid; self.ppid = ppid; self.user = user; self.state = state; self.cpu = cpu
        self.mem = mem; self.rssKb = rssKb; self.elapsedSecs = elapsedSecs; self.name = name; self.command = command
    }

    public var isZombie: Bool { state.hasPrefix("Z") }

    /// The exact command a signal runs: `kill -TERM 123`.
    public func signalCommand(_ action: String) -> String {
        let signal = action == "kill" ? "KILL" : action == "reap" ? "CHLD" : "TERM"
        return "kill -" + signal + " " + String(pid)
    }
}

public struct ProcessOwner: Decodable, Equatable, Hashable, Sendable {
    /// "container", "service" or "" (unknown).
    public let kind: String
    public let id: String
    public let name: String
}

public struct ZombieGroup: Decodable, Equatable, Hashable, Sendable, Identifiable {
    public let parent: ServerProcess
    public let count: UInt32
    public let owner: ProcessOwner
    /// Why the parent may not be stopped here, when it may not.
    public let `protected`: String
    public var id: UInt32 { parent.pid }

    /// The owner can be restarted here (a container or service that is not protected).
    public var canRestartOwner: Bool { (owner.kind == "container" || owner.kind == "service") && `protected`.isEmpty }

    /// The exact command a restart of the owner runs.
    public var restartCommand: String {
        owner.kind == "container" ? "docker restart " + owner.id : "systemctl restart " + owner.id
    }
}

public struct ProcessList: Decodable, Equatable, Sendable {
    public let processes: [ServerProcess]
    public let zombies: [ZombieGroup]
    public let privilege: String

    public var canChange: Bool { ServerPrivilege.canChange(privilege) }
    public var zombieCount: UInt32 { zombies.reduce(0) { $0 &+ $1.count } }
    /// Running processes (zombies are listed in their groups).
    public var live: [ServerProcess] { processes.filter { !$0.isZombie } }

    /// The process table: a filter on name, command, user or exact PID;
    /// heaviest first by CPU or memory; at most `limit`.
    public func shown(filter: String, byMemory: Bool, limit: Int = 100) -> [ServerProcess] {
        let f = filter.trimmingCharacters(in: .whitespaces)
        let matching = live.filter { p in
            f.isEmpty || p.name.localizedCaseInsensitiveContains(f) || p.command.localizedCaseInsensitiveContains(f)
                || p.user.localizedCaseInsensitiveContains(f) || String(p.pid) == f
        }
        let sorted = matching.enumerated().sorted { a, b in
            let x = byMemory ? Double(a.element.rssKb) : a.element.cpu
            let y = byMemory ? Double(b.element.rssKb) : b.element.cpu
            return x != y ? x > y : a.offset < b.offset
        }.map { $0.element }
        return Array(sorted.prefix(limit))
    }
}

/// Raw counters; two samples make rates.
public struct ServerSample: Codable, Equatable, Sendable {
    public let uptime: Double
    public let cpuTotal: UInt64
    public let cpuIdle: UInt64
    public let memTotalKb: UInt64
    public let memAvailableKb: UInt64
    public let swapTotalKb: UInt64
    public let swapFreeKb: UInt64
    public let load1: Double
    public let netRxBytes: UInt64
    public let netTxBytes: UInt64
    public let diskReadBytes: UInt64
    public let diskWriteBytes: UInt64
    public let rootUsedKb: UInt64
    public let rootAvailKb: UInt64
    public let zombies: UInt32

    enum CodingKeys: String, CodingKey {
        case uptime, cpuTotal, cpuIdle, memTotalKb, memAvailableKb, swapTotalKb, swapFreeKb, load1
        case netRxBytes, netTxBytes, diskReadBytes, diskWriteBytes, rootUsedKb, rootAvailKb, zombies
    }

    public init(uptime: Double, cpuTotal: UInt64, cpuIdle: UInt64, memTotalKb: UInt64, memAvailableKb: UInt64,
                swapTotalKb: UInt64, swapFreeKb: UInt64, load1: Double, netRxBytes: UInt64, netTxBytes: UInt64,
                diskReadBytes: UInt64, diskWriteBytes: UInt64, rootUsedKb: UInt64 = 0, rootAvailKb: UInt64 = 0, zombies: UInt32 = 0) {
        self.uptime = uptime; self.cpuTotal = cpuTotal; self.cpuIdle = cpuIdle
        self.memTotalKb = memTotalKb; self.memAvailableKb = memAvailableKb
        self.swapTotalKb = swapTotalKb; self.swapFreeKb = swapFreeKb; self.load1 = load1
        self.netRxBytes = netRxBytes; self.netTxBytes = netTxBytes
        self.diskReadBytes = diskReadBytes; self.diskWriteBytes = diskWriteBytes
        self.rootUsedKb = rootUsedKb; self.rootAvailKb = rootAvailKb; self.zombies = zombies
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        uptime = try c.decode(Double.self, forKey: .uptime)
        cpuTotal = try c.decode(UInt64.self, forKey: .cpuTotal)
        cpuIdle = try c.decode(UInt64.self, forKey: .cpuIdle)
        memTotalKb = try c.decode(UInt64.self, forKey: .memTotalKb)
        memAvailableKb = try c.decode(UInt64.self, forKey: .memAvailableKb)
        swapTotalKb = try c.decodeIfPresent(UInt64.self, forKey: .swapTotalKb) ?? 0
        swapFreeKb = try c.decodeIfPresent(UInt64.self, forKey: .swapFreeKb) ?? 0
        load1 = try c.decodeIfPresent(Double.self, forKey: .load1) ?? 0
        netRxBytes = try c.decodeIfPresent(UInt64.self, forKey: .netRxBytes) ?? 0
        netTxBytes = try c.decodeIfPresent(UInt64.self, forKey: .netTxBytes) ?? 0
        diskReadBytes = try c.decodeIfPresent(UInt64.self, forKey: .diskReadBytes) ?? 0
        diskWriteBytes = try c.decodeIfPresent(UInt64.self, forKey: .diskWriteBytes) ?? 0
        rootUsedKb = try c.decodeIfPresent(UInt64.self, forKey: .rootUsedKb) ?? 0
        rootAvailKb = try c.decodeIfPresent(UInt64.self, forKey: .rootAvailKb) ?? 0
        zombies = try c.decodeIfPresent(UInt32.self, forKey: .zombies) ?? 0
    }

    public var memUsedKb: UInt64 { minus(memTotalKb, memAvailableKb) }
    public var memPercent: Double { memTotalKb == 0 ? 0 : Double(memUsedKb) * 100.0 / Double(memTotalKb) }
}

/// What happened between two samples, per second.
public struct ServerRates: Equatable, Sendable {
    public let cpuPercent: Double
    public let netRx: Double
    public let netTx: Double
    public let diskRead: Double
    public let diskWrite: Double

    /// nil when the server restarted or no time passed between them.
    public static func between(_ previous: ServerSample, _ now: ServerSample) -> ServerRates? {
        guard now.uptime > previous.uptime else { return nil }
        let secs = now.uptime - previous.uptime
        let total = Double(minus(now.cpuTotal, previous.cpuTotal))
        let idle = Double(minus(now.cpuIdle, previous.cpuIdle))
        let busy = total <= 0 ? 0 : min(100, max(0, (total - idle) * 100.0 / total))
        func delta(_ a: UInt64, _ b: UInt64) -> Double { Double(minus(a, b)) / secs }
        return ServerRates(cpuPercent: busy,
                           netRx: delta(now.netRxBytes, previous.netRxBytes), netTx: delta(now.netTxBytes, previous.netTxBytes),
                           diskRead: delta(now.diskReadBytes, previous.diskReadBytes), diskWrite: delta(now.diskWriteBytes, previous.diskWriteBytes))
    }
}

/// What "Öneriyi uygula" did: applied, already, needs-token, compose, not-coolify.
public struct InitFix: Decodable, Equatable, Sendable {
    public let status: String
    public let app: String
    public let message: String
}

/// Paths on the Disk page.
public enum DiskPaths {
    /// Without trailing slashes ("/" becomes "").
    public static func trimmed(_ path: String) -> String {
        var p = path
        while p.hasSuffix("/") { p.removeLast() }
        return p
    }

    /// The folder above `path` ("/" for a top-level folder).
    public static func parent(_ path: String) -> String {
        let p = trimmed(path)
        guard let slash = p.lastIndex(of: "/"), slash > p.startIndex else { return "/" }
        return String(p[..<slash])
    }

    /// `path` relative to `parent` ("/var/lib", "/var/lib/docker" → "docker").
    public static func name(_ parent: String, _ path: String) -> String {
        guard path.count > parent.count, path.hasPrefix(parent) else { return path }
        var rest = String(path.dropFirst(parent.count))
        while rest.hasPrefix("/") { rest.removeFirst() }
        return rest
    }
}

public enum Sizes {
    /// "118 GB", "512 MB", "3,4 KB" from KB.
    public static func kb(_ kb: UInt64) -> String {
        let (bytes, overflow) = kb.multipliedReportingOverflow(by: 1024)
        return self.bytes(overflow ? UInt64.max : bytes)
    }

    public static func bytes(_ bytes: UInt64) -> String {
        let units = ["B", "KB", "MB", "GB", "TB"]
        var v = Double(bytes)
        var i = 0
        while v >= 1024 && i < units.count - 1 { v /= 1024; i += 1 }
        return number(v, digits: v >= 100 || i == 0 ? 0 : 1) + " " + units[i]
    }

    /// "1,2 MB/sn" for a rate in bytes per second.
    public static func rate(_ bytesPerSecond: Double) -> String {
        let v = bytesPerSecond.isFinite ? max(0, min(bytesPerSecond, 1.8e19)) : 0
        return L.f("{0}/sn", bytes(UInt64(v)))
    }

    /// "%42" in Turkish, "42%" in English.
    public static func percent(_ value: Double) -> String {
        L.f("%{0}", number(value.isFinite ? value : 0, digits: 0))
    }

    /// "42 gün 12 sa", "3 sa 5 dk", "40 sn".
    public static func duration(_ secs: UInt64) -> String {
        let d = secs / 86400, h = secs % 86400 / 3600, m = secs % 3600 / 60
        if d > 0 { return L.f("{0} gün {1} sa", d, h) }
        if h > 0 { return L.f("{0} sa {1} dk", h, m) }
        if m > 0 { return L.f("{0} dk", m) }
        return L.f("{0} sn", secs)
    }

    /// A number with at most `digits` decimals in the interface language ("1,5" / "1.5").
    public static func number(_ value: Double, digits: Int) -> String {
        let f = NumberFormatter()
        f.locale = L.locale
        f.numberStyle = .decimal
        f.usesGroupingSeparator = false
        f.minimumFractionDigits = 0
        f.maximumFractionDigits = digits
        f.roundingMode = .halfUp
        return f.string(from: NSNumber(value: value)) ?? String(value)
    }
}
