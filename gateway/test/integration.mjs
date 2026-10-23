import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
const advancedResponse=await fetch(base+"/advanced");
assert.equal(advancedResponse.status,200);
const advancedHtml=await advancedResponse.text();
assert.match(advancedHtml, />Devices</);
assert.match(advancedHtml, /Plan &amp; billing/);
assert.match(advancedHtml, />Settings</);

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
const { Client } = pg;
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

const outboxStatus = await jsonFetch("/api/admin/mail/outbox?limit=10", {
  headers: authHeaders,
});
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
assert.equal(signupBillingBody.entitled, false);
assert.equal(signupBillingBody.reason, "billing_required");

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
// Verify revisioned CMS draft, publication, rollback and safe HTML metadata rendering.
const cmsSessionHeaders={Cookie:browserCookies,"Content-Type":"application/json","X-CSRF-Token":browserLogin.csrfToken};
const draftCms=async(title,metadata)=>fetch(base+"/api/console/site-content",{
  method:"POST",headers:cmsSessionHeaders,body:JSON.stringify({
    locale:"en",heroTitle:title,heroSubtitle:"Safe integrated landing subtitle",
    seoTitle:metadata,seoDescription:'Description with <script> and "quotes"',
    overrides:{"Cihaz yönetiminde":"Managed capabilities heading"},
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

const approvedRequest = await jsonFetch(
  `/api/approval-requests/${pendingPayload.approval_request_id}/approve`,
  {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  },
);
assert.equal(approvedRequest.item.status, "approved");

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
assert.match(memberInvitation.inviteUrl, /#invite=wrci_/);

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
await acceptanceDb.end();
console.log("integration: ok");
