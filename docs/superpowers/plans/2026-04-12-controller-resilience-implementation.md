# Controller Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ongoing health monitoring with in-place restart, graceful signal handling, and orphan cleanup so the controller detects gateway failures within 15 seconds, recovers automatically, and never leaves orphaned QEMU processes.

**Architecture:** Four components: (1) extract a reusable `checkGatewayHealth` from the existing `waitForHealth`, (2) a `GatewayHealthMonitor` that polls on a timer and triggers restart, (3) a lockfile manager with port-probe orphan cleanup, (4) SIGTERM/SIGINT signal handlers in the CLI entrypoint. All follow the existing factory-with-injected-dependencies pattern used by `createIdleReaper`.

**Tech Stack:** TypeScript, Vitest, `fs/promises`, `node:child_process` (for `lsof`), Zod (lockfile schema), Hono (existing controller HTTP)

**Design spec:** `docs/superpowers/plans/2026-04-12-controller-resilience-design.md`

---

## File Structure

### New files

```
packages/agent-vm/src/controller/
  gateway-health-monitor.ts           ← periodic health check + restart logic
  gateway-health-monitor.test.ts      ← tests for health monitor
  controller-lockfile.ts              ← lockfile write/read/remove + orphan cleanup
  controller-lockfile.test.ts         ← tests for lockfile operations
```

### Modified files

```
packages/agent-vm/src/gateway/
  gateway-zone-orchestrator.ts        ← extract checkGatewayHealth(), refactor waitForHealth
  gateway-zone-orchestrator.test.ts   ← add tests for extracted checkGatewayHealth

packages/agent-vm/src/controller/
  controller-runtime.ts               ← wire health monitor + lockfile
  controller-runtime.test.ts          ← extend tests for health monitor wiring
  controller-runtime-types.ts         ← add health monitor deps + status to ControllerRuntime

packages/agent-vm/src/cli/commands/
  controller-definition.ts            ← add signal handlers to `start` command
```

---

## Task 1: Extract `checkGatewayHealth` from `waitForHealth`

Refactor the existing health check logic so the single-probe function is exported and reusable. `waitForHealth` becomes a thin loop over `checkGatewayHealth`.

**Files:**

- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`
- Modify: `packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`

- [ ] **Step 1: Write a test for the new `checkGatewayHealth` function**

Add a new describe block in the existing test file:

```typescript
describe('checkGatewayHealth', () => {
	it('returns healthy for a 2xx HTTP response', async () => {
		const execMock = vi.fn(async () => ({
			exitCode: 0,
			stdout: '200',
			stderr: '',
		}));
		const managedVm = {
			exec: execMock,
		} satisfies Pick<ManagedVm, 'exec'>;

		const result = await checkGatewayHealth(managedVm, {
			type: 'http',
			port: 18789,
			path: '/',
		});

		expect(result).toEqual({ status: 'healthy' });
	});

	it('returns unhealthy for a non-2xx HTTP response', async () => {
		const execMock = vi.fn(async () => ({
			exitCode: 0,
			stdout: '500',
			stderr: '',
		}));
		const managedVm = {
			exec: execMock,
		} satisfies Pick<ManagedVm, 'exec'>;

		const result = await checkGatewayHealth(managedVm, {
			type: 'http',
			port: 18789,
			path: '/',
		});

		expect(result).toEqual({
			status: 'unhealthy',
			lastObservation: 'http 500',
		});
	});

	it('returns unhealthy when exec throws', async () => {
		const execMock = vi.fn(async () => {
			throw new Error('VM exec pipe broken');
		});
		const managedVm = {
			exec: execMock,
		} satisfies Pick<ManagedVm, 'exec'>;

		const result = await checkGatewayHealth(managedVm, {
			type: 'http',
			port: 18789,
			path: '/',
		});

		expect(result).toEqual({
			status: 'unhealthy',
			lastObservation: 'exec error: VM exec pipe broken',
		});
	});

	it('returns healthy for a command health check with exit code 0', async () => {
		const execMock = vi.fn(async () => ({
			exitCode: 0,
			stdout: '',
			stderr: '',
		}));
		const managedVm = {
			exec: execMock,
		} satisfies Pick<ManagedVm, 'exec'>;

		const result = await checkGatewayHealth(managedVm, {
			type: 'command',
			command: 'check-health',
		});

		expect(result).toEqual({ status: 'healthy' });
	});

	it('returns unhealthy for a command health check with non-zero exit code', async () => {
		const execMock = vi.fn(async () => ({
			exitCode: 1,
			stdout: '',
			stderr: 'process not running',
		}));
		const managedVm = {
			exec: execMock,
		} satisfies Pick<ManagedVm, 'exec'>;

		const result = await checkGatewayHealth(managedVm, {
			type: 'command',
			command: 'check-health',
		});

		expect(result).toEqual({
			status: 'unhealthy',
			lastObservation: 'exit 1',
		});
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
Expected: FAIL -- `checkGatewayHealth` is not exported from the module.

- [ ] **Step 3: Implement `checkGatewayHealth` and refactor `waitForHealth`**

In `packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`, add the new type and function, then refactor `waitForHealth` to use it:

```typescript
import type { GatewayHealthCheck, GatewayLifecycle, GatewayZoneConfig } from 'gateway-interface';
import { createManagedVm as createManagedVmFromCore, type ManagedVm } from 'gondolin-core';

// -- add this import at the top (already there) --
import type { ExecResult } from 'gondolin-core';

export type GatewayHealthCheckResult =
	| { readonly status: 'healthy' }
	| { readonly status: 'unhealthy'; readonly lastObservation: string };

/**
 * Single-probe health check. Runs one health check command inside the VM.
 * Returns healthy/unhealthy with the observation string.
 * Does not retry or restart -- that's the monitor's job.
 */
export async function checkGatewayHealth(
	vm: Pick<ManagedVm, 'exec'>,
	healthCheck: GatewayHealthCheck,
): Promise<GatewayHealthCheckResult> {
	let result: ExecResult;
	try {
		const healthCommand =
			healthCheck.type === 'http'
				? `curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:${healthCheck.port}${healthCheck.path} 2>/dev/null || echo 000`
				: healthCheck.command;
		result = await vm.exec(healthCommand);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { status: 'unhealthy', lastObservation: `exec error: ${message}` };
	}

	if (healthCheck.type === 'http') {
		const httpStatus = result.stdout.trim();
		if (httpStatus.startsWith('2')) {
			return { status: 'healthy' };
		}
		return { status: 'unhealthy', lastObservation: `http ${httpStatus || '(empty)'}` };
	}

	if (result.exitCode === 0) {
		return { status: 'healthy' };
	}
	return { status: 'unhealthy', lastObservation: `exit ${result.exitCode}` };
}

async function waitForHealth(
	managedVm: ManagedVm,
	healthCheck: GatewayHealthCheck,
	attempt: number = 0,
	maxAttempts: number = 30,
): Promise<void> {
	if (attempt >= maxAttempts) {
		throw new Error(`Gateway readiness check failed after ${maxAttempts} attempts.`);
	}

	const checkResult = await checkGatewayHealth(managedVm, healthCheck);
	if (checkResult.status === 'healthy') {
		return;
	}

	await new Promise((resolve) => setTimeout(resolve, 500));
	await waitForHealth(managedVm, healthCheck, attempt + 1, maxAttempts);
}
```

The rest of `startGatewayZone` remains unchanged -- it already calls `waitForHealth`.

- [ ] **Step 4: Run all tests in the file to verify they pass**

Run: `pnpm vitest run packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts`
Expected: All existing tests pass (the refactored `waitForHealth` behaves identically). New `checkGatewayHealth` tests pass.

- [ ] **Step 5: Run basedpyright and linter**

Run: `pnpm oxlint packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts
git commit -m "refactor: extract checkGatewayHealth from waitForHealth for reuse by health monitor"
```

---

## Task 2: Create `GatewayHealthMonitor`

A periodic health poller that detects failures and triggers in-place restart with exponential backoff. Follows the `createIdleReaper` pattern: a factory function with injected dependencies, returns an object with methods.

**Files:**

- Create: `packages/agent-vm/src/controller/gateway-health-monitor.ts`
- Create: `packages/agent-vm/src/controller/gateway-health-monitor.test.ts`

- [ ] **Step 1: Write failing tests for the health monitor**

Create `packages/agent-vm/src/controller/gateway-health-monitor.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayHealthMonitor,
	type GatewayHealthMonitorOptions,
	type GatewayHealthStatus,
} from './gateway-health-monitor.js';

function createTestOptions(
	overrides: Partial<GatewayHealthMonitorOptions> = {},
): GatewayHealthMonitorOptions {
	return {
		checkHealth: vi.fn(async (): Promise<GatewayHealthStatus> => ({ status: 'healthy' })),
		restartGatewayProcess: vi.fn(async () => {}),
		waitForHealthAfterRestart: vi.fn(async () => {}),
		intervalMs: 10_000,
		maxConsecutiveFailures: 5,
		...overrides,
	};
}

describe('createGatewayHealthMonitor', () => {
	it('starts with healthy status', () => {
		const monitor = createGatewayHealthMonitor(createTestOptions());
		expect(monitor.getStatus()).toEqual({ status: 'healthy' });
		monitor.stop();
	});

	it('returns healthy after a successful check', async () => {
		const options = createTestOptions();
		const monitor = createGatewayHealthMonitor(options);

		const result = await monitor.runHealthCheck();

		expect(result).toEqual({ status: 'healthy' });
		expect(options.checkHealth).toHaveBeenCalledTimes(1);
		expect(options.restartGatewayProcess).not.toHaveBeenCalled();
		monitor.stop();
	});

	it('attempts restart when health check returns unhealthy', async () => {
		const checkHealth = vi
			.fn<() => Promise<GatewayHealthStatus>>()
			.mockResolvedValueOnce({ status: 'unhealthy', lastObservation: 'http 500' })
			.mockResolvedValueOnce({ status: 'healthy' });
		const restartGatewayProcess = vi.fn(async () => {});
		const waitForHealthAfterRestart = vi.fn(async () => {});
		const onHealthChange = vi.fn();

		const monitor = createGatewayHealthMonitor(
			createTestOptions({
				checkHealth,
				onHealthChange,
				restartGatewayProcess,
				waitForHealthAfterRestart,
			}),
		);

		await monitor.runHealthCheck();

		expect(restartGatewayProcess).toHaveBeenCalledTimes(1);
		expect(waitForHealthAfterRestart).toHaveBeenCalledTimes(1);
		expect(monitor.getStatus()).toEqual({ status: 'healthy' });
		monitor.stop();
	});

	it('increments consecutive failures when restart fails', async () => {
		const checkHealth = vi
			.fn<() => Promise<GatewayHealthStatus>>()
			.mockResolvedValue({ status: 'unhealthy', lastObservation: 'http 000' });
		const restartGatewayProcess = vi.fn(async () => {});
		const waitForHealthAfterRestart = vi.fn(async () => {
			throw new Error('still unhealthy after restart');
		});

		const monitor = createGatewayHealthMonitor(
			createTestOptions({
				checkHealth,
				maxConsecutiveFailures: 3,
				restartGatewayProcess,
				waitForHealthAfterRestart,
			}),
		);

		await monitor.runHealthCheck();
		expect(monitor.getStatus()).toEqual({
			status: 'unhealthy',
			lastObservation: 'restart failed: still unhealthy after restart',
		});

		await monitor.runHealthCheck();
		await monitor.runHealthCheck();

		expect(monitor.getStatus()).toEqual({
			status: 'failed',
			consecutiveFailures: 3,
		});
		expect(restartGatewayProcess).toHaveBeenCalledTimes(3);
		monitor.stop();
	});

	it('resets consecutive failures on successful health check', async () => {
		const checkHealth = vi
			.fn<() => Promise<GatewayHealthStatus>>()
			.mockResolvedValueOnce({ status: 'unhealthy', lastObservation: 'http 500' })
			.mockResolvedValueOnce({ status: 'healthy' });
		const restartGatewayProcess = vi.fn(async () => {});
		const waitForHealthAfterRestart = vi.fn(async () => {
			throw new Error('restart failed');
		});

		const monitor = createGatewayHealthMonitor(
			createTestOptions({
				checkHealth,
				restartGatewayProcess,
				waitForHealthAfterRestart,
			}),
		);

		await monitor.runHealthCheck();
		expect(monitor.getStatus().status).toBe('unhealthy');

		await monitor.runHealthCheck();
		expect(monitor.getStatus()).toEqual({ status: 'healthy' });
		monitor.stop();
	});

	it('does not attempt restart when in failed state', async () => {
		const checkHealth = vi
			.fn<() => Promise<GatewayHealthStatus>>()
			.mockResolvedValue({ status: 'unhealthy', lastObservation: 'http 000' });
		const restartGatewayProcess = vi.fn(async () => {});
		const waitForHealthAfterRestart = vi.fn(async () => {
			throw new Error('still broken');
		});

		const monitor = createGatewayHealthMonitor(
			createTestOptions({
				checkHealth,
				maxConsecutiveFailures: 2,
				restartGatewayProcess,
				waitForHealthAfterRestart,
			}),
		);

		await monitor.runHealthCheck();
		await monitor.runHealthCheck();
		expect(monitor.getStatus().status).toBe('failed');

		await monitor.runHealthCheck();
		expect(restartGatewayProcess).toHaveBeenCalledTimes(2);
		monitor.stop();
	});

	it('stop prevents further checks from having effect', () => {
		const monitor = createGatewayHealthMonitor(createTestOptions());
		monitor.stop();
		expect(monitor.getStatus()).toEqual({ status: 'healthy' });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/agent-vm/src/controller/gateway-health-monitor.test.ts`
Expected: FAIL -- module not found.

- [ ] **Step 3: Implement the gateway health monitor**

Create `packages/agent-vm/src/controller/gateway-health-monitor.ts`:

```typescript
export type GatewayHealthStatus =
	| { readonly status: 'healthy' }
	| { readonly status: 'unhealthy'; readonly lastObservation: string }
	| { readonly status: 'failed'; readonly consecutiveFailures: number };

export interface GatewayHealthMonitorOptions {
	readonly checkHealth: () => Promise<GatewayHealthStatus>;
	readonly restartGatewayProcess: () => Promise<void>;
	readonly waitForHealthAfterRestart: () => Promise<void>;
	readonly onHealthChange?: (status: GatewayHealthStatus) => void;
	readonly intervalMs?: number;
	readonly maxConsecutiveFailures?: number;
}

export interface GatewayHealthMonitor {
	readonly getStatus: () => GatewayHealthStatus;
	readonly runHealthCheck: () => Promise<GatewayHealthStatus>;
	stop(): void;
}

export function createGatewayHealthMonitor(
	options: GatewayHealthMonitorOptions,
): GatewayHealthMonitor {
	const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 5;
	let currentStatus: GatewayHealthStatus = { status: 'healthy' };
	let consecutiveFailureCount = 0;
	let stopped = false;

	function setStatus(nextStatus: GatewayHealthStatus): void {
		const previousStatusType = currentStatus.status;
		currentStatus = nextStatus;
		if (previousStatusType !== nextStatus.status) {
			options.onHealthChange?.(nextStatus);
		}
	}

	async function runHealthCheck(): Promise<GatewayHealthStatus> {
		if (stopped) {
			return currentStatus;
		}

		if (currentStatus.status === 'failed') {
			return currentStatus;
		}

		const checkResult = await options.checkHealth();

		if (checkResult.status === 'healthy') {
			consecutiveFailureCount = 0;
			setStatus({ status: 'healthy' });
			return currentStatus;
		}

		try {
			await options.restartGatewayProcess();
			await options.waitForHealthAfterRestart();
			consecutiveFailureCount = 0;
			setStatus({ status: 'healthy' });
		} catch (error) {
			consecutiveFailureCount += 1;
			const message = error instanceof Error ? error.message : String(error);

			if (consecutiveFailureCount >= maxConsecutiveFailures) {
				setStatus({
					status: 'failed',
					consecutiveFailures: consecutiveFailureCount,
				});
			} else {
				setStatus({
					status: 'unhealthy',
					lastObservation: `restart failed: ${message}`,
				});
			}
		}

		return currentStatus;
	}

	return {
		getStatus: (): GatewayHealthStatus => currentStatus,
		runHealthCheck,
		stop(): void {
			stopped = true;
		},
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/agent-vm/src/controller/gateway-health-monitor.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run linter**

Run: `pnpm oxlint packages/agent-vm/src/controller/gateway-health-monitor.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/gateway-health-monitor.ts packages/agent-vm/src/controller/gateway-health-monitor.test.ts
git commit -m "feat: add gateway health monitor with periodic polling and in-place restart"
```

---

## Task 3: Create Controller Lockfile Manager

Handles lockfile write/read/remove and port-based orphan cleanup on startup.

**Files:**

- Create: `packages/agent-vm/src/controller/controller-lockfile.ts`
- Create: `packages/agent-vm/src/controller/controller-lockfile.test.ts`

- [ ] **Step 1: Write failing tests for lockfile operations**

Create `packages/agent-vm/src/controller/controller-lockfile.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
	readControllerLockfile,
	removeControllerLockfile,
	writeControllerLockfile,
	type ControllerLockfileData,
} from './controller-lockfile.js';

describe('writeControllerLockfile', () => {
	it('writes lockfile data as JSON', async () => {
		const lockfilePath = path.join(os.tmpdir(), `test-lockfile-${Date.now()}.lock`);
		const lockfileData: ControllerLockfileData = {
			pid: 12345,
			startedAt: '2026-04-12T10:00:00.000Z',
			controllerPort: 18800,
			ingressPort: 18791,
		};

		await writeControllerLockfile(lockfilePath, lockfileData);

		const contents = await fs.readFile(lockfilePath, 'utf8');
		expect(JSON.parse(contents)).toEqual(lockfileData);
		await fs.unlink(lockfilePath);
	});

	it('creates parent directories if they do not exist', async () => {
		const lockfilePath = path.join(
			os.tmpdir(),
			`test-nested-${Date.now()}`,
			'deep',
			'controller.lock',
		);
		const lockfileData: ControllerLockfileData = {
			pid: 12345,
			startedAt: '2026-04-12T10:00:00.000Z',
			controllerPort: 18800,
			ingressPort: 18791,
		};

		await writeControllerLockfile(lockfilePath, lockfileData);

		const contents = await fs.readFile(lockfilePath, 'utf8');
		expect(JSON.parse(contents)).toEqual(lockfileData);
		await fs.rm(path.dirname(path.dirname(lockfilePath)), { recursive: true });
	});
});

describe('readControllerLockfile', () => {
	it('returns parsed data when lockfile exists', async () => {
		const lockfilePath = path.join(os.tmpdir(), `test-lockfile-read-${Date.now()}.lock`);
		const lockfileData: ControllerLockfileData = {
			pid: 99999,
			startedAt: '2026-04-12T10:00:00.000Z',
			controllerPort: 18800,
			ingressPort: 18791,
		};
		await fs.writeFile(lockfilePath, JSON.stringify(lockfileData), 'utf8');

		const result = await readControllerLockfile(lockfilePath);

		expect(result).toEqual(lockfileData);
		await fs.unlink(lockfilePath);
	});

	it('returns undefined when lockfile does not exist', async () => {
		const result = await readControllerLockfile('/tmp/nonexistent-lockfile.lock');
		expect(result).toBeUndefined();
	});

	it('returns undefined when lockfile contains invalid JSON', async () => {
		const lockfilePath = path.join(os.tmpdir(), `test-lockfile-bad-${Date.now()}.lock`);
		await fs.writeFile(lockfilePath, 'not json', 'utf8');

		const result = await readControllerLockfile(lockfilePath);

		expect(result).toBeUndefined();
		await fs.unlink(lockfilePath);
	});
});

describe('removeControllerLockfile', () => {
	it('removes the lockfile', async () => {
		const lockfilePath = path.join(os.tmpdir(), `test-lockfile-rm-${Date.now()}.lock`);
		await fs.writeFile(lockfilePath, '{}', 'utf8');

		await removeControllerLockfile(lockfilePath);

		await expect(fs.access(lockfilePath)).rejects.toThrow();
	});

	it('does not throw when lockfile does not exist', async () => {
		await expect(removeControllerLockfile('/tmp/already-gone.lock')).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-lockfile.test.ts`
Expected: FAIL -- module not found.

- [ ] **Step 3: Implement the lockfile manager**

Create `packages/agent-vm/src/controller/controller-lockfile.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

const controllerLockfileSchema = z.object({
	pid: z.number().int().positive(),
	startedAt: z.string().min(1),
	controllerPort: z.number().int().positive(),
	ingressPort: z.number().int().positive(),
});

export type ControllerLockfileData = z.infer<typeof controllerLockfileSchema>;

export async function writeControllerLockfile(
	lockfilePath: string,
	data: ControllerLockfileData,
): Promise<void> {
	await fs.mkdir(path.dirname(lockfilePath), { recursive: true });
	await fs.writeFile(lockfilePath, JSON.stringify(data, null, '\t'), 'utf8');
}

export async function readControllerLockfile(
	lockfilePath: string,
): Promise<ControllerLockfileData | undefined> {
	let contents: string;
	try {
		contents = await fs.readFile(lockfilePath, 'utf8');
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}

	try {
		const parsed: unknown = JSON.parse(contents);
		return controllerLockfileSchema.parse(parsed);
	} catch {
		return undefined;
	}
}

export async function removeControllerLockfile(lockfilePath: string): Promise<void> {
	try {
		await fs.unlink(lockfilePath);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-lockfile.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run linter**

Run: `pnpm oxlint packages/agent-vm/src/controller/controller-lockfile.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/controller-lockfile.ts packages/agent-vm/src/controller/controller-lockfile.test.ts
git commit -m "feat: add controller lockfile manager for orphan detection"
```

---

## Task 4: Add orphan cleanup function to lockfile module

This adds the `cleanupOrphanedProcesses` function that probes ports and kills stale processes on startup.

**Files:**

- Modify: `packages/agent-vm/src/controller/controller-lockfile.ts`
- Modify: `packages/agent-vm/src/controller/controller-lockfile.test.ts`

- [ ] **Step 1: Write failing tests for orphan cleanup**

Add to `packages/agent-vm/src/controller/controller-lockfile.test.ts`:

```typescript
import {
	cleanupOrphanedProcesses,
	readControllerLockfile,
	removeControllerLockfile,
	writeControllerLockfile,
	type ControllerLockfileData,
	type OrphanCleanupDependencies,
} from './controller-lockfile.js';

describe('cleanupOrphanedProcesses', () => {
	it('removes stale lockfile and probes ports when old controller is not reachable', async () => {
		const lockfilePath = path.join(os.tmpdir(), `test-orphan-${Date.now()}.lock`);
		await writeControllerLockfile(lockfilePath, {
			pid: 99999,
			startedAt: '2026-04-12T10:00:00.000Z',
			controllerPort: 18800,
			ingressPort: 18791,
		});

		const dependencies: OrphanCleanupDependencies = {
			tryStopOldController: vi.fn(async () => false),
			findProcessOnPort: vi.fn(async () => undefined),
			killProcess: vi.fn(async () => {}),
		};

		await cleanupOrphanedProcesses(
			{
				lockfilePath,
				controllerPort: 18800,
				ingressPort: 18791,
			},
			dependencies,
		);

		expect(await readControllerLockfile(lockfilePath)).toBeUndefined();
		expect(dependencies.findProcessOnPort).toHaveBeenCalledWith(18791);
		expect(dependencies.findProcessOnPort).toHaveBeenCalledWith(18800);
		expect(dependencies.killProcess).not.toHaveBeenCalled();
	});

	it('kills process on ingress port when old controller cannot be stopped', async () => {
		const lockfilePath = path.join(os.tmpdir(), `test-orphan-kill-${Date.now()}.lock`);
		await writeControllerLockfile(lockfilePath, {
			pid: 99999,
			startedAt: '2026-04-12T10:00:00.000Z',
			controllerPort: 18800,
			ingressPort: 18791,
		});

		const dependencies: OrphanCleanupDependencies = {
			tryStopOldController: vi.fn(async () => false),
			findProcessOnPort: vi.fn(async (port: number) => {
				if (port === 18791) return 55555;
				return undefined;
			}),
			killProcess: vi.fn(async () => {}),
		};

		await cleanupOrphanedProcesses(
			{
				lockfilePath,
				controllerPort: 18800,
				ingressPort: 18791,
			},
			dependencies,
		);

		expect(dependencies.killProcess).toHaveBeenCalledWith(55555);
		expect(await readControllerLockfile(lockfilePath)).toBeUndefined();
	});

	it('skips cleanup when no lockfile exists', async () => {
		const dependencies: OrphanCleanupDependencies = {
			tryStopOldController: vi.fn(async () => false),
			findProcessOnPort: vi.fn(async () => undefined),
			killProcess: vi.fn(async () => {}),
		};

		await cleanupOrphanedProcesses(
			{
				lockfilePath: '/tmp/nonexistent-lockfile.lock',
				controllerPort: 18800,
				ingressPort: 18791,
			},
			dependencies,
		);

		expect(dependencies.tryStopOldController).not.toHaveBeenCalled();
		expect(dependencies.findProcessOnPort).not.toHaveBeenCalled();
	});

	it('does not kill processes when old controller stops cleanly', async () => {
		const lockfilePath = path.join(os.tmpdir(), `test-orphan-clean-${Date.now()}.lock`);
		await writeControllerLockfile(lockfilePath, {
			pid: 99999,
			startedAt: '2026-04-12T10:00:00.000Z',
			controllerPort: 18800,
			ingressPort: 18791,
		});

		const dependencies: OrphanCleanupDependencies = {
			tryStopOldController: vi.fn(async () => true),
			findProcessOnPort: vi.fn(async () => undefined),
			killProcess: vi.fn(async () => {}),
		};

		await cleanupOrphanedProcesses(
			{
				lockfilePath,
				controllerPort: 18800,
				ingressPort: 18791,
			},
			dependencies,
		);

		expect(dependencies.findProcessOnPort).not.toHaveBeenCalled();
		expect(dependencies.killProcess).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-lockfile.test.ts`
Expected: FAIL -- `cleanupOrphanedProcesses` and `OrphanCleanupDependencies` not exported.

- [ ] **Step 3: Implement `cleanupOrphanedProcesses`**

Add to `packages/agent-vm/src/controller/controller-lockfile.ts`:

```typescript
export interface OrphanCleanupDependencies {
	readonly tryStopOldController: (controllerPort: number) => Promise<boolean>;
	readonly findProcessOnPort: (port: number) => Promise<number | undefined>;
	readonly killProcess: (pid: number) => Promise<void>;
}

export interface CleanupOrphanedProcessesOptions {
	readonly lockfilePath: string;
	readonly controllerPort: number;
	readonly ingressPort: number;
}

export async function cleanupOrphanedProcesses(
	options: CleanupOrphanedProcessesOptions,
	dependencies: OrphanCleanupDependencies,
): Promise<void> {
	const lockfileData = await readControllerLockfile(options.lockfilePath);
	if (!lockfileData) {
		return;
	}

	const stoppedCleanly = await dependencies.tryStopOldController(lockfileData.controllerPort);
	if (!stoppedCleanly) {
		for (const port of [options.ingressPort, options.controllerPort]) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- sequential port cleanup avoids races
			const pid = await dependencies.findProcessOnPort(port);
			if (pid !== undefined) {
				// oxlint-disable-next-line eslint/no-await-in-loop -- sequential port cleanup avoids races
				await dependencies.killProcess(pid);
			}
		}
	}

	await removeControllerLockfile(options.lockfilePath);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-lockfile.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run linter**

Run: `pnpm oxlint packages/agent-vm/src/controller/controller-lockfile.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/controller-lockfile.ts packages/agent-vm/src/controller/controller-lockfile.test.ts
git commit -m "feat: add orphan cleanup with port probing and dependency injection"
```

---

## Task 5: Add default orphan cleanup dependencies (platform integration)

Add the real implementations of `tryStopOldController`, `findProcessOnPort`, and `killProcess` that use `fetch` and `lsof`.

**Files:**

- Modify: `packages/agent-vm/src/controller/controller-lockfile.ts`
- Modify: `packages/agent-vm/src/controller/controller-lockfile.test.ts`

- [ ] **Step 1: Write a test for the default `findProcessOnPort` implementation**

Add to `packages/agent-vm/src/controller/controller-lockfile.test.ts`:

```typescript
import { createDefaultOrphanCleanupDependencies } from './controller-lockfile.js';

describe('createDefaultOrphanCleanupDependencies', () => {
	it('tryStopOldController returns false when fetch fails', async () => {
		const dependencies = createDefaultOrphanCleanupDependencies();
		const result = await dependencies.tryStopOldController(59999);
		expect(result).toBe(false);
	});

	it('findProcessOnPort returns undefined for a port with no listener', async () => {
		const dependencies = createDefaultOrphanCleanupDependencies();
		const result = await dependencies.findProcessOnPort(59999);
		expect(result).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-lockfile.test.ts`
Expected: FAIL -- `createDefaultOrphanCleanupDependencies` not exported.

- [ ] **Step 3: Implement the default dependencies**

Add to `packages/agent-vm/src/controller/controller-lockfile.ts`:

```typescript
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCallback);

export function createDefaultOrphanCleanupDependencies(): OrphanCleanupDependencies {
	return {
		async tryStopOldController(controllerPort: number): Promise<boolean> {
			try {
				const response = await fetch(`http://127.0.0.1:${controllerPort}/stop`, {
					method: 'POST',
					signal: AbortSignal.timeout(5_000),
				});
				return response.ok;
			} catch {
				return false;
			}
		},

		async findProcessOnPort(port: number): Promise<number | undefined> {
			try {
				const { stdout } = await execAsync(`lsof -ti :${port}`);
				const pidString = stdout.trim().split('\n')[0];
				if (!pidString) {
					return undefined;
				}
				const pid = Number.parseInt(pidString, 10);
				return Number.isNaN(pid) ? undefined : pid;
			} catch {
				return undefined;
			}
		},

		async killProcess(pid: number): Promise<void> {
			try {
				process.kill(pid, 'SIGTERM');
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				try {
					process.kill(pid, 0);
					process.kill(pid, 'SIGKILL');
				} catch {
					// Process already exited after SIGTERM
				}
			} catch {
				// Process doesn't exist
			}
		},
	};
}
```

Note: `import { exec as execCallback }` and `import { promisify }` go at the top of the file with the other imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-lockfile.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run linter**

Run: `pnpm oxlint packages/agent-vm/src/controller/controller-lockfile.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/controller-lockfile.ts packages/agent-vm/src/controller/controller-lockfile.test.ts
git commit -m "feat: add default orphan cleanup implementations using lsof and fetch"
```

---

## Task 6: Wire health monitor into `controller-runtime.ts`

Connect the health monitor to the controller runtime using the same pattern as the idle reaper: create the monitor, start a timer, clear it on shutdown.

**Files:**

- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`

- [ ] **Step 1: Update `ControllerRuntimeDependencies` and `ControllerRuntime` types**

In `packages/agent-vm/src/controller/controller-runtime-types.ts`, add the health monitor dependency slots and health status to the runtime return type:

```typescript
import type { GatewayProcessSpec } from 'gateway-interface';
import type { ManagedVm, SecretResolver } from 'gondolin-core';

import type { SystemConfig } from '../config/system-config.js';
import type { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';
import type { RunTaskFn } from '../shared/run-task.js';
import type { createControllerService } from './http/controller-http-routes.js';
import type { GatewayHealthStatus } from './gateway-health-monitor.js';
import type { ToolProfile } from './leases/lease-manager.js';

export interface ControllerRuntime {
	readonly controllerPort: number;
	readonly gateway: {
		readonly ingress: {
			readonly host: string;
			readonly port: number;
		};
		readonly processSpec: GatewayProcessSpec;
		readonly vm: Pick<ManagedVm, 'close' | 'id'>;
	};
	readonly getHealthStatus: () => GatewayHealthStatus;
	close(): Promise<void>;
}

export interface ControllerRuntimeDependencies {
	readonly clearIntervalImpl?: (timer: NodeJS.Timeout) => void;
	readonly createManagedToolVm?: (options: {
		readonly profile: ToolProfile;
		readonly tcpSlot: number;
		readonly workspaceDir: string;
		readonly zoneId: string;
	}) => Promise<ManagedVm>;
	readonly createSecretResolver?: (options: {
		readonly serviceAccountToken: string;
	}) => Promise<SecretResolver>;
	readonly healthCheckIntervalMs?: number;
	readonly now?: () => number;
	readonly runTask?: RunTaskFn;
	readonly setIntervalImpl?: (
		callback: () => void | Promise<void>,
		delayMs: number,
	) => NodeJS.Timeout;
	readonly startGatewayZone?: typeof startGatewayZone;
	readonly startHttpServer?: (options: {
		readonly app: ReturnType<typeof createControllerService>;
		readonly port: number;
	}) => Promise<{
		close(): Promise<void>;
	}>;
}

export interface StartControllerRuntimeOptions {
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
}
```

- [ ] **Step 2: Wire the health monitor in `controller-runtime.ts`**

In `packages/agent-vm/src/controller/controller-runtime.ts`, add after the gateway is started and before the HTTP server:

Add import at top:

```typescript
import { checkGatewayHealth } from '../gateway/gateway-zone-orchestrator.js';
import { createGatewayHealthMonitor, type GatewayHealthStatus } from './gateway-health-monitor.js';
```

After the `await runTaskStep('Starting gateway zone', ...)` block (~line 113), add the health monitor wiring:

```typescript
const healthMonitor = createGatewayHealthMonitor({
	checkHealth: async (): Promise<GatewayHealthStatus> => {
		const gatewayRef = gateway;
		if (!gatewayRef) {
			return { status: 'unhealthy', lastObservation: 'gateway not available' };
		}
		const result = await checkGatewayHealth(gatewayRef.vm, gatewayRef.processSpec.healthCheck);
		return result;
	},
	restartGatewayProcess: async () => {
		const gatewayRef = requireGateway();
		await gatewayRef.vm.exec(gatewayRef.processSpec.startCommand);
	},
	waitForHealthAfterRestart: async () => {
		const gatewayRef = requireGateway();
		const checkResult = await checkGatewayHealth(gatewayRef.vm, gatewayRef.processSpec.healthCheck);
		if (checkResult.status !== 'healthy') {
			throw new Error(
				`Gateway not healthy after restart: ${'lastObservation' in checkResult ? checkResult.lastObservation : checkResult.status}`,
			);
		}
	},
	intervalMs: dependencies.healthCheckIntervalMs ?? 10_000,
});
const healthMonitorTimer = (dependencies.setIntervalImpl ?? setInterval)(
	() => void healthMonitor.runHealthCheck(),
	dependencies.healthCheckIntervalMs ?? 10_000,
);
const clearHealthMonitorTimer = (): void =>
	(dependencies.clearIntervalImpl ?? clearInterval)(healthMonitorTimer);
```

Update the `close()` method in the return object to clear the health monitor timer:

```typescript
return {
	async close(): Promise<void> {
		clearReaperTimer();
		healthMonitor.stop();
		clearHealthMonitorTimer();
		await releaseAllLeases();
		await requireGateway().vm.close();
		await serverRef.current?.close();
	},
	controllerPort: options.systemConfig.host.controllerPort,
	gateway: {
		ingress: requireGateway().ingress,
		processSpec: requireGateway().processSpec,
		vm: requireGateway().vm,
	},
	getHealthStatus: () => healthMonitor.getStatus(),
};
```

- [ ] **Step 3: Update the controller-runtime test to verify health monitor wiring**

Add a new test to `packages/agent-vm/src/controller/controller-runtime.test.ts`:

```typescript
it('creates a health monitor timer and clears it on close', async () => {
	process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
	const zone = systemConfig.zones[0];
	if (!zone) {
		throw new Error('Expected test zone.');
	}
	const clearIntervalMock = vi.fn();
	const setIntervalMock = vi.fn(() => 456 as unknown as NodeJS.Timeout);

	const runtime = await startControllerRuntime(
		{
			systemConfig,
			zoneId: 'shravan',
		},
		{
			clearIntervalImpl: clearIntervalMock,
			createSecretResolver: async () => ({
				resolve: async () => '',
				resolveAll: async () => ({}),
			}),
			setIntervalImpl: setIntervalMock,
			startGatewayZone: vi.fn(async () => ({
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imagePath: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
				vm: {
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'gateway-vm-health',
					setIngressRoutes: vi.fn(),
					getVmInstance: vi.fn(),
				},
				zone,
			})),
			startHttpServer: vi.fn(async () => ({
				close: async () => {},
			})),
		},
	);

	// setInterval called twice: once for idle reaper, once for health monitor
	expect(setIntervalMock).toHaveBeenCalledTimes(2);

	expect(runtime.getHealthStatus()).toEqual({ status: 'healthy' });

	await runtime.close();

	// clearInterval called twice: once for idle reaper, once for health monitor
	expect(clearIntervalMock).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 4: Run all controller-runtime tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-runtime.test.ts`
Expected: All tests pass. Existing tests still pass (they already provide `setIntervalImpl` and `clearIntervalImpl` mocks that accept multiple calls).

- [ ] **Step 5: Run linter on modified files**

Run: `pnpm oxlint packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime-types.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime-types.ts packages/agent-vm/src/controller/controller-runtime.test.ts
git commit -m "feat: wire gateway health monitor into controller runtime with timer lifecycle"
```

---

## Task 7: Wire lockfile into controller runtime

Write the lockfile at startup, clean up orphans before starting, remove lockfile on shutdown.

**Files:**

- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime-types.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.test.ts`

- [ ] **Step 1: Add lockfile path to `StartControllerRuntimeOptions`**

In `packages/agent-vm/src/controller/controller-runtime-types.ts`, add lockfile options:

```typescript
export interface StartControllerRuntimeOptions {
	readonly lockfilePath?: string;
	readonly systemConfig: SystemConfig;
	readonly zoneId: string;
}
```

Add lockfile dependency overrides to `ControllerRuntimeDependencies`:

```typescript
export interface ControllerRuntimeDependencies {
	// ... existing fields ...
	readonly lockfileDependencies?: {
		readonly cleanupOrphanedProcesses?: (
			options: import('./controller-lockfile.js').CleanupOrphanedProcessesOptions,
			dependencies: import('./controller-lockfile.js').OrphanCleanupDependencies,
		) => Promise<void>;
		readonly orphanCleanupDependencies?: import('./controller-lockfile.js').OrphanCleanupDependencies;
		readonly writeLockfile?: (
			path: string,
			data: import('./controller-lockfile.js').ControllerLockfileData,
		) => Promise<void>;
		readonly removeLockfile?: (path: string) => Promise<void>;
	};
}
```

- [ ] **Step 2: Wire lockfile in `controller-runtime.ts`**

Add import at top of `packages/agent-vm/src/controller/controller-runtime.ts`:

```typescript
import path from 'node:path';

import {
	cleanupOrphanedProcesses as cleanupOrphanedProcessesImpl,
	createDefaultOrphanCleanupDependencies,
	removeControllerLockfile,
	writeControllerLockfile,
} from './controller-lockfile.js';
```

At the beginning of `startControllerRuntime`, before secret resolution, add orphan cleanup:

```typescript
const lockfilePath =
	options.lockfilePath ?? path.join(options.systemConfig.cacheDir, 'controller.lock');
const ingressPort = options.systemConfig.zones.find((zone) => zone.id === options.zoneId)?.gateway
	.port;
if (ingressPort !== undefined) {
	const cleanupFn =
		dependencies.lockfileDependencies?.cleanupOrphanedProcesses ?? cleanupOrphanedProcessesImpl;
	const orphanDeps =
		dependencies.lockfileDependencies?.orphanCleanupDependencies ??
		createDefaultOrphanCleanupDependencies();
	await cleanupFn(
		{
			lockfilePath,
			controllerPort: options.systemConfig.host.controllerPort,
			ingressPort,
		},
		orphanDeps,
	);
}
```

After the HTTP server starts, write the lockfile:

```typescript
const writeLockfileFn = dependencies.lockfileDependencies?.writeLockfile ?? writeControllerLockfile;
await writeLockfileFn(lockfilePath, {
	pid: process.pid,
	startedAt: new Date().toISOString(),
	controllerPort: options.systemConfig.host.controllerPort,
	ingressPort: ingressPort ?? 0,
});
```

In the `close()` method, remove the lockfile:

```typescript
const removeLockfileFn =
	dependencies.lockfileDependencies?.removeLockfile ?? removeControllerLockfile;

return {
	async close(): Promise<void> {
		clearReaperTimer();
		healthMonitor.stop();
		clearHealthMonitorTimer();
		await releaseAllLeases();
		await requireGateway().vm.close();
		await serverRef.current?.close();
		await removeLockfileFn(lockfilePath);
	},
	// ...
};
```

- [ ] **Step 3: Add test for lockfile lifecycle**

Add to `packages/agent-vm/src/controller/controller-runtime.test.ts`:

```typescript
it('cleans up orphans on startup and writes lockfile', async () => {
	process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
	const zone = systemConfig.zones[0];
	if (!zone) {
		throw new Error('Expected test zone.');
	}
	const cleanupMock = vi.fn(async () => {});
	const writeLockfileMock = vi.fn(async () => {});
	const removeLockfileMock = vi.fn(async () => {});

	const runtime = await startControllerRuntime(
		{
			lockfilePath: '/tmp/test-controller.lock',
			systemConfig,
			zoneId: 'shravan',
		},
		{
			createSecretResolver: async () => ({
				resolve: async () => '',
				resolveAll: async () => ({}),
			}),
			lockfileDependencies: {
				cleanupOrphanedProcesses: cleanupMock,
				orphanCleanupDependencies: {
					tryStopOldController: vi.fn(async () => false),
					findProcessOnPort: vi.fn(async () => undefined),
					killProcess: vi.fn(async () => {}),
				},
				writeLockfile: writeLockfileMock,
				removeLockfile: removeLockfileMock,
			},
			startGatewayZone: vi.fn(async () => ({
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imagePath: '/tmp/gateway-image',
				},
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: openClawProcessSpec,
				vm: {
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						host: '127.0.0.1',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'gateway-vm-lockfile',
					setIngressRoutes: vi.fn(),
					getVmInstance: vi.fn(),
				},
				zone,
			})),
			startHttpServer: vi.fn(async () => ({
				close: async () => {},
			})),
		},
	);

	expect(cleanupMock).toHaveBeenCalledTimes(1);
	expect(cleanupMock).toHaveBeenCalledWith(
		expect.objectContaining({
			lockfilePath: '/tmp/test-controller.lock',
			controllerPort: 18800,
			ingressPort: 18791,
		}),
		expect.any(Object),
	);
	expect(writeLockfileMock).toHaveBeenCalledWith(
		'/tmp/test-controller.lock',
		expect.objectContaining({
			pid: process.pid,
			controllerPort: 18800,
			ingressPort: 18791,
		}),
	);

	await runtime.close();

	expect(removeLockfileMock).toHaveBeenCalledWith('/tmp/test-controller.lock');
});
```

- [ ] **Step 4: Run all controller-runtime tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/controller-runtime.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run linter**

Run: `pnpm oxlint packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime-types.ts`

- [ ] **Step 6: Commit**

```bash
git add packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime-types.ts packages/agent-vm/src/controller/controller-runtime.test.ts packages/agent-vm/src/controller/controller-lockfile.ts
git commit -m "feat: wire lockfile lifecycle into controller runtime with orphan cleanup on startup"
```

---

## Task 8: Add SIGTERM/SIGINT signal handlers to `controller start`

Register signal handlers in the CLI command that calls `runtime.close()` on shutdown signals.

**Files:**

- Modify: `packages/agent-vm/src/cli/commands/controller-definition.ts`

- [ ] **Step 1: Add signal handling to the `start` command handler**

In `packages/agent-vm/src/cli/commands/controller-definition.ts`, modify the `start` command's `handler` function. After the `runtime` is created and the JSON output is written, add:

```typescript
				handler: async ({ config, zone }) => {
					const systemConfig = await loadSystemConfigFromOption(config, dependencies);
					const selectedZone = requireZone(systemConfig, zone);

					await warnIfGatewayImageCacheIsCold(io, systemConfig);
					const runTask = await createRunTask(io);
					const runtime = await dependencies.startControllerRuntime(
						{
							systemConfig,
							zoneId: selectedZone.id,
						},
						{ runTask },
					);
					io.stdout.write(
						`${JSON.stringify(
							{
								controllerPort: runtime.controllerPort,
								ingress: runtime.gateway.ingress,
								vmId: runtime.gateway.vm.id,
								zoneId: selectedZone.id,
							},
							null,
							2,
						)}\n`,
					);

					let shuttingDown = false;
					const shutdown = async (): Promise<void> => {
						if (shuttingDown) {
							io.stderr.write('[controller] Forced exit on second signal.\n');
							process.exit(1);
						}
						shuttingDown = true;
						io.stderr.write('[controller] Shutting down gracefully...\n');
						const forceExitTimer = setTimeout(() => {
							io.stderr.write('[controller] Shutdown timed out, forcing exit.\n');
							process.exit(1);
						}, 10_000);
						forceExitTimer.unref();
						try {
							await runtime.close();
						} finally {
							clearTimeout(forceExitTimer);
						}
					};
					process.on('SIGTERM', () => void shutdown());
					process.on('SIGINT', () => void shutdown());

					await new Promise<void>(() => {});
				},
```

The `await new Promise<void>(() => {})` keeps the process alive after startup (it previously exited immediately after printing the JSON, which was a bug -- the controller is a long-running server).

- [ ] **Step 2: Run linter**

Run: `pnpm oxlint packages/agent-vm/src/cli/commands/controller-definition.ts`

- [ ] **Step 3: Run the full test suite to check for regressions**

Run: `pnpm vitest run packages/agent-vm/`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-vm/src/cli/commands/controller-definition.ts
git commit -m "feat: add SIGTERM/SIGINT graceful shutdown with timeout to controller start"
```

---

## Task 9: Expose health status on the controller HTTP API

Add a `/health` endpoint to the controller HTTP API that returns the current gateway health status.

**Files:**

- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts` (pass health getter to routes)

- [ ] **Step 1: Read the existing HTTP routes file**

Read `packages/agent-vm/src/controller/http/controller-http-routes.ts` to understand the current pattern for adding routes.

- [ ] **Step 2: Add the `/health` route**

Follow the existing pattern in the file. Add a GET `/health` route that returns the health monitor status:

```typescript
app.get('/health', async (context) => {
	const healthStatus = operations.getHealthStatus();
	const statusCode = healthStatus.status === 'healthy' ? 200 : 503;
	return context.json(healthStatus, statusCode);
});
```

Wire `getHealthStatus` through the operations object passed to `createControllerService`. The exact wiring depends on the current shape of the routes file -- follow the established pattern for how `operations` are passed.

- [ ] **Step 3: Update the controller-runtime.ts to pass health status to routes**

In `createControllerService` call inside `controller-runtime.ts`, add the `getHealthStatus` operation:

```typescript
const controllerApp = createControllerService({
	leaseManager,
	operations: {
		...createControllerRuntimeOperations({
			// ... existing options ...
		}),
		getHealthStatus: () => healthMonitor.getStatus(),
		stopController: createStopControllerOperation({
			// ... existing options ...
		}),
	},
	systemConfig: options.systemConfig,
});
```

- [ ] **Step 4: Write a test for the `/health` endpoint**

Add to the existing controller-runtime test that already tests HTTP endpoints:

```typescript
const healthResponse = await startHttpServerArgs.app.request('/health');
expect(healthResponse.status).toBe(200);
await expect(healthResponse.json()).resolves.toEqual({ status: 'healthy' });
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/agent-vm/src/controller/`
Expected: All tests pass.

- [ ] **Step 6: Run linter**

Run: `pnpm oxlint packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/controller-runtime.ts`

- [ ] **Step 7: Commit**

```bash
git add packages/agent-vm/src/controller/http/controller-http-routes.ts packages/agent-vm/src/controller/controller-runtime.ts packages/agent-vm/src/controller/controller-runtime.test.ts
git commit -m "feat: add /health endpoint exposing gateway health monitor status"
```

---

## Task 10: Final verification

Run the full test suite and linter across the entire package to confirm no regressions.

- [ ] **Step 1: Run all tests**

Run: `pnpm vitest run packages/agent-vm/`
Expected: All tests pass.

- [ ] **Step 2: Run linter on the full package**

Run: `pnpm oxlint packages/agent-vm/src/`

- [ ] **Step 3: Run type check**

Run: `pnpm tsc --noEmit -p packages/agent-vm/tsconfig.json`

- [ ] **Step 4: Verify test counts**

Count tests and confirm all pass. Report pass/fail counts and exit codes.

- [ ] **Step 5: Final commit (if any formatting fixes needed)**

```bash
git add -A
git commit -m "chore: formatting and lint fixes from controller resilience implementation"
```

---

## Summary

| Task      | Component                                  | Estimated Time |
| --------- | ------------------------------------------ | -------------- |
| 1         | Extract `checkGatewayHealth`               | 5 min          |
| 2         | Gateway health monitor                     | 10 min         |
| 3         | Controller lockfile (write/read/remove)    | 5 min          |
| 4         | Orphan cleanup function                    | 5 min          |
| 5         | Default platform dependencies (lsof/fetch) | 5 min          |
| 6         | Wire health monitor into runtime           | 10 min         |
| 7         | Wire lockfile into runtime                 | 10 min         |
| 8         | SIGTERM/SIGINT signal handlers             | 5 min          |
| 9         | /health HTTP endpoint                      | 5 min          |
| 10        | Final verification                         | 5 min          |
| **Total** |                                            | **~65 min**    |
