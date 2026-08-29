import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import type { ControllerClient } from '../controller/http/controller-client.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { runSshCommand } from './ssh-commands.js';

const systemConfig = {
	schemaVersion: 2,
	storageRootDir: './storage',
	cacheDir: './cache',
	controllerStateDir: '/controller-state-test',
	controllerRuntimeDir: './controller-runtime',
	host: {
		controllerPort: 18800,
		projectNamespace: 'agent-vm-tests-a1b2c3d4',
		secretsProvider: {
			type: '1password',
			tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
		},
	},
	imageProfiles: {
		gateways: {
			hermes: {
				type: 'hermes',
				buildConfig: './vm-images/gateways/hermes/build-config.json',
			},
			worker: { type: 'worker', buildConfig: './vm-images/gateways/worker/build-config.json' },
		},
		toolVms: {
			default: { type: 'toolVm', buildConfig: './vm-images/tool-vms/default/build-config.json' },
		},
	},
	tcpPool: {
		basePort: 19000,
		size: 5,
	},
	toolVmProfiles: {
		standard: {
			cpus: 1,
			memory: '1G',
			imageProfile: 'default',
		},
	},
	zones: [
		{
			egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
			gateway: {
				type: 'hermes',
				imageProfile: 'hermes',
				cpus: 2,
				memory: '2G',
				config: './config/shravan/hermes.yaml',
				port: 18791,
				profileSecretProjectionsByAgent: { beta: {} },
				profilesByAgent: { beta: 'beta' },
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
				zoneRuntimeDir: './runtime/shravan',
			},
			id: 'shravan',
			secrets: {},
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
} satisfies SystemConfig;

const baseZone = systemConfig.zones[0];
if (!baseZone) {
	throw new Error('Expected test system config to include a zone.');
}

const hermesSystemConfig = {
	...systemConfig,
	zones: [
		{
			...baseZone,
			gateway: {
				type: 'hermes',
				imageProfile: 'hermes',
				profilesByAgent: { beta: 'beta' },
				profileSecretProjectionsByAgent: {
					beta: {
						API_SERVER_KEY: 'API_SERVER_KEY_BETA',
						DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN',
					},
				},
				cpus: 2,
				memory: '2G',
				config: './config/hermes/hermes.yaml',
				port: 18792,
				stateDir: './state/hermes',
				zoneFilesDir: './zone-files/hermes',
				zoneRuntimeDir: './runtime/hermes',
			},
			id: 'hermes-zone',
			secrets: {
				API_SERVER_KEY_BETA: {
					audience: 'gateway',
					envVar: 'API_SERVER_KEY_BETA',
					injection: 'env',
					source: 'environment',
				},
			},
		},
	],
} satisfies SystemConfig;

const workerSystemConfig = {
	...systemConfig,
	zones: [
		{
			...baseZone,
			gateway: {
				type: 'worker',
				imageProfile: 'worker',
				cpus: 2,
				memory: '2G',
				config: './config/worker/worker.json',
				port: 18793,
				stateDir: './state/worker',
				zoneRuntimeDir: './runtime/worker',
			},
			id: 'worker-zone',
			secrets: {},
		},
	],
} satisfies SystemConfig;

function createControllerClientStub(
	enableZoneSsh: ControllerClient['enableZoneSsh'],
): ControllerClient {
	return {
		destroyZone: async () => ({}),
		enableZoneSsh,
		getControllerStatus: async () => ({}),
		getZoneLogs: async () => ({}),
		refreshZoneCredentials: async () => ({}),
		stopController: async () => ({}),
		upgradeZone: async () => ({}),
	};
}

describe('runSshCommand', () => {
	it('opens a Hermes-ready login shell without OpenClaw secret setup', async () => {
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			identityFile: '/tmp/hermes-key',
			port: 2223,
			user: 'root',
		}));
		const runInteractiveProcess = vi.fn(
			async (_command: string, _arguments: readonly string[]): Promise<void> => {},
		);

		await runSshCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => createControllerClientStub(enableZoneSsh),
				runInteractiveProcess,
			},
			io: { stderr: { write: () => true }, stdout: { write: () => true } },
			systemConfig: hermesSystemConfig,
			zoneId: 'hermes-zone',
		});

		expect(enableZoneSsh).toHaveBeenCalledWith('hermes-zone', {});
		const remoteCommand = vi.mocked(runInteractiveProcess).mock.calls[0]?.[1].at(-1);
		expect(remoteCommand).toEqual(expect.stringContaining('source /etc/profile.d/hermes-env.sh'));
		expect(remoteCommand).not.toEqual(expect.stringContaining('openclaw'));
		expect(remoteCommand).not.toEqual(expect.stringContaining('OPENCLAW_GATEWAY_TOKEN'));
		expect(remoteCommand).not.toEqual(expect.stringContaining('framework.environment.sh'));
	});

	it('rejects controller SSH for Worker before contacting the controller', async () => {
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			port: 2224,
			user: 'root',
		}));
		const runInteractiveProcess = vi.fn(
			async (_command: string, _arguments: readonly string[]): Promise<void> => {},
		);

		await expect(
			runSshCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: () => createControllerClientStub(enableZoneSsh),
					runInteractiveProcess,
				},
				io: { stderr: { write: () => true }, stdout: { write: () => true } },
				systemConfig: workerSystemConfig,
				zoneId: 'worker-zone',
			}),
		).rejects.toThrow(
			"controller ssh is not implemented for gateway type 'worker'; use the Worker task APIs.",
		);
		expect(enableZoneSsh).not.toHaveBeenCalled();
		expect(runInteractiveProcess).not.toHaveBeenCalled();
	});

	it('throws when the controller returns incomplete ssh data without a printable command', async () => {
		await expect(
			runSshCommand({
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
				systemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow('Controller returned incomplete SSH access details.');
	});

	it('wraps interactive ssh failures with context', async () => {
		const runInteractiveProcess = vi.fn(async () => {
			throw new Error('connect ECONNREFUSED');
		});

		await expect(
			runSshCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: () =>
						createControllerClientStub(async () => ({
							host: '127.0.0.1',
							port: 2222,
							user: 'root',
						})),
					runInteractiveProcess,
				},
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				systemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow('Failed to open SSH session to root@127.0.0.1:2222');
	});
});
