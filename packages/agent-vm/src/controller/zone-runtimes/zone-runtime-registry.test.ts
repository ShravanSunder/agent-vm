import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig, SystemConfig } from '../../config/system-config.js';
import type { GatewayZone } from '../../gateway/gateway-zone-support.js';
import { ActiveTaskRegistry, type ActiveWorkerTask } from '../active-task-registry.js';
import type { PreparedWorkerTask, WorkerTaskInput } from '../worker-task-runner.js';
import { createOpenClawZoneRuntime } from './openclaw-zone-runtime.js';
import { createWorkerZoneRuntime } from './worker-zone-runtime.js';
import { createZoneRuntimeRegistry } from './zone-runtime-registry.js';
import type {
	ControllerZoneRuntime,
	OpenClawZoneRuntime,
	WorkerZoneRuntime,
} from './zone-runtime-types.js';

const systemConfig = {
	schemaVersion: 1,
	cacheDir: './cache',
	runtimeDir: './runtime',
	host: {
		controllerPort: 18800,
		projectNamespace: 'multi-zone-test',
	},
	imageProfiles: {
		gateways: {
			openclaw: { type: 'openclaw', buildConfig: './gateway.json' },
			worker: { type: 'worker', buildConfig: './worker.json' },
		},
		toolVms: {
			standard: { type: 'toolVm', buildConfig: './tool.json' },
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './shravan/openclaw.json',
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
			},
			secrets: {},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
		{
			id: 'alevtina',
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18792,
				config: './alevtina/openclaw.json',
				stateDir: './state/alevtina',
				zoneFilesDir: './zone-files/alevtina',
			},
			secrets: {},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
		{
			id: 'worker-zone',
			gateway: {
				type: 'worker',
				imageProfile: 'worker',
				memory: '2G',
				cpus: 2,
				port: 18793,
				config: './worker/worker.json',
				stateDir: './state/worker',
			},
			secrets: {},
			allowedHosts: ['api.openai.com'],
			websocketBypass: [],
		},
	],
	toolVmProfiles: {
		standard: {
			cpus: 1,
			imageProfile: 'standard',
			memory: '1G',
		},
	},
	tcpPool: { basePort: 19000, size: 5 },
} satisfies SystemConfig;

const loadedSystemConfig = {
	...systemConfig,
	systemConfigPath: '/tmp/system.json',
} satisfies LoadedSystemConfig;

const openClawZone = systemConfig.zones.find((zone) => zone.id === 'shravan');
if (!openClawZone || openClawZone.gateway.type !== 'openclaw') {
	throw new Error('Expected shravan OpenClaw test zone.');
}

const workerZone = systemConfig.zones.find((zone) => zone.id === 'worker-zone');
if (!workerZone || workerZone.gateway.type !== 'worker') {
	throw new Error('Expected worker test zone.');
}

function isOpenClawGatewayZone(zone: GatewayZone | undefined): zone is GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'openclaw' }>;
} {
	return zone?.gateway.type === 'openclaw';
}

function isWorkerGatewayZone(zone: GatewayZone | undefined): zone is GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'worker' }>;
} {
	return zone?.gateway.type === 'worker';
}

function getWorkerZone(): GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'worker' }>;
} {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === 'worker-zone');
	if (!isWorkerGatewayZone(zone)) {
		throw new Error('Expected worker test zone.');
	}
	return zone;
}

function getOpenClawZone(): GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'openclaw' }>;
} {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === 'shravan');
	if (!isOpenClawGatewayZone(zone)) {
		throw new Error('Expected shravan OpenClaw test zone.');
	}
	return zone;
}

