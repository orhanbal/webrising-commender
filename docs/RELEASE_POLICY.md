# Production release boundary (Issue #30)

`main` is the development integration branch, not a release. Production is the
`production` branch. After a one-time owner bootstrap, only the
`promote-production` workflow moves it, and only after the owner approves the
`production` environment.

| Event | Production deployment (after cut-over) |
|---|---|
| Push to a feature branch / PR update | none |
| PR merge or direct push to `main` (code or docs) | none |
| Green `ci` / `platform-distribution` on `main` | none |
| Approved `promote-production` run | exactly one, for the requested SHA, verified via `/health` |

## Controls

| Control | Where | Fails closed when |
|---|---|---|
| Release gate | `scripts/release-gate.mjs` (34 unit tests) | SHA not full 40-hex or confirmation differs; SHA not on `main`; no green exact-SHA `ci` **push on main** run; any of the 17 required jobs (`REQUIRED_CI_JOBS`, kept equal to `ci.yml` by a test) missing, duplicated, extra, skipped, cancelled or failed; no green exact-SHA `platform-distribution`; `production` absent (promote/rollback) or present (bootstrap); `production` head has no valid release tag (unauthorized update); promote not a fast-forward; rollback target never released |
| Release ledger | annotated `production-release/<UTC>-<sha12>` tags | a tag is lightweight, or its message's `sha:` line differs from its target → ignored and reported |
| Approval | `production` environment, required reviewer | job waits; the App key secret is not given to the job before approval |
| Write path | dedicated GitHub App, rulesets on `production` and `production-release/**` | missing App secrets → no token → no push; `GITHUB_TOKEN`, owner pushes and other apps are blocked by the rulesets |
| Deployed identity | `scripts/verify-release.mjs` (in the release job) | `/health` never shows `build.commit == sha` twice in a row within 30 min; `unknown`, missing or another SHA is never accepted |
| Drift detection | `production-guard.yml` (on production/tag push and daily from `main`) | audit gate fails |
| No bot writes to `main` | `bootstrap-locks.yml` is read-only | — |

Why a GitHub App: the default `GITHUB_TOKEN` (`github-actions[bot]`) cannot be
added to a ruleset bypass list. The bypass actors github.com offers are
repository roles, teams, GitHub Apps and Dependabot (deploy keys only on GHES).

## Facts checked for this repository (2 Nov 2026)

- Repository is **public** (`api.github.com`), so on the Free plan required
  reviewers, environment secrets/variables and deployment-branch rules are
  available.
- The only collaborator is `orhanbal` (admin). **Do not enable "Prevent
  self-review"**: the person who dispatches a run cannot then approve it, and
  with one maintainer every release would wait forever. With one maintainer the
  required reviewer is a deliberate second step (dispatch, then approve in the
  UI), not a second person. Enable "Prevent self-review" only once a second
  maintainer is a required reviewer.
- Coolify (`coollabsio/coolify` main, `ApplicationDeploymentJob.php`,
  `bootstrap/helpers/parsers.php`):
  - for Docker Compose builds, `SOURCE_COMMIT` reaches the build only when
    **"Include Source Commit in Build"** is enabled (`--build-arg SOURCE_COMMIT=<sha>` and a
    process environment variable); otherwise the image reports `unknown`;
  - any `${VAR}` in a compose `environment:` or `build.args` becomes a stored
    Coolify variable, and a stored `SOURCE_COMMIT` overrides the injected
    commit. The Coolify compose files therefore contain no `SOURCE_COMMIT`
    reference (an earlier revision of this PR had one, which would have
    pinned it to `unknown`);
  - with "Use build secrets" enabled the value is not a build argument and the
    image reports `unknown`: verification then fails.
  The deployed Coolify version was not inspected. The first approved release
  is the real test: it is accepted only if `/health` shows the exact SHA.
- `9bdcf23c` predates `build.commit`. It can be bootstrapped (its exact-SHA CI
  run 41113664032 has the 17 required jobs green, and `platform-distribution`
  is green; the gate passed against live GitHub data), but `/health` cannot
  verify it. Verified releases start with the first release that contains
  this PR.

## Cut-over sequence (no unwanted deployment)

Each step needs the owner's approval. None has been executed. Steps 1–3 do
not affect the running deployment.

