import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../controller/system-config.js';
import { runSshCommand } from './ssh-commands.js';

const systemConfig = {
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
				cpus: 2,
				memory: '2G',
				openclawConfig: './config/shravan/openclaw.json',
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

describe('runSshCommand', () => {
	it('spawns an interactive ssh session', async () => {
		const runInteractiveProcess = vi.fn(async () => {});

		await runSshCommand({
			dependencies: {
				createControllerClient: () => ({
					enableZoneSsh: async () => ({
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 2222,
						user: 'root',
					}),
				}) as never,
				runInteractiveProcess,
			} as never,
			io: {
				stderr: { write: () => true },
				stdout: { write: () => true },
			},
			restArguments: ['--zone', 'shravan'],
			systemConfig,
		});

		expect(runInteractiveProcess).toHaveBeenCalledWith('ssh', [
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
				createControllerClient: () => ({
					enableZoneSsh: async () => ({
						command: 'ssh -i /tmp/key -p 2222 root@127.0.0.1',
					}),
				}) as never,
			} as never,
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
});
