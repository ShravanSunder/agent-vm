import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { GatewayZoneConfig } from '@agent-vm/gateway-interface';
import type { SecretResolver } from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openclawLifecycle } from './openclaw-lifecycle.js';

const createdDirectories: string[] = [];
const execFileAsync = promisify(execFile);
type OpenClawGatewayConfig = Extract<GatewayZoneConfig['gateway'], { readonly type: 'openclaw' }>;

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function renderBootstrapFiles(command: string, rootDirectory: string): Promise<void> {
	const rootedCommand = command
		.replaceAll('/root', path.join(rootDirectory, 'root'))
		.replaceAll('/etc/profile.d', path.join(rootDirectory, 'etc', 'profile.d'))
		.replaceAll('/run/openclaw', path.join(rootDirectory, 'run', 'openclaw'))
		.replaceAll('/work', path.join(rootDirectory, 'work'))
		.replace(`chown -R openclaw:openclaw ${path.join(rootDirectory, 'work')} && `, '');
	await execFileAsync('bash', ['-lc', rootedCommand]);
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
	);
});

const resolvedSecrets: Record<string, string> = {
	DISCORD_BOT_TOKEN: 'discord-token',
	OPENCLAW_GATEWAY_TOKEN: "gateway'token",
	PERPLEXITY_API_KEY: 'perplexity-token',
};

function createZone(overrides?: {
	readonly authProfilesRef?: GatewayZoneConfig['gateway']['authProfilesRef'];
	readonly gateway?: Partial<OpenClawGatewayConfig>;
	readonly runtimeEnvironment?: GatewayZoneConfig['runtimeEnvironment'];
	readonly runtimePluginConfigs?: GatewayZoneConfig['runtimePluginConfigs'];
	readonly withoutAuthProfilesRef?: boolean;
}): GatewayZoneConfig {
	const baseGateway: OpenClawGatewayConfig = {
		cpus: 2,
		config: '/host/config/shravan/openclaw.json',
		memory: '2G',
		port: 18791,
		ssh: { secretEnv: 'explicit' },
		stateDir: '/host/state/shravan',
		type: 'openclaw',
		zoneFilesDir: '/host/zone-files/shravan',
	};

	return {
		egressHosts: ['api.openai.com', 'api.perplexity.ai'].map((host) => ({
			host,
			audience: 'gateway' as const,
		})),
		gateway: {
			...baseGateway,
			...(overrides?.withoutAuthProfilesRef
				? {}
				: {
						authProfilesRef: overrides?.authProfilesRef ?? {
							source: '1password',
							ref: 'op://vault/item/auth-profiles',
						},
					}),
			...overrides?.gateway,
		},
		id: 'shravan',
		secrets: {
			DISCORD_BOT_TOKEN: {
				injection: 'env',
				audience: 'gateway',
				source: '1password',
				ref: 'op://vault/item/discord',
			},
			OPENCLAW_GATEWAY_TOKEN: {
				injection: 'env',
				audience: 'gateway',
				source: '1password',
				ref: 'op://vault/item/openclaw-gateway-token',
			},
			PERPLEXITY_API_KEY: {
				hosts: ['api.perplexity.ai'],
				injection: 'http-mediation',
				audience: 'gateway',
				source: '1password',
				ref: 'op://vault/item/perplexity',
			},
		},
		defaultToolVmProfile: 'standard',
		...(overrides?.runtimeEnvironment ? { runtimeEnvironment: overrides.runtimeEnvironment } : {}),
		...(overrides?.runtimePluginConfigs
			? { runtimePluginConfigs: overrides.runtimePluginConfigs }
			: {}),
		websocketBypass: ['gateway.discord.gg:443'],
	};
}

