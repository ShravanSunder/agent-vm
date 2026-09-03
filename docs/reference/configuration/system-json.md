# system.jsonc

`system.jsonc` is the controller's top-level human-authored schema-version-2 config file.
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

storageRootDir

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

toolVmProfiles

tcpPool

leaseIdleTtl
```

## host

| Field | Required | Meaning |
| --- | --- | --- |
| `controllerPort` | yes | TCP port for the controller HTTP API. |
| `projectNamespace` | yes | Lowercase namespace used for deployment identity, generated storage isolation, runtime labels, and cache separation. |
| `secretsProvider` | when using `source: "1password"` | How the host resolves 1Password-backed secrets. |
| `githubToken` | no | Host-only token for clone and push. Never enters the VM. |
| `observability` | no | Host-owned Victoria/OpenTelemetry stack used by opted-in Hermes zones. |

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

Per-zone managed Hermes observability uses Gondolin HTTP mediation.
The old collector path depended on raw Gondolin `tcpHosts` and must not be
restored. Enabled zones send framework and common Tool Portal OTLP to a synthetic
collector host that the controller rewrites to the configured loopback collector
port. Tool VM SSH remains the only raw TCP exception in the managed gateway VM
spec.

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
| `dataDir` | required for `managed` | Independent durable host directory for Victoria data. Must not overlap `storageRootDir` or its derived cache, controller, or zone leaves. Omit for `external`. |
| `projectName` | `agent-vm-observability-<projectNamespace>` | Managed-stack Docker Compose project name. Must use lowercase letters, numbers, hyphens, and underscores, and start with a letter or number. Managed only. |
| `bindAddress` | `127.0.0.1` | Host bind address for collector and Victoria ports. Only loopback addresses are accepted. |
| `prepareOnBuild` | `true` | Lets `agent-vm build` render artifacts and run Docker Compose for `managed` when an opted-in zone is selected. `external` reports that the stack is externally managed. |
| `waitOnBuild` | `true` | Makes managed build wait for collector, metrics, logs, and traces readiness after Compose startup. |
| `controllerStartPolicy` | `degraded` | `degraded` starts the controller when readiness is unavailable; `require-ready` fails after the bounded readiness budget; `off` skips startup checks. No policy starts Docker. |
| `startupCheckTimeoutMs` | `30000` | Total bounded readiness budget for one startup pass. The collector check uses the health endpoint first and falls back to OTLP HTTP receiver reachability; Victoria services use health endpoints. |
| `ports.collectorGrpc` | `4317` | Host OTLP gRPC collector port. All observability ports must be unique values from 1 through 65535. |
| `ports.collectorHttp` | `4318` | Host OTLP HTTP collector port used by managed Gateway diagnostics. |
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
<controllerRuntimeDir>/observability/<projectNamespace>/docker-compose.observability.yml
<controllerRuntimeDir>/observability/<projectNamespace>/otel-collector-config.yaml
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
| `gatewayServiceAutoRestart.enabled` | `true` | Enables bounded whole-Gateway VM recovery from repeated gateway-service or gateway control-session degradation. Managed sibling processes have no same-VM restart or supervisor path. |
| `gatewayServiceAutoRestart.consecutiveFailureThreshold` | `10` | Consecutive degraded observations required before the relevant recovery boundary is eligible. A healthy observation resets that boundary's counter. |
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
events to `<controllerRuntimeDir>/controller-health/events.jsonl` as diagnostic evidence.
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

## storageRootDir

`storageRootDir` is the sole authored standard operational storage path. It
is required and supports the existing absolute, config-relative, and
home-relative syntax. Generated scaffolds use the same `host.projectNamespace`
for deployment identity and storage isolation:

```text
local      <project>/.agent-vm/<projectNamespace>
user-dir   ~/.agent-vm/<projectNamespace>
pod        /var/agent-vm/<projectNamespace>
```

`storageRootDir` stores that final full path. Controller startup loads and
canonicalizes it, then derives the tree below without appending or recomputing
`projectNamespace`. Schema version 2 rejects authored `cacheDir`,
`controllerStateDir`, `runtimeDir`, `zones[].gateway.stateDir`, and
`zones[].gateway.zoneFilesDir` fields.

The controller derives this exact tree:

```text
<storageRootDir>/
├── cache/                              cacheDir
├── controller-state/                   controllerStateDir
│   └── zones/<zoneId>/
├── controller-runtime/                 controllerRuntimeDir
│   ├── vm-ownership/
│   ├── controller-health/
│   └── observability/<projectNamespace>/
└── <zoneId>/
    ├── state/                          stateDir
    ├── zone-files/                     zoneFilesDir for Hermes
    └── runtime/                        zoneRuntimeDir
        ├── logs/
        ├── gitdirs/agents/<agentId>/
        ├── worker-tasks/<taskId>/
        └── control-sessions/
