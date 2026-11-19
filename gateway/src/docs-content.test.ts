import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.CONTROL_API_KEY ??= "test-control-key-0123456789-0123456789";
process.env.APPROVAL_SIGNING_SECRET ??= "test-approval-secret-0123456789-012345";

const { docGroups, docPages, toolReferenceNames } = await import("./docs-content.js");
const site = await import("./site-content.js");
const { listedTools } = await import("./mcp.js");

const origin = "https://wecommander.app";
const pageText = (page: (typeof docPages)[number]) => JSON.stringify(page);

test("every docs page has a unique /docs/<slug> path, a title, a description and a body", () => {
  const paths = new Set<string>();
  for (const page of docPages) {
    assert.match(page.path, /^\/docs\/[a-z0-9-]+$/, page.path);
    assert.ok(!paths.has(page.path), `duplicate ${page.path}`);
    paths.add(page.path);
    assert.ok(page.title.trim().length > 10 && page.title.endsWith("· WECOMMANDER Docs"), `${page.path}: title`);
    assert.ok(page.description.length >= 60 && page.description.length <= 320, `${page.path}: description length ${page.description.length}`);
    assert.ok(page.heading.trim() && page.intro.trim().length >= 60, `${page.path}: heading and intro`);
    assert.ok(page.blocks.length >= 2, `${page.path}: body`);
    assert.ok(page.content && page.section === "Docs", `${page.path}: content page in Docs`);
    assert.ok((docGroups as readonly string[]).includes(page.docGroup ?? ""), `${page.path}: group`);
  }
  for (const group of docGroups) assert.ok(docPages.some((p) => p.docGroup === group), `empty group ${group}`);
});

test("docs pages are public pages, web app routes, and in the /docs index", () => {
  const app = readFileSync(new URL("../ui/src/App.tsx", import.meta.url), "utf8");
  const routes: string[] = JSON.parse(app.match(/const contentPaths=(\[[^\]]*\]);/)![1]!);
  const index = site.pageByPath.get("/docs")!;
  const listed = index.blocks.flatMap((b) => ("see" in b ? b.see : []));
  for (const page of docPages) {
    assert.equal(site.pageByPath.get(page.path), page, `${page.path} not in publicPages`);
    assert.ok(site.contentPagePaths.includes(page.path), `${page.path} not a content page`);
    assert.ok(routes.includes(page.path), `${page.path} missing from contentPaths in ui/src/App.tsx`);
    assert.ok(listed.includes(page.path), `${page.path} missing from the /docs index`);
  }
});

test("every link in the docs points to an existing public page", () => {
  for (const page of [site.pageByPath.get("/docs")!, ...docPages]) {
    for (const block of page.blocks) {
      if ("see" in block) for (const path of block.see) assert.ok(site.pageByPath.has(path), `${page.path} links to unknown ${path}`);
    }
  }
});

test("the MCP tool reference lists every tool the gateway offers, and only those", () => {
  const offered = listedTools().map((t: { name: string }) => t.name).sort();
  const documented = [...toolReferenceNames].sort();
  assert.equal(new Set(documented).size, documented.length, "a tool is documented twice");
  assert.deepEqual(offered.filter((n: string) => !documented.includes(n)), [], "tools missing from /docs/mcp-tools");
  assert.deepEqual(documented.filter((n) => !offered.includes(n)), [], "documented tools the gateway does not offer");
  const reference = pageText(site.pageByPath.get("/docs/mcp-tools")!);
  for (const name of offered) assert.ok(reference.includes(`"${name}"`), `${name} not in the reference table`);
});

test("crawlers, JSON-LD, the sitemap and llms.txt carry every docs page", () => {
  const sitemap = site.sitemapXml(origin, "2026-11-19");
  const llms = site.llmsTxt(origin);
  const full = site.llmsFullTxt(origin);
  for (const page of docPages) {
    assert.ok(sitemap.includes(`<loc>${origin}${page.path}</loc>`), `${page.path} not in sitemap`);
    assert.ok(llms.includes(`(${origin}${page.path}): ${page.description}`), `${page.path} not in llms.txt`);
    assert.ok(full.includes(`URL: ${origin}${page.path}`) && full.includes(page.intro), `${page.path} not in llms-full.txt`);
    const html = site.renderPageHtml(page);
    assert.ok(html.includes(`<h1>`) && html.includes('href="/docs"'), `${page.path}: prerender`);
    const ld = JSON.parse(site.pageJsonLd(page, origin));
    const types = ld["@graph"].map((n: { "@type": string }) => n["@type"]);
    assert.ok(types.includes("TechArticle") && types.includes("BreadcrumbList"), `${page.path}: JSON-LD ${types}`);
  }
  assert.match(llms, /## Documentation \(A to Z\)/);
  const indexLd = JSON.parse(site.pageJsonLd(site.pageByPath.get("/docs")!, origin))["@graph"];
  assert.ok(indexLd.some((n: { "@type": string }) => n["@type"] === "ItemList"));
});

test("heading anchors are stable ids", () => {
  assert.equal(site.anchorId("1. Create your account"), "1-create-your-account");
  assert.equal(site.anchorId("Edges, floating and locking"), "edges-floating-and-locking");
  const html = site.renderPageHtml(site.pageByPath.get("/docs/getting-started")!);
  assert.ok(html.includes('<h2 id="what-you-need">'));
});
