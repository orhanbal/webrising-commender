import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db.js";
import { sendMail, smtpConfigured } from "./mailer.js";

type Queryable = typeof db | PoolClient;

type MailPayload = {
  to: string;
  subject: string;
  text: string;
};

function outboxKey() {
  const secret = String(
    process.env.MAIL_OUTBOX_ENCRYPTION_SECRET ||
      process.env.APPROVAL_SIGNING_SECRET ||
      "",
  );
  if (secret.length < 32) {
    throw new Error("MAIL_OUTBOX_ENCRYPTION_SECRET or APPROVAL_SIGNING_SECRET must be at least 32 characters");
  }
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.alloc(0),
      Buffer.from("commender-mail-outbox-v1", "utf8"),
      32,
    ),
  );
}

function encryptPayload(payload: MailPayload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", outboxKey(), iv);
  cipher.setAAD(Buffer.from("commender-mail-outbox-v1", "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptPayload(row: {
  payload_ciphertext: string;
  payload_iv: string;
  payload_tag: string;
}) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    outboxKey(),
    Buffer.from(row.payload_iv, "base64url"),
  );
  decipher.setAAD(Buffer.from("commender-mail-outbox-v1", "utf8"));
  decipher.setAuthTag(Buffer.from(row.payload_tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.payload_ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as MailPayload;
  if (
    !parsed ||
    typeof parsed.to !== "string" ||
    typeof parsed.subject !== "string" ||
    typeof parsed.text !== "string"
  ) {
    throw new Error("invalid_mail_outbox_payload");
  }
  return parsed;
}

export async function enqueueMail(
  queryable: Queryable,
  input: MailPayload,
  expiresInMinutes: number | null = null,
) {
  const encrypted = encryptPayload(input);
  const result = await queryable.query<{ id: string }>(
    "insert into mail_outbox(payload_ciphertext,payload_iv,payload_tag,expires_at) values($1,$2,$3,case when $4::int is null then null else now()+($4::int * interval '1 minute') end) returning id::text",
    [encrypted.ciphertext, encrypted.iv, encrypted.tag, expiresInMinutes],
  );
  return result.rows[0]!.id;
}

function errorText(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function retrySeconds(attempts: number) {
  return Math.min(
    3600,
    Math.max(5, 5 * 2 ** Math.min(10, Math.max(0, attempts - 1))),
  );
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
    "     and (expires_at is null or expires_at>now())",
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
    " returning m.id::text,m.payload_ciphertext,m.payload_iv,m.payload_tag,m.attempts",
  ].join("\n");
  const claimed = await db.query<{
    id: string;
    payload_ciphertext: string;
    payload_iv: string;
    payload_tag: string;
    attempts: number;
  }>(sql, [Math.max(1, Math.min(100, limit)), leaseToken]);

  let sent = 0;
  let failed = 0;
  for (const item of claimed.rows) {
    try {
      const payload = decryptPayload(item);
      await sendMail(payload);
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
      process.stderr.write("mail outbox worker failed: " + errorText(error) + "\n");
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), 2000);
  timer.unref();
  return () => clearInterval(timer);
}
