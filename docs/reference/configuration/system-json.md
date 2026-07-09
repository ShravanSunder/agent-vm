# system.jsonc

`system.jsonc` is the controller's top-level human-authored config file.
Relative paths are resolved relative to the directory containing the system
config. `system.json` is still accepted for existing deployments, but new
scaffolds generate `system.jsonc`.

Comments are allowed in authored config. Runtime files that the controller
writes, including effective worker config, runtime records, API bodies, and
task event logs, remain strict JSON/JSONL.

New scaffolds write deployment-local JSON Schema files under `config/schemas/`:

- `system.schema.json`
- `mcp.schema.json`
- `mcp-portal.schema.json`

The `$schema` fields in authored JSONC files point at those local files for
editor tooling. Runtime compatibility is controlled by `schemaVersion`, not by
fetching schema URLs.

Source schema:
`packages/agent-vm/src/config/system-config.ts`

## Sections

```
host
  controllerPort
  projectNamespace
  secretsProvider
  githubToken
  observability

controller
	  health
	    enabled
	    gatewayServiceIntervalMs
	    staleAfterMs
	    eventHistoryLimit

cacheDir

runtimeDir

imageProfiles
  gateways
  toolVms

zones[]
  id
  agents
  gateway
    ingress
  observability
  resources
  secrets
  runtimeAuthHints
  egressHosts
  websocketUpgrades
  toolPortal
  defaultToolVmProfile
  agentToolVmProfiles
  agentSandboxSeeds

toolVmProfiles

tcpPool

leaseIdleTtl
```

## host

| Field | Required | Meaning |
| --- | --- | --- |
| `controllerPort` | yes | TCP port for the controller HTTP API. |
| `projectNamespace` | yes | Lowercase namespace used for runtime labels and cache separation. |
| `secretsProvider` | when using `source: "1password"` | How the host resolves 1Password-backed secrets. |
| `githubToken` | no | Host-only token for clone and push. Never enters the VM. |
| `observability` | no | Host-owned Victoria/OpenTelemetry stack used by opted-in OpenClaw zones. |

`githubToken` uses the same secret source shape as zone secrets:
`{ "source": "environment", "envVar": "..." }`,
`{ "source": "1password", "ref": "..." }`, or
`{ "source": "config", "value": "..." }`. `source: "config"` embeds a
host-side write token directly in `system.jsonc`; use it only for local or
intentionally checked-in test deployments.

`secretsProvider.tokenSource` may be:

| Type | Meaning |
| --- | --- |
| `env` | Read 1Password service account token from an env var. Defaults to `OP_SERVICE_ACCOUNT_TOKEN`. |
| `keychain` | Read the service account token from macOS Keychain. |

For `keychain`, `service` and `account` are the macOS Keychain lookup target.
New local scaffolds use service `agent-vm`. The default account is
`1p-service-account`; `agent-vm init --onepassword-keychain-account-name <name>`
uses `1p-service-account--<name>` for controller isolation. Store or rotate the
token with `agent-vm auth 1password <op-ref-or-url> --config config/system.jsonc`.
When the ref/url is omitted, the command prompts for a token paste and still
stores it in the configured Keychain target.

For 1Password-backed configs, `agent-vm doctor` also runs a headless fallback
probe with the resolved service-account token: `op whoami` under an isolated
`OP_CONFIG_DIR`, `OP_BIOMETRIC_UNLOCK_ENABLED=false`, and `OP_CACHE=false`.
The probe verifies that the CLI reports `SERVICE_ACCOUNT` without using ambient
desktop/session auth and does not resolve deployment secret refs.

## host.observability

`host.observability` configures host participation in OpenTelemetry collection.
Omit it or set `{ "enabled": false }` to keep the old no-observability runtime
behavior. `agent-vm doctor` reports that state and recommends enabling
observability with a managed local stack unless the deployment intentionally
uses an external shared collector.

When enabled, `stack.mode` decides stack ownership:

- `managed`: this deployment owns a local VictoriaMetrics, VictoriaLogs,
  VictoriaTraces, and OpenTelemetry Collector stack prepared by `agent-vm build`.
- `external`: this deployment connects to an already-managed/shared
  OpenTelemetry Collector and never renders or starts Docker Compose. External
  stacks must explicitly state that the shared collector owns equivalent
  telemetry scrubbing with
  `stack.scrubbing.responsibility: "external-collector"`.

Per-zone OpenClaw observability is supported during the Socket.IO control-plane
hard cutover through Gondolin HTTP mediation. The old collector path depended on
raw Gondolin `tcpHosts` and must not be restored. Enabled OpenClaw zones send
OTLP HTTP/protobuf to a synthetic collector host that the controller rewrites to
the configured loopback collector port. Tool VM SSH remains the only raw TCP
exception in the managed gateway VM spec.

The controller does not start Docker Compose during controller startup. Docker
startup belongs to `agent-vm build` when `prepareOnBuild` is true. A one-off
build can skip stack preparation with `agent-vm build --no-observability`.

Example:

