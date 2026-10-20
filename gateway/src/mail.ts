import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import type { PoolClient } from "pg";
import { db } from "./db.js";
import { redact, sha256 } from "./security.js";

type Queryable = typeof db | PoolClient;
type WireSocket = Socket | TLSSocket;

type MailPayload = {
  to: string;
  subject: string;
  text: string;
};

type SmtpResponse = {
  code: number;
  lines: string[];
};

const workerId = crypto.randomUUID();

function boolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function intEnv(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function encryptionKey() {
  const raw = String(process.env.MAIL_OUTBOX_KEY || "").trim();
  if (!raw) return null;

  const candidates: Buffer[] = [];
  if (/^[0-9a-f]{64}$/i.test(raw)) candidates.push(Buffer.from(raw, "hex"));
  try {
    candidates.push(Buffer.from(raw, "base64url"));
  } catch {}
  try {
    candidates.push(Buffer.from(raw, "base64"));
  } catch {}

  return candidates.find((candidate) => candidate.length === 32) ?? null;
}

export function mailConfigured() {
  return Boolean(
    String(process.env.SMTP_HOST || "").trim() &&
      String(process.env.SMTP_FROM || "").trim() &&
      encryptionKey(),
  );
}

export function publicSignupEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.PUBLIC_SIGNUP_ENABLED || ""));
}

