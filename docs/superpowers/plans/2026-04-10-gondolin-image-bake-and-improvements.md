# Agent-VM Gondolin Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-vm production-ready for merge: eliminate the slow boot, make the zero-to-claw setup experience smooth, and clean up the secrets/config model so the system is maintainable.

**Tech Stack:** TypeScript (ES modules, Node 24), Gondolin SDK (`@earendil-works/gondolin` v0.7+), Hono, Zod 4, Vitest, age encryption, 1Password SDK

**Implementation repo:** `/Users/shravansunder/Documents/dev/project-dev/agent-vm/` (branch: `live-validation-2`)

---

## What We're Building and Why

### The system

Agent-vm is a self-hosted AI assistant stack. OpenClaw (the agent platform — channels, LLM orchestration, tool execution) runs inside Gondolin QEMU micro-VMs for security isolation. The controller on the host Mac manages VM lifecycles, resolves secrets from 1Password, and exposes a lease API for ephemeral tool VMs.

Three trust boundaries:
1. **Host** — owns all secrets, runs the controller, never exposed to agent code
2. **Gateway VM** — runs OpenClaw with channels (Discord, WhatsApp). Gets secrets via HTTP mediation (agent never sees API keys) or env vars (sandbox-protected by Gondolin)
3. **Tool VM** — ephemeral sandboxes for code execution. SSH-accessible from gateway. No access to channel tokens or agent state

We validated the full chain across 5 phases: Touch ID → 1Password → secrets → Gondolin VM → OpenClaw → Discord/WhatsApp → Codex response. 109 tests pass. 12 e2e scenarios verified. The system works.

### What's wrong with it right now

The system works but the experience of running it is rough:

**Boot takes ~90 seconds.** Here's what actually happens when `agent-vm controller start` runs:

```
buildImage()          — Check cache, build if miss    ~0s (cached) or ~60-90s (first time)
createGatewayVm()     — QEMU boot                    ~155ms (measured in experiments)
setupGatewayVmRuntime — ln, update-ca-certificates,   ~5-10s (runs INSIDE the VM every boot)
                        write env profile,
                        copy plugin from VFS to rootfs,
                        chown plugin files
startOpenClawInGateway — nohup openclaw gateway,       ~15-30s (loads plugins, connects channels)
                         poll for HTTP readiness
```

The first boot is dominated by image building (extracting OCI container into rootfs). Subsequent boots still take 20-40s because of the runtime setup steps that run inside the VM every single time: CA certificate updates, plugin file copying, ownership fixes.

The core insight: **most of this runtime setup is static.** CA certificates don't change between boots. The plugin binary doesn't change between boots. Directory structures don't change. Only the zone-specific env profile (which zone, which gateway token) is truly per-boot.

**Secrets config is tangled.** Right now, 1Password `op://` URIs live inline in `system.json`:

```json
"DISCORD_BOT_TOKEN": {
  "source": "1password",
  "ref": "op://agent-vm/agent-discord-app/bot-token",  // <-- user-specific vault path
  "injection": "env"                                     // <-- structural config
}
```

This mixes two concerns: the *structure* of how a secret is used (env injection vs HTTP mediation, which hosts) with the *location* of where it lives in the user's 1Password vault. A new user has to dig through system.json to find and change every `ref` field. And system.json is meant to be version-controlled — user-specific vault paths shouldn't be in it.

**No setup command.** Going from zero to a running system requires manually creating system.json, the zone config directory, the OpenClaw config, the state directory, and understanding which env vars to set. There's no `init` that scaffolds all of this.

**OAuth requires manual VM access.** Some LLM backends (Codex) need interactive OAuth login inside the gateway VM. Currently you need to know the SSH port and identity file path from the controller's runtime state.

### How we fix it

**Three layers of boot speedup, each independent:**

1. **postBuild image baking** — Gondolin's `postBuild` config runs commands inside the rootfs at *build time*. We move CA cert updates, plugin installation, directory creation, and ownership fixes from runtime into `postBuild.copy` + `postBuild.commands` in `build-config.json`. The image is built once, cached by fingerprint (SHA256 of the full build config including postBuild), and reused for every boot. Runtime setup drops to just writing a single env profile file.

   Gondolin's postBuild now works on macOS via OCI containerized builds — no separate Docker build step needed for the postBuild commands. The `build-config.json` already references an OCI image (`agent-vm-gateway:latest`) for the base packages (Node.js, OpenClaw, openssh). postBuild adds our custom layer on top.

   **What this buys:** Subsequent boots go from ~20-40s to ~15-30s (the runtime setup overhead is eliminated, OpenClaw startup still takes time).

2. **Gondolin checkpoints (infrastructure only in this plan)** — After the first successful boot + OpenClaw startup, we snapshot the VM's rootfs as a qcow2 checkpoint. Gondolin checkpoints are disk-only (no memory/process state). On next boot, `VmCheckpoint.load(path).resume(options)` creates a fresh VM with the checkpointed rootfs as a backing layer.

   **This plan builds the checkpoint infrastructure (path resolution, existence checks, encryption helpers) but defers actual checkpoint create/resume to a follow-up.** The reason: `VmCheckpoint` API needs to be verified against the linked Gondolin SDK version before wiring it into the boot path. The infrastructure is worth building now because the storage and encryption design decisions affect Phase F.

   Important storage nuance: checkpoints must NOT live under `stateDir`. The zone's `stateDir` is VFS-mounted into the gateway VM at `/home/openclaw/.openclaw/state` (`gateway-vm-configuration.ts:123`) and is swept wholesale by `snapshot-create-operation.ts:30` when creating zone backups. Putting 4GB qcow2 files there would leak them into the guest and bloat encrypted snapshots. Checkpoints live under the image cache dir alongside the built assets: `${stateDir}/images/gateway/${fingerprint}/checkpoint.qcow2` — wait, that's also under stateDir. Correct path: `./checkpoints/${zoneId}/gateway-${fingerprint}.qcow2` at the project root, outside any VFS-mounted directory.

   Security nuance: checkpoints capture rootfs only — VFS-mounted paths (state, workspace) are excluded. But the env profile at `/root/.openclaw-env` contains the gateway token and IS in the rootfs. We handle this with defense-in-depth encryption (age).

   **What this buys (when wired up):** After first boot, subsequent boots skip all rootfs setup. Combined with postBuild, the flow would be: resume checkpoint → write env profile → start OpenClaw.

3. **Build script** — `scripts/build-images.sh` runs the full pipeline: build TypeScript packages (plugin dist needed for postBuild.copy), build OCI Docker images, run Gondolin `buildAssets` with postBuild. One command for the whole image stack.

   **What this buys:** Deterministic builds. No more wondering if the cache is stale or the plugin wasn't rebuilt.

**Separating structural config from user-specific config:**

`system.json` keeps the *structure*: which secrets exist, how they're injected (env vs HTTP mediation), which hosts get mediation. The actual 1Password `op://` URIs move to `.env.local` as `${SECRET_NAME}_REF` variables:

```
# .env.local
DISCORD_BOT_TOKEN_REF=op://agent-vm/agent-discord-app/bot-token
PERPLEXITY_API_KEY_REF=op://agent-vm/agent-perplexity/credential
```

The `op://` URIs are vault paths, not secret values — safe to template in `.env.example` with sensible defaults. A new user copies `.env.example` to `.env.local`, fills in `OP_SERVICE_ACCOUNT_TOKEN`, and the defaults work if their vault matches the template. If not, they override specific `*_REF` vars.

Resolution order: config `ref` field (explicit) → `${NAME}_REF` env var → error. This is backward compatible — existing system.json with inline refs still works.

**Critical: the CLI must load `.env.local` at startup.** Today nothing loads `.env.local` into `process.env` — only the vitest integration config and manual `source .env.local` do. Node 24 has `process.loadEnvFile()` built-in. The CLI entrypoint must call it before any secret resolution runs, or the entire `.env` ref pattern is dead on arrival.

**Zero-to-claw in six steps:**

