import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { PgSearchPersistence } from "../dist/search-persistence.js";
import fs from "node:fs/promises";
import pg from "pg";
import WebSocket from "ws";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8787";
const apiKey = process.env.CONTROL_API_KEY;
if (!apiKey) throw new Error("CONTROL_API_KEY is required");

const authHeaders = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
};

const appResponse = await fetch(base + "/app");
assert.equal(appResponse.status, 200);
const appHtml = await appResponse.text();
assert.match(appHtml, /WECOMMANDER/);
assert.ok(appHtml.includes('id="root"'),"Modern /app must deliver the React shell");
assert.match(appHtml, /\/modern\/assets\/index-[^"]+\.js/);
// Discovery for search engines and AI assistants: robots, sitemap, llms.txt,
// and public pages readable without JavaScript, with per-page metadata.
const robots = await (await fetch(base + "/robots.txt")).text();
assert.match(robots, /User-agent: GPTBot\nAllow: \//);
assert.match(robots, /User-agent: ClaudeBot/);
assert.match(robots, /Disallow: \/dashboard/);
assert.match(robots, /Sitemap: http:\/\/127\.0\.0\.1:8787\/sitemap\.xml/);
const sitemap = await fetch(base + "/sitemap.xml");
assert.match(sitemap.headers.get("content-type"), /application\/xml/);
const sitemapText = await sitemap.text();
for (const pagePath of ["/", "/faq", "/alternatives", "/docs", "/guides/claude-server-terminal"]) {
  assert.ok(sitemapText.includes(`<loc>http://127.0.0.1:8787${pagePath}</loc>`), `sitemap lists ${pagePath}`);
}
assert.ok(!sitemapText.includes("/dashboard"), "account pages are not in the sitemap");
const llms = await (await fetch(base + "/llms.txt")).text();
assert.match(llms, /^# WECOMMANDER\n\n> /);
assert.match(llms, /\(http:\/\/127\.0\.0\.1:8787\/faq\)/);
assert.match(await (await fetch(base + "/llms-full.txt")).text(), /## Frequently asked questions/);
const faqHtml = await (await fetch(base + "/faq")).text();
assert.match(faqHtml, /<title>FAQ · WECOMMANDER<\/title>/);
assert.match(faqHtml, /<link rel="canonical" href="http:\/\/127\.0\.0\.1:8787\/faq">/);
assert.match(faqHtml, /"@type":"FAQPage"/);
assert.match(faqHtml, /<div id="root"><main class="prerender"><h1>Frequently asked questions<\/h1>/);
const alternativesHtml = await (await fetch(base + "/alternatives")).text();
assert.match(alternativesHtml, /<table>/);
const faqJson = await jsonFetch("/api/public/pages?path=%2Ffaq");
assert.equal(faqJson.page.heading, "Frequently asked questions");
assert.ok(faqJson.related.some((p) => p.path === "/alternatives"));
assert.equal((await fetch(base + "/api/public/pages?path=%2Fdashboard")).status, 404);
const dashboardHtml = await (await fetch(base + "/dashboard")).text();
assert.match(dashboardHtml, /<meta name="robots" content="noindex,nofollow">/);
assert.ok(dashboardHtml.includes('<div id="root"></div>'), "account pages carry no pre-rendered text");

// Built assets: content-hashed names, cached for a year, sent compressed.
const mainAsset = appHtml.match(/\/modern\/assets\/index-[^"]+\.js/)[0];
const assetResponse = await fetch(base + mainAsset, { headers: { "Accept-Encoding": "br, gzip" } });
assert.equal(assetResponse.status, 200);
assert.equal(assetResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");
assert.equal(assetResponse.headers.get("content-encoding"), "br");
assert.ok((await assetResponse.text()).length > 1000, "compressed asset decodes to the bundle");
const plainAsset = await fetch(base + mainAsset, { headers: { "Accept-Encoding": "identity" } });
assert.equal(plainAsset.headers.get("content-encoding"), null);
await plainAsset.arrayBuffer();
// The legacy /advanced console is retired; old links redirect to the React pages.
for (const [path, target] of [["/advanced", "/dashboard"], ["/advanced?view=approvals", "/approvals"], ["/advanced?view=access", "/team"], ["/advanced?view=audit", "/audit"], ["/advanced?view=files", "/files"]]) {
  const legacy = await fetch(base + path, { redirect: "manual" });
  assert.equal(legacy.status, 302, path);
  assert.equal(legacy.headers.get("location"), target, path);
}

for (const name of ["wecommander-white.svg","wecommander-black.svg","wecommander-favicon.svg"]) {
  const asset = await fetch(base + "/assets/" + name);
  assert.equal(asset.status, 200);
  assert.ok((asset.headers.get("content-type")||"").includes("image/svg+xml"));
  const source = await asset.text();
  assert.ok(source.includes("viewBox="));
}
assert.ok(appHtml.includes("/api/public/brand/favicon"), "App must use configurable favicon");
const landingAssetCheck = await fetch(base + "/");
assert.equal(landingAssetCheck.status, 200);
const landingAssetMarkup = await landingAssetCheck.text();
assert.ok(landingAssetMarkup.includes('id="root"'));
assert.ok(landingAssetMarkup.includes("/api/public/brand/favicon"));
assert.ok(landingAssetMarkup.includes('rel="canonical"'),"Landing needs canonical metadata before CMS publishes");
assert.ok(landingAssetMarkup.includes('property="og:title"'),"Landing needs Open Graph defaults");
assert.match(landingAssetMarkup, /\/modern\/assets\/index-[^"]+\.js/);
const publicFavicon=await fetch(base+"/api/public/brand/favicon",{redirect:"manual"});
assert.ok([200,302].includes(publicFavicon.status),"Branded favicon endpoint must serve an image or fallback");
const consoleNoSession=await fetch(base+"/api/console/me");
assert.equal(consoleNoSession.status,401,"Super admin endpoint requires authentication");
const consoleControlToken=await fetch(base+"/api/console/me",{headers:authHeaders});
assert.equal(consoleControlToken.status,403,"Control API key must not grant human platform admin privileges");
const installResponse=await fetch(base+"/install");
assert.equal(installResponse.status,200,"Install route must be publicly accessible");
const installHtml=await installResponse.text();
assert.ok(installHtml.includes('id="root"'),"Install route must load the React app");
assert.match(installHtml,/\/modern\/assets\/index-[^"]+\.js/);
const publishedAgents=await jsonFetch("/api/public/downloads");
assert.equal(typeof publishedAgents.available,"boolean");
assert.equal(Array.isArray(publishedAgents.assets),true);
assert.ok(publishedAgents.assets.every(asset=>
  asset.url.startsWith("https://github.com/orhanbal/webrising-commender/releases/download/")
),"Download links must always point to verified project release assets");
const publicPlans=await jsonFetch("/api/public/plans");
assert.equal(publicPlans.mode,"saas");
assert.equal(typeof publicPlans.paddle.checkoutEnabled,"boolean");
assert.equal(Array.isArray(publicPlans.plans),true);
const missingPaddle=await fetch(base+"/api/billing/paddle/checkout",{
 method:"POST",
 headers:{"Content-Type":"application/json"}
});
assert.equal(missingPaddle.status,401,"Checkout requires login");

const smtpCapture = process.env.SMTP_TEST_OUTPUT || "/tmp/commender-smtp.jsonl";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const { Client, Pool } = pg;
const acceptanceDb = new Client({ connectionString: databaseUrl });
await acceptanceDb.connect();

async function jsonFetch(path, options = {}) {
  const response = await fetch(base + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function rpc(id, method, params = undefined) {
  return jsonFetch("/mcp", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
}

async function rpcAs(headers, id, method, params = undefined) {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`POST /mcp -> ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

function toolText(response) {
  const text = response?.result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition timeout; last=${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function smtpMessages() {
  const raw = await fs.readFile(smtpCapture, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForMail(pattern, timeoutMs = 8000) {
  return waitFor(async () => {
    const messages = await smtpMessages();
    return messages.find((message) => pattern.test(message.data)) || null;
  }, timeoutMs, 100);
}

async function assignSubscription(organizationId, planKey = "ci-standard", status = "active") {
  return jsonFetch(`/api/admin/organizations/${organizationId}/subscription`, {
    method: "PUT",
    headers: authHeaders,
    body: JSON.stringify({
      planKey,
      status,
      cancelAtPeriodEnd: false,
    }),
  });
}

const health = await jsonFetch("/health");
assert.equal(health.status, "ok");
assert.match(health.build?.commit ?? "", /^(unknown|[0-9a-f]{40})$/);

// One-line install: dispatcher bound to PUBLIC_BASE_URL, platform scripts served as text.
{
  const installer = await fetch(base + "/install.sh");
  assert.equal(installer.status, 200);
  assert.match(installer.headers.get("content-type"), /^text\/plain/);
  assert.equal(installer.headers.get("x-content-type-options"), "nosniff");
  const body = await installer.text();
  assert.match(body, /^#!\/bin\/sh/);
  assert.ok(body.includes(`BASE='${new URL(process.env.PUBLIC_BASE_URL || base).origin}'`), "dispatcher uses the gateway origin");
  for (const route of ["/install/ubuntu.sh", "/install/macos.sh", "/install.ps1", "/install/agent.ps1"]) {
    const r = await fetch(base + route);
    assert.equal(r.status, 200, route);
    assert.ok((await r.text()).length > 500, route);
  }
  const cmd = await fetch(base + "/install/WECOMMANDER-Kur.cmd");
  assert.equal(cmd.status, 200);
  assert.match(cmd.headers.get("content-disposition") || "", /attachment; filename="WECOMMANDER-Kur\.cmd"/);
  assert.match(await cmd.text(), /install\.ps1' \| iex/);
}

const publicConfig = await jsonFetch("/api/public/config");
assert.equal(publicConfig.deploymentMode, "saas");
assert.equal(publicConfig.signupEnabled, true);
assert.equal(publicConfig.passwordResetEnabled, true);

const standardPlan = await jsonFetch("/api/admin/billing/plans", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    key: "ci-standard",
    name: "CI Standard",
    maxDevices: 20,
    maxMembers: 20,
    maxApiTokens: 20,
    metadata: { fixture: true },
    active: true,
  }),
});
assert.equal(standardPlan.item.key, "ci-standard");

const initialOrganizations = await jsonFetch("/api/organizations", { headers: authHeaders });
assert.ok(initialOrganizations.items.length > 0);
const defaultOrganization = initialOrganizations.items[0];
await assignSubscription(defaultOrganization.id);

const initialBilling = await jsonFetch(
  `/api/admin/organizations/${defaultOrganization.id}/billing`,
  { headers: authHeaders },
);
assert.equal(initialBilling.mode, "saas");
assert.equal(initialBilling.entitled, true);
assert.equal(initialBilling.plan.key, "ci-standard");
assert.equal(initialBilling.usage.devices, 0);

const signupResponse = await fetch(base + "/api/auth/signup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "signup@example.test",
    password: "signup-initial-password",
    workspaceName: "Signup Workspace",
  }),
});
assert.equal(signupResponse.status, 202);
assert.equal((await signupResponse.json()).ok, true);
// The form no longer asks for a workspace name: it comes from the e-mail address.
const namelessSignup = await fetch(base + "/api/auth/signup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "jane.doe+test@example.test", password: "nameless-signup-password" }),
});
assert.equal(namelessSignup.status, 202);
await namelessSignup.text();
assert.equal((await acceptanceDb.query(
  "select workspace_name from pending_signups where lower(email)='jane.doe+test@example.test'",
)).rows[0].workspace_name, "jane.doe test");

const signupLoginBeforeVerify = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "signup@example.test",
    password: "signup-initial-password",
  }),
});
assert.equal(signupLoginBeforeVerify.status, 401);

const verificationMail = await waitForMail(/#verify=wrsv_/);
const verificationMatch = verificationMail.data.match(/#verify=(wrsv_[A-Za-z0-9_-]+)/);
assert.ok(verificationMatch);
const verificationToken = verificationMatch[1];

const encryptedOutbox = await acceptanceDb.query(
  `select recipient_hash,payload_ciphertext,payload_nonce,payload_tag
     from mail_outbox
    order by id asc
    limit 1`,
);
assert.equal(encryptedOutbox.rowCount, 1);
assert.notEqual(encryptedOutbox.rows[0].recipient_hash, "signup@example.test");
assert.equal(
  encryptedOutbox.rows[0].payload_ciphertext.includes("signup@example.test"),
  false,
);
assert.ok(encryptedOutbox.rows[0].payload_nonce);
assert.ok(encryptedOutbox.rows[0].payload_tag);

// SMTP capture can become visible before the worker commits sent_at in PostgreSQL.
// Wait for the durable state instead of racing the asynchronous mail worker.
const outboxStatus = await waitFor(async () => {
  const status = await jsonFetch("/api/admin/mail/outbox?limit=10", {
    headers: authHeaders,
  });
  return status.configured && status.counts.sent >= 1 ? status : null;
}, 8000, 100);
assert.equal(outboxStatus.configured, true);
assert.ok(outboxStatus.counts.sent >= 1);
assert.equal("recipient_hash" in outboxStatus.items[0], false);
assert.equal("payload_ciphertext" in outboxStatus.items[0], false);

const invalidOutboxLimit = await jsonFetch("/api/admin/mail/outbox?limit=not-a-number", {
  headers: authHeaders,
});
assert.ok(Array.isArray(invalidOutboxLimit.items));

const wrongVerificationPassword = await fetch(base + "/api/auth/signup/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: verificationToken,
    password: "wrong-signup-password",
  }),
});
assert.equal(wrongVerificationPassword.status, 401);

const verifySignupResponse = await fetch(base + "/api/auth/signup/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: verificationToken,
    password: "signup-initial-password",
  }),
});
assert.equal(verifySignupResponse.status, 200);
const verifiedSignup = await verifySignupResponse.json();
assert.equal(verifiedSignup.email, "signup@example.test");
assert.equal(verifiedSignup.role, "owner");
const signupCookies = verifySignupResponse.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");

const verifyReplay = await fetch(base + "/api/auth/signup/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: verificationToken,
    password: "signup-initial-password",
  }),
});
assert.equal(verifyReplay.status, 400);
assert.equal((await verifyReplay.json()).error, "invalid_or_expired_verification");

const verifiedSignupMe = await fetch(base + "/api/auth/me", {
  headers: { Cookie: signupCookies },
});
assert.equal(verifiedSignupMe.status, 200);
assert.equal((await verifiedSignupMe.json()).email, "signup@example.test");

const signupBilling = await fetch(base + "/api/billing", {
  headers: { Cookie: signupCookies },
});
assert.equal(signupBilling.status, 200);
const signupBillingBody = await signupBilling.json();
// SaaS: the plan catalog gives every new workspace the free plan.
assert.equal(signupBillingBody.entitled, true, "a new SaaS workspace starts on the free plan");
assert.equal(signupBillingBody.plan.key, "free");
assert.equal(signupBillingBody.limits.maxDevices, 1);
assert.equal(signupBillingBody.subscription, null);
const catalog = await jsonFetch("/api/public/plans");
for (const key of ["free", "pro", "team"]) assert.ok(catalog.plans.some((plan) => plan.key === key), "catalog plan " + key);
assert.equal(catalog.plans.find((plan) => plan.key === "free").free, true);
assert.equal(catalog.plans.find((plan) => plan.key === "pro").featured, true);
assert.equal(catalog.plans.find((plan) => plan.key === "pro").priceId, null, "no price ID until PADDLE_PRICE_PRO is set");
const freeUsage = await (await fetch(base + "/api/usage", { headers: { Cookie: signupCookies } })).json();
assert.equal(freeUsage.limit, 5000, "the free plan has a monthly tool-call quota");
// The rest of this suite checks paid-plan enforcement without a free tier.
await acceptanceDb.query("update billing_plans set active=false where key='free'");
const signupBillingNoFree = await (await fetch(base + "/api/billing", { headers: { Cookie: signupCookies } })).json();
assert.equal(signupBillingNoFree.entitled, false);
assert.equal(signupBillingNoFree.reason, "billing_required");

const unknownResetRequest = await fetch(base + "/api/auth/password-reset/request", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "does-not-exist@example.test" }),
});
assert.equal(unknownResetRequest.status, 202);
assert.equal((await unknownResetRequest.json()).ok, true);

const resetRequest = await fetch(base + "/api/auth/password-reset/request", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "signup@example.test" }),
});
assert.equal(resetRequest.status, 202);

const resetMail = await waitForMail(/#reset=wrrp_/);
const resetMatch = resetMail.data.match(/#reset=(wrrp_[A-Za-z0-9_-]+)/);
assert.ok(resetMatch);
const resetToken = resetMatch[1];

const resetConfirm = await fetch(base + "/api/auth/password-reset/confirm", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: resetToken,
    newPassword: "signup-replaced-password",
  }),
});
assert.equal(resetConfirm.status, 200);
assert.equal((await resetConfirm.json()).ok, true);

const resetReplay = await fetch(base + "/api/auth/password-reset/confirm", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: resetToken,
    newPassword: "signup-third-password",
  }),
});
assert.equal(resetReplay.status, 400);

const revokedSignupSession = await fetch(base + "/api/auth/me", {
  headers: { Cookie: signupCookies },
});
assert.equal(revokedSignupSession.status, 401);

const oldSignupPassword = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "signup@example.test",
    password: "signup-initial-password",
  }),
});
assert.equal(oldSignupPassword.status, 401);

const newSignupPassword = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "signup@example.test",
    password: "signup-replaced-password",
  }),
});
assert.equal(newSignupPassword.status, 200);

const browserUser = await jsonFetch("/api/users", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    email: "owner@example.test",
    password: "correct-horse-battery-staple",
    role: "owner",
  }),
});
assert.equal(browserUser.item.email, "owner@example.test");
assert.equal(browserUser.item.role, "owner");

const badLoginResponse = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "owner@example.test",
    password: "wrong-password-value",
  }),
});
assert.equal(badLoginResponse.status, 401);

const browserLoginResponse = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "owner@example.test",
    password: "correct-horse-battery-staple",
  }),
});
assert.equal(browserLoginResponse.status, 200);
const browserLogin = await browserLoginResponse.json();
assert.equal(browserLogin.authKind, "session");
assert.match(browserLogin.csrfToken, /^wrcc_/);
const browserCookies = browserLoginResponse.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
assert.match(browserCookies, /commender_session=wrcs_/);

const browserMeResponse = await fetch(base + "/api/auth/me", {
  headers: { Cookie: browserCookies },
});
assert.equal(browserMeResponse.status, 200);
const browserMe = await browserMeResponse.json();
assert.equal(browserMe.email, "owner@example.test");
assert.equal(browserMe.role, "owner");
assert.equal(browserMe.authKind, "session");

// Platform admin authorization and tenant-role boundaries are verified against a real
// cookie session, not against the globally privileged control API key.
const ordinaryOwnerConsole=await fetch(base+"/api/console/me",{headers:{Cookie:browserCookies}});
assert.equal(ordinaryOwnerConsole.status,403,"Workspace ownership is not platform administration");
await acceptanceDb.query(
  "insert into platform_administrators(user_id,granted_by) values($1,'integration-test') on conflict(user_id) do update set revoked_at=null",
  [browserMe.userId],
);
const platformMe=await fetch(base+"/api/console/me",{headers:{Cookie:browserCookies}});
assert.equal(platformMe.status,200);
assert.equal((await platformMe.json()).platformRole,"super_admin");
// The platform operator's own workspace is never limited by a SaaS plan.
const operatorBilling=await (await fetch(base+"/api/billing",{headers:{Cookie:browserCookies}})).json();
assert.equal(operatorBilling.entitled,true);
assert.equal(operatorBilling.plan.key,"internal");
assert.equal(operatorBilling.limits.maxDevices,null);
// Console: a super admin switches public sign-up without a redeploy.
{
  const headers={Cookie:browserCookies,"Content-Type":"application/json","X-CSRF-Token":browserLogin.csrfToken};
  const flip=(enabled,currentPassword="correct-horse-battery-staple")=>fetch(base+"/api/console/settings/public-signup",
    {method:"POST",headers,body:JSON.stringify({enabled,currentPassword})});
  assert.equal((await jsonFetch("/api/public/config")).signupEnabled,true,"environment default while no console value");
  const off=await flip(false);
  assert.equal(off.status,200);
  assert.deepEqual((await off.json()).signupSetting,{enabled:false,source:"console"});
  assert.equal((await jsonFetch("/api/public/config")).signupEnabled,false);
  const blocked=await fetch(base+"/api/auth/signup",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({email:"closed-signup@example.test"})});
  assert.equal(blocked.status,404);
  await blocked.text();
  assert.equal((await flip(true)).status,200);
  assert.equal((await jsonFetch("/api/public/config")).signupEnabled,true);
  assert.equal((await (await fetch(base+"/api/console/system",{headers})).json()).signupSetting.source,"console");
}
// Console: the free plan's monthly tool-call limit is edited with the other limits.
{
  const headers={Cookie:browserCookies,"Content-Type":"application/json","X-CSRF-Token":browserLogin.csrfToken};
  const setLimits=(monthlyToolCalls)=>fetch(base+"/api/console/plans/limits",{method:"POST",headers,body:JSON.stringify({
    key:"free",maxDevices:1,maxMembers:1,maxApiTokens:2,monthlyToolCalls,currentPassword:"correct-horse-battery-staple"})});
  await acceptanceDb.query("update billing_plans set active=true where key='free'");
  assert.equal((await setLimits(1200)).status,200);
  const consoleBilling=await (await fetch(base+"/api/console/billing",{headers})).json();
  assert.equal(consoleBilling.plans.find((plan)=>plan.key==="free").monthly_tool_calls,1200);
  const freeCard=(await jsonFetch("/api/public/plans")).plans.find((plan)=>plan.key==="free");
  assert.ok(freeCard.features.includes("Ayda 1.200 araç çağrısı"),"the pricing card shows the limit in force");
  assert.equal((await setLimits(5000)).status,200);
  await acceptanceDb.query("update billing_plans set active=false where key='free'");
}
// Verify revisioned CMS draft, publication, rollback and safe HTML metadata rendering.
const cmsSessionHeaders={Cookie:browserCookies,"Content-Type":"application/json","X-CSRF-Token":browserLogin.csrfToken};
const tinyPng="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YRHuwoAAAAASUVORK5CYII=";
const mediaBody=(currentPassword)=>JSON.stringify({alt:"Integration test media",mime:"image/png",base64:tinyPng,currentPassword});
const rejectedMedia=await fetch(base+"/api/console/media/upload",{
 method:"POST",headers:cmsSessionHeaders,body:mediaBody("invalid-admin-password"),
});
assert.equal(rejectedMedia.status,403,"Media upload requires password reauthentication");
const mediaUploaded=await fetch(base+"/api/console/media/upload",{
 method:"POST",headers:cmsSessionHeaders,body:mediaBody("correct-horse-battery-staple"),
});
assert.equal(mediaUploaded.status,201);
const mediaId=(await mediaUploaded.json()).id;
const draftMediaResponse=await fetch(base+"/api/public/media/"+mediaId);
assert.equal(draftMediaResponse.status,404,"Unpublished CMS images must not be publicly readable");
const forbiddenDraftPreview=await fetch(base+"/api/console/media/"+mediaId);
assert.equal(forbiddenDraftPreview.status,401,"Draft images must require a super-admin session");
const adminDraftPreview=await fetch(base+"/api/console/media/"+mediaId,{headers:{Cookie:browserCookies}});
assert.equal(adminDraftPreview.status,200);
assert.equal(adminDraftPreview.headers.get("content-type"),"image/png");
assert.match(adminDraftPreview.headers.get("cache-control")||"",/no-store/);
const mediaInventory=await fetch(base+"/api/console/media",{headers:{Cookie:browserCookies}});
assert.equal(mediaInventory.status,200);
assert.ok((await mediaInventory.json()).items.some(row=>row.id===mediaId));
const invalidMediaReference=await fetch(base+"/api/console/site-content",{
 method:"POST",headers:cmsSessionHeaders,
 body:JSON.stringify({locale:"en",heroTitle:"Invalid draft",heroSubtitle:"Test draft should fail",
 overrides:{"media:feature:0":"javascript:alert(1)"}}),
});
assert.equal(invalidMediaReference.status,400,"CMS must reject untrusted media URLs");
const draftCms=async(title,metadata)=>fetch(base+"/api/console/site-content",{
  method:"POST",headers:cmsSessionHeaders,body:JSON.stringify({
    locale:"en",heroTitle:title,heroSubtitle:"Safe integrated landing subtitle",
    seoTitle:metadata,seoDescription:'Description with <script> and "quotes"',
    overrides:{"Cihaz yönetiminde":"Managed capabilities heading","media:feature:0":mediaId},
  }),
});
const cmsCreated=await draftCms("Integration Draft One","One <script>unsafe</script> & safe");
assert.equal(cmsCreated.status,201);
const cmsFirstId=(await cmsCreated.json()).id;
const draftDoesNotPublish=await jsonFetch("/api/public/site-content?locale=en");
assert.equal(draftDoesNotPublish.item,null);
const cmsPublish=async(id)=>fetch(base+"/api/console/site-content/publish",{
  method:"POST",headers:cmsSessionHeaders,body:JSON.stringify({id,currentPassword:"correct-horse-battery-staple"}),
});
const unauthenticatedPublish=await fetch(base+"/api/console/site-content/publish",{
  method:"POST",headers:cmsSessionHeaders,
  body:JSON.stringify({id:cmsFirstId,currentPassword:"incorrect-password-value"}),
});
assert.equal(unauthenticatedPublish.status,403,"Publishing site content requires current admin password");
assert.equal((await cmsPublish(cmsFirstId)).status,200);
const publishedMedia=await fetch(base+"/api/public/media/"+mediaId);
assert.equal(publishedMedia.status,200,"Published landing images become publicly readable");
assert.equal(publishedMedia.headers.get("content-type"),"image/png");
assert.match(publishedMedia.headers.get("cache-control")||"",/no-store/,"Published media must not remain cached after unpublish");
const publicFirst=await jsonFetch("/api/public/site-content?locale=en");
assert.equal(publicFirst.item.hero_title,"Integration Draft One");
assert.equal(publicFirst.item.overrides["Cihaz yönetiminde"],"Managed capabilities heading");
const seoHtml=(await(await fetch(base+"/")).text());
assert.ok(seoHtml.includes("One &lt;script&gt;unsafe&lt;/script&gt; &amp; safe"),"Published SEO title must be HTML escaped");
assert.ok(!seoHtml.includes("<script>unsafe</script>"),"Stored CMS text must never inject HTML scripts");
assert.ok(seoHtml.includes('property="og:description"'),"Published SEO must render OG metadata server-side");
const cmsSecond=await draftCms("Integration Draft Two","Revised SEO title");
assert.equal(cmsSecond.status,201);
const cmsSecondId=(await cmsSecond.json()).id;
assert.equal((await cmsPublish(cmsSecondId)).status,200);
assert.equal((await jsonFetch("/api/public/site-content?locale=en")).item.hero_title,"Integration Draft Two");
assert.equal((await cmsPublish(cmsFirstId)).status,200,"Older revision must be republishable for rollback");
assert.equal((await jsonFetch("/api/public/site-content?locale=en")).item.hero_title,"Integration Draft One");
await acceptanceDb.query("delete from site_content_revisions where id=any($1::bigint[])",[[cmsFirstId,cmsSecondId]]);
assert.equal((await fetch(base+"/api/public/media/"+mediaId)).status,404,
 "Unreferenced media must no longer be public when its published CMS revision is removed");
await acceptanceDb.query("delete from site_media_assets where id=$1",[mediaId]);

const legalDraft=async(title)=>fetch(base+"/api/console/legal",{
 method:"POST",headers:cmsSessionHeaders,
 body:JSON.stringify({page:"privacy",locale:"en",title,body:"Legal plain text content with <script>alert(1)</script> markup rendered as text."}),
});
const firstLegal=await legalDraft("Privacy Revision One");
assert.equal(firstLegal.status,201);
const legalFirstId=(await firstLegal.json()).id;
assert.equal((await jsonFetch("/api/public/legal?page=privacy&locale=en")).item,null,"Draft legal content must not be public");
const publishLegal=async(id,currentPassword)=>fetch(base+"/api/console/legal/publish",{
 method:"POST",headers:cmsSessionHeaders,body:JSON.stringify({id,currentPassword}),
});
assert.equal((await publishLegal(legalFirstId,"wrong-password-value")).status,403);
assert.equal((await publishLegal(legalFirstId,"correct-horse-battery-staple")).status,200);
const legalPublished=await jsonFetch("/api/public/legal?page=privacy&locale=en");
assert.equal(legalPublished.item.title,"Privacy Revision One");
assert.equal(legalPublished.item.body.includes("<script>"),true,"Legal editor preserves literal text, React must escape rendering");
assert.equal((await jsonFetch("/api/public/legal?page=terms&locale=en")).item,null,"Privacy publish cannot overwrite terms");
const secondLegal=await legalDraft("Privacy Revision Two");
assert.equal(secondLegal.status,201);
const legalSecondId=(await secondLegal.json()).id;
assert.equal((await publishLegal(legalSecondId,"correct-horse-battery-staple")).status,200);
assert.equal((await jsonFetch("/api/public/legal?page=privacy&locale=en")).item.title,"Privacy Revision Two");
assert.equal((await publishLegal(legalFirstId,"correct-horse-battery-staple")).status,200,"Legal rollback must restore previous revision");
assert.equal((await jsonFetch("/api/public/legal?page=privacy&locale=en")).item.title,"Privacy Revision One");
await acceptanceDb.query("delete from legal_page_revisions where id=any($1::bigint[])",[[legalFirstId,legalSecondId]]);

// Live incident triage: a password-confirmed acknowledgement is audit-only and
// never marks a relay healthy, grants device access or hides subsequent new incidents.
const fakeRelayId="ci-stale-relay-acceptance";
await acceptanceDb.query(
 `insert into relay_nodes(id,region,public_ws_url,internal_base_url,enabled,drain,last_seen_at)
  values($1,'ci','wss://relay.example.test/agent','https://relay.example.test',true,false,now()-interval '1 hour')
  on conflict(id) do update set last_seen_at=now()-interval '1 hour',enabled=true,drain=false`,
 [fakeRelayId],
);
const activeIncidents=await fetch(base+"/api/console/incidents",{headers:{Cookie:browserCookies}});
assert.equal(activeIncidents.status,200);
const relayIncident=(await activeIncidents.json()).items.find(i=>i.kind==="relay_unhealthy");
assert.ok(relayIncident?.fingerprint,"Stale relay must be reported as an incident");
const unauthorizedIncident=await fetch(base+"/api/console/incidents");
assert.equal(unauthorizedIncident.status,401);
const invalidReview=await fetch(base+"/api/console/incidents/acknowledge",{
 method:"POST",headers:cmsSessionHeaders,
 body:JSON.stringify({fingerprint:relayIncident.fingerprint,currentPassword:"wrong-password-value"}),
});
assert.equal(invalidReview.status,403,"Incident acknowledgements require a current admin password");
const incidentReview=await fetch(base+"/api/console/incidents/acknowledge",{
 method:"POST",headers:cmsSessionHeaders,
 body:JSON.stringify({fingerprint:relayIncident.fingerprint,currentPassword:"correct-horse-battery-staple"}),
});
assert.equal(incidentReview.status,200);
assert.equal((await incidentReview.json()).conditionResolved,false);
const reviewedIncident=(await(await fetch(base+"/api/console/incidents",{headers:{Cookie:browserCookies}})).json()).items
 .find(i=>i.kind==="relay_unhealthy");
assert.ok(reviewedIncident?.acknowledgedAt,"Reviewed incident is auditable");
await acceptanceDb.query("update relay_nodes set last_seen_at=now() where id=$1",[fakeRelayId]);
const refreshedIncidents=(await(await fetch(base+"/api/console/incidents",{headers:{Cookie:browserCookies}})).json()).items;
assert.ok(!refreshedIncidents.some(i=>i.fingerprint===relayIncident.fingerprint),
  "Resolved/stale fingerprint should not stay active after fresh relay heartbeat");
const staleReview=await fetch(base+"/api/console/incidents/acknowledge",{
 method:"POST",headers:cmsSessionHeaders,
 body:JSON.stringify({fingerprint:relayIncident.fingerprint,currentPassword:"correct-horse-battery-staple"}),
});
assert.equal(staleReview.status,409,"Cannot acknowledge an inactive incident");
await acceptanceDb.query("delete from relay_nodes where id=$1",[fakeRelayId]);
await acceptanceDb.query("delete from platform_incident_acknowledgements where fingerprint=$1",[relayIncident.fingerprint]);
const membershipOrg=browserMe.organizationId;
const memberSeed=await acceptanceDb.query(
  `insert into users(email,password_hash,email_verified_at)
   select 'console-role-fixture@example.test',password_hash,now() from users where id=$1
   returning id`,[browserMe.userId]);
const memberId=memberSeed.rows[0].id;
await acceptanceDb.query(
  "insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",
  [membershipOrg,memberId]);
// Global user detail is read-only and must never include password/session secrets.
const memberDetailResponse=await fetch(base+"/api/console/users/detail?userId="+memberId,{headers:{Cookie:browserCookies}});
assert.equal(memberDetailResponse.status,200);
const memberDetail=await memberDetailResponse.json();
assert.equal(memberDetail.user.id,memberId);
assert.equal(memberDetail.user.email,"console-role-fixture@example.test");
assert.equal(memberDetail.user.platform_administrator,false);
assert.equal(memberDetail.organizations.some(row=>row.id===membershipOrg&&row.role==="viewer"),true);
assert.equal(typeof memberDetail.user.active_sessions,"number");
assert.equal(Object.hasOwn(memberDetail.user,"password_hash"),false);
assert.equal(Object.hasOwn(memberDetail.user,"token_hash"),false);
assert.equal(Object.hasOwn(memberDetail.user,"csrf_hash"),false);
const selfDetail=await fetch(base+"/api/console/users/detail?userId="+browserMe.userId,{headers:{Cookie:browserCookies}});
assert.equal(selfDetail.status,200);
assert.equal((await selfDetail.json()).user.platform_administrator,true);
const deniedDetail=await fetch(base+"/api/console/users/detail?userId="+memberId);
assert.equal(deniedDetail.status,401);
const impossibleDetail=await fetch(base+"/api/console/users/detail?userId=00000000-0000-4000-8000-000000000000",{headers:{Cookie:browserCookies}});
assert.equal(impossibleDetail.status,404);
const invalidUserId=await fetch(base+"/api/console/users/detail?userId=not-a-uuid",{headers:{Cookie:browserCookies}});
assert.equal(invalidUserId.status,400);
// Combined audit feed supports server-side risk/source filters and page boundaries.
const tenantAudit=await acceptanceDb.query(
  "insert into audit_logs(organization_id,actor,tool,risk,outcome,detail) values($1,'ci-actor','ci.audit.search.marker','low','success','test only') returning id",
  [browserMe.organizationId],
);
const platformAudit=await acceptanceDb.query(
  "insert into platform_admin_audit(actor_user_id,action,detail) values($1,'ci.platform.audit.marker','test only') returning id",
  [browserMe.userId],
);
const auditHeaders={Cookie:browserCookies};
const auditTenant=await fetch(base+"/api/console/audit?source=tenant&risk=low&limit=1&q=ci.audit.search.marker",{headers:auditHeaders});
assert.equal(auditTenant.status,200);
const tenantAuditData=await auditTenant.json();
assert.equal(tenantAuditData.total,1);
assert.equal(tenantAuditData.items.length,1);
assert.equal(tenantAuditData.items[0].source,"tenant");
assert.equal(tenantAuditData.items[0].item_id,"tenant:"+tenantAudit.rows[0].id);
const pagedAudit=await fetch(base+"/api/console/audit?source=tenant&risk=low&limit=1&offset=1&q=ci.audit.search.marker",{headers:auditHeaders});
assert.equal(pagedAudit.status,200);
assert.equal((await pagedAudit.json()).items.length,0);
const auditPlatform=await fetch(base+"/api/console/audit?source=platform&risk=high&q=ci.platform.audit.marker",{headers:auditHeaders});
assert.equal(auditPlatform.status,200);
const platformAuditData=await auditPlatform.json();
assert.equal(platformAuditData.total,1);
assert.equal(platformAuditData.items[0].source,"platform");
const mismatchedRisk=await fetch(base+"/api/console/audit?source=platform&risk=critical&q=ci.platform.audit.marker",{headers:auditHeaders});
assert.equal((await mismatchedRisk.json()).total,0);
const invalidAuditFilter=await fetch(base+"/api/console/audit?source=invalid",{headers:auditHeaders});
assert.equal(invalidAuditFilter.status,400,"Audit source filter rejects unsupported values");
const forbiddenAudit=await fetch(base+"/api/console/audit?source=platform");
assert.equal(forbiddenAudit.status,401,"Unprivileged clients cannot inspect global audit history");
await acceptanceDb.query("delete from audit_logs where id=$1",[tenantAudit.rows[0].id]);
await acceptanceDb.query("delete from platform_admin_audit where id=$1",[platformAudit.rows[0].id]);
// Device inventory pagination, search and explicit revoked-state filtering.
const inventoryDevice=await acceptanceDb.query(
 `insert into devices(id,organization_id,name,hostname,platform,token_hash)
  values(gen_random_uuid(),$1,'ci-device-inventory-marker','ci-host','linux','ci-inventory-temporary-token-hash')
  returning id`,[browserMe.organizationId],
);
const inventoryHeaders={Cookie:browserCookies};
const activeInventory=await fetch(base+"/api/console/devices?status=active&limit=1&q=ci-device-inventory-marker",{headers:inventoryHeaders});
assert.equal(activeInventory.status,200);
const activeInventoryData=await activeInventory.json();
assert.equal(activeInventoryData.total,1);
assert.equal(activeInventoryData.items.length,1);
assert.equal(activeInventoryData.items[0].id,inventoryDevice.rows[0].id);
const emptyInventoryPage=await fetch(base+"/api/console/devices?status=active&limit=1&offset=1&q=ci-device-inventory-marker",{headers:inventoryHeaders});
assert.equal((await emptyInventoryPage.json()).items.length,0);
const noRevokedInventory=await fetch(base+"/api/console/devices?status=revoked&q=ci-device-inventory-marker",{headers:inventoryHeaders});
assert.equal((await noRevokedInventory.json()).total,0);
await acceptanceDb.query("update devices set revoked_at=now() where id=$1",[inventoryDevice.rows[0].id]);
const revokedInventory=await fetch(base+"/api/console/devices?status=revoked&q=ci-device-inventory-marker",{headers:inventoryHeaders});
assert.equal((await revokedInventory.json()).total,1);
assert.equal((await(await fetch(base+"/api/console/devices?status=active&q=ci-device-inventory-marker",{headers:inventoryHeaders})).json()).total,0);
assert.equal((await fetch(base+"/api/console/devices?status=unsupported",{headers:inventoryHeaders})).status,400);
assert.equal((await fetch(base+"/api/console/devices")).status,401);
await acceptanceDb.query("delete from devices where id=$1",[inventoryDevice.rows[0].id]);
const userDirectory=await fetch(base+"/api/console/users?limit=1&offset=0&q=console-role-fixture",{
 headers:{Cookie:browserCookies},
});
assert.equal(userDirectory.status,200);
const userDirectoryResult=await userDirectory.json();
assert.equal(userDirectoryResult.limit,1);
assert.ok(Number.isInteger(userDirectoryResult.total));
assert.equal(userDirectoryResult.items.length<=1,true);
const noMatchingUsers=await fetch(base+"/api/console/users?limit=25&q=__no_such_user_923abcc__",{
 headers:{Cookie:browserCookies},
});
assert.equal(noMatchingUsers.status,200);
assert.equal((await noMatchingUsers.json()).total,0);
const workspaceDirectory=await fetch(base+"/api/console/organizations?limit=1&offset=0&q=Test",{headers:{Cookie:browserCookies}});
assert.equal(workspaceDirectory.status,200);
const workspaceDirectoryData=await workspaceDirectory.json();
assert.equal(workspaceDirectoryData.items.length<=1,true,"Organization directory must honor page size");
assert.ok(Number.isInteger(workspaceDirectoryData.total),"Organization list exposes exact total");
const filteredUnknownOrg=await fetch(base+"/api/console/organizations?limit=25&q=__no_such_workspace_289df4__",{
 headers:{Cookie:browserCookies},
});
assert.equal(filteredUnknownOrg.status,200);
assert.equal((await filteredUnknownOrg.json()).total,0);
const inaccessibleOrgList=await fetch(base+"/api/console/organizations?limit=25",{
 headers:{"Authorization":"Bearer ci-control-key-0123456789-0123456789"},
});
assert.equal(inaccessibleOrgList.status,403,"Tenant control token must not view the platform directory");
const membersResult=await fetch(base+"/api/console/organizations/members?organizationId="+membershipOrg,{headers:{Cookie:browserCookies}});
assert.equal(membersResult.status,200);
assert.ok((await membersResult.json()).items.some(item=>item.user_id===memberId));
const roleBody=JSON.stringify({organizationId:membershipOrg,userId:memberId,role:"operator",currentPassword:"correct-horse-battery-staple"});
const roleWithoutCsrf=await fetch(base+"/api/console/organizations/members/role",{
  method:"POST",headers:{Cookie:browserCookies,"Content-Type":"application/json"},body:roleBody});
assert.equal(roleWithoutCsrf.status,403,"Admin mutation must enforce CSRF");
const roleChange=await fetch(base+"/api/console/organizations/members/role",{
  method:"POST",headers:{Cookie:browserCookies,"Content-Type":"application/json","X-CSRF-Token":browserLogin.csrfToken},
  body:roleBody});
assert.equal(roleChange.status,200);
const roleStored=await acceptanceDb.query(
  "select role from organization_members where organization_id=$1 and user_id=$2",
  [membershipOrg,memberId]);
assert.equal(roleStored.rows[0].role,"operator");
const escalateToOwner=await fetch(base+"/api/console/organizations/members/role",{
  method:"POST",headers:{Cookie:browserCookies,"Content-Type":"application/json","X-CSRF-Token":browserLogin.csrfToken},
  body:JSON.stringify({organizationId:membershipOrg,userId:memberId,role:"owner",currentPassword:"correct-horse-battery-staple"})});
assert.equal(escalateToOwner.status,400,"A platform editor cannot silently assign organization ownership");
// Owner recovery: step-up, CSRF, eligibility, self/platform-admin protection, audit.
// A dedicated platform administrator keeps these calls out of the main
// account's console mutation budget used by later tests.
const recoveryAdminSeed=await acceptanceDb.query(
  `insert into users(email,password_hash,email_verified_at)
   select 'console-recovery-admin@example.test',password_hash,now() from users where id=$1 returning id`,[browserMe.userId]);
const recoveryAdminId=recoveryAdminSeed.rows[0].id;
await acceptanceDb.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",[membershipOrg,recoveryAdminId]);
await acceptanceDb.query("insert into platform_administrators(user_id,granted_by) values($1,'ci-owner-recovery-admin')",[recoveryAdminId]);
const recoveryLogin=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({email:"console-recovery-admin@example.test",password:"correct-horse-battery-staple"})});
assert.equal(recoveryLogin.status,200);
const recoveryCookies=recoveryLogin.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
const recoveryCsrf=(await recoveryLogin.json()).csrfToken;
const recoveryHeaders={Cookie:recoveryCookies,"Content-Type":"application/json","X-CSRF-Token":recoveryCsrf};
const recovery=(body,headers=recoveryHeaders)=>fetch(base+"/api/console/organizations/owner-recovery",{method:"POST",headers,body:JSON.stringify(body)});
const recoveryBody={organizationId:membershipOrg,userId:memberId,reason:"Owner lost access; ticket CI-1234",currentPassword:"correct-horse-battery-staple"};
assert.equal((await recovery(recoveryBody,{Cookie:recoveryCookies,"Content-Type":"application/json"})).status,403,"owner recovery enforces CSRF");
assert.equal((await recovery({...recoveryBody,currentPassword:"incorrect-password-value"})).status,403,"owner recovery requires step-up");
assert.equal((await recovery({...recoveryBody,reason:"short"})).status,400,"owner recovery requires a reason");
assert.equal((await recovery({...recoveryBody,unexpected:true})).status,400,"owner recovery rejects unknown fields");
const selfRecovery=await recovery({...recoveryBody,userId:recoveryAdminId});
assert.equal(selfRecovery.status,403);
assert.equal((await selfRecovery.json()).error,"cannot_modify_self");
await acceptanceDb.query("update users set email_verified_at=null where id=$1",[memberId]);
const unverifiedRecovery=await recovery(recoveryBody);
assert.equal(unverifiedRecovery.status,409);
assert.equal((await unverifiedRecovery.json()).error,"target_account_not_eligible");
await acceptanceDb.query("update users set email_verified_at=now() where id=$1",[memberId]);
await acceptanceDb.query("insert into platform_administrators(user_id,granted_by) values($1,'ci-owner-recovery-test')",[memberId]);
const adminTargetRecovery=await recovery(recoveryBody);
assert.equal(adminTargetRecovery.status,403,"recovery must not target a platform administrator");
await acceptanceDb.query("delete from platform_administrators where user_id=$1",[memberId]);
assert.equal((await recovery({...recoveryBody,organizationId:"00000000-0000-4000-8000-000000000000"})).status,404);
assert.equal((await fetch(base+"/api/console/organizations/owner-recovery",{method:"POST",headers:{"Authorization":"Bearer ci-control-key-0123456789-0123456789","Content-Type":"application/json"},body:JSON.stringify(recoveryBody)})).status,403,"control token is not a platform session");
const recovered=await recovery(recoveryBody);
assert.equal(recovered.status,200);
assert.deepEqual(await recovered.json(),{ok:true,organizationId:membershipOrg,userId:memberId,from:"operator",to:"owner"});
assert.equal((await acceptanceDb.query("select role from organization_members where organization_id=$1 and user_id=$2",[membershipOrg,memberId])).rows[0].role,"owner");
assert.equal((await acceptanceDb.query("select role from organization_members where organization_id=$1 and user_id=$2",[membershipOrg,browserMe.userId])).rows[0].role,"owner","existing owners are not demoted");
const recoveryAudit=await acceptanceDb.query("select detail from platform_admin_audit where action='organization.owner_recovery' and actor_user_id=$1 order by created_at desc limit 1",[recoveryAdminId]);
assert.match(recoveryAudit.rows[0]?.detail||"",/CI-1234/);
assert.ok(!/correct-horse/.test(recoveryAudit.rows[0].detail),"audit never contains the password");
assert.equal((await recovery(recoveryBody)).status,409,"already owner");
await acceptanceDb.query("update organization_members set role='operator' where organization_id=$1 and user_id=$2",[membershipOrg,memberId]);
await acceptanceDb.query("update platform_administrators set revoked_at=now() where user_id=$1",[recoveryAdminId]);
await acceptanceDb.query("delete from organization_members where organization_id=$1 and user_id=$2",[membershipOrg,recoveryAdminId]);
const workerLogin=await fetch(base+"/api/auth/login",{
  method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({email:"console-role-fixture@example.test",password:"correct-horse-battery-staple"}),
});
assert.equal(workerLogin.status,200);
const workerCookies=workerLogin.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
const adminSessions=await fetch(base+"/api/console/users/sessions?userId="+memberId,{headers:{Cookie:browserCookies}});
assert.equal(adminSessions.status,200);
const workerSession=(await adminSessions.json()).items.find(s=>!s.revoked_at);
assert.ok(workerSession?.id,"Admin must see user sessions without raw credentials");
const badSessionRevoke=await fetch(base+"/api/console/users/sessions/revoke",{
  method:"POST",headers:cmsSessionHeaders,
  body:JSON.stringify({sessionId:workerSession.id,currentPassword:"incorrect-password-value"}),
});
assert.equal(badSessionRevoke.status,403);
const sessionRevoke=await fetch(base+"/api/console/users/sessions/revoke",{
  method:"POST",headers:cmsSessionHeaders,
  body:JSON.stringify({sessionId:workerSession.id,currentPassword:"correct-horse-battery-staple"}),
});
assert.equal(sessionRevoke.status,200);
const blockedWorker=await fetch(base+"/api/auth/me",{headers:{Cookie:workerCookies}});
assert.equal(blockedWorker.status,401,"Revoked session must lose access immediately");
await acceptanceDb.query("update platform_administrators set revoked_at=now() where user_id=$1",[browserMe.userId]);
const revokedPlatform=await fetch(base+"/api/console/me",{headers:{Cookie:browserCookies}});
assert.equal(revokedPlatform.status,403,"Revocation must take effect without signing out");
const unverifiedSeed=await acceptanceDb.query(
  `insert into users(email,password_hash,email_verified_at)
   select 'unverified-console-fixture@example.test',password_hash,null from users where id=$1 returning id`,
  [browserMe.userId]);
await acceptanceDb.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",
  [membershipOrg,unverifiedSeed.rows[0].id]);
const unverifiedLogin=await fetch(base+"/api/auth/login",{
  method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({email:"unverified-console-fixture@example.test",password:"correct-horse-battery-staple"})});
assert.equal(unverifiedLogin.status,401,"Unverified accounts must not log in");
await acceptanceDb.query("delete from users where id=any($1::uuid[])",[[memberId,unverifiedSeed.rows[0].id]]);
await acceptanceDb.query("delete from platform_administrators where user_id=$1",[browserMe.userId]);

const browserCsrfDenied = await fetch(base + "/api/pairing", {
  method: "POST",
  headers: { Cookie: browserCookies, "Content-Type": "application/json" },
  body: "{}",
});
assert.equal(browserCsrfDenied.status, 403);
assert.equal((await browserCsrfDenied.json()).error, "csrf_required");

const browserPairing = await fetch(base + "/api/pairing", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: "{}",
});
assert.equal(browserPairing.status, 201);

// Account-authorized desktop pairing: only a browser session with CSRF and
// workspace operator privileges may approve an ephemeral device request.
const linkLanding = await fetch(base + "/connect-device?requestId=11111111-1111-4111-8111-111111111111");
assert.equal(linkLanding.status, 200);
assert.match(await linkLanding.text(), /Bilgisayarını bağla/);

const linkStart = await jsonFetch("/api/device-link/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
});
assert.match(linkStart.requestId, /^[0-9a-f-]{36}$/i);
assert.ok(linkStart.requestSecret.length >= 20);
const pollBody = JSON.stringify({
  requestId: linkStart.requestId, requestSecret: linkStart.requestSecret,
});
const firstPoll = await jsonFetch("/api/device-link/poll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: pollBody,
});
assert.equal(firstPoll.status, "pending");
assert.equal(firstPoll.pairingCode, undefined, "Unapproved device must not receive pairing credentials");
// Regression: an installer polls every 3 s while the owner approves. Two
// minutes of polling must not exhaust the start or enroll limits.
for (let i = 0; i < 40; i++) {
  const waiting = await fetch(base + "/api/device-link/poll", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: pollBody,
  });
  assert.equal(waiting.status, 200, `poll ${i} must not be rate limited`);
  await waiting.text();
}
const restartAfterPolling = await fetch(base + "/api/device-link/start", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
});
assert.equal(restartAfterPolling.status, 201, "polling must not consume the device-link start budget");
await restartAfterPolling.text();
const incorrectSecret = await jsonFetch("/api/device-link/poll", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({requestId:linkStart.requestId,requestSecret:"incorrect-but-long-secret-12345"}),
});
assert.equal(incorrectSecret.status, "expired", "Incorrect secret cannot access device-link request");

const anonymousLinkApprove = await fetch(base + "/api/device-link/approve", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({requestId:linkStart.requestId,organizationId:browserMe.organizationId}),
});
assert.equal(anonymousLinkApprove.status, 401);
const missingLinkCsrf = await fetch(base + "/api/device-link/approve", {
  method: "POST", headers: { Cookie: browserCookies, "Content-Type": "application/json" },
  body: JSON.stringify({requestId:linkStart.requestId,organizationId:browserMe.organizationId}),
});
assert.equal(missingLinkCsrf.status, 403);
const controlLinkApprove = await fetch(base + "/api/device-link/approve", {
  method: "POST", headers: authHeaders,
  body: JSON.stringify({requestId:linkStart.requestId,organizationId:browserMe.organizationId}),
});
assert.equal(controlLinkApprove.status, 403, "Control API tokens cannot approve desktop account linking");
const browserLinkApprove = await fetch(base + "/api/device-link/approve", {
  method: "POST",
  headers: { Cookie: browserCookies, "Content-Type": "application/json", "X-CSRF-Token": browserLogin.csrfToken },
  body: JSON.stringify({requestId:linkStart.requestId,organizationId:browserMe.organizationId}),
});
assert.equal(browserLinkApprove.status, 200);
const approvedLink = await jsonFetch("/api/device-link/poll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: pollBody,
});
assert.equal(approvedLink.status, "approved");
assert.ok(approvedLink.pairingCode.length >= 20);
const consumedLink = await jsonFetch("/api/device-link/poll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: pollBody,
});
assert.equal(consumedLink.status, "consumed", "Approved authorization can only be redeemed once");

// Management Center (tray app): browser-approved sign-in, a token that only
// reaches approvals, autonomous mode and devices, and self-disconnect.
const centerStart = await jsonFetch("/api/center-link/start", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Ofis-PC" }),
});
assert.match(centerStart.approveUrl, /\/connect-center\?requestId=[0-9a-f-]{36}$/);
const centerPollBody = JSON.stringify({ requestId: centerStart.requestId, requestSecret: centerStart.requestSecret });
assert.equal((await jsonFetch("/api/center-link/poll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: centerPollBody,
})).status, "pending");
const browserCenterHeaders = { Cookie: browserCookies, "Content-Type": "application/json", "X-CSRF-Token": browserLogin.csrfToken };
assert.equal((await jsonFetch("/api/center-link/info?requestId=" + centerStart.requestId, {
  headers: browserCenterHeaders,
})).name, "Ofis-PC");
const controlCenterApprove = await fetch(base + "/api/center-link/approve", {
  method: "POST", headers: authHeaders,
  body: JSON.stringify({ requestId: centerStart.requestId, organizationId: browserMe.organizationId }),
});
assert.equal(controlCenterApprove.status, 403, "Only a browser session can connect a Management Center");
const centerApprove = await fetch(base + "/api/center-link/approve", {
  method: "POST", headers: browserCenterHeaders,
  body: JSON.stringify({ requestId: centerStart.requestId, organizationId: browserMe.organizationId }),
});
assert.equal(centerApprove.status, 200);
const centerRedeemed = await jsonFetch("/api/center-link/poll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: centerPollBody,
});
assert.equal(centerRedeemed.status, "approved");
assert.match(centerRedeemed.centerToken, /^wmc_/);
assert.equal((await jsonFetch("/api/center-link/poll", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: centerPollBody,
})).status, "consumed");
const centerHeaders = { Authorization: `Bearer ${centerRedeemed.centerToken}`, "Content-Type": "application/json" };
const centerMe = await jsonFetch("/api/center/me?platform=windows", { headers: centerHeaders });
assert.equal(centerMe.name, "Ofis-PC");
assert.equal((await acceptanceDb.query(
  "select platform from management_centers where id=$1", [centerRedeemed.centerId],
)).rows[0].platform, "windows", "a center linked without a platform reports it on /api/center/me");
assert.equal(centerMe.email, browserMe.email);
assert.ok(Array.isArray((await jsonFetch("/api/approval-requests?status=pending", { headers: centerHeaders })).items));
assert.ok(Array.isArray((await jsonFetch("/api/devices", { headers: centerHeaders })).items));
assert.ok(Array.isArray((await jsonFetch("/api/trust/autonomy", { headers: centerHeaders })).items));
for (const [method, path] of [["GET", "/api/tokens"], ["POST", "/api/pairing"], ["GET", "/api/audit"]]) {
  const denied = await fetch(base + path, { method, headers: centerHeaders, body: method === "POST" ? "{}" : undefined });
  assert.equal(denied.status, 403, `center token must not reach ${method} ${path}`);
  assert.equal((await denied.json()).error, "center_scope");
}
// "Ajani kur" in a signed-in Center: a one-time pairing code, audited.
const centerPairing = await fetch(base + "/api/center/pairing-code", { method: "POST", headers: centerHeaders, body: "{}" });
assert.equal(centerPairing.status, 201, "a signed-in Center gets a one-time pairing code");
const centerPairingBody = await centerPairing.json();
assert.ok(centerPairingBody.pairingCode.length >= 20);
assert.equal(centerPairingBody.expiresInSeconds, 300);
assert.equal((await acceptanceDb.query(
  "select 1 from audit_logs where tool='center.pairing_code'",
)).rowCount, 1, "center pairing codes are audited");
const browserPairingCode = await fetch(base + "/api/center/pairing-code", { method: "POST", headers: browserCenterHeaders, body: "{}" });
assert.equal(browserPairingCode.status, 403, "only a Center token gets a Center pairing code");
await browserPairingCode.text();
const centerMcp = await fetch(base + "/mcp", {
  method: "POST", headers: centerHeaders,
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
assert.equal(centerMcp.status, 403, "a Management Center never reaches MCP tools");
await centerMcp.text();
const centerWrongPassword = await fetch(base + "/api/trust/autonomy", {
  method: "POST", headers: centerHeaders,
  body: JSON.stringify({ enable: true, minutes: 30, deviceIds: [linkStart.requestId], currentPassword: "wrong-password" }),
});
assert.equal(centerWrongPassword.status, 403, "enabling autonomy from the tray still needs the password");
await centerWrongPassword.text();
const centerList = await jsonFetch("/api/centers", { headers: browserCenterHeaders });
assert.ok(centerList.items.some((item) => item.id === centerRedeemed.centerId && !item.revoked_at));
const centerDisconnect = await fetch(base + "/api/center/disconnect", { method: "POST", headers: centerHeaders, body: "{}" });
assert.equal(centerDisconnect.status, 200);
await centerDisconnect.text();
const centerAfterDisconnect = await fetch(base + "/api/center/me", { headers: centerHeaders });
assert.equal(centerAfterDisconnect.status, 401, "a disconnected center token stops working");
await centerAfterDisconnect.text();
const linkedDevice = await jsonFetch("/api/agent/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pairingCode: approvedLink.pairingCode,
    hostname: "auto-linked-device",
    platform: "windows",
  }),
});
assert.match(linkedDevice.deviceId, /^[0-9a-f-]{36}$/i);
const linkedTenant = await acceptanceDb.query(
  "select organization_id from devices where id=$1", [linkedDevice.deviceId],
);
assert.equal(linkedTenant.rows[0].organization_id, browserMe.organizationId);
const replayEnrollment = await fetch(base + "/api/agent/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({pairingCode:approvedLink.pairingCode,hostname:"replay-device",platform:"windows"}),
});
assert.equal(replayEnrollment.status, 400, "Issued pairing code must be single use");

const pairing = await jsonFetch("/api/pairing", {
  method: "POST",
  headers: authHeaders,
  body: "{}",
});
assert.equal(typeof pairing.pairingCode, "string");

const enrolled = await jsonFetch("/api/agent/enroll", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pairingCode: pairing.pairingCode,
    name: "CI mock device",
    hostname: "ci-host",
    platform: "linux",
  }),
});
assert.match(enrolled.deviceId, /^[0-9a-f-]{36}$/i);
assert.equal(typeof enrolled.deviceToken, "string");

// Real PostgreSQL integration for bounded search-session persistence. A newly
// constructed store represents a gateway restart without the original Map.
const searchOwner = await acceptanceDb.query(
  "select organization_id from devices where id=$1", [enrolled.deviceId],
);
assert.equal(searchOwner.rows.length, 1);
const durableKey = {
  id: randomUUID(), organizationId: searchOwner.rows[0].organization_id,
  actor: "search-ci-owner", deviceId: enrolled.deviceId,
};
const searchPool = new Pool({ connectionString: databaseUrl });
const durableStore = new PgSearchPersistence(searchPool);
const durableCreatedAt = Date.now();
try {
  await durableStore.create({
    ...durableKey, path: "/ci", query: "needle", searchType: "files",
    createdAt: durableCreatedAt,
  });
  assert.equal(await durableStore.progress(durableKey, {
    items: [{ path: "/ci/one.txt" }], scannedEntries: 32,
    scannedBytes: 0, sequence: 1,
  }), true);
  const beforeCompletion = await durableStore.page(durableKey, durableKey.id, 0, 10);
  assert.equal(beforeCompletion.status, "running");
  assert.deepEqual(beforeCompletion.items, [{ path: "/ci/one.txt" }]);
  assert.equal(beforeCompletion.progressUpdates, 1);
  assert.equal(beforeCompletion.scannedEntries, 32);
  const runningList = await durableStore.list(durableKey);
  const listedProgress = runningList.items.find(item => item.searchId === durableKey.id);
  assert.equal(listedProgress?.status, "running");
  assert.equal(listedProgress?.progressUpdates, 1);
  assert.equal(listedProgress?.scannedEntries, 32);
  assert.equal(listedProgress?.scannedBytes, 0);
  assert.equal(await durableStore.progress({ ...durableKey, actor: "foreign-actor" }, {
    items: [{ path: "/ci/foreign" }], scannedEntries: 90,
    scannedBytes: 0, sequence: 3,
  }), false);
  assert.equal(await durableStore.progress(durableKey, {
    items: [{ path: "/ci/out-of-order" }], scannedEntries: 12,
    scannedBytes: 0, sequence: 1,
  }), false);
  // A foreign Gateway may read the actor-scoped snapshot, but cannot finalize
  // a native request it did not originate, even with the correct search ID.
  const foreignGateway = new PgSearchPersistence(searchPool);
  assert.equal(await foreignGateway.finish(durableKey, {
    status: "completed", items: [{ path: "/ci/foreign-completion" }],
    truncated: false, timedOut: false,
  }), false);
  assert.equal((await durableStore.page(durableKey, durableKey.id, 0, 10)).status, "running");
  await durableStore.finish(durableKey, {
    status: "completed",
    items: [{ path: "/ci/one.txt" }, { path: "/ci/two.txt" }],
    truncated: false, timedOut: false, progressUpdates: 1,
    scannedEntries: 37, scannedBytes: 120,
  });
  const afterRestart = new PgSearchPersistence(searchPool);
  const restored = await afterRestart.page(durableKey, durableKey.id, 1, 1);
  assert.equal(restored.status, "completed");
  assert.deepEqual(restored.items, [{ path: "/ci/two.txt" }]);
  assert.equal(restored.resultCount, 2);
  assert.equal(restored.scannedEntries, 37);
  assert.equal(restored.scannedBytes, 120);
  await assert.rejects(
    afterRestart.page({ ...durableKey, actor: "foreign-actor" }, durableKey.id, 0, 10),
    /search_not_found/,
  );
  await assert.rejects(
    afterRestart.page({ ...durableKey, organizationId: "00000000-0000-4000-8000-000000000999" }, durableKey.id, 0, 10),
    /search_not_found/,
  );
  await assert.rejects(
    afterRestart.page({ ...durableKey, deviceId: "00000000-0000-4000-8000-000000000998" }, durableKey.id, 0, 10),
    /search_not_found/,
  );
  // A native search snapshot larger than 1 MiB must retain ordered,
  // pageable results instead of silently discarding the entire result set.
  // 1B native filename checkpoint handoff: only a dead Gateway's lease
  // can be taken over; identical actor/device checks prevent cross-scope claims.
  const recoveryKey = { ...durableKey, id: randomUUID() };
  const nativeCheckpoint = {
    version: 1, root: "/ci", query: "needle", caseSensitive: false,
    pending: ["/ci/pending"], items: [{ path: "/ci/needle.txt" }], scannedEntries: 32,
  };
  await durableStore.create({
    ...recoveryKey, path: "/ci", query: "needle", searchType: "files",
    createdAt: Date.now(),
  });
  assert.equal(await durableStore.progress(recoveryKey, {
    items: nativeCheckpoint.items, scannedEntries: 32, scannedBytes: 0,
    sequence: 1, checkpoint: nativeCheckpoint,
  }), true);
  const persistedCheckpoint = await acceptanceDb.query(
    "select checkpoint from search_sessions where id=$1", [recoveryKey.id],
  );
  assert.deepEqual(persistedCheckpoint.rows[0].checkpoint, nativeCheckpoint);
  // A partial scanner update is intentionally newer than the checkpoint.
  // It must be discarded on takeover, not displayed as recovered output.
  assert.equal(await durableStore.progress(recoveryKey, {
    items: [...nativeCheckpoint.items, { path: "/ci/unsafe-partial.txt" }],
    scannedEntries: 48, scannedBytes: 0, sequence: 2,
  }), true);
  const beforeTakeover = await durableStore.page(recoveryKey, recoveryKey.id, 0, 10);
  assert.equal(beforeTakeover.scannedEntries, 48);
  assert.equal(beforeTakeover.items.length, 2);
  const takeover = new PgSearchPersistence(searchPool);
  const recoveryRows = await takeover.recoveryCandidates();
  assert.ok(recoveryRows.some(item => item.id === recoveryKey.id));
  assert.equal(await takeover.claimRecovery({
    ...recoveryKey, actor: "wrong-actor",
  }), null);
  // The candidate selection snapshot is now stale: an old Gateway managed
  // to commit another safe directory boundary before its lease was fenced.
  // The claimant must consume the checkpoint from UPDATE ... RETURNING.
  const newerCheckpoint = {
    ...nativeCheckpoint,
    scannedEntries: 48,
    pending: ["/ci/newer-pending"],
    items: [...nativeCheckpoint.items, { path: "/ci/needle-newer.txt" }],
  };
  assert.equal(await durableStore.progress(recoveryKey, {
    items: newerCheckpoint.items, scannedEntries: 48, scannedBytes: 0,
    sequence: 3, checkpoint: newerCheckpoint,
  }), true);
  assert.equal(await durableStore.progress(recoveryKey, {
    items: [...newerCheckpoint.items, { path: "/ci/unsafe-tail.txt" }],
    scannedEntries: 55, scannedBytes: 0, sequence: 4,
  }), true);
  const claimed = await takeover.claimRecovery(recoveryKey);
  assert.ok(claimed && Number.isSafeInteger(claimed.sequence) && claimed.sequence > 4);
  assert.deepEqual(claimed.checkpoint, newerCheckpoint);
  const claimedSequence = claimed.sequence;
  const safeRecovery = await takeover.page(recoveryKey, recoveryKey.id, 0, 10);
  assert.equal(safeRecovery.status, "running");
  assert.deepEqual(safeRecovery.items, newerCheckpoint.items,
    "The abandoned partial result must be rolled back to the freshest checkpoint");
  assert.equal(safeRecovery.scannedEntries, newerCheckpoint.scannedEntries);
  assert.equal(safeRecovery.progressUpdates, claimedSequence);
  assert.equal(await durableStore.finish(recoveryKey, {
    status: "completed", items: [{ path: "/ci/stale-native" }],
    truncated: false, timedOut: false,
  }), false);
  assert.equal(await takeover.finish(recoveryKey, {
    status: "completed", items: newerCheckpoint.items,
    truncated: false, timedOut: false, progressUpdates: claimedSequence,
  }), true);
  const recoveredFinal = await takeover.page(recoveryKey, recoveryKey.id, 0, 10);
  assert.equal(recoveredFinal.status, "completed");
  assert.deepEqual(recoveredFinal.items, newerCheckpoint.items);
  assert.equal((await acceptanceDb.query(
    "select checkpoint from search_sessions where id=$1", [recoveryKey.id],
  )).rows[0].checkpoint, null);

  // A conservative content checkpoint carries no old line matches. The
  // claimed row rewinds byte counters and drops an unfinished preview; only
  // the claimant can persist newly read matching lines after that point.
  const contentRecoveryKey = { ...durableKey, id: randomUUID() };
  const contentCheckpoint = {
    version: 1, searchType: "content", root: "/ci", query: "needle",
    caseSensitive: false, pending: ["/ci/unread.txt"],
    items: [], scannedEntries: 32, scannedBytes: 48,
  };
  await durableStore.create({
    ...contentRecoveryKey, path: "/ci", query: "needle", searchType: "content",
    createdAt: Date.now(),
  });
  assert.equal(await durableStore.progress(contentRecoveryKey, {
    items: [], scannedEntries: 32, scannedBytes: 48,
    sequence: 1, checkpoint: contentCheckpoint,
  }), true);
  assert.equal(await durableStore.progress(contentRecoveryKey, {
    items: [{ path: "/ci/unsafe-previous.txt", line: 1, preview: "needle" }],
    scannedEntries: 36, scannedBytes: 88, sequence: 2,
  }), true);
  const contentCandidate = (await takeover.recoveryCandidates())
    .find(item => item.id === contentRecoveryKey.id);
  assert.equal(contentCandidate?.searchType, "content");
  assert.equal(await takeover.claimRecovery({
    ...contentRecoveryKey, actor: "foreign-actor",
  }), null);
  const contentClaim = await takeover.claimRecovery(contentRecoveryKey);
  assert.ok(contentClaim && contentClaim.sequence > 2);
  assert.deepEqual(contentClaim.checkpoint, contentCheckpoint);
  const rewound = await takeover.page(contentRecoveryKey, contentRecoveryKey.id, 0, 10);
  assert.deepEqual(rewound.items, []);
  assert.equal(rewound.scannedEntries, 32);
  assert.equal(rewound.scannedBytes, 48);
  assert.equal(await durableStore.finish(contentRecoveryKey, {
    status: "completed", items: [{ path: "/ci/stale-after-takeover" }],
    truncated: false, timedOut: false,
  }), false);
  assert.equal(await takeover.finish(contentRecoveryKey, {
    status: "completed",
    items: [{ path: "/ci/unread.txt", line: 1, preview: "needle" }],
    truncated: false, timedOut: false,
    scannedEntries: 32, scannedBytes: 96,
    progressUpdates: contentClaim.sequence,
  }), true);
  const completedContent = await takeover.page(contentRecoveryKey, contentRecoveryKey.id, 0, 10);
  assert.equal(completedContent.status, "completed");
  assert.deepEqual(completedContent.items, [
    { path: "/ci/unread.txt", line: 1, preview: "needle" },
  ]);

  // Interrupted checkpoint recovery must never bypass a user's pause or
  // stop. These are real PostgreSQL conditional updates, not mocked SQL.
  const deniedRecoveryKey = { ...durableKey, id: randomUUID() };
  await durableStore.create({
    ...deniedRecoveryKey, path: "/ci", query: "needle", searchType: "files",
    createdAt: Date.now(),
  });
  assert.equal(await durableStore.progress(deniedRecoveryKey, {
    items: nativeCheckpoint.items, scannedEntries: 32, scannedBytes: 0,
    sequence: 1, checkpoint: nativeCheckpoint,
  }), true);
  assert.equal(await durableStore.setPaused(deniedRecoveryKey, true), true);
  assert.equal(await takeover.claimRecovery(deniedRecoveryKey), null,
    "A paused native scanner may not be recovered automatically");
  assert.equal(await durableStore.setPaused(deniedRecoveryKey, false), true);
  await durableStore.stop(deniedRecoveryKey);
  assert.equal(await takeover.claimRecovery(deniedRecoveryKey), null,
    "A stopped session may not be resurrected by another Gateway");
  assert.equal((await acceptanceDb.query(
    "select checkpoint from search_sessions where id=$1", [deniedRecoveryKey.id],
  )).rows[0].checkpoint, null);
  await durableStore.settleStopped(deniedRecoveryKey);

  const oversizedKey = { ...durableKey, id: randomUUID() };
  await durableStore.create({
    ...oversizedKey, path: "/ci", query: "large", searchType: "content",
    createdAt: Date.now(),
  });
  const oversizedItems = Array.from({ length: 500 }, (_, index) => ({
    path: `/ci/${String(index).padStart(4, "0")}.txt`,
    preview: "ğ".repeat(1500),
  }));
  assert.equal(await durableStore.finish(oversizedKey, {
    status: "completed", items: oversizedItems, truncated: false, timedOut: false,
  }), true);
  const firstOversizedPage = await afterRestart.page(oversizedKey, oversizedKey.id, 0, 100);
  assert.equal(firstOversizedPage.status, "completed");
  assert.equal(firstOversizedPage.truncated, true);
  assert.ok(firstOversizedPage.resultCount > 100 && firstOversizedPage.resultCount < 500);
  assert.equal(firstOversizedPage.hasMore, true);
  assert.deepEqual(firstOversizedPage.items, oversizedItems.slice(0, 100));
  const lastOversizedPage = await afterRestart.page(
    oversizedKey, oversizedKey.id, firstOversizedPage.resultCount - 1, 100,
  );
  assert.deepEqual(lastOversizedPage.items, [oversizedItems[firstOversizedPage.resultCount - 1]]);
  assert.equal(lastOversizedPage.hasMore, false);
  await durableStore.stop(oversizedKey);
  assert.deepEqual((await afterRestart.page(oversizedKey, oversizedKey.id, 0, 100)).items, []);

  const foreignList = await afterRestart.list({ ...durableKey, actor: "foreign-actor" });
  assert.equal(foreignList.items.some(item => item.searchId === durableKey.id), false);
  await afterRestart.stop(durableKey);
  const stopped = await afterRestart.page(durableKey, durableKey.id, 0, 10);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(stopped.items, []);
  // A completion arriving after a different Gateway stopped the search
  // must fail its compare-and-swap and must never restore the result.
  const resurrected = await durableStore.finish(durableKey, {
    status: "completed", items: [{ path: "/ci/must-not-reappear" }],
    truncated: false, timedOut: false,
  });
  assert.equal(resurrected, false);
  const stillStopped = await afterRestart.page(durableKey, durableKey.id, 0, 10);
  assert.equal(stillStopped.status, "stopped");
  assert.deepEqual(stillStopped.items, []);
  assert.equal(await durableStore.progress(durableKey, {
    items: [{ path: "/ci/must-not-resurrect" }],
    scannedEntries: 99, scannedBytes: 0, sequence: 9,
  }), false);

  const interruptedKey = { ...durableKey, id: randomUUID() };
  await durableStore.create({
    ...interruptedKey, path: "/ci", query: "unsettled", searchType: "content",
    createdAt: durableCreatedAt,
  });
  const interrupted = await afterRestart.page(interruptedKey, interruptedKey.id, 0, 10);
  assert.equal(interrupted.status, "error");
  assert.equal(interrupted.error, "search_interrupted");
  assert.deepEqual(interrupted.items, []);
  await durableStore.stop(interruptedKey);

  // A live Gateway's scanner is not a crashed/restarted scanner.
  // A distinct observer must report running while its lease is fresh.
  const liveOwner = new PgSearchPersistence(searchPool);
  const liveObserver = new PgSearchPersistence(searchPool);
  const liveKey = { ...durableKey, id: randomUUID() };
  await liveOwner.activate();
  await liveObserver.activate();
  try {
    await liveOwner.create({
      ...liveKey, path: "/ci", query: "live-remote-owner", searchType: "files",
      createdAt: Date.now(),
    });
    const remoteRunning = await liveObserver.page(liveKey, liveKey.id, 0, 10);
    assert.equal(remoteRunning.status, "running");
    assert.deepEqual(remoteRunning.items, []);
    // A stop from a second Gateway becomes visible to the owning process
    // without requiring access to another tenant's session or scanner.
    const remoteStopKey = { ...liveKey, id: randomUUID() };
    await liveOwner.create({
      ...remoteStopKey, path: "/ci", query: "remote-stop", searchType: "files",
      createdAt: Date.now(),
    });
    await liveObserver.stop(remoteStopKey);
    assert.deepEqual(await liveOwner.stoppedIds([remoteStopKey.id]), [remoteStopKey.id]);
    // A different Gateway can request stop, but must never free the owner's
    // native execution quota before that native scanner actually settles.
    await liveObserver.settleStopped(remoteStopKey);
    const foreignSettlement = await searchPool.query(
      "select native_inflight from search_sessions where id=$1", [remoteStopKey.id],
    );
    assert.equal(foreignSettlement.rows[0]?.native_inflight, true);

    // Real PostgreSQL cross-Gateway allocation: eight native workers across
    // two instances must block a ninth worker for the SAME actor, even after
    // a stop that has not yet settled on the owning native Agent.
    const sharedActive = [];
    for (let index = 0; index < 6; index += 1) {
      const key = { ...liveKey, id: randomUUID() };
      const store = index % 2 === 0 ? liveOwner : liveObserver;
      await store.create({
        ...key, path: "/ci", query: "parallel", searchType: "files",
        createdAt: Date.now(),
      });
      sharedActive.push(key);
    }
    const ninthKey = { ...liveKey, id: randomUUID() };
    await assert.rejects(
      liveObserver.create({
        ...ninthKey, path: "/ci", query: "ninth", searchType: "files",
        createdAt: Date.now(),
      }),
      /search_session_limit/,
    );
    await liveOwner.settleStopped(remoteStopKey);
    const ownerSettlement = await searchPool.query(
      "select native_inflight from search_sessions where id=$1", [remoteStopKey.id],
    );
    assert.equal(ownerSettlement.rows[0]?.native_inflight, false);
    await liveObserver.create({
      ...ninthKey, path: "/ci", query: "after-native-settle", searchType: "files",
      createdAt: Date.now(),
    });
    const confirmedStop = await liveObserver.page(remoteStopKey, remoteStopKey.id, 0, 10);
    assert.equal(confirmedStop.status, "stopped");
    assert.deepEqual(confirmedStop.items, []);
    assert.equal(sharedActive.length, 6);

    await liveOwner.deactivate();
    const orphaned = await liveObserver.page(liveKey, liveKey.id, 0, 10);
    assert.equal(orphaned.status, "error");
    assert.equal(orphaned.error, "search_interrupted");
    await liveObserver.stop(liveKey);
  } finally {
    // Safe to call on the same instance even if the normal path deactivated it.
    await liveOwner.deactivate();
    await liveObserver.deactivate();
  }
} finally {
  await acceptanceDb.query(
    "delete from search_sessions where organization_id=$1 and actor=$2",
    [durableKey.organizationId, durableKey.actor],
  );
  await searchPool.end();
}


const wsUrl = base.replace(/^http/, "ws") + "/agent";
const socket = new WebSocket(wsUrl, {
  headers: {
    "x-device-id": enrolled.deviceId,
    Authorization: `Bearer ${enrolled.deviceToken}`,
  },
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("websocket open timeout")), 5000);
  socket.once("open", () => {
    clearTimeout(timer);
    resolve();
  });
  socket.once("error", reject);
});

const connectedDevices = await jsonFetch("/api/devices", { headers: authHeaders });
const connectedDevice = connectedDevices.items.find((item) => item.id === enrolled.deviceId);
assert.ok(connectedDevice);
assert.equal(connectedDevice.online, false);

socket.send(JSON.stringify({
  type: "hello",
  deviceId: enrolled.deviceId,
  hostname: "ci-host",
  os: "linux",
  version: "ci",
  capabilities: ["system", "process"],
}));

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type !== "request") return;

  if (message.action.kind === "system_info") {
    socket.send(JSON.stringify({
      type: "result",
      requestId: message.requestId,
      ok: true,
      data: { hostname: "ci-host", os: "linux", mock: true },
    }));
    return;
  }

  if (message.action.kind === "process_exec") {
    socket.send(JSON.stringify({
      type: "result",
      requestId: message.requestId,
      ok: true,
      data: { exitCode: 0, success: true, stdout: "approved", stderr: "" },
    }));
    return;
  }

  socket.send(JSON.stringify({
    type: "result",
    requestId: message.requestId,
    ok: false,
    error: { code: "unsupported_test_action", message: message.action.kind },
  }));
});

const device = await waitFor(async () => {
  const devices = await jsonFetch("/api/devices", { headers: authHeaders });
  const item = devices.items.find((candidate) => candidate.id === enrolled.deviceId);
  return item?.online ? item : null;
});
assert.equal(device.online, true);

const initialized = await rpc(1, "initialize", {});
assert.equal(initialized.result.serverInfo.name, "webrising-commender");

const listed = await rpc(2, "tools/list", {});
assert.ok(listed.result.tools.some((tool) => tool.name === "system_info"));
assert.ok(listed.result.tools.some((tool) => tool.name === "process_exec"));
assert.ok(listed.result.tools.some((tool) => tool.name === "fs_tree"));
assert.ok(listed.result.tools.some((tool) => tool.name === "fs_search"));
assert.ok(listed.result.tools.some((tool) => tool.name === "code_search"));
assert.ok(listed.result.tools.some((tool) => tool.name === "fs_replace"));
assert.ok(listed.result.tools.some((tool) => tool.name === "task_list"));
assert.ok(listed.result.tools.some((tool) => tool.name === "terminal_list"));

// MCP contract regression: every advertised tool must be uniquely named,
// bounded to its documented JSON object schema, and device-scoped where relevant.
const advertisedTools = listed.result.tools;
const advertisedNames = advertisedTools.map((tool) => tool.name);
assert.equal(new Set(advertisedNames).size, advertisedNames.length, "MCP tool names must be unique");
for (const advertised of advertisedTools) {
  assert.ok(advertised.description.length > 10, `Missing tool description: ${advertised.name}`);
  const schema = advertised.inputSchema;
  assert.equal(schema.type, "object", advertised.name);
  assert.equal(schema.additionalProperties, false, advertised.name);
  const required = schema.required || [];
  assert.equal(new Set(required).size, required.length, advertised.name);
  for (const key of required) {
    assert.ok(Object.hasOwn(schema.properties, key), `Missing schema property ${advertised.name}.${key}`);
  }
  // Desktop Commander-compatible tools take an optional device_id (the single
  // online device is used when omitted); every other device tool requires it.
  const dcCompatible = ["read_file", "read_multiple_files", "write_file", "list_directory",
    "create_directory", "move_file", "get_file_info", "edit_block", "url_fetch"];
  if (dcCompatible.includes(advertised.name)) {
    assert.ok(!required.includes("device_id"), advertised.name);
    assert.equal(schema.properties.device_id.type, "string", advertised.name);
  } else if (advertised.name !== "devices_list") {
    assert.ok(required.includes("device_id"), `Device routing not required: ${advertised.name}`);
    assert.equal(schema.properties.device_id.type, "string", advertised.name);
  }
}
for (const name of [
  "fs_read_lines", "fs_read_multiple", "start_search", "get_more_search_results",
  "stop_search", "terminal_read_page", "get_recent_tool_calls", "get_usage_stats",
  "xlsx_inspect", "xlsx_read_range", "xlsx_find", "xlsx_write_cells",
  "docx_inspect", "docx_read_paragraphs", "docx_read_table", "image_inspect", "pdf_read",
  "read_file", "write_file", "edit_block", "list_directory", "url_fetch",
]) {
  assert.ok(advertisedNames.includes(name), `Missing advertised parity tool: ${name}`);
}
for (const name of ["process_exec", "process_kill", "fs_delete", "task_start",
  "task_cancel", "terminal_start", "terminal_stop"]) {
  const advertised = advertisedTools.find((tool) => tool.name === name);
  assert.equal(advertised.inputSchema.properties.approval_token.type, "string", name);
}
const unknownMcpTool = await rpc(280, "tools/call", {
  name: "unknown_unregistered_tool",
  arguments: {},
});
assert.equal(unknownMcpTool.result.isError, true);
assert.equal(toolText(unknownMcpTool).error, "unknown_tool");
const missingDeviceMcp = await rpc(281, "tools/call", {
  name: "system_info",
  arguments: {},
});
assert.equal(missingDeviceMcp.result.isError, true);
assert.equal(toolText(missingDeviceMcp).error, "device_id_required");

const info = await rpc(3, "tools/call", {
  name: "system_info",
  arguments: { device_id: enrolled.deviceId },
});
assert.deepEqual(toolText(info), { hostname: "ci-host", os: "linux", mock: true });

const denied = await rpc(4, "tools/call", {
  name: "process_exec",
  arguments: { device_id: enrolled.deviceId, command: "echo denied" },
});
assert.equal(denied.result.isError, true);
assert.equal(toolText(denied).error, "approval_required");

const approvedAction = {
  kind: "process_exec",
  command: "echo approved",
};

const defaultOperator = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "CI Default Operator",
    role: "operator",
  }),
});
const operatorApprovalResponse = await fetch(base + "/api/approvals", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${defaultOperator.token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    deviceId: enrolled.deviceId,
    action: approvedAction,
    ttlSeconds: 60,
  }),
});
assert.equal(operatorApprovalResponse.status, 403);

const operatorHeaders = {
  Authorization: `Bearer ${defaultOperator.token}`,
  "Content-Type": "application/json",
};
const humanActionArgs = {
  device_id: enrolled.deviceId,
  command: "echo human-approved",
};
const pendingForHuman = await rpcAs(operatorHeaders, 50, "tools/call", {
  name: "process_exec",
  arguments: humanActionArgs,
});
assert.equal(pendingForHuman.result.isError, true);
const pendingPayload = toolText(pendingForHuman);
assert.equal(pendingPayload.error, "approval_required");
assert.match(pendingPayload.approval_request_id, /^[0-9a-f-]{36}$/i);

const pendingList = await jsonFetch("/api/approval-requests?status=pending", {
  headers: authHeaders,
});
assert.ok(pendingList.items.some((item) => item.id === pendingPayload.approval_request_id));

// Decided from a macOS Management Center: every other center can then read
// where it was decided and say so ("macOS'tan onaylandı").
const macCenterStart = await jsonFetch("/api/center-link/start", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Mac", platform: "macos" }),
});
const macCenterApprove = await fetch(base + "/api/center-link/approve", {
  method: "POST", headers: browserCenterHeaders,
  body: JSON.stringify({ requestId: macCenterStart.requestId, organizationId: browserMe.organizationId }),
});
assert.equal(macCenterApprove.status, 200);
await macCenterApprove.text();
const macCenter = await jsonFetch("/api/center-link/poll", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ requestId: macCenterStart.requestId, requestSecret: macCenterStart.requestSecret }),
});
const macCenterHeaders = { Authorization: `Bearer ${macCenter.centerToken}`, "Content-Type": "application/json" };
const pendingItem = await jsonFetch(`/api/approval-requests/${pendingPayload.approval_request_id}`, {
  headers: macCenterHeaders,
});
assert.equal(pendingItem.item.status, "pending");
assert.equal(pendingItem.item.decided_via, null);

const approvedRequest = await jsonFetch(
  `/api/approval-requests/${pendingPayload.approval_request_id}/approve`,
  {
    method: "POST",
    headers: macCenterHeaders,
    body: "{}",
  },
);
assert.equal(approvedRequest.item.status, "approved");
const decidedSeenByPanel = await jsonFetch(`/api/approval-requests/${pendingPayload.approval_request_id}`, {
  headers: authHeaders,
});
assert.equal(decidedSeenByPanel.item.status, "approved");
assert.deepEqual(decidedSeenByPanel.item.decided_via, { kind: "center", name: "Mac", platform: "macos", self: false });
const decidedSeenBySelf = await jsonFetch(`/api/approval-requests/${pendingPayload.approval_request_id}`, {
  headers: macCenterHeaders,
});
assert.equal(decidedSeenBySelf.item.decided_via.self, true);
const missingItem = await fetch(`${base}/api/approval-requests/00000000-0000-4000-8000-000000000000`, {
  headers: macCenterHeaders,
});
assert.equal(missingItem.status, 404);
await missingItem.text();

const humanApproved = await rpcAs(operatorHeaders, 51, "tools/call", {
  name: "process_exec",
  arguments: humanActionArgs,
});
const humanApprovedData = toolText(humanApproved);
assert.equal(humanApprovedData.success, true);
assert.equal(humanApprovedData.stdout, "approved");

const humanGrantConsumed = await rpcAs(operatorHeaders, 52, "tools/call", {
  name: "process_exec",
  arguments: humanActionArgs,
});
assert.equal(humanGrantConsumed.result.isError, true);
assert.equal(toolText(humanGrantConsumed).error, "approval_required");

// An expired pending request disappears from the pending list and cannot be
// approved; the answer says it expired (found on the Windows acceptance run).
const expiringRequestId = toolText(humanGrantConsumed).approval_request_id;
assert.match(expiringRequestId, /^[0-9a-f-]{36}$/i);
await acceptanceDb.query(
  "update approval_requests set expires_at=now()-interval '1 second' where id=$1",
  [expiringRequestId],
);
const pendingAfterExpiry = await jsonFetch("/api/approval-requests?status=pending", {
  headers: authHeaders,
});
assert.ok(!pendingAfterExpiry.items.some((item) => item.id === expiringRequestId));
const approveExpired = await fetch(
  `${base}/api/approval-requests/${expiringRequestId}/approve`,
  { method: "POST", headers: authHeaders, body: "{}" },
);
assert.equal(approveExpired.status, 409);
assert.equal((await approveExpired.json()).error, "approval_request_expired");
const expiredItem = await jsonFetch(`/api/approval-requests/${expiringRequestId}`, { headers: authHeaders });
assert.equal(expiredItem.item.status, "expired");
assert.equal(expiredItem.item.decided_via, null);

// B03: an approval consumed for a device that is offline never reached it, so
// it is given back (approved again, with its operation) instead of burnt.
const offlinePairing = await jsonFetch("/api/pairing", { method: "POST", headers: authHeaders, body: "{}" });
const offlineDevice = await jsonFetch("/api/agent/enroll", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ pairingCode: offlinePairing.pairingCode, name: "offline", hostname: "offline-host", platform: "linux" }),
});
const offlineArgs = { device_id: offlineDevice.deviceId, command: "echo kept-approval" };
const offlinePending = toolText(await rpcAs(operatorHeaders, 60, "tools/call", { name: "process_exec", arguments: offlineArgs }));
assert.equal(offlinePending.error, "approval_required");
await jsonFetch(`/api/approval-requests/${offlinePending.approval_request_id}/approve`, {
  method: "POST", headers: authHeaders, body: "{}",
});
const offlineRun = toolText(await rpcAs(operatorHeaders, 61, "tools/call", { name: "process_exec", arguments: offlineArgs }));
assert.equal(offlineRun.error, "device-offline");
assert.equal(offlineRun.approval_request_id, offlinePending.approval_request_id);
const kept = await acceptanceDb.query(
  "select status,consumed_at,action from approval_requests where id=$1", [offlinePending.approval_request_id],
);
assert.equal(kept.rows[0].status, "approved");
assert.equal(kept.rows[0].consumed_at, null);
assert.equal(kept.rows[0].action.command, "echo kept-approval");
const restoredAudit = await acceptanceDb.query(
  "select 1 from audit_logs where device_id=$1 and outcome='approval_restored'", [offlineDevice.deviceId],
);
assert.equal(restoredAudit.rowCount, 1);

const tamperApproval = await jsonFetch("/api/approvals", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    deviceId: enrolled.deviceId,
    action: approvedAction,
    ttlSeconds: 60,
  }),
});
assert.equal(typeof tamperApproval.approvalToken, "string");

const tampered = await rpc(5, "tools/call", {
  name: "process_exec",
  arguments: {
    device_id: enrolled.deviceId,
    command: "echo tampered",
    approval_token: tamperApproval.approvalToken,
  },
});
assert.equal(tampered.result.isError, true);
assert.equal(toolText(tampered).error, "approval_required");

const approval = await jsonFetch("/api/approvals", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    deviceId: enrolled.deviceId,
    action: approvedAction,
    ttlSeconds: 60,
  }),
});
assert.equal(typeof approval.approvalToken, "string");

const approved = await rpc(6, "tools/call", {
  name: "process_exec",
  arguments: {
    device_id: enrolled.deviceId,
    command: "echo approved",
    approval_token: approval.approvalToken,
  },
});
const approvedData = toolText(approved);
assert.equal(approvedData.success, true);
assert.equal(approvedData.stdout, "approved");

const replayed = await rpc(7, "tools/call", {
  name: "process_exec",
  arguments: {
    device_id: enrolled.deviceId,
    command: "echo approved",
    approval_token: approval.approvalToken,
  },
});
assert.equal(replayed.result.isError, true);
assert.equal(toolText(replayed).error, "approval_required");

const audit = await jsonFetch("/api/audit?limit=20", { headers: authHeaders });
assert.ok(audit.items.some((item) => item.tool === "process_exec" && item.outcome === "denied"));
assert.ok(audit.items.some((item) => item.tool === "process_exec" && item.outcome === "success"));

const tenantOrg = await jsonFetch("/api/organizations", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "CI Tenant" }),
});
assert.match(tenantOrg.item.id, /^[0-9a-f-]{36}$/i);

await assignSubscription(tenantOrg.item.id);

const tenantMembership = await jsonFetch("/api/members", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    email: "owner@example.test",
    role: "owner",
    organizationId: tenantOrg.item.id,
  }),
});
assert.equal(tenantMembership.item.organization_id, tenantOrg.item.id);
assert.equal(tenantMembership.item.role, "owner");

const switchedOrganizationResponse = await fetch(base + "/api/auth/switch-organization", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: JSON.stringify({ organizationId: tenantOrg.item.id }),
});
assert.equal(switchedOrganizationResponse.status, 200);
const switchedOrganization = await switchedOrganizationResponse.json();
assert.equal(switchedOrganization.organizationId, tenantOrg.item.id);
assert.equal(switchedOrganization.role, "owner");

const switchedMeResponse = await fetch(base + "/api/auth/me", {
  headers: { Cookie: browserCookies },
});
assert.equal(switchedMeResponse.status, 200);
const switchedMe = await switchedMeResponse.json();
assert.equal(switchedMe.organizationId, tenantOrg.item.id);
assert.equal(switchedMe.role, "owner");

const duplicateMemberInvitation = await fetch(base + "/api/invitations", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: JSON.stringify({
    email: "owner@example.test",
    role: "operator",
  }),
});
assert.equal(duplicateMemberInvitation.status, 409);
assert.equal((await duplicateMemberInvitation.json()).error, "already_member");

const memberInvitationResponse = await fetch(base + "/api/invitations", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: JSON.stringify({
    email: "member@example.test",
    role: "operator",
    ttlHours: 24,
  }),
});
assert.equal(memberInvitationResponse.status, 201);
const memberInvitation = await memberInvitationResponse.json();
assert.match(memberInvitation.inviteToken, /^wrci_/);
assert.match(memberInvitation.inviteUrl, /\/invite#token=wrci_/);

const invitationPreviewResponse = await fetch(base + "/api/invitations/preview", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: memberInvitation.inviteToken }),
});
assert.equal(invitationPreviewResponse.status, 200);
const invitationPreview = await invitationPreviewResponse.json();
assert.equal(invitationPreview.item.email, "member@example.test");
assert.equal(invitationPreview.item.organizationId, tenantOrg.item.id);
assert.equal(invitationPreview.item.role, "operator");
assert.equal(invitationPreview.item.existingUser, false);

const invitationAcceptResponse = await fetch(base + "/api/invitations/accept", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: memberInvitation.inviteToken,
    password: "member-secure-password",
  }),
});
assert.equal(invitationAcceptResponse.status, 200);
const invitationAccept = await invitationAcceptResponse.json();
assert.equal(invitationAccept.organizationId, tenantOrg.item.id);
assert.equal(invitationAccept.role, "operator");
const memberCookies = invitationAcceptResponse.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

const invitedMemberMeResponse = await fetch(base + "/api/auth/me", {
  headers: { Cookie: memberCookies },
});
assert.equal(invitedMemberMeResponse.status, 200);
const invitedMemberMe = await invitedMemberMeResponse.json();
assert.equal(invitedMemberMe.email, "member@example.test");
assert.equal(invitedMemberMe.role, "operator");

const invitationReplayResponse = await fetch(base + "/api/invitations/accept", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: memberInvitation.inviteToken,
    password: "member-secure-password",
  }),
});
assert.equal(invitationReplayResponse.status, 400);
assert.equal((await invitationReplayResponse.json()).error, "invalid_or_expired_invitation");

const memberListResponse = await fetch(base + "/api/members", {
  headers: { Cookie: browserCookies },
});
assert.equal(memberListResponse.status, 200);
const memberList = await memberListResponse.json();
const invitedMember = memberList.items.find((item) => item.email === "member@example.test");
assert.ok(invitedMember);
assert.equal(invitedMember.role, "operator");

const lastOwnerDemotionResponse = await fetch(base + `/api/members/${browserMe.userId}`, {
  method: "PATCH",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: JSON.stringify({ role: "admin" }),
});
assert.equal(lastOwnerDemotionResponse.status, 409);
assert.equal((await lastOwnerDemotionResponse.json()).error, "last_owner_required");

const memberRoleUpdateResponse = await fetch(base + `/api/members/${invitedMember.id}`, {
  method: "PATCH",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: JSON.stringify({ role: "viewer" }),
});
assert.equal(memberRoleUpdateResponse.status, 200);
assert.equal((await memberRoleUpdateResponse.json()).item.role, "viewer");

const invitedMemberAfterRoleChange = await fetch(base + "/api/auth/me", {
  headers: { Cookie: memberCookies },
});
assert.equal(invitedMemberAfterRoleChange.status, 200);
assert.equal((await invitedMemberAfterRoleChange.json()).role, "viewer");

const revokeInvitationResponse = await fetch(base + "/api/invitations", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: JSON.stringify({
    email: "revoked@example.test",
    role: "viewer",
  }),
});
assert.equal(revokeInvitationResponse.status, 201);
const revokeInvitation = await revokeInvitationResponse.json();

const revokeInvitationAction = await fetch(
  base + `/api/invitations/${revokeInvitation.item.id}/revoke`,
  {
    method: "POST",
    headers: {
      Cookie: browserCookies,
      "Content-Type": "application/json",
      "X-CSRF-Token": browserLogin.csrfToken,
    },
    body: "{}",
  },
);
assert.equal(revokeInvitationAction.status, 200);

const revokedPreview = await fetch(base + "/api/invitations/preview", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: revokeInvitation.inviteToken }),
});
assert.equal(revokedPreview.status, 404);

const memberRemovalResponse = await fetch(base + `/api/members/${invitedMember.id}`, {
  method: "DELETE",
  headers: {
    Cookie: browserCookies,
    "X-CSRF-Token": browserLogin.csrfToken,
  },
});
assert.equal(memberRemovalResponse.status, 200);

const removedMemberSession = await fetch(base + "/api/auth/me", {
  headers: { Cookie: memberCookies },
});
assert.equal(removedMemberSession.status, 401);

const browserWorkspaceResponse = await fetch(base + "/api/auth/organizations", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: JSON.stringify({ name: "CI Browser Workspace" }),
});
assert.equal(browserWorkspaceResponse.status, 201);
const browserWorkspace = await browserWorkspaceResponse.json();
assert.equal(browserWorkspace.item.role, "owner");

const unprovisionedBillingResponse = await fetch(base + "/api/billing", {
  headers: { Cookie: browserCookies },
});
assert.equal(unprovisionedBillingResponse.status, 200);
const unprovisionedBilling = await unprovisionedBillingResponse.json();
assert.equal(unprovisionedBilling.mode, "saas");
assert.equal(unprovisionedBilling.entitled, false);
assert.equal(unprovisionedBilling.reason, "billing_required");

const unprovisionedPairingResponse = await fetch(base + "/api/pairing", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: "{}",
});
assert.equal(unprovisionedPairingResponse.status, 402);
assert.equal((await unprovisionedPairingResponse.json()).error, "billing_required");

const renameWorkspaceResponse = await fetch(base + "/api/organization", {
  method: "PATCH",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: JSON.stringify({ name: "CI Browser Workspace Renamed" }),
});
assert.equal(renameWorkspaceResponse.status, 200);
assert.equal((await renameWorkspaceResponse.json()).item.name, "CI Browser Workspace Renamed");

const organizationsResponse = await fetch(base + "/api/auth/organizations", {
  headers: { Cookie: browserCookies },
});
assert.equal(organizationsResponse.status, 200);
const organizations = await organizationsResponse.json();
assert.ok(organizations.items.some((item) => item.id === tenantOrg.item.id));
assert.ok(organizations.items.some((item) => item.id === browserWorkspace.item.id));

const switchBackResponse = await fetch(base + "/api/auth/switch-organization", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: JSON.stringify({ organizationId: tenantOrg.item.id }),
});
assert.equal(switchBackResponse.status, 200);

const invitationListResponse = await fetch(base + "/api/invitations", {
  headers: { Cookie: browserCookies },
});
assert.equal(invitationListResponse.status, 200);
const invitationList = await invitationListResponse.json();
assert.ok(invitationList.items.some((item) => item.email === "member@example.test" && item.status === "accepted"));
assert.ok(invitationList.items.some((item) => item.email === "revoked@example.test" && item.status === "revoked"));

const tenantToken = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "CI Tenant Operator",
    role: "operator",
    organizationId: tenantOrg.item.id,
  }),
});
assert.match(tenantToken.token, /^wrc_/);

const tenantHeaders = {
  Authorization: `Bearer ${tenantToken.token}`,
  "Content-Type": "application/json",
};
const tenantMeResponse = await fetch(base + "/api/auth/me", { headers: tenantHeaders });
assert.equal(tenantMeResponse.status, 200);
const tenantMe = await tenantMeResponse.json();
assert.equal(tenantMe.organizationId, tenantOrg.item.id);
assert.equal(tenantMe.role, "operator");
assert.equal(tenantMe.global, false);

const tenantDevicesResponse = await fetch(base + "/api/devices", { headers: tenantHeaders });
assert.equal(tenantDevicesResponse.status, 200);
const tenantDevices = await tenantDevicesResponse.json();
assert.deepEqual(tenantDevices.items, []);

const tenantPairingResponse = await fetch(base + "/api/pairing", {
  method: "POST",
  headers: tenantHeaders,
  body: "{}",
});
assert.equal(tenantPairingResponse.status, 201);

const viewerToken = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "CI Tenant Viewer",
    role: "viewer",
    organizationId: tenantOrg.item.id,
  }),
});
const viewerPairingResponse = await fetch(base + "/api/pairing", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${viewerToken.token}`,
    "Content-Type": "application/json",
  },
  body: "{}",
});
assert.equal(viewerPairingResponse.status, 403);

const tenantAdminToken = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "CI Tenant Admin",
    role: "admin",
    organizationId: tenantOrg.item.id,
  }),
});
const tenantAdminHeaders = {
  Authorization: `Bearer ${tenantAdminToken.token}`,
  "Content-Type": "application/json",
};

const forbiddenBillingAdmin = await fetch(base + "/api/admin/billing/plans", {
  headers: tenantAdminHeaders,
});
assert.equal(forbiddenBillingAdmin.status, 403);
assert.equal((await forbiddenBillingAdmin.json()).error, "global_control_required");

const forbiddenOwnerMembershipChange = await fetch(base + `/api/members/${browserMe.userId}`, {
  method: "PATCH",
  headers: tenantAdminHeaders,
  body: JSON.stringify({ role: "operator" }),
});
assert.equal(forbiddenOwnerMembershipChange.status, 403);
assert.equal((await forbiddenOwnerMembershipChange.json()).error, "cannot_manage_higher_role");

const forbiddenOwnerGrant = await fetch(base + "/api/tokens", {
  method: "POST",
  headers: tenantAdminHeaders,
  body: JSON.stringify({
    name: "Forbidden Owner",
    role: "owner",
  }),
});
assert.equal(forbiddenOwnerGrant.status, 403);

const allowedOperatorGrant = await fetch(base + "/api/tokens", {
  method: "POST",
  headers: tenantAdminHeaders,
  body: JSON.stringify({
    name: "Allowed Operator",
    role: "operator",
  }),
});
assert.equal(allowedOperatorGrant.status, 201);

const tenantOwnerToken = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "CI Tenant Owner",
    role: "owner",
    organizationId: tenantOrg.item.id,
  }),
});

const forbiddenOwnerRevoke = await fetch(
  base + `/api/tokens/${tenantOwnerToken.item.id}/revoke`,
  {
    method: "POST",
    headers: tenantAdminHeaders,
    body: "{}",
  },
);
assert.equal(forbiddenOwnerRevoke.status, 403);

const existingUserInviteOrg = await jsonFetch("/api/organizations", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "CI Existing User Invite" }),
});
await assignSubscription(existingUserInviteOrg.item.id);
const existingUserInviteOwnerToken = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "Existing Invite Bootstrap",
    role: "owner",
    organizationId: existingUserInviteOrg.item.id,
  }),
});
const existingUserInviteHeaders = {
  Authorization: `Bearer ${existingUserInviteOwnerToken.token}`,
  "Content-Type": "application/json",
};
const existingUserInvitationResponse = await fetch(base + "/api/invitations", {
  method: "POST",
  headers: existingUserInviteHeaders,
  body: JSON.stringify({
    email: "owner@example.test",
    role: "admin",
  }),
});
assert.equal(existingUserInvitationResponse.status, 201);
const existingUserInvitation = await existingUserInvitationResponse.json();

