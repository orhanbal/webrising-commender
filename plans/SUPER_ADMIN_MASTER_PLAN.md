# WECOMMANDER — Super Admin Master Plan

Status: IN PROGRESS (2026-10-23). Phase A backend committed, not yet accepted by CI or real login.

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

### Phase A — Auth and first account
- [x] DB migration: independent platform admin grant and platform action audit tables (code committed; production acceptance pending).
- [x] Server-local bootstrap CLI for first account (`orhanbal@gmail.com`), no SMTP dependency (code committed; execution pending).
- [x] Dedicated `/api/console/me` authentication and permission checks (code committed; tests pending).
- [ ] Tests: unauthenticated=401, ordinary owner=403, real platform admin=200, revoked/disabled=403.
- [ ] Real owner login with existing browser session mechanism.
- [ ] Verify persistence across redeploy; no data deletion or volume replacement.

### Phase B — Console shell
- [ ] `/console` protected route and responsive shell with fixed navigation and readable typography.
- [ ] Fluent design, both themes, EN/TR locale, keyboard/mobile accessibility.
- [ ] Overview from real API metrics (no invented live data).
- [ ] Admin profile, session controls, reauthentication and activity timeline.

### Phase C — Users / tenants
- [ ] Paginated user and organization lists, search and scoped detail pages.
- [ ] Memberships, roles, active/disabled state, plan/quota overrides, sessions.
- [ ] Confirmations and audit trail for every mutation; no silent privilege escalation.
- [ ] Separate platform role from tenant role in API and UI.

### Phase D — Devices / operations
- [ ] Fleet health, enrollment status, agents, relay and gateway health.
- [ ] Aggregated usage, tasks, incidents, errors and audit reports.
- [ ] Explicit customer authorization for privileged support actions.

### Phase E — Billing
- [ ] Product plans, prices, quota defaults, subscription states and Paddle webhook health.
- [ ] Preserve Paddle as payment source of truth; no manual fake-paid switches.
- [ ] Refund/cancellation workflows with provider confirmation and audit.

### Phase F — Landing CMS
- [ ] Revisioned, schema-validated content: hero, features, installation, pricing explanations, FAQ, CTA, footer and legal pages.
- [ ] Preview, draft, publish and rollback; safe media uploads and asset versioning.
- [ ] Logo (light/dark), favicon, social metadata, canonical SEO, navigation without hash links.
- [ ] Page-cache invalidation after publish. Preserve layout constraints and responsive checks.

### Phase G — System settings
- [ ] Brand and public configuration, gateway/relay summaries, mail delivery status and integration health.
- [ ] Store sensitive values only through approved secret management; redact on read.
- [ ] Alerting, backups, retention, security posture and maintenance actions.

### Phase H — Release gates
- [ ] TypeScript build, server tests, role/CSRF/security test coverage.
- [ ] Browser acceptance across desktop/mobile EN/TR and light/dark.
- [ ] Functional tests for admin changes, tenant isolation and CMS preview/publish/rollback.
- [ ] Production database backup verified before migration.
- [ ] Fresh-session real login and persistence after redeploy.

## Implementation order

A -> B -> C -> D -> E -> F -> G -> H. No production-ready claim until the release gates pass.
