# Gateway Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `agent-vm` so gateway startup and runtime management flow through a generic lifecycle interface, preserving OpenClaw behavior and introducing the workspace packages needed for future worker-gateway support. Also fix pre-existing bugs surfaced during PR #3 review.

**Architecture:** Extract gateway lifecycle types into a new `gateway-interface` workspace package, move the current OpenClaw-specific VM/process assembly into a new `openclaw-gateway` package, and simplify `agent-vm` to orchestrate generic VM and process specs. The controller never imports gateway implementations — it imports an interface and the right implementation is selected by config via a static import map. Pre-existing bugs (idle reaper races, duplicate type guards, readiness check, sync fs) are fixed as part of this changeset since they touch the same files.

**Tech Stack:** TypeScript, pnpm workspace packages, `cmd-ts`, `zod`, `gondolin-core`, Vitest, tasuku/`RunTaskFn`

**Design spec:** `docs/superpowers/plans/2026-04-12-gateway-abstraction-design.md` — the canonical reference for interface shapes, code examples, and rationale. **Note:** The design spec uses `coding-gateway` — renamed to `worker-gateway` in this plan because the package hosts the generic `agent-vm-worker` process, not a coding-specific one. The config enum value `'coding'` is unchanged.

---

## File Structure

### New packages

```
packages/gateway-interface/          ← types only, zero runtime code
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── src/
    ├── gateway-lifecycle.ts         ← GatewayLifecycle interface + GatewayZoneConfig
    ├── gateway-vm-spec.ts           ← GatewayVmSpec interface
    ├── gateway-process-spec.ts      ← GatewayProcessSpec + GatewayHealthCheck
    └── index.ts                     ← re-exports all types

packages/openclaw-gateway/           ← OpenClaw GatewayLifecycle implementation
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── src/
    ├── openclaw-lifecycle.ts        ← implements GatewayLifecycle (extracted from agent-vm)
    ├── openclaw-lifecycle.test.ts
    └── index.ts

packages/worker-gateway/             ← Worker GatewayLifecycle scaffold (runs agent-vm-worker)
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── src/
    ├── worker-lifecycle.ts          ← implements GatewayLifecycle (VM spec real, process spec throws)
    ├── worker-lifecycle.test.ts
    └── index.ts
```

### Modified files in agent-vm

| File                                 | Action                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `gateway-zone-orchestrator.ts`       | **Rewrite** — accepts `GatewayLifecycle`, calls `buildVmSpec`/`buildProcessSpec`, generic health wait, generic ingress |
| `gateway-zone-orchestrator.test.ts`  | **Rewrite** — tests generic orchestration with mock lifecycle                                                          |
| `gateway-zone-support.ts`            | **Simplify** — keep `findGatewayZone`, update `GatewayZoneStartResult` to include `processSpec`                        |
| `controller-runtime.ts`              | **Modify** — thread `processSpec` through gateway handle                                                               |
| `controller-runtime-types.ts`        | **Modify** — add `processSpec` to runtime types                                                                        |
| `controller-runtime-operations.ts`   | **Modify** — read `processSpec.logPath` instead of hardcoded path, add `processSpec` to `GatewayZoneRuntime`           |
| `system-config.ts`                   | **Modify** — rename `openclawConfig` → `gatewayConfig`, make `loadSystemConfig` async                                  |
| `system-config.test.ts`              | **Modify** — update fixture field name, adapt for async                                                                |
| `init-command.ts`                    | **Modify** — emit `gatewayConfig` in scaffolded system.json                                                            |
| `idle-reaper.ts`                     | **Fix** — sequential lease release instead of `Promise.all`                                                            |
| `gateway-openclaw-lifecycle.ts`      | **Delete** — moved to `openclaw-gateway` package                                                                       |
| `gateway-vm-setup.ts` + test         | **Delete** — bootstrap is now `processSpec.bootstrapCommand`                                                           |
| `gateway-vm-configuration.ts` + test | **Delete** — VM config is now `vmSpec` from lifecycle                                                                  |

### Modified files in openclaw-agent-vm-plugin

| File                         | Action                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `controller-lease-client.ts` | **Fix** — consolidate duplicate `isGondolinLeaseResponse`, import from contract |

---

### Task 1: Create `gateway-interface` Package (Types Only)

**Files:**

- Create: `packages/gateway-interface/package.json`
- Create: `packages/gateway-interface/tsconfig.json`
- Create: `packages/gateway-interface/tsconfig.build.json`
- Create: `packages/gateway-interface/src/gateway-vm-spec.ts`
- Create: `packages/gateway-interface/src/gateway-process-spec.ts`
- Create: `packages/gateway-interface/src/gateway-lifecycle.ts`
- Create: `packages/gateway-interface/src/index.ts`

- [ ] **Step 1: Create `packages/gateway-interface/package.json`**

```json
{
	"name": "gateway-interface",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"scripts": {
		"build": "tsc -p tsconfig.build.json",
		"typecheck": "tsc -p tsconfig.json --noEmit"
	},
	"dependencies": {
		"gondolin-core": "workspace:*"
	}
}
```

- [ ] **Step 2: Create tsconfig files**

`packages/gateway-interface/tsconfig.json`:

```json
{
	"extends": "../../tsconfig.base.json",
	"include": ["src/**/*.ts"],
	"exclude": ["dist"]
}
```

`packages/gateway-interface/tsconfig.build.json`:

```json
{
	"extends": "./tsconfig.json",
	"compilerOptions": {
		"outDir": "dist",
		"declaration": true,
		"declarationMap": true,
		"sourceMap": true,
		"noEmit": false
	}
}
```

- [ ] **Step 3: Create `gateway-vm-spec.ts`**

```ts
import type { SecretSpec, VfsMountSpec } from 'gondolin-core';

/**
 * Everything the controller needs to create the Gondolin VM.
 * Lifecycle implementations own the full Gondolin-facing contract.
 */
export interface GatewayVmSpec {
	readonly environment: Record<string, string>;
	readonly vfsMounts: Record<string, VfsMountSpec>;
	readonly mediatedSecrets: Record<string, SecretSpec>;
	readonly tcpHosts: Record<string, string>;
	readonly allowedHosts: readonly string[];
	readonly rootfsMode: 'readonly' | 'memory' | 'cow';
	readonly sessionLabel: string;
}
```

- [ ] **Step 4: Create `gateway-process-spec.ts`**

```ts
export type GatewayHealthCheck =
	| { readonly type: 'http'; readonly port: number; readonly path: string }
	| { readonly type: 'command'; readonly command: string };

/**
 * Everything about the process running inside the VM.
 * Retained by the running gateway handle for logs, health, restart.
 */
export interface GatewayProcessSpec {
	readonly bootstrapCommand: string;
	readonly startCommand: string;
	readonly healthCheck: GatewayHealthCheck;
	readonly guestListenPort: number;
	readonly logPath: string;
}
```

- [ ] **Step 5: Create `gateway-lifecycle.ts`**

```ts
import type { SecretResolver } from 'gondolin-core';

import type { GatewayProcessSpec } from './gateway-process-spec.js';
import type { GatewayVmSpec } from './gateway-vm-spec.js';

/**
 * Zone config as the lifecycle sees it.
 * Decoupled from SystemConfig — the controller maps into this shape.
 */
export interface GatewayZoneConfig {
	readonly id: string;
	readonly gateway: {
		readonly type: string;
		readonly memory: string;
		readonly cpus: number;
		readonly port: number;
		readonly gatewayConfig: string;
		readonly stateDir: string;
		readonly workspaceDir: string;
		readonly authProfilesRef?: string;
	};
	readonly secrets: Record<
		string,
		{
			readonly source: string;
			readonly ref?: string;
			readonly injection: 'env' | 'http-mediation';
			readonly hosts?: readonly string[];
		}
	>;
	readonly allowedHosts: readonly string[];
	readonly websocketBypass: readonly string[];
	readonly toolProfile: string;
}

export interface GatewayLifecycle {
	/** Build the full VM spec — everything Gondolin needs to create the VM.
	 *  Pure data assembly — no side effects. */
	buildVmSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
		controllerPort: number,
		tcpPool: { readonly basePort: number; readonly size: number },
	): GatewayVmSpec;

	/** Build the process spec — everything about startup, health, and logging.
	 *  Pure data assembly — no side effects. */
	buildProcessSpec(
		zone: GatewayZoneConfig,
		resolvedSecrets: Record<string, string>,
	): GatewayProcessSpec;

	/** Optional: prepare host-side state before the VM boots.
	 *  Example: OpenClaw writes auth-profiles.json from 1Password. */
	prepareHostState?(zone: GatewayZoneConfig, secretResolver: SecretResolver): Promise<void>;
}
```

- [ ] **Step 6: Create `index.ts`**

```ts
export type { GatewayHealthCheck, GatewayProcessSpec } from './gateway-process-spec.js';
export type { GatewayLifecycle, GatewayZoneConfig } from './gateway-lifecycle.js';
export type { GatewayVmSpec } from './gateway-vm-spec.js';
```

