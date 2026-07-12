Implementation Review Reducer Report - Event 185
================================================

Verdict
-------

not_ready

Reason:

- Five read-only reviewer lanes completed and were closed.
- Parent verification accepted blocker and important implementation findings in
  the staged code. The workflow must route back to
  `shravan-dev-workflow:implementation-execute-plan`.

Reviewed scope
--------------

- Current staged diff against `origin/master`.
- `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`
- Accepted specs and plan under `docs/specs/**`.
- Control-session, Tool Portal, OpenClaw gateway, Worker control, HTTP route,
  SSH egress, and architecture-audit surfaces cited by reviewers.

Swarm coverage
--------------

- Whole-source trace: completed, closed.
- Spec/plan compliance: completed, closed.
- Implementation proof + runtime reachability: completed, closed.
- Security/trust + reliability: completed, closed.
- Contracts/tests/code quality: completed, closed.
- External Fable: not included in this local swarm; the packet remains suitable
  for separate Fable review.

Accepted findings
-----------------

1. blocker - Caller-context ids are not bound to accepted control session or
   boot.

   Evidence:

   - `packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts`
     stores `controllerEpoch`, `peerId`, `zoneId`, and purpose, but does not
     store `bootId`, `sessionId`, or `connectionId`.
   - `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`
     validates controller host action caller context against epoch, peer, zone,
     and purpose only.
   - `packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.ts`
     tracks lease ownership by `leaseId -> callerContextId`, not by accepted
     control-session generation.

   Scenario:

   A stale gateway can reuse a previously issued `callerContextId` after a
   gateway VM recreate or accepted-session replacement within the same
   controller epoch. The context is opaque, but not session-fenced.

   Smallest fix:

   Store session-binding fields with trusted caller contexts, validate them for
   lease RPC and controller-host-action RPC, and invalidate old contexts when a
   new accepted gateway session/boot supersedes them.

   Proof:

   Unit/integration coverage registering a context, simulating a new accepted
   gateway boot/session, and proving the old caller context is rejected for both
   lease RPC and controller host action until a fresh registration succeeds.

2. blocker - Managed OpenClaw still preserves deprecated `mcp-portal` plugin
   runtime config.

   Evidence:

   - `packages/openclaw-gateway/src/openclaw-lifecycle.ts` iterates
     `runtimePluginConfigs`, special-cases plugin id `mcp-portal`, and appends
     runtime plugin ids back into `plugins.allow` / `plugins.entries`.
   - `packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts`
     preserves that behavior.

   Scenario:

   A managed zone can still carry stale `runtimePluginConfigs["mcp-portal"]`,
   causing the old managed MCP Portal plugin facade to remain reachable despite
   the hard cutover to Tool Portal.

   Smallest fix:

   Reject deprecated `mcp-portal` plugin/runtime config in managed OpenClaw mode
   or rewrite startup materialization to remove it fail-closed. Update the host
   e2e to assert the cutover behavior.

   Proof:

   Config/lifecycle proof that stale managed `mcp-portal` plugin config fails
   closed or is removed, plus audit coverage.

3. important - Tool Portal directly imports `@agent-vm/mcp-portal/core`.

   Evidence:

   - `packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.ts`
     imports `createPortalCore`, `createUpstreamMcpClientRuntime`, and
     `resolveUpstreamServers` from `@agent-vm/mcp-portal/core`.
   - `scripts/audit-portal-architecture.ts` currently passes despite this edge.

   Scenario:

   Tool Portal now constructs MCP Portal core directly, collapsing the accepted
   backend-adapter boundary.

   Smallest fix:

   Move MCP core construction behind an MCP Portal owned adapter/export and make
   the architecture audit fail on direct `@agent-vm/mcp-portal/core` imports
   from Tool Portal runtime code.

   Proof:

   Architecture audit unit and script proof, plus existing Tool Portal
   integration tests after the import boundary changes.

4. important - `GET /leases` remains unauthenticated.

   Evidence:

   - `packages/agent-vm/src/controller/http/controller-http-routes.ts` returns
     `options.leaseManager.listLeases()` at `GET /leases` without auth.
   - `packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts`
     codifies unauthenticated status 200.

   Scenario:

   Any caller that can reach the controller port can enumerate active lease ids,
   agent ids, zone ids, and TCP slots. The cutover plan keeps retained legacy
   route families as operator/admin surfaces only.

   Smallest fix:

   Remove `GET /leases` or gate it behind operator/admin auth and update tests.

   Proof:

   Test unauthenticated access returns 401/403 or 404, and authenticated
   operator access still works if the route is retained.

