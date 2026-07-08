# Tool VM Lease Renewal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` after this plan passes
> `shravan-dev-workflow:plan-review-swarm`. Steps use checkbox syntax for
> tracking. Do not start product code changes from this draft until the plan
> review findings are folded.

Date: 2026-07-08
Status: plan-review findings and focused re-check findings folded; ready for
orchestrator-owned transition to
`shravan-dev-workflow:implementation-execute-plan`
Goal id: `2026-07-08-toolvm-lease-renewal`
Source spec:
`docs/specs/2026-07-08-toolvm-lease-renewal-lifecycle.md`
Plan workflow:
`tmp/plan-workflows/2026-07-08-toolvm-lease-renewal/`

## Goal

Implement OAuth-style Tool VM lease renewal, stale-lease reacquisition, and
old-handle retirement for managed OpenClaw Tool VM access. A Tool VM SSH or
file-bridge reset must become a typed lifecycle transition that either
reacquires a controller-vetted replacement lease or retires the handle. It must
not surface as a hard local `409 no registered caller context`, and it must not
allow the old stale lease id or old SSH material to run new work.

## Architecture

The controller remains the authority for lease ownership, stable provenance,
current session attachment, and replacement decisions. The OpenClaw plugin may
observe stale evidence and request replacement, but it cannot authorize a
replacement from plugin-held fields. Returned sandbox handles separate stable
request provenance from a mutable current lease binding and consult that
binding at operation time before active-use, SSH, file, exec, heartbeat, or
finalize work can access raw lease or SSH material.

## Tech Stack

- TypeScript, Node 24, pnpm workspace.
- Zod v4 contract schemas in `@agent-vm/gateway-control-contracts`.
- Private Socket.IO `gateway_control_rpc` between controller and managed
  gateway plugin.
- Controller lease manager and gateway-control lease RPC in
  `packages/agent-vm`.
- Managed OpenClaw plugin lease client and sandbox backend in
  `packages/openclaw-agent-vm-plugin`.
- Health/OTEL projection through `@agent-vm/gateway-interface` and
  `packages/agent-vm/src/observability`.

## Source Coverage

Plan creation re-read and used these source artifacts:

- `docs/specs/2026-07-08-toolvm-lease-renewal-lifecycle.md`, 777 lines.
- `tmp/workflow-state/2026-07-08-toolvm-lease-renewal/details.md`, 136 lines.
- `tmp/workflow-state/2026-07-08-toolvm-lease-renewal/events.jsonl`, 4 events.
- `tmp/spec-workflows/2026-07-08-toolvm-lease-renewal/swarm-ledger.md`, 108 lines.
- Prior Socket.IO cutover plan and slices:
  - `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md`.
  - `docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md`.
  - `docs/specs/2026-07-02-socketio-control-plane/slices/04-s4a-gateway-control-contract-lease-rpc.md`.
  - `docs/specs/2026-07-02-socketio-control-plane/slices/16-tool-vm-and-mcp-full-path-proof.md`.

Incident artifact limitation:

- The goal points to sibling repo artifact
  `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/wip/debugging/2026-07-08-sunfam-toolvm-lease-caller-context-409.md`.
  The exact path and a repo search in the current sibling checkout returned no
  matching file. The implementation plan relies on the incident facts already
  captured in the accepted spec, and execution must not edit the deployment
  repo unless the user explicitly asks.

## Non-Goals

- Do not keep using stale old leases for Tool VM work.
- Do not weaken per-agent HMAC, caller-context proof, declared-agent, workspace,
  work-mount, or session-key ownership checks.
- Do not turn the gateway-control WebSocket into a Tool VM data plane.
- Do not add broad direct controller HTTP lease fallbacks.
- Do not disable observability or collapse Tool VM SSH stale evidence into a
  gateway WebSocket, Discord, or gateway-service outage.
- Do not publish until implementation, review, merge/release prerequisites, and
  post-merge registry proof are satisfied.

## File Responsibility Map

`packages/gateway-control-contracts/src/index.ts`

- Owns wire vocabulary: `lease_reacquire`, lease lifecycle payloads, typed
  rejection taxonomy, command/result unions, delivery policy, timeouts, and JSON
  schema snapshots. It also owns the wire-safe `health_event` payload fields for
  lease lifecycle observations. It does not own controller lifecycle authority.

`packages/agent-vm/src/controller/leases/lease-manager.ts`

- Owns lease lifecycle, renewal, release, and active-use state. It coordinates
  with the dedicated old-lease authority store for lifecycle transitions.
  It must prevent normal `lease_create` reuse from satisfying stale-led
  replacement.

`packages/agent-vm/src/controller/leases/tool-vm-lease-authority-store.ts`

- New focused controller-side owner for old-lease authority and bounded
  tombstones. It replaces `leaseOwnerContextByLeaseId` as the authority source
  and is queried by renew, release, reacquire, and ownership checks.

`packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.ts`

- Owns controller-side gateway-control lease operations, caller-context
  verification, stable provenance checks, current session attachment checks,
  `lease_reacquire` orchestration, and private SSH snapshot serialization.

`packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts`

- Owns caller-context registration and typed caller-context resolution. The
  current `resolve(id) -> context | undefined` shape must become, or be wrapped
  by, a discriminated resolution result that can distinguish `ok`, `absent`,
  `stale`, and `session_mismatch` for Tool VM lease operations.

`packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`

- Owns control-message routing, `GatewayControlLeaseRpcOperations` interface
  expansion, command-result shaping, typed rejection mapping, and transport
  parsing of plugin observations. It must not become the lifecycle authority;
  final controller lifecycle decisions are emitted by the authority/reacquire
  path and only transported/recorded through the domain handler.

`packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.ts`

- Owns plugin-side RPC client behavior: typed rejection parsing, caller-context
  refresh, stale/retired recovery decisions, cleanup idempotency, and
  `lease_reacquire` request API.

`packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`

- Owns handle cache, returned handle construction, stale detection, binding
  gate, old binding tombstone, replacement swap, and no-old-lease-work
  enforcement. This is the serialized hotspot.

`packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-handle-binding.ts`

- New focused owner for stable handle provenance, mutable current lease binding,
  old-binding tombstone, replacement swap, terminal state, and runtime identity
  semantics. The factory delegates binding decisions here rather than adding
  more lease closure state.

`packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`

