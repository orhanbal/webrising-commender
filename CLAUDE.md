# Notes for Claude sessions

- Coolify (WECOMMANDER app `u5mlu98kqroo7w68zoa0syac`): cloud sessions cannot
  reach Coolify directly. Use the `coolify-ops` workflow on `main` (dispatch
  `operation=audit`, read the job summary). Config changes only with owner
  approval via `operation=apply-release-policy`. Never deploy, restart or roll
  back from Coolify. See docs/COOLIFY_ACTIONS_OPS.md.
- Production releases only through `promote-production` with explicit owner
  approval (docs/RELEASE_POLICY.md). Never push to `main` or `production`.
