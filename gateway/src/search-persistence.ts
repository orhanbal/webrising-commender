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
export type SearchCompletion = {
  status: "completed" | "error";
  items: unknown[];
  truncated: boolean;
  timedOut: boolean;
  error?: string;
};
export type SearchSummary = {
  searchId: string;
  path: string;
  query: string;
  searchType: "files" | "content";
  status: "running" | "completed" | "error" | "stopped";
  createdAt: string;
  resultCount: number;
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
  /** True only when the running row was atomically transitioned to its final status. */
  finish(key: SearchKey, result: SearchCompletion): Promise<boolean>;
  stop(key: SearchKey): Promise<void>;
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
    await this.pool.query(
      `insert into search_sessions(id,organization_id,actor,device_id,path,query,search_type,status,origin_instance,created_at,expires_at)
       values($1,$2,$3,$4,$5,$6,$7,'running',$8,to_timestamp($9::double precision / 1000),now()+interval '5 minutes')`,
      [s.id, s.organizationId, s.actor, s.deviceId, s.path, s.query, s.searchType, this.originInstance, s.createdAt],
    );
  }

  async finish(s: SearchKey, result: SearchCompletion) {
    let items = result.status === "completed" ? result.items.slice(0, 500) : [];
    let truncated = result.truncated;
    const serialized = JSON.stringify(items);
    if (Buffer.byteLength(serialized, "utf8") > 1024 * 1024) {
      items = [];
      truncated = true;
    }
    const updated = await this.pool.query(
      `update search_sessions
          set status=$5,items=$6::jsonb,truncated=$7,timed_out=$8,error_code=$9
        where id=$1 and organization_id=$2 and actor=$3 and device_id=$4
          and status='running' and expires_at>now()
        returning id`,
      [s.id, s.organizationId, s.actor, s.deviceId,
        result.status, JSON.stringify(items), truncated, result.timedOut, result.error ?? null],
    );
    return Boolean(updated.rowCount);
  }

  async stop(s: SearchKey) {
    const result = await this.pool.query(
      `update search_sessions
          set status='stopped',items='[]'::jsonb,error_code=null
        where id=$1 and organization_id=$2 and actor=$3 and device_id=$4
          and expires_at>now()
        returning id`,
      [s.id, s.organizationId, s.actor, s.deviceId],
    );
    if (!result.rowCount) throw new Error("search_not_found");
  }

  private summary(row: SearchRow) {
    // An active scanner on ANOTHER healthy Gateway remains running. A
    // disconnected/crashed owner is reported interrupted; don't invent
    // resumable native execution after a restart.
    const interrupted = row.status === "running" &&
      row.origin_instance !== this.originInstance && row.origin_alive !== true;
    const status = interrupted ? "error" : row.status;
    const items = status === "completed" && Array.isArray(row.items) ? row.items : [];
    const error = interrupted ? "search_interrupted" : row.error_code;
    return {
      searchId: row.id, path: row.path, query: row.query,
      searchType: row.search_type, status,
      createdAt: new Date(row.created_at).toISOString(),
      resultCount: items.length, truncated: row.truncated,
      timedOut: row.timed_out, ...(error ? { error } : {}),
    };
  }

  async page(scope: Omit<SearchKey, "id">, id: string, offset: number, length: number) {
    const result = await this.pool.query<SearchRow>(
      `select s.id,s.path,s.query,s.search_type,s.status,s.origin_instance,
              s.created_at,s.items,s.truncated,s.timed_out,s.error_code,
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
    const items = summary.status === "completed" && Array.isArray(row.items) ? row.items : [];
    return {
      ...summary, offset, length, items: items.slice(offset, offset + length),
      hasMore: offset + length < items.length,
    };
  }

  async list(scope: Omit<SearchKey, "id">) {
    const result = await this.pool.query<SearchRow>(
      `select s.id,s.path,s.query,s.search_type,s.status,s.origin_instance,
              s.created_at,s.items,s.truncated,s.timed_out,s.error_code,
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
