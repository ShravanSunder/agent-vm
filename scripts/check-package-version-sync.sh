#!/usr/bin/env bash
#
# Fails when publishable @agent-vm workspace packages do not share one version.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! command -v jq >/dev/null 2>&1; then
	echo "[publish] error: jq not on PATH" >&2
	exit 1
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
PACKAGE_ROWS_PATH="$WORKDIR/package-rows.tsv"
PACKAGE_VERSIONS_PATH="$WORKDIR/package-versions.txt"

find packages -mindepth 2 -maxdepth 2 -name package.json -print0 |
	xargs -0 jq -r '
			select(.name | startswith("@agent-vm/")) |
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
echo "[publish] ${PACKAGE_COUNT} @agent-vm packages are synced at ${PACKAGE_VERSION}"
