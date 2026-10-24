import crypto from "node:crypto";
import type { Pool } from "pg";


/** Five-minute, actor/tenant/device-scoped durable search snapshots.
 * This records completed bounded results, not resumable native scanners.
 * Running searches from another gateway process are reported interrupted:
 * do not imply that a deleted/restarted native worker is still reachable.
 */
export type SearchKey = {
  id: string;
  organizationId: string;
  actor: string;
  deviceId: string;
};
export type SearchSnapshot = SearchKey & {
  path: string;
  query: string;
  searchType: "files" | "content";
  createdAt: number;
};
export type SearchProgressUpdate = {
  items: unknown[];
  scannedEntries: number;
  scannedBytes: number;
  sequence: number;
};
export type SearchCompletion = {
  status: "completed" | "error";
  items: unknown[];
  truncated: boolean;
  timedOut: boolean;
  error?: string;
  progressUpdates?: number;
  scannedEntries?: number;
  scannedBytes?: number;
};
export type SearchSummary = {
  searchId: string;
  path: string;
  query: string;
  searchType: "files" | "content";
  status: "running" | "completed" | "error" | "stopped";
  paused: boolean;
  createdAt: string;
  resultCount: number;
  progressUpdates: number;
  scannedEntries: number;
  scannedBytes: number;
  truncated: boolean;
  timedOut: boolean;
  error?: string;
};
export type SearchPage = SearchSummary & {
  offset: number;
  length: number;
  items: unknown[];
  hasMore: boolean;
};
export interface SearchPersistence {
  create(snapshot: SearchSnapshot): Promise<void>;
  /** Clear a stopped row's physical slot only after its native request settles. */
  settleStopped?(key: SearchKey): Promise<void>;
  /** Persist only monotonically newer native progress for the original actor/device. */
  progress?(key: SearchKey, update: SearchProgressUpdate): Promise<boolean>;
  /** Exact native-origin CAS; never pause or revive stopped/foreign searches. */
  setPaused?(key: SearchKey, paused: boolean): Promise<boolean>;
  /** True only when the running row was atomically transitioned to its final status. */
  finish(key: SearchKey, result: SearchCompletion): Promise<boolean>;
  stop(key: SearchKey): Promise<void>;
  /** Returns stopped IDs among this Gateway's active native requests only. */
  stoppedIds(ids: string[]): Promise<string[]>;
  page(scope: Omit<SearchKey, "id">, id: string, offset: number, length: number): Promise<SearchPage>;
  list(scope: Omit<SearchKey, "id">): Promise<{ items: SearchSummary[] }>;
}
type SearchRow = {
  id: string;
  path: string;
  query: string;
  search_type: "files" | "content";
  status: "running" | "completed" | "error" | "stopped";
  origin_instance: string;
  paused: boolean;
  progress_sequence: number;
  scanned_entries: number;
  scanned_bytes: number;
  created_at: Date;
  items: unknown[];
  truncated: boolean;
  timed_out: boolean;
  error_code: string | null;
  origin_alive?: boolean | null;
};
export class PgSearchPersistence implements SearchPersistence {
  private readonly originInstance = crypto.randomUUID();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly pool: Pool) {}

  async activate() {
    await this.pool.query(
      `insert into search_gateway_instances(id,last_heartbeat_at)
       values($1,now()) on conflict(id) do update set last_heartbeat_at=now()`,
      [this.originInstance],
    );
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      void this.pool.query(
        "update search_gateway_instances set last_heartbeat_at=now() where id=$1",
        [this.originInstance],
      ).catch(() => {
        // A transient DB outage will expire the lease and fail closed for
        // remote viewers. A later successful beat restores visibility.
      });
    }, 5_000);
    this.heartbeatTimer.unref();
  }

  async deactivate() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    await this.pool.query("delete from search_gateway_instances where id=$1", [this.originInstance]);
  }

  async create(s: SearchSnapshot) {
    // Serialize actor allocation across all Gateways sharing this PostgreSQL.
    // A local Map quota alone can be bypassed by connecting through a
    // different Gateway or choosing a different device.
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtext('wc-search-actor'),hashtext($1))",
        [JSON.stringify([s.organizationId, s.actor])],
      );
      const active = await client.query<{ count: number }>(
        `select count(*)::integer as count
           from search_sessions s
           join search_gateway_instances g on g.id=s.origin_instance
          where s.organization_id=$1 and s.actor=$2
            and s.native_inflight=true and s.expires_at>now()
            and g.last_heartbeat_at>now()-interval '15 seconds'`,
        [s.organizationId, s.actor],
      );
      if (Number(active.rows[0]?.count ?? 0) >= 8) {
        throw new Error("search_session_limit");
      }
      await client.query(
        `insert into search_sessions(id,organization_id,actor,device_id,path,query,search_type,status,origin_instance,created_at,expires_at,native_inflight)
         values($1,$2,$3,$4,$5,$6,$7,'running',$8,to_timestamp($9::double precision / 1000),now()+interval '5 minutes',true)`,
        [s.id, s.organizationId, s.actor, s.deviceId, s.path, s.query, s.searchType, this.originInstance, s.createdAt],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async settleStopped(s: SearchKey) {
    // A stop revokes results immediately but must not free a remote native
    // execution slot until the Agent responds or disconnects.
    await this.pool.query(
      `update search_sessions set native_inflight=false
        where id=$1 and organization_id=$2 and actor=$3 and device_id=$4
          and origin_instance=$5 and status='stopped' and native_inflight=true`,
      [s.id, s.organizationId, s.actor, s.deviceId, this.originInstance],
    );
  }

  async setPaused(s: SearchKey, paused: boolean) {
    const result = await this.pool.query(
      `update search_sessions set paused=$5
        where id=$1 and organization_id=$2 and actor=$3 and device_id=$4
          and status='running' and native_inflight=true
          and origin_instance=$6 and expires_at>now()
        returning id`,
      [s.id, s.organizationId, s.actor, s.deviceId, paused, this.originInstance],
    );
    return Boolean(result.rowCount);
  }

  async progress(s: SearchKey, update: SearchProgressUpdate) {
    // A stopped/expired request can never regain results. Sequence gating
    // prevents a delayed database write from rolling back a newer page.
    let items = update.items.slice(0, 500);
    if (Buffer.byteLength(JSON.stringify(items), "utf8") > 1024 * 1024) {
      // Never persist a partial item or more than 1 MiB of untrusted payload.
      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(items.slice(0, middle)), "utf8") <= 1024 * 1024) {
          low = middle;
        } else high = middle - 1;
      }
      items = items.slice(0, low);
    }
    const result = await this.pool.query(
      `update search_sessions
          set items=$5::jsonb,scanned_entries=$6,scanned_bytes=$7,progress_sequence=$8
        where id=$1 and organization_id=$2 and actor=$3 and device_id=$4
          and status='running' and paused=false and native_inflight=true and expires_at>now()
          and origin_instance=$9 and progress_sequence<$8
        returning id`,
      [s.id, s.organizationId, s.actor, s.deviceId,
        JSON.stringify(items), update.scannedEntries, update.scannedBytes,
        update.sequence, this.originInstance],
    );
    return Boolean(result.rowCount);
  }

  async finish(s: SearchKey, result: SearchCompletion) {
    // Retain the longest ordered prefix that fits the durable 1 MiB cap.
    // Dropping the entire snapshot when one result crosses the cap loses
    // otherwise valid pages and makes large-directory pagination unusable.
    let items = result.status === "completed" ? result.items.slice(0, 500) : [];
    let truncated = result.truncated || (result.status === "completed" && result.items.length > 500);
    const maxBytes = 1024 * 1024;
    if (Buffer.byteLength(JSON.stringify(items), "utf8") > maxBytes) {
      let low = 0;
      let high = items.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(JSON.stringify(items.slice(0, mid)), "utf8") <= maxBytes) {
          low = mid;
        } else {
          high = mid - 1;
        }
      }
      items = items.slice(0, low);
      truncated = true;
    }
    const updated = await this.pool.query(
      `update search_sessions
          set status=$5,items=$6::jsonb,truncated=$7,timed_out=$8,error_code=$9,native_inflight=false,paused=false,
              progress_sequence=greatest(progress_sequence,$10),
              scanned_entries=greatest(scanned_entries,$11),
              scanned_bytes=greatest(scanned_bytes,$12)
        where id=$1 and organization_id=$2 and actor=$3 and device_id=$4
          and status='running' and native_inflight=true
          and origin_instance=$13 and expires_at>now()
        returning id`,
      [s.id, s.organizationId, s.actor, s.deviceId,
        result.status, JSON.stringify(items), truncated, result.timedOut,
        result.error ?? null, result.progressUpdates ?? 0,
        result.scannedEntries ?? 0, result.scannedBytes ?? 0, this.originInstance],
    );
    return Boolean(updated.rowCount);
  }

  async stop(s: SearchKey) {
    const result = await this.pool.query(
      `update search_sessions
          set status='stopped',paused=false,items='[]'::jsonb,error_code=null
        where id=$1 and organization_id=$2 and actor=$3 and device_id=$4
          and expires_at>now()
        returning id`,
      [s.id, s.organizationId, s.actor, s.deviceId],
    );
    if (!result.rowCount) throw new Error("search_not_found");
  }

  async stoppedIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    // Query only the bounded local active set. The origin guard prevents a
    // different Gateway's search IDs from influencing this process.
    const result = await this.pool.query<{ id: string }>(
      `select id from search_sessions
        where origin_instance=$1 and id=any($2::uuid[]) and status='stopped'`,
      [this.originInstance, ids],
    );
    return result.rows.map(row => row.id);
  }

  private summary(row: SearchRow) {
    // An active scanner on ANOTHER healthy Gateway remains running. A
    // disconnected/crashed owner is reported interrupted; don't invent
    // resumable native execution after a restart.
    const interrupted = row.status === "running" &&
      row.origin_instance !== this.originInstance && row.origin_alive !== true;
    const status = interrupted ? "error" : row.status;
    const items = (status === "completed" || status === "running") &&
      Array.isArray(row.items) ? row.items : [];
    const error = interrupted ? "search_interrupted" : row.error_code;
    return {
      searchId: row.id, path: row.path, query: row.query,
      searchType: row.search_type, status, paused: status === "running" && row.paused === true,
      createdAt: new Date(row.created_at).toISOString(),
      resultCount: items.length,
      progressUpdates: row.progress_sequence ?? 0,
      scannedEntries: Number(row.scanned_entries ?? 0),
      scannedBytes: Number(row.scanned_bytes ?? 0),
      truncated: row.truncated,
      timedOut: row.timed_out, ...(error ? { error } : {}),
    };
  }

  async page(scope: Omit<SearchKey, "id">, id: string, offset: number, length: number) {
    const result = await this.pool.query<SearchRow>(
      `select s.id,s.path,s.query,s.search_type,s.status,s.origin_instance,
              s.created_at,s.items,s.truncated,s.timed_out,s.error_code,s.paused,
              s.progress_sequence,s.scanned_entries,s.scanned_bytes,
              (g.last_heartbeat_at > now() - interval '15 seconds') as origin_alive
         from search_sessions s
         left join search_gateway_instances g on g.id=s.origin_instance
        where s.id=$1 and s.organization_id=$2 and s.actor=$3 and s.device_id=$4
          and s.expires_at>now()`,
      [id, scope.organizationId, scope.actor, scope.deviceId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("search_not_found");
    const summary = this.summary(row);
    const items = (summary.status === "completed" || summary.status === "running") &&
      Array.isArray(row.items) ? row.items : [];
    return {
      ...summary, offset, length, items: items.slice(offset, offset + length),
      hasMore: offset + length < items.length,
    };
  }

  async list(scope: Omit<SearchKey, "id">) {
    const result = await this.pool.query<SearchRow>(
      `select s.id,s.path,s.query,s.search_type,s.status,s.origin_instance,
              s.created_at,s.items,s.truncated,s.timed_out,s.error_code,s.paused,
              s.progress_sequence,s.scanned_entries,s.scanned_bytes,
              (g.last_heartbeat_at > now() - interval '15 seconds') as origin_alive
         from search_sessions s
         left join search_gateway_instances g on g.id=s.origin_instance
        where s.organization_id=$1 and s.actor=$2 and s.device_id=$3 and s.expires_at>now()
        order by s.created_at desc,s.id desc limit 64`,
      [scope.organizationId, scope.actor, scope.deviceId],
    );
    return { items: result.rows.map(row => this.summary(row)) };
  }
}
