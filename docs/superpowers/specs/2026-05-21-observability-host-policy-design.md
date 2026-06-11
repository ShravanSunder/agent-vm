# Observability Host Policy Design

Date: 2026-06-09
Status: implemented in branch; pending review and merge decision
Branch: `feat/observability-host-policy`
Validated base: `origin/master` at `c40e3a7b`

## Problem

`agent-vm` should make local OpenClaw debugging observable without making
controller startup depend on Docker.

The controller should own the contract for a local Victoria-backed
observability stack and should connect OpenClaw to that stack when it is ready.
Slow Docker work belongs in the configured build/prepare lifecycle. During
`controller start`, the controller may do fast readiness checks, generate the
effective OpenClaw telemetry config, and map host endpoints into the Gateway VM,
but it must not pull images, start Compose, or wait on slow container startup.
The same rule applies to every controller-owned OpenClaw gateway start path:
initial controller start, operator restart, cold start, upgrade-triggered
restart, and auto-recovery.

## Design goals

1. Keep controller startup fast. No Docker pull/up/health loop runs in the
   startup critical path.
2. Give operators one durable local telemetry sink for OpenClaw metrics, traces,
   and logs.
3. Make storage explicit and inspectable. Victoria data must live in bind-mounted
   host directories, not anonymous Docker state.
4. Keep retention and disk caps explicit so high-volume debug logging does not
   grow without a bound.
5. Never emit secrets or sensitive content into telemetry. Backend filtering is
   defense-in-depth only, not the primary safety mechanism.
6. Prefer a good local developer workflow: config declares whether host
   observability is part of this deployment; plain `agent-vm build` prepares it
   when enabled; `--no-observability` is a one-run escape hatch.
7. Keep the first implementation focused on OpenClaw Gateway telemetry. Worker
   task resource plumbing remains separate.

## Controller telemetry boundary

This branch wires OpenClaw Gateway logs, metrics, and traces to a host-owned
OpenTelemetry Collector and Victoria backends. Native `agent-vm` controller
instrumentation is intentionally not hidden inside this change.

When controller logs/metrics/traces are added, they should use a small
controller telemetry facade. Controller application logs should go through
Pino behind that facade, while OpenTelemetry remains the trace, metric, and
export protocol boundary. Do not make controller application code call the
OpenTelemetry JavaScript Logs API directly while that surface is still young.
Use manual allowlisted instrumentation first:

- `@opentelemetry/api`
- `@opentelemetry/sdk-node`
- `@opentelemetry/resources`
- `@opentelemetry/semantic-conventions`
- `@opentelemetry/sdk-metrics`
- `@opentelemetry/exporter-trace-otlp-proto`
- `@opentelemetry/exporter-metrics-otlp-proto`
- `pino` for structured controller application logs, with redaction paths and a
  typed safe-field contract.
- `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, Pino OpenTelemetry
  instrumentation, and `@opentelemetry/exporter-logs-otlp-proto` only behind the
  facade if controller log export is added.

Do not start with broad auto-instrumentation. Controller telemetry should emit
route names, operation names, gateway type, zone id, status class, result kind,
durations, retry counts, and coarse error categories. It must not emit request
or response bodies, headers, cookies, auth values, raw URLs with queries,
session keys, commands, prompts, tool payloads, workspace paths, or raw error
stacks. Collector and Victoria scrubbers remain defense-in-depth only.

## Non-goals

- Do not reuse Worker task `externalResources` as the durable host
  observability service model.
- Do not publish repo-resource Compose services with host ports.
- Do not start or block on Docker from `agent-vm controller start`.
- Do not add Grafana, alerting, dashboards, or cloud VictoriaMetrics support in
  v1.
- Do not emit prompt, response, tool input, tool output, or system prompt
  content unless a future explicit content-capture policy is approved.
- Do not rely on VictoriaLogs, VictoriaMetrics, or VictoriaTraces to discover
  and scrub arbitrary secrets after they have already been emitted.

## Original repo evidence before this branch

- `packages/agent-vm/src/config/system-config.ts` currently has `host` fields
  for controller port, project namespace, secrets provider, and GitHub token. It
  has no `host.observability` or `host.logging` surface.
- `packages/agent-vm/src/config/system-config.ts` currently has zone fields for
  gateway, secrets, egress, websocket bypass, tool VM profiles, and
  `resources`. It has no zone-level observability config.
- `packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.ts`
  defines `externalResourcesSchema` for Worker task resource input.
- `docs/reference/configuration/resource-contracts.md` describes external
  resources as Worker task input and repo-local Compose as per-task, no
  host-published ports.
- `packages/agent-vm/src/cli/commands/controller-definition.ts` already fails
  fast when the Gateway image is not cached and tells the operator to run
  `agent-vm build`. This is the right precedent for keeping slow prep out of
  `controller start`.
- `packages/agent-vm/src/cli/build-command.ts` is the existing home for
  expensive host-side preparation.
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts` writes an effective
  OpenClaw config and already injects the runtime `gondolin` plugin config.
  This is the right boundary for OpenClaw diagnostics config injection.
