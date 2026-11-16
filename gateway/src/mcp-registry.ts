// The official MCP Registry (registry.modelcontextprotocol.io) lists
// WECOMMANDER under our own domain: app.wecommander/wecommander. VS Code,
// Cursor and other MCP clients read their server galleries from it.
//
// Domain proof is "HTTP authentication": the gateway serves an Ed25519 public
// key at /.well-known/mcp-registry-auth and signs a timestamp with the private
// key to get a short-lived publish token. The key pair is derived from the
// gateway's own server secret, so it is never stored, copied or typed by
// anyone, and it stays the same across restarts.
import { createHmac, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { productSummary } from "./site-content.js";

export const REGISTRY_URL = "https://registry.modelcontextprotocol.io";
/** Bump when the listing below changes; the registry refuses the same version twice. */
export const REGISTRY_LISTING_VERSION = "1.0.0";

// PKCS#8 header for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function registryKey(secret: string): { privateKey: KeyObject; publicKeyBase64: string } {
  const seed = createHmac("sha256", secret).update("wecommander-mcp-registry-ed25519-v1").digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return { privateKey, publicKeyBase64: Buffer.from(spki.subarray(spki.length - 32)).toString("base64") };
}

/** The body of /.well-known/mcp-registry-auth. */
export function registryAuthRecord(secret: string) {
  return `v=MCPv1; k=ed25519; p=${registryKey(secret).publicKeyBase64}\n`;
}

/** app.wecommander for wecommander.app (reverse DNS). */
export function namespaceFor(origin: string) {
  return new URL(origin).hostname.split(".").reverse().join(".");
}

/** The registry entry (server.json, schema 2025-12-11): our remote MCP endpoint, OAuth sign-in. */
export function registryServerJson(origin: string) {
  const summary = productSummary.length <= 100 ? productSummary
    : "SSH client, server management and one remote MCP URL for your machines, with human approvals.";
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: `${namespaceFor(origin)}/wecommander`,
    title: "WECOMMANDER",
    description: summary,
    version: REGISTRY_LISTING_VERSION,
    websiteUrl: `${origin}/`,
    remotes: [{ type: "streamable-http", url: `${origin}/mcp` }],
  };
}

/** Signs the current time as the publisher CLI does (RFC 3339 UTC, Ed25519, hex). */
export function signedLogin(origin: string, secret: string, now = new Date()) {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const signature = sign(null, Buffer.from(timestamp, "utf8"), registryKey(secret).privateKey).toString("hex");
  return { domain: new URL(origin).hostname, timestamp, signed_timestamp: signature };
}

export type PublishResult = { ok: boolean; status: number; detail: string };

/**
 * Logs in with the domain proof and publishes the listing. Never throws:
 * the listing is a nicety, the gateway runs the same without it.
 */
export async function publishToRegistry(origin: string, secret: string, fetcher: typeof fetch = fetch): Promise<PublishResult> {
  try {
    const login = await fetcher(`${REGISTRY_URL}/v0/auth/http`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signedLogin(origin, secret)),
      signal: AbortSignal.timeout(20_000),
    });
    const loginBody = await login.json().catch(() => ({})) as Record<string, unknown>;
    const token = String(loginBody.registry_token ?? loginBody.token ?? loginBody.access_token ?? "");
    if (!login.ok || !token) return { ok: false, status: login.status, detail: `login refused: ${JSON.stringify(loginBody).slice(0, 300)}` };
    const publish = await fetcher(`${REGISTRY_URL}/v0/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(registryServerJson(origin)),
      signal: AbortSignal.timeout(20_000),
    });
    const text = (await publish.text().catch(() => "")).slice(0, 300);
    return { ok: publish.ok, status: publish.status, detail: publish.ok ? "published" : text };
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}
