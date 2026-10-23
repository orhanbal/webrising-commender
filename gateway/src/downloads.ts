/**
 * Sanitized, cached public GitHub release metadata for device downloads.
 * Never creates a download link for an asset that was not actually published.
 */
const releasesPage = "https://github.com/orhanbal/webrising-commender/releases";
const githubEndpoint = "https://api.github.com/repos/orhanbal/webrising-commender/releases/latest";
export type DownloadAsset = { name: string; size: number; url: string; platform: "windows" | "macos" | "linux" };
export type ReleaseInfo = { available: boolean; releaseUrl: string; tagName: string | null; assets: DownloadAsset[] };
const noRelease:ReleaseInfo = { available: false, releaseUrl: releasesPage, tagName: null, assets: [] };
let cache:{value:ReleaseInfo;expiresAt:number}|null = null;
const names:Record<string,DownloadAsset["platform"]>={
  "WECOMMANDER-windows-x64.exe":"windows",
  "WECOMMANDER-macos-universal":"macos",
  "WECOMMANDER-linux-x64":"linux",
};
export async function getDownloads():Promise<ReleaseInfo>{
  if(cache && cache.expiresAt>Date.now())return cache.value;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),4500);
  try{
    const response=await fetch(githubEndpoint,{
      headers:{"Accept":"application/vnd.github+json","User-Agent":"WECOMMANDER-Gateway"},
      signal:controller.signal,
    });
    if(!response.ok)return noRelease;
    const data=await response.json() as {
      tag_name?:unknown;html_url?:unknown;draft?:unknown;prerelease?:unknown;
      assets?:Array<{name?:unknown;browser_download_url?:unknown;size?:unknown}>;
    };
    if(data.draft===true || data.prerelease===true)return noRelease;
    const validAssets=(Array.isArray(data.assets)?data.assets:[])
      .filter(asset=>typeof asset.name==="string" && names[asset.name]!==undefined)
      .slice(0,8).flatMap(asset=>{
        if(typeof asset.browser_download_url!=="string")return [];
        const url=asset.browser_download_url;
        if(!url.startsWith("https://github.com/orhanbal/webrising-commender/releases/download/"))return [];
        return [{name:asset.name as string,url,
          size:typeof asset.size==="number"?Math.max(0,Math.trunc(asset.size)):0,
          platform:names[asset.name as string]!}];
      });
    const value:ReleaseInfo={
      available:validAssets.length>0,
      tagName:typeof data.tag_name==="string"?data.tag_name.slice(0,64):null,
      releaseUrl:typeof data.html_url==="string" &&
        data.html_url.startsWith(releasesPage+"/tag/")?data.html_url:releasesPage,
      assets:validAssets,
    };
    cache={value,expiresAt:Date.now()+10*60_000};
    return value;
  }catch{
    return noRelease;
  }finally{clearTimeout(timeout)}
}
