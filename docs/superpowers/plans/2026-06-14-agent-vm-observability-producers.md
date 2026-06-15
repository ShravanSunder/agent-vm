# Agent VM Observability Producers Implementation Plan

Date: 2026-06-14
Status: draft plan; not reviewed; not executed
Skill: `shravan-dev-workflow:plan-create`

## Problem

Managed host observability exists and Victoria is healthy, but the current
runtime does not export `agent-vm` controller or gateway health events into
OpenTelemetry. OpenClaw diagnostics is configured as a producer, but the live
runtime reports `diagnostics-otel: internal diagnostics capability unavailable`,
which means that producer exits before subscribing to internal diagnostics.

This plan makes the producer boundary explicit:

```text
agent-vm host observability stack
  -> already owns collector + Victoria readiness and storage

agent-vm controller/gateway health
  -> missing host-side OTLP producer

OpenClaw diagnostics
  -> configured as producer
  -> blocked unless diagnostics-otel is bundled or trusted official
```

## Goal

When host observability is enabled, `agent-vm` must export safe controller and
gateway operational telemetry to the configured OpenTelemetry collector, and the
managed OpenClaw gateway image must either produce OpenClaw diagnostics telemetry
or fail a preflight/proof gate with a clear trust-classification reason.

The final proof must show Victoria data for:

- `service.name=agent-vm-controller`
- the configured OpenClaw service name, such as
  `shravan-claw-sunfam-openclaw-gateway`
- the beta controller path in
  `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta`, using
  fresh Victoria rows from the beta runtime and preserving a small,
  inspectable beta deployment diff.

## Non-goals

- Do not add Grafana, dashboards, alerting, cloud Victoria, or new query UIs.
- Do not start Docker or Docker Compose from controller startup.
- Do not enable prompt, response, transcript, command, request body, header,
  cookie, token, or tool payload capture.
- Do not add broad OpenTelemetry auto-instrumentation.
- Do not make downstream collector scrubbing the primary safety boundary.
- Do not change unrelated gateway, lease, or 1Password behavior.
- Do not publish or change `shravan-claw` until the `agent-vm` proof gates pass.
- Do not use the stable `shravan-claw` deployment as the first downstream
  proof target. `shravan-claw-beta` is the required downstream proof surface.

## Source Coverage

Plan source/context read completely:

| Source | Lines | Coverage | Use |
| --- | ---: | --- | --- |
| `tmp/debug-workflows/2026-06-14-agent-vm-master-observability-producer-gap/debug-investigation.md` | 247 | 1-247 | Current failure evidence and first diagnosis. |
| `docs/wip/communications/2026-06-12-victoria-observability-stack-handoff.md` | 165 | 1-165 | Current ownership model: agent-vm owns stack, OpenClaw is producer. |
| `docs/superpowers/plans/2026-05-21-observability-host-policy.md` | 675 | 1-675 | Historical implemented host-observability plan and deferred controller telemetry note. |
| `docs/superpowers/specs/2026-05-21-observability-host-policy-design.md` | 616 | 1-616 | Historical design, safety policy, and future controller telemetry facade direction. |
| PR #90 REST body | n/a | full body | Confirmed PR claimed stack/policy/readiness/scrubbing, not controller/gateway producer telemetry. |

Targeted repo evidence read for current implementation:

- `docs/reference/configuration/system-json.md` lines 100-240, 719-775, and
  1035-1055 for host and zone observability contracts.
- `packages/agent-vm/src/observability/observability-config.ts` for runtime
  config shape.
- `packages/agent-vm/src/observability/otel-collector-config.ts` for collector
  OTLP receiver/exporter/scrubber shape.
- `packages/agent-vm/src/controller/controller-runtime.ts` for controller
  readiness and `HealthEventStore` creation.
- `packages/agent-vm/src/controller/controller-runtime-types.ts` for runtime
  dependency injection.
- `packages/agent-vm/src/controller/health/health-event-store.ts` and
  `health-event-store.unit.test.ts` for the event store and durable log
  boundary.
- `packages/gateway-interface/src/health/agent-vm-health.ts` for existing
  structured health events.
