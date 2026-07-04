Event 197 Local Reducer Report
==============================

Goal:
- `2026-07-02-socketio-control-plane`

Input:
- Event 196 advanced the branch to implementation review after accepted
  Event 195 findings were fixed.
- Five child reviewer lanes were started for the post-Event-195 review. Three
  returned settled/null payloads, and two did not return before timeout. All
  five lanes were closed to avoid repeating the earlier file-descriptor/resource
  pressure problem.
- Because independent lane output was unavailable, this report records a local
  reducer/source-trace pass only. It is not PR-ready evidence and does not
  replace the requested external Fable review.

Verdict:
- `review_ready_for_external_fable`
- No new accepted blocker or important implementation finding was found in this
  local reducer pass.
- Not PR-ready. Terminal OpenClaw, Worker, VM, default e2e, `pnpm check`
  refresh, and live beta Discord/OpenClaw proof remain required after Fable
  findings are fixed or explicitly rejected with evidence.

Swarm coverage:
- Whole-source trace lane `019f2daa-ce5f-79d0-9315-d51f75063245`: timed out,
  then closed. Previous status before close: `running`.
- Spec/proof lane `019f2dab-0230-7e53-b93e-7df2a3551637`: timed out, then
  closed. Previous status before close: `running`.
- Security/runtime lane `019f2dab-35ec-7223-a348-ec96e91cd6bf`: settled with
  null completion, then closed.
- Reliability/backpressure lane `019f2dab-6249-7512-9963-2ec77a7374d3`:
  settled with null completion, then closed.
- Contracts/tests lane `019f2dab-9add-7a70-9837-6b0b5c32f775`: settled with
  null completion, then closed.

Local reducer checks:

1. Review packet inventory freshness
   - Before this reducer artifact was added,
     `git diff --cached --name-status origin/master | wc -l` returned `396`.
   - After staging this Event 197 reducer artifact and refreshing the packet,
     current staged inventory is expected to contain 397 paths.
   - `staged-name-status.txt` is refreshed from fresh
     `git diff --cached --name-status origin/master`.
   - `staged-stat.txt` matches fresh `git diff --cached --stat origin/master`.
   - No accepted packet-staleness finding.

2. Lossy delivery and hard sequence frontier
   - `evaluateControlSequenceContinuity()` accepts `latest_wins` and
     `droppable` without advancing `nextLastSeenSequence`.
   - Gateway and Worker peer services return `lastSeenPeerSequence + 1` for
     lossy/advisory `nextPeerSequence({ deliveryPolicy })` calls instead of
     reserving a hard peer slot.
   - Controller, Gateway, and Worker latest-wins queues flush with
     `orderControlMessagesByEnvelopeSequence()` before `volatile.emit`.
   - Regression anchors exist in control-protocol unit tests, Gateway service
     integration tests, Worker service integration tests, and controller client
     integration tests.
   - No accepted sequence-frontier finding.

3. Worker `operation_cancel`
   - VM-side Worker application handler returns rejected command_result for
     controller-originated `operation_cancel`; it does not close the active
     task.
   - Worker Socket.IO service integration proves the session stays connected
     after the rejected result.
   - Worker runtime integration proves the active task remains active until the
     existing HTTP task close route is used.
   - No accepted Worker close-path finding.

4. Tool Portal MCP session retirement
   - `ManagedMcpProviderBackendFactory.retireSession(sessionKey)` exists and
     invalidates agent scopes recorded for that session key.
   - Managed Tool Portal runtime calls `retireSession()` on entrypoint LRU
     eviction and runtime close.
   - Unit proof covers retirement on LRU eviction and close.
   - No accepted MCP-session-retirement finding.

