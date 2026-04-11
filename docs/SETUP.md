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

Edit `.env.local`:

- set `OP_SERVICE_ACCOUNT_TOKEN`
- adjust any `*_REF` values if your 1Password vault paths differ
- set `AGE_IDENTITY_KEY` if you want snapshot and checkpoint encryption available

### 3. Build images

```bash
agent-vm build
```

Builds Docker OCI images from Dockerfiles, then Gondolin VM assets per zone.
First build takes a few minutes. Subsequent builds reuse cached fingerprints.

### 4. Start the controller

```bash
agent-vm controller start
```

### 5. Do OAuth setup if needed

```bash
agent-vm controller ssh-cmd --zone <zone-id>
```

Inside the gateway VM, run the auth flow you need, for example:

```bash
openclaw auth login
```

### 6. Verify

```bash
agent-vm controller doctor
agent-vm controller status
```
