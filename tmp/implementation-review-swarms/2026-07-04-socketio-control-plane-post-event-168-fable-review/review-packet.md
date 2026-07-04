Socket.IO Control Plane Post-Event-200 Fable Review Packet
==========================================================

Purpose
-------

This packet is for a fresh implementation review of the current committed
branch diff
after Event 185 accepted blocker/important findings were addressed, the
post-Event-186 Worker git RPC proof gap was fixed, the Event 188 internal review
fixes were folded in, the Event 189 accepted findings were fixed, the
post-Event-190 accepted findings were fixed in Event 191, the Event 192
Worker-control scope gap was fixed, the Event 193 post-Fable findings were
fixed, the Event 194 accepted findings were fixed, the Event 195 accepted
findings were fixed, and the post-Event-197 terminal proof repairs were folded
in.

Review the current repository state, not the older final-terminal review packet.
Older packets and reducers remain useful as finding history only:

- tmp/implementation-review-swarms/2026-07-03-socketio-control-plane-final-terminal-review/review-packet.md
- tmp/implementation-review-swarms/2026-07-03-socketio-control-plane-final-terminal-review/reducer-report.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-171.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-172.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-178.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-180.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-181.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-183.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-184.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-185.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-186.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-187.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-188.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-189.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-190.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-191.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-192.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-193.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-194.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-195.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-196.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/reducer-report-event-197.md
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/execution-report-event-200.md

Mode And Classifier
-------------------

mode: implementation
review_class: source-backed, plan-backed, risk-triggered
source_backed_verdict_attempted: true
whole-source-trace: required

Classifier reason:

- This is a pre-PR hard-cutover implementation review.
- It changes runtime authority, security boundaries, VM/plugin transport,
  public capability surfaces, agent/tool execution, MCP/Tool Portal routing,
  and OpenClaw/Worker control-plane behavior.
- Prior implementation-review swarms found real blocker/important findings.

Repository And Git Scope
------------------------

Repo:

```text
/Users/shravansunder/Documents/dev/project-dev/agent-vm.mcp-portal-better-interface
```

Branch/base:

```text
branch: mcp-portal-better-interface
HEAD: af018d2
base: origin/master 479ad73
working tree: expected clean
branch diff: `origin/master...HEAD`
inventory files: staged-name-status.txt and staged-stat.txt keep their legacy
  names from earlier staged review cycles, but now contain the committed branch
  diff against `origin/master`.
```

Review the committed branch diff against `origin/master` and the source
artifacts below. The branch file inventory is captured here:

- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-name-status.txt
- tmp/implementation-review-swarms/2026-07-04-socketio-control-plane-post-event-168-fable-review/staged-stat.txt

Accepted Request
----------------

Implement the Socket.IO-over-Gondolin control-plane hard cutover from the
accepted specs and reviewed vertical-slice plan through implementation, proof,
implementation review, and PR-ready non-merge wrapup.

Non-goals and hard boundaries:

- No OpenClaw sidecar control service.
- No Socket.IO polling fallback.
- No raw `controller.vm.host:18800` control fallback.
- No moving Worker task submit/state/close off ingress HTTP in this cutover.
- No control-socket bulk data path.
- No PR merge unless explicitly authorized.

OpenClaw version rule:

- OpenClaw `2026.6.5` is the minimum acceptable runtime.
- Current implementation remains on `2026.6.8` because current upstream package
  pins and managed image metadata use `2026.6.8`.
- Do not request a downgrade to `2026.6.5`.

Source Specs
------------

Read these source artifacts directly:

- docs/specs/2026-07-01-socketio-control-protocol-semantics.md
- docs/specs/2026-06-30-gateway-control-session-hard-cutover.md
- docs/specs/2026-06-25-tool-portal-composition-contract.md

Source plan and proof matrix:

- docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md
- docs/specs/2026-07-02-socketio-control-plane/slices/README.md
- docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md
- docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md
- docs/specs/2026-07-02-socketio-control-plane/relevant-file-profile.md

Workflow state:

- tmp/workflow-state/2026-07-02-socketio-control-plane/details.md
- tmp/workflow-state/2026-07-02-socketio-control-plane/events.jsonl

Important current-state note:

- `events.jsonl` is the official transition log. After this packet is staged,
  latest event should include Event 200, keeping the workflow in
  implementation-review-swarm after fresh VM/default e2e and `pnpm check`
  proof were restored.
- This packet was refreshed after accepted Event 185 findings were fixed:
  caller contexts now bind to gateway boot/session and evict/release by
  lifecycle, managed OpenClaw rejects runtime `mcp-portal` plugin config and
  strips stale base plugin config, Tool Portal consumes MCP Portal through the
  `mcp-provider-backend` adapter instead of `@agent-vm/mcp-portal/core`,
  unauthenticated `GET /leases` and `controller lease list` are removed,
  controller-host-action stale caller-context recovery retries once in the same
  call, failed accepted upgrade credentials are terminal-stamped for eviction,
  SSH Git read allowlisting derives generic trusted repo hosts and fails closed
  when no trusted repo allowlist exists, and managed `hmacKey` docs no longer
  imply OpenClaw approval-token behavior.
- This packet was also refreshed after the Worker git RPC proof gap was fixed:
  `worker-loop.worker.e2e.test.ts` now drives real Worker-originated
  `git_push` / `git_pull_default` RPCs through `executeWorkerTask`, the
  controller-created Worker control material, the Worker ingress control
  service, and `createWorkerControlDomainHandler`. The production Worker domain
  handler now returns a full `worker_control_rpc` command-result message wrapper
  instead of only the command-result payload.