const existingUserPreviewResponse = await fetch(base + "/api/invitations/preview", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token: existingUserInvitation.inviteToken }),
});
assert.equal(existingUserPreviewResponse.status, 200);
assert.equal((await existingUserPreviewResponse.json()).item.existingUser, true);

const existingUserWrongPassword = await fetch(base + "/api/invitations/accept", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: existingUserInvitation.inviteToken,
    password: "wrong-password-value",
  }),
});
assert.equal(existingUserWrongPassword.status, 401);
assert.equal((await existingUserWrongPassword.json()).error, "invalid_credentials");

const existingUserAcceptResponse = await fetch(base + "/api/invitations/accept", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token: existingUserInvitation.inviteToken,
    password: "correct-horse-battery-staple",
  }),
});
assert.equal(existingUserAcceptResponse.status, 200);
const existingUserAccept = await existingUserAcceptResponse.json();
assert.equal(existingUserAccept.userId, browserMe.userId);
assert.equal(existingUserAccept.organizationId, existingUserInviteOrg.item.id);
assert.equal(existingUserAccept.role, "admin");

const forbiddenOwnerInvite = await fetch(base + "/api/invitations", {
  method: "POST",
  headers: tenantAdminHeaders,
  body: JSON.stringify({
    email: "future-owner@example.test",
    role: "owner",
  }),
});
assert.equal(forbiddenOwnerInvite.status, 403);
assert.equal((await forbiddenOwnerInvite.json()).error, "cannot_grant_role");

