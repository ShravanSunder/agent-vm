# 06 - S6a Health EventKind Remap

Purpose:
- Replace legacy `gateway-control-link` health vocabulary with
  `gateway-control-session`/control RPC vocabulary.

Source anchors:
- CUT Health And Operator Contract.
- CUT recovery-trigger mapping.

Owned write surface:
- `packages/gateway-interface/src/health/agent-vm-health.ts`
- Health telemetry, reducer, runtime, and state-machine call sites named in
  the root plan
- `packages/gateway-interface/src/health/controller-request-policy.ts` through
  hot-file sequence

Dependencies:
- S3.

Checkpoint:
- `gateway-control-link` is not a current readiness/recovery event kind.
- New control-session event kind is understood by reducers and telemetry.

Proof rows:
- RESIDUE-5
- RECOVERY-1 event vocabulary portion

Commands:
- `pnpm test:unit`
- `pnpm check`

Split trigger:
- Split if telemetry and recovery reducers cannot be updated in one safe pass.