- This packet was refreshed again after Event 188 internal review:
  Worker death-grace classification now requires accepted/ready control-session
  diagnostics instead of raw transport connection, Tool Portal controller host
  action caller contexts are released/evicted after terminal use, the export
  verifier checks runtime-consumed named exports, JSON Schema tests compare
  reviewed static artifacts, stale `lease-list` public vocabulary was removed,
  and the SG gateway orchestrator fixture now exercises `zoneGit` before
  asserting SSH Git egress policy.
- This packet was refreshed after Event 189 review:
  managed Tool Portal effective config is read-only in the OpenClaw guest and
  manifest paths are validated inside the controller-owned directory; post-ack
  handler exceptions produce explicit failed `command_result` messages when the
  domain supports them; failed reserved response receipts stale/close the
  session instead of leaving sequence holes; gateway `zone_git_push` retains
  message/command/idempotency identity across ack-before-result flaps; `/leases`
  route disposition is consistently delete; portal export verification includes
  root runtime exports; portal call JSON Schema tests compare a reviewed static
  snapshot.
- This packet was refreshed after Event 191:
  package export verification covers the newly reported missing runtime root
  exports; gateway/worker control package descriptions no longer say
  placeholder; gateway `zone_git_push` stale caller-context retry refreshes
  command/message/idempotency identity while accepted-result retries reuse
  identity; controller-mediated zone-git push refuses `main`/`master` before
  pushing; managed Tool Portal entrypoints have a bounded LRU-style cache; the
  OpenClaw plugin's temporary caller-context scope map is one-shot after
  entrypoint creation/failure.
- This packet was refreshed after Hilbert's post-Event-191 proof review:
  plain `pnpm lint` now passes and is included in `pnpm check`; the CI default
  e2e step is named as the default four-lane proof rather than all non-secret
  e2e proof; `staged-stat.txt` was documented as a self-referential review aid
  during staged review cycles. For this committed review cycle, use live
  `git diff --stat origin/master...HEAD` as the exact count source.
- This packet was refreshed after Event 193:
  failed Worker tasks now publish failed advisory runtime events; Worker
  advisory publishes are caught/logged instead of producing unhandled promise
  rejections; gateway trusted caller contexts are bound to `sessionId` and
  `connectionId`; Worker capacity and runtime status advisory events have
  explicit publisher/handler proof for latest-wins, no command identity, and no
  controller mutation side effects.
- This packet was refreshed after Event 192:
  Worker control now includes VM-side application handling for controller
  cancel/recovery commands, Worker-originated capacity/runtime observation
  event publishing, controller-side advisory observation persistence, exported
  Worker control payload types, and typed zone-git fixture repairs.
- This packet was refreshed after Event 194:
  controller-originated Worker `operation_cancel` is hard-rejected in
  `worker_control` so Worker task submit/state/close remain ingress HTTP-only
  for this PR; Gateway and Worker peer services coalesce latest-wins events and
  use volatile emits for latest-wins/droppable advisory traffic; MCP-backed Tool
  Portal sessions now thread session provenance into the MCP provider backend;
  the staged inventory and this review packet were refreshed at
  that checkpoint.
- This packet was refreshed after Event 195:
  lossy/advisory latest-wins and droppable packets no longer reserve or advance
  the hard critical sequence frontier; queued latest-wins flushes are ordered by
  envelope sequence before volatile emit; Worker `operation_cancel` has
  service-level and live active-task rejection proof; managed Tool Portal LRU
  eviction/runtime close retires session-scoped MCP provider backend/session
  state; active Tool VM lease ownership survives refreshed `callerContextId`,
  `sessionId`, and `connectionId` when stable controller-vetted provenance
  matches, while different agent/session-key provenance is rejected; root plan,
  canonical proof matrix, and slice files were updated for these semantics.
  The staged-review inventory was refreshed to 397 paths against
  `origin/master` at that historical checkpoint.
- This packet was refreshed after Event 200:
  the Worker e2e harness sequence-gap fix, host e2e fixture repairs, full VM
  gate, default e2e gate, and `pnpm check` refresh were checkpointed in commit
  `af018d2`. After that checkpoint, the review surface is the committed branch
  diff `origin/master...HEAD`, not the empty staged index.

Implementation Scope
--------------------

Major delivered surfaces to inspect:

- New shared control contract package:
  - packages/control-protocol-contracts/src/index.ts
  - packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts
- New gateway domain contract package:
  - packages/gateway-control-contracts/src/index.ts
  - packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts
- New worker domain contract package:
  - packages/worker-control-contracts/src/index.ts
  - packages/worker-control-contracts/src/worker-control-contracts.unit.test.ts
- Controller control-session runtime:
  - packages/agent-vm/src/controller/control-session/
- OpenClaw plugin-hosted gateway control service:
  - packages/openclaw-agent-vm-plugin/src/gateway-control-service/
  - packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts
- Worker VM control service and RPC client:
  - packages/agent-vm-worker/src/control-session/
  - packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.ts
  - packages/agent-vm/src/controller/control-session/worker-control-domain-handler.ts
- Raw-control and hard-cutover residue gates:
  - packages/openclaw-gateway/src/openclaw-lifecycle.ts
  - packages/worker-gateway/src/worker-lifecycle.ts
  - scripts/audit-portal-architecture.ts
- Tool Portal / MCP Portal public-surface cutover:
  - packages/tool-portal/src/in-process-entrypoint/
  - packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.ts
  - packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.ts
  - packages/mcp-portal/src/mcp-provider-backend/
  - packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.ts
  - packages/config-contracts/src/tool-portal-config.ts
  - packages/agent-portal-sdk/src/
- Managed image and OpenClaw version/provenance:
  - packages/agent-vm/managed-images.json
  - packages/agent-vm/src/build/managed-image-dockerfile.ts
  - packages/agent-vm/src/build/managed-image-release.unit.test.ts

