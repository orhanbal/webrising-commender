# Coolify operations for AI clients (WECOMMANDER only)

AI clients (Claude, ChatGPT, any MCP client) can audit WECOMMANDER's Coolify
application and propose release-setting changes through WECOMMANDER's own MCP
endpoint. They never hold a Coolify token, can never deploy or roll back, and
every change needs a human approval in the console.

```
AI client ──MCP──▶ WECOMMANDER gateway ──REST──▶ Coolify 4.5.3 ──▶ app u5mlu98kqroo7w68zoa0syac
                    │ platform administrator only
                    │ one application, fixed in code (u5mlu98kqroo7w68zoa0syac)
                    │ release invariant: Auto Deploy only with git_branch=production
                    │ four whitelisted fields
                    │ approval bound to the exact diff (console, password)
                    │ single-use apply, drift check, read-back verification
                    └ audit_logs + platform_admin_audit
```

## Why a proxy, not Coolify's built-in MCP

Verified in the Coolify v4.5.3 source:

- The built-in MCP server (`/mcp`, `CoolifyServer`, ~78 tools) authenticates
  with a normal Sanctum API token. It must be enabled by the root team
  (`POST /mcp/enable`).
- API tokens are **team scoped**. Abilities are `read`, `write`, `deploy`,
  `read:sensitive`, `write:sensitive`, `root`. There is no per-application
  scope. A token that can change WECOMMANDER can change every application of
  the team, and the built-in MCP exposes deploy, delete and environment
  variable tools to whoever holds it.

So the Coolify token stays on the WECOMMANDER server, and the gateway enforces
the application and operation limits. Leave Coolify's built-in MCP disabled
unless you need it for something else.

## Verified API contract (Coolify v4.5.3)

| Operation | Endpoint | Token ability |
|---|---|---|
| Read application and settings | `GET /api/v1/applications/{uuid}` (returns nested `settings`) | `read` |
| Change settings | `PATCH /api/v1/applications/{uuid}` | `write` |
| List deployments | `GET /api/v1/deployments/applications/{uuid}?skip=&take=` → `{count, deployments}` | `read` |
| Deploy | `POST /api/v1/deploy` | `deploy` (not granted) |
| Rollback | `POST /api/v1/applications/{uuid}/rollback` | `deploy` (not granted) |

Fields the proxy may change, and the release policy it audits against:

| UI label | API field | Stored in | Policy |
|---|---|---|---|
| Git Branch | `git_branch` | application | `production` |
| Auto Deploy | `is_auto_deploy_enabled` | `settings` | on |
| Include Source Commit in Build | `include_source_commit_in_build` | `settings` | on |
| Use build secrets | `use_build_secrets` | `settings` | off |

`PATCH` also accepts `instant_deploy`, which queues a deployment (and needs
the `deploy` ability), and `git_commit_sha`. The proxy rejects both, along with
every other field. Without `read:sensitive`, Coolify hides deployment logs and
secrets. The proxy also strips logs, configuration snapshots and webhook
secrets from what it returns.

## MCP tools

These tools are listed only to active platform administrators who connect
with a user identity (OAuth or a console session). Workspace API tokens and
the control key get `platform_admin_required`.

| Tool | Effect |
|---|---|
| `coolify_get_application` | Read-only projection (status, branch, release settings) |
| `coolify_get_configuration` | Read-only audit against the policy above |
| `coolify_list_deployments`, `coolify_get_deployment` | Read-only, no logs, scoped to the allowlisted app |
| `coolify_get_health` | Coolify status, newest deployment, the gateway's build commit |
| `coolify_propose_configuration_change` | Creates a pending request: diff, impact, rollback values, digest. Changes nothing. |
| `coolify_apply_configuration_change` | Applies one **approved** request once: checks the current values still equal the approved "from" values, PATCHes only those fields, re-reads, and verifies |
| `coolify_get_change_request` | Status of a request |
| `coolify_deploy`, `coolify_rollback` | Always refused, pointing to `promote-production` |

Approval: Console → System → **Coolify change requests**. You see the exact
diff and digest, and you re-enter your password. The decision is bound to that
digest, expires after 30 minutes, and can be used once. Approving does not
apply anything; the AI then calls `coolify_apply_configuration_change`, which
never deploys. With Auto Deploy on, the next GitHub push to `production`
(made only by `promote-production`) deploys.

### Release invariant (Issue #30)

While Auto Deploy is on, Coolify may track only the `production` branch.
Otherwise a push to `main` would deploy to production without passing
`promote-production`. The invariant is enforced on the **resulting** state,
which is the live Coolify values plus the change:

- **Proposal:** a request whose result breaks the invariant is refused and not
  stored. Examples: `git_branch=main` while Auto Deploy is on, or Auto Deploy
  on while the branch is `main`.
- **Apply:** the invariant is checked again against freshly read values. Two
  requests that are each valid alone ("Auto Deploy on", "branch main") cannot
  be combined, in either order. The second one is refused, and its approval
  is consumed.
- **PATCH order:** Auto Deploy is switched off in the first PATCH and on in
  the last one. Before switching it on, the proxy re-reads Coolify and
  requires `git_branch=production`. If Coolify ignored the branch change, Auto
  Deploy stays off and the request ends as `verification_failed`.

