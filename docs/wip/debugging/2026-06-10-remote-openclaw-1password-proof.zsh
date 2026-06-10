#!/usr/bin/env zsh
set -euo pipefail

CONFIG_PATH="${1:-config/system.jsonc}"
ZONE_ID="${2:-sunfam}"
OUTPUT_DIR="${3:-tmp/agent-vm-remote-proof-$(date +%Y%m%d%H%M%S)}"
INGRESS_URL="${AGENT_VM_PROOF_INGRESS_URL:-http://127.0.0.1:18791}"
RUN_REFRESH="${AGENT_VM_PROOF_RUN_REFRESH:-0}"
EXPECTED_AGENT_VM_VERSION="${AGENT_VM_PROOF_AGENT_VM_VERSION:-0.0.94}"

mkdir -p "$OUTPUT_DIR"
SUMMARY_PATH="$OUTPUT_DIR/share-safe-summary.txt"
: > "$SUMMARY_PATH"

leak_patterns=(
	-e '["'\''"]?OP_SERVICE_ACCOUNT_TOKEN["'\''"]?[[:space:]]*[:=]'
	-e '\bops_[A-Za-z0-9._=-]{16,}\b'
	-e 'Bearer[[:space:]]+[A-Za-z0-9._~+/=-]+'
	-e 'op://'
	-e 'stdout=.*[A-Za-z0-9._-]{20,}'
	-e 'stderr=.*[A-Za-z0-9._-]{20,}'
	-e '["'\''"]?(_authToken|password|passwd|token|secret|credential)["'\''"]?[[:space:]]*[:=][[:space:]]*["'\''"]?[A-Za-z0-9._/@+=:-]{8,}'
)

safe_patterns=(
	-e '1password-op-cli-headless'
	-e 'opEnvIsolation'
	-e 'opAuth='
	-e 'opConfig='
	-e 'opBiometricUnlock='
	-e 'opCache='
	-e 'opConnectEnv='
	-e 'opSessionEnv='
	-e 'opAccountEnv='
	-e 'operationId'
	-e 'operation-finished'
	-e 'operation-failed'
	-e 'secret-resolution-failed'
	-e 'gateway-service-health'
	-e 'agent-channel-provider-health'
	-e 'gateway-recovery'
	-e 'lifecycleState'
	-e 'readiness'
	-e 'vmId'
	-e 'hostPid'
	-e 'ingress'
	-e 'zoneId'
	-e 'statusCode'
	-e 'audience'
	-e 'resolvedSecretCount'
	-e '"/health"'
	-e '"/readyz"'
	-e '"ok"'
	-e '"ready"'
	-e 'passed'
	-e 'failed'
)

print_summary() {
	print -r -- "$*" >> "$SUMMARY_PATH"
}

fail_preflight() {
	print_summary ""
	print_summary "preflight=failed"
	print_summary "reason=$1"
	print_summary "summary=$SUMMARY_PATH"
	print -r -- "$SUMMARY_PATH"
	exit 2
}

require_command() {
	local command_name="$1"
	if ! command -v "$command_name" > /dev/null 2>&1; then
		fail_preflight "missing-command:$command_name"
	fi
}

record_command() {
	local name="$1"
	shift
	local output_path="$OUTPUT_DIR/$name.txt"
	local exit_path="$OUTPUT_DIR/$name.exit"
	print_summary ""
	print_summary ">>> $name"
	set +e
	"$@" > "$output_path" 2>&1
	local exit_code="$?"
	set -e
	print -r -- "$exit_code" > "$exit_path"
	print_summary "exit=$exit_code output=$output_path"
	leak_scan "$name" "$output_path"
	safe_extract "$name" "$output_path"
}

leak_scan() {
	local name="$1"
	local output_path="$2"
	local leak_scan_path="$output_path.leak-scan.txt"
	if rg -n "${leak_patterns[@]}" "$output_path" > "$leak_scan_path"; then
		print_summary "leak-scan=$leak_scan_path"
		print_summary "leak-scan-result=matches-present-do-not-share-raw-output"
	else
		print_summary "leak-scan-result=ok"
	fi
}

safe_extract() {
	local name="$1"
	local output_path="$2"
	local candidates_path="$OUTPUT_DIR/$name.safe-candidates.txt"
	local redacted_safe_path="$OUTPUT_DIR/$name.safe-lines.txt"
	if ! rg -n "${safe_patterns[@]}" "$output_path" > "$candidates_path"; then
		print_summary "safe-lines=none"
		return
	fi
	if rg -q "${leak_patterns[@]}" "$candidates_path"; then
		print_summary "safe-lines-note=some-candidate-lines-omitted-by-leak-filter"
	fi
	rg -v "${leak_patterns[@]}" "$candidates_path" > "$redacted_safe_path" || true
	if [[ -s "$redacted_safe_path" ]]; then
		print_summary "safe-lines:"
		cat "$redacted_safe_path" >> "$SUMMARY_PATH"
	else
		print_summary "safe-lines=none-after-leak-filter"
	fi
}

read_recorded_exit_code() {
	local name="$1"
	local exit_path="$OUTPUT_DIR/$name.exit"
	if [[ ! -f "$exit_path" ]]; then
		print -r -- "missing"
		return
	fi
	cat "$exit_path"
}

summarize_expected_exit() {
	local name="$1"
	local expected_exit="$2"
	local exit_code
	exit_code="$(read_recorded_exit_code "$name")"
	if [[ "$exit_code" == "$expected_exit" ]]; then
		print_summary "proof-check:$name=passed exit=$exit_code"
	else
		print_summary "proof-check:$name=failed exit=$exit_code expected=$expected_exit"
	fi
}

