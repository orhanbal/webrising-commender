# Coolify operations (WECOMMANDER only)

Claude and other agents manage WECOMMANDER's Coolify application only through
the `coolify-ops` GitHub workflow. They never receive a Coolify token.

```
Claude (any session) ──GitHub API: dispatch──▶ coolify-ops.yml on main
                                                │ environment coolify-read  → read token
                                                │ environment coolify-write → read+write token, owner approval
                                                ▼
                                       scripts/coolify-ops.mjs ──HTTPS──▶ Coolify 4.5.3 API ──▶ u5mlu98kqroo7w68zoa0syac
```

Why GitHub Actions: Claude Code cloud sessions cannot reach the Coolify server
(their network policy denies the host), and Coolify tokens cannot be scoped to
one application. GitHub-hosted runners can reach Coolify. GitHub Environment
secrets keep the token out of chats, code and logs (GitHub masks secrets in
logs). Restricting both environments to `main` means only reviewed code ever
runs with a token. The connection is part of the repository, so every new
Claude session can use it.

## Operations

| Operation | Environment / token | Effect |
|---|---|---|
| `audit` | `coolify-read`, ability **read** | Reads the app (status, four release settings, recent deployments, no logs or secrets). Runs local negative tests: other app UUID, `instant_deploy` and unlisted fields are refused with no request sent. Runs one real negative test: a no-op `PATCH` with the read token must get HTTP 403. Fails if a deployment appears during the run. |
| `apply-release-policy` | `coolify-write`, abilities **read + write**, owner approval | Moves only the settings that differ to the fixed policy: `git_branch=production`, `include_source_commit_in_build=on`, `use_build_secrets=off`, and finally `is_auto_deploy_enabled=on`. Auto Deploy is switched off first if the branch is wrong, and switched on only after a re-read shows `production`. Never sends `instant_deploy`. Refuses if the app is not `running:healthy`. Re-reads all four values and fails if they differ or if a deployment appeared. |

There are no free-form inputs: the application UUID and the policy values are
constants in `scripts/coolify-ops.mjs`. Changing them requires a reviewed PR
to `main`. There is no deploy, restart or rollback operation. Production
releases go through `promote-production` (docs/RELEASE_POLICY.md).

Results appear in the run's job summary as JSON. Every run is recorded in
GitHub Actions: who dispatched it, the reason, who approved it, and the
output. Coolify keeps its own audit trail of API changes.

## How an agent uses it

1. Dispatch `coolify-ops` on `main` with `operation=audit` and a `reason`.
   With the GitHub MCP server, use `actions_run_trigger` (workflow
   `coolify-ops.yml`, ref `main`).
2. Read the job summary or log of the run.
3. Dispatch `apply-release-policy` only when the owner has approved that
   change. The run then waits for the `coolify-write` environment approval,
   which only the owner can give.

## One-time setup (owner, GitHub and Coolify web UI)

Only the owner can create Coolify tokens and GitHub secrets.

1. **Coolify → Keys & Tokens → API tokens:** create `wecommander-ops-read`
   with only **read**. If you are about to run `apply-release-policy`, also
   create `wecommander-ops-write` with **read** and **write**. Never tick
   `deploy`, `root`, `read:sensitive` or `write:sensitive`. Settings → API
   Access must be on. If the API IP allowlist is in use, GitHub-hosted runners
   (dynamic IPs) will be refused; then the allowlist must permit them.
2. **GitHub → Settings → Environments:** create `coolify-read` and
   `coolify-write`. For both, set Deployment branches to *Selected branches*
   → `main`. For `coolify-write`, add yourself as Required reviewer.
   - `coolify-read`: secret `COOLIFY_READ_TOKEN`, variable `COOLIFY_API_URL`
     (your Coolify URL, `https://…`).
   - `coolify-write`: secret `COOLIFY_WRITE_TOKEN`, variable
     `COOLIFY_API_URL`.

The write token is team-wide. It is the riskiest credential here. Delete it in
Coolify after the release settings are applied, and create a new one when
another change is approved.

## Residual risk

Coolify cannot scope a token to one application, so the limits above are
enforced by reviewed code, not by Coolify. Whoever can run modified code with
a token, for example by changing the environments' branch rule or merging a
modified script to `main`, has the token's full team-wide scope:

- **read token:** reads every project, application, database, service and
  server of the team, with secret values hidden;
- **write token:** additionally changes any application's settings, overwrites
  environment variables, creates, changes or deletes projects, environments,
  private keys and storages, and changes servers. It cannot deploy, start,
  stop, restart, roll back or delete applications and databases; those need
  `deploy`.

Mitigations: environments limited to `main`; owner approval on
`coolify-write`; short-lived write token; separate team for WECOMMANDER (the
long-term fix, see PR #48 discussion).
