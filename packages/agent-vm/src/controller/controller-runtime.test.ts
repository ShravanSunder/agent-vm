import { describe, expect, it, vi } from 'vitest';

import { startControllerRuntime } from './controller-runtime.js';
import type { SystemConfig } from './system-config.js';

const systemConfig = {
	cacheDir: './cache',
	host: {
		controllerPort: 18800,
		secretsProvider: {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
		},
	},
	images: {
		gateway: {
			buildConfig: './images/gateway/build-config.json',
		},
		tool: {
			buildConfig: './images/tool/build-config.json',
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				memory: '2G',
				cpus: 2,
				port: 18791,
				openclawConfig: './config/shravan/openclaw.json',
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
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
} satisfies SystemConfig;

describe('startControllerRuntime', () => {
	it('starts the gateway, creates the controller app, and opens the controller port', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}
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
		const setIntervalMock = vi.fn(() => 123 as unknown as NodeJS.Timeout);

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
				startGatewayZone,
				startHttpServer,
				setIntervalImpl: setIntervalMock,
			},
		);

		expect(startGatewayZone).toHaveBeenCalledWith(
			expect.objectContaining({
				zoneId: 'shravan',
			}),
		);
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
		});
		const refreshResponse = await startHttpServerArgs.app.request(
			'/zones/shravan/credentials/refresh',
			{ method: 'POST' },
		);
		expect(refreshResponse.status).toBe(200);
		const upgradeResponse = await startHttpServerArgs.app.request('/zones/shravan/upgrade', {
			method: 'POST',
		});
		expect(upgradeResponse.status).toBe(200);
		expect(startGatewayZone).toHaveBeenCalledTimes(3);
		expect(setIntervalMock).toHaveBeenCalledTimes(1);
		expect(runtime.controllerPort).toBe(18800);
		expect(runtime.gateway.vm.id).toBe('gateway-vm-1');
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
});