summarize_observed_exit() {
	local name="$1"
	local exit_code
	exit_code="$(read_recorded_exit_code "$name")"
	print_summary "observed-exit:$name=$exit_code"
}

summarize_leak_scan_overview() {
	local scan_count=0
	local match_count=0
	local leak_scan_path
	for leak_scan_path in "$OUTPUT_DIR"/*.leak-scan.txt(N); do
		scan_count=$((scan_count + 1))
		if [[ -s "$leak_scan_path" ]]; then
			match_count=$((match_count + 1))
		fi
	done
	print_summary "proof-check:leak-scan-files=$scan_count"
	if ((match_count == 0)); then
		print_summary "proof-check:leak-scan-matches=none"
	else
		print_summary "proof-check:leak-scan-matches=$match_count inspect-before-sharing-raw"
	fi
}

print_summary "agent-vm remote OpenClaw/1Password proof"
print_summary "timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
print_summary "cwd=$PWD"
print_summary "config=$CONFIG_PATH"
print_summary "zone=$ZONE_ID"
print_summary "ingress=$INGRESS_URL"
print_summary "run-refresh=$RUN_REFRESH"
print_summary "expected-agent-vm-version=$EXPECTED_AGENT_VM_VERSION"
print_summary ""
print_summary "Keep this file shareable. Share raw *.txt files only after inspecting any *.leak-scan.txt files."

require_command rg
require_command pnpm
require_command node
require_command op

if [[ ! -f "$CONFIG_PATH" ]]; then
	fail_preflight "config-not-found:$CONFIG_PATH"
fi

if [[ ! -f node_modules/@agent-vm/agent-vm/package.json ]]; then
	fail_preflight "agent-vm-package-not-installed:node_modules/@agent-vm/agent-vm/package.json"
fi

INSTALLED_AGENT_VM_VERSION="$(
	node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("node_modules/@agent-vm/agent-vm/package.json","utf8")); console.log(pkg.version);'
)"
print_summary "installed-agent-vm-version=$INSTALLED_AGENT_VM_VERSION"
if [[ "$INSTALLED_AGENT_VM_VERSION" != "$EXPECTED_AGENT_VM_VERSION" ]]; then
	fail_preflight "unexpected-agent-vm-version:$INSTALLED_AGENT_VM_VERSION"
fi

record_command "agent-vm-version" pnpm exec agent-vm --version
record_command "agent-vm-package-version" node -e 'const fs=require("node:fs"); const pkg=JSON.parse(fs.readFileSync("node_modules/@agent-vm/agent-vm/package.json","utf8")); console.log(pkg.version);'
record_command "op-version" op --version
record_command "validate" pnpm exec agent-vm validate --config "$CONFIG_PATH"
record_command "doctor-locked-desktop" pnpm exec agent-vm doctor --config "$CONFIG_PATH" --show-passed
record_command "doctor-locked-desktop-poisoned-env" env \
	OP_CONNECT_HOST=https://connect.invalid.example \
	OP_CONNECT_TOKEN=ambient-connect-token \
	OP_SESSION=ambient-session-token \
	OP_SESSION_human=ambient-named-session-token \
	OP_ACCOUNT=ambient-account \
	OP_CONFIG_DIR=/tmp/ambient-human-op-config \
	OP_CACHE=true \
	OP_BIOMETRIC_UNLOCK_ENABLED=true \
	pnpm exec agent-vm doctor --config "$CONFIG_PATH" --show-passed

record_command "credentials-check-locked-desktop" pnpm exec agent-vm controller credentials check --config "$CONFIG_PATH" --zone "$ZONE_ID"

if [[ "$RUN_REFRESH" == "1" ]]; then
	record_command "credentials-refresh" pnpm exec agent-vm controller credentials refresh --config "$CONFIG_PATH" --zone "$ZONE_ID"
else
	print_summary ""
	print_summary ">>> credentials-refresh"
	print_summary "skipped=set AGENT_VM_PROOF_RUN_REFRESH=1 to exercise runtime secret refresh"
fi

record_command "controller-status" pnpm exec agent-vm controller status --config "$CONFIG_PATH" --zone "$ZONE_ID"
record_command "controller-health-readiness" pnpm exec agent-vm controller health --config "$CONFIG_PATH" --zone "$ZONE_ID"
record_command "controller-service-health-liveness" pnpm exec agent-vm controller service-health --config "$CONFIG_PATH" --zone "$ZONE_ID"
record_command "controller-health-snapshot" pnpm exec agent-vm controller health-snapshot --config "$CONFIG_PATH" --zone "$ZONE_ID"

if command -v curl > /dev/null 2>&1; then
	record_command "curl-ingress-health" curl -sS -i "$INGRESS_URL/health"
	record_command "curl-ingress-readyz" curl -sS -i "$INGRESS_URL/readyz"
else
	print_summary ""
	print_summary ">>> curl-ingress"
	print_summary "skipped=curl-not-found"
fi

print_summary ""
print_summary ">>> proof-checks"
summarize_expected_exit "validate" "0"
summarize_expected_exit "doctor-locked-desktop" "0"
summarize_expected_exit "doctor-locked-desktop-poisoned-env" "0"
summarize_expected_exit "credentials-check-locked-desktop" "0"
if [[ "$RUN_REFRESH" == "1" ]]; then
	summarize_expected_exit "credentials-refresh" "0"
else
	print_summary "proof-check:credentials-refresh=skipped"
fi
summarize_observed_exit "controller-status"
summarize_observed_exit "controller-health-readiness"
summarize_observed_exit "controller-service-health-liveness"
summarize_observed_exit "controller-health-snapshot"
summarize_leak_scan_overview

print_summary ""
print_summary "done"
print_summary "summary=$SUMMARY_PATH"
print -r -- "$SUMMARY_PATH"
