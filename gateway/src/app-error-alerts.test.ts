import test from "node:test";
import assert from "node:assert/strict";
import type { AlertDeps } from "./app-error-alerts.js";
process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.CONTROL_API_KEY ||= "x".repeat(32);
process.env.APPROVAL_SIGNING_SECRET ||= "y".repeat(32);
const { appErrorFingerprint, errorType, normalizeFrame, recordAppErrorKind } = await import("./app-error-alerts.js");

const windowsDetail = (user: string, line: number) =>
  `System.InvalidOperationException: Sequence contains no elements for 'host-${line}'\n` +
  `   at System.Linq.ThrowHelper.ThrowNoElementsException()\n` +
  `   at Wecommander.Center.Core.TeamSync.MergeAsync(String id) in D:\\a\\webrising-commender\\Core\\TeamSync.cs:line ${line}\n` +
  `   at Wecommander.Center.App.<TickAsync>d__12.MoveNext() in C:\\Users\\${user}\\src\\App.xaml.cs:line ${line + 7}`;

const macDetail = (address: string, offset: number) =>
  `NSRangeException: index 5 beyond bounds\n` +
  `0   CoreFoundation      ${address} __exceptionPreprocess + ${offset}\n` +
  `1   libobjc.A.dylib     0x00000001891f6c18 objc_exception_throw + 60\n` +
  `2   WecommanderCenter   0x0000000102a3b4c0 $s17WecommanderCenter8AppModelC4tickyyF + ${offset * 2}`;

test("same error from two users and two builds is one kind", () => {
  const a = appErrorFingerprint({ platform: "windows", message: "InvalidOperationException: Sequence contains no elements", detail: windowsDetail("orhan", 35) });
  const b = appErrorFingerprint({ platform: "windows", message: "InvalidOperationException: Sequence contains no elements", detail: windowsDetail("venture", 41) });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
  const m1 = appErrorFingerprint({ platform: "macos", message: "NSRangeException: index 5 beyond bounds", detail: macDetail("0x0000000189640ec0", 164) });
  const m2 = appErrorFingerprint({ platform: "macos", message: "NSRangeException: index 9 beyond bounds", detail: macDetail("0x00000001a0000000", 172) });
  assert.equal(m1, m2);
});

test("a different stack, type or platform is a new kind", () => {
  const base = { platform: "windows", message: "InvalidOperationException: x", detail: windowsDetail("orhan", 35) };
  const other = { ...base, detail: base.detail.replace("TeamSync.MergeAsync", "TeamSync.PushAsync") };
  assert.notEqual(appErrorFingerprint(base), appErrorFingerprint(other));
  assert.notEqual(appErrorFingerprint(base), appErrorFingerprint({ ...base, platform: "macos" }));
  assert.notEqual(appErrorFingerprint(base), appErrorFingerprint({ ...base, message: "IOException: x", detail: base.detail.replace("System.InvalidOperationException", "System.IO.IOException") }));
});

test("without a stack the normalised message tells kinds apart", () => {
  const prev = (build: number, when: string) => ({ platform: "windows",
    message: `InvalidOperationException: The app ended unexpectedly in its previous run (build ${build}, started ${when}).`, detail: "" });
  assert.equal(appErrorFingerprint(prev(410, "2026-11-01T10:00:00+03:00")), appErrorFingerprint(prev(415, "2026-11-19T08:12:44+01:00")));
  assert.notEqual(appErrorFingerprint(prev(410, "x")), appErrorFingerprint({ platform: "windows", message: "InvalidOperationException: Disk full", detail: "" }));
});

test("error type and frame normalisation", () => {
  assert.equal(errorType("System.IO.IOException: The pipe is broken"), "System.IO.IOException");
  assert.equal(errorType("something odd happened"), "Error");
  assert.equal(normalizeFrame("   at Foo.Bar() in C:\\Users\\orhan\\x.cs:line 12"), "Foo.Bar()");
  assert.equal(normalizeFrame("3   WecommanderCenter   0x0000000102a3b4c0 main + 44"), "WecommanderCenter <addr> main");
});

type Row = { fingerprint: string; alert: string | null; alertedAt: number | null };