describe('openclawLifecycle', () => {
	describe('authConfig', () => {
		it('provides a list-providers command', () => {
			expect(openclawLifecycle.authConfig).toBeDefined();
			expect(openclawLifecycle.authConfig?.listProvidersCommand).toBe(
				'openclaw models auth list --format plain 2>/dev/null || echo ""',
			);
		});

		it('builds a login command for a given provider', () => {
			expect(openclawLifecycle.authConfig?.buildLoginCommand('codex')).toBe(
				"openclaw models auth login --provider 'codex'",
			);
			expect(openclawLifecycle.authConfig?.buildLoginCommand('openai-codex')).toBe(
				"openclaw models auth login --provider 'openai-codex'",
			);
			expect(
				openclawLifecycle.authConfig?.buildLoginCommand('openai-codex', {
					deviceCode: true,
					setDefault: true,
				}),
			).toBe("openclaw models auth login --provider 'openai-codex' --device-code --set-default");
		});

		it('shell-quotes provider values safely', () => {
			expect(
				openclawLifecycle.authConfig?.buildLoginCommand("codex'; touch /tmp/pwned; echo '"),
			).toBe("openclaw models auth login --provider 'codex'\\''; touch /tmp/pwned; echo '\\'''");
		});
	});

	describe('buildVmSpec', () => {
		it('splits environment and mediated secrets', () => {
			const vmSpec = openclawLifecycle.buildVmSpec({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				runtimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 3,
				},
				zone: createZone(),
			});

			expect(vmSpec.environment.DISCORD_BOT_TOKEN).toBe('discord-token');
			expect(vmSpec.environment.OPENCLAW_GATEWAY_TOKEN).toBe("gateway'token");
			expect(vmSpec.environment.PERPLEXITY_API_KEY).toBeUndefined();
			expect(vmSpec.mediatedSecrets.PERPLEXITY_API_KEY).toEqual({
				hosts: ['api.perplexity.ai'],
				value: 'perplexity-token',
			});
		});

		it('injects runtime environment without mediating or persisting it', () => {
			const vmSpec = openclawLifecycle.buildVmSpec({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				runtimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 3,
				},
				zone: createZone({
					runtimeEnvironment: {
						AGENT_VM_ZONE_GIT_TOKEN: 'runtime-zone-git-token',
					},
				}),
			});

			expect(vmSpec.environment.AGENT_VM_ZONE_GIT_TOKEN).toBe('runtime-zone-git-token');
			expect(vmSpec.mediatedSecrets.AGENT_VM_ZONE_GIT_TOKEN).toBeUndefined();
		});

		it('builds the expected OpenClaw environment, mounts, and tcp hosts', () => {
			const vmSpec = openclawLifecycle.buildVmSpec({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				runtimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 2,
				},
				zone: createZone(),
			});

			expect(vmSpec.environment.OPENCLAW_HOME).toBe('/home/openclaw');
			expect(vmSpec.environment.OPENCLAW_CONFIG_PATH).toBe(
				'/home/openclaw/.openclaw/state/effective-openclaw.json',
			);
			expect(vmSpec.environment.OPENCLAW_PLUGIN_STAGE_DIR).toBeUndefined();
			expect(vmSpec.environment.TMPDIR).toBe('/work/tmp');
			expect(vmSpec.environment.PNPM_HOME).toBe('/pnpm');
			expect(vmSpec.environment.PATH).toContain('/pnpm:');
			expect(vmSpec.environment.npm_config_cache).toBe('/work/cache/npm');
			expect(vmSpec.vfsMounts['/home/openclaw/.openclaw/config']).toEqual({
				hostPath: '/host/config/shravan',
				kind: 'realfs',
			});
			expect(vmSpec.vfsMounts['/home/openclaw/.openclaw/cache']).toEqual({
				hostPath: '/host/cache/gateways/shravan',
				kind: 'realfs',
			});
			expect(vmSpec.vfsMounts['/agent-vm/logs']).toEqual({
				hostPath: '/host/runtime/zones/shravan/logs',
				kind: 'realfs',
			});
			expect(vmSpec.vfsMounts['/zone']).toEqual({
				hostPath: '/host/zone-files/shravan',
				kind: 'realfs',
			});
			expect(vmSpec.vfsMounts['/work']).toBeUndefined();
			expect(vmSpec.vfsMounts['/home/openclaw/zone-files']).toBeUndefined();
			expect(vmSpec.vfsMounts['/home/openclaw/workspace']).toBeUndefined();
			expect(vmSpec.vfsMounts['/var/lib/openclaw/plugin-runtime-deps']).toBeUndefined();
			expect(vmSpec.tcpHosts).toEqual({
				'controller.vm.host:18800': '127.0.0.1:18800',
				'gateway.discord.gg:443': 'gateway.discord.gg:443',
				'tool-0.vm.host:22': '127.0.0.1:19000',
				'tool-1.vm.host:22': '127.0.0.1:19001',
			});
			expect(vmSpec.sessionLabel).toBe('claw-tests-a1b2c3d4:shravan:gateway');
		});
	});

	describe('buildProcessSpec', () => {
		it('builds bootstrap and start commands with runtime-injected gateway token', () => {
			const processSpec = openclawLifecycle.buildProcessSpec(
				createZone({
					runtimeEnvironment: {
						AGENT_VM_ZONE_GIT_TOKEN: 'runtime-zone-git-token',
					},
				}),
				resolvedSecrets,
			);

			expect(processSpec.bootstrapCommand).toContain('/etc/profile.d/openclaw-env.sh');
			expect(processSpec.bootstrapCommand).toContain('/run/openclaw/secrets.env');
			expect(processSpec.bootstrapCommand).toContain("printf '%s\\n'");
			expect(processSpec.bootstrapCommand).toContain('DISCORD_BOT_TOKEN');
			expect(processSpec.bootstrapCommand).toContain('discord-token');
			expect(processSpec.bootstrapCommand).toContain('OPENCLAW_GATEWAY_TOKEN');
			expect(processSpec.bootstrapCommand).toContain('gateway');
			expect(processSpec.bootstrapCommand).toContain('AGENT_VM_ZONE_GIT_TOKEN');
			expect(processSpec.bootstrapCommand).toContain('runtime-zone-git-token');
			expect(processSpec.bootstrapCommand).not.toContain(
				`cat > /run/openclaw/secrets.env << 'ENVEOF'`,
			);
			expect(processSpec.bootstrapCommand).not.toContain('/etc/profile.d/openclaw-admin.sh');
			expect(processSpec.bootstrapCommand).not.toContain('/run/openclaw/gateway-auth.env');
			expect(processSpec.bootstrapCommand).not.toContain('openclaw()');
			expect(processSpec.bootstrapCommand).toContain(
				'OPENCLAW_CONFIG_PATH=/home/openclaw/.openclaw/state/effective-openclaw.json',
			);
			expect(processSpec.bootstrapCommand).not.toContain('OPENCLAW_PLUGIN_STAGE_DIR');
			expect(processSpec.bootstrapCommand).toContain('/work/tmp /work/cache/npm');
			expect(processSpec.bootstrapCommand).toContain('chown -R openclaw:openclaw /work');
			expect(processSpec.bootstrapCommand).toContain('TMPDIR=/work/tmp');
			expect(processSpec.bootstrapCommand).toContain('PNPM_HOME=/pnpm');
			expect(processSpec.bootstrapCommand).toContain('PATH=/pnpm:$PATH');
			expect(processSpec.bootstrapCommand).toContain('npm_config_cache=/work/cache/npm');
			expect(processSpec.startCommand).toContain('. /run/openclaw/secrets.env');
			expect(processSpec.startCommand).toContain('cd /home/openclaw');
			expect(processSpec.bootstrapCommand).toContain('/etc/profile.d/openclaw-env.sh');
			expect(processSpec.bootstrapCommand).toContain('source /root/.bashrc');
			expect(processSpec.startCommand).toContain('nohup openclaw gateway --port 18789');
			expect(processSpec.startCommand).toContain('> /agent-vm/logs/gateway-boot-latest.log 2>&1');
			expect(processSpec.healthCheck).toEqual({
				type: 'http',
				port: 18789,
				path: '/readyz',
			});
			expect(processSpec.logPath).toBe('/agent-vm/logs/gateway-boot-latest.log');
		});

		it('rejects multiline env-injected secrets before building the bootstrap command', () => {
			expect(() =>
				openclawLifecycle.buildProcessSpec(createZone(), {
					...resolvedSecrets,
					OPENCLAW_GATEWAY_TOKEN: 'gateway\nENVEOF\ncommand',
				}),
			).toThrow(/single-line value/u);
		});

		it('writes profile scripts without expanding runtime shell expressions', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-bootstrap-'));
			createdDirectories.push(tempDirectory);
			const processSpec = openclawLifecycle.buildProcessSpec(createZone(), resolvedSecrets);

			await renderBootstrapFiles(processSpec.bootstrapCommand, tempDirectory);

			const environmentShellScript = await readFile(
				path.join(tempDirectory, 'etc', 'profile.d', 'openclaw-env.sh'),
				'utf8',
			);
			await expect(
				readFile(path.join(tempDirectory, 'etc', 'profile.d', 'openclaw-admin.sh'), 'utf8'),
			).rejects.toThrow();
			expect(environmentShellScript).toContain('export PATH=/pnpm:$PATH');
		});
	});

	describe('prepareHostState', () => {
		it('writes auth-profiles.json and effective-openclaw.json when auth is configured', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-04-27T16:45:00.000Z'));
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(
					{
						agents: { defaults: { workspace: '/zone' } },
						logging: { level: 'debug' },
						gateway: {
							auth: { mode: 'token' },
							bind: 'loopback',
							controlUi: {
								allowedOrigins: ['http://127.0.0.1:18791', 'http://localhost:18791'],
							},
						},
						plugins: {
							allow: ['gondolin'],
							entries: {
								gondolin: {
									enabled: true,
									config: {
										controllerUrl: 'http://controller.vm.host:18800',
										zoneId: 'shravan',
									},
								},
							},
						},
					},
					null,
					2,
				),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
					authProfilesByAgent: {
						shravan: {
							source: '1password',
							ref: 'op://vault/item/shravan-auth-profiles',
						},
					},
				},
				runtimePluginConfigs: {
					gondolin: {
						zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN',
					},
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/auth-profiles') {
						return '{"profiles":["main"]}';
					}

					if (secretRef.ref === 'op://vault/item/shravan-auth-profiles') {
						return '{"profiles":["shravan"]}';
					}

					if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
						return 'resolved-gateway-token';
					}

					throw new Error(`Unexpected ref: ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			const effectiveOpenClawConfigContent = await readFile(
				path.join(zone.gateway.stateDir, 'effective-openclaw.json'),
				'utf8',
			);
			expect(effectiveOpenClawConfigContent).not.toContain('resolved-gateway-token');
			expect(JSON.parse(effectiveOpenClawConfigContent)).toMatchObject({
				agents: { defaults: { workspace: '/zone' } },
				logging: {
					level: 'debug',
					file: '/agent-vm/logs/openclaw-YYYY-MM-DD.log',
				},
				gateway: {
					auth: {
						mode: 'token',
						token: {
							id: 'OPENCLAW_GATEWAY_TOKEN',
							provider: 'default',
							source: 'env',
						},
					},
					bind: 'loopback',
					controlUi: {
						allowedOrigins: ['http://127.0.0.1:18791', 'http://localhost:18791'],
					},
				},
				plugins: {
					allow: ['gondolin'],
					entries: {
						gondolin: {
							enabled: true,
							config: {
								controllerUrl: 'http://controller.vm.host:18800',
								zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN',
								zoneId: 'shravan',
							},
						},
					},
				},
				secrets: {
					providers: {
						default: { source: 'env' },
					},
				},
				meta: {
					lastTouchedAt: '2026-04-27T16:45:00.000Z',
					lastTouchedVersion: 'agent-vm',
				},
			});
			expect(
				(await stat(path.join(zone.gateway.stateDir, 'effective-openclaw.json'))).mode & 0o777,
			).toBe(0o600);
			await expect(
				readFile(
					path.join(zone.gateway.stateDir, 'agents', 'main', 'agent', 'auth-profiles.json'),
					'utf8',
				),
			).resolves.toBe('{"profiles":["main"]}');
			await expect(
				readFile(
					path.join(zone.gateway.stateDir, 'agents', 'shravan', 'agent', 'auth-profiles.json'),
					'utf8',
				),
			).resolves.toBe('{"profiles":["shravan"]}');
			expect((await stat(zone.gateway.stateDir)).mode & 0o777).toBe(0o700);
		});

		it('attempts all per-agent auth profile writes before reporting failures', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-auth-fail-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify({ gateway: { auth: { mode: 'token' }, bind: 'loopback' } }, null, 2),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					authProfilesByAgent: {
						alevtina: {
							source: '1password',
							ref: 'op://vault/item/alevtina-auth-profiles',
						},
						shravan: {
							source: '1password',
							ref: 'op://vault/item/shravan-auth-profiles',
						},
					},
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
				withoutAuthProfilesRef: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
						return 'resolved-gateway-token';
					}
					if (secretRef.ref === 'op://vault/item/alevtina-auth-profiles') {
						return '{"profiles":["alevtina"]}';
					}
					if (secretRef.ref === 'op://vault/item/shravan-auth-profiles') {
						throw new Error('missing auth secret');
					}
					throw new Error(`Unexpected ref: ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
				/Failed to write 1 OpenClaw auth profile/u,
			);
			await expect(
				readFile(
					path.join(zone.gateway.stateDir, 'agents', 'alevtina', 'agent', 'auth-profiles.json'),
					'utf8',
				),
			).resolves.toBe('{"profiles":["alevtina"]}');
		});

		it('still writes effective-openclaw.json when authProfilesRef is absent', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-no-auth-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(
					{
						gateway: {
							auth: { mode: 'token' },
							bind: 'loopback',
						},
					},
					null,
					2,
				),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
				withoutAuthProfilesRef: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
						return 'resolved-gateway-token';
					}

					throw new Error(`Unexpected ref: ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			await expect(pathExists(zone.gateway.stateDir)).resolves.toBe(true);
			expect((await stat(zone.gateway.stateDir)).mode & 0o777).toBe(0o700);
			await expect(pathExists(path.join(zone.gateway.stateDir, 'agents'))).resolves.toBe(false);
			await expect(
				pathExists(path.join(zone.gateway.stateDir, 'effective-openclaw.json')),
			).resolves.toBe(true);
			const effectiveOpenClawConfigContent = await readFile(
				path.join(zone.gateway.stateDir, 'effective-openclaw.json'),
				'utf8',
			);
			expect(JSON.parse(effectiveOpenClawConfigContent).logging).toEqual({
				file: '/agent-vm/logs/openclaw-YYYY-MM-DD.log',
			});
		});

		it('preserves an authored logging file path in effective-openclaw.json', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-logs-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(
					{
						logging: {
							file: '/agent-vm/logs/custom-openclaw.log',
							level: 'debug',
						},
						gateway: {
							auth: { mode: 'token' },
							bind: 'loopback',
						},
					},
					null,
					2,
				),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
				withoutAuthProfilesRef: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
						return 'resolved-gateway-token';
					}

					throw new Error(`Unexpected ref: ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			const effectiveOpenClawConfigContent = await readFile(
				path.join(zone.gateway.stateDir, 'effective-openclaw.json'),
				'utf8',
			);
			expect(JSON.parse(effectiveOpenClawConfigContent).logging).toEqual({
				file: '/agent-vm/logs/custom-openclaw.log',
				level: 'debug',
			});
		});

		it('throws when OPENCLAW_GATEWAY_TOKEN ref is absent', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-no-token-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify({ gateway: { auth: { mode: 'token' }, bind: 'loopback' } }, null, 2),
				'utf8',
			);
			const zoneWithoutGatewayToken = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
			});
			const { OPENCLAW_GATEWAY_TOKEN: _removedGatewayToken, ...remainingSecrets } =
				zoneWithoutGatewayToken.secrets;
			const invalidZone = {
				...zoneWithoutGatewayToken,
				secrets: remainingSecrets,
			} as GatewayZoneConfig;
			const secretResolver: SecretResolver = {
				resolve: async () => {
					throw new Error('resolve should not be called');
				},
				resolveAll: async () => ({}),
			};

			await expect(
				openclawLifecycle.prepareHostState?.(invalidZone, secretResolver),
			).rejects.toThrow(/secret 'OPENCLAW_GATEWAY_TOKEN' is missing/u);
		});

		it('throws when base config is not a JSON object', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-bad-config-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(['not-an-object'], null, 2),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/auth-profiles') {
						return '{"profiles":[]}';
					}
					if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
						return 'resolved-gateway-token';
					}
					throw new Error(`Unexpected ref: ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
				/Failed to write effective OpenClaw config for zone 'shravan'.*must be a JSON object/u,
			);
		});

		it('cleans up the temp effective config file if atomic rename fails', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-rename-fail-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			const configPath = path.join(configDirectory, 'openclaw.json');
			await writeFile(
				configPath,
				JSON.stringify({
					gateway: {
						auth: { mode: 'token' },
						bind: 'loopback',
					},
				}),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					config: configPath,
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
				withoutAuthProfilesRef: true,
			});
			await mkdir(path.join(zone.gateway.stateDir, 'effective-openclaw.json'), {
				recursive: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async () => 'resolved-gateway-token',
				resolveAll: async () => ({}),
			};

			await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
				/directory|EISDIR/u,
			);
			expect(
				(await readdir(zone.gateway.stateDir)).filter((entryName) => entryName.includes('.tmp')),
			).toEqual([]);
		});

		it('throws the missing gateway token ref error directly', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-missing-ref-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			const configPath = path.join(configDirectory, 'openclaw.json');
			await writeFile(
				configPath,
				JSON.stringify({
					gateway: {
						auth: { mode: 'token' },
						bind: 'loopback',
					},
				}),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					config: configPath,
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
				withoutAuthProfilesRef: true,
			});
			const brokenZone = {
				...zone,
				secrets: {
					...zone.secrets,
					OPENCLAW_GATEWAY_TOKEN: {
						injection: 'env',
						audience: 'gateway',
						source: '1password',
					},
				},
			} as unknown as GatewayZoneConfig;
			const secretResolver: SecretResolver = {
				resolve: async () => {
					throw new Error('should not resolve');
				},
				resolveAll: async () => ({}),
			};

			await expect(
				openclawLifecycle.prepareHostState?.(brokenZone, secretResolver),
			).rejects.toThrow(/secret 'OPENCLAW_GATEWAY_TOKEN'.*(missing 'ref'|invalid shape)/u);
		});
	});
});