```
agent-vm init shravan           # 1. Scaffold system.json, .env.local, zone config, directories
# edit .env.local               # 2. Set OP_SERVICE_ACCOUNT_TOKEN
./scripts/build-images.sh       # 3. Build OCI + Gondolin images (2-5 min first time, cached after)
agent-vm controller start       # 4. Boot gateway VM, start OpenClaw
agent-vm controller ssh-cmd     # 5. Interactive SSH for OAuth if needed
agent-vm controller doctor      # 6. Verify everything
```

The `init` command generates all the boilerplate: system.json with a default zone, OpenClaw config with the Gondolin sandbox plugin enabled, .env.local from the template, and all required directories.

### What we're NOT doing

- **Memory checkpoints** — Gondolin only supports disk checkpoints (no memory/process snapshots). OpenClaw still cold-starts on every boot. If Gondolin adds memory checkpoints later, we can adopt them.
- **Removing the OCI/Docker step** — The OCI image handles heavy dependencies (Node.js, OpenClaw, openssh). postBuild handles our customizations on top. We could theoretically do everything via postBuild.commands, but using an OCI base is faster (cached layers) and separates concerns.
- **Changing the trust model** — The three-zone architecture (host/gateway/tool) is validated and stays. We're improving the operational experience, not the security architecture.
- **Pool management for tool VMs** — Cold boot is 155ms. On-demand creation with no pool is the right call. No change needed.

### Tradeoffs

| Decision | What we gain | What we pay |
|----------|-------------|-------------|
| postBuild baking | No runtime setup overhead on every boot | Image must be rebuilt when plugin changes. Fingerprint-based cache handles this automatically, but the rebuild itself takes minutes. |
| Checkpoint resume (infrastructure only) | When wired up: skip first-boot-only disk setup on subsequent boots. This plan builds path/encryption infra, not the resume itself. | Checkpoint files are ~4GB (full rootfs). Disk space cost per zone. Age encryption adds ~10s to checkpoint create/restore. Resume wiring is a follow-up after VmCheckpoint API verification. |
| .env for refs | Clean separation of structural vs user config. Easy setup templating. | Two places to look for secret config (system.json structure + .env refs). Resolution order must be documented clearly. |
| `init` scaffolding | Zero-to-claw experience. No manual file creation. | Opinionated defaults. Users with non-standard setups need to edit generated files. |
| Checkpoint encryption | Defense in depth for gateway token in rootfs env file | Adds age dependency. ~10s overhead per checkpoint create/restore. Arguably unnecessary if we move the token out of the env file entirely — but belt-and-suspenders is right for secrets. |

### Execution order and dependencies

```
Phase A: Image Baking (postBuild)     ← Independent, biggest impact
  │
  ├── Phase B: .env Secret Refs       ← Independent of A, can run in parallel
  │     │
  │     └── Phase D: CLI Init         ← Depends on B (init generates .env template)
  │
  ├── Phase E: SSH UX                 ← Independent, small scope
  │
  └── Phase C: Checkpoint Resume      ← Depends on A (checkpoints from baked images)
        │
        └── Phase F: Encryption       ← Depends on C (encrypts checkpoint files)

Phase G: Documentation                ← Last, captures everything above
```

Recommended order: **A → B → D → E → C → F → G**

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `.env.example` | Template with 1P secret refs and hardcoded defaults |
| `scripts/build-images.sh` | Builds OCI Docker images + Gondolin assets in sequence |
| `packages/agent-vm/src/cli/init-command.ts` | `agent-vm init` scaffolding logic |
| `packages/agent-vm/src/cli/init-command.test.ts` | Tests for init command |
| `packages/agent-vm/src/gateway/gateway-checkpoint-manager.ts` | Checkpoint create/resume logic for gateway VMs |
| `packages/agent-vm/src/gateway/gateway-checkpoint-manager.test.ts` | Tests for checkpoint manager |

### Modified Files

| File | Change |
|------|--------|
| `images/gateway/build-config.json` | Add `postBuild.copy` + `postBuild.commands` |
| `images/tool/build-config.json` | Add `postBuild.commands` for CA trust |
| `packages/agent-vm/src/controller/system-config.ts` | Remove dead `postBuild` field from images schema, make `ref` optional in secrets |
| `packages/agent-vm/src/cli/agent-vm-entrypoint.ts` | Load `.env.local` via `process.loadEnvFile()` at startup |
| `packages/gondolin-core/src/build-pipeline.ts` | Include postBuild in fingerprint hash |
| `packages/agent-vm/src/gateway/gateway-vm-setup.ts` | Remove runtime CA update + plugin copy (now baked) |
| `packages/agent-vm/src/gateway/gateway-vm-configuration.ts` | Remove plugin VFS mount (now baked) |
| `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts` | Add checkpoint resume path |
| `packages/agent-vm/src/gateway/credential-manager.ts` | Resolve refs from env when missing in config |
| `packages/agent-vm/src/cli/agent-vm-entrypoint.ts` | Add `init` subcommand |
| `packages/agent-vm/src/cli/agent-vm-cli-support.ts` | Wire init command dependencies |
| `packages/gondolin-core/src/vm-adapter.ts` | Add `getVmInstance()` to `ManagedVm` interface (prep for future checkpoints) |
| `system.json` | Remove inline `ref` values (resolved from .env) |
| `docs/01-architecture-v4.md` (shravan-claw) | Update boot flow, postBuild, checkpoints |
| `docs/05-secrets-security-model.md` (shravan-claw) | Update .env ref pattern |

---

## Phase A: Image Baking via postBuild

### Task 1: Add postBuild to gateway build-config.json

**Files:**
- Modify: `images/gateway/build-config.json`

The gateway OCI image (`agent-vm-gateway:latest`, built by `images/gateway/Dockerfile`) already contains Node.js 24, OpenClaw, openssh, git, curl, python3. The postBuild adds our custom files on top: CA trust update and the plugin directory structure.

- [ ] **Step 1: Update build-config.json with postBuild section**

```json
{
  "arch": "aarch64",
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": [],
    "initramfsPackages": []
  },
  "oci": {
    "image": "agent-vm-gateway:latest",
    "pullPolicy": "never"
  },
  "rootfs": {
    "label": "gondolin-root",
    "sizeMb": 4096
  },
  "postBuild": {
    "copy": [
      {
        "src": "../../packages/openclaw-agent-vm-plugin/dist",
        "dest": "/opt/gondolin-plugin-staging"
      }
    ],
    "commands": [
      "ln -sf /proc/self/fd /dev/fd 2>/dev/null || true",
      "update-ca-certificates > /dev/null 2>&1 || true",
      "mkdir -p /usr/local/lib/node_modules/openclaw/dist/extensions/gondolin",
      "cp -a /opt/gondolin-plugin-staging/. /usr/local/lib/node_modules/openclaw/dist/extensions/gondolin/",
      "chown -R root:root /usr/local/lib/node_modules/openclaw/dist/extensions/gondolin",
      "rm -rf /opt/gondolin-plugin-staging",
      "mkdir -p /home/openclaw/.openclaw /home/openclaw/workspace /root"
    ]
  }
}
```

- [ ] **Step 2: Verify the plugin dist directory exists**

Run: `ls packages/openclaw-agent-vm-plugin/dist/index.js packages/openclaw-agent-vm-plugin/dist/openclaw.plugin.json`
Expected: Both files exist (built by `pnpm -r build` — the build compiles TS to `dist/index.js` and copies `openclaw.plugin.json` + `sdk-validate.mjs` into `dist/`)

- [ ] **Step 3: Commit**

```bash
git add images/gateway/build-config.json
git commit -m "feat: add postBuild to gateway build-config — bake plugin + CA trust into image"
```

---

### Task 2: Add postBuild to tool build-config.json

**Files:**
- Modify: `images/tool/build-config.json`

Tool VMs only need the CA trust update and /dev/fd symlink baked in. No plugin.

- [ ] **Step 1: Update build-config.json with postBuild section**

```json
{
  "arch": "aarch64",
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": [],
    "initramfsPackages": []
  },
  "oci": {
    "image": "agent-vm-tool:latest",
    "pullPolicy": "never"
  },
  "rootfs": {
    "label": "tool-root",
    "sizeMb": 2048
  },
  "postBuild": {
    "commands": [
      "ln -sf /proc/self/fd /dev/fd 2>/dev/null || true",
      "update-ca-certificates > /dev/null 2>&1 || true",
      "mkdir -p /workspace /run/sshd"
    ]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add images/tool/build-config.json
git commit -m "feat: add postBuild to tool build-config — bake CA trust into image"
```

