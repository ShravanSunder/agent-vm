import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { workerConfigSchema } from '@agent-vm/agent-vm-worker';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig } from '../config/system-config.js';
import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';
import type { PreparedWorkerTask, WorkerTaskPollClock } from './worker-task-runner.js';

const startGatewayZoneMock = vi.fn();
const stopRepoResourceProvidersMock =
	vi.fn<typeof import('../resources/repo-resource-provider-runner.js').stopRepoResourceProviders>();

vi.mock('../gateway/gateway-zone-orchestrator.js', () => ({
	startGatewayZone: startGatewayZoneMock,
}));

vi.mock('../resources/repo-resource-provider-runner.js', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('../resources/repo-resource-provider-runner.js')>();
	return {
		...original,
		stopRepoResourceProviders: stopRepoResourceProvidersMock,
	};
});

const workerConfig = workerConfigSchema.parse({
	runtimeInstructions: 'Follow the task.',
	commonAgentInstructions: null,
	defaults: { provider: 'codex', model: 'latest-medium' },
	phases: {
		plan: {
			cycle: { kind: 'review', cycleCount: 1 },
			agentInstructions: null,
			reviewerInstructions: null,
			skills: [],
		},
		work: {
			cycle: { kind: 'review', cycleCount: 1 },
			agentInstructions: null,
			reviewerInstructions: null,
			skills: [],
		},
		wrapup: { instructions: null, skills: [] },
	},
	mcpServers: [],
	verification: [{ name: 'test', command: 'pnpm test' }],
	branchPrefix: 'agent/',
	stateDir: '/state',
});

const systemConfig = {
	schemaVersion: 1,
	cacheDir: '/tmp/cache',
	runtimeDir: '/tmp/runtime',
	systemConfigPath: '/tmp/config/system.json',
	host: {
		controllerPort: 18800,
		projectNamespace: 'worker-timeout-test',
	},
	imageProfiles: {
		gateways: {
			worker: { type: 'worker', buildConfig: '/tmp/gateway-build.json' },
		},
		toolVms: {},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'worker',
				imageProfile: 'worker',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: '/tmp/worker-config.json',
				stateDir: '/tmp/worker-state',
			},
			secrets: {},
			runtimeAuthHints: [],
			egressHosts: ['github.com'].map((host) => ({ host, audience: 'gateway' as const })),
			websocketBypass: [],
		},
	],
	toolVmProfiles: {},
	tcpPool: { basePort: 19000, size: 4 },
} satisfies LoadedSystemConfig;

function requireWorkerZone(): LoadedSystemConfig['zones'][number] {
	const zone = systemConfig.zones[0];
	if (!zone || zone.gateway.type !== 'worker') {
		throw new Error('Expected worker zone.');
	}
	return zone;
}

function createAbortError(): DOMException {
	return new DOMException('The operation was aborted.', 'AbortError');
}

function createAbortableNeverResponse(signal: AbortSignal | null | undefined): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		if (!signal) {
			return;
		}
		if (signal.aborted) {
			reject(createAbortError());
			return;
		}
		signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
	});
}

async function flushAsyncWork(): Promise<void> {
	for (let index = 0; index < 5; index += 1) {
		// oxlint-disable-next-line eslint/no-await-in-loop
		await Promise.resolve();
	}
}

async function waitForObservedPollSignals(
	pollSignals: readonly AbortSignal[],
	expectedCount: number,
): Promise<void> {
	for (let index = 0; index < 20; index += 1) {
		if (pollSignals.length >= expectedCount) {
			return;
		}
		// oxlint-disable-next-line eslint/no-await-in-loop
		await flushAsyncWork();
		// oxlint-disable-next-line eslint/no-await-in-loop
		await vi.advanceTimersByTimeAsync(0);
	}
	throw new Error(
		`Expected ${String(expectedCount)} poll signal(s), saw ${String(pollSignals.length)}.`,
	);
}

function createInstantPollClock(): WorkerTaskPollClock {
	return {
		now: () => 0,
		sleep: async (): Promise<void> => {},
	};
}

function createPreparedWorkerTask(tempDir: string): PreparedWorkerTask {
	const zone = requireWorkerZone();
	const taskId = 'worker-task-1';
	const taskRoot = path.join(tempDir, 'tasks', taskId);
	const taskRuntimeRoot = path.join(tempDir, 'runtime', 'worker-tasks', zone.id, taskId);
	const input = {
		requestTaskId: 'request-task-1',
		prompt: 'fix login',
		repos: [],
		context: {},
		resources: { externalResources: {} },
	};
	return {
		taskId,
		taskRoot,
		zoneId: zone.id,
		input,
		preStartResult: {
			taskId,
			input,
			taskRoot,
			taskRuntimeRoot,
			workDir: path.join(taskRuntimeRoot, 'work'),
			stateDir: path.join(taskRoot, 'state'),
			startedResourceProviders: [],
			environment: {},
			tcpHosts: {},
			vfsMounts: {},
			repos: [],
			effectiveConfig: workerConfig,
		},
		taskZoneConfig: zone,
		zone,
		eventLogPath: path.join(taskRoot, 'state', 'tasks', `${taskId}.jsonl`),
		recordEvent: async (): Promise<void> => {},
	};
}

