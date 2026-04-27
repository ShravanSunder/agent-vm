import { workerConfigSchema } from '@agent-vm/agent-vm-worker';
import { describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from './controller-runtime.js';
import type {
	ExecuteWorkerTaskOptions,
	PreparedWorkerTask,
	PrepareWorkerTaskOptions,
} from './worker-task-runner.js';

const systemConfig = {
	cacheDir: './cache',
	systemConfigPath: './config/system.json',
	systemCacheIdentifierPath: './config/systemCacheIdentifier.json',
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
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				workspaceDir: './workspaces/shravan',
			},
			secrets: {},
			allowedHosts: ['api.anthropic.com'],
			websocketBypass: [],
			toolProfile: 'standard',
		},
	],
	toolProfiles: {
		standard: {
			memory: '1G',
			cpus: 1,
			workspaceRoot: './workspaces/tools',
			imageProfile: 'default',
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies LoadedSystemConfig;

const openClawProcessSpec = {
	bootstrapCommand: 'bootstrap-openclaw',
	guestListenPort: 18789,
	healthCheck: { type: 'http', port: 18789, path: '/' } as const,
	logPath: '/tmp/openclaw.log',
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
			workspaceDir: `/tmp/${taskId}/workspace`,
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

describe('startControllerRuntime', () => {
	it('starts the gateway, creates the controller app, and opens the controller port', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
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
				exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
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
				zoneId: 'shravan',
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
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-1',
					setIngressRoutes: vi.fn(),
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
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
				zoneId: 'shravan',
			}),
		);
		expect(taskTitles).toEqual([
			'Resolving 1Password secrets',
			'Starting gateway zone',
			'Controller API on :18800',
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
		expect(wrongZoneLogsResponse.status).toBe(500);
		const upgradeResponse = await startHttpServerArgs.app.request('/zones/shravan/upgrade', {
			method: 'POST',
		});
		expect(upgradeResponse.status).toBe(200);
		expect(startGatewayZone).toHaveBeenCalledTimes(3);
		expect(zone.gateway.port).toBe(18791);
		expect(closeGatewayVm).toHaveBeenCalledTimes(2);
		expect(setIntervalMock).toHaveBeenCalledTimes(1);
		expect(runtime.controllerPort).toBe(18800);
		expect(runtime.gateway?.vm.id).toBe('gateway-vm-1');
		await runtime.close();
		expect(clearIntervalMock).toHaveBeenCalledTimes(1);
	});

	it('propagates gateway boot failures without starting the HTTP server', async () => {
		const startHttpServer = vi.fn(async () => ({
			close: async () => {},
		}));

		await expect(
			startControllerRuntime(
				{
					systemConfig,
					zoneId: 'shravan',
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
						exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
						id: 'tool-vm-boot-fail',
						setIngressRoutes: vi.fn(),
						getVmInstance: vi.fn(),
					})),
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					startGatewayZone: vi.fn(async () => {
						throw new Error('gateway boot failed');
					}),
					startHttpServer,
				},
			),
		).rejects.toThrow('gateway boot failed');

		expect(startHttpServer).not.toHaveBeenCalled();
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
				systemConfig: workerSystemConfig,
				zoneId: 'shravan',
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
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-worker-stop',
					setIngressRoutes: vi.fn(),
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
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
						exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
						id: 'gateway-vm-worker',
						setIngressRoutes: vi.fn(),
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
					zoneId: 'shravan',
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
						exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
						id: 'tool-vm-worker-task',
						setIngressRoutes: vi.fn(),
						getVmInstance: vi.fn(),
					})),
					createSecretResolver: async () => ({
						resolve: async () => 'controller-token',
						resolveAll: async () => ({}),
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
				zoneId: 'shravan',
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
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-worker-capacity',
					setIngressRoutes: vi.fn(),
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
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
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'gateway-vm-cleanup-test',
					setIngressRoutes: vi.fn(),
					getVmInstance: vi.fn(),
				},
				zone,
			};
		});

		const runtime = await startControllerRuntime(
			{
				systemConfig,
				zoneId: 'shravan',
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
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-cleanup-test',
					setIngressRoutes: vi.fn(),
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
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
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
		const toolVmClose = vi.fn(async () => {});
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
				zoneId: 'shravan',
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: toolVmClose,
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-close',
					setIngressRoutes: vi.fn(),
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
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
					processSpec: openClawProcessSpec,
					vm: {
						close: vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({
							command: 'ssh ...',
							host: '127.0.0.1',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
						id: 'gateway-vm-close',
						setIngressRoutes: vi.fn(),
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

		await startHttpServerArgs.app.request('/lease', {
			body: JSON.stringify({
				agentWorkspaceDir: '/workspace',
				profileId: 'standard',
				scopeKey: 'close-runtime',
				workspaceDir: '/workspace',
				zoneId: 'shravan',
			}),
			headers: {
				'content-type': 'application/json',
			},
			method: 'POST',
		});

		await runtime.close();

		expect(toolVmClose).toHaveBeenCalledTimes(1);
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
				zoneId: 'shravan',
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
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-clean',
					setIngressRoutes: vi.fn(),
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
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
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
						id: 'gateway-vm-clean',
						setIngressRoutes: vi.fn(),
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
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'gateway-vm-close-after-failed-restart',
					setIngressRoutes: vi.fn(),
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
				zoneId: 'shravan',
			},
			{
				createManagedToolVm: vi.fn(async () => ({
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({
						command: 'ssh ...',
						host: '127.0.0.1',
						port: 19000,
						user: 'sandbox',
					})),
					exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
					id: 'tool-vm-close-after-failed-restart',
					setIngressRoutes: vi.fn(),
					getVmInstance: vi.fn(),
				})),
				createSecretResolver: async () => ({
					resolve: async () => '',
					resolveAll: async () => ({}),
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
		expect(refreshResponse.status).toBe(500);
		await expect(runtime.close()).resolves.toBeUndefined();
		expect(closeHttpServer).toHaveBeenCalledTimes(1);
		expect(closeGatewayVm).toHaveBeenCalledTimes(1);
	});
});
