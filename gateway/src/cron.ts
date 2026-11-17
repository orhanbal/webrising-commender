// Schedule engine for WECOMMANDER scheduled tasks: standard 5-field cron
// ("m h dom mon dow"), fixed intervals and one-off times, evaluated in an
// IANA time zone with daylight-saving transitions handled explicitly.
//
// DST rules (documented in docs/SCHEDULED_TASKS.md):
// - A local time that does not exist (spring forward gap) runs at the same
//   wall-clock offset after the change: 02:30 on a 02:00->03:00 night runs at
//   03:30, so a daily job is never silently skipped.
// - A local time that happens twice (fall back) runs once, at the first
//   occurrence, unless the hour field is a wildcard ("30 * * * *"): an hourly
//   or more frequent job keeps running every real hour through the repeat.
// - Day-of-month / day-of-week follow classic (Vixie) cron: when both are
//   restricted, a day matches if EITHER matches.

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

export type Schedule =
  | { kind: "cron"; expr: string }
  | { kind: "interval"; minutes: number }
  | { kind: "once"; at: string };

export type CronSpec = {
  minutes: number[];
  hours: number[];
  doms: boolean[]; // index 1..31
  months: boolean[]; // index 1..12
  dows: boolean[]; // index 0..6 (0 = Sunday)
  domStar: boolean;
  dowStar: boolean;
  hourStar: boolean;
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

type FieldDef = { name: string; min: number; max: number; names?: string[]; namesOffset?: number };
const FIELDS: FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, namesOffset: 1 },
  // 7 is accepted as Sunday, like most crons.
  { name: "day of week", min: 0, max: 7, names: DOW_NAMES, namesOffset: 0 },
];

function parseValue(raw: string, def: FieldDef): number {
  const lower = raw.toLowerCase();
  if (def.names) {
    const index = def.names.indexOf(lower);
    if (index >= 0) return index + (def.namesOffset ?? 0);
  }
  if (!/^\d{1,2}$/.test(raw)) throw new ScheduleError(`${def.name}: "${raw}" is not a number`);
  const value = Number(raw);
  if (value < def.min || value > def.max) {
    throw new ScheduleError(`${def.name}: ${value} is outside ${def.min}-${def.max}`);
  }
  return value;
}

function parseField(text: string, def: FieldDef): { values: Set<number>; star: boolean } {
  if (!text) throw new ScheduleError(`${def.name}: empty field`);
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) throw new ScheduleError(`${def.name}: empty list item`);
    const [base, stepText, extra] = part.split("/");
    if (extra !== undefined || base === undefined || base === "") {
      throw new ScheduleError(`${def.name}: "${part}" is not valid`);
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1) {
        throw new ScheduleError(`${def.name}: step "${stepText}" must be a positive number`);
      }
      step = Number(stepText);
      if (step > def.max - def.min + 1) throw new ScheduleError(`${def.name}: step ${step} is too large`);
    }
    let start: number;
    let end: number;
    if (base === "*") {
      start = def.min;
      end = def.max;
    } else if (base.includes("-")) {
      const [a, b, more] = base.split("-");
      if (more !== undefined || !a || !b) throw new ScheduleError(`${def.name}: "${base}" is not a valid range`);
      start = parseValue(a, def);
      end = parseValue(b, def);
      if (start > end) throw new ScheduleError(`${def.name}: range ${base} goes backwards`);
    } else {
      start = parseValue(base, def);
      // "5/15" means 5, 20, 35, 50 (from 5 to the end of the field).
      end = stepText !== undefined ? def.max : start;
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return { values, star: text.startsWith("*") };
}

const cronCache = new Map<string, CronSpec>();

export function parseCron(expr: string): CronSpec {
  if (typeof expr !== "string") throw new ScheduleError("cron expression must be text");
  const normalized = expr.trim().replace(/\s+/g, " ");
  const cached = cronCache.get(normalized);
  if (cached) return cached;
  if (normalized.length > 200) throw new ScheduleError("cron expression is too long");
  const parts = normalized.split(" ");
  if (parts.length !== 5 || normalized === "") {
    throw new ScheduleError("cron expression needs exactly 5 fields: minute hour day-of-month month day-of-week");
  }
  const [mi, ho, dm, mo, dw] = parts.map((p, i) => parseField(p, FIELDS[i]!));
  const dows = new Array<boolean>(7).fill(false);
  for (const v of dw!.values) dows[v % 7] = true;
  const doms = new Array<boolean>(32).fill(false);
  for (const v of dm!.values) doms[v] = true;
  const months = new Array<boolean>(13).fill(false);
  for (const v of mo!.values) months[v] = true;
  const spec: CronSpec = {
    minutes: [...mi!.values].sort((a, b) => a - b),
    hours: [...ho!.values].sort((a, b) => a - b),
    doms,
    months,
    dows,
    domStar: dm!.star,
    dowStar: dw!.star,
    hourStar: ho!.star,
  };
  if (cronCache.size > 2_000) cronCache.clear();
  cronCache.set(normalized, spec);
  return spec;
}

