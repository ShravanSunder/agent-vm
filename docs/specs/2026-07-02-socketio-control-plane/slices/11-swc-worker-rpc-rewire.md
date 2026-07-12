# 11 - SWc Worker RPC Rewire

Purpose:
- Move Worker git push/pull-default from raw controller HTTP callbacks to
  worker_control_rpc.
- Preserve Worker task HTTP submit/state/close over ingress.

Source anchors:
- CUT Worker Control Session And RPC Contract.
- CUT Git Access And Push Policy.
- CUT Worker task HTTP non-goal.

Owned write surface:
- `packages/agent-vm-worker/src/work-phase/controller-tools/git-push-tool.ts`
- `packages/agent-vm-worker/src/work-phase/controller-tools/git-pull-default-tool.ts`
- `packages/agent-vm-worker/src/work-phase/controller-tools/controller-tool-support.ts`
- `packages/agent-vm-worker/src/coordinator/task-runner.ts`
- `packages/worker-gateway/src/worker-lifecycle.ts`
- Controller worker RPC handlers registered on S3 seam
- `packages/gateway-interface/src/health/controller-request-policy.ts` through
  hot-file sequence
- DELETE the now-dead worker wrapper (PC-2): the LOCAL
  `packages/agent-vm-worker/src/work-phase/controller-tools/controller-request-policy.ts`
  is NOT a re-export barrel — it defines its own `fetchWorkerControllerWithPolicy`
  whose sole caller is `controller-tool-support.ts:132` (rewired here). Once the
  worker op group is gone, delete it + its `controller-request-policy.unit.test.ts`.

Dependencies:
- S1, S3, SWa, SWb.

Checkpoint:
- No Worker `CONTROLLER_BASE_URL` callback path remains for git tools.
- Controller enforces protected/default branch, expectedHead, non-ff, force,
  and delete policy.
- Worker task HTTP submit/state/close still works semantically.
- Controller-originated `operation_cancel` over `worker_control` is
  hard-rejected and must not close the active task; task close remains the
  ingress HTTP path for this PR.
- DAYS-LONG quiesce (user model: "no worker without controller"): a git_push /
  git_pull_default in flight when the session drops is redelivered idempotently
  on reattach via single_use_critical + `idempotencyKey`/`commandId` dedupe
  (DELIVERY-3/4) — exactly-once side effect. The worker does NOT accumulate a
  durable outbox of new intents during an outage (it quiesces without the
  controller); no durable-store seam is built here.

Proof rows:
- RESIDUE-3
- GIT-2, GIT-3 (controller push policy + no pack over the control socket)
- Worker semantic task HTTP regression row in root plan
- Worker control `operation_cancel` rejection service/live active-task proof
- NOTE: GIT-1 (host-boundary git-receive-pack denial) is owned by SG (SSH Git)
  (`15-sg-ssh-egress-git-policy.md`), a Gondolin SSH-egress execPolicy proof —
  do NOT try to satisfy GIT-1 from the worker side.

Commands:
- `pnpm test:unit`
- `pnpm test:integration`
- `mise exec -- pnpm run test:e2e:worker`
- (`mise exec -- pnpm run test:e2e:vm` belongs to SG (SSH Git)/GIT-1, not SWc)

Split trigger:
- Split git policy from Worker rewire if trusted protected-branch policy source
  needs schema/config work.