- Owns public handle contract semantics if `runtimeId` or `runtimeLabel` need
  to become current-binding views. The planned semantics are: `runtimeId` and
  `runtimeLabel` are current-binding views exposed through the same returned
  handle object; after reacquire they reflect the replacement lease id, and
  terminal handles expose their final binding only for diagnostics.

`packages/gateway-interface/src/tool-vm-active-use.ts`

- Owns active-use handle lifecycle helpers used by the plugin binding gate and
  cleanup behavior.

`packages/gateway-interface/src/health/agent-vm-health.ts`

- Owns internal health event semantics, lifecycle transition fields,
  caller-context state, raw internal lease/use correlation where needed for
  controller aggregation, and correlation fields. It does not own public
  hashing/redaction.

`packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.ts`

- Owns plugin-to-controller health/lifecycle event publication.

`packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`

- Owns controller ingestion of plugin health/lifecycle observations and
  correlation forwarding into operator-visible evidence after the wire schema
  accepts those fields.

`packages/agent-vm/src/observability/health-event-telemetry.ts`

- Owns safe OTEL/log projection and public redaction. It emits safe hashes and
  transition ids, and must not export raw lease ids, raw active-use ids,
  `identityPem`, or proof keys.

`packages/agent-vm/src/controller/health/tool-vm-status-aggregation.ts`

- Owns health summary separation between Tool VM SSH, lease/use RPC,
  gateway-control session, gateway service health, and external providers.

`packages/agent-vm/src/cli/manual-templates.ts`
`packages/agent-vm/src/cli/manual-templates.unit.test.ts`
`packages/agent-vm/src/integration-tests/manual-cli.host.e2e.test.ts`

- Own generated operator manuals and proof that the generated text teaches the
  new renewal/reacquire model and health split.

Package manifests and release helpers

- Own version bump, version sync, local pack inspection, post-merge publish,
  registry verification, and published tarball inspection.

## Plan-Creation Lanes

Lane reasoning-effort policy:

- High effort: security/reliability, validation/proof, vertical-slice
  decomposition, and plan review, because this crosses auth, SSH material,
  controller authority, plugin handles, observability, e2e, beta, and release.
- Medium effort is acceptable only for bounded source lookup or small docs
  checks that do not decide authority or proof.

Lanes completed before this plan:

- `codebase-boundary`: current handles capture `options.lease.*`;
  controller authority is a transient lease-owner map; normal create may reuse
  a live compatible lease; `lease_reacquire` is absent from contracts.
- `security-reliability`: stale raw lease id is never authority; refreshed
  caller context alone cannot authorize old stale work; old SSH material must
  be unreachable before replacement; exported evidence must be hashed/omitted.
- `validation-proof`: no current deterministic stale-SSH reacquire e2e hook
  exists; plan must include a harness-enabler and no-skip OpenClaw/VM proof,
  not pretend an existing write/read proof covers the incident class.
- `vertical-slice-decomposition`: accepted 7 behavior-owned slices, with
  returned-handle rebinding as the serialized hotspot.

Lane artifact summaries live under
`tmp/plan-workflows/2026-07-08-toolvm-lease-renewal/lanes/`.

## Vertical Slices

### Slice 1: Lease Lifecycle Contract And `lease_reacquire`

Source requirements: R15, R16, R17, R20.

Behavior:

- Add `lease_reacquire` as an explicit gateway-control RPC operation.
- Add discriminated typed rejection reasons from the spec matrix:
  `lease_absent`, `lease_retired`, `lease_releasing`,
  `lease_generation_stale`, `lease_force_released`,
  `lease_use_tombstoned`, `caller_context_absent`,
  `caller_context_stale`, `caller_context_session_mismatch`,
  `lease_reacquire_required`, `lease_authority_absent`,
  `ownership_denied`, and `runtime_not_ready`.
- Add lifecycle payload/result fields needed later for old lease id, stale
  evidence kind, observed time, caller context, optional `idleTtlHintMs`, and
  replacement lease snapshot.
- Keep forbidden payload fields strict: plugin payload must not carry
  `agentId`, `profileId`, host paths, SSH identity, proof keys, or raw
  compatibility authority for reacquire.

Write surface:

- `packages/gateway-control-contracts/src/index.ts`.
- `packages/openclaw-agent-vm-plugin/src/lease-client-contract.ts`.
- Contract unit tests and JSON schema tests adjacent to those packages.
- Slice 5 may return to `packages/gateway-control-contracts/src/index.ts` for
  lifecycle `health_event` payload fields after event names settle; do not edit
  that hot file in parallel with Slice 1.

TDD checkpoint:

- Add failing contract tests showing `lease_reacquire` is accepted in command
  and command_result unions, forbidden fields reject, and every rejection reason
  roundtrips as a typed enum.
- Make the contract pass without changing controller or plugin behavior yet.

Validation:

- `pnpm vitest run packages/gateway-control-contracts/src/*.unit.test.ts --config vitest.config.ts --project unit`
- `pnpm vitest run packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.unit.test.ts --config vitest.config.ts --project unit`

Split/replan trigger:

- If lifecycle transition fields require broad changes to all health event
  kinds, keep this slice to RPC vocabulary and move health fields to Slice 5.

### Slice 2: Controller Authority Record And Same-Id Renew Gate

Source requirements: R4, R5, R11, R12, R16, R17, R19.

Behavior:

- Add a dedicated controller-owned old-lease authority/tombstone store with
  bounded TTL. Retire `leaseOwnerContextByLeaseId` as an authority source; if a
  local cache remains, it is only a lookup optimization over the authority
  store.
- Record stable ownership provenance at lease create:
  `zoneId`, `agentId`, `agentWorkspaceDir`, `workMountDir`,
  `sessionKeyDigest`, and `purpose`.
- Record controller-derived compatibility:
  `profileId`, `hostWorkMountDir`, `guestWorkdir`, `zoneGitMount`, and idle
  TTL policy.
- Keep current session attachment separate:
  `peerId`, `bootId`, `controllerEpoch`, `sessionId`, and `connectionId`.
- Add a typed caller-context resolution seam before lease RPC authorization:
  `packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts`
  must return, or expose a helper that returns, a discriminated result with
  `status: "ok" | "absent" | "stale" | "session_mismatch"` for Tool VM lease
  resolution. `ok` carries the current trusted caller context; `absent` means no
  current or bounded stale/tombstone record exists; `stale` means a previous
  caller context exists but was superseded or released for the same stable
  caller-context purpose; `session_mismatch` means the context exists but the
  current `peerId`, `bootId`, `controllerEpoch`, `sessionId`, or `connectionId`
  fence does not match the envelope session. Implement this with explicit
  types, not broad `unknown` or stringly side channels.
