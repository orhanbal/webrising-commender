import Foundation
import XCTest
@testable import CenterCore

/// Every text of the app in every language: the tables cover each L.t / L.f
/// key in the sources, keep its placeholders and spacing, and no Turkish
/// text is left outside L.t / L.f.
final class LocalizationTests: XCTestCase {
    override func tearDown() { L.use("tr") }

    private static let translated = L.languages.map(\.code).filter { $0 != "tr" }

    private static var sources: [(file: String, text: String)] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources")
        let files = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" && !["LStrings.swift", "L.swift", "ReleaseNotesData.swift"].contains($0.lastPathComponent) } ?? []
        return files.map { ($0.lastPathComponent, (try? String(contentsOf: $0, encoding: .utf8)) ?? "") }
    }

    /// Swift literal body → the runtime string it stands for.
    private static func unescape(_ body: String) -> String {
        var out = "", escaped = false
        for c in body {
            if escaped {
                switch c { case "n": out.append("\n"); case "t": out.append("\t"); default: out.append(c) }
                escaped = false
            } else if c == "\\" { escaped = true } else { out.append(c) }
        }
        return out
    }

    private static func matches(_ pattern: String, _ text: String) -> [[String]] {
        let re = try! NSRegularExpression(pattern: pattern)
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { m in
            (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: text).map { String(text[$0]) } ?? "" }
        }
    }

    private static var keys: Set<String> {
        var keys: Set<String> = ["Onaylar", "Otonom mod", "Cihazlar", "Ayarlar"] // tab raw values
        for (_, text) in sources {
            for m in matches(#"\bL\.[tf]\(\s*"((?:[^"\\\n]|\\.)*)""#, text) { keys.insert(unescape(m[1])) }
        }
        return keys
    }

    private static func placeholders(_ s: String) -> [String] {
        matches(#"(?<!\{)\{\d+\}(?!\})"#, s).map { $0[0] }.sorted()
    }

    func testEveryTextIsTranslatedWithItsPlaceholders() {
        let keys = Self.keys
        XCTAssertGreaterThan(keys.count, 300)
        for code in Self.translated {
            let table = L.table(code)
            XCTAssertFalse(table.isEmpty, code)
            for key in keys {
                guard let value = table[key] else { XCTFail("\(code): missing \(key)"); continue }
                XCTAssertFalse(value.trimmingCharacters(in: .whitespaces).isEmpty && !key.trimmingCharacters(in: .whitespaces).isEmpty, "\(code): empty \(key)")
                XCTAssertEqual(Self.placeholders(value), Self.placeholders(key), "\(code): placeholders of \(key)")
                XCTAssertEqual(value.hasPrefix(" "), key.hasPrefix(" "), "\(code): leading space of \(key)")
                XCTAssertEqual(value.hasSuffix(" "), key.hasSuffix(" "), "\(code): trailing space of \(key)")
            }
        }
    }

    func testNoTurkishTextOutsideTranslation() {
        let turkish = try! NSRegularExpression(pattern: "[çğıöşüÇĞİÖŞÜ]")
        // "şifre": matched against what a server prints, never shown.
        // The Keychain item label is stored data and stays the same.
        let allowed: Set<String> = ["şifre", "WECOMMANDER Yönetim Merkezi"]
        var left: [String] = []
        for (file, text) in Self.sources {
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                let code = line.trimmingCharacters(in: .whitespaces)
                if code.hasPrefix("//") || code.hasPrefix("///") { continue }
                let stripped = Self.matches(#"\bL\.[tf]\(\s*"((?:[^"\\\n]|\\.)*)""#, String(line))
                    .reduce(String(line)) { $0.replacingOccurrences(of: $1[0], with: "L.t(\"\"") }
                for m in Self.matches(#""((?:[^"\\\n]|\\.)*)""#, stripped) {
                    let body = m[1]
                    if allowed.contains(body) { continue }
                    if turkish.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)) != nil {
                        left.append("\(file): \(body)")
                    }
                }
            }
        }
        XCTAssertEqual(left, [], "Turkish text outside L.t / L.f")
    }

    func testLanguageResolution() {
        XCTAssertEqual(L.resolve(nil, preferred: ["de-AT", "en"]), "de")
        XCTAssertEqual(L.resolve("system", preferred: ["pt-PT"]), "pt-BR")
        XCTAssertEqual(L.resolve(nil, preferred: ["ja-JP", "ko"]), "en")
        XCTAssertEqual(L.resolve("fr", preferred: ["de"]), "fr")
        XCTAssertEqual(L.resolve("xx", preferred: ["tr-TR"]), "tr")
        XCTAssertEqual(L.match("es_MX"), "es")
        XCTAssertNil(L.match(""))
    }

    func testSwitchingLanguageWithoutRestart() {
        L.use("tr")
        XCTAssertEqual(L.t("Ayarlar"), "Ayarlar")
        L.use("de")
        XCTAssertEqual(L.current, "de")
        XCTAssertNotEqual(L.t("Ayarlar"), "Ayarlar")
        XCTAssertEqual(L.t("not a key"), "not a key")
        L.use("en")
        XCTAssertEqual(L.t("Ayarlar"), "Settings")
        XCTAssertEqual(L.f("Sürüm {0}{1} · {2}", "1.0", "", "x").hasPrefix("Version 1.0"), true)
        L.use("tr")
        XCTAssertEqual(Texts.remaining(Date().addingTimeInterval(45.4), now: Date()), "45 sn")
    }

    func testFill() {
        XCTAssertEqual(L.fill("{0} · {1}", ["a", 2]), "a · 2")
        XCTAssertEqual(L.fill("{{0}} {0}", ["x"]), "{0} x")
        XCTAssertEqual(L.fill("{3}", ["x"]), "{3}")
        XCTAssertEqual(L.inLanguage("tr", "Ayarlar"), "Ayarlar")
        XCTAssertEqual(L.inLanguage("en", "Ayarlar"), "Settings")
    }
}
