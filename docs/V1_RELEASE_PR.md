# v1.0 release PR notes (branch `v1-release-prep`)

Prepared for the WECOMMANDER 1.0 launch on **2026-11-23**. This branch is not
merged, pushed, tagged or deployed. Merging it to `main` ships the apps as
`1.0.N` (see "Release day" below), so merge it on the day, not before.

## What is in this branch

1. **Version numbering 1.0.N** (was 0.1.N): CI builds the agent, the Ubuntu
   package, the macOS PKG and the Windows/macOS/Linux apps as `1.0.<CI run>`;
   the apps format versions through one constant (`AppVersion` in
   `center-windows/Core` and `center-macos` CenterCore). Updates still compare
   only the build number, so 0.1.N installs update to 1.0.M.
2. **Release texts:** the "Yenilikler" entry `2026-11-23-v1` (Windows and
   macOS, six languages), the 1.0.0 section of `CHANGELOG.md`,
   `docs/LAUNCH_EMAIL.md` (sign-up mail and in-app messages) and
   `docs/LAUNCH_POSTS.md` (X, LinkedIn, Product Hunt, Show HN).
3. **AI directory kit:** `/server.json` (MCP Registry listing, also committed
   as `server.json` at the repository root), `llms.txt` MCP facts and the
   current release, `docs/DIRECTORY_SUBMISSIONS.md`.
4. **Texts refreshed with what shipped on 18–19 November:** Dock terminal
   tabs and servers in Task Manager, the getting-started tutorial on Windows
   and macOS, the window keeping its place after a language change (Windows),
   AI tools for scheduled tasks, server timers and Docker containers, the
   server tools for SSH targets, per-device AI permissions (trust levels
   including no time limit, root on Linux with two keys, the safety net) and
   the two ways to connect a server for AI (agent, or SSH with nothing
   installed in the Windows app).

## Checks run

- `cd gateway && npm ci && npm test && npm run typecheck`
- `python3 scripts/gen-release-notes.py --check`
- `cd center-windows/Core.Tests && dotnet test` (Windows Core files changed)
- `cargo test -p webrising-commender-agent` was not needed: the Rust changes
  are comments only.

## Release day (2026-11-23)

1. If the launch date moves, change it **before the first merge**: the entry
   id and date `2026-11-23-v1` in `release-notes/notes.json` (then
   `python3 scripts/gen-release-notes.py`), the `## 1.0.0 — 2026-11-23`
   heading in `CHANGELOG.md`, and the dates in `docs/LAUNCH_EMAIL.md`,
   `docs/LAUNCH_POSTS.md` and `docs/DIRECTORY_SUBMISSIONS.md`. Once an app has
   shown the note, its id must not change.
2. Re-read the TODO block below; ship only what has landed on `main`.
3. Merge the PR. CI on `main` builds `1.0.<run>` and the distribution
   workflows publish `ubuntu-preview-<run>` and `macos-preview-<run>`
   (prereleases); installed apps update to 1.0 and show the 1.0 notes once.
4. Promote the gateway: Actions → `promote-production`, `mode=promote`, the
   merge commit SHA as `sha` and `confirm_sha`; approve the `production`
   environment. The release tag is created by that workflow
   (`production-release/<UTC>-<sha12>`); do not create it by hand.
5. After the deploy: the gateway lists itself in the official MCP Registry as
   `1.0.0` (log line `MCP Registry: listed 1.0.0`); check
   `https://wecommander.app/server.json`, `/llms.txt` and `/changelog`.
6. Optional GitHub release named for 1.0: `release.yml` runs on a `v*` tag
   (e.g. `v1.0.0`) and builds the agent binaries and the Windows setup with
   `AppVersion=<tag name>`; the apps do not update from it (they follow the
   preview releases). Decide whether to push such a tag; it is not required.
7. Send the launch mail and publish the in-app messages and posts from
   `docs/LAUNCH_EMAIL.md` and `docs/LAUNCH_POSTS.md`; then the directory
   submissions in `docs/DIRECTORY_SUBMISSIONS.md`.

## TODO before release (not in the texts yet, do not claim until shipped)

> **Done (landed on `main` in #203 and #202, now in the texts).** Earlier note: When one of
> these lands on `main` before the launch, add it to the `2026-11-23-v1`
> entry (six languages), the 1.0.0 section of `CHANGELOG.md`, the launch
> mail and posts and `docs/DIRECTORY_SUBMISSIONS.md`, and remove the
> matching "not yet" wording ("macOS does not have it yet", "Windows only",
> "Not in 1.0").
>
> - [x] **Hybrid Access on macOS:** AI access settings for saved SSH servers
>   in the Mac app (local MCP and remote AI through this Mac).
> - [x] **Hybrid Access on Linux:** the same for the Linux desktop app.
> - [x] **Permissions for SSH targets:** trust levels (or another per-server
>   permission setting) for SSH servers shared with AI; today every command
>   and change over SSH needs an approval every time.
