Event 189 Implementation Review Reducer Report
==============================================

Verdict
-------

not_ready

Reason:

- One blocker and several important findings survived source verification after
  Event 188.
- The branch is still review-active, not PR-ready. Runtime e2e and beta
  Discord/OpenClaw proof remain terminal gates after these findings are fixed or
  explicitly rejected with evidence.

Review Inputs
-------------

Reviewed as raw candidate findings:

- Post-Event-188 implementation review handoff candidate list.
- Current staged source against `origin/master`.
- Current review packet:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md`
- Event 188 execution report:
  `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-188.md`

The reducer did not find fresh lane transcript files beyond the review packet
directory. Candidate findings were therefore verified directly against current
source before acceptance.

Accepted Findings
-----------------

1. blocker: controller-authored managed Tool Portal configs are guest-writable

   Evidence:

   - `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts:520`
     writes effective Tool Portal config under
     `cacheDir/gateways/<zone>/tool-portal-effective`.
   - `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts:526`
     points the VM-side config dir at
     `/home/openclaw/.openclaw/cache/tool-portal-effective`.
   - `packages/openclaw-gateway/src/openclaw-lifecycle.ts:1153`
     mounts the whole OpenClaw cache as `realfs`.
   - `docs/subsystems/gondolin-vm-layer.md:131` documents `realfs` as
     read/write shared host/guest storage.
   - `packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.ts:81`
     trusts the effective-config manifest; lines 86-90 join manifest-selected
     filenames under the config dir without proving they remain inside it.

   Scenario:

   A compromised gateway VM can rewrite the controller-authored effective MCP /
   Tool Portal config before or during runtime consumption. That undermines the
   cutover's trusted-caller-context model because policy and backend selection
   can be changed from the guest side after the controller materializes them.
   Manifest filename traversal is a second-order risk once the manifest is
   writable.

   Smallest fix:

   Mount controller-authored effective config through `realfs-readonly` or a
   separate readonly mount, not the writable cache mount. Validate effective
   manifest filenames as relative safe filenames whose resolved path stays
   inside the config directory.

   Proof:

   Add OpenClaw lifecycle/orchestrator coverage asserting the effective Tool
   Portal config path is readonly from the VM. Add unit coverage for manifest
   path traversal rejection.

   Confidence: high
   Security validation: validated

2. important: post-ack handler exceptions are reported as timeouts

   Evidence:

   - `packages/agent-vm/src/controller/control-session/control-session-client.ts:612`
     acknowledges before dispatch; lines 626-627 dispatch afterward; lines
     656-662 can only try a rejection ack after the positive ack was already
     sent.
   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts:658`
     acknowledges before `applicationMessageHandler.handle`; lines 678-684 then
     attempt a rejection ack after a post-ack throw.
   - `packages/agent-vm-worker/src/control-session/worker-control-service.ts:720`
     has the same ack-before-handler shape; lines 740-746 attempt a late
     rejection ack.

   Scenario:

   The peer sees an accepted command, waits for a command result, and receives
   none when the handler throws after ack. The caller experiences an execution
   timeout instead of a deterministic failed `command_result`.

   Smallest fix:

   Split pre-ack validation from post-ack execution. After a positive ack, catch
   handler failures and emit a failed `command_result` with the original
   `responseToMessageId`. Reserve rejection receipts only for pre-ack parsing,
   bounds, domain, and delivery-policy rejection.

   Proof:

   Add controller, gateway-service, and worker-service tests where a handler
   throws after ack and the caller receives explicit failed command result, not
   timeout.

   Confidence: high

