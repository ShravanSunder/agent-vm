# Plan Ledger — Socket.IO Control Plane Hard Cutover

Date: 2026-07-02. Parent: plan-creation-swarm.
Source: docs/specs/2026-07-01-socketio-control-protocol-semantics.md (1047 lines) +
docs/specs/2026-06-30-gateway-control-session-hard-cutover.md (2382 lines), both accepted (8 fresh-review blockers closed).
This ledger records the accepted spec, review, and interactive design decisions
for the durable plan packet under `docs/specs/2026-07-02-socketio-control-plane/`.

## Source coverage
Both specs read in full by parent + lanes. Repo re-anchored: controller/gateway/worker code, test layers, package
templates, Gondolin ingress source, OpenClaw v2026.6.8 plugin API. Key re-anchor: existing gateway-websocket-client.ts
is a raw-WS client for OpenClaw's own protocol (NOT the new control plane); Socket.IO net-new.

## Lanes issued (packets) + artifacts
- codebase-boundary (high) → lanes/codebase-boundary.md — write scopes, conflict matrix, package template.
- validation-proof (high) → lanes/validation-proof.md — 45-row proof matrix, 7 new harnesses, OPEN-1..5.
- security-reliability (high) → lanes/security-reliability.md — GATE-0, identityPem custody, recovery amplifier, Q1/Q2.
- scope-and-proof-fit (high) → lanes/scope-and-proof-fit.md — 4 blockers + 9 important + 7 nits, all folded.
vertical-slice-decomposition + execution-order folded into parent synthesis (slices spec-enumerated; batch-1 mapped
scopes/proof/order). Named per skill's "smaller lane set" rule; fit lane was the adversarial check.

## Parent verifications (candidate evidence → accepted)
- POST /lease has no auth guard AND serializeLeaseForResponse returns identityPem (controller-http-route-support.ts:145-159)
  → Q1 real custody hole. ACCEPTED.
- recordGatewayControlLinkObservation fires recovery directly from a gateway observation; recordGatewayServiceProbe is a
  separate trigger, no AND-gate; health-events route unauthenticated (controller-health-event-routes.ts:34-137) → the
  recovery amplifier is real. ACCEPTED (S6b).
- openclaw-mcp-portal-plugin symlinked into managed image (managed-image-dockerfile.ts:354) → S5b multi-file incl. image. ACCEPTED.
- shared version 0.0.102 via find-packages auto-discovery; new packages at 0.0.102, no script edit. ACCEPTED.
- default pnpm test:e2e = 4 lanes (run-e2e-proof-lanes.ts:6); e2e-openclaw/worker env-gated → OPEN-4 real. ACCEPTED.
- protocolVersion z.literal(1) + protocol_version_mismatch close reason → I9 covered; explicit row added. ACCEPTED.
- constants grounded: heartbeatAfterMs=30s/stale 120s (current code), lease-use-start 10s, recovery threshold 3,
  git 120s. ACCEPTED.

## Decision record
- Slice set: S1, S2, S3, S4a/S4b, S5(a/b/c), S6(a/b/c), S7, SW(a/b/c). Splits from fit lane B2/B3/I3/I5/I7 accepted.
- DAG: GATE-0a (STOP gate) → S1 → {S2,S3,S7,SWa} → {S4a,S6a,S6c,SWb,SWc} → {S4b,S6b} → integration gate → S5 → proof gates.
- Hot files (single-owner sequence): controller-request-policy.ts, openclaw-plugin-registration.ts. S3 exposes a
  dispatch extension point (I2) to keep the controller dispatcher off the shared-edit set.
- Constants chosen (grounded; ordering normative, 4 magnitudes PLANNING DEFAULT). Reconnect send buffer DISABLED.
- CONTRACT-PURITY: new eventKind enum stays in gateway-interface (owns reducer; contract pkgs transport-only).
- Rollback = version pin (hard cutover, no dual path).
- VERSION RULE (2026-07-05): OpenClaw v2026.6.8 is the selected accepted runtime for this PR. GATE-0a proves the exact
  delivered artifact supports plugin `handleUpgrade(req, socket, head)` plus pre-101 private auth. Do not downgrade or
  float the runtime without fresh GATE-0a/runtime evidence.

## Contested / open (route before the dependent slice)
- BLOCKING: OPEN-5/GATE-0a (whole cutover STOP), OPEN-4 (proof-gating — USER decision), Q2 (S6b worker corroboration
  probe). Q1 is a user implementation decision with default delete for VM-mutation routes; route to spec only if the
  user wants semantics beyond delete-vs-operator-auth-gate. Q2 routes to spec-creation-swarm; OPEN-4 needs the user's
  proof-gate ruling before any done-claim.
