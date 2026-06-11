# Observability Host Policy Implementation Plan

Date: 2026-06-09
Status: implemented in branch; pending review and merge decision
Branch: `feat/observability-host-policy`
Companion spec:
`docs/superpowers/specs/2026-05-21-observability-host-policy-design.md`

## Current branch state

This branch has been rebased onto current `origin/master` and now contains the
observability implementation plus the refreshed plan/spec docs. Do not resurrect
stale code from the old branch.

The old plan is intentionally superseded. It modeled operator-managed Compose
and zone-level `externalResources`; the revised design models a host
observability plane where `stack.mode: "managed"` owns local Compose during
build and `stack.mode: "external"` connects to a shared collector without
Docker work. External mode now requires
`stack.scrubbing.responsibility: "external-collector"` so the shared collector
sanitization contract is explicit instead of implicit.

## Current implementation evidence

- Host observability config, stack ownership, retention, storage isolation,
  loopback bind, and OpenClaw-only zone opt-in live in `system.json`.
- `agent-vm build` prepares a generated Victoria + OpenTelemetry Collector
  Compose stack for `stack.mode: "managed"` when config enables it.
- `stack.mode: "external"` connects OpenClaw to a shared collector and never
  calls Docker Compose from this deployment. It rejects managed-only storage and
  Compose fields.
- `agent-vm build --no-observability` skips the stack for a single run.
- Controller startup does not call Docker or Compose. It only performs bounded
  readiness checks according to `controllerStartPolicy`.
- OpenClaw collector mode generates `diagnostics-otel`, `diagnostics.otel`
  logs/metrics/traces, and `tcpHosts` for the synthetic collector host.
- Generated collector exporters use protobuf OTLP with gzip compression for
  metrics, logs, and traces.
- Managed collector and VictoriaLogs scrub known sensitive fields; external mode
  requires an explicit external collector scrubber responsibility. Source config
  rejects broad diagnostics flags, raw `OPENCLAW_DIAGNOSTICS`, and content
  capture.
- A live host e2e canary sends OTLP protobuf logs, metrics, and traces through
  the collector and verifies storage in VictoriaLogs, VictoriaMetrics, and
  VictoriaTraces.
- Native controller OpenTelemetry instrumentation is not implemented in this
  branch. The companion spec records the intended facade and library path.

## Goal

Implement local, durable, Victoria-backed observability for OpenClaw debugging
without slowing controller startup.

The implementation must:

1. Add a host observability config surface with managed and external stack
   ownership modes.
2. Generate and manage a local Docker Compose Victoria + OpenTelemetry Collector
   stack only for managed mode from the configured build/prepare path.
3. Prepare that stack during plain `agent-vm build` when config enables it.
4. Keep `agent-vm controller start` free of slow Docker work.
5. Map ready host observability endpoints into the OpenClaw Gateway VM.
6. Generate effective OpenClaw diagnostics config for metrics, traces, and logs.
7. Add OpenClaw diagnostics/debug policy without enabling content capture.
8. Enforce no-secret telemetry invariants at source, collector, and VictoriaLogs
   ingestion/query boundaries.
9. Provide tests, docs, and a black-box deployment smoke before claiming done.

## Required mode

Implementation has started on this branch. Continue with review, fixes, and
verification only. Do not commit, merge, tag, push, or rewrite remote history
unless explicitly instructed.

## Design summary

```text
managed slow path:

  agent-vm build
        |
        v
  generate compose + collector config
        |
        v
  docker compose up + readiness wait
        |
        v
  durable bind-mounted dataDir

external build path:

  agent-vm build
        |
        v
  report external/shared stack
        |
        v
  no Docker/Compose call

fast path:

  agent-vm controller start
        |
        +--> fast observability status check only
        +--> synthetic DNS/tcpHosts for Gateway VM
        +--> effective OpenClaw diagnostics config
        |
        v
  OpenClaw diagnostics-otel exports to collector
```

## Phase 0 - Revalidate before coding

- [ ] Re-read `AGENTS.md`.
- [ ] Confirm branch state:

```bash
git status --short --branch
git rev-list --left-right --count origin/master...HEAD
git diff --name-status origin/master...HEAD
```

