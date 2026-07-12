# Lane: scope-and-proof-fit (parent-verified; findings folded into implementation-plan.md)

Historical status:
- This lane captures pre-fold findings. Current execution status lives in
  `implementation-plan.md`, `lanes/validation-proof.md`, and `slices/*.md`.

Status: answered. Historical pre-fold verdict: plan close and required revision — 4 blockers + 9 important + 7 nits, all
with concrete edits that are now folded. No scope drift (non-goals mirror CUT; 3-package split + constants + shell scaffolding are
spec-authorized). Confidence high on B1/I1/classification/constants; medium on I9/N6 (matrix-detail dependent).

## Blockers (all ACCEPTED + folded)
B1 DAG edge wrong: SW was grouped "parallel after S1" but is after S1+S3 (needs S3 session runtime). FOLDED: SW*
   moved into the after-S1+S3 tier; DAG rewritten.
B2 Q1 (/lease identityPem delete vs auth-gate) was originally classified as a spec-level security decision blocking
   S4's route half. SUPERSEDED BY INDEPENDENT PLAN REVIEW: the accepted spec already permits delete or operator-auth
   gate, so Q1 is now a user implementation decision with default delete. FOLDED: S4 split → S4a (RPC parity +
   custody, unblocked) + S4b (route disposition + RESIDUE-6, uses Q1 default unless the user overrides before S4b).
B3 OPEN-2 collector disposition originally required a product ruling before S5's residue-green checkpoint.
   SUPERSEDED BY IMPLEMENTATION DISPOSITION: collector fail-closed is the accepted S5c behavior for this cutover.
B4 OPEN-4 (INGRESS-1 + FLAP-1b only under env-gated e2e-openclaw, not default gate) is a hard blocker for the
   cutover proof gate; the "named lane + CI job" rec is internally inconsistent because a CI job is itself a
   proof-infra change needing the same approval. FOLDED: elevated to BLOCKING user decision; CI-job caveat stated.

## Important (ACCEPTED + folded)
I1 hot-file serialization stated but not operationalized. FOLDED: concrete single-owner for controller-request-policy.ts
   (one sequenced op-group removal); S2 owns openclaw-plugin-registration.ts register() structure, S4a/S7 additive,
   S5a removes last; encoded in DAG.
I2 controller RPC dispatch seam is shared mutable state absent from the matrix. FOLDED: S3 must expose a per-domain
   dispatch EXTENSION POINT (added to S3 checkpoint); S4a/SWc register additively.
I3 S6 bundles mechanical enum-remap with the load-bearing recovery-corroboration fix. FOLDED: S6 split → S6a
   (eventKind remap) / S6b (recovery corroboration + budget) / S6c (correlation).
I4 Q2 (worker corroboration probe source) blocks RECOVERY-2 worker path. FOLDED: reclassified blocking-before-S6b-worker.
I5 SW too large. FOLDED: split → SWa (contract) / SWb (worker server + handshake) / SWc (handlers + rewire + guard);
   clarified worker uses plain Node upgrade, NOT under GATE-0 STOP.
I6 dropped requirement: no proof Worker task submit/state/close over ingress HTTP still works post-cutover. FOLDED:
   added task-HTTP regression row to SWc (CUT surface proof 2287).
I7 GATE-0 conflated feasibility spike with productionized handleUpgrade. FOLDED: split GATE-0a (pre-S1 throwaway
   spike; STOP decision) vs GATE-0b (productionized in S2 with S1 schema).
I8 S5 "image builds without old plugin" claim had no image-build proof row. FOLDED: added image-build smoke
   (e2e-host-docker) in S5b, or drop claim.
I9 versioning proof: PARENT VERIFIED covered (protocolVersion z.literal(1) + protocol_version_mismatch close reason,
   reject-no-resync). FOLDED: explicit row added (S1 unit + S2 handshake).

## Nits (ACCEPTED + folded)
N1 control-resync-timeout 5000 not strictly > connect+ack=5000. FOLDED: rationale fixed — resync is a hello on an
   already-connected socket, compare to ack round-trip (2s) not connect+ack; 5s gives margin. Not in PROTO normative list.
N2 dedupe/replay window presented as derived but unanchored. FOLDED: labeled PLANNING DEFAULT.
N3 no reconnect send-buffer config value though PROTO 671-673 normative. FOLDED: added constant (DISABLED) + S3 config.
N4 S7 write surface omitted openclaw-plugin-registration.ts though it's in the hot-file set. FOLDED: added (additive).
N5 S1 empty shells must satisfy portal-exports audit. FOLDED: placeholder exports in S1 checkpoint.
N6 INGRESS-1 is a JOINT S2+S3 proof, not S2-alone; STOP reachable at S2 seam. FOLDED: reattributed; STOP via GATE-0a
   + S2 HANDSHAKE seam.
N7 FLAP-1(b) soak rig had no owning slice. FOLDED: S3 authors it; runs in cutover gate under AGENT_VM_OPENCLAW_E2E=1.

## Constants ordering-invariant check: PASS
Updated after independent plan review: heartbeat 30s < TTL 120s; connect 3s + ack 2s = 5s < active-use-start 10s;
Engine.IO ping death ~20s < lease stale 120s (agent-vm owns liveness — the "explicitly treated as transport death"
branch); maxHttpBufferSize 64KiB floor > multi-KB identityPem snapshot, below 1MB default. Violations fixed:
N1 (rationale), N3 (missing send-buffer config).
N2 replay window relabeled PLANNING DEFAULT.

## Blocking vs tune classification (final)
BLOCKING: OPEN-5/GATE-0a (whole cutover), OPEN-4 (cutover proof gate — user decision), Q2 (S6b worker).
USER IMPLEMENTATION DECISION: Q1 route disposition default delete unless overridden before S4b.
TUNE-DURING: OPEN-1 magnitudes, OPEN-3 observation-kind.
