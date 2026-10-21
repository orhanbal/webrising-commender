# WECOMMANDER — Final Acceptance Plan

Updated: 2026-10-21
Baseline main: `c4d1ed6427301bc755fcb622aa87f46244f2fcfc`

This is the canonical closure plan for v1.0 acceptance. Update this file after every completed gate.

## Rules

- Do not add paid or third-party runtime/SaaS dependencies.
- Preserve the free self-hosted core.
- Prefer first-party/local solutions.
- Do not mark external acceptance complete without a real environment test.
- Product changes use feature-branch validation and green CI before main.
- Record blockers explicitly instead of pretending a gate passed.

## Final plan

- [x] **1. Baseline and closure plan**
  - Current main recorded.
  - Main CI baseline already green.
  - Final external acceptance gates consolidated here.

- [ ] **2. Production deployment and HTTPS/WSS**
  - [x] Coolify project exists: **WECOMMANDER** / production.
  - [x] Coolify application exists and points to `orhanbal/webrising-commender` / `main`.
  - [x] Coolify production compose entrypoint added at `/docker-compose.yaml`.
  - [x] Production target domain standardized as `https://wecommander.webrising.tr`.
  - [ ] Coolify application must receive three required secret env values:
    - `POSTGRES_PASSWORD`
    - `CONTROL_API_KEY`
    - `APPROVAL_SIGNING_SECRET`
  - [ ] Coolify gateway service must be assigned FQDN `https://wecommander.webrising.tr`.
  - [ ] Deploy current main after the final acceptance package is merged.
  - [ ] Verify external HTTPS health, HSTS and WSS agent upgrade.
  - Current blocker: Coolify MCP can deploy/control existing resources but cannot mutate application configuration or environment values. The one-time secret/FQDN UI step requires the owner.

- [ ] **3. Production backup/restore acceptance**
  - [x] Backup/restore scripts support selecting a production Compose file/project via `COMMANDER_COMPOSE_FILE` / `COMMANDER_COMPOSE_PROJECT`.
  - [x] Restart soak runner supports the same production Compose selection.
  - [x] Backup archive checksum/manifest and destructive restore round-trip are already covered in CI.
  - [ ] BLOCKED until Step 2 deployment exists: produce a real production backup.
  - [ ] Validate production checksum/manifest.
  - [ ] Run controlled destructive production restore acceptance.
  - [ ] Confirm API/data after restore.

- [ ] **4. Real Windows acceptance**
  - Enroll a real Windows machine.
  - Install native Windows Service.
  - Verify service survives restart and reconnects automatically.
  - Verify file/process/PTY/task operations.

- [ ] **5. Real reconnect and soak acceptance**
  - Start a persistent task/PTY.
  - Restart gateway/container and/or interrupt network.
  - Verify device reconnect.
  - Verify long-running task/PTY rediscovery and continuity.

- [ ] **6. Real ChatGPT MCP acceptance**
  - Connect the production MCP endpoint from the intended ChatGPT client.
  - List devices.
  - Execute LOW/MEDIUM operations.
  - Verify HIGH-risk denial without approval and success with exact approval.

- [ ] **7. Real Linux systemd acceptance**
  - Install on a real Linux machine.
  - Verify start/stop/restart/boot behavior and reconnect.

- [ ] **8. Real macOS LaunchAgent acceptance**
  - Install on a real macOS machine if one is available.
  - Verify login/start/restart/uninstall behavior.
  - If no macOS machine is available, record as an external platform blocker rather than blocking the usable Windows/server v1.

- [ ] **9. Final security and operations audit**
  - [x] Audit pass identified and fixed: strict PUBLIC_BASE_URL origin validation.
  - [x] Audit pass identified and fixed: relay RPC redirects disabled and timeout parsing bounded.
  - [x] Audit pass identified and fixed: non-loopback plaintext SMTP rejected by default.
  - [x] Audit pass identified and fixed: query limit parsing cannot inject NaN into SQL limits.
  - [x] Base Compose now passes TRUST_PROXY_HEADERS and explicit SMTP transport policy.
  - Review exposed endpoints, auth boundaries, relay HMAC/TLS, secrets and logs.
  - Verify backup/restore docs and install/uninstall docs.
  - Verify no paid/third-party runtime dependency entered the product.
  - Run final full CI on main.

- [ ] **10. v1.0 closure**
  - Update phase status and master plan.
  - Record any genuine hardware/platform blockers.
  - Create the v1.0 release/tag only after all applicable gates are green.

## Current estimate

The software implementation is approximately 95% complete. The remaining work is dominated by real-environment acceptance. Production deployment preparation is complete; the first external blocker is the one-time Coolify resource creation because the connected Coolify MCP exposes deploy/control but not create-resource.