```jsonc
{
  "host": {
    "observability": {
      "enabled": true,
      "stack": {
        "mode": "managed",
        "scrubbing": { "responsibility": "agent-vm-managed-collector" }
      },
      "runner": "docker-compose",
      "mode": "collector",
      "dataDir": "../observability-data",
      "bindAddress": "127.0.0.1",
      "prepareOnBuild": true,
      "waitOnBuild": true,
      "controllerStartPolicy": "degraded",
      "startupCheckTimeoutMs": 30000,
      "retention": {
        "metrics": { "period": "30d", "minFreeDiskSpaceBytes": "5GiB" },
        "logs": { "period": "14d", "maxDiskSpaceUsageBytes": "50GiB" },
        "traces": {
          "period": "7d",
          "maxDiskUsagePercent": 80
        }
      }
    }
  }
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | required | `true` enables host observability participation; `false` disables it. |
| `stack.mode` | `managed` | `managed` owns the local Victoria + Collector Compose stack; `external` connects to a shared collector and never starts Compose. |
| `stack.scrubbing.responsibility` | `agent-vm-managed-collector` for managed; required `external-collector` for external | Declares which collector owns defense-in-depth sensitive-field dropping. Source code must still avoid emitting secrets in the first place. |
| `runner` | `docker-compose` | Managed-stack host runner used by `agent-vm build` to start the stack. Managed only. |
| `mode` | `collector` | OpenTelemetry Collector receives OTLP and exports to Victoria. |
| `dataDir` | required for `managed` | Durable host directory for Victoria data. Must not overlap cacheDir, runtimeDir, stateDir, or zoneFilesDir. Omit for `external`. |
| `projectName` | `agent-vm-observability-<projectNamespace>` | Managed-stack Docker Compose project name. Must use lowercase letters, numbers, hyphens, and underscores, and start with a letter or number. Managed only. |
| `bindAddress` | `127.0.0.1` | Host bind address for collector and Victoria ports. Only loopback addresses are accepted. |
| `prepareOnBuild` | `true` | Lets `agent-vm build` render artifacts and run Docker Compose for `managed` when an opted-in zone is selected. `external` reports that the stack is externally managed. |
| `waitOnBuild` | `true` | Makes managed build wait for collector, metrics, logs, and traces readiness after Compose startup. |
| `controllerStartPolicy` | `degraded` | `degraded` starts the controller when readiness is unavailable; `require-ready` fails after the bounded readiness budget; `off` skips startup checks. No policy starts Docker. |
| `startupCheckTimeoutMs` | `30000` | Total bounded readiness budget for one startup pass. The collector check uses the health endpoint first and falls back to OTLP HTTP receiver reachability; Victoria services use health endpoints. |
| `ports.collectorGrpc` | `4317` | Host OTLP gRPC collector port. All observability ports must be unique values from 1 through 65535. |
| `ports.collectorHttp` | `4318` | Host OTLP HTTP collector port used by OpenClaw diagnostics. |
| `ports.collectorHealth` | `13133` | Host collector health-check port. |
| `ports.metrics` | `8428` | Host VictoriaMetrics port. |
| `ports.logs` | `9428` | Host VictoriaLogs port. |
| `ports.traces` | `10428` | Host VictoriaTraces port. |
| `retention.metrics` | required for `managed` | Metrics retention period plus optional minimum free disk space. Period values use Victoria duration strings such as `30d`; byte values use explicit units such as `5GiB`. |
| `retention.logs` | required for `managed` | Logs retention period plus optional max disk usage. |
| `retention.traces` | required for `managed` | Traces retention period plus one optional disk cap. Use either `maxDiskSpaceUsageBytes` or `maxDiskUsagePercent`, not both. |

External shared collector example:

```jsonc
{
  "host": {
    "observability": {
      "enabled": true,
      "stack": {
        "mode": "external",
        "scrubbing": { "responsibility": "external-collector" }
      },
      "mode": "collector",
      "bindAddress": "127.0.0.1",
      "controllerStartPolicy": "degraded",
      "startupCheckTimeoutMs": 30000
    }
  }
}
```

For `external`, make the shared collector available on the configured loopback
collector ports and configure that collector to drop or hash the same sensitive
telemetry attributes before storage/export. `agent-vm build` does not render
Compose or create Victoria storage directories for external stacks.

For `managed`, `agent-vm build` writes:

```text
<runtimeDir>/observability/<projectNamespace>/docker-compose.observability.yml
<runtimeDir>/observability/<projectNamespace>/otel-collector-config.yaml
<host.observability.dataDir>/metrics
<host.observability.dataDir>/logs
<host.observability.dataDir>/traces
```

Generated Compose files bind all published ports to loopback, set
`restart: unless-stopped`, and mount the Victoria data directories from
`host.observability.dataDir`. The generated
collector config uses gzip OTLP export to Victoria and drops known sensitive
attributes before export. This managed scrubber is defense-in-depth only:
application and controller code must still avoid logging secrets, prompts,
message bodies, tool payloads, cookies, authorization headers, token values,
private keys, raw URLs with query strings, command content, and other sensitive
data. External collectors must provide equivalent sanitization before storing
or forwarding agent-vm telemetry.

## controller.health

`controller.health` tunes agent-vm controller health collection. Omit it for
the defaults.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enables periodic health monitors. Health routes remain available when disabled. |
| `gatewayServiceIntervalMs` | `10000` | Host-side interval for the agent-vm controller to probe each running gateway-service through the gateway VM service liveness check. |
| `gatewayServiceAutoRestart.enabled` | `true` | Enables automatic restart for a running OpenClaw gateway VM after repeated gateway-service or gateway control-session health failures. |
| `gatewayServiceAutoRestart.consecutiveFailureThreshold` | `10` | Consecutive degraded observations required before restart. A healthy observation resets that boundary's counter. |
| `gatewayServiceAutoRestart.cooldownMs` | `3660000` | Minimum time between automatic restart attempts for one zone. This is 61 minutes by default. |
| `gatewayServiceAutoRestart.maxConsecutiveFailedRecoveries` | `3` | Failed automatic restart attempts allowed before the controller suspends further auto-recovery for that zone. |
| `gatewayServiceAutoRestart.failedRecoveryResetMs` | `86400000` | Suspension reset window after the latest failed recovery attempt. This is 24 hours by default. |
| `gatewayServiceAutoRestart.restartTimeoutMs` | `600000` | Maximum time the controller waits for one automatic restart before recording failed `gateway-recovery`. |
| `gatewayServiceAutoRestart.channelProviderHealth.enabled` | `true` | Enables generic agent channel-provider health as recovery input when the gateway/plugin publishes `agent-channel-provider-health` events. |
| `gatewayServiceAutoRestart.channelProviderHealth.consecutiveFailureThreshold` | `3` | Consecutive generic channel-provider failures required before channel-provider health can select recovery. |
| `gatewayServiceAutoRestart.channelProviderHealth.transitioningTimeoutMs` | `120000` | Maximum time a `transitioning` channel provider can remain in transition before policy treats it as unhealthy. |
| `gatewayServiceAutoRestart.channelProviderHealth.restartGatewayOnRecoverable` | `false` | Keeps `unhealthy-recoverable` channel-provider events as readiness/status degradation by default. Set to `true` only when gateway restart is an intentional recovery action for that provider class. |
| `gatewayServiceAutoRestart.channelProviderHealth.restartGatewayOnUnrecoverable` | `false` | Prevents `unhealthy-unrecoverable` channel-provider events from restarting the gateway by default. |
| `staleAfterMs` | `30000` | Age after which a latest health event is treated as stale in zone health snapshots. |
| `eventHistoryLimit` | `500` | Rolling in-memory event history retained by the agent-vm controller. Latest per-boundary state is retained separately. |

The health snapshot and bounded event history are in-memory controller state
for live HTTP reads. The controller also appends accepted health and recovery
events to `<runtimeDir>/controller-health/events.jsonl` as diagnostic evidence.
That JSONL log is not authority for ownership or recovery decisions; the
runtime record and current process/port checks remain the authority.

Automatic gateway VM recovery uses the current gateway lifecycle state. Running
or degraded gateways are restarted. Failed or stopped gateways can be
cold-started only when current runtime-record and ingress-port ownership checks
prove that the old gateway owner is absent or safe. When recovery restarts a
running gateway, the controller first force releases that zone's Tool VM leases,
then restarts the gateway VM and records `gateway-recovery` with old/new VM
identity evidence. Secret resolver errors such as `secret-resolution-failed`
are surfaced as current recovery blockers, not as original outage causes unless
durable lifecycle evidence proves the outage began during that operation.

Channel-provider recovery is generic. Gateway implementations may include
redacted provider details in `agent-channel-provider-health` events, but the
controller branches only on `healthy`, `transitioning`,
`unhealthy-recoverable`, and `unhealthy-unrecoverable`. By default,
`unhealthy-recoverable` degrades readiness/status without restarting the gateway
VM; set `restartGatewayOnRecoverable` to `true` to opt in to VM restart after
the channel-provider threshold and cooldown.

Example:

```jsonc
{
  "controller": {
	    "health": {
	      "enabled": true,
	      "gatewayServiceIntervalMs": 10000,
	      "gatewayServiceAutoRestart": {
        "enabled": true,
        "consecutiveFailureThreshold": 10,
        "cooldownMs": 3660000,
        "maxConsecutiveFailedRecoveries": 3,
        "failedRecoveryResetMs": 86400000,
        "restartTimeoutMs": 600000,
        "channelProviderHealth": {
          "enabled": true,
          "consecutiveFailureThreshold": 3,
          "transitioningTimeoutMs": 120000,
          "restartGatewayOnRecoverable": false,
          "restartGatewayOnUnrecoverable": false
        }
      },
      "staleAfterMs": 30000,
      "eventHistoryLimit": 500
    }
  }
}
```

## cacheDir

`cacheDir` stores rebuildable artifacts. It is intentionally outside encrypted
zone backups. Current uses include Gondolin image outputs and per-zone gateway
repair/download caches.

Do not place durable secrets or user state under `cacheDir`. Do not place
rebuildable dependency trees under `stateDir` just to make them survive gateway
VM reboot; mount a cache path or bake stable dependency trees into the image
instead.

`cacheDir` may be local disk or network-backed storage in larger deployments.
Do not put active worker gitdirs here; unpushed commits are not rebuildable
cache.

`agent-vm build` automatically prunes old image-cache generations after every
successful build. For each gateway or Tool VM image profile, it keeps the
current fingerprint plus the two newest previous fingerprint directories. The
retention count is fixed; there is no `system.jsonc` cache retention field.
Failed builds do not prune cache entries. Manual `agent-vm cache clean
--confirm` remains more aggressive and deletes every stale image generation.
When multiple image profiles share the same resolved build config path and
effective Gondolin fingerprint in one build, the first profile performs the
expensive asset build and later profiles materialize profile-local cache entries
from those assets.

For Docker-backed image profiles, the effective Gondolin fingerprint includes
the inspected Docker rootfs layer identity after the Docker build completes.
This lets unchanged Docker outputs reuse cached Gondolin assets without forcing
a rebuild on every `agent-vm build`, while Dockerfile or overlay changes that
alter the image layers still produce a new image generation. Each successful
profile build also writes a profile-local prepared-image record under
`cacheDir`; gateway and Tool VM startup may use that record when the matching
assets still exist.

## runtimeDir

`runtimeDir` stores active, non-backup runtime artifacts that are not durable
zone state and not repairable cache. It should prefer local disk because these
paths can be hot during task execution.

Current uses include OpenClaw gateway logs and worker Git metadata:

```text
<runtimeDir>/zones/<zoneId>/logs/
<runtimeDir>/worker-tasks/<zoneId>/<taskId>/gitdirs/<repoId>.git
```

Normal `backup create` does not copy `runtimeDir`, and validation fails when
`runtimeDir` overlaps `cacheDir`, any zone `stateDir`, or any OpenClaw
`zoneFilesDir`. Worker runtime artifacts are task-lifetime data: the agent must
commit and call `git-push` before task teardown if work must survive. OpenClaw
gateway logs are runtime evidence for post-mortems and performance debugging;
they persist across gateway VM restarts but are intentionally excluded from
normal zone backups.

## zoneFilesDir

`zoneFilesDir` is the long-lived OpenClaw household/user files directory. It is
RealFS-mounted into the OpenClaw gateway VM at `/zone` and
is included in OpenClaw zone backups.

Worker gateways do not use `zoneFilesDir`. Their repo files live in VM-local
`/work/repos/<repoId>`, and their Git metadata lives under system-level
`runtimeDir`.

Do not call this `workspaceDir`. Worker execution files live under VM-local
`/work/repos/<repoId>` and are not backed by this host path.

`workMountDir` is not a `system.json` field. It is selected dynamically by
OpenClaw when a tool lease is requested. Static config defines the allowed
roots: the OpenClaw state sandbox root and `zoneFilesDir`. A lease
`workMountDir` must be a concrete child path under one of those roots; the roots
themselves are validation boundaries and are rejected as mount targets.
For the canonical name/location/storage vocabulary, see
[Lease Path Vocabulary](../../architecture/storage-model.md#lease-path-vocabulary).

```text
Tool VM lease workdir: /workspace
Tool VM rootfs/COW scratch: /work
OpenClaw gateway zone files: /zone
OpenClaw state sandboxes: /home/openclaw/.openclaw/state/sandboxes
```

For the storage boundary model, see
[storage-model.md](../../architecture/storage-model.md).

## OpenClaw Channel Defaults

`agent-vm init --type openclaw` scaffolds framework primitives: Gondolin,
memory-core, VM lifecycle, Tool VM lease plumbing, and runtime auth wiring. It
does not enable Discord or any other channel-specific surface by default.

Channel config is deployment-owned. Enable channels in
`config/gateways/<zone>/openclaw.json`, then declare the matching secrets,
`egressHosts`, and any required `websocketUpgrades` entries in
`config/system.jsonc`.
Managed OpenClaw image profiles install known extracted channel packages, such
as `@openclaw/discord`, from the OpenClaw channel config.

New OpenClaw scaffolds set `approvals.plugin.enabled=true` with
`approvals.plugin.mode="session"` for OpenClaw-owned plugin approval prompts.
Managed Tool Portal capabilities under `calls.requiresApproval` are rejected in
this cutover; use `calls.withoutApproval` for callable managed OpenClaw
capabilities until a Tool Portal approval bridge exists. Exec approval
forwarding and channel-native approver user IDs remain deployment-owned.

## gateway.ingress

`zones[].gateway.ingress` customizes the host-facing Gondolin ingress timeout
behavior for the gateway VM. Omit it for Gondolin defaults.

| Field | Required | Meaning |
| --- | --- | --- |
| `upstreamHeaderTimeoutMs` | no | Timeout while waiting for response headers from the guest gateway process. |
| `upstreamResponseTimeoutMs` | no | Timeout between upstream response body chunks from the guest gateway process. |

agent-vm exposes the OpenClaw gateway through one host-facing Gondolin ingress
listener at `zones[].gateway.port`. The current OpenClaw gateway route maps `/`
to the OpenClaw guest gateway port, so the Control UI, `/healthz`, `/readyz`,
OpenAI-compatible HTTP endpoints, SSE streaming, and WebSocket traffic share the
same route.

OpenClaw startup waits on `/health` service liveness. Explicit zone health
probes use `/readyz`. The controller's periodic gateway-service monitor also
uses `/health` as service liveness so channel or provider readiness degradation
can be reported without automatically treating the gateway VM process as dead.

agent-vm keeps Gondolin response buffering disabled for gateway ingress so
streaming responses can pass through incrementally. Long-running non-streaming
gateway requests, such as direct agent API calls, may need a larger
`upstreamResponseTimeoutMs` than Gondolin's default. Streaming responses are less
sensitive because each emitted chunk resets the response-body idle timer.

These timeout settings do not open additional guest webserver ports. Additional
guest HTTP services require explicit Gondolin ingress routes from non-root path
prefixes to guest ports. Raw TCP services belong in `tcpHosts`, not HTTP
ingress.

## OpenClaw Tool Portal Defaults

Managed OpenClaw gateway images install `@agent-vm/openclaw-agent-vm-plugin`,
which registers the `gondolin` plugin. The `gondolin` plugin owns the managed
Tool Portal native tools:

- `tool_portal_list`
- `tool_portal_search`
- `tool_portal_describe`
- `tool_portal_call`

New OpenClaw scaffolds allow and enable `gondolin` and do not enable a separate
`mcp-portal` plugin. Managed OpenClaw rejects `calls.requiresApproval` during
effective config materialization in this cutover; use `calls.withoutApproval`
for callable managed OpenClaw capabilities until a Tool Portal approval bridge
exists.

When `agents.list` is configured, agent-vm scaffolds sibling MCP config files in
`config/gateways/<zone>/`:

- `mcp.config.jsonc` describes upstream MCP providers and discovery.
- `mcp-portal.config.jsonc` describes agent profile assignments, profile
  policies, and optional external `/mcp-proxy` auth.

Managed OpenClaw does not generate OpenClaw MCP server entries for MCP Portal.
The `gondolin` plugin registers the four Tool Portal native tools directly and
calls Tool Portal in-process with MCP providers as an internal backend.
Operator-authored upstream MCP servers live in `mcp.config.jsonc`; agent-vm
materializes an effective Tool Portal gateway config that turns configured
1Password secrets into runtime environment references or runtime-mediated
bindings before gateway boot.

`zones[].toolPortal.configDir` points at the directory containing those two
authored files. In managed OpenClaw mode, `externalAuth` and `mcpProxy` are
stripped from the gateway effective config; they are only used by the external
`mcp-portal mcp-proxy serve` adapter.

The package-level `tool-portal.config.jsonc` schema exists for cross-backend
capability policy. Managed OpenClaw currently projects the authored
`mcp.config.jsonc` and `mcp-portal.config.jsonc` MCP-provider policy into a
generated Tool Portal effective config; MCP Portal remains the backend policy
owner for upstream MCP providers and standalone `mcp-proxy` use.

Important fields in `mcp-portal.config.jsonc`:

- `agents.<agentId>.profile` selects a profile.
- `agents.<agentId>.credentialVersion` revokes previously printed external
  `/mcp-proxy` bearer credentials for that agent.
- `agents.<agentId>.hmacKey` is for standalone/external MCP Portal approval
  token flows. Managed OpenClaw rejects `calls.requiresApproval` in this
  cutover, so `hmacKey` is not used by the managed Tool Portal projection and is
  stripped before managed gateway config enters the VM.
- `externalAuth.masterKey` is required only for external `/mcp-proxy` bearer
  auth and client-config generation.
- `mcpProxy.server.host`, `mcpProxy.server.port`, and
  `mcpProxy.auth.headerName` configure the loopback Hono MCP proxy.
- `profiles.<name>.namespaces` defines the agent's portal policy per namespace:
  `tools.allow`, `tools.deny`, `calls.withoutApproval`, and
  `calls.requiresApproval`. `tools.allow` is `*` for every discovered tool or an
  explicit list of visible tool names; `tools.deny` removes tools from the
  catalog. Call selectors use the same shape and decide whether a visible tool
  runs directly or requires approval. Managed OpenClaw currently rejects
  `calls.requiresApproval` in the generated effective config, so managed
  callable tools must be listed under `calls.withoutApproval`. Visible tools
  outside both call selectors are blocked at execution time.
  A profile is a complete policy. Profiles do not inherit from or merge with
  other profiles; assign an agent to the profile you want it to use.

Important fields in `mcp.config.jsonc` provider entries:

- `transport.kind` may be `streamable-http`, `sse`, or `stdio`.
- Remote provider `transport.url` must use `http` or `https`.
- `transport.connectionTimeoutMs` optionally overrides the provider connection,
  `tools/list`, and call timeout budget when a real upstream MCP provider is
  slower than the default 12000 ms budget.
- Stdio providers must declare `transport.networkAccess`.
- `transport.networkAccess: "declared"` requires non-empty
  `transport.requiredEgressHosts`.
- Every secret in `transport.env` or `transport.headers` needs a matching
  `secretPolicies.<name>` entry.
- Provider secrets keep their stored value raw by default. Omit `format` for
  API keys such as `TAVILY_API_KEY` that should be passed through unchanged.
- Use `format: { "kind": "bearer" }` when an upstream MCP provider expects
  `Bearer <token>` presentation, such as an `authorization` header. Store only
  the raw token in 1Password or the host environment. The same `format` object
  works on both `source: "1password"` and `source: "environment"` provider
  secret refs.
- Use `format: { "kind": "prefix", "prefix": "Token" }` for provider-specific
  schemes. Agent-vm inserts exactly one ASCII space between the prefix and the
  raw secret, so `prefix: "Bearer:"` becomes `Bearer: <token>`. Prefixes must
  be non-empty and must not contain whitespace.
- `secretPolicies.<name>.injection` is either `env` or `http-mediation`;
  mediated secrets must list allowed `hosts`.
- For stdio MCP API keys, prefer `http-mediation` when the MCP server sends the
  env value in outbound HTTP headers or other Gondolin-supported request
  locations. The effective config rewrites the authored env ref to a generated
  `AGENT_VM_MCP_*` placeholder environment variable, while the raw value stays
  in host-side mediated secret state.

Example provider-secret presentation:

```jsonc
{
  "schemaVersion": 1,
  "providers": {
    "linear": {
      "kind": "mcp",
      "namespace": "linear",
      "transport": {
        "kind": "streamable-http",
        "url": "https://mcp.linear.app/mcp",
        "headers": {
          "authorization": {
            "source": "environment",
            "name": "LINEAR_MCP_TOKEN",
            "format": { "kind": "bearer" }
          }
        }
      },
      "secretPolicies": {
        "authorization": {
          "injection": "http-mediation",
          "hosts": ["mcp.linear.app"]
        }
      }
    },
    "tavily": {
      "kind": "mcp",
      "namespace": "tavily",
      "transport": {
        "kind": "stdio",
        "command": "tavily-mcp",
        "env": {
          "TAVILY_API_KEY": {
            "source": "environment",
            "name": "TAVILY_API_KEY"
          }
        },
        "networkAccess": "declared",
        "requiredEgressHosts": ["api.tavily.com"]
      },
      "secretPolicies": {
        "TAVILY_API_KEY": {
          "injection": "http-mediation",
          "hosts": ["api.tavily.com"]
        }
      }
    }
  }
}
```

Local OpenClaw e2e coverage uses a fake Streamable HTTP MCP provider and the
controller e2e harness `tcpHostsOverride` path to make that host-side provider
reachable from inside the OpenClaw gateway VM. The e2e proof does not require
DeepWiki, Tavily, 1Password, or real upstream MCP credentials; credentialed
upstream providers belong in an explicit deployment e2e outside the default
local suite.

During the Socket.IO control-plane hard cutover,
`agent-vm init --type openclaw --openclaw-agents sun,shravan` scaffolds managed
OpenClaw agents with `/zone/agents/<id>` workspaces. Managed OpenClaw zones may
declare multiple trusted agents in `zones[].agents` when OpenClaw `agents.list`,
Tool Portal/MCP Portal bindings, per-agent auth/profile files, and Tool VM
profile policy stay aligned. The scaffold deliberately does not create channel
bindings or Discord guild allowlists because those are deployment-owned IDs.

OpenClaw `web_fetch` in Gondolin deployments needs fake-IP SSRF policy for
mediated DNS and proxy-style environments:

```json
{
  "tools": {
    "web": {
      "fetch": {
        "ssrfPolicy": {
          "allowRfc2544BenchmarkRange": true,
          "allowIpv6UniqueLocalRange": true
        }
      }
    }
  }
}
```

This is separate from `zones[].egressHosts`. The SSRF policy lets OpenClaw
connect to Gondolin's synthetic addresses; `egressHosts` still decides which
real destinations Gondolin may fetch.

Agent-vm's Gondolin adapter uses RFC2544 synthetic IPv4 answers and
`::ffff:198.18.0.1` for synthetic AAAA when `tcpHosts` are enabled. That value
is accepted by OpenClaw when `allowRfc2544BenchmarkRange` is true. Do not use
`browser.ssrfPolicy.allowedHostnames` as the first fix for Discord media; that
exact-host bypass skips private-IP checks for the named host and is broader
than the adapter-level synthetic DNS fix.

## WebSocket egress

`zones[].websocketUpgrades` allows selected WebSocket upgrade URLs through
Gondolin's normal HTTP egress path. It is narrower than `egressHosts`, not a
replacement for it: every `websocketUpgrades[].host` must also be declared in
`egressHosts` for the same audience.

Each rule has:

```json
{
  "audience": "gateway",
  "scheme": "wss",
  "host": "gateway-*.discord.gg",
  "port": 443,
  "path": "/"
}
```

`scheme` is the WebSocket scheme (`ws` or `wss`). Gondolin presents the upgrade
handshake to request hooks as `http` or `https`; agent-vm maps those back to
`ws` or `wss` for policy matching. `host` supports `*` wildcards, `port` is
optional and defaults to 80 for `ws` and 443 for `wss`, and `path` is optional
but must start with `/` when present. Query strings are not matched.

Use `websocketUpgrades` for native WebSocket clients that can work through
Gondolin's HTTP upgrade bridge. The legacy raw WebSocket TCP passthrough config has been
removed; stale configs should delete it and declare explicit WebSocket upgrade
policy plus matching `egressHosts`.

Gondolin `allowedInternalHosts` is also not the first fix for this symptom. It
relaxes Gondolin HTTP hook internal-IP blocking for matching hostnames, while
the observed Discord media failure happens earlier in OpenClaw's own SSRF guard
as it validates synthetic DNS answers.

The scaffold also includes `tools.sandbox.tools.alsoAllow` for `web_search`,
`web_fetch`, `message`, and `group:plugins`. That does not configure a search
provider by itself; it prevents sandbox tool policy from hiding web tools after
the deployment adds a provider, keeps OpenClaw's `message_tool_only` group reply
mode usable by exposing the explicit channel reply tool, and exposes optional
plugin-owned tools such as Tool Portal's `tool_portal_*` tools to sandboxed
agents.

OpenClaw Tool VMs mount their validated lease work mount at `/workspace`.
`/work` remains Tool VM rootfs/COW scratch. Worker task VMs keep repo edits
under `/work/repos/<repoId>`; worker `/work` is per-task rootfs and is unrelated
to the Tool VM scratch path above.

## imageProfiles

Gateway image profiles are used by zones:

```json
{
  "imageProfiles": {
    "gateways": {
      "worker": {
        "type": "worker",
        "buildConfig": "../vm-images/gateways/worker/build-config.jsonc",
        "source": {
          "kind": "managedBase",
          "base": "worker-gateway",
          "overlay": "../vm-images/gateways/worker/overlay.jsonc"
        }
      }
    }
  }
}
```

`source.kind = "managedBase"` means `agent-vm build` generates the Dockerfile
from the installed `@agent-vm/agent-vm` package and the managed GHCR base image
tag pinned by that package's `managed-images.json` manifest. Managed image tags
use their own release line and are intentionally separate from npm package
versions.
The deployment overlay is intentionally small; use it for extra apt packages,
copy steps, post-base commands, and explicit per-image package overrides.
`agent-vm build` regenerates Dockerfiles under
`cacheDir/generated-dockerfiles/...`; do not edit generated Dockerfiles by hand.
OpenClaw gateway deployments should omit `packageOverrides` when the managed
default package set is acceptable. Use `packageOverrides.openclaw` only for
deliberate non-default runtime package pins, such as a temporary rollback or
forward test of a specific `@openclaw/*` package. Use
`packageOverrides.npm` for direct non-OpenClaw npm packages such as
`@openai/codex` on the OpenClaw and worker gateway images, and
`packageOverrides.pnpm` for exact transitive override
floors such as `undici`. Overlay package pins override managed default package
entries by package name during Dockerfile generation. If the overlay pins
`openclaw@X` and an `@openclaw/*@Y` package with a different version, build
output warns before Docker and Gondolin work begin.

Managed package defaults are recorded under each base image in the installed
package's `managed-images.json`, then exposed in the generated Dockerfile plan
with source labels such as
`overrides undici@8.5.0[managed-images.json/packageOverrides.pnpm]`.
Remove those managed defaults only after fresh package evidence shows OpenClaw
and required `@openclaw/*` packages no longer resolve the vulnerable dependency.

Example non-default OpenClaw runtime package pin:

```jsonc
{
	"schemaVersion": 1,
	"packageOverrides": {
		"openclaw": [
			"@openclaw/discord@2026.6.8"
		],
    "pnpm": {
      "undici": "8.5.0"
    }
  }
}
```

Legacy `dockerfile` profiles are reported by `agent-vm doctor`; migrate them
with `agent-vm migrate images`.

OpenClaw tool VMs use `imageProfiles.toolVms`. Worker-only configs normally
omit tool VM image profiles.

## zones

Each zone selects one gateway image profile and one gateway behavior config:

```json
{
  "id": "coding-agent",
  "gateway": {
    "type": "worker",
    "memory": "2G",
    "cpus": 2,
    "port": 18791,
    "config": "./gateways/coding-agent/worker.jsonc",
    "imageProfile": "worker",
    "stateDir": "../state/coding-agent",
    "repoPushPolicies": [
      {
        "repoUrl": "https://github.com/example/example-repo.git",
        "defaultBranch": "main",
        "protectedBranches": ["release"],
        "protectedBranchPatterns": ["hotfix/*"]
      }
    ]
  },
  "resources": {
    "allowRepoResources": false
  },
  "secrets": {
    "GITHUB_TOKEN": {
      "source": "environment",
      "envVar": "GITHUB_TOKEN",
      "injection": "http-mediation",
      "audience": "gateway",
      "hosts": ["api.github.com", "github.com"]
    }
  },
  "runtimeAuthHints": [
    {
      "kind": "service-token",
      "secret": "GITHUB_TOKEN",
      "service": "github",
      "hosts": ["api.github.com", "github.com"],
      "tools": ["gh"]
    }
  ],
  "egressHosts": [
    { "host": "api.openai.com", "audience": "gateway" },
    { "host": "api.github.com", "audience": "gateway" },
    { "host": "github.com", "audience": "gateway" },
    { "host": "mcp.deepwiki.com", "audience": "gateway" }
  ]
}
```

For worker gateways, `gateway.repoPushPolicies` is the controller-trusted
source for host-token branch push safety. Worker task requests name repos and
base branches to prepare; they do not define protected branch policy. If a
worker task repo has no matching `repoPushPolicies[].repoUrl`, controller-owned
push for that repo fails closed before Git I/O.

Worker zones do not declare Tool VM profile fields. OpenClaw zones must declare
`defaultToolVmProfile` and `agentToolVmProfiles`, even when the agent mapping is
empty. This makes the Tool VM image policy visible in generated configs instead
of hiding it behind defaults.

OpenClaw zones add `zoneFilesDir` because they own long-lived household/user
files:

```json
{
  "id": "shravan",
  "gateway": {
    "type": "openclaw",
    "memory": "4G",
    "cpus": 4,
    "port": 18791,
    "config": "./gateways/shravan/openclaw.json",
    "imageProfile": "openclaw",
    "runtimeRootfsSize": "12G",
    "stateDir": "../state/shravan",
    "zoneFilesDir": "../zone-files/shravan",
    "authLogin": {
      "defaultAgent": "main",
      "providers": {
        "openai": {
          "profileIds": [
            "openai-codex:work@example.com",
            "openai-codex:personal@example.com",
            "openai-codex:admin@example.com"
          ]
        }
      }
    },
    "authProfilesByAgent": {
      "shravan": { "source": "environment", "envVar": "SHRAVAN_AUTH_PROFILES" }
    }
  },
  "agents": [{ "id": "shravan" }],
  "defaultToolVmProfile": "standard",
  "agentToolVmProfiles": {},
  "agentSandboxSeeds": {
    "shravan": [
      {
        "source": { "source": "environment", "envVar": "SHRAVAN_GCLOUD_CONFIG" },
        "target": ".config/gcloud/configurations/config_default",
        "mode": 384
      }
    ]
  }
}
```

New OpenClaw scaffolds set `agents.defaults.workspace` to
`/zone/agents/default`. This keeps authored agent workspace files
under `zoneFilesDir` while leaving `/zone` itself available for shared
zone-level notes and reference material. During the Socket.IO control-plane hard
cutover, same-zone multi-agent OpenClaw remains supported through declared-agent
parity and controller-vetted caller context. Use separate zones only when
gateway lifecycle, channel, secret, or zone-files isolation matters more than
sharing the gateway VM.

`agentToolVmProfiles` values must reference entries in top-level `toolVmProfiles`.
Unmapped agents use the zone fallback `defaultToolVmProfile`.

## zones[].observability

`zones[].observability` opts an OpenClaw zone into OpenTelemetry export through
the host collector. During the Socket.IO control-plane hard cutover, OpenClaw
diagnostics use mediated OTLP HTTP instead of raw collector `tcpHosts`.

Accepted shape:

```jsonc
{
  "zones": [
    {
      "id": "shravan",
      "gateway": { "type": "openclaw" },
      "observability": {
        "enabled": true,
        "openclaw": {
          "serviceName": "agent-vm-openclaw-shravan",
          "logs": true,
          "metrics": true,
          "traces": true,
          "sampleRate": 1,
          "flushIntervalMs": 10000,
          "diagnosticsFlags": ["scheduler.debug"]
        }
      }
    }
  ]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | required | `true` enables mediated OpenClaw OTLP HTTP export. Requires `host.observability.enabled=true`. |
| `openclaw.serviceName` | required | OpenTelemetry service name for OpenClaw signals. |
| `openclaw.logs` | `true` | Enables OpenClaw log export to the host collector. |
| `openclaw.metrics` | `true` | Enables OpenClaw metric export to the host collector. |
| `openclaw.traces` | `true` | Enables OpenClaw trace export to the host collector. |
| `openclaw.sampleRate` | `1` | Trace sample rate from 0 to 1. |
| `openclaw.flushIntervalMs` | `10000` | OpenClaw diagnostics flush interval. |
| `openclaw.captureContent.enabled` | `false` | Must remain false. Content capture is not supported. |
| `openclaw.diagnosticsFlags` | `[]` | Narrow OpenClaw debug categories to enable. Broad or content-capturing flags are rejected. |

The old raw collector `tcpHosts` implementation is intentionally not available
for managed OpenClaw zones in this cutover. Do not inject
`OPENCLAW_DIAGNOSTICS` through `gateway.rawEnvSecrets` to recreate it. Authored
OpenClaw `logging.redactSensitive` must stay enabled; disabling forms such as
`false`, `off`, `disabled`, and `0` are rejected.

`gateway.authProfilesByAgent` writes OpenClaw auth profiles to
`<stateDir>/agents/<agentId>/agent/auth-profiles.json` before the gateway VM
boots. Configure per-agent entries only when agents intentionally keep separate
OpenClaw auth stores. For the shared OpenClaw provider auth model, configure
`gateway.authLogin.defaultAgent` and refresh the configured provider profiles
for that agent; doctor validates that shared auth owner instead of requiring
duplicate auth material for every OpenClaw agent. `gateway.authProfilesRef` and
`gateway.authProfilesByAgent` support `environment`, `1password`, and `config`
sources. Inline `config` values here are plaintext OpenClaw auth profiles and
should be limited to local or test deployments.

`gateway.authLogin` is separate from auth material. It stores only the operator
profile ids used by `agent-vm auth openclaw login <provider>`:

- `defaultAgent` is the OpenClaw agent whose isolated auth store receives
  configured profile logins when the CLI does not pass `--agent`.
- `providers.<provider>.profileIds` is the ordered list of profile ids that
  `--all-configured-profiles` should refresh for that provider.

For the common refresh path, run:

```bash
agent-vm auth openclaw login openai \
  --zone shravan \
  --all-configured-profiles \
  --device-code
```

The helper opens one OpenClaw login per configured profile id and then verifies
the ids are listed by OpenClaw for the target agent. For one-off profile
creation or testing, pass `--agent <agentId>` and one or more
`--profile-id <profileId>` values. Use `--dry-run` to print the resolved plan
without opening SSH.

`gateway.controlAuth` is required for OpenClaw gateways and names the
gateway env secret OpenClaw uses to authenticate controller API calls. The
referenced secret must exist in `zone.secrets` with `injection: "env"` and
`audience: "gateway"`. New scaffolds use:

```json
"controlAuth": { "mode": "token", "secret": "OPENCLAW_GATEWAY_TOKEN" }
```

`gateway.rawEnvSecrets` is the explicit escape hatch for other OpenClaw secrets
that must reach the gateway VM as raw environment variables. Other provider or
service tokens should use `http-mediation` unless the integration cannot work
with HTTP mediation, such as a non-HTTP or websocket credential flow. The
managed zone-git push path is controller-owned through Tool Portal host actions;
do not add a zone-git push token to the gateway VM.

`zones[].gateway.runtimeRootfsSize` optionally requests a minimum runtime root
disk size for the gateway VM, using Gondolin `rootfs.size`. The base image is
not rebuilt for this value; Gondolin grows the writable root disk and runs
`resize2fs` in the guest before startup completes. The guest image must contain
`resize2fs`.

`agentSandboxSeeds` writes first-boot files into the agent's scoped sandbox work
mount before the Tool VM starts. Targets are relative to the sandbox
backing directory exposed at `/workspace` in Tool VMs, cannot use `..`, and are
not written for shared `/zone` work mounts. Existing files are preserved so a
user's edited credentials or config are not overwritten on later leases. Seed
sources support `environment`, `1password`, and `config`; inline seed values are
written as plaintext files into the sandbox work mount on first boot.

The important path model is:

```text
OpenClaw gateway durable zone files:
  guest /zone  ->  host gateway.zoneFilesDir

Tool VM selected work mount:
  guest /workspace  ->  host path chosen by OpenClaw lease request
  guest /work       ->  Tool VM rootfs/COW scratch

That Tool VM `/workspace` backing path may be an agent sandbox work directory
under stateDir, or a subpath of zoneFilesDir. The Tool VM root filesystem
itself is disposable, including `/work`.
```

Tool VM and gateway startup recovery use host-side TCP listener ownership
checks before signaling recorded QEMU/krun processes. The controller requires
`lsof` on the host for that recovery path. If `lsof` is unavailable and
persisted runtime records need port-owner verification, startup fails with a
clear host dependency error instead of guessing ownership.

## toolVmProfiles

`toolVmProfiles` names the Tool VM runtime profiles available to OpenClaw
zones. The name is intentionally explicit: these are profiles for disposable
Tool VMs, not gateway profiles and not OpenClaw user profiles.

```json
{
  "toolVmProfiles": {
    "standard": {
      "memory": "1G",
      "cpus": 1,
      "imageProfile": "default",
      "runtimeRootfsSize": "16G"
    },
    "tools-dev": {
      "memory": "2G",
      "cpus": 2,
      "imageProfile": "tools-dev"
    }
  },
  "imageProfiles": {
    "toolVms": {
      "default": { "type": "toolVm", "buildConfig": "../vm-images/tool-vms/default/build-config.json" },
      "tools-dev": { "type": "toolVm", "buildConfig": "../vm-images/tool-vms/dev/build-config.json" }
    }
  }
}
```

`toolVmProfiles[*].imageProfile` must reference
`imageProfiles.toolVms[*]`. The build pipeline can build multiple Tool VM image
profiles from one config. Image profiles with the same resolved build config
path and identical effective image fingerprints are deduped during
`agent-vm build`, so separate profile names do not by themselves force separate
Gondolin asset conversion work.

`toolVmProfiles[*].runtimeRootfsSize` applies the same runtime root disk sizing
to Tool VMs created from that profile. Use the image build config
`rootfs.sizeMb` for packages baked into the base image; use
`runtimeRootfsSize` for writable runtime capacity such as agent caches,
temporary installs, browser artifacts, and command output generated after boot.

## zones[].resources

`resources` controls whether repo-local providers may satisfy logical
resources. If omitted, `allowRepoResources` behaves as `true`.

```json
{
  "resources": {
    "allowRepoResources": [
      "https://github.com/example/example-repo"
    ]
  }
}
```

| Value | Meaning |
| --- | --- |
| `false` | Repo-local providers are disabled; required resources must be supplied externally. |
| `true` | Any requested repo may provide resources. This is the default. |
| `string[]` | Only matching repo URLs may provide resources. |

Repo resources are TCP-only and compile to Gondolin `tcpHosts`, env, and
read-only VFS mounts. They do not modify `egressHosts`; HTTP egress remains a
zone-level policy.

`allowRepoResources: false` disables the entire repo-local resource contract
pipeline. The controller does not load `.agent-vm/repo-resources.ts`, does not
run `.agent-vm/run-setup.sh`, and does not call
`finalizeRepoResourceSetup(input)`. Required resources must be supplied as
task external resources. `true` and `string[]` allow matching repos with a
contract file to run setup/finalization after resource resolution.

## secrets

Zone secrets support three sources:

| Source | Fields |
| --- | --- |
| `environment` | `envVar` |
| `1password` | `ref` |
| `config` | `value` |

`source: "config"` embeds the secret value directly in `system.json`; use it
only for local or intentionally checked-in test credentials.

The same secret source union is also used by host/controller fields such as
`host.githubToken`, `zones[].adminAccess.secret`,
`zones[].gateway.authProfilesRef`, `zones[].gateway.authProfilesByAgent`, and
`zones[].agentSandboxSeeds[].source`. Inline `config` on those fields is still
plaintext in the authored config and may include host write credentials or
controller admin credentials, so treat it as a local/test convenience rather
than a production secret store.

Secrets support two injection modes:

| Injection | Meaning |
| --- | --- |
| `http-mediation` | Gondolin injects the secret into outbound HTTP requests for listed `hosts`. The VM process does not see the raw secret. |
| `env` | Secret is exposed as a VM environment variable. |

For `http-mediation`, `hosts` is required and must be non-empty. For `env`,
`audience` must be `gateway` and `hosts` must be omitted. Tool VM secrets are
always mediated. `source: "environment"` is allowed for a Tool VM secret only
when `injection` is `http-mediation`; in that case the controller reads the
environment variable and Gondolin mediates the value.

For `http-mediation` secrets with `audience: "tool-vm"` or `"both"`,
`agentAccess` is required, and the OpenClaw zone must declare at least one
`zones[].agents[].id` so the access rule has an agent set to evaluate. Use
`"all"` to make the mediated placeholder available to every declared OpenClaw
agent in the zone, or a non-empty array such as `["sun"]` to scope placeholder
delivery to specific declared agents. The controller selects the allowed secret
names for the requesting `agentId` before resolving secret refs, so an
agent-scoped Tool VM never causes other agents' mediated secret refs to be read
for that lease. For `audience: "both"`, `agentAccess` scopes only Tool VM
placeholder delivery; gateway mediation remains zone-wide.

Example Tool VM-mediated secret scoped to one agent:

```jsonc
"GITHUB_TOKEN": {
  "source": "1password",
  "ref": "op://agent-vm/example-sun-github/credential",
  "injection": "http-mediation",
  "audience": "tool-vm",
  "hosts": ["api.github.com", "github.com"],
  "agentAccess": ["sun"]
}
```

OpenClaw zones allow raw gateway env secrets only when the secret is referenced
by `gateway.controlAuth.secret` or is listed in `gateway.rawEnvSecrets`. This
keeps provider API tokens on the mediated path by default and makes every
raw-env exception visible in deployment config.

Secret names must be valid environment variable identifiers. This keeps
gateway env-file rendering and runtime placeholder names safe and predictable.

## runtimeAuthHints

Worker zones may declare `runtimeAuthHints` to describe mediated service tokens
to the worker agent. These hints generate worker runtime instructions only; they
do not mount config files and do not expose real secret values. They name the
service, mediated host list, tool names, and placeholder env var so the worker
agent can use normal tooling without guessing which token exists. OpenClaw zones
must not declare `runtimeAuthHints`; Tool VM auth is controlled by Tool
VM-audience mediated secrets and `egressHosts`.

Known services get setup recipes in the generated runtime instructions. Current
recipes cover `github`, `npm`, Linear, Readwise, and Python package indexes
(`pypi`, `pypi-private`, `python`, or `python-package-index`). Unknown services
are still listed, but the generated guidance tells the agent to report an auth
setup gap if the correct toolchain setup is not known.

```json
{
  "runtimeAuthHints": [
    {
      "kind": "service-token",
      "secret": "GITHUB_TOKEN",
      "service": "github",
      "hosts": ["api.github.com"],
      "tools": ["gh"]
    },
    {
      "kind": "service-token",
      "secret": "NPM_AUTH_TOKEN",
      "service": "npm",
      "hosts": ["registry.npmjs.org"],
      "tools": ["npm", "pnpm", "yarn"]
    }
  ]
}
```

Each hint must reference a worker-zone secret with `injection:
"http-mediation"` and an audience that reaches the worker gateway runtime
(`"gateway"` or `"both"`). Every hint host must also appear in that secret's
`hosts`.

Generated auth guidance appears in `/agent-vm/agents.md`,
`/agent-vm/runtime-instructions.md`, and the prompt's `runtimeInstructions`
layer.

## tcpPool

The TCP pool reserves host ports for VM networking. Agent Worker Gateway uses the
controller mapping. OpenClaw Gateway also uses it for tool VM SSH slots.

```json
{
  "tcpPool": {
    "basePort": 19000,
    "size": 12
  }
}
```

Generated configs use `size: 12` so one controller can run multiple agents and
zones without exhausting Tool VM SSH slots immediately.

## leaseIdleTtl

`leaseIdleTtl` is optional. When omitted, every lease uses the default 100 minute
idle timeout. Managed OpenClaw Tool VM leases use one TTL policy for all agents;
OpenClaw scope keys are not part of the agent-vm lease model and cannot change
TTL selection.
Clients may request `idleTtlMs` on a lease request, bounded by `minRequestedMs`
and `maxRequestedMs`:

```json
{
  "leaseIdleTtl": {
    "defaultMs": 6000000,
    "minRequestedMs": 1000,
    "maxRequestedMs": 86400000
  }
}
```

When `idleTtlMs` is omitted from the request, the controller uses `defaultMs`.

## Cross-Field Validation

The schema rejects:

- 1Password secrets without `host.secretsProvider`.
- Legacy `allowedHosts`; use `egressHosts` with explicit `audience`.
- Zone secrets without explicit `audience`.
- Env-injected zone secrets with non-gateway audience or declared `hosts`.
- OpenClaw env-injected zone secrets not listed in `gateway.rawEnvSecrets`,
  except the configured `gateway.controlAuth.secret`.
- Tool VM-reaching mediated secrets without `agentAccess: "all"` or a non-empty
  agent id array.
- Tool VM-reaching mediated secrets in OpenClaw zones with no declared
  `zones[].agents`.
- Tool VM-reaching mediated secrets whose `agentAccess` array references an
  unknown `zones[].agents[].id`.
- Worker zones declaring `agentAccess`, because worker zones do not boot
  OpenClaw Tool VMs.
- Mediated secret hosts not declared in `egressHosts` for the same audience.
- WebSocket upgrade hosts not declared in `egressHosts` for the same audience.
- OpenClaw zones without `gateway.controlAuth` or without the referenced
  gateway-only env secret.
- Zones referencing missing gateway image profiles.
- Zone gateway type mismatches against the selected image profile.
- OpenClaw zones declaring `runtimeAuthHints`.
- OpenClaw zone observability without `host.observability.enabled=true`.
- Worker zone observability.
- OpenClaw observability with broad/content-capturing diagnostics flags or raw
  `OPENCLAW_DIAGNOSTICS`.
- Worker `runtimeAuthHints` referencing missing secrets, non-mediated secrets,
  Tool VM-only secrets, or hosts not listed on the referenced secret.
- OpenClaw zones without `defaultToolVmProfile`.
- OpenClaw zones without explicit `agentToolVmProfiles`.
- Worker zones declaring Tool VM profile or sandbox seed fields.
- `agentToolVmProfiles` values referencing missing `toolVmProfiles`.
- `agentSandboxSeeds` targets that are absolute or escape the sandbox work mount.
- Tool VM profiles referencing missing Tool VM image profiles.
- OpenClaw MCP Portal configs that fail materialization semantics, including
  missing stdio `networkAccess`, missing provider `secretPolicies`, invalid
  mediated hosts, and generated secret environment-name collisions.