Event 172 Findings To Verify As Fixed
-------------------------------------

Fable should specifically verify whether these Event 172 findings are actually
fixed in the current branch diff:

1. Managed OpenClaw plugin-supplied agent identity:
   - Expected fix: managed OpenClaw zones fail closed when `zones[].agents` is
     empty, and `agentToolVmProfiles` entries must reference declared agents
     and known profiles.
   - Additional Event 172 fix: caller-context registration fails closed for
     multi-agent OpenClaw zones until controller-signed agent attestation exists,
     so a compromised plugin cannot choose another declared agent.
   - Inspect:
     - packages/agent-vm/src/config/system-config.ts
     - packages/agent-vm/src/config/system-config.unit.test.ts
     - packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts
     - packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts
     - docs/getting-started/openclaw-guide.md

2. Managed `controller_host_action.zone_git_push` overgrant:
   - Expected fix: generated managed Tool Portal config does not grant
     `controller_host_action.zone_git_push` to every profile. Explicit authored
     `controller_host_action` is allowed only for the narrow
     `zone_git_push` binding.
   - Inspect:
     - packages/agent-vm/src/gateway/mcp-portal-effective-config.ts
     - packages/agent-vm/src/gateway/mcp-portal-effective-config.unit.test.ts

3. Caller-context purpose isolation and stale refresh:
   - Expected fix: plugin caller-context cache is keyed by exact caller scope:
     `zoneId`, `purpose`, `agentId`, `agentWorkspaceDir`, `workMountDir`, and
     session-key digest. Host-action calls register
     `tool_portal_controller_host_action`; lease calls register
     `tool_vm_lease`; stale/absent controller responses clear the scoped
     host-action cache before retry.
   - Expected controller behavior: controller-host-action rejects non
     `tool_portal_controller_host_action` contexts.
   - Inspect:
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-caller-context-store.ts
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.ts
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.ts
     - packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.ts
     - packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.ts
     - packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.ts
     - packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts

4. Handler-generated response sequencing:
   - Expected fix: gateway and worker control services allocate an exclusive
     peer sequence when reserving a handler response, so a rejected or pending
     receipt cannot race with another outbound frame and reuse the same
     sequence.
   - Inspect:
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.ts
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts
     - packages/agent-vm-worker/src/control-session/worker-control-service.ts
     - packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts

5. Worker git retry identity across ack-before-result flap:
   - Expected fix: worker git RPC client preserves the same `commandId`,
     `idempotencyKey`, and `messageId` for an in-flight idempotency key across
     transport loss, and clears identity only on terminal controller response or
     in-band RPC error. This must hold for both `git_push` and
     `git_pull_default`.
   - Inspect:
     - packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.ts
     - packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.unit.test.ts

6. Portal export verifier freshness:
   - Expected fix: `pnpm check` runs a workspace build before the portal export
     audit, and the verifier asserts
     `@agent-vm/tool-portal/in-process-entrypoint` exports
     `createManagedToolPortalInProcessRuntime`.
   - Inspect:
     - scripts/run-check-gate.ts
     - scripts/run-check-gate.unit.test.ts
     - scripts/verify-portal-package-exports.ts

7. Standalone `pnpm lint` proof:
   - Expected proof: standalone `pnpm lint` passed in addition to `pnpm check`
     and `pnpm lint:types`.
   - Inspect workflow state and proof claims below.

Post-Event-176 Findings Also Fixed
----------------------------------

Fable should also verify these accepted findings from the latest review pass:

1. Host-action authorization proof overgrant:
   - Expected fix: controller-host-action authorization tests use an authored
     `controller_host_action.zone_git_push` policy and reject zones without
     that authored policy.
   - Inspect:
     - packages/agent-vm/src/controller/control-session/gateway-control-controller-host-action-authorization.unit.test.ts

2. MCP Portal agent parity:
   - Expected fix: effective MCP Portal config validation rejects extra portal
     agents and missing declared agents when materializing managed profile
     config.
   - Inspect:
     - packages/agent-vm/src/gateway/mcp-portal-effective-config.ts
     - packages/agent-vm/src/gateway/mcp-portal-effective-config.unit.test.ts
     - packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts
     - packages/agent-vm/src/operations/config-validation.ts

3. Worker reconnect peer-sequence continuity:
   - Expected fix: worker reconnect hello continuity resets unobserved peer
     sequence allocations to the accepted reconnect frontier, mirroring the
     gateway-side behavior.
   - Inspect:
     - packages/agent-vm-worker/src/control-session/worker-control-service.ts
     - packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts

4. Raw-control manual residue:
   - Expected fix: the stale `scripts/live-sandbox-manual.mjs` manual sandbox
     script is deleted and docs no longer describe active Worker git
     push/pull-default through raw controller HTTP callbacks.
   - Inspect:
     - docs/architecture/overview.md
     - docs/architecture/agent-worker-gateway.md
     - docs/getting-started/worker-guide.md
     - packages/agent-vm/src/integration-tests/gateway-api-http.integration.test.ts

Post-Event-178 Findings Also Fixed
----------------------------------

Fable should specifically verify these accepted findings from Event 178:

1. Worker git docs/raw-control residue:
   - Expected fix: active architecture docs describe Worker git push/pull as
     `worker_control_rpc` intents, while Worker task submit/state/close remain
     on ingress HTTP.
   - Inspect:
     - docs/architecture/overview.md
     - docs/architecture/agent-worker-gateway.md

