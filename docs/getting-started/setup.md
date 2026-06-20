# Setup Guide

Use this guide for a local Worker-mode scaffold.

## Prerequisites

Universal:

- Node.js >= 24
- pnpm
- QEMU

Needed for common local flows:

- Docker, when building gateway OCI images or running repo-level providers
  declared through `.agent-vm/repo-resources.ts`.
- 1Password setup, only when using `--secrets 1password`.
- age, only for encrypted backup/local key generation flows.

Run `agent-vm validate` to check files. Run `agent-vm doctor` to check the
current host.

## Quick Start

### 1. Initialize a local Worker project

```bash
agent-vm init coding-agent --type worker --preset macos-local
```

`macos-local` expands to:

- local relative paths
- `aarch64` VM images
- 1Password-backed secrets
- `.env.local`

The scaffold includes:

- `config/system.jsonc`
- `config/gateways/coding-agent/worker.jsonc`
- `config/gateways/coding-agent/prompts/*.md`
- `vm-images/gateways/worker/build-config.jsonc`
- `vm-images/gateways/worker/overlay.jsonc`

The generated local gateway image installs public runtime tooling only. For
monorepo local task runs, pack `agent-vm-worker` and set
`AGENT_VM_WORKER_TARBALL_PATH`; the controller copies that tarball into
`/state/agent-vm-worker.tgz` when a worker task starts.

### 2. Check the files

```bash
agent-vm validate --config config/system.jsonc
```

### 3. Check the current machine

```bash
agent-vm doctor --config config/system.jsonc
```

### 4. Configure secrets

For `macos-local`, `.env.local` is written so you can adjust local values.

Optional tweaks:

- adjust any `*_REF` values if your 1Password vault paths differ
- run `agent-vm auth 1password <op-ref-or-url> --config config/system.jsonc`
  to read a 1Password service-account token with `op read` and store it in the
  configured macOS Keychain entry
- omit the ref/url to paste the service-account token interactively
- set `OP_SERVICE_ACCOUNT_TOKEN` only if you intentionally switch to an
  env-backed service-account token instead of Keychain-backed storage

For container-host or CI scaffolds, use:

```bash
agent-vm init coding-agent --type worker --preset container-x86 --namespace agent-vm
# or, on an arm64 container host:
agent-vm init coding-agent --type worker --preset container-arm64 --namespace agent-vm
```

Container presets use environment-backed secrets and do not write `.env.local`.

### 5. Build images

```bash
agent-vm build --config config/system.jsonc
```

This generates Dockerfiles from managed agent-vm base images plus your overlay,
builds Docker OCI images, then builds Gondolin VM assets. Later builds reuse
cached fingerprints.

### 6. Start the controller

```bash
agent-vm controller start --config config/system.jsonc --zone coding-agent
```

## More

- Config fields: [../reference/configuration/README.md](../reference/configuration/README.md)
- Validate vs doctor: [../reference/validate-and-doctor.md](../reference/validate-and-doctor.md)
- Agent Worker Gateway: [worker-guide.md](worker-guide.md)
