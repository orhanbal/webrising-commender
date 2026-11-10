using System.Text.Json;
using System.Text.RegularExpressions;

namespace Wecommander.Center.Core;

/// <summary>
/// Is a newer agent published? The "Ajanı güncelle" installer picks the newest
/// platform preview release (ubuntu-preview-N with the Windows setup), and the
/// agent it installs reports version 0.1.N, so N is compared directly.
/// </summary>
public static partial class AgentUpdate
{
    public const string ReleasesUrl = "https://api.github.com/repos/orhanbal/webrising-commender/releases?per_page=30";
    public const string WindowsAsset = "WECOMMANDER-Setup-windows-x64.exe";

    [GeneratedRegex(@"^ubuntu-preview-(\d+)$")]
    private static partial Regex PreviewTag();

    [GeneratedRegex(@"^\d+\.\d+\.(\d+)")]
    private static partial Regex VersionBuild();

    /// <summary>Newest build number with a Windows setup, or null.</summary>
    public static int? LatestWindowsBuild(string releasesJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(releasesJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
            int? best = null;
            foreach (var release in doc.RootElement.EnumerateArray())
            {
                if (release.TryGetProperty("draft", out var draft) && draft.ValueKind == JsonValueKind.True) continue;
                var tag = release.TryGetProperty("tag_name", out var t) ? t.GetString() ?? "" : "";
                var m = PreviewTag().Match(tag);
                if (!m.Success || !int.TryParse(m.Groups[1].Value, out var build)) continue;
                var hasSetup = release.TryGetProperty("assets", out var assets) && assets.ValueKind == JsonValueKind.Array
                    && assets.EnumerateArray().Any(a => a.TryGetProperty("name", out var n) && n.GetString() == WindowsAsset);
                if (hasSetup && (best is null || build > best)) best = build;
            }
            return best;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>"0.1.1725" -> 1725.</summary>
    public static int? Build(string? version)
    {
        var m = VersionBuild().Match(version ?? "");
        return m.Success && int.TryParse(m.Groups[1].Value, out var b) ? b : null;
    }

    public static bool IsNewer(int? latestBuild, string? installedVersion) =>
        latestBuild is { } latest && Build(installedVersion) is { } installed && latest > installed;
}