- TUNE-DURING: OPEN-1 magnitudes, OPEN-3 observation-kind.

## Accepted dispositions
- OPEN-2 collector-mode observability disposition: superseded by 2026-07-06 user correction. Managed OpenClaw
  collector-mode raw tcpHosts remain forbidden, but enabled zone observability must be preserved through a
  non-raw replacement: Gondolin HTTP mediation to the loopback OTLP HTTP collector.

## Independent plan review folded (2026-07-02) — plan-review-report.md
User ran a separate 4-lane plan review; parent VERIFIED every accepted finding against code before folding (not
blind acceptance). Verifications:
- B1 version provenance: target OpenClaw is 2026.6.8. CONFIRMED → GATE-0a runs against the exact delivered
  runtime artifact and stops if that runtime cannot provide handleUpgrade-before-101.
- B2 circular proof matrix (plan↔lane point at each other). CONFIRMED → validation-proof.md made canonical, plan
  links one-way.
- B3 runtime-status (controller-http-routes.ts:771) + zone-git/push (controller-zone-operation-routes.ts:388) live,
  undisposed. CONFIRMED → complete S4b route-disposition table (all 4 families + GET /leases).
- B4 gateway union only had lease/use; non-lease ops (health_event/runtime_status/tool_portal_controller_host_action/
  cancel/recovery) unowned. CONFIRMED → S4a owns the FULL union; consumers implement handlers.
- B5 OPEN-4 GIT-1 lacked a command. CONFIRMED → exact commands (test:e2e:openclaw/worker/vm) in the cutover gate.
- Imp2 heartbeatStaleMs = 2*60*1000 = 120_000 (lease-manager.ts:163), NOT the 90_000 I wrote (90s was the 3x-min
  invariant). CONFIRMED → corrected to 120_000. (Parent error caught.)
- Imp3 allowedHosts built at openclaw-lifecycle.ts:1011. CONFIRMED → S5a owns allowedHosts + tcpHosts w/ planted fixture.
- Imp8 e2e-openclaw includes only *.openclaw.e2e.test.ts (vitest.config.ts:230-231). CONFIRMED → INGRESS-1/FLAP-1b
  in NEW *.openclaw.e2e.test.ts, not extending .host.e2e.
- Imp11 manual-templates.ts:188 emits gateway-control-link/controller.vm.host:18800 in a SHIPPABLE generated manual.
  CONFIRMED → residue-audit contract covers generated-manual output + S5a edits it.
- Imp4 env merge (split-resolved-gateway-secrets.ts:108). CONFIRMED → reserve control env names, inject after user env.
All 5 blockers + 11 important folded. Q1 RECLASSIFIED from spec-loop to user implementation decision (spec already
permits delete-or-auth-gate, CUT:468-470); default = delete VM-mutation routes. GIT-1 placed in e2e-vm (host-boundary).
Also folded: Imp5 (worker git payload fields + trusted policy source), Imp6 (nonce state machine), Imp7 (controller-
owned budget key), Imp9 (identityPem custody incl. duplicate/stale delivery), Imp10 (semantic task-HTTP regression),
Imp1 (collector final-ship STOP).

## Architecture re-review pass 2 folded (2026-07-02) — architecture-recheck-report.md §"Pass 2"
Four grounded lanes + parent verification vs spec text, live code, Gondolin checkout. All verified before folding.
- AF-1 (BLOCKER): git host-boundary execPolicy normative (CUT:1844-1858) + GIT-1 proof but UNOWNED; net-new (zero
  repo refs). Gondolin supports it (host/src/qemu/ssh.ts:73). Fix: NEW slice SG / SSH Git
  (`15-sg-ssh-egress-git-policy.md`)
  owns gondolin-adapter egress + 2-lifecycle wiring; GIT-1 re-owned SWc→SG.
- AF-2 (PROTO edit): deliveryPolicy was trusted-sender-set; added receiver-derives-and-fails-closed rule + DP-TRUST row.
- AF-3 (PROTO edit): removed vestigial resync_request/resync_response kinds (hello supersedes); removed dead shared
  `snapshot` kind because snapshots ride as domain `event` messages with latest_wins delivery; pinned heartbeat/
  observation disposition; added KIND-EXACT row.
