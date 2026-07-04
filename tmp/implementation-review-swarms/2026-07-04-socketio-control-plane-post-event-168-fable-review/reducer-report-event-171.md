Implementation Review Reducer Report - Event 171
================================================

Verdict
-------

not_ready

Reason:
- The post-Event-170 staged fixes are improved, but the current staged code still
  has accepted authority-boundary blockers in managed OpenClaw Tool Portal /
  gateway control.
- The staged proof is also incomplete for response ack/sequence behavior,
  Worker reconnect idempotency, package export freshness, and final PR-ready
  standalone lint/beta proof.

Scope
-----

- Mode: implementation review
- Review class: source-backed, plan-backed, risk-triggered
- Whole-source trace: required and completed
- Reviewed diff: staged branch `mcp-portal-better-interface` against
  `origin/master`
- Packet:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`

Reviewer Lanes
--------------

- Whole-source trace: `019f2ac7-8c71-7063-affc-4a7a5319163f`, completed and closed.
- Security/trust: `019f2ac7-bf7f-7af2-871d-0b161b7276bb`, completed and closed.
- Implementation proof: `019f2ac7-e263-79b3-b3ad-fb581016eddf`, completed and closed.
- Runtime/reliability: `019f2ac8-07a3-7773-8191-c160dbccb3a6`, completed and closed.
- Contracts/tests: `019f2ac8-2f68-7831-b15e-6967bf4ff9b9`, completed and closed.

Accepted Findings
-----------------

1. blocker - Empty `zones[].agents` lets a compromised gateway/plugin choose a
   trusted OpenClaw agent identity.

   Evidence:
   - `packages/agent-vm/src/config/system-config.ts:804` keeps
     `zones[].agents` optional.
   - `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts:73-83`
     validates caller-context agent membership only when configured agent IDs
     exist.
   - `packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts:49-58`
     only proves the session key is agent-shaped and internally matches
     `agentId`.
   - `packages/agent-vm/src/controller/leases/openclaw-tool-vm-lease-create-options.ts:65-74`
     similarly skips undeclared-agent rejection when the configured set is
     empty.

   Scenario:
   A compromised in-VM plugin in a zone with no declared `zones[].agents` can
   register `agent:admin:*` as long as the sessionKey and `agentId` match each
   other, then select controller Tool Portal / Tool VM profile authority for an
   undeclared agent.

   Smallest fix:
   Fail closed for managed OpenClaw control when `zones[].agents` is empty, or
   synthesize one explicit trusted default agent and reject every other agent.
   Validate Tool Portal agents and `agentToolVmProfiles` as subsets of declared
   zone agents.

   Proof:
   Config validation coverage for empty-agent managed Tool Portal /
   `agentToolVmProfiles`, plus a controller integration/unit test that forged
   `agent:admin:*` caller-context registration is rejected.

2. blocker - Managed effective Tool Portal config grants `zone_git_push` to
   every profile.

   Evidence:
   - `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts:123-147`
     builds Tool Portal config for all authored profiles.
   - `packages/agent-vm/src/gateway/mcp-portal-effective-config.ts:189-207`
     injects `controller_host_action.zone_git_push` with `withoutApproval`
     into every profile when zone git is enabled.
   - `packages/agent-vm/src/controller/control-session/gateway-control-controller-host-action-authorization.ts:103-150`
     re-derives authorization from that same generated config.

   Scenario:
   A read-only or intentionally narrow profile gets `zone_git_push` despite
   never authoring that capability. The model can list/call it and controller
   re-authorization permits it because the generated policy already injected it.

   Smallest fix:
   Stop unconditional injection. Require an explicit trusted per-profile
   binding for `controller_host_action.zone_git_push`, or fail closed when no
   binding exists.

   Proof:
   Unit coverage with two profiles where only the explicitly authorized profile
   can list/call/authorize `controller_host_action.zone_git_push`.

3. blocker - Caller-context cache is purpose-blind, allowing lease contexts to
   be replayed as controller-host-action contexts and causing stale-context
   failures after controller runtime rebuilds.

   Evidence:
   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-caller-context-store.ts:1-20`
     keys one shared cache only by `agentId`.
   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.ts:344-381`
     writes lease caller contexts into that shared agent cache.
   - `packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.ts:67-76`
     skips host-action `caller_context_register` whenever any cached context
     exists for the agent.
   - `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts:324-375`
     does not reject non-`tool_portal_controller_host_action` caller contexts
     before authorizing/executing controller host action.
   - `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts:1003-1010`
     creates a fresh controller-side caller context registry when session
     runtime is rebuilt.

   Scenario:
   A prior Tool VM lease caches a `tool_vm_lease` callerContextId. Later
   `tool_portal_call` reuses it for `zone_git_push` instead of registering a
   host-action-specific context. After controller restart, the plugin can also
   keep a stale cached ID while the controller registry no longer knows it.

   Smallest fix:
   Key the plugin cache by purpose and current accepted session/generation, and
   have controller-host-action reject caller contexts whose purpose is not
   `tool_portal_controller_host_action`. Clear/re-register on stale/absent
   caller-context responses.

   Proof:
   Tests that seed a lease context then call Tool Portal host action and prove a
   fresh host-action registration occurs; tests that stale cached context
   refreshes after a rebuilt controller registry.

4. important - Handler-generated response envelopes allocate peer sequence
   before accepted receipt.

   Evidence:
   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts:578-591`
   - `packages/agent-vm-worker/src/control-session/worker-control-service.ts:642-655`
   - `nextPeerSequence()` mutates sequence state in both services before
     `emitWithAck` has returned an accepted receipt.

   Scenario:
   If a handler response receives a rejected/timeout transport receipt, the
   service has already advanced `nextPeerSequenceValue`. A later outbound
   message on the same connection can skip a peer sequence that was never
   accepted by the controller.

   Smallest fix:
   Reserve/commit outbound response sequence only after accepted ack, or provide
   rollback for rejected/time-out response sends. Add negative receipt and
   timeout coverage for gateway and worker handler-response paths.

   Proof:
   Integration tests that force rejected/timeout receipts for handler-generated
   responses and prove the next successful outbound response does not self-gap.

