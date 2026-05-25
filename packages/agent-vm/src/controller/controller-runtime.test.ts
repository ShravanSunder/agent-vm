import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { workerConfigSchema } from '@agent-vm/agent-vm-worker';
import { describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

import type { LoadedSystemConfig } from '../config/system-config.js';
import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../testing/managed-vm-test-helpers.js';
import { startControllerRuntime } from './controller-runtime.js';
import type { controllerLeaseCreateRequestSchema } from './http/controller-request-schemas.js';
import type {
	ExecuteWorkerTaskOptions,
	PreparedWorkerTask,
	PrepareWorkerTaskOptions,
} from './worker-task-runner.js';

type ControllerLeaseCreateRequestBody = z.input<typeof controllerLeaseCreateRequestSchema>;

const systemConfig = {
	schemaVersion: 1,
	cacheDir: './cache',
	runtimeDir: './runtime',
	systemConfigPath: './config/system.json',
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
			openclaw: {
				type: 'openclaw',
				buildConfig: './vm-images/gateways/openclaw/build-config.json',
			},
			worker: {
				type: 'worker',
				buildConfig: './vm-images/gateways/worker/build-config.json',
			},
		},
		toolVms: {
			default: {
				type: 'toolVm',
				buildConfig: './vm-images/tool-vms/default/build-config.json',
			},
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
			},
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
	toolVmProfiles: {
		standard: {
			memory: '1G',
			cpus: 1,
			imageProfile: 'default',
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies LoadedSystemConfig;

function createLeaseRequestBody(
	overrides: Partial<ControllerLeaseCreateRequestBody> = {},
): ControllerLeaseCreateRequestBody {
	return {
		agentId: 'main',
		agentWorkspaceDir: '/agent-work',
		profileId: 'standard',
		sessionKey: 'agent:main:controller-runtime-test',
		workMountDir: '/home/openclaw/.openclaw/state/sandboxes/agent/work',
		zoneId: 'shravan',
		...overrides,
	};
}

const openClawProcessSpec = {
	bootstrapCommand: 'bootstrap-openclaw',
	guestListenPort: 18789,
	healthCheck: { type: 'http', port: 18789, path: '/' } as const,
	logPath: '/agent-vm/logs/gateway-boot-latest.log',
	startCommand: 'start-openclaw',
};

const workerProcessSpec = {
	bootstrapCommand: 'bootstrap-worker',
	guestListenPort: 18789,
	healthCheck: { type: 'http', port: 18789, path: '/health' } as const,
	logPath: '/tmp/agent-vm-worker.log',
	startCommand: 'start-worker',
};

function createPreparedWorkerTaskStub(
	taskId: string,
	requestTaskId: string = `request-${taskId}`,
): PreparedWorkerTask {
	const sourceZone = systemConfig.zones[0];
	if (!sourceZone) {
		throw new Error('Expected worker zone.');
	}
	const workerZone = {
		...sourceZone,
		gateway: {
			...sourceZone.gateway,
			type: 'worker' as const,
		},
	};
	return {
		taskId,
		taskRoot: `/tmp/${taskId}`,
		zoneId: 'shravan',
		input: {
			requestTaskId,
			prompt: 'test',
			repos: [],
			context: {},
			resources: { externalResources: {} },
		},
		preStartResult: {
			taskId,
			input: {
				requestTaskId,
				prompt: 'test',
				repos: [],
				context: {},
				resources: { externalResources: {} },
			},
			taskRoot: `/tmp/${taskId}`,
			taskRuntimeRoot: `/tmp/runtime/worker-tasks/shravan/${taskId}`,
			workDir: `/tmp/${taskId}/work`,
			stateDir: `/tmp/${taskId}/state`,
			environment: {},
			startedResourceProviders: [],
			tcpHosts: {},
			vfsMounts: {},
			repos: [],
			effectiveConfig: workerConfigSchema.parse({
				runtimeInstructions: 'Generated runtime instructions.',
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
			}),
		},
		taskZoneConfig: workerZone,
		zone: workerZone,
		eventLogPath: `/tmp/${taskId}/state/tasks/${taskId}.jsonl`,
		recordEvent: async () => {},
	};
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null;
}

function readStringProperty(value: unknown, propertyName: string): string {
	if (typeof value !== 'object' || value === null) {
		throw new Error(`Expected response JSON object with '${propertyName}'.`);
	}
	if (!isUnknownRecord(value)) {
		throw new Error(`Expected response JSON object with '${propertyName}'.`);
	}
	const propertyValue = value[propertyName];
	if (typeof propertyValue !== 'string') {
		throw new Error(`Expected response JSON property '${propertyName}' to be a string.`);
	}
	return propertyValue;
}

describe('startControllerRuntime', () => {
	it('starts the gateway, creates the controller app, and opens the controller port', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const taskTitles: string[] = [];
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const closeGatewayVm = vi.fn(async () => {});
		const startGatewayZone = vi.fn(async () => ({
			image: {
				built: true,
				fingerprint: 'gateway-image',
				imagePath: '/tmp/gateway-image',
			},
			ingress: {
				host: '127.0.0.1',
				port: 18791,
			},
			processSpec: openClawProcessSpec,
			vm: {
				close: closeGatewayVm,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({
					command: 'ssh ...',
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 19000,
					user: 'sandbox',
				})),
				exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
				fs: createManagedVmFsStub(),
				getHostPid: vi.fn(() => 48282),
				id: 'gateway-vm-1',
				setIngressRoutes: vi.fn(),
				getVmInstance: vi.fn(),
			},
			zone,
		}));
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const startHttpServer = vi.fn(
			async (options: {
				app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
				port: number;
			}) => {
				startHttpServerArgs = options;
				return {
					close: async () => {},
				};
			},
		);
		const clearIntervalMock = vi.fn();
		const fakeInterval = setTimeout(() => undefined, 0);
		clearTimeout(fakeInterval);
		const setIntervalMock = vi.fn(() => fakeInterval);

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					fs: createManagedVmFsStub(),
					id: 'tool-vm-1',
					setIngressRoutes: vi.fn(),
					getHostPid: () => 12345,
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				clearIntervalImpl: clearIntervalMock,
				runTask: async (title, fn) => {
					taskTitles.push(title);
					await fn();
				},
				startGatewayZone,
				startHttpServer,
				setIntervalImpl: setIntervalMock,
			},
		);

		expect(startGatewayZone).toHaveBeenCalledWith(
			expect.objectContaining({
				runTask: expect.any(Function),
				runtimeEnvironment: {
					AGENT_VM_ZONE_GIT_TOKEN: expect.any(String),
				},
				runtimePluginConfigs: {
					gondolin: { zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN' },
				},
				zoneId: 'shravan',
			}),
		);
		expect(taskTitles).toEqual([
			'Resolving 1Password secrets',
			'Controller API on :18800',
			'Starting selected gateway zones',
		]);
		expect(startHttpServer).toHaveBeenCalledWith(
			expect.objectContaining({
				port: 18800,
			}),
		);
		if (!startHttpServerArgs) {
			throw new Error('Expected startHttpServer to be called.');
		}
		const statusResponse = await startHttpServerArgs.app.request('/controller-status');
		expect(statusResponse.status).toBe(200);
		await expect(statusResponse.json()).resolves.toMatchObject({
			controllerPort: 18800,
			zones: expect.arrayContaining([
				expect.objectContaining({
					activeLeaseCount: 0,
					bootedAt: expect.any(String),
					id: 'shravan',
					running: true,
					vmId: 'gateway-vm-1',
				}),
			]),
		});
		const zoneStatusResponse = await startHttpServerArgs.app.request('/zones/shravan/status');
		expect(zoneStatusResponse.status).toBe(200);
		await expect(zoneStatusResponse.json()).resolves.toMatchObject({
			bootedAt: expect.any(String),
			id: 'shravan',
			running: true,
			vmId: 'gateway-vm-1',
		});
		const refreshResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/credentials/refresh',
			{ method: 'POST' },
		);
		expect(refreshResponse.status).toBe(200);
		const wrongZoneLogsResponse = await startHttpServerArgs.app.request('/zones/alevtina/logs');
		expect(wrongZoneLogsResponse.status).toBe(404);
		const upgradeResponse = await startHttpServerArgs.app.request('/zones/shravan/upgrade', {
			method: 'POST',
		});
		expect(upgradeResponse.status).toBe(200);
		expect(startGatewayZone).toHaveBeenCalledTimes(3);
		expect(zone.gateway.port).toBe(18791);
		expect(closeGatewayVm).toHaveBeenCalledTimes(2);
		expect(setIntervalMock).toHaveBeenCalledTimes(1);
		expect(runtime.controllerPort).toBe(18800);
		expect(runtime.zones).toEqual([
			expect.objectContaining({
				gateway: {
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					vm: {
						hostPid: 48282,
						id: 'gateway-vm-1',
					},
				},
				lifecycleState: 'running',
				zoneId: 'shravan',
			}),
		]);
		await runtime.close();
		expect(clearIntervalMock).toHaveBeenCalledTimes(1);
	});

	it('reaps stale active uses before releasing expired idle leases', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-active-use-reap-'));
		const stateDir = path.join(tempRoot, 'state', 'shravan');
		const zoneFilesDir = path.join(tempRoot, 'zone-files', 'shravan');
		await mkdir(path.join(stateDir, 'sandboxes', 'agent', 'work'), { recursive: true });
		await mkdir(zoneFilesDir, { recursive: true });
		const runtimeSystemConfig = {
			...systemConfig,
			runtimeDir: path.join(tempRoot, 'runtime'),
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					stateDir,
					zoneFilesDir,
				},
			})),
			leaseIdleTtl: {
				defaultMs: 1_000,
				maxRequestedMs: 60_000,
				minRequestedMs: 1_000,
			},
		} satisfies LoadedSystemConfig;
		const runtimeZone = runtimeSystemConfig.zones[0];
		if (!runtimeZone) {
			throw new Error('Expected runtime test zone.');
		}
		let now = 1_000;
		let runReaper: (() => void | Promise<void>) | undefined;
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const fakeInterval = setTimeout(() => undefined, 0);
		clearTimeout(fakeInterval);
		try {
			const closeToolVm = vi.fn(async () => {});
			const runtime = await startControllerRuntime(
				{
					systemConfig: runtimeSystemConfig,
					zoneIds: ['shravan'],
				},
				{
					createManagedToolVm: vi.fn(async () => ({
						close: closeToolVm,
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						fs: createManagedVmFsStub(),
						id: 'tool-vm-active-use-reap',
						setIngressRoutes: vi.fn(),
						getHostPid: () => 12345,
						getVmInstance: vi.fn(),
					})),
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					now: () => now,
					readIdentityPem: async () => 'pem',
					runTask: async (_title, fn) => {
						await fn();
					},
					setIntervalImpl: (callback) => {
						runReaper = callback;
						return fakeInterval;
					},
					startGatewayZone: vi.fn(async () => ({
						image: {
							built: true,
							fingerprint: 'gateway-image',
							imagePath: '/tmp/gateway-image',
						},
						ingress: {
							host: '127.0.0.1',
							port: 18791,
						},
						processSpec: openClawProcessSpec,
						vm: {
							close: vi.fn(async () => {}),
							enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
							enableSsh: vi.fn(async () => ({
								command: 'ssh ...',
								host: '127.0.0.1',
								identityFile: '/tmp/key',
								port: 19000,
								user: 'sandbox',
							})),
							exec: vi.fn(() =>
								createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
							),
							fs: createManagedVmFsStub(),
							id: 'gateway-vm-active-use-reap',
							setIngressRoutes: vi.fn(),
							getHostPid: () => 12345,
							getVmInstance: vi.fn(),
						},
						zone: runtimeZone,
					})),
					startHttpServer: async (options) => {
						startHttpServerArgs = options;
						return { close: async () => {} };
					},
				},
			);
			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}
			if (!runReaper) {
				throw new Error('Expected lease reaper callback to be registered.');
			}
			const runtimeStatusResponse = await startHttpServerArgs.app.request(
				'/zones/shravan/openclaw-runtime-status',
				{
					body: JSON.stringify({
						pluginId: 'gondolin',
						zoneId: 'shravan',
						findings: [
							{
								id: 'openclaw-tool-vm-agents-defaults-sandbox-backend-shravan-defaults',
								ok: true,
								hint: 'agents.defaults.sandbox.backend=gondolin',
							},
						],
					}),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				},
			);
			expect(runtimeStatusResponse.status).toBe(200);

			const leaseResponse = await startHttpServerArgs.app.request('/lease', {
				body: JSON.stringify(
					createLeaseRequestBody({
						agentId: 'active-use-reap',
						sessionKey: 'agent:active-use-reap:controller-runtime-test',
					}),
				),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			const leasePayload: unknown = await leaseResponse.json();
			expect(leaseResponse.status, JSON.stringify(leasePayload)).toBe(200);
			const leaseId = readStringProperty(leasePayload, 'leaseId');
			const activeUseResponse = await startHttpServerArgs.app.request(`/lease/${leaseId}/uses`, {
				body: JSON.stringify({
					useId: '01890f00-0000-7000-8000-000000000000',
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			expect(activeUseResponse.status).toBe(200);

			now = 123_001;
			await runReaper();

			expect(closeToolVm).toHaveBeenCalledTimes(1);
			await runtime.close();
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it('force releases active-use leases during controller shutdown', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const tempRoot = await mkdtemp(path.join(tmpdir(), 'agent-vm-active-use-close-'));
		const stateDir = path.join(tempRoot, 'state', 'shravan');
		const zoneFilesDir = path.join(tempRoot, 'zone-files', 'shravan');
		await mkdir(path.join(stateDir, 'sandboxes', 'agent', 'work'), { recursive: true });
		await mkdir(zoneFilesDir, { recursive: true });
		const runtimeSystemConfig = {
			...systemConfig,
			runtimeDir: path.join(tempRoot, 'runtime'),
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					stateDir,
					zoneFilesDir,
				},
			})),
		} satisfies LoadedSystemConfig;
		const runtimeZone = runtimeSystemConfig.zones[0];
		if (!runtimeZone) {
			throw new Error('Expected runtime test zone.');
		}
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const fakeInterval = setTimeout(() => undefined, 0);
		clearTimeout(fakeInterval);
		try {
			const closeToolVm = vi.fn(async () => {});
			const runtime = await startControllerRuntime(
				{
					systemConfig: runtimeSystemConfig,
					zoneIds: ['shravan'],
				},
				{
					createManagedToolVm: vi.fn(async () => ({
						close: closeToolVm,
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						fs: createManagedVmFsStub(),
						id: 'tool-vm-active-use-shutdown',
						setIngressRoutes: vi.fn(),
						getHostPid: () => 12345,
						getVmInstance: vi.fn(),
					})),
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					readIdentityPem: async () => 'pem',
					runTask: async (_title, fn) => {
						await fn();
					},
					setIntervalImpl: () => fakeInterval,
					startGatewayZone: vi.fn(async () => ({
						image: {
							built: true,
							fingerprint: 'gateway-image',
							imagePath: '/tmp/gateway-image',
						},
						ingress: {
							host: '127.0.0.1',
							port: 18791,
						},
						processSpec: openClawProcessSpec,
						vm: {
							close: vi.fn(async () => {}),
							enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
							enableSsh: vi.fn(async () => ({
								command: 'ssh ...',
								host: '127.0.0.1',
								identityFile: '/tmp/key',
								port: 19000,
								user: 'sandbox',
							})),
							exec: vi.fn(() =>
								createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
							),
							fs: createManagedVmFsStub(),
							id: 'gateway-vm-active-use-shutdown',
							setIngressRoutes: vi.fn(),
							getHostPid: () => 12345,
							getVmInstance: vi.fn(),
						},
						zone: runtimeZone,
					})),
					startHttpServer: async (options) => {
						startHttpServerArgs = options;
						return { close: async () => {} };
					},
				},
			);
			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}
			const runtimeStatusResponse = await startHttpServerArgs.app.request(
				'/zones/shravan/openclaw-runtime-status',
				{
					body: JSON.stringify({
						pluginId: 'gondolin',
						zoneId: 'shravan',
						findings: [
							{
								id: 'openclaw-tool-vm-agents-defaults-sandbox-backend-shravan-defaults',
								ok: true,
								hint: 'agents.defaults.sandbox.backend=gondolin',
							},
						],
					}),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				},
			);
			expect(runtimeStatusResponse.status).toBe(200);

			const leaseResponse = await startHttpServerArgs.app.request('/lease', {
				body: JSON.stringify(
					createLeaseRequestBody({
						agentId: 'active-use-shutdown',
						sessionKey: 'agent:active-use-shutdown:controller-runtime-test',
					}),
				),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			const leasePayload: unknown = await leaseResponse.json();
			expect(leaseResponse.status, JSON.stringify(leasePayload)).toBe(200);
			const leaseId = readStringProperty(leasePayload, 'leaseId');
			const activeUseResponse = await startHttpServerArgs.app.request(`/lease/${leaseId}/uses`, {
				body: JSON.stringify({
					useId: '01890f00-0000-7000-8000-000000000001',
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			expect(activeUseResponse.status).toBe(200);

			await runtime.close();

			expect(closeToolVm).toHaveBeenCalledTimes(1);
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	it('keeps the controller inspectable when a selected gateway fails to boot', async () => {
		const startHttpServer = vi.fn(async () => ({
			close: async () => {},
		}));

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					fs: createManagedVmFsStub(),
					id: 'tool-vm-boot-fail',
					setIngressRoutes: vi.fn(),
					getHostPid: () => 12345,
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				startGatewayZone: vi.fn(async () => {
					throw new Error('gateway boot failed');
				}),
				startHttpServer,
			},
		);

		expect(runtime.zones).toEqual([
			{
				lastError: 'gateway boot failed',
				lifecycleState: 'failed',
				zoneId: 'shravan',
			},
		]);
		expect(startHttpServer).toHaveBeenCalledTimes(1);
		await runtime.close();
	});

	it('registers stop-controller for worker runtimes', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
			})),
		};
		const workerZone = workerSystemConfig.zones[0];
		if (!workerZone) {
			throw new Error('Expected worker test zone.');
		}
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const startHttpServer = vi.fn(
			async (options: {
				app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
				port: number;
			}) => {
				startHttpServerArgs = options;
				return {
					close: async () => {},
				};
			},
		);

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					fs: createManagedVmFsStub(),
					id: 'tool-vm-worker-stop',
					setIngressRoutes: vi.fn(),
					getHostPid: () => 12345,
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				startGatewayZone: vi.fn(async () => ({
					image: {
						built: true,
						fingerprint: 'gateway-image',
						imagePath: '/tmp/gateway-image',
					},
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					processSpec: workerProcessSpec,
					vm: {
						close: vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						fs: createManagedVmFsStub(),
						id: 'gateway-vm-worker',
						setIngressRoutes: vi.fn(),
						getHostPid: () => 12345,
						getVmInstance: vi.fn(),
					},
					zone: workerZone,
				})),
				startHttpServer,
			},
		);

		if (!startHttpServerArgs) {
			throw new Error('Expected startHttpServer to be called.');
		}
		const stopResponse = await startHttpServerArgs.app.request('/stop-controller', {
			method: 'POST',
		});
		expect(stopResponse.status).toBe(200);
		await expect(stopResponse.json()).resolves.toMatchObject({ ok: true });
		await runtime.close();
	});

	it('passes the controller GitHub token to worker task cloning', async () => {
		const previousGithubToken = process.env.GITHUB_TOKEN;
		process.env.GITHUB_TOKEN = 'controller-token';
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			host: {
				...systemConfig.host,
				githubToken: {
					source: 'environment',
					envVar: 'GITHUB_TOKEN',
				},
			},
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
			})),
		};
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const prepareWorkerTask = vi.fn(async () => createPreparedWorkerTaskStub('worker-task-1'));
		const executeWorkerTask = vi.fn(async () => ({
			taskId: 'worker-task-1',
			finalState: { status: 'completed' },
			taskRoot: '/tmp/worker-task-1',
		}));
		const startHttpServer = vi.fn(
			async (options: {
				app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
				port: number;
			}) => {
				startHttpServerArgs = options;
				return {
					close: async () => {},
				};
			},
		);

		try {
			const runtime = await startControllerRuntime(
				{
					systemConfig: workerSystemConfig,
					zoneIds: ['shravan'],
				},
				{
					createManagedToolVm: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						fs: createManagedVmFsStub(),
						id: 'tool-vm-worker-task',
						setIngressRoutes: vi.fn(),
						getHostPid: () => 12345,
						getVmInstance: vi.fn(),
					})),
					createSecretResolver: async () => ({
						resolve: async () => 'controller-token',
						resolveAll: async () => ({}),
					}),
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					prepareWorkerTask,
					executeWorkerTask,
					startGatewayZone: vi.fn(async () => {
						throw new Error('worker runtime should not start persistent gateway');
					}),
					startHttpServer,
				},
			);

			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}
			const response = await startHttpServerArgs.app.request('/zones/shravan/worker-tasks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					requestTaskId: 'request-task-1',
					prompt: 'fix private repo task',
					repos: [{ repoUrl: 'https://github.com/org/private.git', baseBranch: 'main' }],
					context: {},
				}),
			});

			expect(response.status).toBe(202);
			expect(prepareWorkerTask).toHaveBeenCalledWith(
				expect.objectContaining({
					githubToken: 'controller-token',
				}),
			);
			await runtime.close();
		} finally {
			if (previousGithubToken === undefined) {
				delete process.env.GITHUB_TOKEN;
			} else {
				process.env.GITHUB_TOKEN = previousGithubToken;
			}
		}
	});

	it('exposes zone Git status through the controller using the host GitHub token', async () => {
		const previousGithubToken = process.env.GITHUB_TOKEN;
		const previousOpToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
		process.env.GITHUB_TOKEN = 'controller-token';
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'op-token';
		const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-vm-zone-git-runtime-'));
		const zoneFilesDir = path.join(tempDir, 'zone-files', 'shravan');
		await mkdir(zoneFilesDir, { recursive: true });
		const zoneGitSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			runtimeDir: path.join(tempDir, 'runtime'),
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					stateDir: path.join(tempDir, 'state', zone.id),
					zoneFilesDir,
					zoneGit: {
						remote: {
							repoUrl: 'https://github.com/shravansunder/zone-files.git',
							branch: 'main',
						},
					},
				},
			})),
		};
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const startHttpServer = vi.fn(
			async (options: {
				app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
				port: number;
			}) => {
				startHttpServerArgs = options;
				return {
					close: async () => {},
				};
			},
		);

		try {
			const runtime = await startControllerRuntime(
				{
					systemConfig: zoneGitSystemConfig,
					zoneIds: [],
				},
				{
					createSecretResolver: async () => ({
						resolve: async () => 'controller-token',
						resolveAll: async () => ({}),
					}),
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					startGatewayZone: vi.fn(async () => {
						throw new Error('zone git status should not require a booted gateway');
					}),
					startHttpServer,
				},
			);

			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}
			const response = await startHttpServerArgs.app.request('/zones/shravan/zone-git/status');

			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toMatchObject({
				branch: 'main',
				initialized: false,
				localHead: null,
				remoteHead: null,
			});
			await runtime.close();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
			if (previousGithubToken === undefined) {
				delete process.env.GITHUB_TOKEN;
			} else {
				process.env.GITHUB_TOKEN = previousGithubToken;
			}
			if (previousOpToken === undefined) {
				delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
			} else {
				process.env.OP_SERVICE_ACCOUNT_TOKEN = previousOpToken;
			}
		}
	});

	it('reports a configuration error when zone Git is configured without a controller GitHub token', async () => {
		const previousGithubToken = process.env.GITHUB_TOKEN;
		const previousOpToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
		delete process.env.GITHUB_TOKEN;
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'op-token';
		const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-vm-zone-git-runtime-'));
		const zoneGitSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			runtimeDir: path.join(tempDir, 'runtime'),
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					stateDir: path.join(tempDir, 'state', zone.id),
					zoneFilesDir: path.join(tempDir, 'zone-files', zone.id),
					zoneGit: {
						remote: {
							repoUrl: 'https://github.com/shravansunder/zone-files.git',
							branch: 'main',
						},
					},
				},
			})),
		};
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		const startHttpServer = vi.fn(
			async (options: {
				app: { request(path: string, init?: RequestInit): Response | Promise<Response> };
				port: number;
			}) => {
				startHttpServerArgs = options;
				return {
					close: async () => {},
				};
			},
		);

		try {
			const runtime = await startControllerRuntime(
				{
					systemConfig: zoneGitSystemConfig,
					zoneIds: [],
				},
				{
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					startGatewayZone: vi.fn(async () => {
						throw new Error('zone git status should not require a booted gateway');
					}),
					startHttpServer,
				},
			);

			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}
			const response = await startHttpServerArgs.app.request('/zones/shravan/zone-git/status');

			expect(response.status).toBe(412);
			await expect(response.json()).resolves.toEqual({
				error:
					"zoneGit for zone 'shravan' requires host.githubToken so the controller can push without exposing credentials to VMs.",
			});
			await runtime.close();
		} finally {
			await rm(tempDir, { recursive: true, force: true });
			if (previousGithubToken !== undefined) {
				process.env.GITHUB_TOKEN = previousGithubToken;
			}
			if (previousOpToken === undefined) {
				delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
			} else {
				process.env.OP_SERVICE_ACCOUNT_TOKEN = previousOpToken;
			}
		}
	});

	it('rejects a second worker task while the pod is already occupied', async () => {
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
			})),
		};
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;
		let resolveExecute: (() => Promise<void>) | undefined;
		let taskCounter = 0;
		const prepareWorkerTask = vi.fn(async (options: PrepareWorkerTaskOptions) => {
			taskCounter += 1;
			const prepared = createPreparedWorkerTaskStub(
				`worker-task-${String(taskCounter)}`,
				options.input.requestTaskId,
			);
			await options.onTaskPrepared?.({
				taskId: prepared.taskId,
				zoneId: prepared.zoneId,
				taskRoot: prepared.taskRoot,
				eventLogPath: prepared.eventLogPath,
				branchPrefix: prepared.preStartResult.effectiveConfig.branchPrefix,
				repos: [],
				workerIngress: null,
			});
			return prepared;
		});
		const executeWorkerTask = vi.fn(
			async (prepared, options: ExecuteWorkerTaskOptions) =>
				await new Promise<{
					taskId: string;
					finalState: { status: 'completed' };
					taskRoot: string;
				}>((resolve) => {
					resolveExecute = async () => {
						await options.onTaskFinished?.(prepared.zoneId, prepared.taskId);
						resolve({
							taskId: prepared.taskId,
							finalState: { status: 'completed' },
							taskRoot: prepared.taskRoot,
						});
					};
				}),
		);

		const runtime = await startControllerRuntime(
			{
				systemConfig: workerSystemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					fs: createManagedVmFsStub(),
					id: 'tool-vm-worker-capacity',
					setIngressRoutes: vi.fn(),
					getHostPid: () => 12345,
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				prepareWorkerTask,
				executeWorkerTask,
				startGatewayZone: vi.fn(async () => {
					throw new Error('worker runtime should not start persistent gateway');
				}),
				startHttpServer: vi.fn(async (options) => {
					startHttpServerArgs = options;
					return {
						close: async () => {},
					};
				}),
			},
		);

		try {
			if (!startHttpServerArgs) {
				throw new Error('Expected startHttpServer to be called.');
			}

			const firstResponse = await startHttpServerArgs.app.request('/zones/shravan/worker-tasks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					requestTaskId: 'request-task-1',
					prompt: 'first task',
					repos: [],
					context: {},
				}),
			});
			expect(firstResponse.status).toBe(202);

			const secondResponse = await startHttpServerArgs.app.request('/zones/shravan/worker-tasks', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					requestTaskId: 'request-task-2',
					prompt: 'second task',
					repos: [],
					context: {},
				}),
			});

			expect(secondResponse.status).toBe(409);
			await expect(secondResponse.json()).resolves.toMatchObject({
				status: 'at-capacity',
				error: expect.stringContaining('at capacity'),
			});
			expect(prepareWorkerTask).toHaveBeenCalledTimes(1);

			await resolveExecute?.();
		} finally {
			await runtime.close();
		}
	});

	it('deletes the runtime record on close after the gateway stops', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const callOrder: string[] = [];
		const deleteGatewayRuntimeRecord = vi.fn(async () => {
			callOrder.push('delete-record');
		});
		const closeGatewayVm = vi.fn(async () => {
			callOrder.push('close-gateway');
		});
		const startGatewayZone = vi.fn(async () => {
			callOrder.push('start-gateway');
			return {
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imagePath: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
				vm: {
					close: closeGatewayVm,
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					fs: createManagedVmFsStub(),
					id: 'gateway-vm-cleanup-test',
					setIngressRoutes: vi.fn(),
					getHostPid: () => 12345,
					getVmInstance: vi.fn(),
				},
				zone,
			};
		});

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					fs: createManagedVmFsStub(),
					id: 'tool-vm-cleanup-test',
					setIngressRoutes: vi.fn(),
					getHostPid: () => 12345,
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				deleteGatewayRuntimeRecord,
				startGatewayZone,
				startHttpServer: vi.fn(async () => ({
					close: async () => {},
				})),
			},
		);

		expect(callOrder).toEqual(['start-gateway']);

		await runtime.close();

		expect(closeGatewayVm).toHaveBeenCalledTimes(1);
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith(zone.gateway.stateDir);
		expect(callOrder.slice(-2)).toEqual(['close-gateway', 'delete-record']);
	});

	it('releases active leases when runtime.close is called', async () => {
		const tempDir = await mkdtemp(path.join(tmpdir(), 'agent-vm-runtime-close-'));
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const openClawConfigPath = path.join(tempDir, 'openclaw.json');
		await writeFile(
			openClawConfigPath,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: {
							backend: 'gondolin',
							mode: 'all',
							scope: 'agent',
							workspaceAccess: 'rw',
						},
						workspace: '/zone/agents/default',
					},
					list: [],
				},
			}),
			'utf8',
		);
		const testSystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zoneConfig) => ({
				...zoneConfig,
				gateway:
					zoneConfig.gateway.type === 'openclaw'
						? {
								...zoneConfig.gateway,
								config: openClawConfigPath,
								stateDir: path.join(tempDir, 'state', zoneConfig.id),
								zoneFilesDir: path.join(tempDir, 'zone-files', zoneConfig.id),
							}
						: zoneConfig.gateway,
			})),
		} satisfies LoadedSystemConfig;
		const zone = testSystemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const toolVmClose = vi.fn(async () => {});
		await mkdir(path.join(tempDir, 'zone-files', 'shravan', 'sandbox-work'), { recursive: true });
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;

		try {
			const runtime = await startControllerRuntime(
				{
					systemConfig: testSystemConfig,
					zoneIds: ['shravan'],
				},
				{
					createManagedToolVm: vi.fn(async () => ({
						close: toolVmClose,
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						fs: createManagedVmFsStub(),
						id: 'tool-vm-close',
						setIngressRoutes: vi.fn(),
						getHostPid: () => 12345,
						getVmInstance: vi.fn(),
					})),
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					readProcessIdentity: async () => ({
						command: 'qemu-system-x86_64 -m 1G',
						lstart: 'Fri May 22 10:00:00 2026',
					}),
					readIdentityPem: async () => 'pem',
					startGatewayZone: vi.fn(async () => ({
						image: {
							built: true,
							fingerprint: 'gateway-image',
							imagePath: '/tmp/gateway-image',
						},
						ingress: {
							host: '127.0.0.1',
							port: 18791,
						},
						processSpec: openClawProcessSpec,
						vm: {
							close: vi.fn(async () => {}),
							enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
							enableSsh: vi.fn(async () => ({
								command: 'ssh ...',
								host: '127.0.0.1',
								identityFile: '/tmp/key',
								port: 19000,
								user: 'sandbox',
							})),
							exec: vi.fn(() =>
								createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
							),
							fs: createManagedVmFsStub(),
							id: 'gateway-vm-close',
							setIngressRoutes: vi.fn(),
							getHostPid: () => 12345,
							getVmInstance: vi.fn(),
						},
						zone,
					})),
					startHttpServer: vi.fn(async (options) => {
						startHttpServerArgs = options;
						return {
							close: async () => {},
						};
					}),
				},
			);

			if (!startHttpServerArgs) {
				throw new Error('Expected runtime HTTP server args');
			}

			const runtimeStatusResponse = await startHttpServerArgs.app.request(
				'/zones/shravan/openclaw-runtime-status',
				{
					body: JSON.stringify({
						pluginId: 'gondolin',
						zoneId: 'shravan',
						findings: [
							{
								id: 'openclaw-tool-vm-agents-defaults-sandbox-backend-shravan-defaults',
								ok: true,
								hint: 'agents.defaults.sandbox.backend=gondolin',
							},
						],
					}),
					headers: {
						'content-type': 'application/json',
					},
					method: 'POST',
				},
			);
			expect(runtimeStatusResponse.status).toBe(200);

			const leaseResponse = await startHttpServerArgs.app.request('/lease', {
				body: JSON.stringify(
					createLeaseRequestBody({
						agentId: 'close-runtime',
						agentWorkspaceDir: '/zone',
						sessionKey: 'agent:close-runtime:controller-runtime-test',
						workMountDir: '/zone/sandbox-work',
					}),
				),
				headers: {
					'content-type': 'application/json',
				},
				method: 'POST',
			});

			expect(leaseResponse.status).toBe(200);
			await runtime.close();

			expect(toolVmClose).toHaveBeenCalledTimes(1);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it('surfaces runtime record deletion failures during shutdown', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const closeGatewayVm = vi.fn(async () => {});

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					fs: createManagedVmFsStub(),
					id: 'tool-vm-clean',
					setIngressRoutes: vi.fn(),
					getHostPid: () => 12345,
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				deleteGatewayRuntimeRecord: async () => {
					throw new Error('permission denied');
				},
				startGatewayZone: vi.fn(async () => ({
					image: {
						built: true,
						fingerprint: 'gateway-image',
						imagePath: '/tmp/gateway-image',
					},
					ingress: {
						host: '127.0.0.1',
						port: 18791,
					},
					processSpec: openClawProcessSpec,
					vm: {
						close: closeGatewayVm,
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({
							command: 'ssh ...',
							host: '127.0.0.1',
							identityFile: '/tmp/key',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(() =>
							createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' }),
						),
						fs: createManagedVmFsStub(),
						id: 'gateway-vm-clean',
						setIngressRoutes: vi.fn(),
						getHostPid: () => 12345,
						getVmInstance: vi.fn(),
					},
					zone,
				})),
				startHttpServer: vi.fn(async () => ({
					close: async () => {},
				})),
			},
		);

		await expect(runtime.close()).rejects.toThrow('permission denied');
		expect(closeGatewayVm).toHaveBeenCalledTimes(1);
	});

	it('still closes the HTTP server when gateway restart fails before runtime.close', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const closeGatewayVm = vi.fn(async () => {});
		const closeHttpServer = vi.fn(async () => {});
		const startGatewayZone = vi
			.fn()
			.mockResolvedValueOnce({
				image: {
					built: true,
					fingerprint: 'gateway-image',
					imagePath: '/tmp/gateway-image',
				},
				ingress: {
					host: '127.0.0.1',
					port: 18791,
				},
				processSpec: openClawProcessSpec,
				vm: {
					close: closeGatewayVm,
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					fs: createManagedVmFsStub(),
					id: 'gateway-vm-close-after-failed-restart',
					setIngressRoutes: vi.fn(),
					getHostPid: () => 12345,
					getVmInstance: vi.fn(),
				},
				zone,
			})
			.mockRejectedValueOnce(new Error('restart failed'));
		let startHttpServerArgs:
			| {
					app: {
						request(path: string, init?: RequestInit): Response | Promise<Response>;
					};
					port: number;
			  }
			| undefined;

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneIds: ['shravan'],
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(() => createManagedExecProcessStub({ exitCode: 0, stderr: '', stdout: '' })),
					fs: createManagedVmFsStub(),
					id: 'tool-vm-close-after-failed-restart',
					setIngressRoutes: vi.fn(),
					getHostPid: () => 12345,
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
				}),
				readProcessIdentity: async () => ({
					command: 'qemu-system-x86_64 -m 1G',
					lstart: 'Fri May 22 10:00:00 2026',
				}),
				startGatewayZone,
				startHttpServer: vi.fn(async (options) => {
					startHttpServerArgs = options;
					return {
						close: closeHttpServer,
					};
				}),
			},
		);

		if (!startHttpServerArgs) {
			throw new Error('Expected runtime HTTP server args');
		}

		const refreshResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/credentials/refresh',
			{ method: 'POST' },
		);
		expect(refreshResponse.status).toBe(503);
		await expect(runtime.close()).resolves.toBeUndefined();
		expect(closeHttpServer).toHaveBeenCalledTimes(1);
		expect(closeGatewayVm).toHaveBeenCalledTimes(1);
	});
});
