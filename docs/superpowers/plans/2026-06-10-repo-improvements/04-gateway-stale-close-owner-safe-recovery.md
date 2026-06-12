# Gateway Stale-Close: Dead-PID Close Failures Must Stay Auto-Recoverable

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 4 (stability — single crash can permanently strand an OpenClaw zone)

## Problem

When the gateway QEMU process dies, `markGatewayHostPidMissing` stores the
dead Gondolin handle in `staleGatewayPendingClose` and marks the zone
cold-start-eligible. Auto-recovery then cold-starts, which first runs
`closeStaleGatewayBeforeColdStart`. If `closeGatewayWithDeadline` on that
*already-dead* handle throws (60s deadline; plausible when a stuck FUSE/VFS
teardown hangs `vm.close()` after QEMU exit), the catch block sets
`lifecycleState = failed` with `code: 'owner-unsafe'` and
`coldStartEligible: false`. `classifyFailedGatewayRecoveryAction` routes
`owner-unsafe` to `operator-required`, so auto-recovery is permanently
blocked. Manual `restart()` hits the same close on the same handle. The only
exit is operator `destroy` + `start`.

`owner-unsafe` is the right answer when the VM process might still be alive
(closing ownership is genuinely unproven). It is the wrong answer when the
recorded PID is already proven dead — there is no process left to be unsafe
about.

A sibling gap: `stopNow`'s failure path leaves the in-memory `gateway`
variable pointing at the old handle and never sets
`staleGatewayPendingClose`, so in-memory tracking diverges from the on-disk
orphan-cleanup path.

## Current Evidence

- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts:362-388`
  — `markGatewayHostPidMissing` sets `staleGatewayPendingClose` and
  `coldStartEligible: true` with code `vm-process-missing`.
- `openclaw-zone-runtime.ts:390-433` — `closeStaleGatewayBeforeColdStart`
  catch: restores `staleGatewayPendingClose`, sets
  `{ coldStartEligible: false, error: { code: 'owner-unsafe' }, kind:
  'failed' }`, throws. No PID-liveness check before classifying.
- `packages/agent-vm/src/controller/health/gateway-recovery-actions.ts:75-86`
  — `owner-unsafe` → `{ kind: 'operator-required' }` (auto-recovery blocked).
- `openclaw-zone-runtime.ts:619-688` — `stopNow` catch sets
  `failed(owner-unsafe)` and throws without `gateway = undefined` or setting
  `staleGatewayPendingClose` (the success-path reset at ~654-667 is not
  reached).
- `packages/agent-vm/src/shared/managed-vm-process.ts` — existing
  PID-identity verification used by orphan cleanup (kill-by-identity with
  lstart+command match).

## Non-Goals

- Do not weaken `owner-unsafe` for the live-process case: if the process is
  (or might be) alive and close failed, `operator-required` remains correct.
- Do not change `closeGatewayWithDeadline`'s deadline semantics.
- Do not redesign the recovery policy/state machine.

## Scope

Write surfaces:
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`:
  - In `closeStaleGatewayBeforeColdStart`'s catch: check whether the stale
    gateway's recorded host PID is alive (reusing the identity-verified
    liveness helper). If provably dead: emit a warning, record the
    lifecycle operation as a degraded-close (not `operation-failed` with
    `owner-unsafe`), leave `staleGatewayPendingClose` cleared, and proceed
    with the cold start. If alive or indeterminate: keep current
    `owner-unsafe` behavior.
  - In `stopNow`'s catch: set `gateway = undefined` and, when an active
    gateway handle existed, set `staleGatewayPendingClose = activeGateway`
    (mirroring `markGatewayHostPidMissing`) so the next cold start retries
    the close through the standard path.
- Unit tests in the adjacent zone-runtime test files.

Read-only context:
- `packages/agent-vm/src/shared/managed-vm-process.ts` — liveness/identity
  helper to reuse; confirm how the zone runtime can access the gateway's
  host PID (`getHostPid` already exists per `getLifecycleState` usage).
- `packages/agent-vm/src/controller/health/gateway-vm-recovery-runner.ts`
  and `gateway-vm-recovery-policy.ts` — confirm the recovery loop's
  interpretation of the lifecycle codes you emit.
- `docs/superpowers/plans/2026-06-07-openclaw-controller-resilience-state-machines.md`
  — prior design rationale for the owner-unsafe classification; the change
  must stay consistent with that model (dead-PID is new *proof*, not a new
  policy).

## Task Sequence

1. Extract/confirm a `isGatewayHostProcessAlive(staleGateway)` helper that
   uses identity-verified liveness (not bare PID existence).
2. Implement the dead-PID branch in `closeStaleGatewayBeforeColdStart` as
   scoped above; keep the alive/indeterminate branch byte-for-byte
   behaviorally identical.
3. Fix `stopNow`'s catch to clear `gateway` and set
   `staleGatewayPendingClose`.
4. Unit tests: (a) close hangs/throws + PID dead → cold start proceeds and
   zone reaches `running` with a mock start; (b) close throws + PID alive →
   `owner-unsafe`, `operator-required` preserved; (c) `stopNow` failure →
   `gateway` cleared, `staleGatewayPendingClose` set, next cold start
   attempts the close exactly once.
5. Run the OpenClaw zone-runtime unit suite and the recovery-policy suites.

## Proof Gates

- Red/green proof: test (a) fails on current code (permanent owner-unsafe),
  passes after.
- Focused validation:
  `pnpm vitest run --root . --config vitest.config.ts --project unit packages/agent-vm/src/controller/zone-runtimes packages/agent-vm/src/controller/health`
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`

## Stop Conditions

- Stop if the stale gateway handle does not expose a host PID at the point
  of `closeStaleGatewayBeforeColdStart` (would require threading identity
  through the handle — scope change worth a quick reconverge).
- Stop if recovery-policy tests encode `owner-unsafe` for the dead-PID case
  as intended behavior with documented rationale — that means the prior
  design made this tradeoff deliberately; bring evidence back before
  changing it.

## Risks

- Skipping a close on a "dead" process whose VFS/FUSE mounts are still
  registered can leak mounts. Mitigation: log the skipped close with the
  handle identity so leaked-mount debugging has a trail; mount cleanup
  remains the OS/Gondolin layer's concern (same posture as today's
  `destroy` escape hatch, which also skips the close).

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/04-gateway-stale-close-owner-safe-recovery.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