Expected before implementation: only the plan/spec docs differ from
`origin/master`.

- [ ] Re-check current code paths:
  - `packages/agent-vm/src/config/system-config.ts`
  - `packages/agent-vm/src/cli/commands/controller-definition.ts`
  - `packages/agent-vm/src/cli/build-command.ts`
  - `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
  - `packages/agent-vm/src/controller/health/gateway-vm-recovery-runner.ts`
  - `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
  - `packages/gateway-interface/src/gateway-lifecycle.ts`
  - `packages/agent-vm/src/resources/resource-compiler.ts`
  - `docs/reference/configuration/resource-contracts.md`

Stop if current code has materially changed from the companion spec evidence.

## Phase 1 - Config schema and types

Files likely touched:

- `packages/agent-vm/src/config/system-config.ts`
- `packages/agent-vm/src/config/system-config.unit.test.ts`
- New module under `packages/agent-vm/src/observability/`

Tasks:

- [x] Add `host.observability` schema with `stack.mode` managed/external.
- [x] Require `host.observability.dataDir` only when `stack.mode` is managed.
- [x] Require `stack.scrubbing.responsibility: "external-collector"` for
  external collectors.
- [x] Generate the author-facing JSON Schema from Zod input mode so defaults and
  managed/external variants match deployer-authored config.
- [x] Resolve `dataDir` through the same config path-resolution path as other
  config directories before overlap checks.
- [x] Validate `dataDir` is outside `cacheDir`, `runtimeDir`, every zone
  `stateDir`, every OpenClaw `zoneFilesDir`, and any other known
  cleanup/destructive-command root.
- [x] Constrain v1 `host.observability.bindAddress` to loopback only. Accept
  `127.0.0.1` and, if implemented, `::1`; reject `0.0.0.0`, `::`, and LAN
  addresses.
- [x] Add `controllerStartPolicy` enum:
  - `degraded`
  - `require-ready`
  - `off`
- [x] Add retention schemas for metrics, logs, and traces. Metrics accept
  period plus optional minimum free disk; logs accept period plus optional max
  bytes; traces accept period plus one disk cap, either max bytes or max
  percent.
- [x] Validate retention period and byte-size strings before Compose renders
  Victoria flags.
- [x] Validate `projectName` against Docker Compose project-name-safe grammar.
- [x] Validate observability ports are in range and unique.
- [x] Add `mode` with only `collector` accepted in v1. Reject other values
  clearly even if the field is shaped to allow future expansion.
- [x] Add `prepareOnBuild`, default true when host observability is enabled.
- [x] Add `waitOnBuild`, default true for local developer deployments.
- [ ] Add `startupCheckTimeoutMs`, default 500.
- [ ] Add `zones[].observability` OpenClaw opt-in schema.
- [ ] Reject zone observability when host observability is disabled.
- [ ] Reject zone observability for non-OpenClaw gateways in v1.
- [ ] Reject OpenClaw observability when the selected gateway image profile is
  not the managed `openclaw-gateway` base that installs
  `@openclaw/diagnostics-otel`.

Test expectations:

- Defaults are stable and explicit.
- Invalid retention/disk-cap combinations fail with clear paths.
- `host.observability.enabled: true` with managed `stack.mode` and no `dataDir`
  fails.
- External `stack.mode` loads without managed Compose storage fields.
- Relative and tilde `dataDir` inputs are validated after resolution.
- `dataDir` under cache/runtime/state/zone-files cleanup roots fails.
- Non-loopback `bindAddress` values fail.
- `zones[].observability.enabled: true` without host observability fails.
- Non-OpenClaw zone opt-in fails.

Suggested targeted command:

```bash
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/config/system-config.unit.test.ts
```

## Phase 2 - Render host observability artifacts

Files likely touched:

- New `packages/agent-vm/src/observability/observability-config.ts`
- New `packages/agent-vm/src/observability/observability-compose.ts`
- New `packages/agent-vm/src/observability/otel-collector-config.ts`
- New unit tests beside those modules, such as
  `observability-config.unit.test.ts`, `observability-compose.unit.test.ts`,
  and `otel-collector-config.unit.test.ts`

