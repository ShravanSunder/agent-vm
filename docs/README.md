# agent-vm

A self-hosted system for running LLM coding agents safely. Give it a coding task — it plans, codes, tests, reviews, and opens a PR. Everything runs inside disposable QEMU micro-VMs. API keys are injected at the network layer so the agent never sees raw credentials.

---

## Package Architecture

Seven packages. Dependencies flow downward.

```
                @earendil-works/gondolin
                (external SDK — QEMU micro-VMs,
                 VFS, HTTP mediation, image builds)
                          |
                          v
                gondolin-core
                (VM adapter, secret resolver,
                 image build pipeline, VFS helpers)
                          |
          +---------------+---------------+
          |                               |
          v                               v
  gateway-interface             openclaw-agent-vm-plugin
  (GatewayLifecycle contract,   (OpenClaw sandbox backend,
   VmSpec, ProcessSpec,          lease client, SSH/file bridge)
   splitResolvedSecrets)
          |
     +----+----+
     |         |
     v         v
  openclaw-  worker-
  gateway    gateway
  (OpenClaw  (Worker
   lifecycle) lifecycle)
     |         |
     +----+----+
          |
          v
      agent-vm
      (CLI + Controller runtime,
       HTTP API :18800, lease manager,
       gateway orchestrator,
       worker task runner,
       git push from host)
          |
          | (imports workerConfigSchema)
          v
    agent-vm-worker
    (Runs INSIDE the VM.
     6-phase pipeline, coordinator,
     executors, event sourcing,
     MCP tools, HTTP API :18789)
```

| Package | What it does |
|---------|-------------|
| **gondolin-core** | Wraps the Gondolin SDK. Creates VMs, resolves secrets (1Password/env), builds images with fingerprint caching, assembles VFS mounts and HTTP mediation hooks. |
| **gateway-interface** | The contract. `GatewayLifecycle` interface, `GatewayVmSpec`, `GatewayProcessSpec`. Both gateway types implement this. `splitResolvedGatewaySecrets()` routes secrets to env or HTTP mediation. |
| **openclaw-gateway** | OpenClaw lifecycle: 3 VFS mounts, TCP pool for tool VM SSH, auth profiles, `prepareHostState` writes effective config to disk. |
| **worker-gateway** | Worker lifecycle: 2 VFS mounts (`/workspace` + `/state`), TCP to controller only, no auth, no `prepareHostState`. |
| **agent-vm** | The controller. CLI (cmd-ts), HTTP API (Hono), lease manager + TCP pool + idle reaper for tool VMs, gateway zone orchestrator, worker task runner, host-side git push. |
| **agent-vm-worker** | The pipeline inside the VM. 6-phase coordinator, Codex/Claude executors with thread persistence, JSONL event sourcing, MCP tool server (git-pr, slack-post), HTTP API. |
| **openclaw-agent-vm-plugin** | Bridge to OpenClaw's sandbox system. Registers Gondolin VMs as an OpenClaw sandbox backend. Provides file bridge + shell execution via SSH into tool VMs. |

---

## Two Operating Modes

The controller supports two gateway types. Same infrastructure, different lifecycles.

### Mode 1: Worker (autonomous coding)

```
  Host (Zone 1 — trusted)
  +----------------------------------------------------------+
  |  Controller :18800                                        |
  |  ├── Secret Resolver (1Password / env)                    |
  |  ├── Worker Task Runner                                   |
  |  │   ├── Clone repos (shallow, single-branch)             |
  |  │   ├── Merge config (.agent-vm/config.json > zone)      |
  |  │   ├── Start Docker services (compose up)               |
  |  │   ├── Boot VM per task (ephemeral)                     |
  |  │   ├── Submit task → poll until done (30 min timeout)   |
  |  │   └── Teardown: VM + Docker + workspace                |
  |  ├── Git Push Operations (GitHub token stays here)        |
  |  └── HTTP API                                             |
  |       ├── POST /zones/:id/worker-tasks                    |
  |       └── POST /zones/:id/tasks/:id/push-branches         |
  +----------------------------------------------------------+
       |
       v  (Gondolin VM — ephemeral, per task)
  +----------------------------------------------------------+
  |  agent-vm-worker :18789                   Zone 2           |
  |  ├── Coordinator (6-phase pipeline)                        |
  |  │   ├── Plan → Plan Review (max 2 loops)                  |
  |  │   ├── Work → Verify (max 3 retries)                     |
  |  │   ├── Work Review (max 3 loops)                         |
  |  │   └── Wrapup (git-pr calls controller to push)          |
  |  ├── Executors (Codex SDK, thread persistence)             |
  |  ├── Event Log (JSONL, crash recovery)                     |
  |  └── MCP Tools (git-pr, slack-post)                        |
  |                                                            |
  |  /workspace → host repo clone (VFS realfs)                 |
  |  /state → config + event logs (VFS realfs)                 |
  +----------------------------------------------------------+
       |
       v  (HTTP mediation — secrets injected at proxy layer)
  External APIs (OpenAI, GitHub, Anthropic)
  Agent never sees credentials.
```

### Mode 2: OpenClaw (interactive chat agent)

