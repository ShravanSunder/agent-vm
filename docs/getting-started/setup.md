# Setup Guide

Use this guide for a Hermes deployment scaffold.

## Prerequisites

- Node.js 24 or newer
- pnpm
- QEMU
- Docker for building Gateway OCI images
- 1Password only when using `--secrets 1password`
- age only for encrypted backup and local key-generation flows

## Initialize

For local macOS development:

```bash
agent-vm init coding-agent --preset macos-local
```

Omitting `--type` selects Hermes. `--type hermes` is also accepted. The scaffold
includes the system config, managed Hermes config, MCP and Tool Portal configs,
the Hermes image recipe, and the default Tool VM image overlay.

For a container host:

```bash
agent-vm init coding-agent --preset container-x86 --namespace agent-vm
# arm64:
agent-vm init coding-agent --preset container-arm64 --namespace agent-vm
```

Container presets use environment-backed secrets, put storage under
`/var/agent-vm/<projectNamespace>`, and generate `vm-host-system/`.

## Configure Secrets

The `macos-local` preset uses `aarch64` images, stores operational state under
`~/.agent-vm/<projectNamespace>`, and writes `.env.local` for local settings.
Adjust the secret references for your deployment.

Use `agent-vm auth 1password <op-ref-or-url> --config config/system.jsonc` to
read a service-account token through `op` and store it in the configured macOS
Keychain entry. Omit the reference to paste the token interactively. Use
`OP_SERVICE_ACCOUNT_TOKEN` only when intentionally selecting environment-backed
service-account storage.

Container presets use environment-backed secrets and do not write `.env.local`.
Explicit `--arch`, `--paths`, and `--secrets` flags override preset defaults.
When omitted, the namespace derives deterministically from the canonical
project path.

## Validate And Run

```bash
agent-vm validate --config config/system.jsonc
agent-vm doctor --config config/system.jsonc
agent-vm build --config config/system.jsonc
agent-vm controller start --config config/system.jsonc --zone coding-agent
```

`validate` checks authored configuration. `doctor` checks the current host and
runtime prerequisites. See [validate and doctor](../reference/validate-and-doctor.md).

Configure Hermes agents, Tool Portal policy, secrets, egress, and Tool VM
profiles in [system.jsonc](../reference/configuration/system-json.md).