function createPreparedWorkerTask(input: WorkerTaskInput): PreparedWorkerTask {
	const zone = getWorkerZone();
	const workerInput = {
		context: input.context ?? {},
		prompt: input.prompt,
		repos:
			input.repos?.map((repo) => ({
				baseBranch: repo.baseBranch ?? 'main',
				repoUrl: repo.repoUrl,
			})) ?? [],
		requestTaskId: input.requestTaskId,
		resources: {
			externalResources: Object.fromEntries(
				Object.entries(input.resources?.externalResources ?? {}).map(([name, resource]) => [
					name,
					{
						binding: resource.binding,
						env: resource.env ?? {},
						name: resource.name,
						target: resource.target,
					},
				]),
			),
		},
	};
	return {
		eventLogPath: '/tmp/events.jsonl',
		input: workerInput,
		preStartResult: {
			effectiveConfig: {
				branchPrefix: 'agent-vm/task-1',
				defaults: {
					model: 'latest-medium',
					provider: 'codex',
				},
				mcpServers: [],
				phases: {
					plan: {
						agentInstructions: 'plan',
						agentTurnTimeoutMs: 900_000,
						cycle: { kind: 'noReview' },
						reviewerInstructions: null,
						reviewerTurnTimeoutMs: 900_000,
						skills: [],
					},
					work: {
						agentInstructions: 'work',
						agentTurnTimeoutMs: 2_700_000,
						cycle: { kind: 'review', cycleCount: 1 },
						reviewerInstructions: null,
						reviewerTurnTimeoutMs: 900_000,
						skills: [],
					},
					wrapup: {
						instructions: 'wrapup',
						skills: [],
						turnTimeoutMs: 900_000,
					},
				},
				runtimeInstructions: 'runtime instructions',
				stateDir: '/state',
				verification: [],
				verificationTimeoutMs: 300_000,
			},
			environment: {},
			input: workerInput,
			repos: [],
			startedResourceProviders: [],
			stateDir: '/tmp/state',
			taskId: 'task-1',
			taskRoot: '/tmp/task-1',
			taskRuntimeRoot: '/tmp/runtime/task-1',
			tcpHosts: {},
			vfsMounts: {},
			workDir: '/tmp/work',
		},
		recordEvent: async () => {},
		taskId: 'task-1',
		taskRoot: '/tmp/task-1',
		taskZoneConfig: zone,
		zone,
		zoneId: 'worker-zone',
	};
}

describe('zone runtime contracts', () => {
	it('keeps OpenClaw and Worker runtimes behind one discriminated zone runtime interface', () => {
		const openClawRuntime = {
			destroy: async (purged: boolean) => ({ ok: true, purged, zoneId: 'shravan' }),
			enableSsh: async () => ({
				command: 'ssh root@127.0.0.1',
				host: '127.0.0.1',
				port: 22,
			}),
			exec: async () => ({ exitCode: 0, stderr: '', stdout: 'ok' }),
			gatewayType: 'openclaw',
			getHealth: async () => ({ ok: true, observation: 'http 200', zoneId: 'shravan' }),
			getLogs: async () => ({ output: 'logs', zoneId: 'shravan' }),
			getSnapshot: () => ({ lifecycleState: 'stopped' }),
			refreshCredentials: async () => ({ ok: true, zoneId: 'shravan' }),
			restart: async () => {},
			shutdown: async () => {},
			start: async () => {},
			stop: async () => {},
			upgrade: async () => ({ ok: true, zoneId: 'shravan' }),
			zoneId: 'shravan',
		} satisfies OpenClawZoneRuntime;

		const workerRuntime = {
			closeTaskForZone: async () => ({ status: 'closed' }),
			destroy: async (purged: boolean) => ({ ok: true, purged, zoneId: 'worker-zone' }),
			executeWorkerTask: async () => ({
				finalState: null,
				taskId: 'task-1',
				taskRoot: '/tmp/task-1',
			}),
			gatewayType: 'worker',
			getSnapshot: () => ({ lifecycleState: 'stopped' }),
			getTaskState: async () => null,
			prepareWorkerTask: async (input: WorkerTaskInput) => createPreparedWorkerTask(input),
			pullDefaultForTask: async () => ({
				commitsSinceForkPoint: [],
				defaultBranch: 'main',
				divergence: {
					aheadOfDefault: 0,
					behindDefault: 0,
					forkPoint: 'abc123',
				},
				fetchedCommits: [],
				kind: 'advanced',
				localDefaultHead: 'abc123',
				message: 'advanced',
				remoteDefaultHead: 'abc123',
				repoUrl: 'github.com/example/repo',
				success: true,
			}),
			pushTaskBranches: async () => ({ results: [] }),
			shutdown: async () => {},
			zoneId: 'worker-zone',
		} satisfies WorkerZoneRuntime;

		const runtimes: readonly ControllerZoneRuntime[] = [openClawRuntime, workerRuntime];

		expect(runtimes.map((runtime) => runtime.gatewayType)).toEqual(['openclaw', 'worker']);
	});
});

