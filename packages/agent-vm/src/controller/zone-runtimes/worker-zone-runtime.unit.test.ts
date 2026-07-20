import { describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig, SystemConfig } from '../../config/system-config.js';
import { ManagedVmTerminationUnprovenError } from '../../shared/controller-managed-vm-termination.js';
import type { ActiveWorkerTask } from '../active-task-registry.js';
import {
	createControllerStateRoot,
	resolveControllerGatewayStateRoot,
} from '../durable-state/controller-state-paths.js';
import { resolveControllerWorkerTaskRuntimeRecordTarget } from '../durable-state/controller-state-record-paths.js';
import type { PreparedWorkerTask } from '../worker-task-runner.js';
import { createWorkerZoneRuntime as createWorkerZoneRuntimeImpl } from './worker-zone-runtime.js';

const systemConfig = {
	schemaVersion: 1,
	cacheDir: './cache',
	controllerStateDir: '/controller-state-test',
	runtimeDir: './runtime',
	host: {
		controllerPort: 18800,
		projectNamespace: 'worker-runtime-test',
	},
	imageProfiles: {
		gateways: {
			worker: { type: 'worker', buildConfig: './worker.json' },
		},
		toolVms: {},
	},
	zones: [
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
			egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
		},
	],
	toolVmProfiles: {},
	tcpPool: { basePort: 19000, size: 5 },
} satisfies SystemConfig;

const loadedSystemConfig = {
	...systemConfig,
	systemConfigPath: '/tmp/system.json',
} satisfies LoadedSystemConfig;

function createWorkerZoneRuntime(
	options: Omit<
		Parameters<typeof createWorkerZoneRuntimeImpl>[0],
		| 'managedVmExactProcessTermination'
		| 'managedVmFactory'
		| 'managedVmImages'
		| 'workerRuntimeRecordTargetFor'
	>,
): ReturnType<typeof createWorkerZoneRuntimeImpl> {
	return createWorkerZoneRuntimeImpl({
		...options,
		managedVmExactProcessTermination: {
			terminateRecordedHostProcess: async ({ identity }) => ({
				hostProcessId: identity.hostProcessId,
				kind: 'already-absent',
			}),
		},
		managedVmFactory: {
			createManagedVm: async () => {
				throw new Error('worker unit test must inject executeWorkerTask');
			},
		},
		managedVmImages: {
			prepareImage: async () => ({
				built: false,
				fingerprint: 'test-fingerprint',
				imageReference: '/tmp/test-image',
			}),
		},
		workerRuntimeRecordTargetFor: (taskId) =>
			resolveControllerWorkerTaskRuntimeRecordTarget({
				gatewayStateRoot: resolveControllerGatewayStateRoot({
					controllerStateRoot: createControllerStateRoot({
						controllerStateDirectoryPath: options.systemConfig.controllerStateDir,
					}),
					zoneId: options.zone.id,
				}),
				taskId,
			}),
	});
}

function getWorkerZone(): Extract<
	(typeof systemConfig.zones)[number],
	{ gateway: { type: 'worker' } }
> {
	const configuredZone = systemConfig.zones[0];
	if (!configuredZone || configuredZone.gateway.type !== 'worker') {
		throw new Error('Expected worker test zone.');
	}
	return configuredZone;
}

const workerZone = getWorkerZone();
const workerControllerEpoch = 'worker-controller-epoch-test';

function createActiveWorkerTask(
	taskId: string,
	workerIngress: ActiveWorkerTask['workerIngress'],
): ActiveWorkerTask {
	return {
		branchPrefix: `agent-vm/${taskId}`,
		eventLogPath: `/tmp/${taskId}/events.jsonl`,
		repos: [],
		taskId,
		taskRoot: `/tmp/${taskId}`,
		workerIngress,
		zoneId: 'worker-zone',
	};
}

