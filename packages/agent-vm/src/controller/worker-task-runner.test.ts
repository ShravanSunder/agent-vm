import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { LoadedSystemConfig } from '../config/system-config.js';
import type { WorkerTaskInput } from './worker-task-runner.js';

const startGatewayZoneMock = vi.fn();
const stopRepoResourceProvidersMock =
	vi.fn<typeof import('../resources/repo-resource-provider-runner.js').stopRepoResourceProviders>();
const startRepoResourceProvidersMock = vi.fn<
	typeof import('../resources/repo-resource-provider-runner.js').startRepoResourceProviders
>(async () => ({
	finalizations: [],
	startedProviders: [],
}));
const loadRepoResourceDescriptionContractMock = vi.fn<
	typeof import('../resources/repo-resource-contract-loader.js').loadRepoResourceDescriptionContract
>(async () => ({
	setupCommand: '.agent-vm/run-setup.sh',
	requires: {},
	provides: {},
}));
const hasRepoResourceDescriptionContractMock = vi.fn<
	typeof import('../resources/repo-resource-contract-loader.js').hasRepoResourceDescriptionContract
>(async () => true);
const execaMock = vi.fn();
const effectiveWorkerConfigSchema = z.object({
	runtimeInstructions: z.string(),
	commonAgentInstructions: z.string().nullable().optional(),
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

function buildWorkerConfigInput(): Record<string, unknown> {
	return {
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
	};
}

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

vi.mock('../resources/repo-resource-provider-runner.js', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('../resources/repo-resource-provider-runner.js')>();
	return {
		...original,
		startRepoResourceProviders: startRepoResourceProvidersMock,
		stopRepoResourceProviders: stopRepoResourceProvidersMock,
	};
});

vi.mock('../resources/repo-resource-contract-loader.js', async (importOriginal) => {
	const original =
		await importOriginal<typeof import('../resources/repo-resource-contract-loader.js')>();
	return {
		...original,
		hasRepoResourceDescriptionContract: hasRepoResourceDescriptionContractMock,
		loadRepoResourceDescriptionContract: loadRepoResourceDescriptionContractMock,
	};
});

vi.mock('execa', () => ({
	execa: execaMock,
}));

const systemConfig = {
	cacheDir: '/tmp/cache',
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
				workspaceDir: '',
			},
			secrets: {},
			runtimeAuthHints: [],
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

async function executePreparedWorkerTaskForTest(options: {
	readonly input: WorkerTaskInput;
	readonly secretResolver: { resolve: () => Promise<string>; resolveAll: () => Promise<{}> };
	readonly systemConfig: LoadedSystemConfig;
	readonly zoneId: string;
	readonly timeoutMs?: number;
}): Promise<{
	readonly taskId: string;
	readonly finalState: unknown;
	readonly taskRoot: string;
}> {
	const { executeWorkerTask, prepareWorkerTask } = await import('./worker-task-runner.js');
	const prepared = await prepareWorkerTask({
		input: options.input,
		systemConfig: options.systemConfig,
		zoneId: options.zoneId,
	});
	return await executeWorkerTask(prepared, {
		secretResolver: options.secretResolver,
		systemConfig: options.systemConfig,
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
	});
}

describe('worker-task-runner', () => {
	let tempDir: string;
	let managedVm: ManagedVm;
	let managedVmCloseMock: Mock<() => Promise<void>>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-runner-'));
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		zone.gateway.config = path.join(tempDir, 'gateway-config.json');
		zone.gateway.stateDir = path.join(tempDir, 'state');
		zone.gateway.workspaceDir = path.join(tempDir, 'workspace');
		await fs.writeFile(zone.gateway.config, JSON.stringify(buildWorkerConfigInput()));

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

		managedVmCloseMock = vi.fn(async (): Promise<void> => {});
		managedVm = {
			id: 'worker-vm-1',
			close: async () => await managedVmCloseMock(),
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
				startCommand:
					'agent-vm-worker serve --port 18789 --config /state/effective-worker.json --state-dir /state',
				healthCheck: { type: 'http', port: 18789, path: '/health' },
				guestListenPort: 18789,
				logPath: '/tmp/worker.log',
			},
			vm: managedVm,
			zone,
		});
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
	});

	afterEach(() => {
		delete process.env.AGENT_VM_WORKER_TARBALL_PATH;
		vi.resetModules();
		startGatewayZoneMock.mockReset();
		startRepoResourceProvidersMock.mockReset();
		startRepoResourceProvidersMock.mockResolvedValue({
			finalizations: [],
			startedProviders: [],
		});
		loadRepoResourceDescriptionContractMock.mockReset();
		hasRepoResourceDescriptionContractMock.mockReset();
		hasRepoResourceDescriptionContractMock.mockResolvedValue(true);
		loadRepoResourceDescriptionContractMock.mockResolvedValue({
			setupCommand: '.agent-vm/run-setup.sh',
			requires: {},
			provides: {},
		});
		stopRepoResourceProvidersMock.mockReset();
		execaMock.mockReset();
		vi.restoreAllMocks();
	});

	it('merges resource overlays into the per-task gateway boot', async () => {
		await executePreparedWorkerTaskForTest({
			input: {
				requestTaskId: 'request-task-1',
				prompt: 'fix login',
				repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
				context: {},
				resources: {
					externalResources: {
						pg: {
							name: 'pg',
							binding: { host: 'postgres.local', port: 5432 },
							target: { host: '172.30.0.10', port: 5432 },
							env: { DATABASE_URL: 'postgres://postgres.local:5432/app' },
						},
					},
				},
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
				environmentOverride: {
					DATABASE_URL: 'postgres://postgres.local:5432/app',
				},
			}),
		);
	});

	it('writes effective worker config into per-task state during pre-start', async () => {
		const { preStartGateway } = await import('./worker-task-runner.js');
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const result = await preStartGateway(
			{
				requestTaskId: 'request-task-1',
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
		expect(result.startedResourceProviders).toEqual([]);
		expect(result.repos).toEqual([]);
	});

	it('removes the task root when pre-start fails while copying the local worker tarball', async () => {
		const { preStartGateway } = await import('./worker-task-runner.js');
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		process.env.AGENT_VM_WORKER_TARBALL_PATH = path.join(tempDir, 'missing-worker.tgz');

		await expect(
			preStartGateway(
				{
					requestTaskId: 'request-task-1',
					prompt: 'fix login',
					repos: [],
					context: {},
				},
				zone,
			),
		).rejects.toThrow(/missing-worker\.tgz/u);

		await expect(fs.readdir(path.join(zone.gateway.stateDir, 'tasks'))).resolves.toEqual([]);
	});

	it('resolves common agent instructions and writes generated runtime files', async () => {
		const { preStartGateway } = await import('./worker-task-runner.js');
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		await fs.mkdir(path.join(tempDir, 'prompts'), { recursive: true });
		await fs.writeFile(
			path.join(tempDir, 'prompts', 'common-agent-instructions.md'),
			'common from markdown\n',
			'utf8',
		);
		await fs.writeFile(
			zone.gateway.config,
			JSON.stringify({
				...buildWorkerConfigInput(),
				commonAgentInstructions: { path: './prompts/common-agent-instructions.md' },
			}),
			'utf8',
		);

		const result = await preStartGateway(
			{
				requestTaskId: 'request-task-1',
				prompt: 'fix login',
				repos: [],
				context: {},
			},
			zone,
		);

		const writtenConfig = effectiveWorkerConfigSchema.parse(
			JSON.parse(await fs.readFile(path.join(result.stateDir, 'effective-worker.json'), 'utf8')),
		);
		expect(writtenConfig.commonAgentInstructions).toBe('common from markdown\n');
		expect(writtenConfig.runtimeInstructions).toContain('Runtime instructions');
		expect(writtenConfig.runtimeInstructions).toContain('/workspace');
		expect(writtenConfig.runtimeInstructions).toContain('/agent-vm/agents.md');
		await expect(
			fs.readFile(path.join(result.workspaceDir, 'AGENTS.md'), 'utf8'),
		).resolves.toContain('/agent-vm/agents.md');
		await expect(
			fs.readFile(path.join(result.taskRoot, 'agent-vm', 'runtime-instructions.md'), 'utf8'),
		).resolves.toBe(writtenConfig.runtimeInstructions);
		await expect(
			fs.readFile(path.join(result.taskRoot, 'agent-vm', 'agents.md'), 'utf8'),
		).resolves.toContain('/agent-vm/runtime-instructions.md');
		await expect(fs.readlink(path.join(result.workspaceDir, 'CLAUDE.md'))).resolves.toBe(
			'AGENTS.md',
		);
		await expect(fs.readlink(path.join(result.taskRoot, 'agent-vm', 'CLAUDE.md'))).resolves.toBe(
			'agents.md',
		);
		expect(result.vfsMounts['/agent-vm']).toEqual(
			expect.objectContaining({ kind: 'realfs-readonly' }),
		);
	});

	it('clones repos into named workspace directories and merges primary repo config', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
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
				requestTaskId: 'request-task-1',
				prompt: 'cross repo task',
				repos: [
					{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' },
					{ repoUrl: 'https://github.com/org/backend.git', baseBranch: 'develop' },
				],
				context: {},
			},
			zone,
		);

		expect(execaMock).toHaveBeenNthCalledWith(
			1,
			'git',
			[
				'clone',
				'--branch',
				'main',
				'https://github.com/org/frontend.git',
				path.join(result.workspaceDir, 'frontend'),
			],
			expect.objectContaining({ timeout: 120_000 }),
		);
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			[
				'clone',
				'--branch',
				'develop',
				'https://github.com/org/backend.git',
				path.join(result.workspaceDir, 'backend'),
			],
			expect.objectContaining({ timeout: 120_000 }),
		);
		expect(result.repos).toEqual([
			{
				repoId: 'frontend',
				repoUrl: 'https://github.com/org/frontend.git',
				baseBranch: 'main',
				hostWorkspacePath: path.join(result.workspaceDir, 'frontend'),
				workspacePath: '/workspace/frontend',
			},
			{
				repoId: 'backend',
				repoUrl: 'https://github.com/org/backend.git',
				baseBranch: 'develop',
				hostWorkspacePath: path.join(result.workspaceDir, 'backend'),
				workspacePath: '/workspace/backend',
			},
		]);
		const writtenConfig = effectiveWorkerConfigSchema.parse(
			JSON.parse(await fs.readFile(path.join(result.stateDir, 'effective-worker.json'), 'utf8')),
		);
		expect(writtenConfig.branchPrefix).toBe('feature/');
		expect(writtenConfig.verification?.[0]?.name).toBe('custom');
	});

	it('derives docker-safe lowercase repo IDs from repo URLs', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { preStartGateway } = await import('./worker-task-runner.js');
		const result = await preStartGateway(
			{
				requestTaskId: 'request-task-1',
				prompt: 'cross repo task',
				repos: [
					{ repoUrl: 'https://github.com/Org/Repo.Dir.git', baseBranch: 'main' },
					{ repoUrl: 'https://github.com/Org/Repo Dir.git', baseBranch: 'main' },
				],
				context: {},
			},
			zone,
		);

		expect(result.repos.map((repo) => repo.repoId)).toEqual(['repo-dir', 'repo-dir-2']);
		expect(result.repos.map((repo) => repo.workspacePath)).toEqual([
			'/workspace/repo-dir',
			'/workspace/repo-dir-2',
		]);
	});

	it('resolves a shared repo resource once across multiple repos', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		loadRepoResourceDescriptionContractMock.mockImplementation(async ({ repoId }) =>
			repoId === 'frontend'
				? {
						setupCommand: '.agent-vm/run-setup.sh',
						requires: {
							pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
						},
						provides: {
							pg: {
								type: 'compose',
								service: 'pg',
							},
						},
					}
				: {
						setupCommand: '.agent-vm/run-setup.sh',
						requires: {
							pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
						},
						provides: {
							pg: {
								type: 'compose',
								service: 'pg',
							},
						},
					},
		);
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { preStartGateway } = await import('./worker-task-runner.js');
		await preStartGateway(
			{
				requestTaskId: 'request-task-1',
				prompt: 'cross repo pg task',
				repos: [
					{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' },
					{ repoUrl: 'https://github.com/org/backend.git', baseBranch: 'main' },
				],
				context: {},
			},
			zone,
		);

		const providerCall = startRepoResourceProvidersMock.mock.calls[0]?.[0];
		if (!providerCall) {
			throw new Error('Expected repo resource providers to start.');
		}
		expect(providerCall?.repos).toHaveLength(2);
		expect(providerCall?.repos).toEqual([
			expect.objectContaining({
				repoId: 'frontend',
				repoDir: expect.stringMatching(/\/workspace\/frontend$/u),
				outputDir: expect.stringMatching(/\/state\/tasks\/[^/]+\/agent-vm\/resources\/frontend$/u),
			}),
			expect.objectContaining({
				repoId: 'backend',
				repoDir: expect.stringMatching(/\/workspace\/backend$/u),
				outputDir: expect.stringMatching(/\/state\/tasks\/[^/]+\/agent-vm\/resources\/backend$/u),
			}),
		]);
		expect(providerCall?.providers).toHaveLength(1);
		expect(providerCall?.providers[0]).toMatchObject({
			repoId: 'frontend',
			repoDir: expect.stringMatching(/\/workspace\/frontend$/u),
			outputDir: expect.stringMatching(/\/state\/tasks\/[^/]+\/agent-vm\/resources\/frontend$/u),
			resourceName: 'pg',
			provider: { service: 'pg' },
			binding: { host: 'pg.local', port: 5432 },
		});
	});

	it('reports pre-start cleanup failures without hiding the original resource error', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		const startedProvider = {
			composeFilePath: '/tmp/task/.agent-vm/docker-compose.yml',
			composeProjectName: 'agent-vm-task-prestart-failed-repo-a',
			repoDir: '/tmp/task',
			repoId: 'repo-a',
		};
		startRepoResourceProvidersMock.mockResolvedValue({
			finalizations: [
				{
					repoId: 'repo-a',
					outputDir: '/tmp/task/resources/repo-a',
					final: {
						resources: {
							pg: {
								binding: { host: 'pg.local', port: 5432 },
								target: { host: '172.30.0.8', port: 5432 },
								env: { PATH: '/tmp/fake-bin' },
							},
						},
						generated: [],
					},
				},
			],
			startedProviders: [startedProvider],
		});
		stopRepoResourceProvidersMock.mockRejectedValue(new Error('compose cleanup failed'));
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const zoneWithResources = {
			...zone,
			resources: { allowRepoResources: true },
		};

		const { preStartGateway } = await import('./worker-task-runner.js');
		await expect(
			preStartGateway(
				{
					requestTaskId: 'request-task-1',
					prompt: 'cross repo pg task',
					repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
					context: {},
				},
				zoneWithResources,
			),
		).rejects.toMatchObject({
			errors: [
				expect.objectContaining({ message: expect.stringContaining('reserved environment key') }),
				expect.objectContaining({ message: 'compose cleanup failed' }),
			],
		});
	});

	it('clones repos without auth config args when githubToken is omitted', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { preStartGateway } = await import('./worker-task-runner.js');
		await preStartGateway(
			{
				requestTaskId: 'request-task-1',
				prompt: 'clone public repo',
				repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
				context: {},
			},
			zone,
		);

		expect(execaMock).toHaveBeenCalledWith(
			'git',
			[
				'clone',
				'--branch',
				'main',
				'https://github.com/org/frontend.git',
				expect.stringContaining('/frontend'),
			],
			expect.objectContaining({ timeout: 120_000 }),
		);
	});

	it('clones repos with one-shot GitHub auth config args when githubToken is provided', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { preStartGateway } = await import('./worker-task-runner.js');
		await preStartGateway(
			{
				requestTaskId: 'request-task-1',
				prompt: 'clone private repo',
				repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
				context: {},
			},
			zone,
			{ githubToken: 'ghp_secret-token' },
		);

		const cloneCall = execaMock.mock.calls[0];
		const cloneArgs = cloneCall?.[1] as string[];
		expect(cloneArgs[0]).toBe('-c');
		expect(cloneArgs[1]).toMatch(
			/^http\.https:\/\/github\.com\/\.extraheader=Authorization: Basic /u,
		);
		const encodedHeader = cloneArgs[1]?.replace(
			'http.https://github.com/.extraheader=Authorization: Basic ',
			'',
		);
		expect(Buffer.from(encodedHeader ?? '', 'base64').toString('utf8')).toBe(
			'x-access-token:ghp_secret-token',
		);
		expect(cloneArgs.slice(2, 6)).toEqual([
			'clone',
			'--branch',
			'main',
			'https://github.com/org/frontend.git',
		]);
	});

	it('does not write cloned repo paths to global git safe.directory config', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { preStartGateway } = await import('./worker-task-runner.js');
		await preStartGateway(
			{
				requestTaskId: 'request-task-1',
				prompt: 'clone public repo',
				repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
				context: {},
			},
			zone,
		);

		expect(execaMock).not.toHaveBeenCalledWith(
			'git',
			expect.arrayContaining(['--global', '--add', 'safe.directory']),
			expect.anything(),
		);
	});

	it('scrubs GitHub tokens from clone failures', async () => {
		execaMock.mockRejectedValue(
			new Error(
				'fatal: https://x-access-token:ghp_secret-token@github.com/org/frontend.git failed with Authorization: Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0',
			),
		);
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { preStartGateway } = await import('./worker-task-runner.js');
		await expect(
			preStartGateway(
				{
					requestTaskId: 'request-task-1',
					prompt: 'clone private repo',
					repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
					context: {},
				},
				zone,
				{ githubToken: 'ghp_secret-token' },
			),
		).rejects.toThrow(/x-access-token:\*\*\*@github\.com/);
		await expect(
			preStartGateway(
				{
					requestTaskId: 'request-task-1',
					prompt: 'clone private repo',
					repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
					context: {},
				},
				zone,
				{ githubToken: 'ghp_secret-token' },
			),
		).rejects.not.toThrow(/ghp_secret-token|Authorization: Basic eC/u);
	});

	it('waits for parallel clone attempts to settle before deleting the task root', async () => {
		const events: string[] = [];
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command === 'git' && args.includes('https://github.com/org/failing.git')) {
				events.push('failing-clone-failed');
				throw new Error('clone failed');
			}
			if (command === 'git' && args.includes('https://github.com/org/slow.git')) {
				events.push('slow-clone-started');
				await new Promise((resolve) => setTimeout(resolve, 10));
				events.push('slow-clone-finished');
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const originalRm = fs.rm;
		vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
			events.push('task-root-removed');
			return await originalRm(...args);
		});
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { preStartGateway } = await import('./worker-task-runner.js');
		await expect(
			preStartGateway(
				{
					requestTaskId: 'request-task-1',
					prompt: 'clone two repos',
					repos: [
						{ repoUrl: 'https://github.com/org/failing.git', baseBranch: 'main' },
						{ repoUrl: 'https://github.com/org/slow.git', baseBranch: 'main' },
					],
					context: {},
				},
				zone,
			),
		).rejects.toThrow(/clone failed/u);

		expect(events).toEqual([
			'failing-clone-failed',
			'slow-clone-started',
			'slow-clone-finished',
			'task-root-removed',
		]);
	});

	it('throws on invalid project config instead of silently ignoring it', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
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
					requestTaskId: 'request-task-1',
					prompt: 'cross repo task',
					repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
					context: {},
				},
				zone,
			),
		).rejects.toThrow('Invalid project config');
	});

	it('rejects project config prompt file references', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const originalReadFile = fs.readFile;
		vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, encoding) => {
			if (normalizeMockFilePath(filePath).endsWith('/frontend/.agent-vm/config.json')) {
				return JSON.stringify({
					commonAgentInstructions: { path: './prompts/common-agent-instructions.md' },
				});
			}
			return await originalReadFile(filePath, encoding);
		});

		const { preStartGateway } = await import('./worker-task-runner.js');

		await expect(
			preStartGateway(
				{
					requestTaskId: 'request-task-1',
					prompt: 'cross repo task',
					repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
					context: {},
				},
				zone,
			),
		).rejects.toThrow(/expected string/u);
	});

	it('copies the configured local worker tarball into the task state directory', async () => {
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const localWorkerTarballPath = path.join(tempDir, 'agent-vm-worker-local.tgz');
		await fs.writeFile(localWorkerTarballPath, 'local worker tarball bytes');
		process.env.AGENT_VM_WORKER_TARBALL_PATH = localWorkerTarballPath;

		const { preStartGateway } = await import('./worker-task-runner.js');
		const result = await preStartGateway(
			{
				requestTaskId: 'request-task-1',
				prompt: 'fix login',
				repos: [],
				context: {},
			},
			zone,
		);

		await expect(
			fs.readFile(path.join(result.stateDir, 'agent-vm-worker.tgz'), 'utf8'),
		).resolves.toBe('local worker tarball bytes');
	});

	it('retries transient poll failures before giving up', async () => {
		let pollCount = 0;
		let submittedBody: unknown;
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url =
				typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.endsWith('/tasks')) {
				submittedBody =
					typeof init?.body === 'string'
						? JSON.parse(init.body)
						: input instanceof Request
							? await input.json()
							: undefined;
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

		const result = await executePreparedWorkerTaskForTest({
			input: {
				requestTaskId: 'request-task-1',
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
		expect(submittedBody).toMatchObject({
			repos: [
				{
					repoUrl: 'https://github.com/org/repo.git',
					baseBranch: 'main',
					workspacePath: '/workspace/repo',
				},
			],
		});
		expect(JSON.stringify(submittedBody)).not.toContain('hostWorkspacePath');
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

		await expect(
			executePreparedWorkerTaskForTest({
				input: {
					requestTaskId: 'request-task-1',
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

		const result = await executePreparedWorkerTaskForTest({
			input: {
				requestTaskId: 'request-task-1',
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

	it('includes worker HTTP response bodies in task submission failures', async () => {
		globalThis.fetch = vi.fn(async () => {
			return new Response('worker rejected task payload', {
				status: 500,
				headers: { 'content-type': 'text/plain' },
			});
		}) as typeof fetch;

		await expect(
			executePreparedWorkerTaskForTest({
				input: {
					requestTaskId: 'request-task-1',
					prompt: 'fix login',
					repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
					context: {},
				},
				secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
				systemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/worker rejected task payload/u);
	});

	it('aggregates the primary task failure when shutdown hooks also fail', async () => {
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
				return new Response(JSON.stringify({ status: 'running', taskId: 'task-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		}) as typeof fetch;
		managedVmCloseMock.mockRejectedValue(new Error('vm close failed'));
		stopRepoResourceProvidersMock.mockRejectedValue(new Error('compose cleanup failed'));

		let thrownError: unknown;
		try {
			await executePreparedWorkerTaskForTest({
				input: {
					requestTaskId: 'request-task-1',
					prompt: 'fix login',
					repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
					context: {},
				},
				secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
				systemConfig,
				zoneId: 'shravan',
				timeoutMs: 1,
			});
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		const aggregateError = thrownError as AggregateError;
		expect(aggregateError.message).toMatch(/cleanup also failed/u);
		expect(aggregateError.errors).toEqual([
			expect.objectContaining({ message: expect.stringMatching(/Worker task timed out/u) }),
			expect.objectContaining({ message: 'vm close failed' }),
			expect.objectContaining({ message: 'compose cleanup failed' }),
		]);
		expect(managedVmCloseMock).toHaveBeenCalled();
		expect(stopRepoResourceProvidersMock).toHaveBeenCalled();
	});

	it('aggregates provider, resource-directory, and workspace cleanup failures after shutdown', async () => {
		const { postStopGateway } = await import('./worker-task-runner.js');
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const taskRoot = path.join(zone.gateway.stateDir, 'tasks', 'task-cleanup-failures');
		await fs.mkdir(path.join(taskRoot, 'workspace'), { recursive: true });
		await fs.mkdir(path.join(taskRoot, 'agent-vm', 'resources'), { recursive: true });
		stopRepoResourceProvidersMock.mockRejectedValue(new Error('compose cleanup failed'));
		vi.spyOn(fs, 'rm').mockImplementation(async (targetPath) => {
			const normalizedTarget = normalizeMockFilePath(targetPath);
			if (normalizedTarget.endsWith('/agent-vm/resources')) {
				throw new Error('resource removal failed');
			}
			if (normalizedTarget.endsWith('/workspace')) {
				throw new Error('workspace removal failed');
			}
		});
		const startedProvider = {
			composeFilePath: '/tmp/task/.agent-vm/docker-compose.yml',
			composeProjectName: 'agent-vm-task-cleanup-failures-repo-a',
			repoDir: '/tmp/task',
			repoId: 'repo-a',
		};

		let thrownError: unknown;
		try {
			await postStopGateway('task-cleanup-failures', zone, [startedProvider]);
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		const aggregateError = thrownError as AggregateError;
		expect(aggregateError.errors).toEqual([
			expect.objectContaining({ message: 'compose cleanup failed' }),
			expect.objectContaining({ message: 'resource removal failed' }),
			expect.objectContaining({ message: 'workspace removal failed' }),
		]);
	});

	it('preserves the primary task failure when shutdown hooks succeed', async () => {
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
				return new Response(JSON.stringify({ status: 'running', taskId: 'task-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		}) as typeof fetch;

		await expect(
			executePreparedWorkerTaskForTest({
				input: {
					requestTaskId: 'request-task-1',
					prompt: 'fix login',
					repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
					context: {},
				},
				secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
				systemConfig,
				zoneId: 'shravan',
				timeoutMs: 1,
			}),
		).rejects.toThrow(/Worker task timed out/u);
	});

	it('cleans up providers and task root when task preparation fails after pre-start', async () => {
		const startedProvider = {
			composeFilePath: '/tmp/task/.agent-vm/docker-compose.yml',
			composeProjectName: 'agent-vm-task-prepare-failed-repo-a',
			repoDir: '/tmp/task',
			repoId: 'repo-a',
		};
		startRepoResourceProvidersMock.mockResolvedValue({
			finalizations: [],
			startedProviders: [startedProvider],
		});
		const removedPaths: string[] = [];
		const originalRm = fs.rm;
		vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
			removedPaths.push(normalizeMockFilePath(args[0]));
			return await originalRm(...args);
		});
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { prepareWorkerTask } = await import('./worker-task-runner.js');
		await expect(
			prepareWorkerTask({
				input: {
					requestTaskId: 'request-task-1',
					prompt: 'fix login',
					repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
					context: {},
				},
				systemConfig,
				zoneId: zone.id,
				onTaskPrepared: () => {
					throw new Error('registry write failed');
				},
			}),
		).rejects.toThrow(/registry write failed/u);

		expect(stopRepoResourceProvidersMock).toHaveBeenCalledWith([startedProvider]);
		expect(removedPaths.some((removedPath) => removedPath.includes('/tasks/'))).toBe(true);
	});

	it('preserves task state while pruning the workspace during shutdown', async () => {
		const { postStopGateway } = await import('./worker-task-runner.js');
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const taskRoot = path.join(zone.gateway.stateDir, 'tasks', 'task-keep-state');
		await fs.mkdir(path.join(taskRoot, 'workspace'), { recursive: true });
		await fs.mkdir(path.join(taskRoot, 'state'), { recursive: true });
		await fs.mkdir(path.join(taskRoot, 'agent-vm', 'resources', 'repo-a'), { recursive: true });
		await fs.writeFile(path.join(taskRoot, 'workspace', 'README.md'), 'workspace data');
		await fs.writeFile(path.join(taskRoot, 'state', 'events.jsonl'), '{"event":"task-created"}\n');
		await fs.writeFile(
			path.join(taskRoot, 'agent-vm', 'resources', 'repo-a', 'mock.json'),
			'{"ok":true}\n',
		);

		const startedProvider = {
			composeFilePath: '/tmp/task/.agent-vm/docker-compose.yml',
			composeProjectName: 'agent-vm-task-keep-state-repo-a',
			repoDir: '/tmp/task',
			repoId: 'repo-a',
		};
		await postStopGateway('task-keep-state', zone, [startedProvider]);

		expect(stopRepoResourceProvidersMock).toHaveBeenCalledWith([startedProvider]);
		await expect(fs.stat(path.join(taskRoot, 'state'))).resolves.toBeDefined();
		await expect(fs.stat(path.join(taskRoot, 'agent-vm', 'resources'))).rejects.toThrow();
		await expect(fs.stat(path.join(taskRoot, 'workspace'))).rejects.toThrow();
	});
});
