import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Script } from "node:vm";

const html = readFileSync(new URL("../public/app.html", import.meta.url), "utf8");
const backend = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x=>x[1]);
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);

test("dashboard inline JavaScript compiles", () => {
  assert.equal(scripts.length, 1, "Single self-hosted dashboard script expected");
  assert.doesNotThrow(() => new Script(scripts[0], { filename: "app.html" }));
});

test("each element id is unique and JS bindings target real elements", () => {
  assert.equal(new Set(ids).size, ids.length, "Duplicate HTML id");
  const bindings = [...scripts[0].matchAll(/\$\("([^"]+)"\)/g)].map(x=>x[1]);
  assert.deepEqual([...new Set(bindings)].filter(x=>!ids.includes(x)), []);
});

test("reference dashboard sections and all nine destinations exist", () => {
  for (const key of ["dashboard","devices","terminal","files","tasks","mcp","usage","billing","settings"]) {
    assert.match(html, new RegExp('data-page-target="'+key+'"'), key);
  }
  for (const id of [
    "wcDashboardTitle","wcSignInPrompt","wcDeviceCount","wcTaskCount",
    "wcStorageValue","wcUptimeValue","wcDashDevices","wcDashActivity",
    "wcDashChart","wcDashChartLabels","wcDashUsage","wcDashPlan",
    "wcChartRange","wcGlobalSearch","wcSearchResults","wcProfileButton",
    "wcNotificationsButton","wcMobileMenu","wcMobileBackdrop",
  ])assert.ok(ids.includes(id), id);
});

test("UI uses API-backed metrics, no fabricated screenshot values", () => {
  assert.match(scripts[0], /api\("\/api\/devices"\)/);
  assert.match(scripts[0], /api\("\/api\/usage"\)/);
  assert.match(scripts[0], /api\("\/api\/billing"\)/);
  assert.match(scripts[0], /api\("\/api\/activity\?limit=8"\)/);
  assert.doesNotMatch(html, /12\.4 GB|99\.8%|Venture-Windows|MacBook-Pro/);
});

test("official light/dark wordmarks and favicon are intact and integrated", () => {
  const assets=["wecommander-white.svg","wecommander-black.svg","wecommander-favicon.svg"];
  for(const asset of assets){
    const svg=readFileSync(new URL("../public/assets/"+asset,import.meta.url),"utf8");
    assert.match(svg,/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /viewBox="[0-9 ]+"/);
    assert.doesNotMatch(svg, /<script|<!DOCTYPE|<foreignObject|xlink:href/i);
    assert.match(html,new RegExp(asset.replace(".","\\.")));
  }
  assert.match(html,/class="wc-brand-white"/);
  assert.match(html,/class="wc-brand-black"/);
  assert.match(html,/body\.light \.wc-brand \.wc-brand-white\{display:none!important\}/);
  const landing=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
  assert.equal((landing.match(/class="brand-wordmark"/g)||[]).length,2);
  assert.match(landing,/class="center-brand-icon"/);
  assert.match(landing,/href="\/assets\/wecommander-favicon\.svg"/);
});

test("server provides real daily, monthly, operations and safe activity feeds", () => {
  for (const key of ["daily: daily.rows.map","topTools: topTools.rows.map","/api/activity","viewer"]) {
    assert.ok(backend.includes(key), key);
  }
  assert.match(backend, /select a\.tool,a\.outcome,a\.created_at,a\.device_id,d\.name as device_name/);
  assert.doesNotMatch(backend.slice(backend.indexOf('url.pathname === "/api/activity"'),backend.indexOf('url.pathname === "/api/audit"')),/a\.detail|a\.actor/);
});