- `packages/openclaw-gateway/src/openclaw-lifecycle.ts` builds Gateway VM
  `tcpHosts` for the controller, Tool VM SSH slots, and websocket bypass hosts.
  This is the right boundary for synthetic DNS entries that point to the local
  observability stack.

## External references

Research pass on 2026-06-09 used Tavily and Perplexity against official
VictoriaMetrics and OpenTelemetry documentation. The source docs, not the tool
summaries, are the contract:

- VictoriaMetrics accepts OTLP/HTTP metrics at
  `/opentelemetry/v1/metrics`.
  <https://docs.victoriametrics.com/victoriametrics/integrations/opentelemetry/>
- VictoriaLogs accepts OTLP/HTTP logs at
  `/insert/opentelemetry/v1/logs`.
  <https://docs.victoriametrics.com/victorialogs/data-ingestion/opentelemetry/>
- VictoriaTraces accepts OTLP/HTTP traces at
  `/insert/opentelemetry/v1/traces`.
  <https://docs.victoriametrics.com/victoriatraces/data-ingestion/opentelemetry/>
- VictoriaMetrics retention uses `-retentionPeriod`; storage lives under
  `-storageDataPath`.
  <https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#retention>
- VictoriaLogs and VictoriaTraces support `-retentionPeriod`,
  `-storageDataPath`, and disk-space retention flags such as
  `-retention.maxDiskSpaceUsageBytes` or `-retention.maxDiskUsagePercent`.
  Those two disk caps are mutually exclusive for VictoriaLogs/VictoriaTraces.
  <https://docs.victoriametrics.com/victorialogs/>
  <https://docs.victoriametrics.com/victoriatraces/>
- The VictoriaMetrics OpenTelemetry guide documents an OpenTelemetry Collector
  receiving OTLP on `4317`/`4318` and forwarding to Victoria endpoints.
  <https://docs.victoriametrics.com/guides/getting-started-with-opentelemetry/>
- VictoriaLogs supports dropping known fields at ingest via `ignore_fields` /
  `VL-Ignore-Fields`, and hiding selected fields at query time with
  `hidden_fields_filters`. These are defense-in-depth controls for known fields,
  not arbitrary secret scanners.
  <https://docs.victoriametrics.com/victorialogs/data-ingestion/>
  <https://docs.victoriametrics.com/victorialogs/querying/#hidden-fields>
- VictoriaLogs has deletion APIs for rare exceptional cases such as accidental
  sensitive-data ingestion, but deletion rewrites stored logs and should not be
  part of the normal safety model.
  <https://docs.victoriametrics.com/victorialogs/#how-to-delete-logs>

OpenClaw local checkout evidence:

- `docs/gateway/opentelemetry.md` documents the `diagnostics-otel` plugin,
  `diagnostics.enabled`, `diagnostics.otel.enabled`, `endpoint`,
  `tracesEndpoint`, `metricsEndpoint`, `logsEndpoint`, `serviceName`,
  `sampleRate`, `flushIntervalMs`, and `captureContent`.
- `extensions/diagnostics-otel/src/service.ts` appends `/v1/traces`,
  `/v1/metrics`, and `/v1/logs` to a shared endpoint unless a signal-specific
  endpoint is configured.
- `extensions/diagnostics-otel/src/service.ts` currently enables OTLP logs only
  when `diagnostics.otel.logs === true`.
- `docs/gateway/logging.md` says file logs are controlled by `logging.level`;
  `--verbose` only affects console verbosity.
- `docs/gateway/logging.md` documents OpenClaw redaction across console,
  file-log, OTLP log-record, and transcript sinks.

## System model

