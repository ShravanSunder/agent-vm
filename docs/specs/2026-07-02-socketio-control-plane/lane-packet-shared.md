# Shared Lane Packet — Socket.IO Control Plane Implementation Plan

Repo: /Users/shravansunder/Documents/dev/project-dev/agent-vm.mcp-portal-better-interface
Branch: mcp-portal-better-interface (behind master; PR #162 websocketUpgrades NOT in branch)
Mode: plan-creation, READ-ONLY. Do not edit product code, tests, configs, or plan files.

## Source artifacts (read the sections your lane needs; both are accepted)

- docs/specs/2026-07-01-socketio-control-protocol-semantics.md (958 lines) — PROTO.
  Shared Socket.IO-over-WebSocket transport, ControlEnvelopeSchema (one identity layer),
  shared schemas in @agent-vm/control-protocol-contracts (ControlSessionStateSchema,
  ControlRpcResultBaseSchema, ControlRpcErrorSchema, ControlCorrelationSchema w/ traceId,
  ControlHelloSchema/ControlHelloResponseSchema/ControlCloseSchema),
  delivery policy enum (incl. append_only_observation), correlation/trace propagation section,
  reconnect/resync, backpressure + timing-order invariants, close reasons, handshake trust root,
  proof expectations.
- docs/specs/2026-06-30-gateway-control-session-hard-cutover.md (2382 lines) — CUT.
  Hard cutover from gateway/worker raw controller.vm.host:18800 TCP to controller-initiated
  Socket.IO sessions over Gondolin ingress. Owns gateway_control_rpc + worker_control_rpc domains,
  backend taxonomy, handshake schemas (VM nonce + controller signature), health model +
  recovery-trigger mapping, Git Access And Push Policy, Slice Routes For Planning (§ near line 2325),
  Proof Expectations (§ near line 2210), Stop Conditions.
- docs/specs/2026-07-02-socketio-control-plane/plan-ledger.md — accepted decisions +
  open planning inputs (deferred constants, collector ruling, unused "observation" kind, 2319-line cap).

## Accepted normative decisions (do not relitigate)

- Controller is the Socket.IO CLIENT; each managed VM hosts the Socket.IO SERVER on a private
  transport-neutral path; controller dials in over Gondolin ingress after a readiness probe.
- Socket.IO-over-WebSocket-only (transports:["websocket"], no polling). Socket.IO is net-new (not a
  dependency yet anywhere — verified). JSON Schema is the normative cross-language wire contract.
- Managed OpenClaw placement is FIXED: in-process plugin-hosted private route via OpenClaw v2026.6.5 minimum
  handleUpgrade(req, socket, head); NO sidecar, no second guest port. Proving handleUpgrade-before-101
  private auth is a cutover PREREQUISITE (CUT ~line 748-776). If the pinned plugin API can't provide it,
  the cutover STOPS — no fallback.
- Handshake: VM holds controller public key at boot + issues a per-session connect nonce from the
  readiness endpoint; controller signs identity fields + nonce; presented as x-agent-vm-control-* upgrade
  headers; VM validates + atomically consumes the nonce before 101; duplicate presentation rejected
  (incumbent not evicted).
- Worker scope NARROWED: git_push/git_pull_default + runtime observations/cancel/recovery move to
  worker_control_rpc; task submit/state/close STAY on controller→worker ingress HTTP (POST /tasks,
  GET /tasks/:id, POST /tasks/:id/close) — the healthy host→guest direction.
- One kind vocabulary at both layers (command/command_result/event); strict envelope↔domain
  kind+operation equality. zone_git_push is NOT a model tool; it is tool_portal_controller_host_action.
- Package split: @agent-vm/control-protocol-contracts (leaf, zod-only) ← @agent-vm/gateway-control-contracts
  and @agent-vm/worker-control-contracts. gateway-interface is NOT a control-contract owner.

## Current-state code anchors (parent-verified)

- packages/openclaw-gateway/src/openclaw-lifecycle.ts:69-100 buildGatewayTcpHosts (controller.vm.host:18800,
  tool-<slot>:22, websocketBypass, collector); :883 plugin controllerUrl; :1083-1090 /readyz+/health probes.
- packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts — HTTP lease client (create/renew/
  uses/heartbeat/end/peek/release + openclaw-runtime-status).
- packages/openclaw-agent-vm-plugin/src/gateway-control-link-monitor.ts — periodic controller-health GET +
  /zones/:zoneId/health-events publish loop (the gateway-control-link vocabulary).
- packages/openclaw-agent-vm-plugin/src/zone-git-tool.ts:30,78 — zone-git-push over controller.vm.host.
- packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts:34-45,118-128 — plugin registration;
  openclaw-sandbox-sdk-contract.ts:87-118 — SDK shape (registerTool + registerSandboxBackend); the plugin
  HTTP/upgrade route hook is NOT in this repo's SDK shim yet (must be proven against the exact delivered OpenClaw
  runtime shape).
