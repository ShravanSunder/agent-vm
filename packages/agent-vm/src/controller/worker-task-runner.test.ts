import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from '@shravansunder/gondolin-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

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
const effectiveWorkerConfigSchema = z.object({
	defaults: z
		.object({
			provider: z.string().optional(),
		})
		.optional(),
	branchPrefix: z.string().optional(),
	verification: z.array(z.object({ name: z.string() })).optional(),
});
const completedTaskStateSchema = z.object({
	status: z.literal('completed'),
});
const closedTaskStateSchema = z.object({
	status: z.literal('closed'),
});

function normalizeMockFilePath(filePath: Parameters<typeof fs.readFile>[0]): string {
	if (typeof filePath === 'string') {
		return filePath;
	}
	if (filePath instanceof URL) {
		return filePath.pathname;
	}
	if (filePath instanceof Uint8Array) {
		return Buffer.from(filePath).toString('utf8');
	}
	throw new Error('Unsupported file path type in fs.readFile mock.');
}

vi.mock('../gateway/gateway-zone-orchestrator.js', () => ({
	startGatewayZone: startGatewayZoneMock,
}));

vi.mock('./docker-service-routing.js', async (importOriginal) => {
	const original = await importOriginal<typeof import('./docker-service-routing.js')>();
	return {
		...original,
		startDockerServicesForTask: startDockerServicesForTaskMock,
		stopDockerServicesForTask: stopDockerServicesForTaskMock,
	};
});

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
				type: 'worker',
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

		const writtenConfig = effectiveWorkerConfigSchema.parse(
			JSON.parse(await fs.readFile(path.join(result.stateDir, 'effective-worker.json'), 'utf8')),
		);

		expect(writtenConfig.defaults?.provider).toBe('codex');
		expect(result.tcpHosts).toEqual({});
		expect(result.composeFilePaths).toEqual([]);
		expect(result.repos).toEqual([]);
	});

	it('clones repos into named workspace directories and merges primary repo config', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		startDockerServicesForTaskMock.mockResolvedValue({
			composeFilePaths: [],
			tcpHosts: {},
		});
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const originalReadFile = fs.readFile;
		vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, encoding) => {
			if (normalizeMockFilePath(filePath).endsWith('/frontend/.agent-vm/config.json')) {
				return JSON.stringify({
					branchPrefix: 'feature/',
					verification: [{ name: 'custom', command: 'pnpm custom-check' }],
				});
			}
			return await originalReadFile(filePath, encoding);
		});

		const { preStartGateway } = await import('./worker-task-runner.js');
		const result = await preStartGateway(
			{
				prompt: 'cross repo task',
				repos: [
					{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' },
					{ repoUrl: 'https://github.com/org/backend.git', baseBranch: 'develop' },
				],
				context: {},
			},
			zone,
		);

		expect(execaMock).toHaveBeenNthCalledWith(1, 'git', [
			'clone',
			'--branch',
			'main',
			'https://github.com/org/frontend.git',
			path.join(result.workspaceDir, 'frontend'),
		]);
		expect(execaMock).toHaveBeenNthCalledWith(2, 'git', [
			'clone',
			'--branch',
			'develop',
			'https://github.com/org/backend.git',
			path.join(result.workspaceDir, 'backend'),
		]);
		expect(result.repos).toEqual([
			{
				repoUrl: 'https://github.com/org/frontend.git',
				baseBranch: 'main',
				workspacePath: '/workspace/frontend',
			},
			{
				repoUrl: 'https://github.com/org/backend.git',
				baseBranch: 'develop',
				workspacePath: '/workspace/backend',
			},
		]);
		const writtenConfig = effectiveWorkerConfigSchema.parse(
			JSON.parse(await fs.readFile(path.join(result.stateDir, 'effective-worker.json'), 'utf8')),
		);
		expect(writtenConfig.branchPrefix).toBe('feature/');
		expect(writtenConfig.verification?.[0]?.name).toBe('custom');
	});

	it('throws on invalid project config instead of silently ignoring it', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		startDockerServicesForTaskMock.mockResolvedValue({
			composeFilePaths: [],
			tcpHosts: {},
		});
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const originalReadFile = fs.readFile;
		vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, encoding) => {
			if (normalizeMockFilePath(filePath).endsWith('/frontend/.agent-vm/config.json')) {
				return '{ not-valid-json';
			}
			return await originalReadFile(filePath, encoding);
		});

		const { preStartGateway } = await import('./worker-task-runner.js');

		await expect(
			preStartGateway(
				{
					prompt: 'cross repo task',
					repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
					context: {},
				},
				zone,
			),
		).rejects.toThrow('Invalid project config');
	});

	it('retries transient poll failures before giving up', async () => {
		startDockerServicesForTaskMock.mockResolvedValue({
			composeFilePaths: [],
			tcpHosts: {},
		});
		let pollCount = 0;
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
				pollCount += 1;
				if (pollCount === 1) {
					throw new Error('temporary network error');
				}
				const taskId = url.split('/').pop() ?? 'unknown-task';
				return new Response(JSON.stringify({ status: 'completed', taskId }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		}) as typeof fetch;

		const { runWorkerTask } = await import('./worker-task-runner.js');
		const result = await runWorkerTask({
			input: {
				prompt: 'fix login',
				repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
				context: {},
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zoneId: 'shravan',
			timeoutMs: 10_000,
		});

		expect(completedTaskStateSchema.parse(result.finalState).status).toBe('completed');
		expect(pollCount).toBeGreaterThanOrEqual(2);
	});

	it('fails immediately when the worker returns an invalid task status payload', async () => {
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
				return new Response(JSON.stringify({ wrong: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		}) as typeof fetch;

		const { runWorkerTask } = await import('./worker-task-runner.js');

		await expect(
			runWorkerTask({
				input: {
					prompt: 'fix login',
					repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
					context: {},
				},
				secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
				systemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow('did not match the expected schema');
	});

	it('treats closed worker tasks as terminal results', async () => {
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
				return new Response(JSON.stringify({ status: 'closed', taskId: 'task-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		}) as typeof fetch;

		const { runWorkerTask } = await import('./worker-task-runner.js');
		const result = await runWorkerTask({
			input: {
				prompt: 'fix login',
				repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
				context: {},
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zoneId: 'shravan',
		});

		expect(closedTaskStateSchema.parse(result.finalState).status).toBe('closed');
	});
});