- PC-1 allowedHosts=audience.ts:29-31 (not openclaw-lifecycle.ts:1011). PC-2 worker request-policy not a barrel +
  orphan cleanup added to SWc/S5a. PC-3 identityPem on 3 lease routes. PC-4 :81-83 fail-closed is target-state.
  PC-5 no send-buffer constructor option (clear sendBuffer on reconnect). PC-6 gateway-zone-orchestrator=src/gateway/.
- D3 (initially folded as "keep openclaw domain" recommendation) — SUPERSEDED by the interactive decision below:
  user chose GENERIC (gateway_control). See "Interactive design decisions".
Matrix now 46 rows (added DP-TRUST, KIND-EXACT, RESILIENT-GRACE, RECREATE-FENCE, CONTROLLER-CEILING, and
RPC-VM-1). New slice
file 15 added; README/DAG/profile updated.

## Interactive design decisions (2026-07-02, with user)
- D3 RESOLVED → GENERIC: domain renamed openclaw_gateway_control → gateway_control across both specs; audience
  z.literal("gateway_control"); OpenClaw detail confined to the plugin; gateway-control-contracts owns the generic
  domain. S2 = OpenClaw placement of the generic service.
- Long-running workers / days-long tasks: worker session is runtime-bound (CUT:1534-1538 "taskId when a task
  exists"), so the design fits. User model: recovery = RECREATE the VM (Gondolin has no RAM migration, only
  disk checkpoints/auto-restart — user DeepWiki cite); state persistence is EXTERNAL (future session DB) + Gondolin
  drives; "no worker without controller" (outage quiesces, not headless). New NON-GOALS: worker/gateway-internal
  durability, headless continuation, durable-session-store seam (user: skip). New constant: control-session-death/
  recovery grace (large × heartbeat, PLANNING DEFAULT) SEPARATE from 120s active-use TTL — resilient, not
  over-sensitive; recovery fires only after grace with no reconnect. New proofs RESILIENT-GRACE + RECREATE-FENCE.
  Liveness constants stay session-scoped (user).
- Controller restart correction (2026-07-04): Event 183 source review plus DeepWiki/local Gondolin 0.12.0 evidence
  found no public TypeScript API to adopt a live VM/session into a full `VM`/managed wrapper with `enableIngress()`
  and lifecycle methods. `connectToSession` is exec/snapshot IPC and lifecycle actions are not supported over attach
  IPC. Therefore RESILIENT-GRACE applies to in-process transport/socket flaps while the controller still owns the
  VM handle; controller process restart/redeploy is a managed-VM recreate boundary for this cutover.
- Controller resource ceiling (user: "absolutely required"): controller is a resilient lightweight control/stream
  BROKER, never a data plane; bounded memory regardless of volume; heavy data never transits heap/control socket
  (forbidden_bulk); data streaming brokered onto separate host-terminated paths, never buffered. New PROTO section
  + CONTROLLER-CEILING proof. Gateway external-event (Discord/queue) durability = gateway-internal, out of scope.

## Interactive correction (2026-07-05) — same-zone multi-agent OpenClaw preserved

The single-agent managed OpenClaw rule introduced by the July 4 cutover/review-fix commits is superseded. It was
not a user requirement. Managed OpenClaw must remain properly same-zone multi-agent under the Socket.IO control
plane. The valid boundary is declared-agent parity plus controller-vetted caller context, not exactly one declared
agent per zone.

Plan consequences:
- Added slice `slices/00b-sma-openclaw-same-zone-multi-agent.md`.
- Slice file count is now 19 including `slices/README.md`.
- Added proof rows SMA-1..SMA-7 to the canonical matrix.
- Implementation must remove the single-agent config/runtime/scaffold/docs restrictions while preserving:
  declared-agent allowlists, duplicate/unknown-agent rejection, per-agent `agentToolVmProfiles`, per-agent sandbox
  seeds, MCP Portal agent parity, Tool Portal host-action zone config checks, and stable-provenance lease ownership.
- Review follow-up folded: `sessionKeyDigest` is not a per-agent proof because it can be derived from gateway-supplied
  evidence. Caller-context registration now requires plugin-signed HMAC-SHA256 proof over `agentId`,
  `agentWorkspaceDir`, `workMountDir`, `sessionKey`, `purpose`, and `zoneId` using the controller-generated
  control-session `callerContextProofKey`.
- `../shravan-claw` is not part of this repair unless explicitly authorized. Beta proof uses `../shravan-claw-beta`
  only and must be genuinely multi-agent; a single-agent beta validation run is non-evidence for this correction.
