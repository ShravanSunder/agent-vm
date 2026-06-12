# Tool VM TCP Slot Quarantine Recovery

Planned at: 4f419b0
Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Status: proposed
Priority: 1 (stability — steady-state resource leak)

## Problem

When `vm.close()` fails during lease release or eviction, the lease manager
quarantines the lease's TCP slot so a fresh `createLease` cannot race onto a
port the dead/hung QEMU may still hold. That is correct. But nothing in the
running controller ever promotes a quarantined slot back to free:
`TcpPool.releaseQuarantined()` has zero production call sites. Each failed
close permanently drains one slot for the lifetime of the controller process.
With a finite pool (`tcpPool.size` from `system.json`), a handful of failed
closes in a long-running controller exhausts the pool and every new lease
request fails with `No TCP slots available` until restart.

The design intent for a background poller exists in the interface comment and
in `docs/superpowers/plans/2026-05-23-tool-vm-agent-lease-identity.md`, but it
was never implemented.

## Current Evidence

- `packages/agent-vm/src/controller/leases/tcp-pool.ts:13-16` — interface
  comment: "Promote a quarantined slot back to free after external proof of
  liveness (e.g., a background poller observed the recorded PID is gone)."
- `grep -rn "releaseQuarantined" packages --include="*.ts"` → only the
  interface declaration and implementation in `tcp-pool.ts`. No callers.
- `packages/agent-vm/src/controller/leases/lease-manager.ts:753-762` —
  `releaseLease` quarantines the slot and preserves the runtime record when
  close fails.
- `packages/agent-vm/src/controller/leases/lease-manager.ts:412-440` —
  `evictLease` does the same on close failure (line 438).
- `packages/agent-vm/src/controller/leases/tool-vm-recovery.ts` — Phase A
  startup recovery already has the PID-liveness + process-identity machinery
  (`killOrphanedToolVmProcess`, runtime record scope fencing) that a
  quarantine reaper needs.
- Runtime records for quarantined slots are intentionally preserved on disk
  (`lease-manager.ts:756-757` comment), so the QEMU PID for each quarantined
  slot is recoverable in-process.

## Non-Goals

- Do not change quarantine-on-failure semantics; quarantining is correct.
- Do not make `vm.close()` retried or idempotent at the Gondolin layer.
- Do not touch Phase A startup recovery semantics (scope fencing stays as-is).

## Scope

Write surfaces:
- `packages/agent-vm/src/controller/leases/lease-manager.ts`: track
  quarantined slot → runtime record id (zoneId, recordId, slot) at quarantine
  time; expose a `reapQuarantinedTcpSlots()` method (or extend
  `reapDeadIdleLeases`).
- `packages/agent-vm/src/controller/leases/idle-reaper.ts` (or a sibling
  `quarantine-reaper.ts`): periodic invocation alongside the existing reaper
  cadence.
- `packages/agent-vm/src/controller/controller-runtime.ts`: wire the reaper
  tick (same timer as `reapDeadIdleLeases` / `reapExpiredActiveUses` if
  cadence fits).
- Unit tests adjacent to each file.

Read-only context:
- `packages/agent-vm/src/controller/leases/tool-vm-recovery.ts`: reuse
  `isProcessAlive`-style PID identity verification (PID + lstart/command
  identity, not bare PID) so PID reuse cannot release a slot still held by an
  unrelated process.
- `packages/agent-vm/src/controller/leases/tool-vm-runtime-record.ts`: record
  shape, where the QEMU PID and process identity live.
- `packages/agent-vm/src/shared/managed-vm-process.ts`: existing process
  identity comparison helpers.

## Task Sequence

1. At quarantine time (both `releaseLease` failure path and `evictLease`
   failure path), record `{ tcpSlot, zoneId, runtimeRecordId }` in an
   in-memory `quarantinedSlotRecords` map inside the lease manager.
2. Implement `reapQuarantinedTcpSlots()`: for each entry, load the runtime
   record, verify the recorded QEMU process is dead using the existing
   process-identity comparison (alive-with-same-identity → skip; dead or
   identity-mismatch → proceed). On confirmed-dead: delete the runtime record
   (tolerate failure with a warning, matching existing patterns), call
   `tcpPool.releaseQuarantined(slot)`, remove the map entry, and emit a
   warning-level log noting the recovery.
3. Wire the reap into the existing reaper timer in `controller-runtime.ts`
   (the same cadence as `reapDeadIdleLeases` is acceptable; quarantine
   recovery is not latency-sensitive).
4. Unit tests: (a) quarantine → PID dead → slot becomes allocatable again;
   (b) quarantine → PID alive with matching identity → slot stays
   quarantined; (c) PID reused by a different process identity → treated as
   dead, slot recovered; (d) runtime record delete failure → slot still
   recovered (port safety is proven by PID death, not record deletion),
   warning emitted.
5. Extend the existing pool-exhaustion unit test to show the pool self-heals
   after recovery.

## Proof Gates

- Red/green proof: new unit tests in
  `packages/agent-vm/src/controller/leases/` fail before the reaper exists,
  pass after.
- Focused validation:
  `pnpm vitest run --root . --config vitest.config.ts --project unit packages/agent-vm/src/controller/leases`
- Full validation: `pnpm check && pnpm test:unit`
- Integration check: `pnpm test:integration` (idle-reaper integration suite
  must stay green).

## Stop Conditions

- Stop if runtime records do not actually contain enough process identity to
  prove PID death safely (re-read `tool-vm-runtime-record.ts`; if identity is
  missing, the plan needs a record-schema addition and that is a scope
  change).
- Stop if wiring the reaper requires changing the public `LeaseManager`
  interface consumed by other packages in a breaking way.

## Risks

- PID-reuse false positives: mitigated by reusing the existing
  identity-comparison helpers from `managed-vm-process.ts` instead of bare
  `process.kill(pid, 0)` checks.
- Double-recovery race with Phase A startup cleanup: not possible in-process
  (Phase A runs at startup before the reaper starts); record-delete tolerance
  covers the cross-restart case.

## Handoff Prompt

```text
Use implementation-execute-plan on this plan.

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.improve-v1
Plan: docs/superpowers/plans/2026-06-10-repo-improvements/01-tool-vm-tcp-slot-quarantine-recovery.md
Start by validating the plan against current git state before editing files.
Use bounded subagents only for independent slices. Parent owns integration and
final proof.
```