const tinyPlan = await jsonFetch("/api/admin/billing/plans", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    key: "ci-tiny",
    name: "CI Tiny",
    maxDevices: 0,
    maxMembers: 1,
    maxApiTokens: 1,
    metadata: { fixture: true },
    active: true,
  }),
});
assert.equal(tinyPlan.item.max_devices, 0);

const tinyOrg = await jsonFetch("/api/organizations", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "CI Tiny Tenant" }),
});
await assignSubscription(tinyOrg.item.id, "ci-tiny");

const tinyOwnerToken = await jsonFetch("/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "Tiny Owner",
    role: "owner",
    organizationId: tinyOrg.item.id,
  }),
});
const tinyHeaders = {
  Authorization: `Bearer ${tinyOwnerToken.token}`,
  "Content-Type": "application/json",
};

const tinySecondToken = await fetch(base + "/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "Tiny Overflow",
    role: "operator",
    organizationId: tinyOrg.item.id,
  }),
});
assert.equal(tinySecondToken.status, 409);
const tinySecondTokenBody = await tinySecondToken.json();
assert.equal(tinySecondTokenBody.error, "quota_exceeded");
assert.equal(tinySecondTokenBody.resource, "api_token");
assert.equal(tinySecondTokenBody.limit, 1);

const tinyPairing = await fetch(base + "/api/pairing", {
  method: "POST",
  headers: tinyHeaders,
  body: "{}",
});
assert.equal(tinyPairing.status, 409);
const tinyPairingBody = await tinyPairing.json();
assert.equal(tinyPairingBody.error, "quota_exceeded");
assert.equal(tinyPairingBody.resource, "device");
assert.equal(tinyPairingBody.limit, 0);

