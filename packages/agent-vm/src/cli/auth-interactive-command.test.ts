import type { GatewayAuthConfig } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import type { ControllerClient } from '../controller/http/controller-client.js';
import { defaultCliDependencies } from './agent-vm-cli-support.js';
import { listAuthProviders, runAuthInteractiveCommand } from './auth-interactive-command.js';

function createControllerClientStub(overrides?: {
	readonly enableZoneSsh?: ControllerClient['enableZoneSsh'];
}): ControllerClient {
	return {
		destroyZone: async () => ({}),
		enableZoneSsh: overrides?.enableZoneSsh ?? (async () => ({})),
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

const authConfig: GatewayAuthConfig = {
	buildLoginCommand: (provider: string, options = {}): string =>
		`login --provider ${provider}${options.deviceCode ? ' --device-code' : ''}${options.setDefault ? ' --set-default' : ''}`,
	listProvidersCommand: 'list-cmd',
};

const systemConfig = {
	schemaVersion: 1,
	cacheDir: './cache',
	runtimeDir: './runtime',
	host: { controllerPort: 18800, projectNamespace: 'claw-tests-a1b2c3d4' },
	imageProfiles: {
		gateways: {
			openclaw: {
				type: 'openclaw',
				buildConfig: './vm-images/gateways/openclaw/build-config.json',
			},
		},
		toolVms: {},
	},
	tcpPool: { basePort: 19000, size: 5 },
	toolVmProfiles: {},
	zones: [
		{
			egressHosts: ['api.openai.com'].map((host) => ({ host, audience: 'gateway' as const })),
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
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
} satisfies SystemConfig;

describe('listAuthProviders', () => {
	it('queries over SSH and parses provider names from stdout', async () => {
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: 'codex\nopenai-codex\nanthropic\n',
			stderr: '',
		}));

		const providers = await listAuthProviders({
			listProvidersCommand: 'list-cmd',
			runCommand,
			sshAccess: {
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 2222,
				user: 'root',
			},
		});

		expect(providers).toEqual(['codex', 'openai-codex', 'anthropic']);
		expect(runCommand).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([
				'root@127.0.0.1',
				expect.stringContaining('source /etc/profile.d/openclaw-env.sh && list-cmd'),
			]),
		);
	});

	it('returns empty array when command produces no output', async () => {
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stdout: '',
			stderr: '',
		}));

		const providers = await listAuthProviders({
			listProvidersCommand: 'list-cmd',
			runCommand,
			sshAccess: {
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 2222,
				user: 'root',
			},
		});

		expect(providers).toEqual([]);
	});

	it('throws when the SSH command fails', async () => {
		const runCommand = vi.fn(async () => ({
			exitCode: 255,
			stdout: '',
			stderr: 'connection refused',
		}));

		await expect(
			listAuthProviders({
				listProvidersCommand: 'list-cmd',
				runCommand,
				sshAccess: {
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 2222,
					user: 'root',
				},
			}),
		).rejects.toThrow('Failed to list auth providers: connection refused');
	});
});

describe('runAuthInteractiveCommand', () => {
	it('throws when the lifecycle has no authConfig', async () => {
		await expect(
			runAuthInteractiveCommand({
				authConfig: undefined,
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: vi.fn(),
					runInteractiveProcess: vi.fn(),
				},
				io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
				provider: 'codex',
				systemConfig: {
					host: { controllerPort: 18800, projectNamespace: 'claw-tests-a1b2c3d4' },
				} as never,
				zoneId: 'test',
			}),
		).rejects.toThrow(/does not support interactive auth/i);
	});

	it('runs interactive SSH with the login command when provider is given', async () => {
		const runInteractiveProcess = vi.fn(async () => {});
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 2222,
			user: 'root',
		}));

		await runAuthInteractiveCommand({
			authConfig,
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: vi.fn(() =>
					createControllerClientStub({
						enableZoneSsh,
					}),
				),
				runInteractiveProcess,
			},
			io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
			provider: 'codex',
			systemConfig,
			zoneId: 'shravan',
		});

		expect(enableZoneSsh).toHaveBeenCalledWith('shravan', { secretEnv: 'default' });
		expect(runInteractiveProcess).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([
				'-t',
				'root@127.0.0.1',
				expect.stringContaining('source /etc/profile.d/openclaw-env.sh'),
			]),
		);
	});

	it('resolves zone admin access before starting interactive auth SSH', async () => {
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			port: 2222,
			user: 'root',
		}));
		const createSecretResolver = vi.fn(async () => ({
			resolve: vi.fn(async () => 'resolved-admin-token'),
			resolveAll: vi.fn(async () => ({})),
		}));
		const runInteractiveProcess = vi.fn(async () => {});
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}

		await runAuthInteractiveCommand({
			authConfig,
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: vi.fn(() => createControllerClientStub({ enableZoneSsh })),
				createSecretResolver,
				resolveServiceAccountToken: vi.fn(async () => 'op-service-account-token'),
				runInteractiveProcess,
			},
			io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
			provider: 'codex',
			systemConfig: {
				...systemConfig,
				host: {
					...systemConfig.host,
					secretsProvider: {
						type: '1password',
						tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
					},
				},
				zones: [
					{
						...zone,
						adminAccess: {
							mode: 'secret',
							secret: {
								source: '1password',
								ref: 'op://agent-vm/shravan-ssh-access/token',
							},
						},
					},
				],
			},
			zoneId: 'shravan',
		});

		expect(enableZoneSsh).toHaveBeenCalledWith('shravan', {
			adminToken: 'resolved-admin-token',
			secretEnv: 'default',
		});
		expect(runInteractiveProcess).toHaveBeenCalledWith('ssh', expect.any(Array));
	});

	it('passes device-code and set-default options into the login command', async () => {
		const runInteractiveProcess = vi.fn(async () => {});

		await runAuthInteractiveCommand({
			authConfig,
			deviceCode: true,
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: vi.fn(() =>
					createControllerClientStub({
						enableZoneSsh: async () => ({
							host: '127.0.0.1',
							port: 2222,
							user: 'root',
						}),
					}),
				),
				runInteractiveProcess,
			},
			io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
			provider: 'openai-codex',
			setDefault: true,
			systemConfig,
			zoneId: 'shravan',
		});

		expect(runInteractiveProcess).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([
				expect.stringContaining('login --provider openai-codex --device-code --set-default'),
			]),
		);
	});

	it('wraps interactive SSH failures with provider and zone context', async () => {
		const runInteractiveProcess = vi.fn(async () => {
			throw new Error('connect ECONNREFUSED');
		});
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			port: 2222,
			user: 'root',
		}));

		await expect(
			runAuthInteractiveCommand({
				authConfig,
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: vi.fn(() =>
						createControllerClientStub({
							enableZoneSsh,
						}),
					),
					runInteractiveProcess,
				},
				io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
				provider: 'codex',
				systemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow("Auth failed for codex in zone 'shravan': connect ECONNREFUSED");
	});
});
