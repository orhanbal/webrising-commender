import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { PoolClient } from "pg";
import { db } from "./db.js";

type Queryable = typeof db | PoolClient;

const enabled = /^(1|true|yes|on)$/i.test(
  String(process.env.REGIONAL_RELAY_ENABLED || ""),
);
const nodeId = String(process.env.CLUSTER_NODE_ID || "").trim();
const clusterSecret = String(process.env.RELAY_CLUSTER_SECRET || "");
const relayRegion = String(process.env.RELAY_REGION || "default").trim().toLowerCase();
const relayPublicWsUrl = String(process.env.RELAY_PUBLIC_WS_URL || "").trim();
const relayInternalBaseUrl = String(process.env.RELAY_INTERNAL_BASE_URL || "")
  .trim()
  .replace(/\/$/, "");
const relayMaxDevicesRaw = Number(process.env.RELAY_MAX_DEVICES ?? 10_000);
const relayMaxDevices = Number.isFinite(relayMaxDevicesRaw)
  ? Math.min(1_000_000, Math.max(1, Math.floor(relayMaxDevicesRaw)))
  : 10_000;
const nodeHeartbeatMs = 10_000;
const nodeFreshSeconds = 45;

if (enabled) {
  if (nodeId.length < 2 || nodeId.length > 120) {
    throw new Error("CLUSTER_NODE_ID must be 2-120 characters when regional relay is enabled");
  }
  if (clusterSecret.length < 32) {
    throw new Error("RELAY_CLUSTER_SECRET must be at least 32 characters when regional relay is enabled");
  }
}

function validatedUrl(value: string, protocols: string[]) {
  if (!value) return null;
  const parsed = new URL(value);
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`invalid relay URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

const normalizedPublicWsUrl = validatedUrl(relayPublicWsUrl, ["ws:", "wss:"]);
const normalizedInternalBaseUrl = validatedUrl(relayInternalBaseUrl, ["http:", "https:"]);

function isLoopbackUrl(value: string | null) {
  if (!value) return false;
  const parsed = new URL(value);
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
}

const allowInsecureTransport = /^(1|true|yes|on)$/i.test(
  String(process.env.RELAY_ALLOW_INSECURE_TRANSPORT || ""),
);

if (
  enabled &&
  normalizedPublicWsUrl?.startsWith("ws://") &&
  !isLoopbackUrl(normalizedPublicWsUrl) &&
  !allowInsecureTransport
) {
  throw new Error("RELAY_PUBLIC_WS_URL must use wss:// outside loopback");
}
if (
  enabled &&
  normalizedInternalBaseUrl?.startsWith("http://") &&
  !isLoopbackUrl(normalizedInternalBaseUrl) &&
  !allowInsecureTransport
) {
  throw new Error("RELAY_INTERNAL_BASE_URL must use https:// outside loopback");
}

if ((normalizedPublicWsUrl && !normalizedInternalBaseUrl) || (!normalizedPublicWsUrl && normalizedInternalBaseUrl)) {
  throw new Error("RELAY_PUBLIC_WS_URL and RELAY_INTERNAL_BASE_URL must be configured together");
}

export function regionalRelayEnabled() {
  return enabled;
}

export function currentNodeId() {
  return enabled && nodeId ? nodeId : null;
}

export function currentNodeIsRelay() {
  return enabled && Boolean(normalizedPublicWsUrl && normalizedInternalBaseUrl);
}

export type RelayRoute = {
  id: string;
  region: string;
  publicWsUrl: string;
  internalBaseUrl: string;
};

export async function heartbeatRelayNode() {
  if (!currentNodeIsRelay()) return false;
  await db.query(
    `insert into relay_nodes(
       id,region,public_ws_url,internal_base_url,max_devices,last_seen_at,updated_at
     )
     values($1,$2,$3,$4,$5,now(),now())
     on conflict(id)
     do update set
       region=excluded.region,
       public_ws_url=excluded.public_ws_url,
       internal_base_url=excluded.internal_base_url,
       last_seen_at=now(),
       updated_at=now()`,
    [nodeId, relayRegion, normalizedPublicWsUrl, normalizedInternalBaseUrl, relayMaxDevices],
  );
  return true;
}

export function startRelayHeartbeat() {
  if (!currentNodeIsRelay()) return null;
  const run = () => {
    void heartbeatRelayNode().catch((error) => {
      process.stderr.write(
        `relay heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  };
  run();
  const timer = setInterval(run, nodeHeartbeatMs);
  timer.unref();
  return timer;
}

