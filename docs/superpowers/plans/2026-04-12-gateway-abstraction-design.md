# Gateway Abstraction Design Spec

## The Problem

agent-vm's controller is supposed to be gateway-agnostic — it manages VMs, secrets, leases, networking. But it's deeply coupled to OpenClaw:

- `gateway-openclaw-lifecycle.ts` hardcodes `cd /home/openclaw && nohup openclaw gateway`
- `gateway-vm-setup.ts` hardcodes `OPENCLAW_HOME`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_STATE_DIR`
- `gateway-vm-configuration.ts` hardcodes `/home/openclaw/.openclaw/config` VFS mounts and splits secrets by injection type (env vs HTTP mediation)
- `gateway-zone-orchestrator.ts` calls `startOpenClawInGateway()` directly
- `controller-runtime-operations.ts` reads `/tmp/openclaw.log`
- `system-config.ts` has `openclawConfig` in the zone schema

When the coding gateway (`agent-vm-worker`) needs to plug in, none of this works. The coding gateway has different paths, different env vars, different startup commands, different health checks, different mediated secrets, and different TCP routing.

## What We Want

A controller that receives a complete VM spec and process spec from the gateway lifecycle, then executes it generically:

```
Controller: "Give me everything I need to create this VM and start your process."
Lifecycle:  "Here's the VM spec (env, VFS, secrets, TCP, hosts) and process spec 
             (bootstrap, start, health, logs)."
Controller: "Done. Here's your ingress."
```

The controller doesn't import OpenClaw or coding-agent code. It imports an interface and the right implementation is selected by config.

## Why Not Just Config?

We considered putting everything in system.json. That breaks down because:

1. **Secret splitting has logic** — OpenClaw puts `PERPLEXITY_API_KEY` through HTTP mediation to `api.perplexity.ai` but passes `DISCORD_BOT_TOKEN` as an env var. The coding gateway mediates different secrets to different hosts. This split is data assembly with conditional logic, not static config.

2. **OpenClaw needs pre-start logic** — resolving `authProfilesRef` from 1Password and writing `auth-profiles.json` to the host state directory before the VM boots.

3. **VFS mount paths are computed** — they depend on config directory paths, state directory paths, and zone-specific overrides.

4. **TCP host mapping varies by gateway** — OpenClaw needs WebSocket bypass for Discord/WhatsApp. Coding gateway needs service routing for Docker Compose (postgres, redis).

Config can express the 80% case. The 20% needs code. Hence: interface with implementations.

## The Design

### Package Structure

```
packages/
├── gateway-interface/                  ← types only, no runtime code
│   └── src/
│       ├── gateway-lifecycle.ts        ← GatewayLifecycle interface
│       ├── gateway-vm-spec.ts          ← GatewayVmSpec type
│       ├── gateway-process-spec.ts     ← GatewayProcessSpec type
│       └── index.ts
│
├── openclaw-gateway/                   ← OpenClaw implementation
│   └── src/
│       ├── openclaw-lifecycle.ts       ← implements GatewayLifecycle
│       ├── openclaw-lifecycle.test.ts
│       └── index.ts
│
├── coding-gateway/                     ← Coding agent implementation (future)
│   └── src/
│       ├── coding-lifecycle.ts         ← implements GatewayLifecycle
│       ├── coding-lifecycle.test.ts
│       └── index.ts
│
├── gondolin-core/                      ← unchanged
├── agent-vm/                           ← imports gateway-interface, not implementations
├── openclaw-agent-vm-plugin/           ← unchanged (OpenClaw sandbox backend)
└── agent-vm-worker/                    ← the generic worker process (runs inside VM, serves any runner via config)
```

### The Interface

Two specs, not one. The VM spec covers everything Gondolin needs. The process spec covers what runs inside.

```typescript
// packages/gateway-interface/src/gateway-vm-spec.ts

import type { VfsMountSpec, SecretSpec } from 'gondolin-core';

/**
 * Everything the controller needs to create the Gondolin VM.
 * Lifecycle implementations own the full Gondolin-facing contract.
 */
export interface GatewayVmSpec {
  /** Environment variables set in the VM process */
  readonly environment: Record<string, string>;

  /** VFS mounts (guest path → host path + kind) */
  readonly vfsMounts: Record<string, VfsMountSpec>;

  /** HTTP-mediated secrets — injected at the network boundary by Gondolin.
   *  The agent never sees the real values, only placeholders.
   *  Key = secret name, value = { hosts, value } */
  readonly mediatedSecrets: Record<string, SecretSpec>;

