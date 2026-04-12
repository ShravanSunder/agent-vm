# Agent-VM Setup Guide

## Prerequisites

Run `agent-vm controller doctor` to verify:

- Node.js >= 24
- QEMU
- age
- 1Password CLI
- Docker

## Quick Start

### 1. Initialize the project

```bash
agent-vm init <your-zone-id>
```

This scaffolds:

- `system.json`
- `.env.local`
- `config/<zone>/openclaw.json`
- `state/<zone>/`
- `workspaces/<zone>/`

### 2. Configure secrets

`agent-vm init` defaults to Touch ID via 1Password CLI.

Optional tweaks in `.env.local`:

- adjust any `*_REF` values if your 1Password vault paths differ
- set `OP_SERVICE_ACCOUNT_TOKEN` only if you want a service account instead of Touch ID
- keep `AGE_IDENTITY_KEY` only if you want a custom checkpoint encryption key

### 3. Build images

```bash
agent-vm build
```

Builds Docker OCI images from Dockerfiles, then shared Gondolin VM assets.
First build takes a few minutes. Subsequent builds reuse cached fingerprints from `./cache/images/`.

### 4. Start the controller

```bash
agent-vm controller start
```

### 5. Do OAuth setup if needed

```bash
agent-vm auth codex --zone <zone-id>
```

For advanced manual access, you can still get the raw SSH command with:

```bash
agent-vm controller ssh-cmd --zone <zone-id>
```

### 6. Verify

```bash
agent-vm controller doctor
agent-vm controller status
```
