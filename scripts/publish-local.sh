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
#   - `pnpm check` and `pnpm test:unit` are green.
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

verify_managed_base_images_exist() {
	if ! command -v docker >/dev/null 2>&1; then
		echo "[publish] error: Docker CLI not on PATH; cannot verify managed GHCR base images" >&2
		exit 1
	fi

	managed_base_images=()
	while IFS= read -r managed_base_image; do
		managed_base_images+=("$managed_base_image")
	done < <(
		node - <<'EOF'
const manifest = require('./packages/agent-vm/managed-images.json');
for (const image of Object.values(manifest.baseImages)) {
	console.log(`${image.repository}:${image.tag}`);
}
EOF
	)

	for image in "${managed_base_images[@]}"; do
		echo "[publish] checking $image"
		manifest_json="$(docker buildx imagetools inspect --raw "$image")" || {
			echo "[publish] error: managed GHCR base image tag is missing or inaccessible: $image" >&2
			exit 1
		}
		if ! MANAGED_BASE_IMAGE_MANIFEST="$manifest_json" node - "$image" <<'EOF'
const image = process.argv[2];
const manifest = JSON.parse(process.env.MANAGED_BASE_IMAGE_MANIFEST ?? '');
const platforms = new Set(
	(manifest.manifests ?? []).map((entry) => `${entry.platform?.os}/${entry.platform?.architecture}`),
);
for (const platform of ['linux/amd64', 'linux/arm64']) {
	if (!platforms.has(platform)) {
		throw new Error(`${image} is missing ${platform}`);
	}
}
EOF
		then
			echo "[publish] error: managed GHCR base image tag is missing or incomplete: $image" >&2
			exit 1
		fi
	done
}

echo "[publish] checking @agent-vm package version sync"
bash scripts/check-package-version-sync.sh

echo "[publish] verifying managed GHCR base image tags"
verify_managed_base_images_exist

echo "[publish] building workspace once"
pnpm build

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

echo "[publish] running pnpm -r publish --no-git-checks --config.ignore-scripts=true $DRY_RUN_FLAG"
pnpm -r publish --access=public --no-git-checks --config.ignore-scripts=true $DRY_RUN_FLAG

echo "[publish] done"