describe('executeWorkerTask worker HTTP timeouts', () => {
	let tempDir: string;
	let managedVmCloseMock: Mock<() => Promise<void>>;
	let originalFetch: typeof fetch;

	beforeEach(async () => {
		vi.useFakeTimers();
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-http-timeout-'));
		systemConfig.runtimeDir = path.join(tempDir, 'runtime');
		const zone = requireWorkerZone();
		zone.gateway.stateDir = path.join(tempDir, 'state');
		managedVmCloseMock = vi.fn(async (): Promise<void> => {});
		const managedVm = {
			id: 'worker-vm-1',
			close: async () => await managedVmCloseMock(),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222, user: 'root' })),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: () => null,
			getVmInstance: vi.fn(),
		} satisfies ManagedVm;
		startGatewayZoneMock.mockResolvedValue({
			image: { built: true, fingerprint: 'gateway', imagePath: '/tmp/gateway.img' },
			ingress: { host: '127.0.0.1', port: 18791 },
			processSpec: {
				bootstrapCommand: 'true',
				startCommand: 'agent-vm-worker serve --port 18789',
				healthCheck: { type: 'http', port: 18789, path: '/health' },
				guestListenPort: 18789,
				logPath: '/tmp/worker.log',
			},
			vm: managedVm,
			zone,
		});
		stopRepoResourceProvidersMock.mockResolvedValue(undefined);
		originalFetch = globalThis.fetch;
	});

	afterEach(async () => {
		globalThis.fetch = originalFetch;
		startGatewayZoneMock.mockReset();
		stopRepoResourceProvidersMock.mockReset();
		await fs.rm(tempDir, { force: true, recursive: true });
		vi.useRealTimers();
	});

	it('aborts a hung task submission and runs cleanup', async () => {
		const { executeWorkerTask } = await import('./worker-task-runner.js');
		let submitSignal: AbortSignal | null | undefined;
		globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith('/tasks')) {
				submitSignal = init?.signal;
				return createAbortableNeverResponse(submitSignal);
			}
			throw new Error(`Unexpected fetch ${url}`);
		}) as typeof fetch;

		const task = executeWorkerTask(createPreparedWorkerTask(tempDir), {
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
		});
		const taskError = expect(task).rejects.toThrow(/POST .*\/tasks timed out after 30000ms/u);
		await flushAsyncWork();

		expect(submitSignal).toBeInstanceOf(AbortSignal);
		await vi.advanceTimersByTimeAsync(30_000);
		await taskError;
		expect(managedVmCloseMock).toHaveBeenCalledTimes(1);
		expect(stopRepoResourceProvidersMock).toHaveBeenCalledWith([]);
	});

	it('counts hung poll requests toward consecutive poll failures', async () => {
		const { executeWorkerTask } = await import('./worker-task-runner.js');
		const pollSignals: AbortSignal[] = [];
		globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith('/tasks')) {
				return Promise.resolve(
					new Response(JSON.stringify({ status: 'accepted', taskId: 'worker-task-1' }), {
						status: 201,
						headers: { 'content-type': 'application/json' },
					}),
				);
			}
			if (/\/tasks\/[^/]+$/.test(url)) {
				if (init?.signal) {
					pollSignals.push(init.signal);
				}
				return createAbortableNeverResponse(init?.signal);
			}
			throw new Error(`Unexpected fetch ${url}`);
		}) as typeof fetch;

		const task = executeWorkerTask(createPreparedWorkerTask(tempDir), {
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			pollClock: createInstantPollClock(),
			pollIntervalMs: 1,
			timeoutMs: 60_000,
		});
		const taskError = expect(task).rejects.toThrow(/status polling failed 3 consecutive times/u);

		await waitForObservedPollSignals(pollSignals, 1);
		await vi.advanceTimersByTimeAsync(10_000);
		await waitForObservedPollSignals(pollSignals, 2);
		await vi.advanceTimersByTimeAsync(10_000);
		await waitForObservedPollSignals(pollSignals, 3);
		await vi.advanceTimersByTimeAsync(10_000);
		await taskError;
		expect(pollSignals).toHaveLength(3);
		expect(managedVmCloseMock).toHaveBeenCalledTimes(1);
	});
});
