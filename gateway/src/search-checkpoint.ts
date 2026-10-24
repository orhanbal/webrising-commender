/** Untrusted Agent checkpoint data; the Rust Agent revalidates all paths. */
export type NativeFilenameCheckpoint = {
  version: 1; root: string; query: string; caseSensitive: boolean;
  pending: string[]; items: unknown[]; scannedEntries: number;
};
export function isNativeFilenameCheckpoint(value: unknown): value is NativeFilenameCheckpoint {
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