function fakeDeps(options: { admins?: string[]; mailReady?: boolean; env?: Record<string, string> } = {}) {
  const kinds = new Map<string, Row>();
  const mails: Array<{ to: string; subject: string; text: string }> = [];
  const logs: string[] = [];
  const deps: Partial<AlertDeps> = {
    mailReady: () => options.mailReady ?? true,
    baseUrl: "https://wecommander.example",
    env: options.env ?? {},
    log: (line) => logs.push(line),
    enqueue: async (mail) => { mails.push(mail); },
    query: async (text, values = []) => {
      if (text.includes("insert into app_error_kinds")) {
        const fp = String(values[0]);
        if (kinds.has(fp)) return { rows: [{ inserted: false }] };
        kinds.set(fp, { fingerprint: fp, alert: null, alertedAt: null });
        return { rows: [{ inserted: true }] };
      }
      if (text.startsWith("update app_error_kinds")) {
        const row = kinds.get(String(values[0]))!;
        row.alert = String(values[1]);
        row.alertedAt = Date.now();
        return { rows: [] };
      }
      if (text.includes("filter (where alert='mail')")) {
        const recent = [...kinds.values()].filter((r) => r.alertedAt !== null);
        return { rows: [{ mails: recent.filter((r) => r.alert === "mail").length, summaries: recent.filter((r) => r.alert === "summary").length }] };
      }
      if (text.includes("from platform_administrators")) return { rows: (options.admins ?? ["root@example.com"]).map((email) => ({ email })) };
      throw new Error("unexpected query: " + text);
    },
  };
  return { deps, mails, logs, kinds };
}

const report = (n: number, secret = "") => ({
  platform: "macos", build: "512",
  message: `NSInternalInconsistencyException: broken ${secret}`,
  detail: `NSInternalInconsistencyException: broken ${secret}\n0   WecommanderCenter   0x0000000102a3b4c0 Frame${"abcdefghijklmnopqrstuvwxyz"[n % 26]}${"ABCDEFGHIJ"[Math.floor(n / 26) % 10]} + 4\n` +
    `1   WecommanderCenter   0x0000000102a3b4c0 /Users/orhan/secret/path + 8`,
});

test("the first report of a kind mails every super admin once; repeats do not", async () => {
  const { deps, mails } = fakeDeps({ admins: ["a@example.com", "b@example.com"] });
  const first = await recordAppErrorKind(report(1, "password=hunter2 Authorization: Bearer abc.def"), deps);
  assert.equal(first.firstSeen, true);
  assert.equal(first.alert, "mail");
  assert.deepEqual(mails.map((m) => m.to), ["a@example.com", "b@example.com"]);
  const again = await recordAppErrorKind(report(1, "password=other"), deps);
  assert.equal(again.firstSeen, false);
  assert.equal(mails.length, 2, "a known kind never mails again");
  const text = mails[0]!.subject + mails[0]!.text;
  assert.match(text, /macos/);
  assert.match(text, /512/);
  assert.match(text, /https:\/\/wecommander\.example\/console\/growth\/feedback/);
  assert.match(text, /Frame/);
  assert.doesNotMatch(text, /hunter2|abc\.def|orhan/, "secrets and user folder names never reach the mail");
});

test("at most N new-kind mails an hour, then one summary, then silence (still recorded)", async () => {
  const { deps, mails, kinds } = fakeDeps({ env: { APP_ERROR_ALERTS_PER_HOUR: "3" } });
  const alerts: Array<string | null> = [];
  for (let i = 0; i < 6; i++) alerts.push((await recordAppErrorKind(report(i), deps)).alert);
  assert.deepEqual(alerts, ["mail", "mail", "mail", "summary", "suppressed", "suppressed"]);
  assert.equal(mails.length, 4);
  assert.match(mails[3]!.subject, /more than 3 new kinds/);
  assert.equal(kinds.size, 6, "every kind is recorded");
});

test("switched off or mail not configured: recorded, not mailed, never silent", async () => {
  const off = fakeDeps({ env: { APP_ERROR_ALERTS: "0" } });
  assert.equal((await recordAppErrorKind(report(1), off.deps)).alert, "off");
  assert.equal(off.mails.length, 0);
  const noMail = fakeDeps({ mailReady: false });
  assert.equal((await recordAppErrorKind(report(1), noMail.deps)).alert, "off");
  assert.equal(noMail.mails.length, 0);
  assert.match(noMail.logs[0]!, /mail is not configured/);
});