const tinyInvite = await fetch(base + "/api/invitations", {
  method: "POST",
  headers: tinyHeaders,
  body: JSON.stringify({
    email: "tiny-one@example.test",
    role: "viewer",
  }),
});
assert.equal(tinyInvite.status, 201);

const tinyInviteOverflow = await fetch(base + "/api/invitations", {
  method: "POST",
  headers: tinyHeaders,
  body: JSON.stringify({
    email: "tiny-two@example.test",
    role: "viewer",
  }),
});
assert.equal(tinyInviteOverflow.status, 409);
const tinyInviteOverflowBody = await tinyInviteOverflow.json();
assert.equal(tinyInviteOverflowBody.error, "quota_exceeded");
assert.equal(tinyInviteOverflowBody.resource, "member");
assert.equal(tinyInviteOverflowBody.used, 1);
assert.equal(tinyInviteOverflowBody.limit, 1);

const tinyBilling = await jsonFetch("/api/billing", { headers: tinyHeaders });
assert.equal(tinyBilling.entitled, true);
assert.equal(tinyBilling.plan.key, "ci-tiny");
assert.equal(tinyBilling.usage.pendingInvitations, 1);
assert.equal(tinyBilling.usage.apiTokens, 1);

const tinyUsage = await jsonFetch("/api/usage", { headers: tinyHeaders });
assert.equal(typeof tinyUsage.monthCalls, "number");
assert.equal(typeof tinyUsage.dailyAverage, "number");
assert.equal(tinyUsage.limit, null);
assert.equal(Array.isArray(tinyUsage.months), true);
assert.equal(tinyUsage.months.length, 6);
assert.equal(typeof tinyUsage.resetAt, "string");
assert.equal(Array.isArray(tinyUsage.daily), true);
assert.equal(tinyUsage.daily.length, 7);
assert.equal(typeof tinyUsage.daily[0]?.day, "string");
assert.equal(typeof tinyUsage.daily[0]?.calls, "number");
assert.equal(Array.isArray(tinyUsage.topTools), true);
const tinyActivity = await jsonFetch("/api/activity?limit=6", { headers: tinyHeaders });
assert.equal(Array.isArray(tinyActivity.items), true);
for (const item of tinyActivity.items) {
  assert.equal(typeof item.tool, "string");
  assert.equal(Object.hasOwn(item, "detail"), false, "Activity must not leak audit detail");
  assert.equal(Object.hasOwn(item, "actor"), false, "Activity must not leak actor");
}


