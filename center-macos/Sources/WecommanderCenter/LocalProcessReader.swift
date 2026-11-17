import CenterCore
import Darwin
import Foundation

/// Reads this Mac's processes with public APIs: libproc (proc_listallpids,
/// proc_pidinfo, proc_pidpath). What libproc does not give for other users'
/// processes (CPU time, memory) comes from one `ps` reading of the same
/// moment; when libproc gives nothing at all, `ps` is the whole reading.
/// Runs off the main thread.
enum LocalProcessReader {
    static func read() -> LocalSnapshot {
        let (libproc, complete) = viaLibproc()
        var list = libproc
        let missing = list.contains { $0.cpuTimeNs == nil || $0.residentBytes == nil }
        if list.isEmpty || missing || !complete {
            let ps = PsOutput.parse(runPs())
            list = list.isEmpty ? ps : PsOutput.merge(list, with: ps)
            for i in list.indices where list[i].user.isEmpty { list[i].user = userName(list[i].uid) }
        }
        return LocalSnapshot(at: Date(), processes: list)
    }

    /// The processes libproc could read, and whether it could read every one it listed.
    private static func viaLibproc() -> ([LocalProcessInfo], Bool) {
        let needed = proc_listallpids(nil, 0)
        guard needed > 0 else { return ([], false) }
        var pids = [pid_t](repeating: 0, count: Int(needed) + 64)
        let size = Int32(pids.count * MemoryLayout<pid_t>.stride)
        let got = pids.withUnsafeMutableBytes { buffer -> Int32 in
            proc_listallpids(buffer.baseAddress, size)
        }
        guard got > 0 else { return ([], false) }
        var timebase = mach_timebase_info_data_t()
        mach_timebase_info(&timebase)
        let numer = Double(timebase.numer == 0 ? 1 : timebase.numer)
        let denom = Double(timebase.denom == 0 ? 1 : timebase.denom)
        var users: [UInt32: String] = [:]
        var out: [LocalProcessInfo] = []
        var skipped = 0
        for pid in pids.prefix(Int(got)) where pid >= 0 {
            guard var p = info(pid) else { skipped += 1; continue }
            if let cached = users[p.uid] {
                p.user = cached
            } else {
                let name = userName(p.uid)
                users[p.uid] = name
                p.user = name
            }
            if let ticks = p.cpuTimeNs {
                // proc_taskinfo counts in Mach time units (nanoseconds on Intel, not on Apple silicon).
                p.cpuTimeNs = UInt64(Double(ticks) * numer / denom)
            }
            out.append(p)
        }
        return (out, skipped == 0)
    }

    /// One process; nil when it ended meanwhile.
    private static func info(_ pid: pid_t) -> LocalProcessInfo? {
        var bsd = proc_bsdinfo()
        let bsdSize = Int32(MemoryLayout<proc_bsdinfo>.stride)
        let bsdRead = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsd, bsdSize)
        if bsdRead != bsdSize && pid != 0 { return nil }

        var nameBuffer = [CChar](repeating: 0, count: 256)
        _ = proc_name(pid, &nameBuffer, UInt32(nameBuffer.count))
        var name = String(cString: nameBuffer)
        var pathBuffer = [CChar](repeating: 0, count: 4096)
        let pathLength = proc_pidpath(pid, &pathBuffer, UInt32(pathBuffer.count))
        let path: String? = pathLength > 0 ? String(cString: pathBuffer) : nil
        if name.isEmpty { name = path.map { ($0 as NSString).lastPathComponent } ?? (pid == 0 ? "kernel_task" : "?") }

        var p = LocalProcessInfo(pid: pid, ppid: Int32(bitPattern: bsd.pbi_ppid), name: name, uid: bsd.pbi_uid)
        p.path = path
        if bsdRead == bsdSize && bsd.pbi_start_tvsec > 0 {
            let seconds = Double(bsd.pbi_start_tvsec) + Double(bsd.pbi_start_tvusec) / 1_000_000
            p.started = Date(timeIntervalSince1970: seconds)
        }

        var task = proc_taskinfo()
        let taskSize = Int32(MemoryLayout<proc_taskinfo>.stride)
        if proc_pidinfo(pid, PROC_PIDTASKINFO, 0, &task, taskSize) == taskSize {
            p.cpuTimeNs = task.pti_total_user &+ task.pti_total_system
            p.residentBytes = task.pti_resident_size
            p.threads = Int(task.pti_threadnum)
        }
        return p
    }

    private static func userName(_ uid: UInt32) -> String {
        guard let entry = getpwuid(uid) else { return String(uid) }
        return String(cString: entry.pointee.pw_name)
    }

    private static func runPs() -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = PsOutput.arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return ""
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    /// Asks a process to end (SIGTERM) or stops it at once (SIGKILL); the system's error text when it was refused.
    static func signal(_ pid: Int32, kill force: Bool) -> String? {
        let result = Darwin.kill(pid, force ? SIGKILL : SIGTERM)
        if result == 0 { return nil }
        return String(cString: strerror(errno))
    }

    /// Whether the process still runs.
    static func isRunning(_ pid: Int32) -> Bool {
        Darwin.kill(pid, 0) == 0 || errno == EPERM
    }
}
