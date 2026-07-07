# Implementation Plan — Socket.IO Control Plane Hard Cutover

Date: 2026-07-02
Status: 2026-07-05 multi-agent correction folded after focused plan-review + scope-and-proof-fit folded (4B/9I/7N) + independent plan-review folded (5 blockers + 11 important +
3 questions) + architecture re-review folded (2026-07-02, 4 grounded lanes: git-execPolicy ownership BLOCKER →
new SG (SSH Git) slice; AF-2 deliveryPolicy-trust + AF-3 message-kind spec hardening; PC-1..6 anchor corrections; D3
multi-gateway decision). All findings parent-verified against spec text + live code + the Gondolin checkout.
Ready for implementation-execute-plan starting with SMA. Full control-plane cutover remains gated by GATE-0a and the
open user decisions below.
Source specs (accepted, all 8 fresh-review blockers closed):
- docs/specs/2026-07-01-socketio-control-protocol-semantics.md (PROTO, 1047 lines)
- docs/specs/2026-06-30-gateway-control-session-hard-cutover.md (CUT, 2382 lines)
Ledger: docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md
Plan lanes: lanes/codebase-boundary.md, lanes/validation-proof.md, lanes/security-reliability.md (parent-verified).
External full-system proof target: `../shravan-claw-beta` with actual Discord and actual OpenClaw. Mock-only,
fake-provider, or package-local proof can satisfy lower rows, but it is not a substitute for the full-system lane
when validating live managed behavior.

## Goal

Cut managed gateway/worker VMs over from raw guest→host controller.vm.host:18800 TCP callbacks to
controller-initiated Socket.IO-over-WebSocket control sessions through Gondolin ingress, with one shared
protocol contract, per-domain RPC, and no dual path.

The terminal proof includes a real deployment pass through `../shravan-claw-beta` with actual Discord and actual
OpenClaw. The beta proof is intentionally separate from unit/integration/e2e-openclaw harnesses: those prove the
owned implementation layers, while beta proves the delivered system still works with the live external event source
and managed OpenClaw runtime.

## Non-goals (from the specs; do not expand)

- No sidecar control service (managed OpenClaw uses in-process plugin handleUpgrade).
- No single-agent downgrade. Managed OpenClaw remains a same-zone multi-agent surface when `zones[].agents` declares
  multiple trusted agents. The cutover must preserve per-agent workspaces, `agentToolVmProfiles`, per-agent auth
  files/seeds, channel routing, and agent-scoped Tool VM lease identity. The valid trust boundary is "declared agent
  allowlist plus controller-vetted caller context", not "exactly one declared agent".
- No move of Worker task submit/state/close off ingress HTTP (only git tools + observations move).
- No SSH data-plane change; Tool VM SSH stays raw TCP tool-<slot>:22.
- No credentialed-runner execution; no generic guest/host RPC.
- Collector-mode observability replacement is IN for this cutover. The old raw
  collector `tcpHosts` path is forbidden, but enabled OpenClaw zone
  observability must continue through Gondolin HTTP mediation to the configured
  loopback collector. Tool VM SSH remains the only raw TCP exception.
- LONG-RUNNING / DAYS-LONG TASKS (user-confirmed model, non-goals for THIS cutover):
  - No worker/gateway-internal task-state durability. State persistence is EXTERNAL (a future session DB) and file
    durability is Gondolin drives; both are out of scope here. Recovery = RECREATE the VM (fresh boot, no RAM
    migration — Gondolin gives disk-only checkpoints/auto-restart), resuming from that external state later.
  - No headless task continuation: "a worker does not run without the controller." A control-session outage
    quiesces the peer; it does not drive an autonomous days-long task with no controller attached.
  - No durable-session-store seam is defined now (user: skip it). Control-session state stays inline in the S3
    runtime; externalizing it is deferred to the future durability rework.
  - No same-VM adoption after controller process restart. Gondolin 0.12.0 exposes session IPC attach for
    exec/snapshot-style access, but not a public API that reconstructs a full `VM`/managed wrapper with
    `enableIngress()` and lifecycle methods. For this cutover, controller process restart/redeploy is a managed-VM
    recreate boundary, not a same-VM reconnect guarantee. Transport/socket flaps while the controller process still
    owns the VM handle remain cheap reconnects inside the death-grace window.
- No gateway-internal external-event durability (e.g. inbound Discord/queue events lost if a gateway's own queue
  fails). That is gateway-internal, same bucket as worker-internal durability — the control session guarantees
  control/observation continuity, not the gateway's external-event intake.
  The non-goal does not remove the live beta proof requirement: the final validation still exercises actual Discord
  and actual OpenClaw to prove the managed path is wired, while not claiming durable Discord-event replay.
- CONTROLLER RESOURCE CEILING (hard invariant, PROTO "Controller Resource Ceiling"): the controller is a resilient
  lightweight control/stream BROKER, never a data plane. Per-session + total controller memory stays bounded
  regardless of volume; heavy data never transits the controller heap or the control socket (forbidden_bulk is
  schema-invalid); any data streaming is brokered onto separate host-terminated paths (SSH raw TCP, work mount,
  brokered direct duplex), never proxied through memory. Proof: CONTROLLER-CEILING (S3).

## Lane reasoning-effort + set used

Batch-1 lanes ran at high effort (codebase-boundary, validation-proof, security-reliability — proof-heavy,
security, cross-module). Parent synthesized slice cards + DAG directly from batch-1 evidence (the 7 slices are
spec-enumerated and batch-1 already mapped write scopes, proof, constraints, and serialization order), then
dispatched one scope-and-proof-fit lane (high effort) as the independent fit check. vertical-slice-decomposition
and execution-order were folded into parent synthesis rather than dispatched — recorded here per the skill's
"name the smaller lane set used" rule; the fit lane is the adversarial check on that synthesis.

## GATE 0 — cutover feasibility spike (pre-S1 fail-fast; may STOP the whole cutover)

GATE-0 is split (I7) into a throwaway feasibility spike (here, pre-S1) and productionized work (S2). Only the
spike gates the cutover; production handleUpgrade lands in S2 and depends on S1's handshake schema.

VERSION PROVENANCE PREREQUISITE (B1 — resolve BEFORE GATE-0a). OpenClaw v2026.6.8 is the selected accepted runtime
for this PR. This matches the managed image package overrides and beta validation package line. Any downgrade or
future runtime change requires fresh GATE-0a/runtime evidence for plugin `handleUpgrade(req, socket, head)` plus
pre-101 private auth.
GATE-0a must run against the exact delivered OpenClaw runtime artifact, not a remembered/local SDK declaration. Steps:
- Build or inspect the generated managed image/overlay that this PR delivers.
- Assert in the VM/runtime that `openclaw --version` reports the selected runtime, v2026.6.8.
- If the delivered runtime differs from v2026.6.8, stop and fix the PR inputs
  before running the Socket.IO upgrade proof.
- If the selected runtime cannot provide handleUpgrade-before-101, STOP and route back to spec.

GATE-0a (pre-S1, THROWAWAY spike, no S1 dependency): against that exact runtime artifact, prove the OpenClaw plugin
API can host a detached Socket.IO/Engine.IO server through handleUpgrade(req, socket, head) that: exposes HTTP
readiness; validates a credential and returns 101 or rejects BEFORE the connection completes; accepts a Socket.IO
client over /__agent-vm/gateway-control with transports:["websocket"] on good credential; rejects bad credential
before 101; opens NO second guest port. Disposable spike, not production code. Today the repo SDK shim
(openclaw-sandbox-sdk-contract.ts:87-118) has ZERO handleUpgrade refs.
- LIBRARY PRIMITIVE (verified, de-risks the spike): the Socket.IO/Engine.IO side IS expressible —
  construct `new Server({ transports: ["websocket"], path: "/__agent-vm/gateway-control" })` unattached and
  drive it with `io.engine.handleUpgrade(req, socket, head)`; `allowRequest` (or pre-handoff inspection) runs
  BEFORE the 101 so a bad credential is rejected without completing the handshake. So GATE-0a's residual STOP
  risk is narrowly "does the pinned OpenClaw plugin API actually hand the plugin the raw upgrade (req, socket,
  head) on its own guest port" — NOT whether Socket.IO can be fed externally (it can). CAVEAT: the Socket.IO
  `path` must exactly match the private route on both ends; if any outer layer rewrites the path the connection
  silently fails — assert the path in the spike.
