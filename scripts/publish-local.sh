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
#   AGENT_VM_NPM_TOKEN_OP_REF='op://agent-vm/npm-token-agent-vm-publish/credential' scripts/publish-local.sh
#   AGENT_VM_NPM_TOKEN_OP_REF='op://agent-vm/npm-token-agent-vm-publish/credential' scripts/publish-local.sh --dry-run
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OP_REF="${AGENT_VM_NPM_TOKEN_OP_REF:-op://agent-vm/npm-token-agent-vm-publish/credential}"
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

if ! command -v jq >/dev/null 2>&1; then
	echo "[publish] error: jq not on PATH" >&2
	exit 1
fi

echo "[publish] checking @agent-vm package version sync"
bash scripts/check-package-version-sync.sh

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
PUBLISHABLE_PACKAGES_PATH="$WORKDIR/publishable-packages.tsv"

find packages -mindepth 2 -maxdepth 2 -name package.json -print0 |
	xargs -0 jq -r '
			select((.name | startswith("@agent-vm/")) and (.private != true)) |
			[.name, .version] | @tsv
		' |
	sort -k1,1 > "$PUBLISHABLE_PACKAGES_PATH"

if [[ ! -s "$PUBLISHABLE_PACKAGES_PATH" ]]; then
	echo "[publish] error: no publishable @agent-vm packages found under packages/" >&2
	exit 1
fi

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

echo "[publish] running pnpm -r publish --no-git-checks $DRY_RUN_FLAG"
pnpm -r publish --access=public --no-git-checks $DRY_RUN_FLAG

if [[ -z "$DRY_RUN_FLAG" ]]; then
	echo "[publish] verifying every publishable @agent-vm package is visible on npm"
	while IFS=$'\t' read -r package_name package_version; do
		verified_version=""
		for attempt in 1 2 3 4 5; do
			if verified_version="$(npm view "${package_name}@${package_version}" version 2>/dev/null)"; then
				break
			fi
			sleep 3
		done

		if [[ "$verified_version" != "$package_version" ]]; then
			echo "[publish] error: ${package_name}@${package_version} is not visible on npm" >&2
			exit 1
		fi

		echo "[publish] verified ${package_name}@${package_version}"
	done < "$PUBLISHABLE_PACKAGES_PATH"
fi

echo "[publish] done"
