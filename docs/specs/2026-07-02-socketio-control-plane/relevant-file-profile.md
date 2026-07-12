# Relevant File Profile - Socket.IO Control Plane Hard Cutover

Purpose:
- Give the implementor agent a file-by-file map before code execution.
- Identify current role, cutover hazard, owning slice, and proof rows.

Rule:
- Slice files under `slices/` are the execution entrypoint.
- This profile is navigation help, not a substitute for the root plan or proof
  matrix.

## Source And Plan Artifacts

| file | role | implementation relevance |
| --- | --- | --- |
| `docs/specs/2026-07-01-socketio-control-protocol-semantics.md` | Shared protocol contract | Source of truth for Socket.IO transport, Zod/JSON Schema envelope, delivery, reconnect, backpressure, and proof expectations. |
| `docs/specs/2026-06-30-gateway-control-session-hard-cutover.md` | Domain and cutover contract | Source of truth for gateway/worker domains, Tool Portal taxonomy, route disposition, hard removal, and Git policy. |
| `docs/specs/2026-07-02-socketio-control-plane/implementation-plan.md` | Root execution DAG | Use for global order, dependencies, gates, open decisions, and terminal proof. |
| `docs/specs/2026-07-02-socketio-control-plane/lanes/validation-proof.md` | Canonical proof matrix | 46 row-level proof obligations (incl. DP-TRUST, KIND-EXACT, RESILIENT-GRACE, RECREATE-FENCE, CONTROLLER-CEILING, RPC-VM-1). Every slice must map to rows here. |
| `docs/specs/2026-07-02-socketio-control-plane/slices/*.md` | Per-slice execution plans | One file per executable gate/slice. Implementors should work from these. |

## New Contract Packages

| file/package | current role | owner slice | proof |
| --- | --- | --- | --- |
| `packages/control-protocol-contracts/**` | New package, absent today | S1 | SCHEMA-1..6, DELIVERY-1/2, BP-4/5, HANDSHAKE-1 |
| `packages/gateway-control-contracts/**` | New package, absent today | S1 shell, S4a population | DOMAIN-SEP-1, SURFACE-1, gateway schema rows |
| `packages/worker-control-contracts/**` | New package, absent today | S1 shell, SWa population | DOMAIN-SEP-1, Worker schema rows, GIT-2 schema portion |

## OpenClaw Gateway Placement

| file | current role / hazard | owner slice | proof |
| --- | --- | --- | --- |
| `packages/openclaw-agent-vm-plugin/src/openclaw-sandbox-sdk-contract.ts` | Current SDK shim has no production `handleUpgrade` route shape. | S2 | HANDSHAKE-2..5, INGRESS-1 |
| `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts` | Hot file: existing plugin registration and future private route/tool registration. | S2 owns structure; S4a/S7 additive; S5a final removal | INGRESS-1, RESIDUE-4/5 |
| `packages/openclaw-agent-vm-plugin/src/gateway-control-service/**` | New private Socket.IO control service. | S2 | HANDSHAKE-2..5 |
| `packages/openclaw-gateway/src/openclaw-lifecycle.ts` | Builds `controller.vm.host:18800` tcpHost (`:75`) and websocket-bypass tcpHosts (`:81-83`, a plain mapping loop — no fail-closed check yet). `allowedHosts` at `:1011` only CALLS `gatewayVmAllowedHosts`; it is NOT the injection site. Also the gateway VM-spec home for SG (SSH Git) egress execPolicy. | S2 path exposure; S5a raw-TCP removal; SG egress execPolicy | RESIDUE-1/2, INGRESS-1, GIT-1 |
| `packages/gateway-interface/src/audience.ts` | REAL `controller.vm.host` source: literal at `:11`; unconditional `allowedHosts` injection `gatewayVmAllowedHosts` at `:29-31`. Removing controller.vm.host from allowedHosts edits HERE. | S5a | RESIDUE-2 |
| `packages/gondolin-adapter/src/vm-adapter.ts` | Exposes inbound `SshAccess` (`:59`) only; has NO ssh-EGRESS/execPolicy surface today. SG (SSH Git) adds the egress+execPolicy passthrough to Gondolin's `SshExecPolicy`. | SG | GIT-1 |
| `packages/agent-vm/managed-images.json` | Delivered managed OpenClaw image metadata and runtime version input. This PR targets OpenClaw v2026.6.8 and requires fresh GATE-0a evidence before any runtime change. | GATE-0 | GATE-0 runtime provenance |
| `pnpm-lock.yaml` | Current lock evidence includes OpenClaw package provenance. | GATE-0 | GATE-0 runtime provenance |

## Controller Session And Lease RPC

