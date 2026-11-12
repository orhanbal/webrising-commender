import AppKit
import SwiftTerm

/// Terminal colour themes, the same names and colours as the Windows app.
struct TerminalTheme: Identifiable {
    let id: String
    let name: String
    let background: String
    let foreground: String
    let cursor: String
    /// The 16 ANSI colours; empty keeps SwiftTerm's defaults.
    let palette: [String]

    static let all: [TerminalTheme] = [
        TerminalTheme(id: "dark", name: "Koyu", background: "#0c0c0c", foreground: "#cccccc", cursor: "#60cdff",
                      palette: []),
        TerminalTheme(id: "light", name: "Açık", background: "#fafafa", foreground: "#1e1e1e", cursor: "#005fb8",
                      palette: ["#000000", "#cd3131", "#107c10", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555", "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"]),
        TerminalTheme(id: "solarized-dark", name: "Solarized koyu", background: "#002b36", foreground: "#839496", cursor: "#93a1a1",
                      palette: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
        TerminalTheme(id: "solarized-light", name: "Solarized açık", background: "#fdf6e3", foreground: "#657b83", cursor: "#586e75",
                      palette: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"]),
        TerminalTheme(id: "nord", name: "Nord", background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9",
                      palette: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]),
        TerminalTheme(id: "gruvbox", name: "Gruvbox", background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2",
                      palette: ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]),
        TerminalTheme(id: "monokai", name: "Monokai", background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0",
                      palette: ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"]),
        TerminalTheme(id: "dracula", name: "Dracula", background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2",
                      palette: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"]),
    ]

    static func named(_ id: String) -> TerminalTheme { all.first { $0.id == id } ?? all[0] }

    func apply(to view: TerminalView) {
        view.nativeBackgroundColor = Self.nsColor(background)
        view.nativeForegroundColor = Self.nsColor(foreground)
        view.caretColor = Self.nsColor(cursor)
        if palette.count == 16 { view.installColors(palette.map(Self.termColor)) }
    }

    private static func rgb(_ hex: String) -> (UInt16, UInt16, UInt16) {
        let v = UInt32(hex.dropFirst(), radix: 16) ?? 0
        return (UInt16((v >> 16) & 0xff), UInt16((v >> 8) & 0xff), UInt16(v & 0xff))
    }

    static func nsColor(_ hex: String) -> NSColor {
        let (r, g, b) = rgb(hex)
        return NSColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
    }

    static func termColor(_ hex: String) -> SwiftTerm.Color {
        let (r, g, b) = rgb(hex)
        return SwiftTerm.Color(red: r * 257, green: g * 257, blue: b * 257)
    }
}
