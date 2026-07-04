Event 195 Execution Report
==========================

Goal:
- `2026-07-02-socketio-control-plane`

Input:
- Event 194 routed the branch back to implementation execution after accepted
  review findings in Worker cancel semantics, peer-side latest-wins /
  backpressure delivery, MCP-backed Tool Portal session scoping, and review
  inventory freshness.

Verdict:
- `review_ready`
- Not PR-ready. Terminal OpenClaw, Worker, VM, default e2e, `pnpm check`
  refresh, and live beta Discord/OpenClaw proof remain required after the next
  clean implementation review.

Accepted findings fixed in this pass:

1. Worker control `operation_cancel` created a second task-close path
   - Fixed
     `packages/agent-vm-worker/src/control-session/worker-control-application-handler.ts`
     so controller-originated `operation_cancel` is hard-rejected with
     `worker_control_cancel_not_supported`.
   - Removed VM-side close-task dependencies from
     `createWorkerControlApplicationMessageHandler()`.
   - Worker task submit/state/close remain ingress HTTP-only in this PR.

2. Worker control `operation_cancel` ignored active operation identity
   - Same fix as above: reject the operation instead of inventing underspecified
     control-socket close semantics.
   - Added unit proof that the close callback is not called.

3. Peer-side Gateway and Worker services lacked latest-wins/backpressure proof
   - Added peer-side coalescing for latest-wins messages keyed by control
     identity.
   - Latest-wins and droppable advisory traffic now uses volatile emits.
   - Critical commands continue through acked command delivery.
   - Latest-wins queues are cleared on close/resync/disconnect.

4. MCP-backed Tool Portal sessions were scoped only by agent identity
   - Threaded session provenance from managed Tool Portal runtime into the MCP
     provider backend.
   - `ManagedMcpProviderBackendFactory.createBackend()` now accepts a
     `sessionKey`.
   - The MCP provider backend passes that key into `core.createAgentScope()`.

5. Review packet staged inventory was stale
   - Refreshed staged inventory artifacts.
   - Refreshed the review packet and copy-paste prompt for Event 194.

Fresh proof run after fixes:

- Focused unit proof:
  - `pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/control-session/worker-control-application-handler.unit.test.ts packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.unit.test.ts packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.unit.test.ts packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.unit.test.ts`
  - Result: 4 files / 22 tests passed.
- Focused integration proof:
  - `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts`
  - Result: 2 files / 42 tests passed.
- Static proof:
  - `pnpm typecheck` passed.
  - `pnpm fmt:check` passed.
  - `pnpm lint` passed with 0 warnings / 0 errors.
  - `pnpm lint:types` passed with 0 warnings / 0 errors.
  - `git diff --check` passed.
- Broad proof:
  - `pnpm check` passed with 10 passed / 0 failed in about 27.9s.
- Inventory proof:
  - `git diff --cached --name-only origin/master | wc -l` reports 394 staged
    paths.
  - `git diff --cached --stat origin/master` reports 394 files changed.

Remaining before PR-ready:
- Run/adjudicate the next implementation review.
- Run terminal runtime gates after accepted review findings:
  - `mise exec -- pnpm run test:e2e:openclaw`
  - `mise exec -- pnpm run test:e2e:worker`
  - `mise exec -- pnpm run test:e2e:vm`
  - `mise exec -- pnpm test:e2e`
  - `pnpm check` refresh
  - live `../shravan-claw-beta` actual Discord/OpenClaw proof.

phase_result: complete
evidence: Event 194 accepted findings fixed; focused unit/integration/static
proof and `pnpm check` passed as listed above; review packet, copy-paste prompt,
and staged inventory refreshed
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Accepted Event 194 findings are fixed and
freshly proven; the next required lifecycle gate is implementation review, not
terminal proof or PR wrapup.
