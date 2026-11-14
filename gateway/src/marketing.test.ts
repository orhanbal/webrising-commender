import test from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL ??= "postgres://unused/unused";
const { inAudience, validScore, npsScore, audienceSchema, campaignSchema } = await import("./marketing.js");

test("audience filters by platform, plan and account age", () => {
  const all = audienceSchema.parse({});
  assert.equal(inAudience(all, "windows", null, 0), true);
  const a = audienceSchema.parse({ platforms: ["windows", "macos"], plans: ["pro"], minDays: 7, maxDays: 90 });
  assert.equal(inAudience(a, "windows", "pro", 10), true);
  assert.equal(inAudience(a, "linux", "pro", 10), false);
  assert.equal(inAudience(a, "windows", "free", 10), false);
  assert.equal(inAudience(a, "windows", null, 10), false);
  assert.equal(inAudience(a, "windows", "pro", 3), false);
  assert.equal(inAudience(a, "windows", "pro", 91), false);
});

test("scores fit the survey kind", () => {
  assert.equal(validScore("csat", 5), true);
  assert.equal(validScore("csat", 0), false);
  assert.equal(validScore("nps", 0), true);
  assert.equal(validScore("nps", 11), false);
  assert.equal(validScore("announcement", null), true);
  assert.equal(validScore("announcement", 3), false);
});

test("NPS is promoters minus detractors", () => {
  assert.equal(npsScore([]), null);
  assert.equal(npsScore([{ score: 10, n: 6 }, { score: 8, n: 2 }, { score: 3, n: 2 }]), 40);
});

test("campaign links must be https", () => {
  assert.throws(() => campaignSchema.parse({ kind: "announcement", title: "x", ctaUrl: "javascript:alert(1)" }));
  assert.throws(() => campaignSchema.parse({ kind: "announcement", title: "x", ctaUrl: "http://example.com" }));
  assert.equal(campaignSchema.parse({ kind: "tip", title: "x", ctaUrl: "https://wecommander.app/x" }).ctaUrl, "https://wecommander.app/x");
});