- [ ] **Step 7: Run `pnpm install` to link the new workspace package, then typecheck**

Run: `pnpm install && pnpm --filter gateway-interface typecheck`
Expected: workspace links, typecheck passes with zero errors.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway-interface/
git commit -m "$(cat <<'EOF'
feat: add gateway-interface package — lifecycle types for gateway abstraction

Types only, no runtime code. Defines GatewayLifecycle, GatewayVmSpec,
GatewayProcessSpec, and GatewayZoneConfig.
EOF
)"
```

---

### Task 2: Rename `openclawConfig` → `gatewayConfig` (Hard Cutover)

**Why this comes before the lifecycle extraction:** The extracted lifecycle will consume `zone.gateway.gatewayConfig`. If we extract first and rename later, we'd have two code paths. Hard cutover — one changeset.

**Files:**

- Modify: `packages/agent-vm/src/controller/system-config.ts`
- Modify: `packages/agent-vm/src/controller/system-config.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-vm-configuration.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-vm-setup.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-vm-configuration.test.ts`

- [ ] **Step 1: Rename the Zod schema field**

In `packages/agent-vm/src/controller/system-config.ts`, change `zoneGatewaySchema`:

```ts
const zoneGatewaySchema = z.object({
	type: z.enum(['openclaw', 'coding']).default('openclaw'),
	memory: z.string().min(1),
	cpus: z.number().int().positive(),
	port: z.number().int().positive(),
	gatewayConfig: z.string().min(1), // was: openclawConfig
	stateDir: z.string().min(1),
	workspaceDir: z.string().min(1),
	authProfilesRef: z.string().min(1).optional(),
});
```

- [ ] **Step 2: Update `resolveRelativePaths` in the same file**

Change `openclawConfig` → `gatewayConfig` in the zones mapping:

```ts
zones: config.zones.map((zone) => ({
	...zone,
	gateway: {
		...zone.gateway,
		gatewayConfig: resolvePath(zone.gateway.gatewayConfig),
		stateDir: resolvePath(zone.gateway.stateDir),
		workspaceDir: resolvePath(zone.gateway.workspaceDir),
	},
})),
```

- [ ] **Step 3: Update `init-command.ts` scaffolded system.json**

In `defaultSystemConfig`, change the zone gateway object:

```ts
gateway: {
	type: gatewayType,
	memory: '2G',
	cpus: 2,
	port: 18791,
	gatewayConfig: `./config/${zoneId}/${resolveGatewayConfigFileName(gatewayType)}`,
	stateDir: `./state/${zoneId}`,
	workspaceDir: `./workspaces/${zoneId}`,
},
```

- [ ] **Step 4: Update all references in gateway files**

In `gateway-vm-configuration.ts:89`:

```ts
const configDirectory = path.dirname(path.resolve(options.zone.gateway.gatewayConfig));
const configFileName = path.basename(options.zone.gateway.gatewayConfig);
```

In `gateway-vm-setup.ts:77`:

```ts
openClawConfigPath: zone.gateway.gatewayConfig,
```

In `gateway-zone-orchestrator.test.ts`, update the test fixture:

```ts
gateway: {
	type: 'openclaw',
	memory: '2G',
	cpus: 2,
	port: 18791,
	gatewayConfig: './config/shravan/openclaw.json',
	// ... rest
},
```

In `gateway-vm-configuration.test.ts`, update the zone fixture similarly.

In `system-config.test.ts`, update the test fixture similarly.

- [ ] **Step 5: Run tests to verify the rename is complete**

Run: `pnpm vitest run packages/agent-vm/src/controller/system-config.test.ts packages/agent-vm/src/gateway/`
Expected: all tests pass — no references to `openclawConfig` remain.

- [ ] **Step 6: Grep to confirm no stale references**

Run: `grep -r "openclawConfig" packages/ --include="*.ts" | grep -v node_modules | grep -v dist`
Expected: zero matches.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/
git commit -m "$(cat <<'EOF'
refactor: rename openclawConfig to gatewayConfig — hard cutover

Schema, init scaffolding, path resolution, and all gateway consumers
updated atomically. No backward compatibility — field name changes everywhere.
EOF
)"
```

---

### Task 3: Extract the OpenClaw Lifecycle

**Files:**

- Create: `packages/openclaw-gateway/package.json`
- Create: `packages/openclaw-gateway/tsconfig.json`
- Create: `packages/openclaw-gateway/tsconfig.build.json`
- Create: `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
- Create: `packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
- Create: `packages/openclaw-gateway/src/index.ts`
- Reference: `packages/agent-vm/src/gateway/gateway-vm-configuration.ts` (source of extraction)
- Reference: `packages/agent-vm/src/gateway/gateway-vm-setup.ts` (source of extraction)
- Reference: `packages/agent-vm/src/gateway/gateway-openclaw-lifecycle.ts` (source of extraction)

- [ ] **Step 1: Create package scaffolding**

`packages/openclaw-gateway/package.json`:

```json
{
	"name": "openclaw-gateway",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"scripts": {
		"build": "tsc -p tsconfig.build.json",
		"typecheck": "tsc -p tsconfig.json --noEmit"
	},
	"dependencies": {
		"gateway-interface": "workspace:*",
		"gondolin-core": "workspace:*"
	}
}
```

`tsconfig.json` and `tsconfig.build.json`: same pattern as `gateway-interface` (extends `../../tsconfig.base.json`).

- [ ] **Step 2: Write the failing lifecycle tests**

`packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`:

```ts
import type { GatewayZoneConfig } from 'gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import { openclawLifecycle } from './openclaw-lifecycle.js';

const zone: GatewayZoneConfig = {
	id: 'shravan',
	gateway: {
		type: 'openclaw',
		memory: '2G',
		cpus: 2,
		port: 18791,
		gatewayConfig: '/home/user/config/shravan/openclaw.json',
		stateDir: '/home/user/state/shravan',
		workspaceDir: '/home/user/workspaces/shravan',
	},
	secrets: {
		PERPLEXITY_API_KEY: {
			source: '1password',
			ref: 'op://vault/item/key',
			injection: 'http-mediation',
			hosts: ['api.perplexity.ai'],
		},
		DISCORD_BOT_TOKEN: {
			source: '1password',
			ref: 'op://vault/item/token',
			injection: 'env',
		},
	},
	allowedHosts: ['api.openai.com', 'api.perplexity.ai'],
	websocketBypass: ['gateway.discord.gg:443'],
	toolProfile: 'standard',
};

const resolvedSecrets: Record<string, string> = {
	PERPLEXITY_API_KEY: 'pplx-key',
	DISCORD_BOT_TOKEN: 'discord-token',
	OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
};

describe('openclawLifecycle', () => {
	describe('buildVmSpec', () => {
		it('splits env and mediated secrets', () => {
			const vmSpec = openclawLifecycle.buildVmSpec(zone, resolvedSecrets, 18800, {
				basePort: 19000,
				size: 5,
			});

			expect(vmSpec.environment['DISCORD_BOT_TOKEN']).toBe('discord-token');
			expect(vmSpec.environment).not.toHaveProperty('PERPLEXITY_API_KEY');
			expect(vmSpec.mediatedSecrets['PERPLEXITY_API_KEY']).toEqual({
				hosts: ['api.perplexity.ai'],
				value: 'pplx-key',
			});
		});

		it('sets OpenClaw-specific environment variables', () => {
			const vmSpec = openclawLifecycle.buildVmSpec(zone, resolvedSecrets, 18800, {
				basePort: 19000,
				size: 5,
			});

			expect(vmSpec.environment['OPENCLAW_HOME']).toBe('/home/openclaw');
			expect(vmSpec.environment['OPENCLAW_CONFIG_PATH']).toBe(
				'/home/openclaw/.openclaw/config/openclaw.json',
			);
			expect(vmSpec.environment['OPENCLAW_STATE_DIR']).toBe('/home/openclaw/.openclaw/state');
		});

		it('builds TCP hosts with controller, tool slots, and websocket bypass', () => {
			const vmSpec = openclawLifecycle.buildVmSpec(zone, resolvedSecrets, 18800, {
				basePort: 19000,
				size: 3,
			});

			expect(vmSpec.tcpHosts).toEqual({
				'controller.vm.host:18800': '127.0.0.1:18800',
				'tool-0.vm.host:22': '127.0.0.1:19000',
				'tool-1.vm.host:22': '127.0.0.1:19001',
				'tool-2.vm.host:22': '127.0.0.1:19002',
				'gateway.discord.gg:443': 'gateway.discord.gg:443',
			});
		});

		it('sets VFS mounts for config, state, and workspace', () => {
			const vmSpec = openclawLifecycle.buildVmSpec(zone, resolvedSecrets, 18800, {
				basePort: 19000,
				size: 1,
			});

			expect(vmSpec.vfsMounts).toEqual({
				'/home/openclaw/.openclaw/config': {
					kind: 'realfs',
					hostPath: '/home/user/config/shravan',
				},
				'/home/openclaw/.openclaw/state': {
					kind: 'realfs',
					hostPath: '/home/user/state/shravan',
				},
				'/home/openclaw/workspace': {
					kind: 'realfs',
					hostPath: '/home/user/workspaces/shravan',
				},
			});
		});

		it('uses cow rootfs and zone-based session label', () => {
			const vmSpec = openclawLifecycle.buildVmSpec(zone, resolvedSecrets, 18800, {
				basePort: 19000,
				size: 1,
			});

			expect(vmSpec.rootfsMode).toBe('cow');
			expect(vmSpec.sessionLabel).toBe('shravan-gateway');
		});
	});

	describe('buildProcessSpec', () => {
		it('returns OpenClaw-specific startup and health check', () => {
			const processSpec = openclawLifecycle.buildProcessSpec(zone, resolvedSecrets);

			expect(processSpec.startCommand).toBe(
				'cd /home/openclaw && nohup openclaw gateway --port 18789 > /tmp/openclaw.log 2>&1 &',
			);
			expect(processSpec.healthCheck).toEqual({ type: 'http', port: 18789, path: '/' });
			expect(processSpec.guestListenPort).toBe(18789);
			expect(processSpec.logPath).toBe('/tmp/openclaw.log');
		});

		it('includes gateway token in bootstrap when present', () => {
			const processSpec = openclawLifecycle.buildProcessSpec(zone, resolvedSecrets);

			expect(processSpec.bootstrapCommand).toContain(
				"export OPENCLAW_GATEWAY_TOKEN='gateway-token-123'",
			);
			expect(processSpec.bootstrapCommand).toContain('chmod 600 /root/.openclaw-env');
			expect(processSpec.bootstrapCommand).toContain('source /root/.openclaw-env');
		});

		it('omits gateway token from bootstrap when not present', () => {
			const { OPENCLAW_GATEWAY_TOKEN: _, ...secretsWithoutToken } = resolvedSecrets;
			const processSpec = openclawLifecycle.buildProcessSpec(zone, secretsWithoutToken);

			expect(processSpec.bootstrapCommand).not.toContain('OPENCLAW_GATEWAY_TOKEN');
		});
	});

	describe('prepareHostState', () => {
		it('skips when authProfilesRef is not set', async () => {
			const secretResolver = { resolve: vi.fn(), resolveAll: vi.fn() };
			await openclawLifecycle.prepareHostState!(zone, secretResolver);

			expect(secretResolver.resolve).not.toHaveBeenCalled();
		});

		it('writes auth-profiles.json when authProfilesRef is set', async () => {
			const zoneWithAuth: GatewayZoneConfig = {
				...zone,
				gateway: {
					...zone.gateway,
					authProfilesRef: 'op://vault/item/auth-profiles',
				},
			};
			const secretResolver = {
				resolve: vi.fn(async () => '{"profiles":[]}'),
				resolveAll: vi.fn(),
			};

			// This test uses a real temp dir — verify the file gets written
			const fs = await import('node:fs/promises');
			const os = await import('node:os');
			const path = await import('node:path');
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-test-'));
			const testZone: GatewayZoneConfig = {
				...zoneWithAuth,
				gateway: {
					...zoneWithAuth.gateway,
					stateDir: path.join(tempDir, 'state'),
				},
			};

			try {
				await openclawLifecycle.prepareHostState!(testZone, secretResolver);

				const authProfilesPath = path.join(
					testZone.gateway.stateDir,
					'agents',
					'main',
					'agent',
					'auth-profiles.json',
				);
				const content = await fs.readFile(authProfilesPath, 'utf8');
				expect(content).toBe('{"profiles":[]}');
				expect(secretResolver.resolve).toHaveBeenCalledWith({
					source: '1password',
					ref: 'op://vault/item/auth-profiles',
				});
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		});
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
Expected: FAIL — `openclaw-lifecycle.ts` doesn't exist yet.

- [ ] **Step 4: Implement `openclaw-lifecycle.ts`**

Extract from `gateway-vm-configuration.ts` and `gateway-vm-setup.ts` and `gateway-openclaw-lifecycle.ts`. **All fs operations must use `fs/promises` (async).**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayVmSpec,
	GatewayZoneConfig,
} from 'gateway-interface';
import type { SecretResolver, SecretSpec } from 'gondolin-core';

export const openclawLifecycle: GatewayLifecycle = {
	buildVmSpec(zone, resolvedSecrets, controllerPort, tcpPool): GatewayVmSpec {
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

		const tcpHosts: Record<string, string> = {
			'controller.vm.host:18800': `127.0.0.1:${controllerPort}`,
		};
		for (let slot = 0; slot < tcpPool.size; slot += 1) {
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
		const envLines = [
			'export OPENCLAW_HOME=/home/openclaw',
			`export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/config/${path.basename(zone.gateway.gatewayConfig)}`,
			'export OPENCLAW_STATE_DIR=/home/openclaw/.openclaw/state',
			'export NODE_EXTRA_CA_CERTS=/run/gondolin/ca-certificates.crt',
		];
		if (resolvedSecrets['OPENCLAW_GATEWAY_TOKEN']) {
			const escapedToken = resolvedSecrets['OPENCLAW_GATEWAY_TOKEN'].replace(/'/gu, "'\\''");
			envLines.push(`export OPENCLAW_GATEWAY_TOKEN='${escapedToken}'`);
		}

		return {
			bootstrapCommand:
				'mkdir -p /root && cat > /root/.openclaw-env << ENVEOF\n' +
				envLines.join('\n') +
				'\n' +
				'ENVEOF\n' +
				'chmod 600 /root/.openclaw-env && ' +
				'touch /root/.bashrc && ' +
				"grep -qxF 'source /root/.openclaw-env' /root/.bashrc || echo 'source /root/.openclaw-env' >> /root/.bashrc",
			startCommand:
				'cd /home/openclaw && nohup openclaw gateway --port 18789 > /tmp/openclaw.log 2>&1 &',
			healthCheck: { type: 'http', port: 18789, path: '/' },
			guestListenPort: 18789,
			logPath: '/tmp/openclaw.log',
		};
	},

	async prepareHostState(zone, secretResolver): Promise<void> {
		if (!zone.gateway.authProfilesRef) return;

		const authProfilesDir = path.join(zone.gateway.stateDir, 'agents', 'main', 'agent');
		await fs.mkdir(authProfilesDir, { recursive: true });
		await fs.writeFile(
			path.join(authProfilesDir, 'auth-profiles.json'),
			await secretResolver.resolve({ source: '1password', ref: zone.gateway.authProfilesRef }),
			'utf8',
		);
	},
};
```

- [ ] **Step 5: Create `index.ts`**

```ts
export { openclawLifecycle } from './openclaw-lifecycle.js';
```

- [ ] **Step 6: Run `pnpm install` and then tests**

Run: `pnpm install && pnpm vitest run packages/openclaw-gateway/src/openclaw-lifecycle.test.ts`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/openclaw-gateway/
git commit -m "$(cat <<'EOF'
feat: extract openclaw-gateway package — implements GatewayLifecycle

Moves OpenClaw VM config, secret splitting, TCP host building,
bootstrap command, and auth-profiles preparation into a standalone
package. All fs operations use fs/promises.
EOF
)"
```

---

### Task 4: Refactor Orchestrator to Use the Interface

This is the core refactor. The orchestrator becomes generic — it accepts a `GatewayLifecycle` and executes specs. This task also adds the missing `waitForHealth` generic function, ingress setup, and threads `processSpec` into the gateway handle.

**Files:**

- Create: `packages/agent-vm/src/gateway/gateway-health-check.ts`
- Create: `packages/agent-vm/src/gateway/gateway-health-check.test.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-support.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime-operations.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`
- Modify: `packages/agent-vm/package.json`

- [ ] **Step 1: Write the failing health check test**

`packages/agent-vm/src/gateway/gateway-health-check.test.ts`:

```ts
import type { ManagedVm } from 'gondolin-core';
import { describe, expect, it, vi } from 'vitest';

import { waitForGatewayHealth } from './gateway-health-check.js';

function createMockVm(
	execResults: { exitCode: number; stdout: string; stderr: string }[],
): ManagedVm {
	let callIndex = 0;
	return {
		id: 'test-vm',
		close: vi.fn(async () => {}),
		enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
		enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
		exec: vi.fn(async () => {
			const result = execResults[callIndex] ?? execResults[execResults.length - 1]!;
			callIndex += 1;
			return result;
		}),
		getVmInstance: vi.fn(),
		setIngressRoutes: vi.fn(),
	} satisfies ManagedVm;
}