  /** TCP host mappings — raw TCP passthrough for WebSocket bypass, 
   *  service routing (docker compose), controller API, tool VM SSH.
   *  Key = "host:port" as seen from inside VM, value = "host:port" on host */
  readonly tcpHosts: Record<string, string>;

  /** Hosts the VM is allowed to reach via HTTP mediation */
  readonly allowedHosts: readonly string[];

  /** Rootfs mode: readonly, memory, or cow */
  readonly rootfsMode: 'readonly' | 'memory' | 'cow';

  /** Label for the VM session (used in Gondolin logs) */
  readonly sessionLabel: string;
}
```

```typescript
// packages/gateway-interface/src/gateway-process-spec.ts

/**
 * Everything about the process running inside the VM.
 * Retained by the running gateway handle for logs, health, restart.
 */
export interface GatewayProcessSpec {
  /** Shell command that sets up the environment for interactive sessions.
   *  Writes env profile to a file and hooks .bashrc to source it.
   *  This ensures SSH sessions (agent-vm controller ssh, agent-vm openclaw auth)
   *  get the right env vars. Runs BEFORE startCommand. */
  readonly bootstrapCommand: string;

  /** Shell command that starts the gateway process.
   *  Must background itself (nohup ... &) so vm.exec returns. 
   *  Runs AFTER bootstrapCommand. */
  readonly startCommand: string;

  /** How to check if the gateway is ready */
  readonly healthCheck: GatewayHealthCheck;

  /** Port the gateway process listens on INSIDE the VM.
   *  Used for setIngressRoutes. Different from zone.gateway.port
   *  which is the HOST-side ingress listen port. */
  readonly guestListenPort: number;

  /** Path to the gateway's log file inside the VM */
  readonly logPath: string;
}

export type GatewayHealthCheck =
  | { readonly type: 'http'; readonly port: number; readonly path: string }
  | { readonly type: 'command'; readonly command: string };
```

```typescript
// packages/gateway-interface/src/gateway-lifecycle.ts

import type { SecretResolver } from 'gondolin-core';
import type { GatewayVmSpec } from './gateway-vm-spec.js';
import type { GatewayProcessSpec } from './gateway-process-spec.js';

/**
 * Zone config as the lifecycle sees it.
 * Generic — no OpenClaw-specific fields.
 */
export interface GatewayZoneConfig {
  readonly id: string;
  readonly gateway: {
    readonly type: string;
    readonly memory: string;
    readonly cpus: number;
    readonly port: number;                 // host-side ingress listen port
    readonly gatewayConfig: string;        // path to gateway-specific config file
    readonly stateDir: string;
    readonly workspaceDir: string;
    readonly authProfilesRef?: string;     // optional, OpenClaw uses this
  };
  readonly secrets: Record<string, {
    readonly source: string;
    readonly ref?: string;
    readonly injection: 'env' | 'http-mediation';
    readonly hosts?: readonly string[];
  }>;
  readonly allowedHosts: readonly string[];
  readonly websocketBypass: readonly string[];
  readonly toolProfile: string;
}

export interface GatewayLifecycle {
  /** Build the full VM spec — everything Gondolin needs to create the VM.
   *  Lifecycle owns the complete Gondolin-facing contract: env, VFS, mediated
   *  secrets, TCP hosts, allowed hosts, rootfs mode, session label.
   *  Pure data assembly — no side effects. */
  buildVmSpec(
    zone: GatewayZoneConfig,
    resolvedSecrets: Record<string, string>,
    controllerPort: number,
    tcpPool: { readonly basePort: number; readonly size: number },
  ): GatewayVmSpec;

  /** Build the process spec — everything about startup, health, and logging.
   *  Receives resolvedSecrets so the bootstrap can conditionally include
   *  secrets (e.g., gateway token) in the shell profile for SSH sessions.
   *  The returned processSpec is retained by the running gateway handle so
   *  logs, health checks, and restart stay generic after startup.
   *  Pure data assembly — no side effects. */
  buildProcessSpec(
    zone: GatewayZoneConfig,
    resolvedSecrets: Record<string, string>,
  ): GatewayProcessSpec;