- Proof: generated Dockerfile/package-plan assertion + in-VM `openclaw --version` + SDK compat against that exact
  runtime + good/bad WS upgrade with rejection before 101.
- If that runtime CANNOT provide a pre-101 private-auth hook (and no version bump supplies it) → STOP, route back to
  spec (CUT Stop Conditions:2372). No sidecar / controller.vm.host / polling / raw-WS fallback. STOP is reachable
  from GATE-0a alone (does not need the full INGRESS-1 e2e).

GATE-0b (productionized, IN S2 after S1): add handleUpgrade to the SDK shape shim + sdk-compat unit test; wire the
real plugin route with full nonce+signature+generation validation using S1's handshake schema.

Note (I5): the WORKER control service is plain Node/Hono on the standard Node `upgrade` event — it does NOT carry
GATE-0's pinned-OpenClaw-API STOP risk. It still needs its own handshake proof (e2e-worker) but is not gated by
the OpenClaw feasibility spike.

## Chosen deferred constants (ordering invariants are normative; values grounded in code anchors)

Single exported constant module lands in Slice 1 (@agent-vm/control-protocol-contracts) so proof imports the
same source the runtime uses. Values below satisfy PROTO's timing-order invariants (PROTO ~657-681):

| constant | value | grounding / invariant |
| --- | --- | --- |
| lease-use-heartbeat cadence | 30_000 ms | = current heartbeatAfterMs (lease-manager.ts:162); < TTL |
| active-use TTL / heartbeat-stale | 120_000 ms | = current heartbeatStaleMs = 2*60*1000 (lease-manager.ts:163). NOTE: the code invariant is stale >= 3x cadence (>=90s min); the ACTUAL value is 120s. Plan uses 120_000 to match current behavior — heartbeat 30s < 120s w/ 4x margin (>=3 missed → stale) |
| control-session-connect-timeout | 3_000 ms | = existing controller-health probe budget; connect+ack < 10s |
| control-ack-timeout | 2_000 ms | connect(3s)+ack(2s)=5s < active-use-start 10s budget (invariant 2) |
| active-use-start budget | 10_000 ms | = lease-use-start timeoutMs (controller-request-policy.ts) |
| control-command-execution-timeout | per-op: lease 5–10s, git 120s | = existing per-op policies; git = worker-push 120s |
| control-resync-timeout | 5_000 ms | resync is a hello exchange on an already-connected socket → compare to ack round-trip (2s), not connect+ack; 5s gives hello margin above ack. NOT in PROTO's normative ordering list, so no BP-4 assertion |
| Engine.IO pingInterval / pingTimeout | 10_000 / 10_000 ms | transport death ~20s < lease stale 120s → transport_error classified before lease expiry (invariant 3; agent-vm owns liveness) |
| Socket.IO reconnect send buffer | NEUTRALIZED for application messages — NO constructor option exists (verified); mechanism = clear `socket.sendBuffer` on connect/reconnect (or an emit wrapper); `volatile.emit` for latest_wins/droppable only | NORMATIVE ordering invariant (PROTO 671-673): stale buffered emits must not flush as fresh liveness/mutation. socket.io-client has no "disable send buffer" option, so BP-3 asserts the S3 reconnect-clear/wrapper behavior, NOT a constructor flag |
| maxHttpBufferSize | 65_536 B (64 KiB) | > lease snapshot w/ multi-KB identityPem + envelope; << bulk; below Socket.IO 1MB default (invariant: floor derived from largest legit msg) |
| queue message-count cap | 256 msgs | PLANNING DEFAULT (no code anchor) — overflow closes/stales; tune in impl w/ load evidence |
| queue byte cap | 4 MiB | PLANNING DEFAULT (no code anchor) — bounded; tune in impl |
| dedupe/replay window | 512 messageIds AND >= 60s | PLANNING DEFAULT (no code anchor) — sized to cover max in-flight + max reconnect gap; proof asserts no-replay-outside-window behavior, not the magnitude; tune in impl |
| recovery consecutiveFailureThreshold | 3 | = existing gateway-vm-recovery-policy.ts:32 (reuse for control-session-unhealthy) |
| control-session-death / recovery grace | large multiple of heartbeat cadence — PLANNING DEFAULT (tune under load, NOT guessed here) | DAYS-LONG model: SEPARATE from the 120s active-use TTL. This is how long a control session may be disconnected/reconnecting before the owning controller process gives up and RECREATES the VM. Transport death (~20s Engine.IO) triggers cheap RECONNECT; recovery (expensive VM recreate) fires ONLY after this grace elapses with no reconnect. Must be resilient enough that a network blip or peer/socket flap does NOT trigger recreation while the controller process still owns the VM/ingress handle. Controller process restart/redeploy is not covered by this reconnect promise in this cutover; it is a recreate boundary unless a future Gondolin VM-adoption API is specified and proven. Applies to BOTH gateway and worker (workers get the same large grace) |
| manual reconnect backoff | initial 250 ms, max 5_000 ms, jitter 20% | controller-owned manual reconnect must not run as a fixed 1s loop; retries use bounded exponential backoff with jitter so multi-zone reconnects do not thundering-herd after a shared network blip |
| priority ack stale threshold | 3 consecutive failures | a single heartbeat/operation_cancel ack miss is operator evidence, not terminal session death; terminal stale requires N consecutive priority ack failures and resets on a successful priority ack |
| recovery budget (max failed recoveries, cooldown, reset) | unchanged | reuse existing recoveryBudgets |
| per-source observation budget | mirror threshold (NEW) | forged-observation cap; NEW value, tune in impl |

Four values (queue message/byte caps, dedupe/replay window, per-source observation budget) lack a direct code
anchor and are labeled PLANNING DEFAULT — proof asserts the ORDERING/behavior, not the magnitude; magnitudes
tune under load.

## Vertical slice cards

### SMA — OpenClaw same-zone multi-agent preservation (PLAN REPAIR, before implementation-execute-plan)
- Source: user correction 2026-07-05; existing OpenClaw multi-agent docs and code anchors:
  `docs/reference/configuration/system-json.md` Tool VM profile policy, `docs/getting-started/openclaw-guide.md`
  lease identity, `openclaw-tool-vm-lease-create-options.ts` agent-scoped profile selection.
- Behavior: remove the accidental Socket.IO-cutover rule that rejects managed OpenClaw zones with more than one
  declared trusted agent. Preserve the legitimate checks: OpenClaw zones must declare at least one agent,
  duplicate agent ids reject, `agentToolVmProfiles` and `agentSandboxSeeds` may only reference declared agents,
  caller-context registration rejects undeclared/forged `adapterEvidence.agentId`, and Tool VM leases resolve by
  `authorityContext.agentId`.
- Existing boundary to preserve: `gateway-control-caller-context.ts` already verifies the OpenClaw session key is
  agent-shaped and that the session-key agent equals `adapterEvidence.agentId`; `gateway-control-lease-rpc.ts`
  already checks lease ownership using stable fields (`agentId`, workspace, boot/epoch/peer, purpose,
  sessionKeyDigest, workMountDir, zoneId) rather than transient `sessionId`/`connectionId`. Implementors should
  preserve and extend tests around those boundaries, not add a vague future "attestation" blocker.
- Hard security invariant: before issuing `callerContextId`, the controller must verify a plugin-signed
  caller-context proof and validate `agentId`, `agentWorkspaceDir`, `workMountDir`, and `sessionKeyDigest` against
  controller-owned declared-agent config and agent-owned path policy. The managed OpenClaw plugin signs the evidence
  with the controller-generated control-session `callerContextProofKey` using HMAC-SHA256; the key is injected only
  through the controller-owned private VM environment and is not serialized into plugin config, effective OpenClaw
  config, overlays, runtime records, readiness credentials, or accepted session records. Declared-agent allowlisting
  and `sessionKeyDigest` alone are not sufficient. A declared agent with a workspace or work mount that belongs to
  another agent, a shared ambiguous fallback, a mismatched session key, or an invalid proof must fail closed. Same
  stable provenance with refreshed ephemeral connection/session ids may keep lease reachability; changed workspace,
  work mount, session-key provenance, or proof provenance must not.