async function healthyRelayById(
  relayId: string,
  preferredRegion: string | null,
  queryable: Queryable,
) {
  const result = await queryable.query<{
    id: string;
    region: string;
    public_ws_url: string;
    internal_base_url: string;
  }>(
    `select r.id,r.region,r.public_ws_url,r.internal_base_url
       from relay_nodes r
      where r.id=$1
        and r.enabled
        and not r.drain
        and r.last_seen_at>now()-($2::int*interval '1 second')
        and (
          select count(*)
            from devices d
           where d.assigned_relay_id=r.id
             and d.revoked_at is null
        ) <= r.max_devices
        and ($3::text is null or r.region=$3)
      for update`,
    [relayId, nodeFreshSeconds, preferredRegion],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        region: row.region,
        publicWsUrl: row.public_ws_url,
        internalBaseUrl: row.internal_base_url,
      }
    : null;
}

async function chooseHealthyRelay(
  organizationId: string,
  queryable: Queryable,
  currentRelayId?: string | null,
) {
  const org = await queryable.query<{ relay_region: string | null }>(
    "select relay_region from organizations where id=$1",
    [organizationId],
  );
  if (!org.rows[0]) {
    throw Object.assign(new Error("organization_not_found"), { status: 404 });
  }
  const preferredRegion = org.rows[0].relay_region;

  if (currentRelayId) {
    const current = await healthyRelayById(
      currentRelayId,
      preferredRegion,
      queryable,
    );
    if (current) return current;
  }

  const result = await queryable.query<{
    id: string;
    region: string;
    public_ws_url: string;
    internal_base_url: string;
    assigned_count: string;
  }>(
    `select r.id,
            r.region,
            r.public_ws_url,
            r.internal_base_url,
            (
              select count(*)::text
                from devices d
               where d.assigned_relay_id=r.id
                 and d.revoked_at is null
            ) as assigned_count
       from relay_nodes r
      where r.enabled
        and not r.drain
        and r.last_seen_at>now()-($1::int*interval '1 second')
        and (
          select count(*)
            from devices d
           where d.assigned_relay_id=r.id
             and d.revoked_at is null
        ) < r.max_devices
      order by
        case when $2::text is not null and r.region=$2 then 0 else 1 end,
        (
          select count(*)
            from devices d
           where d.assigned_relay_id=r.id
             and d.revoked_at is null
        ) asc,
        r.id asc
      for update skip locked
      limit 1`,
    [nodeFreshSeconds, preferredRegion],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    region: row.region,
    publicWsUrl: row.public_ws_url,
    internalBaseUrl: row.internal_base_url,
  };
}

export async function assignRelayForDevice(
  deviceId: string,
  queryable: Queryable = db,
): Promise<RelayRoute | null> {
  if (!enabled) return null;

  const device = await queryable.query<{
    organization_id: string;
    assigned_relay_id: string | null;
  }>(
    `select organization_id,assigned_relay_id
       from devices
      where id=$1
        and revoked_at is null
      for update`,
    [deviceId],
  );
  const row = device.rows[0];
  if (!row) {
    throw Object.assign(new Error("device_not_found"), { status: 404 });
  }

  const relay = await chooseHealthyRelay(
    row.organization_id,
    queryable,
    row.assigned_relay_id,
  );
  if (!relay) return null;

  await queryable.query(
    `update devices
        set assigned_relay_id=$2
      where id=$1`,
    [deviceId, relay.id],
  );
  return relay;
}

