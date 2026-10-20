import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import type { PoolClient } from "pg";
import { db } from "./db.js";
import { redact } from "./security.js";

export type MailKind = "email_verification" | "password_reset";
export type MailDeliveryMode = "disabled" | "outbox" | "smtp";
export type SmtpSecurity = "plain" | "starttls" | "tls";

export type SmtpConfig = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
  from: string;
  fromName: string;
  helo: string;
  rejectUnauthorized: boolean;
  allowInsecureAuth: boolean;
};

export type OutboundMail = {
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
};

type SmtpSocket = net.Socket | tls.TLSSocket;
type Queryable = typeof db | PoolClient;

function enumEnv<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  const normalized = String(value ?? fallback).trim().toLowerCase() as T;
  if (!allowed.includes(normalized)) throw new Error(`invalid configuration value: ${normalized}`);
  return normalized;
}

export const mailDeliveryMode = enumEnv(
  process.env.MAIL_DELIVERY_MODE,
  ["disabled", "outbox", "smtp"] as const,
  "disabled",
);

export function smtpConfigFromEnv(): SmtpConfig {
  const security = enumEnv(
    process.env.SMTP_SECURITY,
    ["plain", "starttls", "tls"] as const,
    "plain",
  );
  const host = String(process.env.SMTP_HOST || "127.0.0.1").trim();
  const portValue = Number(process.env.SMTP_PORT || (security === "tls" ? 465 : 25));
  const port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65535 ? portValue : 25;
  const username = String(process.env.SMTP_USERNAME || "").trim() || null;
  const password = process.env.SMTP_PASSWORD ? String(process.env.SMTP_PASSWORD) : null;
  const from = String(process.env.MAIL_FROM || "commender@localhost").trim();
  const fromName = String(process.env.MAIL_FROM_NAME || "WebRising Commender").trim();
  const helo = String(process.env.SMTP_HELO || os.hostname() || "localhost").trim();
  const rejectUnauthorized = !/^(0|false|no)$/i.test(
    String(process.env.SMTP_TLS_REJECT_UNAUTHORIZED ?? "true"),
  );
  const allowInsecureAuth = /^(1|true|yes)$/i.test(
    String(process.env.SMTP_ALLOW_INSECURE_AUTH || ""),
  );

  validateAddress(from);
  if (!!username !== !!password) {
    throw new Error("SMTP_USERNAME and SMTP_PASSWORD must be configured together");
  }
  if (
    username &&
    security === "plain" &&
    !allowInsecureAuth &&
    !["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase())
  ) {
    throw new Error(
      "SMTP authentication over plaintext is disabled; use starttls/tls or SMTP_ALLOW_INSECURE_AUTH=true",
    );
  }

  return {
    host,
    port,
    security,
    username,
    password,
    from,
    fromName,
    helo,
    rejectUnauthorized,
    allowInsecureAuth,
  };
}

export function mailDeliveryAvailable() {
  return mailDeliveryMode !== "disabled";
}

function assertNoHeaderInjection(value: string, field: string) {
  if (/[
]/.test(value)) throw new Error(`invalid ${field}`);
}

function validateAddress(value: string) {
  assertNoHeaderInjection(value, "email");
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(value)) throw new Error("invalid email address");
}

