# OpenClaw Gateway

[Overview](../README.md) > [Architecture](overview.md) > OpenClaw Gateway

How OpenClaw Gateway works — long-running interactive gateway with on-demand tool VMs.

---

## Overview

OpenClaw runs a persistent gateway VM that hosts an interactive chat agent. Tool VMs are created on demand when the agent needs to execute code, and destroyed after use.

```
  External client (Discord / WhatsApp / API)
       |
       v
  +----------------------------------------------------------------+
  | Agent Runtime                                                   |
  |                                                                 |
  |  +---------------------------+                                  |
  |  | Controller :18800         |                                  |
  |  | - secret resolver         |                                  |
  |  | - lease manager           |                                  |
  |  | - TCP pool (port slots)   |                                  |
  |  | - idle reaper (scope TTL) |                                  |
  |  +---------------------------+                                  |
  |       |              |                                          |
  |       v              v (on-demand leases)                       |
  |  +-----------------+  +---------------+  +---------------+      |
  |  | Gateway VM      |  | Tool VM 0     |  | Tool VM 1     |     |
  |  | (Zone 2)        |  | (Zone 3)      |  | (Zone 3)      |     |
  |  | long-running    |  | ephemeral     |  | ephemeral     |     |
  |  | sibling roles:  |  | no raw secrets|  | no raw secrets|     |
  |  | - Tool Portal   |  | /workspace    |  | /workspace    |     |
  |  | - OpenClaw      |  | /work         |  | /work         |     |
  |  +-----------------+  +---------------+  +---------------+      |
  |                        tool-0.vm.host:22  tool-1.vm.host:22     |
  +----------------------------------------------------------------+
```

---

## How OpenClaw Gateway Differs from Agent Worker Gateway

| Concern | Agent Worker Gateway | OpenClaw Gateway |
|---------|--------|----------|
| VM lifecycle | Per-task ephemeral | Long-running gateway + ephemeral tool VMs |
| Who runs inside VM | agent-vm-worker (pipeline) | OpenClaw (chat agent platform) |
| Output | Pull requests | Tool execution results in chat |
| Tool execution | Agent runs commands directly in gateway VM | Agent requests tool VM lease, runs code there |
| VFS mounts | `/state` plus task `/gitdirs`; `/work/repos` is rootfs/COW target | `/config`, `/cache`, `/state`, zone files at `/zone` |
| TCP hosts | Controller only | Controller + all tool VM SSH ports |
| Auth | None | Auth profiles (1Password → disk → VFS) |
| prepareHostState | None | Writes effective config + auth profiles |
| Startup service check | `GET /health` | `GET /health` |
| Explicit readiness check | `GET /health` | `GET /readyz` |
| Service liveness check | `GET /health` | `GET /health` |

