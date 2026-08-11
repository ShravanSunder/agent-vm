#!/usr/bin/env bash
#
# Publishes the synchronized npm and Python Agent VM package release.
#
# Auth model:
#   - npm and PyPI tokens are read from 1Password at runtime.
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
#   scripts/publish-local.sh
#   scripts/publish-local.sh --dry-run
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OP_REF="${AGENT_VM_NPM_TOKEN_OP_REF:-op://agent-vm/npm-token-agent-vm-publish/credential}"
PYPI_OP_REF="${AGENT_VM_PYPI_TOKEN_OP_REF:-op://Dev/PyPI/api-token}"
DRY_RUN="false"
case "${1:-}" in
	"") ;;
	--dry-run)
		DRY_RUN="true"
		echo "[publish] dry-run mode — no artifacts will be uploaded"
		;;
	*)
		echo "[publish] error: expected no arguments or --dry-run" >&2
		exit 1
		;;
esac

if ! command -v op >/dev/null 2>&1; then
	echo "[publish] error: 1Password CLI (op) not on PATH" >&2
	exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
	echo "[publish] error: pnpm not on PATH" >&2
	exit 1
fi

for required_command in curl jq uv; do
	if ! command -v "$required_command" >/dev/null 2>&1; then
		echo "[publish] error: required command is unavailable: $required_command" >&2
		exit 1
	fi
done

WORKDIR="$(mktemp -d)"
chmod 700 "$WORKDIR"
cleanup() {
	unset NPM_TOKEN PYPI_TOKEN
	rm -rf "$WORKDIR"
}
trap cleanup EXIT

echo "[publish] resolving release credentials before long-running preflight"
NPM_TOKEN="${AGENT_VM_NPM_TOKEN-}"
if [[ -z "$NPM_TOKEN" ]]; then
	NPM_TOKEN="$(op read "$OP_REF")"
fi
if [[ -z "$NPM_TOKEN" ]]; then
	echo "[publish] error: 1Password returned an empty npm token" >&2
	exit 1
fi
PYPI_TOKEN="${AGENT_VM_PYPI_TOKEN-}"
if [[ "$DRY_RUN" == "false" ]]; then
	if [[ -z "$PYPI_TOKEN" ]]; then
		PYPI_TOKEN="$(op read "$PYPI_OP_REF")"
	fi
	if [[ -z "$PYPI_TOKEN" ]]; then
		echo "[publish] error: 1Password returned an empty PyPI token" >&2
		exit 1
	fi
fi

cat > "$WORKDIR/.npmrc" <<EOF
//registry.npmjs.org/:_authToken=$NPM_TOKEN
registry=https://registry.npmjs.org/
EOF
unset NPM_TOKEN
export NPM_CONFIG_USERCONFIG="$WORKDIR/.npmrc"

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

verify_published_release() {
	local release_version
	release_version="$(node -p 'require("./packages/agent-vm/package.json").version')"
	local verification_failed="false"
	local package_name
	while IFS= read -r package_name; do
		if [[ "$(npm view "$package_name@$release_version" version 2>/dev/null || true)" != "$release_version" ]]; then
			echo "[publish] waiting for $package_name@$release_version on npm"
			verification_failed="true"
		fi
	done < <(
		node - <<'NODE'
const fs = require('node:fs');
for (const directoryName of fs.readdirSync('packages')) {
	const manifestPath = `packages/${directoryName}/package.json`;
	if (!fs.existsSync(manifestPath)) continue;
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	if (manifest.name?.startsWith('@agent-vm/') && manifest.private !== true) {
		console.log(manifest.name);
	}
}
NODE
	)

	local python_package
	for python_package in agent-vm-agent-portal-sdk agent-vm-hermes-adapter; do
		if [[ "$(
			curl -fsS "https://pypi.org/pypi/${python_package}/${release_version}/json" 2>/dev/null |
				jq -r '.urls | length' 2>/dev/null || true
		)" != "2" ]]; then
			echo "[publish] waiting for ${python_package}==${release_version} on PyPI"
			verification_failed="true"
		fi
	done

	[[ "$verification_failed" == "false" ]]
}

echo "[publish] checking @agent-vm package version sync"
bash scripts/check-package-version-sync.sh

echo "[publish] verifying managed GHCR base image tags"
verify_managed_base_images_exist

echo "[publish] building workspace once"
pnpm build

echo "[publish] verifying npm auth"
npm whoami

echo "[publish] preflighting Python artifacts"
scripts/publish-python-local.sh --dry-run

echo "[publish] preflighting npm artifacts"
pnpm -r publish --access=public --no-git-checks --config.ignore-scripts=true --dry-run

if [[ "$DRY_RUN" == "true" ]]; then
	echo "[publish] dry-run complete"
	exit 0
fi

echo "[publish] publishing Python artifacts"
AGENT_VM_PYPI_TOKEN="$PYPI_TOKEN" scripts/publish-python-local.sh
unset PYPI_TOKEN

echo "[publish] publishing npm artifacts"
pnpm -r publish --access=public --no-git-checks --config.ignore-scripts=true

echo "[publish] verifying complete npm and PyPI release"
for verification_attempt in {1..12}; do
	if verify_published_release; then
		echo "[publish] verified complete synchronized release"
		echo "[publish] done"
		exit 0
	fi
	if [[ "$verification_attempt" -lt 12 ]]; then
		sleep 2
	fi
done

echo "[publish] error: synchronized release did not become fully visible" >&2
exit 1
