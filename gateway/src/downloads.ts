/**
 * Sanitized, cached public GitHub release metadata for device downloads.
 * Never creates a download link for an asset that was not actually published.
 *
 * The apps update from the newest `ubuntu-preview-N` (Windows app, Linux
 * agent) and `macos-preview-N` (Mac app) releases, so the download page
 * lists the same packages from the same releases.
 */
const releasesPage = "https://github.com/orhanbal/webrising-commender/releases";
const githubEndpoint = "https://api.github.com/repos/orhanbal/webrising-commender/releases?per_page=40";
export type DownloadAsset = { name: string; size: number; url: string; platform: "windows" | "macos" | "linux" };
export type ReleaseInfo = { available: boolean; releaseUrl: string; tagName: string | null; assets: DownloadAsset[] };
const noRelease: ReleaseInfo = { available: false, releaseUrl: releasesPage, tagName: null, assets: [] };
let cache: { value: ReleaseInfo; expiresAt: number } | null = null;

type Release = {
  tag_name?: unknown; html_url?: unknown; draft?: unknown;
  assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>;
};
/** Which release series carries each platform's package, and its file name. */
const sources: Array<{ platform: DownloadAsset["platform"]; tag: RegExp; asset: RegExp }> = [
  { platform: "windows", tag: /^ubuntu-preview-(\d+)$/, asset: /^WECOMMANDER-Center-windows-x64\.zip$/ },
  { platform: "macos", tag: /^macos-preview-(\d+)$/, asset: /^WECOMMANDER-Center-macos\.zip$/ },
  { platform: "linux", tag: /^ubuntu-preview-(\d+)$/, asset: /^wecommander-agent_[0-9.]+_amd64\.deb$/ },
];

function pick(releases: Release[], source: (typeof sources)[number]): { release: Release; asset: DownloadAsset } | null {
  let best: { build: number; release: Release; asset: DownloadAsset } | null = null;
  for (const release of releases) {
    if (release.draft === true || typeof release.tag_name !== "string") continue;
    const match = source.tag.exec(release.tag_name);
    if (!match) continue;
    const build = Number(match[1]);
    if (best && build <= best.build) continue;
    const found = (Array.isArray(release.assets) ? release.assets : []).find(a =>
      typeof a.name === "string" && source.asset.test(a.name) &&
      typeof a.browser_download_url === "string" &&
      a.browser_download_url.startsWith(`${releasesPage}/download/${release.tag_name}/`));
    if (!found) continue;
    best = {
      build, release,
      asset: {
        name: found.name as string, url: found.browser_download_url as string, platform: source.platform,
        size: typeof found.size === "number" ? Math.max(0, Math.trunc(found.size)) : 0,
      },
    };
  }
  return best && { release: best.release, asset: best.asset };
}

export async function getDownloads(): Promise<ReleaseInfo> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  try {
    const response = await fetch(githubEndpoint, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "WECOMMANDER-Gateway" },
      signal: controller.signal,
    });
    if (!response.ok) { cache = { value: noRelease, expiresAt: Date.now() + 5 * 60_000 }; return noRelease; }
    const data = await response.json() as unknown;
    const releases = Array.isArray(data) ? data as Release[] : [];
    const picked = sources.map(s => pick(releases, s)).filter(p => p !== null);
    const windows = picked.find(p => p.asset.platform === "windows") ?? picked[0];
    const tag = typeof windows?.release.tag_name === "string" ? windows.release.tag_name.slice(0, 64) : null;
    const html = windows?.release.html_url;
    const value: ReleaseInfo = {
      available: picked.length > 0,
      tagName: tag,
      releaseUrl: typeof html === "string" && html.startsWith(releasesPage + "/tag/") ? html : releasesPage,
      assets: picked.map(p => p.asset),
    };
    cache = { value, expiresAt: Date.now() + 10 * 60_000 };
    return value;
  } catch {
    cache = { value: noRelease, expiresAt: Date.now() + 60_000 };
    return noRelease;
  } finally { clearTimeout(timeout); }
}
