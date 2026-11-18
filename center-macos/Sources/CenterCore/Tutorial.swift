import Foundation

/// The getting-started tutorial's steps. A step moves on when the person does
/// the thing it shows (adds a server, opens a terminal), not with a Next
/// button; the status and AI steps have their own buttons. The same steps on
/// Windows (center-windows/Core/Tutorial.cs) and macOS.
public enum Tutorial {
    public static let notStarted = 0, addServer = 1, connect = 2, status = 3, ai = 4, finish = 5, done = 6

    /// Where it starts: a person who already has servers skips adding one.
    public static func start(hostCount: Int) -> Int { hostCount > 0 ? connect : addServer }

    /// The step to show now (it may move on by itself: servers appeared through sync or import).
    public static func current(_ step: Int, off: Bool, hostCount: Int) -> Int {
        if off || step >= done { return done }
        if step <= notStarted { return start(hostCount: hostCount) }
        if step == addServer && hostCount > 0 { return connect }
        return step
    }

    /// A server was added.
    public static func hostAdded(_ step: Int) -> Int { step == addServer ? connect : step }

    /// A terminal opened.
    public static func terminalOpened(_ step: Int) -> Int { step == addServer || step == connect ? status : step }

    /// The step's own button (or "skip") was pressed.
    public static func next(_ step: Int) -> Int { step >= finish ? done : step + 1 }

    /// Settings → "Baştan başlat".
    public static func restart(hostCount: Int) -> Int { start(hostCount: hostCount) }
}