Tasks:

- [ ] Build a normalized runtime model from system config.
- [ ] Render `docker-compose.observability.yml`.
- [ ] Render `otel-collector-config.yaml` for collector mode.
- [ ] Use pinned image tags or configurable image tags. Do not use floating tags
  unless the final design explicitly accepts that tradeoff.
- [ ] Bind host ports to `host.observability.bindAddress`, default
  `127.0.0.1`.
- [ ] Render all collector and Victoria services with `restart: unless-stopped`
  so Docker can restore prepared services without involving controller startup.
- [ ] Bind-mount durable storage directories:
  - `${dataDir}/metrics`
  - `${dataDir}/logs`
  - `${dataDir}/traces`
- [ ] Pass Victoria retention and disk flags from config.
- [ ] Add collector health extension on a configured local health port.
- [ ] Ensure rendered files contain no secrets.
- [ ] Add collector-side sanitization before any Victoria exporter:
  - drop known sensitive attributes such as auth headers, cookies, API keys,
    token fields, password fields, private key fields, and credentialed URLs
  - keep raw body/message/payload fields out of the pipeline by default
  - hash, truncate, or drop identifiers that do not need full fidelity
- [ ] Add VictoriaLogs ingest defense-in-depth for known sensitive fields using
  `ignore_fields` / `VL-Ignore-Fields` where the selected ingestion path
  supports it.

Test expectations:

- Rendered Compose is deterministic.
- Rendered collector config points metrics/logs/traces at the Victoria service
  names and official OTLP paths.
- Data mounts use bind paths under `dataDir`.
- No generated command uses `down -v` or removes data.
- Collector config contains a sanitization stage before Victoria exporters.
- Object tests prove the sanitization processor is wired into every logs,
  traces, and metrics pipeline.
- VictoriaLogs ingest configuration drops known sensitive field names/prefixes
  where supported.
- Snapshot/object tests assert no generated config contains secret values or
  secret-looking placeholders.
- Fixture tests cover known-bad fields such as `authorization`, `cookie`,
  `token`, `password`, `body`, `message`, `payload`, and credentialed URLs.
- Compose render tests prove every published port is bound to a loopback host.

Suggested targeted command:

```bash
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/observability
```

## Phase 3 - Add observability lifecycle adapter

Files likely touched:

- New observability lifecycle modules/tests

Tasks:

- [ ] Shell out to Docker Compose through a narrow adapter so tests can stub it.
- [ ] Render Compose and collector config into
  `<runtimeDir>/observability/<projectNamespace>/`.
- [ ] Create durable Victoria data subdirectories under
  `host.observability.dataDir` for managed stacks.
- [ ] Implement build-time `waitOnBuild` readiness through the collector health
  endpoint after Compose returns.
- [ ] Do not add `down -v` or data deletion behavior in v1. Data deletion remains
  an explicit manual operator action outside the default `agent-vm` lifecycle.
- [ ] Leave explicit `agent-vm observability render|up|status|down` commands as
  a follow-up CLI convenience unless this slice is explicitly expanded.

Test expectations:

- The adapter writes deterministic compose and collector config paths.
- `waitOnBuild: true` waits for collector readiness after Compose returns.
- `waitOnBuild: false` does not wait.
- No default lifecycle path invokes `docker compose down -v`.

Suggested targeted command:

```bash
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/observability
```

## Phase 4 - Integrate with build, not controller startup

Files likely touched:

- `packages/agent-vm/src/cli/build-command.ts`
- `packages/agent-vm/src/cli/build-command.integration.test.ts`

Tasks:

- [ ] Make plain `agent-vm build` run observability preparation only when
  `host.observability.enabled` is true, `stack.mode` is managed, and at least
  one supported zone opts in.
- [ ] Make external `stack.mode` report the shared stack and skip Docker
  Compose.
- [ ] Add `agent-vm build --no-observability` as a one-run escape hatch that
  does not mutate config.
- [ ] Honor `host.observability.prepareOnBuild` and
  `host.observability.waitOnBuild` for the configured default behavior.
- [ ] Run observability preparation only after the existing build prep succeeds.
- [ ] Reuse the same lifecycle adapter from Phase 3.
- [ ] Preserve current build behavior when config does not enable
  observability.
