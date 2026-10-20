import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

type SocketLike = net.Socket | tls.TLSSocket;
type SecureMode = "plain" | "starttls" | "tls";

type SmtpConfig = {
  host: string;
  port: number;
  secureMode: SecureMode;
  user: string | null;
  password: string | null;
  from: string;
  helo: string;
  timeoutMs: number;
  rejectUnauthorized: boolean;
};

function boolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  return raw === undefined ? fallback : /^(1|true|yes|on)$/i.test(raw);
}

export function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

export function smtpConfig(): SmtpConfig {
  const host = String(process.env.SMTP_HOST || "").trim();
  const from = String(process.env.SMTP_FROM || "").trim();
  if (!host || !from) throw new Error("smtp_not_configured");

  const mode = String(process.env.SMTP_SECURE_MODE || "starttls").trim().toLowerCase();
  if (mode !== "plain" && mode !== "starttls" && mode !== "tls") {
    throw new Error("invalid_SMTP_SECURE_MODE");
  }

  const port = Number(process.env.SMTP_PORT || (mode === "tls" ? 465 : 587));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid_SMTP_PORT");

  const user = String(process.env.SMTP_USER || "").trim() || null;
  const password = process.env.SMTP_PASSWORD || null;
  if (Boolean(user) !== Boolean(password)) throw new Error("SMTP_USER_password_pair_required");

  const timeoutMs = Number(process.env.SMTP_TIMEOUT_MS || 10000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error("invalid_SMTP_TIMEOUT_MS");
  }

  return {
    host,
    port,
    secureMode: mode,
    user,
    password,
    from,
    helo: String(process.env.SMTP_HELO || "commender.local").trim() || "commender.local",
    timeoutMs: Math.floor(timeoutMs),
    rejectUnauthorized: boolEnv("SMTP_TLS_REJECT_UNAUTHORIZED", true),
  };
}

class LineReader {
  private buffer = "";
  private queue: string[] = [];
  private waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private failure: Error | null = null;

  constructor(socket: SocketLike) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const index = this.buffer.indexOf("\n");
        if (index < 0) break;
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(line);
        else this.queue.push(line);
      }
    });
    const fail = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("smtp_connection_closed")));
  }

  line(timeoutMs: number) {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<string>((resolve, reject) => {
      const waiter = {
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("smtp_read_timeout"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

async function response(reader: LineReader, timeoutMs: number) {
  const lines: string[] = [];
  let code = 0;
  for (;;) {
    const line = await reader.line(timeoutMs);
    const match = line.match(/^(\d{3})([- ])(.*)$/);
    if (!match) throw new Error("invalid_smtp_response");
    lines.push(line);
    code = Number(match[1]);
    if (match[2] === " ") break;
  }
  return { code, lines, text: lines.join("\n") };
}

function requireCode(value: Awaited<ReturnType<typeof response>>, allowed: number[]) {
  if (!allowed.includes(value.code)) throw new Error("smtp_" + value.code + ": " + value.text);
  return value;
}

function writeLine(socket: SocketLike, value: string) {
  socket.write(value + "\r\n");
}

async function command(
  socket: SocketLike,
  reader: LineReader,
  value: string,
  timeoutMs: number,
  allowed: number[],
) {
  writeLine(socket, value);
  return requireCode(await response(reader, timeoutMs), allowed);
}

function openSocket(config: SmtpConfig): Promise<SocketLike> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    if (config.secureMode === "tls") {
      const socket = tls.connect({
        host: config.host,
        port: config.port,
        servername: config.host,
        rejectUnauthorized: config.rejectUnauthorized,
      }, () => resolve(socket));
      socket.setTimeout(config.timeoutMs, () => socket.destroy(new Error("smtp_connect_timeout")));
      socket.once("error", onError);
      return;
    }
    const socket = net.createConnection({ host: config.host, port: config.port }, () => resolve(socket));
    socket.setTimeout(config.timeoutMs, () => socket.destroy(new Error("smtp_connect_timeout")));
    socket.once("error", onError);
  });
}

function caps(value: Awaited<ReturnType<typeof response>>) {
  return value.lines.slice(1).map((line) => line.slice(4).trim().toUpperCase());
}

function safeHeader(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function dotStuff(value: string) {
  return value
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => line.startsWith(".") ? "." + line : line)
    .join("\r\n");
}

export async function sendMail(input: { to: string; subject: string; text: string }) {
  const config = smtpConfig();
  let socket = await openSocket(config);
  let reader = new LineReader(socket);

  try {
    requireCode(await response(reader, config.timeoutMs), [220]);
    let hello = await command(socket, reader, "EHLO " + config.helo, config.timeoutMs, [250]);
    let capabilities = caps(hello);

    if (config.secureMode === "starttls") {
      if (!capabilities.some((value) => value.startsWith("STARTTLS"))) {
        throw new Error("smtp_starttls_not_supported");
      }
      await command(socket, reader, "STARTTLS", config.timeoutMs, [220]);
      socket.removeAllListeners("data");
      const plainSocket = socket;
      socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const wrapped = tls.connect({
          socket: plainSocket,
          servername: config.host,
          rejectUnauthorized: config.rejectUnauthorized,
        }, () => resolve(wrapped));
        wrapped.once("error", reject);
      });
      reader = new LineReader(socket);
      hello = await command(socket, reader, "EHLO " + config.helo, config.timeoutMs, [250]);
      capabilities = caps(hello);
    }

    if (config.user && config.password) {
      const auth = capabilities.find((value) => value.startsWith("AUTH ")) || "";
      if (auth.includes("PLAIN")) {
        const token = Buffer.from("\0" + config.user + "\0" + config.password).toString("base64");
        await command(socket, reader, "AUTH PLAIN " + token, config.timeoutMs, [235]);
      } else if (auth.includes("LOGIN")) {
        await command(socket, reader, "AUTH LOGIN", config.timeoutMs, [334]);
        await command(socket, reader, Buffer.from(config.user).toString("base64"), config.timeoutMs, [334]);
        await command(socket, reader, Buffer.from(config.password).toString("base64"), config.timeoutMs, [235]);
      } else {
        throw new Error("smtp_auth_not_supported");
      }
    }

    await command(socket, reader, "MAIL FROM:<" + config.from + ">", config.timeoutMs, [250]);
    await command(socket, reader, "RCPT TO:<" + input.to + ">", config.timeoutMs, [250, 251]);
    await command(socket, reader, "DATA", config.timeoutMs, [354]);

    const domain = config.helo.replace(/[^a-z0-9.-]/gi, "") || "commender.local";
    const headers = [
      "From: " + safeHeader(config.from),
      "To: " + safeHeader(input.to),
      "Subject: " + safeHeader(input.subject),
      "Date: " + new Date().toUTCString(),
      "Message-ID: <" + crypto.randomUUID() + "@" + domain + ">",
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
    ];
    socket.write(headers.join("\r\n") + "\r\n\r\n" + dotStuff(input.text) + "\r\n.\r\n");
    requireCode(await response(reader, config.timeoutMs), [250]);
    await command(socket, reader, "QUIT", config.timeoutMs, [221]);
  } finally {
    socket.destroy();
  }
}
