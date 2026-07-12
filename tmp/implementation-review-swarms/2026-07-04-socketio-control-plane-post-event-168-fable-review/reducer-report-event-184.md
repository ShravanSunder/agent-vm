Post-Event-183 Parent Reducer Report
====================================

Verdict: review_ready

Reviewed current issue:

- Event 183 fixed the gateway control private signer exposure but left one
  design/implementation gap: the plan still implied controller process restart
  could reconnect to the same managed VM within the death-grace window.

Accepted correction:

1. Controller process restart is a managed-VM recreate boundary for this
   cutover.

   Evidence:

   - Local `@earendil-works/gondolin@0.12.0` public `VM` API exposes
     `VM.create(...)` and lifecycle instance methods such as `enableIngress()`,
     but no public adopt/reattach API that reconstructs a full `VM` wrapper
     from an existing session.
   - Gondolin session registry exposes `listSessions`, `findSession`, and
     `connectToSession`, but attach IPC is exec/snapshot shaped.
   - Gondolin attach IPC rejects lifecycle actions with "lifecycle actions are
     not supported over attach IPC".
   - DeepWiki over `earendil-works/gondolin` independently confirmed the attach
     APIs are not a full lifecycle/ingress adoption surface.

   Resolution:

   - Updated the implementation plan non-goals and S3/S6b text: same-VM
     reconnect applies to transport/socket flaps while the controller process
     still owns the VM/ingress handle.
   - Updated `RESILIENT-GRACE` in the canonical proof matrix to exclude
     controller process restart/redeploy and route that case to recreate/fencing.
   - Updated S3 and S6b slice files and the plan ledger with the same boundary.
   - Renamed misleading unit-test descriptions from "restart reconnect" to
     host-only material persistence.

Fresh focused proof:

- `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-session.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-session.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-session-material-store.unit.test.ts packages/agent-vm/src/gateway/gateway-runtime-record.unit.test.ts`
  exited 0 with 4 files / 22 tests passed.
- `pnpm exec oxfmt --check packages/agent-vm/src/controller/control-session/gateway-control-session.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-session.unit.test.ts`
  exited 0.
- `git diff --check && git diff --cached --check` exited 0.
- Staged review inventory regenerated from `git diff --cached origin/master`.

Post-revision status:

- The signer exposure blocker remains fixed.
- The controller-restart reconnect claim is no longer a blocker because the
  specs/plans now match the supported Gondolin lifecycle model.
- The packet is ready for another implementation-review/Fable pass.
- This is review readiness, not PR readiness; terminal runtime e2e and beta
  Discord/OpenClaw proof still need fresh treatment after accepted review
  findings are fixed or explicitly rejected.