describe('createOpenClawZoneRuntime', () => {
	it('starts, snapshots, reads logs, and stops one OpenClaw gateway zone', async () => {
		const close = vi.fn(async () => {});
		const exec = vi.fn(async (command: string) => ({
			exitCode: 0,
			stderr: '',
			stdout: command.includes('/agent-vm/logs/*.log')
				? 'gateway and runtime log output'
				: command.includes('/readyz')
					? '200'
					: 'command output',
		}));
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: async (zoneId) => {
				expect(zoneId).toBe('shravan');
				return {
					image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close,
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({
							command: 'ssh root@127.0.0.1',
							host: '127.0.0.1',
							port: 22,
						})),
						exec,
						getVmInstance: vi.fn(),
						id: 'vm-shravan',
						setIngressRoutes: vi.fn(),
					},
					zone: openClawZone,
				};
			},
			runControllerCredentialsRefresh: async (_options, dependencies) => {
				await dependencies.refreshZoneSecrets('shravan');
				await dependencies.restartGatewayZone('shravan');
				return { ok: true, zoneId: 'shravan' };
			},
			runControllerDestroy: async (options, dependencies) => {
				await dependencies.stopGatewayZone(options.zoneId);
				await dependencies.releaseZoneLeases(options.zoneId);
				return { ok: true, purged: options.purge, zoneId: options.zoneId };
			},
			runControllerLogs: async (options, dependencies) => ({
				output: await dependencies.readGatewayLogs(options.zoneId),
				zoneId: options.zoneId,
			}),
			runControllerUpgrade: async (_options, dependencies) => {
				await dependencies.rebuildGatewayImage('shravan');
				await dependencies.restartGatewayZone('shravan');
				return { ok: true, zoneId: 'shravan' };
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();

		expect(runtime.getSnapshot()).toMatchObject({
			bootedAt: '2026-04-30T10:00:00.000Z',
			gateway: {
				ingress: { host: '127.0.0.1', port: 18791 },
				vm: { id: 'vm-shravan' },
			},
			lifecycleState: 'running',
		});
		await expect(runtime.getLogs()).resolves.toEqual({
			output: 'gateway and runtime log output',
			zoneId: 'shravan',
		});
		expect(exec).toHaveBeenCalledWith(
			[
				"echo '===== gateway boot log (/agent-vm/logs/gateway-boot-latest.log) ====='",
				'cat /agent-vm/logs/gateway-boot-latest.log 2>/dev/null || true',
				'echo',
				"echo '===== latest openclaw runtime log (/agent-vm/logs/*.log) ====='",
				'latest_openclaw_log=$(ls -1t /agent-vm/logs/*.log 2>/dev/null | grep -v "/gateway-boot-latest\\.log$" | head -n 1); if [ -n "$latest_openclaw_log" ]; then tail -n 400 "$latest_openclaw_log"; fi',
			].join('; '),
		);
		await expect(runtime.getHealth()).resolves.toEqual({
			ok: true,
			observation: 'http 200',
			zoneId: 'shravan',
		});
		await runtime.stop();
		expect(close).toHaveBeenCalledTimes(1);
		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });
	});

	it('records startup failure and keeps the zone inspectable', async () => {
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-04-30T10:00:00.000Z'),
			restartGatewayZone: async () => {
				throw new Error('gateway boot failed');
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.start()).rejects.toThrow("Failed to start zone 'shravan'");
		expect(runtime.getSnapshot()).toEqual({
			lastError: 'gateway boot failed',
			lifecycleState: 'failed',
		});
		await expect(runtime.getLogs()).rejects.toThrow(
			"Gateway runtime for zone 'shravan' is unavailable. Last error: gateway boot failed",
		);
	});
});