| file | current role / hazard | owner slice | proof |
| --- | --- | --- | --- |
| `packages/agent-vm/src/controller/control-session/**` | New controller Socket.IO client/session runtime. | S3 | DELIVERY-3/4/5, FENCE-1, BP-1/2/3, FLAP-1A |
| `packages/agent-vm/src/controller/controller-runtime.ts` | Composes controller runtime and recovery/status flows. | S3 plus S6a coordination | FENCE-1, RECOVERY-1 |
| `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts` | Dials/observes gateway after ingress readiness (`enableIngress()` at `:895`, dial point `:888-925`). Path is `src/gateway/`, not `src/controller/`. | S3 | INGRESS-1, FLAP-1 |
| `packages/agent-vm/src/controller/http/controller-http-routes.ts` | Owns old `/lease*`, `GET /leases`, and runtime-status route. `/lease` returns `identityPem` today. | S4b route disposition; S4a parity dependencies | RESIDUE-6, SURFACE-1 |
| `packages/agent-vm/src/controller/http/controller-http-route-support.ts` | Serializes lease response and reads `identityPem`. | S4a/S4b custody proof | SURFACE-1, identityPem custody |
| `packages/agent-vm/src/controller/leases/lease-manager.ts` | Source for heartbeatAfterMs=30s and heartbeatStaleMs=120s. | S1 constants reference; S4a parity | BP-4, SURFACE-1 |
| `packages/gateway-interface/src/health/controller-request-policy.ts` | Hot file for old request-policy op groups and timeouts. | Single-owner hot-file sequence fed by S4a/S6a/SWc | BP-4, RESIDUE rows |

## Health, Recovery, And Observability

| file | current role / hazard | owner slice | proof |
| --- | --- | --- | --- |
| `packages/agent-vm/src/controller/http/controller-health-event-routes.ts` | Old unauthenticated health-events route and gateway-control-link observation path. | S4b/S6b | RESIDUE-6, RECOVERY-2 |
| `packages/agent-vm/src/controller/health/gateway-vm-recovery-policy.ts` | Current recovery reasons include gateway-control-link semantics. | S6b | RECOVERY-1/2 |
| `packages/gateway-interface/src/health/agent-vm-health.ts` | Health event vocabulary owner. | S6a | RESIDUE-5 |
| `packages/agent-vm/src/observability/health-event-telemetry.ts` | Emits health telemetry labels including legacy vocabulary. | S6a/S6c | CORR-1, RESIDUE-5 |
| `packages/agent-vm/src/observability/controller-telemetry.ts` | Controller telemetry for health/recovery evidence. | S6a/S6c | CORR-1 |

## Worker Control

| file | current role / hazard | owner slice | proof |
| --- | --- | --- | --- |
| `packages/agent-vm-worker/src/control-session/**` | New Worker private Socket.IO server. | SWb | Worker handshake/e2e-worker |
| `packages/agent-vm-worker/src/server.ts` | Existing Worker HTTP server for `/health` and `/tasks`; must remain. | SWb | worker task HTTP regression |
| `packages/worker-gateway/src/worker-lifecycle.ts` | Injects `CONTROLLER_BASE_URL` (`:34`) and controller tcpHost (`:61-63`) today; also the worker VM-spec home for SG (SSH Git) egress execPolicy. | SWc/S5a raw-TCP; SG egress execPolicy | RESIDUE-3, RESIDUE-2, GIT-1 |
| `packages/agent-vm-worker/src/work-phase/controller-tools/git-push-tool.ts` | Current Worker-to-controller HTTP push callback. | SWc | GIT-2/3, RESIDUE-3 |
| `packages/agent-vm-worker/src/work-phase/controller-tools/git-pull-default-tool.ts` | Current Worker-to-controller HTTP pull-default callback. | SWc | GIT-2/3, RESIDUE-3 |
| `packages/agent-vm-worker/src/work-phase/controller-tools/controller-tool-support.ts` | Current controller HTTP support for Worker tools. | SWc | RESIDUE-3 |
| `packages/agent-vm-worker/src/coordinator/task-runner.ts` | Threads controller tool configuration into Worker task execution. | SWc | worker task HTTP regression |
| `packages/agent-vm/src/controller/worker-task-runner.ts` | Controller-to-worker `/tasks` ingress path; must remain functional. | SWc proof only | Worker semantic task HTTP regression |

## Tool Portal And Managed OpenClaw Surface

