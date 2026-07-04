# 10 - SWb Worker Control Service

Purpose:
- Add the VM-side Worker private Socket.IO server and readiness route.

Source anchors:
- CUT Worker VM-side ownership.
- PROTO handshake/security contract.

Owned write surface:
- `packages/agent-vm-worker/src/control-session/**`
- Worker server upgrade wiring
- Worker boot verifier/public-key injection path, coordinated with gateway
  lifecycle env custody rules

Dependencies:
- S1, S3, SWa.

Checkpoint:
- `GET /__agent-vm/worker-ready` issues nonce.
- `/__agent-vm/worker-control` upgrades over Socket.IO websocket-only.
- Existing `/health` and `/tasks` routes remain.

Proof rows:
- HANDSHAKE-1 through HANDSHAKE-4 worker equivalents
- worker control e2e harness

Commands:
- `pnpm test:integration`
- `mise exec -- pnpm run test:e2e:worker`

Split trigger:
- Split server wiring from handshake verifier only if boot env custody needs a
  separate shared helper.
