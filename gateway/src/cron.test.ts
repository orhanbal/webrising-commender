import assert from "node:assert/strict";
import test from "node:test";
import {
  isValidTimeZone, localToInstants, nextCron, nextRun, parseCron, previewRuns, ScheduleError, validateSchedule,
} from "./cron.js";

const iso = (d: Date | null) => d?.toISOString() ?? null;
const next = (expr: string, after: string, tz = "UTC") => iso(nextCron(parseCron(expr), new Date(after), tz));
function series(expr: string, after: string, tz: string, n: number) {
  const out: string[] = [];
  let at = new Date(after);
  for (let i = 0; i < n; i++) {
    const d = nextCron(parseCron(expr), at, tz)!;
    out.push(d.toISOString());
    at = d;
  }
  return out;
}

test("cron parser accepts lists, ranges, steps and names", () => {
  const spec = parseCron("0,30 9-17/2 * jan-MAR mon-fri");
  assert.deepEqual(spec.minutes, [0, 30]);
  assert.deepEqual(spec.hours, [9, 11, 13, 15, 17]);
  assert.deepEqual(spec.months.map((v, i) => (v ? i : -1)).filter((i) => i > 0), [1, 2, 3]);
  assert.deepEqual(spec.dows.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCron("5/20 * * * *").minutes, [5, 25, 45]);
  assert.deepEqual(parseCron("*/15 * * * *").minutes, [0, 15, 30, 45]);
  assert.equal(parseCron("0 0 * * 7").dows[0], true, "7 is Sunday");
  assert.equal(parseCron("  0   0  * * *  ").hours[0], 0, "extra spaces are fine");
});

test("cron parser rejects malformed expressions with a reason", () => {
  for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *",
    "* * * * 8", "*/0 * * * *", "5-1 * * * *", "a * * * *", "1,,2 * * * *", "1-2-3 * * * *", "*/1/2 * * * *",
    "-1 * * * *", "* * * foo *", "@daily"]) {
    assert.throws(() => parseCron(bad), ScheduleError, bad);
  }
});

test("next run in UTC and in a fixed-offset zone (Europe/Istanbul, no DST)", () => {
  assert.equal(next("*/15 * * * *", "2026-11-17T10:07:00Z"), "2026-11-17T10:15:00.000Z");
  assert.equal(next("*/15 * * * *", "2026-11-17T10:15:00Z"), "2026-11-17T10:30:00.000Z", "strictly after");
  assert.equal(next("0 0 1 1 *", "2026-11-17T10:07:00Z"), "2027-01-01T00:00:00.000Z");
  // 09:00 Istanbul (UTC+3) on weekdays; 2026-11-21 is a Saturday.
  assert.equal(next("0 9 * * 1-5", "2026-11-21T08:00:00Z", "Europe/Istanbul"), "2026-11-23T06:00:00.000Z");
  assert.equal(next("30 23 * * *", "2026-11-17T20:00:00Z", "Europe/Istanbul"), "2026-11-17T20:30:00.000Z");
});

test("day of month and day of week: either matches when both are set", () => {
  // The 13th or any Friday. 2026-11-17 is a Tuesday; Friday is the 20th, the 13th of December is a Sunday.
  assert.deepEqual(series("0 0 13 * 5", "2026-11-17T00:00:00Z", "UTC", 4),
    ["2026-11-20T00:00:00.000Z", "2026-11-27T00:00:00.000Z", "2026-12-04T00:00:00.000Z", "2026-12-11T00:00:00.000Z"]);
  assert.equal(next("0 0 13 * 5", "2026-12-11T00:00:00Z"), "2026-12-13T00:00:00.000Z");
  assert.equal(next("0 0 1-7 * mon", "2026-11-17T00:00:00Z"), "2026-11-23T00:00:00.000Z");
  // A field starting with "*" keeps AND semantics: Mondays on odd days only.
  assert.equal(next("0 0 */2 * mon", "2026-11-24T00:00:00Z"), "2026-12-07T00:00:00.000Z");
  assert.equal(next("0 0 29 2 *", "2026-11-17T00:00:00Z"), "2028-02-29T00:00:00.000Z");
});

