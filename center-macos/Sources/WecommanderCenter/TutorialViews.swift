import AppKit
import CenterCore
import SwiftUI

extension Color {
    /// The getting-started tutorial's green (the ring and the card's dot).
    static let tutorial = Color(red: 0.13, green: 0.77, blue: 0.37)
}

/// The getting-started tutorial's pulsing green ring around the thing a step
/// points at: a steady ring plus one that grows and fades, over and over
/// (only the steady ring with Reduce Motion). It never takes clicks.
struct TutorialRing: ViewModifier {
    let active: Bool
    var cornerRadius: CGFloat = 8
    @State private var pulse = false

    func body(content: Content) -> some View {
        content.overlay {
            if active {
                ZStack {
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .stroke(Color.tutorial, lineWidth: 2)
                    if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                        RoundedRectangle(cornerRadius: cornerRadius)
                            .stroke(Color.tutorial, lineWidth: 2)
                            .scaleEffect(pulse ? 1.25 : 1)
                            .opacity(pulse ? 0 : 0.9)
                            .animation(.easeOut(duration: 1.2).repeatForever(autoreverses: false), value: pulse)
                    }
                }
                .padding(-4)
                .allowsHitTesting(false)
                .onAppear { DispatchQueue.main.async { pulse = true } }
                .onDisappear { pulse = false }
            }
        }
    }
}

extension View {
    /// The tutorial's pulsing ring around this view while `active`.
    func tutorialRing(_ active: Bool, cornerRadius: CGFloat = 8) -> some View {
        modifier(TutorialRing(active: active, cornerRadius: cornerRadius))
    }
}

/// The getting-started tutorial's card for the current step (Tutorial): a
/// title, one sentence and the step's buttons. It sits in a corner of the
/// window and never covers what it points at; a right click (or Esc) turns
/// the tutorial off.
struct TutorialCard: View {
    @ObservedObject var model: ServersModel
    let step: Int
    var showPanel: () -> Void = {}

    private var title: String {
        switch step {
        case Tutorial.addServer: return L.t("İlk sunucunu ekleyelim")
        case Tutorial.connect: return L.t("Şimdi bağlan")
        case Tutorial.status: return L.t("Sunucunun durumu menü çubuğunda")
        case Tutorial.ai: return L.t("İstersen yapay zekânı bağla")
        default: return L.t("Hazırsın")
        }
    }

    private var message: String {
        switch step {
        case Tutorial.addServer: return L.t("\"Yeni sunucu\"ya bas; adresini ve giriş bilgini yaz, gerisini WECOMMANDER halleder.")
        case Tutorial.connect: return L.t("Sunucuya tıkla; terminal yeni sekmede açılır.")
        case Tutorial.status: return L.t("Menü çubuğundaki WECOMMANDER simgesi işlemci, bellek ve disk durumunu canlı gösterir; tıklayınca ayrıntılar açılır.")
        case Tutorial.ai: return L.t("Claude, ChatGPT ya da Cursor'a sunucularını onayınla kullandırabilirsin. İstemezsen atla.")
        default: return L.t("Öğreticiyi istediğin zaman Ayarlar'dan yeniden başlatabilirsin.")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle().fill(Color.tutorial).frame(width: 8, height: 8)
                Text(title).font(.headline)
            }
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                buttons
            }
        }
        .padding(14)
        .frame(width: 300, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.tutorial.opacity(0.6), lineWidth: 1))
        .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
        .contextMenu { Button(L.t("Öğreticiyi kapat")) { model.setTutorialOff(true) } }
        .onExitCommand { model.setTutorialOff(true) }
        .padding(16)
    }

    @ViewBuilder
    private var buttons: some View {
        switch step {
        case Tutorial.status:
            Button(L.t("Tamam")) { model.tutorialNext() }
                .buttonStyle(.borderedProminent)
        case Tutorial.ai:
            Button(L.t("Atla")) { model.tutorialNext() }
            // The AI's requests arrive in the approvals panel ("Onaylar ve bu Mac").
            Button(L.t("Göster")) {
                showPanel()
                model.tutorialNext()
            }
            .buttonStyle(.borderedProminent)
        case Tutorial.finish:
            Button(L.t("Bitir")) { model.tutorialNext() }
                .buttonStyle(.borderedProminent)
        default:
            Button(L.t("Atla")) { model.tutorialNext() }
        }
    }
}