- The domain handler maps typed caller-context resolution to wire
  `command_result` payloads. The lease RPC consumes the typed resolution and
  combines it with old-lease authority/provenance checks; neither layer should
  infer the taxonomy from `undefined`.
- Enforce same-id `lease_renew` only for current leases.
- Implement controller-side `lease_reacquire` so stale-led replacement cannot
  fall through to normal create reuse and successful replacement returns
  `newLeaseId !== oldLeaseId`.
- Return `lease_authority_absent` when old authority is gone instead of
  trusting plugin-held fields.
- Cover every disappearance or terminal transition that can affect old
  authority: normal create/reuse, release, force release, gateway dead-VM
  eviction, idle reap, expired/dead renew, active-use tombstone, and reacquire.
- Keep old authority alive through those transitions for the configured
  tombstone window, then expire it with injected-time tests.
- For concurrent `lease_reacquire(oldLeaseId)`, the first validated caller
  creates one authoritative transition and records the replacement. Later
  callers may reuse that replacement only after their current caller context,
  stable ownership, controller-derived compatibility, and same-gateway fence are
  independently revalidated under the controller lock.
- Map attachment drift explicitly:
  `peerId`, `bootId`, `controllerEpoch`, `sessionId`, and `connectionId` drift
  returns `caller_context_session_mismatch`; stable ownership/provenance drift
  returns `ownership_denied`.
- Emit exactly one controller-authoritative final lifecycle decision from this
  authority/reacquire path for each transition id. Plugin observations may be
  many; controller final decisions are deduped.

Write surface:

- `packages/agent-vm/src/controller/leases/lease-manager.ts`.
- Create `packages/agent-vm/src/controller/leases/tool-vm-lease-authority-store.ts`.
- `packages/agent-vm/src/controller/control-session/gateway-control-caller-context.ts`.
- `packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.ts`.
- `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`.
- Caller-context registry unit tests.
- Controller lease unit tests.
- Controller domain-handler unit tests.
- Create
  `packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.integration.test.ts`
  for the focused gateway-control `lease_reacquire` seam.

TDD checkpoint:

- Add red tests for:
  - stale/retired same-id renew rejects;
  - reacquire returns a replacement id different from the old id;
  - old authority missing returns `lease_authority_absent`;
  - cross-agent, wrong-workspace, wrong-work-mount, session-key mismatch,
    generation mismatch, and invalid proof still reject;
  - `peerId`, `bootId`, `controllerEpoch`, `sessionId`, and `connectionId`
    drift return `caller_context_session_mismatch`;
  - old authority survives release, force release, dead-VM eviction, idle reap,
    expired renew, and caller-context refresh until fake-clock TTL expiry;
	  - concurrent reacquire records one replacement transition and validates every
	    caller before returning that replacement;
	  - refreshed caller context alone does not authorize old stale work.
- Add caller-context red tests proving typed resolution differentiates
  `caller_context_absent`, `caller_context_stale`, and
  `caller_context_session_mismatch` instead of collapsing them into
  `undefined`.
- Add domain-handler red tests for routing `lease_reacquire`, differentiating
  `caller_context_absent`, `caller_context_stale`,
  `caller_context_session_mismatch`, `lease_authority_absent`, and
  `ownership_denied`, and preserving those typed results into command-result
  payloads.

Validation:

- `pnpm vitest run packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts --config vitest.config.ts --project unit`
- `pnpm vitest run packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts --config vitest.config.ts --project unit`
- `pnpm vitest run packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts --config vitest.config.ts --project unit`
- `pnpm vitest run packages/agent-vm/src/controller/leases/tool-vm-lease-lifecycle.unit.test.ts packages/agent-vm/src/controller/leases/lease-manager.unit.test.ts --config vitest.config.ts --project unit`
- `pnpm vitest run packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.integration.test.ts --config vitest.config.ts --project integration`
- Keep the focused integration file scoped to `lease_reacquire`, typed
  caller-context rejections, authority survival, and concurrent replacement
  behavior.

Split/replan trigger:

- If the old-lease authority store starts absorbing lease-manager lifecycle
  responsibilities beyond old-lease authority, stop and split its API before
  continuing. It owns authority/tombstones, not VM lifecycle or SSH transport.

### Slice 3: Plugin Lease Client Typed Recovery

Source requirements: R3, R6, R12, R15, R16, R17.

Behavior:

- Add plugin client API for `lease_reacquire`.
- Replace broad `absent` recovery inference with typed rejection handling.
- Distinguish local missing caller-context state from controller
  `caller_context_absent`, `caller_context_stale`,
  `caller_context_session_mismatch`, `lease_authority_absent`,
  `ownership_denied`, and terminal lease reasons.
- For cleanup release/end on retired or forgotten state, return idempotent or
  low-noise cleanup results rather than hard user-visible operation failures.
- Keep caller-context refresh allowed only when stable provenance and
  same-gateway fence still match.

Write surface:

- `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.ts`.
- `packages/openclaw-agent-vm-plugin/src/lease-client-contract.ts`.
- Plugin lease client unit tests.
- `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts`
  or a new focused `*.integration.test.ts` file for plugin client to fake
  gateway-control service recovery behavior.

TDD checkpoint:

- Add failing tests where the previous local error string
  `has no registered caller context` is produced today, then assert the client
  routes to refresh/reacquire or cleanup-low-noise for the safe cases.
- Add negative tests for `ownership_denied` and
  `lease_authority_absent`: no retry that trusts plugin fields.

Validation:

- `pnpm vitest run packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts --config vitest.config.ts --project unit`
- `pnpm vitest run packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts --config vitest.config.ts --project integration`
- If the existing integration file would become too broad, create a focused
  `gateway-control-lease-client.integration.test.ts` and run that file with the
  integration project.

Split/replan trigger:

- If `ControllerLeaseRequestError.status` cannot represent the new taxonomy
  cleanly, introduce a typed result adapter instead of layering more
  status-code inference.

### Slice 4: Existing Handle Binding Gate And Replacement Swap

Source requirements: R1, R2, R13, R14, R18.

Behavior:

- Refactor returned `OpenClawSandboxBackendHandle` construction so stable
  request provenance and current lease binding are separate.
- Add a focused binding abstraction that owns current/deprecated/stale/retired
  binding state, terminal state, old SSH material tombstone, replacement swap,
  and runtime identity view.
