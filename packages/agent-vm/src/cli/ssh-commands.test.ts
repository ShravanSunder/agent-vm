import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import type { ControllerClient } from '../controller/http/controller-client.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { runSshCommand } from './ssh-commands.js';

const systemConfig = {
	schemaVersion: 1,
	cacheDir: './cache',
	runtimeDir: './runtime',
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
			allowedHosts: ['api.anthropic.com'],
			gateway: {
				type: 'openclaw',
				imageProfile: 'openclaw',
				cpus: 2,
				memory: '2G',
				config: './config/shravan/openclaw.json',
				port: 18791,
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
			},
			id: 'shravan',
			secrets: {},
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
} satisfies SystemConfig;

const baseZone = systemConfig.zones[0];
if (!baseZone) {
	throw new Error('Expected test system config to include a zone.');
}

const systemConfigWithAdminAccess = {
	...systemConfig,
	zones: [
		{
			...baseZone,
			adminAccess: {
				mode: 'secret',
				secret: {
					source: '1password',
					ref: 'op://agent-vm/shravan-ssh-access/token',
				},
			},
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
		peekLease: async () => ({
			createdAt: 1,
			lastUsedAt: 1,
			leaseId: 'lease-123',
			profileId: 'standard',
			scopeKey: 'scope',
			ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
			tcpSlot: 0,
			zoneId: 'shravan',
		}),
		listLeases: async () => [],
		refreshZoneCredentials: async () => ({}),
		releaseLease: async () => {},
		stopController: async () => ({}),
		upgradeZone: async () => ({}),
	};
}

describe('runSshCommand', () => {
	it('spawns an interactive ssh session', async () => {
		const runInteractiveProcess = vi.fn(
			async (_command: string, _arguments: readonly string[]): Promise<void> => {},
		);

		await runSshCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () =>
					createControllerClientStub(async () => ({
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 2222,
						user: 'root',
					})),
				runInteractiveProcess,
			},
			io: {
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			restArguments: ['--zone', 'shravan'],
			systemConfig,
		});

		expect(runInteractiveProcess).toHaveBeenCalledWith('ssh', [
			'-o',
			'StrictHostKeyChecking=no',
			'-o',
			'UserKnownHostsFile=/dev/null',
			'-i',
			'/tmp/key',
			'-p',
			'2222',
			'root@127.0.0.1',
		]);
	});

	it('rejects --print for ssh sessions', async () => {
		await expect(
			runSshCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: () =>
						createControllerClientStub(async () => ({
							command: 'ssh -i /tmp/key -p 2222 root@127.0.0.1',
						})),
				},
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				restArguments: ['--zone', 'shravan', '--print'],
				systemConfig,
			}),
		).rejects.toThrow('--print is not supported');
	});

	it('keeps controller ssh interactive-only instead of exposing remote command execution', async () => {
		const runInteractiveProcess = vi.fn(
			async (_command: string, _arguments: readonly string[]): Promise<void> => {},
		);
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 2222,
			user: 'root',
		}));

		await expect(
			runSshCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: () => createControllerClientStub(enableZoneSsh),
					runInteractiveProcess,
				},
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				restArguments: ['--zone', 'shravan', '--', 'openclaw', 'auth', 'login'],
				systemConfig,
			}),
		).rejects.toThrow(
			'controller ssh opens an interactive shell only; remote commands are not supported.',
		);
		expect(enableZoneSsh).not.toHaveBeenCalled();
		expect(runInteractiveProcess).not.toHaveBeenCalled();
	});

	it('resolves zone admin access and requests a secret-backed ssh session', async () => {
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 2222,
			secretEnvEnabled: true,
			user: 'root',
		}));
		const runInteractiveProcess = vi.fn(
			async (_command: string, _arguments: readonly string[]): Promise<void> => {},
		);
		const createSecretResolver = vi.fn(async () => ({
			resolve: vi.fn(async () => 'resolved-admin-token'),
			resolveAll: vi.fn(async () => ({})),
		}));

		await runSshCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => createControllerClientStub(enableZoneSsh),
				createSecretResolver,
				resolveServiceAccountToken: vi.fn(async () => 'op-service-account-token'),
				runInteractiveProcess,
			},
			io: {
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			restArguments: ['--zone', 'shravan', '--with-secrets'],
			systemConfig: systemConfigWithAdminAccess,
		});

		expect(enableZoneSsh).toHaveBeenCalledWith('shravan', {
			adminToken: 'resolved-admin-token',
			secretEnv: 'with-secrets',
		});
		const sshInvocation = vi.mocked(runInteractiveProcess).mock.calls.at(0);
		if (!sshInvocation) {
			throw new Error('Expected SSH invocation.');
		}
		const shellCommand = sshInvocation[1].at(-1);
		if (typeof shellCommand !== 'string') {
			throw new Error('Expected SSH shell command to be present.');
		}
		expect(shellCommand).toContain('/run/openclaw/secrets.env');
		expect(shellCommand).not.toContain('resolved-admin-token');
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
				restArguments: ['--zone', 'shravan'],
				systemConfig,
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
				restArguments: ['--zone', 'shravan'],
				systemConfig,
			}),
		).rejects.toThrow('Failed to open SSH session to root@127.0.0.1:2222');
	});

	it('requires --zone explicitly', async () => {
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
				},
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				restArguments: [],
				systemConfig,
			}),
		).rejects.toThrow('--zone is required');
	});
});
