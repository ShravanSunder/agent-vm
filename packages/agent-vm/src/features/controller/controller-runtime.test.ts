import { describe, expect, it, vi } from 'vitest';

import { startControllerRuntime } from './controller-runtime.js';
import type { SystemConfig } from './system-config.js';

const systemConfig = {
	host: {
		controllerPort: 18800,
		secretsProvider: {
			type: '1password',
			serviceAccountTokenEnv: 'OP_SERVICE_ACCOUNT_TOKEN',
		},
	},
	images: {
		gateway: {
			buildConfig: './images/gateway/build-config.json',
			postBuild: [],
		},
		tool: {
			buildConfig: './images/tool/build-config.json',
			postBuild: [],
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
			},
			zone,
		}));
		const startHttpServer = vi.fn(async () => ({
			close: async () => {},
		}));
		const clearIntervalMock = vi.fn();
		const setIntervalMock = vi.fn(() => 123 as unknown as NodeJS.Timeout);

		const runtime = await startControllerRuntime(
			{
				pluginSourceDir: '/plugins/openclaw-gondolin-plugin',
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
				pluginSourceDir: '/plugins/openclaw-gondolin-plugin',
				zoneId: 'shravan',
			}),
		);
		expect(startHttpServer).toHaveBeenCalledWith(
			expect.objectContaining({
				port: 18800,
			}),
		);
		expect(setIntervalMock).toHaveBeenCalledTimes(1);
		expect(runtime.controllerPort).toBe(18800);
		expect(runtime.gateway.vm.id).toBe('gateway-vm-1');
		await runtime.close();
		expect(clearIntervalMock).toHaveBeenCalledTimes(1);
	});
});
