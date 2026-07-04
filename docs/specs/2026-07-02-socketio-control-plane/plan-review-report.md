# Plan Review Report - Socket.IO Control Plane Hard Cutover

Historical status:
- This report records the first independent plan review. Its accepted findings
  have been folded into `implementation-plan.md`, `lanes/validation-proof.md`,
  and the slice files. Do not treat the original "needs revision" verdict below
  as the current execution status.

Review target:
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`

Verdict:
- Needs revision before `implementation-execute-plan`.
- Do not implement code from the current plan yet.

Mode:
- Read-only plan review.
- No implementation files or plan files were changed by this review.

## Coverage

Files read end to end:
- `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md` - 344 lines at the time of review.
- `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md` - 71 lines at the time of review.
- `docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md` - 55 lines at the time of review.
- `docs/specs/2026-07-02-socketio-control-plane/lane-packet-shared.md` - 109 lines at the time of review.
- `docs/specs/2026-07-01-socketio-control-protocol-semantics.md` - 958 lines.
- `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md` - 2382 lines after follow-up schema fix.

Reviewer lanes:
- `whole-plan-cohesion`: completed; needs revision.
- `spec-compliance + execution-scope`: completed; needs revision.
- `testability-validation`: completed; needs revision.
- `security-reliability + architecture-assumptions + adversarial-design`: completed; needs revision.

All four subagents were closed after completion.

## Accepted Blockers

### 1. GATE-0a under-proves the real OpenClaw placement, and the runtime version is not stable.

Evidence:
- Plan gates on exact delivered OpenClaw runtime proof and a pre-S1 throwaway spike at `implementation-plan.md:39`.
- The same spike only promises request inspection and pre-101 reject/accept behavior at `implementation-plan.md:39-45`.
- Version rule note: OpenClaw `v2026.6.5` is the minimum accepted runtime for this PR. A newer OpenClaw may be
  selected only when fresh GATE-0a/runtime evidence shows it materially helps or is required.
- The hard-cutover spec requires the plugin route contract to prove HTTP readiness, `handleUpgrade(req, socket, head)`, detached Socket.IO handoff, pre-101 auth, and no second port.

Failure scenario:
- The spike passes against local or remembered SDK declarations, but the managed VM runtime has a different OpenClaw route API. S1/S2/S5 then build around a placement that cannot ship.

Smallest plan edit:
- Make GATE-0a first resolve the exact OpenClaw runtime artifact used by the generated managed image or overlay.
- Prove a real detached Socket.IO/Engine.IO server through that exact plugin `handleUpgrade`.
- Require a Socket.IO client connection over `/__agent-vm/gateway-control`, `transports: ["websocket"]`, good credential success, bad credential rejected before 101, no second port, and a STOP if any part fails.
- Keep `v2026.6.5` as the minimum target and prove the delivered runtime is actually the selected runtime.

Proof expected:
- Generated Dockerfile/package-plan assertion.
- In-VM `openclaw --version`.
- SDK compatibility against that exact runtime.
- Good/bad WebSocket upgrade proof with rejection before 101.

### 2. The proof matrix is circular and not command-ready.

Evidence:
- Original reviewed plan pointed at `lanes/validation-proof.md` for the full proof matrix at
  `implementation-plan.md:292`.
- `lanes/validation-proof.md` says the full matrix is in the implementation plan at `validation-proof.md:3-4`.
- What exists is proof-family summaries, not row-level requirement -> source ref -> owner -> command/project -> red/green -> freshness details.

Failure scenario:
- Implementation agents can satisfy broad family labels while skipping exact negative tests for nonce replay, stale liveness, no polling, queue overflow, route residue, or generated manual residue.

Smallest plan edit:
- Put the actual matrix in exactly one canonical artifact and link one-way from the other.
- Each row needs: requirement id, source anchor, owner slice, files, test name or command, expected red signal, expected green signal, freshness guard, and split trigger.

Proof expected:
- A reviewer can sample any load-bearing source proof expectation and find an exact planned test/command row.

### 3. Server-side disposition is incomplete for old managed HTTP routes.

Evidence:
- The hard-cutover spec names old route families that must be deleted or operator-auth-gated: `/lease*`, `/zones/:zoneId/health-events`, gateway runtime-status publish, and `POST /zones/:zoneId/zone-git/push` at `gateway-control-session-hard-cutover.md:468-469`.
- Plan S4b covers `/lease` at `implementation-plan.md:143-150`.
- Plan S6b covers health-events at `implementation-plan.md:186`.
- No slice clearly disposes `/zones/:zoneId/openclaw-runtime-status` or `POST /zones/:zoneId/zone-git/push`.
- Live routes exist at `packages/agent-vm/src/controller/http/controller-http-routes.ts:771` and `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts:388`.

Failure scenario:
- VM-originated callers are removed, but shippable HTTP fallback mutation routes remain, preserving the old control surface after the Socket.IO cutover.

Smallest plan edit:
- Add one old-controller-route disposition task/table listing every removed route family:
  - `/lease` and `/lease/:leaseId/*`
  - `/zones/:zoneId/health-events`
  - `/zones/:zoneId/openclaw-runtime-status`
  - `/zones/:zoneId/zone-git/push`
- For each route, choose delete or operator-auth-gate, assign an owner slice, and attach a residue proof row.

Proof expected:
- Integration tests assert each removed route returns 404 or each retained route requires operator/admin authorization.

### 4. Gateway control contract population misses non-lease operations.

Evidence:
- Plan S4a says it will populate `gateway-control-contracts/**` lease/use schemas at `implementation-plan.md:134`.
- The hard-cutover spec requires the gateway operation union to include non-lease operations such as `health_event`, `runtime_status`, `tool_portal_controller_host_action`, `operation_cancel`, and `recovery_command` at `gateway-control-session-hard-cutover.md:975-987`.
- S6/S7 discuss behavior, but no slice owns adding these operations to the shared gateway domain union/schema.

Failure scenario:
- Lease RPC parity lands, but health/runtime/recovery/cancel/host-action messages become ad hoc or absent from the normative Zod/JSON Schema contract.

Smallest plan edit:
- Expand S4a into full gateway-control contract population, or explicitly assign S6/S7 contract writes while keeping one owner for the shared `GatewayControlRpcOperationSchema` and message union.

Proof expected:
- Unit tests assert the operation enum/message union includes every spec operation, rejects missing/extra operations, and enforces envelope/domain/operation consistency.

### 5. OPEN-4 does not define an executable cutover proof gate.

Evidence:
- Plan says the env-gated cutover proof is required at `implementation-plan.md:266-268`.
- The line includes `AGENT_VM_GONDOLIN_E2E=1 (GIT-1)` without a command.
- `package.json` has concrete scripts for `test:e2e:vm`, `test:e2e:openclaw`, and `test:e2e:worker`.
- `scripts/run-e2e-proof-lanes.ts:6` confirms the default `pnpm test:e2e` excludes OpenClaw and Worker e2e projects.

Failure scenario:
- An executor runs the broad default gate plus `pnpm check`, misses INGRESS-1, FLAP-1b, Worker control, or GIT-1, and still thinks the cutover proof passed.

Smallest plan edit:
- Replace OPEN-4 with exact required commands and approval/CI disposition. Candidate shape:
  - `mise exec -- pnpm run test:e2e:openclaw`
  - `mise exec -- pnpm run test:e2e:worker`
  - `mise exec -- pnpm run test:e2e:vm`, or a named evidence-project command for GIT-1.

Proof expected:
- Each named evidence wrapper reports nonzero tests, zero skipped, and zero todo.

## Accepted Important Findings

### 1. OPEN-2 collector isolation cannot be allowed to ship as a hard cutover gap.

Evidence:
- Plan lets S5a/S5b proceed while S5c collector fail-closed is blocked on OPEN-2 at `implementation-plan.md:168` and `implementation-plan.md:332`.
- The hard-cutover stop condition says do not proceed to implementation planning if collector-mode observability can still create managed gateway raw `tcpHosts` without an accepted replacement or exception at `gateway-control-session-hard-cutover.md:2375`.

Plan edit:
- Clarify that S5a/S5b may be preparatory only.
- Final cutover/release cannot ship until S5c is resolved or an accepted spec exception exists.

### 2. The active-use stale constant is anchored to the wrong current value.

Evidence:
- Plan says `heartbeat-stale` is `90_000 ms` and equals current code at `implementation-plan.md:62`.
- Live code sets `heartbeatStaleMs: 2 * 60 * 1000` at `packages/agent-vm/src/controller/leases/lease-manager.ts:163`.

Plan edit:
- Use `120_000 ms`, or explicitly declare `90_000 ms` as an intentional behavior change with rationale and proof.

### 3. S5 does not explicitly own `allowedHosts` removal.

Evidence:
- The spec requires delivered managed gateway VM `allowedHosts` to remove `controller.vm.host` at `gateway-control-session-hard-cutover.md:566`.
- Plan S5 names `tcpHosts`, `websocketBypass`, monitors, and image identity, but not `allowedHosts`.
- Live OpenClaw VM spec builds `allowedHosts` at `packages/openclaw-gateway/src/openclaw-lifecycle.ts:1011`.

Plan edit:
- Add S5a write/proof for both `tcpHosts` and `allowedHosts`, with a planted positive residue fixture.

### 4. Public controller key custody is too casually specified.

Evidence:
- Plan says the controller public key is provisioned as plain VM env at `implementation-plan.md:309`.
- Runtime env values are merged into VM env at `packages/gateway-interface/src/split-resolved-gateway-secrets.ts:108`, then gateway lifecycles spread env into VM specs.

Failure scenario:
- Authored runtime env collides with `AGENT_VM_CONTROL_PUBLIC_KEY`, causing the VM to verify a forged controller signature.

Plan edit:
- Reserve internal control env names.
- Inject controller-owned control boot material after user/runtime env.
- Reject authored/runtime secret/env collisions.

### 5. Worker git RPC policy lacks a trusted state source for `expectedHead` and protected branches.

Evidence:
- Spec requires protected branch refusal and `expectedHead` as a fast-forward precondition at `gateway-control-session-hard-cutover.md:1870-1886`.
- Plan SWa only says "git payloads" at `implementation-plan.md:216`.
- Current push request schema only has `repoUrl` and `branchName` at `packages/agent-vm/src/controller/http/controller-request-schemas.ts:126`.
- `ActiveWorkerTaskRepo` does not carry protected branch policy at `packages/agent-vm/src/controller/active-task-registry.ts:25`.

Plan edit:
- SWa must define worker git payload fields and the trusted controller-side policy source.
- SWc must add controller-side pre-push checks.

### 6. Nonce consume-before-101 needs failed-handoff and TTL semantics.

Evidence:
- Plan requires atomic consume before 101 and duplicate rejection at `implementation-plan.md:47`.
- The shared protocol requires the VM to atomically consume the nonce/signature before the Socket.IO upgrade is accepted at `socketio-control-protocol-semantics.md:892`.
- The plan does not define what happens if validation consumes the nonce and Engine.IO/Socket.IO handoff fails before a usable session exists.

Plan edit:
- Add a nonce state machine: `issued -> consuming -> accepted | failed | expired`.
- Define fresh-ready retry behavior, pending TTL cleanup, and duplicate valid nonce handling without incumbent eviction.

### 7. Recovery per-source budget is spoofable unless the source key is controller-owned.

Evidence:
- Plan introduces a per-source observation budget at `implementation-plan.md:76` and S6b at `implementation-plan.md:186`.
- Spec requires observations to be advisory and per-source budgeted at `gateway-control-session-hard-cutover.md:2302`.

Plan edit:
- Define the budget key from controller-owned identity: domain, zone, VM id, boot id, and generation.
- Do not trust self-reported payload source fields for budget identity.

### 8. Ingress e2e harness target is inconsistent.

Evidence:
- `validation-proof.md:56` says the Socket.IO ingress e2e rig should extend `openclaw-lifecycle.host.e2e.test.ts`.
- `vitest.config.ts:230-231` shows `e2e-openclaw` only includes `packages/**/*.openclaw.e2e.test.ts`.

Plan edit:
- Put INGRESS-1/FLAP-1b in a `*.openclaw.e2e.test.ts` if the gate is `e2e-openclaw`, or intentionally change the gate to the host project. Do not mix suffix and project names.

### 9. identityPem custody proof is narrower than the spec.

Evidence:
- Plan S4a says `identityPem never logged` at `implementation-plan.md:138`.
- Spec requires frames carrying `identityPem` never appear in logs, traces, or exports, and only the single accepted current-generation session receives them at `gateway-control-session-hard-cutover.md:2312-2313`.

Plan edit:
- Expand L.1 to logs, traces, exports, diagnostics, duplicate-session delivery, and stale-generation delivery.

### 10. Worker task HTTP regression proof is too weak as "2xx".

Evidence:
- Plan says Worker POST/GET/close routes still return 2xx at `implementation-plan.md:233-234`.
- Spec says Worker task submit/state/close remain the task-control path at `gateway-control-session-hard-cutover.md:191`.
- Live code posts a Worker task and polls state at `packages/agent-vm/src/controller/worker-task-runner.ts:851`.

Plan edit:
- Replace "2xx" with semantic assertions: submit accepted with `taskId`, state is observable and transitions or reaches terminal state, and close cancels or terminalizes correctly.

### 11. Residue audits need an explicit shippable-surface allowlist and generated manual coverage.

Evidence:
- Spec requires stale docs/manuals to be removed at `gateway-control-session-hard-cutover.md:2340`.
- Current generated manual text still defines `gateway-control-link` through `controller.vm.host:18800` at `packages/agent-vm/src/cli/manual-templates.ts:188`.
- Plan residue rows do not distinguish forbidden shippable docs/manual outputs from allowed historical specs/tests/fixtures.

Plan edit:
- Add a residue-audit contract: forbidden shippable surfaces, allowed historical/spec/test fixtures, planted positives, generated manual template coverage, and generated manual output coverage.

## Questions For Plan Revision

1. Is Q1 really a spec decision?
   - The spec already allows delete or operator-auth-gate at `gateway-control-session-hard-cutover.md:468-470`.
   - This likely should be a user implementation decision before S4b, not another spec-creation loop, unless there is a deeper semantic question.

2. Where does GIT-1 live?
   - If receive-pack denial is pure Gondolin host-boundary behavior, it likely belongs in `e2e-vm`.
   - If it needs managed OpenClaw runtime context, it belongs in `e2e-openclaw`.
   - The plan needs to pick the owning project and file suffix.

3. OPEN-2 needs a product/spec call before final hard-cutover shipment.
   - Preparatory work can continue only if the plan states clearly that final cutover cannot ship with collector raw TCP still possible.

## Suggested Route

Return to `plan-creation-swarm` to revise the implementation plan with the accepted blockers and important findings.

Use `spec-creation-swarm` only for the unresolved product/spec choices that truly need new semantics, especially OPEN-2 if collector-mode observability needs a replacement or exception.

Do not proceed to `implementation-execute-plan` until:
- GATE-0a proves the exact runtime placement.
- OPEN-4 has exact executable proof commands.
- The route disposition table is complete.
- The proof matrix is canonical and row-level.
- The hard-cutover residue gates include routes, VM specs, generated manuals, package identities, and old raw-control vocabulary.
