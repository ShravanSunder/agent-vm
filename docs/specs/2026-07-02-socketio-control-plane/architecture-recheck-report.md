# Architecture Recheck Report - Socket.IO Control Plane Hard Cutover

Date: 2026-07-02

Purpose:
- Re-review the accepted specs and implementation plan for architecture issues
  that would block implementation success.
- Update the planning packet so an implementation agent can execute from
  vertical slice files and a relevant-file profile.

## Coverage

Read in full:
- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md` - 958 lines.
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md` - 2382 lines after schema fix.
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md` - 471 lines after updates.
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md` - 117 lines.
- Supporting plan lane artifacts, ledger, prior review reports, and new slice files.

Repo anchors rechecked:
- OpenClaw v2026.6.5-minimum runtime provenance.
- Socket.IO/OpenClaw `handleUpgrade` absence in current package code.
- e2e scripts and Vitest project suffixes.
- lease heartbeat/stale constants.
- old controller HTTP routes and raw callback vocabulary.
- Worker callback and git-tool surfaces.
- generated manual and managed image residue.

## Architecture Issues Fixed

1. Worker event-only operation schema bug.
   - Problem: `worker_runtime_observation` was event-only, but the spec's
     `WorkerControlRpcCommandResultMessageSchema` did not exclude it from
     `command_result`.
   - Fix: Updated the hard-cutover spec to exclude
     `worker_runtime_observation` with the other event-only Worker operations.
   - Proof mapping: `DOMAIN-SEP-1` now requires every event-only Worker
     operation to be rejected as `command_result`.

2. Plan text drift.
   - Updated source spec line counts to current values.
   - Corrected stale lane/ledger wording around Q1, OPEN-1, and heartbeat stale
     value.

3. Proof matrix completeness.
   - Confirmed `lanes/validation-proof.md` is now the canonical 45-row matrix.
   - Rows include owner, files/harness, command, red/green expectation,
     freshness guard, and split trigger.

4. Vertical slice execution structure.
   - Added `slices/README.md` plus one standalone file per executable gate or
     slice.
   - The root plan now points implementors to the slice files.

5. Relevant-file profile.
   - Added `relevant-file-profile.md` with current role, hazard, owner slice,
     and proof mapping for the files an implementation agent is likely to touch.

6. Historical artifact hygiene.
   - Marked old review/fit artifacts as historical where their pre-fold verdicts
     could mislead an implementor.

## Current Execution Packet

Primary files for implementors:
- `implementation-plan.md`
- `lanes/validation-proof.md`
- `slices/README.md`
- `slices/*.md`
- `relevant-file-profile.md`

Historical files:
- `plan-review-report.md`
- `plan-review-delta-report.md`
- `lanes/scope-and-proof-fit.md`
- `lanes/codebase-boundary.md`
- `lanes/security-reliability.md`
- `lane-packet-shared.md`

Use historical files only for rationale/evidence, not current execution status.

## Remaining Pre-Execution Gates

These are not hidden plan blockers; they are explicit gate decisions or stop
conditions in the current plan:

1. GATE-0a:
   - Prove exact managed OpenClaw runtime provenance; v2026.6.5 is the minimum accepted version.
   - Prove detached Socket.IO through plugin `handleUpgrade` with pre-101 auth.
   - Stop and return to spec if the runtime cannot support this.

2. OPEN-4:
   - User decision: keep OpenClaw/Worker/VM e2e commands as explicit required
     lanes or add them to CI/default proof infrastructure with approval.

3. Q1:
   - User decision: accept default delete for VM-mutation controller routes, or
     explicitly choose operator-auth-gate per route family before S4b.

4. OPEN-2:
   - Accepted disposition for this hard cutover: collector-mode raw tcpHosts
     fail closed. A future collector replacement transport or exception must
     route through a new spec update.

5. Q2:
   - Spec confirmation for Worker corroboration probe source. Blocks only the
     Worker branch of S6b.

## Architecture Re-Review Pass 2 (2026-07-02)

