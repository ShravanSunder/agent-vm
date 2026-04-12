import type { BuildConfig, BuildImageResult, ManagedVm, SecretResolver } from 'gondolin-core';
import { describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../controller/system-config.js';
import { startGatewayZone } from './gateway-zone-orchestrator.js';

const systemConfig = {
	cacheDir: '/cache',
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
				type: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				openclawConfig: './config/shravan/openclaw.json',
				stateDir: './state/shravan',
				workspaceDir: './workspaces/shravan',
			},
			secrets: {
				PERPLEXITY_API_KEY: {
					source: '1password',
					ref: 'op://agent-vm/agent-perplexity/credential',
					injection: 'http-mediation',
					hosts: ['api.perplexity.ai'],
				},
				DISCORD_BOT_TOKEN: {
					source: '1password',
					ref: 'op://agent-vm/agent-discord-app/bot-token',
					injection: 'env',
				},
			},
			allowedHosts: ['api.anthropic.com', 'api.openai.com', 'api.perplexity.ai'],
			websocketBypass: ['gateway.discord.gg:443'],
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

const minimalBuildConfig: BuildConfig = {
	arch: 'aarch64',
	distro: 'alpine',
};

describe('startGatewayZone', () => {
	it('builds the image, resolves secrets, creates the vm, and enables ingress', async () => {
		const taskTitles: string[] = [];
		const closeMock = vi.fn(async () => {});
		const enableIngressMock = vi.fn(async () => ({ host: '127.0.0.1', port: 18791 }));
		const enableSshMock = vi.fn(async () => ({ host: '127.0.0.1', port: 2222 }));
		const execMock = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
		const setIngressRoutesMock = vi.fn();
		const managedVm: ManagedVm = {
			id: 'vm-123',
			close: closeMock,
			enableIngress: enableIngressMock,
			enableSsh: enableSshMock,
			exec: execMock,
			getVmInstance: vi.fn(),
			setIngressRoutes: setIngressRoutesMock,
		};
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('resolve is not used by this test');
			},
			resolveAll: async () => ({
				PERPLEXITY_API_KEY: 'resolved-key',
				DISCORD_BOT_TOKEN: 'resolved-key',
			}),
		};
		const buildImage = vi.fn(
			async (_options: unknown): Promise<BuildImageResult> => ({
				built: true,
				fingerprint: 'fingerprint-123',
				imagePath: '/tmp/gateway-image',
			}),
		);
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);
		const buildConfig: BuildConfig = {
			arch: 'aarch64',
			distro: 'alpine',
			rootfs: {
				label: 'gateway-root',
			},
		};
		const loadBuildConfig = vi.fn(async (): Promise<BuildConfig> => buildConfig);

		const result = await startGatewayZone(
			{
				runTask: async (title, fn) => {
					taskTitles.push(title);
					await fn();
				},
				secretResolver,
				systemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage,
				createManagedVm,
				loadBuildConfig,
			},
		);

		expect(loadBuildConfig).toHaveBeenCalledWith('./images/gateway/build-config.json');
		expect(buildImage).toHaveBeenCalled();
		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: ['api.anthropic.com', 'api.openai.com', 'api.perplexity.ai'],
				cpus: 2,
				env: expect.objectContaining({
					HOME: '/home/openclaw',
					NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
					OPENCLAW_HOME: '/home/openclaw',
					OPENCLAW_CONFIG_PATH: '/home/openclaw/.openclaw/config/openclaw.json',
					OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
					DISCORD_BOT_TOKEN: 'resolved-key',
				}),
				imagePath: '/tmp/gateway-image',
				memory: '2G',
				rootfsMode: 'cow',
				secrets: {
					PERPLEXITY_API_KEY: {
						hosts: ['api.perplexity.ai'],
						value: 'resolved-key',
					},
				},
				tcpHosts: expect.objectContaining({
					'controller.vm.host:18800': '127.0.0.1:18800',
					'gateway.discord.gg:443': 'gateway.discord.gg:443',
				}),
			}),
		);
		expect(execMock).toHaveBeenCalledWith(
			'cd /home/openclaw && nohup openclaw gateway --port 18789 > /tmp/openclaw.log 2>&1 &',
		);
		expect(setIngressRoutesMock).toHaveBeenCalledWith([
			{
				port: 18789,
				prefix: '/',
				stripPrefix: true,
			},
		]);
		expect(enableIngressMock).toHaveBeenCalledWith({
			listenPort: 18791,
		});
		expect(taskTitles).toEqual([
			'Resolving zone secrets',
			'Building gateway image',
			'Booting gateway VM',
			'Configuring gateway',
			'Starting OpenClaw',
		]);
		expect(result).toMatchObject({
			image: {
				fingerprint: 'fingerprint-123',
				imagePath: '/tmp/gateway-image',
			},
			ingress: {
				host: '127.0.0.1',
				port: 18791,
			},
		});
	});

	it('throws for an unknown zone id', async () => {
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('not used');
			},
			resolveAll: async () => ({}),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver,
					systemConfig,
					zoneId: 'does-not-exist',
				},
				{
					buildImage: vi.fn(),
					createManagedVm: vi.fn(),
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow("Unknown zone 'does-not-exist'.");
	});

	it('throws a clear error for coding gateways until that runtime is implemented', async () => {
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('not used');
			},
			resolveAll: async () => ({}),
		};
		const codingSystemConfig: SystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'coding',
				},
			})),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver,
					systemConfig: codingSystemConfig,
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(),
					createManagedVm: vi.fn(),
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow(/coding gateway runtime is not implemented/i);
	});

	it('splits env secrets from http-mediation secrets based on injection config', async () => {
		const closeMock = vi.fn(async () => {});
		const enableIngressMock = vi.fn(async () => ({ host: '127.0.0.1', port: 18791 }));
		const execMock = vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' }));
		const setIngressRoutesMock = vi.fn();
		const managedVm: ManagedVm = {
			id: 'vm-456',
			close: closeMock,
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: execMock,
			getVmInstance: vi.fn(),
			setIngressRoutes: setIngressRoutesMock,
		};
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('not used');
			},
			resolveAll: async () => ({
				PERPLEXITY_API_KEY: 'pplx-key',
				DISCORD_BOT_TOKEN: 'discord-token',
			}),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver,
				systemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall as [Record<string, unknown>];

		// PERPLEXITY_API_KEY should be in secrets (http-mediation) with hosts
		expect(vmOptions.secrets).toEqual({
			PERPLEXITY_API_KEY: {
				hosts: ['api.perplexity.ai'],
				value: 'pplx-key',
			},
		});

		// DISCORD_BOT_TOKEN should be in env (env injection)
		expect(vmOptions.env).toMatchObject({
			DISCORD_BOT_TOKEN: 'discord-token',
		});

		// PERPLEXITY_API_KEY should NOT be in env
		expect(vmOptions.env).not.toHaveProperty('PERPLEXITY_API_KEY');
	});

	it('builds tcp hosts with controller and websocket bypass entries', async () => {
		const closeMock = vi.fn(async () => {});
		const execMock = vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' }));
		const managedVm: ManagedVm = {
			id: 'vm-789',
			close: closeMock,
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: execMock,
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: {
					resolve: async (): Promise<string> => {
						throw new Error('not used');
					},
					resolveAll: async () => ({
						PERPLEXITY_API_KEY: 'key',
						DISCORD_BOT_TOKEN: 'token',
					}),
				},
				systemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall as [Record<string, unknown>];
		expect(vmOptions.tcpHosts).toEqual({
			'controller.vm.host:18800': '127.0.0.1:18800',
			'tool-0.vm.host:22': '127.0.0.1:19000',
			'tool-1.vm.host:22': '127.0.0.1:19001',
			'tool-2.vm.host:22': '127.0.0.1:19002',
			'tool-3.vm.host:22': '127.0.0.1:19003',
			'tool-4.vm.host:22': '127.0.0.1:19004',
			'gateway.discord.gg:443': 'gateway.discord.gg:443',
		});
	});

	it('throws when gateway readiness polling exhausts all attempts', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-timeout',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async () => ({ exitCode: 0, stdout: '000', stderr: '' })),
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: {
						resolve: async (): Promise<string> => {
							throw new Error('not used');
						},
						resolveAll: async () => ({}),
					},
					systemConfig,
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow(/gateway.*readiness/iu);
	});

	it('writes the resolved gateway token to a root-only env file', async () => {
		const execMock = vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' }));
		const managedVm: ManagedVm = {
			id: 'vm-token',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: execMock,
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(),
		};

		await startGatewayZone(
			{
				secretResolver: {
					resolve: async (): Promise<string> => {
						throw new Error('not used');
					},
					resolveAll: async () => ({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
				},
				systemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(execMock).toHaveBeenCalledWith(
			expect.stringContaining('cat > /root/.openclaw-env << ENVEOF'),
		);
		expect(execMock).toHaveBeenCalledWith(expect.stringContaining('chmod 600 /root/.openclaw-env'));
		expect(execMock).toHaveBeenCalledWith(expect.stringContaining('source /root/.openclaw-env'));
		expect(execMock).toHaveBeenCalledWith(
			expect.stringContaining("export OPENCLAW_GATEWAY_TOKEN='gateway-token-123'"),
		);
	});
});
