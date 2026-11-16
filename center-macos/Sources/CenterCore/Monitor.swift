import Foundation

/// What the menu bar monitor shows for one server, from two samples.
public struct MonitorReading: Equatable, Sendable {
    public var cpu = 0.0, mem = 0.0, swap = 0.0, disk = 0.0
    /// Bytes per second; zero until a second sample arrives.
    public var rx = 0.0, tx = 0.0, read = 0.0, write = 0.0
    /// CPU and rates need two samples.
    public var hasRates = false
    public init() {}
    /// The worst of CPU, memory and disk: the colour of the menu bar item.
    public var worst: Double { max(cpu, mem, disk) }
}

public enum MonitorMath {
    /// Percentages and rates of `now`, against the previous sample of the same connection.
    public static func reading(previous: ServerSample?, now: ServerSample, last: MonitorReading = MonitorReading()) -> MonitorReading {
        var r = last
        r.mem = now.memTotalKb == 0 ? 0 : Double(now.memTotalKb - min(now.memAvailableKb, now.memTotalKb)) * 100 / Double(now.memTotalKb)
        r.swap = now.swapTotalKb == 0 ? 0 : Double(now.swapTotalKb - min(now.swapFreeKb, now.swapTotalKb)) * 100 / Double(now.swapTotalKb)
        let rootTotal = now.rootUsedKb + now.rootAvailKb
        r.disk = rootTotal == 0 ? 0 : Double(now.rootUsedKb) * 100 / Double(rootTotal)
        guard let prev = previous, now.uptime > prev.uptime else { return r }
        let secs = now.uptime - prev.uptime
        let total = now.cpuTotal >= prev.cpuTotal ? Double(now.cpuTotal - prev.cpuTotal) : 0
        let idle = now.cpuIdle >= prev.cpuIdle ? Double(now.cpuIdle - prev.cpuIdle) : 0
        r.cpu = total <= 0 ? 0 : max(0, min(100, (total - idle) * 100 / total))
        func delta(_ a: UInt64, _ b: UInt64) -> Double { a >= b ? Double(a - b) / secs : 0 }
        r.rx = delta(now.netRxBytes, prev.netRxBytes)
        r.tx = delta(now.netTxBytes, prev.netTxBytes)
        r.read = delta(now.diskReadBytes, prev.diskReadBytes)
        r.write = delta(now.diskWriteBytes, prev.diskWriteBytes)
        r.hasRates = true
        return r
    }

    /// Hosts watched before the person chose any: the first that connect without asking (up to three).
    public static func defaultWatch(_ hosts: [CoreHost]) -> [String] {
        Array(hosts.filter { $0.isSsh && ($0.savedSecret || ($0.authKind == "key" && $0.keyPath != nil)) }.prefix(3).map(\.id))
    }
}

public enum Percent {
    /// "%42" in Turkish, "42%" in English, "42 %" in German and French.
    public static func text(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .percent
        f.maximumFractionDigits = 0
        f.locale = L.locale
        return f.string(from: NSNumber(value: value / 100)) ?? String(format: "%.0f%%", value)
    }
}