```

`cache`, `controller-state`, and `controller-runtime` are reserved and invalid
as zone IDs. Independent controller deployments on one host must select
different storage roots.

## Derived cacheDir

`cacheDir` stores rebuildable artifacts. It is intentionally outside encrypted
zone backups. Current uses include Gondolin image outputs and per-zone gateway
repair/download caches.

Do not place durable secrets or user state under `cacheDir`. Do not place
rebuildable dependency trees under `stateDir` just to make them survive gateway
VM reboot; mount a cache path or bake stable dependency trees into the image
instead.

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

## Derived controllerStateDir

`controllerStateDir` is `<storageRootDir>/controller-state`. The controller
canonicalizes the storage root before use and preserves existing path-isolation
and mount-source checks.

This directory is host-controller-only durable authority. It and all of its
descendants must never enter immutable boot inputs, environment, telemetry, or
any Gateway or Tool VM mount.

## Derived controllerRuntimeDir and zoneRuntimeDir

`controllerRuntimeDir` is `<storageRootDir>/controller-runtime` and stores the
controller ownership lock, health evidence, and generated observability files.
`zoneRuntimeDir` is `<storageRootDir>/<zoneId>/runtime` and stores active
non-backup runtime artifacts owned by one zone.

Current uses include Hermes Gateway logs and Worker Git metadata:

```text
<zoneRuntimeDir>/logs/
<zoneRuntimeDir>/gitdirs/agents/<agentId>/workspace.git
<zoneRuntimeDir>/worker-tasks/<taskId>/gitdirs/<repoId>.git
```

Normal `backup create` copies neither runtime root. Worker runtime artifacts are
task-lifetime data: the agent must
commit and call `git-push` before task teardown if work must survive. Hermes
gateway logs are runtime evidence for post-mortems and performance debugging;
they persist across gateway VM restarts but are intentionally excluded from
normal zone backups.

## Derived zoneFilesDir

`zoneFilesDir` is the derived `<storageRootDir>/<zoneId>/zone-files` Hermes
per-agent workspace directory. The Gateway VM does not receive a broad mount.
The controller selects each agent workspace from
`zoneFilesDir/agents/<agentId>` for its Tool VM. The complete directory is
included in Hermes zone backups.

Worker gateways do not use `zoneFilesDir`. Their repo files live in VM-local
`/work/repos/<repoId>`, and their Git metadata lives under `zoneRuntimeDir`.

Do not call this `workspaceDir`. Worker execution files live under VM-local
`/work/repos/<repoId>` and are not backed by this host path. For managed agents,
the controller derives one durable workspace from
`zoneFilesDir/agents/<agentId>` and projects only its filtered view into the
selected Tool VM.

Managed lease requests do not carry `workMountDir`, `hostWorkMountDir`, or
other host-path authority. Trusted system configuration selects the actual
workspace and optional Git capabilities.
For the canonical name/location/storage vocabulary, see
[Lease Path Vocabulary](../../architecture/storage-model.md#lease-path-vocabulary).

```text
Tool VM durable agent workspace: /workspace
Tool VM rootfs/COW workdir: /work
Tool VM optional workspace Git database: /gitdirs/workspace.git
Hermes Gateway broad zone-files mount: none
```

For the storage boundary model, see
[storage-model.md](../../architecture/storage-model.md).

## gateway.ingress

`zones[].gateway.ingress` customizes the host-facing Gondolin ingress timeout
behavior for the gateway VM. Omit it for Gondolin defaults.

| Field | Required | Meaning |
| --- | --- | --- |
| `upstreamHeaderTimeoutMs` | no | Timeout while waiting for response headers from the guest gateway process. |
| `upstreamResponseTimeoutMs` | no | Timeout between upstream response body chunks from the guest gateway process. |

agent-vm exposes one host-facing Gondolin ingress listener at
`zones[].gateway.port`. For a managed Hermes Gateway, the controller first
publishes only the private Tool Portal control route and admits any framework
root route atomically with the current Gateway cohort. Containment or
replacement removes those routes before successor admission.

agent-vm keeps Gondolin response buffering disabled for gateway ingress so
streaming responses can pass through incrementally. Long-running non-streaming
gateway requests, such as direct agent API calls, may need a larger
`upstreamResponseTimeoutMs` than Gondolin's default. Streaming responses are less
sensitive because each emitted chunk resets the response-body idle timer.

These timeout settings do not open additional guest webserver ports. Additional
guest HTTP services require explicit Gondolin ingress routes from non-root path
prefixes to guest ports. Raw TCP services belong in `tcpHosts`, not HTTP
ingress.

## Managed Gateway Tool Portal Defaults

Managed Hermes uses its Python Gateway Runtime adapter to expose the managed
Tool Portal native tools:

- `tool_portal_list`
- `tool_portal_search`
- `tool_portal_describe`
- `tool_portal_call`

Hermes scaffolds use the managed adapter and do not enable a separate
model-visible MCP Portal plugin. Managed Tool Portal supports both
`calls.withoutApproval` and controller-authorized `calls.requiresApproval`
selectors.

The selected managed image starts one common Tool Portal service process beside
one Hermes framework process. The framework integration is a thin
client: it authenticates native agent/profile identity and uses the service's
private UDS. ToolPortalService, hosted by the common sibling, owns capability
policy, controller bindings, per-agent SSH, active use, and the SSH Sandbox API.

When agents are configured for a managed Gateway, agent-vm scaffolds these
sibling authored config files in `config/gateways/<zone>/`:

- `mcp.config.jsonc` describes upstream MCP providers and discovery.
- `tool-portal.config.jsonc` describes agent profile assignments, complete
  cross-backend namespace policies, explicit backend bindings, and call/tool
  selectors.

Namespace discovery uses one optional bounded field: `discovery.summary`.
MCP-backed namespaces author it only at
`mcp.config.jsonc.providers.<provider>.discovery.summary`; the provider record
key may differ from its public `namespace`. A `controller_execution` or
`tool_vm_runner` namespace may instead author `discovery.summary` on its Tool
Portal namespace policy. MCP-backed Tool Portal policy rejects a duplicate
`discovery` field rather than overriding or merging the provider value.

Managed Hermes does not generate framework-native MCP server entries for MCP
Portal. Its adapter registers the four Tool Portal operations and calls the
Tool Portal service over the private UDS.
Operator-authored upstream MCP servers live in `mcp.config.jsonc`; agent-vm
loads the sibling `tool-portal.config.jsonc` as managed policy authority and
materializes effective Gateway config that turns configured 1Password secrets
into runtime environment references or runtime-mediated bindings before gateway
boot.

Omitting `zones[].toolPortal` disables the managed Tool Portal for that zone.
When present, it is one strict required contract:

```jsonc
{
  "configDir": "./gateways/my-zone",
  "surfaceEligibilityByProfile": {
    "default": {
      "linear": ["protected_uds"]
    }
  }
}
```

`configDir` points at the directory containing the managed authored pair:
`mcp.config.jsonc` and `tool-portal.config.jsonc`.
`surfaceEligibilityByProfile` is the controller-authored profile/namespace map
used by the one Tool Portal service. `protected_uds` admits a namespace through
the authenticated private Gateway Runtime client. Surface values are semantic
authorization labels; they do not start listeners. Managed mode exposes neither
a Tool Portal HTTP/MCP/stdio listener nor public Tool Portal ingress.
`configDir` and `surfaceEligibilityByProfile` are required when Tool Portal is
enabled; partial objects, standalone listener fields, and unknown fields are
rejected.

### Managed Tool Portal Authored Policy

Managed Gateway policy is authored in `tool-portal.config.jsonc`. Its important
fields are:

- `agents.<agentId>.profile` selects one complete profile.
- `agents.<agentId>.credentialBindings` optionally declares that agent's
  controller-only named 1Password file sets for credentialed Managed runtimes.
  Bindings select credentials but do not grant capabilities beyond the profile.
- `mode` must be `"managed"`.
- `profiles.<name>.namespaces` defines the profile's namespace policy.
- `profiles.<name>.namespaces.<namespaceId>.backend.kind` explicitly binds
  the namespace to `mcp_provider`, `controller_execution`, or
  `tool_vm_runner`. Declaring a backend kind does not by itself prove that a
  later backend/runtime cutover is deployed.
- `profiles.<name>.namespaces.<namespaceId>.discovery.summary` is an optional
  1-500 character description for `controller_execution` and
  `tool_vm_runner`. MCP-backed namespaces source the same metadata only from
  the matching MCP provider.
- Each namespace colocates `tools.allow`, `tools.deny`,
  `calls.withoutApproval`, and `calls.requiresApproval`. A visible tool outside
  both call selectors is blocked. The two call selectors must not overlap.
- `calls.requiresApproval` is valid managed policy. The controller approval
  authority owns challenge, reservation, grant, and dispatch admission; managed
  policy does not use standalone HMAC keys as approval authority.

Successful Tool Portal list, search, and describe items include a required
`namespaceDiscovery` array for exactly the namespaces represented by that
item. This metadata does not enter call requests, approval presentation,
backend arguments, controller execution, or Tool VM SSH. Hermes also renders
the effective name, availability, and optional summary once per session using
its existing bounded orientation. `configured_cli.safeHelp` remains separate:
it is the required per-operation capability description returned through Tool
Portal discovery, not namespace prompt text.

Any managed namespace that effectively admits at least one tool through
`calls.requiresApproval` requires `zones[].approvalAccess`. Static validation
and gateway preflight fail closed when that authority is absent. No
`approvalAccess` default is inferred from `adminAccess`, standalone MCP Portal
auth, or any other authority.

Every `approvalAccess.approvers[]` entry is exactly
`{ kind: "managed_gateway", approverId }`. Secrets, credentials, bearer
authorities, and other variants are rejected. Only Hermes declares the native
presenter capability in this release; Worker zones reject managed approval
authority rather than falling back to another approval surface. The
controller exposes no external approval HTTP routes. Hermes's separately
authenticated in-VM agent-message API uses `API_SERVER_KEY` and is not an
approval authority.

`controller_execution` contains named `registered_action | configured_cli`
operations. Configured CLI binds exactly one `controller_host` or
`ephemeral_managed_vm` target. Its timeout is `quick` (fixed 5 seconds) or
`open` (120-second default, caller override up to 8 hours). The Gateway never
selects the target, executable, image, environment, or raw controller deadline.

Every `configured_cli` operation requires its own invocation-level `calls`
policy in addition to the namespace call selectors. Namespace
`calls.withoutApproval` or `calls.requiresApproval` establishes the operation
baseline. The operation's `calls.deny` and `calls.requiresApproval` arrays then
match exact admitted command paths plus optional present flag names and values;
`calls.withoutApproval` must be the literal `"remaining_admitted"`. All
matching rules are collected and fixed precedence applies independently of
authored order:

```text
deny > requires_approval > without_approval
```

An empty matcher `flags` array classifies the entire exact command path.
Predicate names and values are alternatives, predicates within one matcher are
conjunctive, and matchers within one bucket are alternatives. The old
`commands[].flagRules[].kind: "deny"` shape is rejected; keep only
`allowed_values` admission rules there and express path-scoped flag denial in
`configured_cli.calls.deny`. A visible configured CLI admitted through the
namespace direct baseline still requires `zones[].approvalAccess` when its
operation-level `calls.requiresApproval` array is non-empty. Hermes is the sole
native presenter for those matched invocations in this release.

`tool_vm_runner` may separately define a `command.cli` operation for one
executable already installed in the caller's current leased Tool VM. This is a
different discriminated-union branch from `controller_execution.configured_cli`:
configuration owns the absolute `executable`, `safeHelp`, optional bounded
`metadata`, work-relative `workingDirectory`, timeout class, and output policy;
the caller owns unrestricted `argv` and optional `stdin`. Agent VM validates
only protocol and resource bounds, passes `[executable, ...argv]` without shell
interpolation, and executes through the existing current-generation strict-SSH
path. It does not define an allowed command grammar or route the call through
controller execution or a credentialed Managed runtime.

Only this branch may contain `advisoryHints.hintDeny` and
`advisoryHints.hintRequiresApproval`. They reuse exact path-prefix and
present-flag matching with fixed precedence:

```text
hintDeny > hintRequiresApproval > unmatched direct call
```

These hints affect only `tool_portal_call`. They do not restrict the same
agent's terminal, Python, or other execution path inside the Tool VM. Discovery,
denial diagnostics, and approval presentation label that limitation explicitly.
A visible `hintRequiresApproval` matcher requires `zones[].approvalAccess`, but
the namespace baseline for `command.cli` remains `calls.withoutApproval`.

The public call accepts empty or caller-selected tokenized `argv`, a non-empty
`reason`, optional bounded text `stdin`, and `timeoutMs` only for an `open`
operation. Newline and tab remain literal argv content; NUL-bearing or empty
individual tokens are rejected as malformed transport values. The result uses
the common configured-CLI fields: `exitCode`, `stdout`, `stdoutTruncated`,
optional fixed-safe `stderrSummary`, and `stderrTruncated`.
`stdoutMaxBytes` is capped at 65,536 bytes so model-visible output remains valid
Portal JSON; the independent strict-SSH transport ceiling remains 1 MiB per
stream, and larger captured stderr is reduced to the fixed-safe summary.

The credentialed `ephemeral_managed_vm` target is a controller-created reusable
Managed runtime, not a leased Tool VM and not one VM per call. It requires
`runtimeId`, `credentialBinding`, 1-16 unique `credentialFiles` mappings, and
1-16 controller-authored `credentialEnvironment` entries. Environment entries
resolve only to `{ kind: "credential_root" }` or
`{ kind: "credential_file", source }`; callers cannot select their names or
values. Credential paths are read-only and memory-backed while ordinary CLI
config, state, and cache remain in live COW rootfs.

One agent/runtime executes one command at a time. A concurrent call is
retryably rejected rather than queued. Compatible independently authorized
calls reuse the VM until 15 idle minutes elapse; every call still gets its own
current policy and approval decision. Retirement discards credential memory and
COW without checkpointing. Gateway startup prepares `imageReference` and binds
its fingerprint into controller-only compatibility. Persisted Gateway-safe
config contains only an opaque cohort revision, never credential refs, file
paths, runtime ids, or prepared image details. `tool_vm_runner` remains direct
Gateway-to-leased-Tool-VM strict SSH with no per-command controller RPC.

For Gog service accounts, map the 1Password value to Gog's expected
`sa-<encoded-account>.json` path and set:

```jsonc
{
  "agents": {
    "sun": {
      "profile": "google-enabled",
      "credentialBindings": {
        "google": {
          "files": {
            "service-account": {
              "source": "1password",
              "ref": "<operator-authored 1Password reference>"
            }
          }
        }
      }
    }
  },
  "executionTarget": {
    "kind": "ephemeral_managed_vm",
    "runtimeId": "google-workspace",
    "credentialBinding": "google",
    "credentialFiles": [
      {
        "source": "service-account",
        "path": "sa-<encoded-account>.json"
      }
    ],
    "credentialEnvironment": {
      "GOG_DATA_DIR": { "kind": "credential_root" }
    },
    "imageReference": "./gog-image.jsonc",
    "guestCwd": "/work",
    "environment": { "kind": "empty" },
    "allowedHosts": ["oauth2.googleapis.com", "www.googleapis.com"]
  }
}
```

Gog config/state/cache remain on COW because only `GOG_DATA_DIR` points at the
credential mount. An unchanged live 1Password ref is resolved again only after
retirement. For immediate replacement:

```text
agent-vm controller credential-runtime retire \
  --zone <zone> --agent <agentId> --runtime <runtimeId> [--force]