- [ ] Add a clear message when observability is enabled but Docker is not
  available.

Test expectations:

- Existing build tests continue to pass when config does not enable
  observability.
- Enabled config calls observability preparation after image preparation.
- `prepareOnBuild: false` skips observability preparation without requiring a
  CLI flag.
- `waitOnBuild: true` waits for readiness; `waitOnBuild: false` starts without
  a readiness wait.
- `--no-observability` skips observability preparation even when config enables
  it.
- Build failures do not leave partial claims that observability is ready.

Suggested targeted command:

```bash
pnpm exec vitest run --config vitest.config.ts --project integration packages/agent-vm/src/cli/build-command.integration.test.ts
```

## Phase 5 - Gateway endpoint mapping

Files likely touched:

- `packages/gateway-interface/src/gateway-lifecycle.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- `packages/agent-vm/src/controller/*` or mapper modules that build
  `GatewayZoneConfig`

Tasks:

- [ ] Add an observability connection model to `GatewayZoneConfig`.
- [ ] In collector mode, map:

```text
otel-collector.observability.vm.host:4318 -> 127.0.0.1:<collectorHttp>
otel-collector.observability.vm.host:4317 -> 127.0.0.1:<collectorGrpc>
```

- [ ] Detect conflicts with existing `tcpHosts` keys and fail clearly.
- [ ] Do not use Worker task `externalResources` for this path.

Test expectations:

- Collector mode maps only collector hostnames.
- Non-collector mode is rejected in config validation.
- Conflicts with controller/tool/websocket mappings fail.
- Worker gateway behavior is unchanged.

Suggested targeted command:

```bash
pnpm exec vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts
```

## Phase 6 - Effective OpenClaw diagnostics config

Files likely touched:

- `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts`

Tasks:

- [ ] Merge `plugins.allow` to include `diagnostics-otel`.
- [ ] Merge `plugins.entries["diagnostics-otel"].enabled = true`.
- [ ] Merge top-level `diagnostics.enabled = true`.
- [ ] Merge `diagnostics.otel` from zone observability config.
- [ ] In collector mode, write shared endpoint:

```text
http://otel-collector.observability.vm.host:4318
```

- [ ] Reject direct mode in v1 with a clear validation error.
- [ ] Set `diagnostics.otel.logs = true` when log export is enabled.
- [ ] Keep `captureContent.enabled = false` by default.
- [ ] Reject or override generated configs that would enable OpenClaw content
  capture for prompts, responses, tool inputs, tool outputs, transcripts, or
  system prompts.
- [ ] Reject authored `logging.redactSensitive: "off"` for
  observability-enabled zones.
- [ ] Ensure generated telemetry fields are allowlisted operational fields:
  component, event kind, status, duration, counters, bounded labels, hashed or
  truncated identifiers, and coarse error categories.
- [ ] Preserve unrelated authored OpenClaw config.
- [ ] Make host/zone observability policy own the `diagnostics-otel` plugin entry
  and `diagnostics.otel` signal/exporter keys for observability-enabled zones.
  Preserve unrelated authored OpenClaw config.

Test expectations:

- Existing plugin config is preserved and extended.
- Collector endpoint is correct.
- Direct mode is rejected before effective config generation.
- Authored telemetry settings cannot disable required exporter safety,
  content-capture, or redaction settings.
- Logs are not silently omitted.
- Content capture remains off.
- Redaction is not disabled.
- Sensitive content fields cannot be enabled through generated config.
- Auth/token config injection still works.

Suggested targeted command:

```bash
pnpm exec vitest run --config vitest.config.ts --project e2e-host packages/openclaw-gateway/src/openclaw-lifecycle.host.e2e.test.ts
```

## Phase 7 - OpenClaw debug/log policy; controller logging deferred

Files likely touched:

- `packages/agent-vm/src/config/system-config.ts`
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts`

Native controller log-level flags, `host.logging`, and a controller
OpenTelemetry facade are intentionally deferred. This branch only owns
OpenClaw diagnostics safety for observability-enabled zones.

Tasks:

- [ ] Support generated OpenClaw diagnostics flags from an explicit safe
  allowlist only.
- [ ] Reject wildcard/all diagnostics env forms such as
  `OPENCLAW_DIAGNOSTICS=*`, `OPENCLAW_DIAGNOSTICS=all`, and
  `OPENCLAW_DIAGNOSTICS=1` for observability-enabled zones.
- [ ] Reject payload, body, content, query, transcript, and other
  sensitive-content-bearing diagnostics flags unless a future content-capture
  policy explicitly approves them.
- [ ] Ensure debug/trace modes increase operational detail without expanding
  secret-bearing payload capture.

Test expectations:

- Content capture remains off.
- Diagnostics flags do not add prompt, response, token, credential, or tool
  payload fields.
- Unsafe `OPENCLAW_DIAGNOSTICS` wildcard/all/payload/query values fail
  validation for observability-enabled zones.

Suggested targeted command:

```bash
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/config/system-config.unit.test.ts
```

## Phase 8 - Controller-owned gateway start guard

Files likely touched:

- `packages/agent-vm/src/cli/commands/controller-definition.ts`
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.ts`
- `packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.unit.test.ts`
- `packages/agent-vm/src/controller/health/gateway-vm-recovery-runner.ts`
- `packages/agent-vm/src/controller/health/gateway-vm-recovery-runner.unit.test.ts`
- `packages/agent-vm/src/cli/commands/controller-definition.unit.test.ts`
- Observability status module/tests

Tasks:

- [ ] Put the fast observability status check in the shared OpenClaw gateway
  start preparation path, not only in the CLI command wrapper.
- [ ] Apply the same policy to controller start, operator restart, cold start,
  upgrade-triggered restart, and gateway auto-recovery.
- [ ] Never call Docker Compose `up` from controller-owned gateway start paths.
- [ ] Never call Docker CLI from controller-owned gateway start paths. Readiness
  uses only bounded HTTP probes against the collector health endpoint.
- [ ] For `controllerStartPolicy: degraded`, log status and continue.
- [ ] For `controllerStartPolicy: require-ready`, fail fast if status is not
  ready.
- [ ] Add health/status details for observability readiness in a follow-up API
  contract change.

Test expectations:

- A command-level unit test proves `controller start` does not call the Compose
  adapter or Docker adapter before delegating to runtime startup.
- Runtime/gateway-start tests prove observability-enabled gateway start paths do
  not call Compose/Docker from start, restart, cold start, or auto-recovery.
- A unit test proves startup status checks honor `startupCheckTimeoutMs`.
- `degraded` continues.
- `require-ready` fails quickly.
- `off` does not check readiness.

Suggested targeted command:

```bash
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/cli/commands/controller-definition.unit.test.ts packages/agent-vm/src/controller/zone-runtimes/openclaw-zone-runtime.unit.test.ts packages/agent-vm/src/controller/health/gateway-vm-recovery-runner.unit.test.ts
```

## Phase 9 - Docs and generated manuals

Files likely touched:

- `docs/reference/configuration/system-json.md`
- `docs/subsystems/controller.md`
- `docs/architecture/openclaw-gateway.md`
- `packages/agent-vm/src/cli/manual-templates.ts`
- `packages/agent-vm/src/cli/manual-templates.unit.test.ts`

Tasks:

- [ ] Document `host.observability`.
- [ ] Document `zones[].observability`.
- [ ] Document the build-time observability lifecycle and the deferred explicit
  `agent-vm observability ...` command group.
- [ ] Document that controller startup never starts Docker.
- [ ] Document data retention and bind-mounted storage.
- [ ] Document the secret policy:
  - never emit secrets or sensitive content in the first place
  - OpenClaw content capture remains off
  - generated configs must not disable redaction
  - collector/VictoriaLogs scrubbers are defense-in-depth only
  - VictoriaLogs deletion APIs are incident response, not routine lifecycle
- [ ] Add a generated manual page for deployment agents.
- [ ] Keep generated manual concise and procedural.

Suggested targeted commands:

```bash
pnpm exec vitest run --config vitest.config.ts --project unit packages/agent-vm/src/cli/manual-templates.unit.test.ts
pnpm build
```

## Phase 10 - shravan-claw consumer

Only start this after the `agent-vm` implementation is validated locally.

Consumer repo:

```text
/Users/shravansunder/Documents/dev/project-dev/shravan-claw
```

Tasks:

- [ ] Refresh `shravan-claw` from its current remote state before editing.
- [ ] Update its `@agent-vm/agent-vm` dependency using the agreed local package
  or published version path.
- [ ] Add `host.observability` with explicit `dataDir`, retention, and disk
  caps.
- [ ] Add `zones[].observability` for `sunfam`.
- [ ] Keep authored OpenClaw config small if `agent-vm` generates effective
  diagnostics config.
- [ ] Update scripts so build/prep starts the observability stack and waits for
  readiness.
- [ ] Keep controller startup fast.

Smoke expectations:

- `pnpm build` prepares images and observability stack.
- `pnpm start` does not start Docker and does not wait on slow Compose startup.
- VictoriaMetrics contains OpenClaw metrics.
- VictoriaLogs contains OpenClaw logs.
- VictoriaTraces contains OpenClaw traces.
- Data directories remain after stopping containers.
- Smoke data inspection finds operational metadata but no raw prompt text,
  response text, tool input/output payloads, auth headers, token values, or
  credentialed URLs.
- Smoke uses sentinel canaries for fake tokens, headers, prompts, tool payloads,
  and credentialed URLs, then fails if any sentinel appears in generated
  artifacts or Victoria storage.

## Verification gates

Targeted iteration:

```bash
git diff --check
pnpm exec vitest run --config vitest.config.ts --project <unit|integration|e2e-host> <changed-test-files>
pnpm typecheck
pnpm lint
pnpm fmt:check
mise run lint
```

Full repo gate before claiming done:

```bash
pnpm check
pnpm test:unit
pnpm test:integration
pnpm test:e2e:host
pnpm test:e2e:inventory
mise exec -- pnpm test:e2e:openclaw
```

`pnpm check` is necessary but not sufficient; it does not run the behavioral
unit/integration/e2e test layers.

Black-box local smoke:

```bash
tmpdir="$(mktemp -d)"
# create or copy a minimal deployment config into "$tmpdir"
# run the built CLI exactly as a user would
agent-vm build --config "$tmpdir/config/system.jsonc"
# inspect host loopback collector and Victoria health/status endpoints
```

Live OpenClaw/Victoria smoke, when environment permits:

```bash
agent-vm controller start --config <deployment-config> --zone <zone>
# trigger a small OpenClaw action
# inject fake canary token/header/prompt/tool-payload/credentialed-URL strings
# query metrics/logs/traces from host loopback Victoria endpoints
# fail if any canary appears in generated artifacts or Victoria storage
```

Report command exit codes and pass/fail counts. If unrelated infrastructure
fails, stop code edits and report the scoped pass/fail status rather than
changing tooling.

## Execution notes

- Keep edits scoped. This is not a general resource-system rewrite.
- Do not thread Worker task external resources into host observability.
- Prefer small modules with explicit responsibilities:
  - config normalization
  - compose rendering
  - collector config rendering
  - lifecycle adapter
  - status/readiness checker
  - Gateway tcpHosts mapper
  - OpenClaw effective diagnostics merger
- Use structured parsers/renderers for YAML/JSON if the repo already provides
  them; otherwise keep generated YAML deterministic and tested by snapshots or
  direct object assertions.
- No command should delete telemetry data by default.
- No secret material belongs in generated Compose files, collector config, or
  Docker image state.
- No telemetry path may rely on downstream scrubbing as the primary safety
  control. Scrubbing exists because mistakes happen; source-side non-emission is
  the invariant.
- Any field that might contain credentials, auth material, prompts, responses,
  transcript text, tool payloads, or secret environment values must be dropped,
  redacted, hashed, or omitted before it reaches Victoria storage.

## Open questions

Resolve these before implementation:

1. First shravan-claw retention/disk budget:
   - metrics period
   - logs period and max disk
  - traces period and one max disk cap, either bytes or percent
2. Should a future `destroy-data` command exist at all, or should data deletion
   remain manual outside `agent-vm`?
