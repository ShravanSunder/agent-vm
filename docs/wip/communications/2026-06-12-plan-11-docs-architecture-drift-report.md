# Plan 11 Docs Architecture Drift Report

Status: steps 1-4 implemented and verified on branch
`improve/plan-11-docs-architecture-drift`; heartbeat decision gate remains open.

## Scope Completed

- Updated `docs/architecture/agent-worker-gateway.md` so task statuses and the
  event table match `taskStatusValues` and `taskEventSchema`.
- Added `packages/agent-vm-worker/src/state/event-doc-drift.unit.test.ts` to
  cross-check the documented worker task event table against the Zod event
  union.
- Updated `CLAUDE.md` with all 11 packages and clarified that `pnpm check` is a
  static quality gate, not a substitute for unit/integration tests.
- Updated `docs/architecture/overview.md` with the 11-package model, a pointer
  to `docs/subsystems/controller.md` as the authoritative route table, and the
  missing controller startup/key-subsystem notes.
- Added `docs/subsystems/mcp-portal.md` to `docs/README.md`.

## Reading Coverage

- Plan 11:
  `docs/superpowers/plans/2026-06-10-repo-improvements/11-docs-architecture-drift.md`
  read end to end, 161 lines.
- Plan 09 was already read end to end, 151 lines, and this branch is stacked on
  Plan 09 because Plan 11 coordinates with Plan 09's events route docs.
- Source-of-truth files checked:
  - `packages/agent-vm-worker/src/state/task-event-types.ts`
  - `packages/agent-vm-worker/src/state/task-state.ts`
  - `packages/agent-vm/src/controller/controller-runtime.ts`
  - `docs/subsystems/controller.md`
  - package `package.json` dependency edges under `packages/*`
  - `packages/agent-vm/src/controller/heartbeat-sender.ts`

## Red/Green Proof

Initial red command:

```sh
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/state/event-doc-drift.unit.test.ts
```

Result: exit 1, 1 test failed. The stale doc table listed old event names
(`plan-created`, `work-started`, `review-result`, `verification-result`,
`fix-applied`) and missed the current controller git events.

Focused green command after docs update:

```sh
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/state
```

Result: exit 0, 3 test files passed, 18 tests passed.

## Final Verification

```sh
pnpm check
```

Result: exit 0, 6 gates passed, 0 failed.

```sh
pnpm test:unit
```

Result: exit 0, taxonomy passed, 200 test files passed, 1809 tests passed.

```sh
pnpm lint
```

Result: exit 0, 0 warnings, 0 errors.

```sh
mise run lint
```

Result: exit 0 after trusting this worktree's `mise.toml`; delegated to
`pnpm lint`, 0 warnings, 0 errors.

```sh
git diff --check
```

Result: exit 0.

## Decision Gate

The plan's step 5 remains blocked on the explicit heartbeat direction:

- Document the existing `CALLER_URL` heartbeat contract, or
- delete/split the feature in a separate code change.

Verified current behavior in `heartbeat-sender.ts`: when `CALLER_URL` is set,
the controller starts a caller heartbeat sender that posts to
`${CALLER_URL}/tasks/{requestTaskId}/heartbeat` with a 10s default cadence, 5s
per-request timeout, and permanent stop on 404 or 410. Other failures retry with
warnings on the first, third consecutive, then every tenth consecutive failure.

## Not Run

- `pnpm test:integration` was not required for the completed independent docs
  slice. The plan required `pnpm check` and `pnpm test:unit` when the guard test
  was added.

## Branch State

- Branch: `improve/plan-11-docs-architecture-drift`
- Stack base: `origin/improve/plan-09-task-event-stream-and-embedding` at
  `3953657`
- Current status: ready for heartbeat decision before Plan 11 can be called
  complete.
