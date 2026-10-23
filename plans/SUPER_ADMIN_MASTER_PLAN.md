# WECOMMANDER — Super Admin Master Plan

Status: IN PROGRESS (2026-10-23). Security, management, CMS and test improvements committed; completion is gated on full CI, production checks and external acceptance.

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
- [ ] Full TR translation of all console-specific descriptions and controls, keyboard accessibility/contrast audit, and final browser acceptance.

### Phase C — Users and organizations
- [x] User listing/search/pagination, audited disable/enable with password reauthentication.
- [x] User session inventory and audited forced session revocation, excluding own session and protected platform administrators.
- [x] Workspace membership browser and viewer/operator/admin role changes with step-up and owner-role protection.
- [x] Organization-specific quota overrides and editable plan limits.
- [ ] Organization details/large-list pagination, bulk operations, owner transfer with explicit approval, elevated-account recovery and additional lifecycle acceptance.

### Phase D — Devices and operations
- [x] Cross-workspace read-only device inventory and unified tenant/platform audit timeline.
- [x] Live system counts for relay health, active sessions, pending approvals and mail queue.
- [ ] Agent enrollment/heartbeat/relay failover and terminal/file/task operations on real Windows, macOS and Linux devices.
- [ ] Incident investigation, alerting and explicit customer-authorized support controls.

### Phase E — Billing
- [x] Read-only plans/subscriptions reporting and password-confirmed plan/organization quota editors.
- [x] Existing Paddle webhook integration tests provide synthetic subscription lifecycle coverage.
- [ ] Paddle provider status, customer cancellation and refund-request workflow, real sandbox/live checkout acceptance and reconciliation.
- [ ] Never change provider-controlled paid status through an internal administration override.

### Phase F — Landing CMS and brand
- [x] Versioned EN/TR hero and 106 landing copy strings with grouped editor, draft/publish/rollback, publish reauthentication and live rendering.
- [x] SEO title/description per locale, safely escaped SSR homepage tags, canonical and Open Graph metadata.
- [x] Light/dark PNG/WebP logos and favicon storage, safe public fallback and password-confirmed asset upload.
- [x] Browser and API tests for landing card visibility, revision publish/rollback, escaping and failed reauthentication.
- [ ] Legal-page content editor, section reordering, richer media library, robust SVG handling, structured FAQ editor and CMS production browser acceptance.

### Phase G — System settings
- [x] Safe read-only mail queue, active sessions, relay, approval, deployment mode and signup health reporting.
- [ ] SMTP activation with WECOMMANDER sender (intentionally deferred until launch), secrets management UI, backups, alerts and operational maintenance.
- [ ] Provider credentials must remain redacted and outside version control.

### Phase H — Release gates
- [x] GitHub workflow runs gateway, integration, agent/relay E2E and cross-platform packaging jobs.
- [x] New API/browser acceptance assertions added; final full-workflow verification pending.
- [ ] Green latest **full** CI after all commits and production deployed commit equality.
- [ ] End-to-end accepted user login, workspace role changes, admin CMS/SEO publish, Paddle and live agent controls.
- [ ] Verified production backup/restore and rollback drills.
- [ ] Confirm no tenant data leaking into privileged support operations.

## Implementation order

A -> B -> C -> D -> E -> F -> G -> H. No production-ready claim until the release gates pass.
