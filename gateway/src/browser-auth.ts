import crypto from "node:crypto";
import { randomToken, sha256 } from "./crypto-utils.js";

export const sessionCookieName = "commender_session";
export const csrfCookieName = "commender_csrf";

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function scrypt(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt);
  return `scrypt$v1$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, version, saltEncoded, keyEncoded] = encoded.split("$");
  if (algorithm !== "scrypt" || version !== "v1" || !saltEncoded || !keyEncoded) return false;

  try {
    const expected = Buffer.from(keyEncoded, "base64url");
    const actual = await scrypt(password, Buffer.from(saltEncoded, "base64url"));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function browserSessionSeconds() {
  const hours = Number(process.env.BROWSER_SESSION_HOURS ?? 12);
  const boundedHours = Number.isFinite(hours) ? Math.min(720, Math.max(1, Math.floor(hours))) : 12;
  return boundedHours * 60 * 60;
}

export function newBrowserSessionMaterial() {
  const sessionToken = "wrcs_" + randomToken(32);
  const csrfToken = "wrcc_" + randomToken(24);
  return {
    sessionToken,
    sessionHash: sha256(sessionToken),
    csrfToken,
    csrfHash: sha256(csrfToken),
  };
}

export function sessionTokenFromCookie(header: string | undefined) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== sessionCookieName) continue;
    const value = part.slice(separator + 1).trim();
    return value.startsWith("wrcs_") ? value : null;
  }
  return null;
}

function cookieBase(name: string, value: string, maxAge: number, secure: boolean, httpOnly: boolean) {
  return [
    `${name}=${value}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
    "SameSite=Strict",
    httpOnly ? "HttpOnly" : "",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

export function authCookies(sessionToken: string, csrfToken: string, maxAge: number, secure: boolean) {
  return [
    cookieBase(sessionCookieName, sessionToken, maxAge, secure, true),
    cookieBase(csrfCookieName, csrfToken, maxAge, secure, false),
  ];
}

export function clearAuthCookies(secure: boolean) {
  return [
    cookieBase(sessionCookieName, "", 0, secure, true),
    cookieBase(csrfCookieName, "", 0, secure, false),
  ];
}
