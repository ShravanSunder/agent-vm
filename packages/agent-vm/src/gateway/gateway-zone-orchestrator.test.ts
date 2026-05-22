import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { GatewayZoneConfig } from '@agent-vm/gateway-interface';
import type {
	BuildConfig,
	BuildImageResult,
	ManagedVm,
	ManagedVmInstance,
} from '@agent-vm/gondolin-adapter';
import type { SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { startGatewayZone } from './gateway-zone-orchestrator.js';

const { cleanupOrphanedGatewayIfPresentMock } = vi.hoisted(() => ({
	cleanupOrphanedGatewayIfPresentMock: vi.fn(async () => ({
		cleanedUp: false,
		killedPid: null,
	})),
}));

vi.mock('./gateway-recovery.js', () => ({
	cleanupOrphanedGatewayIfPresent: cleanupOrphanedGatewayIfPresentMock,
}));

const createdDirectories: string[] = [];

const openClawToolVmSandbox = {
	backend: 'gondolin',
	mode: 'all',
	scope: 'agent',
	workspaceAccess: 'rw',
} satisfies Record<string, string>;

afterEach(async () => {
	cleanupOrphanedGatewayIfPresentMock.mockClear();
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
	);
});

async function createGatewayConfigPath(): Promise<string> {
	const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-gateway-zone-'));
	createdDirectories.push(workingDirectoryPath);
	const configDirectory = path.join(workingDirectoryPath, 'config', 'shravan');
	await mkdir(configDirectory, { recursive: true });
	const configPath = path.join(configDirectory, 'openclaw.json');
	await writeFile(
		configPath,
		JSON.stringify({
			agents: {
				defaults: {
					sandbox: openClawToolVmSandbox,
					workspace: '/zone/agents/default',
				},
			},
			gateway: {
				auth: { mode: 'token' },
				bind: 'loopback',
				controlUi: {
					allowedOrigins: ['http://127.0.0.1:18791', 'http://localhost:18791'],
				},
			},
		}),
		'utf8',
	);
	return configPath;
}

async function writeMinimalMcpPortalConfigs(
	configDir: string,
	mcpConfig: unknown = {
		providers: {},
		schemaVersion: 1,
	},
): Promise<void> {
	await writeFile(path.join(configDir, 'mcp.config.jsonc'), JSON.stringify(mcpConfig), 'utf8');
	await writeFile(
		path.join(configDir, 'mcp-portal.config.jsonc'),
		JSON.stringify({
			agents: { shravan: { profile: 'default' } },
			profiles: { default: { enabledNamespaces: [] } },
			schemaVersion: 1,
		}),
		'utf8',
	);
}

async function createSystemConfigPath(): Promise<string> {
	const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-gateway-cache-id-'));
	createdDirectories.push(workingDirectoryPath);
	const configDirectory = path.join(workingDirectoryPath, 'config');
	await mkdir(configDirectory, { recursive: true });
	return path.join(configDirectory, 'system.json');
}

function createHttpHealthGatewayLifecycle(): {
	readonly buildProcessSpec: () => {
		readonly bootstrapCommand: string;
		readonly guestListenPort: number;
		readonly healthCheck: { readonly type: 'http'; readonly port: number; readonly path: string };
		readonly logPath: string;
		readonly startCommand: string;
	};
	readonly buildVmSpec: () => {
		readonly allowedHosts: readonly string[];
		readonly environment: Record<string, never>;
		readonly mediatedSecrets: Record<string, never>;
		readonly rootfsMode: 'cow';
		readonly sessionLabel: string;
		readonly tcpHosts: Record<string, never>;
		readonly vfsMounts: Record<string, never>;
	};
} {
	return {
		buildProcessSpec: () => ({
			bootstrapCommand: 'bootstrap-http-gateway',
			guestListenPort: 18789,
			healthCheck: { type: 'http', port: 18789, path: '/' },
			logPath: '/tmp/http-gateway.log',
			startCommand: 'start-http-gateway',
		}),
		buildVmSpec: () => ({
			allowedHosts: [],
			environment: {},
			mediatedSecrets: {},
			rootfsMode: 'cow',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			tcpHosts: {},
			vfsMounts: {},
		}),
	};
}