- Every operation-time path must read the current binding through a gate:
  active-use start, heartbeat, file bridge, shell command, exec build, finalize,
  and cleanup.
- On stale evidence, tombstone old active-use state, old SSH material,
  caller-context mapping, and cache state before replacement work begins.
- After successful `lease_reacquire`, the same returned handle object uses the
  replacement lease id and SSH material.
- If reacquire fails with ownership/provenance denial, the handle becomes
  terminal for new work.
- Do not replay a failed SSH/file/exec operation after possible partial work;
  only a later caller operation may reacquire.
- `runtimeId` and `runtimeLabel` become current-binding views on the same handle
  object. After successful reacquire they reflect the replacement lease id.
  Terminal handles expose their final binding for diagnostics only and cannot
  start new work.

Write surface:

- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`.
- Create `packages/openclaw-agent-vm-plugin/src/sandbox-backend/tool-vm-handle-binding.ts`.
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-contract.ts`
  if `runtimeId`/`runtimeLabel` typing or docs need to change.
- `packages/gateway-interface/src/tool-vm-active-use.ts` only if active-use
  helper changes are required.
- `packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.unit.test.ts`
  as the canonical existing factory test file. Create a new focused unit file
  only if the existing file becomes too broad to keep readable.
- Plugin/controller integration tests for same-handle stale replacement across
  the RPC boundary.

TDD checkpoint:

- Add failing tests that keep the same returned handle alive after stale
  evidence and prove the next `runShellCommand`, file bridge operation,
  `buildExecSpec`, and `finalizeExec` do not call `lease_use_start`,
  heartbeat, SSH, or file bridge with the old raw lease id or old SSH identity.
- Add concurrent stale-handle tests showing two handles cannot inherit
  replacement authority without each passing a controller-vetted path.
- Add an explicit no-replay test for R18: when an SSH/file/exec operation has
  potentially started and then fails stale, that same operation is not replayed
  automatically. Only the next caller operation may reacquire.
- Assert visible runtime identity semantics: before stale it reflects the
  current lease; after reacquire it reflects the replacement lease; after
  terminal denial it cannot be used for new work.

Validation:

- `pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.unit.test.ts --config vitest.config.ts --project unit`
- `pnpm vitest run packages/openclaw-agent-vm-plugin/src/controller-integration.integration.test.ts --config vitest.config.ts --project integration`
- If a new focused binding unit file is created, add that file to the targeted
  command instead of relying on the broad unit suite.

Split/replan trigger:

- If runtime identity cannot be represented as current-binding views without
  changing the OpenClaw contract, stop and return to plan/spec before
  weakening the same-handle reacquire requirement.

### Slice 5: Lifecycle Observability And Health Separation

Source requirements: R7, R8, R20.

Behavior:

- Add lifecycle event fields for operation, lifecycle state/transition,
  caller-context state, typed rejection class, raw internal lease/use
  correlation where needed, public hashed old lease id, public hashed
  replacement lease id, public hashed active-use id, correlation, and stable
  transition id.
- Separate plugin observations from the controller's authoritative final
  decision.
- Ensure health summaries preserve Tool VM SSH, lease/use RPC,
  gateway-control session, gateway service health, MCP/provider, and Discord
  boundaries.
- Ensure exported telemetry/logs/manual/package artifacts omit raw ids,
  `identityPem`, and proof keys.

Write surface:

- `packages/gateway-control-contracts/src/index.ts` for wire-safe lifecycle
  `health_event` payload shape and JSON schema snapshots. This file is a hot
  file; do not edit it in parallel with Slice 1.
- `packages/gateway-interface/src/health/agent-vm-health.ts`.
- `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.ts`.
- `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`.
- `packages/agent-vm/src/observability/health-event-telemetry.ts`.
- `packages/agent-vm/src/controller/health/tool-vm-status-aggregation.ts`.
- Health/observability unit tests.
- `packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.unit.test.ts`.
- `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts`.
- Create
  `packages/agent-vm/src/controller/control-session/gateway-control-lifecycle-events.integration.test.ts`
  for plugin observation -> controller final decision -> telemetry projection.

TDD checkpoint:

- Add tests for one stale-to-reacquire flow that emits plugin observation
  evidence and exactly one controller authoritative final decision with a stable
  transition id.
- Add aggregation tests proving Tool VM SSH stale does not degrade
  gateway-control-session, gateway-service-health, or Discord summaries.
- Add contract roundtrip tests proving lifecycle fields survive
  `GatewayControlHealthEventPayloadSchema` and
  `GatewayControlRpcMessageSchema`.
- Add one raw-vs-hashed proof: controller aggregation can still correlate raw
  internal ids, while exported telemetry contains only hashes or redacted
  values.

Validation:

- `pnpm vitest run packages/gateway-control-contracts/src/*.unit.test.ts packages/gateway-interface/src/health/agent-vm-health.unit.test.ts packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-event-publisher.unit.test.ts packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts packages/agent-vm/src/observability/health-event-telemetry.unit.test.ts packages/agent-vm/src/controller/health/tool-vm-status-aggregation.unit.test.ts --config vitest.config.ts --project unit`
- `pnpm vitest run packages/openclaw-agent-vm-plugin/src/controller-integration.integration.test.ts --config vitest.config.ts --project integration`
- `pnpm vitest run packages/agent-vm/src/controller/control-session/gateway-control-lifecycle-events.integration.test.ts --config vitest.config.ts --project integration`

Split/replan trigger:

- If the event model gets too broad, narrow lifecycle fields to lease/Tool-VM
  lifecycle event variants and keep non-lease health events unchanged.

### Slice 6: Deterministic OpenClaw/VM Stale-Reacquire Proof Harness

Source requirements: R1, R2, R3, R5, R13, R16, R17, R18.

Behavior:

- Add or extend a no-skip OpenClaw/VM proof that boots the real controller,
  managed OpenClaw gateway VM, gateway-control RPC path, Tool VM lease, and
  Tool VM SSH/file or shell path.
- Add a deterministic stale-evidence trigger for the incident class:
  an authenticated, e2e-only stale-reacquire probe holds the same returned
  OpenClaw sandbox backend handle across two operations. The harness forces the
  current lease's Tool VM SSH path stale by closing/quarantining the current
  Tool VM runtime or TCP slot through test-owned controller/VM handles, not by
  adding a production controller HTTP lease route. The next operation on the
  same handle must reacquire before new work or return a typed denial without
  using the old lease id.
