#!/usr/bin/env bash
set -euo pipefail

mode="${1:?stale-wheel or wrong-mcp}"
reference="${2:?approved full feature commit}"
packet="${S4C2_CI_PACKET_DIR:?approved packet directory}"
test_path="packages/agent-vm/src/integration-tests/portal-composition.hermes.e2e.test.ts"
test "${CI:-}" = true
test "${RUNNER_OS:-}" = Linux
test -r /dev/kvm
test -w /dev/kvm
test "$(git rev-parse HEAD)" = "$reference"
git diff --exit-code
output="${RUNNER_TEMP:?}/s4c2-negative-${mode}"
mkdir -p "$output"

# Both roots are private to this matrix job. No restore/save-image-cache action is used.
export AGENT_VM_E2E_USE_LOCAL_TOOL_VM_PACKAGES=1
export AGENT_VM_HERMES_E2E=1
export AGENT_VM_E2E_SKIP_WORKSPACE_BUILD=1
export AGENT_VM_E2E_REQUIRE_PREPARED_IMAGE_CACHE=0
export AGENT_VM_E2E_CACHE_DIR="$output/baseline-cache"
mise exec -- pnpm exec vitest run --project e2e-hermes "$test_path" > "$output/baseline.log" 2>&1
cat "$output/baseline.log"

python3 "$packet/prepare_mutation.py" apply --checkout "$PWD" --reference "$reference" --mode "$mode" --output "$output"
restore_source() {
  python3 "$packet/prepare_mutation.py" restore --checkout "$PWD" --reference "$reference" --mode "$mode" --output "$output"
}
trap restore_source EXIT
export AGENT_VM_E2E_CACHE_DIR="$output/mutant-cache"
set +e
timeout 900 mise exec -- pnpm exec vitest run --project e2e-hermes "$test_path" > "$output/mutant.log" 2>&1
mutant_status=$?
set -e
cat "$output/mutant.log"
python3 "$packet/assess_negative.py" "$mode" "$mutant_status" "$output/mutant.log"
restore_source
trap - EXIT
git diff --exit-code
export AGENT_VM_E2E_CACHE_DIR="$output/baseline-cache"
mise exec -- pnpm exec vitest run --project e2e-hermes "$test_path" > "$output/restored.log" 2>&1
cat "$output/restored.log"
printf 's4c2-negative-restored %s %s\n' "$mode" "$reference"