```

The command uses existing zone `adminAccess`. Without `--force`, active work is
left running and the result is `active`; `--force` cancels it before exact
cleanup. Other results are `retired`, `absent`, or `owner-unsafe`.

For lifecycle ownership, final admission, credential-memory, COW, recovery,
and Tool VM separation, see
[Credentialed Managed Runtimes](../../architecture/credentialed-runtimes.md).

For an MCP-backed managed namespace, the namespace id matches the provider
namespace in `mcp.config.jsonc` and explicitly selects `mcp_provider`:

```jsonc
{
  "schemaVersion": 1,
  "mode": "managed",
  "agents": {
    "main": { "profile": "default" }
  },
  "profiles": {
    "default": {
      "namespaces": {
        "linear": {
          "backend": { "kind": "mcp_provider" },
          "tools": { "allow": "*", "deny": [] },
          "calls": {
            "withoutApproval": { "allow": ["get_issue"], "deny": [] },
            "requiresApproval": { "allow": ["create_issue"], "deny": [] }
          }
        }
      }
    }
  }
}
```

`profiles.*.capabilities` is rejected; there is no compatibility alias or dual
managed reader.

This namespace policy governs the Capability API (`list`, `search`, `describe`,
and `call`). It does not turn the managed SSH Sandbox API into a catalog of RPC
capabilities. Hermes BaseEnvironment operations use
the separate `GatewayRuntimeClient.sandbox` API for authenticated environment,
shell, filesystem, process, stream, and terminal access. ToolPortalService owns
both APIs and may use the same current agent binding and SSH connection after
their distinct admission paths.

### Standalone/External MCP Portal Authored Policy

Standalone/external MCP Portal uses `mcp.config.jsonc` plus
`mcp-portal.config.jsonc`. The latter is loaded by `mcp-portal mcp-proxy serve`,
not by managed Gateway config materialization. Its important fields are:

- `agents.<agentId>.profile` selects a profile.
- `agents.<agentId>.credentialVersion` revokes previously printed external
  `/mcp-proxy` bearer credentials for that agent.
- `agents.<agentId>.hmacKey` is for standalone/external MCP Portal approval
  token flows.
- `externalAuth.masterKey` is required only for external `/mcp-proxy` bearer
  auth and client-config generation.
- `mcpProxy.server.host`, `mcpProxy.server.port`, and
  `mcpProxy.auth.headerName` configure the loopback Hono MCP proxy.
- `profiles.<name>.namespaces` defines the agent's portal policy per namespace:
  `tools.allow`, `tools.deny`, `calls.withoutApproval`, and
  `calls.requiresApproval`. `tools.allow` is `*` for every discovered tool or an
  explicit list of visible tool names; `tools.deny` removes tools from the
  catalog. Call selectors use the same shape and decide whether a visible tool
  runs directly or requires the standalone approval-token flow. Visible tools
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

Local managed Tool Portal integration uses deterministic upstream providers;
credentialed upstream providers belong in an explicit deployment E2E. Hermes
zones may declare multiple trusted agents when `zones[].agents`,
`profilesByAgent`, Tool Portal assignments, capability bindings, profile-secret
projections, and Tool VM profile policy stay aligned.

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

Hermes Tool VMs mount the selected filtered durable agent workspace at
`/workspace`; `/work` is rootfs/COW hot execution space and the default cwd.
Worker task VMs keep repo edits under `/work/repos/<repoId>`; Worker `/work`
remains per-task rootfs/COW.

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
Managed Worker and Tool VM deployments should omit `packageOverrides` when the
managed default package set is acceptable. Use `packageOverrides.npm` for
direct npm packages such as `@openai/codex`, and
`packageOverrides.pnpm` for exact transitive override
floors such as `undici`. Overlay package pins override managed default package
entries by package name during Dockerfile generation.

Managed package defaults are recorded under each base image in the installed
package's `managed-images.json`, then exposed in the generated Dockerfile plan
with source labels such as
`overrides undici@8.5.0[managed-images.json/packageOverrides.pnpm]`.
Remove managed defaults only after fresh package evidence proves the retained
runtime no longer resolves the affected dependency.

Legacy `dockerfile` profiles are reported by `agent-vm doctor`; migrate them
with `agent-vm migrate images`.

Hermes Tool VMs use `imageProfiles.toolVms`. Worker-only configs normally
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

Worker zones do not declare Tool VM profile fields. Hermes zones must declare
`defaultToolVmProfile` and `agentToolVmProfiles`, even when the agent mapping is
empty. This makes the Tool VM image policy visible in generated configs instead
of hiding it behind defaults.

Hermes zones receive a derived `zoneFilesDir` because they own durable per-agent
workspaces. Hermes does not expose a broad zone root to its Gateway:

```json
{
  "id": "shravan",
  "gateway": {
    "type": "hermes",
    "memory": "4G",
    "cpus": 4,
    "port": 18791,
    "config": "./gateways/shravan/config.yaml",
    "imageProfile": "hermes",
    "runtimeRootfsSize": "12G",
    "backupDir": "../backups/shravan",
    "backupIdentity": {
      "source": "environment",
      "envVar": "AGE_BACKUP_IDENTITY"
    },
    "profilesByAgent": {
      "shravan": "shravan"
    },
    "profileSecretProjectionsByAgent": {
      "shravan": {
        "API_SERVER_KEY": "HERMES_PROFILE_API_KEY",
        "DISCORD_BOT_TOKEN": "HERMES_DISCORD_BOT_TOKEN"
      }
    }
  },
  "agents": [{ "id": "shravan" }],
  "defaultToolVmProfile": "standard",
  "agentToolVmProfiles": {}
}
```

Each declared Hermes agent has one durable workspace under
`zoneFilesDir/agents/<agentId>`. Same-zone multi-agent Hermes remains isolated
through exact declared-agent/profile/projection parity and controller-vetted
caller context. Use separate zones when Gateway lifecycle, secret, or
zone-files isolation matters more than sharing the Gateway VM.

`agentToolVmProfiles` values must reference entries in top-level `toolVmProfiles`.
Unmapped agents use the zone fallback `defaultToolVmProfile`.

`zones[].gateway.backupDir` optionally selects the encrypted backup output
directory. When omitted, backup output defaults to `<stateDir>/backups`.
`zones[].gateway.backupIdentity` is an optional host secret reference using the
same `1password`, `environment`, or `config` forms as other host-resolved
secrets. It is required when running `backup create` or `backup restore` and is
not resolved by `backup list`. There is no implicit backup identity fallback;
new deployments must configure this field before creating or restoring a
backup.

## zones[].observability

`zones[].observability` opts a managed Hermes zone into common
framework and Tool Portal OpenTelemetry export through the host collector.
Worker zones reject enabled zone observability. Hermes producers use mediated
OTLP HTTP through the controller-configured collector boundary.

Accepted shape:

```jsonc
{
  "zones": [
    {
      "id": "shravan",
      "gateway": { "type": "hermes" },
      "observability": {
        "enabled": true,
        "services": {
          "framework": {
            "logs": true,
            "metrics": true,
            "traces": true,
            "sampleRate": 1,
            "flushIntervalMs": 10000
          },
          "toolPortal": {
            "logs": true,
            "metrics": true,
            "traces": true,
            "sampleRate": 1,
            "flushIntervalMs": 10000
          }
        }
      }
    }
  ]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | required | `true` enables the selected managed framework and common Tool Portal producers. Requires `host.observability.enabled=true`. |
| `services.framework.logs` | `true` | Enables Hermes framework log export. |
| `services.framework.metrics` | `true` | Enables selected framework metric export. |
| `services.framework.traces` | `true` | Enables selected framework trace export. |
| `services.framework.sampleRate` | `1` | Selected framework trace sample rate from 0 to 1. |
| `services.framework.flushIntervalMs` | `10000` | Selected framework exporter flush interval. |
| `services.toolPortal.logs` | `true` | Enables common Tool Portal log export. |
| `services.toolPortal.metrics` | `true` | Enables common Tool Portal metric export. |
| `services.toolPortal.traces` | `true` | Enables common Tool Portal trace export. |
| `services.toolPortal.sampleRate` | `1` | Tool Portal trace sample rate from 0 to 1. |
| `services.toolPortal.flushIntervalMs` | `10000` | Tool Portal exporter flush interval. |
Producer service names are controller-fixed and cannot be authored: Hermes uses
`agent-vm-hermes`, and the common Tool Portal uses `agent-vm-tool-portal`.
Framework and Tool Portal identities
cannot be swapped.

Every producer receives its own fixed source policy
`{ captureContent: false, admitBaggage: false }` and independently applied lossy
admission limits: export batches contain at most 64 records, each signal queues
at most 256 records, and each record is at most 65,536 bytes. The batch bound
must not exceed the queue bound. These safety fields are lifecycle contracts,
not authorable zone fields. Collector scrubbing remains required defense in
depth.

For managed Hermes profiles, `gateway.profileSecretProjectionsByAgent` maps
each declared agent id to explicit profile environment targets and existing
zone secret source names:

```jsonc
{
  "profilesByAgent": {
    "clawfest": "clawfest",
    "beta": "beta"
  },
  "profileSecretProjectionsByAgent": {
    "clawfest": {
      "API_SERVER_KEY": "API_SERVER_KEY_CLAWFEST",
      "DISCORD_BOT_TOKEN": "DISCORD_BOT_TOKEN_CLAWFEST",
      "DISCORD_ALLOW_BOTS": "DISCORD_ALLOW_BOTS_CLAWFEST",
      "DISCORD_BOTS_REQUIRE_INLINE_MENTION": "DISCORD_BOTS_REQUIRE_INLINE_MENTION_CLAWFEST",
      "OPENROUTER_API_KEY": "OPENROUTER_API_KEY_CLAWFEST"
    },
    "beta": {
      "API_SERVER_KEY": "API_SERVER_KEY_BETA",
      "DISCORD_BOT_TOKEN": "DISCORD_BOT_TOKEN_BETA",
      "DISCORD_ALLOW_BOTS": "DISCORD_ALLOW_BOTS_BETA",
      "DISCORD_BOTS_REQUIRE_INLINE_MENTION": "DISCORD_BOTS_REQUIRE_INLINE_MENTION_BETA",
      "OPENROUTER_API_KEY": "OPENROUTER_API_KEY_BETA"
    }
  }
}
```

The outer mapping keys must exactly match both `zones[].agents` and
`profilesByAgent`. Every agent declares exactly one `API_SERVER_KEY` target and
one `DISCORD_BOT_TOKEN` target. Each target is backed by its own distinct
`injection: "env"`, `audience: "gateway"` source. The root listener keeps the
separate reserved source `API_SERVER_KEY`; it cannot be projected into a named
profile or reused as a profile-key source. Hermes v0.20 authenticates
`/p/<profile>/...` with the selected profile's key, while unprefixed root routes
use the root listener key.

Discord remains a raw Gateway exception because the token is used for both HTTP
and WebSocket traffic. Other profile credential targets use Gateway-reaching
`http-mediation` sources, so the assigned profile receives only the opaque
placeholder and the raw provider value remains outside Hermes.

The only additional profile environment targets admitted for Hermes are the
non-credential Discord controls `DISCORD_ALLOW_BOTS` and
`DISCORD_BOTS_REQUIRE_INLINE_MENTION`. Each must name a zone secret with
`injection: "env"` and `audience: "gateway"`; arbitrary profile environment
targets remain rejected. `DISCORD_ALLOW_BOTS` accepts `none` (the safe default),
`mentions` (only bot messages that mention the recipient), or `all`.
`DISCORD_BOTS_REQUIRE_INLINE_MENTION: true` adds a literal inline `@mention`
requirement for bot-authored messages and does not affect human messages.

These controls do not make Hermes bot-to-bot conversations a supported
topology. Upstream Hermes warns that Discord reply pings can satisfy another
bot's mention gate and create an acknowledgement/feedback loop. Keep bot
admission disabled unless a deliberate, bounded validation probe requires it;
any beta probe is validation evidence only, not a supported deployment shape.

The adapter writes each complete target map only into the exact memory-backed
`profiles/<profile>/.env`, removes the transient source variables, and then
starts stock Hermes. Deployment-authored non-secret common policy is the
read-only `config.yaml` selected by `gateway.config`; root/default and named
profile homes remain direct durable `stateDir` RealFS. Preflight rejects
durable root or profile `.env` files and secret-bearing native Hermes
configuration. Agent VM materializes a new named profile's native `config.yaml`
with `platforms.api_server.enabled: false`: the default profile owns Hermes's
single HTTP listener while the shared listener still authenticates the named
profile through its `/p/<profile>/` prefix and profile API key. Existing named
profile configs must carry the same explicit disable; Agent VM rejects an
unmarked config before boot rather than silently rewriting authored bytes.
Remove known legacy files explicitly before starting the zone; do not add
migration or copy-back behavior.

`zones[].gateway.runtimeRootfsSize` optionally requests a minimum runtime root
disk size for the gateway VM, using Gondolin `rootfs.size`. The base image is
not rebuilt for this value; Gondolin grows the writable root disk and runs
`resize2fs` in the guest before startup completes. The guest image must contain
`resize2fs`.

The important path model is:

```text
Hermes durable agent workspaces:
  host derived zoneFilesDir/agents/<agentId>

Tool VM selected work mount:
  guest /workspace -> filtered host zoneFilesDir/agents/<agentId>
  guest /gitdirs/workspace.git -> optional selected runtime Git database
  guest /work -> Tool VM rootfs/COW hot work

The Tool VM root filesystem, including `/work`, is disposable. `/workspace`
and the optional selected Git database survive Tool VM replacement according
to their separate storage policies.
```

Tool VM and gateway startup recovery use host-side TCP listener ownership
checks before signaling recorded QEMU/krun processes. The controller requires
`lsof` on the host for that recovery path. If `lsof` is unavailable and
persisted runtime records need port-owner verification, startup fails with a
clear host dependency error instead of guessing ownership.

## toolVmProfiles

`toolVmProfiles` names the Tool VM runtime profiles available to Hermes zones.
The name is intentionally explicit: these are profiles for disposable Tool VMs,
not Gateway or Hermes framework profiles.

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
`zones[].gateway.backupIdentity`.
Inline `config` on those fields is still
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
`agentAccess` is required, and the Hermes zone must declare at least one
`zones[].agents[].id` so the access rule has an agent set to evaluate. Use
`"all"` to make the mediated placeholder available to every declared Hermes
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

Hermes raw profile environment values are limited to the explicit
`profileSecretProjectionsByAgent` contract. This keeps provider API tokens on
the mediated path by default and makes every raw-env exception visible in
deployment config.

Secret names must be valid environment variable identifiers. This keeps
gateway env-file rendering and runtime placeholder names safe and predictable.

## runtimeAuthHints

Worker zones may declare `runtimeAuthHints` to describe mediated service tokens
to the worker agent. These hints generate worker runtime instructions only; they
do not mount config files and do not expose real secret values. They name the
service, mediated host list, tool names, and placeholder env var so the worker
agent can use normal tooling without guessing which token exists. Hermes zones
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
controller mapping. Hermes Gateway uses it for Tool VM SSH slots.

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
idle timeout. Managed Hermes Tool VM leases use one TTL policy for all agents;
framework scope keys are not part of the Agent VM lease model and cannot change
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
- Hermes profile-secret projections that reference missing sources, reserved
  sources, or forbidden targets.
- Tool VM-reaching mediated secrets without `agentAccess: "all"` or a non-empty
  agent id array.
- Tool VM-reaching mediated secrets in Hermes zones with no declared
  `zones[].agents`.
- Tool VM-reaching mediated secrets whose `agentAccess` array references an
  unknown `zones[].agents[].id`.
- Worker zones declaring `agentAccess`, because Worker zones do not boot Tool
  VMs.
- Mediated secret hosts not declared in `egressHosts` for the same audience.
- WebSocket upgrade hosts not declared in `egressHosts` for the same audience.
- Zones referencing missing gateway image profiles.
- Zone gateway type mismatches against the selected image profile.
- Hermes zones declaring `runtimeAuthHints`.
- Hermes zone observability without `host.observability.enabled=true`.
- Worker zone observability.
- Worker `runtimeAuthHints` referencing missing secrets, non-mediated secrets,
  Tool VM-only secrets, or hosts not listed on the referenced secret.
- Hermes zones without `defaultToolVmProfile`.
- Hermes zones without explicit `agentToolVmProfiles`.
- Worker zones declaring Tool VM profile fields.
- `agentToolVmProfiles` values referencing missing `toolVmProfiles`.
- Tool VM profiles referencing missing Tool VM image profiles.
- Managed MCP Portal configs that fail materialization semantics, including
  missing stdio `networkAccess`, missing provider `secretPolicies`, invalid
  mediated hosts, and generated secret environment-name collisions.