- Keep gateway-to-Tool-VM SSH as the only raw SSH leg.
- Prove there is no fallback to old direct controller HTTP lease routes.
- The e2e route/hook must be disabled by default, proof-signed like the current
  write/read e2e probe, body-size bounded, path constrained, and unavailable to
  ordinary production OpenClaw callers.

Write surface:

- `packages/agent-vm/src/integration-tests/openclaw-subagent-lease.openclaw.e2e.test.ts`
  or a new `*.openclaw.e2e.test.ts` file when isolation is cleaner.
- E2E harness helpers only if they are needed to trigger deterministic stale
  SSH/file evidence.
- `packages/openclaw-agent-vm-plugin/src/tool-vm-write-read-e2e-tool.ts` only
  if extending the existing signed e2e probe is cleaner than adding a new
  signed stale-reacquire probe file.

TDD checkpoint:

- Add a failing OpenClaw/VM test or harness-enabler assertion that cannot pass
  with the current stale caller-context behavior.
- Then implement the smallest deterministic trigger and proof path needed to
  make the e2e meaningful. Do not mark existing write/read proof as sufficient
  unless it exercises stale evidence and reacquire/retire behavior.
- Required assertions:
  - the first operation records an old lease id and succeeds;
  - the harness forces the old lease's SSH path stale while preserving the same
    returned backend handle;
  - the next operation either uses `lease_reacquire` and a replacement
    `newLeaseId !== oldLeaseId`, or returns a typed terminal denial;
  - no `lease_use_start`, heartbeat, SSH, file, or exec work uses the old lease
    after stale evidence;
  - telemetry includes plugin observation and one controller final decision.

Validation:

- `pnpm test:e2e:inventory` as inventory only.
- `mise exec -- pnpm test:e2e:openclaw` as the no-skip OpenClaw proof.

Split/replan trigger:

- If deterministic stale SSH injection cannot be made reliable in the current
  harness, stop and record the blocker. Keep unit/integration proof status
  separate; do not claim the OpenClaw/VM layer.

### Slice 7: Docs And Generated Manuals

Source requirement: R9.

Behavior:

- Update canonical docs to explain current-lease renew, stale-lease reacquire,
  old-lease retirement, typed rejections, no-old-lease-work, and health split.
- Update generated manual templates so deployment agents diagnose Tool VM SSH,
  lease/use RPC, gateway-control session, gateway service, MCP/provider, and
  Discord as separate failure surfaces.
- Keep host observability enabled. Do not document disabling observability as a
  fix for the cutover.

Write surface:

- Canonical docs under `docs/architecture/**`, `docs/subsystems/**`, or
  `docs/reference/configuration/**` as the implementation shows the right home.
- `packages/agent-vm/src/cli/manual-templates.ts`.
- `packages/agent-vm/src/cli/manual-templates.unit.test.ts`.
- `packages/agent-vm/src/integration-tests/manual-cli.host.e2e.test.ts` if the
  built CLI smoke needs new assertions.

TDD checkpoint:

- Add manual-template assertions for renewal/reacquire, no-old-lease-work, and
  health split before updating template text.
- Run built CLI manual update smoke when generated output matters.

Validation:

- `pnpm vitest run packages/agent-vm/src/cli/manual-templates.unit.test.ts --config vitest.config.ts --project unit`
- `pnpm vitest run packages/agent-vm/src/integration-tests/manual-cli.host.e2e.test.ts --config vitest.config.ts --project e2e-host`

Split/replan trigger:

- If canonical docs span several ownership pages, split canonical docs and
  generated manual edits into two commits but keep both required before
  implementation review.

### Slice 8a: Version, Beta, And PR-Ready Release Proof

Source requirement: R10.

Behavior:

- Bump every publishable `@agent-vm/*` package to a fresh unpublished version
  after implementation proof is ready.
- Verify package version sync and local packed package contents before merge.
- Sync local tarballs into beta, verify installed package source, and run beta
  validation/build/start plus the Slice 6 authenticated stale-reacquire Tool VM
  operation.
- Produce a PR-ready receipt. This slice does not merge or publish.

Write surface:

- Package manifests for publishable `@agent-vm/*`.
- Lockfile only as required by the package-manager workflow.
- No runtime behavior code in this slice.

External write scopes:

- Repo-local writes: package manifests and lockfile only after implementation
  proof is ready.
- Sibling beta deployment writes: `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`
  modifies the beta deployment and requires the user-approved beta validation
  phase.
- npm registry writes: not allowed in Slice 8a.

TDD checkpoint:

- This slice is release proof, not product TDD. The gate is exact command
  evidence and tarball/registry inspection.

Validation:

- `pnpm check`
- `bash scripts/check-package-version-sync.sh`
- Verify the fresh version is unpublished before claiming release readiness:
  `AGENT_VM_RELEASE_VERSION="$(jq -r .version packages/agent-vm/package.json)"`.
  For every publishable package listed below, `npm view "${package_name}@${AGENT_VM_RELEASE_VERSION}" version`
  must fail with not-found before publish.
- `PACK_DIR=/private/tmp/agent-vm-toolvm-lease-renewal-pack`
- `mkdir -p "$PACK_DIR"`
- `pnpm --filter @agent-vm/agent-vm pack --pack-destination "$PACK_DIR"`
- Inspect packed `package/package.json` for sibling `@agent-vm/*` pins.
- Inspect packed `package/managed-images.json` for intended managed image tags
  and no npm package version pins.
- Also pack and spot-check touched published packages:
  `@agent-vm/gateway-control-contracts` and
  `@agent-vm/openclaw-agent-vm-plugin`, checking that generated schemas or
  shipped files do not contain `identityPem`, proof keys, raw active-use ids,
  raw lease ids outside private test fixtures, or credential substrings.
- Use `tar -xOf "$PACK_DIR"/agent-vm-*.tgz package/package.json` and
  `tar -xOf "$PACK_DIR"/agent-vm-*.tgz package/managed-images.json` for the
  root package inspection; use the corresponding tarball names for touched
  package spot-checks.
- `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`
- In beta, verify installed package source/version before runtime proof:
  - `node -p "require('./node_modules/@agent-vm/agent-vm/package.json').version"`
  - `node -p "require('./node_modules/@agent-vm/openclaw-agent-vm-plugin/package.json').version"`
  - `node -p "require('./node_modules/@agent-vm/gateway-control-contracts/package.json').version"`