async function createSystemConfig(): Promise<LoadedSystemConfig> {
	const workingDirectoryPath = await mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-gateway-zone-state-'),
	);
	createdDirectories.push(workingDirectoryPath);
	return createLoadedSystemConfig(
		{
			cacheDir: path.join(workingDirectoryPath, 'cache'),
			runtimeDir: path.join(workingDirectoryPath, 'runtime'),
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
					worker: {
						type: 'worker',
						buildConfig: './vm-images/gateways/worker/build-config.json',
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: './vm-images/tool-vms/default/build-config.json',
					},
				},
			},
			zones: [
				{
					id: 'shravan',
					gateway: {
						type: 'openclaw',
						imageProfile: 'openclaw',
						memory: '2G',
						cpus: 2,
						port: 18791,
						config: await createGatewayConfigPath(),
						rawEnvSecrets: ['AGENT_VM_ZONE_GIT_TOKEN', 'DISCORD_BOT_TOKEN'],
						stateDir: path.join(workingDirectoryPath, 'state', 'shravan'),
						zoneFilesDir: path.join(workingDirectoryPath, 'zone-files', 'shravan'),
					},
					secrets: {
						PERPLEXITY_API_KEY: {
							source: '1password',
							ref: 'op://agent-vm/shravan-perplexity/credential',
							injection: 'http-mediation',
							audience: 'gateway',
							hosts: ['api.perplexity.ai'],
						},
						DISCORD_BOT_TOKEN: {
							source: '1password',
							ref: 'op://agent-vm/shravan-discord/bot-token',
							injection: 'env',
							audience: 'gateway',
						},
						OPENCLAW_GATEWAY_TOKEN: {
							source: '1password',
							ref: 'op://agent-vm/shravan-gateway-auth/password',
							injection: 'env',
							audience: 'gateway',
						},
					},
					egressHosts: ['api.anthropic.com', 'api.openai.com', 'api.perplexity.ai'].map((host) => ({
						host,
						audience: 'gateway' as const,
					})),
					websocketBypass: ['gateway.discord.gg:443'],
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
				},
			],
			toolVmProfiles: {
				standard: {
					memory: '1G',
					cpus: 1,
					imageProfile: 'default',
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
		},
		{ systemConfigPath: await createSystemConfigPath() },
	);
}

const minimalBuildConfig: BuildConfig = {
	arch: 'aarch64',
	distro: 'alpine',
};

function createVmInstanceStub(pid: number = 28282): ManagedVmInstance {
	return {
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
		enableSsh: async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19000,
			user: 'sandbox',
		}),
		exec: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
		id: `vm-instance-${pid}`,
		server: {
			controller: {
				child: {
					pid,
				},
			},
		},
		setIngressRoutes: () => {},
	} as ManagedVmInstance;
}

function createOpenClawSecretResolver(resolvedSecrets: Record<string, string>): SecretResolver {
	return {
		resolve: async (secretRef): Promise<string> => {
			if (secretRef.ref === 'op://agent-vm/shravan-discord/bot-token') {
				return resolvedSecrets.DISCORD_BOT_TOKEN ?? 'resolved-discord-token';
			}

			if (secretRef.ref === 'op://agent-vm/shravan-perplexity/credential') {
				return resolvedSecrets.PERPLEXITY_API_KEY ?? 'resolved-perplexity-key';
			}

			if (secretRef.ref === 'op://agent-vm/shravan-gateway-auth/password') {
				return resolvedSecrets.OPENCLAW_GATEWAY_TOKEN ?? 'resolved-gateway-token';
			}

			throw new Error(`Unexpected secret ref: ${secretRef.ref}`);
		},
		resolveAll: async () => resolvedSecrets,
	};
}

