import { describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig, SystemConfig } from '../../config/system-config.js';
import type { ActiveWorkerTask } from '../active-task-registry.js';
import { createWorkerZoneRuntime } from './worker-zone-runtime.js';

const systemConfig = {
	cacheDir: './cache',
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
			websocketBypass: [],
		},
	],
	toolVmProfiles: {},
	tcpPool: { basePort: 19000, size: 5 },
} satisfies SystemConfig;

const loadedSystemConfig = {
	...systemConfig,
	systemConfigPath: '/tmp/system.json',
} satisfies LoadedSystemConfig;

const workerZone = systemConfig.zones[0];
if (!workerZone || workerZone.gateway.type !== 'worker') {
	throw new Error('Expected worker test zone.');
}

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

describe('createWorkerZoneRuntime destroy orchestration', () => {
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
});