2. Shippable docs/manual residue audit scope:
   - Expected fix: `scripts/audit-portal-architecture.ts` scans current
     `docs/architecture/**`, `docs/getting-started/**`, and
     `packages/agent-vm/src/cli/manual-templates.ts` surfaces, not only source
     code.
   - Inspect:
     - scripts/audit-portal-architecture.ts
     - scripts/audit-portal-architecture.unit.test.ts

3. Reconnect/resync and reconnect hello timeout behavior:
   - Expected fix: reconnect `resync_required` performs a bounded resync/hello
     retry instead of terminal stale; reconnect hello timeout explicitly
     stales/closes the session instead of leaving a superficially connected but
     unusable session.
   - Inspect:
     - packages/agent-vm/src/controller/control-session/control-session-client.ts
     - packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts

4. Ready credential fetch connect-budget abort:
   - Expected fix: gateway and worker readiness credential fetches receive an
     abort signal tied to `CONTROL_SESSION_TIMING_MS.connectTimeout`.
   - Inspect:
     - packages/agent-vm/src/controller/control-session/gateway-control-session.ts
     - packages/agent-vm/src/controller/control-session/gateway-control-session.unit.test.ts
     - packages/agent-vm/src/controller/control-session/worker-control-session.ts
     - packages/agent-vm/src/controller/control-session/worker-control-session.unit.test.ts

5. Caller-context registry cap:
   - Expected fix: controller caller-context registry rejects unique contexts
     above a bounded cap.
   - Inspect:
     - packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts
     - packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts

6. Public `tool_vm_runner` config with no runtime backend:
   - Expected fix: Tool Portal in-process runtime creation fails closed with an
     explicit unsupported-backend error when config contains `tool_vm_runner`
     until a real runtime backend is implemented.
   - Inspect:
     - packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.ts
     - packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.unit.test.ts

Event 181 Findings To Verify As Fixed
-------------------------------------

Fable should specifically verify these accepted findings from Event 181:

1. Control-session signer persistence:
   - Event 181 intent was signer persistence, but Event 183 found the first
     implementation wrote private material into guest-visible gateway state.
   - Current expected fix: gateway control-session private signer material is
     persisted only in controller-owned host runtime storage under
     `runtimeDir/control-sessions/gateway/<zoneId>/session-material.json`.
     `gateway-runtime.json` under `zone.gateway.stateDir` must not contain
     `controlSession`, `privateKeyPkcs8Pem`, or PEM text.
   - Current expected boundary: persisted material does NOT imply same-VM
     reconnect after controller process restart. Event 184 narrows controller
     restart/redeploy to a managed-VM recreate boundary for this cutover.
   - Expected boundary: worker material serialize/deserialize helpers exist and
     are tested, but full cross-controller worker reconnect persistence depends
     on the durable worker task/session owner that this cutover does not
     introduce.
   - Inspect:
     - packages/agent-vm/src/controller/control-session/gateway-control-session.ts
     - packages/agent-vm/src/controller/control-session/gateway-control-session.unit.test.ts
     - packages/agent-vm/src/controller/control-session/worker-control-session.ts
     - packages/agent-vm/src/controller/control-session/worker-control-session.unit.test.ts
     - packages/agent-vm/src/controller/control-session/gateway-control-session-material-store.ts
     - packages/agent-vm/src/controller/control-session/gateway-control-session-material-store.unit.test.ts
     - packages/agent-vm/src/gateway/gateway-runtime-record.ts
     - packages/agent-vm/src/gateway/gateway-runtime-record.unit.test.ts
     - packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts
     - packages/agent-vm/src/gateway/gateway-zone-support.ts
     - packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts

2. Active lease caller-context refresh:
   - Expected fix: active lease operations re-register the original scoped
     caller context once when the controller reports the cached context as
     absent, not only during `lease_create`.
   - Expected operations: `lease_renew`, `lease_release`, `lease_use_start`,
     `lease_use_heartbeat`, `lease_use_end`, and `lease_peek`.
   - Inspect:
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.ts
     - packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts

3. Managed SSH Git read allowlist:
   - Expected fix: lifecycle-level trusted repository allowlists feed
     `createGitReadOnlySshEgressOptions`, OpenClaw derives the allowlist from
     trusted `zone.gateway.zoneGit.remote.repoUrl`, Worker derives it from
     controller-prepared repo resources, and SSH agent egress fails closed when
     no trusted allowlist is available.
   - Expected policy: allow `git-upload-pack`; deny `git-receive-pack`.
   - Inspect:
     - packages/gateway-interface/src/git-read-allowlist.ts
     - packages/gateway-interface/src/gateway-lifecycle.ts
     - packages/gateway-interface/src/index.ts
     - packages/openclaw-gateway/src/openclaw-lifecycle.ts
     - packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts
     - packages/worker-gateway/src/worker-lifecycle.ts
     - packages/worker-gateway/src/worker-lifecycle.unit.test.ts
     - packages/agent-vm/src/controller/worker-task-runner.ts

4. Generated/manual/package metadata residue:
   - Expected fix: generated Tool VM lease manual no longer teaches removed
     HTTP lease semantics, OpenClaw plugin metadata no longer says
     "controller lease API", and the architecture audit scans shipped metadata.
   - Inspect:
     - packages/agent-vm/src/cli/manual-templates.ts
     - packages/agent-vm/src/cli/manual-templates.unit.test.ts
     - packages/openclaw-agent-vm-plugin/openclaw.plugin.json
     - scripts/audit-portal-architecture.ts
     - scripts/audit-portal-architecture.unit.test.ts

