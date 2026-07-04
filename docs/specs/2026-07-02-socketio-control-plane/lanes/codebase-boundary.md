# Lane: codebase-boundary (parent-verified)

Status: answered. Confidence: high on write surfaces + conflict topology. Parent verified: mcp-portal baked into
managed-image-dockerfile.ts:354 (S5 removal spans image build); shared version 0.0.102 via find-packages
auto-discovery (new packages created at 0.0.102, NO version-sync script edit); controller-request-policy copies are
re-export barrels.

## Package-creation checklist (template = packages/controller-execution-contracts/)
Per new package mirror that file set: package.json (name @agent-vm/<pkg>, version 0.0.102, type:module, exports map,
deps zod ^4.4.3 + @agent-vm/control-protocol-contracts workspace:* for domain pkgs, devDep vitest), tsconfig.json
(extends ../../tsconfig.base.json), tsconfig.build.json, tsdown.config.ts, src/index.ts + sub-barrels + models/*-schema.ts.
Shared one-time wiring (conflict points): tsconfig.base.json paths (:63-140, established registration mechanism, NOT
the boundary-rule tsconfig); scripts/verify-portal-package-exports.ts (:1-18); scripts/audit-portal-architecture.ts
(:14-19 portalPackageNames + :23-34 runtimePortalImportPrefixes — leaf contract joins forbidden-runtime-import gate).
pnpm-workspace.yaml NO edit (glob). Socket.IO net-new.

## Per-slice write scope (summary; full detail accepted into plan)
S1 control-protocol-contract  CREATE packages/control-protocol-contracts/** (leaf zod-only) + shared wiring edits.
S2 gateway-control-service-placement  EDIT openclaw-sandbox-sdk-contract.ts assertSdkShape:87-118 (add handleUpgrade),
   sdk-compat.unit.test.ts, openclaw-plugin-registration.ts (Socket.IO server + upgrade hook + /__agent-vm/ready);
   CREATE openclaw-agent-vm-plugin/src/gateway-control-service/**; EDIT openclaw-lifecycle.ts (expose paths on existing
   guest port, no 2nd port); dep += socket.io, control-protocol-contracts, gateway-control-contracts.
S3 controller-session-runtime  CREATE packages/agent-vm/src/controller/control-session/** (Socket.IO CLIENT mgr);
   EDIT controller-runtime.ts:369 (compose), gateway-zone-orchestrator.ts:888-925 (dial after enableIngress);
   dep += socket.io-client, control-protocol-contracts, gateway-control-contracts.
S4 lease-control-rpc-parity  POPULATE gateway-control-contracts/**; CREATE controller gateway-RPC handlers (invoke
   lease-manager.ts); EDIT controller-request-policy.ts (remove lease-* ops); REMOVE controller-lease-client.ts + test,
   update sandbox-backend-handle-factory.ts; EDIT controller-http-routes.ts (delete/auth-gate POST /lease:386 +
   /lease/:id/* :528,536,548,625,643,684,740; GET /leases:612 stays).
S5 managed-openclaw-hard-cutover (REMOVAL, run LAST)  EDIT openclaw-lifecycle.ts buildGatewayTcpHosts (:75 remove
   controller.vm.host, :81-83 websocketBypass fail-closed, :85-97 collector fail-closed [OPEN ruling]); REMOVE
   gateway-control-link-monitor.ts (S6 overlap), zone-git-tool.ts (S7 overlap), plugin-registration edits; remove old
   MCP Portal identity — NOT self-contained: agent-vm/package.json:48, tsconfig.build.json, managed-image-dockerfile.ts:13,354
   (BAKED INTO IMAGE — verified), openclaw-deployment-doctor.ts, manual-templates.ts, e2e-harness.ts, tsconfig.base.json.
S6 operator-health-observability  EDIT gateway-interface/src/health/agent-vm-health.ts (control-link→control-session:
   :7-18 enum, :59-63 reasons, :73-94 pins/variant); blast radius 8+ files (health-event-telemetry.ts:94,
   controller-telemetry.ts:218, gateway-vm-recovery-policy.ts:330, controller-runtime.ts:323,729,
   gateway-service-health-monitor.ts:196-197,594, durable-health-event-log.ts:113, gateway-zone-state-machine.ts:17,
   controller-health-event-routes.ts:12,41); EDIT controller-request-policy.ts (remove controller-health,
   health-event-publish, openclaw-runtime-status); EDIT controller-health-event-routes.ts:88 (delete/auth-gate).
S7 tool-portal-backend-taxonomy  EDIT config-contracts/src/tool-portal-config.ts:31,33,137 (mcp→mcp_provider,
   credentialed_runner→tool_vm_runner/controller_host_action) + tool-portal consumers + testing/index.ts; EDIT
   audit-portal-architecture.ts (S1 overlap); zone_git_push→controller_host_action (S5 overlap;
   controller-execution-contracts has controller-host-action-boundary/).
Worker git-tools  CREATE packages/worker-control-contracts/** + packages/agent-vm-worker/src/control-session/**
   (Socket.IO server + dispatcher + /__agent-vm/worker-ready alongside server.ts; Hono /health,/tasks STAY); REWIRE
   git-push-tool.ts + git-pull-default-tool.ts off controllerBaseUrl, controller-tool-support.ts:132, task-runner.ts:172;
   EDIT worker-lifecycle.ts:34 (rm CONTROLLER_BASE_URL), :61-63 (rm tcpHost), worker-lifecycle.unit.test.ts:56; EDIT
   controller-request-policy.ts (remove worker-push-branches, worker-pull-default); CREATE controller worker-RPC handlers
   (invoke git-push-operations.ts / git-pull-default-operations.ts, S3 overlap).

## Conflict-risk matrix (shared file → contending slices)
- controller-request-policy.ts → S4,S5,S6,worker — HIGHEST (all remove different op-groups; endgame near-total removal;
  plugin + worker copies are re-export barrels of this single source).
- openclaw-plugin-registration.ts → S2,S4,S5,S7 — HIGHEST (4 slices mutate one register()).
- controller-runtime.ts → S3,S4,S6(:323,729) — HIGH.
- openclaw-lifecycle.ts → S2,S5 — MED (different functions).
- tsconfig.base.json paths → S1,worker,S5 — MED mechanical. audit-portal-architecture.ts → S1,S7 — MED.
  verify-portal-package-exports.ts → S1,worker — LOW. manual-templates.ts → S5,S6 — LOW.

## Disjointness / serialization
S1 FIRST (foundation; owns one-time shared wiring). After S1, parallel on mostly-disjoint dirs: S2, S3, worker.
Serialize the two hot files (controller-request-policy.ts, openclaw-plugin-registration.ts) under a single owner or
strict sequence. S5 runs LAST (removal safe only after 2/4/6/7/worker move live callers). Contract-purity trap: new
control-session eventKind belongs in pure control-protocol-contracts but agent-vm-health.ts lives in gateway-interface
which depends on gondolin-adapter — S6 either edits in place (stays non-pure) or the enum moves (affects S1+S6).

## Open questions (parent resolutions noted)
Q1 S1 scaffolds all 3 package shells (recommended) → ACCEPT: S1 creates all 3 shells + shared wiring once; S4 and
   worker only populate op schemas.
Q2 audit-portal-architecture.ts new-package registration → ACCEPT: S1 owns it (foundation).
Q3 openclaw-mcp-portal-plugin removal is multi-file incl. image dockerfile → scope explicitly in S5 (verified baked).
Q4 collector-mode observability gates S5 tcpHosts fail-closed edit → isolate behind the open product ruling.
