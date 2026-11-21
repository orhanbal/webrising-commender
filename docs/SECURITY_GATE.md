# WECOMMANDER Security Gate

Security Gate is a **release-blocking, fail-closed set of tests** in the
existing `.github/workflows/ci.yml`. It is not a production network scanner,
a guarantee of security, or a replacement for an independent penetration test.

## Enforcement

Every pull request and push to `main` executes these two CI jobs:

| Required CI job | Gate | Tests / commands |
| --- | --- | --- |
| `security-gate` | SG-01–SG-06 | Isolated tenant checks, RBAC, signed approvals, CSRF, root/trust/autonomy restrictions, OAuth acceptance |
| `security-dependencies` | SG-07–SG-10 | Gitleaks on checked-out source, npm runtime dependency audit for gateway and UI, RustSec advisory audit of Cargo.lock |

Both job names are included in
[`REQUIRED_CI_JOBS`](../scripts/release-gate.mjs).
The existing production release gate checks the **exact commit SHA** and
requires all named CI jobs to succeed before it can promote to `production`.
A missing, skipped, cancelled or failed job prevents production promotion.
Do not remove a failing job from the list to force a release.

The existing mandatory jobs supply additional device-side validation:

- The patched Excel/OOXML writer is validated by a real XLSX roundtrip (preserved source, cell types, and no overwrite) on **Linux, Windows and macOS**. The Windows check is a mandatory `rust-platforms` job; macOS runs in its dedicated `macos` workflow (not part of the Linux production release gate). The current XLSX writer is `umya-spreadsheet 4.0.0-beta.1`, so a production rollout requires explicit reviewer awareness and targeted canary checks.


- `agent-e2e`: live Rust agent + gateway integration, local capability
  ceilings (`--read-only`, `--no-commands`), signed approvals and real
  command behavior.
- `rust` / `rust-platforms`: Rust build, tests and platform-specific filesystem,
  PTY, race and process isolation checks.
- `relay-e2e`: authenticated regional relay behavior.
- `tls-smoke`: HTTPS/WSS acceptance.

Security Gate uses these existing checks **without duplicating a native
Rust build** in the new job.

## Attacker stories and pass conditions

| ID | Negative scenario | Pass condition |
| --- | --- | --- |
| SG-01 | User A asks for user B's devices and tries REST/MCP read or exec | Not enumerated; no device dispatch; foreign device is not found |
| SG-02 | Approval is forged, reused for a different device, or used for altered command parameters | `approval_required`, with denied call audited |
| SG-03 | AI/API token tries to enable full trust, root or autonomy, or change a command allowlist | Browser-session restrictions yield HTTP 403; CSRF still required |
| SG-04 | Viewer OAuth token calls medium/high-risk MCP tools | `forbidden`, denial audited |
| SG-05 | Trust, root, safety-net and autonomy changes attempt to evade browser controls | Existing integration regression tests fail on bypass |
| SG-06 | Invalid OAuth authorization or token operations | Existing OAuth acceptance tests fail |
| SG-07 | Secret-like values accidentally committed in current source tree | Gitleaks exits nonzero |
| SG-08/09 | High or critical advisory affects shipped Node.js runtime dependencies | `npm audit --omit=dev --audit-level=high` exits nonzero |
| SG-10 | Known vulnerable Rust dependency in `Cargo.lock` | `cargo audit` exits nonzero |

### Non-goals for this first stage

- No autonomous exploitation of `wecommander.app` or customer equipment.
- No denial-of-service, password spraying, external port scans or
  production network fuzzing.
- No assertion of root containment merely from gateway authorization tests;
  root security also depends on the device OS, local sudo policy and agent.
- No claim of comprehensive prompt-injection resistance. AI/MCP tool
  authorization is tested, but semantic attacks on AI decision-making require
  a separate adversarial evaluation.
- Gitleaks currently scans the **checked-out tree**, not every historical
  commit. Investigate and rotate historical leaked credentials separately.
- SAST/DAST and multi-platform fuzzing remain separate planned work.

## Safe execution and fixtures

`gateway/test/security-gate-boundaries.mjs` refuses to run unless:

1. `SECURITY_GATE_ISOLATED=true` is explicitly set.
2. `TEST_BASE_URL` resolves to a loopback host.
3. `DATABASE_URL` resolves to a loopback PostgreSQL host.
4. `CONTROL_API_KEY` is set for test-only approval fixture issuance.

It creates random organizations, users, API tokens and **offline fake devices**.
Its test commands are never dispatched to a real machine. The test attempts
to delete its fixtures even when assertions fail. Use disposable PostgreSQL;
do **not** point these checks at a shared or production database, even with
a localhost tunnel.

The existing `command-allowlist-api.mjs` regression is additionally backed
by a fake SMTP receiver; emails stay in CI. All CI credentials in the workflow
are throwaway, non-production values.

## How to run

Open **GitHub → Actions → ci** on a pull request or `main` commit.
Inspect `security-gate` and `security-dependencies` separately.

To reproduce locally, provision an isolated PostgreSQL database and
fake SMTP service, install the gateway dependencies and build it, start the
Gateway bound to `127.0.0.1`, then run the following in `gateway/`:

```bash
# Use the same disposable environment variables as the security-gate CI job.
SECURITY_GATE_ISOLATED=true node test/security-gate-boundaries.mjs
node test/rbac-matrix-e2e.mjs
node test/command-allowlist-api.mjs
node test/oauth-integration.mjs
```

For native isolation validation, follow the existing `agent-e2e` CI job.
For periodic external manual review, run passive ZAP against a dedicated
staging environment; active scanning, load tests and agent fuzzing need
explicit scope and disposable targets.

## Failure triage

1. Identify the exact failed SG test and affected commit.
2. For a denial-boundary regression, mark the release blocked and inspect
   the audit logs, auth/tenant predicates, device routing and agent checks.
3. For an advisory or secret scan, verify the finding, patch/revoke the
   affected material, and rerun CI. Avoid blanket ignores.
4. Preserve sanitized evidence (test name, revision, outcome) in a GitHub
   issue or review. Never paste raw credentials or tokens into logs.
5. Re-enable deployment only when all required CI jobs are green at the
   intended SHA. Approval by a human is *additional* to these checks.

## Current confidence

This is an automated **regression and dependency security gate**.
It does not prove absence of vulnerabilities. Independent manual pentesting,
threat-model review, and dedicated Windows/macOS adversarial scenarios remain
necessary for security acceptance.
