# agent-vm

Sandboxed VM infrastructure for autonomous coding agents.

The primary path is the Worker gateway: a caller submits a coding task, the
controller boots a fresh Gondolin micro-VM, `agent-vm-worker` plans, edits,
validates, reviews, and asks the host-side controller to push a branch and open
a PR. The agent can execute code inside the VM, but secrets and git push
credentials stay on the host.

If you want the underlying micro-VM runtime details, see the upstream Gondolin
docs on [sandbox setup and secret mediation](https://github.com/earendil-works/gondolin/blob/main/README.md#quick-example)
and [custom image / VFS features](https://github.com/earendil-works/gondolin/blob/main/README.md#feature-highlights).

OpenClaw support still exists, but it is the secondary interactive mode. Start
with the Worker gateway unless you are specifically building an OpenClaw setup.

## Mental Model

```text
request / API / CI
      |
      v
controller host process
  - reads system.json
  - resolves secrets
  - clones repos
  - builds/caches VM images
  - pushes branches
      |
      v
Gondolin VM
  - runs agent-vm-worker
  - mounts /workspace and /state only
  - runs agent-generated commands safely
```

The controller clones git repositories on the host side, then realfs-mounts
them into the VM at `/workspace`. The VM can edit the mounted checkout, but git
push still happens through the host-side controller. PR creation happens from
the worker via `gh pr create` after `git-push` succeeds, with GitHub HTTP
traffic mediated by the controller proxy.

## Init Presets

`agent-vm init` can scaffold the repo for two deployment shapes: bare metal and
generic container host.

| Preset | Use when | Expands to |
| --- | --- | --- |
| `macos-local` | Local Mac development | local paths, `aarch64`, 1Password secrets, `hostSystemType: "bare-metal"`, writes `.env.local` |
| `container-x86` | x86_64 Linux container runtime | runtime paths, `x86_64`, environment secrets, `vm-host-system/` |

Explicit flags like `--arch`, `--paths`, and `--secrets` override preset
defaults.

## Validate vs Doctor

Use both, but for different questions.

```bash
agent-vm validate --config config/system.json
agent-vm doctor --config config/system.json
```

`validate` checks whether the scaffolded files are coherent. `doctor` checks
whether the current machine can run the config right now.

See [docs/reference/validate-and-doctor.md](docs/reference/validate-and-doctor.md).

## Quick Start

```bash
pnpm install
pnpm build
AGENT_VM="node packages/agent-vm/dist/cli/agent-vm-entrypoint.js"

$AGENT_VM init coding-agent --type worker --preset macos-local
$AGENT_VM validate --config config/system.json
$AGENT_VM doctor --config config/system.json
$AGENT_VM build --config config/system.json
$AGENT_VM controller start --config config/system.json --zone coding-agent
```

For monorepo local task runs, pack `agent-vm-worker` and set
`AGENT_VM_WORKER_TARBALL_PATH` before starting worker tasks. The local gateway
image installs public runtime tooling only; the controller copies the tarball
into `/state/agent-vm-worker.tgz` when a task starts.

Container-host scaffold:

```bash
AGENT_VM="node packages/agent-vm/dist/cli/agent-vm-entrypoint.js"

$AGENT_VM init coding-agent --type worker --preset container-x86 --namespace agent-vm
$AGENT_VM validate --config config/system.json
```

## Read Next

| Goal | Read |
| --- | --- |
| Understand the docs layout | [docs/README.md](docs/README.md) |
| Understand system architecture | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Configure the Worker gateway | [docs/getting-started/worker-guide.md](docs/getting-started/worker-guide.md) |
| Look up config fields | [docs/reference/configuration/README.md](docs/reference/configuration/README.md) |
| Use OpenClaw Gateway | [docs/getting-started/openclaw-guide.md](docs/getting-started/openclaw-guide.md) |

## Development

```bash
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:smoke
pnpm check
```
