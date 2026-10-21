# Security

## Default-deny boundaries

- The native agent never opens a listening port.
- Filesystem operations are restricted to configured roots.
- Device credentials are random and stored server-side as hashes.
- Pairing codes are single-use and expire.
- High-risk operations require a signed approval token.
- Request and response bodies are size-capped.
- Audit text passes through secret redaction before storage.

## Local file policy

For existing paths, the agent canonicalizes the path before checking it against allowed roots. For new paths it canonicalizes the closest existing parent and then reconstructs the final path. Symlink traversal outside a root is rejected.

## Approval claims

A valid claim binds:
- device id
- action family
- the exact operation payload and parameters
- expiry
- nonce

The gateway derives a unique per-device approval verification key from `APPROVAL_SIGNING_SECRET` and the device id. Only the derived device key is provisioned during enrollment; the master signing secret never leaves the gateway.

For HIGH-risk actions, the gateway validates and atomically consumes the one-time approval before dispatch. The native agent independently verifies the HMAC signature, device id, action, exact parameters and expiry before executing the operation. Changing a command, path, PID, PTY session id or any other approved parameter invalidates the approval. A compromised relay path therefore cannot turn an arbitrary string into local approval.

## Logging

Never intentionally log:
- Authorization headers
- device tokens
- pairing codes
- approval signing secret
- database passwords
- raw environment files

The redactor masks common bearer/API-key/password/token patterns in audit summaries.

## Service installation

Install scripts are explicit. The agent does not silently install persistence or hide itself. Removal scripts are provided.


## Browser authentication

The web console supports first-class browser sessions in addition to control/API tokens.

- Passwords are stored only as salted scrypt verifiers.
- Browser session tokens are random and only their SHA-256 verifier is persisted.
- The session cookie is HttpOnly, SameSite=Strict, and Secure when `PUBLIC_BASE_URL` is HTTPS.
- Mutating cookie-authenticated requests require a per-session CSRF token.
- Login attempts are rate-limited.
- Browser users receive organization-scoped RBAC from `organization_members`.
- Password changes revoke the user's other browser sessions.
- The global `CONTROL_API_KEY` remains a deployment/bootstrap credential and should not be used as a normal SaaS user login.


## Invitations and membership safety

Workspace invitation URLs are bearer secrets. The raw invitation token is never persisted; only its SHA-256 verifier is stored.

- Invitation preview and acceptance endpoints are independently rate-limited.
- Invitation links place the bearer token in the URL fragment (`#invite=...`), which browsers do not send in HTTP request URLs; preview sends the token in a POST body to avoid proxy/access-log leakage.
- Invitations are single-use, expiring, and revocable.
- Existing accounts must prove knowledge of their current password before an invitation can create a new membership.
- New accounts are created only while consuming a valid invitation.
- Membership role updates and removals serialize the workspace membership rows before enforcing the last-owner invariant.
- Admins cannot grant or manage a role above their own role.
- Removing a member revokes that member's browser sessions scoped to the workspace.
- Open unauthenticated self-registration is intentionally not enabled before email-verification and billing-abuse controls exist.


## Billing and entitlement boundary

Billing state cannot be modified by tenant-scoped admins. Plan catalog changes, manual subscription assignments and normalized billing events require the global control credential. Manual assignments are deliberately provider-neutral: provider/customer/subscription identifiers can enter durable state only after a provider-specific adapter has verified and normalized an event.

SaaS quota enforcement is server-side and transaction-bound:

- device limits are enforced again when an enrollment actually consumes a device slot;
- pending invitations reserve member capacity;
- direct member creation and invitation acceptance serialize on the organization row;
- tenant API-token creation serializes on the same organization row;
- subscription/event state changes take that organization lock as well.

This prevents concurrent allocation requests from oversubscribing the last available slot.

A non-entitled or `past_due`/canceled organization keeps its existing resources but cannot allocate new billable resources. This avoids destructive billing side effects while still enforcing the commercial boundary.

Normalized billing events are stored without raw webhook bodies or payment credentials. Event idempotency is keyed by `provider + event_id`. A replay with the same normalized payload is a no-op; reusing the same event id with different normalized data is rejected as `billing_event_conflict`.

Every normalized provider event must also carry a verified provider occurrence timestamp. Once a provider event has advanced an organization's subscription state, older events from that provider are retained in the event ledger but ignored for state mutation. A different event with the exact same occurrence time is treated as `billing_event_order_conflict` rather than guessed into an order; the adapter must reconcile against the provider's authoritative subscription snapshot. Events from a different provider are ignored while the subscription is bound to the current provider. This prevents delayed webhooks from rolling subscription state backward or a retired provider from overwriting the active provider.

