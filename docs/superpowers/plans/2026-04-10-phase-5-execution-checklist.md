# Phase 5 Execution Checklist

Status audit for `docs/superpowers/plans/2026-04-10-phase-5-review-fixes-tests-e2e.md`.
This checklist reflects the current reorganized file layout from Phase 5a.

## Task Checklist

### Subsystem A: Bug Fixes

- [x] Task 1: H5 gateway readiness throws on exhaustion
- [x] Task 2: H4 snapshot encryption is ESM-safe
- [x] Task 3: H1 runtime ID equals lease ID
- [x] Task 4: H2 stale scope cache invalidates on dead lease
- [x] Task 5: H3 workspace cleanup runs between sessions
- [x] Task 6: M1 dead `profileId` removed from plugin config
- [x] Task 7: M2 FS bridge forwards `signal` and `allowFailure`
- [x] Task 8: M3 gateway token persists to `/root/.openclaw-env`

### Subsystem B: Quality Gates and Structural Improvements

- [x] Task 9: Formatter run and passing
- [x] Task 10: Type-aware lint run with `0` errors
- [x] Task 11: Typecheck run and passing
- [x] Task 12: `controller-runtime` split and slimmed
- [x] Task 13: Expanded `tcp-pool` tests
- [x] Task 14: Expanded `idle-reaper` tests
- [x] Task 15: Added controller-runtime boot failure test
- [x] Task 16: Full quality gate run completed

### Subsystem C: E2E Verification Checklist

- [x] Task 17: Reproducible E2E checklist written

### Subsystem D: Validation and Integration Tests

- [x] Task 18: Separate unit and integration Vitest configs and commands
- [x] Task 19: Zod request validation added to controller HTTP routes
- [x] Task 20: Live model roundtrip integration test added and passing
- [x] Task 21: Live controller stop/restart persistence test added and passing

## File Audit

### Gateway

- [x] `packages/agent-vm/src/gateway/gateway-openclaw-lifecycle.ts`
      H5 fix: readiness failure now throws after max attempts
- [x] `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
      Coverage for readiness exhaustion and token persistence
- [x] `packages/agent-vm/src/gateway/gateway-vm-setup.ts`
      M3 fix: writes resolved token to `/root/.openclaw-env` with `chmod 600`

### Snapshots

- [x] `packages/agent-vm/src/snapshots/snapshot-encryption.ts`
      H4 fix: encrypt path no longer uses `require()`
- [x] `packages/agent-vm/src/snapshots/snapshot-encryption.test.ts`
      ESM-safe encryption coverage added
- [x] `packages/agent-vm/src/snapshots/snapshot-manager.ts`
      Split into smaller snapshot operations during Phase 5a

### Controller Runtime and Leases

- [x] `packages/agent-vm/src/controller/controller-runtime.ts`
      Slim orchestration file; active leases released on `runtime.close()`
- [x] `packages/agent-vm/src/controller/lease-manager.ts`
      H3 cleanup hook and failure cleanup for VM/SSH provisioning
- [x] `packages/agent-vm/src/controller/lease-manager.test.ts`
      Workspace cleanup and failure cleanup coverage
- [x] `packages/agent-vm/src/controller/controller-runtime.test.ts`
      Boot failure and runtime-close lease release coverage
- [x] `packages/agent-vm/src/controller/tcp-pool.test.ts`
      Exhaustion and mapping coverage added
- [x] `packages/agent-vm/src/controller/idle-reaper.test.ts`
      Multiple-expired and all-active coverage added

### Controller HTTP Validation

- [x] `packages/agent-vm/src/controller/controller-request-schemas.ts`
      Zod request schemas added
- [x] `packages/agent-vm/src/controller/controller-http-routes.ts`
      Lease request now validated with Zod
- [x] `packages/agent-vm/src/controller/controller-zone-operation-routes.ts`
      Destroy and execute-command requests now validated with Zod
- [x] `packages/agent-vm/src/controller/controller-http-routes.test.ts`
      Invalid request responses assert schema error details

### Plugin Backend

- [x] `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.ts`
      M1 fix: `profileId` removed
- [x] `packages/openclaw-agent-vm-plugin/src/gondolin-plugin-config.test.ts`
      Updated to reflect removed `profileId`
- [x] `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`
      H1/H2/M2 fixes for lease ID runtime identity, stale cache invalidation, and FS bridge forwarding
- [x] `packages/openclaw-agent-vm-plugin/src/openclaw-backend-dependencies.ts`
      Forwards `signal` and `allowFailure` through SSH backend helper
- [x] `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts`
      Updated coverage for lease IDs, stale cache invalidation, and forwarding
- [x] `packages/openclaw-agent-vm-plugin/src/controller-integration.test.ts`
      Updated to current lease-backed runtime identity behavior

### CLI and Test Commands

- [x] `package.json`
      `test:integration` added
- [x] `vitest.config.ts`
      Unit suite excludes `*.integration.test.ts`
- [x] `vitest.integration.config.ts`
      Integration suite includes `*.integration.test.ts` and loads `.env.local`

### Integration Tests

- [x] `packages/agent-vm/src/integration-tests/live-sandbox-e2e.integration.test.ts`
      Still passing
- [x] `packages/agent-vm/src/integration-tests/live-cross-vm-ssh.integration.test.ts`
      Still passing
- [x] `packages/agent-vm/src/integration-tests/live-controller-restart-persistence.integration.test.ts`
      Added and passing
- [x] `packages/agent-vm/src/integration-tests/live-agent-model-roundtrip.integration.test.ts`
      Added and passing with live environment

### Docs

- [x] `docs/E2E-VERIFICATION-CHECKLIST.md`
      Manual end-to-end checklist created and updated to current integration counts

## Verification Snapshot

- [x] `pnpm build`
- [x] `pnpm typecheck`
- [x] `pnpm oxlint .`
- [x] `pnpm lint:types` exits `0` with warnings only
- [x] `pnpm fmt:check`
- [x] `pnpm test`
- [x] `pnpm test:integration`
