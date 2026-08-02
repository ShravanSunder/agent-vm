# Managed Gateway Control-Session Resilience Implementation Plan v2

Date: 2026-08-02

This plan supersedes `implementation-plan.md` and its lane/review artifacts. Those files describe the discarded replacement/coordinator architecture and MUST NOT be executed.

## Goal and boundary

Implement the reviewed specification and program design with the smallest current-code cutover:

```text
existing GatewayDisposableControlSessionClient
  -> bounded first acceptance remains
  -> post-acceptance retry never becomes terminal
  -> one idempotent ensureDialing entry point
  -> current-source health watchdog invokes that entry point
  -> existing health pipeline reports bounded reconnect evidence
```

No Gateway replacement redesign, new protocol direction, secret resolution, 1Password, power management, Tool Portal admission diagnosis, automatic Tool VM probe, aggregate readiness state, or framework-specific retry policy is in scope.

## Requirements/proof matrix

| Requirement | Owning task | Proof gate | Layer | Evidence source | Freshness guard | Red/green |
| --- | --- | --- | --- | --- | --- | --- |
| R1, R2, R5: finite interruption and sleep cannot terminate a previously accepted manager | T1 | targeted client unit test crosses 16 attempts and 60 seconds, then accepts a fresh attachment from the same client | Unit | parent-run Vitest output | current worktree diff | Required |
| R4, R5: one current attempt/session with fresh attachment-local sequence state | T1 | duplicate `ensureDialing`, delayed callback, accepted/watchdog, and disposal unit cases | Unit | parent-run Vitest output | current worktree diff | Required |
| R6: reconnect never replays ambiguous work | T1 | existing pending-command disconnect tests plus scoped regression | Unit/integration | parent-run Vitest output | current worktree diff | Required where behavior changes |
| R3: narrow recovery preserves Gateway/framework and avoids resolver/restart | T2 | controller/zone integration proves watchdog reaches the existing current manager without lifecycle operation | Integration | parent-run Vitest output | current worktree diff | Required |
| R7, R8: truthful current state, bounded durable evidence, production watchdog wiring | T2, T3 | health contract/store/telemetry tests and real controller composition test | Unit/integration | parent-run Vitest output and durable-log assertions | current worktree diff | Required |
| R9, V4: OpenClaw parity through real controller/Gateway/Tool VM/SSH path | T4 | `mise exec -- pnpm test:e2e:openclaw` with extended control-session recovery journey | E2E | parent-run no-skip evidence lane | exact build and current worktree | Required |
| R9, V5: Hermes parity through shared path | T4 | `mise exec -- pnpm test:e2e:hermes` with a managed Tool VM-backed recovery journey | E2E | parent-run no-skip evidence lane | exact build and current worktree | Required |
| V7: no regression | T5 | `pnpm test:unit`, `pnpm test:integration`, `pnpm check` | Unit/integration/quality | parent-run commands | after final diff | Not new behavior |

If the existing Hermes harness cannot perform the required real Tool VM-backed operation without introducing a new product boundary, stop and split the live-proof harness work; do not weaken or relabel V5.

## Vertical slices

### T1 — Durable post-acceptance connection manager

Source: R1, R2, R4-R6; V1, V2, V6.

Write scope:

- `packages/agent-vm/src/controller/control-session/gateway-disposable-control-session-client.ts`
- `packages/agent-vm/src/controller/control-session/gateway-disposable-control-session-client.unit.test.ts`

Steps:

1. RED: replace the current post-acceptance exhaustion expectations with tests proving attempts remain eligible after the former attempt and wall-clock limits, while initial `ready` still rejects within its existing bound.
2. RED: add idempotent `ensureDialing(reason)` behavior for accepted, active-attempt, scheduled-retry, dormant, disposed, and duplicate-trigger cases.
3. GREEN: make exhaustion checks apply only before first acceptance; remove post-acceptance stabilization deadline authority while retaining heartbeat/time confidence and capped retry delay.
4. Preserve fresh attachment generations, attachment-local sequence reset, pending-command failure, process admission, and late-callback fencing.

Checkpoint: targeted client unit suite is green with observed red/green evidence.

Split/replan trigger: the current client cannot expose idempotent maintenance without moving identity or admission ownership.

### T2 — Current-source health watchdog wiring

Source: R3, R5, R8; V3.

Write scope:

- `packages/agent-vm/src/controller/zone-runtimes/zone-runtime-types.ts`
- `packages/agent-vm/src/controller/zone-runtimes/managed-gateway-zone-runtime.ts`
- corresponding managed-runtime tests
- `packages/agent-vm/src/controller/controller-runtime.ts`
- corresponding controller-runtime tests

Steps:

1. RED: prove a stale current-source monitor observation invokes the active Gateway handle's manager and that stale/superseded source keys are rejected.
2. Add a narrow managed-runtime method that validates running lifecycle plus exact Gateway source and delegates to `controlSession.ensureDialing('stale-health')`.
3. Wire `recoverDeadControlSession` in production monitor composition to resolve the current runtime on every call.
4. Preserve the monitor as watchdog only; do not create sockets, timers, lifecycle operations, or secret resolution there.

Checkpoint: targeted managed-runtime, monitor, and controller composition tests are green.

Split/replan trigger: wiring requires retaining a manager outside its current Gateway handle or bypassing source validation.

### T3 — Bounded truthful reconnect evidence

Source: R7, R8; V3.

Write scope:

- `packages/gateway-lifecycle/src/health/agent-vm-health.ts`
- `packages/agent-vm/src/controller/health/health-event-store.ts`
- `packages/agent-vm/src/controller/health/durable-health-event-log.ts` only if existing append projection needs a typed addition
- `packages/agent-vm/src/observability/health-event-telemetry.ts`
- manager/orchestrator event callbacks and corresponding tests

Steps:

1. RED: add closed reconnect phase/outcome/window schema validation and health projection cases.
2. RED: prove repeated attempt cycles update the live bucket immediately but coalesce durable evidence by exact Gateway source/manager outage window.
3. RED: prove stale-source disposal/supersession may close durable evidence but cannot overwrite the successor live bucket.
4. GREEN: extend the existing event/store pipeline; add no new route, store, readiness state, or authority.

Checkpoint: gateway-lifecycle health, health-store, telemetry, durable-log, and snapshot tests are green.

Split/replan trigger: bounded evidence requires a second persistence/authority system rather than an additive extension of the existing health pipeline.

### T4 — Production-shaped framework proof

Source: R3, R6, R9; V4-V6.

Write scope:

- existing reliability fault contracts/harnesses
- `control-session-recovery.openclaw.e2e.test.ts`
- the narrowest existing Hermes managed E2E journey capable of a Tool VM-backed operation

Steps:

1. Extend the existing authenticated reliability actuator to isolate controller-to-Gateway attempts beyond the former budget and release on an explicit event, without wall-clock sleeps.
2. OpenClaw: preserve the same Gateway VM/framework process, perform a normal no-tool framework interaction during isolation, restore control, then perform a fresh non-mutating Tool VM operation.
3. Hermes: exercise the same shared manager and a real managed Tool VM-backed operation through the Hermes path.
4. Cross-process outcome honesty: interrupt one operation after its effect can be ambiguous but before its result is safely observed; prove reconnect reports failure or unknown and never replays it or converts it to success.
5. Record exact identity, attachment, no-restart, and zero-replay observations.

Checkpoint: both no-skip framework evidence lanes pass. Inventory-only or skipped runs do not count.

Split/replan trigger: a framework harness lacks the production boundary required by V4/V5.

### T5 — Integrated verification and review

1. Run targeted suites after every slice.
2. Run `pnpm test:unit`, `pnpm test:integration`, and `pnpm check` after the integrated diff.
3. Run the OpenClaw and Hermes evidence lanes through `mise exec --`.
4. Run `shravan-dev-workflow:implementation-review-swarm`; address or evidence-reject findings.
5. Use `shravan-dev-workflow:implementation-pr-wrapup` for a PR-ready, non-merge terminal.

## Execution DAG

```text
gate 0: validate current pair, HEAD, instructions, and existing proof seams
  |
  v
T1 durable manager + local red/green proof
  |
  +------> T2 watchdog wiring + composition proof
  |
  +------> T3 bounded evidence + projection proof
              |
              v
       integration gate: parent reviews combined authority/state paths
              |
              v
       targeted unit/integration gate
              |
              v
       T4 OpenClaw + Hermes production-shaped proof
              |
              v
       T5 broad quality, implementation review, PR readiness
```

T2 and T3 may run in parallel only after T1 fixes the manager interface and only with disjoint files. Parent integration owns all cross-slice type changes. T4 begins only after the targeted integration gate is green.

## Security and reliability constraints

- Controller remains the control initiator and sole authority owner.
- Every attempt retains current identity, admission, attachment generation, and attachment-local sequence fencing.
- Telemetry and health evidence never grant lifecycle or lease authority.
- Interrupted commands fail honestly and are never replayed by reconnect.
- Retry timers and socket attempts remain one-at-a-time and bounded; only the post-acceptance episode terminal is removed.
- No new secret, public HTTP, ingress, filesystem, subprocess, or provider boundary is introduced.

## Rollback

The change is an internal hard cutover with no data migration. Before a PR merge, rollback is the scoped Git revert. Do not preserve dual reconnect policies or add a compatibility flag.

## Open questions

None for T1-T3. T4 must stop and report if the current Hermes harness cannot cross the required real Tool VM boundary without new product design.

## Next workflow

`shravan-dev-workflow:plan-review-swarm`, then `shravan-dev-workflow:implementation-execute-plan` after accepted findings are folded in.
