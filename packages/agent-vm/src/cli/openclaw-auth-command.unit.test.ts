import type { GatewayAuthConfig } from '@agent-vm/gateway-interface';
import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import type { ControllerClient } from '../controller/http/controller-client.js';
import { type CliDependencies, defaultCliDependencies } from './agent-vm-cli-support.js';
import { runOpenClawAuthCommand } from './openclaw-auth-command.js';

function createControllerClientStub(overrides?: {
	readonly enableZoneSsh?: ControllerClient['enableZoneSsh'];
}): ControllerClient {
	return {
		destroyZone: async () => ({}),
		enableZoneSsh: overrides?.enableZoneSsh ?? (async () => ({})),
		getControllerStatus: async () => ({}),
		getZoneLogs: async () => ({}),
		peekLease: async () => ({
			agentId: 'main',
			createdAt: 1,
			idleTtlMs: 6_000_000,
			lastUsedAt: 1,
			leaseId: 'lease-123',
			profileId: 'standard',
			ssh: { host: '127.0.0.1', port: 19000, user: 'sandbox' },
			tcpSlot: 0,
			transport: 'ssh-sandbox' as const,
			workdir: '/workspace',

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
		`login --provider ${provider}${options.agentId ? ` --agent ${options.agentId}` : ''}${options.profileId ? ` --profile-id ${options.profileId}` : ''}${options.deviceCode ? ' --device-code' : ''}`,
	buildProfileListCommand: (provider: string, options: { readonly agentId: string }): string =>
		`list --provider ${provider} --agent ${options.agentId}`,
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

function createSuccessfulProfileListCommand(
	stdout = 'openai-codex:test@example.com\n',
): NonNullable<CliDependencies['runCommand']> {
	return vi.fn(async () => ({
		exitCode: 0,
		stderr: '',
		stdout,
	}));
}

describe('runOpenClawAuthCommand', () => {
	it('logs in configured profile ids for the configured default auth agent and verifies them', async () => {
		const runInteractiveProcess = vi.fn(async () => {});
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: 'openai-codex:first@example.com\nopenai-codex:second@example.com\n',
		}));
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw fixture zone.');
		}

		await runOpenClawAuthCommand({
			allConfiguredProfiles: true,
			authConfig,
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
				runCommand,
				runInteractiveProcess,
			},
			deviceCode: true,
			io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
			provider: 'openai',
			systemConfig: {
				...systemConfig,
				zones: [
					{
						...zone,
						gateway: {
							...zone.gateway,
							authLogin: {
								defaultAgent: 'main',
								providers: {
									openai: {
										profileIds: [
											'openai-codex:first@example.com',
											'openai-codex:second@example.com',
										],
									},
								},
							},
						},
					},
				],
			},
			zoneId: 'shravan',
		});

		expect(runInteractiveProcess).toHaveBeenCalledTimes(2);
		expect(runInteractiveProcess).toHaveBeenNthCalledWith(
			1,
			'ssh',
			expect.arrayContaining([
				expect.stringContaining(
					'login --provider openai --agent main --profile-id openai-codex:first@example.com --device-code',
				),
			]),
		);
		expect(runInteractiveProcess).toHaveBeenNthCalledWith(
			2,
			'ssh',
			expect.arrayContaining([
				expect.stringContaining(
					'login --provider openai --agent main --profile-id openai-codex:second@example.com --device-code',
				),
			]),
		);
		expect(runCommand).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([expect.stringContaining('list --provider openai --agent main')]),
		);
	});

	it('logs in explicit profile ids for an explicit auth agent and verifies them', async () => {
		const runInteractiveProcess = vi.fn(async () => {});
		const runCommand = vi.fn(async () => ({
			exitCode: 0,
			stderr: '',
			stdout: 'openai-codex:new@example.com\n',
		}));

		await runOpenClawAuthCommand({
			agentId: 'main',
			authConfig,
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
				runCommand,
				runInteractiveProcess,
			},
			io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
			profileIds: ['openai-codex:new@example.com'],
			provider: 'openai',
			systemConfig,
			zoneId: 'shravan',
		});

		expect(runInteractiveProcess).toHaveBeenCalledTimes(1);
		expect(runInteractiveProcess).toHaveBeenNthCalledWith(
			1,
			'ssh',
			expect.arrayContaining([
				expect.stringContaining(
					'login --provider openai --agent main --profile-id openai-codex:new@example.com',
				),
			]),
		);
		expect(runCommand).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([expect.stringContaining('list --provider openai --agent main')]),
		);
	});

	it('dry-runs configured profile login without opening SSH', async () => {
		const stdoutWrite = vi.fn(() => true);
		const createControllerClient = vi.fn();
		const runCommand = vi.fn();
		const runInteractiveProcess = vi.fn();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw fixture zone.');
		}

		await runOpenClawAuthCommand({
			allConfiguredProfiles: true,
			authConfig,
			dependencies: {
				...defaultCliDependencies,
				createControllerClient,
				runCommand,
				runInteractiveProcess,
			},
			dryRun: true,
			io: { stdout: { write: stdoutWrite }, stderr: { write: vi.fn(() => true) } },
			provider: 'openai',
			systemConfig: {
				...systemConfig,
				zones: [
					{
						...zone,
						gateway: {
							...zone.gateway,
							authLogin: {
								defaultAgent: 'main',
								providers: {
									openai: {
										profileIds: [
											'openai-codex:first@example.com',
											'openai-codex:second@example.com',
										],
									},
								},
							},
						},
					},
				],
			},
			zoneId: 'shravan',
		});

		expect(createControllerClient).not.toHaveBeenCalled();
		expect(runInteractiveProcess).not.toHaveBeenCalled();
		expect(runCommand).not.toHaveBeenCalled();
		expect(stdoutWrite).toHaveBeenCalledWith(
			expect.stringContaining("OpenClaw auth login plan for zone 'shravan'"),
		);
		expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining("agent 'main'"));
		expect(stdoutWrite).toHaveBeenCalledWith(
			expect.stringContaining('openai-codex:first@example.com'),
		);
		expect(stdoutWrite).toHaveBeenCalledWith(
			expect.stringContaining('openai-codex:second@example.com'),
		);
		expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Verification: enabled'));
	});

	it('rejects configured-profile login when no default auth agent can be resolved', async () => {
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw fixture zone.');
		}

		await expect(
			runOpenClawAuthCommand({
				allConfiguredProfiles: true,
				authConfig,
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: vi.fn(),
					runInteractiveProcess: vi.fn(),
				},
				io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
				provider: 'openai',
				systemConfig: {
					...systemConfig,
					zones: [
						{
							...zone,
							gateway: {
								...zone.gateway,
								authLogin: {
									providers: {
										openai: {
											profileIds: ['openai-codex:first@example.com'],
										},
									},
								},
							},
						},
					],
				},
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/No gateway\.authLogin\.defaultAgent configured/u);
	});

	it('rejects login when no profile ids are provided', async () => {
		await expect(
			runOpenClawAuthCommand({
				authConfig,
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: vi.fn(),
					runInteractiveProcess: vi.fn(),
				},
				io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
				provider: 'openai',
				systemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/No profile ids provided/u);
	});

	it('runs OpenClaw provider login for openai-codex when requested', async () => {
		const runInteractiveProcess = vi.fn(async () => {});
		const runCommand = createSuccessfulProfileListCommand();

		await runOpenClawAuthCommand({
			authConfig,
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
				runCommand,
				runInteractiveProcess,
			},
			io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
			agentId: 'main',
			profileIds: ['openai-codex:test@example.com'],
			provider: 'openai-codex',
			systemConfig,
			zoneId: 'shravan',
		});

		expect(runInteractiveProcess).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([expect.stringContaining('login --provider openai-codex')]),
		);
	});

	it('throws when the lifecycle has no authConfig', async () => {
		await expect(
			runOpenClawAuthCommand({
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
		const runCommand = createSuccessfulProfileListCommand();
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 2222,
			user: 'root',
		}));

		await runOpenClawAuthCommand({
			authConfig,
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: vi.fn(() =>
					createControllerClientStub({
						enableZoneSsh,
					}),
				),
				runCommand,
				runInteractiveProcess,
			},
			io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
			agentId: 'main',
			profileIds: ['openai-codex:test@example.com'],
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
		const runCommand = createSuccessfulProfileListCommand();
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected test zone.');
		}

		await runOpenClawAuthCommand({
			authConfig,
			dependencies: {
				...defaultCliDependencies,
				createControllerClient: vi.fn(() => createControllerClientStub({ enableZoneSsh })),
				createSecretResolver,
				resolveServiceAccountToken: vi.fn(async () => 'op-service-account-token'),
				runCommand,
				runInteractiveProcess,
			},
			io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
			agentId: 'main',
			profileIds: ['openai-codex:test@example.com'],
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

	it('passes device-code into the login command', async () => {
		const runInteractiveProcess = vi.fn(async () => {});
		const runCommand = createSuccessfulProfileListCommand();

		await runOpenClawAuthCommand({
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
				runCommand,
				runInteractiveProcess,
			},
			io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
			agentId: 'main',
			profileIds: ['openai-codex:test@example.com'],
			provider: 'openai',
			systemConfig,
			zoneId: 'shravan',
		});

		expect(runInteractiveProcess).toHaveBeenCalledWith(
			'ssh',
			expect.arrayContaining([
				expect.stringContaining(
					'login --provider openai --agent main --profile-id openai-codex:test@example.com --device-code',
				),
			]),
		);
	});

	it('wraps interactive SSH failures with provider and zone context', async () => {
		const runInteractiveProcess = vi.fn(async () => {
			throw new Error('connect ECONNREFUSED');
		});
		const runCommand = createSuccessfulProfileListCommand();
		const enableZoneSsh = vi.fn(async () => ({
			host: '127.0.0.1',
			port: 2222,
			user: 'root',
		}));

		await expect(
			runOpenClawAuthCommand({
				authConfig,
				dependencies: {
					...defaultCliDependencies,
					createControllerClient: vi.fn(() =>
						createControllerClientStub({
							enableZoneSsh,
						}),
					),
					runCommand,
					runInteractiveProcess,
				},
				io: { stdout: { write: vi.fn(() => true) }, stderr: { write: vi.fn(() => true) } },
				agentId: 'main',
				profileIds: ['openai-codex:test@example.com'],
				provider: 'codex',
				systemConfig,
				zoneId: 'shravan',
			}),
		).rejects.toThrow("Auth failed for codex in zone 'shravan' agent 'main': connect ECONNREFUSED");
	});
});