5. Portal export and JSON Schema proof gates:
   - Expected fix: portal export verification includes the newly reachable
     public import surfaces and control contract tests compare full JSON Schema
     bundles, not only smoke-checking shapes.
   - Inspect:
     - scripts/verify-portal-package-exports.ts
     - packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts
     - packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts
     - packages/worker-control-contracts/src/worker-control-contracts.unit.test.ts

6. Stale Vitest alias cleanup:
   - Expected fix: removed `credentialed-runner-boundary` Vitest alias is gone.
   - Inspect:
     - vitest.config.ts

Event 184 Semantics Correction To Verify As Fixed
-------------------------------------------------

Fable should specifically verify this accepted correction:

1. Controller restart/redeploy is not claimed as same-VM reconnect.
   - Expected fix: `RESILIENT-GRACE` applies to transport/socket flaps while the
     owning controller process still has the VM/ingress handle.
   - Expected fix: controller process restart/redeploy is documented as a
     managed-VM recreate boundary for this cutover, because Gondolin 0.12.0
     attach IPC does not expose a public full lifecycle/ingress VM adoption API.
   - Expected fix: unit-test names and proof wording no longer imply that
     serialized signer material proves controller-restart reconnect.
   - Inspect:
     - docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md
     - docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md
     - docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md
     - docs/specs/2026-07-02-socketio-control-plane/slices/03-s3-controller-session-runtime.md
     - docs/specs/2026-07-02-socketio-control-plane/slices/07b-s6b-recovery-corroboration.md
     - packages/agent-vm/src/controller/control-session/gateway-control-session.unit.test.ts
     - packages/agent-vm/src/controller/control-session/worker-control-session.unit.test.ts

Known Review-Sensitive Residue
------------------------------

Broad text search still finds old raw-controller strings in specs, tests, and a
fixtures. Review whether these are allowed context/fixtures or shippable
managed residue:

- specs and plan files intentionally mention `controller.vm.host:18800` and
  `CONTROLLER_BASE_URL` as removed/current-state context.
- unit/integration fixtures intentionally use old raw-controller strings to
  prove audit failures or legacy config translation.
- `scripts/live-sandbox-manual.mjs` has been deleted. Fable should verify that
  no equivalent shippable raw-control manual/sandbox path remains.

Do not treat every string match as a bug. Do treat any reachable managed
runtime path, generated manual, public package export, VM config, lifecycle
builder, or deployment default that still ships the raw control path as a
hard-cutover blocker.

Proof Claims
------------

Current Event 200 proof after terminal refresh and host-e2e fixture repairs:

```text
pnpm exec oxfmt packages/agent-vm/src/backup/backup-create-operation.host.e2e.test.ts
  passed, formatted 1 file

pnpm check
  passed, 10 passed / 0 failed in 27.04s
  includes build, package-version sync, Zod guard, test taxonomy, portal
  architecture audit, portal export audit, lint, format, type-aware lint, and
  typecheck

git diff --check
  passed

git diff --check
  passed

mise exec -- pnpm run test:e2e:vm
  passed, 5 files / 9 tests / 0 skipped / 0 todo
  result: tmp/vitest-results/e2e-vm-42352-fO1Xkl/results.json

set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm test:e2e
  passed all default e2e proof lanes, 4 passed / 0 failed in 80.56s
  e2e-host-docker: 1 file / 2 tests / 0 skipped / 0 todo,
    tmp/vitest-results/e2e-host-docker-87413-h5OKus/results.json
  e2e-host: 22 files / 180 tests / 0 skipped / 0 todo,
    tmp/vitest-results/e2e-host-87411-3gpboG/results.json
  e2e-vm: 5 files / 9 tests / 0 skipped / 0 todo,
    tmp/vitest-results/e2e-vm-87412-p1EXEn/results.json
  e2e-vm-mediation: passed in 11.59s

Focused host-e2e repair proof before default e2e:
pnpm vitest run --config vitest.config.ts --project e2e-host <six previously failing files>
  passed, 6 files / 94 tests

Focused init-command integration proof:
pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/cli/init-command.integration.test.ts
  passed, 1 file / 39 tests
```

Current Event 190 proof after fixing Event 189 accepted findings:

```text
pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts
  passed after Event 189 fixes, 3 files / 70 tests

pnpm vitest run --config vitest.config.ts --project unit packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.unit.test.ts packages/agent-portal-sdk/src/portal-call-surface/portal-call-contracts.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-domain-handler.unit.test.ts
  passed after Event 189 fixes, 5 files / 42 tests

pnpm vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts -t 'mounts managed Tool Portal effective config read-only'
  passed after Event 189 fixes, 1 file / 1 selected test, 54 skipped

pnpm exec tsx scripts/verify-portal-package-exports.ts
  passed after Event 189 export verifier expansion, 21 required imports resolved, 96 named exports present, 2 smoke calls passed, 4 deferred imports absent

pnpm lint
  passed after Event 189 fixes, 0 warnings / 0 errors

pnpm typecheck
  passed after Event 189 fixes across all workspace projects

pnpm lint:types
  passed after Event 189 fixes, 0 warnings / 0 errors

git diff --check
  passed after Event 189 fixes

pnpm check
  passed after Event 189 fixes, 9 passed / 0 failed
```

Current lightweight sanity checks run while preparing this packet:

```text
git diff --cached --check
  passed

git ls-files --others --exclude-standard | wc -l
  0

git diff --name-only | wc -l
  0

git diff --name-only origin/master...HEAD | wc -l
  400

git diff --shortstat origin/master...HEAD
  400 files changed, 68944 insertions(+), 11058 deletions(-)

pnpm vitest run --config vitest.config.ts --project unit packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts packages/worker-control-contracts/src/worker-control-contracts.unit.test.ts packages/gateway-interface/src/health/controller-request-policy.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts
  passed after Event 188 fixes, 6 files / 72 tests

pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts packages/agent-vm/src/controller/worker-task-runner.integration.test.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts
  passed after Event 188 fixes, 3 files / 118 tests

pnpm exec tsx scripts/verify-portal-package-exports.ts
  passed after Event 188 export verifier expansion, 21 required imports resolved, 79 named exports present, 2 smoke calls passed, 4 deferred imports absent

pnpm fmt:check
  passed after Event 188 fixes

pnpm lint
  passed after Event 188 fixes, 0 warnings / 0 errors

pnpm lint:types
  passed after Event 188 fixes, 0 warnings / 0 errors

pnpm typecheck
  passed after Event 188 fixes across 17 workspace projects

git diff --check
  passed after Event 188 fixes

pnpm check
  passed after Event 188 fixes, 9 passed / 0 failed

pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/worker-control-domain-handler.unit.test.ts
  passed after the Worker command-result wrapper fix, 1 file / 6 tests

pnpm exec oxfmt --check packages/agent-vm/src/integration-tests/worker-loop.worker.e2e.test.ts packages/agent-vm/src/controller/control-session/worker-control-domain-handler.ts packages/agent-vm/src/controller/control-session/worker-control-domain-handler.unit.test.ts
  passed after the Worker git RPC e2e and handler edits

AGENT_VM_WORKER_E2E=1 AGENT_VM_TEST_OPENAI_API_KEY=scripted-e2e-placeholder mise exec -- pnpm vitest run --config vitest.config.ts --project e2e-worker packages/agent-vm/src/integration-tests/worker-loop.worker.e2e.test.ts -t "dispatches worker git RPCs through the controller-backed control session"
  passed after the Worker proof-gap fix, 1 file / 1 test passed / 1 skipped, duration 61.67s

pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-session.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-session.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-session-material-store.unit.test.ts packages/agent-vm/src/gateway/gateway-runtime-record.unit.test.ts
  passed after Event 184 semantics correction and Event 183 signer exposure fix, 4 files / 22 tests

pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/control-session/gateway-control-session.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-session.unit.test.ts packages/agent-vm/src/gateway/gateway-runtime-record.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts
  passed after Event 181 fixes, 4 files / 25 tests

pnpm vitest run --config vitest.config.ts --project unit packages/worker-gateway/src/worker-lifecycle.unit.test.ts
  passed after Event 181 SSH Git allowlist fixes, 1 file / 8 tests

pnpm vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts
  passed after Event 181 SSH Git allowlist fixes, 1 file / 53 tests

pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts
  passed after Event 181 fixes, 3 files / 65 tests

pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/cli/manual-templates.unit.test.ts packages/control-protocol-contracts/src/control-protocol-contracts.unit.test.ts packages/gateway-control-contracts/src/gateway-control-contracts.unit.test.ts packages/worker-control-contracts/src/worker-control-contracts.unit.test.ts scripts/audit-portal-architecture.unit.test.ts
  passed after Event 181 residue/schema/export-audit fixes, 5 files / 47 tests

pnpm exec tsx scripts/audit-portal-architecture.ts
  passed after Event 181 residue fixes

pnpm exec tsx scripts/verify-portal-package-exports.ts
  passed after Event 181 export verifier expansion, 21 required imports resolved, 57 named exports present, 4 deferred imports absent

pnpm lint
  passed after Event 181 fixes, 0 warnings / 0 errors

pnpm lint:types
  passed after Event 181 fixes, 0 warnings / 0 errors

pnpm test:taxonomy
  passed after Event 181 fixes

pnpm typecheck
  passed after Event 181 fixes across 17 workspace projects

git diff --check && git diff --cached --check
  passed after Event 181 fixes

pnpm check
  passed after Event 181 fixes, 9 passed / 0 failed

pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.unit.test.ts scripts/audit-portal-architecture.unit.test.ts packages/agent-vm/src/cli/manual-templates.unit.test.ts
  passed after post-Event-179 reducer fixes, 4 files / 16 tests

pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts
  passed after post-Event-179 reducer fixes, 3 files / 65 tests

pnpm exec tsx scripts/audit-portal-architecture.ts
  passed after expanding shippable docs/manual residue scope

rg -n "push-branches|worker-push-branches|worker-pull-default" docs/architecture docs/getting-started docs/reference docs/subsystems packages/agent-vm/src/cli/manual-templates.ts
  returned no matches after post-Event-179 docs/manual residue fixes

pnpm fmt:check
  passed after post-Event-179 reducer fixes

pnpm lint
  passed after post-Event-179 reducer fixes, 0 warnings / 0 errors

pnpm lint:types
  passed after post-Event-179 reducer fixes, 0 warnings / 0 errors

pnpm typecheck
  passed after post-Event-179 reducer fixes across 17 workspace projects

git diff --check && git diff --cached --check
  passed after post-Event-179 reducer fixes

pnpm check
  passed after post-Event-179 reducer fixes, 9 passed / 0 failed

pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.unit.test.ts
  passed, 1 file / 2 tests

pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts
  passed, 3 files / 80 tests

pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts
  passed after the final peer-sequence reserved-frontier fix, 2 files / 33 tests

pnpm exec oxfmt --check <4 edited gateway/worker control-service source/test files>
  passed

pnpm --filter @agent-vm/openclaw-agent-vm-plugin --filter @agent-vm/agent-vm-worker typecheck
  passed

git diff --check && git diff --cached --check
  passed

pnpm lint
  passed after the final peer-sequence reserved-frontier fix, 0 warnings / 0 errors

pnpm exec tsx scripts/verify-portal-package-exports.ts
  passed earlier in this review cycle; rerun if Fable needs export-specific
  proof after Event 172

pnpm typecheck
  passed across 17 workspace projects

pnpm lint:types
  passed, 0 warnings / 0 errors

pnpm check
  passed after the final peer-sequence reserved-frontier fix, 9 passed / 0 failed
  includes build, package-version sync, Zod guard, test taxonomy, portal architecture audit, portal export audit, format, type-aware lint, and typecheck

pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/gateway/mcp-portal-effective-config.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-controller-host-action-authorization.unit.test.ts packages/openclaw-agent-vm-plugin/src/tool-portal-native-tools.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-controller-host-action-backend.unit.test.ts packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.unit.test.ts
  passed after the latest review-finding fixes, 5 files / 40 tests

pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/operations/config-validation.integration.test.ts -t "MCP Portal agents" --reporter verbose
  passed after the latest MCP Portal agent parity fix, 1 selected test, 27 skipped by filter

pnpm vitest run --config vitest.config.ts --project integration packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts
  passed after the latest worker reconnect continuity fix, 2 files / 34 tests

pnpm vitest run --config vitest.config.ts --project unit scripts/audit-portal-architecture.unit.test.ts
  passed after stale raw-control manual residue cleanup, 1 file / 7 tests

pnpm lint
  passed after the latest review-finding fixes, 0 warnings / 0 errors

pnpm typecheck
  passed after the latest review-finding fixes across 17 workspace projects

pnpm lint:types
  passed after the latest review-finding fixes, 0 warnings / 0 errors

pnpm check
  passed after the latest review-finding fixes, 9 passed / 0 failed

git diff --check && git diff --cached --check
  passed after the latest review-finding fixes

rg -n "push-branches endpoint|push-branches API|POST /push-branches" docs/architecture/overview.md docs/architecture/agent-worker-gateway.md
  returned no matches after Event 178 fixes

pnpm vitest run --config vitest.config.ts --project unit packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-session.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-session.unit.test.ts packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.unit.test.ts scripts/audit-portal-architecture.unit.test.ts
  passed after Event 178 fixes, 7 files / 48 tests

pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/controller/control-session/control-session-client.integration.test.ts
  passed after Event 178 fixes, 1 file / 29 tests

pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm/src/gateway/gateway-zone-orchestrator.integration.test.ts
  passed after Event 178 fixes, 1 file / 49 tests

pnpm exec tsx scripts/audit-portal-architecture.ts
  passed after Event 178 fixes

pnpm fmt:check
  passed after Event 178 fixes

pnpm lint
  passed after Event 178 fixes, 0 warnings / 0 errors

pnpm lint:types
  passed after Event 178 fixes, 0 warnings / 0 errors

pnpm typecheck
  passed after Event 178 fixes across 17 workspace projects

pnpm check
  passed after Event 178 fixes, 9 passed / 0 failed
```