Four grounded lanes (2 codebase-structure, 1 socket.io library-API reality
check, 1 spec↔plan coverage audit) plus parent verification against spec text,
live code, and the Gondolin checkout. Findings folded:

Blocker:
- AF-1: the SSH-egress git execPolicy (deny `git-receive-pack` at host boundary)
  is normative (CUT:1844-1858) with a proof row (GIT-1) but had NO owning slice;
  verified net-new (zero repo refs). Gondolin supports it
  (`host/src/qemu/ssh.ts:73` `SshExecPolicy`), so it is an ownership gap, not a
  stop gate. Fix: new SG (SSH Git) slice `15-sg-ssh-egress-git-policy.md` owns the
  gondolin-adapter egress surface + two-lifecycle wiring; GIT-1 re-owned to SG.

Spec hardening (PROTO edited):
- AF-2: envelope `deliveryPolicy` was a trusted sender-set field with no
  recompute rule. Added: receiver derives class from `(operation, payload)` and
  fails closed on contradiction (new DP-TRUST proof row).
- AF-3: 5 of 9 message kinds were unmapped; `resync_request`/`resync_response`
  contradicted hello-based resync. Removed those two; pinned snapshot/heartbeat/
  observation dispositions; added KIND-EXACT proof row.

Plan-accuracy corrections (anchors verified):
- PC-1: allowedHosts injection is `gateway-interface/src/audience.ts:29-31`, not
  `openclaw-lifecycle.ts:1011`.
- PC-2: worker `controller-request-policy.ts` is NOT a barrel; both copies +
  tests orphan as callers leave — added explicit deletions to SWc/S5a.
- PC-3: identityPem is emitted by three lease routes (`:386/:536/:548`), not one.
- PC-4: `openclaw-lifecycle.ts:81-83` "fail-closed" is target-state, not
  existing code.
- PC-5: socket.io-client has NO send-buffer disable option; BP-3 now asserts the
  reconnect-clear/wrapper behavior.
- PC-6: `gateway-zone-orchestrator.ts` is `src/gateway/`, not `src/controller/`.

Decision resolved (user chose):
- D3: user chose GENERIC. Domain renamed `openclaw_gateway_control` →
  `gateway_control` across both specs; handshake audience
  `z.literal("gateway_control")`. OpenClaw-specific detail (plugin-hosted route,
  model-tool bindings) confined to `@agent-vm/openclaw-agent-vm-plugin`; the
  domain contract in `gateway-control-contracts` is generic. S2 remains the
  OpenClaw-specific placement of the generic service.

Design discussion — long-running workers / multi-day tasks (user model):
- Recovery = RECREATE the VM (fresh boot; Gondolin has no RAM migration — only
  disk checkpoints / auto-restart). State persistence is EXTERNAL (future
  session DB) + Gondolin durable drives — OUT of this cutover.
- "No worker without controller": a control-session outage quiesces the peer; it
  does not drive a headless days-long task. In-flight op redelivers idempotently
  on reattach (single_use_critical dedupe); no accumulating durable outbox.
- Heartbeats must be resilient, not over-sensitive: a NEW control-session-death /
  recovery grace (large multiple of heartbeats, PLANNING DEFAULT) is SEPARATE
  from the 120s active-use TTL. Transport death → cheap reconnect; recovery
  (expensive recreate) fires only after the grace with no reconnect. Same grace
  for gateway and worker.
- New non-goals: worker/gateway-internal durability, headless continuation,
  durable-session-store seam (user: skip). New proofs: RESILIENT-GRACE,
  RECREATE-FENCE. Liveness constants stay session-scoped.

Confirmed non-issues (no change): collector-mode deferral gating, S4b 4-family
coverage, eventKind enum staying in gateway-interface, constant ordering,
handshake trust root, and (library-verified) `io.engine.handleUpgrade` +
`allowRequest` pre-101 rejection.

## Current Verdict

The architecture packet is ready for implementor handoff after the explicit
GATE-0a and user/spec decisions above are handled. The plan is now organized as
vertical slice files, the proof matrix is row-level, and the relevant files are
profiled.

Do not implement production code before GATE-0a.
