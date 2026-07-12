import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CONTROL_SESSION_TIMING_MS } from '@agent-vm/control-protocol-contracts';
import type { ManagedVm } from '@agent-vm/gondolin-adapter';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { writeGatewayRuntimeRecord } from '../gateway/gateway-runtime-record.js';
import type { StartGatewayZoneOptions } from '../gateway/gateway-zone-support.js';
import { terminateLiveManagedVm } from '../shared/controller-managed-vm-termination.js';
import type { ManagedVmKillDependencies } from '../shared/managed-vm-process.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';
import type { ControlSessionClient, WorkerControlRpcOperations } from './control-session/index.js';
import type { WorkerTaskInput } from './worker-task-runner.js';
import type { WorkerTaskPollClock } from './worker-task-runner.js';

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

const workerControllerEpoch = 'worker-controller-epoch-test';
const workerVmId = 'worker-vm-1';

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
	schemaVersion: 1,
	cacheDir: '/tmp/cache',
	runtimeDir: '/tmp/runtime',
	systemConfigPath: '/tmp/config/system.json',
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
				repoPushPolicies: [],
			},
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			runtimeAuthHints: [],
			egressHosts: ['github.com'].map((host) => ({ host, audience: 'gateway' as const })),
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
	toolVmProfiles: {
		standard: { memory: '1G', cpus: 1, imageProfile: 'default' },
	},
	tcpPool: { basePort: 19000, size: 4 },
} satisfies LoadedSystemConfig;

async function executePreparedWorkerTaskForTest(options: {
	readonly input: WorkerTaskInput;
	readonly managedVmKillDependencies?: ManagedVmKillDependencies;
	readonly onTaskFinished?: (zoneId: string, taskId: string) => Promise<void>;
	readonly pollClock?: WorkerTaskPollClock;
	readonly pollIntervalMs?: number;
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
		...(options.onTaskFinished ? { onTaskFinished: options.onTaskFinished } : {}),
		controllerEpoch: workerControllerEpoch,
		...(options.managedVmKillDependencies === undefined
			? {}
			: { managedVmKillDependencies: options.managedVmKillDependencies }),
		secretResolver: options.secretResolver,
		systemConfig: options.systemConfig,
		pollClock: options.pollClock ?? createInstantPollClock(),
		pollIntervalMs: options.pollIntervalMs ?? 1,
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
	});
}

function createInstantPollClock(): WorkerTaskPollClock {
	let elapsedMs = 0;
	return {
		now: () => elapsedMs,
		sleep: async (durationMs: number): Promise<void> => {
			elapsedMs += Math.max(durationMs, 1);
		},
	};
}

interface WorkerControlSessionClientStub {
	readonly client: ControlSessionClient;
	readonly closeMock: Mock<() => void>;
}

function createWorkerControlSessionClientStub(options: {
	readonly connectedStates: readonly boolean[];
	readonly readyStates?: readonly boolean[];
}): WorkerControlSessionClientStub {
	let diagnosticsIndex = 0;
	const closeMock = vi.fn();
	return {
		client: {
			ready: Promise.resolve({
				connectionId: '55555555-5555-4555-8555-555555555555',
				controllerEpoch: 'worker-epoch-a',
				outcome: 'accepted',
				sessionId: '33333333-3333-4333-8333-333333333333',
			}),
			close: closeMock,
			emitApplicationMessage: vi.fn(async () => ({ received: true })),
			getDiagnostics: vi.fn(() => {
				const connected =
					options.connectedStates[Math.min(diagnosticsIndex, options.connectedStates.length - 1)];
				const ready =
					options.readyStates?.[Math.min(diagnosticsIndex, options.readyStates.length - 1)] ??
					connected;
				diagnosticsIndex += 1;
				return {
					accepted: ready ?? false,
					connected: connected ?? false,
					endpointPath: '/__agent-vm/worker-control',
					helloCount: ready ? 1 : 0,
					ready: ready ?? false,
				};
			}),
		},
		closeMock,
	};
}

const pullDefaultForTaskStub: WorkerControlRpcOperations['pullDefaultForTask'] = async () => {
	return {
		error: 'not used',
		kind: 'failed',
		message: 'not used',
		repoUrl: 'https://github.com/org/repo.git',
		success: false,
	};
};

const pushTaskBranchesStub: WorkerControlRpcOperations['pushTaskBranches'] = async () => ({
	results: [],
});

function createWorkerControlOperationsStub(): WorkerControlRpcOperations {
	return {
		pullDefaultForTask: pullDefaultForTaskStub,
		pushTaskBranches: pushTaskBranchesStub,
	};
}