5. important - Tool Portal host-action stale caller-context recovery fails the
   first user call.

   Evidence:

   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.ts`
     forgets caller context on stale/absent response, then throws
     `execution_failed` instead of re-registering and retrying once.

   Scenario:

   After controller restart, caller-context eviction, or registry loss, the
   first model-visible `zone_git_push` fails even though the backend knows the
   recovery action.

   Smallest fix:

   On stale/absent caller-context responses, clear scoped cache, re-register,
   and replay the same host action once with a bounded retry.

   Proof:

   A single `tool_portal_call` succeeds after an initial stale/absent
   controller-host-action response and emits:
   `tool_portal_controller_host_action -> caller_context_register ->
   tool_portal_controller_host_action`.

6. important - Authenticated upgrade failure records can leak until service
   restart.

   Evidence:

   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts`
     marks accepted credential records as `failed` when `engine.handleUpgrade`
     throws, but does not set `terminalAtMs`.
   - `packages/agent-vm-worker/src/control-session/worker-control-service.ts`
     has the same pattern.
   - Both reapers delete terminal records only when `terminalAtMs` is set.

   Scenario:

   Repeated post-auth upgrade failures can fill the credential record queue and
   wedge reconnects until process restart.

   Smallest fix:

   Stamp `terminalAtMs = now()` in both catch paths when moving an accepted
   credential to `failed`.

   Proof:

   Integration/unit proof forcing `engine.handleUpgrade()` to throw after
   credential acceptance, advancing time, and proving eviction frees capacity.

7. important - Managed SSH read allowlisting is GitHub-shaped despite generic
   trusted repo URLs.

   Evidence:

   - `packages/gateway-interface/src/git-read-allowlist.ts` normalizes only
     GitHub repo URLs.
   - `packages/openclaw-gateway/src/openclaw-lifecycle.ts` and
     `packages/worker-gateway/src/worker-lifecycle.ts` use fixed GitHub SSH
     host policy.

   Scenario:

   Trusted repos on GitHub Enterprise, GitLab, or another configured SSH host
   are dropped from the allowlist and then fail closed. That is safer than open,
   but it breaks legitimate configured repos and does not match the generic
   trusted repo contract.

   Smallest fix:

   Normalize trusted SSH repos by host and repo path and derive allowed SSH
   hosts from those trusted repos while continuing to deny receive-pack.

   Proof:

   Unit coverage for non-`github.com` trusted repos in gateway and worker
   lifecycle builders, plus VM/e2e proof if this remains in the current cutover
   scope.

8. important - Caller-context registry has only a hard cap and no lifecycle
   eviction.

   Evidence:

   - `packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts`
     stores contexts permanently until the runtime exits.
   - Lease release only deletes `leaseId -> callerContextId`, not the caller
     context.

   Scenario:

   A long-running gateway with many legitimate unique contexts eventually hits
   the 1024-context hard cap and fails all new caller-context registration.

   Smallest fix:

   Add lifecycle-based eviction, TTL, LRU, or session-close cleanup while
   keeping the hard cap as a final fail-safe.

   Proof:

   Regression registering more than the cap worth of sequential completed
   contexts without wedging future registrations.

Accepted proof gaps / terminal gates
------------------------------------

- Worker git RPC e2e still proves the Worker service with a local synthetic
  controller socket, not the full real controller-backed git RPC path. Treat as
  a proof gap unless implementation narrows the proof claim.
- Fresh terminal runtime proof is still pending after accepted fixes:
  `test:e2e:openclaw`, `test:e2e:worker`, `test:e2e:vm`, default
  `test:e2e`, `pnpm check`, and beta Discord/OpenClaw proof.

Accepted follow-ups
-------------------

- Runtime should reject unknown `zone_git_push` Tool Portal arguments instead of
  silently dropping extra fields.
- `tool_vm_runner` config accepted by contracts but runtime scans all profiles
  and hard-fails on inactive profiles. Either implement runtime support or
  reject/preflight in a scoped way.
- Managed configuration docs still imply `hmacKey` participates in managed
  OpenClaw approval-token verification; update docs/audit coverage.

Rejected or deferred candidates
-------------------------------

- Event 183 signer material exposure appears fixed: parent and whole-source
  trace found private signer material moved out of guest-visible runtime state.
- Event 184 controller restart semantics correction appears honest: staged docs
  now define controller restart/redeploy as a recreate boundary, not same-VM
  adoption.
- Terminal e2e freshness is not a new implementation defect by itself because
  the packet already marks it as a required later gate; it remains a mandatory
  pre-PR proof gate after accepted fixes.

Source trace
------------

review_class: source-backed / plan-backed / risk-triggered
source_coverage_state: covered with accepted implementation defects
source_backed_verdict_attempted: true
whole-source-trace: completed
classifier_reason: architecture cutover, security boundary, runtime authority,
plugin/MCP surface, public capability, and plan-backed staged implementation.

Routing follow-through
----------------------

phase_result: needs_revision
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Accepted blocker and important implementation
findings require implementation fixes and focused proof before another review
swarm or terminal PR-ready proof.
