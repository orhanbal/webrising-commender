# WECOMMANDER — Final Acceptance Plan

Updated: 2026-10-21
Initial acceptance baseline: `c4d1ed6427301bc755fcb622aa87f46244f2fcfc`
Production deployed commit (owner-reported): `21daec39d1836384a1b6bbde230613ad5c79fe24`
Windows acceptance bundle integrated into main: `dd3945e7de16fcb28df4ead7974cbd649d078a24`

This is the canonical closure plan for v1.0 acceptance. Update after each verified gate. **CI success is not a substitute for production or physical-device acceptance.**

## Rules

- No paid or third-party runtime/SaaS dependencies; preserve the free, self-hosted core.
- No new product features during final acceptance. Fix only demonstrated defects.
- Use feature branch → green CI → single squash commit to main for subsequent changes.
- Record external blockers and unverified states; never mark them as passed.
- Do not run destructive production restore without a verified backup, maintenance window and authorized shell access.

## CI / Windows acceptance package — VERIFIED (2026-10-21)

- [x] PR #12 (`ci: add WECOMMANDER Windows acceptance bundle`) head `43e2503dc00f3c1bbabbf87ab5c8d26e9523df96` passed its CI run `39649906237` (14/14 jobs green).
- [x] The same two-file patch (Windows acceptance artifact workflow and Windows service display name) is already in main as the **single** commit `dd3945e7de16fcb28df4ead7974cbd649d078a24`. PR #12 is **closed, unmerged**; do not claim it was squash-merged or duplicate the patch.
- [x] Main push CI run `39650931775` on `dd3945e7de16fcb28df4ead7974cbd649d078a24` completed **success**, with all 14 checks green.
- [x] Main-run artifact `WECOMMANDER-windows-x64-acceptance` exists (artifact ID `12369441425`, 3,021,637 bytes, SHA-256 archive digest `a9d1f81d946cb8eb562639d7d564fe0a1db81690ae78a574a6a62fcdd715f502`). GitHub retention: **until 2026-11-04 18:17:54 UTC**, unless removed earlier.
- [x] The artifact workflow packages the release-mode Windows agent EXE, installer, uninstaller, quickstart and executable SHA-256 checksum file.
- [ ] Physical Windows device validation with this artifact remains pending.

Main CI: https://github.com/orhanbal/webrising-commender/actions/runs/39650931775
Main artifact: https://github.com/orhanbal/webrising-commender/actions/runs/39650931775/artifacts/12369441425
PR #12: https://github.com/orhanbal/webrising-commender/pull/12

## Final plan

- [x] **1. Baseline and closure plan**
  - Baseline and external acceptance gates documented.
  - Windows artifact integration and green main CI recorded above.

- [ ] **2. Production deployment and HTTPS/WSS**
  - [x] Coolify project/application exists: **WECOMMANDER** / production; source is `orhanbal/webrising-commender` / `main`.
  - [x] Production Compose entrypoint: `/docker-compose.yaml`.
  - [x] Target domain: `https://wecommander.webrising.tr`.
  - [x] Owner reports production running:healthy at commit `21daec39`.
  - [ ] Verify current Coolify secret values are present **without disclosing them**: `POSTGRES_PASSWORD`, `CONTROL_API_KEY`, `APPROVAL_SIGNING_SECRET`.
  - [ ] Verify gateway FQDN, external HTTPS health, HSTS and WSS upgrade from outside the deployment.
  - [ ] Decide controlled deployment of main `dd3945e7` (or later verified acceptance commit) to production, then reverify. **Do not assume CI changed the deployed commit.**
  - Note: older claim that Coolify resources still need creation is obsolete; running production has been reported. External verification is still pending.

- [ ] **3. Production backup/restore acceptance — BLOCKED**
  - [x] Backup/restore and restart soak scripts support `COMMANDER_COMPOSE_FILE` / `COMMANDER_COMPOSE_PROJECT`.
  - [x] CI covers backup archive checksum/manifest and destructive restore in a **test stack**.
  - [ ] Real production backup, checksum/manifest verification, controlled destructive restore and post-restore API/data validation.
  - **Blocker:** server shell access unavailable due to Desktop Commander monthly usage quota. Production restore has **not** been performed. Do not mark this gate complete or substitute the CI restore test.

- [ ] **4. Real Windows acceptance — WAITING FOR PHYSICAL DEVICE**
  - [x] Release-mode Windows x64 acceptance artifact generated and available (see above).
  - [x] Windows service smoke passed in CI.
  - [ ] On the **venture** Windows device: download main-run artifact before retention expiry, verify checksums, enroll device and install native Windows Service.
  - [ ] Verify service startup, boot/restart persistence, reconnect and file/process/PTY/task operations.
  - **Blocker:** physical access to venture device not currently available. No real-device pass claimed.

- [ ] **5. Real reconnect and soak acceptance**
  - [ ] Start persistent task/PTY, restart gateway/container or interrupt network, then verify reconnect, task rediscovery and continuity.

- [ ] **6. Real ChatGPT MCP acceptance**
  - [ ] Connect production MCP from intended ChatGPT client, list devices, execute LOW/MEDIUM operations, and verify HIGH-risk denial/approval behavior.

- [ ] **7. Real Linux systemd acceptance**
  - [ ] Verify install, start/stop/restart/boot and reconnect on a real Linux machine.

- [ ] **8. Real macOS LaunchAgent acceptance**
  - [ ] Verify login/start/restart/uninstall on a real macOS machine, if available.
  - If unavailable, record as an external platform limitation rather than falsely marking it complete.

- [ ] **9. Final security and operations audit**
  - [x] Strict `PUBLIC_BASE_URL` origin validation.
  - [x] Relay RPC redirects disabled and timeout parsing bounded.
  - [x] Non-loopback plaintext SMTP rejected by default.
  - [x] Query limit parsing prevents NaN injection into SQL limits.
  - [x] Base Compose passes `TRUST_PROXY_HEADERS` and explicit SMTP transport policy.
  - [x] Main CI for Windows artifact commit `dd3945e7` green (14/14 checks).
  - [ ] Final manual review of exposed endpoints, auth boundaries, relay HMAC/TLS, secrets/logs, backup/restore docs and install/uninstall docs.
  - [ ] Confirm no paid/third-party runtime/SaaS dependency was introduced; repeat full main CI after any future change.

- [ ] **10. v1.0 closure**
  - [ ] Update phase status and master plan when applicable external gates are evidenced.
  - [ ] Record real hardware/platform blockers.
  - [ ] Tag/release v1.0 only after all applicable acceptance gates are green.

## Current state / next actions

**CI/package gate complete. Overall final acceptance is not complete.** The immediate verified output is a downloadable Windows x64 acceptance artifact built from main. Next operational steps are (1) preserve/download the expiring artifact, (2) test on the venture Windows device when physically accessible, (3) restore authorized server shell access and perform a controlled production backup/restore, and (4) finish HTTPS/WSS, MCP, reconnect and platform tests. Do not interpret a production `running:healthy` report as proof of backup/restore or real Windows acceptance.
