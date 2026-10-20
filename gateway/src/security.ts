import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

function required(name: string, min = 32) {
  const value = String(process.env[name] || "");
  if (value.length < min) throw new Error(`${name} must be at least ${min} characters`);
  return value;
}

export const controlApiKey = required("CONTROL_API_KEY");
const approvalSecret = required("APPROVAL_SIGNING_SECRET");

export function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function isControlAuthorized(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(controlApiKey);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export type ApprovalRequest = {
  kind: string;
  [key: string]: unknown;
};

export type ApprovalClaim = {
  deviceId: string;
  action: string;
  request: ApprovalRequest;
  exp: number;
  nonce: string;
};

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function deriveDeviceApprovalKey(deviceId: string) {
  return crypto
    .createHmac("sha256", approvalSecret)
    .update(`device:${deviceId}:approval:v1`)
    .digest();
}

export function deviceApprovalKeyForAgent(deviceId: string) {
  return deriveDeviceApprovalKey(deviceId).toString("base64url");
}

export function issueApproval(deviceId: string, request: ApprovalRequest, ttlSeconds = 120) {
  const claim: ApprovalClaim = {
    deviceId,
    action: request.kind,
    request,
    exp: Math.floor(Date.now() / 1000) + Math.max(15, Math.min(ttlSeconds, 600)),
    nonce: randomToken(18),
  };
  const payload = encode(claim);
  const signature = crypto
    .createHmac("sha256", deriveDeviceApprovalKey(deviceId))
    .update(payload)
    .digest("base64url");
  return { token: `${payload}.${signature}`, claim };
}

export function verifyApprovalClaim(
  token: string | undefined | null,
  deviceId: string,
  request: ApprovalRequest,
): ApprovalClaim | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto
    .createHmac("sha256", deriveDeviceApprovalKey(deviceId))
    .update(payload)
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;

  try {
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ApprovalClaim;
    if (
      claim.deviceId !== deviceId ||
      claim.action !== request.kind ||
      !isDeepStrictEqual(claim.request, request) ||
      claim.exp < Math.floor(Date.now() / 1000) ||
      typeof claim.nonce !== "string" ||
      claim.nonce.length < 16
    ) {
      return null;
    }
    return claim;
  } catch {
    return null;
  }
}

export function verifyApproval(
  token: string | undefined | null,
  deviceId: string,
  request: ApprovalRequest,
) {
  return verifyApprovalClaim(token, deviceId, request) !== null;
}

const secretPatterns = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi,
  /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"']+/gi,
  /(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/gi,
];

export function redact(value: unknown) {
  let text = typeof value === "string" ? value : JSON.stringify(value);
  if (text.length > 2_000) text = text.slice(0, 2_000) + "…";
  for (const pattern of secretPatterns) text = text.replace(pattern, "$1[REDACTED]");
  return text;
}