- Current trust boundary: this HMAC blocks model/tool-shaped payloads and stale guest-visible config from minting
  caller contexts outside the plugin path, but it is not controller-trusted active-agent attestation against a fully
  compromised plugin process that can read private VM environment. Full compromised-plugin provenance requires a
  future OpenClaw/session attestation source or a controller-issued per-agent capability that is not resident in the
  same guest trust domain.
- Write surface: EDIT `system-config.ts`, `gateway-zone-orchestrator.ts`, `init-command.ts`,
  `manual-templates.ts`, `docs/reference/configuration/system-json.md`, `docs/subsystems/controller.md`,
  `docs/getting-started/openclaw-guide.md`;
  EDIT targeted tests in `system-config.unit.test.ts`, `gateway-zone-orchestrator.integration.test.ts`,
  `agent-vm-entrypoint.unit.test.ts`, `init-command.integration.test.ts`, `manual-templates.unit.test.ts`,
  `openclaw-tool-vm-lease-create-options.unit.test.ts`, `mcp-portal-effective-config.unit.test.ts`, and
  `config-validation.integration.test.ts` where the existing parity tests do not already cover multiple agents.
- Checkpoint: the same-zone multi-agent fixture loads/scaffolds; declared non-default-agent caller context is accepted
  and remains non-default downstream; undeclared, mismatched-session-key, wrong-workspace, wrong-work-mount, and
  invalid-proof caller contexts still reject; `agentToolVmProfiles` still chooses the agent-specific Tool VM profile;
  Tool Portal/MCP Portal effective config still requires parity with all declared agents; generated manuals no
  longer teach single-agent cutover.
- Proof: SMA-1..SMA-7 in the canonical proof matrix. Layer: unit + integration + manual-generation smoke + beta
  validation. Red/green is required because current code fails the accepted behavior.
- Dependency: independent of GATE-0a. SMA may be implemented/reviewed before the runtime spike, but no production
  control-plane cutover slice may claim readiness until both SMA and GATE-0a have passed. Split trigger: if
  caller-context identity binding must defend against a fully compromised OpenClaw plugin, route back to spec for a
  new OpenClaw/session attestation source before claiming that stronger property.
- Workspace rule: same-zone multi-agent requires explicit per-agent workspace entries or a controller-proven mapping
  that resolves to distinct agent-scoped mounts/workdirs. Ambiguous shared fallback is invalid for SMA.