describe('worker-task-runner', () => {
	let tempDir: string;
	let managedVm: ManagedVm;
	let managedVmCloseMock: Mock<() => Promise<void>>;
	let managedVmStartMock: Mock<() => Promise<void>>;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-runner-'));
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		zone.gateway.config = path.join(tempDir, 'gateway-config.json');
		zone.gateway.stateDir = path.join(tempDir, 'state');
		systemConfig.runtimeDir = path.join(tempDir, 'runtime');
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

		managedVmCloseMock = vi.fn(async () => {});
		managedVmStartMock = vi.fn(async () => {});
		managedVm = {
			id: workerVmId,
			close: async () => await managedVmCloseMock(),
			enableIngress: vi.fn(async () => ({
				close: vi.fn(async () => {}),
				host: '127.0.0.1',
				port: 18791,
			})),
			enableSsh: vi.fn(async () => ({
				close: async () => {},
				serverHostKey: TEST_SSH_SERVER_HOST_KEY,
				host: '127.0.0.1',
				port: 2222,
				user: 'root',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			setIngressRoutes: vi.fn(),
			getHostPid: () => null,
			getVmInstance: vi.fn(),
			start: async () => await managedVmStartMock(),
		};

		startGatewayZoneMock.mockImplementation(async (startOptions: StartGatewayZoneOptions) => {
			const vmOwnership = await startOptions.createVmOwnership({
				kind: 'standalone',
				sessionLabel: 'worker-task-session',
				zoneId: zone.id,
			});
			vmOwnership.attachGatewayVm(managedVm.id);
			await managedVm.start();
			return {
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
				terminateVm: async () => await managedVm.close(),
				vm: managedVm,
				vmOwnership,
				zone,
			};
		});
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
	});

	afterEach(() => {
		delete process.env.AGENT_VM_WORKER_TARBALL_PATH;
		delete process.env.AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON;
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
			expect.any(Object),
		);
		expect(managedVmStartMock).toHaveBeenCalledOnce();
		expect(managedVmCloseMock).toHaveBeenCalledOnce();
	});

	it('creates standalone Worker VM lifecycle authority without reservation state', async () => {
		// Arrange / Act
		await executePreparedWorkerTaskForTest({
			input: {
				requestTaskId: 'request-task-shared-ownership-root',
				prompt: 'verify shared ownership root',
				repos: [],
				context: {},
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zoneId: 'shravan',
		});
		const startOptions = startGatewayZoneMock.mock.calls[0]?.[0] as
			| StartGatewayZoneOptions
			| undefined;
		if (startOptions === undefined) {
			throw new Error('Worker task did not invoke gateway startup.');
		}
		const vmOwnership = await startOptions.createVmOwnership({
			kind: 'standalone',
			sessionLabel: 'worker-standalone-lifecycle',
			zoneId: 'shravan',
		});

		// Assert
		expect(vmOwnership.gatewaySeed).toMatchObject({
			controllerEpoch: workerControllerEpoch,
			zoneId: 'shravan',
		});
		expect(vmOwnership.gatewayIdentity).toBeUndefined();
		expect(vmOwnership).not.toHaveProperty('ownershipReservation');
		expect(vmOwnership).not.toHaveProperty('destroyDetached');
		expect(vmOwnership.attachGatewayVm('worker-vm-independent')).toMatchObject({
			gatewayVmId: 'worker-vm-independent',
			zoneId: 'shravan',
		});
	});

	it('terminates the exact recorded Worker VM runner before stock close', async () => {
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const processIdentity = {
			command: 'qemu-system-aarch64 -name worker-vm-1',
			lstart: 'Sat Jul 11 17:00:00 2026',
		};
		const orderedEvents: string[] = [];
		let runnerAttached = true;
		managedVm = {
			...managedVm,
			getHostPid: () => (runnerAttached ? 48_282 : null),
		};
		managedVmCloseMock.mockImplementation(async () => {
			orderedEvents.push('stock-close');
		});
		const managedVmKillDependencies = {
			isProcessAlive: () => runnerAttached,
			killProcess: (pid: number, signal: NodeJS.Signals) => {
				orderedEvents.push(`${String(signal)}:${String(pid)}`);
				runnerAttached = false;
			},
			readProcessCommand: async () => processIdentity.command,
			readProcessIdentity: async () => processIdentity,
			sleep: async () => {},
		} satisfies ManagedVmKillDependencies;
		startGatewayZoneMock.mockImplementationOnce(async (startOptions: StartGatewayZoneOptions) => {
			const vmOwnership = await startOptions.createVmOwnership({
				kind: 'standalone',
				sessionLabel: 'worker-task-session',
				zoneId: zone.id,
			});
			const gatewayIdentity = vmOwnership.attachGatewayVm(managedVm.id);
			await managedVm.start();
			const workerStateDirectory = startOptions.zoneOverride?.gateway.stateDir;
			if (workerStateDirectory === undefined) {
				throw new Error('Worker task startup did not provide its state directory.');
			}
			await writeGatewayRuntimeRecord(workerStateDirectory, {
				configPath: systemConfig.systemConfigPath,
				controllerPort: systemConfig.host.controllerPort,
				createdAt: '2026-07-11T17:00:00.000Z',
				gateway: gatewayIdentity,
				gatewayType: 'worker',
				guestListenPort: 18_789,
				ingressPort: 18_791,
				processIdentity,
				projectNamespace: systemConfig.host.projectNamespace,
				qemuPid: 48_282,
				schemaVersion: 2,
				sessionLabel: `${systemConfig.host.projectNamespace}:${zone.id}:gateway`,
				vmId: managedVm.id,
				zoneId: zone.id,
			});
			return {
				image: { built: true, fingerprint: 'gateway', imagePath: '/tmp/gateway.img' },
				ingress: { host: '127.0.0.1', port: 18_791 },
				processSpec: {
					bootstrapCommand: 'true',
					startCommand: 'agent-vm-worker serve',
					healthCheck: { type: 'http', port: 18_789, path: '/health' },
					guestListenPort: 18_789,
					logPath: '/tmp/worker.log',
				},
				terminateVm: async () => {
					await terminateLiveManagedVm({
						dependencies: managedVmKillDependencies,
						target: {
							hostPid: 48_282,
							processIdentity,
							vmId: managedVm.id,
						},
						vm: managedVm,
					});
				},
				vm: managedVm,
				vmOwnership,
				zone,
			};
		});
		await executePreparedWorkerTaskForTest({
			input: {
				requestTaskId: 'request-task-exact-worker-cleanup',
				prompt: 'prove exact Worker cleanup',
				repos: [],
				context: {},
			},
			managedVmKillDependencies,
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
			zoneId: zone.id,
		});

		expect(orderedEvents).toEqual(['SIGTERM:48282', 'stock-close']);
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
		expect(writtenConfig.runtimeInstructions).toContain('/work/repos');
		expect(writtenConfig.runtimeInstructions).toContain('/agent-vm/agents.md');
		await expect(
			fs.readFile(path.join(result.taskRoot, 'agent-vm', 'runtime-instructions.md'), 'utf8'),
		).resolves.toBe(writtenConfig.runtimeInstructions);
		await expect(
			fs.readFile(path.join(result.taskRoot, 'agent-vm', 'agents.md'), 'utf8'),
		).resolves.toContain('/agent-vm/runtime-instructions.md');
		await expect(fs.readlink(path.join(result.taskRoot, 'agent-vm', 'CLAUDE.md'))).resolves.toBe(
			'agents.md',
		);
		await expect(fs.readFile(path.join(result.workDir, 'AGENTS.md'), 'utf8')).rejects.toThrow();
		await expect(fs.readlink(path.join(result.workDir, 'CLAUDE.md'))).rejects.toThrow();
		expect(result.vfsMounts['/agent-vm']).toEqual(
			expect.objectContaining({ kind: 'realfs-readonly' }),
		);
		expect(result.vfsMounts['/work/repos']).toBeUndefined();
		expect(result.vfsMounts['/gitdirs']).toEqual(
			expect.objectContaining({
				hostPath: path.join(result.taskRuntimeRoot, 'gitdirs'),
				kind: 'realfs',
			}),
		);
	});

	it('clones repos into named work directories and merges primary repo config', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		const baseZone = systemConfig.zones[0];
		const zone =
			baseZone?.gateway.type === 'worker'
				? {
						...baseZone,
						gateway: {
							...baseZone.gateway,
							repoPushPolicies: [
								{
									repoUrl: 'https://github.com/org/frontend.git',
									defaultBranch: 'main',
									protectedBranches: ['release'],
									protectedBranchPatterns: ['hotfix/*'],
								},
							],
						},
					}
				: baseZone;
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const originalReadFile = fs.readFile;
		vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, encoding) => {
			if (
				normalizeMockFilePath(filePath).endsWith('/repo-metadata/frontend/.agent-vm/config.json')
			) {
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
					{ repoUrl: 'https://github.com/org/frontend', baseBranch: 'main' },
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
				'-c',
				'core.hooksPath=/dev/null',
				'clone',
				'--bare',
				'--branch',
				'main',
				'https://github.com/org/frontend',
				path.join(result.taskRuntimeRoot, 'gitdirs', 'frontend.git'),
			],
			expect.objectContaining({ timeout: 120_000 }),
		);
		expect(execaMock).toHaveBeenCalledWith(
			'git',
			[
				'-c',
				'core.hooksPath=/dev/null',
				'clone',
				'--bare',
				'--branch',
				'develop',
				'https://github.com/org/backend.git',
				path.join(result.taskRuntimeRoot, 'gitdirs', 'backend.git'),
			],
			expect.objectContaining({ timeout: 120_000 }),
		);
		expect(result.repos).toEqual([
			{
				repoId: 'frontend',
				repoUrl: 'https://github.com/org/frontend',
				baseBranch: 'main',
				pushPolicy: {
					kind: 'trusted_config',
					defaultBranch: 'main',
					protectedBranches: ['release'],
					protectedBranchPatterns: ['hotfix/*'],
				},
				gitDirPath: '/gitdirs/frontend.git',
				hostGitDir: path.join(result.taskRuntimeRoot, 'gitdirs', 'frontend.git'),
				hostMetadataPath: path.join(result.taskRuntimeRoot, 'repo-metadata', 'frontend'),
				workPath: '/work/repos/frontend',
			},
			{
				repoId: 'backend',
				repoUrl: 'https://github.com/org/backend.git',
				baseBranch: 'develop',
				pushPolicy: { kind: 'missing' },
				gitDirPath: '/gitdirs/backend.git',
				hostGitDir: path.join(result.taskRuntimeRoot, 'gitdirs', 'backend.git'),
				hostMetadataPath: path.join(result.taskRuntimeRoot, 'repo-metadata', 'backend'),
				workPath: '/work/repos/backend',
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
		expect(result.repos.map((repo) => repo.workPath)).toEqual([
			'/work/repos/repo-dir',
			'/work/repos/repo-dir-2',
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
				repoDir: expect.stringMatching(/\/repo-metadata\/frontend$/u),
				outputDir: expect.stringMatching(/\/state\/tasks\/[^/]+\/agent-vm\/resources\/frontend$/u),
			}),
			expect.objectContaining({
				repoId: 'backend',
				repoDir: expect.stringMatching(/\/repo-metadata\/backend$/u),
				outputDir: expect.stringMatching(/\/state\/tasks\/[^/]+\/agent-vm\/resources\/backend$/u),
			}),
		]);
		expect(providerCall?.providers).toHaveLength(1);
		expect(providerCall?.providers[0]).toMatchObject({
			repoId: 'frontend',
			repoDir: expect.stringMatching(/\/repo-metadata\/frontend$/u),
			outputDir: expect.stringMatching(/\/state\/tasks\/[^/]+\/agent-vm\/resources\/frontend$/u),
			resourceName: 'pg',
			provider: { service: 'pg' },
			binding: { host: 'pg.local', port: 5432 },
		});
	});

	it('skips bare repos without resource contracts while setting up contract repos', async () => {
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
				: null,
		);
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { preStartGateway } = await import('./worker-task-runner.js');
		await preStartGateway(
			{
				requestTaskId: 'request-task-1',
				prompt: 'mixed repo resource task',
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
		expect(providerCall.repos.map((repo) => repo.repoId)).toEqual(['frontend']);
		expect(providerCall.providers.map((provider) => provider.repoId)).toEqual(['frontend']);
	});

	it('passes selected external resources to repo resource setup at the task boundary', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		loadRepoResourceDescriptionContractMock.mockResolvedValue({
			setupCommand: '.agent-vm/run-setup.sh',
			requires: {
				pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
			},
			provides: {},
		});
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const zoneWithExternalResources = {
			...zone,
			resources: {
				allowRepoResources: true,
				externalResources: {
					pg: {
						name: 'pg',
						binding: { host: 'pg.local', port: 5432 },
						target: { host: '127.0.0.1', port: 15432 },
						env: { DATABASE_URL: 'postgres://127.0.0.1:15432/app' },
					},
					unused: {
						name: 'unused',
						binding: { host: 'unused.external', port: 1234 },
						target: { host: '127.0.0.1', port: 11234 },
						env: {},
					},
				},
			},
		};

		const { preStartGateway } = await import('./worker-task-runner.js');
		await preStartGateway(
			{
				requestTaskId: 'request-task-1',
				prompt: 'external resource task',
				repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
				resources: {
					externalResources: zoneWithExternalResources.resources.externalResources,
				},
				context: {},
			},
			zoneWithExternalResources,
		);

		const providerCall = startRepoResourceProvidersMock.mock.calls[0]?.[0];
		if (!providerCall) {
			throw new Error('Expected repo resource providers to start.');
		}
		expect(providerCall.repos[0]?.selectedExternalResources).toEqual({
			pg: {
				binding: { host: 'pg.local', port: 5432 },
				target: { host: '127.0.0.1', port: 15432 },
			},
		});
	});

	it('does not execute repo resource contracts when repo resources are disabled', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		loadRepoResourceDescriptionContractMock.mockRejectedValue(
			new Error('repo-local contract should not run'),
		);
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const zoneWithRepoResourcesDisabled = {
			...zone,
			resources: { allowRepoResources: false },
		};

		const { preStartGateway } = await import('./worker-task-runner.js');
		await preStartGateway(
			{
				requestTaskId: 'request-task-1',
				prompt: 'repo resources disabled task',
				repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
				context: {},
			},
			zoneWithRepoResourcesDisabled,
		);

		expect(loadRepoResourceDescriptionContractMock).not.toHaveBeenCalled();
		expect(startRepoResourceProvidersMock).toHaveBeenCalledWith(
			expect.objectContaining({
				repos: [],
				providers: [],
			}),
		);
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
				'-c',
				'core.hooksPath=/dev/null',
				'clone',
				'--bare',
				'--branch',
				'main',
				'https://github.com/org/frontend.git',
				expect.stringContaining('/gitdirs/frontend.git'),
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
		expect(cloneArgs.slice(2, 8)).toEqual([
			'-c',
			'core.hooksPath=/dev/null',
			'clone',
			'--bare',
			'--branch',
			'main',
		]);
		expect(cloneArgs[8]).toBe('https://github.com/org/frontend.git');
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

	it('serializes cloned repo git config writes to avoid config.lock races', async () => {
		let activeConfigWrites = 0;
		let maxActiveConfigWrites = 0;
		const configKeys: string[] = [];
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command === 'git' && args[3] === 'config') {
				activeConfigWrites += 1;
				maxActiveConfigWrites = Math.max(maxActiveConfigWrites, activeConfigWrites);
				configKeys.push(args[4] ?? '');
				await Promise.resolve();
				activeConfigWrites -= 1;
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});
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

		expect(configKeys).toEqual([
			'core.bare',
			'user.email',
			'user.name',
			'http.version',
			'commit.gpgsign',
		]);
		expect(maxActiveConfigWrites).toBe(1);
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

	it('reports every failed repo clone during pre-start', async () => {
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command === 'git' && args.includes('clone')) {
				const repoUrl = args.at(-2) ?? 'unknown';
				return { stdout: '', stderr: `clone failed for ${repoUrl}`, exitCode: 128 };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { preStartGateway } = await import('./worker-task-runner.js');
		let thrownError: unknown;
		try {
			await preStartGateway(
				{
					requestTaskId: 'request-task-1',
					prompt: 'clone repos',
					repos: [
						{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' },
						{ repoUrl: 'https://github.com/org/backend.git', baseBranch: 'main' },
					],
					context: {},
				},
				zone,
			);
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		const aggregateError = thrownError as AggregateError;
		expect(aggregateError.errors).toEqual([
			expect.objectContaining({
				message: expect.stringContaining('https://github.com/org/frontend.git'),
			}),
			expect.objectContaining({
				message: expect.stringContaining('https://github.com/org/backend.git'),
			}),
		]);
	});

	it('waits for parallel clone attempts to settle before deleting the task root', async () => {
		const events: string[] = [];
		let releaseSlowClone: (() => void) | undefined;
		const slowCloneCanFinish = new Promise<void>((resolve) => {
			releaseSlowClone = resolve;
		});
		let markSlowCloneStarted: (() => void) | undefined;
		const slowCloneStarted = new Promise<void>((resolve) => {
			markSlowCloneStarted = resolve;
		});
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command === 'git' && args.includes('https://github.com/org/failing.git')) {
				events.push('failing-clone-failed');
				throw new Error('clone failed');
			}
			if (command === 'git' && args.includes('https://github.com/org/slow.git')) {
				events.push('slow-clone-started');
				markSlowCloneStarted?.();
				await slowCloneCanFinish;
				events.push('slow-clone-finished');
				return { stdout: '', stderr: '', exitCode: 0 };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const originalRm = fs.rm;
		vi.spyOn(fs, 'rm').mockImplementation(async (...args) => {
			const normalizedTarget = normalizeMockFilePath(args[0]);
			if (!normalizedTarget.endsWith('agent-vm-metadata.tar')) {
				events.push(
					normalizedTarget.includes('/worker-tasks/')
						? 'task-runtime-root-removed'
						: 'task-root-removed',
				);
			}
			return await originalRm(...args);
		});
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const { preStartGateway } = await import('./worker-task-runner.js');
		const preStartPromise = preStartGateway(
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
		);
		await slowCloneStarted;
		expect(events).not.toContain('task-root-removed');
		releaseSlowClone?.();
		await expect(preStartPromise).rejects.toThrow(/clone failed/u);

		expect(events).toEqual([
			'failing-clone-failed',
			'slow-clone-started',
			'slow-clone-finished',
			'task-root-removed',
			'task-runtime-root-removed',
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
			if (
				normalizeMockFilePath(filePath).endsWith('/repo-metadata/frontend/.agent-vm/config.json')
			) {
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

	it('fails loudly when probing repo metadata fails', async () => {
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command === 'git' && args.includes('ls-tree')) {
				return { stdout: '', stderr: 'fatal: remote branch main not found', exitCode: 128 };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
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
					prompt: 'cross repo task',
					repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
					context: {},
				},
				zone,
			),
		).rejects.toThrow(/Failed to probe \.agent-vm metadata/u);
	});

	it('fails loudly when the repo metadata probe terminates without an exit code', async () => {
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command === 'git' && args.includes('ls-tree')) {
				return { stdout: '', stderr: 'killed', exitCode: undefined };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
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
					prompt: 'cross repo task',
					repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
					context: {},
				},
				zone,
			),
		).rejects.toThrow(/git ls-tree terminated without an exit code/u);
	});

	it('fails loudly when repo metadata archive terminates without an exit code', async () => {
		execaMock.mockImplementation(async (command: string, args: readonly string[]) => {
			if (command === 'git' && args.includes('ls-tree')) {
				return { stdout: '.agent-vm', stderr: '', exitCode: 0 };
			}
			if (command === 'git' && args.includes('archive')) {
				return { stdout: '', stderr: 'killed', exitCode: undefined };
			}
			return { stdout: '', stderr: '', exitCode: 0 };
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
					prompt: 'cross repo task',
					repos: [{ repoUrl: 'https://github.com/org/frontend.git', baseBranch: 'main' }],
					context: {},
				},
				zone,
			),
		).rejects.toThrow(/git archive terminated without an exit code/u);
	});

	it('rejects project config prompt file references', async () => {
		execaMock.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const originalReadFile = fs.readFile;
		vi.spyOn(fs, 'readFile').mockImplementation(async (filePath, encoding) => {
			if (
				normalizeMockFilePath(filePath).endsWith('/repo-metadata/frontend/.agent-vm/config.json')
			) {
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

	it('copies configured local worker package tarballs and writes a local package manifest', async () => {
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const localWorkerTarballPath = path.join(tempDir, 'agent-vm-worker-local.tgz');
		const localControlProtocolTarballPath = path.join(
			tempDir,
			'agent-vm-control-protocol-contracts-local.tgz',
		);
		const localWorkerControlTarballPath = path.join(
			tempDir,
			'agent-vm-worker-control-contracts-local.tgz',
		);
		const localGatewayInterfaceTarballPath = path.join(
			tempDir,
			'agent-vm-gateway-interface-local.tgz',
		);
		const localGondolinAdapterTarballPath = path.join(
			tempDir,
			'agent-vm-gondolin-adapter-local.tgz',
		);
		const localSecretManagementTarballPath = path.join(
			tempDir,
			'agent-vm-secret-management-local.tgz',
		);
		await Promise.all([
			fs.writeFile(localWorkerTarballPath, 'local worker tarball bytes'),
			fs.writeFile(localControlProtocolTarballPath, 'local control protocol tarball bytes'),
			fs.writeFile(localWorkerControlTarballPath, 'local worker control tarball bytes'),
			fs.writeFile(localGatewayInterfaceTarballPath, 'local gateway interface tarball bytes'),
			fs.writeFile(localGondolinAdapterTarballPath, 'local gondolin adapter tarball bytes'),
			fs.writeFile(localSecretManagementTarballPath, 'local secret management tarball bytes'),
		]);
		process.env.AGENT_VM_WORKER_PACKAGE_TARBALLS_JSON = JSON.stringify([
			{ packageName: 'agent-vm-worker', sourcePath: localWorkerTarballPath },
			{ packageName: 'control-protocol-contracts', sourcePath: localControlProtocolTarballPath },
			{ packageName: 'gateway-interface', sourcePath: localGatewayInterfaceTarballPath },
			{ packageName: 'gondolin-adapter', sourcePath: localGondolinAdapterTarballPath },
			{ packageName: 'secret-management', sourcePath: localSecretManagementTarballPath },
			{ packageName: 'worker-control-contracts', sourcePath: localWorkerControlTarballPath },
		]);

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

		const packageDirectory = path.join(result.stateDir, 'agent-vm-worker-packages');
		const packageJson = z
			.object({
				dependencies: z.record(z.string(), z.string()),
				pnpm: z.object({
					overrides: z.record(z.string(), z.string()),
				}),
			})
			.parse(JSON.parse(await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')));
		expect(packageJson.dependencies).toEqual({
			'@agent-vm/agent-vm-worker': 'file:/state/agent-vm-worker-packages/agent-vm-worker-local.tgz',
			'@agent-vm/control-protocol-contracts':
				'file:/state/agent-vm-worker-packages/agent-vm-control-protocol-contracts-local.tgz',
			'@agent-vm/gateway-interface':
				'file:/state/agent-vm-worker-packages/agent-vm-gateway-interface-local.tgz',
			'@agent-vm/gondolin-adapter':
				'file:/state/agent-vm-worker-packages/agent-vm-gondolin-adapter-local.tgz',
			'@agent-vm/secret-management':
				'file:/state/agent-vm-worker-packages/agent-vm-secret-management-local.tgz',
			'@agent-vm/worker-control-contracts':
				'file:/state/agent-vm-worker-packages/agent-vm-worker-control-contracts-local.tgz',
		});
		expect(packageJson.pnpm?.overrides).toEqual(packageJson.dependencies);
		await expect(
			fs.readFile(path.join(packageDirectory, 'agent-vm-worker-local.tgz'), 'utf8'),
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
					gitDirPath: '/gitdirs/repo.git',
					workPath: '/work/repos/repo',
				},
			],
		});
		expect(JSON.stringify(submittedBody)).not.toContain('hostGitDir');
	});

	it('deletes task runtime gitdirs when a completed repo task has no controller push', async () => {
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
				return new Response(JSON.stringify({ status: 'completed', taskId: 'task-1' }), {
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

		const taskRuntimeRoot = path.join(
			systemConfig.runtimeDir,
			'worker-tasks',
			'shravan',
			result.taskId,
		);
		await expect(fs.stat(taskRuntimeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('deletes task runtime gitdirs when a completed repo task has a successful controller push', async () => {
		const { executeWorkerTask, prepareWorkerTask } = await import('./worker-task-runner.js');
		const prepared = await prepareWorkerTask({
			input: {
				requestTaskId: 'request-task-1',
				prompt: 'fix login',
				repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
				context: {},
			},
			systemConfig,
			zoneId: 'shravan',
		});
		await prepared.recordEvent({
			event: 'controller-git-push-succeeded',
			repoUrl: 'https://github.com/org/repo.git',
			branch: 'agent/task-1',
			attempts: 1,
			localHead: 'local-sha',
			remoteBranchHead: 'local-sha',
		});

		const result = await executeWorkerTask(prepared, {
			controllerEpoch: workerControllerEpoch,
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
		});

		const taskRuntimeRoot = path.join(
			systemConfig.runtimeDir,
			'worker-tasks',
			'shravan',
			result.taskId,
		);
		await expect(fs.stat(taskRuntimeRoot)).rejects.toThrow();
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

	it('keeps an active worker task alive when worker control reconnects within death grace', async () => {
		const { executeWorkerTask, prepareWorkerTask } = await import('./worker-task-runner.js');
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
				const status = pollCount >= 3 ? 'completed' : 'running';
				return new Response(JSON.stringify({ status, taskId: 'task-1' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			throw new Error(`Unexpected fetch ${url}`);
		}) as typeof fetch;
		const controlSessionClient = createWorkerControlSessionClientStub({
			connectedStates: [false, true],
		});
		const connectWorkerControlSession = vi.fn(async () => controlSessionClient.client);
		const prepared = await prepareWorkerTask({
			input: {
				requestTaskId: 'request-task-1',
				prompt: 'fix login',
				repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
				context: {},
			},
			systemConfig,
			zoneId: 'shravan',
		});

		const result = await executeWorkerTask(prepared, {
			connectWorkerControlSession,
			controllerEpoch: workerControllerEpoch,
			controlSession: {
				controllerEpoch: 'worker-epoch-a',
				operations: createWorkerControlOperationsStub(),
			},
			pollClock: createInstantPollClock(),
			pollIntervalMs: 1,
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig,
		});

		expect(connectWorkerControlSession).toHaveBeenCalledOnce();
		expect(completedTaskStateSchema.parse(result.finalState).status).toBe('completed');
		expect(controlSessionClient.closeMock).toHaveBeenCalledOnce();
	});

	it('requires worker VM recovery when worker control stays disconnected beyond death grace', async () => {
		const { executeWorkerTask, prepareWorkerTask } = await import('./worker-task-runner.js');
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
		const controlSessionClient = createWorkerControlSessionClientStub({
			connectedStates: [false],
		});
		const connectWorkerControlSession = vi.fn(async () => controlSessionClient.client);
		const prepared = await prepareWorkerTask({
			input: {
				requestTaskId: 'request-task-1',
				prompt: 'fix login',
				repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
				context: {},
			},
			systemConfig,
			zoneId: 'shravan',
		});

		await expect(
			executeWorkerTask(prepared, {
				connectWorkerControlSession,
				controllerEpoch: workerControllerEpoch,
				controlSession: {
					controllerEpoch: 'worker-epoch-a',
					operations: createWorkerControlOperationsStub(),
				},
				pollClock: createInstantPollClock(),
				pollIntervalMs: CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace,
				secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
				systemConfig,
				timeoutMs: CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace * 2,
			}),
		).rejects.toThrow(/exceeded death grace/u);
		expect(connectWorkerControlSession).toHaveBeenCalledOnce();
		expect(controlSessionClient.closeMock).toHaveBeenCalledOnce();
	});

	it('requires worker VM recovery when worker control reconnects transport without accepted hello', async () => {
		const { executeWorkerTask, prepareWorkerTask } = await import('./worker-task-runner.js');
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
		const controlSessionClient = createWorkerControlSessionClientStub({
			connectedStates: [true],
			readyStates: [false],
		});
		const connectWorkerControlSession = vi.fn(async () => controlSessionClient.client);
		const prepared = await prepareWorkerTask({
			input: {
				requestTaskId: 'request-task-1',
				prompt: 'fix login',
				repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
				context: {},
			},
			systemConfig,
			zoneId: 'shravan',
		});

		await expect(
			executeWorkerTask(prepared, {
				connectWorkerControlSession,
				controllerEpoch: workerControllerEpoch,
				controlSession: {
					controllerEpoch: 'worker-epoch-a',
					operations: createWorkerControlOperationsStub(),
				},
				pollClock: createInstantPollClock(),
				pollIntervalMs: CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace,
				secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
				systemConfig,
				timeoutMs: CONTROL_SESSION_TIMING_MS.controlSessionDeathGrace * 2,
			}),
		).rejects.toThrow(/exceeded death grace/u);
		expect(connectWorkerControlSession).toHaveBeenCalledOnce();
		expect(controlSessionClient.closeMock).toHaveBeenCalledOnce();
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

	it('deletes task runtime gitdirs when the worker returns failed status', async () => {
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
				return new Response(JSON.stringify({ status: 'failed', taskId: 'task-1' }), {
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

		const taskRuntimeRoot = path.join(
			systemConfig.runtimeDir,
			'worker-tasks',
			'shravan',
			result.taskId,
		);
		await expect(fs.stat(taskRuntimeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('preserves task resources when primary failure is followed by unproven VM destruction', async () => {
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
			expect.objectContaining({
				cause: expect.objectContaining({ message: 'vm close failed' }),
				message: expect.stringMatching(/did not prove exact destruction/u),
			}),
		]);
		expect(managedVmCloseMock).toHaveBeenCalled();
		expect(stopRepoResourceProvidersMock).not.toHaveBeenCalled();
	});

	it('reports Worker VM cleanup failure when stock close rejects', async () => {
		managedVmCloseMock.mockRejectedValueOnce(new Error('stock close failed'));
		const onTaskFinished = vi.fn(async () => {});

		await expect(
			executePreparedWorkerTaskForTest({
				input: {
					requestTaskId: 'request-task-incomplete-worker-close',
					prompt: 'fix login',
					repos: [{ repoUrl: 'https://github.com/org/repo.git', baseBranch: 'main' }],
					context: {},
				},
				secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
				systemConfig,
				zoneId: 'shravan',
				onTaskFinished,
			}),
		).rejects.toThrow(/did not prove exact destruction/u);

		expect(managedVmCloseMock).toHaveBeenCalledOnce();
		expect(onTaskFinished).not.toHaveBeenCalled();
		expect(stopRepoResourceProvidersMock).not.toHaveBeenCalled();
	});

	it('aggregates provider, resource-directory, and runtime cleanup failures after shutdown', async () => {
		const { postStopGateway } = await import('./worker-task-runner.js');
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}
		const taskRoot = path.join(zone.gateway.stateDir, 'tasks', 'task-cleanup-failures');
		const taskRuntimeRoot = path.join(
			systemConfig.runtimeDir,
			'worker-tasks',
			zone.id,
			'task-cleanup-failures',
		);
		await fs.mkdir(path.join(taskRuntimeRoot, 'work'), { recursive: true });
		await fs.mkdir(path.join(taskRoot, 'agent-vm', 'resources'), { recursive: true });
		stopRepoResourceProvidersMock.mockRejectedValue(new Error('compose cleanup failed'));
		vi.spyOn(fs, 'rm').mockImplementation(async (targetPath) => {
			const normalizedTarget = normalizeMockFilePath(targetPath);
			if (normalizedTarget.endsWith('/agent-vm/resources')) {
				throw new Error('resource removal failed');
			}
			if (normalizedTarget.endsWith('/runtime/worker-tasks/shravan/task-cleanup-failures')) {
				throw new Error('runtime removal failed');
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
			await postStopGateway('task-cleanup-failures', zone, [startedProvider], {
				runtimeDir: systemConfig.runtimeDir,
			});
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		const aggregateError = thrownError as AggregateError;
		expect(aggregateError.errors).toEqual([
			expect.objectContaining({ message: 'compose cleanup failed' }),
			expect.objectContaining({ message: 'resource removal failed' }),
			expect.objectContaining({ message: 'runtime removal failed' }),
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

	it('preserves task state while pruning runtime work during shutdown', async () => {
		const { postStopGateway } = await import('./worker-task-runner.js');
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected zone config.');
		}

		const taskRoot = path.join(zone.gateway.stateDir, 'tasks', 'task-keep-state');
		const taskRuntimeRoot = path.join(
			systemConfig.runtimeDir,
			'worker-tasks',
			zone.id,
			'task-keep-state',
		);
		await fs.mkdir(path.join(taskRuntimeRoot, 'work'), { recursive: true });
		await fs.mkdir(path.join(taskRoot, 'state'), { recursive: true });
		await fs.mkdir(path.join(taskRoot, 'agent-vm', 'resources', 'repo-a'), { recursive: true });
		await fs.writeFile(path.join(taskRuntimeRoot, 'work', 'README.md'), 'work data');
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
		await postStopGateway('task-keep-state', zone, [startedProvider], {
			runtimeDir: systemConfig.runtimeDir,
		});

		expect(stopRepoResourceProvidersMock).toHaveBeenCalledWith([startedProvider]);
		await expect(fs.stat(path.join(taskRoot, 'state'))).resolves.toBeDefined();
		await expect(fs.stat(path.join(taskRoot, 'agent-vm', 'resources'))).rejects.toThrow();
		await expect(fs.stat(taskRuntimeRoot)).rejects.toThrow();
	});
});
