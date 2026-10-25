/** Pure OAuth input guards. No network fetch of untrusted client metadata. */
export function redirectAllowed(value: string) {
  if (!value || value.length > 1024) return false;
  try {
    const u = new URL(value);
    if (u.username || u.password || u.hash || !u.hostname) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function validResource(value: string, origin: string) {
  return value === origin + "/mcp" || value === origin;
}

export function validChallenge(value: string) {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

export function validClientGrants(value: unknown) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 ||
      !value.includes("authorization_code") || new Set(value).size !== value.length) return false;
  return value.every((v) => v === "authorization_code" || v === "refresh_token");
}

/** Reject ambiguous repeated OAuth query parameters before authorization. */
export function uniqueOAuthQueryParams(params: URLSearchParams): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error("duplicate_parameter");
    }
    values[key] = value;
  }
  return values;
}

/** This authorization server supports only the authorization-code response type. */
export function validClientResponses(value: unknown) {
  return value === undefined ||
    (Array.isArray(value) && value.length === 1 && value[0] === "code");
}