3. important: failed handler-response receipts leave reserved sequence holes

   Evidence:

   - `packages/agent-vm/src/controller/control-session/control-session-client.ts:631`
     reserves a response sequence before `emitWithAck`; line 654 swallows the
     response-send failure.
   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts:665`
     reserves a peer response sequence; lines 670-676 send asynchronously and
     swallow failures.
   - `packages/agent-vm-worker/src/control-session/worker-control-service.ts:727`
     reserves a peer response sequence; lines 732-738 send asynchronously and
     swallow failures.

   Scenario:

   A response frame reserves sequence N, receipt fails, and the session keeps
   going. The next successful frame at N+1 looks like a gap to the peer, so
   recovery is delayed and reported at the wrong boundary.

   Smallest fix:

   Treat failed receipt for a reserved handler response as session-stale: close
   the session and force reconnect/resync. Do not swallow reserved response
   receipt failures as harmless background noise.

   Proof:

   Add integration tests that force response `emitWithAck` rejection after
   reservation and assert session stale/close behavior instead of later sequence
   gap.

   Confidence: high

4. important: `zone_git_push` does not preserve command identity across
   ack-before-result flaps

   Evidence:

   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.ts:351`
     creates a fresh message id for each `zone_git_push` send.
   - Lines 354 and 361 derive fresh `commandId` and `idempotencyKey` from that
     message id.
   - `packages/gateway-control-contracts/src/index.ts:617` classifies
     `tool_portal_controller_host_action` as `single_use_critical`.
   - The Worker control RPC client keeps pending command identity per
     idempotency key in
     `packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.ts:64`.

   Scenario:

   If a controller-host-action git push succeeds but the command result is lost
   across an ack-before-result reconnect/flap, a retry gets a new command
   identity. The controller cannot dedupe the operation as the same critical
   command, and an `expectedHead` precondition can turn a successful prior push
   into a misleading retry failure.

   Smallest fix:

   Give `zone_git_push` a stable command identity for the logical Tool Portal
   call or idempotency key, and retain it across one transport retry until a
   terminal result is observed. Mirror the Worker git RPC identity-retention
   shape where appropriate.

   Proof:

   Add unit/integration coverage for lost result after accepted git push:
   retry reuses `commandId`, `messageId`, and `idempotencyKey`, and controller
   returns the terminal cached result.

   Confidence: high

5. important: `/leases` disposition is contradictory across plan, slice, code,
   and docs

   Evidence:

   - `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md:248`
     says `GET /leases` stays operator S4b.
   - `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md:254`
     says to keep `GET /leases` as an operator diagnostic.
   - `docs/specs/2026-07-02-socketio-control-plane/slices/05-s4b-controller-route-disposition.md:29`
     says `GET /leases` remains operator diagnostic only.
   - `packages/agent-vm/src/controller/http/controller-http-routes.unit.test.ts:848`
     now asserts active leases are not exposed via `GET /leases`.
   - `packages/agent-vm/src/integration-tests/gateway-api-http.integration.test.ts:171`
     verifies the old public lease list is not exposed over real HTTP.
   - `docs/architecture/openclaw-gateway.md:225` says lease visibility comes
     from status/health snapshot routes, not a public lease-list route.

   Scenario:

   The implementor has conflicting source-of-truth instructions. One reader
   will preserve or recreate `/leases`; another will delete it. That is a hard
   cutover footgun because route disposition is one of the public/private
   boundary decisions.

   Smallest fix:

   Make the plan and S4b slice match the implemented decision: `GET /leases`
   and `controller lease list` are removed in this cutover; any future operator
   diagnostic must be a separate authenticated/admin design.

   Proof:

   Update plan/slice text and keep the existing negative HTTP tests.

   Confidence: high

6. important: portal export verifier still misses runtime-consumed root exports

   Evidence:

   - `scripts/verify-portal-package-exports.ts:34` checks only
     `createPortalCallSurfaceJsonSchemas` from root `@agent-vm/agent-portal-sdk`.
   - `packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts:1`
     consumes many root `@agent-vm/agent-portal-sdk` exports such as
     `PortalCallRequestSchema`, `PortalCallResultSchema`,
     `PortalDescribeRequestSchema`, `PortalListRequestSchema`,
     `PortalSearchRequestSchema`, `JsonValueSchema`, and related types.
   - `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.ts:3`
     consumes root `@agent-vm/agent-portal-sdk` exports including portal call
     schemas and JSON value types.
   - `packages/tool-portal/src/cli-allowances/models/cli-allowance-schema.ts:3`
     consumes root `@agent-vm/controller-execution-contracts` exports, but the
     verifier only named-export checks the testing subpath at
     `scripts/verify-portal-package-exports.ts:84`.

   Scenario:

   A package build can pass the export audit while removing or failing to expose
   root runtime symbols consumed by other packages. That recreates the package
   export false-green this audit is meant to prevent.

   Smallest fix:

   Add the runtime-consumed root named exports for
   `@agent-vm/agent-portal-sdk` and `@agent-vm/controller-execution-contracts`
   to the verifier.

   Proof:

   `pnpm exec tsx scripts/verify-portal-package-exports.ts` should fail before
   the fix when a consumed root export is temporarily removed, then pass after
   the verifier list is complete.

   Confidence: high

