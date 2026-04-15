# agent-vm

Sandboxed micro-VM infrastructure for AI coding agents. Run tool calls, code execution, and agent workflows inside ephemeral QEMU virtual machines with per-session isolation, managed secrets, and workspace mounting.

Built on [Gondolin](https://github.com/nicholasgasior/gondolin) (QEMU micro-VMs) with [OpenClaw](https://github.com/nicholasgasior/openclaw) integration for agent orchestration.

## Why

AI coding agents need to execute code — shell commands, file operations, package installs, network requests — with your credentials and full filesystem access. One bad tool call and credentials leak, repos corrupt, or packages install that you didn't authorize.

agent-vm solves this by running each tool call inside an ephemeral QEMU micro-VM:

- **Sandboxed execution** — each tool call runs in its own VM with controlled network access, scoped filesystem mounts, and no host credential exposure
- **Ephemeral by default** — tool VMs are created on demand and destroyed after use. No state leaks between sessions.
- **Managed secrets** — API keys and tokens sourced from 1Password, injected via HTTP mediation or env vars. Secrets never touch the agent environment directly.
- **Workspace mounting** — project files mounted read-write into the VM via Gondolin VFS. Changes persist to the host workspace.

## How It Works

```
Host (macOS)
├── Controller (Node.js, :18800)
│   ├── Lease Manager — tool VM lifecycle, scope-based reuse
│   ├── TCP Pool — port allocation for SSH tunnels
│   ├── Idle Reaper — 30min TTL, automatic cleanup
│   └── HTTP API (Hono)
│
├── Gateway VM (Debian slim, 2GB RAM, persistent)
│   ├── OpenClaw — agent orchestration, model routing
│   ├── Gondolin sandbox plugin
│   ├── Discord + WhatsApp channels
│   └── Ingress → :18791
│
└── Tool VMs (Debian slim, 1GB RAM, ephemeral)
    ├── SSH via Gondolin virtio tunnel
    ├── /workspace — VFS-mounted from host
    └── Created on-demand per tool call
```

The **controller** runs on the host and manages VM lifecycle. It exposes an HTTP API for lease management — requesting, reusing, and releasing tool VMs.

The **gateway VM** is a persistent VM running OpenClaw. When an agent receives a tool call, the sandbox plugin routes it to the controller's lease API, which spawns (or reuses) a tool VM to execute the command.

**Tool VMs** are ephemeral Debian micro-VMs. Each gets SSH access, a mounted workspace, and scoped network egress. After execution, results return through the gateway and the VM is reaped after idle timeout.

**Worker mode** extends this with multi-phase task execution: planning, git operations, code execution (via Codex SDK), verification, and wrapup actions (PR creation, Slack notifications).

## Packages

| Package | Purpose |
|---------|---------|
| `gondolin-core` | QEMU micro-VM adapter, secret resolver, build pipeline, policy compiler, volume manager |
| `agent-vm` | Host controller — CLI, HTTP API, lease manager, gateway manager, backup system |
| `agent-vm-worker` | Worker task executor — planning, git ops, code execution, verification, wrapup actions |
| `gateway-interface` | Shared TypeScript interfaces for gateway lifecycle, VM specs, health checks |
| `worker-gateway` | Worker VM lifecycle — ephemeral Debian VMs per tool call |
| `openclaw-gateway` | OpenClaw VM lifecycle — persistent gateway with plugin setup and channel config |
| `openclaw-agent-vm-plugin` | Bridges OpenClaw and Gondolin — sandbox backend, lease client, plugin registration |

## CLI

```
agent-vm controller doctor              # Validate environment (node, qemu, age, op, ports)
agent-vm controller start               # Boot controller + gateway VM
agent-vm controller stop                # Graceful shutdown
agent-vm controller status              # System status
agent-vm controller ssh-cmd             # Get SSH command for gateway VM
agent-vm controller logs                # Gateway OpenClaw logs
agent-vm controller destroy [--purge]   # Stop zone + optionally purge state
agent-vm controller upgrade             # Rebuild image + restart
agent-vm controller credentials refresh # Re-resolve 1Password secrets
agent-vm controller lease list          # Active tool VM leases
agent-vm controller lease release <id>  # Release a specific lease
agent-vm backup create                  # Encrypted backup of zone state
agent-vm backup restore                 # Decrypt + restore zone state
agent-vm backup list                    # List backup archives
```

## Prerequisites

- macOS (host)
- Node.js >= 24
- [QEMU](https://www.qemu.org/) — micro-VM hypervisor
- [age](https://github.com/FiloSottile/age) — backup encryption
- [1Password CLI](https://developer.1password.com/docs/cli/) — secret management

## Setup

```bash
# Install dependencies
pnpm install

# Copy and configure environment
cp .env.example .env.local

# Validate environment
pnpm exec agent-vm controller doctor

# Start the controller + gateway
pnpm exec agent-vm controller start
```

## Development

```bash
pnpm build              # Build all packages
pnpm test               # Run unit tests
pnpm test:integration   # Run integration tests
pnpm test:smoke         # Run smoke tests
pnpm check              # Lint + format check + typecheck
pnpm lint:fix           # Auto-fix lint issues
pnpm fmt                # Format all files
```

## License

[MIT](LICENSE)