```
  Host (Zone 1 — trusted)
  +----------------------------------------------------------+
  |  Controller :18800                                        |
  |  ├── Secret Resolver                                      |
  |  ├── Lease Manager (tool VM allocation)                   |
  |  ├── TCP Pool (SSH port slots for tool VMs)               |
  |  ├── Idle Reaper (30min TTL)                              |
  |  └── HTTP API                                             |
  |       ├── POST /lease (create tool VM)                    |
  |       ├── DELETE /lease/:id (release)                     |
  |       └── Zone ops (destroy, upgrade, logs, SSH, exec)    |
  +----------------------------------------------------------+
       |                           |
       v                           v
  Gateway VM (Zone 2)         Tool VMs (Zone 3)
  +----------------------+    +--------------------+
  | OpenClaw :18789      |    | Ephemeral, per     |
  | Long-running         |    | lease               |
  | Discord / WhatsApp   |    | No secrets          |
  | Auth profiles (1P)   |    | No network          |
  | 3 VFS mounts         |    | /workspace only     |
  | TCP to all tool VMs  |    | SSH via TCP pool     |
  +----------------------+    +--------------------+
```

---

## Security Model

Three nested trust zones. Each boundary restricts what's visible to the inner zone.

```
  +====================================================================+
  |  ZONE 1: HOST  (fully trusted)                                      |
  |                                                                     |
  |  Controller, secret resolver, GitHub token, Docker daemon           |
  |  Can: resolve secrets, push branches, manage VMs                    |
  |  Never: runs untrusted code                                         |
  |                                                                     |
  |  +---------------------------------------------------------------+  |
  |  |  ZONE 2: GATEWAY VM  (sandboxed)                              |  |
  |  |                                                                |  |
  |  |  Per-task (Worker) or long-running (OpenClaw)                  |  |
  |  |  Has: full shell access, VFS-mounted workspace                 |  |
  |  |  Can: outbound HTTP (allowlisted hosts only)                   |  |
  |  |  Cannot: see API keys, access host FS, persist after shutdown  |  |
  |  |                                                                |  |
  |  |  +----------------------------------------------------------+  |  |
  |  |  |  ZONE 3: TOOL VM  (untrusted, OpenClaw only)             |  |  |
  |  |  |                                                           |  |  |
  |  |  |  Ephemeral, per-lease. Runs LLM-generated code.           |  |  |
  |  |  |  Has: workspace mount only. No secrets, no network.       |  |  |
  |  |  +----------------------------------------------------------+  |  |
  |  +---------------------------------------------------------------+  |
  +=====================================================================+
```

**Key properties:**
- **Secrets never enter the VM** — Gondolin's HTTP mediation proxy intercepts outbound requests and injects API keys at the network layer. The agent makes normal HTTP calls without ever seeing credentials.
- **Each task is isolated** — fresh VM, fresh workspace, fresh Docker namespace. Tasks can't contaminate each other.
- **GitHub token stays on host** — the VM asks the controller to push. `git push` runs from Zone 1 where the token lives.
- **Allowlisted egress** — outbound traffic restricted per-zone. No arbitrary internet access.
- **.env / secrets never readable by agent** — contrast with container-based approaches where `process.env` exposes everything.

---

## The Agent Pipeline (Worker Mode)

Six phases, three with retry loops. Every state change logged to JSONL.

1. **Plan** — reads your codebase, writes an implementation plan
2. **Plan Review** — separate LLM reviews the plan, revises if rejected (max 2 loops)
3. **Work** — writes code with full shell access (default: GPT-5.4 via Codex SDK)
4. **Verify** — runs your tests + linter, auto-fixes failures on same LLM thread (max 3 retries)
5. **Work Review** — separate LLM reviews the diff, requests changes if needed (max 3 loops)
6. **Wrapup** — commits changes, calls controller's push-branches endpoint → PR created from host

---

## Quick Start

See [SETUP.md](SETUP.md) for prerequisites, installation, and first-run instructions.

---

## Reading Guide

### By audience

| You want to... | Read |
|----------------|------|
| **5-min pitch** — what this is, security model, why VMs | This README (you're done) |
| **15-min walkthrough** — all the moving parts | README → [architecture.md](architecture.md) → [worker-pipeline.md](worker-pipeline.md) |
| **Work on the codebase** — implementation details | + [subsystems/](subsystems/) deep dives |
| **Configure or operate** — config fields, E2E checks | [reference/](reference/) |

### Full doc tree

```
docs/
├── README.md                              You are here
├── architecture.md                        System architecture: packages, controller,
│                                          gateway abstraction, secrets, trust zones
├── worker-pipeline.md                     Inside the VM: 6-phase pipeline, event
│                                          sourcing, executors, MCP tools
├── SETUP.md                               Prerequisites + quick start
│
├── subsystems/                            Implementation deep dives
│   ├── controller.md                      Controller runtime, HTTP API, leases
│   ├── gateway-lifecycle.md               Gateway abstraction, OpenClaw vs Worker
│   ├── gondolin-vm-layer.md               VM adapter, VFS, HTTP mediation
│   ├── secrets-and-credentials.md         Secret resolution + injection modes
│   └── worker-task-pipeline.md            Controller-side task lifecycle
│
└── reference/                             Lookup material
    ├── configuration-reference.md         All config fields (system.json, worker.json)
    ├── project-status.md                  Build history, E2E verification matrix
    └── e2e-verification.md                Live testing checklist
```