The internal normalized-event API is not a substitute for provider webhook verification. Any Paddle, Stripe or other adapter must verify the provider's signature and map trusted provider identifiers to an organization before calling the internal billing event layer.


## Email verification, reset and outbox security

Public signup is available only when `DEPLOYMENT_MODE=saas`, `PUBLIC_SIGNUP_ENABLED=true`, and local SMTP/outbox encryption are configured.

- A public signup remains in `pending_signups`; it does not create a user or organization before verification.
- Verification requires both the one-time email token and the signup password. A mailbox link alone cannot activate an attacker-chosen password.
- Verification/reset bearer tokens are stored only as SHA-256 verifiers and are carried in URL fragments, not page-request query strings.
- Public signup, verification, reset request and reset confirmation each have independent IP/account/token rate limits.
- Password reset responses do not reveal whether an account exists.
- Reset completion revokes all active browser sessions and consumes every outstanding reset token for the user.
- Existing bootstrap/admin/invitation-created accounts are marked verified by their trusted provisioning path; legacy users are marked verified during migration to avoid lockout.
- Mail recipient, subject and body are encrypted together with AES-256-GCM before persistence. The outbox stores only a recipient hash plus ciphertext/nonce/tag.
- The outbox key is a dedicated secret and is never stored in PostgreSQL.
- SMTP STARTTLS/TLS certificate validation defaults to enabled. Disabling `SMTP_TLS_REJECT_UNAUTHORIZED` weakens transport authentication and is not recommended for production.
- Delivery retries are bounded. Exhausted messages enter a dead-letter state instead of retrying forever.
- Operational outbox APIs expose delivery metadata/errors only, never decrypted payloads or recipient addresses.


## Regional relay security boundary

Regional relay mode is optional and first-party. Relay nodes are trusted members of the Commender control plane; they are not third-party services.

- Every node has a distinct `CLUSTER_NODE_ID`.
- Inter-node request payloads are authenticated with HMAC-SHA256 over HTTP method, path, timestamp, nonce and exact body hash.
- Relay requests outside a short clock window are rejected.
- A valid nonce is accepted only once per relay process, preventing captured-request replay inside the acceptance window.
- A relay executes an internal device request only when that device is currently recorded as connected to that exact relay and its local socket is ready.
- Agent WebSocket upgrade requires the normal device token and, in clustered mode, the device must be assigned to the current healthy/non-draining relay.
- Regional route refresh is device-token authenticated and separately rate-limited.
- Outside loopback, public relay URLs must use `wss://` and private inter-node URLs must use `https://` unless an operator explicitly sets `RELAY_ALLOW_INSECURE_TRANSPORT=true`.
- HMAC authenticates/integrity-protects the internal payload but is not a confidentiality layer; production inter-node traffic must use TLS.
- `RELAY_CLUSTER_SECRET` is a dedicated cluster secret. Do not reuse `CONTROL_API_KEY`, device tokens or approval-signing secrets.
- PostgreSQL must remain private to trusted control-plane/relay nodes and must never be exposed publicly. Network ACL/firewall policy should restrict database access to those nodes only.
- Relay `drain` preserves existing connections; `enabled=false` removes the node from routing immediately.

A compromise of a trusted relay node is treated as control-plane infrastructure compromise. Rotate the cluster secret, disable the node, rotate infrastructure credentials and review audit/device presence records.


## Native TLS termination

Commender can terminate HTTPS/WSS directly without nginx, Caddy or another runtime proxy.

- Configure `TLS_CERT_FILE` and `TLS_KEY_FILE` together. Partial configuration fails startup.
- The private key is read from the filesystem and is never persisted to PostgreSQL.
- Keep the private-key file readable only by the gateway runtime identity and mount it read-only when using containers.
- Native TLS requires an HTTPS `PUBLIC_BASE_URL`; this keeps generated links and Secure-cookie behavior aligned with the actual public transport.
- Minimum protocol version defaults to TLS 1.2. Only TLS 1.2 or TLS 1.3 may be selected.
- Public certificates must chain to a CA trusted by the browsers, AI clients and native agents that connect to the deployment.
- The container-local healthcheck may skip certificate verification only to test the already-local gateway process; this does not disable TLS verification for external clients or agents.
- HSTS is emitted on HTTPS deployments but does not opt unrelated subdomains into HSTS.

If an existing reverse proxy terminates TLS, leave the native TLS file settings empty and keep the proxy-to-gateway link constrained to the trusted local/private network.