5. Active lease ownership after refreshed caller contexts
   - Lease RPC ownership now compares stable controller-vetted provenance:
     `zoneId`, `peerId`, `bootId`, `controllerEpoch`, `agentId`,
     `agentWorkspaceDir`, `workMountDir`, `sessionKeyDigest`, and `purpose`.
   - It excludes raw `callerContextId`, `sessionId`, and `connectionId`, so a
     refreshed context for the same stable provenance can access an active
     lease.
   - Regression proof covers refreshed-context access and different
     agent/session-key rejection.
   - No accepted lease-ownership finding.

Source/spec/plan/code/proof matrix:

```text
source_obligation_id: DELIVERY-1 / DELIVERY-2
source_anchor: docs/specs/2026-07-01-socketio-control-protocol-semantics.md
plan_anchor: docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md
implementation_anchor: packages/control-protocol-contracts/src/index.ts; packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts; packages/agent-vm-worker/src/control-session/worker-control-service.ts; packages/agent-vm/src/controller/control-session/control-session-client.ts
proof_anchor: packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts; packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts; packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts; packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts
reachability_status: live
coverage_status: covered locally; external Fable review still requested
false_substitute_risk: stale lossy messages could be mistaken for critical sequence proof
accepted_deviation_bucket: none
accepted_route_target: none
```

```text
source_obligation_id: SWC-CANCEL-BOUNDARY
source_anchor: docs/specs/2026-07-02-socketio-control-plane/slices/11-swc-worker-rpc-rewire.md
plan_anchor: docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md
implementation_anchor: packages/agent-vm-worker/src/control-session/worker-control-application-handler.ts
proof_anchor: packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts; packages/agent-vm-worker/src/worker-runtime.integration.test.ts
reachability_status: live
coverage_status: covered locally; external Fable review still requested
false_substitute_risk: handler-only proof could miss live task-close behavior
accepted_deviation_bucket: none
accepted_route_target: none
```

```text
source_obligation_id: TOOL-PORTAL-MCP-SESSION-RETIREMENT
source_anchor: docs/specs/2026-06-25-tool-portal-composition-contract.md
plan_anchor: docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md
implementation_anchor: packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts; packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.ts
proof_anchor: packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.unit.test.ts
reachability_status: live
coverage_status: covered locally; external Fable review still requested
false_substitute_risk: entrypoint LRU eviction could clean Tool Portal state but leave MCP sessions alive
accepted_deviation_bucket: none
accepted_route_target: none
```

```text
source_obligation_id: LEASE-REFRESHED-CALLER-CONTEXT
source_anchor: docs/specs/2026-06-30-gateway-control-session-hard-cutover.md
plan_anchor: docs/specs/2026-07-02-socketio-control-plane/slices/04-s4a-gateway-control-contract-lease-rpc.md
implementation_anchor: packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.ts
proof_anchor: packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts
reachability_status: live
coverage_status: covered locally; external Fable review still requested
false_substitute_risk: using raw callerContextId as lease owner would break reconnect/refreshed-context semantics
accepted_deviation_bucket: none
accepted_route_target: none
```

Remaining before PR-ready:
- External Fable/adversarial implementation review, or explicit user acceptance
  of the limited local reducer coverage.
- Terminal proof gates after accepted Fable findings:
  - `mise exec -- pnpm run test:e2e:openclaw`
  - `mise exec -- pnpm run test:e2e:worker`
  - `mise exec -- pnpm run test:e2e:vm`
  - `mise exec -- pnpm test:e2e`
  - `pnpm check`
  - live `../shravan-claw-beta` actual Discord/OpenClaw proof.

phase_result: complete
evidence: local reducer report written at tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-197.md; child reviewer lanes unavailable/closed as listed; local source-trace checks found no accepted blocker/important findings; staged inventory matches fresh git output
recommended_next_workflow: shravan-dev-workflow:implementation-review-swarm
recommended_transition_reason: Local reducer found no new accepted findings, but independent child-agent review lanes were unavailable; the next useful implementation-review action is external Fable review of the refreshed packet before terminal proof and PR wrapup.
