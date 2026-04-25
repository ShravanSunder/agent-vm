#!/usr/bin/env bash
#
# Publishes every workspace package to npm under @agent-vm.
#
# Auth model:
#   - npm token is read from 1Password at runtime.
#   - The token lives ONLY in a temp .npmrc that npm reads via
#     NPM_CONFIG_USERCONFIG.  The temp file is deleted on exit.
#   - The token never lands in the repo, ~/.npmrc, or shell history.
#
# Preconditions:
#   - 1Password CLI (`op`) is signed in.
#   - Working tree is clean (commit version bumps before publishing).
#   - `pnpm build` and `pnpm check` and `pnpm test:unit` are green.
#
# Use:
#   scripts/publish-local.sh           # publish all packages
#   scripts/publish-local.sh --dry-run # rehearsal, no upload
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OP_REF="op://agent-vm/npm-token-agent-vm-publish/credential"
DRY_RUN_FLAG=""
if [[ "${1:-}" == "--dry-run" ]]; then
	DRY_RUN_FLAG="--dry-run"
	echo "[publish] dry-run mode — no tarballs will be uploaded"
fi

if ! command -v op >/dev/null 2>&1; then
	echo "[publish] error: 1Password CLI (op) not on PATH" >&2
	exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
	echo "[publish] error: pnpm not on PATH" >&2
	exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

NPM_TOKEN="$(op read "$OP_REF")"
if [[ -z "$NPM_TOKEN" ]]; then
	echo "[publish] error: empty token from $OP_REF" >&2
	exit 1
fi

cat > "$WORKDIR/.npmrc" <<EOF
//registry.npmjs.org/:_authToken=$NPM_TOKEN
registry=https://registry.npmjs.org/
EOF
unset NPM_TOKEN

export NPM_CONFIG_USERCONFIG="$WORKDIR/.npmrc"

echo "[publish] verifying npm auth"
npm whoami

echo "[publish] running pnpm -r publish $DRY_RUN_FLAG"
pnpm -r publish --access=public $DRY_RUN_FLAG

echo "[publish] done"
