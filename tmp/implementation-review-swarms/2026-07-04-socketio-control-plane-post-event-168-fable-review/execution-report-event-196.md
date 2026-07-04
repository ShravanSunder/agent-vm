Event 196 Execution Report
==========================

Goal:
- `2026-07-02-socketio-control-plane`

Input:
- Event 195 review routed the branch back to implementation execution for
  lossy sequencing/frontier semantics, latest-wins flush ordering,
  Worker `operation_cancel` proof depth, peer-side volatile/quiescence proof,
  Tool Portal MCP session retirement, refreshed caller-context lease ownership,
  and stale spec/plan/review artifacts.

Verdict:
- `review_ready`
- Not PR-ready. Terminal OpenClaw, Worker, VM, default e2e, `pnpm check`
  refresh after any later accepted findings, and live beta Discord/OpenClaw
  proof remain required after the next clean implementation review.

Accepted findings fixed in this pass:

1. Lossy advisory packets advanced or reserved the hard sequence frontier
   - Fixed shared sequence continuity so `latest_wins` and `droppable` messages
     do not advance the critical frontier.
   - Gateway and Worker peer services no longer reserve hard peer sequence slots
     for lossy/advisory outbound traffic.
   - Added regression proof that critical messages remain admissible after lossy
     gaps.

2. Latest-wins flush could reorder across keys
   - Added shared envelope-sequence ordering for queued lossy flushes.
   - Gateway, Worker, and controller latest-wins queues use the shared ordering
     before emit.

3. Worker `operation_cancel` proof was handler-only
   - Added service-level Socket.IO proof that controller-originated
     `operation_cancel` returns rejected command_result and the socket remains
     connected.
   - Added live active-task Worker runtime proof that `worker_control`
     `operation_cancel` does not close the active task, while HTTP task close
     still terminalizes it.

4. Latest-wins volatile/quiescence proof was shallow
   - Gateway and Worker runtime/advisory publishers now request lossy sequence
     allocation with `deliveryPolicy`.
   - Unit proof asserts runtime status publishers call
     `nextPeerSequence({ deliveryPolicy: "latest_wins" })`.
   - Integration proof covers lossy coalescing and critical-message continuity.

5. Tool Portal LRU eviction did not retire session-scoped MCP state
   - `ManagedMcpProviderBackendFactory` now tracks MCP provider agent ids by
     session key and exposes `retireSession(sessionKey)`.
   - Managed Tool Portal runtime retires MCP provider sessions on entrypoint LRU
     eviction and runtime close.

6. Active Tool VM leases were pinned to raw `callerContextId`
   - Lease RPC ownership now compares stable controller-vetted provenance:
     `zoneId`, `peerId`, `bootId`, `controllerEpoch`, `agentId`,
     `agentWorkspaceDir`, `workMountDir`, `sessionKeyDigest`, and `purpose`.
   - Ownership intentionally excludes raw `callerContextId`, `sessionId`, and
     `connectionId` so reconnect/refreshed caller contexts can reach existing
     leases when stable provenance matches.
   - Different agent/session-key provenance remains rejected.

7. Spec/plan/review packet drift
   - Root plan, canonical proof matrix, and relevant vertical slice files now
     record the lossy-frontier, Worker cancel, MCP session retirement, and
     refreshed lease ownership semantics.

Fresh proof run after fixes:

- Focused unit proof:
  - `pnpm vitest run --config vitest.config.ts --project unit packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.unit.test.ts packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.unit.test.ts packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`
  - Result: 6 files / 55 tests passed.
- Focused integration proof:
  - `pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts packages/agent-vm-worker/src/worker-runtime.integration.test.ts`
  - Result: 4 files / 79 tests passed.
- Touched package typecheck:
  - `pnpm --filter @agent-vm/agent-vm --filter @agent-vm/agent-vm-worker --filter @agent-vm/openclaw-agent-vm-plugin --filter @agent-vm/tool-portal --filter @agent-vm/mcp-portal --filter @agent-vm/control-protocol-contracts typecheck`
  - Result: all 6 selected packages passed.
- Static proof:
  - `pnpm exec oxfmt --check` over the Event 196 touched implementation files
    passed.
  - `pnpm lint` passed with 0 warnings / 0 errors.
  - `pnpm lint:types` passed with 0 warnings / 0 errors.
  - `git diff --check` passed.
- Broad proof:
  - `pnpm check` passed with 10 passed / 0 failed in 33.42s.
  - Included build, package-version sync, Zod guard, taxonomy audit, portal
    architecture/export audits, lint, format, type-aware lint, and typecheck.

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
evidence: Event 195 accepted findings fixed; focused unit/integration/static
proof and `pnpm check` passed as listed above; review packet, copy-paste prompt,
and staged inventory refreshed to 396 staged paths against `origin/master`
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Accepted Event 195 findings are fixed and
freshly proven; the next required lifecycle gate is implementation review, not
terminal proof or PR wrapup.
