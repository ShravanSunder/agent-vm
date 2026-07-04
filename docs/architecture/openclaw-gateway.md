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
  |  | OpenClaw :18789 |  | no raw secrets|  | no raw secrets|     |
  |  | 4 VFS mounts    |  | no network    |  | no network    |     |
  |  | TCP to all tools|  | /workspace    |  | /workspace    |     |
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

The gateway VM boots at controller startup and stays running. It is NOT per-task.

```
  controller start
       |
       v
  1. Non-destructive runtime ownership preflight
  2. Preflight gateway start:
     - Resolve and cache all gateway/startup secrets
     - Preflight effective-openclaw.json and auth-profile writes
     - Preflight MCP Portal effective config materialization
     - Validate OpenClaw Tool VM requirements
  3. Build/preselect gateway image (cached by fingerprint)
  4. Clean owned orphan Tool VMs and gateway runtime, if present
  5. prepareHostState using preflight-cached secrets:
     - Write effective-openclaw.json (env SecretRef for gateway token)
     - Write per-agent auth-profiles.json files from configured sources
  6. buildVmSpec → GatewayVmSpec (4 mounts, TCP pool, env)
  7. buildProcessSpec → bootstrap + start commands
  8. createManagedVm → Gondolin VM
  9. Bootstrap: write shell/admin profiles and runtime secret env files
  10. Start: source runtime secrets, then run openclaw gateway --port 18789
  11. Wait for service liveness check (GET /health on :18789)
  12. Enable ingress
```

The gateway stays alive until `controller stop`, `controller destroy`, process
exit, or automatic gateway VM recovery. Recovery has two infrastructure actions:
restart a known running gateway VM, or cold-start a failed/stopped gateway when
current ownership checks prove it is safe. For running-gateway recovery, the
controller force releases that zone's Tool VM leases, restarts the gateway VM,
verifies the VM id changed, and records a `gateway-recovery` health event. For
cold-start recovery, the controller verifies that the old record/port state is
safe before creating a new gateway. The default trigger is 10 consecutive
degraded observations with a 61 minute per-zone cooldown. After 3 consecutive
failed automatic recovery attempts, the controller records
`gateway-recovery-suspended` and pauses auto-recovery for that zone until the
failed-recovery reset window expires.

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

The OpenClaw VM path `/zone` is long-lived zone files, not
worker-style hot execution storage. This storage is RealFS-mounted and backed
up. The host-side config field is `zoneFilesDir`; there is no static
`workspaceDir` field in `system.json`. The runtime lease equivalent is
`workMountDir`, selected dynamically for each Tool VM lease.

---

## Tool VM Leases

When the agent needs to execute code, OpenClaw requests a Tool VM capability
from the managed Gondolin plugin. The controller owns lease authority and talks
to the gateway plugin over the private Socket.IO control session exposed through
Gondolin ingress.

### Lease Lifecycle

```
  OpenClaw agent: "I need to run this code"
       |
       v
  plugin emits gateway_control_rpc lease_create {
    opaque caller context,
    profileId,
    agentWorkspaceDir,
    workMountDir: "/zone/..."
  }
       |
       v
  Controller: lease-manager.createLease()
       |
       |  1. Translate workMountDir from gateway path to trusted hostWorkMountDir
       |  2. Reuse same agent only if profileId, hostWorkMountDir, and
       |     agentWorkspaceDir match
       |  3. Probe existing VM; evict stale leases
       |  4. tcpPool.allocate() → slot 0 (port 19000)
       |  5. createManagedVm() → boot tool VM
       |  6. vm.enableSsh() → SSH access ready
       |  7. Store lease record
       v
  Response: { leaseId, ssh: { host, port: 19000, user, identityFile } }
       |
       v
  Gateway uses SSH directly to execute code in tool VM
       |
       |-- gateway_control_rpc lease_use_start before command or file-bridge script
       |-- gateway_control_rpc lease_use_heartbeat while it runs
       |-- gateway_control_rpc lease_use_end when it finishes
       |
  v  (lease idle TTL; default 100 minutes)
  Idle reaper: releaseLease()
       |  1. vm.close() → tool VM destroyed
       |  2. tcpPool.release(slot) → port freed
```

### Agent-Based Reuse