  /** Optional: prepare host-side state before the VM boots.
   *  Example: OpenClaw writes auth-profiles.json from 1Password.
   *  Most gateways don't need this. */
  prepareHostState?(
    zone: GatewayZoneConfig,
    secretResolver: SecretResolver,
  ): Promise<void>;
}
```

### Why This Shape

**Two specs, not one.** The reviewer correctly identified that collapsing VM config and process config into one spec loses the real Gondolin boundary. `GatewayVmSpec` maps 1:1 to what `createManagedVm()` accepts. `GatewayProcessSpec` maps to what happens after the VM exists. Clear separation.

**`buildVmSpec` receives `controllerPort` and `tcpPool`.** TCP host mapping needs the controller port (for `controller.vm.host:18800 → 127.0.0.1:18800`) and tool VM SSH slots (for `tool-0.vm.host:22 → 127.0.0.1:19000`). These are infrastructure concerns the lifecycle needs to know about to build the TCP map.

**`mediatedSecrets` in the VM spec.** The lifecycle splits secrets by injection type. OpenClaw puts `PERPLEXITY_API_KEY` through mediation (hosts: `api.perplexity.ai`) and `DISCORD_BOT_TOKEN` into env. The controller passes `mediatedSecrets` to `createHttpHooks()` and `environment` to the VM env. No more `splitResolvedGatewaySecrets` in the controller.

**`bootstrapCommand` separate from `startCommand`.** The bootstrap writes an env profile file and hooks .bashrc. This supports interactive SSH sessions — when you run `agent-vm controller ssh` or `agent-vm openclaw auth`, the shell sources the env profile. Without this, SSH sessions have no env vars. This is a first-class requirement for ALL gateways, not just OpenClaw.

**`guestListenPort` separate from `zone.gateway.port`.** Guest port = where the process listens inside the VM (e.g., 18789). Host port = where the ingress listens on the host (e.g., 18791 from zone config). These are different. The spec has `guestListenPort`; the controller uses `zone.gateway.port` for `enableIngress()`.

**`processSpec` retained by the running handle.** After startup, the controller keeps `processSpec` so operations like `logs` read `processSpec.logPath` (not `/tmp/openclaw.log`), and `status` can re-check `processSpec.healthCheck`. This makes all runtime operations generic.

**`GatewayZoneConfig.secrets` preserves injection metadata.** The original spec dropped `injection` and `hosts` from the zone config secrets. That broke the secret splitting logic. Now the lifecycle receives the full secret config including injection type and mediation hosts.

### How the Controller Uses It

```typescript
// gateway-zone-orchestrator.ts — generic

export interface GatewayZoneStartResult {
  readonly image: BuildImageResult;
  readonly ingress: { readonly host: string; readonly port: number };
  readonly processSpec: GatewayProcessSpec;     // retained for runtime ops
  readonly vm: ManagedVm;
  readonly zone: GatewayZoneConfig;
}

export async function startGatewayZone(options: {
  readonly image: BuildImageResult;   // from buildGatewayImage(), has .imagePath
  readonly lifecycle: GatewayLifecycle;
  readonly resolvedSecrets: Record<string, string>;
  readonly secretResolver: SecretResolver;
  readonly systemConfig: SystemConfig;
  readonly zone: GatewayZoneConfig;
  readonly runTask?: RunTaskFn;
}): Promise<GatewayZoneStartResult> {
  const runTaskStep = options.runTask ?? noopRunTask;

  // 1. Create mount target directories (unconditional — controller responsibility)
  //    VFS realfs mounts need the host directories to exist before the VM boots.
  fs.mkdirSync(options.zone.gateway.stateDir, { recursive: true });
  fs.mkdirSync(options.zone.gateway.workspaceDir, { recursive: true });

  // 2. Pre-start hook (optional — gateway-specific host state)
  //    Example: OpenClaw writes auth-profiles.json from 1Password.
  //    This is NOT for creating mount directories — that's step 1.
  if (options.lifecycle.prepareHostState) {
    await runTaskStep('Preparing host state', async () => {
      await options.lifecycle.prepareHostState!(options.zone, options.secretResolver);
    });
  }

  // 3. Build specs (pure, no side effects)
  const vmSpec = options.lifecycle.buildVmSpec(
    options.zone,
    options.resolvedSecrets,
    options.systemConfig.host.controllerPort,
    options.systemConfig.tcpPool,
  );
  const processSpec = options.lifecycle.buildProcessSpec(options.zone, options.resolvedSecrets);

  // 3. Create VM with vmSpec
  let managedVm!: ManagedVm;
  await runTaskStep('Booting gateway VM', async () => {
    managedVm = await createManagedVm({
      imagePath: options.image.imagePath,
      memory: options.zone.gateway.memory,
      cpus: options.zone.gateway.cpus,
      rootfsMode: vmSpec.rootfsMode,
      env: vmSpec.environment,
      vfsMounts: vmSpec.vfsMounts,
      secrets: vmSpec.mediatedSecrets,
      allowedHosts: vmSpec.allowedHosts,
      tcpHosts: vmSpec.tcpHosts,
      sessionLabel: vmSpec.sessionLabel,
    });
  });

  // 4. Bootstrap shell environment (for SSH sessions)
  await runTaskStep('Configuring gateway', async () => {
    await managedVm.exec(processSpec.bootstrapCommand);
  });

  // 5. Start the gateway process
  await runTaskStep('Starting gateway', async () => {
    await managedVm.exec(processSpec.startCommand);
  });

  // 6. Wait for health
  await runTaskStep('Waiting for readiness', async () => {
    await waitForHealth(managedVm, processSpec.healthCheck);
  });

  // 7. Enable ingress
  managedVm.setIngressRoutes([{
    port: processSpec.guestListenPort,
    prefix: '/',
    stripPrefix: true,
  }]);
  const ingress = await managedVm.enableIngress({
    listenPort: options.zone.gateway.port,  // HOST port from zone config
  });

  return { image: options.image, ingress, processSpec, vm: managedVm, zone: options.zone };
}
```

**No OpenClaw imports. No hardcoded paths. No secret splitting logic.**

The controller passes `vmSpec` fields directly to `createManagedVm`. The lifecycle implementation decided what goes where. The `processSpec` is retained in the result so runtime operations stay generic.

### The OpenClaw Implementation

```typescript
// packages/openclaw-gateway/src/openclaw-lifecycle.ts