```text
slow path, config-driven host preparation

  agent-vm build
        |
        v
  generated compose + generated otelcol config
        |
        v
  bind-mounted host dataDir
        |
        +--> victoria-metrics :8428
        +--> victoria-logs    :9428
        +--> victoria-traces  :10428
        +--> otel-collector   :4318, :4317, health :13133

fast path, controller start

  agent-vm controller start
        |
        +--> fast readiness/status check only
        +--> Gateway VM tcpHosts synthetic DNS
        +--> effective OpenClaw config
        |
        v
  OpenClaw diagnostics-otel --> otel-collector.observability.vm.host:4318
        |
        v
  collector routes signals to Victoria backends
```

## Preferred backend topology

Use an OpenTelemetry Collector container as the v1 Gateway-facing endpoint.

Benefits:

- OpenClaw can use one shared endpoint:
  `http://otel-collector.observability.vm.host:4318`.
- The collector can fan out metrics, logs, and traces to the Victoria-specific
  signal endpoints.
- The collector gives one readiness point for the Gateway connection.
- Future processors can handle batching, filtering, resource attributes,
  sampling, and delta-to-cumulative metric conversion without changing
  OpenClaw config.

Cost:

- One more container and one generated collector config file.

Direct-to-Victoria is deferred. If it is added later, the controller must write
OpenClaw signal-specific endpoints because a shared OpenClaw endpoint would
append `/v1/<signal>`, while VictoriaLogs and VictoriaTraces require
`/insert/opentelemetry/v1/<signal>`.

## Secret and sensitive data policy

This design is fail-closed for secrets:

1. Source-side invariant: `agent-vm`, OpenClaw, and the generated collector
   config must be designed so secrets and sensitive content are never emitted in
   telemetry in the first place.
2. Disallowed telemetry content includes raw tokens, API keys, auth headers,
   cookies, passwords, SSH keys, secret environment values, 1Password refs with
   resolved values, full credentialed URLs, prompt text, model response text,
   tool inputs, tool outputs, transcript payloads, and assembled system prompts.
3. Allowed telemetry should use bounded operational fields: component names,
   event kinds, status codes, durations, counters, hashed or truncated stable
   identifiers, and coarse error categories.
4. OpenClaw content capture stays off. `captureContent.enabled` must be false in
   generated config. v1 should reject any generated config path that would enable
   prompt, response, tool, transcript, or system-prompt capture.
5. Generated config must not disable OpenClaw redaction. If an authored
   OpenClaw config sets `logging.redactSensitive: "off"`, the controller fails
   config validation for observability-enabled zones.
6. The collector and VictoriaLogs get secondary scrubbers for known fields only.
   They are there to catch accidents, not to make unsafe source logs acceptable.

Collector mode should include an explicit sanitization stage before exporting to
Victoria backends:

- Drop known sensitive resource/log/span attributes such as `authorization`,
  `cookie`, `set-cookie`, `x-api-key`, `api_key`, `token`, `password`,
  `secret`, `access_token`, `refresh_token`, `id_token`, `private_key`,
  `client_secret`, and credentialed URL fields.
- Redact, hash, or truncate identifiers where full values are not needed for
  debugging.
- Keep raw body/message/payload fields out of logs unless a future explicit
  content-capture design is approved.

VictoriaLogs should receive known-field protections too:

- Configure ingest-side `ignore_fields` / `VL-Ignore-Fields` for known sensitive
  field names and prefixes wherever the ingestion path supports it.
- Configure query-side `hidden_fields_filters` for sensitive fields when a
  VictoriaLogs access proxy or query wrapper is introduced.
- Use query-time masking pipes only for display safety. They do not remove the
  original stored value, so they cannot be the primary safety control.
- Treat VictoriaLogs deletion APIs as incident response for accidental ingestion,
  not as a normal data lifecycle.

## Configuration model

Add a host-owned service plane:

```jsonc
{
  "host": {
    "observability": {
      "enabled": true,
      "stack": "victoria",
      "runner": "docker-compose",
      "mode": "collector",
      "prepareOnBuild": true,
      "waitOnBuild": true,
      "dataDir": "/Users/shravansunder/.agent-vm/observability/sunfam",
      "projectName": "agent-vm-observability-sunfam",
      "bindAddress": "127.0.0.1",
      "startupCheckTimeoutMs": 500,
      "ports": {
        "collectorGrpc": 4317,
        "collectorHttp": 4318,
        "collectorHealth": 13133,
        "metrics": 8428,
        "logs": 9428,
        "traces": 10428
      },
      "controllerStartPolicy": "degraded",
      "retention": {
        "metrics": {
          "period": "30d",
          "minFreeDiskSpaceBytes": "5GiB"
        },
        "logs": {
          "period": "14d",
          "maxDiskSpaceUsageBytes": "50GiB"
        },
        "traces": {
          "period": "7d",
          "maxDiskUsagePercent": 80
        }
      }
    }
  }
}
```