- In beta: `pnpm validate`
- In beta: `pnpm exec agent-vm validate --config config/system.jsonc --mcp-live`
- In beta: `mise exec -- pnpm build`
- In beta: `mise exec -- pnpm start`
- In beta: run the Slice 6 authenticated stale-reacquire Tool VM probe against
  the installed package. Success signal:
  - first Tool VM operation succeeds and records an old lease hash;
  - the same backend handle observes forced stale SSH/lease evidence;
  - the next operation reports `status: ok` with `newLeaseIdHash != oldLeaseIdHash`
    or a typed terminal denial;
  - `health-snapshot` separates Tool VM SSH/lease lifecycle from
    gateway-control-session and gateway-service-health.

Publishable package list for registry verification:

```text
@agent-vm/agent-portal-sdk
@agent-vm/agent-vm
@agent-vm/agent-vm-worker
@agent-vm/config-contracts
@agent-vm/control-protocol-contracts
@agent-vm/controller-execution-contracts
@agent-vm/gateway-control-contracts
@agent-vm/gateway-interface
@agent-vm/gondolin-adapter
@agent-vm/mcp-portal
@agent-vm/openclaw-agent-vm-plugin
@agent-vm/openclaw-gateway
@agent-vm/secret-management
@agent-vm/tool-portal
@agent-vm/worker-control-contracts
@agent-vm/worker-gateway
```

Split/replan trigger:

- If beta cannot run, record the blocker and leave repo-local proof separate.
  Do not claim beta or release readiness from repo-only tests.

Completion receipt:

- `PR-ready complete`: implementation proof, review findings addressed, package
  versions fresh and synced, local packs inspected, beta installed package
  source verified, beta stale-reacquire Tool VM probe passed or explicitly
  blocked with evidence, PR checks/review state ready.

### Slice 8b: Post-Merge Publish Proof

Source requirement: R10.

Behavior:

- Publish only after explicit merge/release authorization, release PR merge, and
  local `master` fast-forwarded to `origin/master`.
- Publish through the repo helper from the release source.
- Verify every published package with `npm view`.
- Inspect the published root package tarball and spot-check touched package
  tarballs before calling release complete.

Write surface:

- No source edits expected. This slice writes to the npm registry and temporary
  pack directories only.

External write scopes:

- npm registry publish is a side effect and requires explicit release
  authorization plus the merged/fast-forwarded release source.

Validation:

- `git checkout master`
- `git pull --ff-only origin master`
- `git status --short --branch`
- `pnpm check`
- `bash scripts/check-package-version-sync.sh`
- `set -a; source .env.local; set +a; scripts/publish-local.sh`
- `AGENT_VM_RELEASE_VERSION="$(jq -r .version packages/agent-vm/package.json)"`
- For every publishable package listed above:
  `npm view "${package_name}@${AGENT_VM_RELEASE_VERSION}" version`.
- `PUBLISHED_PACK_DIR=/private/tmp/agent-vm-toolvm-lease-renewal-published-pack`
- `mkdir -p "$PUBLISHED_PACK_DIR"`
- `npm pack "@agent-vm/agent-vm@${AGENT_VM_RELEASE_VERSION}" --pack-destination "$PUBLISHED_PACK_DIR" --json`
- `tar -xOf "$PUBLISHED_PACK_DIR"/agent-vm-*.tgz package/package.json`
- `tar -xOf "$PUBLISHED_PACK_DIR"/agent-vm-*.tgz package/managed-images.json`
- Spot-check published `@agent-vm/gateway-control-contracts` and
  `@agent-vm/openclaw-agent-vm-plugin` tarballs for absence of `identityPem`,
  proof keys, raw active-use ids, raw lease ids outside private test fixtures,
  and credential substrings.

Completion receipt:

- `post-merge publish complete`: merged source confirmed, publish helper
  completed, `npm view` confirmed every publishable package at the intended
  version, published tarballs inspected, and no sensitive export found.

## Requirements / Proof Matrix

| Req | Owning slice | Proof layer | Evidence source | Freshness guard | Red/green |
| --- | --- | --- | --- | --- | --- |
| R1 old stale lease ids are never used for new Tool VM SSH work | 4, 6 | unit, integration, OpenClaw/VM | handle tests, plugin/controller integration, no-skip OpenClaw e2e | same returned handle after stale; old lease id and old SSH are observable in test fakes but not used | required |
| R2 stale handles reacquire or retire before next active-use start | 3, 4, 6 | unit, integration, OpenClaw/VM | lease-client and handle tests | next operation on stale handle is tested | required |
| R3 missing caller-context mapping avoids hard local 409 when safe recovery/cleanup exists | 3, 4 | unit, integration | previous error string covered | assertion includes `no registered caller context` | required |
| R4 ownership/provenance remains fail-closed | 2 | unit, integration | controller lease RPC negatives | cross-agent, workspace, workMount, session-key, generation, proof cases | required |
| R5 refreshed caller context alone cannot authorize old stale work | 2, 4 | unit, integration, OpenClaw/VM | controller authority and handle tests | old id cannot start new active use | required |
| R6 retired cleanup is idempotent or low-noise | 3, 5 | unit, integration | lease-client cleanup and telemetry tests | repeated release/end path | required |
| R7 final lifecycle decision is observable | 5 | unit, integration, OTEL/log shape | health event and telemetry tests | operation, hashes, caller-context state, rejection, transition id, correlation | required |
| R8 health summaries keep layers separate | 5 | unit, integration | tool-vm status aggregation | Tool VM stale cannot become gateway/Discord outage | required |
| R9 docs/manuals teach renewal model and health split | 7 | unit, host e2e smoke | manual-template tests, built CLI manual update | generated text from current templates | required |
| R10 release proof includes version, pack, publish, registry, tarball | 8a, 8b | quality, beta, release | command outputs and tarball inspection | 8a blocks on implementation/review/beta readiness; 8b blocks on explicit release authorization, merged PR, fast-forwarded release source, and current registry state | required |
| R11 same-id renew only for current leases | 2, 3 | unit, integration | lease-manager/RPC/client tests | stale/retired cannot return same id current | required |
| R12 provenance and session attachment remain distinct | 2, 3 | unit, integration | controller caller-context tests | refreshed session allowed only with stable provenance and fence match | required |
| R13 old handle tombstones old active-use, SSH, caller context, and cache before replacement | 4 | unit, integration | binding gate and tombstone tests | old material unreachable before replacement work | required |
| R14 concurrent stale handles cannot share authority without controller-vetted path | 2, 4 | unit, integration | concurrency tests | each handle independently validates or retires | required |
| R15 typed rejection taxonomy is canonical end-to-end | 1, 3, 5 | unit, integration | contract, lease-client, telemetry tests | exact enum identifiers from spec | required |
| R16 stale-led replacement uses explicit `lease_reacquire`, not `lease_create` | 1, 2, 3 | unit, integration | contract and RPC tests | normal create reuse path cannot satisfy stale replacement | required |
| R17 successful reacquire returns `newLeaseId !== oldLeaseId` | 2, 3, 4 | unit, integration | controller and plugin tests | old id retired/tombstoned when present | required |
| R18 replay only before SSH/file/exec work starts | 4, 6 | unit, OpenClaw/VM | handle and e2e tests | mid-operation failure not replayed | required |
| R19 reacquire authority comes from controller-owned old-lease authority plus current caller context | 2 | unit, integration | authority store/RPC tests | missing authority returns `lease_authority_absent` | required |
| R20 plugin observations and controller final decision are separated with transition-id dedupe | 5 | unit, integration, OTEL/log shape | event publisher/domain handler/telemetry tests | exactly one authoritative final decision per transition | required |