// ---------------------------------------------------------------------------
// Time zones

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    if (formatterCache.size > 500) formatterCache.clear();
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Whether `name` is an IANA time zone name (no raw UTC offsets). */
export function isValidTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || name.length < 1 || name.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,3}$/.test(name)) return false;
  try {
    formatter(name).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock time minus UTC, in milliseconds, at the instant `utcMs`. */
export function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const seconds = Math.floor(utcMs / 1000) * 1000;
  const parts = formatter(timeZone).formatToParts(new Date(seconds));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return local - seconds;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The UTC instants a local wall-clock time (`naive`, as if it were UTC) maps
 * to: one normally, two in a fall-back repeat, and for a spring-forward gap
 * the time shifted by the gap.
 */
export function localToInstants(
  naive: number,
  timeZone: string,
  keepBoth = true,
  offsetAt: (utcMs: number) => number = (utcMs) => zoneOffsetMs(utcMs, timeZone),
): number[] {
  const before = offsetAt(naive - DAY);
  const after = offsetAt(naive + DAY);
  const candidates = [...new Set([naive - before, naive - after])]
    .filter((c) => c + offsetAt(c) === naive)
    .sort((a, b) => a - b);
  if (candidates.length === 0) return [naive - before];
  return keepBoth ? candidates : candidates.slice(0, 1);
}

/** First minute in [from, to] whose offset differs from `offset` (binary search). */
function transitionAfter(from: number, to: number, offset: number, timeZone: string) {
  let lo = Math.floor(from / MINUTE);
  let hi = Math.ceil(to / MINUTE);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (zoneOffsetMs(mid * MINUTE, timeZone) === offset) lo = mid + 1;
    else hi = mid;
  }
  return lo * MINUTE;
}

// ---------------------------------------------------------------------------
// Next run computation

const MAX_SEARCH_DAYS = 366 * 8 + 2; // covers Feb 29 schedules

function dayMatches(spec: CronSpec, dayMs: number) {
  const d = new Date(dayMs);
  if (!spec.months[d.getUTCMonth() + 1]) return false;
  const dom = spec.doms[d.getUTCDate()]!;
  const dow = spec.dows[d.getUTCDay()]!;
  return spec.domStar || spec.dowStar ? dom && dow : dom || dow;
}

/** The first instant strictly after `after` that matches the cron spec in `timeZone`, or null. */
export function nextCron(spec: CronSpec, after: Date, timeZone: string): Date | null {
  const afterMs = after.getTime();
  const naiveAfter = afterMs + zoneOffsetMs(afterMs, timeZone);
  const firstDay = Math.floor(naiveAfter / DAY) * DAY - DAY; // one day back covers zone shifts
  let best: number | null = null;
  let bestNaive = 0;
  for (let d = 0; d < MAX_SEARCH_DAYS; d++) {
    const dayMs = firstDay + d * DAY;
    if (best !== null && dayMs > bestNaive + 3 * HOUR) break;
    if (!dayMatches(spec, dayMs)) continue;
    // Fast path: no offset change around this day, so local times map to
    // instants by one subtraction and in order.
    const offset = zoneOffsetMs(dayMs - 2 * DAY, timeZone);
    const laterOffset = zoneOffsetMs(dayMs + 2 * DAY, timeZone);
    const stable = offset === laterOffset;
    // Otherwise one transition sits in the window; locate it once per day.
    const transition = stable ? 0 : transitionAfter(dayMs - 2 * DAY, dayMs + 2 * DAY, offset, timeZone);
    const offsetAt = (utcMs: number) => (utcMs < transition ? offset : laterOffset);
    for (const h of spec.hours) {
      for (const m of spec.minutes) {
        const naive = dayMs + h * HOUR + m * MINUTE;
        // Offsets differ by less than a day; skip the clearly-past quickly.
        if (naive < naiveAfter - 3 * HOUR) continue;
        if (best !== null && naive > bestNaive + 3 * HOUR) break;
        if (stable) {
          const instant = naive - offset;
          if (instant > afterMs) {
            if (best === null || instant < best) return new Date(instant);
            return new Date(best);
          }
          continue;
        }
        for (const instant of localToInstants(naive, timeZone, spec.hourStar, offsetAt)) {
          if (instant > afterMs && (best === null || instant < best)) {
            best = instant;
            bestNaive = naive;
          }
        }
      }
    }
  }
  return best === null ? null : new Date(best);
}

/**
 * The next run of a schedule strictly after `after`. For intervals, runs are
 * anchored at `anchor` (the previous scheduled time or the creation time) and
 * missed slots are skipped: there is never a catch-up storm.
 */
export function nextRun(schedule: Schedule, timeZone: string, after: Date, anchor?: Date): Date | null {
  switch (schedule.kind) {
    case "cron":
      return nextCron(parseCron(schedule.expr), after, timeZone);
    case "interval": {
      const step = schedule.minutes * MINUTE;
      const base = (anchor ?? after).getTime();
      const afterMs = after.getTime();
      if (base > afterMs) return new Date(base);
      const k = Math.floor((afterMs - base) / step) + 1;
      return new Date(base + k * step);
    }
    case "once": {
      const at = new Date(schedule.at);
      return at.getTime() > after.getTime() ? at : null;
    }
  }
}

/** The next `count` run times after `from` (fewer when the schedule ends). */
export function previewRuns(schedule: Schedule, timeZone: string, from: Date, count = 5): Date[] {
  const out: Date[] = [];
  let after = from;
  let anchor: Date | undefined = schedule.kind === "interval" ? from : undefined;
  for (let i = 0; i < count; i++) {
    const next = nextRun(schedule, timeZone, after, anchor);
    if (!next) break;
    out.push(next);
    after = next;
    anchor = next;
  }
  return out;
}

/** Throws ScheduleError when the schedule cannot run (bad cron, bad zone). */
export function validateSchedule(schedule: Schedule, timeZone: string) {
  if (!isValidTimeZone(timeZone)) throw new ScheduleError(`unknown time zone "${String(timeZone)}"`);
  if (schedule.kind === "cron") {
    const spec = parseCron(schedule.expr);
    if (!nextCron(spec, new Date(), timeZone)) throw new ScheduleError("this cron expression never matches a date");
  }
  if (schedule.kind === "once" && Number.isNaN(new Date(schedule.at).getTime())) {
    throw new ScheduleError("the run time is not a valid date");
  }
}
