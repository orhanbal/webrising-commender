import AppKit
import SwiftTerm

/// Autocomplete in a terminal, like the Windows app: the line being typed is
/// followed; a command from this host's history or the snippets that starts
/// with it shows dimmed after the cursor, and → accepts it. Tab stays the
/// shell's own completion. Answers to password prompts are never kept.
@MainActor
final class Autosuggest {
    private weak var view: TerminalView?
    private let label = NSTextField(labelWithString: "")
    private var line = ""
    private var known = true
    private(set) var hint = ""
    var history: [String] = []
    var snippets: [String] = []
    /// A command was entered: (command, the screen text before it).
    var onCommand: ((String, String) -> Void)?

    init(view: TerminalView) {
        self.view = view
        label.isHidden = true
        label.alphaValue = 0.45
        label.lineBreakMode = .byClipping
        label.drawsBackground = false
        view.addSubview(label)
    }

    /// Bytes the person typed. Called on the next main-queue turn, never
    /// inside the terminal's send callback (it may hold the terminal lock).
    func typed(_ bytes: [UInt8]) {
        let text = String(decoding: bytes, as: UTF8.self)
        switch text {
        case "\r":
            let prompt = promptText()
            let secret = ["password", "passphrase", "parola", "şifre", "passcode", "pin:", "token"]
                .contains { prompt.lowercased().contains($0) }
            let command = line.trimmingCharacters(in: .whitespaces)
            if known, !command.isEmpty, !secret {
                onCommand?(command, prompt)
                history.removeAll { $0 == command }
                history.append(command)
            }
            line = ""
            known = true
        case "\u{7f}", "\u{8}":
            if !line.isEmpty { line.removeLast() }
        case "\u{3}", "\u{15}":
            line = ""
            known = true
        default:
            if text.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value != 0x7f }) {
                line += text
            } else {
                known = false // arrows, Tab, Ctrl keys: the shell changed the line
            }
        }
        refresh()
    }

    /// → with a suggestion: types the rest of it. True when it did.
    func accept() -> Bool {
        guard !hint.isEmpty, let view else { return false }
        let rest = hint
        hide()
        line += rest
        view.send(txt: rest)
        return true
    }

    func hide() {
        hint = ""
        label.isHidden = true
    }

    func refresh() {
        hide()
        guard known, line.trimmingCharacters(in: .whitespaces).count >= 2, let view else { return }
        let pick = history.reversed().first { $0.hasPrefix(line) && $0.count > line.count }
            ?? snippets.first { $0.hasPrefix(line) && $0.count > line.count }
        guard let pick else { return }
        hint = String(pick.dropFirst(line.count))
        let state = view.terminalStateSnapshot()
        let cols = max(1, state.dimensions.cols), rows = max(1, state.dimensions.rows)
        let cellW = view.bounds.width / CGFloat(cols)
        let cellH = view.bounds.height / CGFloat(rows)
        let x = CGFloat(state.cursor.col) * cellW
        let rowTop = CGFloat(state.cursor.row) * cellH
        let y = view.isFlipped ? rowTop : view.bounds.height - rowTop - cellH
        label.font = view.font
        label.textColor = view.nativeForegroundColor
        label.stringValue = hint
        label.frame = NSRect(x: x, y: y, width: max(0, view.bounds.width - x), height: cellH)
        label.isHidden = false
    }

    /// The cursor row's text before what was typed (the prompt).
    private func promptText() -> String {
        guard let view else { return "" }
        let state = view.terminalStateSnapshot()
        let row = state.visibleRows.first { $0.row == state.cursor.row }?.text ?? ""
        let trimmed = row.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        return trimmed.hasSuffix(line) ? String(trimmed.dropLast(line.count)) : trimmed
    }
}