The proxy cannot stop someone from changing these settings directly in the
Coolify UI. `coolify_get_configuration` reports `release_invariant.ok`, and
`production-guard` still detects untagged `production` heads.

Every call, including denials, is written to `audit_logs` (`tool` =
`coolify_*`). Console decisions are written to `platform_admin_audit`. The
token is never logged, audited or returned.

## Owner setup (one time, no repository download needed)

1. **Create a least-privilege token in Coolify.** Keys & Tokens → API tokens →
   create `wecommander-ops`, in the team that owns WECOMMANDER. Tick only
   **read** and **write**. Do **not** tick `deploy`, `root`,
   `read:sensitive` or `write:sensitive`. Copy the token once. Do not paste it
   into Claude or any chat.
2. **Make sure the API is enabled.** Settings → Advanced → API Access on. If you
   use the API IP allowlist, add the address the WECOMMANDER container connects
   from. If WECOMMANDER and Coolify run on the same server, use the URL the
   container can reach.
3. **Give the token to the WECOMMANDER gateway only.** In Coolify →
   WECOMMANDER application → Environment Variables, add:
   - `COOLIFY_API_URL` = your Coolify base URL (`https://…`, no path)
   - `COOLIFY_API_TOKEN` = the token (runtime only: untick "Build Variable")
   - `COOLIFY_ALLOWED_APPLICATIONS` = `u5mlu98kqroo7w68zoa0syac`

   These take effect on the next deployment, which is the next verified
   `promote-production` release that contains this feature. Do not redeploy
   from Coolify just for this.
4. **Connect the AI client** to `https://<wecommander>/mcp` with OAuth as a
   platform administrator (docs/MCP_OAUTH.md).

If anything is misconfigured (non-https URL, empty token, or an allowlist
other than exactly `u5mlu98kqroo7w68zoa0syac`), the tools return
`coolify_not_configured` and make no calls. Supporting another application
needs a code change and review, not an environment edit.

## First use: audit, then change only what is approved

The tools exist only after a release that contains them is live. Until then,
check the four values by hand in the Coolify UI (application → Configuration
→ General for Git Branch; the other three are under Advanced).

1. The AI calls `coolify_get_configuration` and reports the four values.
2. For each value that does not match the policy, it calls
   `coolify_propose_configuration_change` and shows you the diff, impact and
   rollback values.
3. You approve in the console. The AI applies the change and reports the
   values it read back.
4. When all four values match the policy, run the first `promote` release
   (docs/RELEASE_POLICY.md).

To undo a change, propose the rollback values from the original request, and
approve that request in the same way.

## Residual risk: the token is team-wide

Coolify cannot scope a token to one application, so the gateway's limits are
enforced in software. The token has `read` + `write` on the **whole team**.

**Anyone who obtains the token, or gains code execution in the gateway
container** (where the token is a runtime environment variable), bypasses
every proxy rule. They can call the Coolify API directly and can:

- **read** every project, application, service, database and server of the
  team. Secret values stay hidden because the token has no `read:sensitive`.
- **change** any application's settings with `PATCH /applications/{uuid}`:
  branch, repository, build and start commands, domains, health checks, labels
  and Auto Deploy. The new values take effect on that application's next
  deployment, for example a webhook push with Auto Deploy on.
- **overwrite or delete** environment variables of applications, databases,
  services, projects, servers and the team. Values cannot be read, but they
  can be replaced.
- **create applications**, **create, change or delete** projects,
  environments, private keys (`/security/keys`), S3 storages, cloud tokens,
  destinations and storages.
- **change servers**: `PATCH`/`DELETE /servers/{uuid}`, proxy configuration,
  docker cleanup, server migration, Cloudflare tunnel.
- **delete** database backup schedules and executions.
- **not** deploy, start, stop, restart, roll back, or delete applications and
  databases. In v4.5.3 all of these require `deploy`.
- **not** read or write secret values flagged as sensitive. That needs
  `read:sensitive` or `write:sensitive`.

The `write` ability is therefore much broader than the four fields the proxy
uses. Server-level and key-level changes can affect every resource on that
server. The abilities above were read from `routes/api.php` (`api.ability`
middleware) at tag v4.5.3; re-check them after a Coolify upgrade.

A compromised **platform administrator account** (password and session or
OAuth) can propose and approve its own requests. It remains limited to the
four fields, to WECOMMANDER, and to the release invariant.

Mitigations:

- Put WECOMMANDER in its **own Coolify team**, with no other resources. This
  is the strongest available limit: the team-wide blast radius becomes
  WECOMMANDER itself. In Coolify a server belongs to one team, so this also
  means a server dedicated to WECOMMANDER. Until then, assume the token can
  affect everything else in the current team and on its servers.
- Never grant `deploy`, `root`, `read:sensitive` or `write:sensitive`.
- Restrict the Coolify API with its IP allowlist to the gateway's address.
- Rotate the token on any suspicion. Revoke it in Coolify (Keys & Tokens) to
  disable the proxy immediately. The gateway then fails closed.
- Review `audit_logs` (`coolify_*`), `platform_admin_audit`, Coolify's own
  audit events and `production-guard` regularly.
