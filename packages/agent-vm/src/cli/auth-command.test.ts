import { describe, expect, it, vi } from 'vitest';

import type { ControllerClient } from '../controller/controller-client.js';
import type { SystemConfig } from '../controller/system-config.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { runAuthCommand } from './auth-command.js';

function createAuthSystemConfig(): SystemConfig {
	return {
		cacheDir: './cache',
		host: {
			controllerPort: 18800,
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env' },
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
		tcpPool: {
			basePort: 19000,
			size: 5,
		},
		toolProfiles: {
			standard: {
				cpus: 1,
				memory: '1G',
				workspaceRoot: './workspaces/tools',
			},
		},
		zones: [
			{
				allowedHosts: ['api.anthropic.com'],
				gateway: {
					type: 'openclaw',
					cpus: 2,
					memory: '2G',
					openclawConfig: './config/shravan/openclaw.json',
					port: 18791,
					stateDir: './state/shravan',
					workspaceDir: './workspaces/shravan',
				},
				id: 'shravan',
				secrets: {},
				toolProfile: 'standard',
				websocketBypass: [],
			},
		],
	};
}

function createControllerClientStub(
	enableZoneSsh: ControllerClient['enableZoneSsh'],
): ControllerClient {
	return {
		destroyZone: async () => ({}),
		enableZoneSsh,
		getControllerStatus: async () => ({}),
		getZoneLogs: async () => ({}),
		listLeases: async () => [],
		refreshZoneCredentials: async () => ({}),
		releaseLease: async () => {},
		stopController: async () => ({}),
		upgradeZone: async () => ({}),
	};
}

describe('runAuthCommand', () => {
	it('opens an interactive SSH session that runs openclaw auth login for the requested plugin', async () => {
		const runInteractiveProcess = vi.fn(async () => {});
		const systemConfig = createAuthSystemConfig();

		await runAuthCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => ({
					...createControllerClientStub(async () => ({
						host: '127.0.0.1',
						identityFile: '/tmp/test-key',
						port: 19000,
						user: 'root',
					})),
				}),
				runInteractiveProcess,
			},
			io: {
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			pluginName: 'codex',
			systemConfig,
			zoneId: 'shravan',
		});

		expect(runInteractiveProcess).toHaveBeenCalledWith('ssh', [
			'-t',
			'-o',
			'StrictHostKeyChecking=no',
			'-o',
			'UserKnownHostsFile=/dev/null',
			'-i',
			'/tmp/test-key',
			'-p',
			'19000',
			'root@127.0.0.1',
			'openclaw',
			'models',
			'auth',
			'login',
			'--provider',
			'codex',
		]);
	});

	it('throws when the controller returns an invalid SSH response', async () => {
		await expect(
			runAuthCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: () => createControllerClientStub(async () => 'not-an-object'),
				},
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				pluginName: 'codex',
				systemConfig: createAuthSystemConfig(),
				zoneId: 'shravan',
			}),
		).rejects.toThrow('Controller returned an invalid SSH response.');
	});

	it('throws when the controller omits host or port', async () => {
		await expect(
			runAuthCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: () =>
						createControllerClientStub(async () => ({
							user: 'root',
						})),
				},
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				pluginName: 'codex',
				systemConfig: createAuthSystemConfig(),
				zoneId: 'shravan',
			}),
		).rejects.toThrow("Cannot auth: controller returned incomplete SSH access for zone 'shravan'.");
	});

	it('wraps SSH failures with plugin and zone context', async () => {
		const runInteractiveProcess = vi.fn(async () => {
			throw new Error('connect ECONNREFUSED');
		});

		await expect(
			runAuthCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: () =>
						createControllerClientStub(async () => ({
							host: '127.0.0.1',
							port: 19000,
							user: 'root',
						})),
					runInteractiveProcess,
				},
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				pluginName: 'codex',
				systemConfig: createAuthSystemConfig(),
				zoneId: 'shravan',
			}),
		).rejects.toThrow("Auth failed for codex in zone 'shravan': connect ECONNREFUSED");
	});
});
