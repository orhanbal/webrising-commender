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


## Public signup, verification and password reset

Public signup is disabled by default and becomes available only when `PUBLIC_SIGNUP_ENABLED=true` and a first-party mail delivery mode is configured.

- Public signup never creates a login-capable account before email verification.
- Signup passwords are converted to salted scrypt verifiers before pending registration state is stored.
- Verification and password-reset bearer tokens are random, single-use, expiring values; PostgreSQL stores only SHA-256 verifiers.
- Verification and reset links place tokens in URL fragments (`#verify=...`, `#reset=...`) so normal HTTP request URLs and reverse-proxy access logs do not receive the bearer secret.
- Public endpoints are IP/account/token rate-limited.
- Password-reset request responses do not disclose whether an account exists.
- Successful password reset revokes every browser session for the user.
- Accepting a trusted workspace invitation or creating a user through the authenticated admin API marks that address as verified and invalidates any older pending public-verification material.
- Consumed/superseded auth mail bodies are scrubbed from the outbox.

The built-in SMTP client uses Node's native `net`/`tls` modules. It supports local plaintext relay, STARTTLS and implicit TLS. SMTP credentials over plaintext are rejected for non-loopback hosts unless the operator explicitly enables `SMTP_ALLOW_INSECURE_AUTH=true`.

`MAIL_DELIVERY_MODE=outbox` is intended for development/manual diagnostics: messages remain in PostgreSQL and are not delivered. Production public signup/reset should use `MAIL_DELIVERY_MODE=smtp` with the operator's own mail server or local relay.
