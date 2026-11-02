# Production release boundary (Issue #30)

`main` is the development integration branch. It is **not** a production
release. Production is whatever the `production` branch points at, and that
branch is moved only by the `promote-production` workflow after a named
operator approves it.

| Event | Production deployment |
|---|---|
| Push to a feature branch / PR update | none |
| PR merge or direct push to `main` (code or docs) | none |
| Green `ci` / `platform-distribution` on `main` | none |
| `promote-production` run approved in the `production` environment | exactly one, for the requested SHA |

## Repository controls in this change

- `.github/workflows/promote-production.yml` — `workflow_dispatch` only,
  runs from `main`, bound to the `production` environment, serialized by a
  `production-release` concurrency group. It takes the full SHA twice, a mode
  (`promote` or `rollback`) and a change reference.
- `scripts/release-gate.mjs` — refuses unless **all** hold:
  - the input is a full 40-hex SHA (no branch, tag or short SHA) and the
    confirmation matches;
  - the SHA is reachable from `origin/main`;
  - a `ci` run for that exact SHA, event `push`, branch `main` completed with
    `success`, and every job of its latest attempt is `success`/`skipped`
    (at least 17 jobs, at least one `success`);
  - a `platform-distribution` run for that exact SHA succeeded;
  - `promote` fast-forwards the current `production` head; `rollback` may only
    target a SHA that already carries a `production-release/*` tag.
  Unit tests: `scripts/release-gate.test.mjs` (run in the `gateway` CI job).
- On success the workflow pushes atomically, with a lease on the previous
  production head, the `production` ref and an annotated
  `production-release/<UTC time>-<sha12>` tag recording previous SHA, CI run,
  approving run, actor and reason. The tags are the release ledger.
- `bootstrap-locks.yml` no longer commits or pushes to `main`; it only
  verifies lockfiles and formatting on pull requests.
- The gateway image records its source commit (`SOURCE_COMMIT` build arg →
  `WECOMMANDER_BUILD_COMMIT`), and `GET /health` reports
  `build.commit` (40-hex or `unknown`). `scripts/accept-production.mjs`
  asserts it when `COMMANDER_EXPECTED_COMMIT` is set.

## Operator cut-over (requires a separate approved change window)

Nothing below has been applied. Each step changes live configuration and is
listed so it can be reviewed and approved first.

1. **Record known-good state.** Note the SHA Coolify currently runs (last
   verified: `9bdcf23c52e841c6ffd551654f155edd49f347ed`) and confirm `/health`
   is `ok`.
2. **GitHub environment `production`.** Settings → Environments → New:
   required reviewers (the release owner), enable *Prevent self-review* if more
   than one maintainer exists, deployment branches: `main` only.
3. **Create `production` at the known-good SHA** (does not deploy anything
   while Coolify still tracks `main`):
   run `promote-production` with `sha` = the step-1 SHA, `mode=promote`. The
   gate requires that SHA's main CI and distribution to be green; for
   `9bdcf23c` both were green (CI run 41113664032).
4. **Ruleset on `production`.** Settings → Rules → New branch ruleset, target
   `production`: restrict creations, updates and deletions, block force
   pushes; bypass list: *GitHub Actions* only (no admin bypass).
5. **Coolify.** In application `u5mlu98kqroo7w68zoa0syac` change the Git
   branch from `main` to `production`. Keep automatic deployment on webhook
   enabled: it now fires only when `production` moves. If the application's
   build arguments do not already include `SOURCE_COMMIT`, enable Coolify's
   option to include the source commit in the build so `/health` reports it.
6. **Rollback of the cut-over itself:** switch the Coolify branch back to
   `main` and redeploy the step-1 SHA. Data is unaffected: the change touches
   only which ref is built.

## Acceptance evidence still required after cut-over

Issue #30 is closed only when all of these are observed and recorded:

- a PR push, a docs-only `main` push and a code `main` push each cause **zero**
  Coolify deployments (Coolify deployment list, webhook log);
- one approved `promote-production` run causes **exactly one** deployment, of
  the requested SHA;
- `/health` returns `build.commit` equal to that SHA and
  `COMMANDER_EXPECTED_COMMIT=<sha> node scripts/accept-production.mjs` passes;
- a `rollback` run to the previous tag deploys that SHA once and passes the
  same check.

## Rules for development agents

- Never push to `main` or `production`. Work on a branch, open a (draft) PR.
- Never trigger `promote-production`; it is an operator action.
- A green CI or a merged PR is not a release and must not be reported as one.