const eventPlan = await jsonFetch("/api/admin/billing/plans", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    key: "ci-event",
    name: "CI Event Plan",
    maxDevices: 5,
    maxMembers: 5,
    maxApiTokens: 5,
    metadata: { fixture: true },
    active: true,
  }),
});
assert.equal(eventPlan.item.key, "ci-event");

const eventOrg = await jsonFetch("/api/organizations", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "CI Event Tenant" }),
});

const normalizedEvent = {
  provider: "ci-provider",
  eventId: "evt-ci-001",
  eventType: "subscription.activated",
  occurredAt: "2026-10-20T20:00:00.000Z",
  organizationId: eventOrg.item.id,
  subscription: {
    planKey: "ci-event",
    status: "active",
    externalCustomerId: "ci-customer-event",
    externalSubscriptionId: "ci-subscription-event",
    cancelAtPeriodEnd: false,
  },
};
const appliedEvent = await jsonFetch("/api/admin/billing/events", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify(normalizedEvent),
});
assert.equal(appliedEvent.applied, true);
assert.equal(appliedEvent.duplicate, false);

const duplicateEvent = await jsonFetch("/api/admin/billing/events", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify(normalizedEvent),
});
assert.equal(duplicateEvent.applied, false);
assert.equal(duplicateEvent.duplicate, true);