### S1 — control-protocol-contract (FOUNDATION, first, disjoint create + one-time shared wiring)
- Source: PROTO Shared Package Contract, Shared Envelope, delivery/close/handshake schemas; ledger.
- Behavior: the shared Zod+JSON-Schema contract every other slice imports; the constant module above.
- Write surface: CREATE packages/control-protocol-contracts/** (leaf, zod-only; template = controller-execution-contracts,
  version 0.0.102). ALSO scaffold empty shells for packages/gateway-control-contracts/** and
  packages/worker-control-contracts/** (so shared wiring is edited once). Shared wiring (owned here):
  tsconfig.base.json paths, scripts/verify-portal-package-exports.ts, scripts/audit-portal-architecture.ts
  (add 3 packages to portalPackageNames + runtimePortalImportPrefixes).
- Checkpoint: 3 packages build + typecheck + export; contract unit suite green; JSON Schema export snapshot. The two
  empty shells (gateway/worker-control-contracts) MUST carry placeholder exports so pnpm test:portal-exports passes
  before S4a/SWa populate them (N5).
- Proof: SCHEMA-1..6, DELIVERY-1/2 (queue-policy unit), BP-4 (timing-order over the constant module),
  BP-5, HANDSHAKE-1, DOMAIN-SEP-1. Layer: unit (pnpm test:unit) + architecture-gate.
- Dependency: none. Split trigger: if JSON-Schema export tooling is non-trivial, split exporter into its own task.

### S2 — gateway-control-service-placement (after S1; contains GATE-0b productionization)
- Source: CUT Placement And Route Ownership:706-776, Handshake Requirements.
- Behavior: OpenClaw plugin hosts the private Socket.IO server + GET /__agent-vm/ready (nonce issue) +
  /__agent-vm/gateway-control upgrade, pre-101 auth, on the existing OpenClaw guest port (no 2nd port). This is the
  OpenClaw-specific PLACEMENT/binding of the generic `gateway_control` domain (D3) — the domain contract stays in
  gateway-control-contracts; only the hosting/registration lives here in the plugin.
- Write surface: EDIT openclaw-sandbox-sdk-contract.ts assertSdkShape:87-118 (+ sdk-compat.unit.test.ts),
  openclaw-plugin-registration.ts (Socket.IO server + upgrade hook + ready route — S2 OWNS the register()
  structure; S4/S7 layer in additively, S5 removes last — see I1); CREATE
  openclaw-agent-vm-plugin/src/gateway-control-service/**; EDIT openclaw-lifecycle.ts (expose paths).
  Dep += socket.io, control-protocol-contracts, gateway-control-contracts.
- Nonce state machine (Imp6): the readiness endpoint issues a nonce; the upgrade validates + atomically consumes it
  before 101. Define the lifecycle explicitly: issued → consuming → accepted | failed | expired. Required behavior:
  if validation consumes the nonce but the Engine.IO/Socket.IO handoff fails before a usable session exists → state
  failed, the consumed nonce is NOT reusable, the client must request a FRESH nonce (fresh-ready retry); pending
  (issued/consuming) nonces expire on a bounded TTL and are swept; a duplicate VALID nonce is rejected without
  evicting the incumbent accepted session (ties to PROTO duplicate_session). Owner: S1 schema + S2 implementation.
- Checkpoint: GATE-0b — pre-101 private auth proven over the real plugin route with S1's handshake schema; nonce
  state machine incl. failed-handoff + TTL-expiry paths.
- Proof: HANDSHAKE-2/3/4 (integration, S2 seam alone — STOP-decision level), HANDSHAKE nonce failed-handoff +
  TTL-expiry (integration), P.1 in-VM-attacker (e2e); INGRESS-1/INGRESS-2/HANDSHAKE-5 are a JOINT S2+S3 e2e-openclaw
  proof (need the controller client to dial) — N6.
- Dependency: S1 (+ GATE-0a spike already passed pre-S1). Split trigger: none beyond GATE-0a/0b already split.

### S3 — controller-session-runtime (after S1; parallel with S2/worker)
- Source: CUT slice route; PROTO reconnect/resync, fencing, backpressure.
- Behavior: controller Socket.IO CLIENT connection manager, generation binding, reconnect/resync, stale handling,
  session health state machine; dials each VM after ingress readiness.
- Write surface: CREATE packages/agent-vm/src/controller/control-session/**; EDIT controller-runtime.ts:369
  (compose), gateway-zone-orchestrator.ts:888-925 (dial after enableIngress). Dep += socket.io-client,
  control-protocol-contracts, gateway-control-contracts. Reconnect send buffer NEUTRALIZED for application
  messages (N3; PROTO 671-673 normative invariant) — there is NO socket.io-client option to disable it, so S3
  clears `socket.sendBuffer` on connect/reconnect (or wraps emit) and reserves `volatile` for latest_wins/
  droppable; BP-3 asserts this behavior against the real client, not a constructor flag.
- Controller restart boundary: S3 does not claim same-VM adoption across a controller process restart. Persisted
  control-session material supports fencing/cleanup and future-safe state inspection, but Gondolin 0.12.0 attach IPC
  does not recover the `VM` lifecycle/ingress object. A restarted controller must recreate the affected managed VM
  for this cutover; only in-process transport/socket flaps use the cheap reconnect/resync path.
- Checkpoint: controller establishes a session to a fake VM Socket.IO server; reconnect/resync + fencing hold;
  AND the per-domain RPC dispatch seam is an EXTENSION POINT (register handlers per domain) so S4/SW add
  handlers additively rather than editing a shared central router (I2 — removes a hidden shared-mutable surface).
- Proof: DELIVERY-3/4/5(b), FENCE-1(integration), BP-1/2/3, FLAP-1(a) deterministic, BP-3 reconnect-buffer config
  asserted against the real constructed client options. Layer: integration (NEW rig, SIBLING to
  gateway-websocket-client.integration.test.ts — do NOT reuse the raw-WS rig). S3 authors the FLAP-1(b) soak rig
  (N7; runs in the cutover gate under AGENT_VM_OPENCLAW_E2E=1).
- Dependency: S1. Split trigger: split connection-manager from reconnect/resync from queue/backpressure.

### S4a — gateway-control contract (FULL union) + lease-rpc-parity (after S1+S3; register on S3 seam)
- Source: CUT Gateway Control RPC Contract:975-987, SURFACE-1.
- Behavior: S4a OWNS the complete gateway domain contract, not just lease ops (B4). Domain = GENERIC
  `gateway_control` (D3 resolved), NOT openclaw-named; OpenClaw-specific detail stays in the plugin. It lands the
  full GatewayControlRpcOperationSchema + message union covering control_ping, caller_context_register,
  lease_create/get/peek/renew/release,
  lease_use_start/heartbeat/end, health_event, runtime_status, tool_portal_controller_host_action, operation_cancel,
  recovery_command — with envelope/domain/operation consistency. S4a IMPLEMENTS the lease/use handlers; the non-lease
  handlers are implemented by their owning slices against this one contract (health_event + runtime_status → S6b/S6c;
  tool_portal_controller_host_action → S7; operation_cancel/recovery_command → S3/S4a). One owner for the shared
  union prevents ad hoc/absent non-lease messages.
- Write surface: POPULATE gateway-control-contracts/** with the FULL operation union + all message/payload schemas;
  CREATE controller lease/use RPC handlers REGISTERED on the S3 dispatch seam (additive — I2); REMOVE
  controller-lease-client.ts (+test), update sandbox-backend-handle-factory.ts; EDIT controller-request-policy.ts
  (remove lease-* op group — HOT FILE single-owner sequence, I1).
- Checkpoint: gateway union includes EVERY spec operation (rejects missing/extra); lease create/renew/use-start/
  heartbeat/end/release parity over RPC; caller_context_register validates untrusted OpenClaw adapter evidence and
  returns only an opaque controller-issued callerContextId before lease_create; identityPem never logged.
  Lease ownership is bound to stable controller-vetted provenance
  (`zoneId`, `peerId`, `bootId`, `controllerEpoch`, `agentId`,
  `agentWorkspaceDir`, `workMountDir`, `sessionKeyDigest`, `purpose`), not raw
  `callerContextId`, `sessionId`, or `connectionId`; a reconnect that refreshes
  caller-context/session/connection ids but presents the same stable provenance
  must keep existing Tool VM leases reachable, while different agent/workspace/
  session-key provenance is rejected.
- Proof: B4 union-completeness unit (enum + message union == spec set, missing/extra rejected, envelope↔domain↔
  operation consistency), SURFACE-1, DELIVERY-3/4 (lease ops), L.1 identityPem custody (see expanded L.1 below).
  Layer: unit + integration (extend gateway-zone-orchestrator.integration.test.ts + lease-manager).
- Dependency: S1, S3. Split trigger: split contract-union population from lease-handler impl if the union is large.

### S4b — server-side controller-route disposition (COMPLETE table — B3; after each family's caller moves)
- Source: CUT server-side disposition:463-469 ("removed from callers" is insufficient; server route must be
  deleted or operator-auth-gated, else it is a shippable fallback the hard cutover forbids).
- Behavior: every old managed-VM-reachable controller route is deleted or operator-auth-gated; each gets a residue
  proof row (RESIDUE-6). Complete disposition table (parent-verified all live):

```text
route family                                  live at                                    disposition   owner  after
────────────────────────────────────────────  ─────────────────────────────────────────  ────────────  ─────  ─────
POST /lease, GET /lease/:leaseId,             controller-http-routes.ts:386/536/548       delete OR      S4b    S4a
  POST /lease/:leaseId/renew,                   (NO auth). identityPem emitted by ALL       operator-gate
  /lease/:leaseId/uses*, DELETE /lease/:id      THREE of /lease, GET :id, renew via
  (Tool VM SSH identityPem on 3 of them)        serializeLeaseForResponse (route-support.ts:145,155)
POST /zones/:zoneId/health-events             controller-health-event-routes.ts:88         delete OR      S6b    S6a
  (unauthenticated today)                        (unauth)                                    operator-gate
POST /zones/:zoneId/openclaw-runtime-status   controller-http-routes.ts:771                delete OR      S6b    S6a
                                                                                            operator-gate
POST /zones/:zoneId/zone-git/push             deleted in S7; old zoneGitToken guard        delete        S7     S7
  (removed with direct VM push route)             must not ship as guest config/env residue
GET /leases                                    controller-http-routes.ts:612                delete        S4b    —
```
- Delete vs operator-auth-gate is a USER implementation decision (Q1, reclassified — the spec ALREADY permits
  either at CUT:468-470, so this is NOT a spec-creation loop). Pick per family; default: DELETE the VM-mutation
  routes (/lease*, health-events, runtime-status, zone-git/push) since no legitimate caller remains post-cutover.
  Event 189 resolved the stale `/leases` contradiction in favor of the implemented hard cutover: DELETE
  `GET /leases`; any future operator lease diagnostic must be a separate authenticated/admin design.
- Write surface: EDIT controller-http-routes.ts, controller-health-event-routes.ts, controller-zone-operation-routes.ts.
- Checkpoint: each removed family 404s; any retained family requires operator auth; no unauthenticated VM-reachable
  lease/health/runtime/git mutation route remains.
- Proof: RESIDUE-6 per family (integration: 404 on deleted, 401/403 on retained). Layer: integration.
- Dependency: each family after its caller-side slice (lease→S4a, health/runtime→S6a, zone-git→S7). Q1 default
  chosen above; only revisit if the user wants retention-with-auth for a specific family.

### S5 — managed-openclaw-hard-cutover (REMOVAL, LAST; heavy overlap)
- Source: CUT Hard Cutover Invariants, residue rules, Current-State inventory.
- Behavior: remove all raw controller.vm.host paths, old MCP Portal identity, fail-closed for websocketBypass;
  delivered tcpHosts only tool-<slot>:22. Collector observability must use mediated OTLP HTTP, not raw tcpHosts.
- Write surface (S5a raw-TCP + monitors): EDIT openclaw-lifecycle.ts buildGatewayTcpHosts (:75 constructs
  `${controllerVmHost}:18800`; :81-83 is a plain websocketBypass→tcpHosts mapping loop TODAY — there is NO
  fail-closed check there yet, so S5a ADDS/PROVES the fail-closed behavior, it does not "find" it). ANCHOR
  CORRECTION (PC-1): controller.vm.host is NOT removed at openclaw-lifecycle.ts:1011 — that line only CALLS
  `gatewayVmAllowedHosts(zone.egressHosts)`. The literal lives at gateway-interface/src/audience.ts:11 and the
  UNCONDITIONAL injection is `gatewayVmAllowedHosts` at audience.ts:29-31 (`[controllerVmHost, ...]`). Removing
  controller.vm.host from allowedHosts EDITS audience.ts (Imp3); worker-lifecycle.ts:31 calls the same helper.
  REMOVE gateway-control-link-monitor.ts, zone-git-tool.ts; EDIT openclaw-plugin-registration.ts (HOT FILE; S5
  does the FINAL removal after S2/S4/S7 — I1). ORPHAN CLEANUP (PC-2): once controller-lease-client.ts (S4a),
  zone-git-tool.ts + gateway-control-link-monitor.ts (S5a) are gone, the plugin's re-export barrel
  openclaw-agent-vm-plugin/src/controller-request-policy.ts + its .unit/.integration tests + the
  `export * from './controller-request-policy.js'` in index.ts:3 are dead — DELETE them here. Also EDIT generated
  manual output: manual-templates.ts:188 still emits "gateway-control-link ... controller.vm.host:18800" — a
  SHIPPABLE generated-doc residue (Imp11).
- Write surface (S5b mcp-portal identity + IMAGE, own task — I8): remove openclaw-mcp-portal-plugin identity across
  agent-vm/package.json:48, tsconfig.build.json, managed-image-dockerfile.ts:13,354 (IMAGE),
  openclaw-deployment-doctor.ts, manual-templates.ts, e2e-harness.ts, tsconfig.base.json.
- Checkpoint: residue audits green (S5a — tcpHosts SET==only tool-<slot>:22 AND allowedHosts drops controller.vm.host,
  each with a planted-positive fixture); generated manual output carries no gateway-control-link/controller.vm.host;
  managed image REBUILDS without mcp-portal (S5b).
- Proof: RESIDUE-1/2(non-collector)/3/4/5 (architecture-gate + unit + boot-fail-closed integration) + allowedHosts
  residue row; RESIDUE-audit contract (Imp11) distinguishes FORBIDDEN shippable surfaces (generated manuals/docs,
  delivered VM specs, package load identity) from ALLOWED historical (specs/tests/fixtures), with planted positives
  AND generated-manual-template + generated-manual-OUTPUT coverage; PLUS an image-build smoke rebuilding the managed
  image without mcp-portal (I8 — e2e-host-docker, or drop the "image
  builds" claim if not provable at this layer). Rollback: VERSION PIN.
- Dependency: S2, S4a, S4b, S6, S7, SW (all live callers moved first). Split: S5a (raw-TCP+monitors) |
  S5b (mcp-portal identity+image) | S5c (collector mediated-OTLP replacement).
- FINAL-SHIPMENT STOP (Imp1 + CUT Stop Condition:2375): the cutover CANNOT SHIP / be released while
  collector-mode observability either recreates managed gateway raw tcpHosts or is disabled without a replacement.
  The accepted OPEN-2 disposition is superseded by user requirement: enabled OpenClaw zone observability must build
  and route OTLP HTTP to the host collector through Gondolin HTTP mediation. `tcpHosts` remains only Tool VM SSH.

### S6 — operator-health-observability (after S3; SPLIT S6a/S6b/S6c — I3)
- Source: CUT Health And Operator Contract, recovery-trigger mapping, correlation allowlist.
- CONTRACT-PURITY decision (affects S6a): new control-session eventKind enum — DEFAULT keep in gateway-interface
  in-place (it already owns the reducer + depends on gondolin-adapter; contract packages stay transport-only).

S6a — eventKind remap (mechanical, low-risk):
- Write surface: EDIT gateway-interface/src/health/agent-vm-health.ts (control-link→control-session); blast radius
  8+ files (health-event-telemetry, controller-telemetry, gateway-vm-recovery-policy:330, controller-runtime:323/729,
  gateway-service-health-monitor, durable-health-event-log, gateway-zone-state-machine, controller-health-event-routes);
  EDIT controller-request-policy.ts (HOT FILE; remove controller-health/health-event-publish/openclaw-runtime-status
  op group — via the single owner sequence, I1).
- Proof: RESIDUE-5. Layer: unit + architecture-gate.

S6b — recovery corroboration + per-source budget (LOAD-BEARING incident-amplifier fix; security O.2/O.3):
- Write surface: gateway-vm-recovery-policy.ts (control-session-unhealthy trigger; require controller-probe
  corroboration AND-gate; per-source observation budget); controller-health-event-routes.ts:88 (delete/auth-gate the
  unauthenticated publish route — coordinated with S4b table).
- Budget KEY must be controller-owned identity (Imp7): {domain, zoneId, gatewayVmId, bootId, generationId} derived
  from the accepted control session, NOT self-reported payload fields — else a compromised gateway spoofs the source
  key to dodge the budget. The budget only meaningfully caps a source when the key is un-spoofable.
- RESILIENCE (days-long model): recovery = RECREATE the VM (fresh boot), which is expensive, so it must NOT be
  hair-triggered. Transport death (~20s Engine.IO) drives a cheap RECONNECT; recovery fires ONLY after the
  control-session-death grace (large multiple of heartbeats — constants table) elapses with no successful reconnect.
  A network blip or peer/socket flap must reconnect within the grace and NOT recreate while the owning controller
  process is still alive. A controller process restart/redeploy is outside this same-VM reconnect promise in this
  cutover because Gondolin 0.12.0 does not expose a public full-VM adoption API; the restarted controller recreates
  the managed VM. Applies to gateway AND worker (worker gets the same large grace; "no worker without controller" —
  a lost session quiesces the peer, it does not fail the task). After a genuine recreate, the new VM boots with a
  NEW bootId; the lingering old-boot/old-epoch session is fenced.
- Checkpoint: recovery requires probe corroboration AND the death-grace elapsed with no reconnect; forged failing
  observations under one controller-owned source key cannot exceed per-source budget nor drive recovery without
  corroboration; an in-process reconnect within grace cancels any pending recovery. Runtime-status evidence used to
  authorize Tool VM lease creation is bound to the accepted session that delivered it (`bootId`, `controllerEpoch`,
  `peerId`, `sessionId`, and `connectionId`); a prior boot/session snapshot is stale for lease authority even inside
  the wall-clock freshness window.
- Proof: RECOVERY-1/2 (budget key = controller identity; spoofed payload source rejected) + RESILIENT-GRACE (no
  recovery before grace; in-process reconnect within grace cancels it; controller process restart is a recreate
  boundary) + RECREATE-FENCE (post-recreate new-bootId session accepted, old-boot/old-epoch fenced). Layer: unit +
  integration. WORKER-domain corroboration path BLOCKED on Q2 (probe source).

S6c — correlation/trace to operator evidence:
- Write surface: correlation allowlist + agent-vm-health reducer propagation (traceId/runId/sessionKeyDigest/toolCallId).
- Proof: CORR-1. Layer: integration + unit (allowlist real-filter).
- Dependency (all S6*): S3. Split trigger: applied (S6a/S6b/S6c).

### S7 — tool-portal-backend-taxonomy (after S1; parallel; overlaps S5 for zone_git_push)
- Source: CUT Backend Taxonomy, residue table.
- Behavior: backend-kind rename (mcp→mcp_provider, credentialed_runner→tool_vm_runner/controller_host_action);
  zone_git_push becomes tool_portal_controller_host_action (not a model tool); forbidden-import gates.
- Write surface: EDIT config-contracts/src/tool-portal-config.ts:31,33,137 + tool-portal consumers +
  testing/index.ts; EDIT audit-portal-architecture.ts (S1 overlap); EDIT openclaw-plugin-registration.ts (HOT FILE;
  zone_git_push tool registration in register() — additive layer per I1, N4); zone_git_push handler via
  controller_host_action (controller-execution-contracts has controller-host-action-boundary/).
- Checkpoint: backend enum aligned; tool_portal_* exact 4-name allowlist; forbidden-edge gate green.
  Managed in-process Tool Portal entrypoints are bounded by session provenance;
  LRU eviction and runtime close retire the corresponding session-scoped MCP
  provider backend/session instead of leaving upstream MCP state alive after the
  entrypoint disappears.
- Proof: RESIDUE-4, backend-kind unit, DOMAIN-SEP. Layer: unit + architecture-gate.
- Dependency: S1. Split trigger: rename from zone_git_push-controller-host-action.

### SW — worker git-tools → worker_control_rpc (after S1+S3; SPLIT SWa/SWb/SWc — I5)
- Source: CUT Worker Control Session And RPC Contract; worker narrowed scope.
- Behavior: worker_control_rpc for git_push/git_pull_default + runtime observations/recovery; worker VM-side
  Socket.IO server + /__agent-vm/worker-ready; controller-originated
  `operation_cancel` is hard-rejected in this PR so it cannot become a second
  task-close path; task submit/state/close STAY on ingress HTTP. Worker runtime
  observations/status/capacity snapshots are agent-progress diagnostics, not
  zone health or VM-recovery inputs in this cutover. VM/session liveness stays
  owned by `/health`, private control-session heartbeat, and recovery evidence.
  If worker-progress correlation becomes operator-visible beyond the append-only
  task event log, it must be added to task evidence/task snapshots with a real
  worker-owned correlation source; do not invent one from the ready-handshake
  requestId or route it through `AgentVmHealthEvent` without a spec revision.
- NOTE: worker control service is plain Node/Hono on the standard Node `upgrade` event — NOT gated by GATE-0's
  pinned-OpenClaw-API STOP. Still needs its own HANDSHAKE proof (e2e-worker).

SWa — contract population:
- Write surface: POPULATE packages/worker-control-contracts/** (worker op union, git payloads, observations).
  Git payload fields must be EXPLICIT (Imp5): git_push carries repoUrl/branchName + optional expectedHead (the
  ff precondition); the agent-facing payload names ONLY its own branch + optional expectedHead. Protected-branch /
  default-branch policy is NOT in the payload — it is resolved controller-side from trusted zone/repo state (CUT
  1870-1886). Today's push schema (controller-request-schemas.ts:126) is only repoUrl+branchName and
  ActiveWorkerTaskRepo (active-task-registry.ts:25) carries NO protected-branch policy — SWa defines the trusted
  policy source the controller reads.
- Proof: worker schema unit, DOMAIN-SEP (worker op on gateway union rejected); expectedHead-is-precondition schema
  unit; event-only worker operations (`worker_capacity_snapshot`, `worker_runtime_status`,
  `worker_runtime_observation`) cannot appear as `command_result`. Layer: unit.

SWb — worker VM-side server + private route:
- Write surface: CREATE packages/agent-vm-worker/src/control-session/** (first worker socket.io import; shares Node
  process; Hono /health,/tasks STAY); attach WS upgrade + GET /__agent-vm/worker-ready; provision controller public
  key at boot (security G0.1 worker path).
- Proof: worker HANDSHAKE (nonce+signature, atomic consume) under e2e-worker (AGENT_VM_WORKER_E2E=1). Layer: integration + e2e-worker.

SWc — controller handlers + rewire + residue:
- Write surface: REWIRE git-push-tool.ts, git-pull-default-tool.ts, controller-tool-support.ts:132,
  task-runner.ts:172 off CONTROLLER_BASE_URL; EDIT worker-lifecycle.ts:34,:61-63 (+unit test:56); EDIT
  controller-request-policy.ts (HOT FILE; remove worker-push-branches/worker-pull-default via single owner
  sequence — I1); CREATE controller worker-RPC handlers REGISTERED on the S3 dispatch seam (additive — I2),
  invoking git-push-operations.ts / git-pull-default-operations.ts. ADD controller-side pre-push checks (Imp5):
  refuse default/protected branch resolved from trusted worker gateway `repoPushPolicies` config, force/non-ff,
  ref delete; expectedHead is a ff-precondition, never --force-with-lease. Worker task request repos are not trusted
  policy input; if a task repo lacks a matching controller-configured push policy, controller push fails closed before
  Git I/O. ORPHAN CLEANUP (PC-2): the worker's LOCAL
  agent-vm-worker/src/work-phase/controller-tools/controller-request-policy.ts is NOT a re-export barrel — it
  defines its own fetchWorkerControllerWithPolicy, whose sole caller is controller-tool-support.ts:132 (the file
  this slice rewires). Once the worker op group is gone, delete that wrapper + its controller-request-policy.unit.test.ts.
- Checkpoint: worker push/pull-default over RPC without raw controller TCP; controller pre-push policy enforced;
  AND Worker task submit/state/close over ingress HTTP STILL WORK (regression guard — I6, I10, CUT surface proof
  2287; worker-task-runner.ts:851 posts + polls).
- Proof: worker DELIVERY (git single_use_critical), GIT-2/3 (controller push policy — protected/force/delete
  refusal + expectedHead precondition; no git pack over the control socket), RESIDUE-3, PLUS a SEMANTIC task-HTTP
  regression row (Imp10 — not just 2xx): control-socket `operation_cancel` is
  rejected and does not close an active task; submit accepted with taskId, state observable and transitions/reaches
  terminal, close cancels/terminalizes correctly. Layer: unit + integration + e2e-worker. NOTE: GIT-1 (host-boundary
  git-receive-pack denial) is owned by the new SG (SSH Git) slice — it is a Gondolin SSH-egress execPolicy proof, not a
  worker-RPC proof; SWc must not try to satisfy GIT-1 from the worker side.
- Dependency (all SW*): S1, S3. Split trigger: applied (SWa/SWb/SWc).

### SG (SSH Git) — ssh-egress-git-read-policy (git READ host boundary; NEW — closes AF-1)
- Source: CUT Git Access And Push Policy:1844-1860 ("the managed VM spec MUST set an SSH egress execPolicy");
  CUT git-access proof:2316-2322. This surface is NORMATIVE and already has a proof row (GIT-1) but had NO owning
  slice before this revision — verified NET-NEW: zero repo refs to execPolicy/git-receive-pack/git-upload-pack/
  sshEgress, and gondolin-adapter exposes only INBOUND SshAccess (vm-adapter.ts:59), not egress.
- FEASIBILITY (verified against the Gondolin checkout — NOT a STOP gate): Gondolin's host SSH server already
  supports git-verb-level egress execPolicy — `SshExecPolicy = (SshExecRequest) => SshExecDecision`
  (gondolin host/src/qemu/ssh.ts:73), git service names in host/src/ssh/exec.ts, and the confirm-bash.ts example
  distinguishes git-upload-pack (fetch) vs git-receive-pack (push). So this is an ownership/wiring gap, not a
  capability gap.
- Behavior: the delivered managed VM spec sets an SSH-egress execPolicy that ALLOWS git-upload-pack (read) to
  allowed upstream git hosts, DENIES git-receive-pack (push) unconditionally, and denies non-git exec. Receive-pack
  denied at the host boundary means the agent has no push path except the controller (defense-in-depth behind the
  no-guest-credential model). The adapter supports optional repo allowlisting for callers with a trusted repo set;
  the current OpenClaw and Worker lifecycle builders do not receive task/zone repo lists at VM-spec construction
  time, so SG does not claim lifecycle-level per-repo enforcement in this cutover.
- Write surface: (a) EXTEND gondolin-adapter to expose the Gondolin ssh-egress + execPolicy passthrough surface
  (packages/gondolin-adapter/src/vm-adapter.ts — new egress config alongside SshAccess); (b) WIRE the egress config
  (enable + execPolicy allow-upload/deny-receive/deny-non-git; no lifecycle-level repo allowlist is available in
  this cutover) into BOTH openclaw-lifecycle.ts and worker-lifecycle.ts VM-spec builders. Coordinates with S5a on
  those two hot lifecycle files (SG ADDS egress config; S5a REMOVES raw control tcpHosts — different regions,
  sequence per the hot-file note).
- Checkpoint: delivered gateway + worker VM specs carry the egress execPolicy; git-upload-pack allowed to the
  allowed upstream git host set, git-receive-pack and non-git exec denied at the host boundary.
- Proof: GIT-1 (e2e-vm — *.vm.e2e.test.ts; host-boundary receive-pack denial + upload-pack allowed; proves the
  Gondolin boundary, not a mocked policy). Layer: unit (adapter/lifecycle egress-config shape) + e2e-vm.
- Dependency: none on the control plane (the git read path is orthogonal to Socket.IO); after GATE-0a succeeds, it may
  run early in parallel with S1. Sequence its openclaw-lifecycle.ts / worker-lifecycle.ts edits against S5a. Split trigger: split the
  gondolin-adapter surface from the two-lifecycle wiring if the adapter change needs its own review.

## Execution DAG

```text
gate 0a: repo state + THROWAWAY feasibility spike (pinned OpenClaw pre-101 hook). STOP the cutover here if unprovable.
  |
SMA OpenClaw same-zone multi-agent preservation
  |  (independent of GATE-0a runtime spike; blocks implementation readiness because current code/docs contain an
  |   invalid single-agent restriction)
  |
S1 control-protocol-contract  (creates 3 pkg shells + shared wiring + constant module; owns tsconfig.base/audit scripts)
  |
  +-- S2 gateway-control-service-placement   (plugin + gateway spec; contains GATE-0b) ─┐
  +-- S3 controller-session-runtime          (controller client + RPC dispatch SEAM)    │  parallel after S1
  +-- S7 tool-portal-backend-taxonomy        (config + gates)                           │  (disjoint dirs)
  +-- SWa worker-control-contracts population (worker contract pkg)                      ─┘
  |
  +-- SG (SSH Git) ssh-egress-git-read-policy
  |                                  (gondolin-adapter egress + 2 lifecycle VM specs; git READ host boundary;
  |                                    control-plane-independent after GATE-0a; may run in parallel with S1; sequence lifecycle
  |                                    edits w/ S5a; owns GIT-1)
  |
  |   after S1 + S3 (need the session runtime + dispatch seam):
  +-- S4a lease-rpc-parity (register on S3 seam)      ─┐
  +-- S6a eventKind remap                              │  register handlers additively on the S3 seam (I2);
  +-- S6c correlation                                  │  serialize the 2 HOT files via single owner (I1)
  +-- SWb worker server + /__agent-vm/worker-ready     │
  +-- SWc worker handlers + rewire + task-HTTP guard   ─┘
  |
S4b route disposition          (after S4a; uses Q1 default unless user overrides before S4b)
S6b recovery corroboration + budget (after S6a; worker path BLOCKED on Q2)
  |
integration gate: parent reviews diffs; resolve HOT-file merges; verify no dual path
  |
S5 managed-openclaw-hard-cutover  (LAST): S5a raw-TCP+monitors | S5b mcp-portal identity+image |
                                   S5c collector mediated-OTLP replacement
  |
targeted validation gate: pnpm test:unit + test:integration + test:portal-architecture + test:portal-exports + test:taxonomy
  |
cutover proof gate (REQUIRED named lane — NOT in default test:e2e; exact commands, B5):
  mise exec -- pnpm run test:e2e:openclaw   # INGRESS-1 [S2+S3 join], FLAP-1b, P.1 (*.openclaw.e2e.test.ts)
  mise exec -- pnpm run test:e2e:worker     # worker RPC + HANDSHAKE (*.worker.e2e.test.ts)
  mise exec -- pnpm run test:e2e:vm         # GIT-1 receive-pack-denied-at-host (*.vm.e2e.test.ts; Gondolin host boundary)
  each wrapper must report nonzero tests, zero skipped, zero todo. OPEN-4: whether these join CI / a named required
  gate is a proof-infra change needing the SAME approval as editing run-e2e-proof-lanes.ts — USER decision before
  any done-claim (do not silently rely on the default 4-lane test:e2e, which excludes all three).
  |
full gate: mise exec -- pnpm test:e2e (4 default lanes) + pnpm check (typecheck/lint/lint:types/fmt/check:zod)
  |
implementation-review-swarm
```

## Write surfaces + hot-file serialization (operationalized — I1)

Disjoint after S1: S2 (plugin/gateway dirs), S3 (controller/control-session/), S7 (config-contracts/tool-portal),
SWa/SWb (worker pkg + worker control-session/). Two HOT files edited by 4 slices — CONCRETE OWNERSHIP, not just a note:
- packages/gateway-interface/src/health/controller-request-policy.ts — SINGLE OWNER lands ALL op-group removals
  (lease-* / worker-* / health-*) as ONE sequenced change (S4a/S6a/SWc feed it; S5a does the final removal). The
  plugin + worker copies are re-export barrels of this single source (no separate edits).
- packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts — S2 OWNS the register() structure; S4a and
  S7 layer their tool/route registrations in ADDITIVELY; S5a removes last. Encoded as the DAG ordering above.
- I2 seam: S3 exposes a per-domain RPC dispatch EXTENSION POINT so S4a/SWc register handlers additively — the
  controller dispatcher is NOT a shared central file both edit. (If S3 cannot make it an extension point, add the
  dispatcher file to this serialization set.)
MED-risk shared: controller-runtime.ts (S3/S4a/S6a), openclaw-lifecycle.ts (S2/S5a/SG),
worker-lifecycle.ts (SWc/S5a/SG). SG (SSH Git) ADDS ssh-egress execPolicy config; S5a REMOVES raw control tcpHosts;
different regions of the same builders — sequence, do not co-edit blindly. gateway-interface/src/audience.ts is
the REAL allowedHosts injection site (gatewayVmAllowedHosts:29-31) removed by S5a — NOT openclaw-lifecycle.ts:1011
(a call site). Mechanical shared: tsconfig.base.json, audit-portal-architecture.ts,
verify-portal-package-exports.ts (all owned by S1).

## Requirements/proof matrix

CANONICAL matrix lives in lanes/validation-proof.md (B2 — one-way link; that file does NOT point back here). Each
row there carries: requirement id → source anchor → owner slice → files → test name/command → expected RED signal →
expected GREEN signal → freshness guard → split trigger (row-level, not family-summary). Load-bearing rows echoed
here for the DAG only (full detail is in the canonical file):
- DELIVERY-1/2 lossy/advisory delivery coalesces/drops without reserving or
  advancing the hard sequence frontier; queued lossy flushes are ordered by
  envelope sequence before volatile emit.
- DELIVERY-5 append_only_observation preserves N=24 discrete health events (incident-critical; regression to
  latest_wins MUST fail). unit+integration. Owner: S1 (store) + S6c.
- FLAP-1(a) deterministic + (b) real-runtime soak (A5 motivating-assumption proof). integration (S3) + a NEW
  *.openclaw.e2e.test.ts (Imp8 — e2e-openclaw includes ONLY *.openclaw.e2e.test.ts; do NOT extend the
  .host.e2e.test.ts file, which runs under a different project).
- INGRESS-1 pre-101 private auth over real ingress (cutover prerequisite). JOINT S2+S3, NEW *.openclaw.e2e.test.ts
  (Imp8). The STOP decision itself is reachable earlier from GATE-0a + S2's HANDSHAKE-2/3/4 integration seam.
- RPC-VM-1 controller-originated gateway_control_rpc over the private managed VM route: JOINT S2+S3+S4a,
  NEW *.openclaw.e2e.test.ts. This is stronger than "Socket.IO connected": the controller must send
  `control_ping` over `/__agent-vm/gateway-control` and parse a typed gateway_control command result from the VM,
  with no fallback to controller HTTP/raw TCP and no `/socket.io` path in the route contract.
- SMA-1..SMA-7 preserve same-zone multi-agent OpenClaw: config accepts multiple declared trusted agents, scaffold
  accepts multiple `--openclaw-agents`, caller context accepts declared agents and rejects undeclared agents,
  agentToolVmProfiles resolves by agent id, manuals/docs no longer teach single-agent cutover, and beta validation
  proves the real multi-agent deployment shape is not blocked by this rule. A single-agent beta pass is explicitly
  non-evidence for SMA.
- SCHEMA versioning: protocolVersion mismatch fails closed → close reason protocol_version_mismatch (I9 — covered by
  z.literal(1) strict parse + reject-no-resync; explicit row added). Owner: S1 unit + S2 handshake integration.
- RESIDUE-1..6 (RED today, GREEN after cutover) + planted-positive fixtures so empty match sets are meaningful.
- RECOVERY-2 forged-health budget + corroboration. unit+integration. Owner: S6b (worker path gated on Q2).
- GIT-1 receive-pack-denied-at-host: e2e-vm (*.vm.e2e.test.ts) — pure Gondolin host-boundary execPolicy. OWNER = SG
  (SSH Git)
  (gondolin-adapter egress surface + openclaw/worker lifecycle wiring), NOT SWc; needs no managed-OpenClaw runtime
  context. GIT-2/3 (controller push policy, no pack over socket): SWc unit+integration.
- DELIVERY-POLICY-TRUST (AF-2, NEW): receiver derives delivery class from (operation, payload) and fails closed on
  an envelope deliveryPolicy that contradicts the derived class (parallels SCHEMA-3 kind/operation equality). unit
  (S1 operation→class binding) + integration (S3 dispatch enforcement). Owner: S1 + S3.
- KIND-EXACT (AF-3, NEW): every ControlMessageKindSchema value resolves to an owning payload/handler branch; a
  declared-but-unmapped kind fails. resync_request/resync_response removed (hello supersedes); `snapshot` removed
  from the shared kind enum because snapshots ride as domain `event` messages with latest_wins delivery; heartbeat/
  observation each mapped per PROTO kind-disposition. unit. Owner: S1.
- I6/I10 task-HTTP regression: SEMANTIC assertions (Imp10) — submit accepted w/ taskId, state observable +
  transitions/terminal, close cancels/terminalizes — NOT bare 2xx. Owner: SWc / controller-integration.
Companion always-run (Definition of Done): pnpm typecheck, lint, lint:types, fmt:check, check:zod, full pnpm check.

## Security assumptions (from lanes/security-reliability.md)

Applicable. Trust root = controller public key provisioned per-boot as plain VM env (NOT mediated secret, NOT baked
into Dockerfile); VM holds only the public verifier so in-VM untrusted model code cannot forge a session; per-session
nonce atomically consumed before 101 with the issued→consuming→accepted|failed|expired state machine (Imp6).

Control env-name collision (Imp4): runtime/user env is merged into the VM env (split-resolved-gateway-secrets.ts:108,
mergeRuntimeGatewaySecrets) and spread into VM specs. If an authored runtime env value collides with the control key
name (e.g. AGENT_VM_CONTROL_PUBLIC_KEY), the VM could verify a FORGED controller signature. Constraint: RESERVE
internal control env names (reject them as authored/runtime secret names), and INJECT controller-owned control boot
material AFTER user/runtime env so it cannot be overridden. Proof: unit — authored env colliding with a reserved
control name is rejected; control material wins the merge order.

identityPem custody (Imp9, expands L.1): frames carrying identityPem never appear in logs, traces, exports, OR
diagnostics; delivered ONLY on the single accepted current-generation session — never on a duplicate-session or
stale-generation delivery path; bounded in-memory lifetime. Proof asserts all of: logs, traces, exports,
diagnostics, duplicate-session-delivery, stale-generation-delivery.

Recovery advisory+corroborated+budgeted with a controller-owned budget key (Imp7); host githubToken never in VM,
git-receive-pack denied at host boundary; controller pre-push policy from trusted state (Imp5).
Plan/handoff artifacts carry no resolved secrets, op:// refs, or account metadata.

## Risks + rollback

- Rollback = VERSION PIN to pre-cutover package (hard cutover; no runtime dual path).
- Top risk: GATE-0a — the delivered OpenClaw runtime must be the selected runtime, v2026.6.8, and must provide
  handleUpgrade-before-101. Prove the exact delivered runtime artifact before
  trusting the spike. If the selected runtime cannot provide the hook → STOP at spec.
- Second: A5 reliability bet — if FLAP-1(b) shows the new session flaps like the old path, STOP and revise (do not
  ship). This is why FLAP-1(b) is a required gate, not optional.
- Hot-file merge contention (2 files × 4 slices) — mitigated by single-owner/strict-sequence.

## Open questions — classified blocking-before-<gate/slice> vs tune-during (fit lane B2/B3/B4/I4)

BLOCKING (must resolve before the named gate/slice; not tunable during execution):
- VERSION PROVENANCE (B1) / GATE-0a: target OpenClaw is v2026.6.8. GATE-0a must run against the EXACT delivered
  runtime artifact. Blocks the ENTIRE cutover; STOP if the selected runtime cannot provide handleUpgrade-before-101.
- OPEN-4: cutover proofs (INGRESS-1, FLAP-1b, worker RPC, GIT-1) run under env-gated lanes NOT in default
  pnpm test:e2e (VERIFIED). Exact commands are now in the cutover proof gate. USER DECISION: how these gate the
  cutover / join CI — a proof-infra change needing the SAME approval as editing run-e2e-proof-lanes.ts. Blocks the
  done-claim, not the slice work.
- Q2: worker corroboration probe source (Worker /health vs ingress readiness) — spec confirm. Blocks S6b worker path only.

USER IMPLEMENTATION DECISION (not a spec loop — review Q1 reclassification; spec already permits either at CUT:468-470):
- Q1: per-route DELETE vs operator-auth-gate for the S4b disposition table. Plan default = DELETE the VM-mutation
  routes and `GET /leases`; no unauthenticated lease-list diagnostic remains in this cutover. Confirm the default or override per family before S4b; no
  spec-creation-swarm loop needed unless a deeper semantic question exists.
- D3 (multi-gateway domain — RESOLVED, user chose GENERIC): the control domain is `gateway_control` (generic
  Tool-VM lease/use + health/runtime-status/recovery), NOT `openclaw_gateway_control`. Handshake audience is
  `z.literal("gateway_control")`. OpenClaw-specific detail (plugin-hosted route, model-tool bindings, runtime
  status specifics) lives ONLY in `@agent-vm/openclaw-agent-vm-plugin`, never in the domain contract. Both specs
  renamed. gateway-control-contracts (already generically named) owns the generic `gateway_control` domain +
  operation union. A future gateway that leases Tool VMs reuses `gateway_control` + its own runtime binding; one
  with a different op set adds its own domain. S2 remains the OpenClaw-specific PLACEMENT of the generic service.

TUNE-DURING (not blocking; magnitude/behavior tuned in implementation):
- OPEN-1 constants: ordering resolved with grounded values; 4 labeled PLANNING-DEFAULT magnitudes (queue msg/byte
  caps, replay window, per-source budget) tune under load — proof asserts ordering/behavior, not magnitude.
- OPEN-3 ControlMessageKindSchema "observation" unused: default retain-with-note; decide before S1 enum-exactness test.

## Next skill

Independent plan review already run (docs/specs/2026-07-02-socketio-control-plane/plan-review-report.md):
5 blockers + 11 important + 3 questions, ALL parent-verified against code and folded into this revision. Remaining
before implementation-execute-plan:
- GATE-0a exact delivered OpenClaw runtime proof + real-runtime handleUpgrade proof (blocks everything).
- USER decisions: OPEN-4 proof-gating disposition; Q1 per-route delete-vs-auth-gate (default = delete).
- Route to spec ONLY the genuine product/semantic call: Q2 worker corroboration probe source.
Then implementation-execute-plan. (A re-review of this revision is optional; the review's own suggested route is back
to plan-creation, which this revision satisfies.)

## External Full-System Proof

Before a PR-ready claim, run or record a blocked attempt for the external deployment proof:

- Target: `../shravan-claw-beta`.
- Required live surfaces: actual Discord integration and actual OpenClaw managed runtime.
- Evidence: command transcript or operator log proving the real deployment path, with secrets redacted.
- Freshness guard: no fake Discord provider, no mock OpenClaw process, no package-local-only assertion.
- Scope boundary: this proof validates live wiring and managed behavior; it does not claim gateway-internal
  external-event durability, which remains an explicit non-goal for this cutover.

External proof runbook:

1. Refresh beta from this worktree with `pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta`.
2. Reconcile beta's selected OpenClaw runtime before building. The current PR-selected runtime is OpenClaw v2026.6.8;
   beta must not prove against a stale, downgraded, or accidental runtime. If the runtime changes, record the GATE-0a
   evidence that made that version acceptable.
3. For SMA proof only, stage beta with at least two declared same-zone OpenClaw agents plus matching Tool Portal/MCP
   Portal agent bindings. Do not count a single-agent beta run as proof of the multi-agent repair.
4. In `../shravan-claw-beta`, run `pnpm validate` and `pnpm exec agent-vm validate --config config/system.jsonc --mcp-live`.
   Live MCP discovery must attempt every MCP Portal namespace concurrently, use
   a configurable per-namespace timeout that defaults to 12 seconds, settle all
   namespace results, use discovered tools from successful namespaces, and mark
   timed-out or failed namespaces disabled/unavailable with a safe reason in the
   validation/catalog evidence.
5. In `../shravan-claw-beta`, run `mise exec -- pnpm build`.
6. Start the beta controller with `mise exec -- pnpm start`.
7. Exercise the real Discord channel path configured by beta's OpenClaw config. The current beta target is the
   `#beta-debug` channel binding for `pulse-bot`; the proof may use a manual/operator Discord message or a
   token-backed Discord API send, but tokens and 1Password refs must stay redacted.
8. Prove at least one full MCP call through Tool Portal, not only `tools/list`.
   The proof may call a deterministic available provider first; unavailable
   provider calls must return a structured disabled/unavailable error before
   ambiguous upstream behavior.
9. Prove the non-default beta agent Tool VM path when S16 is in scope: the
   request must create a controller-vetted lease over gateway control RPC, write
   a nonce marker file in the Tool VM, read it back, and return the marker.
   The only raw SSH leg is gateway VM to Tool VM.
10. Capture evidence that the message traversed actual Discord, the managed OpenClaw gateway, the plugin/control
   plane, and the controller-owned backend path. Acceptable evidence includes redacted command transcript, controller
   logs, OpenClaw logs, and the visible Discord reply/result.
11. Stop or clean up the beta controller after evidence capture unless another operator is intentionally keeping the
   deployment running.

## Vertical Slice Files

Each executable slice also has a standalone plan file under
`docs/specs/2026-07-02-socketio-control-plane/slices/`. Implementors
should consume the slice file for their assigned work, then return to this root
plan for DAG context and terminal gates.
