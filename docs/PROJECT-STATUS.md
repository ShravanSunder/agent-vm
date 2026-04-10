# Agent VM — Project Status

## Overview

Self-hosted AI assistant running OpenClaw inside Gondolin QEMU micro-VMs with per-user trust zone isolation, managed secrets via 1Password, and ephemeral tool VMs for sandboxed code execution.

**Branch:** `live-validation`  
**PR:** ShravanSunder/agent-vm#1  
**Tests:** 109 unit/integration, 12 live e2e scenarios verified

---

## Architecture

```
Host (macOS)
├── Controller (Node.js, :18800)
│   ├── Lease Manager (tool VM lifecycle)
│   ├── TCP Pool (port allocation for SSH tunnels)
│   ├── Idle Reaper (30min TTL)
│   └── HTTP API (Hono)
│
├── Gateway VM (Debian slim, Gondolin QEMU, 2GB RAM)
│   ├── OpenClaw 2026.4.2 (Codex OAuth)
│   ├── Gondolin sandbox plugin (45/86 plugins)
│   ├── Discord + WhatsApp channels
│   └── Ingress → :18791
│
└── Tool VMs (Debian slim, ephemeral, 1GB RAM each)
    ├── SSH via sandboxssh (Gondolin virtio tunnel)
    ├── /workspace (VFS-mounted from host)
    └── Created on-demand per tool call
```

---

## Packages

| Package | Purpose | Files |
|---------|---------|-------|
| `gondolin-core` | VM adapter, secret resolver, build pipeline, policy compiler | 8 source + 6 test |
| `agent-vm` | Controller CLI, runtime, lease API, gateway manager, snapshots | 20 source + 18 test |
| `openclaw-agent-vm-plugin` | OpenClaw sandbox backend, lease client, plugin registration | 5 source + 5 test |

---

## CLI Commands

```
agent-vm controller doctor              # Validate environment (node, qemu, age, op, ports)
agent-vm controller start               # Boot controller + gateway VM
agent-vm controller stop                # Graceful shutdown
agent-vm controller status              # System status
agent-vm controller ssh-cmd             # Get SSH command for gateway VM
agent-vm controller logs                # Gateway OpenClaw logs
agent-vm controller destroy [--purge]   # Stop zone + optionally purge state
agent-vm controller upgrade             # Rebuild image + restart
agent-vm controller credentials refresh # Re-resolve 1P secrets
agent-vm controller lease list          # Active tool VM leases
agent-vm controller lease release <id>  # Release a specific lease
agent-vm controller snapshot create     # Encrypted backup of zone state
agent-vm controller snapshot restore    # Decrypt + restore zone state
agent-vm controller snapshot list       # List snapshot archives
```

---

## E2E Verification Matrix

| # | Scenario | Result | Evidence |
|---|----------|--------|----------|
| 1 | Agent chat → Codex model responds | ✅ | "Four" (what is 2+2) |
| 2 | Sandbox tool call → tool VM exec | ✅ | "hello-from-sandbox" |
| 3 | FS bridge write + read | ✅ | "FSBRIDGEWORKS" via python3 /dev/fd/3 |
| 4 | Workspace persistence (same session) | ✅ | File written in call 1, read in call 2 |
| 5 | Multiple sessions → separate VMs | ✅ | discord:123 → slot 0, whatsapp:456 → slot 1 |
| 6 | Controller stop + restart | ✅ | State persists, clean leases, tool calls work |
| 7 | Snapshot create + restore | ✅ | Age encrypted, auth-profiles restored (2672 bytes) |
| 8 | Scope-based VM reuse | ✅ | Same scopeKey reuses handle within process |
| 9 | Doctor checks | ✅ | All binaries found (qemu, age, op, node) |
| 10 | SSH into gateway VM | ✅ | Gondolin enableSsh + profile.d env vars |
| 11 | Auth from 1P at boot | ✅ | auth-profiles.json written to VFS state dir |
| 12 | Idle reaper (manual release) | ✅ | DELETE /lease → 0 leases, VMs destroyed |

---

## What Was Built (Chronological)

