// Local stdio mode (v1.1 item 4): the Rust agent serves MCP itself, without a
// gateway. Its tool list is generated from the gateway's tool definitions so
// both modes offer the same names, descriptions and argument schemas.
// crates/agent/src/local_tools.json is the generated copy; local-tools.test.ts
// fails when it drifts. Regenerate with: npm run -s export-local-tools
import { actionFromTool, tools } from "./mcp.js";

type Schema = { type?: string; properties?: Record<string, any>; required?: string[]; items?: any; enum?: unknown[] };
type Tool = { name: string; description: string; inputSchema: Schema };

const snakeToCamel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** The conversion the agent applies to MCP arguments: drop gateway-only keys,
 *  camelCase the rest, set kind. Mirrors crates/agent/src/stdio_mcp.rs. */
export function genericAction(name: string, args: Record<string, unknown>) {
  const out: Record<string, unknown> = { kind: name };
  for (const [key, value] of Object.entries(args)) {
    if (key === "device_id" || key === "approval_token") continue;
    out[snakeToCamel(key)] = value;
  }
  return out;
}

/** A representative value for a JSON schema, used to compare conversions. */
export function sample(schema: any, key = ""): unknown {
  if (schema?.enum?.length) return schema.enum[0];
  switch (schema?.type) {
    case "integer": case "number": return key.includes("offset") ? 0 : 3;
    case "boolean": return true;
    case "array": return [sample(schema.items, key)];
    case "object": return {};
    default: return key.includes("base64") ? "aGk=" : key.includes("sha256") ? "a".repeat(64) : "x";
  }
}

function sampleArgs(tool: Tool) {
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(tool.inputSchema.properties ?? {})) args[key] = sample(schema, key);
  return args;
}

/** Tools the agent can serve directly: their action kind equals the tool name. */
export function localTools(): Tool[] {
  return (tools as Tool[]).flatMap((tool) => {
    let action: { kind?: string };
    try { action = actionFromTool(tool.name, sampleArgs(tool)) as { kind?: string }; } catch { return []; }
    if (action?.kind !== tool.name) return [];
    const properties = { ...(tool.inputSchema.properties ?? {}) };
    delete properties.device_id; delete properties.approval_token;
    const required = (tool.inputSchema.required ?? []).filter((r) => r !== "device_id" && r !== "approval_token");
    return [{ name: tool.name, description: tool.description, inputSchema: { type: "object", properties, required, additionalProperties: false } as Schema }];
  });
}

