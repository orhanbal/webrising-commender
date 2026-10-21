import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type WebSocket from "ws";
import type { PoolClient } from "pg";
import { db } from "./db.js";
import type { AgentAction } from "./protocol.js";
import { actionRisk } from "./protocol.js";
import type { AgentHub } from "./relay.js";
import { sha256 } from "./crypto-utils.js";

type Queryable = typeof db | PoolClient;

export type RelayNode = {
  id: string;
  region: string;
  internal_url: string;
  public_url: string;
  last_seen_at: string;
  draining_at: string | null;
  disabled_at: string | null;
};

function intEnv(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function required(name: string, min = 1) {
  const value = String(process.env[name] || "").trim();
  if (value.length < min) throw new Error(`${name} must be at least ${min} characters`);
  return value;
}

function normalizedBaseUrl(name: string, value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${name} must use http or https`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const object = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(object[key]))
      .join(",") +
    "}"
  );
}

function timingSafeEqualText(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function websocketUrl(publicUrl: string) {
  return publicUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:") + "/agent";
}

export class DeviceRouter {
  readonly mode: "standalone" | "regional";
  readonly nodeId: string | null;
  readonly region: string | null;
  readonly instanceId = crypto.randomUUID();

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatSeconds: number;
  private readonly staleSeconds: number;
  private readonly internalTimeoutMs: number;
  private readonly clusterSecret: string | null;
  private readonly internalUrl: string | null;
  private readonly publicUrl: string;

  constructor(
    private readonly hub: AgentHub,
    publicBaseUrl: string,
  ) {
    const mode = String(process.env.CLUSTER_MODE || "standalone").trim().toLowerCase();
    if (mode !== "standalone" && mode !== "regional") {
      throw new Error("CLUSTER_MODE must be standalone or regional");
    }
    this.mode = mode;
    this.heartbeatSeconds = intEnv("CLUSTER_HEARTBEAT_SECONDS", 5, 1, 60);
    this.staleSeconds = intEnv(
      "CLUSTER_NODE_STALE_SECONDS",
      Math.max(20, this.heartbeatSeconds * 4),
      this.heartbeatSeconds * 2,
      600,
    );
    this.internalTimeoutMs = intEnv("CLUSTER_INTERNAL_TIMEOUT_MS", 35_000, 1_000, 15 * 60_000);

    if (this.mode === "regional") {
      this.nodeId = required("GATEWAY_NODE_ID");
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(this.nodeId)) {
        throw new Error("GATEWAY_NODE_ID must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}");
      }
      this.region = required("GATEWAY_REGION");
      this.internalUrl = normalizedBaseUrl("GATEWAY_INTERNAL_URL", required("GATEWAY_INTERNAL_URL"));
      this.publicUrl = normalizedBaseUrl(
        "GATEWAY_PUBLIC_URL",
        String(process.env.GATEWAY_PUBLIC_URL || publicBaseUrl),
      );
      this.clusterSecret = required("CLUSTER_SHARED_SECRET", 32);
    } else {
      this.nodeId = null;
      this.region = null;
      this.internalUrl = null;
      this.publicUrl = publicBaseUrl.replace(/\/$/, "");
      this.clusterSecret = null;
    }
  }

  isRegional() {
    return this.mode === "regional";
  }

  async start() {
    if (!this.isRegional()) return;

    const client = await db.connect();
    try {
      await client.query("begin");
      const current = await client.query<{
        instance_id: string;
        last_seen_at: string;
        disabled_at: string | null;
      }>(
        "select instance_id,last_seen_at,disabled_at from relay_nodes where id=$1 for update",
        [this.nodeId],
      );
      const row = current.rows[0];
      if (row && !row.disabled_at && row.instance_id !== this.instanceId) {
        const ageMs = Date.now() - new Date(row.last_seen_at).getTime();
        if (Number.isFinite(ageMs) && ageMs < this.staleSeconds * 1000) {
          await client.query("rollback");
          throw new Error("relay_node_id_already_active");
        }
      }

      await client.query(
        `insert into relay_nodes(
           id,instance_id,region,internal_url,public_url,last_seen_at,disabled_at,updated_at
         )
         values($1,$2,$3,$4,$5,now(),null,now())
         on conflict(id)
         do update set
           instance_id=excluded.instance_id,
           region=excluded.region,
           internal_url=excluded.internal_url,
           public_url=excluded.public_url,
           last_seen_at=now(),
           disabled_at=null,
           updated_at=now()`,
        [this.nodeId, this.instanceId, this.region, this.internalUrl, this.publicUrl],
      );
      await client.query("commit");
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {}
      throw error;
    } finally {
      client.release();
    }

    this.heartbeatTimer = setInterval(() => {
      void db
        .query(
          `update relay_nodes
              set last_seen_at=now(),updated_at=now()
            where id=$1 and instance_id=$2 and disabled_at is null`,
          [this.nodeId, this.instanceId],
        )
        .catch(() => {});
    }, this.heartbeatSeconds * 1000);
    this.heartbeatTimer.unref();
  }

  async shutdown() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (!this.isRegional()) return;
    await db.query(
      `update relay_nodes
          set last_seen_at=to_timestamp(0),updated_at=now()
        where id=$1 and instance_id=$2`,
      [this.nodeId, this.instanceId],
    );
    await db.query(
      `update devices
          set connected_node_id=null,
              connected_connection_id=null,
              connected_at=null
        where connected_node_id=$1`,
      [this.nodeId],
    );
  }

  async registerLocal(deviceId: string, socket: WebSocket) {
    if (!this.isRegional()) {
      this.hub.register(deviceId, socket);
      return;
    }

    const connectionId = crypto.randomUUID();
    this.hub.register(deviceId, socket, {
      onReady: async () => {
        const updated = await db.query(
          `update devices
              set relay_node_id=coalesce(relay_node_id,$2),
                  connected_node_id=$2,
                  connected_connection_id=$3,
                  connected_at=now()
            where id=$1
              and revoked_at is null
              and (relay_node_id is null or relay_node_id=$2)
            returning id`,
          [deviceId, this.nodeId, connectionId],
        );
        if (!updated.rowCount) throw new Error("device_assigned_to_different_relay");
      },
      onClosed: async () => {
        await db.query(
          `update devices
              set connected_node_id=null,
                  connected_connection_id=null,
                  connected_at=null
            where id=$1
              and connected_node_id=$2
              and connected_connection_id=$3`,
          [deviceId, this.nodeId, connectionId],
        );
      },
    });
  }

  async validateLocalSocket(deviceId: string) {
    if (!this.isRegional()) return true;
    const result = await db.query<{ relay_node_id: string | null }>(
      "select relay_node_id from devices where id=$1 and revoked_at is null",
      [deviceId],
    );
    const row = result.rows[0];
    return Boolean(row && (!row.relay_node_id || row.relay_node_id === this.nodeId));
  }

  private async healthyNode(nodeId: string, queryable: Queryable = db) {
    const result = await queryable.query<RelayNode>(
      `select id,region,internal_url,public_url,last_seen_at,draining_at,disabled_at
         from relay_nodes
        where id=$1
          and disabled_at is null
          and last_seen_at>now()-($2::int*interval '1 second')`,
      [nodeId, this.staleSeconds],
    );
    return result.rows[0] ?? null;
  }

  private async enrollmentNode(nodeId: string, queryable: Queryable = db) {
    const node = await this.healthyNode(nodeId, queryable);
    if (!node || node.draining_at) return null;
    return node;
  }

  async ensureOrganizationRelay(
    organizationId: string,
    queryable: Queryable = db,
  ): Promise<RelayNode | null> {
    if (!this.isRegional()) return null;

    const assigned = await queryable.query<RelayNode>(
      `select n.id,n.region,n.internal_url,n.public_url,n.last_seen_at,n.draining_at,n.disabled_at
         from organization_relay_assignments a
         join relay_nodes n on n.id=a.relay_node_id
        where a.organization_id=$1`,
      [organizationId],
    );
    if (assigned.rows[0]) {
      const available = await this.enrollmentNode(assigned.rows[0].id, queryable);
      if (!available) {
        throw Object.assign(new Error("relay_not_accepting_enrollments"), { status: 409 });
      }
      return available;
    }

    const local = await this.enrollmentNode(this.nodeId!, queryable);
    if (!local) throw Object.assign(new Error("local_relay_unavailable"), { status: 503 });

    await queryable.query(
      `insert into organization_relay_assignments(organization_id,relay_node_id)
       values($1,$2)
       on conflict(organization_id) do nothing`,
      [organizationId, this.nodeId],
    );
    const final = await queryable.query<RelayNode>(
      `select n.id,n.region,n.internal_url,n.public_url,n.last_seen_at,n.draining_at,n.disabled_at
         from organization_relay_assignments a
         join relay_nodes n on n.id=a.relay_node_id
        where a.organization_id=$1`,
      [organizationId],
    );
    const available = final.rows[0]
      ? await this.enrollmentNode(final.rows[0].id, queryable)
      : null;
    if (!available) {
      throw Object.assign(new Error("relay_not_accepting_enrollments"), { status: 409 });
    }
    return available;
  }

  async assignOrganizationRelay(organizationId: string, relayNodeId: string) {
    if (!this.isRegional()) {
      throw Object.assign(new Error("regional_mode_required"), { status: 400 });
    }
    const node = await this.enrollmentNode(relayNodeId);
    if (!node) {
      throw Object.assign(new Error("relay_not_accepting_enrollments"), { status: 409 });
    }

    const organization = await db.query("select 1 from organizations where id=$1", [organizationId]);
    if (!organization.rowCount) {
      throw Object.assign(new Error("organization_not_found"), { status: 404 });
    }

    await db.query(
      `insert into organization_relay_assignments(organization_id,relay_node_id,updated_at)
       values($1,$2,now())
       on conflict(organization_id)
       do update set relay_node_id=excluded.relay_node_id,updated_at=now()`,
      [organizationId, relayNodeId],
    );

    const existingDevices = await db.query<{ count: string }>(
      "select count(*)::text as count from devices where organization_id=$1 and revoked_at is null",
      [organizationId],
    );
    return {
      organizationId,
      relayNodeId,
      existingDevicesUnaffected: Number(existingDevices.rows[0]?.count || 0),
      appliesToFutureEnrollments: true,
    };
  }

  async pairingRelay(organizationId: string, queryable: Queryable = db) {
    return this.ensureOrganizationRelay(organizationId, queryable);
  }

  async enrollmentWsUrl(relayNodeId: string | null) {
    if (!this.isRegional()) return websocketUrl(this.publicUrl);
    if (!relayNodeId) throw Object.assign(new Error("relay_assignment_missing"), { status: 503 });
    const node = await this.enrollmentNode(relayNodeId);
    if (!node) {
      throw Object.assign(new Error("relay_not_accepting_enrollments"), { status: 409 });
    }
    return websocketUrl(node.public_url);
  }

  async resolveDeviceWsUrl(deviceId: string) {
    if (!this.isRegional()) return websocketUrl(this.publicUrl);
    const device = await db.query<{ relay_node_id: string | null }>(
      "select relay_node_id from devices where id=$1 and revoked_at is null",
      [deviceId],
    );
    const relayNodeId = device.rows[0]?.relay_node_id;
    if (!relayNodeId) throw Object.assign(new Error("relay_assignment_missing"), { status: 503 });
    const node = await this.healthyNode(relayNodeId);
    if (!node) throw Object.assign(new Error("relay_unavailable"), { status: 503 });
    return websocketUrl(node.public_url);
  }

  private sign(method: string, path: string, body: unknown) {
    if (!this.isRegional() || !this.clusterSecret || !this.nodeId) {
      throw new Error("regional_mode_required");
    }
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(18).toString("base64url");
    const digest = sha256(canonical(body));
    const material = [method.toUpperCase(), path, timestamp, nonce, this.nodeId, digest].join("\n");
    const signature = crypto
      .createHmac("sha256", this.clusterSecret)
      .update(material)
      .digest("base64url");
    return {
      "x-commender-node": this.nodeId,
      "x-commender-timestamp": timestamp,
      "x-commender-nonce": nonce,
      "x-commender-signature": signature,
    };
  }

  async verifyInternal(
    headers: IncomingHttpHeaders,
    method: string,
    path: string,
    body: unknown,
  ) {
    if (!this.isRegional() || !this.clusterSecret) return false;

    const source = String(headers["x-commender-node"] || "");
    const timestamp = String(headers["x-commender-timestamp"] || "");
    const nonce = String(headers["x-commender-nonce"] || "");
    const signature = String(headers["x-commender-signature"] || "");
    if (!source || !timestamp || nonce.length < 16 || !signature) return false;

    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 45) return false;

    const sourceNode = await this.healthyNode(source);
    if (!sourceNode) return false;

    const digest = sha256(canonical(body));
    const material = [method.toUpperCase(), path, timestamp, nonce, source, digest].join("\n");
    const expected = crypto
      .createHmac("sha256", this.clusterSecret)
      .update(material)
      .digest("base64url");
    if (!timingSafeEqualText(expected, signature)) return false;

    const inserted = await db.query(
      `insert into cluster_request_nonces(source_node_id,nonce,expires_at)
       values($1,$2,now()+interval '2 minutes')
       on conflict do nothing
       returning nonce`,
      [source, nonce],
    );
    return inserted.rowCount === 1;
  }

  private async internalPost(node: RelayNode, path: string, body: unknown) {
    const headers = this.sign("POST", path, body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.internalTimeoutMs);
    try {
      const response = await fetch(node.internal_url + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(
          new Error(String(payload?.error || `relay_http_${response.status}`)),
          { status: response.status },
        );
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  private async deviceRoute(deviceId: string) {
    const result = await db.query<{
      organization_id: string;
      relay_node_id: string | null;
      connected_node_id: string | null;
      revoked_at: string | null;
    }>(
      `select organization_id,relay_node_id,connected_node_id,revoked_at
         from devices
        where id=$1`,
      [deviceId],
    );
    return result.rows[0] ?? null;
  }

  async request(deviceId: string, action: AgentAction, approvalToken?: string | null) {
    if (!this.isRegional()) return this.hub.request(deviceId, action, approvalToken);
    if (this.hub.isOnline(deviceId)) return this.hub.request(deviceId, action, approvalToken);

    const route = await this.deviceRoute(deviceId);
    if (!route || route.revoked_at) throw new Error("device-not-found");
    if (!route.connected_node_id) throw new Error("device-offline");
    if (route.connected_node_id === this.nodeId) throw new Error("device-offline");

    const node = await this.healthyNode(route.connected_node_id);
    if (!node) throw new Error("device-offline");
    const response = await this.internalPost(node, "/internal/cluster/device/request", {
      organizationId: route.organization_id,
      deviceId,
      action,
      ...(approvalToken !== undefined ? { approvalToken } : {}),
    });
    return response.data;
  }

  async disconnect(deviceId: string) {
    if (!this.isRegional()) return this.hub.disconnect(deviceId);
    if (this.hub.isOnline(deviceId)) return this.hub.disconnect(deviceId);

    const route = await this.deviceRoute(deviceId);
    if (!route?.connected_node_id) return false;
    if (route.connected_node_id === this.nodeId) return false;

    const node = await this.healthyNode(route.connected_node_id);
    if (!node) return false;
    const response = await this.internalPost(node, "/internal/cluster/device/disconnect", {
      organizationId: route.organization_id,
      deviceId,
    });
    return Boolean(response.disconnected);
  }

  async onlineStates(deviceIds: string[]) {
    const states = new Map<string, boolean>();
    for (const id of deviceIds) states.set(id, this.hub.isOnline(id));
    if (!this.isRegional() || deviceIds.length === 0) return states;

    const remoteIds = deviceIds.filter((id) => !states.get(id));
    if (remoteIds.length === 0) return states;

    const result = await db.query<{ id: string; connected_node_id: string | null; node_live: boolean }>(
      `select d.id,
              d.connected_node_id,
              case
                when n.id is not null
                 and n.disabled_at is null
                 and n.last_seen_at>now()-($2::int*interval '1 second')
                then true else false
              end as node_live
         from devices d
         left join relay_nodes n on n.id=d.connected_node_id
        where d.id=any($1::uuid[])`,
      [remoteIds, this.staleSeconds],
    );
    for (const row of result.rows) {
      states.set(row.id, Boolean(row.connected_node_id && row.node_live));
    }
    return states;
  }

  async isOnline(deviceId: string) {
    return (await this.onlineStates([deviceId])).get(deviceId) === true;
  }

  async nodes() {
    if (!this.isRegional()) return [];
    const result = await db.query(
      `select n.id,n.instance_id,n.region,n.internal_url,n.public_url,n.last_seen_at,n.disabled_at,
              (n.disabled_at is null and n.last_seen_at>now()-($1::int*interval '1 second')) as healthy,
              count(distinct a.organization_id)::int as organizations,
              count(distinct d.id) filter (where d.connected_node_id=n.id)::int as connected_devices
         from relay_nodes n
         left join organization_relay_assignments a on a.relay_node_id=n.id
         left join devices d on d.connected_node_id=n.id and d.revoked_at is null
        group by n.id
        order by n.region,n.id`,
      [this.staleSeconds],
    );
    return result.rows;
  }

  async handleInternalRequest(body: {
    organizationId: string;
    deviceId: string;
    action: AgentAction;
    approvalToken?: string;
  }) {
    if (!this.isRegional()) throw Object.assign(new Error("regional_mode_required"), { status: 404 });
    const device = await db.query(
      `select 1 from devices
        where id=$1
          and organization_id=$2
          and revoked_at is null
          and relay_node_id=$3
          and connected_node_id=$3`,
      [body.deviceId, body.organizationId, this.nodeId],
    );
    if (!device.rowCount) throw Object.assign(new Error("device_not_local"), { status: 409 });

    if (actionRisk(body.action.kind) === "high" && !body.approvalToken) {
      throw Object.assign(new Error("approval_required"), { status: 403 });
    }
    return this.hub.request(body.deviceId, body.action, body.approvalToken);
  }

  async handleInternalDisconnect(body: { organizationId: string; deviceId: string }) {
    if (!this.isRegional()) throw Object.assign(new Error("regional_mode_required"), { status: 404 });
    const device = await db.query(
      `select 1 from devices
        where id=$1
          and organization_id=$2
          and relay_node_id=$3`,
      [body.deviceId, body.organizationId, this.nodeId],
    );
    if (!device.rowCount) throw Object.assign(new Error("device_not_local"), { status: 409 });
    return this.hub.disconnect(body.deviceId);
  }
}