function encryptPayload(payload: MailPayload) {
  const key = encryptionKey();
  if (!key) throw new Error("mail_outbox_key_not_configured");

  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

function decryptPayload(row: {
  payload_nonce: string;
  payload_ciphertext: string;
  payload_tag: string;
}): MailPayload {
  const key = encryptionKey();
  if (!key) throw new Error("mail_outbox_key_not_configured");

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(row.payload_nonce, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(row.payload_tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.payload_ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");

  const parsed = JSON.parse(plaintext) as MailPayload;
  if (!parsed.to || !parsed.subject || !parsed.text) {
    throw new Error("invalid_mail_payload");
  }
  return parsed;
}

export async function enqueueMail(
  payload: MailPayload,
  queryable: Queryable = db,
) {
  const encrypted = encryptPayload(payload);
  const result = await queryable.query(
    `insert into mail_outbox(
       recipient_hash,payload_nonce,payload_ciphertext,payload_tag
     )
     values($1,$2,$3,$4)
     returning id,created_at`,
    [
      sha256(payload.to.trim().toLowerCase()),
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.tag,
    ],
  );
  return result.rows[0];
}

function sanitizeHeader(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function envelopeAddress(value: string) {
  const clean = sanitizeHeader(value);
  const match = clean.match(/<([^<>]+)>/);
  return (match?.[1] || clean).trim();
}

function dotStuff(body: string) {
  return body
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? "." + line : line))
    .join("\r\n");
}

class SmtpConnection {
  private socket: WireSocket | null = null;
  private buffer = "";
  private lines: string[] = [];
  private waiters: Array<() => void> = [];
  private lastError: Error | null = null;

  private attach(socket: WireSocket) {
    this.socket = socket;
    socket.setTimeout(intEnv("SMTP_TIMEOUT_MS", 10_000, 1_000, 120_000));
    socket.on("timeout", () => socket.destroy(new Error("smtp_timeout")));
    socket.on("error", (error) => {
      this.lastError = error;
      const waiters = this.waiters.splice(0);
      for (const wake of waiters) wake();
    });
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      while (true) {
        const index = this.buffer.indexOf("\n");
        if (index < 0) break;
        const line = this.buffer.slice(0, index + 1).replace(/\r?\n$/, "");
        this.buffer = this.buffer.slice(index + 1);
        this.lines.push(line);
      }
      const waiters = this.waiters.splice(0);
      for (const wake of waiters) wake();
    });
  }

  private async nextLine() {
    while (this.lines.length === 0) {
      if (this.lastError) throw this.lastError;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    return this.lines.shift()!;
  }

  private async response(): Promise<SmtpResponse> {
    const lines: string[] = [];
    let code = 0;
    while (true) {
      const line = await this.nextLine();
      lines.push(line);
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match) continue;
      const current = Number(match[1]);
      if (!code) code = current;
      if (current === code && match[2] === " ") return { code, lines };
    }
  }

  private write(value: string) {
    if (!this.socket) throw new Error("smtp_not_connected");
    this.socket.write(value);
  }

  private async command(command: string, expected: number[]) {
    this.write(command + "\r\n");
    const response = await this.response();
    if (!expected.includes(response.code)) {
      throw new Error(`smtp_${response.code}_${response.lines.join(" ").slice(0, 240)}`);
    }
    return response;
  }

  async connect() {
    const host = String(process.env.SMTP_HOST || "").trim();
    const port = intEnv("SMTP_PORT", 25, 1, 65535);
    const security = String(process.env.SMTP_SECURITY || "starttls").trim().toLowerCase();
    if (!host) throw new Error("smtp_host_not_configured");
    if (!["none", "starttls", "tls"].includes(security)) {
      throw new Error("invalid_smtp_security");
    }

    if (security === "tls") {
      const socket = tls.connect({
        host,
        port,
        servername: host,
        rejectUnauthorized: boolEnv("SMTP_TLS_REJECT_UNAUTHORIZED", true),
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      this.attach(socket);
    } else {
      const socket = net.createConnection({ host, port });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      this.attach(socket);
    }

    const banner = await this.response();
    if (banner.code !== 220) throw new Error(`smtp_banner_${banner.code}`);

    let ehlo = await this.command(
      `EHLO ${sanitizeHeader(process.env.SMTP_HELO_NAME || "commender.local")}`,
      [250],
    );

    if (security === "starttls") {
      await this.command("STARTTLS", [220]);
      const current = this.socket;
      if (!current) throw new Error("smtp_not_connected");
      current.removeAllListeners("data");
      current.removeAllListeners("timeout");
      current.removeAllListeners("error");
      this.buffer = "";
      this.lines = [];
      this.lastError = null;

      const secure = tls.connect({
        socket: current as Socket,
        servername: host,
        rejectUnauthorized: boolEnv("SMTP_TLS_REJECT_UNAUTHORIZED", true),
      });
      await new Promise<void>((resolve, reject) => {
        secure.once("secureConnect", resolve);
        secure.once("error", reject);
      });
      this.attach(secure);
      ehlo = await this.command(
        `EHLO ${sanitizeHeader(process.env.SMTP_HELO_NAME || "commender.local")}`,
        [250],
      );
    }

    const username = String(process.env.SMTP_USERNAME || "");
    const password = String(process.env.SMTP_PASSWORD || "");
    if (username) {
      const caps = ehlo.lines.join("\n").toUpperCase();
      if (caps.includes("AUTH") && caps.includes("PLAIN")) {
        const encoded = Buffer.from(`\0${username}\0${password}`, "utf8").toString("base64");
        await this.command(`AUTH PLAIN ${encoded}`, [235]);
      } else {
        await this.command("AUTH LOGIN", [334]);
        await this.command(Buffer.from(username, "utf8").toString("base64"), [334]);
        await this.command(Buffer.from(password, "utf8").toString("base64"), [235]);
      }
    }
  }

  async send(payload: MailPayload) {
    const from = String(process.env.SMTP_FROM || "").trim();
    if (!from) throw new Error("smtp_from_not_configured");

    const fromEnvelope = envelopeAddress(from);
    const toEnvelope = envelopeAddress(payload.to);
    await this.command(`MAIL FROM:<${fromEnvelope}>`, [250]);
    await this.command(`RCPT TO:<${toEnvelope}>`, [250, 251]);
    await this.command("DATA", [354]);

    const messageIdDomain = fromEnvelope.includes("@")
      ? fromEnvelope.split("@").pop()
      : "commender.local";
    const headers = [
      `From: ${sanitizeHeader(from)}`,
      `To: ${sanitizeHeader(payload.to)}`,
      `Subject: ${sanitizeHeader(payload.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${messageIdDomain}>`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
    ].join("\r\n");

    this.write(headers + "\r\n\r\n" + dotStuff(payload.text) + "\r\n.\r\n");
    const response = await this.response();
    if (response.code !== 250) {
      throw new Error(`smtp_data_${response.code}_${response.lines.join(" ").slice(0, 240)}`);
    }
  }

  async close() {
    try {
      await this.command("QUIT", [221]);
    } catch {}
    this.socket?.destroy();
    this.socket = null;
  }
}

export async function sendMailNow(payload: MailPayload) {
  const connection = new SmtpConnection();
  try {
    await connection.connect();
    await connection.send(payload);
  } finally {
    await connection.close();
  }
}

function retrySeconds(attempts: number) {
  const sequence = [30, 120, 300, 900, 1800, 3600, 7200, 14400];
  return sequence[Math.min(sequence.length - 1, Math.max(0, attempts))]!;
}

export async function deliverOutboxBatch(limit = 10) {
  if (!mailConfigured()) return { delivered: 0, failed: 0 };

  const claimed = await db.query<{
    id: string;
    payload_nonce: string;
    payload_ciphertext: string;
    payload_tag: string;
    attempts: number;
  }>(
    `with candidates as (
       select id
         from mail_outbox
        where sent_at is null
          and next_attempt_at<=now()
          and (locked_at is null or locked_at<now()-interval '10 minutes')
        order by created_at asc
        for update skip locked
        limit $1
     )
     update mail_outbox m
        set locked_at=now(),locked_by=$2
       from candidates c
      where m.id=c.id
     returning m.id::text,m.payload_nonce,m.payload_ciphertext,m.payload_tag,m.attempts`,
    [Math.max(1, Math.min(100, limit)), workerId],
  );

  let delivered = 0;
  let failed = 0;
  for (const row of claimed.rows) {
    try {
      const payload = decryptPayload(row);
      await sendMailNow(payload);
      await db.query(
        `update mail_outbox
            set sent_at=now(),locked_at=null,locked_by=null,last_error=null
          where id=$1::bigint and locked_by=$2`,
        [row.id, workerId],
      );
      delivered += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 500);
      await db.query(
        `update mail_outbox
            set attempts=$3,
                next_attempt_at=now()+($4::int*interval '1 second'),
                locked_at=null,
                locked_by=null,
                last_error=$5
          where id=$1::bigint and locked_by=$2`,
        [row.id, workerId, attempts, retrySeconds(attempts), message],
      );
      failed += 1;
    }
  }

  return { delivered, failed };
}

export function startMailWorker() {
  if (!mailConfigured()) return null;
  const intervalMs = intEnv("MAIL_DELIVERY_INTERVAL_MS", 5_000, 250, 300_000);
  const batch = intEnv("MAIL_DELIVERY_BATCH", 10, 1, 100);

  const run = () => {
    void deliverOutboxBatch(batch).catch((error) => {
      process.stderr.write(
        `mail delivery failed: ${redact(error instanceof Error ? error.message : error)}\n`,
      );
    });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
