# agent-vm

Self-hosted autonomous coding agent system. Runs LLM agents inside
Gondolin QEMU micro-VMs with per-task ephemeral sandboxing. Secrets never
enter the sandbox, and every task starts from a clean VM image.

---

## System Stack

```
  You / CI / API
       |
       v
  Controller        (host process, :18800)
       |
       v
  Gateway VM        (Gondolin QEMU micro-VM)
       |
       v
  Tool VMs          (ephemeral, on-demand per task)
```

The **Controller** runs on the host, owns VM lifecycle, and never executes
untrusted code. The **Gateway VM** mediates between the outside world and
the sandboxed environment. **Tool VMs** are disposable -- booted per task,
destroyed on completion.

---

## Operating Modes

|                    | OpenClaw                        | Worker                                              |
|--------------------|---------------------------------|------------------------------------------------------|
| **Purpose**        | Interactive chat agent          | Autonomous coding pipeline                           |
| **Gateway type**   | `openclaw`                      | `worker`                                             |
| **VM lifecycle**   | Long-running per zone           | Per-task ephemeral                                   |
| **Pipeline**       | User-driven conversation        | 6-phase: plan > review > work > verify > review > wrapup |
| **Output**         | Chat responses + tool calls     | Pull requests                                        |
| **Backing services** | Discord, WhatsApp channels    | Docker compose (postgres, etc.)                      |

---

## Package Map

| Package | Description |
|---------|-------------|
| `@shravansunder/agent-vm` | CLI + controller runtime |
| `@shravansunder/agent-vm-worker` | Task pipeline (runs inside VM) |
| `@shravansunder/gondolin-core` | VM adapter + secret resolver |
| `@shravansunder/gateway-interface` | Shared gateway lifecycle types |
| `@shravansunder/openclaw-gateway` | OpenClaw gateway implementation |
| `@shravansunder/worker-gateway` | Worker gateway implementation |
| `@shravansunder/openclaw-agent-vm-plugin` | OpenClaw sandbox plugin |

All packages live under `packages/` in this monorepo.

---

## Quick Start

See [SETUP.md](SETUP.md) for prerequisites, installation, and first-run
instructions.

---

## Documentation

| Document | What it covers |
|----------|---------------|
| [architecture.md](architecture.md) | System architecture -- trust zones, VM lifecycle, secret flow |
| [agent-vm-worker-architecture.md](agent-vm-worker-architecture.md) | Worker pipeline deep dive -- phases, state machine, event log |
| [configuration-reference.md](configuration-reference.md) | All config fields for system.json, zone configs, and env |
| [subsystems/](subsystems/) | Subsystem deep dives -- secrets, snapshots, networking, Docker |