describe('startGatewayZone', () => {
	it('builds the image, resolves secrets, creates the vm, and enables ingress', async () => {
		const taskTitles: string[] = [];
		const closeMock = vi.fn(async () => {});
		const enableIngressMock = vi.fn(async () => ({ host: '127.0.0.1', port: 18791 }));
		const enableSshMock = vi.fn(async () => ({ host: '127.0.0.1', port: 2222 }));
		const execMock = vi.fn(async (command: string) => ({
			exitCode: 0,
			stdout: command.includes('curl -sS -o /dev/null -w "%{http_code}"') ? '200' : '',
			stderr: '',
		}));
		const setIngressRoutesMock = vi.fn();
		const managedVm: ManagedVm = {
			id: 'vm-123',
			close: closeMock,
			enableIngress: enableIngressMock,
			enableSsh: enableSshMock,
			exec: execMock,
			getVmInstance: vi.fn(() => createVmInstanceStub(28282)),
			setIngressRoutes: setIngressRoutesMock,
		};
		const secretResolver = createOpenClawSecretResolver({
			PERPLEXITY_API_KEY: 'resolved-key',
			DISCORD_BOT_TOKEN: 'resolved-key',
			OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
		});
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

		const systemConfig = await createSystemConfig();
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

		expect(loadBuildConfig).toHaveBeenCalledWith('./vm-images/gateways/openclaw/build-config.json');
		const logDirectoryPath = path.join(systemConfig.runtimeDir, 'zones', 'shravan', 'logs');
		expect((await stat(logDirectoryPath)).mode & 0o777).toBe(0o700);
		expect(buildImage).toHaveBeenCalled();
		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.arrayContaining([
					'controller.vm.host',
					'api.anthropic.com',
					'api.openai.com',
					'api.perplexity.ai',
				]),
				cpus: 2,
				env: expect.objectContaining({
					HOME: '/home/openclaw',
					NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
					OPENCLAW_HOME: '/home/openclaw',
					OPENCLAW_CONFIG_PATH: '/home/openclaw/.openclaw/state/effective-openclaw.json',
					OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
					DISCORD_BOT_TOKEN: 'resolved-key',
				}),
				imagePath: '/tmp/gateway-image',
				memory: '2G',
				rootfsMode: 'cow',
				sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
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
				vfsMounts: expect.objectContaining({
					'/agent-vm/logs': {
						hostPath: path.join(systemConfig.runtimeDir, 'zones', 'shravan', 'logs'),
						kind: 'realfs',
					},
					'/home/openclaw/.openclaw/cache': {
						hostPath: path.join(systemConfig.cacheDir, 'gateways', 'shravan'),
						kind: 'realfs',
					},
				}),
			}),
		);
		expect(execMock).toHaveBeenCalledWith(
			'set -a && . /run/openclaw/secrets.env && set +a && cd /home/openclaw && nohup openclaw gateway --port 18789 > /agent-vm/logs/gateway-boot-latest.log 2>&1 &',
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
			'Cleaning orphaned gateway runtime',
			'Validating OpenClaw Tool VM requirements',
			'Resolving zone secrets',
			'Building gateway image',
			'Preparing host state',
			'Booting gateway VM',
			'Configuring gateway',
			'Starting gateway',
			'Waiting for readiness',
			'Recording gateway runtime',
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
			processSpec: {
				guestListenPort: 18789,
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
			},
		});
	});

	it('cleans orphaned gateway runtime before rejecting invalid OpenClaw Tool VM requirements', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		await writeFile(
			zone.gateway.config,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: {
							backend: 'host',
							mode: 'all',
							scope: 'agent',
							workspaceAccess: 'rw',
						},
						workspace: '/zone/agents/default',
					},
					list: [],
				},
			}),
			'utf8',
		);
		const cleanupOrphanedGatewayIfPresent = vi.fn(async () => ({
			cleanedUp: true,
			killedPid: 28282,
		}));
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imagePath: '/tmp/img',
		}));

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({}),
					systemConfig,
					zoneId: 'shravan',
				},
				{
					buildImage,
					cleanupOrphanedGatewayIfPresent,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow("OpenClaw zone 'shravan' Tool VM requirements failed");

		expect(cleanupOrphanedGatewayIfPresent).toHaveBeenCalledWith({
			stateDir: zone.gateway.stateDir,
			zoneId: 'shravan',
		});
		expect(buildImage).not.toHaveBeenCalled();
	});

	it('resolves only gateway audience secrets while starting the gateway VM', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-gateway-only',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' })),
			getVmInstance: vi.fn(() => createVmInstanceStub(28286)),
			setIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected gateway test system config to include a zone.');
		}
		zone.secrets.LINEAR_API_KEY = {
			source: '1password',
			ref: 'op://agent-vm/shravan-linear/credential',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.linear.app'],
		};
		zone.egressHosts = [...zone.egressHosts, { host: 'api.linear.app', audience: 'tool-vm' }];
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'pplx-key',
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
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

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.not.arrayContaining(['api.linear.app']),
				env: expect.not.objectContaining({
					LINEAR_API_KEY: expect.any(String),
				}),
				secrets: expect.not.objectContaining({
					LINEAR_API_KEY: expect.anything(),
				}),
			}),
		);
	});

	it('materializes MCP Portal runtime plugin config from zone MCP config', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir);
		const lifecycleZones: GatewayZoneConfig[] = [];
		const managedVm: ManagedVm = {
			id: 'vm-mcp',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' })),
			getVmInstance: vi.fn(() => createVmInstanceStub(28290)),
			setIngressRoutes: vi.fn(),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					agents: [{ id: 'shravan' }],
					mcpPortal: { configDir },
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				loadGatewayLifecycle: () => ({
					buildProcessSpec: () => ({
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/' } as const,
						logPath: '/tmp/gateway.log',
						startCommand: 'start',
					}),
					buildVmSpec: (options) => {
						lifecycleZones.push(options.zone);
						return {
							allowedHosts: [],
							environment: {},
							mediatedSecrets: {},
							rootfsMode: 'cow' as const,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							tcpHosts: {},
							vfsMounts: {},
						};
					},
				}),
			},
		);

		expect(lifecycleZones[0]?.runtimePluginConfigs).toEqual({
			'mcp-portal': { configDir: '/home/openclaw/.openclaw/cache/mcp-portal-effective' },
		});
		expect(lifecycleZones[0]?.runtimeMcpServers).toBeUndefined();
	});

	it('does not generate OpenClaw mcp.servers entries for managed MCP Portal', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir);
		const lifecycleZones: GatewayZoneConfig[] = [];
		const managedVm: ManagedVm = {
			id: 'vm-mcp-native',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' })),
			getVmInstance: vi.fn(() => createVmInstanceStub(28290)),
			setIngressRoutes: vi.fn(),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					agents: [{ id: 'shravan' }],
					mcpPortal: { configDir },
				},
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				loadGatewayLifecycle: () => ({
					buildProcessSpec: () => ({
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/' } as const,
						logPath: '/tmp/gateway.log',
						startCommand: 'start',
					}),
					buildVmSpec: (options) => {
						lifecycleZones.push(options.zone);
						return {
							allowedHosts: [],
							environment: {},
							mediatedSecrets: {},
							rootfsMode: 'cow' as const,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							tcpHosts: {},
							vfsMounts: {},
						};
					},
				}),
			},
		);

		expect(lifecycleZones[0]?.runtimeMcpServers).toBeUndefined();
	});

	it('adds MCP Portal upstream hosts to effective gateway egress', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				deepwiki: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://mcp.deepwiki.com/mcp' },
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-generated-egress',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' })),
			getVmInstance: vi.fn(() => createVmInstanceStub(28291)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					mcpPortal: { configDir },
				},
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

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.arrayContaining(['mcp.deepwiki.com']),
			}),
		);
	});

	it('does not duplicate MCP Portal upstream hosts declared for gateway egress', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				deepwiki: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://mcp.deepwiki.com/mcp' },
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-egress',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' })),
			getVmInstance: vi.fn(() => createVmInstanceStub(28291)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					egressHosts: [...baseZone.egressHosts, { audience: 'gateway', host: 'mcp.deepwiki.com' }],
					mcpPortal: { configDir },
				},
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

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.arrayContaining(['mcp.deepwiki.com']),
			}),
		);
		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall as [{ readonly allowedHosts: readonly string[] }];
		expect(vmOptions.allowedHosts.filter((host) => host === 'mcp.deepwiki.com')).toHaveLength(1);
	});

	it('keeps loopback MCP Portal provider URLs out of gateway egress', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				local_proxy: {
					kind: 'mcp',
					namespace: 'local_proxy',
					transport: { kind: 'streamable-http', url: 'http://127.0.0.1:18791/mcp' },
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-loopback',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' })),
			getVmInstance: vi.fn(() => createVmInstanceStub(28292)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async () => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					mcpPortal: { configDir },
				},
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

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.not.arrayContaining(['127.0.0.1', 'localhost']),
			}),
		);
	});

	it('merges environmentOverride into vm environment before boot', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-override',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '200' })),
			getVmInstance: vi.fn(() => createVmInstanceStub(28286)),
			setIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				environmentOverride: {
					DATABASE_URL: 'postgres://app:secret@postgres.local:5432/app',
				},
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp-env-override',
					imagePath: '/tmp/gateway-image',
				})),
				createManagedVm,
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				env: expect.objectContaining({
					DATABASE_URL: 'postgres://app:secret@postgres.local:5432/app',
				}),
			}),
		);
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
					systemConfig: await createSystemConfig(),
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

	it('loads the worker lifecycle for worker gateway zones', async () => {
		const systemConfig = await createSystemConfig();
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
				secrets: {
					OPENAI_API_KEY: {
						source: '1password' as const,
						ref: 'op://agent-vm/shravan-openai/credential',
						injection: 'http-mediation' as const,
						audience: 'gateway' as const,
						hosts: ['api.openai.com'],
					},
				},
			})),
		};
		const secretResolver: SecretResolver = {
			resolve: async () => 'openai-key',
			resolveAll: async () => ({ OPENAI_API_KEY: 'openai-key' }),
		};
		const execMock = vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '200' }));
		const setIngressRoutesMock = vi.fn();
		const enableIngressMock = vi.fn(async () => ({ host: '127.0.0.1', port: 18791 }));

		const result = await startGatewayZone(
			{
				secretResolver,
				systemConfig: workerSystemConfig,
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp-worker',
					imagePath: '/tmp/worker-image',
				})),
				cleanupOrphanedGatewayIfPresent: vi.fn(async () => ({
					cleanedUp: false,
					killedPid: null,
				})),
				createManagedVm: vi.fn(async () => ({
					close: vi.fn(),
					enableIngress: enableIngressMock,
					enableSsh: vi.fn(),
					exec: execMock,
					getVmInstance: vi.fn(() => createVmInstanceStub(12345)),
					id: 'worker-vm-123',
					setIngressRoutes: setIngressRoutesMock,
				})),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				writeGatewayRuntimeRecord: vi.fn(async () => {}),
			},
		);

		expect(result.processSpec.startCommand).toContain('agent-vm-worker');
		expect(result.processSpec.healthCheck).toEqual({ type: 'http', port: 18789, path: '/health' });
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
			getVmInstance: vi.fn(() => createVmInstanceStub(28283)),
			setIngressRoutes: setIngressRoutesMock,
		};
		const secretResolver = createOpenClawSecretResolver({
			PERPLEXITY_API_KEY: 'pplx-key',
			DISCORD_BOT_TOKEN: 'discord-token',
			OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
		});
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver,
				systemConfig: await createSystemConfig(),
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
			getVmInstance: vi.fn(() => createVmInstanceStub(28284)),
		};
		const createManagedVm = vi.fn(async (_options: unknown): Promise<ManagedVm> => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'key',
					DISCORD_BOT_TOKEN: 'token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
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

	it('throws with the gateway log tail and closes the vm when readiness polling exhausts all attempts', async () => {
		const closeMock = vi.fn(async () => {});
		const execMock = vi.fn(async (command: string) => {
			if (command.includes('tail -n 80')) {
				return {
					exitCode: 0,
					stdout: 'OpenClaw failed to parse config: unknown thinkingDefault\n',
					stderr: '',
				};
			}
			if (command.includes('http://127.0.0.1:18789/readyz')) {
				return { exitCode: 1, stdout: '', stderr: '' };
			}
			return { exitCode: 0, stdout: '000', stderr: '' };
		});
		const managedVm: ManagedVm = {
			id: 'vm-timeout',
			close: closeMock,
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: execMock,
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(() => createVmInstanceStub(28285)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					gatewayReadinessMaxAttempts: 2,
					gatewayReadinessRetryDelayMs: 0,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow(
			/Gateway readiness check failed after 2 attempts.*Last probe: http \(empty\).*Gateway process may still be booting, or it may have crashed before opening its health port.*OpenClaw failed to parse config/su,
		);
		expect(execMock).toHaveBeenCalledWith(
			'tail -n 80 /agent-vm/logs/gateway-boot-latest.log 2>/dev/null || true',
		);
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('defaults gateway readiness polling to about 60 seconds', async () => {
		const execMock = vi.fn(async (command: string) => {
			if (command.includes('tail -n 80')) {
				return { exitCode: 0, stdout: '', stderr: '' };
			}
			if (command.includes('http://127.0.0.1:18789/readyz')) {
				return { exitCode: 1, stdout: '', stderr: '' };
			}
			return { exitCode: 0, stdout: '000', stderr: '' };
		});
		const managedVm: ManagedVm = {
			id: 'vm-default-timeout',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: execMock,
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(() => createVmInstanceStub(28285)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					gatewayReadinessRetryDelayMs: 0,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow(/Gateway readiness check failed after 120 attempts/su);
	});

	it('throws command stdout and stderr and closes the vm when gateway configuration fails', async () => {
		const closeMock = vi.fn(async () => {});
		const managedVm: ManagedVm = {
			id: 'vm-config-failed',
			close: closeMock,
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async (command: string) =>
				command.includes('cat > /etc/profile.d/openclaw-env.sh')
					? {
							exitCode: 42,
							stdout: 'bootstrap stdout',
							stderr: 'bootstrap stderr',
						}
					: { exitCode: 0, stdout: '200', stderr: '' },
			),
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(() => createVmInstanceStub(28285)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					gatewayReadinessMaxAttempts: 5,
					gatewayReadinessRetryDelayMs: 0,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				},
			),
		).rejects.toThrow(/Configuring gateway failed.*exit 42.*bootstrap stdout.*bootstrap stderr/su);
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('does not treat non-2xx http responses as ready', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-not-ready-500',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi
				.fn()
				.mockResolvedValueOnce({ exitCode: 0, stdout: '500', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '500', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '500', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '500', stderr: '' })
				.mockResolvedValueOnce({ exitCode: 0, stdout: '500', stderr: '' })
				.mockResolvedValue({ exitCode: 0, stdout: '500', stderr: '' }),
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(() => createVmInstanceStub(28286)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					createManagedVm: vi.fn(async () => managedVm),
					gatewayReadinessMaxAttempts: 5,
					gatewayReadinessRetryDelayMs: 0,
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
					loadGatewayLifecycle: createHttpHealthGatewayLifecycle,
				},
			),
		).rejects.toThrow(/500/u);
	});

	it('supports command-based health checks', async () => {
		const execMock = vi.fn(async (command: string) => ({
			exitCode: command === 'check-health' ? 0 : 0,
			stdout: '',
			stderr: '',
		}));
		const managedVm: ManagedVm = {
			id: 'vm-command-health',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: execMock,
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(() => createVmInstanceStub(28287)),
		};

		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
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
				loadGatewayLifecycle: () => ({
					buildProcessSpec: () => ({
						bootstrapCommand: 'bootstrap-worker',
						guestListenPort: 18789,
						healthCheck: { type: 'command', command: 'check-health' } as const,
						logPath: '/tmp/worker.log',
						startCommand: 'start-worker',
					}),
					buildVmSpec: () => ({
						allowedHosts: [],
						environment: {},
						mediatedSecrets: {},
						rootfsMode: 'cow' as const,
						sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
						tcpHosts: {},
						vfsMounts: {},
					}),
				}),
			},
		);

		expect(execMock).toHaveBeenCalledWith('check-health');
		expect(result.processSpec.logPath).toBe('/tmp/worker.log');
	});

	it('omits full gateway commands from command failure messages', async () => {
		const secretBearingBootstrapCommand =
			"export FUTURE_SECRET='do-not-leak-command-material' && false";
		const managedVm: ManagedVm = {
			id: 'vm-failed-bootstrap',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async (command: string) =>
				command === secretBearingBootstrapCommand
					? { exitCode: 1, stdout: 'bootstrap stdout', stderr: 'bootstrap stderr' }
					: { exitCode: 0, stdout: '200', stderr: '' },
			),
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(() => createVmInstanceStub(28287)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createSystemConfig(),
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
					loadGatewayLifecycle: () => ({
						buildProcessSpec: () => ({
							bootstrapCommand: secretBearingBootstrapCommand,
							guestListenPort: 18789,
							healthCheck: { type: 'http', port: 18789, path: '/' } as const,
							logPath: '/tmp/worker.log',
							startCommand: 'start-worker',
						}),
						buildVmSpec: () => ({
							allowedHosts: [],
							environment: {},
							mediatedSecrets: {},
							rootfsMode: 'cow' as const,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							tcpHosts: {},
							vfsMounts: {},
						}),
					}),
				},
			),
		).rejects.toThrow(
			/^(?!.*(?:do-not-leak-command-material|Command:))Configuring gateway failed with exit 1/u,
		);
	});

	it('retries health checks until a 2xx response is returned', async () => {
		const execMock = vi.fn(async (command: string) => {
			if (!command.includes('curl -sS -o /dev/null -w "%{http_code}"')) {
				return { exitCode: 0, stdout: '', stderr: '' };
			}
			healthProbeCount += 1;
			return {
				exitCode: 0,
				stdout: healthProbeCount === 1 ? '000' : '200',
				stderr: '',
			};
		});
		let healthProbeCount = 0;
		const managedVm: ManagedVm = {
			id: 'vm-retry-health',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: execMock,
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(() => createVmInstanceStub(28288)),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				cleanupOrphanedGatewayIfPresent: vi.fn(async () => ({
					cleanedUp: false,
					killedPid: null,
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
				loadGatewayLifecycle: createHttpHealthGatewayLifecycle,
			},
		);

		expect(execMock).toHaveBeenNthCalledWith(
			3,
			expect.stringContaining('curl -sS -o /dev/null -w "%{http_code}"'),
		);
		expect(execMock).toHaveBeenNthCalledWith(
			4,
			expect.stringContaining('curl -sS -o /dev/null -w "%{http_code}"'),
		);
		expect(healthProbeCount).toBe(2);
	});

	it('configures the gateway to use the generated effective OpenClaw config path', async () => {
		const execMock = vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' }));
		const managedVm: ManagedVm = {
			id: 'vm-token',
			close: vi.fn(async () => {}),
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: execMock,
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(() => createVmInstanceStub(28289)),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				buildImage: vi.fn(async () => ({
					built: true,
					fingerprint: 'fp',
					imagePath: '/tmp/img',
				})),
				cleanupOrphanedGatewayIfPresent: vi.fn(async () => ({
					cleanedUp: false,
					killedPid: null,
				})),
				createManagedVm: vi.fn(async () => managedVm),
				loadBuildConfig: vi.fn(async () => minimalBuildConfig),
			},
		);

		expect(execMock).toHaveBeenCalledWith(
			expect.stringContaining("cat > /etc/profile.d/openclaw-env.sh << 'ENVEOF'"),
		);
		expect(execMock).toHaveBeenCalledWith(
			expect.stringContaining('chmod 644 /etc/profile.d/openclaw-env.sh'),
		);
		expect(execMock).toHaveBeenCalledWith(expect.stringContaining('source /root/.bashrc'));
		expect(execMock).toHaveBeenCalledWith(
			expect.stringContaining(
				'export OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/state/effective-openclaw.json',
			),
		);
	});

	it('closes the booted gateway VM if writing the runtime record fails', async () => {
		const closeMock = vi.fn(async () => {});
		const managedVm: ManagedVm = {
			id: 'vm-record-fail',
			close: closeMock,
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 2222 })),
			exec: vi.fn(async () => ({ exitCode: 0, stdout: '200', stderr: '' })),
			setIngressRoutes: vi.fn(),
			getVmInstance: vi.fn(() => createVmInstanceStub(28290)),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					buildImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imagePath: '/tmp/img',
					})),
					cleanupOrphanedGatewayIfPresent: vi.fn(async () => ({
						cleanedUp: false,
						killedPid: null,
					})),
					createManagedVm: vi.fn(async () => managedVm),
					loadBuildConfig: vi.fn(async () => minimalBuildConfig),
					writeGatewayRuntimeRecord: vi.fn(async () => {
						throw new Error('disk full');
					}),
				},
			),
		).rejects.toThrow(/disk full/u);

		expect(closeMock).toHaveBeenCalledTimes(1);
	});
});
