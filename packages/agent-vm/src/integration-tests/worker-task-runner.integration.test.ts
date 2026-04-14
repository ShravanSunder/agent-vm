import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { serve } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../../agent-vm-worker/src/server.js';
import type { SystemConfig } from '../config/system-config.js';

const startGatewayZoneMock = vi.fn();
const startDockerServicesForTaskMock = vi.fn(async () => ({
	composeFilePaths: [],
	tcpHosts: {},
}));
const stopDockerServicesForTaskMock = vi.fn(async () => {});

vi.mock('../gateway/gateway-zone-orchestrator.js', () => ({
	startGatewayZone: startGatewayZoneMock,
}));

vi.mock('../controller/docker-service-routing.js', () => ({
	startDockerServicesForTask: startDockerServicesForTaskMock,
	stopDockerServicesForTask: stopDockerServicesForTaskMock,
}));

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

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-task-runner-integration-'));
		workerPort = await findOpenPort();
		closeVmMock = vi.fn(async () => {});

		let activeTaskId: string | null = null;
		let currentStatus: 'pending' | 'completed' = 'pending';
		let receivedTaskBody: Record<string, unknown> | null = null;

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
								plan: { skills: [], maxReviewLoops: 1 },
								planReview: { skills: [] },
								work: { skills: [], maxReviewLoops: 1, maxVerificationRetries: 1 },
								workReview: { skills: [] },
								wrapup: { skills: [] },
							},
							mcpServers: [],
							verification: [{ name: 'test', command: 'pnpm test' }],
							verificationTimeoutMs: 300_000,
							wrapupActions: [],
							branchPrefix: 'agent/',
							commitCoAuthor: 'agent-vm-worker <noreply@agent-vm>',
							idleTimeoutMs: 1_800_000,
							stateDir: '/state',
						},
					},
					plan: null,
					lastContextError: null,
					lastDiffError: null,
					plannerThreadId: null,
					workThreadId: null,
					planReviewLoop: 0,
					workReviewLoop: 0,
					verificationAttempt: 0,
					lastReviewSummary: null,
					lastVerificationResults: null,
					wrapupResults: null,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				};
			},
			submitTask: async (input) => {
				receivedTaskBody = input as Record<string, unknown>;
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
				startCommand: 'node /opt/agent-vm-worker/dist/main.js serve --port 18789',
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

		Reflect.set(globalThis, '__receivedWorkerTaskBody', () => receivedTaskBody);
	});

	afterEach(async () => {
		startGatewayZoneMock.mockReset();
		startDockerServicesForTaskMock.mockReset();
		stopDockerServicesForTaskMock.mockReset();
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
		host: {
			controllerPort: 18800,
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
			},
		},
		images: {
			gateway: { buildConfig: '/tmp/gateway-build.json' },
			tool: { buildConfig: '/tmp/tool-build.json' },
		},
		zones: [
			{
				id: 'shravan',
				gateway: {
					type: 'coding',
					memory: '2G',
					cpus: 2,
					port: 18791,
					gatewayConfig: '',
					stateDir: '',
					workspaceDir: '',
				},
				secrets: {},
				allowedHosts: ['github.com'],
				websocketBypass: [],
				toolProfile: 'standard',
			},
		],
		toolProfiles: {
			standard: { memory: '1G', cpus: 1, workspaceRoot: '/tmp/tools' },
		},
		tcpPool: { basePort: 19000, size: 4 },
	} satisfies SystemConfig;

	it('posts to a real worker HTTP server, harvests the terminal state, and tears down the vm', async () => {
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		zone.gateway.gatewayConfig = path.join(tempDir, 'gateway-config.json');
		zone.gateway.stateDir = path.join(tempDir, 'state');
		zone.gateway.workspaceDir = path.join(tempDir, 'workspace');
		await fs.writeFile(zone.gateway.gatewayConfig, JSON.stringify({}));

		const { runWorkerTask } = await import('../controller/worker-task-runner.js');
		const result = await runWorkerTask({
			input: {
				prompt: 'fix login bug',
				repos: [],
				context: { ticket: 'INC-123' },
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zoneId: 'shravan',
			timeoutMs: 2_000,
		});

		expect(result.finalState).toMatchObject({
			status: 'completed',
			taskId: result.taskId,
		});
		expect(startGatewayZoneMock).toHaveBeenCalledTimes(1);
		expect(closeVmMock).toHaveBeenCalledTimes(1);
		const receivedTaskBody = (
			Reflect.get(globalThis, '__receivedWorkerTaskBody') as () => unknown
		)();
		expect(receivedTaskBody).toMatchObject({
			prompt: 'fix login bug',
			repos: [],
			context: { ticket: 'INC-123' },
		});
		await expect(fs.stat(result.taskRoot)).rejects.toThrow();
	});
});
