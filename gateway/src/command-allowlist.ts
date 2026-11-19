// DB lookup for the per-device command allowlist; rules live in
// command-allowlist-rules.ts.
import { db } from "./db.js";
import { commandTokens, patternMatches } from "./command-allowlist-rules.js";
export { MAX_ALLOWLIST_ENTRIES, normalizePattern } from "./command-allowlist-rules.js";

export async function allowlistMatch(organizationId: string, deviceId: string, command: string) {
  if (!commandTokens(command)) return null;
  const result = await db.query<{ id: string; pattern: string }>(
    "select id,pattern from device_command_allowlist where organization_id=$1 and device_id=$2 order by created_at",
    [organizationId, deviceId],
  );
  return result.rows.find((row) => patternMatches(row.pattern, command)) ?? null;
}

/** The same rules for an SSH target (connector computer + host). */
export async function sshAllowlistMatch(organizationId: string, centerId: string, hostId: string, command: string) {
  if (!commandTokens(command)) return null;
  const result = await db.query<{ id: string; pattern: string }>(
    `select id,pattern from connector_target_command_allowlist
      where organization_id=$1 and center_id=$2 and host_id=$3 order by created_at`,
    [organizationId, centerId, hostId],
  );
  return result.rows.find((row) => patternMatches(row.pattern, command)) ?? null;
}
