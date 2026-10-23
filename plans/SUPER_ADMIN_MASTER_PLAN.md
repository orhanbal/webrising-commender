# WECOMMANDER — Super Admin Master Plan

Status: IN PROGRESS (2026-10-23). Full CI passed on previous baseline. User detail, remaining admin translations and browser/API acceptance added; latest CI and production release gates still require verification.

## Decision

- Dedicated operator console route: `/console`, separate from tenant UI `/dashboard`.
- First intended super administrator email: `orhanbal@gmail.com`.
- Default user interface language English; Turkish is selectable and persisted.
- Light/dark mode and mobile/tablet responsiveness remain supported.
- No email service required for **initial server-local bootstrap**. Email verification and SMTP will be configured before public launch with a WECOMMANDER-branded sender.
- **Never** infer super-admin privileges from an email match or from organization `owner`/`admin` role.
- No public bootstrap endpoint, seeded password, environment variable super-admin password, or login bypass.

## Security invariants

1. Introduce a platform-level grant stored separately from `organization_members`, e.g. `platform_administrators(user_id, granted_at, granted_by, revoked_at)`. Only authenticated, non-disabled sessions with an active grant can enter `/console` or call `/api/console/*`.
2. Prefer enforcing platform permission in shared middleware per request, never relying on frontend navigation checks alone.
3. A control API token is **not** automatically a human super-admin session.
4. Initial bootstrap is a one-shot command executed within the authorized gateway runtime. It takes the email and password securely (interactive input or protected stdin), hashes the password with existing scrypt implementation, creates user and owner organization membership transactionally, and issues the first platform grant. Refuse to bootstrap if a platform administrator already exists unless using a separate, explicitly authorized recovery procedure.
5. No password or reset token in logs, commits, process command arguments, deployment logs, URLs, or support messages.
6. Require CSRF checks for cookie-authenticated mutations, rate limits for auth, immutable audit events for platform changes, and elevated reauthentication/step-up for high impact actions.
7. Use existing tenant boundaries; global support access must be deliberately scoped, logged, and never silently grant filesystem/terminal access to customer devices.
8. Configurable content must be sanitized and revisioned. Avoid arbitrary HTML/script injection and do not expose secret configuration values in admin API responses.

## Phases and acceptance

Legend: [x] implementation committed, [ ] acceptance or implementation still required. A checked box does not imply verified production acceptance.

### Phase A — Auth and first account
- [x] Independent platform grants, platform audit schema and server-only bootstrap CLI.
- [x] Guarded console API routes; organization owner is **not** a platform administrator.
- [x] Test coverage added for 401 unauthenticated, 403 owner/API token, 200 granted session, immediate revoked grant, CSRF and unverified account rejection.
- [x] Repeated migration no longer automatically verifies accounts.
- [x] Console mutations rate-limited by authenticated account and source IP.
- [ ] Validate the production first-admin bootstrap state and account recovery with an authorized human session.
- [ ] Prove production session persistence across a deploy; verify restorable database backups.

### Phase B — Console shell
- [x] Responsive /console route, dedicated sidebar and shared profile menu.
- [x] EN/TR language selector and light/dark toggle reused in console.
- [x] Database-backed overview; user, organization, device, audit, billing, CMS, brand and system sections.
- [x] Browser screenshot acceptance added for desktop/mobile console and multiple sections.
- [x] Localized console navigation/core actions and legal CMS into Turkish; modal focus/Escape keyboard acceptance added.
- [ ] Complete Turkish audit across every dynamic admin label, responsive contrast audit and authenticated production browser acceptance.

### Phase C — Users and organizations
- [x] User listing/search/pagination, audited disable/enable with password reauthentication.
- [x] User session inventory and audited forced session revocation, excluding own session and protected platform administrators.
- [x] Password/token-free user detail panel with platform grant, verification state, workspace membership roles, session count and accessible modal; API/browser/authorization tests committed.
- [x] Workspace membership browser and viewer/operator/admin role changes with step-up and owner-role protection.
- [x] Organization-specific quota overrides and editable plan limits.
- [x] Server-side organization search, 25-row pagination/total counts; user totals and pagination boundary checks.
- [ ] Bulk operations, detailed organization lifecycle, protected owner transfer/recovery and further lifecycle acceptance.