Latest terminal proof recorded in workflow state after the major runtime fixes,
before the Event 172 follow-up edits:

```text
pnpm check
  passed

mise exec -- pnpm run test:e2e:openclaw
  passed, 7 files / 12 tests / 0 skipped / 0 todo
  result: tmp/vitest-results/e2e-openclaw-8117-CE2JYT/results.json

set -a; source .env.local; set +a; AGENT_VM_TEST_OPENAI_API_KEY="$OPEN_AI_TEST_KEY" mise exec -- pnpm run test:e2e:worker
  passed, 3 files / 4 tests / 0 skipped / 0 todo
  result: tmp/vitest-results/e2e-worker-41228-mfkd7l/results.json

mise exec -- pnpm run test:e2e:vm
  passed, 5 files / 9 tests / 0 skipped / 0 todo
  result: tmp/vitest-results/e2e-vm-91223-XM3ptu/results.json

mise exec -- pnpm test:e2e
  passed, 4 lanes / 0 failed
  host-docker: tmp/vitest-results/e2e-host-docker-9478-6X9jmf/results.json
  host: tmp/vitest-results/e2e-host-9480-V5EwgT/results.json
  VM: tmp/vitest-results/e2e-vm-9479-PxPWK6/results.json
  VM mediation: tmp/vitest-results/e2e-vm-mediation-9481-TDiTgO/results.json

final pnpm check
  passed, 8 passed / 0 failed
```

Post-Event-192 proof:

```text
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/control-session/worker-control-application-handler.unit.test.ts packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-domain-handler.unit.test.ts packages/worker-control-contracts/src/worker-control-contracts.unit.test.ts packages/agent-vm-worker/src/state/task-state.unit.test.ts
  passed, 5 files / 34 tests

pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/control-session/worker-control-application-handler.unit.test.ts packages/agent-vm-worker/src/work-phase/controller-tools/worker-control-rpc-client.unit.test.ts packages/agent-vm/src/controller/control-session/worker-control-domain-handler.unit.test.ts packages/worker-control-contracts/src/worker-control-contracts.unit.test.ts packages/agent-vm-worker/src/state/task-state.unit.test.ts packages/agent-vm/src/config/system-config.unit.test.ts packages/gateway-interface/src/git-read-allowlist.unit.test.ts packages/gondolin-adapter/src/vm-adapter.unit.test.ts scripts/run-check-gate.unit.test.ts
  passed, 9 files / 223 tests

pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm/src/cli/controller-operation-commands.unit.test.ts packages/agent-vm/src/controller/controller-runtime.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-controller-host-action-authorization.unit.test.ts packages/agent-vm/src/controller/leases/lease-work-mount-paths.unit.test.ts
  passed, 4 files / 69 tests

pnpm typecheck
  passed across 17 workspace projects

pnpm lint -- packages/agent-vm-worker/src/control-session/worker-control-application-handler.ts packages/agent-vm-worker/src/main.ts
  passed, 0 warnings / 0 errors

pnpm lint:types -- packages/agent-vm-worker/src/control-session/worker-control-application-handler.ts packages/agent-vm-worker/src/main.ts
  passed, 0 warnings / 0 errors

git diff --cached --check
  passed

pnpm check
  passed, 10 passed / 0 failed in 29.45s
```