- packages/worker-gateway/src/worker-lifecycle.ts:34,61-63 — CONTROLLER_BASE_URL env + controller.vm.host:18800 tcpHost.
- packages/agent-vm-worker/src/server.ts — Hono /health + /tasks routes (STAY).
- packages/agent-vm-worker/src/work-phase/controller-tools/{git-push-tool.ts:54-60,git-pull-default-tool.ts}
  — worker→controller push/pull over CONTROLLER_BASE_URL (MOVE to worker_control_rpc).
- packages/agent-vm/src/controller/worker-task-runner.ts:851-885 — controller→worker task submit + state
  poll over ingress HTTP (host→guest, STAY).
- packages/agent-vm/src/controller/http/controller-http-routes.ts:386+ POST /lease (NO auth guard),
  lease routes; controller-health-event-routes.ts:88 health-events; controller-zone-operation-routes.ts:388 zone-git/push.
- packages/agent-vm/src/controller/leases/lease-manager.ts:162 heartbeatAfterMs=30s, :179-180 heartbeatStaleMs>=3x.
- packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts:330 'gateway-control-link-unhealthy'
  recovery reason (MUST remap to control-session-unhealthy).
- packages/gateway-interface/src/health/agent-vm-health.ts — canonical health event model + reducer
  (depends on gondolin-adapter runtime → contract-purity trap for the new eventKind enum).
- packages/gateway-interface/src/health/controller-request-policy.ts:1-30 — all gateway/worker controller ops
  (lease-*, zone-git-push, health-event-publish, openclaw-runtime-status, worker-push-branches, worker-pull-default);
  plugin + worker copies are RE-EXPORT BARRELS of this (single source of truth).
- packages/agent-vm/src/gateway-api-client/gateway-websocket-client.ts — EXISTING RAW WS client for OpenClaw's
  own gateway protocol; NOT the new control plane; do not confuse or reuse.
- gondolin host/src/ingress.ts:940,1539-1714 (sibling checkout /Users/shravansunder/Documents/dev/open-source/vm/gondolin)
  — enableIngress upgrade, path-prefix routes, header passthrough, raw duplex after 101, no idle timeout.
  @earendil-works/gondolin 0.12.0 pinned in packages/gondolin-adapter/package.json.

## Test layers (map proof here)

- Unit: `pnpm test:unit` (vitest --project unit + test:taxonomy audit). *.unit.test.ts colocated.
- Integration: `pnpm test:integration` (*.integration.test.ts).
- E2E: `mise exec -- pnpm test:e2e` (run-e2e-proof-lanes.ts); project variants: e2e-host, e2e-vm
  (AGENT_VM_GONDOLIN_E2E=1, *.vm.e2e.test.ts), e2e-openclaw (AGENT_VM_OPENCLAW_E2E=1), e2e-worker
  (AGENT_VM_WORKER_E2E=1). Existing rigs to extend, not reinvent: gateway-zone-orchestrator.integration.test.ts,
  gateway-websocket-client.integration.test.ts, openclaw-lifecycle.host.e2e.test.ts,
  worker-runtime.worker.e2e.test.ts, controller-integration.integration.test.ts.
- Architecture gates: `pnpm test:portal-architecture`, `test:portal-exports`, `test:taxonomy` (forbidden edges,
  package exports). Typecheck: `pnpm typecheck`. Lint: `pnpm lint` / `lint:types`.

## Open planning inputs your lane may need to resolve

- Concrete deferred constants: queue message/byte caps, maxHttpBufferSize floor (must exceed lease snapshot w/
  identityPem — multi-KB PEM), control-session-connect/ack/exec/resync timeouts, heartbeat cadence, replay
  window, Engine.IO pingInterval/pingTimeout. Ordering invariants are NORMATIVE (PROTO backpressure §):
  heartbeat cadence < active-use TTL (current heartbeatAfterMs=30s, stale>=3x=90s); connect+ack < the current
  10s active-use-start policy budget; app timeouts ordered vs Engine.IO ping.
- Collector-mode observability disposition (only zone observability mode; fail-closed strands zones) — product
  ruling still open; plan should isolate it so it doesn't block the control-plane slices.

## Output contract (all lanes)

Return the plan-creation packet output schema: lane name; status answered|blocked; evidence inspected with
path:line; candidate slice cards where relevant (source anchor → behavior → touched files → checkpoint →
proof layer+evidence); requirement/proof implications; conflicts; open questions; completion receipt;
confidence. Candidate evidence only — parent verifies and owns the final plan.
