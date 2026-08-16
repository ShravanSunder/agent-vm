#!/usr/bin/env bash
#
# Publishes the synchronized npm and Python release through GitHub OIDC.
# Safe to rerun for the same commit: npm versions and PyPI files that already
# exist are skipped, and final success requires all 21 registry versions.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [[ "${GITHUB_ACTIONS-}" != "true" || -z "${ACTIONS_ID_TOKEN_REQUEST_URL-}" ]]; then
	echo "[trusted-release] error: GitHub Actions OIDC is required" >&2
	exit 1
fi

for required_command in curl docker jq node npm pnpm uv; do
	if ! command -v "$required_command" >/dev/null 2>&1; then
		echo "[trusted-release] error: required command is unavailable: $required_command" >&2
		exit 1
	fi
done

RELEASE_WORKDIR="$(mktemp -d)"
chmod 700 "$RELEASE_WORKDIR"
cleanup() {
	rm -rf "$RELEASE_WORKDIR"
}
trap cleanup EXIT

release_version="$(node -p 'require("./packages/agent-vm/package.json").version')"
NPM_PACKAGE_NAMES_PATH="$RELEASE_WORKDIR/npm-package-names.txt"
node - <<'NODE' > "$NPM_PACKAGE_NAMES_PATH"
const fs = require('node:fs');
for (const directoryName of fs.readdirSync('packages').sort()) {
	const manifestPath = `packages/${directoryName}/package.json`;
	if (!fs.existsSync(manifestPath)) continue;
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	if (manifest.name?.startsWith('@agent-vm/') && manifest.private !== true) {
		console.log(manifest.name);
	}
}
NODE
npm_package_count="$(wc -l < "$NPM_PACKAGE_NAMES_PATH" | tr -d '[:space:]')"
if [[ "$npm_package_count" -eq 0 ]]; then
	echo "[trusted-release] error: no publishable @agent-vm packages were found" >&2
	exit 1
fi

echo "[trusted-release] checking synchronized release inputs"
bash scripts/check-package-version-sync.sh

echo "[trusted-release] verifying managed base image tags"
while IFS= read -r managed_base_image; do
	managed_base_image_manifest="$(docker buildx imagetools inspect --raw "$managed_base_image")" || {
		echo "[trusted-release] error: managed base image is missing or inaccessible: $managed_base_image" >&2
		exit 1
	}
	if ! MANAGED_BASE_IMAGE_MANIFEST="$managed_base_image_manifest" node - "$managed_base_image" <<'NODE'
const image = process.argv[2];
const manifest = JSON.parse(process.env.MANAGED_BASE_IMAGE_MANIFEST ?? '');
const platforms = new Set(
	(manifest.manifests ?? []).map((entry) => `${entry.platform?.os}/${entry.platform?.architecture}`),
);
for (const platform of ['linux/amd64', 'linux/arm64']) {
	if (!platforms.has(platform)) throw new Error(`${image} is missing ${platform}`);
}
NODE
	then
		echo "[trusted-release] error: managed base image is incomplete: $managed_base_image" >&2
		exit 1
	fi
done < <(
	node - <<'NODE'
const manifest = require('./packages/agent-vm/managed-images.json');
for (const image of Object.values(manifest.baseImages)) {
	console.log(`${image.repository}:${image.tag}`);
}
NODE
)

echo "[trusted-release] building workspace once"
pnpm build

echo "[trusted-release] packing all npm artifacts without lifecycle rebuilds"
while IFS= read -r package_name; do
	pnpm \
		--filter "$package_name" \
		pack \
		--pack-destination "$RELEASE_WORKDIR" \
		--config.ignore-scripts=true >/dev/null
	package_tarball="$RELEASE_WORKDIR/${package_name/@agent-vm\//agent-vm-}-${release_version}.tgz"
	if [[ ! -s "$package_tarball" ]]; then
		echo "[trusted-release] error: expected npm artifact was not packed: $package_tarball" >&2
		exit 1
	fi
done < "$NPM_PACKAGE_NAMES_PATH"

echo "[trusted-release] publishing missing Python artifacts through OIDC"
scripts/publish-python-local.sh --trusted-publishing

echo "[trusted-release] publishing missing npm versions through OIDC"
while IFS= read -r package_name; do
	if [[ "$(npm view "$package_name@$release_version" version 2>/dev/null || true)" == "$release_version" ]]; then
		echo "[trusted-release] already published: $package_name@$release_version"
		continue
	fi
	package_tarball="$RELEASE_WORKDIR/${package_name/@agent-vm\//agent-vm-}-${release_version}.tgz"
	npm publish "$package_tarball" --access=public --ignore-scripts
done < "$NPM_PACKAGE_NAMES_PATH"

verify_published_release() {
	local verification_failed="false"
	local package_name
	while IFS= read -r package_name; do
		if [[ "$(npm view "$package_name@$release_version" version 2>/dev/null || true)" != "$release_version" ]]; then
			echo "[trusted-release] waiting for $package_name@$release_version on npm"
			verification_failed="true"
		fi
	done < "$NPM_PACKAGE_NAMES_PATH"

	local python_package
	for python_package in agent-vm-agent-portal-sdk agent-vm-hermes-adapter; do
		if [[ "$(curl -fsS "https://pypi.org/pypi/${python_package}/${release_version}/json" 2>/dev/null | jq -r '.urls | length' 2>/dev/null || true)" != "2" ]]; then
			echo "[trusted-release] waiting for ${python_package}==${release_version} on PyPI"
			verification_failed="true"
		fi
	done
	[[ "$verification_failed" == "false" ]]
}

echo "[trusted-release] verifying complete npm and PyPI release"
for verification_attempt in {1..12}; do
	if verify_published_release; then
		echo "[trusted-release] verified $npm_package_count npm and 2 Python packages at $release_version"
		exit 0
	fi
	if [[ "$verification_attempt" -lt 12 ]]; then
		sleep 2
	fi
done

echo "[trusted-release] error: synchronized release did not become fully visible" >&2
exit 1