### Phase D — Devices and operations
- [x] Cross-workspace read-only device inventory and unified tenant/platform audit timeline.
- [x] Audit timeline now supports bounded server-side search, platform/workspace source and risk filters, total counts and paginated UI with API/browser regression checks.
- [x] Cross-workspace device inventory now supports bounded server-side search, active/revoked filtering and accurate pagination; no unverified online-status claim.
- [x] Live system counts for relay health, active sessions, pending approvals and mail queue.
- [ ] Agent enrollment/heartbeat/relay failover and terminal/file/task operations on real Windows, macOS and Linux devices.
- [x] Live incident detection for mail failures and stale relay heartbeats, audited password-confirmed incident acknowledgement (no automatic repair or suppression).
- [ ] Off-platform alert delivery, incident history/retention, customer-authorized remote support controls and real-device acceptance.

### Phase E — Billing
- [x] Read-only plans/subscriptions reporting and password-confirmed plan/organization quota editors.
- [x] Existing Paddle webhook integration tests provide synthetic subscription lifecycle coverage.
- [x] Owner cancellation/refund support request submission, duplicate-open protection, request history and audited super-admin review queue. These do not execute provider transactions.
- [ ] Paddle provider status, actual cancellation/refund execution with authenticated provider reconciliation, real sandbox/live checkout acceptance.
- [x] Support review never changes subscription status, entitlement, or executes a Paddle refund (integration assertion added).

### Phase F — Landing CMS and brand
- [x] Versioned EN/TR hero and 106 landing copy strings with grouped editor, draft/publish/rollback, publish reauthentication and live rendering.
- [x] SEO title/description per locale, safely escaped SSR homepage tags, canonical and Open Graph metadata.
- [x] Light/dark PNG/WebP logos and favicon storage, safe public fallback and password-confirmed asset upload.
- [x] Browser and API tests for landing card visibility, revision publish/rollback, escaping and failed reauthentication.
- [x] Plain-text EN/TR privacy and terms editor, drafts, password-confirmed publish/restore, public pages and API/browser coverage added (CI acceptance pending).
- [x] Structured editing of existing FAQ question/answer pairs and SVG image input converted to validated PNG before upload.
- [x] Password-protected PNG/WebP media library with SVG-to-PNG conversion, immutable asset IDs, audited uploads, and feature-card images selected through revisioned CMS publication.
- [x] Unpublished images are not exposed by the public media endpoint; drafts use a separately authorized preview endpoint. Publication and removal boundaries have integration coverage.
- [ ] Legally approved final documents, arbitrary FAQ creation/order, media collection lifecycle, full section reordering and authenticated production browser acceptance.

### Phase G — System settings
- [x] Safe read-only mail queue, active sessions, relay, approval, deployment mode and signup health reporting.
- [x] Visual system health dashboard, warning indicators and incident-review controls.
- [x] Backend incident fingerprinting and password-confirmed acknowledgement with no automatic suppression; browser/API acceptance added.
- [x] Canonical Compose backup script hardened against overwrites, with non-destructive isolated restore drill and separate test-database CI backup/restore acceptance.
- [ ] Off-host encrypted production backup schedule and real recovery drill, SMTP activation with WECOMMANDER sender (deferred to launch), credential settings, active alert delivery.
- [ ] Provider credentials must remain redacted and outside version control.

### Phase H — Release gates
- [x] GitHub workflow runs gateway, integration, agent/relay E2E and cross-platform packaging jobs.
- [x] New API/browser acceptance assertions added; final full-workflow verification pending.
- [ ] Confirm **latest** full CI success and exact commit match after the current audit, media-hardening and responsive-table work (prior `214da4dd` baseline succeeded).
- [ ] End-to-end accepted user login, workspace role changes, admin CMS/SEO publish, Paddle and live agent controls.
- [ ] Verified production backup/restore and rollback drills.
- [ ] Confirm no tenant data leaking into privileged support operations.

## Implementation order

A -> B -> C -> D -> E -> F -> G -> H. No production-ready claim until the release gates pass.