`dataDir` should be required when observability is enabled. It must not default
to `cacheDir`. A future implementation may add a safe convenience default, but
v1 should force the operator to choose a durable, inspectable disk location.
Validation should run after normal config path resolution and reject `dataDir`
when it is inside `cacheDir`, `runtimeDir`, any zone `stateDir`, any OpenClaw
`zoneFilesDir`, or other known cleanup/destructive-command roots.

`bindAddress` is loopback-only in v1. Accept `127.0.0.1` and, if IPv6 loopback
is implemented, `::1`; reject `0.0.0.0`, `::`, and host LAN addresses. The
Gateway VM reaches the stack through explicit `tcpHosts`, so the host services
do not need LAN exposure.

`stack` is `victoria` in v1. `runner` is `docker-compose` in v1. `mode` is
`collector` in v1. The schema may reserve these fields so the config shape can
later grow, but v1 should reject unsupported values clearly.

`prepareOnBuild` defaults to true when `host.observability.enabled` is true.
`waitOnBuild` defaults to true for the local developer deployment path so a
normal build leaves the configured observability stack ready, not merely
started.

`controllerStartPolicy` values:

- `degraded`: default. Controller performs a fast status check and starts even if
  the observability stack is unavailable. Current branch behavior reports
  ready/degraded in controller startup logs; explicit health/status API fields
  are deferred to a follow-up contract change.
- `require-ready`: controller performs a fast status check and fails if the
  configured endpoint is unavailable. It still does not start Docker or wait on
  Compose.
- `off`: controller does not check readiness. It still writes config if
  observability is enabled.

Controller-owned gateway start checks must be bounded HTTP probes against the
collector health endpoint. They must not shell out to `docker`,
`docker compose`, or any container runtime CLI. The default timeout budget is
500 ms.

Add a zone-owned opt-in plane only for Gateway telemetry policy:

```jsonc
{
  "zones": [
    {
      "id": "sunfam",
      "observability": {
        "enabled": true,
        "openclaw": {
          "serviceName": "agent-vm-openclaw-sunfam",
          "traces": true,
          "metrics": true,
          "logs": true,
          "sampleRate": 1,
          "flushIntervalMs": 10000,
          "captureContent": {
            "enabled": false
          },
          "diagnosticsFlags": []
        }
      }
    }
  ]
}
```

If `host.observability.enabled` is false, any zone observability opt-in is a
config error.

If a zone gateway type is not `openclaw`, v1 should reject
`zones[].observability.enabled: true` with a clear message.

## Generated host artifacts

The controller package should generate these files under a deterministic
observability work directory. Generated config files may live under cache/runtime,
but telemetry data must live under `host.observability.dataDir`.

```text
<runtimeDir>/observability/<projectNamespace>/
  docker-compose.observability.yml
  otel-collector-config.yaml

<host.observability.dataDir>/
  metrics/
  logs/
  traces/
```

The Compose file bind-mounts:

- `${dataDir}/metrics` to the VictoriaMetrics `-storageDataPath`.
- `${dataDir}/logs` to the VictoriaLogs `-storageDataPath`.
- `${dataDir}/traces` to the VictoriaTraces `-storageDataPath`.
- generated collector config into the collector container read-only.

Generated Compose services use `restart: unless-stopped` so Docker can restore
prepared collector and Victoria services after daemon or host recovery without
moving Docker startup into `agent-vm controller start`.

Normal lifecycle commands must not remove `dataDir`. There should be no default
command equivalent to `docker compose down -v`.

## Build lifecycle

`agent-vm build` runs the observability preparation path after the existing image
preparation succeeds when `host.observability.enabled` is true and at least one
supported zone opts into observability. This gives the deployment a single "make
everything expensive ready" command without putting Docker in `controller start`.

`agent-vm build --no-observability` skips only observability preparation for
that run and does not mutate config. There should be no
`--with-observability` requirement for the normal configured path.

`agent-vm controller start` must not call `docker compose up`.

Explicit `agent-vm observability render|up|status|down` commands remain a
follow-up CLI convenience, not part of this build-first implementation slice.
When added, they must reuse the same artifact renderer/readiness logic and must
not remove `dataDir` by default.

## Gateway connection

When host observability and zone observability are enabled, the OpenClaw Gateway
VM gets synthetic DNS entries for collector mode:

Collector mode:

```text
otel-collector.observability.vm.host:4318 -> 127.0.0.1:<collectorHttp>
otel-collector.observability.vm.host:4317 -> 127.0.0.1:<collectorGrpc>
```

These entries should be compiled by an observability-specific mapper, not by
pretending they are Worker task external resources.

In v1, OpenClaw observability requires the selected gateway image profile to use
the managed `openclaw-gateway` base so the build path owns installation of
`@openclaw/diagnostics-otel`. Custom OpenClaw image profiles should fail config
validation until they have a separately designed plugin proof.

## Effective OpenClaw config

The controller writes the effective OpenClaw config with:

```jsonc
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": { "enabled": true }
    }
  },
  "diagnostics": {
    "enabled": true,
    "flags": [],
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector.observability.vm.host:4318",
      "protocol": "http/protobuf",
      "serviceName": "agent-vm-openclaw-sunfam",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 1,
      "flushIntervalMs": 10000,
      "captureContent": {
        "enabled": false
      }
    }
  }
}
```

The controller should reject direct mode before effective config generation in
v1. Future direct mode support would omit the shared `endpoint` and write
`metricsEndpoint`, `logsEndpoint`, and `tracesEndpoint` with the
Victoria-specific paths.

For observability-enabled zones, host/zone observability policy owns the
`diagnostics-otel` plugin entry and the `diagnostics.otel` signal/exporter keys.
The merger preserves unrelated authored OpenClaw config, but authored telemetry
values cannot disable required exporter safety, content-capture, or redaction
settings.

`logging.level` remains the file-log volume control. Debug or trace collection
must set `logging.level` to `debug` or `trace`; `--verbose` is not sufficient for
OpenClaw file logs or OTLP log export.

## Debug/logging policy

Native controller logging and controller OpenTelemetry instrumentation are
deferred. A future controller logging design should add a `ControllerTelemetry`
facade and `host.logging` separately from `host.observability`:

```text
controller code
  -> ControllerTelemetry
       -> Pino safe structured logger
       -> manual OpenTelemetry spans and metrics
       -> optional OTLP log bridge behind the facade
```

```jsonc
{
  "host": {
    "logging": {
      "level": "info",
      "openclaw": "inherit",
      "gondolin": "default"
    }
  }
}
```

Future CLI and env overrides should be limited and explicit:

```text
agent-vm controller start --log-level debug
agent-vm controller start --debug
AGENT_VM_LOG_LEVEL=trace
```

`--debug` should be an alias for `--log-level debug`; it must not imply content
capture. Content capture remains off.

OpenClaw diagnostics flags must be explicitly allowlisted for
observability-enabled zones. Reject wildcard/all forms such as
`OPENCLAW_DIAGNOSTICS=*`, `OPENCLAW_DIAGNOSTICS=all`, and
`OPENCLAW_DIAGNOSTICS=1`; reject payload, body, content, query, or transcript
flags unless a future content-capture design approves them. Redaction remains
required, but the source-side invariant is that sensitive content is not emitted
in the first place.

## Readiness and status

Readiness waits are allowed only in explicit slow-path commands:

- `agent-vm build` when config enables observability and `waitOnBuild` is true

Controller-owned gateway start checks should be fast:

- Check the collector health endpoint with a short timeout.
- Report status as `ready`, `not-ready`, or `not-configured`.
- Never start Docker from controller startup, restart, cold start, upgrade, or
  auto-recovery.
- Never call Docker CLI from those startup paths.

## shravan-claw consumer shape

Consumer work should happen after the `agent-vm` branch design is agreed and the
implementation exists.

Current local consumer path:

```text
/Users/shravansunder/Documents/dev/project-dev/shravan-claw
```

Expected consumer changes:

- Update `@agent-vm/agent-vm` after the local package or branch build exists.
- Add `host.observability` with explicit `dataDir`, retention, and disk caps.
- Add zone observability opt-in for `sunfam`.
- Keep `config/gateways/sunfam/openclaw.json` authored defaults small; let
  `agent-vm` generate effective diagnostics config when possible.
- Use `pnpm build` or an equivalent script to run plain `agent-vm build`; the
  enabled host observability config prepares the stack by default.
- Use `pnpm start` for controller startup without Docker waits.

## Open questions before implementation

1. What exact default retention and disk budget should shravan-claw use for the
   first real debug run?
2. Should a future `destroy-data` command exist at all, or should data deletion
   remain a manual operator action outside `agent-vm`?
