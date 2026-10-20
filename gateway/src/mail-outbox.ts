import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db.js";
import { sendMail, smtpConfigured } from "./mailer.js";

type Queryable = typeof db | PoolClient;

export async function enqueueMail(
  queryable: Queryable,
  input: { to: string; subject: string; text: string },
) {
  const result = await queryable.query<{ id: string }>(
    "insert into mail_outbox(to_address,subject,body_text) values($1,$2,$3) returning id::text",
    [input.to, input.subject, input.text],
  );
  return result.rows[0]!.id;
}

function errorText(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\\r\\n]+/g, " ").slice(0, 1000);
}

function retrySeconds(attempts: number) {
  return Math.min(3600, Math.max(5, 5 * 2 ** Math.min(10, Math.max(0, attempts - 1))));
}

export async function drainMailOutbox(limit = 10) {
  if (!smtpConfigured()) return { claimed: 0, sent: 0, failed: 0 };

  const leaseToken = crypto.randomUUID();
  const sql = [
    "with candidates as (",
    "  select id",
    "    from mail_outbox",
    "   where sent_at is null",
    "     and next_attempt_at<=now()",
    "     and (lease_until is null or lease_until<now())",
    "   order by created_at asc",
    "   limit $1",
    "   for update skip locked",
    ")",
    "update mail_outbox m",
    "   set lease_until=now()+interval '5 minutes',",
    "       lease_token=$2,",
    "       attempts=attempts+1",
    "  from candidates c",
    " where m.id=c.id",
    " returning m.id::text,m.to_address,m.subject,m.body_text,m.attempts",
  ].join("\\n");
  const claimed = await db.query<{
    id: string;
    to_address: string;
    subject: string;
    body_text: string;
    attempts: number;
  }>(sql, [Math.max(1, Math.min(100, limit)), leaseToken]);

  let sent = 0;
  let failed = 0;
  for (const item of claimed.rows) {
    try {
      await sendMail({ to: item.to_address, subject: item.subject, text: item.body_text });
      await db.query(
        "update mail_outbox set sent_at=now(),lease_until=null,lease_token=null,last_error=null where id=$1::bigint and lease_token=$2",
        [item.id, leaseToken],
      );
      sent += 1;
    } catch (error) {
      const delay = retrySeconds(item.attempts);
      await db.query(
        "update mail_outbox set next_attempt_at=now()+($3::int * interval '1 second'),lease_until=null,lease_token=null,last_error=$4 where id=$1::bigint and lease_token=$2",
        [item.id, leaseToken, delay, errorText(error)],
      );
      failed += 1;
    }
  }

  return { claimed: claimed.rowCount ?? 0, sent, failed };
}

export function startMailOutboxWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await drainMailOutbox();
    } catch (error) {
      process.stderr.write("mail outbox worker failed: " + errorText(error) + "\\n");
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 2000);
  timer.unref();
  return () => clearInterval(timer);
}
