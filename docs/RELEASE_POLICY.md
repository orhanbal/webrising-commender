# Production release boundary (Issue #30)

`main` is the development integration branch, not a release. Production is the
`production` branch. Only the `promote-production` workflow creates
(`mode=bootstrap`, once) or moves (`promote`, `rollback`) it, and only after the
owner approves the `production` environment. Nothing in this process needs a
local checkout. Every step is done in the GitHub or Coolify web UI.

| Event | Production deployment (after cut-over) |
|---|---|
| Push to a feature branch / PR update | none |
| PR merge or direct push to `main` (code or docs) | none |
| Green `ci` / `platform-distribution` on `main` | none |
| Approved `promote-production` run (`promote`/`rollback`) | exactly one, for the requested SHA, verified via `/health` |
| Approved `promote-production` run (`bootstrap`) | none (creates the ref only) |

## Controls

| Control | Where | Fails closed when |
|---|---|---|
| Release gate | `scripts/release-gate.mjs` (61 unit tests with `release-tools.test.mjs`) | SHA not full 40-hex or confirmation differs; SHA not on `main`; the **newest** `ci` push-on-main run for the SHA (latest attempt) is missing, queued, running, failed, cancelled or timed out — an older success never counts; any of the 17 required jobs (`REQUIRED_CI_JOBS`, kept equal to `ci.yml` by a test) missing, duplicated, extra, not `success`, or from another run/attempt; the **newest** `platform-distribution` run linked to that exact ci run is not `success`, belongs to an earlier attempt or predates it; `production` absent (promote/rollback) or present (bootstrap); `production` head has no valid release tag (unauthorized update); promote not a fast-forward; rollback target never released |
| Distribution linkage | `ubuntu-distribution.yml` `run-name` "(ci `<run id>`/`<attempt>`)"; older runs: artifact `WECOMMANDER-multiplatform-preview-<ci run number>` | GitHub lists `workflow_run` runs under the default-branch head at trigger time, not under the commit they built, so `head_sha` is never used for this link (live example: skipped run 41520734100, triggered by a PR's CI on 2 Nov, is listed under `9bdcf23c`; the real build of `9bdcf23c` is run 41114449603, linked by artifact `…-1530`) |
| Release ledger | annotated `production-release/<UTC>-<sha12>` tags | lightweight tag, or tag whose `sha:` line differs from its target → ignored |
| Approval | `production` environment, required reviewer | job waits; the App key secret is not given to the job before approval |
| Write path | dedicated GitHub App + rulesets on `production` and `production-release/**`; push step re-checks the remote head and pushes with a lease | missing App secrets → no token → no push; remote head differs from what the gate saw → no push; `GITHUB_TOKEN`, owner pushes and other apps are blocked by the rulesets |
| Deployed identity | `scripts/verify-release.mjs` in the release job | `/health` never shows `build.commit == sha` twice in a row within 30 min; `unknown`, missing or another SHA never passes |
| Drift detection | `production-guard.yml` (production/tag push and daily from `main`) | audit gate fails |
| No bot writes to `main` | `bootstrap-locks.yml` is read-only | — |

Why a GitHub App: the default `GITHUB_TOKEN` (`github-actions[bot]`) cannot be
added to a ruleset bypass list. The bypass actors github.com offers are
repository roles, teams, GitHub Apps and Dependabot.

## Facts checked (2 Nov 2026)

- **Repository:** public, so on the Free plan required reviewers, environment
  secrets and variables, and deployment-branch rules are available.
- **Collaborators:** the only one is `orhanbal` (admin). **Do not enable
  "Prevent self-review"**: with one maintainer, every run would wait forever.
- **Coolify source** (`coollabsio/coolify` main):
  - A GitHub push deploys only applications whose Git branch equals the pushed
    branch **and** whose *Auto Deploy* setting is on (`Webhook/Github.php`,
    `Application::isDeployable()`). Tag pushes match no application.
  - Compose builds receive `SOURCE_COMMIT` only with *Include Source Commit in
    Build*. Any `${SOURCE_COMMIT}` reference in a compose file would become a
    stored variable that overrides it, so the Coolify compose files contain
    none.
  - With *Use build secrets* on, the image reports `unknown`, and
    verification then fails.
- **Gate against live GitHub data (read-only):**
  - `9bdcf23c` passes `mode=bootstrap` (ci run 41113664032, distribution
    41114449603).
  - `75c857f` is refused: its newest ci run failed.
- **`9bdcf23c` and `/health`:** this commit predates `build.commit`, so
  `/health` cannot verify it. Verified releases start with the first
  promotion of a commit that contains this PR.

## One-time production cut-over procedure

Each step is done once, by the owner, in a web UI, in this order. Claude and
other agents do none of these steps and never receive the App private key.
Steps 1–2 change nothing in production. Steps 3–7 form one change window.

**Prerequisites:** PR #33 is reviewed, and the current deployment is healthy at
`9bdcf23c52e841c6ffd551654f155edd49f347ed`.

1. **Release GitHub App** (github.com → Settings → Developer settings →
   GitHub Apps → New GitHub App).
   - Name: `wecommander-release`. Homepage: the repository URL.
   - Webhook: **inactive**.
   - Repository permissions: **Contents: Read and write**, nothing else.
   - Installable: only on this account.
   - Then Install App → **Only select repositories** →
     `webrising-commender`.
   - On the App page, note the **App ID** and click **Generate a private
     key**. The browser downloads a `.pem` file.
2. **Environment and rules** (repository → Settings).
   - **Environments → New environment `production`:**
     - Required reviewers: `orhanbal`.
     - Prevent self-review: **off**.
     - Allow administrators to bypass: **off**.
     - Deployment branches and tags: **Selected → `main`**.
     - Environment secrets:
       - `RELEASE_APP_ID` = the App ID.
       - `RELEASE_APP_PRIVATE_KEY` = paste the whole `.pem` content.
       - Then delete the downloaded `.pem` file. It is never needed again; a
         new key can be generated if required.
     - Environment variable: `PRODUCTION_BASE_URL` =
       `https://wecommander.webrising.tr`.
   - **Rules → Rulesets → New branch ruleset**:
     - Target `production`, enforcement **Active**.
     - Restrict creations, restrict updates, restrict deletions, block force
       pushes.
     - Bypass list: **`wecommander-release` App only**.
   - **New tag ruleset**: target `production-release/**`, restrict
     creations, updates and deletions, same single bypass.
3. **Coolify** (application `u5mlu98kqroo7w68zoa0syac`, Advanced/General).
   - Record the running commit (`9bdcf23c`).
   - Turn **Auto Deploy off**.
   - Do not change the branch yet.
   - Production keeps running `9bdcf23c`. From now on no push deploys.
4. **Merge PR #33** (GitHub UI).
   - Expected: no Coolify deployment, because Auto Deploy is off.
   - Wait until `ci` and `platform-distribution` for the merge commit are
     green. The distribution run name then ends with `(ci <id>/<attempt>)`.
   - Note the merge commit SHA as `M`.
5. **Create `production` without deploying** (Actions → `promote-production`
   → Run workflow on `main`).
   - Inputs: `sha` and `confirm_sha` =
     `9bdcf23c52e841c6ffd551654f155edd49f347ed`, `mode` = `bootstrap`,
     `reason` = `Issue #30 cut-over`.
   - Approve the pending `production` deployment.
   - Expected: the gate passes; the App creates `production` at `9bdcf23c`
     and one annotated tag; `production-guard` runs and passes.
   - Check: the branch exists, and Coolify shows no new deployment.
6. **Coolify switch.**
   - Git branch: `main` → **`production`**.
   - **Include Source Commit in Build: on**.
   - Use build secrets: off.
   - **Auto Deploy: on**.
   - Do not press Redeploy. `production` equals the running commit, and no
     push has happened yet, so nothing deploys.
7. **First verified release** (Actions → `promote-production` on `main`).
   - Inputs: `sha` = `confirm_sha` = `M`, `mode` = `promote`, plus a reason.
   - Approve.
   - Expected: exactly one Coolify deployment, of `M`; the job's last step
     reports `/health` `build.commit` = `M` twice in a row;
     `production-guard` passes.

**Rollback of the window:**
- Before step 6: turn Auto Deploy back on. Nothing else changed in
  production.
- After step 6: set the Coolify branch back to `main`, turn *Include Source
  Commit* off, and redeploy `9bdcf23c` from the Coolify UI.
- In both cases data is untouched. The created branch, tags, rulesets and App
  can stay; they do not deploy anything.

### Evidence that closes Issue #30

Record each with its Coolify deployment ID or workflow run link:
- zero deployments for the merge (step 4) and for the bootstrap (step 5);
- exactly one verified deployment for step 7;
- zero deployments for a later docs-only push to `main` and for a PR update;
- a refused run: dispatch from a non-`main` ref, or a SHA whose newest CI is
  red;
- after a second verified release, a `rollback` to the previous release:
  exactly one deployment, verified.

### Emergency (break-glass)

If the gate cannot pass, for example because GitHub Actions is down, the owner
can deploy a known SHA from the Coolify UI. Afterwards, record the incident and
re-align `production` through a normal release. `production-guard` reports any
untagged head until then.

## Rules for development agents

- Never push to `main` or `production`; never create `production-release/*`
  tags. Work on a branch and open a Draft PR.
- Never dispatch `promote-production`, approve the environment, or handle the
  release App key. These are owner actions.
- A green CI or a merged PR is not a release; do not report it as one.

**Residual risk:** an integration acting with the owner's GitHub identity can
in principle dispatch and approve, because both are owner permissions. The
rules above forbid it. Do not grant such integrations Actions or Deployments
write permission where you can choose.

## Other open PRs

PR #34 (MCP client acceptance) was developed independently from `main`.
Both PRs touch `.github/workflows/ci.yml` and `CHANGELOG.md`. After #33 is
merged, rebase #34 onto the new `main` and let its full CI run before review.
