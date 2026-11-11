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

/// <summary>
/// Updates the whole app (which carries the agent) in place: the newest
/// ubuntu-preview-N with the app zip, checked against SHA256SUMS.txt, is
/// unpacked next to the running copy and swapped in by a hidden helper after
/// the app quits. The app's own build N is in build.txt next to it.
/// </summary>
public static partial class AppUpdate
{
    public const string ZipAsset = "WECOMMANDER-Center-windows-x64.zip";
    public const string SumsAsset = "SHA256SUMS.txt";
    public const string Repo = "orhanbal/webrising-commender";

    [GeneratedRegex(@"^ubuntu-preview-(\d+)$")]
    private static partial Regex PreviewTag();

    public sealed record Release(int Build, string ZipUrl, string SumsUrl);

    /// <summary>This app's build (build.txt next to it), or null in a developer build.</summary>
    public static int? CurrentBuild(string? appDirectory = null)
    {
        try
        {
            var text = File.ReadAllText(Path.Combine(appDirectory ?? AppContext.BaseDirectory, "build.txt")).Trim();
            return int.TryParse(text, out var b) ? b : null;
        }
        catch (Exception) { return null; }
    }

    /// <summary>The newest release with the app zip and its checksums (download URLs from this repo only).</summary>
    public static Release? Latest(string releasesJson)
    {
        try
        {
            using var doc = JsonDocument.Parse(releasesJson);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
            Release? best = null;
            foreach (var release in doc.RootElement.EnumerateArray())
            {
                if (release.TryGetProperty("draft", out var draft) && draft.ValueKind == JsonValueKind.True) continue;
                var tag = release.TryGetProperty("tag_name", out var t) ? t.GetString() ?? "" : "";
                var m = PreviewTag().Match(tag);
                if (!m.Success || !int.TryParse(m.Groups[1].Value, out var build)) continue;
                if (!release.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array) continue;
                string? zip = null, sums = null;
                var prefix = $"https://github.com/{Repo}/releases/download/{tag}/";
                foreach (var a in assets.EnumerateArray())
                {
                    var name = a.TryGetProperty("name", out var n) ? n.GetString() : null;
                    var url = a.TryGetProperty("browser_download_url", out var u) ? u.GetString() : null;
                    if (url is null || !url.StartsWith(prefix, StringComparison.Ordinal)) continue;
                    if (name == ZipAsset) zip = url;
                    else if (name == SumsAsset) sums = url;
                }
                if (zip is not null && sums is not null && (best is null || build > best.Build)) best = new Release(build, zip, sums);
            }
            return best;
        }
        catch (JsonException) { return null; }
    }

    public static bool IsNewer(Release? latest, int? current) => latest is not null && current is { } c && latest.Build > c;

    /// <summary>The SHA-256 (lowercase hex) for <paramref name="asset"/> in a SHA256SUMS.txt, or null.</summary>
    public static string? ExpectedHash(string sums, string asset)
    {
        string? found = null;
        foreach (var raw in sums.Split('\n'))
        {
            var line = raw.Trim();
            var m = Regex.Match(line, @"^([a-fA-F0-9]{64})\s+\*?(.+)$");
            if (!m.Success || m.Groups[2].Value != asset) continue;
            if (found is not null) return null; // not unique
            found = m.Groups[1].Value.ToLowerInvariant();
        }
        return found;
    }

    /// <summary>
    /// The hidden helper (PowerShell, no window) that waits for the app to
    /// quit, swaps the new files in (keeping the old copy until the new one is
    /// in place) and starts the app again. It runs from the temp folder: a
    /// process whose current folder is inside the app folder would stop the
    /// swap (Windows does not rename a folder in use). When the swap does not
    /// happen, the reason goes to <paramref name="failFile"/>; the app shows
    /// it at its next start.
    /// </summary>
    public static string SwapScript(string appDir, string newDir, int appPid, string failFile, string exeName = "WecommanderCenter.exe")
    {
        static string Q(string s) => "'" + s.Replace("'", "''") + "'";
        var old = appDir.TrimEnd('\\') + ".old";
        return string.Join("\n",
            "$ErrorActionPreference='Stop'",
            "Set-Location -LiteralPath ([IO.Path]::GetTempPath())",
            $"$app={Q(appDir.TrimEnd('\\'))}; $new={Q(newDir)}; $old={Q(old)}; $fail={Q(failFile)}",
            $"try {{ Wait-Process -Id {appPid} -Timeout 30 -ErrorAction SilentlyContinue }} catch {{}}",
            // Everything still running from the app folder (agent, core, a second copy).
            "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($app + '\\',[StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force -ErrorAction SilentlyContinue",
            "Start-Sleep -Milliseconds 800",
            "if(Test-Path -LiteralPath $old){ Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }",
            "$moved=$false; $why=''",
            "for($i=0;$i -lt 30 -and -not $moved;$i++){ try { Rename-Item -LiteralPath $app -NewName (Split-Path $old -Leaf); $moved=$true } catch { $why=$_.Exception.Message; Start-Sleep -Seconds 1 } }",
            "if($moved){ try { Move-Item -LiteralPath $new -Destination $app; Remove-Item -LiteralPath $fail -Force -ErrorAction SilentlyContinue } catch { $why=$_.Exception.Message; Rename-Item -LiteralPath $old -NewName (Split-Path $app -Leaf); $moved=$false } }",
            "if(-not $moved){ New-Item -ItemType Directory -Force -Path (Split-Path $fail) | Out-Null; Set-Content -LiteralPath $fail -Value $why -Encoding UTF8 }",
            $"Start-Process -FilePath (Join-Path $app {Q(exeName)}) -WorkingDirectory $app -ArgumentList '--updated'",
            "if($moved){ Start-Sleep -Seconds 5; Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }");
    }
}
