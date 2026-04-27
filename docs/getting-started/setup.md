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
- `hostSystemType: "bare-metal"`
- `.env.local`

The scaffold includes:

- `config/system.json`
- `config/systemCacheIdentifier.json`
- `config/gateways/coding-agent/worker.json`
- `config/gateways/coding-agent/prompts/*.md`
- `vm-images/gateways/worker/Dockerfile`
- `vm-images/gateways/worker/build-config.json`

### 2. Check the files

```bash
agent-vm validate --config config/system.json
```

### 3. Check the current machine

```bash
agent-vm doctor --config config/system.json
```

### 4. Configure secrets

For `macos-local`, `.env.local` is written so you can adjust local values.

Optional tweaks:

- adjust any `*_REF` values if your 1Password vault paths differ
- set `OP_SERVICE_ACCOUNT_TOKEN` if you want a service account instead of
  Keychain storage

For container-host or CI scaffolds, use:

```bash
agent-vm init coding-agent --type worker --preset container-x86 --namespace agent-vm
```

Container presets use environment-backed secrets and do not write `.env.local`.

### 5. Build images

```bash
agent-vm build --config config/system.json
```

This builds Docker OCI images from Dockerfiles, then Gondolin VM assets. Later
builds reuse cached fingerprints.

### 6. Start the controller

```bash
agent-vm controller start --config config/system.json --zone coding-agent
```

## More

- Config fields: [../reference/configuration/README.md](../reference/configuration/README.md)
- Validate vs doctor: [../reference/validate-and-doctor.md](../reference/validate-and-doctor.md)
- Agent Worker Gateway: [worker-guide.md](worker-guide.md)