---

### Task 3: Remove dead postBuild from system-config schema + update system.json

**Files:**
- Modify: `packages/agent-vm/src/controller/system-config.ts`
- Modify: `system.json`

The current schema has `postBuild: z.array(z.string())` in the images section, but **nothing reads it** — the controller loads `build-config.json` directly via `gateway-image-builder.ts`. postBuild config lives in `build-config.json` where Gondolin reads it. Having it in system-config creates dead config surface (a second source of truth for no runtime benefit). Remove it.

- [ ] **Step 1: Remove postBuild from the images schema**

In `packages/agent-vm/src/controller/system-config.ts`, change both gateway and tool image schemas:

Old:
```typescript
gateway: z.object({
  buildConfig: z.string().min(1),
  postBuild: z.array(z.string()),
}),
tool: z.object({
  buildConfig: z.string().min(1),
  postBuild: z.array(z.string()),
}),
```

New:
```typescript
gateway: z.object({
  buildConfig: z.string().min(1),
}),
tool: z.object({
  buildConfig: z.string().min(1),
}),
```

- [ ] **Step 2: Remove postBuild from system.json**

Remove the `"postBuild": []` arrays from `system.json` images section:

```json
"images": {
  "gateway": {
    "buildConfig": "./images/gateway/build-config.json"
  },
  "tool": {
    "buildConfig": "./images/tool/build-config.json"
  }
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/controller/system-config.ts system.json
git commit -m "fix: remove dead postBuild from system-config — build-config.json is the source of truth"
```

---

### Task 4: Include postBuild in build fingerprint

**Files:**
- Modify: `packages/gondolin-core/src/build-pipeline.ts`
- Test: `packages/gondolin-core/src/build-pipeline.test.ts` (existing)

The `computeBuildFingerprint` already hashes the full buildConfig. Since `postBuild` is part of `BuildConfig`, it's automatically included in the fingerprint via `stableSerialize(buildConfig)`. Verify this works correctly.

- [ ] **Step 1: Write a test to verify postBuild changes the fingerprint**

```typescript
// Add to packages/gondolin-core/src/build-pipeline.test.ts
import { describe, expect, it } from 'vitest';

import { computeBuildFingerprint } from './build-pipeline.js';

describe('computeBuildFingerprint', () => {
  it('produces different fingerprints when postBuild changes', () => {
    const baseConfig = {
      arch: 'aarch64',
      distro: 'alpine',
      alpine: { version: '3.23.0' },
    };

    const withPostBuild = {
      ...baseConfig,
      postBuild: {
        commands: ['update-ca-certificates'],
      },
    };

    const fingerprintWithout = computeBuildFingerprint(baseConfig as never);
    const fingerprintWith = computeBuildFingerprint(withPostBuild as never);
    expect(fingerprintWithout).not.toBe(fingerprintWith);
  });

  it('produces same fingerprint for identical postBuild configs', () => {
    const configA = {
      arch: 'aarch64',
      postBuild: { commands: ['echo hello'] },
    };
    const configB = {
      arch: 'aarch64',
      postBuild: { commands: ['echo hello'] },
    };

    expect(computeBuildFingerprint(configA as never)).toBe(
      computeBuildFingerprint(configB as never),
    );
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run packages/gondolin-core/src/build-pipeline`
Expected: PASS (no code changes needed — stableSerialize already handles nested objects)

- [ ] **Step 3: Commit**

```bash
git add packages/gondolin-core/src/build-pipeline.test.ts
git commit -m "test: verify postBuild changes build fingerprint"
```

---

### Task 5: Strip runtime setup from gateway-vm-setup.ts

**Files:**
- Modify: `packages/agent-vm/src/gateway/gateway-vm-setup.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-vm-configuration.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- Test: existing tests in `packages/agent-vm/src/gateway/`

Now that CA trust, /dev/fd, and plugin files are baked into the image via postBuild, the runtime setup in `setupGatewayVmRuntime` can be stripped to only the zone-specific env profile.

- [ ] **Step 1: Write test for stripped runtime setup**

```typescript
// Add to packages/agent-vm/src/gateway/gateway-vm-setup.test.ts
import { describe, expect, it, vi } from 'vitest';

import { setupGatewayVmRuntime } from './gateway-vm-setup.js';