const conflictingEventResponse = await fetch(base + "/api/admin/billing/events", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    ...normalizedEvent,
    subscription: {
      ...normalizedEvent.subscription,
      status: "canceled",
    },
  }),
});
assert.equal(conflictingEventResponse.status, 409);
assert.equal((await conflictingEventResponse.json()).error, "billing_event_conflict");

const eventBilling = await jsonFetch(
  `/api/admin/organizations/${eventOrg.item.id}/billing`,
  { headers: authHeaders },
);
assert.equal(eventBilling.entitled, true);
assert.equal(eventBilling.plan.key, "ci-event");
assert.equal(eventBilling.subscription.provider, "ci-provider");

const conflictingSubscriptionOrg = await jsonFetch("/api/organizations", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({ name: "CI Subscription Conflict Tenant" }),
});
const conflictingSubscriptionResponse = await fetch(base + "/api/admin/billing/events", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    provider: "ci-provider",
    eventId: "evt-ci-subscription-collision",
    eventType: "subscription.activated",
    occurredAt: "2026-10-20T20:05:00.000Z",
    organizationId: conflictingSubscriptionOrg.item.id,
    subscription: {
      planKey: "ci-event",
      status: "active",
      externalCustomerId: "ci-customer-conflict",
      externalSubscriptionId: "ci-subscription-event",
      cancelAtPeriodEnd: false,
    },
  }),
});
assert.equal(conflictingSubscriptionResponse.status, 409);
assert.equal(
  (await conflictingSubscriptionResponse.json()).error,
  "billing_subscription_conflict",
);