export async function relayOnlineDeviceIds(deviceIds: string[]) {
  if (!enabled || deviceIds.length === 0) return new Set<string>();
  const result = await db.query<{ id: string }>(
    `select d.id::text
       from devices d
       join relay_nodes r on r.id=d.connected_relay_id
      where d.id=any($1::uuid[])
        and d.revoked_at is null
        and d.relay_last_seen_at>now()-($2::int*interval '1 second')
        and r.enabled
        and r.last_seen_at>now()-($2::int*interval '1 second')`,
    [deviceIds, nodeFreshSeconds],
  );
  return new Set(result.rows.map((row) => row.id));
}

export async function connectedRelayForDevice(deviceId: string) {
  if (!enabled) return null;
  const result = await db.query<{
    id: string;
    region: string;
    internal_base_url: string;
  }>(
    `select r.id,r.region,r.internal_base_url
       from devices d
       join relay_nodes r on r.id=d.connected_relay_id
      where d.id=$1
        and d.revoked_at is null
        and d.relay_last_seen_at>now()-($2::int*interval '1 second')
        and r.enabled
        and r.last_seen_at>now()-($2::int*interval '1 second')
      limit 1`,
    [deviceId, nodeFreshSeconds],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        region: row.region,
        internalBaseUrl: row.internal_base_url,
      }
    : null;
}

const seenNonces = new Map<string, number>();

function purgeNonces(now: number) {
  for (const [nonce, expires] of seenNonces) {
    if (expires <= now) seenNonces.delete(nonce);
  }
}

function relaySignatureBase(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer | string,
) {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return [
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
}

function signatureFor(base: string) {
  return crypto.createHmac("sha256", clusterSecret).update(base).digest("hex");
}

export function signedRelayHeaders(method: string, path: string, body: string) {
  if (!enabled || clusterSecret.length < 32 || !nodeId) {
    throw new Error("regional_relay_not_configured");
  }
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(18).toString("base64url");
  const signature = signatureFor(
    relaySignatureBase(method, path, timestamp, nonce, body),
  );
  return {
    "content-type": "application/json",
    "x-commender-node": nodeId,
    "x-commender-timestamp": timestamp,
    "x-commender-nonce": nonce,
    "x-commender-signature": signature,
  };
}

function headerValue(headers: IncomingHttpHeaders, name: string) {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function verifyRelayRequest(
  method: string,
  path: string,
  headers: IncomingHttpHeaders,
  body: Buffer,
) {
  if (!enabled || clusterSecret.length < 32) return false;

  const sender = headerValue(headers, "x-commender-node");
  const timestamp = headerValue(headers, "x-commender-timestamp");
  const nonce = headerValue(headers, "x-commender-nonce");
  const signature = headerValue(headers, "x-commender-signature");
  if (!sender || !timestamp || !nonce || !signature) return false;
  if (sender.length > 120 || nonce.length > 120 || signature.length !== 64) return false;

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 30_000) {
    return false;
  }

  const now = Date.now();
  purgeNonces(now);
  if (seenNonces.has(nonce)) return false;

  const expected = Buffer.from(
    signatureFor(relaySignatureBase(method, path, timestamp, nonce, body)),
    "hex",
  );
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return false;
  }

  seenNonces.set(nonce, now + 60_000);
  return true;
}

export async function callRelay<T>(
  relayInternalBaseUrl: string,
  path: string,
  payload: unknown,
): Promise<T> {
  const body = JSON.stringify(payload);
  const response = await fetch(relayInternalBaseUrl + path, {
    method: "POST",
    headers: signedRelayHeaders("POST", path, body),
    body,
    signal: AbortSignal.timeout(
      Math.max(1_000, Number(process.env.RELAY_REQUEST_TIMEOUT_MS || 35_000)),
    ),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof result?.error === "string" ? result.error : `relay_http_${response.status}`,
    );
  }
  return result as T;
}
