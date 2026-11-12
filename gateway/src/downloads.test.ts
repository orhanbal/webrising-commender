import test from "node:test";
import assert from "node:assert/strict";
import { getDownloads } from "./downloads.js";

const base = "https://github.com/orhanbal/webrising-commender/releases";
const asset = (tag: string, name: string, url = `${base}/download/${tag}/${name}`) => ({ name, browser_download_url: url, size: 1234 });

test("download catalog lists the newest preview packages the apps update from", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify([
      { tag_name: "ubuntu-preview-1834", html_url: `${base}/tag/ubuntu-preview-1834`, draft: false, prerelease: true,
        assets: [asset("ubuntu-preview-1834", "WECOMMANDER-Center-windows-x64.zip")] },
      { tag_name: "ubuntu-preview-1835", html_url: `${base}/tag/ubuntu-preview-1835`, draft: false, prerelease: true,
        assets: [asset("ubuntu-preview-1835", "WECOMMANDER-Center-windows-x64.zip"),
          asset("ubuntu-preview-1835", "wecommander-agent_0.1.1835_amd64.deb"),
          asset("ubuntu-preview-1835", "evil.exe", "https://evil.example.com/evil.exe")] },
      { tag_name: "macos-preview-254", html_url: `${base}/tag/macos-preview-254`, draft: false, prerelease: true,
        assets: [asset("macos-preview-254", "WECOMMANDER-Center-macos.zip")] },
      { tag_name: "macos-preview-255", draft: true, assets: [asset("macos-preview-255", "WECOMMANDER-Center-macos.zip")] },
      { tag_name: "macos-preview-256", draft: false,
        assets: [{ name: "WECOMMANDER-Center-macos.zip", browser_download_url: "https://evil.example.com/x.zip", size: 1 }] },
    ]), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const data = await getDownloads();
    assert.equal(data.available, true);
    assert.equal(data.tagName, "ubuntu-preview-1835");
    assert.equal(data.releaseUrl, `${base}/tag/ubuntu-preview-1835`);
    assert.deepEqual(data.assets.map(a => [a.platform, a.url]), [
      ["windows", `${base}/download/ubuntu-preview-1835/WECOMMANDER-Center-windows-x64.zip`],
      ["macos", `${base}/download/macos-preview-254/WECOMMANDER-Center-macos.zip`],
      ["linux", `${base}/download/ubuntu-preview-1835/wecommander-agent_0.1.1835_amd64.deb`],
    ]);
    assert.equal((await getDownloads()).assets.length, 3);
    assert.equal(calls, 1, "download metadata must be cached");
  } finally { globalThis.fetch = original; }
});