const pastDueEvent = await jsonFetch("/api/admin/billing/events", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    ...normalizedEvent,
    eventId: "evt-ci-002",
    eventType: "subscription.past_due",
    occurredAt: "2026-10-20T21:00:00.000Z",
    subscription: {
      ...normalizedEvent.subscription,
      status: "past_due",
    },
  }),
});
assert.equal(pastDueEvent.applied, true);

const pastDueBilling = await jsonFetch(
  `/api/admin/organizations/${eventOrg.item.id}/billing`,
  { headers: authHeaders },
);
assert.equal(pastDueBilling.entitled, false);
assert.equal(pastDueBilling.reason, "billing_required");

const sameTimeConflictResponse = await fetch(base + "/api/admin/billing/events", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    ...normalizedEvent,
    eventId: "evt-ci-same-time",
    eventType: "subscription.same_time_conflict",
    occurredAt: "2026-10-20T21:00:00.000Z",
    subscription: {
      ...normalizedEvent.subscription,
      status: "active",
    },
  }),
});
assert.equal(sameTimeConflictResponse.status, 409);
const sameTimeConflict = await sameTimeConflictResponse.json();
assert.equal(sameTimeConflict.error, "billing_event_order_conflict");
assert.equal(sameTimeConflict.orderConflict, true);
assert.equal(sameTimeConflict.applied, false);