function encodedWord(value: string) {
  assertNoHeaderInjection(value, "header");
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function normalizeCrlf(value: string) {
  return value.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

export function formatSmtpMessage(config: SmtpConfig, mail: OutboundMail) {
  validateAddress(mail.to);
  validateAddress(config.from);
  assertNoHeaderInjection(mail.subject, "subject");
  assertNoHeaderInjection(config.fromName, "from name");

  const messageId = `<${crypto.randomUUID()}@${config.helo.replace(/[^a-zA-Z0-9.-]/g, "") || "localhost"}>`;
  const headers = [
    `From: ${encodedWord(config.fromName)} <${config.from}>`,
    `To: <${mail.to}>`,
    `Subject: ${encodedWord(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  return headers.join("\r\n") + "\r\n\r\n" + normalizeCrlf(mail.text) + "\r\n";
}

function waitForConnect(socket: SmtpSocket, event: "connect" | "secureConnect") {
  return new Promise<void>((resolve, reject) => {
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off(event, onReady);
      socket.off("error", onError);
    };
    socket.once(event, onReady);
    socket.once("error", onError);
  });
}

function readResponse(socket: SmtpSocket) {
  return new Promise<{ code: number; lines: string[] }>((resolve, reject) => {
    let buffer = "";
    const lines: string[] = [];

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error("smtp connection closed"));
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline + 1).replace(/\r?\n$/, "");
        buffer = buffer.slice(newline + 1);
        lines.push(line);
        const match = line.match(/^(\d{3})([ -])/);
        if (match?.[2] === " ") {
          cleanup();
          resolve({ code: Number(match[1]), lines });
          return;
        }
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function command(socket: SmtpSocket, value: string, expected: number | number[]) {
  assertNoHeaderInjection(value, "smtp command");
  socket.write(value + "\r\n");
  const response = await readResponse(socket);
  const expectedCodes = Array.isArray(expected) ? expected : [expected];
  if (!expectedCodes.includes(response.code)) {
    throw new Error(`smtp ${response.code}: ${response.lines.join(" | ").slice(0, 500)}`);
  }
  return response;
}

function tlsOptions(config: SmtpConfig) {
  return {
    servername: net.isIP(config.host) ? undefined : config.host,
    rejectUnauthorized: config.rejectUnauthorized,
  };
}

export async function sendSmtpMail(config: SmtpConfig, mail: OutboundMail) {
  validateAddress(mail.to);
  let socket: SmtpSocket;

  if (config.security === "tls") {
    const secure = tls.connect({
      host: config.host,
      port: config.port,
      ...tlsOptions(config),
    });
    socket = secure;
    await waitForConnect(secure, "secureConnect");
  } else {
    const plain = net.createConnection({ host: config.host, port: config.port });
    socket = plain;
    await waitForConnect(plain, "connect");
  }

  socket.setTimeout(20_000, () => socket.destroy(new Error("smtp timeout")));

  try {
    const greeting = await readResponse(socket);
    if (greeting.code !== 220) throw new Error(`smtp greeting ${greeting.code}`);

    await command(socket, `EHLO ${config.helo}`, 250);

    if (config.security === "starttls") {
      await command(socket, "STARTTLS", 220);
      const secure = tls.connect({
        socket: socket as net.Socket,
        ...tlsOptions(config),
      });
      socket = secure;
      await waitForConnect(secure, "secureConnect");
      socket.setTimeout(20_000, () => socket.destroy(new Error("smtp timeout")));
      await command(socket, `EHLO ${config.helo}`, 250);
    }

    if (config.username && config.password) {
      const auth = Buffer.from(`\0${config.username}\0${config.password}`, "utf8").toString("base64");
      await command(socket, `AUTH PLAIN ${auth}`, 235);
    }

    await command(socket, `MAIL FROM:<${config.from}>`, 250);
    await command(socket, `RCPT TO:<${mail.to}>`, [250, 251]);
    await command(socket, "DATA", 354);

    const data = formatSmtpMessage(config, mail);
    socket.write(data + ".\r\n");
    const accepted = await readResponse(socket);
    if (accepted.code !== 250) throw new Error(`smtp data ${accepted.code}`);

    try {
      await command(socket, "QUIT", 221);
    } catch {}
  } finally {
    socket.end();
    socket.destroy();
  }
}

export async function queueMail(mail: OutboundMail, queryable: Queryable = db) {
  if (!mailDeliveryAvailable()) throw new Error("mail_delivery_unavailable");
  validateAddress(mail.to);
  assertNoHeaderInjection(mail.subject, "subject");
  await queryable.query(
    `insert into mail_outbox(kind,to_email,subject,text_body)
     values($1,$2,$3,$4)`,
    [mail.kind, mail.to, mail.subject, mail.text],
  );
}

async function claimOutboxBatch(limit = 10) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query<{
      id: string;
      kind: MailKind;
      to_email: string;
      subject: string;
      text_body: string;
      attempts: number;
    }>(
      `select id,kind,to_email,subject,text_body,attempts
         from mail_outbox
        where sent_at is null
          and text_body is not null
          and available_at<=now()
        order by created_at asc
        for update skip locked
        limit $1`,
      [limit],
    );
    for (const row of result.rows) {
      await client.query(
        "update mail_outbox set attempts=attempts+1,available_at=now()+interval '5 minutes' where id=$1",
        [row.id],
      );
      row.attempts += 1;
    }
    await client.query("commit");
    return result.rows;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deliverOutboxOnce(config = smtpConfigFromEnv()) {
  if (mailDeliveryMode !== "smtp") return { attempted: 0, sent: 0, failed: 0 };

  const batch = await claimOutboxBatch();
  let sent = 0;
  let failed = 0;
  for (const row of batch) {
    try {
      await sendSmtpMail(config, {
        kind: row.kind,
        to: row.to_email,
        subject: row.subject,
        text: row.text_body,
      });
      await db.query(
        "update mail_outbox set sent_at=now(),text_body=null,last_error=null where id=$1",
        [row.id],
      );
      sent += 1;
    } catch (error) {
      const retrySeconds = Math.min(3600, 30 * 2 ** Math.min(7, Math.max(0, row.attempts - 1)));
      await db.query(
        "update mail_outbox set available_at=now()+($2::int * interval '1 second'),last_error=$3 where id=$1",
        [
          row.id,
          retrySeconds,
          redact(error instanceof Error ? error.message : String(error)).slice(0, 1000),
        ],
      );
      failed += 1;
    }
  }
  return { attempted: batch.length, sent, failed };
}

export function startMailWorker() {
  if (mailDeliveryMode !== "smtp") return () => {};

  const config = smtpConfigFromEnv();
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await deliverOutboxOnce(config);
    } catch (error) {
      process.stderr.write(
        `mail worker failed: ${redact(error instanceof Error ? error.message : String(error))}\n`,
      );
    } finally {
      busy = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), 10_000);
  timer.unref();
  return () => clearInterval(timer);
}