Post-Event-194 proof:

```text
pnpm vitest run --config vitest.config.ts --project unit packages/agent-vm-worker/src/control-session/worker-control-application-handler.unit.test.ts packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.unit.test.ts packages/tool-portal/src/in-process-entrypoint/tool-portal-in-process-entrypoint.unit.test.ts packages/tool-portal/src/in-process-entrypoint/managed-tool-portal-runtime.unit.test.ts
  passed, 4 files / 22 tests

pnpm vitest run --config vitest.config.ts --project integration packages/agent-vm-worker/src/control-session/worker-control-service.integration.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts
  passed, 2 files / 42 tests

pnpm typecheck
  passed across workspace projects

pnpm fmt:check
  passed

pnpm lint
  passed, 0 warnings / 0 errors

pnpm lint:types
  passed, 0 warnings / 0 errors

git diff --check
  passed

pnpm check
  passed, 10 passed / 0 failed in about 27.9s

git diff --name-only origin/master...HEAD | wc -l
  400

git diff --stat origin/master...HEAD
  400 files changed; use live `git diff --stat origin/master...HEAD` for
  exact insertion/deletion counts.
```

Fable should treat beta Discord/OpenClaw proof as stale relative to the
post-Event-194 and post-Event-197 fixes. Terminal VM/default e2e and
`pnpm check` are fresh as of Event 200; beta proof is still useful regression
history, not final PR-ready proof. If this review comes back clean, the next
execution step is to refresh beta proof before PR-ready non-merge wrapup.

Latest beta Discord/OpenClaw proof recorded in workflow state:

```text
Discord API message id: 1522681935779069992
nonce: socketio-control-proof-20260703T191423Z
sender bot id: 1508937355816472747
OpenClaw log: /Users/shravansunder/.agent-vm/runtime/zones/beta/logs/openclaw-2026-07-03.log
trajectory: /Users/shravansunder/.agent-vm/state/beta/agents/beta/sessions/e3e4cfc7-db79-4609-b4b1-e45c41ebe79f.trajectory.jsonl
```

Do not print or request secret values. The proof commands in workflow state are
redacted where required.

Reviewer Questions
------------------

Return only grounded candidate findings. Prioritize blockers and important
findings that would prevent PR-ready non-merge wrapup.

1. Do the Event 172, post-Event-176, Event 178, Event 181, Event 183,
   Event 184, Event 185, Event 187, Event 188, Event 189, Event 191,
   Event 192, Event 193, Event 194, and Event 195
   blocker/important fixes hold up against
   the current branch code,
   especially trust identity,
   caller-context purpose, response sequencing, retry identity, export verifier
   freshness, reconnect/resync behavior, ready-fetch aborts, caller-context
   registry bounds, host-only signer material persistence, controller restart
   as VM recreate boundary, active lease caller-context refresh, managed SSH Git
   egress allowlisting, JSON Schema equality proof, Worker git RPC controller
   path proof, explicit failed command results after accepted handler failures,
   response receipt failure handling, read-only Tool Portal effective config,
   static portal-call JSON Schema snapshots, and raw-control
   docs/manual/package metadata residue, VM-side Worker recovery handling,
   Worker advisory runtime observation persistence, hard rejection of
   Worker-control cancellation, peer-side latest-wins/droppable backpressure,
   MCP-backed Tool Portal session scoping, lossy sequence-frontier handling,
   MCP session retirement on Tool Portal entrypoint eviction/runtime close, and
   refreshed caller-context lease ownership?
2. Does the branch implementation satisfy the Socket.IO-over-Gondolin hard
   cutover without preserving old managed raw-controller control paths?
3. Are gateway and worker trust boundaries controller-owned where authority is
   exercised?
4. Are Zod v4 schemas, inferred types, event maps, and runtime validation in
   sync across controller, OpenClaw plugin, worker, and shared packages?
5. Are delivery, dedupe, retry, reconnect/resync, and backpressure semantics
   implemented enough for the accepted plan, or is any plan/spec obligation only
   documented?
6. Is Tool Portal the public managed OpenClaw tool surface, with MCP Portal
   demoted to backend/internal provider role?
7. Are proof claims strong enough and mapped to the source obligations, without
   relabeled or weakened gates?
8. Are there hidden shippable residues from the old model:
   `controller.vm.host:18800`, `CONTROLLER_BASE_URL`, `gateway-control-link`,
   `/socket.io` path naming, Socket.IO polling fallback, OpenClaw sidecar, old
   `openclaw-mcp-portal-plugin` managed identity, or control-socket bulk data?
9. Has deletion of `scripts/live-sandbox-manual.mjs` and the post-Event-181
   generated/manual/package metadata cleanup removed the manual
   raw-controller residue, or is there an equivalent shippable old-control path
   still present?

Output Shape
------------

Use this shape for every candidate finding:

```text
severity: blocker | important | follow-up | nit
title:
evidence: exact file:line, symbol, command output, or plan section
scenario: concrete failure, exploit, regression, or maintenance path
smallest_fix:
proof: test, check, or manual reproduction that would prove the fix
confidence: high | medium | low
```

If there are no high-confidence findings, say:

```text
No findings.
Confidence: <high | medium | low>
Remaining uncertainty: <short list>
```

Read-only boundary:

- Do not edit files.
- Do not stage changes.
- Do not commit.
- Do not run destructive git operations.
- Do not print secrets.