describe('createWorkerZoneRuntime', () => {
	it('prepares worker tasks through the worker runtime and reports stopped lifecycle state', async () => {
		const prepareWorkerTask = vi.fn(async (options) =>
			createPreparedWorkerTask({
				...options.input,
				requestTaskId: 'request-1',
			}),
		);
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				activateReservation: vi.fn(),
				beginZoneDestroy: vi.fn(),
				clear: vi.fn(),
				countOccupiedForZone: vi.fn(() => 0),
				endZoneDestroy: vi.fn(),
				get: vi.fn(),
				listForZone: vi.fn(() => []),
				releaseReservation: vi.fn(),
				setWorkerIngress: vi.fn(),
				tryReserve: vi.fn(() => 'reservation-1'),
			},
			controllerGithubToken: null,
			prepareWorkerTask,
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getWorkerZone(),
		});

		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });
		await expect(
			runtime.prepareWorkerTask({
				context: {},
				prompt: 'test',
				repos: [],
				requestTaskId: 'request-1',
				resources: { externalResources: {} },
			}),
		).resolves.toMatchObject({
			taskId: 'task-1',
			zoneId: 'worker-zone',
		});
		expect(prepareWorkerTask).toHaveBeenCalledWith(
			expect.objectContaining({
				zoneId: 'worker-zone',
			}),
		);
	});

	it('reports worker lifecycle as running while the zone has active tasks', () => {
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				activateReservation: vi.fn(),
				beginZoneDestroy: vi.fn(),
				clear: vi.fn(),
				countOccupiedForZone: vi.fn(() => 1),
				endZoneDestroy: vi.fn(),
				get: vi.fn(),
				listForZone: vi.fn(() => [createActiveWorkerTask('task-1')]),
				releaseReservation: vi.fn(),
				setWorkerIngress: vi.fn(),
				tryReserve: vi.fn(() => 'reservation-1'),
			},
			controllerGithubToken: null,
			prepareWorkerTask: vi.fn(async (options) => createPreparedWorkerTask(options.input)),
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getWorkerZone(),
		});

		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'running' });
	});

	it('destroys worker zone runtime by clearing active tasks for that zone', async () => {
		const clear = vi.fn();
		const activeTask1 = {
			...createActiveWorkerTask('task-1'),
			workerIngress: { host: '127.0.0.1', port: 18881 },
		};
		const activeTask2 = {
			...createActiveWorkerTask('task-2'),
			workerIngress: { host: '127.0.0.1', port: 18882 },
		};
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchMock;
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				activateReservation: vi.fn(),
				beginZoneDestroy: vi.fn(),
				clear,
				countOccupiedForZone: vi.fn(() => 2),
				endZoneDestroy: vi.fn(),
				get: vi.fn(),
				listForZone: vi.fn(() => [activeTask1, activeTask2]),
				releaseReservation: vi.fn(),
				setWorkerIngress: vi.fn(),
				tryReserve: vi.fn(() => 'reservation-1'),
			},
			controllerGithubToken: null,
			prepareWorkerTask: vi.fn(async (options) => createPreparedWorkerTask(options.input)),
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getWorkerZone(),
		});

		try {
			await expect(runtime.destroy(false)).resolves.toEqual({
				ok: true,
				purged: false,
				zoneId: 'worker-zone',
			});
			expect(clear).toHaveBeenCalledWith('worker-zone', 'task-1');
			expect(clear).toHaveBeenCalledWith('worker-zone', 'task-2');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('refuses worker destroy while an active task is still preparing', async () => {
		const clear = vi.fn();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchMock;
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				activateReservation: vi.fn(),
				beginZoneDestroy: vi.fn(),
				clear,
				countOccupiedForZone: vi.fn(() => 1),
				endZoneDestroy: vi.fn(),
				get: vi.fn(),
				listForZone: vi.fn(() => [createActiveWorkerTask('task-booting')]),
				releaseReservation: vi.fn(),
				setWorkerIngress: vi.fn(),
				tryReserve: vi.fn(() => 'reservation-1'),
			},
			controllerGithubToken: null,
			prepareWorkerTask: vi.fn(async (options) => createPreparedWorkerTask(options.input)),
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getWorkerZone(),
		});

		try {
			await expect(runtime.destroy(true)).rejects.toThrow(
				"Task 'task-booting' in zone 'worker-zone' is still preparing",
			);
			expect(clear).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('gates new worker task reservations while destroy is closing active tasks', async () => {
		const registry = new ActiveTaskRegistry();
		const reservationId = registry.tryReserve('worker-zone', 2);
		expect(reservationId).not.toBeNull();
		registry.activateReservation('worker-zone', reservationId ?? 'missing', {
			...createActiveWorkerTask('task-1'),
			workerIngress: { host: '127.0.0.1', port: 18888 },
		});
		let releaseWorkerClose: (() => void) | undefined;
		let workerCloseStarted: (() => void) | undefined;
		const workerCloseStartedPromise = new Promise<void>((resolve) => {
			workerCloseStarted = resolve;
		});
		const releaseWorkerClosePromise = new Promise<void>((resolve) => {
			releaseWorkerClose = resolve;
		});
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => {
			workerCloseStarted?.();
			await releaseWorkerClosePromise;
			return new Response(null, { status: 200 });
		});
		globalThis.fetch = fetchMock;
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: registry,
			controllerGithubToken: null,
			prepareWorkerTask: vi.fn(async (options) => createPreparedWorkerTask(options.input)),
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getWorkerZone(),
		});

		try {
			const destroyPromise = runtime.destroy(false);
			await workerCloseStartedPromise;

			expect(registry.tryReserve('worker-zone', 2)).toBeNull();

			releaseWorkerClose?.();
			await expect(destroyPromise).resolves.toEqual({
				ok: true,
				purged: false,
				zoneId: 'worker-zone',
			});
			expect(registry.tryReserve('worker-zone', 2)).not.toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('attempts all worker closes and clears only successfully closed tasks when a sibling fails', async () => {
		const activeTask1 = {
			...createActiveWorkerTask('task-1'),
			workerIngress: { host: '127.0.0.1', port: 18881 },
		};
		const activeTask2 = {
			...createActiveWorkerTask('task-2'),
			workerIngress: { host: '127.0.0.1', port: 18882 },
		};
		const clear = vi.fn();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
			.mockResolvedValueOnce(new Response('close failed', { status: 503 }));
		globalThis.fetch = fetchMock;
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				activateReservation: vi.fn(),
				beginZoneDestroy: vi.fn(),
				clear,
				countOccupiedForZone: vi.fn(() => 2),
				endZoneDestroy: vi.fn(),
				get: vi.fn(),
				listForZone: vi.fn(() => [activeTask1, activeTask2]),
				releaseReservation: vi.fn(),
				setWorkerIngress: vi.fn(),
				tryReserve: vi.fn(() => 'reservation-1'),
			},
			controllerGithubToken: null,
			prepareWorkerTask: vi.fn(async (options) => createPreparedWorkerTask(options.input)),
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getWorkerZone(),
		});

		try {
			await expect(runtime.destroy(false)).rejects.toThrow(
				"worker close returned HTTP 503 for task 'task-2'",
			);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(clear).toHaveBeenCalledTimes(1);
			expect(clear).toHaveBeenCalledWith('worker-zone', 'task-1');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('closes active worker tasks and purges worker state when destroy runs with purge', async () => {
		const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-worker-destroy-'));
		const originalFetch = globalThis.fetch;
		try {
			const stateDir = path.join(tempDirectory, 'state', 'worker-zone');
			const runtimeDir = path.join(tempDirectory, 'runtime');
			const workerRuntimeDir = path.join(runtimeDir, 'worker-tasks', 'worker-zone');
			await mkdir(stateDir, { recursive: true });
			await mkdir(workerRuntimeDir, { recursive: true });
			await writeFile(path.join(stateDir, 'state.txt'), 'state', 'utf8');
			await writeFile(path.join(workerRuntimeDir, 'runtime.txt'), 'runtime', 'utf8');
			const purgeWorkerZone = {
				...getWorkerZone(),
				gateway: {
					...getWorkerZone().gateway,
					stateDir,
				},
			};
			const clear = vi.fn();
			const activeTask = {
				...createActiveWorkerTask('task-1'),
				workerIngress: { host: '127.0.0.1', port: 18888 },
			};
			const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
			globalThis.fetch = fetchMock;
			const runtime = createWorkerZoneRuntime({
				activeTaskRegistry: {
					activateReservation: vi.fn(),
					beginZoneDestroy: vi.fn(),
					clear,
					countOccupiedForZone: vi.fn(() => 1),
					endZoneDestroy: vi.fn(),
					get: vi.fn(),
					listForZone: vi.fn(() => [activeTask]),
					releaseReservation: vi.fn(),
					setWorkerIngress: vi.fn(),
					tryReserve: vi.fn(() => 'reservation-1'),
				},
				controllerGithubToken: null,
				prepareWorkerTask: vi.fn(async (options) => createPreparedWorkerTask(options.input)),
				requestHeartbeatRegistry: {
					acquire: vi.fn(),
					release: vi.fn(),
				},
				secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
				systemConfig: {
					...loadedSystemConfig,
					runtimeDir,
					zones: [purgeWorkerZone],
				},
				zone: purgeWorkerZone,
			});

			await expect(runtime.destroy(true)).resolves.toEqual({
				ok: true,
				purged: true,
				zoneId: 'worker-zone',
			});
			expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:18888/tasks/task-1/close', {
				method: 'POST',
			});
			expect(clear).toHaveBeenCalledWith('worker-zone', 'task-1');
			await expect(access(stateDir)).rejects.toMatchObject({ code: 'ENOENT' });
			await expect(access(workerRuntimeDir)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			globalThis.fetch = originalFetch;
			await rm(tempDirectory, { force: true, recursive: true });
		}
	});

	it('does not clear active worker tasks during normal shutdown', async () => {
		const clear = vi.fn();
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				activateReservation: vi.fn(),
				beginZoneDestroy: vi.fn(),
				clear,
				countOccupiedForZone: vi.fn(() => 1),
				endZoneDestroy: vi.fn(),
				get: vi.fn(),
				listForZone: vi.fn(() => [createActiveWorkerTask('task-1')]),
				releaseReservation: vi.fn(),
				setWorkerIngress: vi.fn(),
				tryReserve: vi.fn(() => 'reservation-1'),
			},
			controllerGithubToken: null,
			prepareWorkerTask: vi.fn(async (options) => createPreparedWorkerTask(options.input)),
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getWorkerZone(),
		});

		await runtime.shutdown();

		expect(clear).not.toHaveBeenCalled();
	});
});

