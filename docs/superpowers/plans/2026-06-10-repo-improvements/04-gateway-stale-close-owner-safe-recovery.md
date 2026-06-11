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
    gateway's host PID is alive using the ALREADY-INJECTED `isProcessAlive`
    closure (the runtime imports it from `managed-vm-process.ts` at line
    ~23 and injects it at ~218; the handle exposes
    `staleGateway.vm.getHostPid(): number | null` — confirmed on
    `Pick<ManagedVm, ...>` in `zone-runtime-types.ts:32`). NOTE (review
    2026-06-11): this is a bare PID-existence check, NOT identity-verified —
    the in-memory handle carries no recorded `ProcessIdentity`; identity
    verification would require reading the on-disk gateway runtime record
    and is explicitly out of scope. Bare `isProcessAlive` is sufficient
    here: a `null`/missing PID or dead PID means there is no process to be
    unsafe about. If provably dead: emit a warning, record the lifecycle
    operation as a degraded-close (not `operation-failed` with
    `owner-unsafe`), leave `staleGatewayPendingClose` cleared, and proceed
    with the cold start. If alive or indeterminate: keep current
    `owner-unsafe` behavior byte-for-byte.
  - Entry-path note: when `staleGatewayPendingClose` was set via
    `markGatewayHostPidMissing` (`:368-388`), the PID was already proven
    dead/missing, so the re-check passes trivially. When set via the new
    `stopNow` catch path (below), the process may be alive — the re-check
    is the primary gate there. Do not skip it.
  - Interaction note: when the dead-PID path skips the close and proceeds,
    `cleanupOrphanedGatewayIfPresent` inside `startGatewayZone` will read
    the on-disk runtime record, confirm the PID dead via its own check, and
    delete the record — no double-signal risk (verified). Do not make
    `closeStaleGatewayBeforeColdStart` touch the on-disk record itself.
  - In `stopNow`'s catch: set `gateway = undefined` and, when an active
    gateway handle existed, set `staleGatewayPendingClose = activeGateway`
    (mirroring `markGatewayHostPidMissing`) so the next cold start retries
    the close through the standard path.
- Unit tests in the adjacent zone-runtime test files.

Read-only context:
- `packages/agent-vm/src/shared/managed-vm-process.ts` — `isProcessAlive`
  (line 6) is the helper; PID access confirmed via
  `staleGateway.vm.getHostPid()` (`zone-runtime-types.ts:32`,
  `vm-adapter.ts:134`). No new dependency direction: the zone runtime
  already imports from this module.
- `packages/agent-vm/src/controller/health/gateway-vm-recovery-runner.ts`
  and `gateway-vm-recovery-policy.ts` — confirm the recovery loop's
  interpretation of the lifecycle codes you emit.
- `docs/superpowers/plans/2026-06-07-openclaw-controller-resilience-state-machines.md`
  — prior design rationale for the owner-unsafe classification; the change
  must stay consistent with that model (dead-PID is new *proof*, not a new
  policy).

## Task Sequence

1. Add a small local helper `isStaleGatewayProcessAlive(staleGateway)` that
   reads `staleGateway.vm.getHostPid()` and returns the injected
   `isProcessAlive(pid)` result (`false` for `null`/missing PID). Bare PID
   check by design — see Scope note.
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
  `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/zone-runtimes packages/agent-vm/src/controller/health`
- Full validation: `pnpm check && pnpm test:unit && pnpm test:integration`

## Stop Conditions

- (Pre-verified 2026-06-11: `getHostPid` is available on the handle —
  `zone-runtime-types.ts:32` picks it from `ManagedVm`; the PID-availability
  stop condition does not fire. Existing test
  `openclaw-zone-runtime.unit.test.ts:1186` pins `owner-unsafe` only for
  the alive-PID `stop()` path with `isProcessAlive: () => true` — it stays
  valid; no existing test pins owner-unsafe for the cold-start dead-PID
  path, so the new tests fill a gap rather than rewriting assertions.)
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
