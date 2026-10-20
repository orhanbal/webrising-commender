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
- expiry
- nonce

The gateway signs the canonical claim with `APPROVAL_SIGNING_SECRET`. The agent receives the claim alongside the operation, and the gateway verifies the claim before dispatch. Future hardened releases may additionally provision a public verification key to the agent.

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