describe('createZoneRuntimeRegistry', () => {
	it('starts all selected zones with partial-start semantics', async () => {
		const shravanRuntime = createFakeOpenClawRuntime('shravan');
		const alevtinaRuntime = createFakeOpenClawRuntime('alevtina', {
			getLogs: async () => {
				throw new Error("Gateway runtime for zone 'alevtina' is unavailable");
			},
			getSnapshot: () => ({
				lastError: 'alevtina boot failed',
				lifecycleState: 'failed',
			}),
			start: async () => {
				throw new Error('alevtina boot failed');
			},
		});
		const writeLog = vi.fn();
		const registry = createZoneRuntimeRegistry({
			createRuntimeForZone: (zone) => (zone.id === 'shravan' ? shravanRuntime : alevtinaRuntime),
			systemConfig: {
				...loadedSystemConfig,
				zones: [getOpenClawZone(), { ...getOpenClawZone(), id: 'alevtina' }],
			},
			writeLog,
			zoneIds: ['shravan', 'alevtina'],
		});

		await registry.startSelectedZones();

		expect(writeLog).toHaveBeenCalledWith("Failed to start zone 'alevtina': alevtina boot failed");
		expect(registry.getSnapshotByZone()).toEqual({
			alevtina: {
				lastError: 'alevtina boot failed',
				lifecycleState: 'failed',
			},
			shravan: { lifecycleState: 'running' },
		});
		await expect(registry.getOpenClawRuntime('shravan').getLogs()).resolves.toEqual({
			output: 'logs for shravan',
			zoneId: 'shravan',
		});
		await expect(registry.getOpenClawRuntime('alevtina').getLogs()).rejects.toThrow(
			"Gateway runtime for zone 'alevtina' is unavailable",
		);
	});

	it('rejects unsupported operations by target zone type', async () => {
		const registry = createZoneRuntimeRegistry({
			createRuntimeForZone: (zone) =>
				zone.gateway.type === 'worker'
					? createFakeWorkerRuntime(zone.id)
					: createFakeOpenClawRuntime(zone.id),
			systemConfig: loadedSystemConfig,
			zoneIds: ['shravan', 'worker-zone'],
		});

		expect(() => registry.getOpenClawRuntime('worker-zone')).toThrow(
			"Zone 'worker-zone' with gateway type 'worker' does not support OpenClaw operations.",
		);
		expect(() => registry.getWorkerRuntime('shravan')).toThrow(
			"Zone 'shravan' with gateway type 'openclaw' does not support worker operations.",
		);
		await expect(registry.destroyZone('missing-zone', false)).rejects.toThrow(
			"Unknown zone 'missing-zone'.",
		);
	});
});