1. **Release App and environment.**
   - Create a GitHub App `wecommander-release` (no webhook). Repository
     permissions: **Contents: Read and write** only (Metadata read is
     implied). Install it on this repository only. Generate a private key.
   - Settings → Environments → `production`: required reviewer `orhanbal`;
     "Prevent self-review" **off** (see above); deployment branches and tags:
     **Selected → `main`**; leave "Allow administrators to bypass" **off**.
   - Environment secrets: `RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`.
     Environment variable: `PRODUCTION_BASE_URL=https://wecommander.webrising.tr`.
     Do not create repository-level copies of these.
2. **Bootstrap `production` at the running known-good commit**, from the
   owner's own checkout (`promote-production` cannot do this: it runs only
   from `main`, and this PR is not merged yet):
   ```
   scripts/bootstrap-production.sh 9bdcf23c52e841c6ffd551654f155edd49f347ed 9bdcf23c52e841c6ffd551654f155edd49f347ed
   scripts/bootstrap-production.sh 9bdcf23c52e841c6ffd551654f155edd49f347ed 9bdcf23c52e841c6ffd551654f155edd49f347ed --execute
   ```
   The first command is a dry run. The gate must pass. The script creates
   `production` and one annotated bootstrap tag atomically and refuses to
   run twice. Coolify still tracks `main`, so nothing deploys.
3. **Rulesets** (Settings → Rules → Rulesets), enforcement **Active**:
   - branch ruleset, target `production`: restrict creations, restrict
     updates, restrict deletions, block force pushes; bypass list:
     `wecommander-release` App only (no role bypass);
   - tag ruleset, target `production-release/**`: restrict creations,
     updates and deletions; same single bypass.
   - Check: `git push origin HEAD:production` from the owner's checkout is
     rejected with `GH013`.
4. **Coolify change window** for app `u5mlu98kqroo7w68zoa0syac`:
   record the current deployment SHA (`9bdcf23c`), enable "Include Source
   Commit in Build", make sure "Use build secrets" is off, and change Git
   branch `main` → `production`. Do **not** press Redeploy: `production`
   equals the running SHA. If Coolify redeploys anyway, it builds the same
   `9bdcf23c`.
   *Rollback:* switch the branch back to `main` and turn the option off. Data
   is not touched.
5. **Merge this PR** into `main`. Expected evidence: **zero** Coolify
   deployments (this is the first "main push → no deploy" proof); `ci` and
   `platform-distribution` green for the merge SHA.
6. **First verified release:** Actions → `promote-production` → Run workflow
   on `main` with the merge SHA twice, `mode=promote`, a reason → approve.
   Expected: one Coolify deployment of that SHA, then the job's verification
   step sees `/health` `build.commit` equal to the SHA. `production-guard`
   runs and passes. `COMMANDER_EXPECTED_COMMIT=<sha> node scripts/accept-production.mjs`
   passes.
7. **Negative evidence:** push a docs-only commit and a test-only PR to `main`
   → zero deployments. Dispatching from a non-`main` ref, an untagged
   rollback target, or a red-CI SHA → refused, no deployment.
8. **Rollback drill** (after a second verified release): `mode=rollback` to
   the previous release SHA → one deployment, verified.

Issue #30 closes after steps 5–8 are recorded with Coolify deployment IDs and
workflow run links.

### Emergency (break-glass)

If the gate cannot pass, for example GitHub Actions is down or an old SHA has
no complete CI data, the owner can deploy a known SHA from the Coolify UI
directly. Afterwards, record the incident and re-align `production` through a
normal release. Never disable the rulesets to push by hand without recording
it. `production-guard` reports the untagged head until the next release.

## Rules for development agents

- Never push to `main` or `production`; never create `production-release/*`
  tags. Work on a branch and open a Draft PR.
- Never dispatch `promote-production`, approve the environment, or run
  `bootstrap-production.sh --execute`. These are owner actions.
- A green CI or a merged PR is not a release; do not report it as one.

**Residual risk:** an integration that acts with the owner's GitHub identity
(for example an AI assistant's GitHub App user token) can in principle both
dispatch the workflow and approve the environment, because both are owner
permissions. The agent rules above forbid this. Where an integration lets you
choose, do not grant it Actions or Deployments write permission.
