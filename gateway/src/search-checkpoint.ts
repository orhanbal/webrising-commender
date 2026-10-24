/** Untrusted Agent checkpoint data; the Rust Agent revalidates all paths. */
export type NativeFilenameCheckpoint = {
  version: 1; root: string; query: string; caseSensitive: boolean;
  pending: string[]; items: unknown[]; scannedEntries: number;
};
export type NativeContentCheckpoint = NativeFilenameCheckpoint & {
  searchType: "content"; scannedBytes: number;
};
function isBaseCheckpoint(value: unknown): value is NativeFilenameCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const x = value as Record<string, unknown>;
  if (x.version !== 1 || typeof x.root !== "string" || x.root.length < 1 ||
      x.root.length > 4096 || typeof x.query !== "string" || !x.query ||
      x.query.length > 1024 || typeof x.caseSensitive !== "boolean" ||
      !Number.isSafeInteger(x.scannedEntries) || Number(x.scannedEntries) < 0 ||
      Number(x.scannedEntries) > 100_000 || !Array.isArray(x.pending) ||
      x.pending.length === 0 || x.pending.length > 4096 ||
      x.pending.some(p => typeof p !== "string" || !p || p.length > 4096) ||
      !Array.isArray(x.items) || x.items.length > 500) return false;
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= 128 * 1024; }
  catch { return false; }
}

/** File-name checkpoints cannot masquerade as content checkpoints. */
export function isNativeFilenameCheckpoint(value: unknown): value is NativeFilenameCheckpoint {
  return isBaseCheckpoint(value) &&
    !("searchType" in value) && !("scannedBytes" in value);
}

/** Prior text previews are only hints: Rust re-reads every saved file and
 * verifies its complete matching-line set under the allowlist before replay.
 */
export function isNativeContentCheckpoint(value: unknown): value is NativeContentCheckpoint {
  if (!isBaseCheckpoint(value)) return false;
  const candidate = value as NativeContentCheckpoint;
  return candidate.searchType === "content" &&
    Number.isSafeInteger(candidate.scannedBytes) &&
    candidate.scannedBytes >= 0 && candidate.scannedBytes <= 64 * 1024 * 1024 &&
    candidate.items.every(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const line = item as Record<string, unknown>;
      return Object.keys(line).length === 3 &&
        typeof line.path === "string" && line.path.length > 0 && line.path.length <= 4096 &&
        Number.isSafeInteger(line.line) && Number(line.line) > 0 &&
        typeof line.preview === "string" && line.preview.length <= 1000;
    });
}
