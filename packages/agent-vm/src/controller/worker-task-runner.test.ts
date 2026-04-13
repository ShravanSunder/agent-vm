import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from 'gondolin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';

const startGatewayZoneMock = vi.fn();
const stopDockerServicesForTaskMock = vi.fn();
const startDockerServicesForTaskMock = vi.fn<
	() => Promise<{ composeFilePaths: readonly string[]; tcpHosts: Record<string, string> }>
>(async () => ({
	composeFilePaths: [],
	tcpHosts: {},
}));
const execaMock = vi.fn();

vi.mock('../gateway/gateway-zone-orchestrator.js', () => ({
	startGatewayZone: startGatewayZoneMock,
}));

vi.mock('./docker-service-routing.js', () => ({
	startDockerServicesForTask: startDockerServicesForTaskMock,
	stopDockerServicesForTask: stopDockerServicesForTaskMock,
}));

vi.mock('execa', () => ({
	execa: execaMock,
}));

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

describe('worker-task-runner', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-runner-'));
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		zone.gateway.gatewayConfig = path.join(tempDir, 'gateway-config.json');
		zone.gateway.stateDir = path.join(tempDir, 'state');
		zone.gateway.workspaceDir = path.join(tempDir, 'workspace');
		await fs.writeFile(
			zone.gateway.gatewayConfig,
			JSON.stringify({
				defaults: { provider: 'codex', model: 'latest-medium' },
				phases: {},
				mcpServers: [],
				verification: [{ name: 'test', command: 'pnpm test' }],
				wrapupActions: [{ type: 'git-pr', required: true }],
				branchPrefix: 'agent/',
				commitCoAuthor: 'agent-vm-worker <noreply@agent-vm>',
				idleTimeoutMs: 1_800_000,
				stateDir: '/state',
			}),
		);

		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith('/tasks')) {
				return new Response(JSON.stringify({ status: 'accepted', taskId: 'task-1' }), {
					status: 201,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (/\/tasks\/[^/]+$/.test(url)) {
				const taskId = url.split('/').pop() ?? 'unknown-task';
				return new Response(JSON.stringify({ status: 'completed', taskId }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		}) as typeof fetch;

		const managedVm: ManagedVm = {
			id: 'worker-vm-1',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222, user: 'root' })),
			exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(),
		};

		startGatewayZoneMock.mockResolvedValue({
			image: { built: true, fingerprint: 'gateway', imagePath: '/tmp/gateway.img' },
			ingress: { host: '127.0.0.1', port: 18791 },
			processSpec: {
				bootstrapCommand: 'true',
				startCommand: 'node /opt/agent-vm-worker/dist/main.js serve --port 18789',
				healthCheck: { type: 'http', port: 18789, path: '/health' },
				guestListenPort: 18789,
				logPath: '/tmp/worker.log',
			},
			vm: managedVm,
			zone,
		});
	});

	afterEach(() => {
		vi.resetModules();
		startGatewayZoneMock.mockReset();
		startDockerServicesForTaskMock.mockReset();
		stopDockerServicesForTaskMock.mockReset();
		execaMock.mockReset();
		vi.restoreAllMocks();
	});

	it('merges docker tcp hosts into the per-task gateway boot', async () => {
		startDockerServicesForTaskMock.mockImplementation(async () => ({
			composeFilePaths: ['/tmp/task/.agent-vm/docker-compose.yml'],
			tcpHosts: {
				'postgres.local:5432': '172.30.0.10:5432',
			},
		}));
		const { runWorkerTask } = await import('./worker-task-runner.js');

		await runWorkerTask({
			input: {
				prompt: 'fix login',
				repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
				context: {},
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zoneId: 'shravan',
		});

		expect(startGatewayZoneMock).toHaveBeenCalledWith(
			expect.objectContaining({
				tcpHostsOverride: {
					'postgres.local:5432': '172.30.0.10:5432',
				},
			}),
		);
		expect(stopDockerServicesForTaskMock).toHaveBeenCalledWith([
			'/tmp/task/.agent-vm/docker-compose.yml',
		]);
	});

	it('writes effective worker config into per-task state during pre-start', async () => {
		const { preStartGateway } = await import('./worker-task-runner.js');
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const result = await preStartGateway(
			{
				prompt: 'fix login',
				repos: [],
				context: {},
			},
			zone,
		);

		const writtenConfig = JSON.parse(
			await fs.readFile(path.join(result.stateDir, 'effective-worker.json'), 'utf8'),
		) as { defaults?: { provider?: string } };

		expect(writtenConfig.defaults?.provider).toBe('codex');
		expect(result.tcpHosts).toEqual({});
		expect(result.composeFilePaths).toEqual([]);
		expect(result.repos).toEqual([]);
	});
});
