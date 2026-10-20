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
