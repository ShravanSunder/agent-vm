#!/usr/bin/env bash
#
# Fails when publishable npm and Python packages do not share one version.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v jq >/dev/null 2>&1; then
	echo "[publish] error: jq not on PATH" >&2
	exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
	echo "[publish] error: uv not on PATH" >&2
	exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
PACKAGE_ROWS_PATH="$WORKDIR/package-rows.tsv"
PACKAGE_VERSIONS_PATH="$WORKDIR/package-versions.txt"
DEPRECATED_PACKAGE_VIOLATIONS_PATH="$WORKDIR/deprecated-package-violations.txt"
PYTHON_PACKAGE_ROWS_PATH="$WORKDIR/python-package-rows.tsv"

find packages -mindepth 2 -maxdepth 2 -name package.json -print0 |
	xargs -0 jq -r '
			select(.name == "@agent-vm/openclaw-mcp-portal-plugin" and .private != true) |
			input_filename
		' > "$DEPRECATED_PACKAGE_VIOLATIONS_PATH"

if [[ -s "$DEPRECATED_PACKAGE_VIOLATIONS_PATH" ]]; then
	echo "[publish] error: deprecated managed OpenClaw MCP Portal plugin identity must be private" >&2
	while IFS= read -r package_file_path; do
		echo "[publish]   ${package_file_path}" >&2
	done < "$DEPRECATED_PACKAGE_VIOLATIONS_PATH"
	exit 1
fi

find packages -mindepth 2 -maxdepth 2 -name package.json -print0 |
	xargs -0 jq -r '
			select((.name | startswith("@agent-vm/")) and .private != true) |
			[.version, .name, input_filename] | @tsv
		' |
	sort -k2,2 > "$PACKAGE_ROWS_PATH"

if [[ ! -s "$PACKAGE_ROWS_PATH" ]]; then
	echo "[publish] error: no @agent-vm packages found under packages/" >&2
	exit 1
fi

cut -f1 "$PACKAGE_ROWS_PATH" | sort -u > "$PACKAGE_VERSIONS_PATH"
PACKAGE_VERSION_COUNT="$(wc -l < "$PACKAGE_VERSIONS_PATH" | tr -d '[:space:]')"

if [[ "$PACKAGE_VERSION_COUNT" -ne 1 ]]; then
	echo "[publish] error: @agent-vm package versions are not in sync" >&2
	while IFS= read -r package_row; do
		IFS=$'\t' read -r package_version package_name package_file_path <<< "$package_row"
		echo "[publish]   ${package_name}@${package_version} (${package_file_path})" >&2
	done < "$PACKAGE_ROWS_PATH"
	exit 1
fi

PACKAGE_COUNT="$(wc -l < "$PACKAGE_ROWS_PATH" | tr -d '[:space:]')"
PACKAGE_VERSION="$(sed -n '1p' "$PACKAGE_VERSIONS_PATH")"

PYTHON_PACKAGE_NAMES=(
	"agent-vm-agent-portal-sdk"
	"agent-vm-hermes-adapter"
)
for python_package_name in "${PYTHON_PACKAGE_NAMES[@]}"; do
	python_package_json="$(uv version --output-format json --package "$python_package_name")"
	python_package_version="$(jq -r '.version' <<< "$python_package_json")"
	if [[ -z "$python_package_version" || "$python_package_version" == "null" ]]; then
		echo "[publish] error: uv returned no version for ${python_package_name}" >&2
		exit 1
	fi
	printf '%s\t%s\n' "$python_package_version" "$python_package_name" >> "$PYTHON_PACKAGE_ROWS_PATH"
done

PYTHON_PACKAGE_COUNT="$(wc -l < "$PYTHON_PACKAGE_ROWS_PATH" | tr -d '[:space:]')"
while IFS=$'\t' read -r python_package_version python_package_name; do
	if [[ "$python_package_version" != "$PACKAGE_VERSION" ]]; then
		echo "[publish] error: ${python_package_name}@${python_package_version} does not match npm release ${PACKAGE_VERSION}" >&2
		exit 1
	fi
done < "$PYTHON_PACKAGE_ROWS_PATH"

ADAPTER_SDK_PIN="$(
	uv run --locked --quiet python - <<'PY'
import pathlib
import tomllib

manifest_path = pathlib.Path("python/agent-vm-hermes-adapter/pyproject.toml")
manifest = tomllib.loads(manifest_path.read_text())
sdk_dependencies = [
    dependency
    for dependency in manifest["project"]["dependencies"]
    if dependency.startswith("agent-vm-agent-portal-sdk")
]
if len(sdk_dependencies) != 1:
    raise SystemExit("Hermes adapter must declare exactly one agent-vm-agent-portal-sdk dependency")
print(sdk_dependencies[0])
PY
)"
EXPECTED_ADAPTER_SDK_PIN="agent-vm-agent-portal-sdk==${PACKAGE_VERSION}"
if [[ "$ADAPTER_SDK_PIN" != "$EXPECTED_ADAPTER_SDK_PIN" ]]; then
	echo "[publish] error: Hermes adapter SDK dependency must be ${EXPECTED_ADAPTER_SDK_PIN}, found ${ADAPTER_SDK_PIN}" >&2
	exit 1
fi

echo "[publish] ${PACKAGE_COUNT} npm and ${PYTHON_PACKAGE_COUNT} Python packages are synced at ${PACKAGE_VERSION}"
