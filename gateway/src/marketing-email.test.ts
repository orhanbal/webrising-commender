import test from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL ??= "postgres://unused/unused";
process.env.CONTROL_API_KEY ||= "x".repeat(32);
process.env.APPROVAL_SIGNING_SECRET ||= "y".repeat(32);
process.env.MAIL_OUTBOX_KEY = "11".repeat(32);
const { audienceCondition, emailAudienceSchema, emailSchema, mailText, unsubscribeLinks, validUnsubscribe } = await import("./marketing-email.js");

const user = "6b1f2c1e-8a8e-4d0a-9a43-3f1c6f1d2b7a";

test("only opted-in, verified, active people are reached", () => {
  const all = audienceCondition(emailAudienceSchema.parse({}), 0);
  assert.match(all.sql, /u\.marketing_opt_in/);
  assert.match(all.sql, /email_verified_at is not null/);
  assert.match(all.sql, /disabled_at is null/);
  assert.deepEqual(all.params, []);
});

test("audience parameters are numbered after the caller's own", () => {
  const c = audienceCondition(emailAudienceSchema.parse({ plans: ["pro"], minDays: 7, maxDays: 30 }), 2);
  assert.deepEqual(c.params, [["pro"], 7, 30]);
  assert.match(c.sql, /\$3::text\[\]/);
  assert.match(c.sql, /\$4::int/);
  assert.match(c.sql, /\$5::int/);
});

test("every mail ends with an unsubscribe link that only works for its owner", () => {
  const links = unsubscribeLinks("https://wecommander.app", user)!;
  assert.match(links.page, /^https:\/\/wecommander\.app\/unsubscribe\?u=/);
  assert.match(links.oneClick, /^https:\/\/wecommander\.app\/api\/unsubscribe\?u=/);
  const digest = new URL(links.page).searchParams.get("t")!;
  assert.equal(validUnsubscribe(user, digest), true);
  assert.equal(validUnsubscribe("00000000-0000-4000-8000-000000000000", digest), false);
  assert.equal(validUnsubscribe(user, digest.slice(0, -1) + (digest.endsWith("A") ? "B" : "A")), false);
  assert.equal(validUnsubscribe(user, ""), false);
  const text = mailText("Merhaba\n", links.page);
  assert.ok(text.startsWith("Merhaba\n\n—\n"));
  assert.ok(text.includes(links.page));
});

test("a campaign needs a subject and a body", () => {
  assert.equal(emailSchema.safeParse({ subject: "", body: "x" }).success, false);
  assert.equal(emailSchema.safeParse({ subject: "x", body: " " }).success, false);
  assert.equal(emailSchema.safeParse({ subject: "Yeni sürüm", body: "Merhaba" }).success, true);
});