function createPreparedWorkerTask(taskId: string): PreparedWorkerTask {
	const input = {
		context: {},
		prompt: 'prove Worker VM cleanup ownership',
		repos: [],
		requestTaskId: `request-${taskId}`,
		resources: { externalResources: {} },
	};
	return {
		eventLogPath: `/tmp/${taskId}/events.jsonl`,
		input,
		preStartResult: {
			effectiveConfig: {
				branchPrefix: `agent-vm/${taskId}`,
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
			input,
			repos: [],
			startedResourceProviders: [],
			stateDir: `/tmp/${taskId}/state`,
			taskId,
			taskRoot: `/tmp/${taskId}`,
			taskRuntimeRoot: `/tmp/runtime/${taskId}`,
			tcpHosts: {},
			vfsMounts: {},
			workDir: `/tmp/${taskId}/work`,
		},
		recordEvent: async () => {},
		taskId,
		taskRoot: `/tmp/${taskId}`,
		taskZoneConfig: workerZone,
		zone: workerZone,
		zoneId: 'worker-zone',
	};
}

function createActiveTaskRegistryStub(
	activeTask: ActiveWorkerTask,
	clear: Parameters<typeof createWorkerZoneRuntime>[0]['activeTaskRegistry']['clear'],
): Parameters<typeof createWorkerZoneRuntime>[0]['activeTaskRegistry'] {
	return {
		activateReservation: vi.fn(),
		beginZoneDestroy: vi.fn(),
		clear,
		countOccupiedForZone: vi.fn(() => 1),
		endZoneDestroy: vi.fn(),
		get: vi.fn(() => activeTask),
		listForZone: vi.fn(() => [activeTask]),
		releaseReservation: vi.fn(),
		setWorkerIngress: vi.fn(),
		tryReserve: vi.fn(() => 'reservation-1'),
	};
}

describe('createWorkerZoneRuntime destroy orchestration', () => {
	it('retains active ownership when Worker execution nests unproven VM destruction', async () => {
		const prepared = createPreparedWorkerTask('task-owner-unsafe');
		const activeTask = createActiveWorkerTask(prepared.taskId, {
			host: '127.0.0.1',
			port: 18881,
		});
		const clear = vi.fn(() => true);
		const nestedCleanupFailure = new AggregateError(
			[
				new Error('worker task failed'),
				new AggregateError(
					[new ManagedVmTerminationUnprovenError('Worker VM exact destruction is unproven')],
					'nested cleanup failed',
				),
			],
			'worker execution and cleanup failed',
		);
		const executeWorkerTask = vi.fn(async () => {
			throw nestedCleanupFailure;
		});
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: createActiveTaskRegistryStub(activeTask, clear),
			controllerGithubToken: null,
			controllerEpoch: workerControllerEpoch,
			executeWorkerTask,
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: workerZone,
		});

		await expect(runtime.executeWorkerTask(prepared)).rejects.toBe(nestedCleanupFailure);

		expect(clear).not.toHaveBeenCalled();
		expect(executeWorkerTask).toHaveBeenCalledWith(
			prepared,
			expect.objectContaining({
				controllerEpoch: workerControllerEpoch,
				controlSession: expect.objectContaining({ controllerEpoch: workerControllerEpoch }),
				workerRuntimeRecordTarget: {
					filePath:
						'/controller-state-test/zones/worker-zone/worker-tasks/task-owner-unsafe/gateway-runtime.json',
					kind: 'controller-worker-task-runtime-record',
					taskId: 'task-owner-unsafe',
					zoneId: 'worker-zone',
				},
			}),
		);
		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'running' });
	});

	it('clears active ownership when Worker execution fails without a destruction error', async () => {
		const prepared = createPreparedWorkerTask('task-ordinary-failure');
		const activeTask = createActiveWorkerTask(prepared.taskId, {
			host: '127.0.0.1',
			port: 18881,
		});
		const clear = vi.fn(() => true);
		const ordinaryFailure = new Error('worker request rejected');
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: createActiveTaskRegistryStub(activeTask, clear),
			controllerGithubToken: null,
			controllerEpoch: workerControllerEpoch,
			executeWorkerTask: vi.fn(async () => {
				throw ordinaryFailure;
			}),
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: workerZone,
		});

		await expect(runtime.executeWorkerTask(prepared)).rejects.toBe(ordinaryFailure);

		expect(clear).toHaveBeenCalledOnce();
		expect(clear).toHaveBeenCalledWith('worker-zone', prepared.taskId);
	});

	it('clears only successfully closed tasks and wraps unexpected close rejections', async () => {
		const activeTask1 = createActiveWorkerTask('task-1', {
			host: '127.0.0.1',
			port: 18881,
		});
		const activeTask2 = createActiveWorkerTask('task-2', {
			host: '127.0.0.1',
			port: 18882,
		});
		const clear = vi.fn();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
			.mockRejectedValueOnce(new TypeError('socket closed'));
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
			controllerEpoch: workerControllerEpoch,
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: workerZone,
		});

		try {
			await expect(runtime.destroy(false)).rejects.toMatchObject({
				body: 'socket closed',
				httpStatus: 0,
				taskId: 'task-2',
				zoneId: 'worker-zone',
			});
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(clear).toHaveBeenCalledTimes(1);
			expect(clear).toHaveBeenCalledWith('worker-zone', 'task-1');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('releases the destroy gate after close failures', async () => {
		const activeTask = createActiveWorkerTask('task-1', {
			host: '127.0.0.1',
			port: 18881,
		});
		const endZoneDestroy = vi.fn();
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn(async () => new Response('close failed', { status: 503 }));
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				activateReservation: vi.fn(),
				beginZoneDestroy: vi.fn(),
				clear: vi.fn(),
				countOccupiedForZone: vi.fn(() => 1),
				endZoneDestroy,
				get: vi.fn(),
				listForZone: vi.fn(() => [activeTask]),
				releaseReservation: vi.fn(),
				setWorkerIngress: vi.fn(),
				tryReserve: vi.fn(() => 'reservation-1'),
			},
			controllerGithubToken: null,
			controllerEpoch: workerControllerEpoch,
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: workerZone,
		});

		try {
			await expect(runtime.destroy(false)).rejects.toThrow(
				"worker close returned HTTP 503 for task 'task-1'",
			);
			expect(endZoneDestroy).toHaveBeenCalledWith('worker-zone');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('drains active worker tasks during controller shutdown', async () => {
		const activeTask = createActiveWorkerTask('task-1', {
			host: '127.0.0.1',
			port: 18881,
		});
		const beginZoneDestroy = vi.fn();
		const clear = vi.fn();
		const endZoneDestroy = vi.fn();
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchMock;
		const runtime = createWorkerZoneRuntime({
			activeTaskRegistry: {
				activateReservation: vi.fn(),
				beginZoneDestroy,
				clear,
				countOccupiedForZone: vi.fn(() => 1),
				endZoneDestroy,
				get: vi.fn(),
				listForZone: vi.fn(() => [activeTask]),
				releaseReservation: vi.fn(),
				setWorkerIngress: vi.fn(),
				tryReserve: vi.fn(() => 'reservation-1'),
			},
			controllerGithubToken: null,
			controllerEpoch: workerControllerEpoch,
			requestHeartbeatRegistry: {
				acquire: vi.fn(),
				release: vi.fn(),
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: workerZone,
		});

		try {
			await runtime.shutdown();

			expect(beginZoneDestroy).toHaveBeenCalledWith('worker-zone');
			expect(fetchMock).toHaveBeenCalledWith(
				'http://127.0.0.1:18881/tasks/task-1/close',
				expect.objectContaining({ method: 'POST' }),
			);
			expect(clear).toHaveBeenCalledWith('worker-zone', 'task-1');
			expect(endZoneDestroy).toHaveBeenCalledWith('worker-zone');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