See [overview.md](overview.md#gateway-lifecycle-contract) for the GatewayLifecycle interface that both gateways implement.

---

## Gateway VM Lifecycle

The Gateway VM boots at controller startup and stays running. It is NOT
per-task. The selected managed image owns an exact two-role boot contract: one
common Tool Portal service process and one OpenClaw framework service process.
They start as siblings under guest root for address-space, event-loop, and crash
isolation. Neither launches, parents, supervises, restarts, or adopts the other.

```
  controller start
       |
       v
  1. Non-destructive runtime ownership preflight
  2. Preflight Gateway start:
     - Resolve and cache all gateway/startup secrets
     - Preflight protected framework and Tool Portal inputs
     - Validate OpenClaw Tool VM requirements
  3. Build/preselect gateway image (cached by fingerprint)
  4. Clean owned orphan Tool VMs and gateway runtime, if present
  5. prepareHostState using preflight-cached secrets:
     - Write effective-openclaw.json (env SecretRef for gateway token)
     - Write per-agent auth-profiles.json files from configured sources
  6. Materialize immutable Tool Portal and OpenClaw boot inputs
  7. buildVmRequirements → GatewayVmRequirements (mounts, TCP pool, env)
  8. injected ManagedVmFactory.createManagedVm → backend-neutral ManagedVm
  9. ManagedVm.start() boots the selected image
  10. Image boot starts the Tool Portal and OpenClaw sibling roles concurrently
  11. Join Tool Portal evidence/UDS readiness with OpenClaw HTTP readiness
  12. Enable only the admitted framework root and controller control routes
```

The controller prepares the image and immutable inputs, starts the VM, and
derives aggregate readiness. It does not use `ManagedVm.exec()` or another guest
process API to start either sibling.

The Gateway stays alive until `controller stop`, `controller destroy`, sibling
process exit, or automatic Gateway VM recovery. Either sibling's death or
unrecoverable readiness failure retires the whole Gateway epoch; there is no
same-VM process successor or supervisor. Gateway VM recovery either restarts a
known running Gateway VM or cold-starts a failed/stopped Gateway when current
ownership checks prove it is safe. For running-Gateway recovery, the controller
releases that zone's Tool VM leases, restarts the Gateway VM, verifies the VM id
changed, and records a `gateway-recovery` health event. For cold-start recovery,
the controller verifies that the old record/port state is safe before creating a
new Gateway. The default Gateway-recovery budget has a 61 minute per-zone
cooldown. After 3 consecutive failed automatic recovery attempts, the controller
records `gateway-recovery-suspended` and pauses auto-recovery for that zone until
the failed-recovery reset window expires.

OpenClaw/provider details stay below the plugin boundary. The plugin may publish
generic `agent-channel-provider-health` events with redacted details such as a
provider type or status code, but controller recovery branches only on
`healthy`, `transitioning`, `unhealthy-recoverable`, and
`unhealthy-unrecoverable`. Recoverable channel-provider failures degrade
readiness/status by default and feed gateway recovery only when policy
explicitly enables `restartGatewayOnRecoverable`; unrecoverable provider
failures are surfaced for diagnosis and do not restart the gateway by default.

Gateway ingress has two different ports in play. `processSpec.guestListenPort`
is the OpenClaw HTTP/WebSocket port inside the VM. `zones[].gateway.port` is the
host-facing Gondolin ingress listener. After service liveness, agent-vm writes
one Gondolin route, `/` to `processSpec.guestListenPort`, then enables ingress
on `zones[].gateway.port`. OpenClaw readiness can still be degraded after
ingress when a channel/provider is unavailable.

That single route is the OpenClaw serving surface. The Control UI, gateway
WebSocket, `/healthz`, `/readyz`, `/v1/chat/completions`, `/v1/responses`, and
plugin HTTP routes all pass through it. SSE streaming depends on Gondolin
forwarding response chunks incrementally; agent-vm keeps response buffering
disabled for gateway ingress and exposes timeout knobs under
`zones[].gateway.ingress`.

Serving another guest HTTP service, such as a preview server or sidecar
dashboard, is a separate ingress-route design. It should add explicit non-root
path-prefix routes to guest ports instead of changing rootfs size or treating
OpenClaw config as a host port mapper. Raw TCP services use `tcpHosts`, not
HTTP ingress.

For the full 15-step boot sequence, see [overview.md](overview.md#gateway-zone-orchestrator).
For the lifecycle implementation, see [subsystems/gateway-lifecycle.md](../subsystems/gateway-lifecycle.md#openclaw-implementation).
For storage boundaries, see [storage-model.md](storage-model.md).

---

## OpenClaw Plugin Runtime Deps And Zone Data

Target state: stable bundled OpenClaw plugin runtime dependencies are baked into
the gateway image/rootfs and exposed through `OPENCLAW_PLUGIN_STAGE_DIR`:

```text
guest:
  /opt/openclaw/plugin-runtime-deps
```

`cacheDir` may still hold repair/download caches, but it is not the normal hot
import path and is not included in encrypted zone backups. Durable OpenClaw
state and auth profiles remain under `stateDir`.

The OpenClaw VM path `/zone` is long-lived zone files, not worker-style hot
execution storage. This storage is RealFS-mounted and backed up. The controller
derives `zoneFilesDir` as `<storageRootDir>/<zoneId>/zone-files`; each configured
agent owns a durable child at `zoneFilesDir/agents/<agentId>`. OpenClaw's native
`workspaceDir` is identity evidence at the plugin boundary, not a controller
mount-path input.

---

## Tool VM Leases

The controller remains the durable Tool VM lease authority. The common Tool
Portal service owns the current-epoch binding, active-use, strict SSH, and
Sandbox runtime inside the Gateway VM. OpenClaw does not receive a lease, Tool
VM identity, or SSH material: its thin adapter sends authenticated Sandbox API
requests over the private UDS and receives API results.

### Lease Lifecycle

```
  OpenClaw agent: "I need to run this code"
       |
       v
  OpenClaw adapter authenticates the native agent
       |
       v  private UDS: GatewayRuntimeClient.sandbox.*
  Tool Portal service
       |-- validates the controller-authored ManagedAgentProjection
       |-- resolves only this agent's current binding
       |-- owns active-use and strict SSH lifecycle
       |
       v  private controller control path
  Controller lease authority
       |
       |  1. Resolve trusted Tool VM profile and storage
       |  2. Reuse only a compatible current agent lease
       |  3. Probe existing VM; replace an unhealthy lease
       |  4. Allocate one TCP slot
       |  5. Create ManagedVm with /workspace, /work, optional /gitdirs, /agent-vm
       |  6. Publish the agent-specific binding and pinned SSH access
       v
  Tool Portal service establishes and maintains that agent's SSH connection
       |
       v
  Execute the requested shell/file/process/stream operation in the Tool VM
       |
       v
  Return canonical Sandbox API results over the private UDS
       |
  v  (lease idle TTL; default 100 minutes)
  Idle reaper: releaseLease()
       |  1. vm.close() → tool VM destroyed
       |  2. tcpPool.release(slot) → port freed
```

### Agent-Based Reuse

Managed OpenClaw/Gondolin Tool VM leases are agent-keyed. The controller
creates or reuses one compatible Tool VM per `zoneId + agentId`. OpenClaw
scope keys are framework-boundary SDK context only. The adapter authenticates a
native agent and sends a trusted invocation context over UDS; it does not send
lease or host-path authority to the controller.

If the same agent already has an active lease, it is reused only when its
controller-derived profile assignment and storage policy fingerprint still
match. A mismatch is treated as a caller conflict, not as a new Tool VM. Before
reuse, the controller probes the VM; an unhealthy lease is unrouted and
replaced. This lets one agent's Tool VM persist across calls, channels,
sessions, or subagents without crossing stable-agent or storage boundaries.

The Tool Portal service renews an idle reusable binding over its private
controller relationship; health snapshots call this `lease-renew`.
Operator-visible lease summaries come from controller status and health snapshot
routes, not from a public lease-list route. In-flight Sandbox API and
Tool-VM-backed Capability API operations are tracked separately as active uses;
health snapshots call active-use heartbeat a `lease-heartbeat`.
Successful lease-heartbeats and lease-renews both keep lease state alive, but
they diagnose different boundaries. A lease-heartbeat means an active operation
is still alive. A lease-renew means an idle cached lease is being reused. This
distinction matters when debugging control-session timeouts versus stale Tool VM
SSH state. Because active uses are tracked separately, a
long-running SSH command keeps the Tool VM protected from idle reap without
making the controller a stdout/stderr data proxy. If a framework client
disappears before final cleanup, the UDS request and service-owned active-use
lifecycle still have bounded retirement; the controller can mark an abandoned
use stale and the normal idle reaper can release the lease later.

If the Tool Portal service observes stale SSH or binding evidence, it retires
the old agent-specific binding before later operations may use it and asks the
controller for a current replacement. The controller re-resolves the caller,
old-binding authority, session fence, workspace, profile, and agent ownership
before publishing replacement access. Old lease and SSH identities remain
correlation evidence only; framework adapters never receive or reuse them.

The Gateway Runtime Sandbox API owns environment, execution, filesystem,
process, stream, and terminal operations. The OpenClaw adapter translates native
SandboxBackend calls to those typed UDS methods; the Tool Portal service performs
the SSH work. The controller does not expose a generic filesystem RPC for Tool
VMs and does not proxy command stdout/stderr.

Every live Tool VM gets a unique ephemeral Ed25519 SSH server key. Gondolin
forces `sshd` to use that key and returns only its public identity. The
controller binds it to the Gateway-visible `tool-<slot>.vm.host` alias and
includes that exact `known_hosts` line in the service-private binding. The Tool
Portal service uses it for strict host-key checking. Missing or malformed server
identity fails binding admission closed; neither managed API uses TOFU or a
permissive host-key fallback.

During the Socket.IO control-plane hard cutover, managed OpenClaw zones may
declare multiple trusted agents in the same gateway zone. Caller-context
registration accepts only declared agents and binds the declared `agentId` to
the framework-native identity, agent workspace, Tool Portal profile, and active
Gateway/attachment epoch. The Tool Portal service validates that projected
identity before binding acquisition. The controller checks the zone's
`agentToolVmProfiles[agentId]`
mapping first and falls back to `defaultToolVmProfile`; cross-agent workspace,
profile, or generation evidence fails closed instead of collapsing the zone to
one agent.

For Tool VM-mediated service tokens, the controller filters zone secrets by the
requesting declared `agentId` and each secret's `agentAccess` before resolving
refs. `agentAccess: "all"` is the explicit all-declared-agents case; arrays such
as `["sun"]` keep a mediated placeholder out of other agents' Tool VMs and avoid
resolving that secret for their leases. For `audience: "both"`, the rule scopes
only the Tool VM side; gateway mediation is still zone-wide.

Before the first Tool VM boot for an agent-scoped sandbox work mount, the
controller can seed configured files such as `.config/gcloud/...` into that
sandbox's `/work` backing directory. Seeds are first-boot only and do not
overwrite files that already exist.

The controller reports incompatible reuse as a typed conflict through the
private control path; the Tool Portal service returns a typed managed operation
failure over UDS. No managed lease HTTP API is exposed to the framework.

### TCP Pool

Each tool VM gets a TCP port slot. The gateway VM reaches tool VMs via Gondolin synthetic DNS:

```
  Slot 0  →  127.0.0.1:19000  →  tool-0.vm.host:22 (inside gateway)
  Slot 1  →  127.0.0.1:19001  →  tool-1.vm.host:22
  ...
  Slot N  →  127.0.0.1:{basePort+N}
```

Pool size is configured in `systemConfig.tcpPool.size`.

For implementation details, see [subsystems/controller.md](../subsystems/controller.md#lease-manager).

---

## Tool Portal Native Tools

Managed OpenClaw gateway images install the common Gateway Runtime service and
the thin OpenClaw adapter. The adapter registers native OpenClaw tools for
`tool_portal_list`, `tool_portal_search`, `tool_portal_describe`, and
`tool_portal_call`, then forwards them through its one `GatewayRuntimeClient`
over the private UDS.

Tool Portal is the managed model-visible capability surface. Gateway Runtime
composes the reusable MCP-provider backend for MCP-backed namespaces. Managed
OpenClaw must not expose a second native `mcp_portal_*` model tool surface for
the same capabilities.

For managed Gateway policy, operators author `mcp.config.jsonc` and
`tool-portal.config.jsonc`. At gateway startup, agent-vm materializes effective
provider and Tool Portal config under the gateway cache directory. The gateway
VM receives environment references and runtime-mediated secret bindings, not
1Password credentials.

The MCP-provider backend runtime is an upstream MCP client aggregator. It
connects to operator-configured MCP servers from `mcp.config.jsonc`, keeps
upstream auth and transport details out of Tool VMs and model-visible tool
inputs, and normalizes upstream progress into adapter-neutral events. OpenClaw
receives progress through the native tool `onUpdate` callback and receives one
final tool result.

One service-wide ToolPortalService and MCP-provider runtime serve all agents in
the zone. Each complete profile in `tool-portal.config.jsonc` owns `namespaces`
with explicit `backend.kind` and call/tool selectors. Trusted invocation context
selects the agent assignment and profile per call; it does not select or create
a per-agent backend instance. Denied namespaces and tools are excluded from that
invocation's catalog and search view.

Managed mode exposes two distinct APIs through the same authenticated private
UDS connection:

- **Capability API**: `portal.list`, `portal.search`, `portal.describe`, and
  `portal.call`. Calls select `{ namespace, name, arguments }`, then
  ToolPortalService applies visibility, call policy, approval, and exactly one
  configured backend. A `tool_vm_runner` backend may execute in the current
  agent's Tool VM.
- **SSH Sandbox API**: direct environment, execution, filesystem, process,
  stream, and terminal operations for OpenClaw's SandboxBackend. It does not do
  capability-catalog lookup or per-command capability approval.

Both paths may converge on the same agent-specific Tool VM binding and
service-owned SSH connection only after their distinct admission. The managed
service exposes no framework-facing HTTP, MCP, stdio, or public ingress
listener. Standalone Tool Portal is the mode that may explicitly configure
HTTP/MCP/stdio entrypoints; it has no managed controller, binding, SSH, or
Sandbox API authority in version 1.

A `controller_execution` configured CLI with an
`ephemeral_managed_vm` target does not converge on that Tool VM. It sends one
independently authorized controller RPC to the per-agent credentialed runtime
manager, which executes direct array argv in its own reusable Managed VM.
`tool_vm_runner` and the Sandbox API remain on the leased Tool VM strict-SSH
path. See [Credentialed Managed Runtimes](credentialed-runtimes.md).

Managed `calls.requiresApproval` enters the controller-owned approval authority,
which binds the trusted principal and exact call before dispatch. Any managed
profile that effectively admits an approval-required tool requires zone
`approvalAccess`; static validation and gateway preflight fail closed when it is
absent. Standalone MCP Portal is a separate mode: external clients use
`mcp.config.jsonc` plus `mcp-portal.config.jsonc`, and the `mcp-portal mcp-proxy
serve` adapter owns its bearer and HMAC behavior. Managed Gateway policy never
consumes that standalone auth material as authority.

OpenClaw has no managed-Gateway native approval presenter in this release.
An OpenClaw zone rejects `approvalAccess` because the sole supported authority
is `kind: "managed_gateway"`. Hermes is the sole native presenter
implementation, and the controller exposes no external approval HTTP surface.

See [MCP Portal](../subsystems/mcp-portal.md) for the portal API, schema,
approval, and redaction model.

---

## Sandbox Plugin (openclaw-agent-vm-plugin)

The `openclaw-agent-vm-plugin` package is a thin bridge from OpenClaw's native
sandbox system to the common Gateway Runtime service.

```
  OpenClaw SDK
       |
       | Discovers plugin (id: 'gondolin')
       v
  openclaw-agent-vm-plugin
       |
       | Registers as sandbox backend and connects one GatewayRuntimeClient
       v
  When agent needs tool execution:
       |
       | 1. Authenticate the native OpenClaw agent
       | 2. Select its immutable ManagedAgentProjection
       | 3. Send typed sandbox.* requests over the private UDS
       v
  Tool Portal service
       | owns binding / active use / strict SSH / Sandbox runtime
       v
  Current agent-specific Tool VM
```

The plugin provides:
- **Identity adaptation**: authenticate an OpenClaw agent and attach its
  controller-authored projection to each request.
- **File bridge adaptation**: translate OpenClaw file operations to typed
  `sandbox.fs.*` UDS calls.
- **Shell adaptation**: translate OpenClaw shell/process behavior to typed
  environment, execution, stream, and terminal UDS calls.
- **Workspace access**: the controller binds the authenticated OpenClaw agent to
  its configured filtered durable workspace at `/workspace` and optional
  workspace Git database at `/gitdirs/workspace.git`. `/work` is rootfs/COW
  execution space and the default command cwd; it is lost when the Tool VM is
  closed or replaced.

The plugin does not host ToolPortalService, request or cache leases, hold SSH
keys, establish SSH connections, track active uses, select Tool VMs, or own
replacement. Those mechanics stay inside the Tool Portal service and
controller.

The OpenClaw plugin normalizes workspace/cwd intent before calling the
controller. Known Tool VM guest paths are ordinary in-guest intent:
`/workspace` is durable agent-owned content and `/work` is disposable hot work.
OpenClaw SDK `workspaceDir` authenticates the configured agent only; it is
translated at the plugin boundary and never becomes host-path authority.

The controller remains the storage authority. It derives the selected
`zoneFilesDir/agents/<agentId>` source and optional `zoneRuntimeDir` Git database
from trusted configuration, constructs the filtered provider, and boots the Tool
VM without accepting a caller-supplied host or Gateway mount path.

OpenClaw SDK compatibility note: OpenClaw currently names the selected sandbox
path `workspaceDir`. The agent-vm plugin validates it as native identity
evidence and sends only trusted invocation context with private UDS requests.

---

## Auth Profiles

OAuth tokens for model providers are written as OpenClaw auth profiles before
the gateway VM boots. Prefer `zone.gateway.authProfilesByAgent` for current
deployments: each configured agent gets its own
`<stateDir>/agents/<agentId>/agent/auth-profiles.json`.

`zone.gateway.authProfilesRef` is still accepted as a legacy/shared fallback
for older single-agent deployments. It writes one profile file for the `main`
agent only and should not be used for new per-agent setups.

```
  zone.gateway.authProfilesByAgent[agentId] (1Password or environment secret)
       |
       v
  prepareHostState: secretResolver.resolve(ref)
       |
       v
  Write auth-profiles.json to host stateDir/agents/<agentId>/agent/ (mode 0600)
       |
       v
  VM reads via VFS mount of stateDir
```

For the full auth profile flow, see [subsystems/secrets-and-credentials.md](../subsystems/secrets-and-credentials.md#auth-profiles).

---

## WebSocket Upgrades

Discord and other channel clients use normal WebSocket connections through
Gondolin's HTTP upgrade bridge. Deployment config grants that path with
`egressHosts` plus `websocketUpgrades`; it does not create raw TCP pass-through
entries for public WebSocket gateways.

```json
"websocketUpgrades": [
  {
    "audience": "gateway",
    "scheme": "wss",
    "host": "gateway.discord.gg",
    "port": 443,
    "path": "/"
  },
  {
    "audience": "gateway",
    "scheme": "wss",
    "host": "gateway-*.discord.gg",
    "port": 443,
    "path": "/"
  }
]
```

Wildcard destination authority still belongs in `egressHosts` (`*.discord.gg`,
`*.discord.com`, `*.discord.media`, `*.discordapp.com`,
`*.discordapp.net`). `websocketUpgrades` is narrower: it authorizes selected
upgrade URLs for the gateway or Tool VM audience, and every upgrade host must
also be declared in `egressHosts`.

Raw `tcpHosts` remain internal plumbing for Tool VM SSH slots and explicit host
services such as resource endpoints. Managed gateway/controller control uses
Gondolin ingress plus the private Socket.IO control session, not raw controller
callbacks. Raw `tcpHosts` are not a deployment-level WebSocket escape hatch.

---

## Zone Operations

The controller exposes operations for managing the OpenClaw Gateway:

| Operation | Endpoint | What it does |
|-----------|----------|-------------|
| Status | `GET /controller-status` | System config and zone health |
| Health | `GET /zones/:id/health` | Live gateway health probe from inside the VM |
| Health snapshot | `GET /zones/:id/health-snapshot` | In-memory zone health state derived from controller, gateway, channel-provider, lease, and Tool VM SSH events |
| Logs | `GET /zones/:id/logs` | Gateway boot log plus OpenClaw runtime log tail from `/agent-vm/logs` in the VM |
| Credentials | `POST /zones/:id/credentials/refresh` | Re-resolve secrets, restart gateway |
| Destroy | `POST /zones/:id/destroy` | Stop gateway, release leases, purge state |
| Upgrade | `POST /zones/:id/upgrade` | Rebuild image, restart gateway |
| SSH | `POST /zones/:id/enable-ssh` | SSH access to gateway VM |
| Exec | `POST /zones/:id/execute-command` | Run command in gateway VM after zone admin authorization when configured |

For OpenClaw zones, startup waits on `/health` service liveness. Explicit
`GET /zones/:id/health` uses `/readyz`, which includes application readiness.
Explicit `GET /zones/:id/service-health` and the controller's periodic
gateway-service monitor use `/health` as service liveness so channel/provider
readiness degradation does not by itself classify the VM process as dead.

For implementation details, see [subsystems/controller.md](../subsystems/controller.md#operations).

The OpenClaw application heartbeat is not the same thing as infrastructure
health. A scheduled OpenClaw agent turn can prove that OpenClaw app logic ran,
but it does not by itself prove that the gateway-to-agent-vm-controller link,
channel-provider communication path, lease-heartbeat path, lease-renew path, or
Tool VM SSH path is healthy.

---

## Source File Map

| Package | File | Responsibility |
|---------|------|---------------|
| gateway-runtime | `production/gateway-runtime-production-service.ts` | One ToolPortalService host, private UDS, controller relationship, binding/SSH/Sandbox ownership |
| gateway-lifecycle | `managed-gateway-boot-contract.ts` | Exact Tool Portal plus selected framework sibling boot contract |
| openclaw-gateway | `openclaw-lifecycle.ts` | OpenClaw VM/process requirements and protected framework inputs |
| openclaw-agent-vm-plugin | `openclaw-plugin-registration.ts` | Thin plugin discovery, native tools, one UDS client |
| openclaw-agent-vm-plugin | `gateway-runtime-sandbox-backend.ts` | OpenClaw SandboxBackend-to-GatewayRuntimeClient adaptation |
| agent-vm | `controller-runtime-operations.ts` | Zone operations (destroy, upgrade, logs, etc.) |
| agent-vm | `leases/lease-manager.ts` | Lease CRUD, VM creation, cleanup |
| agent-vm | `leases/tcp-pool.ts` | Port slot allocation |
| agent-vm | `leases/idle-reaper.ts` | TTL-based lease expiration |
