# WECOMMANDER — ChatGPT MCP OAuth 2.1 / PKCE

## Activation

The Gateway's OAuth authorization service is opt-in. Keep the existing CONTROL_API_KEY, API tokens and native Agent pairing unchanged.

1. Configure the actual externally reachable HTTPS origin in PUBLIC_BASE_URL (for example https://commander.example.com). Production must use HTTPS (native TLS or a trusted HTTPS reverse proxy).
2. Set MCP_OAUTH_ENABLED=true in the Gateway runtime environment and deploy after passing tests.
3. Confirm the Agent is paired and online; OAuth authenticates ChatGPT-to-Gateway, not Gateway-to-Agent.
4. In ChatGPT, create a custom MCP plugin using https://commander.example.com/mcp and select OAuth. The Gateway advertises dynamic client registration; browser login and per-client consent follow.
5. Use a viewer or operator account, never distribute CONTROL_API_KEY to clients. Elevated/high-risk actions retain their explicit human approval flow.

## Discovery and endpoints

- GET /.well-known/oauth-protected-resource
- GET /.well-known/oauth-protected-resource/mcp
- GET /.well-known/oauth-authorization-server
- POST /oauth/register (public clients, approved HTTPS or loopback redirect URIs)
- GET/POST /oauth/authorize (browser session, visible consent, CSRF)
- POST /oauth/token (authorization_code + S256 PKCE, refresh_token rotation)
- POST /oauth/revoke
- POST /mcp (resource-bound Bearer OAuth token or existing permitted credentials)

Authorization server issuer: PUBLIC_BASE_URL origin. The resource audience is the /mcp URL; for compatibility the gateway also accepts the exact origin. Cross-server resource values are rejected.

## Security and lifecycle

- OAuth client IDs, SHA-256 hashes of codes/access tokens/refresh tokens, identities and audiences live in PostgreSQL. Raw tokens are returned only at issuance.
- 5-minute one-time authorization code, 1-hour bearer access token, 30-day rotating refresh token; revocation invalidates both.
- Login uses the existing verified browser account system. User disablement or membership removal invalidates bearer authorization at the next request.
- Browser consent uses the current browser session's CSRF token; POST authorization code issuance requires explicit allow.
- OAuth tokens are accepted **only** on /mcp; browser/admin REST authorization remains separate.
- Per-tool securitySchemes advertises mcp:tools; exact-command high-risk approval still applies independently.
- A default-disabled feature flag keeps existing deployments compatible.

## Acceptance checklist

- Gateway typecheck, unit/security tests and GitHub Actions green.
- Over HTTPS validate OAuth protected-resource metadata, authorization-server metadata and 401 WWW-Authenticate.
- DCR registers a client; invalid/insecure callback is rejected.
- Signed-in user can consent; unsigned/CSRF-less request cannot grant access.
- PKCE incorrect verifier, reused authorization code and mismatched resource are rejected.
- Valid OAuth access token successfully performs MCP initialize and tools/list for its organization only; no access to /api/console.
- Refresh rotates tokens; old refresh and revoked access fail.
- HIGH-risk tools continue to create an approval request.
- Complete **real ChatGPT connection** and **Agent terminal command** tests before declaring production accepted.

The OAuth module does not bypass existing human-in-the-loop approvals or expand agent filesystem allowlists. Never enable anonymous remote command execution.
