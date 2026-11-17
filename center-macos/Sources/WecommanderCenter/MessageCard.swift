import AppKit
import CenterCore
import SwiftUI

/// The person's next marketing message or survey from the console, fetched
/// once per app run; shown bottom left of the main window.
@MainActor
final class MessageCenter: ObservableObject {
    @Published private(set) var message: InAppMessage?
    private var fetched = false
    private let app: AppModel

    init(app: AppModel) { self.app = app }

    func fetchOnce() {
        guard !fetched, let token = app.token else { return }
        fetched = true
        let gateway = app.gateway
        Task {
            // Offline or an older server: nothing to show.
            guard let m = try? await gateway.message(token: token) else { return }
            message = m
            respond(m, "shown")
        }
    }

    func respond(_ m: InAppMessage, _ action: String, score: Int? = nil, comment: String? = nil) {
        guard let token = app.token else { return }
        let gateway = app.gateway
        Task { try? await gateway.respond(token: token, id: m.id, action: action, score: score, comment: comment) }
    }

    func close() { message = nil }
}

struct MessageCard: View {
    @ObservedObject var center: MessageCenter
    @State private var chosen: Int?
    @State private var note = ""
    @State private var thanked = false

    private static let faces = ["😩", "🙁", "🤔", "🙂", "😄"]

    var body: some View {
        if let m = center.message {
            VStack(alignment: .leading, spacing: 10) {
                if thanked {
                    Text(L.t("Teşekkürler! 🙏")).font(.callout.weight(.semibold))
                } else {
                    HStack(alignment: .top) {
                        Text(icon(m.kind) + m.title).font(.callout.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button { center.respond(m, "dismissed"); center.close() } label: { WCIcon(.close) }
                            .buttonStyle(.borderless).help(L.t("Kapat")).accessibilityLabel(L.t("Kapat"))
                    }
                    if !m.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(m.body).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    if m.isSurvey {
                        survey(m)
                    } else if let cta = m.cta {
                        Button(cta.label) {
                            center.respond(m, "clicked")
                            NSWorkspace.shared.open(cta.url)
                            center.close()
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
            .padding(14)
            .frame(width: 320, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.2)))
            .shadow(radius: 8, y: 2)
            .padding(16)
        }
    }

    @ViewBuilder
    private func survey(_ m: InAppMessage) -> some View {
        let csat = m.kind == "csat"
        HStack(spacing: csat ? 6 : 2) {
            ForEach(m.scores, id: \.self) { value in
                let label = csat ? Self.faces[value - 1] : String(value)
                if chosen == value {
                    Button { chosen = value } label: { Text(label).font(csat ? .title2 : .caption).frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                } else {
                    Button { chosen = value } label: { Text(label).font(csat ? .title2 : .caption).frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered)
                }
            }
        }
        if !csat {
            HStack {
                Text(L.t("Hiç olası değil"))
                Spacer()
                Text(L.t("Çok olası"))
            }
            .font(.caption2).foregroundStyle(.secondary)
        }
        if let score = chosen {
            TextField(L.t("Eklemek istediğin bir şey var mı? (isteğe bağlı)"), text: $note, axis: .vertical)
                .lineLimit(2...4)
                .onChange(of: note) { v in if v.count > 1000 { note = String(v.prefix(1000)) } }
            Button(L.t("Gönder")) {
                let comment = note.trimmingCharacters(in: .whitespacesAndNewlines)
                center.respond(m, "answered", score: score, comment: comment.isEmpty ? nil : comment)
                thanked = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { center.close() }
            }
            .buttonStyle(.borderedProminent)
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }

    private func icon(_ kind: String) -> String {
        switch kind {
        case "tip": return "💡 "
        case "announcement": return "📣 "
        default: return "👋 "
        }
    }
}