describe('waitForGatewayHealth', () => {
	it('resolves immediately when health check returns 2xx', async () => {
		const vm = createMockVm([{ exitCode: 0, stdout: '200', stderr: '' }]);

		await waitForGatewayHealth(
			vm,
			{ type: 'http', port: 18789, path: '/' },
			{ maxAttempts: 5, intervalMs: 0 },
		);

		expect(vm.exec).toHaveBeenCalledTimes(1);
	});

	it('retries until 2xx is returned', async () => {
		const vm = createMockVm([
			{ exitCode: 0, stdout: '000', stderr: '' },
			{ exitCode: 0, stdout: '000', stderr: '' },
			{ exitCode: 0, stdout: '200', stderr: '' },
		]);

		await waitForGatewayHealth(
			vm,
			{ type: 'http', port: 18789, path: '/' },
			{ maxAttempts: 5, intervalMs: 0 },
		);

		expect(vm.exec).toHaveBeenCalledTimes(3);
	});

	it('rejects non-2xx as not ready', async () => {
		const vm = createMockVm([
			{ exitCode: 0, stdout: '500', stderr: '' },
			{ exitCode: 0, stdout: '500', stderr: '' },
			{ exitCode: 0, stdout: '500', stderr: '' },
		]);

		await expect(
			waitForGatewayHealth(
				vm,
				{ type: 'http', port: 18789, path: '/' },
				{ maxAttempts: 3, intervalMs: 0 },
			),
		).rejects.toThrow(/readiness/i);
	});

	it('throws after exhausting max attempts', async () => {
		const vm = createMockVm([{ exitCode: 0, stdout: '000', stderr: '' }]);

		await expect(
			waitForGatewayHealth(
				vm,
				{ type: 'http', port: 18789, path: '/' },
				{ maxAttempts: 2, intervalMs: 0 },
			),
		).rejects.toThrow(/readiness/i);
	});

	it('supports command-type health checks', async () => {
		const vm = createMockVm([{ exitCode: 0, stdout: '', stderr: '' }]);

		await waitForGatewayHealth(
			vm,
			{ type: 'command', command: '/health-check.sh' },
			{ maxAttempts: 5, intervalMs: 0 },
		);

		expect(vm.exec).toHaveBeenCalledWith('/health-check.sh');
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/gateway/gateway-health-check.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `gateway-health-check.ts`**

```ts
import type { GatewayHealthCheck } from 'gateway-interface';
import type { ManagedVm } from 'gondolin-core';

export interface HealthCheckOptions {
	readonly maxAttempts?: number;
	readonly intervalMs?: number;
}

export async function waitForGatewayHealth(
	vm: ManagedVm,
	healthCheck: GatewayHealthCheck,
	options?: HealthCheckOptions,
): Promise<void> {
	const maxAttempts = options?.maxAttempts ?? 30;
	const intervalMs = options?.intervalMs ?? 500;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const isHealthy =
			healthCheck.type === 'http'
				? await checkHttp(vm, healthCheck.port, healthCheck.path)
				: await checkCommand(vm, healthCheck.command);

		if (isHealthy) return;

		if (attempt < maxAttempts - 1) {
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	}

	throw new Error(
		`Gateway readiness check failed after ${maxAttempts} attempts. The gateway process may not have started.`,
	);
}

async function checkHttp(vm: ManagedVm, port: number, path: string): Promise<boolean> {
	const result = await vm.exec(
		`curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:${port}${path} 2>/dev/null || echo 000`,
	);
	const statusCode = result.stdout.trim();
	// Only 2xx counts as ready — 500/502/403 are not "ready"
	return statusCode.startsWith('2');
}

async function checkCommand(vm: ManagedVm, command: string): Promise<boolean> {
	const result = await vm.exec(command);
	return result.exitCode === 0;
}
```

- [ ] **Step 4: Run health check tests**

Run: `pnpm vitest run packages/agent-vm/src/gateway/gateway-health-check.test.ts`
Expected: all pass.

- [ ] **Step 5: Update `gateway-zone-support.ts` — add `processSpec` to `GatewayZoneStartResult`**

```ts
import type { GatewayProcessSpec } from 'gateway-interface';

// ... existing imports ...

export interface GatewayZoneStartResult {
	readonly image: import('gondolin-core').BuildImageResult;
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly processSpec: GatewayProcessSpec;
	readonly vm: import('gondolin-core').ManagedVm;
	readonly zone: GatewayZone;
}
```

- [ ] **Step 6: Rewrite `gateway-zone-orchestrator.ts` to use the interface**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

import type { GatewayLifecycle } from 'gateway-interface';
import { createManagedVm, type ManagedVm } from 'gondolin-core';

import { resolveZoneSecrets } from './credential-manager.js';
import {
	buildGatewayImage,
	type GatewayImageBuilderDependencies,
} from './gateway-image-builder.js';
import { waitForGatewayHealth } from './gateway-health-check.js';
import {
	findGatewayZone,
	type GatewayZoneStartResult,
	type StartGatewayZoneOptions,
} from './gateway-zone-support.js';

export interface GatewayManagerDependencies extends GatewayImageBuilderDependencies {
	readonly createManagedVm?: typeof createManagedVm;
}

export async function startGatewayZone(
	options: StartGatewayZoneOptions & { readonly lifecycle: GatewayLifecycle },
	dependencies: GatewayManagerDependencies = {},
): Promise<GatewayZoneStartResult> {
	const runTaskStep =
		options.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const zone = findGatewayZone(options.systemConfig, options.zoneId);

	// 1. Resolve secrets
	let resolvedSecrets!: Awaited<ReturnType<typeof resolveZoneSecrets>>;
	await runTaskStep('Resolving zone secrets', async () => {
		resolvedSecrets = await resolveZoneSecrets({
			systemConfig: options.systemConfig,
			zoneId: zone.id,
			secretResolver: options.secretResolver,
		});
	});

	// 2. Build image
	let image!: Awaited<ReturnType<typeof buildGatewayImage>>;
	await runTaskStep('Building gateway image', async () => {
		image = await buildGatewayImage(
			{
				buildConfigPath: options.systemConfig.images.gateway.buildConfig,
				cacheDir: path.join(options.systemConfig.cacheDir, 'images', 'gateway'),
			},
			{
				...(dependencies.buildImage ? { buildImage: dependencies.buildImage } : {}),
				...(dependencies.loadBuildConfig ? { loadBuildConfig: dependencies.loadBuildConfig } : {}),
			},
		);
	});

	// 3. Create mount target directories (unconditional — controller responsibility)
	await fs.mkdir(zone.gateway.stateDir, { recursive: true });
	await fs.mkdir(zone.gateway.workspaceDir, { recursive: true });

	// 4. Pre-start hook (optional — gateway-specific host state)
	if (options.lifecycle.prepareHostState) {
		await runTaskStep('Preparing host state', async () => {
			await options.lifecycle.prepareHostState!(zone, options.secretResolver);
		});
	}

	// 5. Build specs (pure, no side effects)
	const vmSpec = options.lifecycle.buildVmSpec(
		zone,
		resolvedSecrets,
		options.systemConfig.host.controllerPort,
		options.systemConfig.tcpPool,
	);
	const processSpec = options.lifecycle.buildProcessSpec(zone, resolvedSecrets);

	// 6. Create VM
	const createVm = dependencies.createManagedVm ?? createManagedVm;
	let managedVm!: ManagedVm;
	await runTaskStep('Booting gateway VM', async () => {
		managedVm = await createVm({
			imagePath: image.imagePath,
			memory: zone.gateway.memory,
			cpus: zone.gateway.cpus,
			rootfsMode: vmSpec.rootfsMode,
			env: vmSpec.environment,
			vfsMounts: vmSpec.vfsMounts,
			secrets: vmSpec.mediatedSecrets,
			allowedHosts: vmSpec.allowedHosts,
			tcpHosts: vmSpec.tcpHosts,
			sessionLabel: vmSpec.sessionLabel,
		});
	});

	// 7. Bootstrap shell environment
	await runTaskStep('Configuring gateway', async () => {
		await managedVm.exec(processSpec.bootstrapCommand);
	});

	// 8. Start the gateway process
	await runTaskStep('Starting gateway', async () => {
		await managedVm.exec(processSpec.startCommand);
	});

	// 9. Wait for health
	await runTaskStep('Waiting for readiness', async () => {
		await waitForGatewayHealth(managedVm, processSpec.healthCheck);
	});

	// 10. Enable ingress
	managedVm.setIngressRoutes([
		{
			port: processSpec.guestListenPort,
			prefix: '/',
			stripPrefix: true,
		},
	]);
	const ingress = await managedVm.enableIngress({
		listenPort: zone.gateway.port,
	});

	return { image, ingress, processSpec, vm: managedVm, zone };
}
```

- [ ] **Step 7: Add `processSpec` to `GatewayZoneRuntime` in `controller-runtime-operations.ts`**

```ts
import type { GatewayProcessSpec } from 'gateway-interface';

interface GatewayZoneRuntime {
	readonly ingress: {
		readonly host: string;
		readonly port: number;
	};
	readonly processSpec: GatewayProcessSpec;
	readonly vm: {
		close(): Promise<void>;
		enableSsh(): Promise<unknown>;
		exec(command: string): Promise<{
			readonly exitCode: number;
			readonly stderr: string;
			readonly stdout: string;
		}>;
	};
}
```

And update `getZoneLogs` to use it:

```ts
getZoneLogs: async (targetZoneId: string) => {
	assertActiveZone(targetZoneId);
	return await runControllerLogs(
		{ zoneId: targetZoneId },
		{
			readGatewayLogs: async () => {
				try {
					const result = await options
						.getGateway()
						.vm.exec(`cat ${options.getGateway().processSpec.logPath} 2>/dev/null || echo ""`);
					return result.stdout;
				} catch {
					return '';
				}
			},
		},
	);
},
```

- [ ] **Step 8: Thread `processSpec` through `controller-runtime.ts`**

In the gateway handle, store and expose `processSpec`:

```ts
// After startGateway() returns, gateway now has .processSpec
const stopGatewayZone = async (): Promise<void> => await gateway.vm.close();

// In createControllerRuntimeOperations, getGateway returns processSpec:
getGateway: () => ({
	ingress: gateway.ingress,
	processSpec: gateway.processSpec,
	vm: gateway.vm,
}),
```

- [ ] **Step 9: Update `controller-runtime-types.ts`**

Add `lifecycle` to `StartGatewayZoneOptions` or ensure `startGatewayZone` in dependencies accepts the lifecycle. The `startGatewayZone` type reference needs to match the new signature with `lifecycle`.

- [ ] **Step 10: Rewrite orchestrator tests for generic lifecycle**

The existing tests in `gateway-zone-orchestrator.test.ts` assert OpenClaw-specific behavior (env vars, paths). Rewrite them to test generic orchestration: the test provides a mock `GatewayLifecycle` and verifies the orchestrator calls the right lifecycle methods in the right order, passes specs to `createManagedVm`, and threads `processSpec` into the result.

Keep the existing behavior assertions (secret splitting, TCP hosts, env vars) but move them to the `openclaw-gateway` package tests (Task 3). The orchestrator tests should verify:

- lifecycle.buildVmSpec is called with the right args
- lifecycle.buildProcessSpec is called with the right args
- lifecycle.prepareHostState is called when present
- createManagedVm receives the vmSpec fields
- processSpec is in the returned result
- health check is invoked
- ingress is configured from processSpec.guestListenPort

- [ ] **Step 11: Run all affected tests**

Run: `pnpm vitest run packages/agent-vm/src/gateway/ packages/agent-vm/src/controller/`
Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add packages/agent-vm/
git commit -m "$(cat <<'EOF'
refactor: orchestrator uses GatewayLifecycle interface

Orchestrator accepts a GatewayLifecycle, calls buildVmSpec/buildProcessSpec,
and executes generically. processSpec is retained in the gateway handle for
runtime operations. Generic waitForGatewayHealth replaces OpenClaw-specific
readiness polling. Health check now requires 2xx (not just non-000).
EOF
)"
```

---

### Task 5: Wire Lifecycle Loader and Dependencies

**Files:**

- Create: `packages/agent-vm/src/gateway/gateway-lifecycle-loader.ts`
- Create: `packages/agent-vm/src/gateway/gateway-lifecycle-loader.test.ts`
- Modify: `packages/agent-vm/package.json`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`

- [ ] **Step 1: Write failing loader tests**

```ts
import type { GatewayLifecycle } from 'gateway-interface';
import { describe, expect, it } from 'vitest';

import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';

describe('loadGatewayLifecycle', () => {
	it('returns the openclaw lifecycle for openclaw type', () => {
		const lifecycle = loadGatewayLifecycle('openclaw');
		expect(lifecycle).toBeDefined();
		expect(lifecycle.buildVmSpec).toBeTypeOf('function');
		expect(lifecycle.buildProcessSpec).toBeTypeOf('function');
	});

	it('returns the coding lifecycle for coding type', () => {
		const lifecycle = loadGatewayLifecycle('coding');
		expect(lifecycle).toBeDefined();
		expect(lifecycle.buildVmSpec).toBeTypeOf('function');
	});

	it('throws for unknown gateway types', () => {
		expect(() => loadGatewayLifecycle('unknown')).toThrow("Unknown gateway type 'unknown'");
	});
});
```

- [ ] **Step 2: Implement the static lifecycle map**

```ts
import { workerLifecycle } from 'worker-gateway';
import type { GatewayLifecycle } from 'gateway-interface';
import { openclawLifecycle } from 'openclaw-gateway';

const lifecycleByType = {
	coding: workerLifecycle,
	openclaw: openclawLifecycle,
} satisfies Record<string, GatewayLifecycle>;

export function loadGatewayLifecycle(type: string): GatewayLifecycle {
	const lifecycle = lifecycleByType[type as keyof typeof lifecycleByType];
	if (!lifecycle) {
		throw new Error(
			`Unknown gateway type '${type}'. Supported types: ${Object.keys(lifecycleByType).join(', ')}`,
		);
	}
	return lifecycle;
}
```

- [ ] **Step 3: Add workspace dependencies to `agent-vm/package.json`**

```json
"dependencies": {
	"@hono/node-server": "^1",
	"cmd-ts": "^0.14.0",
	"worker-gateway": "workspace:*",
	"execa": "^9.5.2",
	"gateway-interface": "workspace:*",
	"gondolin-core": "workspace:*",
	"hono": "^4",
	"openclaw-gateway": "workspace:*",
	"zod": "^4"
}
```

- [ ] **Step 4: Wire lifecycle into `controller-runtime.ts`**

In `startControllerRuntime`, load the lifecycle from zone config and pass it to the orchestrator:

```ts
import { loadGatewayLifecycle } from '../gateway/gateway-lifecycle-loader.js';

// ... inside startControllerRuntime:
const zone = findConfiguredZone(options.systemConfig, options.zoneId);
const lifecycle = loadGatewayLifecycle(zone.gateway.type);

const startGateway = async () =>
	await (dependencies.startGatewayZone ?? startGatewayZone)({
		lifecycle,
		runTask: runTaskStep,
		secretResolver,
		systemConfig: options.systemConfig,
		zoneId: options.zoneId,
	});
```

- [ ] **Step 5: Run `pnpm install` then typecheck and tests**

Run: `pnpm install && pnpm typecheck && pnpm vitest run packages/agent-vm/src/gateway/gateway-lifecycle-loader.test.ts`
Expected: workspace links resolve, typecheck passes, loader tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/
git commit -m "$(cat <<'EOF'
feat: add lifecycle loader — static import map for gateway types

Controller loads GatewayLifecycle by zone.gateway.type via a static map.
agent-vm depends on gateway-interface, openclaw-gateway, and worker-gateway.
EOF
)"
```

---

### Task 6: Delete Old OpenClaw-Specific Code

**Files:**

- Delete: `packages/agent-vm/src/gateway/gateway-openclaw-lifecycle.ts`
- Delete: `packages/agent-vm/src/gateway/gateway-vm-setup.ts`
- Delete: `packages/agent-vm/src/gateway/gateway-vm-setup.test.ts`
- Delete: `packages/agent-vm/src/gateway/gateway-vm-configuration.ts`
- Delete: `packages/agent-vm/src/gateway/gateway-vm-configuration.test.ts`
- Modify: `packages/agent-vm/src/index.ts` (remove dead re-exports if any)

- [ ] **Step 1: Delete the files**

```bash
rm packages/agent-vm/src/gateway/gateway-openclaw-lifecycle.ts
rm packages/agent-vm/src/gateway/gateway-vm-setup.ts
rm packages/agent-vm/src/gateway/gateway-vm-setup.test.ts
rm packages/agent-vm/src/gateway/gateway-vm-configuration.ts
rm packages/agent-vm/src/gateway/gateway-vm-configuration.test.ts
```

- [ ] **Step 2: Remove any stale imports or re-exports from `index.ts`**

Grep for imports from the deleted files and remove them:

```bash
grep -r "gateway-vm-configuration\|gateway-vm-setup\|gateway-openclaw-lifecycle" packages/agent-vm/src/ --include="*.ts" | grep -v node_modules | grep -v dist | grep -v ".test.ts"
```

Expected: zero matches after cleanup (the orchestrator no longer imports these).

- [ ] **Step 3: Run the full suite**

Run: `pnpm check && pnpm test`
Expected: lint/typecheck/format pass, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A packages/agent-vm/src/gateway/
git commit -m "$(cat <<'EOF'
refactor: delete OpenClaw-specific helpers from agent-vm

gateway-openclaw-lifecycle.ts, gateway-vm-setup.ts, and
gateway-vm-configuration.ts moved to openclaw-gateway package.
agent-vm orchestrator uses the generic GatewayLifecycle interface.
EOF
)"
```

---

### Task 7: Create Worker Gateway Scaffold

**Files:**

- Create: `packages/worker-gateway/package.json`
- Create: `packages/worker-gateway/tsconfig.json`
- Create: `packages/worker-gateway/tsconfig.build.json`
- Create: `packages/worker-gateway/src/worker-lifecycle.ts`
- Create: `packages/worker-gateway/src/worker-lifecycle.test.ts`
- Create: `packages/worker-gateway/src/index.ts`

- [ ] **Step 1: Create package scaffolding**

`packages/worker-gateway/package.json`:

```json
{
	"name": "worker-gateway",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"scripts": {
		"build": "tsc -p tsconfig.build.json",
		"typecheck": "tsc -p tsconfig.json --noEmit"
	},
	"dependencies": {
		"gateway-interface": "workspace:*",
		"gondolin-core": "workspace:*"
	}
}
```

`tsconfig.json` and `tsconfig.build.json`: same pattern as other packages.

- [ ] **Step 2: Write the failing tests**

```ts
import type { GatewayZoneConfig } from 'gateway-interface';
import { describe, expect, it } from 'vitest';

import { workerLifecycle } from './worker-lifecycle.js';

const zone: GatewayZoneConfig = {
	id: 'test-coding',
	gateway: {
		type: 'coding',
		memory: '2G',
		cpus: 2,
		port: 18791,
		gatewayConfig: '/home/user/config/coding.json',
		stateDir: '/home/user/state/coding',
		workspaceDir: '/home/user/workspaces/coding',
	},
	secrets: {
		ANTHROPIC_API_KEY: {
			source: '1password',
			ref: 'op://vault/item/key',
			injection: 'http-mediation',
			hosts: ['api.anthropic.com'],
		},
		GITHUB_TOKEN: {
			source: '1password',
			ref: 'op://vault/item/token',
			injection: 'env',
		},
	},
	allowedHosts: ['api.anthropic.com', 'api.github.com'],
	websocketBypass: [],
	toolProfile: 'standard',
};

const resolvedSecrets: Record<string, string> = {
	ANTHROPIC_API_KEY: 'anthropic-key',
	GITHUB_TOKEN: 'github-token',
};

describe('workerLifecycle', () => {
	describe('buildVmSpec', () => {
		it('mounts /state and /workspace', () => {
			const vmSpec = workerLifecycle.buildVmSpec(zone, resolvedSecrets, 18800, {
				basePort: 19000,
				size: 3,
			});

			expect(vmSpec.vfsMounts['/state']).toEqual({
				kind: 'realfs',
				hostPath: '/home/user/state/coding',
			});
			expect(vmSpec.vfsMounts['/workspace']).toEqual({
				kind: 'realfs',
				hostPath: '/home/user/workspaces/coding',
			});
		});

		it('splits env and mediated secrets', () => {
			const vmSpec = workerLifecycle.buildVmSpec(zone, resolvedSecrets, 18800, {
				basePort: 19000,
				size: 1,
			});

			expect(vmSpec.environment['GITHUB_TOKEN']).toBe('github-token');
			expect(vmSpec.mediatedSecrets['ANTHROPIC_API_KEY']).toEqual({
				hosts: ['api.anthropic.com'],
				value: 'anthropic-key',
			});
		});

		it('uses coding session label', () => {
			const vmSpec = workerLifecycle.buildVmSpec(zone, resolvedSecrets, 18800, {
				basePort: 19000,
				size: 1,
			});

			expect(vmSpec.sessionLabel).toBe('test-coding-coding');
		});

		it('includes controller TCP host', () => {
			const vmSpec = workerLifecycle.buildVmSpec(zone, resolvedSecrets, 18800, {
				basePort: 19000,
				size: 1,
			});

			expect(vmSpec.tcpHosts['controller.vm.host:18800']).toBe('127.0.0.1:18800');
		});
	});

	describe('buildProcessSpec', () => {
		it('throws because agent-vm-worker is not present yet', () => {
			expect(() => workerLifecycle.buildProcessSpec(zone, resolvedSecrets)).toThrow(
				/agent-vm-worker/i,
			);
		});
	});
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run packages/worker-gateway/src/worker-lifecycle.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `worker-lifecycle.ts`**

```ts
import path from 'node:path';

import type {
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayVmSpec,
	GatewayZoneConfig,
} from 'gateway-interface';
import type { SecretSpec } from 'gondolin-core';

export const workerLifecycle: GatewayLifecycle = {
	buildVmSpec(zone, resolvedSecrets, controllerPort, _tcpPool): GatewayVmSpec {
		const environment: Record<string, string> = {
			HOME: '/home/coder',
			NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
			STATE_DIR: '/state',
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

		const tcpHosts: Record<string, string> = {
			'controller.vm.host:18800': `127.0.0.1:${controllerPort}`,
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

	buildProcessSpec(_zone, _resolvedSecrets): GatewayProcessSpec {
		throw new Error(
			"Coding gateway process start is blocked: 'agent-vm-worker' is not present in this repo yet. " +
				'The VM spec (buildVmSpec) is functional — process startup will be implemented when the worker lands.',
		);
	},

	// No prepareHostState needed for coding gateway
};
```

- [ ] **Step 5: Create `index.ts`**

```ts
export { workerLifecycle } from './worker-lifecycle.js';
```

- [ ] **Step 6: Run `pnpm install` and tests**

Run: `pnpm install && pnpm vitest run packages/worker-gateway/src/worker-lifecycle.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/worker-gateway/
git commit -m "$(cat <<'EOF'
feat: add worker-gateway package — scaffold with honest runtime guard

buildVmSpec is functional (mounts, secrets, TCP hosts). buildProcessSpec
throws until agent-vm-worker lands. No pretending to work.
EOF
)"
```

---

### Task 8: Fix Pre-Existing Bugs and Remove Sync FS Cruft

These bugs were surfaced during PR #3 review. The sync fs calls violate the async-everywhere pattern established in the prior changeset. Fix all of it in one pass.

**Files:**

- Modify: `packages/agent-vm/src/controller/idle-reaper.ts`
- Modify: `packages/agent-vm/src/controller/idle-reaper.test.ts` (if exists, or create)
- Modify: `packages/openclaw-agent-vm-plugin/src/controller-lease-client.ts`
- Modify: `packages/agent-vm/src/controller/system-config.ts`
- Modify: `packages/agent-vm/src/controller/system-config.test.ts`
- Modify: `packages/agent-vm/src/cli/init-command.ts`
- Modify: `packages/agent-vm/src/cli/init-command.test.ts`

- [ ] **Step 1: Fix idle reaper — sequential lease release**

The idle reaper uses `Promise.all` for lease release. Every other release path in the codebase uses sequential release with comments like "sequential release avoids TCP slot races." The reaper should match.

In `idle-reaper.ts`:

```ts
export function createIdleReaper(options: {
	readonly getLeases: () => {
		readonly id: string;
		readonly lastUsedAt: number;
	}[];
	readonly now: () => number;
	readonly releaseLease: (leaseId: string) => Promise<void>;
	readonly ttlMs: number;
}): {
	reapExpiredLeases(): Promise<void>;
} {
	return {
		async reapExpiredLeases(): Promise<void> {
			const expiredLeaseIds = options
				.getLeases()
				.filter((lease) => options.now() - lease.lastUsedAt > options.ttlMs)
				.map((lease) => lease.id);
			for (const leaseId of expiredLeaseIds) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- sequential release avoids TCP slot races
				await options.releaseLease(leaseId);
			}
		},
	};
}
```

- [ ] **Step 2: Fix duplicate `isGondolinLeaseResponse` in `controller-lease-client.ts`**

The `controller-lease-client.ts` has its own copy that doesn't validate `ssh`. Import from the contract instead:

```ts
import {
	isGondolinLeaseResponse,
	type GondolinLeaseResponse,
} from './sandbox-backend/sandbox-backend-contract.js';
```

Remove the local `isGondolinLeaseResponse` function and the local `GondolinLeaseResponse` interface (keep the interface if the contract one differs, or consolidate into a single shared type).

**Important:** Check that the import path is correct — `controller-lease-client.ts` is in `openclaw-agent-vm-plugin/src/` and `sandbox-backend-contract.ts` is in `openclaw-agent-vm-plugin/src/sandbox-backend/`. Verify the contract exports the type guard and the interface.

- [ ] **Step 3: Make `loadSystemConfig` async**

In `system-config.ts`, convert to async:

```ts
import fs from 'node:fs/promises';

export async function loadSystemConfig(configPath: string): Promise<SystemConfig> {
	const absoluteConfigPath = path.resolve(configPath);
	const configDir = path.dirname(absoluteConfigPath);
	const rawConfig = await fs.readFile(absoluteConfigPath, 'utf8');
	const parsedConfig = JSON.parse(rawConfig) as unknown;
	const config = systemConfigSchema.parse(parsedConfig);
	return resolveRelativePaths(config, configDir);
}
```

Update all callers and tests to await it. The test already creates temp files synchronously (fine in tests), but the assertion becomes:

```ts
await expect(loadSystemConfig(configPath)).resolves.toMatchObject({ ... });
```

And the error case:

```ts
await expect(loadSystemConfig(configPath)).rejects.toThrow(/zones/i);
```

**Grep for all callers of `loadSystemConfig`** and update them. This likely includes CLI command handlers.

- [ ] **Step 4: Convert `init-command.ts` to async fs**

`init-command.ts` has 4 sync fs calls: `mkdirSync`, `writeFileSync`, `appendFileSync`. Convert them:

- `writeFileIfMissing` → async, use `fs.writeFile` with `{ flag: 'wx' }` and catch `EEXIST`
- `scaffoldAgentVmProject` → async, callers must await
- `fs.mkdirSync` → `await fs.mkdir`
- `fs.appendFileSync` → `await fs.appendFile`

Update `init-command.test.ts` to await the async scaffolding.

Only 2 non-test source files have sync fs: `system-config.ts` (step 3) and `init-command.ts` (this step). After this, zero sync fs in non-test source code.

- [ ] **Step 5: Verify no sync fs calls remain in non-test source**

Run: `grep -rn "readFileSync\|writeFileSync\|mkdirSync\|rmSync\|appendFileSync\|readdirSync" packages/agent-vm/src/ packages/openclaw-gateway/src/ packages/worker-gateway/src/ packages/gateway-interface/src/ --include="*.ts" | grep -v ".test.ts" | grep -v node_modules | grep -v dist`
Expected: zero matches.

- [ ] **Step 6: Run all affected tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/ packages/agent-vm/src/cli/ packages/openclaw-agent-vm-plugin/src/`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/ packages/openclaw-agent-vm-plugin/
git commit -m "$(cat <<'EOF'
fix: remove all sync fs from source, fix idle reaper race, deduplicate type guard

- Idle reaper: Promise.all → sequential for-loop (matches all other release paths)
- controller-lease-client: import isGondolinLeaseResponse from contract
- loadSystemConfig: sync readFileSync → async readFile
- init-command: sync writeFileSync/mkdirSync/appendFileSync → async
- Zero sync fs calls remain in non-test source files
EOF
)"
```

---

### Task 9: Split Controller Into Domain Folders

The current `controller/` folder is a flat bag of 21 files mixing config, leases, HTTP, operations, and runtime wiring. Split it by domain boundary so each folder has one clear responsibility. This is a file-move refactor — same code, new structure.

**Why now:** The gateway abstraction just changed import paths across the codebase. Doing the folder restructure in the same branch avoids a second round of import churn. And `controller-runtime.ts` is about to get a `lifecycle` parameter + `processSpec` threading — better to slim it down first.

**Target structure:**

```
packages/agent-vm/src/
├── config/                                    ← EXTRACTED from controller/
│   ├── system-config.ts                       ←   schema + async loading + path resolution
│   └── system-config.test.ts
│
├── controller/                                ← THIN: orchestration only, no domain logic
│   ├── controller-runtime.ts                  ←   wires services together (<100 lines)
│   ├── controller-runtime-types.ts            ←   ControllerRuntime, deps interfaces
│   ├── controller-runtime-support.ts          ←   createSecretResolverFromSystemConfig, findConfiguredZone
│   ├── controller-runtime.test.ts
│   └── controller-runtime-operations.ts       ←   stays here — it IS the runtime ops wiring
│
├── gateway/                                   ← orchestrator + health + lifecycle loader (already here)
│   ├── credential-manager.ts
│   ├── gateway-health-check.ts
│   ├── gateway-image-builder.ts
│   ├── gateway-lifecycle-loader.ts
│   ├── gateway-zone-orchestrator.ts
│   ├── gateway-zone-support.ts
│   └── ... tests ...
│
├── http/                                      ← EXTRACTED from controller/
│   ├── controller-http-server.ts              ←   Hono server start/stop
│   ├── controller-http-routes.ts              ←   route definitions (lease + zone ops)
│   ├── controller-zone-operation-routes.ts    ←   zone-specific routes
│   ├── controller-http-route-support.ts       ←   shared route types
│   ├── controller-request-schemas.ts          ←   Zod request schemas
│   ├── controller-client.ts                   ←   HTTP client (used by CLI)
│   ├── controller-http-routes.test.ts
│   └── controller-client.test.ts
│
├── leases/                                    ← EXTRACTED from controller/
│   ├── lease-service.ts                       ←   NEW: factory that creates manager + pool + reaper
│   ├── lease-manager.ts
│   ├── tcp-pool.ts
│   ├── idle-reaper.ts
│   ├── lease-manager.test.ts
│   ├── tcp-pool.test.ts
│   └── idle-reaper.test.ts
│
├── operations/                                ← already exists, stays as-is
│   ├── controller-status.ts
│   ├── credentials-refresh.ts
│   ├── destroy-zone.ts
│   ├── doctor.ts
│   ├── upgrade-zone.ts
│   ├── zone-logs.ts
│   └── ... tests ...
│
├── shared/
│   └── run-task.ts
│
├── backup/
├── cli/
└── tool-vm/
```

**Domain boundaries:**

| Folder        | Responsibility                                               | Imports from                                |
| ------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `config/`     | Parse + validate system.json, resolve paths                  | Nothing — pure data                         |
| `gateway/`    | Build specs via lifecycle, create VM, health check, ingress  | `gondolin-core`, lifecycle packages         |
| `leases/`     | TCP slot allocation, lease CRUD, idle reaping                | `gondolin-core` (tool VMs)                  |
| `http/`       | Hono routes, request handling, server lifecycle              | Operations (via injected fns)               |
| `operations/` | Runtime ops: logs, ssh, destroy, upgrade, credential refresh | Gateway handle, lease manager               |
| `controller/` | **Thin wiring only** — creates services, connects them       | Everything (but no domain logic of its own) |

**Files:**

- Move: `controller/system-config.ts` → `config/system-config.ts`
- Move: `controller/system-config.test.ts` → `config/system-config.test.ts`
- Move: `controller/controller-http-server.ts` → `http/controller-http-server.ts`
- Move: `controller/controller-http-routes.ts` → `http/controller-http-routes.ts`
- Move: `controller/controller-http-routes.test.ts` → `http/controller-http-routes.test.ts`
- Move: `controller/controller-zone-operation-routes.ts` → `http/controller-zone-operation-routes.ts`
- Move: `controller/controller-http-route-support.ts` → `http/controller-http-route-support.ts`
- Move: `controller/controller-request-schemas.ts` → `http/controller-request-schemas.ts`
- Move: `controller/controller-client.ts` → `http/controller-client.ts`
- Move: `controller/controller-client.test.ts` → `http/controller-client.test.ts`
- Move: `controller/lease-manager.ts` → `leases/lease-manager.ts`
- Move: `controller/lease-manager.test.ts` → `leases/lease-manager.test.ts`
- Move: `controller/tcp-pool.ts` → `leases/tcp-pool.ts`
- Move: `controller/tcp-pool.test.ts` → `leases/tcp-pool.test.ts`
- Move: `controller/idle-reaper.ts` → `leases/idle-reaper.ts`
- Move: `controller/idle-reaper.test.ts` → `leases/idle-reaper.test.ts`
- Create: `leases/lease-service.ts`
- Create: `leases/lease-service.test.ts`

- [ ] **Step 1: Move config files**

```bash
mkdir -p packages/agent-vm/src/config
git mv packages/agent-vm/src/controller/system-config.ts packages/agent-vm/src/config/system-config.ts
git mv packages/agent-vm/src/controller/system-config.test.ts packages/agent-vm/src/config/system-config.test.ts
```

Update all imports of `'../controller/system-config.js'` and `'./system-config.js'` across the codebase.

Run: `grep -rn "system-config" packages/agent-vm/src/ --include="*.ts" | grep "import" | grep -v node_modules | grep -v dist`

Fix every import path. The new path from `controller/` is `'../config/system-config.js'`. From `cli/` it's `'../config/system-config.js'`. From `gateway/` it's `'../config/system-config.js'`.

- [ ] **Step 2: Move HTTP files**

```bash
mkdir -p packages/agent-vm/src/http
git mv packages/agent-vm/src/controller/controller-http-server.ts packages/agent-vm/src/http/controller-http-server.ts
git mv packages/agent-vm/src/controller/controller-http-routes.ts packages/agent-vm/src/http/controller-http-routes.ts
git mv packages/agent-vm/src/controller/controller-http-routes.test.ts packages/agent-vm/src/http/controller-http-routes.test.ts
git mv packages/agent-vm/src/controller/controller-zone-operation-routes.ts packages/agent-vm/src/http/controller-zone-operation-routes.ts
git mv packages/agent-vm/src/controller/controller-http-route-support.ts packages/agent-vm/src/http/controller-http-route-support.ts
git mv packages/agent-vm/src/controller/controller-request-schemas.ts packages/agent-vm/src/http/controller-request-schemas.ts
git mv packages/agent-vm/src/controller/controller-client.ts packages/agent-vm/src/http/controller-client.ts
git mv packages/agent-vm/src/controller/controller-client.test.ts packages/agent-vm/src/http/controller-client.test.ts
```

Update all imports. The HTTP files mostly import from each other (now same folder) and from `controller/` types (now `'../controller/...'`).

- [ ] **Step 3: Move lease files**

```bash
mkdir -p packages/agent-vm/src/leases
git mv packages/agent-vm/src/controller/lease-manager.ts packages/agent-vm/src/leases/lease-manager.ts
git mv packages/agent-vm/src/controller/lease-manager.test.ts packages/agent-vm/src/leases/lease-manager.test.ts
git mv packages/agent-vm/src/controller/tcp-pool.ts packages/agent-vm/src/leases/tcp-pool.ts
git mv packages/agent-vm/src/controller/tcp-pool.test.ts packages/agent-vm/src/leases/tcp-pool.test.ts
git mv packages/agent-vm/src/controller/idle-reaper.ts packages/agent-vm/src/leases/idle-reaper.ts
git mv packages/agent-vm/src/controller/idle-reaper.test.ts packages/agent-vm/src/leases/idle-reaper.test.ts
```

Update all imports.

- [ ] **Step 4: Create `lease-service.ts`**

This is the new factory that wraps lease manager + TCP pool + idle reaper creation. Extracts the wiring from `controller-runtime.ts`.

```ts
import type { ManagedVm } from 'gondolin-core';

import type { SystemConfig } from '../config/system-config.js';
import { createIdleReaper } from './idle-reaper.js';
import { createLeaseManager, type Lease, type LeaseManager } from './lease-manager.js';
import { createTcpPool, type TcpPool } from './tcp-pool.js';

export interface LeaseServiceDependencies {
	readonly cleanWorkspace?: (options: {
		readonly profile: Lease['profileId'];
		readonly tcpSlot: number;
		readonly zoneId: string;
	}) => Promise<void>;
	readonly createManagedVm: (options: {
		readonly profile: unknown;
		readonly tcpSlot: number;
		readonly workspaceDir: string;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly now?: () => number;
}

export interface LeaseService {
	readonly leaseManager: LeaseManager;
	readonly tcpPool: TcpPool;
	startIdleReaper(intervalMs?: number): { stop(): void };
}

export function createLeaseService(
	systemConfig: SystemConfig,
	dependencies: LeaseServiceDependencies,
): LeaseService {
	const now = dependencies.now ?? Date.now;
	const tcpPool = createTcpPool(systemConfig.tcpPool);
	const leaseManager = createLeaseManager({
		cleanWorkspace: dependencies.cleanWorkspace
			? async ({ profile, tcpSlot, zoneId }) =>
					await dependencies.cleanWorkspace!({ profile: profile as string, tcpSlot, zoneId })
			: undefined,
		createManagedVm: dependencies.createManagedVm,
		now,
		tcpPool,
	});

	return {
		leaseManager,
		tcpPool,
		startIdleReaper(intervalMs = 60_000): { stop(): void } {
			const reaper = createIdleReaper({
				getLeases: () => leaseManager.listLeases(),
				now,
				releaseLease: async (leaseId) => await leaseManager.releaseLease(leaseId),
				ttlMs: 30 * 60 * 1000,
			});
			const timer = setInterval(() => void reaper.reapExpiredLeases(), intervalMs);
			return {
				stop(): void {
					clearInterval(timer);
				},
			};
		},
	};
}
```

- [ ] **Step 5: Slim down `controller-runtime.ts`**

After moving files and extracting `lease-service.ts`, the controller-runtime should:

1. Create secret resolver (from `controller-runtime-support.ts`)
2. Load lifecycle (from `gateway-lifecycle-loader.ts`)
3. Create lease service (from `leases/lease-service.ts`)
4. Start gateway zone (from `gateway/gateway-zone-orchestrator.ts`)
5. Create HTTP server with operations (from `http/`)
6. Return close handle

The file should shrink from ~155 lines to ~80-100 lines. The lease wiring (pool, manager, reaper, interval, cleanup) moves entirely into `lease-service.ts`.

Update imports in `controller-runtime.ts`:

```ts
import { loadSystemConfig } from '../config/system-config.js';
import { createControllerService } from '../http/controller-http-routes.js';
import { startControllerHttpServer } from '../http/controller-http-server.js';
import { createLeaseService } from '../leases/lease-service.js';
```

- [ ] **Step 6: Update `index.ts` re-exports**

Update `packages/agent-vm/src/index.ts` to export from the new folder paths. Anything the CLI or external consumers import must still be accessible.

- [ ] **Step 7: Fix all remaining broken imports**

Run: `pnpm typecheck`

This will surface every broken import. Fix them one by one. The common patterns:

- `'./system-config.js'` from controller files → `'../config/system-config.js'`
- `'./lease-manager.js'` from controller files → `'../leases/lease-manager.js'`
- `'./controller-http-routes.js'` from controller files → `'../http/controller-http-routes.js'`

- [ ] **Step 8: Run full suite**

Run: `pnpm check && pnpm test`
Expected: all pass — same behavior, new file locations.

- [ ] **Step 9: Commit**

```bash
git add packages/agent-vm/src/
git commit -m "$(cat <<'EOF'
refactor: split controller/ into domain folders — config, http, leases

config/: system-config (schema + loading)
http/: Hono routes, server, client, request schemas
leases/: lease-manager, tcp-pool, idle-reaper, new lease-service factory
controller/: thin orchestration only — wires services, no domain logic
operations/: unchanged

New lease-service.ts absorbs lease+pool+reaper wiring from controller-runtime.
controller-runtime.ts shrinks to ~80 lines of pure service composition.
EOF
)"
```

---

### Task 10: End-to-End Verification

**Files:**

- Reference: `system.json` (in whatever agent-vm workspace the user has)

- [ ] **Step 1: Run full local verification loop**

Run: `pnpm check`
Expected: lint/typecheck/format pass with zero errors.

- [ ] **Step 2: Run all tests**

Run: `pnpm test`
Expected: all Vitest suites pass.

- [ ] **Step 3: Run integration suite if host permits**

Run: `pnpm test:integration`
Expected: pass or fail only on known host permission constraints.

- [ ] **Step 4: Live-validate the OpenClaw CLI flow against a real VM**

This is non-negotiable. Every command must run against a real Gondolin VM.

```bash
# Build everything first
pnpm build

# Init a fresh project (verify gatewayConfig in output, not openclawConfig)
pnpm --filter agent-vm exec agent-vm init --zone test-e2e --type openclaw
cat system.json | grep gatewayConfig  # must match, not openclawConfig

# Build the gateway image
pnpm --filter agent-vm exec agent-vm build

# Start the controller — watch for progress steps
pnpm --filter agent-vm exec agent-vm controller start

# In another terminal or after backgrounding:
pnpm --filter agent-vm exec agent-vm controller status
pnpm --filter agent-vm exec agent-vm controller logs --zone test-e2e
```

Expected:

- Init emits `gatewayConfig` (not `openclawConfig`)
- Build succeeds
- Controller boots with progress steps: Resolving zone secrets → Building gateway image → Booting gateway VM → Preparing host state (if authProfilesRef set) → Configuring gateway → Starting gateway → Waiting for readiness
- Status returns zone info with ingress
- Logs reads from `processSpec.logPath` (not hardcoded `/tmp/openclaw.log` — verify by checking the code path, not the value, since for OpenClaw they happen to be the same)

- [ ] **Step 5: Verify worker-gateway scope honestly**

```bash
# Verify that coding init works
pnpm --filter agent-vm exec agent-vm init --zone coding-test --type coding

# Verify that coding gateway start fails clearly
# (This should fail with the agent-vm-worker error, not a cryptic crash)
```

Expected: `init --type coding` scaffolds correctly. Starting a coding zone throws: "Coding gateway process start is blocked: 'agent-vm-worker' is not present in this repo yet."

- [ ] **Step 6: Verify no deleted file is referenced at runtime**

```bash
grep -r "gateway-vm-configuration\|gateway-vm-setup\|gateway-openclaw-lifecycle" packages/agent-vm/src/ --include="*.ts" | grep -v node_modules | grep -v dist
```

Expected: zero matches.

- [ ] **Step 7: Verify folder structure is clean**

```bash
# Controller folder should have ~5 files (runtime + types + support + operations + test)
ls packages/agent-vm/src/controller/
# Should NOT contain: system-config, lease-manager, tcp-pool, idle-reaper, http-*

# Each domain folder should exist
ls packages/agent-vm/src/config/
ls packages/agent-vm/src/http/
ls packages/agent-vm/src/leases/
```

Expected: each folder contains only its domain files. Controller folder has no lease, HTTP, or config files.

---

## Summary

The gateway abstraction ships with:

- `gateway-interface` package — types only (GatewayLifecycle, GatewayVmSpec, GatewayProcessSpec, GatewayZoneConfig)
- `openclaw-gateway` package — full OpenClaw lifecycle extraction with tests
- `worker-gateway` package — VM spec functional, process spec throws until agent-vm-worker lands
- Generic orchestrator using lifecycle interface
- Generic health check (2xx required, not just non-000)
- `processSpec` retained in gateway handle for runtime operations
- `openclawConfig` → `gatewayConfig` hard cutover
- Bug fixes: idle reaper races, duplicate type guard, async loadSystemConfig, sync fs removed
- Controller split into domain folders: `config/`, `http/`, `leases/`, `operations/`, `controller/` (thin wiring)
- New `lease-service.ts` absorbs lease+pool+reaper creation from controller-runtime

The real coding process remains blocked on `agent-vm-worker`, which is out of scope for this changeset.
