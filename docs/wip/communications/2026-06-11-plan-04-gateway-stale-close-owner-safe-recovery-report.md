# 2026-06-11 Plan 04 - Gateway Stale-Close Owner-Safe Recovery

## Scope

- Repo: `/Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-plan-04-gateway-stale-close-owner-safe-recovery`
- Branch: `improve/plan-04-gateway-stale-close-owner-safe-recovery`
- Base: `improve-v1` (`32c0e1c5` at slice start)
- Source plan: `docs/superpowers/plans/2026-06-10-repo-improvements/04-gateway-stale-close-owner-safe-recovery.md`
- Plan coverage: full file loaded, 166 lines.

This worktree was initially created from `master` by mistake, then reset to the requested base before edits with:

```sh
git switch -C improve/plan-04-gateway-stale-close-owner-safe-recovery improve-v1
```

## Changed Files

- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.unit.test.ts`
- `packages/agent-vm/src/controller/zone-runtimes/gateway-lifecycle-operation-record.unit.test.ts`
- `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.unit.test.ts`

## Implementation

- Added stale-gateway process liveness classification before converting a failed stale close into degraded recovery.
- If stale close fails and the stale gateway host PID is missing or proven dead, the runtime logs the stale VM identity, records `vm-close-finished` with a diagnostic `errorMessage`, omits `errorCode: "owner-unsafe"`, clears the stale pending handle, and continues cold start.
- If the stale PID is alive or the PID probe itself fails, the runtime preserves the owner-unsafe path and refuses replacement start.
- A failed `stop()` now clears the active gateway handle, stores the failed close handle in `staleGatewayPendingClose`, and leaves the runtime owner-unsafe.
- Repeated `stop()`, `destroy()`, and direct `start()` all route through the stale pending close path instead of bypassing owner safety.

## Review

Ran implementation review swarm for Plan04. Accepted and fixed these findings:

- Degraded-close warning needed stale handle identity.
- Indeterminate PID probe failures needed explicit owner-unsafe coverage.
- Repeated stop/destroy/direct start could bypass stale pending close safety.
- Dead-PID degraded close records should not carry `errorCode: "owner-unsafe"`.
- Operation record parser should round-trip degraded `vm-close-finished` diagnostic text.

## Evidence

Red proof before implementation:

```sh
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.unit.test.ts
```

- Exit: 1
- Expected failures: 3 stale-close tests failed before runtime support existed.

Focused green proof after implementation and review fixes:

```sh
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.unit.test.ts packages/agent-vm/src/controller/zone-runtimes/gateway-lifecycle-operation-record.unit.test.ts
```

- Exit: 0
- Result: 2 files, 38 tests passed.

```sh
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/zone-runtimes/zone-runtime-registry.unit.test.ts
```

- Exit: 0
- Result: 1 file, 19 tests passed.

```sh
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/zone-runtimes packages/agent-vm/src/controller/health
```

- Exit: 0
- Result: 12 files, 147 tests passed.

Final proof gates:

```sh
pnpm fmt
```

- Exit: 0
- Result: formatted 621 files.

```sh
git diff --check
```

- Exit: 0

```sh
pnpm fmt:check
```

- Exit: 0
- Result: all matched files use the correct format.

```sh
mise trust mise.toml && mise run lint
```

- Exit: 0
- Result: 0 warnings, 0 errors.

```sh
pnpm check
```

- Exit: 0
- Result: 6 passed, 0 failed.

```sh
pnpm test:unit
```

- Exit: 0
- Result: taxonomy passed; 197 files, 1810 tests passed.

```sh
pnpm test:integration
```

- Exit: 0
- Result: 23 files, 327 tests passed.

Base checkout hook repair:

```sh
mise trust mise.toml && mise run lint
```

- Workdir: `/Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1`
- Exit: 0
- Result: 0 warnings, 0 errors.

## Not Run

- Live e2e lanes were not run for this slice. The source plan targets process-local stale-close state-machine behavior and named unit/focused/full static gates; no live VM or OpenClaw e2e lane was required by the plan.

## Branch State

- Local changes are verified.
- Push state: pending.
