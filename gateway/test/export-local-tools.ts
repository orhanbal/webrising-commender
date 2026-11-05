// Regenerates crates/agent/src/local_tools.json from the gateway tool list.
// Usage: npm run -s export-local-tools
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.DATABASE_URL ??= "postgres://unused@127.0.0.1:1/unused";
process.env.CONTROL_API_KEY ??= "export-control-key-0123456789-0123456789";
process.env.APPROVAL_SIGNING_SECRET ??= "export-approval-secret-0123456789-01234";
const { localTools } = await import("../src/local-tools.js");
const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../crates/agent/src/local_tools.json");
fs.writeFileSync(target, JSON.stringify(localTools(), null, 1) + "\n");
console.log("wrote", target, localTools().length, "tools");
