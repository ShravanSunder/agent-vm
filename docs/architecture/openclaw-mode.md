# OpenClaw Mode

[Overview](../README.md) > [Architecture](overview.md) > OpenClaw Mode

How OpenClaw mode works — long-running interactive gateway with on-demand tool VMs.

---

## Overview

OpenClaw runs a persistent gateway VM that hosts an interactive chat agent. Tool VMs are created on demand when the agent needs to execute code, and destroyed after use.

```
  Delegator (Discord / WhatsApp / API)
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
  |  | - idle reaper (30min TTL) |                                  |
  |  +---------------------------+                                  |
  |       |              |                                          |
  |       v              v (on-demand leases)                       |
  |  +-----------------+  +---------------+  +---------------+      |
  |  | Gateway VM      |  | Tool VM 0     |  | Tool VM 1     |     |
  |  | (Zone 2)        |  | (Zone 3)      |  | (Zone 3)      |     |
  |  | long-running    |  | ephemeral     |  | ephemeral     |     |
  |  | OpenClaw :18789 |  | no secrets    |  | no secrets    |     |
  |  | 3 VFS mounts    |  | no network    |  | no network    |     |
  |  | TCP to all tools|  | /workspace    |  | /workspace    |     |
  |  +-----------------+  +---------------+  +---------------+      |
  |                        tool-0.vm.host:22  tool-1.vm.host:22     |
  +----------------------------------------------------------------+
```

---

## How OpenClaw Differs from Worker

| Concern | Worker | OpenClaw |
|---------|--------|----------|
| VM lifecycle | Per-task ephemeral | Long-running gateway + ephemeral tool VMs |
| Who runs inside VM | agent-vm-worker (pipeline) | OpenClaw (chat agent platform) |
| Output | Pull requests | Tool execution results in chat |
| Tool execution | Agent runs commands directly in gateway VM | Agent requests tool VM lease, runs code there |
| VFS mounts | 2 (/workspace, /state) | 3 (/config, /state, /workspace) |
| TCP hosts | Controller only | Controller + all tool VM SSH ports + WebSocket bypass |
| Auth | None | Auth profiles (1Password → disk → VFS) |
| prepareHostState | None | Writes effective config + auth profiles |
| Health check | `GET /health` | `GET /` |

See [overview.md](overview.md#gateway-abstraction) for the GatewayLifecycle interface that both modes implement.

---

## Gateway VM Lifecycle

The gateway VM boots at controller startup and stays running. It is NOT per-task.

```
  controller start
       |
       v
  1. Resolve zone secrets
  2. Build gateway image (cached by fingerprint)
  3. prepareHostState:
     - Write effective-openclaw.json (inject gateway token)
     - Write auth-profiles.json from 1Password
  4. buildVmSpec → GatewayVmSpec (3 mounts, TCP pool, env)
  5. buildProcessSpec → bootstrap + start commands
  6. createManagedVm → Gondolin VM
  7. Bootstrap: write shell env to /etc/profile.d/
  8. Start: openclaw gateway --port 18789
  9. Wait for health check (GET / on :18789)
  10. Enable ingress
```

The gateway stays alive until `controller stop`, `controller destroy`, or process exit.

For the full 15-step boot sequence, see [overview.md](overview.md#gateway-zone-orchestrator).
For the lifecycle implementation, see [subsystems/gateway-lifecycle.md](../subsystems/gateway-lifecycle.md#openclaw-implementation).

---

## Tool VM Leases

When the agent needs to execute code, OpenClaw requests a tool VM lease through the controller's HTTP API.

### Lease Lifecycle

```
  OpenClaw agent: "I need to run this code"
       |
       v
  POST /lease { scopeKey: "discord:user123", zoneId, profileId }
       |
       v
  Controller: lease-manager.createLease()
       |
       |  1. tcpPool.allocate() → slot 0 (port 19000)
       |  2. createManagedVm() → boot tool VM
       |  3. vm.enableSsh() → SSH access ready
       |  4. Store lease record
       v
  Response: { leaseId, ssh: { host, port: 19000, user, identityFile } }
       |
       v
  OpenClaw uses SSH to execute code in tool VM
       |
       v  (30 minutes idle)
  Idle reaper: releaseLease()
       |  1. vm.close() → tool VM destroyed
       |  2. tcpPool.release(slot) → port freed
```

### Scope-Based Reuse

Leases are keyed by `scopeKey` — typically `{channel}:{userId}`. If the same scope already has an active lease, it's reused instead of creating a new VM. This means a user's tool VM persists across multiple tool calls within the same conversation.

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
       | 3. Provide file bridge (read/write via SSH)
       | 4. Provide shell execution (commands via SSH)
       v
  Tool VM: runs agent-generated code safely
```

The plugin provides:
- **File bridge**: `mkdirp`, `readFile`, `writeFile`, `stat`, `remove`, `rename` — all via SSH into the tool VM
- **Shell execution**: run arbitrary commands in the tool VM
- **Workspace access**: `/workspace` is VFS-mounted read/write

---

## Auth Profiles

OAuth tokens for model providers are managed through 1Password:

```
  zone.gateway.authProfilesRef (1Password secret)
       |
       v
  prepareHostState: secretResolver.resolve(ref)
       |
       v
  Write auth-profiles.json to host stateDir (mode 0600)
       |
       v
  VM reads via VFS mount of stateDir
```

For the full auth profile flow, see [subsystems/secrets-and-credentials.md](../subsystems/secrets-and-credentials.md#auth-profiles).

---

## WebSocket Bypass

Discord and WhatsApp use WebSocket connections that can't go through HTTP mediation. These are configured as TCP pass-through:

```json
"websocketBypass": ["gateway.discord.gg:443", "web.whatsapp.com:443"]
```

Bypass hosts get direct TCP forwarding via `tcpHosts` — no HTTP interception, no secret injection.

---

## Zone Operations

The controller exposes operations for managing the OpenClaw gateway:

| Operation | Endpoint | What it does |
|-----------|----------|-------------|
| Status | `GET /controller-status` | System config and zone health |
| Logs | `GET /zones/:id/logs` | Gateway process logs from VM |
| Credentials | `POST /zones/:id/credentials/refresh` | Re-resolve secrets, restart gateway |
| Destroy | `POST /zones/:id/destroy` | Stop gateway, release leases, purge state |
| Upgrade | `POST /zones/:id/upgrade` | Rebuild image, restart gateway |
| SSH | `POST /zones/:id/enable-ssh` | SSH access to gateway VM |
| Exec | `POST /zones/:id/execute-command` | Run command in gateway VM |

For implementation details, see [subsystems/controller.md](../subsystems/controller.md#operations).

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
