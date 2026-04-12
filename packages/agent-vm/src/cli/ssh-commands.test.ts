import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import type { ControllerClient } from '../controller/http/controller-client.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { runSshCommand } from './ssh-commands.js';

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
		gateway: { buildConfig: './images/gateway/build-config.json' },
		tool: { buildConfig: './images/tool/build-config.json' },
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
				gatewayConfig: './config/shravan/openclaw.json',
				port: 18791,
				stateDir: './state/shravan',
				workspaceDir: './workspaces/shravan',
			},
			id: 'shravan',
			secrets: {},
			websocketBypass: [],
			toolProfile: 'standard',
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
		listLeases: async () => [],
		refreshZoneCredentials: async () => ({}),
		releaseLease: async () => {},
		stopController: async () => ({}),
		upgradeZone: async () => ({}),
	};
}

describe('runSshCommand', () => {
	it('spawns an interactive ssh session', async () => {
		const runInteractiveProcess = vi.fn(async () => {});

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

	it('prints the command when --print is passed', async () => {
		const outputs: string[] = [];

		await runSshCommand({
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: () =>
					createControllerClientStub(async () => ({
						command: 'ssh -i /tmp/key -p 2222 root@127.0.0.1',
					})),
			},
			io: {
				stderr: { write: () => true },
				stdout: {
					write: (chunk: string | Uint8Array) => {
						outputs.push(String(chunk));
						return true;
					},
				},
			},
			restArguments: ['--zone', 'shravan', '--print'],
			systemConfig,
		});

		expect(outputs.join('')).toContain('ssh -i /tmp/key -p 2222 root@127.0.0.1');
	});

	it('passes through remote command arguments', async () => {
		const runInteractiveProcess = vi.fn(async () => {});

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
			restArguments: ['--zone', 'shravan', '--', 'openclaw', 'auth', 'login'],
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
			expect.stringContaining('source /etc/profile.d/openclaw-env.sh'),
		]);
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
