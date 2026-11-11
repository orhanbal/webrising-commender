import CenterCore
import Foundation

/// A27: one side of a shared terminal. The host sends output and receives
/// guests' keys; a guest receives output and sends keys. Payloads are sealed
/// with the team key by wecommander-core, so the relay only sees opaque frames.
@MainActor
final class ShareConnection: ObservableObject {
    let id: String
    let isHost: Bool
    @Published var allowInput = false
    @Published private(set) var guests: [String: String] = [:]
    var onOutput: ((String) -> Void)?
    var onInput: ((String) -> Void)?
    var onEnded: ((String) -> Void)?
    private let task: URLSessionWebSocketTask
    private let core: CoreClient
    private var history: [String] = []
    private var historySize = 0

    init(core: CoreClient, url: URL, token: String, id: String, host: Bool) {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        task = URLSession.shared.webSocketTask(with: request)
        self.core = core
        self.id = id
        isHost = host
        task.resume()
        receive()
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
    }

    /// Host: terminal output (base64), kept for guests who join later.
    func sendOutput(_ b64: String) {
        history.append(b64)
        historySize += b64.count
        while historySize > 96 * 1024, !history.isEmpty { historySize -= history.removeFirst().count }
        guard !guests.isEmpty else { return }
        Task { await sendSealed("data", b64, to: nil) }
    }

    /// Guest: keys for the host's terminal.
    func sendInput(_ keys: String) {
        Task { await sendSealed("input", keys, to: nil) }
    }

    func kick(_ guest: String) {
        send(["t": "kick", "to": guest])
    }

    private func sendSealed(_ type: String, _ plain: String, to: String?) async {
        guard let reply = try? await core.call("team.seal", ["data": plain]) as? [String: Any],
              let sealed = reply["data"] as? String else { return }
        var frame: [String: Any] = ["t": type, "d": sealed]
        if let to { frame["to"] = to }
        send(frame)
    }

    private func send(_ frame: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func receive() {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(.string(let text)):
                    await self.handle(text)
                    self.receive()
                case .success:
                    self.receive()
                case .failure:
                    let reason: String
                    switch self.task.closeReason.flatMap({ String(data: $0, encoding: .utf8) }) {
                    case "removed by host": reason = "Paylaşan kişi seni çıkardı."
                    case "share is full": reason = "Bu paylaşım dolu."
                    case "no such share": reason = "Paylaşım artık yok."
                    default: reason = "Paylaşım bitti."
                    }
                    self.onEnded?(reason)
                }
            }
        }
    }

    private func handle(_ text: String) async {
        guard let data = text.data(using: .utf8),
              let f = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = f["t"] as? String else { return }
        let from = f["from"] as? String
        switch type {
        case "join" where isHost:
            guard let from else { return }
            guests[from] = f["email"] as? String ?? ""
            for chunk in history { await sendSealed("data", chunk, to: from) }
        case "leave" where isHost:
            if let from { guests.removeValue(forKey: from) }
        case "input" where isHost && allowInput, "data" where !isHost:
            guard let sealed = f["d"] as? String,
                  let reply = try? await core.call("team.open", ["data": sealed]) as? [String: Any],
                  let plain = reply["data"] as? String else { return }
            if type == "input" { onInput?(plain) } else { onOutput?(plain) }
        case "paused" where !isHost:
            onOutput?(Data("\r\n\u{1b}[90m[Paylaşan kişinin bağlantısı koptu; geri gelmesi bekleniyor.]\u{1b}[0m\r\n".utf8).base64EncodedString())
        default:
            break
        }
    }
}