## Execution DAG

```text
gate 0: repo/source re-anchor
  - git status
  - read accepted spec, plan, and workflow state
  - confirm no unrelated dirty files in intended write set
  |
  v
slice 1: contract vocabulary and typed taxonomy
  |
  v
slice 2: controller authority/tombstones and renew/reacquire semantics
  |
  v
slice 3: plugin lease client typed recovery and cleanup behavior
  |
  v
slice 4: returned handle binding gate and old-binding tombstone
  |
  +-------------------------------+
  |                               |
  v                               v
slice 5: observability/health     slice 6: deterministic OpenClaw/VM proof
  |                               |
  +---------------+---------------+
                  |
                  v
slice 7: canonical docs and generated manuals
                  |
                  v
integration gate: parent reviews diff, hot files, and proof matrix
                  |
                  v
targeted validation gate: slice commands and red/green evidence
                  |
                  v
full validation gate: pnpm test:unit, pnpm test:integration, pnpm check,
                      e2e inventory, no-skip OpenClaw/VM proof
                  |
                  v
implementation-review-swarm
                  |
                  v
slice 8a: fresh version, local pack, beta installed-source proof,
          beta stale-reacquire proof, PR-ready receipt
                  |
                  v
implementation-pr-wrapup: PR checks, review threads, and mergeability
                  |
                  v
explicit merge/release authorization + merged PR + fast-forwarded master
                  |
                  v
slice 8b: post-merge publish helper, npm registry verification,
          published tarball inspection
```

Parallelization:

- Slice 4 is a serialized hotspot; do not let another worker edit
  `sandbox-backend-handle-factory.ts` in parallel.
- Hot files are serialized, not lane-parallel:
  - `packages/gateway-control-contracts/src/index.ts`: Slice 1 owns
    `lease_reacquire` vocabulary first; Slice 5 may return for lifecycle
    `health_event` payload fields only after Slice 1 names settle.
  - `packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.ts`:
    Slice 2 owns `lease_reacquire` routing and typed rejection shaping; Slice
    5 may return for health/lifecycle event ingestion only after Slice 2 result
    mapping is stable.
  - `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts`:
    Slice 4 owns handle rebinding; do not mix e2e-probe edits into this file in
    the same checkpoint unless Slice 4 proof is already green.
- Slice 5 can start after Slice 1 field names settle, but final event semantics
  must be reconciled after Slice 4.
- Slice 7 can draft operator wording after field names settle, but final manual
  proof waits for Slice 5 evidence names.
- Slice 8a starts only after implementation proof and implementation review are
  addressed. It may bump versions, inspect local packs, sync beta tarballs, and
  produce a PR-ready receipt, but it must not publish.
- Slice 8b starts only after explicit release authorization, PR merge, and a
  local `master` fast-forward to `origin/master`. It is the only slice allowed
  to write to the npm registry.

## Checkpoint Commit Rhythm

Checkpoint commits should be narrow and proven:

1. Accepted spec + reviewed implementation plan artifacts.
2. Slice 1 after contract unit proof.
3. Slice 2 after controller authority proof.
4. Slice 3 after plugin client proof.
5. Slice 4 after same-handle rebinding proof.
6. Slice 5 after observability/health proof.
7. Slice 6/7 after OpenClaw/VM proof and docs/manual proof.
8. Slice 8a after version sync, fresh unpublished-version proof, local pack
   inspection, beta installed-source verification, beta stale-reacquire proof,
   and PR-ready wrapup.
9. Slice 8b after explicit release authorization, merged PR, fast-forwarded
   `master`, publish helper success, `npm view` verification for every
   publishable package, and published tarball inspection.

Do not stage unrelated files. Do not treat commits as proof; attach command
evidence to the checkpoint.

## Validation Gates

Targeted unit gates:

```bash
pnpm vitest run packages/gateway-control-contracts/src/*.unit.test.ts --config vitest.config.ts --project unit
pnpm vitest run packages/openclaw-agent-vm-plugin/src/openclaw-lease-contract.unit.test.ts --config vitest.config.ts --project unit
pnpm vitest run packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-lease-client.unit.test.ts --config vitest.config.ts --project unit
pnpm vitest run packages/agent-vm/src/controller/control-session/gateway-control-caller-context.unit.test.ts --config vitest.config.ts --project unit
pnpm vitest run packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.unit.test.ts --config vitest.config.ts --project unit
pnpm vitest run packages/agent-vm/src/controller/control-session/gateway-control-domain-handler.unit.test.ts --config vitest.config.ts --project unit
pnpm vitest run packages/agent-vm/src/controller/leases/tool-vm-lease-lifecycle.unit.test.ts packages/agent-vm/src/controller/leases/lease-manager.unit.test.ts --config vitest.config.ts --project unit
pnpm vitest run packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.unit.test.ts --config vitest.config.ts --project unit
pnpm vitest run packages/gateway-interface/src/health/agent-vm-health.unit.test.ts packages/agent-vm/src/observability/health-event-telemetry.unit.test.ts packages/agent-vm/src/controller/health/tool-vm-status-aggregation.unit.test.ts --config vitest.config.ts --project unit
pnpm vitest run packages/agent-vm/src/cli/manual-templates.unit.test.ts --config vitest.config.ts --project unit
```

Targeted integration gates:

```bash
pnpm vitest run packages/agent-vm/src/controller/control-session/gateway-control-lease-rpc.integration.test.ts --config vitest.config.ts --project integration
pnpm vitest run packages/openclaw-agent-vm-plugin/src/gateway-control-service/gateway-control-service.integration.test.ts --config vitest.config.ts --project integration
pnpm vitest run packages/openclaw-agent-vm-plugin/src/controller-integration.integration.test.ts --config vitest.config.ts --project integration
pnpm vitest run packages/agent-vm/src/controller/control-session/gateway-control-lifecycle-events.integration.test.ts --config vitest.config.ts --project integration
```

Broad gates:

```bash
pnpm test:unit
pnpm test:integration
pnpm test:e2e:inventory
mise exec -- pnpm test:e2e:openclaw
pnpm check
```

Beta gates:

```bash
pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta
```

Then in beta:

```bash
pnpm validate
pnpm exec agent-vm validate --config config/system.jsonc --mcp-live
mise exec -- pnpm build
mise exec -- pnpm start
```

The beta runtime proof must include a real Tool VM file/read or shell operation
through the installed package. If beta cannot run, record the blocker and keep
repo proof separate.

Release gates:

```bash
bash scripts/check-package-version-sync.sh
AGENT_VM_RELEASE_VERSION="$(jq -r .version packages/agent-vm/package.json)"
PACK_DIR=/private/tmp/agent-vm-toolvm-lease-renewal-pack
mkdir -p "$PACK_DIR"
pnpm --filter @agent-vm/agent-vm pack --pack-destination "$PACK_DIR"
tar -xOf "$PACK_DIR"/agent-vm-*.tgz package/package.json
tar -xOf "$PACK_DIR"/agent-vm-*.tgz package/managed-images.json
pnpm --filter @agent-vm/gateway-control-contracts pack --pack-destination "$PACK_DIR"
pnpm --filter @agent-vm/openclaw-agent-vm-plugin pack --pack-destination "$PACK_DIR"
```

Before PR-ready is claimed, every publishable package must also be checked as
fresh/unpublished with `npm view "${package_name}@${AGENT_VM_RELEASE_VERSION}"
version`; each command must fail as not found. A registry hit means the release
version is already burned and the full package set needs a new version before
continuing.

Post-merge publish, only after explicit release authorization, merged PR, and
local `master` fast-forwarded to `origin/master`:

```bash
git checkout master
git pull --ff-only origin master
git status --short --branch
pnpm check
bash scripts/check-package-version-sync.sh
set -a; source .env.local; set +a; scripts/publish-local.sh
AGENT_VM_RELEASE_VERSION="$(jq -r .version packages/agent-vm/package.json)"
for package_name in \
	@agent-vm/agent-portal-sdk \
	@agent-vm/agent-vm \
	@agent-vm/agent-vm-worker \
	@agent-vm/config-contracts \
	@agent-vm/control-protocol-contracts \
	@agent-vm/controller-execution-contracts \
	@agent-vm/gateway-control-contracts \
	@agent-vm/gateway-interface \
	@agent-vm/gondolin-adapter \
	@agent-vm/mcp-portal \
	@agent-vm/openclaw-agent-vm-plugin \
	@agent-vm/openclaw-gateway \
	@agent-vm/secret-management \
	@agent-vm/tool-portal \
	@agent-vm/worker-control-contracts \
	@agent-vm/worker-gateway
do
	npm view "${package_name}@${AGENT_VM_RELEASE_VERSION}" version
done
PUBLISHED_PACK_DIR=/private/tmp/agent-vm-toolvm-lease-renewal-published-pack
mkdir -p "$PUBLISHED_PACK_DIR"
npm pack "@agent-vm/agent-vm@${AGENT_VM_RELEASE_VERSION}" --pack-destination "$PUBLISHED_PACK_DIR" --json
tar -xOf "$PUBLISHED_PACK_DIR"/agent-vm-*.tgz package/package.json
tar -xOf "$PUBLISHED_PACK_DIR"/agent-vm-*.tgz package/managed-images.json
npm pack "@agent-vm/gateway-control-contracts@${AGENT_VM_RELEASE_VERSION}" --pack-destination "$PUBLISHED_PACK_DIR" --json
npm pack "@agent-vm/openclaw-agent-vm-plugin@${AGENT_VM_RELEASE_VERSION}" --pack-destination "$PUBLISHED_PACK_DIR" --json
```

## Security And Reliability Constraints

- A stale raw lease id is a correlation key only, never authority.
- Reacquire must use controller-owned old-lease authority/tombstone state plus a
  current caller context.
- Re-registering caller context must not bridge ownership, workspace, workMount,
  session-key, boot, epoch, or peer drift.
- Old SSH material must be unreachable from handle operation code before
  replacement work begins.
- If local tombstone succeeds but controller reacquire fails, the old handle
  remains terminal for new work.
- Concurrent stale handles must not inherit replacement authority from each
  other without independent controller-vetted validation.
- Retry and reacquire timers must be bounded and jittered when shared failures
  can affect multiple zones or agents.
- Exported telemetry, logs, manuals, package artifacts, schemas, and public docs
  must omit raw `identityPem`, proof keys, raw active-use ids, and raw lease ids
  unless an explicitly private control-message contract requires them. Exported
  evidence uses hashes.
- Host observability stays enabled; this work must improve operator evidence,
  not hide it.

## Split And Replan Triggers

Stop implementation and reconverge before writing more code if any of these
happen:

- The selected contract fields cannot express `lease_reacquire` without
  overloading `lease_create`.
- The controller cannot preserve bounded old-lease authority after release or
  force release without widening persistent state beyond this spec.
- The returned handle cannot safely support mutable binding without a new helper
  abstraction.
- The deterministic OpenClaw/VM stale proof cannot be made no-skip and stable.
- Observability changes require disabling zone or host observability.
- Release/package proof requires changing managed OpenClaw upstream version or
  managed image tags without explicit maintainer permission.

## Phase Footer

phase_result: complete
evidence:
- docs/specs/2026-07-08-toolvm-lease-renewal-implementation-plan.md
- tmp/plan-workflows/2026-07-08-toolvm-lease-renewal/implementation-plan.md
- tmp/plan-workflows/2026-07-08-toolvm-lease-renewal/plan-ledger.md
recommended_next_workflow: shravan-dev-workflow:implementation-execute-plan
recommended_transition_reason: The implementation plan maps R1-R20 to vertical
slices, proof gates, release gates, write surfaces, split triggers, and folded
plan-review findings; product code can begin only after orchestrator records
the official transition.