- Full-system proof target: `../shravan-claw-beta` with actual Discord and actual OpenClaw. This live proof validates
  managed wiring and runtime behavior; it does not change the non-goal that gateway-internal Discord/queue durability
  is out of scope for the control-session cutover.

## Interactive correction (2026-07-06) — full MCP and Tool VM path proof

The proof contract now requires a complete Tool VM and MCP path, not only
connected-session or discovery evidence.

Plan consequences:
- Added slice `slices/16-tool-vm-and-mcp-full-path-proof.md`.
- Slice file count is now 20 including `slices/README.md`.
- Added proof rows MCP-DISCOVERY-1, MCP-DISCOVERY-2, MCP-CALL-1, TOOLVM-BETA-1,
  and TOOLVM-BETA-2 to the canonical matrix.
- MCP Portal live discovery must attempt all referenced namespaces concurrently,
  enforce a configurable per-namespace timeout defaulting to 12 seconds, settle
  all namespace results, use discovered tools from successful namespaces, and
  expose failed or timed-out namespaces as disabled/unavailable with safe
  diagnostics. Referenced unavailable namespaces are operator-visible but fail
  validation proof; discovered tool input schemas must build validators during
  live validation.
- Full MCP proof must include at least one real `tool_portal_call`, not only
  `tools/list`.
- Full Tool VM proof must include a non-default `beta` agent path that creates a
  controller-vetted lease over gateway control RPC, writes a nonce marker file in
  the Tool VM, reads it back, and returns the marker. Only gateway VM to Tool VM
  uses raw SSH.

## Implementation review correction (2026-07-06) — worker push policy trust source

The first F4 repair incorrectly treated worker task request repo metadata as a
trusted protected-branch policy source. That is rejected. Worker task requests
only declare repo intent and base branch for preparation. Controller-owned worker
push safety is configured on the trusted worker gateway `repoPushPolicies`
source; prepared active task state stores a typed `trusted_config` policy or a
typed `missing` policy. Controller push fails closed before Git I/O when a task
repo lacks matching trusted policy. This preserves the host-token confused-deputy
boundary for worker `git_push`.

## Implementation review correction (2026-07-07) — stability and traceability scope

Source revalidation found the old F1 wording too coarse. The remaining defect
was not only physical socket eviction; a `resync_required` challenger could
temporarily mask incumbent accepted-session availability. The accepted control
contract is now: pending full-resync challengers do not disconnect, mask, or
suppress controller-originated traffic on the incumbent. The incumbent becomes
stale only after the replacement fresh hello is accepted.

Stability follow-ups are explicitly out of silent-done scope unless the plan is
extended with new slices:
- real gateway/worker `operation_cancel` needs active-operation identity,
  idempotent terminal races, and an actual abort path;
- worker liveness/progress needs a periodic worker-owned progress signal if the
  controller must distinguish quiet work from wedged work;
- worker observation correlation needs a real worker-owned correlation source
  before it becomes operator-visible beyond task event evidence;
- true W3C `traceparent` propagation and OTel span joining are separate from
  current allowlisted `traceId` attributes.

Follow-on stability tightening (2026-07-07): the control runtime now treats
connect/hello timeout and command-ack timeout as separate contracts, resets the
priority failure budget on fresh accepted hello, keeps semantic command-result
timeouts out of the transport-ack failure budget, and releases an unreceipted
priority sequence reservation only while no later hard sequence has moved. This
preserves retryability for heartbeat and reserved `operation_cancel` priority
frames without weakening strict receiver sequence-gap detection.

## Route
Independent plan review DONE and folded. Architecture re-review pass 2 DONE and folded. Focused SMA plan review DONE
and folded. Implementation-execute-plan may start with SMA. Remaining before the broader control-plane cutover can
ship: GATE-0a (exact delivered runtime proof + real-runtime handleUpgrade proof), user decisions (OPEN-4 proof-gating,
Q1 route defaults), and spec confirmation for Q2 worker probe. Use the slice plan files under `slices/` for execution.

## Completion receipt
Artifacts: implementation-plan.md, plan-ledger.md, lanes/{codebase-boundary,validation-proof,security-reliability,
scope-and-proof-fit}.md, lane-packet-shared.md. No product code/tests/configs/non-plan docs edited. All lane outputs
parent-verified against spec text + live code before acceptance. No secrets/op:// refs/account metadata in artifacts.
