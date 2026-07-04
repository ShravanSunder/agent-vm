Socket.IO Control Plane Post-Event-168 Review Reducer
=====================================================

Review packet:
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/review-packet.md

Reviewer lanes reduced:
- whole-source trace: 019f2a9c-19df-7293-be37-1cf483d8cb0b
- implementation proof: 019f2a9c-a8db-7fa2-9d3b-16e8d89a6f8a
- security/trust boundary: 019f2a9c-af6c-74c2-b333-0c26ddb68dbe
- runtime/reliability: 019f2a9c-b5cd-72e3-8281-72e6e6b404b6
- contracts/tests/PR hygiene: 019f2a9c-bc9d-7e20-9ea1-a08986075905

Parent verification:
- `pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts -t 'provisions plugin verifier config and connects the gateway control session after ingress'`
  exited 1 on the current staged tree. The test still sends
  `toolPortalAgentId` and omits required `payload.callerContext`.
- `AGENT_VM_OPENCLAW_E2E=1 mise exec -- pnpm vitest run --config vitest.config.ts --project e2e-openclaw packages/agent-vm/src/integration-tests/openclaw-zone-git.openclaw.e2e.test.ts`
  exited 1 on the current staged tree with `Controller host action failed.`
- `pnpm exec tsx scripts/verify-portal-package-exports.ts` exited 0, but
  inspection confirmed the verifier imports source-mapped `src/*.ts` modules
  from `package.json.exports` instead of the real built export targets.

Verdict:
- not_ready

Accepted blocker findings:

1. Fresh managed Tool Portal `zone_git_push` fails without a prior lease caller
   context.
   Evidence:
   - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.ts:240
   - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.ts:344
   - parent OpenClaw e2e rerun exited 1 with `Controller host action failed`.
   Required fix:
   - Add a trusted caller-context issuance path for Tool Portal
     `tool_portal_controller_host_action` that does not depend on prior
     Tool VM lease creation.

2. Managed OpenClaw still lets the plugin choose trusted agent identity.
   Evidence:
   - packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.ts:68
   - packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.ts:161
   - packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts:44
   Required fix:
   - Stop treating a plugin-supplied `agentId` plus agent-shaped `sessionKey`
     as a trusted binding. Controller-owned caller-context issuance must reject
     forged agent identity.

3. Gateway and Worker peers advance sequence state before an accepted ack.
   Evidence:
   - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts:580
   - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts:674
   - packages/agent-vm-worker/src/control-session/worker-control-service.ts:644
   - packages/agent-vm-worker/src/control-session/worker-control-service.ts:737
   Required fix:
   - Advance peer sequence only after `emitWithAck` returns an accepted
     receipt. Handler-generated responses must not record sequence before ack.

4. Gateway orchestrator integration proof is false on the current tree.
   Evidence:
   - packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts:3464
   - parent focused integration rerun exited 1 with missing
     `payload.callerContext` and unrecognized `toolPortalAgentId`.
   Required fix:
   - Update the integration test and expectations to the current
     `callerContext` wire contract.

Accepted important findings:

1. Portal export verifier still proves source modules, not shipped package
   exports.
   Evidence:
   - scripts/verify-portal-package-exports.ts:158
   Required fix:
   - Validate real built/package export targets, not source-mapped modules.

2. Beta Discord/OpenClaw proof is stale relative to the current staged runtime.
   Evidence:
   - tmp/workflow-state/2026-07-02-socketio-control-plane/details.md records
     Event 161 beta proof; Event 169 only records review packet and `pnpm check`.
   Required fix:
   - Refresh beta proof after accepted runtime fixes land.

Accepted follow-ups:

1. Upgrade-path exceptions can strand consumed credentials without
   `terminalAtMs`.
   Evidence:
   - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts:918
   - packages/agent-vm-worker/src/control-session/worker-control-service.ts:979

2. `scripts/live-sandbox-manual.mjs` still exercises raw
   `controller.vm.host:18800`.
   Classification:
   - Follow-up unless the hard-cutover audit starts treating manual sandbox
     scripts as shippable managed runtime. It is not package runtime, but it can
     create false-green manual proof.

3. `vitest.config.ts` still has a deleted `credentialed-runner-boundary` alias.
   Classification:
   - Nit, safe cleanup.

Rejected / deferred:

1. SG repo allowlist as a blocker.
   Reason:
   - The accepted SG slice explicitly scopes this cutover to host-boundary Git
     read/write policy: allow `git-upload-pack`, deny `git-receive-pack`, and
     keep optional repo allowlisting for future callers that have a trusted
     repo set. Current OpenClaw and Worker lifecycle builders are zone-level and
     do not receive the task/zone repo list in this cutover.

Route:
- Back to shravan-dev-workflow:implementation-execute-plan.

phase_result: needs_revision
evidence: five reviewer lanes reduced; parent reran focused gateway orchestrator integration and OpenClaw zone-git e2e, both failed on the current staged tree; accepted blockers require implementation fixes.
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: Current staged implementation is not review-ready until accepted blocker/important findings are fixed and fresh proof reruns.
