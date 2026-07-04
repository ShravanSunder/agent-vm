# 07b - S6b Recovery Corroboration And Budget

Purpose:
- Replace raw control-link recovery triggers with control-session evidence.
- Require controller-owned corroboration and source-budgeting for gateway or
  worker observations.

Source anchors:
- CUT recovery corroboration.
- CUT threat model forged-health amplifier.

Owned write surface:
- `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts`
- Recovery state integration paths
- Health-event route disposition coordination with S4b

Dependencies:
- S3, S6a.
- Worker branch waits on Q2 worker probe-source decision.

Checkpoint:
- `control-session-unhealthy` replaces `gateway-control-link-unhealthy`.
- Gateway/worker observation alone cannot drive recovery.
- Budget key is controller-owned: domain, zone, VM id, boot id, generation.
- DAYS-LONG resilience: recovery = RECREATE the VM (expensive), so it is NOT
  hair-triggered. Transport death drives a cheap reconnect; recovery fires ONLY
  after the control-session-death grace (large multiple of heartbeats) elapses
  with no reconnect. A reconnect within grace cancels pending recovery. Same
  large grace for gateway AND worker. Controller process restart/redeploy is
  outside this reconnect promise for this cutover and recreates the managed VM;
  Gondolin 0.12.0 attach IPC does not recover a full lifecycle/ingress `VM`
  object. After recreate, old-boot/old-epoch session is fenced.

Proof rows:
- RECOVERY-1
- RECOVERY-2
- RESILIENT-GRACE (no recovery before grace; in-process reconnect within grace
  cancels it)
- RECREATE-FENCE (post-recreate new-boot session accepted, old-boot fenced)

Commands:
- `pnpm test:unit`
- `pnpm test:integration`

Split trigger:
- Split gateway and worker corroboration if Q2 remains unresolved.
