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