describe('setupGatewayVmRuntime (post-bake)', () => {
  it('writes env profile but does not run CA update or plugin copy', async () => {
    const execCalls: string[] = [];
    const mockVm = {
      id: 'test-vm',
      exec: vi.fn(async (command: string) => {
        execCalls.push(command);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
      enableSsh: vi.fn(),
      enableIngress: vi.fn(),
      setIngressRoutes: vi.fn(),
      close: vi.fn(),
    };

    await setupGatewayVmRuntime({
      managedVm: mockVm,
      openClawConfigPath: './config/shravan/openclaw.json',
      gatewayToken: 'test-token',
    });

    // Should write env profile
    expect(execCalls.some((cmd) => cmd.includes('.openclaw-env'))).toBe(true);

    // Should NOT run update-ca-certificates (baked in)
    expect(execCalls.some((cmd) => cmd.includes('update-ca-certificates'))).toBe(false);

    // Should NOT run plugin copy (baked in)
    expect(execCalls.some((cmd) => cmd.includes('cp -a /opt/gondolin-plugin-src'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/gateway/gateway-vm-setup`
Expected: FAIL (current code still runs CA update and plugin copy)

- [ ] **Step 3: Strip runtime setup in gateway-vm-setup.ts**

Replace `setupGatewayVmRuntime` in `packages/agent-vm/src/gateway/gateway-vm-setup.ts`:

```typescript
export async function setupGatewayVmRuntime(options: {
  readonly gatewayToken?: string;
  readonly managedVm: ManagedVm;
  readonly openClawConfigPath: string;
}): Promise<void> {
  const gatewayEnvironmentProfile =
    'export OPENCLAW_HOME=/home/openclaw\n' +
    `export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/config/${path.basename(options.openClawConfigPath)}\n` +
    'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state\n' +
    (options.gatewayToken
      ? `export OPENCLAW_GATEWAY_TOKEN='${options.gatewayToken.replace(/'/gu, "'\\''")}'\n`
      : '') +
    'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt\n';

  await options.managedVm.exec(
    'mkdir -p /root && cat > /root/.openclaw-env << ENVEOF\n' +
      gatewayEnvironmentProfile +
      'ENVEOF\n' +
      'chmod 600 /root/.openclaw-env && ' +
      'touch /root/.bashrc && ' +
      "grep -qxF 'source /root/.openclaw-env' /root/.bashrc || echo 'source /root/.openclaw-env' >> /root/.bashrc",
  );
}
```

Key changes:
- Removed `ln -sf /proc/self/fd /dev/fd` (baked in via postBuild)
- Removed `update-ca-certificates` (baked in via postBuild)
- Removed `pluginSourceDir` parameter and plugin copy block (baked in via postBuild)

- [ ] **Step 4: Remove plugin VFS mount from gateway-vm-configuration.ts**

In `packages/agent-vm/src/gateway/gateway-vm-configuration.ts`, the `buildGatewayVmFactoryOptions` function currently adds a `/opt/gondolin-plugin-src` VFS mount when `pluginSourceDir` is provided. Remove that mount:

Old (in the `vfsMounts` object):
```typescript
...(options.pluginSourceDir
  ? {
      '/opt/gondolin-plugin-src': {
        hostPath: options.pluginSourceDir,
        kind: 'realfs-readonly' as const,
      },
    }
  : {}),
```

Remove this block entirely. The plugin is now baked into the image.

Also remove `pluginSourceDir` from the options interface of `buildGatewayVmFactoryOptions`.

- [ ] **Step 5: Update gateway-zone-orchestrator.ts**

Remove `pluginSourceDir` from `setupGatewayVmRuntime` call and `createGatewayVm` call:

In `startGatewayZone`, the call to `createGatewayVm` currently spreads `pluginSourceDir`. Remove it:

```typescript
const managedVm = await createGatewayVm(
  {
    controllerPort: options.systemConfig.host.controllerPort,
    gatewayImagePath: image.imagePath,
    resolvedSecrets,
    secretResolver: options.secretResolver,
    systemConfig: options.systemConfig,
    zone,
  },
  dependencies.createManagedVm ? { createManagedVm: dependencies.createManagedVm } : {},
);
await setupGatewayVmRuntime({
  ...(resolvedSecrets.OPENCLAW_GATEWAY_TOKEN
    ? { gatewayToken: resolvedSecrets.OPENCLAW_GATEWAY_TOKEN }
    : {}),
  managedVm,
  openClawConfigPath: zone.gateway.openclawConfig,
});
```

Remove `pluginSourceDir` from `StartGatewayZoneOptions` in `gateway-zone-support.ts` as well.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/gateway/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/gateway/
git commit -m "feat: strip runtime CA/plugin setup — now baked into image via postBuild"
```

---

### Task 6: Create image build script

**Files:**
- Create: `scripts/build-images.sh`

This script builds both OCI Docker images and then runs Gondolin `buildAssets` to produce the final VM images.

**Important:** The build script must write Gondolin assets to the same cache directory the controller uses at runtime. The controller resolves the cache path from `${zone.gateway.stateDir}/images/gateway/` (see `gateway-zone-orchestrator.ts:34`). If the script writes to a different path (e.g. `build-cache/gateway/`), `controller start` won't find the cached assets and will rebuild from scratch — defeating the purpose of pre-building.

The script reads `system.json` to discover zone state directories and writes assets there.

- [ ] **Step 1: Create the build script**

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_PATH="${1:-$ROOT_DIR/system.json}"

echo "=== Building agent-vm images ==="

# Step 1: Build the TypeScript packages (plugin dist is needed for postBuild.copy)
echo "[1/4] Building TypeScript packages..."
cd "$ROOT_DIR"
pnpm -r build

# Step 2: Build OCI Docker images
echo "[2/4] Building gateway OCI image..."
docker build -t agent-vm-gateway:latest "$ROOT_DIR/images/gateway"

echo "[3/4] Building tool OCI image..."
docker build -t agent-vm-tool:latest "$ROOT_DIR/images/tool"

# Step 3: Build Gondolin VM assets into the cache dirs the controller uses.
# The controller caches gateway images at ${zone.stateDir}/images/gateway/.
# We read system.json to find the zone state dirs so the cache is primed
# in the right place.
echo "[4/4] Building Gondolin VM assets..."
node --input-type=module -e "
  import { buildAssets } from '@earendil-works/gondolin';
  import fs from 'node:fs';
  import path from 'node:path';

  const rootDir = '${ROOT_DIR}';
  const configPath = path.resolve('${CONFIG_PATH}');
  const configDir = path.dirname(configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  function resolvePath(p) {
    return path.isAbsolute(p) ? p : path.resolve(configDir, p);
  }

  async function build(name, buildConfigPath, outputDir) {
    const buildConfig = JSON.parse(fs.readFileSync(buildConfigPath, 'utf8'));
    fs.mkdirSync(outputDir, { recursive: true });
    console.log('  Building ' + name + ' → ' + outputDir);
    await buildAssets(buildConfig, { outputDir, verbose: true });
    console.log('  ' + name + ' done.');
  }

  // Build gateway and tool images into each zone's cache dir.
  // The controller reads gateway assets from \${zone.stateDir}/images/gateway/
  // (gateway-zone-orchestrator.ts:34) and tool assets from
  // \${zone.stateDir}/images/tool/ (tool-vm-lifecycle.ts:63).
  // Both must be primed per-zone.
  const gatewayBuildConfig = resolvePath(config.images.gateway.buildConfig);
  const toolBuildConfig = resolvePath(config.images.tool.buildConfig);
  for (const zone of config.zones) {
    const zoneStateDir = resolvePath(zone.gateway.stateDir);
    await build(
      'gateway (' + zone.id + ')',
      gatewayBuildConfig,
      path.join(zoneStateDir, 'images', 'gateway'),
    );
    await build(
      'tool (' + zone.id + ')',
      toolBuildConfig,
      path.join(zoneStateDir, 'images', 'tool'),
    );
  }
"

echo ""
echo "=== All images built ==="
```

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/build-images.sh`

- [ ] **Step 3: Commit**

```bash
git add scripts/build-images.sh
git commit -m "feat: add build-images.sh — builds OCI + Gondolin assets in sequence"
```

---

## Phase B: .env Secret Refs

### Task 7: Create .env.example template

**Files:**
- Create: `.env.example`

Move 1Password secret refs from system.json into .env with hardcoded defaults. The `op://` URIs are vault paths (not secrets) so they're safe to template.

- [ ] **Step 1: Create .env.example**

```bash
# agent-vm environment configuration
# Copy to .env.local and fill in values.

# === 1Password Service Account Token (required) ===
# Get from: https://my.1password.com/developer-tools/service-accounts
OP_SERVICE_ACCOUNT_TOKEN=

# === Secret References ===
# 1Password op:// URIs pointing to where each secret lives.
# Override these if your vault structure differs from the defaults.
DISCORD_BOT_TOKEN_REF=op://agent-vm/agent-discord-app/bot-token
PERPLEXITY_API_KEY_REF=op://agent-vm/agent-perplexity/credential
OPENCLAW_GATEWAY_TOKEN_REF=op://agent-vm/agent-shravan-claw-gateway/password

# === Snapshot Encryption ===
# Age identity key for encrypting zone snapshots (state + workspace backups).
# Generate with: age-keygen
AGE_IDENTITY_KEY=
```

- [ ] **Step 2: Add .env.local to .gitignore if not already present**

Run: `grep -q '.env.local' .gitignore || echo '.env.local' >> .gitignore`

- [ ] **Step 3: Commit**

```bash
git add .env.example .gitignore
git commit -m "feat: add .env.example — template for secret refs with hardcoded 1P defaults"
```

---

### Task 8: Update secret resolution to use env-based refs

**Files:**
- Modify: `packages/agent-vm/src/controller/system-config.ts`
- Modify: `packages/agent-vm/src/gateway/credential-manager.ts`
- Test: `packages/agent-vm/src/gateway/credential-manager.test.ts`

When `ref` is missing from a secret in system.json, resolve it from `${SECRET_NAME}_REF` environment variable.

- [ ] **Step 1: Write failing test**

```typescript
// packages/agent-vm/src/gateway/credential-manager.test.ts
import { describe, expect, it, vi } from 'vitest';

import { resolveZoneSecrets } from './credential-manager.js';

describe('resolveZoneSecrets with env-based refs', () => {
  it('resolves ref from environment when not in config', async () => {
    const originalEnv = process.env.DISCORD_BOT_TOKEN_REF;
    process.env.DISCORD_BOT_TOKEN_REF = 'op://test-vault/test-item/token';

    const mockResolver = {
      resolve: vi.fn(async (ref) => `resolved-${ref.ref}`),
      resolveAll: vi.fn(async (refs) => {
        const results: Record<string, string> = {};
        for (const [name, ref] of Object.entries(refs)) {
          results[name] = `resolved-${ref.ref}`;
        }
        return results;
      }),
    };

    const result = await resolveZoneSecrets({
      systemConfig: {
        zones: [
          {
            id: 'test',
            gateway: {
              memory: '2G',
              cpus: 2,
              port: 18791,
              openclawConfig: './config/test/openclaw.json',
              stateDir: './state/test',
              workspaceDir: './workspaces/test',
            },
            secrets: {
              DISCORD_BOT_TOKEN: {
                source: '1password' as const,
                injection: 'env' as const,
                // ref intentionally omitted — should come from env
              },
            },
            allowedHosts: ['discord.com'],
            websocketBypass: [],
            toolProfile: 'standard',
          },
        ],
      } as never,
      zoneId: 'test',
      secretResolver: mockResolver,
    });

    expect(mockResolver.resolveAll).toHaveBeenCalled();
    const callArg = mockResolver.resolveAll.mock.calls[0]?.[0] as Record<string, { ref: string }>;
    expect(callArg.DISCORD_BOT_TOKEN.ref).toBe('op://test-vault/test-item/token');

    process.env.DISCORD_BOT_TOKEN_REF = originalEnv;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/gateway/credential-manager`
Expected: FAIL

- [ ] **Step 3: Make ref optional in system-config schema**

In `packages/agent-vm/src/controller/system-config.ts`:

Old:
```typescript
const secretReferenceSchema = z.object({
  source: z.literal('1password'),
  ref: z.string().min(1),
  injection: z.enum(['env', 'http-mediation']).default('env'),
  hosts: z.array(z.string().min(1)).optional(),
});
```

New:
```typescript
const secretReferenceSchema = z.object({
  source: z.literal('1password'),
  ref: z.string().min(1).optional(),
  injection: z.enum(['env', 'http-mediation']).default('env'),
  hosts: z.array(z.string().min(1)).optional(),
});
```

- [ ] **Step 4: Update credential-manager.ts to resolve refs from env**

In `packages/agent-vm/src/gateway/credential-manager.ts`:

```typescript
import type { SecretRef, SecretResolver } from 'gondolin-core';

import type { SystemConfig } from '../controller/system-config.js';

function findZone(
  systemConfig: SystemConfig,
  zoneId: string,
): SystemConfig['zones'][number] | undefined {
  return systemConfig.zones.find((zone) => zone.id === zoneId);
}

function resolveSecretRef(
  secretName: string,
  secretConfig: { readonly ref?: string },
): string {
  if (secretConfig.ref) {
    return secretConfig.ref;
  }

  const envVarName = `${secretName}_REF`;
  const envValue = process.env[envVarName]?.trim();
  if (!envValue) {
    throw new Error(
      `Secret '${secretName}' has no ref in config and ${envVarName} is not set in environment.`,
    );
  }

  return envValue;
}

export async function resolveZoneSecrets(options: {
  readonly systemConfig: SystemConfig;
  readonly zoneId: string;
  readonly secretResolver: SecretResolver;
}): Promise<Record<string, string>> {
  const zone = findZone(options.systemConfig, options.zoneId);
  if (!zone) {
    throw new Error(`Unknown zone '${options.zoneId}'.`);
  }

  const resolvedRefs: Record<string, SecretRef> = {};
  for (const [secretName, secretConfig] of Object.entries(zone.secrets)) {
    resolvedRefs[secretName] = {
      source: secretConfig.source,
      ref: resolveSecretRef(secretName, secretConfig),
    };
  }

  return await options.secretResolver.resolveAll(resolvedRefs);
}
```

- [ ] **Step 5: Load .env.local in CLI entrypoint**

This is critical — without it, the `${NAME}_REF` env vars won't be in `process.env` and secret resolution will fail. Node 24 has `process.loadEnvFile()` built-in.

In `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`, add at the very top of the file (before any imports that might trigger side effects):

```typescript
// Load .env.local into process.env before anything else.
// Node 24's built-in loadEnvFile throws if file doesn't exist, so guard it.
try {
  process.loadEnvFile('.env.local');
} catch {
  // .env.local is optional — secrets may come from system.json refs or shell env
}
```

Place this before the existing imports. This ensures `process.env` has the `*_REF` variables before `credential-manager.ts` reads them.

- [ ] **Step 6: Update system.json to use env-based refs**

Remove inline `ref` values from `system.json`. The refs will come from `.env.local` via the `*_REF` convention:

```json
"secrets": {
  "DISCORD_BOT_TOKEN": {
    "source": "1password",
    "injection": "env"
  },
  "PERPLEXITY_API_KEY": {
    "source": "1password",
    "injection": "http-mediation",
    "hosts": ["api.perplexity.ai"]
  },
  "OPENCLAW_GATEWAY_TOKEN": {
    "source": "1password",
    "injection": "env"
  }
}
```

- [ ] **Step 7: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/gateway/credential-manager`
Expected: PASS

- [ ] **Step 8: Run all tests**

Run: `pnpm vitest run`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/agent-vm/src/controller/system-config.ts packages/agent-vm/src/gateway/credential-manager.ts packages/agent-vm/src/gateway/credential-manager.test.ts packages/agent-vm/src/cli/agent-vm-entrypoint.ts system.json
git commit -m "feat: resolve secret refs from env — ref optional in config, .env.local loaded at startup"
```

---

## Phase C: Checkpoint Fast Resume

### Task 9: Add checkpoint method to ManagedVm interface

**Files:**
- Modify: `packages/gondolin-core/src/vm-adapter.ts`
- Create: `packages/gondolin-core/src/checkpoint-adapter.ts`
- Create: `packages/gondolin-core/src/checkpoint-adapter.test.ts`
- Modify: `packages/gondolin-core/src/index.ts`

Add `getVmInstance()` to the `ManagedVm` interface so the checkpoint infrastructure can access the underlying Gondolin VM for future checkpoint operations. This task does NOT export a `resumeFromCheckpoint` API — that's deferred to the follow-up when the VmCheckpoint API is verified. Shipping a public function that intentionally throws would be a fake API.

- [ ] **Step 1: Add getVmInstance to ManagedVm interface**

In `packages/gondolin-core/src/vm-adapter.ts`, add to the `ManagedVm` interface:

```typescript
export interface ManagedVm {
  readonly id: string;
  exec(command: string): Promise<ExecResult>;
  enableSsh(options?: unknown): Promise<SshAccess>;
  enableIngress(options?: unknown): Promise<IngressAccess>;
  setIngressRoutes(routes: readonly IngressRoute[]): void;
  close(): Promise<void>;
  /** Access the underlying VM instance for checkpoint operations (future use). */
  getVmInstance(): ManagedVmInstance;
}
```

In the return object of `createManagedVm`, add:
```typescript
getVmInstance(): ManagedVmInstance {
  return vmInstance;
},
```

- [ ] **Step 2: Write test for getVmInstance**

```typescript
// Add to packages/gondolin-core/src/vm-adapter.test.ts
import { describe, expect, it, vi } from 'vitest';

import { createManagedVm } from './vm-adapter.js';

describe('ManagedVm.getVmInstance', () => {
  it('returns the underlying VM instance', async () => {
    const mockInstance = {
      id: 'test-vm',
      exec: vi.fn(async () => ({ exitCode: 0 })),
      enableSsh: vi.fn(),
      enableIngress: vi.fn(),
      setIngressRoutes: vi.fn(),
      close: vi.fn(),
    };

    const vm = await createManagedVm(
      {
        imagePath: '',
        memory: '512M',
        cpus: 1,
        rootfsMode: 'cow',
        allowedHosts: [],
        secrets: {},
        vfsMounts: {},
      },
      {
        createVm: vi.fn(async () => mockInstance),
        createHttpHooks: vi.fn(() => ({ env: {}, httpHooks: {} })),
        createRealFsProvider: vi.fn(),
        createReadonlyProvider: vi.fn(),
        createMemoryProvider: vi.fn(),
        createShadowProvider: vi.fn(),
        createShadowPathPredicate: vi.fn(),
      },
    );

    expect(vm.getVmInstance()).toBe(mockInstance);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run packages/gondolin-core/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/gondolin-core/src/vm-adapter.ts packages/gondolin-core/src/vm-adapter.test.ts
git commit -m "feat: add getVmInstance to ManagedVm — prep for checkpoint support"
```

---

### Task 10: Build checkpoint path resolution (infrastructure — resume is a follow-up)

**Files:**
- Create: `packages/agent-vm/src/gateway/gateway-checkpoint-manager.ts`
- Create: `packages/agent-vm/src/gateway/gateway-checkpoint-manager.test.ts`

This task builds the path resolution and existence-check infrastructure for checkpoints. It does NOT wire up actual checkpoint create/resume — that requires verifying Gondolin's `VmCheckpoint` API against the linked SDK version and is a follow-up task.

**Why build the infra now:** The storage path decision (outside stateDir) and encryption design (Phase F) need to be settled before resume can be wired up. Getting path resolution right now prevents a refactor later.

**Why checkpoints must NOT be under stateDir:** The zone's `stateDir` is VFS-mounted into the gateway VM (`gateway-vm-configuration.ts:123`) and is copied wholesale by `snapshot-create-operation.ts:30` into encrypted zone snapshots. A 4GB qcow2 checkpoint file there would: (a) be visible inside the guest VM, (b) bloat every zone snapshot by 4GB.

Checkpoints live at the project root under `./checkpoints/${zoneId}/`:

- [ ] **Step 1: Write test for checkpoint manager**

```typescript
// packages/agent-vm/src/gateway/gateway-checkpoint-manager.test.ts
import { describe, expect, it } from 'vitest';

import {
  resolveCheckpointPath,
  shouldUseCheckpoint,
} from './gateway-checkpoint-manager.js';

describe('gateway-checkpoint-manager', () => {
  it('resolveCheckpointPath returns path under checkpoints dir, not stateDir', () => {
    const result = resolveCheckpointPath('./checkpoints', 'shravan', 'abc123');
    expect(result).toBe('checkpoints/shravan/gateway-abc123.qcow2');
  });

  it('shouldUseCheckpoint returns false when file does not exist', () => {
    const result = shouldUseCheckpoint('/nonexistent/path.qcow2');
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/gateway/gateway-checkpoint-manager`
Expected: FAIL

- [ ] **Step 3: Implement gateway-checkpoint-manager.ts**

```typescript
// packages/agent-vm/src/gateway/gateway-checkpoint-manager.ts
import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves the checkpoint file path for a gateway zone.
 * Checkpoints live OUTSIDE stateDir (which is VFS-mounted and swept by snapshots).
 */
export function resolveCheckpointPath(
  checkpointsBaseDir: string,
  zoneId: string,
  imageFingerprint: string,
): string {
  return path.join(checkpointsBaseDir, zoneId, `gateway-${imageFingerprint}.qcow2`);
}

export function shouldUseCheckpoint(checkpointPath: string): boolean {
  return fs.existsSync(checkpointPath);
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/gateway/gateway-checkpoint-manager`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent-vm/src/gateway/gateway-checkpoint-manager.ts packages/agent-vm/src/gateway/gateway-checkpoint-manager.test.ts
git commit -m "feat: add gateway checkpoint path resolution — outside stateDir to avoid VFS/snapshot leak"
```

---

## Phase D: CLI Init Command

### Task 11: Add `agent-vm init` command

**Files:**
- Create: `packages/agent-vm/src/cli/init-command.ts`
- Create: `packages/agent-vm/src/cli/init-command.test.ts`
- Modify: `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`

The `init` command scaffolds a new agent-vm project: creates `system.json`, `.env.local`, config directory, and state directory. It does NOT run `doctor` — the user runs `agent-vm controller doctor` separately as the final verification step.

- [ ] **Step 1: Write test for init command**

```typescript
// packages/agent-vm/src/cli/init-command.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scaffoldAgentVmProject } from './init-command.js';

describe('scaffoldAgentVmProject', () => {
  const testDir = path.join(os.tmpdir(), `agent-vm-init-test-${Date.now()}`);

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('creates system.json with default zone', () => {
    const result = scaffoldAgentVmProject({ targetDir: testDir, zoneId: 'test-zone' });
    expect(result.created).toContain('system.json');
    const config = JSON.parse(fs.readFileSync(path.join(testDir, 'system.json'), 'utf8'));
    expect(config.zones[0].id).toBe('test-zone');
  });

  it('creates .env.local from template', () => {
    const result = scaffoldAgentVmProject({ targetDir: testDir, zoneId: 'test-zone' });
    expect(result.created).toContain('.env.local');
    const envContent = fs.readFileSync(path.join(testDir, '.env.local'), 'utf8');
    expect(envContent).toContain('OP_SERVICE_ACCOUNT_TOKEN=');
    expect(envContent).toContain('DISCORD_BOT_TOKEN_REF=');
  });

  it('creates config and state directories', () => {
    scaffoldAgentVmProject({ targetDir: testDir, zoneId: 'my-zone' });
    expect(fs.existsSync(path.join(testDir, 'config', 'my-zone'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'state', 'my-zone'))).toBe(true);
    expect(fs.existsSync(path.join(testDir, 'workspaces', 'my-zone'))).toBe(true);
  });

  it('does not overwrite existing system.json', () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'system.json'), '{"existing": true}');
    const result = scaffoldAgentVmProject({ targetDir: testDir, zoneId: 'test-zone' });
    expect(result.skipped).toContain('system.json');
    const config = JSON.parse(fs.readFileSync(path.join(testDir, 'system.json'), 'utf8'));
    expect(config.existing).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/cli/init-command`
Expected: FAIL

- [ ] **Step 3: Implement init-command.ts**

```typescript
// packages/agent-vm/src/cli/init-command.ts
import fs from 'node:fs';
import path from 'node:path';

interface ScaffoldOptions {
  readonly targetDir: string;
  readonly zoneId: string;
}

interface ScaffoldResult {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
}

const DEFAULT_SYSTEM_CONFIG = (zoneId: string): object => ({
  host: {
    controllerPort: 18800,
    secretsProvider: {
      type: '1password',
      tokenSource: {
        type: 'env',
        envVar: 'OP_SERVICE_ACCOUNT_TOKEN',
      },
    },
  },
  images: {
    gateway: {
      buildConfig: './images/gateway/build-config.json',
    },
    tool: {
      buildConfig: './images/tool/build-config.json',
    },
  },
  zones: [
    {
      id: zoneId,
      gateway: {
        memory: '2G',
        cpus: 2,
        port: 18791,
        openclawConfig: `./config/${zoneId}/openclaw.json`,
        stateDir: `./state/${zoneId}`,
        workspaceDir: `./workspaces/${zoneId}`,
      },
      secrets: {
        DISCORD_BOT_TOKEN: {
          source: '1password',
          injection: 'env',
        },
        PERPLEXITY_API_KEY: {
          source: '1password',
          injection: 'http-mediation',
          hosts: ['api.perplexity.ai'],
        },
        OPENCLAW_GATEWAY_TOKEN: {
          source: '1password',
          injection: 'env',
        },
      },
      allowedHosts: [
        'api.openai.com',
        'auth.openai.com',
        'api.perplexity.ai',
        'discord.com',
        'cdn.discordapp.com',
        'api.github.com',
        'registry.npmjs.org',
      ],
      websocketBypass: [
        'gateway.discord.gg:443',
        'web.whatsapp.com:443',
        'g.whatsapp.net:443',
        'mmg.whatsapp.net:443',
      ],
      toolProfile: 'standard',
    },
  ],
  toolProfiles: {
    standard: {
      memory: '1G',
      cpus: 1,
      workspaceRoot: './workspaces/tools',
    },
  },
  tcpPool: {
    basePort: 19000,
    size: 5,
  },
});

const ENV_TEMPLATE = `# agent-vm environment configuration
# Fill in required values below.

# === 1Password Service Account Token (required) ===
OP_SERVICE_ACCOUNT_TOKEN=

# === Secret References (1Password op:// URIs) ===
DISCORD_BOT_TOKEN_REF=op://agent-vm/agent-discord-app/bot-token
PERPLEXITY_API_KEY_REF=op://agent-vm/agent-perplexity/credential
OPENCLAW_GATEWAY_TOKEN_REF=op://agent-vm/agent-shravan-claw-gateway/password

# === Snapshot Encryption ===
# Generate with: age-keygen
AGE_IDENTITY_KEY=
`;

const OPENCLAW_CONFIG_TEMPLATE = (zoneId: string): object => ({
  gateway: {
    port: 18789,
    mode: 'local',
    bind: 'loopback',
    auth: { mode: 'token' },
  },
  agents: {
    defaults: {
      workspace: '/home/openclaw/workspace',
      model: { primary: 'openai-codex/gpt-5.4' },
      sandbox: { mode: 'all', backend: 'gondolin', scope: 'session' },
    },
  },
  tools: { elevated: { enabled: false } },
  plugins: {
    entries: {
      gondolin: {
        enabled: true,
        config: {
          controllerUrl: 'http://controller.vm.host:18800',
          zoneId,
        },
      },
    },
  },
  channels: {},
});

function writeIfMissing(filePath: string, content: string): 'created' | 'skipped' {
  if (fs.existsSync(filePath)) {
    return 'skipped';
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return 'created';
}

export function scaffoldAgentVmProject(options: ScaffoldOptions): ScaffoldResult {
  const created: string[] = [];
  const skipped: string[] = [];

  const systemJsonPath = path.join(options.targetDir, 'system.json');
  const systemJsonStatus = writeIfMissing(
    systemJsonPath,
    JSON.stringify(DEFAULT_SYSTEM_CONFIG(options.zoneId), null, '\t') + '\n',
  );
  (systemJsonStatus === 'created' ? created : skipped).push('system.json');

  const envPath = path.join(options.targetDir, '.env.local');
  const envStatus = writeIfMissing(envPath, ENV_TEMPLATE);
  (envStatus === 'created' ? created : skipped).push('.env.local');

  const openclawConfigPath = path.join(
    options.targetDir,
    'config',
    options.zoneId,
    'openclaw.json',
  );
  const openclawStatus = writeIfMissing(
    openclawConfigPath,
    JSON.stringify(OPENCLAW_CONFIG_TEMPLATE(options.zoneId), null, '\t') + '\n',
  );
  (openclawStatus === 'created' ? created : skipped).push(
    `config/${options.zoneId}/openclaw.json`,
  );

  const directories = [
    path.join(options.targetDir, 'state', options.zoneId),
    path.join(options.targetDir, 'workspaces', options.zoneId),
    path.join(options.targetDir, 'workspaces', 'tools'),
    path.join(options.targetDir, 'images', 'gateway'),
    path.join(options.targetDir, 'images', 'tool'),
  ];
  for (const dir of directories) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return { created, skipped };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/cli/init-command`
Expected: PASS

- [ ] **Step 5: Wire init into CLI entrypoint**

In `packages/agent-vm/src/cli/agent-vm-entrypoint.ts`, add the `init` case before the `controller` group:

```typescript
import { scaffoldAgentVmProject } from './init-command.js';

// In runAgentVmCli, before the controller check:
if (commandGroup === 'init') {
  const zoneId = argv[1] || 'default';
  const result = scaffoldAgentVmProject({
    targetDir: process.cwd(),
    zoneId,
  });
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return;
}
```

This makes the command: `agent-vm init <zone-id>`

- [ ] **Step 6: Run all tests**

Run: `pnpm vitest run packages/agent-vm/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/cli/init-command.ts packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/cli/agent-vm-entrypoint.ts
git commit -m "feat: add agent-vm init command — scaffolds system.json, .env, zone config"
```

---

## Phase E: SSH UX

### Task 12: Improve SSH gateway access

**Files:**
- Modify: `packages/agent-vm/src/cli/ssh-commands.ts`

**This is a UX enhancement, not already-working behavior.** The current `ssh-commands.ts` only *prints* the SSH command string or JSON response from the controller API (`ssh-commands.ts:27`). It does NOT spawn an interactive SSH session itself. The user currently has to copy-paste the printed command into their terminal.

The enhancement: spawn `ssh` directly with `stdio: 'inherit'` so the user gets an interactive shell in one step.

- [ ] **Step 1: Read the current ssh-commands.ts**

Read `packages/agent-vm/src/cli/ssh-commands.ts` to understand what it currently does (prints SSH command, doesn't spawn it).

- [ ] **Step 2: Add interactive SSH mode**

The command should:
1. Call controller API to get SSH access details (already implemented)
2. Instead of printing the command, spawn `ssh -i <identityFile> -p <port> root@<host>` with `stdio: 'inherit'` for interactive mode
3. Support one-shot mode with `-- <command>`: `agent-vm controller ssh-cmd --zone shravan -- openclaw auth login`
4. Fall back to printing the command if `--print` flag is passed (for scripting)

Use `execa` (already a dependency) with `stdio: 'inherit'` for the interactive spawn.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-vm/src/cli/ssh-commands.ts
git commit -m "feat: improve SSH command — interactive mode for gateway OAuth setup"
```

---

## Phase F: Checkpoint Encryption (Defense in Depth)

### Task 13: Encrypt gateway checkpoints with age

**Files:**
- Modify: `packages/agent-vm/src/gateway/gateway-checkpoint-manager.ts`
- Test: `packages/agent-vm/src/gateway/gateway-checkpoint-manager.test.ts`

Although Gondolin checkpoints capture only rootfs (VFS mounts like state/workspace are excluded), the rootfs MAY contain the gateway token in `/root/.openclaw-env`. As defense in depth, encrypt checkpoints using the existing age encryption infrastructure.

- [ ] **Step 1: Write test**

```typescript
// Add to packages/agent-vm/src/gateway/gateway-checkpoint-manager.test.ts
import { describe, expect, it, vi } from 'vitest';

import {
  encryptCheckpointFile,
  decryptCheckpointFile,
} from './gateway-checkpoint-manager.js';

describe('checkpoint encryption', () => {
  it('encryptCheckpointFile calls encryption.encrypt with correct paths', async () => {
    const mockEncrypt = vi.fn(async () => {});
    await encryptCheckpointFile(
      '/tmp/gateway.qcow2',
      { encrypt: mockEncrypt, decrypt: vi.fn() },
    );
    expect(mockEncrypt).toHaveBeenCalledWith(
      '/tmp/gateway.qcow2',
      '/tmp/gateway.qcow2.age',
    );
  });

  it('decryptCheckpointFile calls encryption.decrypt with correct paths', async () => {
    const mockDecrypt = vi.fn(async () => {});
    await decryptCheckpointFile(
      '/tmp/gateway.qcow2.age',
      { encrypt: vi.fn(), decrypt: mockDecrypt },
    );
    expect(mockDecrypt).toHaveBeenCalledWith(
      '/tmp/gateway.qcow2.age',
      '/tmp/gateway.qcow2',
    );
  });
});
```

- [ ] **Step 2: Implement encryption helpers**

Add to `packages/agent-vm/src/gateway/gateway-checkpoint-manager.ts`:

```typescript
import type { SnapshotEncryption } from '../snapshots/snapshot-manager.js';

export async function encryptCheckpointFile(
  checkpointPath: string,
  encryption: SnapshotEncryption,
): Promise<string> {
  const encryptedPath = `${checkpointPath}.age`;
  await encryption.encrypt(checkpointPath, encryptedPath);
  return encryptedPath;
}

export async function decryptCheckpointFile(
  encryptedPath: string,
  encryption: SnapshotEncryption,
): Promise<string> {
  const decryptedPath = encryptedPath.replace(/\.age$/u, '');
  await encryption.decrypt(encryptedPath, decryptedPath);
  return decryptedPath;
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/gateway/gateway-checkpoint-manager`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/gateway/gateway-checkpoint-manager.ts packages/agent-vm/src/gateway/gateway-checkpoint-manager.test.ts
git commit -m "feat: add checkpoint encryption — age encrypt/decrypt for gateway checkpoints"
```

---

## Phase G: Documentation Updates

### Task 14: Update architecture doc

**Files:**
- Modify: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/01-architecture-v4.md`

Update the architecture doc to reflect:
1. postBuild image baking (no more runtime CA/plugin setup)
2. Checkpoint-based fast resume
3. .env secret ref pattern
4. `init` command

- [ ] **Step 1: Update the system topology section**

Replace the gateway VM description to show that plugins and CA certs are baked into the image. Remove the runtime setup mentions. Add checkpoint flow.

Key changes to the topology diagram:
- Add `postBuild: plugin + CA trust baked in` under each VM
- Add checkpoint resume path annotation
- Update secret placement table to show .env ref pattern

- [ ] **Step 2: Add a "Boot flow" section**

```markdown
## Boot flow

### First boot (image not cached)
1. `build-images.sh` builds OCI Docker images + Gondolin assets with postBuild
2. postBuild bakes: CA trust update, plugin install, directory structure
3. VM boots from cached image (~155ms)
4. Runtime writes zone-specific env profile to `/root/.openclaw-env`
5. OpenClaw starts, channels connect
6. Checkpoint saved for fast subsequent boots

### Subsequent boots (checkpoint exists)
1. Resume from encrypted checkpoint (disk state restored)
2. Runtime writes zone-specific env profile (may have changed)
3. OpenClaw starts from pre-configured rootfs
```

- [ ] **Step 3: Update the secret placement table**

Add `.env` ref pattern:
```markdown
| Secret ref (op:// URI) | `.env.local` as `SECRET_NAME_REF` | Convention: `${NAME}_REF` env var |
```

- [ ] **Step 4: Commit in shravan-claw repo**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/shravan-claw
git add docs/01-architecture-v4.md
git commit -m "docs: update architecture — postBuild baking, checkpoints, .env refs"
```

---

### Task 15: Update secrets security model doc

**Files:**
- Modify: `/Users/shravansunder/Documents/dev/project-dev/shravan-claw/docs/05-secrets-security-model.md`

Update to document:
1. .env ref pattern (refs live in .env, not system.json)
2. Checkpoint encryption (defense in depth)
3. Removal of gateway token from rootfs env file (if implemented)

- [ ] **Step 1: Add .env ref pattern section**

```markdown
## Secret Reference Resolution

Secret 1Password `op://` URIs are resolved in this order:
1. `ref` field in `system.json` secrets config (explicit)
2. `${SECRET_NAME}_REF` environment variable (from `.env.local`)
3. Error if neither is available

The `.env.example` template provides hardcoded defaults for the `op://` URIs.
These are vault paths, not secret values — safe to template and share.
```

- [ ] **Step 2: Add checkpoint encryption note**

```markdown
## Checkpoint Security

Gondolin checkpoints capture rootfs state (OS, packages, config files).
VFS-mounted paths (state, workspace) are NOT captured.

Checkpoints are encrypted with `age` as defense-in-depth:
- Encrypted at rest: `gateway-<fingerprint>.qcow2.age`
- Decrypted to temp path for resume, cleaned up after
- Uses the same `AGE_IDENTITY_KEY` as snapshot encryption
```

- [ ] **Step 3: Commit in shravan-claw repo**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/shravan-claw
git add docs/05-secrets-security-model.md
git commit -m "docs: update secrets model — .env ref pattern, checkpoint encryption"
```

---

### Task 16: Add setup guide to agent-vm repo

**Files:**
- Create: `/Users/shravansunder/Documents/dev/project-dev/agent-vm/docs/SETUP.md`

A concise zero-to-claw guide.

- [ ] **Step 1: Write SETUP.md**

```markdown
# Agent-VM Setup Guide

## Prerequisites

Run `agent-vm controller doctor` to verify:
- Node.js >= 24
- QEMU (`brew install qemu`)
- age (`brew install age`)
- 1Password CLI (`brew install 1password-cli`)
- Docker (for OCI image builds)

## Quick Start

### 1. Initialize project

```bash
agent-vm init <your-zone-id>
```

This creates:
- `system.json` — system configuration
- `.env.local` — secret references (fill in `OP_SERVICE_ACCOUNT_TOKEN`)
- `config/<zone>/openclaw.json` — OpenClaw configuration
- `state/<zone>/` — persistent state directory
- `workspaces/<zone>/` — workspace directory

### 2. Configure secrets

Edit `.env.local`:
- Set `OP_SERVICE_ACCOUNT_TOKEN` (from 1Password service account)
- Adjust `*_REF` values if your 1Password vault differs from defaults
- Set `AGE_IDENTITY_KEY` (generate with `age-keygen`)

### 3. Build images

```bash
./scripts/build-images.sh
```

First build takes ~2-5 minutes (downloads, installs packages).
Subsequent builds are cached by fingerprint.

### 4. Start controller

```bash
agent-vm controller start
```

### 5. OAuth setup (if needed)

SSH into the gateway VM for interactive auth:

```bash
agent-vm controller ssh-cmd --zone <zone-id>
# Inside VM:
openclaw auth login
```

### 6. Verify

```bash
agent-vm controller doctor
agent-vm controller status
```
```

- [ ] **Step 2: Commit in agent-vm repo**

```bash
cd /Users/shravansunder/Documents/dev/project-dev/agent-vm
git add docs/SETUP.md
git commit -m "docs: add setup guide — zero to claw in 6 steps"
```

---

## Summary

### What changes and why

| Phase | Tasks | Problem it solves | How you'd verify it worked |
|-------|-------|-------------------|---------------------------|
| A: Image Baking | 1-6 | Runtime setup runs inside the VM on every boot (CA certs, plugin copy, chown). This takes 5-10s and is completely static between boots. | `setupGatewayVmRuntime` issues exactly 1 exec call (env profile only). No `update-ca-certificates`, no `cp -a plugin`. |
| B: .env Secret Refs | 7-8 | 1P vault paths are tangled into system.json alongside structural config. New users have to dig through JSON to find what to change. **Plus:** nothing loads `.env.local` at runtime — fixed by adding `process.loadEnvFile()` to CLI entrypoint. | `system.json` has no `ref` fields. `credential-manager.ts` resolves from `${NAME}_REF` env vars. `.env.example` provides defaults. CLI loads `.env.local` on startup. |
| C: Checkpoint Infra (resume is follow-up) | 9-10 | Build the path resolution and encryption infrastructure for checkpoints. Actual resume requires VmCheckpoint API verification — follow-up task. | `gateway-checkpoint-manager.ts` resolves checkpoint path from `./checkpoints/${zoneId}/` (NOT stateDir — avoids VFS mount + snapshot sweep leak). |
| D: CLI Init | 11 | Going from zero to a running system requires manually creating 5+ files and directories. | `agent-vm init shravan` produces system.json, .env.local, config/shravan/openclaw.json, and all directories. |
| E: SSH UX | 12 | OAuth setup requires knowing SSH port and identity file from runtime state. | `agent-vm controller ssh-cmd --zone shravan` opens interactive SSH. |
| F: Checkpoint Encryption | 13 | Gateway token ends up in rootfs at `/root/.openclaw-env`. Checkpoint captures rootfs → token on disk unencrypted. | Checkpoint files stored as `.qcow2.age`. Decrypted to temp path for resume, cleaned up after. |
| G: Documentation | 14-16 | Architecture and security docs don't reflect postBuild, checkpoints, or .env ref pattern. No setup guide exists. | Docs describe current boot flow, secret resolution, and six-step setup. |

### Execution order

**A → B → D → E → C → F → G**

- A (postBuild) is the biggest single improvement — do it first
- B (.env refs) is independent, cleans up config before D generates templates
- D (init) depends on B because it generates the .env template
- E (SSH) is small and standalone
- C (checkpoints) depends on A because it checkpoints baked images
- F (encryption) depends on C because it encrypts checkpoint files
- G (docs) goes last because it documents everything else

### After all tasks

Run full check suite from agent-vm root:
```bash
pnpm check
```
All lints, types, and tests must pass before PR.

### What "done" looks like

1. `agent-vm init <zone>` scaffolds a complete project in one command
2. `./scripts/build-images.sh` builds everything — OCI images + Gondolin assets with postBuild — into the cache dirs the controller actually reads
3. `agent-vm controller start` boots faster on warm cache (runtime setup reduced to env profile only; OpenClaw startup still takes time)
4. Secret `op://` URIs live in `.env.local`, not system.json. CLI loads `.env.local` at startup via `process.loadEnvFile()`
5. `agent-vm controller ssh-cmd` spawns interactive SSH (not just prints the command)
6. Checkpoint path infrastructure built with encryption helpers — checkpoint files stored outside stateDir to avoid VFS/snapshot leak. Actual resume is a follow-up after VmCheckpoint API verification.
7. Architecture, security, and setup docs reflect all changes
8. All existing tests pass + new tests for each feature

### Follow-up work (not in this plan)

- **Wire up checkpoint create/resume**: Build `checkpoint-adapter.ts` wrapping Gondolin's `VmCheckpoint.load().resume()`. Verify API against linked SDK version. Connect into `gateway-zone-orchestrator.ts` — resume from checkpoint on warm boot, create checkpoint after cold boot.
- **Image cache outside stateDir**: The image cache at `${stateDir}/images/gateway/` also leaks into VFS-mounted state (same problem as checkpoints). Consider moving it to a project-level cache dir. This is an existing issue, not introduced by this plan.
- **Tool VM runtime bake**: `tool-vm-lifecycle.ts:89-93` still runs `useradd`, `mkdir`, `chown`, `ln` at runtime on every tool VM boot. These could move into the tool image's postBuild.
