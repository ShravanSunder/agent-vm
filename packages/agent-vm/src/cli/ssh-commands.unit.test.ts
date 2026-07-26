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
		projectNamespace: 'claw-tests-a1b2c3d4',
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
			egressHosts: ['api.anthropic.com'].map((host) => ({ host, audience: 'gateway' as const })),
			gateway: {
				type: 'openclaw',
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				imageProfile: 'openclaw',
				cpus: 2,
				memory: '2G',
				config: './config/shravan/openclaw.json',
				port: 18791,
				stateDir: './state/shravan',
				zoneFilesDir: './zone-files/shravan',
				zoneRuntimeDir: './runtime/shravan',
			},
			id: 'shravan',
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
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
					beta: { DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN' },
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
			secrets: {},
		},
	],
} satisfies SystemConfig;

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
		refreshZoneCredentials: async () => ({}),
		stopController: async () => ({}),
		upgradeZone: async () => ({}),
	};
}

describe('runSshCommand', () => {
	it('spawns a gateway-token-loaded interactive ssh session by default', async () => {
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

		await runSshCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => createControllerClientStub(enableZoneSsh),
				runInteractiveProcess,
			},
			io: {
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			restArguments: ['--zone', 'shravan'],
			systemConfig,
		});

		expect(enableZoneSsh).toHaveBeenCalledWith('shravan', {
			secretEnv: 'gateway-token',
		});
		expect(runInteractiveProcess).toHaveBeenCalledWith('ssh', [
			'-t',
			'-o',
			'StrictHostKeyChecking=no',
			'-o',
			'UserKnownHostsFile=/dev/null',
			'-i',
			'/tmp/key',
			'-p',
			'2222',
			'root@127.0.0.1',
			expect.stringContaining(
				'/run/agent-vm/managed-gateway-environment/openclaw-gateway-token.environment.sh',
			),
		]);
		const sshArguments = vi.mocked(runInteractiveProcess).mock.calls[0]?.[1];
		const shellCommand = sshArguments?.at(-1);
		expect(shellCommand).not.toEqual(
			expect.stringContaining('openclaw-all-secrets.environment.sh'),
		);
	});

	it('spawns an all-secrets interactive ssh session when explicitly requested', async () => {
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

		await runSshCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () => createControllerClientStub(enableZoneSsh),
				runInteractiveProcess,
			},
			io: {
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			restArguments: ['--zone', 'shravan', '--all-secrets'],
			systemConfig,
		});

		expect(enableZoneSsh).toHaveBeenCalledWith('shravan', {
			secretEnv: 'all-secrets',
		});
		const sshArguments = vi.mocked(runInteractiveProcess).mock.calls[0]?.[1];
		const shellCommand = sshArguments?.at(-1);
		expect(shellCommand).toEqual(
			expect.stringContaining(
				'/run/agent-vm/managed-gateway-environment/openclaw-all-secrets.environment.sh',
			),
		);
		expect(shellCommand).not.toEqual(
			expect.stringContaining('openclaw-gateway-token.environment.sh'),
		);
		if (typeof shellCommand !== 'string') {
			throw new Error('Expected OpenClaw all-secrets shell command.');
		}
		expect(shellCommand.indexOf('openclaw-all-secrets.environment.sh')).toBeLessThan(
			shellCommand.indexOf('/etc/profile.d/openclaw-env.sh'),
		);
	});

	it('fails closed when the controller cannot enable the ssh gateway token', async () => {
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 2222,
			secretEnvEnabled: false,
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
				io: {
					stderr: { write: () => true },
					stdout: { write: () => true },
				},
				restArguments: ['--zone', 'shravan'],
				systemConfig,
			}),
		).rejects.toThrow(
			'Controller did not enable OPENCLAW_GATEWAY_TOKEN for this SSH session. Check the zone gateway.ssh.secretEnv policy and configured OPENCLAW_GATEWAY_TOKEN secret.',
		);
		expect(enableZoneSsh).toHaveBeenCalledWith('shravan', {
			secretEnv: 'gateway-token',
		});
		expect(runInteractiveProcess).not.toHaveBeenCalled();
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

	it('resolves zone admin access and requests a gateway-token-backed ssh session', async () => {
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
			restArguments: ['--zone', 'shravan'],
			systemConfig: systemConfigWithAdminAccess,
		});

		expect(enableZoneSsh).toHaveBeenCalledWith('shravan', {
			adminToken: 'resolved-admin-token',
			secretEnv: 'gateway-token',
		});
		const sshInvocation = vi.mocked(runInteractiveProcess).mock.calls.at(0);
		if (!sshInvocation) {
			throw new Error('Expected SSH invocation.');
		}
		expect(sshInvocation[1]).toContain('-t');
		const shellCommand = sshInvocation[1].at(-1);
		if (typeof shellCommand !== 'string') {
			throw new Error('Expected SSH shell command to be present.');
		}
		expect(shellCommand).toContain(
			'/run/agent-vm/managed-gateway-environment/openclaw-gateway-token.environment.sh',
		);
		expect(shellCommand).not.toContain('openclaw-all-secrets.environment.sh');
		expect(shellCommand).not.toContain('resolved-admin-token');
	});

	it('opens a plain Hermes login shell without OpenClaw secret setup', async () => {
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			identityFile: '/tmp/hermes-key',
			port: 2223,
			secretEnvEnabled: false,
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
			restArguments: ['--zone', 'hermes-zone'],
			systemConfig: hermesSystemConfig,
		});

		expect(enableZoneSsh).toHaveBeenCalledWith('hermes-zone', { secretEnv: 'default' });
		const remoteCommand = vi.mocked(runInteractiveProcess).mock.calls[0]?.[1].at(-1);
		expect(remoteCommand).toBe("bash -lc 'exec bash -l'");
		expect(remoteCommand).not.toEqual(expect.stringContaining('openclaw'));
		expect(remoteCommand).not.toEqual(expect.stringContaining('OPENCLAW_GATEWAY_TOKEN'));
	});

	it('rejects all-secrets SSH for Hermes before enabling SSH', async () => {
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			port: 2223,
			user: 'root',
		}));

		await expect(
			runSshCommand({
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: () => createControllerClientStub(enableZoneSsh),
				},
				io: { stderr: { write: () => true }, stdout: { write: () => true } },
				restArguments: ['--zone', 'hermes-zone', '--all-secrets'],
				systemConfig: hermesSystemConfig,
			}),
		).rejects.toThrow('--all-secrets is supported only for OpenClaw zones');
		expect(enableZoneSsh).not.toHaveBeenCalled();
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
							secretEnvEnabled: true,
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
