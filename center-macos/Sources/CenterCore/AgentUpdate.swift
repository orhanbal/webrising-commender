import Foundation

/// Is a newer agent published? "Ajanı güncelle" installs the newest
/// macos-preview-N release with the universal PKG, whose agent reports
/// version 0.1.N, so N is compared directly.
public enum AgentUpdate {
    public static let releasesURL = URL(string: "https://api.github.com/repos/orhanbal/webrising-commender/releases?per_page=30")!
    public static let macAsset = "WECOMMANDER-macos-universal.pkg"

    public static func latestMacBuild(_ json: Data) -> Int? {
        guard let releases = (try? JSONSerialization.jsonObject(with: json)) as? [[String: Any]] else { return nil }
        var best: Int?
        for release in releases {
            if release["draft"] as? Bool == true { continue }
            guard let tag = release["tag_name"] as? String, tag.hasPrefix("macos-preview-"),
                  let build = Int(tag.dropFirst("macos-preview-".count)) else { continue }
            let assets = release["assets"] as? [[String: Any]] ?? []
            guard assets.contains(where: { $0["name"] as? String == macAsset }) else { continue }
            if best == nil || build > best! { best = build }
        }
        return best
    }

    /// "0.1.1725" -> 1725.
    public static func build(_ version: String?) -> Int? {
        guard let parts = version?.split(separator: "."), parts.count >= 3 else { return nil }
        return Int(parts[2].prefix { $0.isNumber })
    }

    public static func isNewer(_ latest: Int?, than installed: String?) -> Bool {
        guard let latest, let current = build(installed) else { return false }
        return latest > current
    }
}