test("America/New_York spring forward: a skipped local time runs after the change", () => {
  // 2026-03-08 02:00 EST -> 03:00 EDT. 02:30 does not exist: it runs at 03:30 EDT.
  assert.deepEqual(series("30 2 * * *", "2026-03-07T12:00:00Z", "America/New_York", 3),
    ["2026-03-08T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
  // A 15-minute job keeps a real 15-minute rhythm through the gap.
  assert.deepEqual(series("*/15 * * * *", "2026-03-08T06:30:00Z", "America/New_York", 5),
    ["2026-03-08T06:45:00.000Z", "2026-03-08T07:00:00.000Z", "2026-03-08T07:15:00.000Z",
      "2026-03-08T07:30:00.000Z", "2026-03-08T07:45:00.000Z"]);
  assert.deepEqual(localToInstants(Date.UTC(2026, 2, 8, 2, 30), "America/New_York"), [Date.UTC(2026, 2, 8, 7, 30)]);
});

test("America/New_York fall back: fixed hours run once, wildcard hours every real hour", () => {
  // 2026-11-01 02:00 EDT -> 01:00 EST: 01:30 happens twice.
  assert.deepEqual(series("30 1 * * *", "2026-10-31T12:00:00Z", "America/New_York", 2),
    ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  assert.deepEqual(series("30 * * * *", "2026-11-01T04:00:00Z", "America/New_York", 4),
    ["2026-11-01T04:30:00.000Z", "2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z", "2026-11-01T07:30:00.000Z"]);
  assert.deepEqual(localToInstants(Date.UTC(2026, 10, 1, 1, 30), "America/New_York"),
    [Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30)]);
});

test("Europe/Berlin DST in both directions", () => {
  // 2026-03-29 02:00 CET -> 03:00 CEST (01:00Z).
  assert.equal(next("0 2 * * *", "2026-03-28T12:00:00Z", "Europe/Berlin"), "2026-03-29T01:00:00.000Z");
  assert.equal(next("0 2 * * *", "2026-03-29T01:00:00Z", "Europe/Berlin"), "2026-03-30T00:00:00.000Z");
  assert.deepEqual(series("*/30 * * * *", "2026-03-29T00:15:00Z", "Europe/Berlin", 4),
    ["2026-03-29T00:30:00.000Z", "2026-03-29T01:00:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-29T02:00:00.000Z"]);
  // 2026-10-25 03:00 CEST -> 02:00 CET (01:00Z): 02:15 happens twice, a daily job runs once.
  assert.deepEqual(series("15 2 * * *", "2026-10-24T12:00:00Z", "Europe/Berlin", 2),
    ["2026-10-25T00:15:00.000Z", "2026-10-26T01:15:00.000Z"]);
  // A daily 09:00 job stays at 09:00 local on both sides of the change.
  assert.deepEqual(series("0 9 * * *", "2026-10-24T00:00:00Z", "Europe/Berlin", 3),
    ["2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z"]);
});

test("intervals skip missed slots (no catch-up) and once runs a single time", () => {
  const anchor = new Date("2026-11-17T10:00:00Z");
  const interval = { kind: "interval" as const, minutes: 15 };
  assert.equal(iso(nextRun(interval, "UTC", new Date("2026-11-17T10:00:00Z"), anchor)), "2026-11-17T10:15:00.000Z");
  // Gateway was down for hours: the next slot is the next one on the grid, not the missed ones.
  assert.equal(iso(nextRun(interval, "UTC", new Date("2026-11-17T13:07:00Z"), anchor)), "2026-11-17T13:15:00.000Z");
  const once = { kind: "once" as const, at: "2026-12-01T09:00:00+03:00" };
  assert.equal(iso(nextRun(once, "Europe/Istanbul", new Date("2026-11-17T10:00:00Z"))), "2026-12-01T06:00:00.000Z");
  assert.equal(nextRun(once, "Europe/Istanbul", new Date("2026-12-01T06:00:00Z")), null);
});

test("preview gives the next five runs", () => {
  const from = new Date("2026-11-17T10:07:00Z");
  assert.deepEqual(previewRuns({ kind: "cron", expr: "0 * * * *" }, "UTC", from).map((d) => d.toISOString()),
    ["2026-11-17T11:00:00.000Z", "2026-11-17T12:00:00.000Z", "2026-11-17T13:00:00.000Z",
      "2026-11-17T14:00:00.000Z", "2026-11-17T15:00:00.000Z"]);
  assert.deepEqual(previewRuns({ kind: "interval", minutes: 60 }, "UTC", from).map((d) => d.toISOString()).slice(0, 2),
    ["2026-11-17T11:07:00.000Z", "2026-11-17T12:07:00.000Z"]);
  assert.equal(previewRuns({ kind: "once", at: "2026-11-18T00:00:00Z" }, "UTC", from).length, 1);
});

test("time zones are IANA names only", () => {
  for (const ok of ["Europe/Istanbul", "America/New_York", "UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+3"]) {
    assert.equal(isValidTimeZone(ok), true, ok);
  }
  for (const bad of ["", "+03:00", "Mars/Base", "Europe/Istanbul; drop", "../etc", 42, null]) {
    assert.equal(isValidTimeZone(bad), false, String(bad));
  }
  assert.throws(() => validateSchedule({ kind: "cron", expr: "0 0 31 2 *" }, "UTC"), /never matches/);
  assert.throws(() => validateSchedule({ kind: "cron", expr: "0 0 * * *" }, "Nowhere/City"), /time zone/);
  assert.doesNotThrow(() => validateSchedule({ kind: "cron", expr: "0 0 * * *" }, "Europe/Istanbul"));
});

test("next-run computation stays fast for every-minute schedules", () => {
  const started = performance.now();
  let at = new Date("2026-03-08T05:00:00Z");
  for (let i = 0; i < 500; i++) at = nextCron(parseCron("* * * * *"), at, "America/New_York")!;
  assert.equal(at.toISOString(), "2026-03-08T13:20:00.000Z");
  assert.ok(performance.now() - started < 3_000);
});