| file | current role / hazard | owner slice | proof |
| --- | --- | --- | --- |
| `packages/config-contracts/src/tool-portal-config.ts` | Backend taxonomy currently needs rename alignment. | S7 | RESIDUE-4 |
| `packages/tool-portal/**` | Tool Portal core/consumers; must not import controller/Gondolin/OpenClaw runtime. | S7 | RESIDUE-4, architecture gate |
| `packages/agent-vm/src/controller/http/controller-zone-operation-routes.ts` | Current zone-git push route. | S4b/S7 | RESIDUE-6, GIT-2 |
| `packages/agent-vm/src/controller/git-push-operations.ts` | Controller-owned push implementation and policy home. | S7/SWc | GIT-2 |
| `packages/agent-vm/src/controller/git-pull-default-operations.ts` | Controller-owned pull-default implementation. | SWc | GIT-2 |

## Residue, Manuals, Images, And Audits

| file | current role / hazard | owner slice | proof |
| --- | --- | --- | --- |
| `packages/agent-vm/src/cli/manual-templates.ts` | Generated manuals currently mention old control-link/controller host and MCP Portal plugin identity. | S5a/S5b | RESIDUE-1/4/5 |
| `packages/agent-vm/src/cli/manual-templates.unit.test.ts` | Manual output proof. | S5a/S5b | RESIDUE audit |
| `packages/agent-vm/src/image/managed-image-dockerfile.ts` | Managed image package/install identity. | S5b | RESIDUE-4, image smoke |
| `packages/agent-vm/src/operations/openclaw-deployment-doctor.ts` | Deployment doctor may name MCP Portal/plugin checks. | S5b | RESIDUE-4 |
| `packages/agent-vm/src/e2e-harness.ts` | Managed image/test overlay package identity. | S5b | RESIDUE-4 |
| `scripts/audit-portal-architecture.ts` | Existing architecture gate; must learn new packages and forbidden edges. | S1/S7/S5 | RESIDUE-4, control residue audit |
| `scripts/verify-portal-package-exports.ts` | Package export gate; must include new contract packages. | S1 | package export proof |
| `scripts/audit-test-taxonomy.ts` | Test suffix/project guard. | Proof infra only | prevents wrong e2e suffix |
| `scripts/run-e2e-proof-lanes.ts` | Default e2e lane runner excludes OpenClaw/Worker. | OPEN-4 decision only | terminal proof gate |
| `scripts/run-vitest-evidence-project.ts` | Evidence wrapper; fails on skipped/todo/zero tests. | proof infra | terminal proof gate |
| `package.json` | Script source for `test:e2e:*`, `pnpm check`. | proof infra | terminal proof gate |
| `vitest.config.ts` | Project/file suffix source for e2e-openclaw, e2e-worker, e2e-vm. | proof infra | INGRESS/WORKER/GIT e2e |

## Current Hot Files

| hot file | rule |
| --- | --- |
| `packages/gateway-interface/src/health/controller-request-policy.ts` | One sequenced owner lands all op-group removals for lease, worker, health/runtime. Do not let S4a/S6a/SWc make conflicting independent edits. |
| `packages/openclaw-agent-vm-plugin/src/openclaw-plugin-registration.ts` | S2 owns register structure; S4a and S7 add on top; S5a removes old registrations last. |
| `packages/openclaw-gateway/src/openclaw-lifecycle.ts` | S2 may expose private paths; S5a performs raw tcpHosts/allowedHosts removal after callers move. |
| `packages/agent-vm/src/cli/manual-templates.ts` | S5a and S5b both touch generated manual truth. Coordinate residue wording and unit tests. |

## Files That Should Not Own Control Contracts

| file/package | reason |
| --- | --- |
| `packages/gateway-interface/src/index.ts` | Existing lifecycle/health/VM-spec package. New pure control envelopes/domain operation unions must live in the three dedicated control contract packages. |
| `packages/tool-portal/**` | Portable Tool Portal core must not import Socket.IO, Gondolin, OpenClaw, SSH, or controller runtime. |
| `packages/openclaw-agent-vm-plugin/**` | Runtime placement and adapter only; not the shared cross-domain protocol source of truth. |

## Implementation Profile Summary

Critical path:
1. GATE-0 runtime provenance.
2. S1 contracts and package wiring.
3. S2/S3 live session skeleton.
4. S4a lease RPC plus SW worker contracts/worker service.
5. S4b/S6/S7/SW route, health, git, and taxonomy migration.
6. S5 hard removal.
7. Terminal e2e and full gate.

Parallel, control-plane-independent:
- SG (SSH Git) egress read policy (gondolin-adapter egress + two lifecycle VM
  specs). Owns GIT-1. May start with/before S1; sequence lifecycle edits with
  S5a.

Do not ship:
- old raw `controller.vm.host:18800` control callbacks,
- old Worker `CONTROLLER_BASE_URL` controller tools,
- managed OpenClaw MCP Portal plugin identity,
- generated manuals teaching `gateway-control-link` as current behavior,
- collector-mode raw tcpHosts without accepted exception,
- Socket.IO polling fallback,
- event-only Worker operations as command results.
