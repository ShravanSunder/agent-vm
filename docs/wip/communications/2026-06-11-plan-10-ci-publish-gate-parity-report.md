# Plan 10 - CI Publish-Gate Parity and E2E Lane Wiring

Date: 2026-06-11
Branch: `improve/plan-10-ci-publish-gate-parity`
Base branch: `improve-v1`
Implementation commit: `3c77760 ci: align publish gate with e2e proof lanes`
Push state: pushed to `origin/improve/plan-10-ci-publish-gate-parity`
PR URL: https://github.com/ShravanSunder/agent-vm/pull/new/improve/plan-10-ci-publish-gate-parity

## Scope

Implemented the reviewed plan at
`docs/superpowers/plans/2026-06-10-repo-improvements/10-ci-publish-gate-parity.md`.

Changed surfaces:

- `.github/workflows/publish.yml`
- `scripts/run-e2e-proof-lanes.ts`
- `scripts/run-e2e-proof-lanes.unit.test.ts`

No `docs/` taxonomy page needed updating: the scoped `docs/` scan outside WIP and plan files found only `docs/subsystems/mcp-portal.md`, which already documents the explicit OpenClaw E2E lane.

## Implementation Summary

- Added the publish-job gate steps missing relative to CI:
  - `pnpm test:taxonomy`
  - `pnpm lint:types`
  - `pnpm typecheck`
  - `pnpm test:integration`
  - `pnpm test:e2e:inventory`
- Extended `scripts/run-e2e-proof-lanes.ts` from 3 lanes to 6:
  - existing ungated lanes: `e2e-host`, `e2e-vm`, `e2e-vm-mediation`
  - newly visible gated lanes: `e2e-openclaw`, `e2e-worker`, `e2e-secrets`
- Added explicit per-lane gate env checks:
  - `AGENT_VM_OPENCLAW_E2E=1`
  - `AGENT_VM_WORKER_E2E=1`
  - `AGENT_VM_1PASSWORD_E2E=1`
- Changed the lane summary so absent gated lanes are reported as `SKIP`, not silently omitted or counted as pass/fail.

## Red Proof

Before implementation, the new runner tests failed against current code:

- Command: `pnpm vitest run --config vitest.config.ts --project unit scripts/run-e2e-proof-lanes.unit.test.ts`
- Exit: 1
- Result: 1 failed file, 3 failed tests, 3 passed tests
- Expected failures:
  - lane list only contained 3 IDs instead of 6.
  - `skippedCount` was undefined.
  - gated-lane-present case only started 3 lanes instead of 6.

## Proof Gates

- `pnpm fmt`
  - Exit: 0
  - Result: Oxfmt completed on 621 files.
- `pnpm vitest run --config vitest.config.ts --project unit scripts/run-e2e-proof-lanes.unit.test.ts`
  - Exit: 0
  - Result: 1 file passed, 6 tests passed.
- `pnpm test:e2e:inventory`
  - Exit: 0
  - Result: 1 file passed, 15 files skipped; 1 test passed, 26 tests skipped.
- `mise exec -- pnpm test:e2e`
  - Exit: 0
  - Result: 3 lanes passed, 3 skipped, 0 failed.
  - Passed: `e2e-host` 149 tests / 19 files; `e2e-vm` 10 tests / 6 files; `e2e-vm-mediation` 3 tests / 2 files.
  - Skipped: `e2e-openclaw` because `AGENT_VM_OPENCLAW_E2E=1` absent; `e2e-worker` because `AGENT_VM_WORKER_E2E=1` absent; `e2e-secrets` because `AGENT_VM_1PASSWORD_E2E=1` absent.
- `pnpm test:taxonomy`
  - Exit: 0
  - Result: Test taxonomy audit passed.
- `pnpm check`
  - Exit: 0
  - Result: 6 passed, 0 failed.
  - Sub-gates: package version sync, zod guard, taxonomy, format, type-aware lint, typecheck.
- `pnpm test:unit`
  - Exit: 0
  - Result: 197 files passed, 1804 tests passed.
- `pnpm test:integration`
  - Exit: 0
  - Result: 23 files passed, 327 tests passed.
- `git diff --check`
  - Exit: 0
- `gh workflow view publish.yml --ref improve/plan-10-ci-publish-gate-parity --yaml`
  - Exit: 0
  - Result: GitHub resolved the branch workflow YAML and showed the new publish-job parity steps before the existing managed-image release-evidence steps.

## Notes

- `actionlint` was not installed locally, so workflow proof used the plan-allowed `gh workflow view` path after pushing the branch.
- The publish workflow can only be fully proven by the next release or manual workflow run; this slice proves the pushed YAML resolves and preserves release step ordering.
- `pnpm check` emitted existing warning-only type-aware lint output in scripts, but the gate summary was 6 passed and 0 failed. No lint-backlog cleanup was in Plan 10 scope.