const billingAfterOrderConflict = await jsonFetch(
  `/api/admin/organizations/${eventOrg.item.id}/billing`,
  { headers: authHeaders },
);
assert.equal(billingAfterOrderConflict.subscription.status, "past_due");
assert.equal(billingAfterOrderConflict.subscription.providerEventId, "evt-ci-002");

const staleEvent = await jsonFetch("/api/admin/billing/events", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    ...normalizedEvent,
    eventId: "evt-ci-003",
    eventType: "subscription.reactivated_late",
    occurredAt: "2026-10-20T20:30:00.000Z",
    subscription: {
      ...normalizedEvent.subscription,
      status: "active",
    },
  }),
});
assert.equal(staleEvent.applied, false);
assert.equal(staleEvent.duplicate, false);
assert.equal(staleEvent.stale, true);
assert.equal(staleEvent.providerMismatch, false);

const billingAfterStaleEvent = await jsonFetch(
  `/api/admin/organizations/${eventOrg.item.id}/billing`,
  { headers: authHeaders },
);
assert.equal(billingAfterStaleEvent.entitled, false);
assert.equal(billingAfterStaleEvent.subscription.status, "past_due");
assert.equal(
  billingAfterStaleEvent.subscription.providerEventId,
  "evt-ci-002",
);

const wrongProviderEvent = await jsonFetch("/api/admin/billing/events", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    ...normalizedEvent,
    provider: "old-provider",
    eventId: "evt-ci-old-provider",
    eventType: "subscription.activated",
    occurredAt: "2026-10-20T22:00:00.000Z",
  }),
});
assert.equal(wrongProviderEvent.applied, false);
assert.equal(wrongProviderEvent.providerMismatch, true);

const billingAfterWrongProvider = await jsonFetch(
  `/api/admin/organizations/${eventOrg.item.id}/billing`,
  { headers: authHeaders },
);
assert.equal(billingAfterWrongProvider.subscription.provider, "ci-provider");
assert.equal(billingAfterWrongProvider.subscription.status, "past_due");

const pastDueToken = await fetch(base + "/api/tokens", {
  method: "POST",
  headers: authHeaders,
  body: JSON.stringify({
    name: "Blocked By Billing",
    role: "owner",
    organizationId: eventOrg.item.id,
  }),
});
assert.equal(pastDueToken.status, 402);
assert.equal((await pastDueToken.json()).error, "billing_required");

// Full Paddle webhook lifecycle: signed subscription creation, deduplication,
// pause (revoked entitlement) and customer-portal price upgrade.
const paddleSecret=process.env.PADDLE_WEBHOOK_SECRET;
assert.ok(paddleSecret,"Paddle webhook secret required for integration fixture");
const paddlePrice="pri_"+"p".repeat(26);
const upgradePrice="pri_"+"q".repeat(26);
const transactionId="txn_"+"t".repeat(26);
const subscriptionId="sub_"+"s".repeat(26);
const customerId="ctm_"+"c".repeat(26);
const paddlePlan=await jsonFetch("/api/admin/billing/plans",{
 method:"POST",headers:authHeaders,
 body:JSON.stringify({key:"ci-paddle",name:"Paddle Standard",maxDevices:3,maxMembers:1,maxApiTokens:1,
 metadata:{paddlePriceId:paddlePrice,priceLabel:"$9 / month"},active:true}),
});
assert.equal(paddlePlan.item.key,"ci-paddle");
const upgradedPlan=await jsonFetch("/api/admin/billing/plans",{
 method:"POST",headers:authHeaders,
 body:JSON.stringify({key:"ci-paddle-plus",name:"Paddle Plus",maxDevices:9,maxMembers:3,maxApiTokens:3,
 metadata:{paddlePriceId:upgradePrice,priceLabel:"$19 / month"},active:true}),
});
assert.equal(upgradedPlan.item.key,"ci-paddle-plus");
const paddleOrg=await jsonFetch("/api/organizations",{
 method:"POST",headers:authHeaders,body:JSON.stringify({name:"Paddle CI Tenant"}),
});
await acceptanceDb.query(
 "insert into paddle_checkout_intents(transaction_id,organization_id,plan_key,price_id) values($1,$2,$3,$4)",
 [transactionId,paddleOrg.item.id,"ci-paddle",paddlePrice]
);
const unsignedPaddle=await fetch(base+"/webhooks/paddle",{
 method:"POST",headers:{"Content-Type":"application/json"},body:"{}",
});
assert.equal(unsignedPaddle.status,401);
const webhookSend=async(event)=>{
 const payload=JSON.stringify(event);
 const ts=String(Math.floor(Date.now()/1000));
 const signature="ts="+ts+";h1="+createHmac("sha256",paddleSecret)
  .update(ts+":"+payload).digest("hex");
 const response=await fetch(base+"/webhooks/paddle",{
  method:"POST",headers:{"Content-Type":"application/json","Paddle-Signature":signature},
  body:payload,
 });
 return {status:response.status,body:await response.json()};
};
const eventPayload=(eventId,type,status,price,transaction)=>{
 return {
  event_id:eventId,event_type:type,occurred_at:new Date().toISOString(),
  data:{
   id:subscriptionId,status,customer_id:customerId,
   ...(transaction?{transaction_id:transaction}:{}),
   current_billing_period:{ends_at:new Date(Date.now()+30*86400000).toISOString()},
   scheduled_change:null,
   items:[{price:{id:price}}],
  }
 };
};
const first=eventPayload("evt_"+"a".repeat(26),"subscription.created","active",paddlePrice,transactionId);
const signedCreated=await webhookSend(first);
assert.equal(signedCreated.status,200,JSON.stringify(signedCreated.body));
assert.equal(signedCreated.body.applied,true);
const firstBilling=await jsonFetch(
 "/api/admin/organizations/"+paddleOrg.item.id+"/billing",{headers:authHeaders});
assert.equal(firstBilling.plan.key,"ci-paddle");
assert.equal(firstBilling.entitled,true);
assert.equal(firstBilling.subscription.externalSubscriptionId,subscriptionId);
const replayCreated=await webhookSend(first);
assert.equal(replayCreated.status,200);
assert.equal(replayCreated.body.applied,false);
const paused=await webhookSend(
 eventPayload("evt_"+"b".repeat(26),"subscription.paused","paused",paddlePrice));
assert.equal(paused.status,200,JSON.stringify(paused.body));
const pausedBilling=await jsonFetch(
 "/api/admin/organizations/"+paddleOrg.item.id+"/billing",{headers:authHeaders});
assert.equal(pausedBilling.subscription.status,"paused");
assert.equal(pausedBilling.entitled,false);
const upgraded=await webhookSend(
 eventPayload("evt_"+"d".repeat(26),"subscription.updated","active",upgradePrice));
assert.equal(upgraded.status,200,JSON.stringify(upgraded.body));
const upgradeBilling=await jsonFetch(
 "/api/admin/organizations/"+paddleOrg.item.id+"/billing",{headers:authHeaders});
assert.equal(upgradeBilling.plan.key,"ci-paddle-plus","Paddle portal upgrade must update plan");
assert.equal(upgradeBilling.entitled,true);
assert.equal(upgradeBilling.limits.maxDevices,9);
const unknownPrice=await webhookSend(
 eventPayload("evt_"+"e".repeat(26),"subscription.updated","active","pri_"+"z".repeat(26)));
assert.equal(unknownPrice.status,409,"Unknown Paddle catalog price must not grant privileges");
const noPriceBilling=await jsonFetch(
 "/api/admin/organizations/"+paddleOrg.item.id+"/billing",{headers:authHeaders});
assert.equal(noPriceBilling.plan.key,"ci-paddle-plus","Reject unknown price rather than change entitlement");

// Owner-initiated Paddle support cases are internal records, never provider actions.
const supportMeResponse=await fetch(base+"/api/auth/me",{headers:{Cookie:browserCookies}});
assert.equal(supportMeResponse.status,200);
const supportOrgId=(await supportMeResponse.json()).organizationId;
await acceptanceDb.query(
 `insert into organization_subscriptions(organization_id,plan_key,status,provider)
  values($1,'ci-paddle','active','paddle')
  on conflict(organization_id) do update set plan_key='ci-paddle',status='active',provider='paddle'`,
 [supportOrgId],
);
const supportSessionHeaders={Cookie:browserCookies,"Content-Type":"application/json","X-CSRF-Token":browserLogin.csrfToken};
const supportPayload=JSON.stringify({type:"refund",message:"I would like a refund review, please."});
const requestFromApiKey=await fetch(base+"/api/billing/support-requests",{
 method:"POST",headers:{"Content-Type":"application/json",...authHeaders},body:supportPayload,
});
assert.equal(requestFromApiKey.status,403,"Support requests must originate from a human owner session");
const supportViewer=await acceptanceDb.query(
 `insert into users(email,password_hash,email_verified_at)
  select 'billing-viewer-fixture@example.test',password_hash,now() from users where id=$1 returning id`,
 [browserMe.userId]);
await acceptanceDb.query(
 "insert into organization_members(organization_id,user_id,role) values($1,$2,'viewer')",
 [supportOrgId,supportViewer.rows[0].id]);
const viewerLogin=await fetch(base+"/api/auth/login",{
 method:"POST",headers:{"Content-Type":"application/json"},
 body:JSON.stringify({email:"billing-viewer-fixture@example.test",password:"correct-horse-battery-staple"}),
});
assert.equal(viewerLogin.status,200);
const viewerCookies=viewerLogin.headers.getSetCookie().map(value=>value.split(";")[0]).join("; ");
const viewerSupportRequest=await fetch(base+"/api/billing/support-requests",{headers:{Cookie:viewerCookies}});
assert.equal(viewerSupportRequest.status,403,"Refund details are visible only to workspace owners");
const supportSubmitted=await fetch(base+"/api/billing/support-requests",{
 method:"POST",headers:supportSessionHeaders,body:supportPayload,
});
assert.equal(supportSubmitted.status,201,JSON.stringify(await supportSubmitted.clone().json()));
const requestId=(await supportSubmitted.json()).item.id;
const duplicateSupport=await fetch(base+"/api/billing/support-requests",{
 method:"POST",headers:supportSessionHeaders,body:supportPayload,
});
assert.equal(duplicateSupport.status,409,"Duplicate open refund requests are blocked");
const customerRequests=await fetch(base+"/api/billing/support-requests",{headers:{Cookie:browserCookies}});
assert.equal(customerRequests.status,200);
assert.ok((await customerRequests.json()).items.some(item=>item.id===requestId&&item.status==="pending"));
await acceptanceDb.query(
 "insert into platform_administrators(user_id,granted_by) values($1,'integration-test') on conflict(user_id) do update set revoked_at=null",
 [browserMe.userId],
);
const adminRequestView=await fetch(base+"/api/console/billing/requests",{headers:{Cookie:browserCookies}});
assert.equal(adminRequestView.status,200);
assert.ok((await adminRequestView.json()).items.some(item=>item.id===requestId));
const reviewBody=(currentPassword,status="in_review")=>JSON.stringify({
 id:requestId,status,note:"The request is being checked against provider records.",currentPassword,
});
const wrongReview=await fetch(base+"/api/console/billing/requests/review",{
 method:"POST",headers:supportSessionHeaders,body:reviewBody("wrong-password-value"),
});
assert.equal(wrongReview.status,403,"Support review must require fresh administrator password");
const review=await fetch(base+"/api/console/billing/requests/review",{
 method:"POST",headers:supportSessionHeaders,body:reviewBody("correct-horse-battery-staple"),
});
assert.equal(review.status,200);
assert.equal((await review.json()).providerActionPerformed,false);
const reviewed=await acceptanceDb.query(
 "select status from billing_support_requests where id=$1",[requestId]);
assert.equal(reviewed.rows[0].status,"in_review");
const unchangedSubscription=await acceptanceDb.query(
 "select status from organization_subscriptions where organization_id=$1",[supportOrgId]);
assert.equal(unchangedSubscription.rows[0].status,"active","Review cannot mutate Paddle entitlement");
const closeRequest=await fetch(base+"/api/console/billing/requests/review",{
 method:"POST",headers:supportSessionHeaders,body:reviewBody("correct-horse-battery-staple","closed"),
});
assert.equal(closeRequest.status,200);
const secondClose=await fetch(base+"/api/console/billing/requests/review",{
 method:"POST",headers:supportSessionHeaders,body:reviewBody("correct-horse-battery-staple","closed"),
});
assert.equal(secondClose.status,409);
await acceptanceDb.query("delete from billing_support_requests where id=$1",[requestId]);
await acceptanceDb.query("delete from users where id=$1",[supportViewer.rows[0].id]);
await acceptanceDb.query("update platform_administrators set revoked_at=now() where user_id=$1",[browserMe.userId]);

// Monthly tool-call quota: a workspace whose plan allows 0 calls gets a clear
// error from /mcp tools/call and nothing reaches a device.
{
  await acceptanceDb.query(
    `insert into billing_plans(key,name,max_devices,max_members,max_api_tokens,metadata,active)
     values('ci-quota','CI Quota',1,1,1,'{"monthlyToolCalls":0}'::jsonb,true) on conflict (key) do nothing`,
  );
  const quotaOrg = await jsonFetch("/api/organizations", {
    method: "POST", headers: authHeaders, body: JSON.stringify({ name: "CI Quota" }),
  });
  await assignSubscription(quotaOrg.item.id, "ci-quota");
  const quotaToken = await jsonFetch("/api/tokens", {
    method: "POST", headers: authHeaders,
    body: JSON.stringify({ name: "CI Quota", role: "operator", organizationId: quotaOrg.item.id }),
  });
  const quotaHeaders = { Authorization: `Bearer ${quotaToken.token}`, "Content-Type": "application/json" };
  const blocked = await rpcAs(quotaHeaders, 9901, "tools/call", { name: "devices_list", arguments: {} });
  assert.equal(blocked.result.isError, true);
  const reason = JSON.parse(blocked.result.content[0].text);
  assert.equal(reason.error, "monthly_tool_call_limit");
  assert.equal(reason.limit, 0);
  assert.match(reason.upgrade_url, /\/pricing$/);
  const listed = await rpcAs(quotaHeaders, 9902, "tools/list");
  assert.ok(listed.result.tools.length > 0, "tools/list is not counted or blocked");
}

const browserLogoutResponse = await fetch(base + "/api/auth/logout", {
  method: "POST",
  headers: {
    Cookie: browserCookies,
    "Content-Type": "application/json",
    "X-CSRF-Token": browserLogin.csrfToken,
  },
  body: "{}",
});
assert.equal(browserLogoutResponse.status, 200);
const revokedBrowserSession = await fetch(base + "/api/auth/me", {
  headers: { Cookie: browserCookies },
});
assert.equal(revokedBrowserSession.status, 401);

socket.close();
// Later CI suites run against this database in SaaS mode: leave the free plan on.
await acceptanceDb.query("update billing_plans set active=true where key='free'");
await acceptanceDb.end();
console.log("integration: ok");
