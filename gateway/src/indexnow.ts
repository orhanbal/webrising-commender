// IndexNow (https://www.indexnow.org): tells Bing (and Yandex, Seznam, Naver)
// that the public pages changed, right after a deploy, instead of waiting for
// the next crawl. ChatGPT's and Copilot's web search read Bing's index. The key
// is public by design (it is served at /<key>.txt to prove the site owns it).
import { createHash } from "node:crypto";
import { publicPages } from "./site-content.js";

/** The site's IndexNow key: stable per origin, 32 hex characters. */
export function indexNowKey(origin: string) {
  return createHash("sha256").update(`wecommander-indexnow:${origin}`).digest("hex").slice(0, 32);
}

/** The request body for api.indexnow.org: every public page of this origin. */
export function indexNowPayload(origin: string) {
  const host = new URL(origin).host;
  const key = indexNowKey(origin);
  return { host, key, keyLocation: `${origin}/${key}.txt`, urlList: publicPages.map((page) => `${origin}${page.path}`) };
}

/** Only the real public site announces itself (not local, preview or test gateways). */
export function shouldAnnounce(origin: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.INDEXNOW_DISABLED === "true") return false;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.)/.test(url.hostname) && !url.hostname.endsWith(".local")
      && (env.INDEXNOW_ENABLED === "true" || url.hostname === "wecommander.app");
  } catch { return false; }
}

/** Announces the public pages once; a failure is only logged (search engines crawl anyway). */
export async function announcePages(origin: string, fetcher: typeof fetch = fetch) {
  const body = indexNowPayload(origin);
  try {
    const response = await fetcher("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    process.stdout.write(`IndexNow: announced ${body.urlList.length} pages (${response.status})\n`);
    return response.status;
  } catch (error) {
    process.stdout.write(`IndexNow: not announced (${error instanceof Error ? error.message : String(error)})\n`);
    return 0;
  }
}
