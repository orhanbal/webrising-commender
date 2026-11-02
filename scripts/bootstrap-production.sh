#!/usr/bin/env bash
# One-time creation of the `production` branch (Issue #30), run by the
# repository owner from their own checkout BEFORE the production ruleset exists
# and BEFORE Coolify is switched to track `production`.
#
#   scripts/bootstrap-production.sh <sha> <sha-again>            # dry run
#   scripts/bootstrap-production.sh <sha> <sha-again> --execute  # create
#
# Creating the branch deploys nothing while Coolify still tracks `main`.
# The release gate (mode=bootstrap) must pass: full SHA on main, exact-SHA
# 17/17 green main push CI, green platform-distribution, no existing
# `production` branch and no existing production-release/* tag.
# Needs: git, node >= 22, network access to api.github.com. GH_TOKEN optional.
set -euo pipefail

sha="${1:-}"; confirm="${2:-}"; execute="${3:-}"
if [[ -z "$sha" || -z "$confirm" ]]; then
  echo "usage: $0 <40-char-sha> <same-sha-again> [--execute]" >&2
  exit 2
fi
if [[ -n "$execute" && "$execute" != "--execute" ]]; then
  echo "unknown argument: $execute" >&2
  exit 2
fi

cd "$(git rev-parse --show-toplevel)"
remote_url="$(git remote get-url origin)"
repo="${GITHUB_REPOSITORY:-$(sed -E 's#^(https://github.com/|git@github.com:)##; s#\.git$##' <<<"$remote_url")}"

GITHUB_REPOSITORY="$repo" RELEASE_MODE=bootstrap RELEASE_SHA="$sha" RELEASE_CONFIRM_SHA="$confirm" \
  node scripts/release-gate.mjs

tag="production-release/$(date -u +%Y%m%dT%H%M%SZ)-${sha:0:12}"
actor="$(git config user.email || echo unknown)"
note="$(mktemp)"
trap 'rm -f "$note"' EXIT
printf 'mode: bootstrap\nsha: %s\nprevious: none\nactor: %s\nreason: Issue #30 one-time production ref bootstrap at the known-good deployed commit\n' \
  "$sha" "$actor" > "$note"

echo
echo "Would create annotated tag ${tag} -> ${sha} and push atomically:"
echo "  git push --atomic --force-with-lease=refs/heads/production: origin ${sha}:refs/heads/production refs/tags/${tag}"
if [[ "$execute" != "--execute" ]]; then
  echo "Dry run only. Re-run with --execute to create the branch and tag."
  exit 0
fi

git tag -a "$tag" "$sha" -F "$note"
if ! git push --atomic "--force-with-lease=refs/heads/production:" origin "${sha}:refs/heads/production" "refs/tags/${tag}"; then
  git tag -d "$tag" >/dev/null
  echo "push refused; nothing was created" >&2
  exit 1
fi
echo "production -> ${sha} created with ${tag}. Next: create the rulesets (docs/RELEASE_POLICY.md step 3)."
