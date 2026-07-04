# 09 - SWa Worker Control Contracts

Purpose:
- Populate worker_control_rpc contracts for Worker-originated controller tools
  and observations.

Source anchors:
- CUT Worker Control Session And RPC Contract.
- CUT Git Access And Push Policy.
- PROTO domain separation.

Owned write surface:
- `packages/worker-control-contracts/**`

Dependencies:
- S1.

Checkpoint:
- Worker operation union includes control ping, capacity/status/observation,
  git push, pull-default, cancel, and recovery.
- Git payloads carry intent only; protected/default branch policy comes from
  trusted controller state.
- Event-only worker operations cannot appear as `command_result`.

Proof rows:
- DOMAIN-SEP-1 worker portion
- SCHEMA rows for worker contract exactness
- GIT-2 schema precondition portion

Commands:
- `pnpm test:unit`

Split trigger:
- Split git payload contracts from observation contracts if schema ownership
  becomes unclear.