7. important: Tool Portal request-schema proof is tautological for agent-facing
   JSON Schema

   Evidence:

   - `packages/agent-portal-sdk/src/portal-call-surface/portal-call-contracts.unit.test.ts:365`
     calls `createPortalCallSurfaceJsonSchemas()`.
   - Lines 368-372 compare those schemas to fresh `z.toJSONSchema(...)` output
     from the same Zod schemas.
   - The new control/gateway/worker contract packages now have reviewed static
     JSON Schema artifacts, but the agent-facing portal call surface does not.

   Scenario:

   A change in Zod schema generation or accidental schema drift can update both
   sides of the assertion at once. The test proves the helper calls Zod, not
   that the reviewed agent-facing JSON Schema contract remains stable.

   Smallest fix:

   Add a static reviewed JSON Schema snapshot for the portal call surface and
   compare generated output to that artifact.

   Proof:

   Unit test fails when the static portal call schema snapshot is stale and
   passes after intentional snapshot review/update.

   Confidence: high

8. important: PR-ready proof remains incomplete after Events 185-188

   Evidence:

   - `tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-188.md`
     lists focused unit/integration/static checks only.
   - The same report explicitly says terminal OpenClaw, Worker, VM, default
     e2e, and beta Discord/OpenClaw proof still need a fresh pass.

   Scenario:

   The branch is review-ready but not PR-ready. Calling it PR-ready now would
   overclaim runtime coverage after meaningful post-terminal fixes.

   Smallest fix:

   After accepted findings are fixed or rejected, rerun the terminal proof
   gates from the goal/plan: `mise exec -- pnpm run test:e2e:openclaw`,
   `mise exec -- pnpm run test:e2e:worker`, `mise exec -- pnpm run test:e2e:vm`,
   `mise exec -- pnpm test:e2e`, `pnpm check`, and live
   `../shravan-claw-beta` Discord/OpenClaw validation.

   Proof:

   Fresh command outputs and beta validation transcript/log pointers.

   Confidence: high

Follow-Ups
----------

1. follow-up: session-bound Tool Portal entrypoints and caller-context scopes do
   not evict

   Evidence:

   - `packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.ts:82`
     stores caller-context scope by entrypoint cache key.
   - Line 122 inserts session-scoped state, including raw `sessionKey` in the
     value, with no eviction path.
   - `packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.ts:122`
     caches entrypoints by cache key with no bound or lifecycle release.

   Scenario:

   A long-running gateway can retain stale session-scoped state and raw
   session keys in memory across many Tool Portal contexts. This is not yet
   proven as an immediate exploit path, but it conflicts with the long-running
   peer model and should be bounded or releasable.

   Smallest fix:

   Add explicit lifecycle release/TTL/bounded cache behavior and avoid retaining
   raw session keys longer than needed.

   Confidence: medium

2. follow-up: MCP-provider backend hard-codes OpenClaw provenance

   Evidence:

   - `packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts:127`
     creates agent scope with `source: 'openclaw-trusted'`.

   Scenario:

   The backend is now a Tool Portal backend boundary, but provenance is still
   OpenClaw-specific. This may be acceptable for the managed OpenClaw slice, but
   it should be revisited before using the backend for non-OpenClaw Tool Portal
   hosts.

   Smallest fix:

   Parameterize or document the provenance source at the backend factory
   boundary when another Tool Portal host lands.

   Confidence: medium

Rejected Or Not Accepted
------------------------

- No additional nit was accepted from the handoff without direct verification.
- Broad raw-string residue was not accepted from grep alone; prior notes were
  noisy and require reachability checks before becoming findings.

Review Proof
------------

review_class: source-backed, plan-backed, risk-triggered
source_backed_verdict_attempted: true
whole-source-trace: reduced from current source and handoff candidate list
source_coverage_state: partial; accepted findings route back to implementation

Routing
-------

phase_result: needs_revision
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: accepted blocker/important implementation and
source-contract findings remain after Event 188 and need fixes before another
implementation-review-swarm pass.