Managed OpenClaw/Gondolin Tool VM leases are agent-keyed. The controller
creates or reuses one compatible Tool VM per `zoneId + agentId`. OpenClaw
scope keys are plugin-boundary SDK context only: the plugin may receive them
from OpenClaw core, but does not send them to the controller, and the
controller does not store, return, log, or derive TTL from them.

If the same agent already has an active lease, it is reused only when
`profileId`, `hostWorkMountDir`, and `agentWorkspaceDir` also match. A mismatch
is treated as a caller conflict, not as a new tool VM. Before reuse, the
controller probes the VM; dead leases are evicted and replaced. This means an
agent's Tool VM persists across multiple tool calls, channels, sessions, or
subagents without silently crossing work mount or profile boundaries.

Cached handles renew the idle lease over `gateway_control_rpc`; health snapshots
call this `lease-renew`. Operator-visible lease summaries come from controller
status and health snapshot routes, not from a public lease-list route.
VM-facing lease mutation/read routes are not part of the managed control path.
In-flight commands and file-bridge operations are tracked separately as active
uses; health snapshots call active-use heartbeat a `lease-heartbeat`.
Successful lease-heartbeats and lease-renews both keep lease state alive, but
they diagnose different boundaries. A lease-heartbeat means an active operation
is still alive. A lease-renew means an idle cached lease is being reused. This
distinction matters when debugging control-session timeouts versus stale Tool VM
SSH state. Because active uses are tracked separately, a
long-running SSH command keeps the Tool VM protected from idle reap without
making the controller a stdout/stderr data proxy. If a plugin misses its final
cleanup callback, plugin heartbeats stop after a finite safety cap (12 hours by
default); the controller then marks the use stale after the heartbeat window and
the normal idle reaper can release the lease later.

The shared agent-vm lease type exposes only an SSH capability: lease id,
workdir, TCP slot, and endpoint/key material. The OpenClaw filesystem bridge is
adapter behavior inside `@agent-vm/openclaw-agent-vm-plugin`; it translates
OpenClaw's sandbox file API into remote shell scripts over that SSH lease. The
controller does not expose a generic filesystem RPC for Tool VMs and does not
proxy command stdout/stderr.

The controller first checks the zone's `agentToolVmProfiles[agentId]` mapping.
If no agent-specific mapping exists, it falls back to the zone's
`defaultToolVmProfile`. This lets one OpenClaw zone serve multiple agents with
different Tool VM images while keeping the gateway and durable `/zone` namespace
shared.

For Tool VM-mediated service tokens, the controller filters zone secrets by the
requesting declared `agentId` and each secret's `agentAccess` before resolving
refs. `agentAccess: "all"` is the explicit all-declared-agents case; arrays such
as `["sun"]` keep a mediated placeholder out of other agents' Tool VMs and avoid
resolving that secret for their leases. For `audience: "both"`, the rule scopes
only the Tool VM side; gateway mediation is still zone-wide.

Before the first Tool VM boot for an agent-scoped sandbox work mount, the
controller can seed configured files such as `.config/gcloud/...` into that
sandbox's `/workspace` backing directory. Seeds are first-boot only and do not
overwrite files that already exist.

The controller reports reuse conflicts as `AgentLeaseCompatibilityConflictError`,
surfaced through the lease route as HTTP 409. The message names the zone,
`agentId`, and the mismatched field so operators can distinguish a caller bug
from VM capacity or startup failure.

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

Managed OpenClaw gateway images install the Gondolin plugin and Tool Portal
packages. The plugin registers native OpenClaw tools for `tool_portal_list`,
`tool_portal_search`, `tool_portal_describe`, and `tool_portal_call`.

Tool Portal is the managed model-visible capability surface. MCP Portal remains
the MCP-specific provider backend for MCP-backed capabilities and the standalone
MCP proxy surface for deployments that explicitly choose it outside managed
OpenClaw. Managed OpenClaw must not expose a second native `mcp_portal_*` model
tool surface for the same capabilities.

At gateway startup, agent-vm materializes effective MCP Portal configs under the
gateway cache directory and points the plugin at that effective config
directory. The authored config stays in the deployment repo; the gateway VM
receives effective config with environment references and runtime-mediated secret
bindings. The gateway VM does not receive 1Password credentials.

