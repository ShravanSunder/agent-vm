#!/usr/bin/env bash
#
# Builds and publishes the agent-vm Python packages to PyPI.
#
# Live authentication is resolved from 1Password into the uv process
# environment. Dry-run mode never reads 1Password and requires no token.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN="false"
case "${1:-}" in
	"") ;;
	--dry-run) DRY_RUN="true" ;;
	*)
		echo "[python-publish] error: expected no arguments or --dry-run" >&2
		exit 1
		;;
esac

if ! command -v uv >/dev/null 2>&1; then
	echo "[python-publish] error: uv not on PATH" >&2
	exit 1
fi

echo "[python-publish] checking synchronized npm and Python package versions"
bash scripts/check-package-version-sync.sh

PYTHON_RELEASE_VERSION="$(uv version --short --package agent-vm-agent-portal-sdk)"
PYTHON_DIST_DIR="$(mktemp -d)"
cleanup() {
	unset UV_PUBLISH_TOKEN
	rm -rf "$PYTHON_DIST_DIR"
}
trap cleanup EXIT

echo "[python-publish] building Python packages in an isolated directory"
uv build \
	--all-packages \
	--out-dir "$PYTHON_DIST_DIR" \
	--no-create-gitignore

SDK_ARTIFACTS=(
	"$PYTHON_DIST_DIR/agent_vm_agent_portal_sdk-${PYTHON_RELEASE_VERSION}-py3-none-any.whl"
	"$PYTHON_DIST_DIR/agent_vm_agent_portal_sdk-${PYTHON_RELEASE_VERSION}.tar.gz"
)
ADAPTER_ARTIFACTS=(
	"$PYTHON_DIST_DIR/agent_vm_hermes_adapter-${PYTHON_RELEASE_VERSION}-py3-none-any.whl"
	"$PYTHON_DIST_DIR/agent_vm_hermes_adapter-${PYTHON_RELEASE_VERSION}.tar.gz"
)

for python_artifact in "${SDK_ARTIFACTS[@]}" "${ADAPTER_ARTIFACTS[@]}"; do
	if [[ ! -s "$python_artifact" ]]; then
		echo "[python-publish] error: expected artifact was not built: $(basename "$python_artifact")" >&2
		exit 1
	fi
done

PYTHON_ARTIFACT_COUNT="$(find "$PYTHON_DIST_DIR" -maxdepth 1 -type f | wc -l | tr -d '[:space:]')"
if [[ "$PYTHON_ARTIFACT_COUNT" -ne 4 ]]; then
	echo "[python-publish] error: expected exactly four Python distribution artifacts, found ${PYTHON_ARTIFACT_COUNT}" >&2
	exit 1
fi

PUBLISH_ARGS=(
	--trusted-publishing never
	--check-url https://pypi.org/simple
)

if [[ "$DRY_RUN" == "true" ]]; then
	echo "[python-publish] checking SDK artifacts without uploading"
	uv publish --dry-run "${PUBLISH_ARGS[@]}" "${SDK_ARTIFACTS[@]}"
	echo "[python-publish] checking Hermes adapter artifacts without uploading"
	uv publish --dry-run "${PUBLISH_ARGS[@]}" "${ADAPTER_ARTIFACTS[@]}"
	echo "[python-publish] dry-run complete"
	exit 0
fi

PYPI_TOKEN="${AGENT_VM_PYPI_TOKEN-}"
if [[ -z "$PYPI_TOKEN" ]]; then
	if [[ -z "${AGENT_VM_PYPI_TOKEN_OP_REF-}" ]]; then
		echo "[python-publish] error: a resolved PyPI token or 1Password reference is required" >&2
		exit 1
	fi
	if ! command -v op >/dev/null 2>&1; then
		echo "[python-publish] error: 1Password CLI (op) not on PATH" >&2
		exit 1
	fi
	PYPI_TOKEN="$(op read "$AGENT_VM_PYPI_TOKEN_OP_REF")"
fi
if [[ -z "$PYPI_TOKEN" ]]; then
	echo "[python-publish] error: 1Password returned an empty PyPI token" >&2
	exit 1
fi
export UV_PUBLISH_TOKEN="$PYPI_TOKEN"
unset PYPI_TOKEN

echo "[python-publish] publishing SDK artifacts"
uv publish "${PUBLISH_ARGS[@]}" "${SDK_ARTIFACTS[@]}"
echo "[python-publish] publishing Hermes adapter artifacts"
uv publish "${PUBLISH_ARGS[@]}" "${ADAPTER_ARTIFACTS[@]}"

echo "[python-publish] done"