function createActiveWorkerTask(taskId: string): ActiveWorkerTask {
	return {
		branchPrefix: `agent-vm/${taskId}`,
		eventLogPath: `/tmp/${taskId}/events.jsonl`,
		repos: [],
		taskId,
		taskRoot: `/tmp/${taskId}`,
		workerIngress: null,
		zoneId: 'worker-zone',
	};
}

function createFakeOpenClawRuntime(
	zoneId: string,
	overrides: Partial<OpenClawZoneRuntime> = {},
): OpenClawZoneRuntime {
	let lifecycleState: 'running' | 'failed' | 'stopped' = 'stopped';
	return {
		destroy: async (purged) => ({ ok: true, purged, zoneId }),
		enableSsh: async () => ({
			command: 'ssh root@127.0.0.1',
			host: '127.0.0.1',
			port: 22,
		}),
		exec: async () => ({ exitCode: 0, stderr: '', stdout: zoneId }),
		gatewayType: 'openclaw',
		getHealth: async () => ({ ok: true, observation: 'http 200', zoneId }),
		getLogs: async () => ({ output: `logs for ${zoneId}`, zoneId }),
		getSnapshot: () => ({ lifecycleState }),
		refreshCredentials: async () => ({ ok: true, zoneId }),
		restart: async () => {},
		shutdown: async () => {
			lifecycleState = 'stopped';
		},
		start: async () => {
			lifecycleState = 'running';
		},
		stop: async () => {
			lifecycleState = 'stopped';
		},
		upgrade: async () => ({ ok: true, zoneId }),
		zoneId,
		...overrides,
	};
}

function createFakeWorkerRuntime(zoneId: string): WorkerZoneRuntime {
	return {
		closeTaskForZone: async () => ({ status: 'closed' }),
		destroy: async (purged) => ({ ok: true, purged, zoneId }),
		executeWorkerTask: async () => ({
			finalState: null,
			taskId: 'task-1',
			taskRoot: '/tmp/task-1',
		}),
		gatewayType: 'worker',
		getSnapshot: () => ({ lifecycleState: 'stopped' }),
		getTaskState: async () => null,
		prepareWorkerTask: async (input) => createPreparedWorkerTask(input),
		pullDefaultForTask: async () => ({
			commitsSinceForkPoint: [],
			defaultBranch: 'main',
			divergence: {
				aheadOfDefault: 0,
				behindDefault: 0,
				forkPoint: 'abc123',
			},
			fetchedCommits: [],
			kind: 'advanced',
			localDefaultHead: 'abc123',
			message: 'advanced',
			remoteDefaultHead: 'abc123',
			repoUrl: 'github.com/example/repo',
			success: true,
		}),
		pushTaskBranches: async () => ({ results: [] }),
		shutdown: async () => {},
		zoneId,
	};
}
