# agent-vm

Give it a coding task. It plans an approach, writes the code, runs your
tests, reviews its own work, and opens a pull request. Everything happens
inside a disposable virtual machine — the agent has full filesystem and
shell access, but it can't affect your real systems.

agent-vm is a self-hosted system for running LLM coding agents safely.
Each task gets its own fresh VM that boots in seconds, does the work, and
is destroyed when done. API keys are injected at the network layer so the
agent never sees the raw credentials.

---

## How It Works

```
  You / CI / API
       |
       |  "Add pagination to /api/users"
       v
  Controller        (your host machine, :18800)
       |            Clones your repo, assembles config,
       |            boots a fresh VM, submits the task,
       |            waits for completion, pushes the PR.
       v
  Gateway VM        (Gondolin QEMU micro-VM, ~2s boot)
       |            Runs the coding agent inside a sandbox.
       |            Full filesystem + shell access inside.
       |            Can't touch the host or other tasks.
       v
  Tool VMs          (ephemeral, on-demand)
                    Extra sandboxed environments for
                    database containers, build tools, etc.
```

The **Controller** is a Node.js process on your machine. It never runs
untrusted code — it just manages VMs and credentials.

The **Gateway VM** is where the LLM agent works. It's a lightweight QEMU
virtual machine (via [Gondolin](https://github.com/nicholasgasior/gondolin))
that boots in ~2 seconds. Your repo is mounted read-write inside the VM.
The agent can run any command — npm, git, python — but it's sandboxed.
When the task finishes, the VM is destroyed and nothing persists except
your repo changes and the event log.

**Tool VMs** are additional sandboxes for backing services (postgres,
redis) that your tests might need. They're booted on demand and cleaned
up with the task.

---

## The Agent Pipeline (Worker Mode)

When you give it a task, the agent runs a 6-phase loop:

1. **Plan** — reads your codebase, writes an implementation plan
2. **Plan Review** — reviews its own plan, revises if needed
3. **Work** — writes the code (uses OpenAI GPT-5.4 by default)
4. **Verify** — runs your tests and linter, fixes failures automatically
5. **Work Review** — reviews the diff, requests changes if quality is low
6. **Wrapup** — stages and commits changes, controller pushes branch and opens a pull request

If verification or review fails, the agent loops back and tries again
(up to configurable retry limits). The whole thing is event-sourced —
every state change is logged to a JSONL file for debugging.

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