The portal core is an upstream MCP client aggregator. It connects to
operator-configured MCP servers from `mcp.config.jsonc`, keeps upstream auth and
transport details out of Tool VMs and model-visible tool inputs, and normalizes
upstream progress into adapter-neutral events. OpenClaw receives progress through
the native tool `onUpdate` callback and receives one final tool result.

Each agent profile from `mcp-portal.config.jsonc` owns its allowed namespace and
tool policy. The resulting agent scope owns upstream MCP clients, catalog, and
search index. Denied tools are excluded before catalog and search index
construction rather than post-filtered from a global index.

The plugin still participates in the agent loop. It injects prompt context before
prompt construction and gates portal calls before tool execution. OpenClaw's
trusted hook result is the approval boundary for managed native tools; external
MCP clients use the separate `mcp-portal mcp-proxy serve` adapter and its bearer
auth.

See [MCP Portal](../subsystems/mcp-portal.md) for the portal API, schema,
approval, and redaction model.

---

## Sandbox Plugin (openclaw-agent-vm-plugin)

The `openclaw-agent-vm-plugin` package bridges OpenClaw's sandbox system to Gondolin VMs.

```
  OpenClaw SDK
       |
       | Discovers plugin (id: 'gondolin')
       v
  openclaw-agent-vm-plugin
       |
       | Registers as sandbox backend
       v
  When agent needs tool execution:
       |
       | 1. Request lease from controller
       | 2. Get SSH access to tool VM
       | 3. Start active-use records for shell and file-bridge operations
       | 4. Provide file bridge (read/write via SSH)
       | 5. Provide shell execution (commands via SSH)
       | 6. End active-use records on finalize/command completion
       v
  Tool VM: runs agent-generated code safely
```

The plugin provides:
- **File bridge**: `mkdirp`, `readFile`, `writeFile`, `stat`, `remove`, `rename` — all via SSH into the tool VM
- **Shell execution**: run arbitrary commands in the tool VM
- **Active-use tracking**: every shell command and file-bridge script opens a
  controller active-use record and heartbeats it while the SSH operation is
  pending, so the controller can reap stale leases without proxying command
  output.
- **Work mount access**: tool VMs use `/workspace` for lease-local RealFS
  execution; `/work` remains VM-local rootfs/COW scratch.
  Lease requests provide `workMountDir` as a concrete OpenClaw gateway child
  path under `/home/openclaw/.openclaw/state/sandboxes` or `/zone`; the roots
  themselves are validation boundaries, and the controller rejects them as mount
  targets.
  The controller maps that gateway path to `hostWorkMountDir`, verifies the
  real path is inside either `stateDir/sandboxes` or `zoneFilesDir`, and mounts
  non-zone-git work mounts into the Tool VM at `/workspace`.

The OpenClaw plugin normalizes workspace/cwd intent before calling the
controller. Known Tool VM guest paths are allowed as intent: `/workspace` maps
to the mounted agent workspace, while `/work` stays Tool VM rootfs/COW scratch.
The plugin sends the controller only the lease mount source and keeps the
effective guest cwd on the backend handle for SSH execution.

The controller remains the security boundary for host mounts. It accepts
controller-supported OpenClaw gateway paths such as `/zone/<child>` and
`/home/openclaw/.openclaw/state/sandboxes/<child>`, translates them to host
paths, and proves the resolved path is inside the configured allowed roots
before booting a Tool VM.

OpenClaw SDK compatibility note: OpenClaw currently names the selected sandbox
path `workspaceDir`. The agent-vm plugin translates that field to
`workMountDir` before calling the controller.

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
| openclaw-gateway | `openclaw-lifecycle.ts` | buildVmSpec, buildProcessSpec, prepareHostState, authConfig |
| openclaw-agent-vm-plugin | `openclaw-plugin-registration.ts` | Plugin discovery, sandbox backend factory |
| openclaw-agent-vm-plugin | `sandbox-backend-contract.ts` | File bridge, shell execution interface |
| agent-vm | `controller-runtime-operations.ts` | Zone operations (destroy, upgrade, logs, etc.) |
| agent-vm | `leases/lease-manager.ts` | Lease CRUD, VM creation, cleanup |
| agent-vm | `leases/tcp-pool.ts` | Port slot allocation |
| agent-vm | `leases/idle-reaper.ts` | TTL-based lease expiration |
