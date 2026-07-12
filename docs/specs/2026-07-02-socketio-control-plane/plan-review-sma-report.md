# Focused Plan Review Report — SMA Same-Zone Multi-Agent Repair

Date: 2026-07-05

Reviewed artifacts:

- `implementation-plan.md`
- `lanes/validation-proof.md`
- `slices/00b-sma-openclaw-same-zone-multi-agent.md`
- `slices/README.md`
- `plan-ledger.md`

Verdict after folding findings: ready for implementation-execute-plan starting
with SMA. The broader Socket.IO cutover remains gated by GATE-0a and the
existing open decisions.

## Accepted Findings Folded

1. SMA proof was not self-closing.
   - Changed SMA-3, SMA-4, and SMA-5 owners to SMA.
   - S4a/S7 now preserve these invariants later; they do not own the initial
     repair proof.

2. Stable provenance proof was underspecified.
   - Added explicit requirement that `agentId`, `agentWorkspaceDir`,
     `workMountDir`, and `sessionKeyDigest` must be controller-validated or
     controller-derived before `callerContextId` issuance.
   - Added negatives for wrong workspace, wrong work mount, changed session-key
     provenance, and ambiguous shared fallback.

3. Per-agent workspace isolation was too soft.
   - Promoted distinct per-agent workspace/mount mapping from implementation
     note to hard SMA invariant.

4. MCP Portal parity proof lacked a two-agent green path.
   - SMA-5 now requires 2-agent positive tests in both unit materialization and
     integration validation layers.

5. Beta proof could be vacuous.
   - SMA-7 now requires staged beta with at least one non-default second agent,
     matching portal bindings, and an agent-distinguishing surface.
   - A single-agent beta pass is explicitly non-evidence.

6. Readiness and ledger text contradicted each other.
   - Root status and ledger route now both say implementation may start with
     SMA, while the full cutover remains gated by GATE-0a and open decisions.

7. Ledger insertion spliced controller-ceiling text into SMA.
   - Restored the controller-ceiling bullet and kept the SMA correction separate.

8. SMA/GATE-0a ordering was ambiguous.
   - README now says SMA may run before GATE-0a; production Socket.IO cutover
     slices still require GATE-0a.

## Remaining User / Product Decisions

- OPEN-4 proof-gating disposition.
- Q1 route delete-vs-auth-gate defaults before S4b.
- Q2 worker corroboration probe source.

## Implementation Guardrails

- Do not touch `../shravan-claw` without explicit authorization.
- Do not satisfy SMA by deleting the guard only.
- Do not accept raw gateway workspace/mount claims without controller validation
  or derivation.
- Do not count single-agent beta validation as proof of SMA.