export const openclawLifecycle: GatewayLifecycle = {
  buildVmSpec(zone, resolvedSecrets, controllerPort, tcpPool): GatewayVmSpec {
    // Split secrets by injection type
    const environment: Record<string, string> = {
      HOME: '/home/openclaw',
      NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
      OPENCLAW_CONFIG_PATH: `/home/openclaw/.openclaw/config/${path.basename(zone.gateway.gatewayConfig)}`,
      OPENCLAW_HOME: '/home/openclaw',
      OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
    };
    const mediatedSecrets: Record<string, SecretSpec> = {};

    for (const [secretName, secretConfig] of Object.entries(zone.secrets)) {
      const secretValue = resolvedSecrets[secretName];
      if (!secretValue) continue;

      if (secretConfig.injection === 'http-mediation' && secretConfig.hosts) {
        mediatedSecrets[secretName] = { hosts: [...secretConfig.hosts], value: secretValue };
      } else {
        environment[secretName] = secretValue;
      }
    }

    // Build TCP hosts
    const tcpHosts: Record<string, string> = {
      // In-VM alias is stable at :18800 regardless of actual host port.
      // This is the address gateways and plugins use to reach the controller.
      'controller.vm.host:18800': `127.0.0.1:${controllerPort}`,
    };
    for (let slot = 0; slot < tcpPool.size; slot++) {
      tcpHosts[`tool-${slot}.vm.host:22`] = `127.0.0.1:${tcpPool.basePort + slot}`;
    }
    for (const wsHost of zone.websocketBypass) {
      tcpHosts[wsHost] = wsHost;
    }

    const configDir = path.dirname(path.resolve(zone.gateway.gatewayConfig));

    return {
      environment,
      mediatedSecrets,
      vfsMounts: {
        '/home/openclaw/.openclaw/config': { kind: 'realfs', hostPath: configDir },
        '/home/openclaw/.openclaw/state': { kind: 'realfs', hostPath: zone.gateway.stateDir },
        '/home/openclaw/workspace': { kind: 'realfs', hostPath: zone.gateway.workspaceDir },
      },
      tcpHosts,
      allowedHosts: [...zone.allowedHosts],
      rootfsMode: 'cow',
      sessionLabel: `${zone.id}-gateway`,
    };
  },

  buildProcessSpec(zone, resolvedSecrets): GatewayProcessSpec {
    // Build the env profile content — conditionally include gateway token
    const envLines = [
      'export OPENCLAW_HOME=/home/openclaw',
      `export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/config/${path.basename(zone.gateway.gatewayConfig)}`,
      'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state',
      'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt',
    ];
    if (resolvedSecrets.OPENCLAW_GATEWAY_TOKEN) {
      const escapedToken = resolvedSecrets.OPENCLAW_GATEWAY_TOKEN.replace(/'/g, "'\\''");
      envLines.push(`export OPENCLAW_GATEWAY_TOKEN='${escapedToken}'`);
    }

    return {
      bootstrapCommand:
        'mkdir -p /root && cat > /root/.openclaw-env << ENVEOF\n' +
        envLines.join('\n') + '\n' +
        'ENVEOF\n' +
        'chmod 600 /root/.openclaw-env && ' +
        'touch /root/.bashrc && ' +
        "grep -qxF 'source /root/.openclaw-env' /root/.bashrc || echo 'source /root/.openclaw-env' >> /root/.bashrc",
      startCommand: 'cd /home/openclaw && nohup openclaw gateway --port 18789 > /tmp/openclaw.log 2>&1 &',
      healthCheck: { type: 'http', port: 18789, path: '/' },
      guestListenPort: 18789,
      logPath: '/tmp/openclaw.log',
    };
  },

  async prepareHostState(zone, secretResolver): Promise<void> {
    if (!zone.gateway.authProfilesRef) return;

    const authProfilesDir = path.join(zone.gateway.stateDir, 'agents', 'main', 'agent');
    fs.mkdirSync(authProfilesDir, { recursive: true });
    fs.writeFileSync(
      path.join(authProfilesDir, 'auth-profiles.json'),
      await secretResolver.resolve({ source: '1password', ref: zone.gateway.authProfilesRef }),
      'utf8',
    );
  },
};
```

### The Coding Implementation (Sketch)

```typescript
// packages/coding-gateway/src/coding-lifecycle.ts

export const codingLifecycle: GatewayLifecycle = {
  buildVmSpec(zone, resolvedSecrets, controllerPort, tcpPool): GatewayVmSpec {
    const environment: Record<string, string> = {
      HOME: '/home/coder',
      STATE_DIR: '/state',
      NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
    };
    const mediatedSecrets: Record<string, SecretSpec> = {};

    for (const [secretName, secretConfig] of Object.entries(zone.secrets)) {
      const secretValue = resolvedSecrets[secretName];
      if (!secretValue) continue;
      if (secretConfig.injection === 'http-mediation' && secretConfig.hosts) {
        mediatedSecrets[secretName] = { hosts: [...secretConfig.hosts], value: secretValue };
      } else {
        environment[secretName] = secretValue;
      }
    }

    // TCP hosts for Docker Compose services + controller
    const tcpHosts: Record<string, string> = {
      // In-VM alias is stable at :18800 regardless of actual host port.
      // This is the address gateways and plugins use to reach the controller.
      'controller.vm.host:18800': `127.0.0.1:${controllerPort}`,
      'postgres.local:5432': '127.0.0.1:5432',
      'redis.local:6379': '127.0.0.1:6379',
    };

    return {
      environment,
      mediatedSecrets,
      vfsMounts: {
        '/state': { kind: 'realfs', hostPath: zone.gateway.stateDir },
        '/workspace': { kind: 'realfs', hostPath: zone.gateway.workspaceDir },
      },
      tcpHosts,
      allowedHosts: [...zone.allowedHosts],
      rootfsMode: 'cow',
      sessionLabel: `${zone.id}-coding`,
    };
  },

  buildProcessSpec(zone, _resolvedSecrets): GatewayProcessSpec {
    return {
      bootstrapCommand:
        'mkdir -p /root && cat > /root/.coding-env << ENVEOF\n' +
        'export HOME=/home/coder\n' +
        'export STATE_DIR=/state\n' +
        'ENVEOF\n' +
        'chmod 600 /root/.coding-env && ' +
        'touch /root/.bashrc && ' +
        "grep -qxF 'source /root/.coding-env' /root/.bashrc || echo 'source /root/.coding-env' >> /root/.bashrc",
      startCommand: 'agent-vm-worker serve --port 18789 > /tmp/coding.log 2>&1 &',
      healthCheck: { type: 'http', port: 18789, path: '/health' },
      guestListenPort: 18789,
      logPath: '/tmp/coding.log',
    };
  },

  // No prepareHostState needed
};
```

### Runtime Operations — processSpec Retained

After startup, the controller keeps `processSpec` in the running handle:

```typescript
// controller-runtime.ts stores:
gateway = {
  vm: managedVm,
  ingress: { host, port },
  processSpec: processSpec,  // retained
  zone: zone,
};

// controller-runtime-operations.ts uses it generically:
logs: async (zoneId) => {
  const output = await gateway.vm.exec(`cat ${gateway.processSpec.logPath} 2>/dev/null || echo ""`);
  return { logs: output.stdout };
},

// Future: health re-check, restart, etc. all use processSpec
```

### System Config Changes

```typescript
const zoneGatewaySchema = z.object({
  type: z.enum(['openclaw', 'coding']).default('openclaw'),
  memory: z.string().min(1),
  cpus: z.number().int().positive(),
  port: z.number().int().positive(),
  gatewayConfig: z.string().min(1),        // was: openclawConfig
  stateDir: z.string().min(1),
  workspaceDir: z.string().min(1),
  authProfilesRef: z.string().min(1).optional(),
});
```

### How Implementations Are Loaded

Static import map — simple, type-safe:

```typescript
import { openclawLifecycle } from 'openclaw-gateway';
import { codingLifecycle } from 'coding-gateway';

const lifecycleByType: Record<string, GatewayLifecycle> = {
  openclaw: openclawLifecycle,
  coding: codingLifecycle,
};

function loadGatewayLifecycle(type: string): GatewayLifecycle {
  const lifecycle = lifecycleByType[type];
  if (!lifecycle) throw new Error(`Unknown gateway type '${type}'.`);
  return lifecycle;
}
```

### What Gets Deleted from agent-vm

| File | What happens |
|------|-------------|
| `gateway-openclaw-lifecycle.ts` | **Deleted** — moved to `openclaw-gateway` package |
| `gateway-vm-setup.ts` | **Deleted** — bootstrap is now `processSpec.bootstrapCommand` |
| `gateway-vm-configuration.ts` | **Deleted** — VM config is now `vmSpec` from lifecycle |
| `gateway-zone-orchestrator.ts` | **Simplified** — calls lifecycle methods, executes specs generically |
| `controller-runtime-operations.ts` | **Simplified** — reads `processSpec.logPath` not hardcoded path |
| `splitResolvedGatewaySecrets()` | **Deleted** — secret splitting moves to lifecycle implementation |
| `buildGatewayTcpHosts()` | **Deleted** — TCP host building moves to lifecycle implementation |
| `prepareGatewayHostDirectories()` | **Split** — mount target dir creation (stateDir, workspaceDir) stays in orchestrator (unconditional). Auth-profiles write moves to `lifecycle.prepareHostState()` (optional). |
| `buildGatewayVmFactoryOptions()` | **Deleted** — replaced by `lifecycle.buildVmSpec()` |

---

## Relationship to the Agent Loop System (Scope 2)

The gateway abstraction (this doc) and the agent loop system are at different levels:

```
Gateway Abstraction (this doc)           Agent Loop System (separate doc)
─────────────────────────────            ────────────────────────────────
"How does the controller                 "What does the coding process
 start and manage the VM?"                do once it's running?"

Packages:                                Packages:
  gateway-interface                        agent-vm-worker (or generic outer-loop)
  openclaw-gateway                         coding-agent-codex
  coding-gateway                           coding-agent-claude (future)
                                           oncall-agent (future)

Concern:                                 Concern:
  VM lifecycle, env vars, mounts,          Task state machine, prompt building,
  mediated secrets, TCP routing,           agent execution, verification, git, PR
  health checks, ingress, shell setup

Interface:                               Interface:
  GatewayLifecycle                         AgentRunner (execute prompt → diffs)
  GatewayVmSpec + GatewayProcessSpec       TaskStateMachine (pending → done)
                                           Verifier (lint, test, custom)
```

They connect at one point: `codingLifecycle.buildProcessSpec()` returns `startCommand: "agent-vm-worker serve --port 18789"`. That's the only coupling.

The agent loop redesign (generic outer loop, pluggable agent runners, oncall as a different agent type) is independent work. The gateway abstraction should ship first because it unblocks the coding-gateway from plugging into the controller.

---

## Migration Path

```
Step 1: Create gateway-interface package (types only — GatewayLifecycle, VmSpec, ProcessSpec)
Step 2: Create openclaw-gateway package (extract from agent-vm, implements GatewayLifecycle)
Step 3: Refactor gateway-zone-orchestrator to use the interface
Step 4: Retain processSpec in running gateway handle
Step 5: Delete OpenClaw-specific code from agent-vm
Step 6: Verify — existing OpenClaw flow works identically
─────── refactor complete, no new features ──────
Step 7: Create coding-gateway package (implements GatewayLifecycle)
Step 8: Verify — init --type coding && build && start boots a coding gateway
```

Steps 1-6 are a refactor — same behavior, cleaner architecture. Steps 7-8 are the payoff.
