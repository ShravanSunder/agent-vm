# agent-vm

Sandboxed VM infrastructure for autonomous coding agents. See [agent-vm deepwiki](https://deepwiki.com/ShravanSunder/agent-vm).

Agent VM runs long-lived Hermes Gateways and per-agent Tool VMs through the
Gondolin micro-VM backend. Agents can execute code inside VMs, while secrets,
approval authority, lifecycle ownership, and Git push credentials stay with the
host controller.

## Upgrading From A Worker Release

Worker was removed in a hard cutover. Before installing this release, use the
old binary and old configuration to stop the old controller cleanly:

```bash
agent-vm controller stop --config <old-config>
```

If the controller is unavailable, use that same old release for scoped offline
cleanup of every Worker zone:

```bash
agent-vm controller cleanup --config <old-config> --zone <worker-zone>
```

Verify that its Worker VMs, runtime records, leases, and ingress ownership are
absent before replacing the package train or configuration. If exact cleanup
cannot be proven, stop the upgrade and restore the old release and config to
finish cleanup. The Hermes-only release rejects Worker configuration and does
not read, migrate, adopt, or delete old Worker records.

## Mental Model

```text
Hermes client / channel --> Hermes Gateway VM
                            - Hermes framework service
                            - Gateway Runtime (Tool Portal)
                                      |
                                gateway_control
                                      |
                                      v
                            agent-vm host controller
                            - secrets and approval authority
                            - VM lifecycle records and image cache
                            - managed workspace Git operations
                                      |
                                      v
                            per-agent Tool VM
                            - durable /workspace
                            - disposable /work
                            - optional /gitdirs/workspace.git
```

VM orchestration is backend-neutral below the application composition root.
Hermes produces workload requirements through `gateway-lifecycle`; controller,
lease, health, recovery, Gateway VM, and Tool VM code consume narrow
`managed-vm` capabilities. `agent-vm` selects `gondolin-vm-adapter` at startup,
so backend-native handles and filesystem objects do not flow into domain code.

## Init Presets

`agent-vm init` scaffolds a Hermes deployment. Omitting `--type` selects Hermes;
`--type hermes` remains accepted.

| Preset | Use when | Expands to |
| --- | --- | --- |
| `macos-local` | Local Mac development | `~/.agent-vm/<projectNamespace>`, `aarch64`, 1Password secrets, writes `.env.local` |
| `container-x86` | x86_64 Linux container runtime | `/var/agent-vm/<projectNamespace>`, `x86_64`, environment secrets, `vm-host-system/` |
| `container-arm64` | arm64 Linux container runtime | `/var/agent-vm/<projectNamespace>`, `aarch64`, environment secrets, `vm-host-system/` |

Explicit flags such as `--arch`, `--paths`, and `--secrets` override preset
defaults.

## Quick Start

```bash
pnpm install
pnpm build
AGENT_VM="node packages/agent-vm/dist/cli/agent-vm-entrypoint.js"

$AGENT_VM init coding-agent --preset macos-local
$AGENT_VM validate --config config/system.jsonc
$AGENT_VM doctor --config config/system.jsonc
$AGENT_VM build --config config/system.jsonc
$AGENT_VM controller start --config config/system.jsonc --zone coding-agent
```

Container-host scaffold:

```bash
$AGENT_VM init coding-agent --preset container-x86 --namespace agent-vm
# or, on an arm64 container host:
$AGENT_VM init coding-agent --preset container-arm64 --namespace agent-vm
$AGENT_VM validate --config config/system.jsonc
```

`validate` checks whether authored files are coherent. `doctor` checks whether
the current machine can run them. See
[validate and doctor](docs/reference/validate-and-doctor.md).

## Read Next

| Goal | Read |
| --- | --- |
| Understand the docs layout | [docs/README.md](docs/README.md) |
| Understand system architecture | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Configure a Hermes managed Gateway | [docs/reference/configuration/system-json.md](docs/reference/configuration/system-json.md) |
| Understand credentialed CLI runtimes | [docs/architecture/credentialed-runtimes.md](docs/architecture/credentialed-runtimes.md) |
| Look up config fields | [docs/reference/configuration/README.md](docs/reference/configuration/README.md) |

## Development

```bash
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:e2e:inventory
pnpm test:e2e
pnpm check
```