5. important - Worker git push/pull lose exactly-once semantics across
   ack-before-result control-session flaps.

   Evidence:
   - `docs/specs/2026-07-02-socketio-control-plane/slices/11-swc-worker-rpc-rewire.md:36-41`
     requires redelivery idempotently on reattach.
   - `packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.ts:118-186`
     creates a new `commandId` per tool invocation and has no reconnect replay
     path.
   - `packages/agent-vm/src/controller/control-session/control-session-dispatcher.ts:106-119`
     dedupes by `commandId` and `idempotencyKey` together.

   Scenario:
   The controller acks `git_push`, performs the host operation, then the session
   drops before `command_result`. A retried worker tool call creates a new
   command identity, so controller dedupe will not collapse the retry.

   Smallest fix:
   Preserve stable retry identity for in-flight Worker git commands across
   reconnect/reattach and resend with the same `commandId` and `idempotencyKey`.

   Proof:
   Worker integration/e2e test that drops after transport ack but before result,
   reconnects, and proves one terminal result and one controller-side operation.

6. important - `test:portal-exports` can still prove stale workspace `dist`
   artifacts and misses the new Tool Portal in-process named export.

   Evidence:
   - `scripts/verify-portal-package-exports.ts:167-199` imports mapped
     workspace `./dist/*.js` files from package exports.
   - `scripts/verify-portal-package-exports.ts:32-117` has no named-export
     requirement for `@agent-vm/tool-portal/in-process-entrypoint`.
   - `packages/tool-portal/src/in-process-entrypoint/index.ts:1-2` exports the
     newly added managed runtime surface.
   - `package.json:9-22` keeps `build` separate from `check`.

   Scenario:
   A source/export map regression can be masked by stale `dist` output, and the
   verifier would not prove `createManagedToolPortalInProcessRuntime` is present
   even when the import specifier resolves.

   Smallest fix:
   Verify a fresh build/pack artifact, and assert required named exports for
   `@agent-vm/tool-portal/in-process-entrypoint`.

   Proof:
   Verifier fails if the in-process named export is missing and fails on a stale
   source-vs-dist fixture or packed package with missing exported file.

7. important - Standalone `pnpm lint` proof is still missing from the accepted
   PR-ready proof contract.

   Evidence:
   - `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md:127-133`
     lists `pnpm lint` as an always-run companion gate.
   - `scripts/run-check-gate.ts:63-115` runs `lint:types`, not standalone
     `lint`.

   Scenario:
   The packet can say `pnpm check` is green while the documented `pnpm lint`
   gate has not run.

   Smallest fix:
   Either run and record `pnpm lint` before PR-ready status, or update the
   accepted proof contract if standalone lint is intentionally no longer
   required.

   Proof:
   Fresh final proof includes `pnpm lint` exit 0.

Accepted Follow-Ups / Scope Drifts
----------------------------------

- Worker control cancel/recovery remains contract-only; either implement the
  inbound handler/emitter path or narrow the plan/spec wording if this cutover
  intentionally keeps cancel/recovery outside `worker_control`.
- Worker git payloads still expose `taskGeneration` and `command` identity
  mirrors that the controller does not fully validate. Prefer removing unused
  mirrors or validating them against the authenticated session/envelope.
- Add a regression pinning the implemented lease-purpose guard, so
  `tool_portal_controller_host_action` caller contexts cannot mint Tool VM
  leases after refactor.

Rejected / Deferred
-------------------

- Beta Discord/OpenClaw proof freshness remains a terminal PR-ready gate, not a
  blocker to this review pass by itself. It must be refreshed after accepted
  implementation findings are fixed.
- `scripts/live-sandbox-manual.mjs` raw-controller residue was not promoted to
  an accepted blocker in this pass because stronger managed-runtime blockers
  already route the work back to execution; re-check residue before PR-ready.

Review Proof
------------

- Source trace covered the named Event 170/171 obligations.
- Reviewer outputs were verified against current staged source before
  acceptance.
- No external Fable result was reduced in this report; the copy-paste Fable
  packet remains available for an outside review lane.

Source Trace Summary
--------------------

- review_class: source-backed, plan-backed, risk-triggered
- source_coverage_state: covered with accepted deviations
- source_backed_verdict_attempted: true
- whole-source-trace: completed
- accepted_route_target: `shravan-dev-workflow:implementation-execute-plan`

Routing Follow-Through
----------------------

Route back to implementation execution. Fix accepted blocker/important findings,
rerun focused proof, then rerun implementation review before terminal e2e,
beta Discord/OpenClaw proof, and PR-ready non-merge wrapup.
