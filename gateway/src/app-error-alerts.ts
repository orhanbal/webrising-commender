// Errors must never be silent: every app error report is grouped into a
// "kind" by a stable fingerprint (platform + error type + top stack frames,
// with user paths, addresses and numbers normalised away), and the first
// report of a kind never seen before e-mails the platform super admins.
//
// Rate limited across all organizations: at most APP_ERROR_ALERTS_PER_HOUR
// (default 20) new-kind mails an hour; after that one summary mail, and the
// rest of that hour's new kinds are only recorded (Console → Growth → Feedback).
// APP_ERROR_ALERTS=0 turns the mails off (default on).
//
// Mail text only carries scrubbed (no user folder names) and redacted (no
// tokens, passwords, connection strings) report text.

import crypto from "node:crypto";
import { db } from "./db.js";
import { enqueueMail, mailConfigured } from "./mail.js";
import { scrubUserPaths } from "./scrub.js";
import { redactSecrets } from "./security.js";

type Query = (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
type Mail = { to: string; subject: string; text: string };

export type AppErrorReport = { platform: string; build: string; message: string; detail: string };

export type AlertDeps = {
  query: Query;
  enqueue: (mail: Mail) => Promise<unknown>;
  mailReady: () => boolean;
  baseUrl: string;
  env: Record<string, string | undefined>;
  log: (line: string) => void;
};

const defaultDeps = (): AlertDeps => ({
  query: (text, values) => db.query(text, values as unknown[]),
  enqueue: (mail) => enqueueMail(mail),
  mailReady: mailConfigured,
  baseUrl: process.env.PUBLIC_BASE_URL || "",
  env: process.env,
  log: (line) => process.stderr.write(line + "\n"),
});

const FRAMES = 5;
const MAX_RECIPIENTS = 10;

/** Report text safe to store or mail: user folder names and secrets removed. */
export function cleanErrorText(text: string) {
  return redactSecrets(scrubUserPaths(text)).replace(/\u0000/g, "");
}

/** "System.IO.IOException: …" / "NSRangeException: …" → the type; "Error" when none is named. */
export function errorType(message: string, detail = "") {
  for (const text of [message, detail.split("\n", 1)[0] ?? ""]) {
    const match = text.match(/^\s*([A-Za-z_][\w.`$<>+]{0,120}?)\s*:\s/);
    if (match) return match[1]!.replace(/\d+/g, "#");
  }
  return "Error";
}

/** A stack frame: .NET/JS "   at …", Apple callStackSymbols "3  Module  0x… sym + 12", Rust/gdb "#3 …". */
function isFrame(line: string) {
  return /^\s+at\s/.test(line) || /^\s*\d+\s+\S+\s+0x[0-9a-f]+\s/i.test(line) || /^\s*#\d+\s/.test(line);
}

/** One frame with everything that differs between users, builds and runs removed. */
export function normalizeFrame(line: string) {
  return scrubUserPaths(line).trim()
    .replace(/^#?\d+\s+/, "")            // frame index
    .replace(/^at\s+/, "")
    .replace(/\s+in\s+(?:[A-Za-z]:\\|\/).*$/, "") // .NET " in C:\build\path\File.cs:line 35" (not Swift "closure #1 in f()")
    .replace(/0x[0-9a-f]+/gi, "<addr>")       // addresses
    .replace(/\s*\+\s*\d+\s*$/, "")       // Apple "+ 123" offsets
    .replace(/\((?:file:\/\/)?[^()]*[\/\\][^()]*\)$/, "") // JS "(path/file.js:10:5)"
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** The message without the varying parts (quoted text, numbers, ids, paths). */
export function normalizeMessage(message: string) {
  return scrubUserPaths(message)
    .replace(/"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’/g, "…")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#")
    .replace(/0x[0-9a-f]+/gi, "<addr>")
    .replace(/[A-Za-z]:\\[^\s]+|\/[^\s]+/g, "…")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export function topFrames(detail: string, count = FRAMES) {
  return detail.split(/\r?\n/).filter(isFrame).map(normalizeFrame).filter(Boolean).slice(0, count);
}

/** Same platform, type and top frames = same kind, whoever reported it and in whichever build. */
export function appErrorFingerprint(report: Pick<AppErrorReport, "platform" | "message" | "detail">) {
  const frames = topFrames(report.detail);
  // Without a stack the message (normalised) is all that tells kinds apart.
  const where = frames.length ? frames.join("\n") : normalizeMessage(report.message);
  return crypto.createHash("sha256")
    .update([report.platform, errorType(report.message, report.detail), where].join("\n"))
    .digest("hex").slice(0, 32);
}

function alertsEnabled(env: AlertDeps["env"]) {
  const raw = env.APP_ERROR_ALERTS;
  return raw === undefined || raw === "" || /^(1|true|yes|on)$/i.test(raw);
}

function perHour(env: AlertDeps["env"]) {
  const value = Number(env.APP_ERROR_ALERTS_PER_HOUR ?? 20);
  return Number.isFinite(value) ? Math.min(1000, Math.max(1, Math.floor(value))) : 20;
}

const oneLine = (text: string, max: number) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Counts the report into its kind; the first report of a new kind mails the
 * super admins (within the hourly limit). Returns what happened.
 */
export async function recordAppErrorKind(
  report: AppErrorReport & { fingerprint?: string },
  overrides: Partial<AlertDeps> = {},
): Promise<{ fingerprint: string; firstSeen: boolean; alert: "mail" | "summary" | "suppressed" | "off" | null }> {
  const deps = { ...defaultDeps(), ...overrides };
  const fingerprint = report.fingerprint ?? appErrorFingerprint(report);
  const type = errorType(report.message, report.detail);
  const build = oneLine(cleanErrorText(report.build), 40);
  const message = oneLine(cleanErrorText(report.message), 500);
  // xmax=0 only for the row this statement inserted: atomic "first seen".
  const upsert = await deps.query(
    `insert into app_error_kinds(fingerprint,platform,error_type,first_build,last_build,message)
     values($1,$2,$3,$4,$4,$5)
     on conflict (fingerprint) do update set report_count=app_error_kinds.report_count+1,
       last_seen_at=now(), last_build=excluded.last_build
     returning (xmax=0) as inserted`,
    [fingerprint, report.platform, type, build, message],
  );
  if (!upsert.rows[0]?.inserted) return { fingerprint, firstSeen: false, alert: null };

  const mark = (alert: string) => deps.query(
    "update app_error_kinds set alert=$2,alerted_at=now() where fingerprint=$1", [fingerprint, alert]);
  if (!alertsEnabled(deps.env)) {
    await mark("off");
    return { fingerprint, firstSeen: true, alert: "off" };
  }
  if (!deps.mailReady()) {
    await mark("off");
    deps.log(`app error alert: new kind ${fingerprint} (${report.platform} ${type}) not mailed: mail is not configured`);
    return { fingerprint, firstSeen: true, alert: "off" };
  }

  const recent = await deps.query(
    `select count(*) filter (where alert='mail')::int as mails,
            count(*) filter (where alert='summary')::int as summaries
       from app_error_kinds where alerted_at > now() - interval '1 hour'`,
  );
  const limit = perHour(deps.env);
  const mails = Number(recent.rows[0]?.mails ?? 0);
  const summaries = Number(recent.rows[0]?.summaries ?? 0);
  const alert = mails < limit ? "mail" : summaries === 0 ? "summary" : "suppressed";
  await mark(alert);
  if (alert === "suppressed") return { fingerprint, firstSeen: true, alert };

  const recipients = await deps.query(
    `select u.email from platform_administrators p join users u on u.id=p.user_id
      where p.revoked_at is null and u.disabled_at is null and u.email is not null
      order by p.granted_at asc limit $1`,
    [MAX_RECIPIENTS],
  );
  if (!recipients.rows.length) {
    deps.log(`app error alert: new kind ${fingerprint} not mailed: no platform super admin with an e-mail address`);
    return { fingerprint, firstSeen: true, alert };
  }

  const base = deps.baseUrl.replace(/\/+$/, "");
  const link = /^https?:\/\//.test(base) ? `${base}/console/growth/feedback` : "Console → Growth → Feedback";
  const stack = cleanErrorText(report.detail).split(/\r?\n/).map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""))
    .filter((line) => line.trim()).slice(0, 12).map((line) => line.slice(0, 300)).join("\n");
  const mail: Mail = alert === "mail" ? {
    to: "",
    subject: oneLine(`WECOMMANDER: new app error (${report.platform}, build ${build}): ${message}`, 160),
    text:
      `A kind of app error never seen before was reported.\n\n` +
      `Platform: ${report.platform}\nBuild: ${build}\nType: ${type}\nMessage: ${message}\n` +
      `Kind: ${fingerprint}\n\nFirst stack lines:\n${stack || "(none)"}\n\n` +
      `How often it recurs, and which builds: ${link}\n\n` +
      `Only the first report of each kind is mailed (at most ${limit} an hour).`,
  } : {
    to: "",
    subject: oneLine(`WECOMMANDER: more than ${limit} new kinds of app error in the last hour`, 160),
    text:
      `More than ${limit} new kinds of app error were reported in the last hour. ` +
      `New kinds are still recorded, but not mailed one by one until the hour has passed.\n\n` +
      `Latest: ${report.platform}, build ${build}: ${message}\n\nAll of them: ${link}`,
  };
  for (const { email } of recipients.rows) await deps.enqueue({ ...mail, to: String(email) });
  return { fingerprint, firstSeen: true, alert };
}
