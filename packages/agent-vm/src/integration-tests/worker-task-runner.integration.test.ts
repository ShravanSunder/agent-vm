import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../../agent-vm-worker/src/server.js';
import type { ServerDeps } from '../../../agent-vm-worker/src/server.js';
import type { LoadedSystemConfig } from '../config/system-config.js';

const startGatewayZoneMock = vi.fn();
const startRepoResourceProvidersMock = vi.fn(async () => ({
	finalizations: [],
	startedProviders: [],
}));
const stopRepoResourceProvidersMock = vi.fn(async () => {});

vi.mock('../gateway/gateway-zone-orchestrator.js', () => ({
	startGatewayZone: startGatewayZoneMock,
}));

vi.mock('../resources/repo-resource-provider-runner.js', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('../resources/repo-resource-provider-runner.js')>();
	return {
		...original,
		startRepoResourceProviders: startRepoResourceProvidersMock,
		stopRepoResourceProviders: stopRepoResourceProvidersMock,
	};
});

function buildWorkerConfigInput(): Record<string, unknown> {
	return {
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
	};
}

async function findOpenPort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Could not determine port')));
				return;
			}
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(address.port);
			});
		});
	});
}

describe('worker-task-runner integration', () => {
	let tempDir: string;
	let server: { close: (cb?: () => void) => void } | null = null;
	let workerPort: number;
	let closeVmMock: ReturnType<typeof vi.fn>;
	let receivedTaskBody: Parameters<ServerDeps['submitTask']>[0] | null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-task-runner-integration-'));
		workerPort = await findOpenPort();
		closeVmMock = vi.fn(async () => {});

		let activeTaskId: string | null = null;
		let currentStatus: 'pending' | 'completed' = 'pending';
		receivedTaskBody = null;

		const app = createApp({
			getActiveTaskId: () => activeTaskId,
			getActiveTaskStatus: () => currentStatus,
			getTaskState: (taskId) => {
				if (taskId !== activeTaskId && currentStatus !== 'completed') {
					return undefined;
				}
				return {
					taskId,
					status: currentStatus,
					config: {
						taskId,
						prompt: 'fix login',
						repos: [],
						context: {},
						effectiveConfig: {
							defaults: { provider: 'codex', model: 'latest-medium' },
							phases: {
								plan: {
									skills: [],
									cycle: { kind: 'review', cycleCount: 1 },
									agentInstructions: null,
									reviewerInstructions: null,
									agentTurnTimeoutMs: 900_000,
									reviewerTurnTimeoutMs: 900_000,
								},
								work: {
									skills: [],
									cycle: { kind: 'review', cycleCount: 1 },
									agentInstructions: null,
									reviewerInstructions: null,
									agentTurnTimeoutMs: 2_700_000,
									reviewerTurnTimeoutMs: 900_000,
								},
								wrapup: { skills: [], instructions: null, turnTimeoutMs: 900_000 },
							},
							mcpServers: [],
							verification: [{ name: 'test', command: 'pnpm test' }],
							verificationTimeoutMs: 300_000,
							branchPrefix: 'agent/',
							runtimeInstructions: 'Generated runtime instructions.',
							commonAgentInstructions: null,
							stateDir: '/state',
						},
					},
					plan: null,
					lastContextError: null,
					planAgentThreadId: null,
					planReviewerThreadId: null,
					workAgentThreadId: null,
					workReviewerThreadId: null,
					wrapupThreadId: null,
					planReviewCycle: 0,
					workReviewCycle: 0,
					currentCycle: 0,
					currentMaxCycles: 0,
					lastPlanReview: null,
					lastWorkReview: null,
					lastValidationResults: null,
					failureReason: null,
					wrapupResult: null,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
			},
			submitTask: async (input) => {
				receivedTaskBody = input;
				activeTaskId = input.taskId;
				currentStatus = 'pending';
				setTimeout(() => {
					currentStatus = 'completed';
				}, 50);
				return { taskId: input.taskId, status: 'accepted' as const };
			},
			closeTask: async () => ({ status: 'closed' as const }),
			getUptime: () => 100,
			getExecutorInfo: () => ({ provider: 'codex', model: 'gpt-5.4-low' }),
		});

		server = serve({ fetch: app.fetch, port: workerPort });
		startGatewayZoneMock.mockResolvedValue({
			image: { built: true, fingerprint: 'gateway', imagePath: '/tmp/gateway.img' },
			ingress: { host: '127.0.0.1', port: workerPort },
			processSpec: {
				bootstrapCommand: 'true',
				startCommand:
					'agent-vm-worker serve --port 18789 --config /state/effective-worker.json --state-dir /state',
				healthCheck: { type: 'http', port: 18789, path: '/health' },
				guestListenPort: 18789,
				logPath: '/tmp/worker.log',
			},
			vm: {
				id: 'worker-vm-1',
				close: closeVmMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: workerPort })),
				enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222, user: 'root' })),
				exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
				setIngressRoutes: vi.fn(),
				getVmInstance: vi.fn(),
			},
			zone: systemConfig.zones[0],
		});
	});

	afterEach(async () => {
		startGatewayZoneMock.mockReset();
		startRepoResourceProvidersMock.mockReset();
		startRepoResourceProvidersMock.mockResolvedValue({
			finalizations: [],
			startedProviders: [],
		});
		stopRepoResourceProvidersMock.mockReset();
		if (server) {
			await new Promise<void>((resolve) => {
				server?.close(() => resolve());
			});
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	const systemConfig = {
		cacheDir: '/tmp/cache',
		runtimeDir: '/tmp/runtime',
		systemConfigPath: '/tmp/config/system.json',
		systemCacheIdentifierPath: '/tmp/config/systemCacheIdentifier.json',
		host: {
			controllerPort: 18800,
			projectNamespace: 'claw-tests-a1b2c3d4',
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
			},
		},
		imageProfiles: {
			gateways: {
				openclaw: { type: 'openclaw', buildConfig: '/tmp/gateway-build.json' },
				worker: { type: 'worker', buildConfig: '/tmp/gateway-build.json' },
			},
			toolVms: {
				default: { type: 'toolVm', buildConfig: '/tmp/tool-build.json' },
			},
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
					config: '',
					stateDir: '',
				},
				secrets: {},
				allowedHosts: ['github.com'],
				websocketBypass: [],
				toolProfile: 'standard',
			},
		],
		toolProfiles: {
			standard: { memory: '1G', cpus: 1, workspaceRoot: '/tmp/tools', imageProfile: 'default' },
		},
		tcpPool: { basePort: 19000, size: 4 },
	} satisfies LoadedSystemConfig;

	it('posts to a real worker HTTP server, harvests the terminal state, and tears down the vm', async () => {
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		zone.gateway.config = path.join(tempDir, 'gateway-config.json');
		zone.gateway.stateDir = path.join(tempDir, 'state');
		systemConfig.runtimeDir = path.join(tempDir, 'runtime');
		await fs.writeFile(zone.gateway.config, JSON.stringify(buildWorkerConfigInput()));

		const { executeWorkerTask, prepareWorkerTask } =
			await import('../controller/worker-task-runner.js');
		const prepared = await prepareWorkerTask({
			input: {
				requestTaskId: 'request-task-1',
				prompt: 'fix login bug',
				repos: [],
				context: { ticket: 'INC-123' },
			},
			systemConfig,
			zoneId: 'shravan',
		});
		const result = await executeWorkerTask(prepared, {
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			timeoutMs: 2_000,
		});

		expect(result.finalState).toMatchObject({
			status: 'completed',
			taskId: result.taskId,
		});
		expect(startGatewayZoneMock).toHaveBeenCalledTimes(1);
		expect(closeVmMock).toHaveBeenCalledTimes(1);
		expect(receivedTaskBody).toMatchObject({
			prompt: 'fix login bug',
			repos: [],
			context: { ticket: 'INC-123' },
		});
		await expect(fs.stat(result.taskRoot)).resolves.toBeDefined();
		await expect(fs.stat(path.join(result.taskRoot, 'state'))).resolves.toBeDefined();
		await expect(
			fs.stat(path.join(systemConfig.runtimeDir, 'worker-tasks', 'shravan', result.taskId)),
		).rejects.toThrow();
	});
});
