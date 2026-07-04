# Plan Review Delta Report - Updated Socket.IO Control Plane Plan

Review target:
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md`

Mode:
- Read-only delta review after the prior plan-review findings were folded.
- No implementation files or plan files were edited by this review.

Resolution note:
- Addressed after this delta review by replacing `lanes/validation-proof.md`
  with a canonical proof matrix and by updating the S4b/Q1 DAG wording
  in `implementation-plan.md`.

Coverage:
- `implementation-plan.md`: 463 lines, read end to end.
- `lanes/validation-proof.md`: 75 lines, read end to end.
- Live anchors checked for e2e scripts/projects, OpenClaw provenance, heartbeat constants, and request-policy timeouts.

Verdict:
- Historical delta verdict: improved substantially, but needed one proof-matrix
  revision before `implementation-execute-plan`.
- Current status after follow-up edits: addressed.

## Resolved From Prior Review

The updated plan resolves or materially addresses these prior blockers:

- GATE-0a now requires exact OpenClaw runtime provenance and a real detached Socket.IO/Engine.IO proof through `handleUpgrade`, with no second guest port.
- Server-side route disposition is now a complete table for `/lease*`, health-events, runtime-status, and zone-git push.
- Gateway control contracts now own the full gateway operation union, not only lease/use schemas.
- OPEN-4 now names exact cutover commands for OpenClaw, Worker, and VM e2e proof lanes.
- OPEN-2 collector disposition is clearly marked as blocking final shipment, not merely a local S5c detail.
- Active-use stale is corrected to `120_000 ms`.
- `allowedHosts` removal, public-key env custody, Worker git policy, nonce failed-handoff, recovery budget identity, ingress e2e suffix, identityPem custody, Worker semantic task proof, and manual residue coverage are all represented.

## Remaining Blocker - Addressed

### 1. The canonical proof matrix still is not row-level or command-ready.

Evidence:
- `implementation-plan.md:375-377` says the canonical matrix has row-level fields: requirement id, source anchor, owner slice, files, test name or command, expected red signal, expected green signal, freshness guard, and split trigger.
- `lanes/validation-proof.md:3-5` repeats the same row schema claim.
- But `lanes/validation-proof.md:14-51` still contains grouped proof families such as `SCHEMA-1..6`, `DELIVERY-1..5`, and `GIT-1..3`, not individual rows with the claimed fields.
- `lanes/validation-proof.md:29-31` says BP-4 is still blocked on OPEN-1 constants, while `implementation-plan.md:69-95` chooses the constants and `implementation-plan.md:448-450` classifies OPEN-1 as resolved/tune-during.

Failure scenario:
- An implementation agent can satisfy a family label while skipping individual proofs such as protocol-version mismatch, duplicate nonce behavior, no unbounded reconnect buffer, no polling, route residue, or generated manual residue.
- Another agent can treat BP-4 as blocked on OPEN-1 even though the main plan has already chosen constants, causing duplicate planning or stalled execution.

Applied plan edit:
- Replace `lanes/validation-proof.md` family summaries with actual rows. Each row should include:
  - requirement id
  - source spec anchor
  - owner slice
  - file or harness to edit
  - exact test name or command
  - expected red signal
  - expected green signal
  - freshness guard
  - split trigger
- Update BP-4 and the OPEN-1 section in `validation-proof.md` to say constants are chosen in `implementation-plan.md:69-95`; only four magnitudes are tune-during planning defaults.

Proof expected:
- Sampling `SCHEMA-1`, `SCHEMA-2`, `DELIVERY-5`, `HANDSHAKE-3`, `BP-4`, `RESIDUE-6`, and `GIT-1` should produce seven distinct rows with exact commands and red/green expectations.

## Important Cleanup - Addressed

### 1. Q1 wording is slightly inconsistent across the DAG and decision section.

Evidence:
- `implementation-plan.md:201-202` says Q1 default is chosen unless the user wants retention-with-auth.
- Before the follow-up fix, `implementation-plan.md:335` still presented S4b as blocked on Q1.
- `implementation-plan.md:443-446` says Q1 is a user implementation decision with default delete.

Applied plan edit:
- Reworded the DAG line to:
  `S4b route disposition (after S4a; uses Q1 default unless user overrides before S4b)`.

## Current Readiness

Ready to proceed only after:
- GATE-0a exact delivered OpenClaw runtime proof and real-runtime handleUpgrade proof are run.
- The user makes the OPEN-4 proof-gating and Q1 disposition calls, or accepts the defaults recorded in the plan.
- OPEN-2 and Q2 are routed to spec only where they are required by the plan's own blocking boundaries.
