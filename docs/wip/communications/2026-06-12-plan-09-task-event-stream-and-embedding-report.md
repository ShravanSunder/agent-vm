# Plan 09 Task Event Stream And Embedding Report

Status: implemented and locally verified on branch
`improve/plan-09-task-event-stream-and-embedding`.

## Scope

- Added `GET /zones/:zoneId/tasks/:taskId/events` as a server-sent events route
  for worker task JSONL events.
- Added replay/tail/cursor logic in `task-event-stream.ts`, including corrupt
  final-line tolerance, terminal-event close, failure-sentinel fallback, and an
  abortable bounded polling loop.
- Exported `startControllerRuntime` plus `ControllerRuntime`,
  `ControllerRuntimeDependencies`, and `StartControllerRuntimeOptions` from the
  package entrypoint.
- Updated `docs/subsystems/controller.md` and `CLAUDE.md` route documentation.

## Reading Coverage

- Plan 09: `docs/superpowers/plans/2026-06-10-repo-improvements/09-task-event-stream-and-embedding.md`
  read end to end, 151 lines.
- Handoff packet:
  `tmp/plan-workflows/2026-06-11-agent-vm-improve-v1-repo-improvements-handoff/plan-handoff.md`
  read end to end, 160 lines.
- Batch checkpoint:
  `docs/wip/communications/2026-06-11-repo-improvement-batch-checkpoint.md`
  read end to end, 133 lines.
- Plan 11 ordering context:
  `docs/superpowers/plans/2026-06-10-repo-improvements/11-docs-architecture-drift.md`
  read end to end, 161 lines.

## Implementation Notes

- The SSE route intentionally mirrors the existing task snapshot route: no
  per-request auth and no initial readiness gate. The route comment records this
  choice. Because the stream is long-lived, heartbeat ticks check
  `runtimeReadiness` and abort the stream when the runtime state is `stopping`.
- The stream cap is per task and currently set to 4 concurrent streams.
- The tailer uses a bounded polling loop with injectable sleep instead of
  depending on `fs.watch`. This keeps the behavior deterministic across the
  host state directory filesystems and test environments while still satisfying
  the replay/tail/terminal semantics from the plan.
- `task-state-reader.ts` gained exported path/sentinel helpers so the stream
  code reuses the existing task state path vocabulary instead of duplicating it.

## Red/Green Proof

Initial red command before production code:

```sh
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/task-event-stream.unit.test.ts packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/index.unit.test.ts
```

Result: exit 1. The new module import was missing, `startControllerRuntime` was
not exported from the package entrypoint, and the events route returned 404.

Focused green after implementation:

```sh
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/task-event-stream.unit.test.ts packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts packages/agent-vm/src/index.unit.test.ts
```

Result: exit 0, 3 test files passed, 93 tests passed.

Focused controller proof:

```sh
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller
```

Result: exit 0, 39 test files passed, 471 tests passed.

## Final Verification

Fresh final commands after the last production-code cleanup:

```sh
pnpm check
```

Result: exit 0, 6 gates passed, 0 failed.

```sh
pnpm test:unit
```

Result: exit 0, taxonomy passed, 199 test files passed, 1808 tests passed.

```sh
pnpm test:integration
```

Result: exit 0, 23 test files passed, 327 tests passed.

```sh
pnpm lint
```

Result: exit 0, 0 warnings, 0 errors.

```sh
mise run lint
```

Result: exit 0, delegated to `pnpm lint`, 0 warnings, 0 errors. The Plan09
worktree `mise.toml` was trusted before this command; the base repo trust issue
from the stop hook is also clear.

```sh
git diff --check
```

Result: exit 0.

## Not Run

- E2E lanes were not run for Plan09. The plan required unit-focused controller
  proof plus full `pnpm check`, `pnpm test:unit`, and `pnpm test:integration`;
  no VM/OpenClaw/worker live e2e lane was named for this slice.

## Branch State

- Branch: `improve/plan-09-task-event-stream-and-embedding`
- Base: `origin/improve-v1` at `f3ea186`
- Dependency note: live `merge-base --is-ancestor` showed Plan03 is not an
  ancestor of Plan06, so this slice followed the batch pattern of isolated
  plan branches from current `origin/improve-v1` rather than merging previous
  plan branches into Plan09.