### Phase 1-3 (Foundation)
- [x] pnpm monorepo with 3 packages
- [x] Gondolin core: VM adapter, secret resolver, build pipeline, mount policy, volume manager
- [x] Controller: system config (Zod), gateway manager, lease manager, TCP pool
- [x] Plugin: sandbox backend factory, lease client, OpenClaw SDK type guard
- [x] 1Password integration: op-cli, env, keychain token sources
- [x] Hybrid secrets: HTTP mediation for API keys, env injection for tokens
- [x] WebSocket bypass (tcp.hosts) for Discord + WhatsApp
- [x] Live tests: cross-VM SSH, lease API round-trip

### Phase 4 (API, CLI, Snapshots)
- [x] Gateway HTTP API client (/readyz, /tools/invoke with Bearer auth)
- [x] Gateway WebSocket client (connect.challenge handshake, chat.send)
- [x] CLI completeness: stop, lease list/release, snapshot create/restore/list, ssh-cmd
- [x] Snapshot manager with age identity-key encryption
- [x] Doctor checks for qemu, age, op binaries with install hints
- [x] Fix tokenSource schema mismatch (serviceAccountTokenEnv → tokenSource)
- [x] Resolve all system.json paths relative to config file location
- [x] Tool profile lookup from config (not hardcoded)

### Phase 5 (Live Validation + Fixes)
- [x] Switch to Debian slim OCI images (Dockerfile-based)
- [x] Fix plugin discovery (copy to OpenClaw extensions dir, not BUNDLED_PLUGINS_DIR override)
- [x] Fix SSH tool VM: enableSsh on TCP pool port, correct user
- [x] Fix chatgpt.com in allowedHosts (Codex API uses chatgpt.com/backend-api)
- [x] Fix /dev/fd symlink for FS bridge (Debian OCI doesn't mount it)
- [x] Fix config writable (realfs not realfs-readonly)
- [x] Fix CA trust for SSH sessions (NODE_EXTRA_CA_CERTS in profile.d)
- [x] Sandbox lifecycle: scope-based VM reuse, finalizeExec, manager
- [x] FS bridge stdin forwarding for file writes
- [x] workspaceAccess: "rw" in sandbox config
- [x] Controller logs via VM exec (not nonexistent host file)
- [x] API surface rename (descriptive names per TS rules)
- [x] Plugin file rename (sandbox-backend-factory, openclaw-plugin-registration, etc.)

---

## Configuration

### system.json
- `tokenSource: { type: "env", envVar: "OP_SERVICE_ACCOUNT_TOKEN" }` (for testing)
- `allowedHosts` includes: chatgpt.com, api.openai.com, auth.openai.com, deb.debian.org
- `tcpPool: { basePort: 19000, size: 5 }`
- `toolProfiles.standard: { memory: "1G", cpus: 1 }`

### openclaw.json
- `model.primary: "openai-codex/gpt-5.4"` (Codex OAuth, NOT Anthropic)
- `sandbox: { mode: "all", backend: "gondolin", scope: "session", workspaceAccess: "rw" }`
- `tools.elevated.enabled: false`
- `plugins.entries.gondolin.config.controllerUrl: "http://controller.vm.host:18800"`

### Docker Images
- `agent-vm-gateway:latest` — node:24-slim + openssh-server + openclaw@2026.4.2
- `agent-vm-tool:latest` — node:24-slim + openssh-server + python3 + git

---

## Known Issues / Future Work

1. **Snapshot size** — Includes image cache (26GB). Should exclude `state/*/images/` from snapshots.
2. **Boot time** — ~90s for gateway (CA update + plugin copy + OpenClaw startup). Could pre-bake more into image.
3. **Codex OAuth expiry** — Token expires in ~10 days. Needs manual re-auth via SSH.
4. **Formatting** — `pnpm fmt:check` not configured. 29 files unformatted.
5. **Gondolin SDK link** — `@earendil-works/gondolin` uses filesystem link. Not portable to CI.
6. **Multi-zone** — Only `shravan` zone tested. `alevtina` and `shravan-lab` zones not configured yet.
7. **Agent scope** — Not live-tested (requires multi-session from same agent via channels).