- `packages/agent-vm/src/integration-tests/observability-storage-canary.host.e2e.test.ts`
  for current OTLP-to-Victoria storage proof style.
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts` for generated OpenClaw
  diagnostics config.
- `packages/agent-vm/src/build/managed-image-dockerfile.ts` and
  `packages/agent-vm/src/cli/build-command.ts` for managed OpenClaw package
  installation.

External/source research:

- DeepWiki on `open-telemetry/opentelemetry-js`: current Node path is manual
  instrumentation behind `NodeSDK`, explicit OTLP HTTP exporters for traces,
  metrics, and logs, and `instrumentations: []` to avoid broad
  auto-instrumentation. Logs packages/exporters remain experimental enough to
  keep behind an app facade.
- DeepWiki plus npm tarball inspection for `openclaw/openclaw@2026.5.20` and
  `@openclaw/diagnostics-otel@2026.5.20`: `diagnostics-otel` subscribes through
  `ctx.internalDiagnostics?.onEvent`, and OpenClaw grants that only when the
  service id matches the plugin id, the id is `diagnostics-otel` or
  `diagnostics-prometheus`, and the plugin origin is `bundled` or
  `trustedOfficialInstall`.

## Current Evidence

The host stack is not the blocker:

```text
collector health: 127.0.0.1:13133 => Server available
Victoria service.name labels => AgentStudio, ai-tools-observability-smoke
VictoriaLogs agent-vm/controller/gateway queries => no rows
VictoriaTraces agent-vm/controller/gateway queries => no rows
```

Current code gaps:

- `packages/agent-vm/package.json` has no `@opentelemetry/*` producer
  dependency.
- `createObservabilityRuntimeConfig` models host stack settings and OpenClaw
  zone telemetry settings, but no controller producer identity.
- `controller-runtime.ts` checks observability readiness and writes stderr
  messages; it does not start an OTLP SDK/exporter.
- `HealthEventStore.record` stores in memory and queues durable JSONL writes;
  it has no OTLP fanout sink.
- `AgentVmHealthEvent` already contains the key gateway/controller/lease/Tool VM
  operational event kinds we need to export.

OpenClaw trust evidence:

- `@openclaw/diagnostics-otel` logs
  `diagnostics-otel: internal diagnostics capability unavailable` when
  `ctx.internalDiagnostics?.onEvent` is absent.
- OpenClaw `services.ts` grants `internalDiagnostics` only to
  `diagnostics-otel`/`diagnostics-prometheus` when origin is `bundled` or
  `trustedOfficialInstall`.
- `trustedOfficialInstall` requires an official catalog match and a matching
  install record. A global package alone is not enough.
- OpenClaw config type marks `plugins.installs` as an internal transient carrier
  for install records and says it must not be persisted to `openclaw.json`.
- OpenClaw has sanctioned plugin-owned config mutation hooks/flows, including
  focused `mutateConfigFile(...)` writes, registered config migrations,
  auto-enable probes, and install-record commit/registry refresh flows. The
  diagnostics trust fix should trigger those supported OpenClaw mechanisms
  first, instead of hand-authoring OpenClaw's protected internal install ledger.
- Current agent-vm image generation installs `@openclaw/diagnostics-otel` with
  `pnpm add -g`, but existing proof only asserts the install line exists.

## Architecture Decision

Add a host-side `agent-vm` telemetry facade. Controller/runtime code records
safe operational events through that facade; no application code calls broad
OpenTelemetry APIs directly.

Use OpenTelemetry JS SDK packages behind the facade:

- `@opentelemetry/api`
- `@opentelemetry/sdk-node`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`
- `@opentelemetry/sdk-metrics`
- `@opentelemetry/sdk-logs`
- `@opentelemetry/exporter-trace-otlp-http`
- `@opentelemetry/exporter-metrics-otlp-http`
- `@opentelemetry/exporter-logs-otlp-http`

Implementation must verify exact package names and current versions before the
lockfile change. If package APIs drift during implementation, keep the facade
contract stable and adapt only the package-specific adapter.

Disable auto-instrumentation:

```text
NodeSDK({ instrumentations: [] })
```

Initial emitted signals:

```text
logs:
  agent_vm.health_event
  agent_vm.controller_lifecycle
  agent_vm.observability_readiness

metrics:
  agent_vm_health_events_total
  agent_vm_health_event_duration_ms
  agent_vm_gateway_recovery_events_total

traces:
  short manual spans only for bounded operations where start/end are real
  or can be faithfully represented, such as gateway recovery and controller
  request attempts. Do not synthesize broad spans for every passive state.
```

Resource identity:

```text
service.name = agent-vm-controller
service.version = <package version>
dev.repo.hash = <repo identity hash>
dev.worktree.hash = <worktree identity hash>
dev.runtime.flavor = agent-vm|openclaw|beta
dev.release.channel = local|managed|beta
agent.vm.project_namespace = <host.projectNamespace>
agent.vm.controller.port = <host.controllerPort>
agent.vm.observability.stack_mode = managed|external
```

Proof-only attributes are allowed only for fresh verification runs and must not
be promoted to stream labels:

```text
agent.proof.marker = <fresh marker from AGENT_VM_OBSERVABILITY_MARKER>
agent.proof.started_at = <bounded verification start time>
```

Event attributes must be allowlisted and low-cardinality. Do not export raw
errors, stack traces, commands, prompts, tool payloads, response bodies, request
headers, cookies, token values, credentialed URLs, 1Password refs with resolved
values, private paths, or unbounded session keys.

## Task Sequence

### Task 0 - Revalidate And Capture Red Proof

Owner: executor.

Tasks:

- Confirm branch/worktree state and target branch.
- Re-run the live Victoria queries for `agent-vm`, controller, gateway,
  `gateway-control-link`, `lease-renew`, and the configured OpenClaw service.
- Re-run collector/Victoria health checks.
- Record the current red proof before implementation.

Write surfaces:

- No product code changes.
- Optional `tmp/debug-workflows/...` evidence note updates only if useful.

Validation:

```bash
git status --short --branch
curl -fsS http://127.0.0.1:13133/
curl -fsS 'http://127.0.0.1:8428/api/v1/label/service.name/values'
```

### Task 1 - Add Controller Telemetry Facade

Owner: executor.

Likely files:

- `packages/agent-vm/src/observability/controller-telemetry.ts`
- `packages/agent-vm/src/observability/controller-telemetry.unit.test.ts`
- `packages/agent-vm/package.json`
- `pnpm-lock.yaml`

Tasks:

- Add a small facade with:
  - `startControllerTelemetry`
  - `recordHealthEvent`
  - `recordControllerLifecycleEvent`
  - `recordObservabilityReadiness`
  - `forceFlush`
  - `shutdown`
- Build OTLP endpoint from enabled observability runtime config:
  `http://<bindAddress>:<collectorHttp>`.
- Build safe resource attributes for controller telemetry, including
  `dev.repo.hash`, `dev.worktree.hash`, `dev.runtime.flavor`, and
  `dev.release.channel`. Do not export raw repo or worktree paths.
- Support proof-only marker attributes from
  `AGENT_VM_OBSERVABILITY_MARKER`/verification context so host-docker and beta
  Victoria queries can prove fresh data.
- Use `instrumentations: []`.
- Use plural SDK options where current OpenTelemetry JS supports them:
  `metricReaders`, `logRecordProcessors`.
- Provide a no-op implementation when host observability is disabled,
  controller start policy is off, no selected observable zones exist, or setup
  fails.
- Make exporter setup fail-open by default; readiness policy still controls only
  stack readiness, not telemetry SDK startup.

Proof:

- Unit tests for enabled, disabled, setup failure, endpoint construction,
  resource attributes, and no auto-instrumentation.

### Task 2 - Add Safe Health Event Mapping

Owner: executor.

Likely files:

- `packages/agent-vm/src/observability/health-event-telemetry.ts`
- `packages/agent-vm/src/observability/health-event-telemetry.unit.test.ts`
- `packages/gateway-interface/src/health/agent-vm-health.ts` only if a missing
  safe classification field is truly needed.

Tasks:

- Map every `AgentVmHealthEvent` kind to:
  - one log record with stable event name;
  - counter labels;
  - duration histogram input when `elapsedMs` exists; and
  - optional trace/span metadata only for faithful bounded operations.
- Add an explicit allowlist per event kind.
- Bucket or omit high-cardinality ids unless needed for operator correlation.
  If `leaseId` or `useId` is retained, it must be bounded/truncated or marked as
  a deliberate operator-correlation field in tests.
- Coarse-grain errors to `errorCode`/error category only.
- Ensure no mapper path serializes the full event object blindly.

Proof:

- Unit tests for every `AgentVmHealthEvent.kind`.
- Canary tests proving forbidden fields are dropped/absent.
- Type-level exhaustiveness: adding a new event kind must fail tests or
  compilation until the telemetry mapper is updated.

### Task 3 - Fan Out HealthEventStore To Telemetry Sinks

Owner: executor.

Likely files:

- `packages/agent-vm/src/controller/health/health-event-store.ts`
- `packages/agent-vm/src/controller/health/health-event-store.unit.test.ts`

Tasks:

- Add optional event sinks to `HealthEventStoreOptions`.
- Preserve current in-memory and durable JSONL semantics.
- Do not await sink writes on the synchronous `record` path.
- Queue sink writes with failure isolation, like durable writes.
- Add `flushSinks` or extend `flushDurableWrites` carefully so tests and
  runtime close can drain telemetry without changing health serving behavior.
- If telemetry sink fails, health recording must continue.

Proof:

- Unit tests that sink receives events.
- Unit tests that sink failure does not break in-memory health or durable log.
- Unit tests that flush drains queued telemetry writes.

### Task 4 - Wire Controller Runtime And Lifecycle Events

Owner: executor.

Likely files:

- `packages/agent-vm/src/controller/controller-runtime.ts`
- `packages/agent-vm/src/controller/controller-runtime-types.ts`
- `packages/agent-vm/src/controller/controller-runtime.unit.test.ts`

Tasks:

- Create controller telemetry after observability runtime config is known and
  before `HealthEventStore` is constructed.
- Inject telemetry dependencies for tests.
- Pass telemetry sink into `HealthEventStore`.
- Emit lifecycle/readiness events for:
  - controller API bound;
  - observability ready/degraded/require-ready failure;
  - selected zone gateway start attempted/succeeded/failed where safe.
- Keep existing stderr logs.
- Flush and shut down telemetry on `runtime.close()`.
- Ensure telemetry setup never starts Docker and never blocks the fast path
  beyond bounded SDK initialization.

Proof:

- Existing controller startup tests still pass.
- New unit tests prove degraded readiness does not block startup.
- New unit tests prove require-ready failure records/flushed telemetry when
  possible and still closes the server.
- New unit tests prove `runtime.close()` shuts down telemetry once.

### Task 5 - Add Fake OTLP Receiver Proof

Owner: executor.

Likely files:

- `packages/agent-vm/src/integration-tests/controller-telemetry.host.e2e.test.ts`
  or another existing host e2e location that matches repo naming rules.
- Shared helper module only if the existing storage canary helpers are too
  duplicated.

Tasks:

- Start a local fake OTLP HTTP receiver on loopback.
- Run the real telemetry facade or a controller-runtime slice against that
  receiver.
- Trigger representative events:
  - `gateway-control-link`
  - `gateway-service-health`
  - `lease-renew`
  - `lease-heartbeat`
  - `tool-vm-ssh`
  - `gateway-recovery`
  - controller lifecycle/readiness
- Assert the fake receiver observes OTLP requests on `/v1/logs`,
  `/v1/metrics`, and `/v1/traces` when traces are enabled for bounded events.
- Assert forbidden canaries are absent from serialized request bodies.

Proof:

```bash
pnpm exec vitest run --config vitest.config.ts --project e2e-host packages/agent-vm/src/integration-tests/controller-telemetry.host.e2e.test.ts
```

### Task 6 - Add Managed Victoria Controller Storage Proof

Owner: executor.

Likely files:

- `packages/agent-vm/src/integration-tests/observability-storage-canary.host.e2e.test.ts`
  or a sibling `controller-telemetry-storage-canary.host.e2e.test.ts`.

Tasks:

- Reuse the existing managed stack canary pattern.
- Emit controller telemetry through the real facade into the managed collector.
- Query:
  - VictoriaLogs for `service.name=agent-vm-controller`;
  - VictoriaMetrics for `agent_vm_health_events_total`;
  - VictoriaTraces for a bounded controller/gateway operation span if enabled.
- Require a fresh proof marker and the required producer resource labels in
  positive Victoria queries.
- Verify sensitive canaries are absent from Victoria storage.

Proof:

```bash
GITHUB_ACTIONS=true pnpm run test:e2e:host-docker
```

or the narrower host-docker project command that owns the storage canary.

### Task 7 - Fix And Prove OpenClaw Diagnostics Trust

Owner: executor.

Likely files:

- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- `packages/agent-vm/src/build/managed-image-release.unit.test.ts`
- `packages/agent-vm/src/cli/build-command.integration.test.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts`
- Live OpenClaw e2e tests if already available for observability.

Tasks:

- First reproduce the trust issue with a minimal OpenClaw runtime proof:
  installed `@openclaw/diagnostics-otel`, config allows it, but registry record
  lacks `trustedOfficialInstall`, causing missing `internalDiagnostics`.
- Test fix candidates in this order:
  1. Identify and use OpenClaw's supported plugin config mutation hook/flow
     during image build. This should be the same sanctioned mechanism plugins
     use for focused config mutation, config migration, auto-enable, and
     install-record commit/registry refresh, and it must run non-interactively.
  2. If the supported command internally uses a transient install-record
     carrier, prove that shape from OpenClaw source/tests and generate only the
     minimum stage/runtime input needed for OpenClaw itself to commit the
     trusted official install record.
  3. If no supported non-interactive path exists, fail the build/preflight with
     a clear diagnostic
     and document that an upstream OpenClaw change is required.
- Do not persist `plugins.installs` into user-authored `openclaw.json`.
- Ensure the generated effective config still owns `diagnostics-otel` plugin
  allow/entry and `diagnostics.otel` safety fields.
- Add unit/integration tests that prove the generated Dockerfile or runtime
  setup creates the trusted official install condition, not just the package
  install line.
- Add live proof that the runtime log no longer contains
  `diagnostics-otel: internal diagnostics capability unavailable`.

Proof:

```bash
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/build/managed-image-release.unit.test.ts
pnpm exec vitest run --config vitest.config.ts --project integration packages/agent-vm/src/cli/build-command.integration.test.ts
pnpm exec vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts
mise exec -- pnpm test:e2e:openclaw
```

If the live VM/OpenClaw gate cannot run because Docker/QEMU/Zig prerequisites
are unavailable, stop short of claiming the OpenClaw producer fixed and report
the lower-layer proof separately.

### Task 8 - Docs And Generated Manuals

Owner: executor.

Likely files:

- `docs/reference/configuration/system-json.md`
- `docs/subsystems/controller.md`
- `docs/architecture/openclaw-gateway.md`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.unit.test.ts`
- Possibly a short `docs/wip/communications/...` handoff after implementation.

Tasks:

- Document that `host.observability` now has two producer classes:
  - `agent-vm-controller`
  - OpenClaw zone service names.
- Document safe fields and forbidden content.
- Document how operators query Victoria for controller/gateway health events.
- Document the OpenClaw trust/preflight behavior and the no-user-authored
  `plugins.installs` rule.
- Keep generated manuals concise and procedural.

Proof:

```bash
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/cli/manual-templates.unit.test.ts
pnpm build
```

### Task 9 - Downstream Shravan-Claw Beta Validation

Owner: executor, after `agent-vm` proof gates pass.

Likely repo:

```text
/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta
```

Tasks:

- Inspect beta before edits:
  - `git status --short --branch`
  - `git diff --stat`
  - `config/system.jsonc` for existing `host.observability`
  - `zones[].observability` for the beta OpenClaw zone.
- Keep the beta diff small and inspectable. Expected beta write surface is
  limited to dependency sync artifacts, observability config opt-in, generated
  manual/schema refresh if required, and managed-image overlay refresh from the
  existing sync helper.
- For unpublished local validation, use the repo-documented helper:

  ```bash
  pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta
  ```

  The repo instructions require this path to build once, pack local
  `@agent-vm/*` tarballs, update beta dependency pins, run `pnpm install` in
  beta, and refresh beta OpenClaw overlay tarballs.
- For published-package validation, verify beta is pinned to the intended
  registry version and is not left on stale local tarballs.
- Ensure beta has the minimal observability config needed for the proof:
  - `host.observability.enabled=true`
  - `host.observability.stack.mode=managed`
  - loopback collector/Victoria ports
  - durable beta `host.observability.dataDir`
  - `zones[].observability.enabled=true` for zone `beta`
  - beta OpenClaw `serviceName`
  - safe diagnostics flags only.
- Run beta's normal validation/build/start path without disturbing stable
  `shravan-claw`:
  - `pnpm validate`
  - `mise exec -- pnpm build`
  - `pnpm start` in a controlled long-running session, or an explicit restart
    only after recording the pre-existing controller/listener state.
- Keep the beta controller running while Victoria queries execute from another
  shell/session. If the executor started the beta controller, it owns clean
  shutdown; if it attached to an already-running beta controller, it must not
  stop it without explicit operator intent.
- Use a fresh proof marker for the beta run and require Victoria rows carrying
  the required resource labels:
  - `dev.repo.hash`
  - `dev.worktree.hash`
  - `dev.release.channel=beta`
  - `dev.runtime.flavor=beta` or the equivalent documented beta runtime value.
- Query Victoria for:
  - `service.name=agent-vm-controller`
  - `agent_vm.health_event`
  - `agent_vm.controller_lifecycle`
  - beta configured OpenClaw service name
  - `gateway-control-link`
  - `lease-renew`
  - `tool-vm-ssh`
  - OpenClaw diagnostics logs/traces/metrics.
- Record the beta diff after proof and confirm it remains limited to the
  expected small set. If the beta diff expands into unrelated config,
  generated artifacts, or stable deployment files, stop and replan before
  claiming downstream proof.

Proof:

- Live beta `pnpm validate`, `mise exec -- pnpm build`, and `pnpm start`
  evidence.
- Victoria queries with row counts, fresh marker, beta resource labels, and
  sample safe attributes.
- Sentinel sensitive strings absent from Victoria storage.
- `git diff --stat` and `git diff --name-only` from beta before and after the
  proof, showing the deployment delta is small and expected.

### Task 10 - Stable Shravan-Claw Validation After Beta

Owner: executor, only after beta proof is green and the user agrees to promote
the package/deployment change beyond beta.

Tasks:

- Update `/Users/shravansunder/Documents/dev/project-dev/shravan-claw` only
  after the beta controller has proven Victoria storage end to end.
- Reuse the beta query set and service-name checks, but keep stable deployment
  changes out of the beta proof gate.

## Requirements And Proof Matrix

| Requirement / Claim | Owning task | Proof owner | Proof gate | Layer | Stale-proof guard | Red/green? | Sized to pass? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Current managed stack is healthy but has no agent-vm/controller/gateway telemetry. | 0 | executor | Live Victoria + collector queries | smoke | Run on current date before code edits. | red required | yes |
| Controller/gateway telemetry uses a facade, manual instruments, and no broad auto-instrumentation. | 1 | executor | Unit tests inspect facade config; type review | unit | Check `instrumentations: []` and no `auto-instrumentations-node` dependency. | green required | yes |
| Telemetry setup is fail-open and does not change readiness semantics. | 1, 4 | executor | Controller runtime unit tests | unit | Existing degraded/require-ready tests must still pass. | green required | yes |
| Every `AgentVmHealthEvent.kind` maps to safe logs/metrics and any spans are bounded. | 2 | executor | Exhaustive mapper unit tests | unit | Adding an event kind must fail until mapper updated. | red/green required | yes |
| Health event recording remains available when telemetry export fails. | 3 | executor | HealthEventStore unit tests | unit | Test sink failure plus durable log failure independently. | red/green required | yes |
| Runtime emits controller lifecycle/readiness and gateway health events into telemetry. | 4, 5 | executor | Controller runtime unit + fake OTLP host e2e | integration, host e2e | Use real controller/runtime seams, not only mapper tests. | red/green required | yes |
| Managed Victoria stores `agent-vm-controller` telemetry with no sensitive canaries. | 6 | executor | Host-docker Victoria storage canary | host e2e | Query Victoria directly; fail on skipped/zero tests. | green required | yes if Docker available |
| Controller and OpenClaw telemetry carry required producer identity labels. | 1, 2, 6, 9 | executor | Unit resource tests + Victoria queries for `dev.repo.hash`, `dev.worktree.hash`, `dev.release.channel`, and `dev.runtime.flavor` | unit, host e2e, beta smoke | Use fresh marker and current worktree hash; do not accept unlabeled Victoria rows. | green required | yes |
| Victoria proof uses fresh data, not stale stored rows. | 1, 6, 9 | executor | `AGENT_VM_OBSERVABILITY_MARKER` propagation plus positive/negative Victoria queries | unit, host e2e, beta smoke | Marker must be generated for the current proof run and included in positive queries. | green required | yes |
| OpenClaw diagnostics plugin receives internal diagnostics capability. | 7 | executor | Source-level trust proof + live OpenClaw e2e | host e2e, VM/OpenClaw e2e | Runtime log must not contain capability-unavailable; Victoria must show configured service name. | red/green required | split if upstream-blocked |
| Docs/manuals explain producer boundaries and safe querying. | 8 | executor | Manual template tests + docs review | unit/docs | Generated manual must mention controller and OpenClaw producer distinction. | green required | yes |
| Beta managed deployment proves real operational data through the beta controller. | 9 | executor | `shravan-claw-beta` validate/build/start + Victoria queries | smoke/e2e | Query live beta deployment after dependency sync; rows must include beta resource labels and a fresh marker. | green required | yes after release/sync |
| Beta deployment delta stays small and inspectable. | 9 | executor | Beta `git diff --stat` and `git diff --name-only` before/after proof | review/proof | Stop if unrelated beta files or stable `shravan-claw` files are touched. | green required | yes |
| Stable deployment is not changed before beta proof. | 10 | executor | `git status --short --branch` in stable `shravan-claw` before beta proof | review/proof | Stable promotion requires explicit post-beta decision. | green required | yes |

## Validation Gates

Targeted iteration:

```bash
git diff --check
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/observability
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/health/health-event-store.unit.test.ts
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/controller/controller-runtime.unit.test.ts
pnpm exec vitest run --config vitest.config.ts --project e2e-host packages/agent-vm/src/integration-tests/controller-telemetry.host.e2e.test.ts
```

OpenClaw producer lane:

```bash
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/build/managed-image-release.unit.test.ts
pnpm exec vitest run --config vitest.config.ts --project integration packages/agent-vm/src/cli/build-command.integration.test.ts
pnpm exec vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts
mise exec -- pnpm test:e2e:openclaw
```

Broad gates before done:

```bash
pnpm lint
pnpm lint:types
pnpm typecheck
pnpm fmt:check
pnpm test:unit
pnpm test:integration
pnpm test:e2e:host
pnpm test:e2e:inventory
pnpm check
```

Beta behavioral smoke after package sync:

```bash
# From /Users/shravansunder/Documents/dev/project-dev/agent-vm
pnpm dev:sync-tarballs -- --deployment ../shravan-claw-beta

# From /Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta
export AGENT_VM_OBSERVABILITY_MARKER="agent-vm-beta-$(date +%s)"
git status --short --branch
git diff --stat
pnpm validate
mise exec -- pnpm build

# In a controlled long-running beta session; keep it running during queries.
pnpm start

# In another shell while beta is live.
curl -fsS 'http://127.0.0.1:8428/api/v1/label/service.name/values'
curl -fsS 'http://127.0.0.1:9428/select/logsql/query' --data-urlencode "query=service.name:agent-vm-controller dev.release.channel:beta agent.proof.marker:$AGENT_VM_OBSERVABILITY_MARKER" --data-urlencode 'limit=20'
curl -fsS 'http://127.0.0.1:10428/select/logsql/query' --data-urlencode 'query="resource_attr:service.name":agent-vm-controller "resource_attr:dev.release.channel":beta' --data-urlencode 'limit=20'
git diff --stat
git diff --name-only
```

Report exit codes, pass/fail counts, and skipped tests. Skipped e2e inventory
does not prove runtime behavior.

## Write Surfaces

Expected code/test surfaces:

- `packages/agent-vm/package.json`
- `pnpm-lock.yaml`
- `packages/agent-vm/src/observability/*`
- `packages/agent-vm/src/controller/health/health-event-store.ts`
- `packages/agent-vm/src/controller/controller-runtime.ts`
- `packages/agent-vm/src/controller/controller-runtime-types.ts`
- `packages/agent-vm/src/integration-tests/*telemetry*.host.e2e.test.ts`
- `packages/agent-vm/src/build/managed-image-dockerfile.ts`
- `packages/agent-vm/src/build/managed-image-release.unit.test.ts`
- `packages/agent-vm/src/cli/build-command.integration.test.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts`
- `docs/reference/configuration/system-json.md`
- `docs/subsystems/controller.md`
- `docs/architecture/openclaw-gateway.md`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.unit.test.ts`

Downstream surfaces only after repo proof:

- `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/package.json`
- `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/pnpm-lock.yaml`
- `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/system.jsonc`
- `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/config/schemas/system.schema.json`
- `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/docs/manual/observability.md`
- `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/vm-images/gateways/openclaw/overlay.jsonc`
- `/Users/shravansunder/Documents/dev/project-dev/shravan-claw-beta/vm-images/tool-vms/default/overlay.jsonc`

Stable deployment surfaces only after beta proof and explicit promotion:

- `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/package.json`
- `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/pnpm-lock.yaml`
- stable downstream config/manual docs as needed.

## Security Assumptions

- Source-side non-emission is the primary invariant. Collector/Victoria
  scrubbers are defense in depth.
- Logs should use event names and attributes. Do not place sensitive data in log
  bodies.
- Metrics labels must be low-cardinality and safe.
- Spans must not include raw URLs, request bodies, headers, commands, prompts,
  tool payloads, paths, or raw stacks.
- `plugins.installs` is an OpenClaw internal transient install-record carrier.
  Do not write it directly as agent-vm's primary integration strategy. If it is
  involved, it must be because OpenClaw's supported plugin modify/install flow
  consumes it as a transient carrier, and it must never be written to
  user-authored `openclaw.json`.

## Rollback And Recovery

- If controller telemetry causes startup instability, the implementation must
  fail open and keep the controller running. Operators can also disable
  `host.observability` while the code fix is reverted.
- If OpenClaw trust repair breaks image build, revert the managed image
  Dockerfile change and keep the controller producer fix; do not couple the two
  producer lanes.
- If a canary ever appears in Victoria storage, stop the run, preserve evidence
  under `tmp/debug-workflows`, do not continue adding telemetry fields, and use
  VictoriaLogs deletion only as incident response after preserving proof.
- If VM/OpenClaw live e2e prerequisites are unavailable, report lower-layer
  proof and do not claim OpenClaw producer done.

## Split Or Replan Triggers

- OpenTelemetry JS package APIs differ from the researched shape enough that
  the facade cannot compile cleanly.
- Logs export cannot be made safe and testable behind the facade.
- OpenClaw cannot be made to create a trusted official diagnostics install
  record without an upstream change.
- Host e2e fake receiver cannot reliably parse/observe SDK OTLP output.
- Managed Victoria proof becomes flaky or depends on fixed ports unavailable in
  local/CI.

When triggered, split the affected lane and keep completed producer proof
separate from unresolved producer proof.

## Open Questions

1. Should `agent-vm-controller` service name be configurable later, or fixed in
   v1 to avoid expanding config surface?
2. Should controller telemetry emit when `host.observability.enabled=true` but
   no selected zone has `zones[].observability.enabled=true`? Current stack
   preparation is zone-gated, so v1 should likely emit only when a collector is
   configured for selected observable zones.
3. Should we keep lease identifiers as bounded correlation attributes, hash
   them, or omit them from Victoria by default?
4. If OpenClaw’s supported fix is `openclaw plugins install`, is it acceptable
   for managed image builds to run that command during Docker build, or should
   agent-vm generate a transient install ledger instead?

## Recommended Next Step

Run `shravan-dev-workflow:plan-review-swarm` on this plan before
implementation. After review findings are resolved, execute with
`shravan-dev-workflow:implementation-execute-plan`.
