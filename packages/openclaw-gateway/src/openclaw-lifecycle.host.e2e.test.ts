import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV,
	type GatewayZoneConfig,
} from '@agent-vm/gateway-lifecycle';
import type { SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openclawLifecycle, processSupervisorHelperTestInternals } from './openclaw-lifecycle.js';

const createdDirectories: string[] = [];
const execFileAsync = promisify(execFile);
type OpenClawGatewayConfig = Extract<GatewayZoneConfig['gateway'], { readonly type: 'openclaw' }>;
type InvalidFinalManagedGondolinConfigTestCase =
	| {
			readonly error: RegExp;
			readonly name: 'partial controlSession';
			readonly runtimeConfig: {
				readonly controlSession: {
					readonly bootId: string;
				};
			};
	  }
	| {
			readonly error: RegExp;
			readonly name: 'empty toolPortal';
			readonly runtimeConfig: {
				readonly toolPortal: Record<never, never>;
			};
	  };

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function runNodeHelperWithStdin(
	helperPath: string,
	stdin: string,
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
	const child = spawn(process.execPath, [helperPath], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	let stderr = '';
	let stdout = '';
	child.stderr.setEncoding('utf8');
	child.stdout.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stdin.end(stdin);
	const [exitCode] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
	return { exitCode: exitCode ?? -1, stderr, stdout };
}

async function renderBootstrapFiles(
	command: string,
	rootDirectory: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const rootedCommand = command
		.replaceAll('/root', path.join(rootDirectory, 'root'))
		.replaceAll('/etc/profile.d', path.join(rootDirectory, 'etc', 'profile.d'))
		.replaceAll('/run/openclaw', path.join(rootDirectory, 'run', 'openclaw'))
		.replaceAll('/usr/local/libexec', path.join(rootDirectory, 'usr', 'local', 'libexec'))
		.replaceAll('/work', path.join(rootDirectory, 'work'))
		.replace(`chown -R openclaw:openclaw ${path.join(rootDirectory, 'work')} && `, '');
	await execFileAsync('sh', ['-lc', rootedCommand], { env });
}

function shellQuoteForTest(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

async function captureThrownError(promise: Promise<unknown> | undefined): Promise<Error> {
	if (promise === undefined) {
		throw new Error('Expected lifecycle hook to be defined.');
	}
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	throw new Error('Expected promise to reject.');
}

async function captureThrownMessage(promise: Promise<unknown> | undefined): Promise<string> {
	return (await captureThrownError(promise)).message;
}

function aggregateChildMessages(error: Error): readonly string[] {
	return error instanceof AggregateError
		? error.errors.map((childError: unknown) =>
				childError instanceof Error ? childError.message : String(childError),
			)
		: [];
}

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
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
	readonly toolPortal?: GatewayZoneConfig['toolPortal'];
	readonly runtimeMcpServers?: GatewayZoneConfig['runtimeMcpServers'];
	readonly runtimeEnvironment?: GatewayZoneConfig['runtimeEnvironment'];
	readonly runtimeMediatedSecrets?: GatewayZoneConfig['runtimeMediatedSecrets'];
	readonly runtimePrivateEnvironment?: GatewayZoneConfig['runtimePrivateEnvironment'];
	readonly observability?: GatewayZoneConfig['observability'];
	readonly runtimePluginConfigs?: GatewayZoneConfig['runtimePluginConfigs'];
	readonly gitReadAllowlistRepos?: GatewayZoneConfig['gitReadAllowlistRepos'];
	readonly withoutAuthProfilesRef?: boolean;
	readonly secrets?: GatewayZoneConfig['secrets'];
	readonly websocketUpgrades?: GatewayZoneConfig['websocketUpgrades'];
}): GatewayZoneConfig {
	const baseGateway: OpenClawGatewayConfig = {
		controlAuth: {
			mode: 'token',
			secret: 'OPENCLAW_GATEWAY_TOKEN',
		},
		cpus: 2,
		config: '/host/config/shravan/openclaw.json',
		memory: '2G',
		port: 18791,
		rawEnvSecrets: ['DISCORD_BOT_TOKEN'],
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
		agents: [{ id: 'shravan' }],
		...(overrides?.toolPortal ? { toolPortal: overrides.toolPortal } : {}),
		...(overrides?.observability ? { observability: overrides.observability } : {}),
		secrets: overrides?.secrets ?? {
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
		...(overrides?.gitReadAllowlistRepos
			? { gitReadAllowlistRepos: overrides.gitReadAllowlistRepos }
			: {}),
		...(overrides?.runtimeEnvironment ? { runtimeEnvironment: overrides.runtimeEnvironment } : {}),
		...(overrides?.runtimeMediatedSecrets
			? { runtimeMediatedSecrets: overrides.runtimeMediatedSecrets }
			: {}),
		...(overrides?.runtimePrivateEnvironment
			? { runtimePrivateEnvironment: overrides.runtimePrivateEnvironment }
			: {}),
		...(overrides?.runtimePluginConfigs
			? { runtimePluginConfigs: overrides.runtimePluginConfigs }
			: {}),
		...(overrides?.runtimeMcpServers ? { runtimeMcpServers: overrides.runtimeMcpServers } : {}),
		websocketUpgrades: overrides?.websocketUpgrades ?? [],
	};
}

function createObservabilityConfig(): NonNullable<GatewayZoneConfig['observability']> {
	return {
		mode: 'collector',
		collector: {
			host: 'otel-collector.observability.vm.host',
			grpcPort: 4317,
			httpPort: 4318,
			targetHost: '127.0.0.1',
			targetGrpcPort: 24_317,
			targetHttpPort: 24_318,
		},
		openclaw: {
			serviceName: 'agent-vm-openclaw-shravan',
			traces: true,
			metrics: true,
			logs: true,
			sampleRate: 1,
			flushIntervalMs: 10_000,
			diagnosticsFlags: ['scheduler.debug'],
		},
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

		it('writes effective auth and SSH admin token files from the default gateway token secret', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-gateway-token-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify({ gateway: { bind: 'loopback' } }, null, 2),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					rawEnvSecrets: ['DISCORD_BOT_TOKEN'],
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/auth-profiles') {
						return '{"profiles":["main"]}';
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
			expect(JSON.parse(effectiveOpenClawConfigContent)).toMatchObject({
				gateway: {
					auth: {
						token: {
							id: 'OPENCLAW_GATEWAY_TOKEN',
							provider: 'default',
							source: 'env',
						},
					},
				},
			});

			const processSpec = openclawLifecycle.buildProcessSpec(zone, {
				OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
				DISCORD_BOT_TOKEN: 'discord-token',
			});
			await renderBootstrapFiles(processSpec.bootstrapCommand, tempDirectory, {
				...process.env,
				OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
				DISCORD_BOT_TOKEN: 'discord-token',
			});
			const gatewayTokenEnvFilePath = path.join(
				tempDirectory,
				'run',
				'openclaw',
				'gateway-token.env',
			);
			const tokenEnvFile = await readFile(gatewayTokenEnvFilePath, 'utf8');
			expect(tokenEnvFile).toContain('OPENCLAW_GATEWAY_TOKEN');
			expect(tokenEnvFile).not.toContain('DISCORD_BOT_TOKEN');
		});

		it('writes effective auth and SSH admin token files from the configured control auth secret', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-custom-gateway-token-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify({ gateway: { bind: 'loopback' } }, null, 2),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					controlAuth: {
						mode: 'token',
						secret: 'CUSTOM_GATEWAY_TOKEN',
					},
					rawEnvSecrets: [],
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
				secrets: {
					CUSTOM_GATEWAY_TOKEN: {
						injection: 'env',
						audience: 'gateway',
						source: '1password',
						ref: 'op://vault/item/custom-gateway-token',
					},
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/auth-profiles') {
						return '{"profiles":["main"]}';
					}
					if (secretRef.ref === 'op://vault/item/custom-gateway-token') {
						return 'resolved-custom-gateway-token';
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
			expect(JSON.parse(effectiveOpenClawConfigContent)).toMatchObject({
				gateway: {
					auth: {
						token: {
							id: 'CUSTOM_GATEWAY_TOKEN',
							provider: 'default',
							source: 'env',
						},
					},
				},
			});

			const processSpec = openclawLifecycle.buildProcessSpec(zone, {
				CUSTOM_GATEWAY_TOKEN: 'custom-gateway-token',
			});
			await renderBootstrapFiles(processSpec.bootstrapCommand, tempDirectory, {
				...process.env,
				CUSTOM_GATEWAY_TOKEN: 'custom-gateway-token',
			});
			const gatewayTokenEnvFilePath = path.join(
				tempDirectory,
				'run',
				'openclaw',
				'gateway-token.env',
			);
			const tokenEnvFile = await readFile(gatewayTokenEnvFilePath, 'utf8');
			expect(tokenEnvFile).toContain('CUSTOM_GATEWAY_TOKEN');
			expect(tokenEnvFile).not.toContain('OPENCLAW_GATEWAY_TOKEN');
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
					agentId: 'shravan',
				}),
			).toBe("openclaw models auth --agent 'shravan' login --provider 'openai-codex'");
			expect(
				openclawLifecycle.authConfig?.buildLoginCommand('openai-codex', {
					agentId: 'shravan',
					profileId: 'openai-codex:shravan@example.com',
				}),
			).toBe(
				"openclaw models auth --agent 'shravan' login --provider 'openai-codex' --profile-id 'openai-codex:shravan@example.com'",
			);
			expect(
				openclawLifecycle.authConfig?.buildLoginCommand('openai-codex', {
					agentId: 'shravan',
					deviceCode: true,
				}),
			).toBe(
				"openclaw models auth --agent 'shravan' login --provider 'openai-codex' --device-code",
			);
			expect(
				openclawLifecycle.authConfig?.buildProfileListCommand('openai-codex', {
					agentId: 'shravan',
				}),
			).toBe("openclaw models auth --agent 'shravan' list --provider 'openai-codex'");
		});

		it('shell-quotes provider values safely', () => {
			expect(
				openclawLifecycle.authConfig?.buildLoginCommand("codex'; touch /tmp/pwned; echo '"),
			).toBe("openclaw models auth login --provider 'codex'\\''; touch /tmp/pwned; echo '\\'''");
		});
	});

	describe('buildVmRequirements', () => {
		it('splits environment and mediated secrets', () => {
			const vmRequirements = openclawLifecycle.buildVmRequirements({
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
			expect(vmRequirements.mounts).not.toHaveProperty('/run/agent-vm/openclaw-process-supervisor');

			expect(vmRequirements.environment.DISCORD_BOT_TOKEN).toBe('discord-token');
			expect(vmRequirements.environment.OPENCLAW_GATEWAY_TOKEN).toBe("gateway'token");
			expect(vmRequirements.environment.PERPLEXITY_API_KEY).toBeUndefined();
			expect(vmRequirements.mediatedSecrets.PERPLEXITY_API_KEY).toEqual({
				hosts: ['api.perplexity.ai'],
				value: 'perplexity-token',
			});
		});

		it('rejects authored env secrets that are not explicit raw-env exceptions', () => {
			expect(() =>
				openclawLifecycle.buildVmRequirements({
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
						gateway: {
							rawEnvSecrets: [],
						},
					}),
				}),
			).toThrow(/DISCORD_BOT_TOKEN.*rawEnvSecrets/u);
		});

		it('rejects OPENCLAW_DIAGNOSTICS raw env overrides for observability-enabled zones', () => {
			const zone = createZone({
				gateway: {
					rawEnvSecrets: ['DISCORD_BOT_TOKEN', 'OPENCLAW_DIAGNOSTICS'],
				},
				observability: createObservabilityConfig(),
				secrets: {
					...createZone().secrets,
					OPENCLAW_DIAGNOSTICS: {
						injection: 'env',
						audience: 'gateway',
						source: 'environment',
						envVar: 'OPENCLAW_DIAGNOSTICS',
					},
				},
			});

			expect(() =>
				openclawLifecycle.buildVmRequirements({
					controllerPort: 18800,
					gatewayCacheDir: '/host/cache/gateways/shravan',
					projectNamespace: 'claw-tests-a1b2c3d4',
					resolvedSecrets: {
						...resolvedSecrets,
						OPENCLAW_DIAGNOSTICS: '*',
					},
					runtimeDir: '/host/runtime',
					tcpPool: {
						basePort: 19000,
						size: 3,
					},
					zone,
				}),
			).toThrow(/OPENCLAW_DIAGNOSTICS/u);
		});

		it('injects explicitly allowlisted runtime environment without mediating or persisting it', () => {
			const vmRequirements = openclawLifecycle.buildVmRequirements({
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
					gateway: {
						rawEnvSecrets: ['DISCORD_BOT_TOKEN', 'OPENCLAW_TEST_RUNTIME_SECRET'],
					},
					runtimeEnvironment: {
						OPENCLAW_TEST_RUNTIME_SECRET: 'runtime-test-secret',
					},
				}),
			});

			expect(vmRequirements.environment.OPENCLAW_TEST_RUNTIME_SECRET).toBe('runtime-test-secret');
			expect(vmRequirements.mediatedSecrets.OPENCLAW_TEST_RUNTIME_SECRET).toBeUndefined();
		});

		it('injects controller-owned private environment without runtime secret mediation', () => {
			const vmRequirements = openclawLifecycle.buildVmRequirements({
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
					runtimePrivateEnvironment: {
						[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV]: 'private-proof-key',
					},
				}),
			});

			expect(vmRequirements.environment[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV]).toBe(
				'private-proof-key',
			);
			expect(
				vmRequirements.mediatedSecrets[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV],
			).toBeUndefined();
		});

		it('rejects user runtime environment that collides with controller-owned private names', () => {
			expect(() =>
				openclawLifecycle.buildVmRequirements({
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
						gateway: {
							rawEnvSecrets: ['DISCORD_BOT_TOKEN', GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV],
						},
						runtimeEnvironment: {
							[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV]: 'user-proof-key',
						},
					}),
				}),
			).toThrow(/collides with a controller-owned private environment variable/u);
		});

		it('injects generated runtime mediated secrets without authored zone secret config entries', () => {
			const vmRequirements = openclawLifecycle.buildVmRequirements({
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
					runtimeMediatedSecrets: {
						AGENT_VM_MCP_TAVILY_API_KEY: {
							hosts: ['api.tavily.com'],
							value: 'runtime-tavily-token',
						},
					},
				}),
			});

			expect(vmRequirements.mediatedSecrets.AGENT_VM_MCP_TAVILY_API_KEY).toEqual({
				hosts: ['api.tavily.com'],
				value: 'runtime-tavily-token',
			});
			expect(vmRequirements.environment.AGENT_VM_MCP_TAVILY_API_KEY).toBeUndefined();
		});

		it('rejects generated runtime secrets that collide with authored zone secrets', () => {
			expect(() =>
				openclawLifecycle.buildVmRequirements({
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
						runtimeMediatedSecrets: {
							PERPLEXITY_API_KEY: {
								hosts: ['api.perplexity.ai'],
								value: 'runtime-perplexity-token',
							},
						},
					}),
				}),
			).toThrow(/PERPLEXITY_API_KEY.*authored http-mediation secret/u);
		});

		it('builds the expected OpenClaw environment, mounts, and tcp hosts', () => {
			vi.stubEnv('PATH', '/host-only/bin');
			const vmRequirements = openclawLifecycle.buildVmRequirements({
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

			expect(vmRequirements.environment.OPENCLAW_HOME).toBe('/home/openclaw');
			expect(vmRequirements.environment.OPENCLAW_CONFIG_PATH).toBe(
				'/home/openclaw/.openclaw/state/effective-openclaw.json',
			);
			expect(vmRequirements.environment.NODE_OPTIONS).toBe(
				'--dns-result-order=ipv4first --no-network-family-autoselection',
			);
			expect(vmRequirements.environment.OPENCLAW_PLUGIN_STAGE_DIR).toBeUndefined();
			expect(vmRequirements.environment.TMPDIR).toBe('/work/tmp');
			expect(vmRequirements.environment.PNPM_HOME).toBe('/pnpm');
			expect(vmRequirements.environment.PATH).toBe(
				'/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
			);
			expect(vmRequirements.environment.npm_config_cache).toBe('/work/cache/npm');
			// IPv4-preference egress for the Node OpenClaw process to defeat
			// Happy Eyeballs racing on gondolin's shared synthetic AAAA.
			// See FORCE_IPV4_EGRESS_NODE_OPTIONS in @agent-vm/gateway-lifecycle.
			expect(vmRequirements.environment.NODE_OPTIONS).toBe(
				'--dns-result-order=ipv4first --no-network-family-autoselection',
			);
			expect(vmRequirements.allowedHosts).toEqual(['api.openai.com', 'api.perplexity.ai']);
			expect(vmRequirements.mounts['/home/openclaw/.openclaw/config']).toEqual({
				hostPath: '/host/config/shravan',
				access: 'read-write',
				kind: 'host-directory',
			});
			expect(vmRequirements.mounts['/home/openclaw/.openclaw/cache']).toEqual({
				hostPath: '/host/cache/gateways/shravan',
				access: 'read-write',
				kind: 'host-directory',
			});
			expect(vmRequirements.mounts['/agent-vm/logs']).toEqual({
				hostPath: '/host/runtime/zones/shravan/logs',
				access: 'read-write',
				kind: 'host-directory',
			});
			expect(vmRequirements.mounts['/zone']).toEqual({
				hostPath: '/host/zone-files/shravan',
				access: 'read-write',
				kind: 'host-directory',
			});
			expect(vmRequirements.mounts['/work']).toBeUndefined();
			expect(vmRequirements.mounts['/home/openclaw/zone-files']).toBeUndefined();
			expect(vmRequirements.mounts['/home/openclaw/workspace']).toBeUndefined();
			expect(vmRequirements.mounts['/var/lib/openclaw/plugin-runtime-deps']).toBeUndefined();
			expect(vmRequirements.tcpHosts).toEqual({
				'tool-0.vm.host:22': '127.0.0.1:19000',
				'tool-1.vm.host:22': '127.0.0.1:19001',
			});
			expect(vmRequirements.sessionLabel).toBe('claw-tests-a1b2c3d4:shravan:gateway');
		});

		it('mounts managed Tool Portal effective config read-only when configured', () => {
			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				runtimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 2,
				},
				zone: createZone({
					runtimePluginConfigs: {
						gondolin: {
							toolPortal: {
								configDir: '/home/openclaw/.openclaw/cache/tool-portal-effective',
							},
						},
					},
				}),
			});

			expect(vmRequirements.mounts['/home/openclaw/.openclaw/cache/tool-portal-effective']).toEqual(
				{
					hostPath: '/host/cache/gateways/shravan/tool-portal-effective',
					access: 'read-only',
					kind: 'host-directory',
				},
			);
		});

		it('routes collector-mode observability through mediated HTTP instead of raw collector tcp hosts', () => {
			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				runtimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 2,
				},
				zone: createZone({
					observability: createObservabilityConfig(),
				}),
			});

			expect(vmRequirements.allowedHosts).toContain('otel-collector.observability.vm.host');
			expect(vmRequirements.tcpHosts).toEqual({
				'tool-0.vm.host:22': '127.0.0.1:19000',
				'tool-1.vm.host:22': '127.0.0.1:19001',
			});
		});

		it('carries websocket upgrade URL policy into the gateway VM spec', () => {
			const websocketUpgrades = [
				{
					audience: 'gateway' as const,
					scheme: 'wss' as const,
					host: 'gateway.discord.gg',
					port: 443,
					path: '/',
				},
				{
					audience: 'gateway' as const,
					scheme: 'wss' as const,
					host: 'gateway-*.discord.gg',
					port: 443,
					path: '/',
				},
			];

			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				runtimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 2,
				},
				zone: createZone({ websocketUpgrades }),
			});

			expect(vmRequirements.websocketUpgrades).toEqual(websocketUpgrades);
		});

		it('denies Git SSH reads when no trusted repo allowlist is available', async () => {
			vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent-vm-test-agent.sock');

			const vmRequirements = openclawLifecycle.buildVmRequirements({
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

			expect(vmRequirements.sshEgress).toBeUndefined();
		});

		it('allows only trusted Git SSH reads from the gateway VM spec', async () => {
			vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent-vm-test-agent.sock');

			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				runtimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 2,
				},
				zone: createZone({
					gitReadAllowlistRepos: ['ssh://git@git.example.com/shravan/zone-files.git'],
				}),
			});

			expect(vmRequirements.sshEgress).toEqual({
				agentSocket: '/tmp/agent-vm-test-agent.sock',
				allowedHosts: ['git.example.com'],
				allowedRepositories: ['shravan/zone-files'],
				kind: 'git-read-only',
			});
		});

		it('omits OpenClaw SSH egress when no host SSH agent is available', () => {
			vi.stubEnv('SSH_AUTH_SOCK', '');

			const vmRequirements = openclawLifecycle.buildVmRequirements({
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

			expect(vmRequirements.sshEgress).toBeUndefined();
		});

		it('preserves the forced IPv4-preference flags even when a zone secret supplies NODE_OPTIONS', () => {
			// Regression test for the merge-order bug surfaced in PR #93
			// review: a zone secret named NODE_OPTIONS must NOT drop our
			// forced flags, because Happy Eyeballs would race the
			// synthetic AAAA again.
			const baseZone = createZone({
				gateway: {
					rawEnvSecrets: ['DISCORD_BOT_TOKEN', 'NODE_OPTIONS'],
				},
			});
			const zoneWithNodeOptions: GatewayZoneConfig = {
				...baseZone,
				secrets: {
					...baseZone.secrets,
					NODE_OPTIONS: {
						injection: 'env',
						audience: 'gateway',
						source: 'environment',
						envVar: 'NODE_OPTIONS_OVERRIDE',
					},
				},
			};

			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets: {
					...resolvedSecrets,
					NODE_OPTIONS: '--inspect=0.0.0.0:9229',
				},
				runtimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 2,
				},
				zone: zoneWithNodeOptions,
			});

			// Forced flags lead; user value follows.
			expect(vmRequirements.environment.NODE_OPTIONS).toBe(
				'--dns-result-order=ipv4first --no-network-family-autoselection --inspect=0.0.0.0:9229',
			);
		});
	});

	describe('buildProcessSpec', () => {
		it('builds bootstrap and start commands with runtime-injected gateway token', () => {
			const processSpec = openclawLifecycle.buildProcessSpec(createZone(), resolvedSecrets);

			expect(processSpec.bootstrapCommand).toContain('/etc/profile.d/openclaw-env.sh');
			expect(processSpec.bootstrapCommand).toContain('/run/openclaw/secrets.env');
			expect(processSpec.bootstrapCommand).toContain("printf '%s\\n'");
			expect(processSpec.bootstrapCommand).toContain('DISCORD_BOT_TOKEN');
			expect(processSpec.bootstrapCommand).toContain('OPENCLAW_GATEWAY_TOKEN');
			expect(processSpec.bootstrapCommand).not.toContain('AGENT_VM_ZONE_GIT_TOKEN');
			expect(processSpec.bootstrapCommand).not.toContain('discord-token');
			expect(processSpec.bootstrapCommand).not.toContain("gateway'token");
			expect(processSpec.bootstrapCommand).not.toContain(
				`cat > /run/openclaw/secrets.env << 'ENVEOF'`,
			);
			expect(processSpec.bootstrapCommand).not.toContain('/etc/profile.d/openclaw-admin.sh');
			expect(processSpec.bootstrapCommand).not.toContain('/run/openclaw/gateway-auth.env');
			expect(processSpec.bootstrapCommand).not.toContain('openclaw()');
			expect(processSpec.bootstrapCommand).not.toContain('diagnostics-otel.tgz');
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
			expect(processSpec.bootstrapCommand).toContain('/etc/profile.d/openclaw-env.sh');
			expect(processSpec.bootstrapCommand).toContain('source /root/.bashrc');
			expect(processSpec.bootstrapCommand).toContain(
				'/usr/local/libexec/agent-vm-openclaw-process-supervisor',
			);
			expect(processSpec.startCommand).toContain(
				'gateway-supervisor: controller-owned helper ready; awaiting typed request',
			);
			expect(processSpec.startCommand).not.toContain('while true');
			expect(processSpec.startCommand).not.toContain('nohup');
			expect(processSpec.startCommand).not.toContain('openclaw gateway --port');
			expect(processSpec.healthCheck).toEqual({
				type: 'http',
				port: 18789,
				path: '/readyz',
			});
			expect(processSpec.logPath).toBe('/agent-vm/logs/gateway-boot-latest.log');
		});

		it('installs a fixed non-network helper without autonomously launching a process', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-process-supervisor-helper-'),
			);
			createdDirectories.push(tempDirectory);
			const processSpec = openclawLifecycle.buildProcessSpec(createZone(), resolvedSecrets);
			const encodedHelper =
				/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/usr\/local\/libexec\/agent-vm-openclaw-process-supervisor/u.exec(
					processSpec.bootstrapCommand,
				);
			expect(encodedHelper?.[1]).toBeDefined();
			const helperPath = path.join(tempDirectory, 'agent-vm-openclaw-process-supervisor');
			const helperSource = Buffer.from(encodedHelper?.[1] ?? '', 'base64').toString('utf8');
			await writeFile(helperPath, helperSource, 'utf8');
			await expect(execFileAsync(process.execPath, ['--check', helperPath])).resolves.toMatchObject(
				{
					stderr: '',
				},
			);
			expect(helperSource).toContain("refuse('process-overlap')");
			expect(helperSource).toContain("path.join(groupPath, 'cgroup.kill')");
			expect(helperSource).toContain("path.join(groupPath, 'cgroup.events')");
			expect(helperSource).toContain('const maximumAttempts = 500;');
			expect(helperSource).toContain('Atomics.wait(sleeper, 0, 0, 10);');
			expect(helperSource).toContain('rmdirSync(groupPath)');
			expect(helperSource).not.toContain('rmSync(groupPath, { recursive: false })');
			expect(helperSource).toContain('emptyObserved: true');
			expect(helperSource).toContain(
				`set -a; . /run/openclaw/secrets.env; set +a; cd /home/openclaw; exec /usr/local/bin/openclaw gateway --port 18789`,
			);
			expect(helperSource).not.toContain('exec su ');
			expect(processSpec.startCommand).not.toMatch(
				/(?:openclaw gateway|while true|restart_delay_seconds|nohup)/u,
			);
		});

		it.each([
			{
				failureStage: 'create-cgroup',
				injectionTarget: 'mkdirSync(groupPath, { mode: 0o700 });',
			},
			{
				failureStage: 'inspect-created-cgroup',
				injectionTarget: "if (populated(groupPath)) refuse('process-overlap');",
			},
		] as const)(
			'persists only the bounded $failureStage start marker when that pre-receipt stage fails',
			async ({ failureStage, injectionTarget }) => {
				const tempDirectory = await mkdtemp(
					path.join(os.tmpdir(), `openclaw-process-supervisor-${failureStage}-`),
				);
				createdDirectories.push(tempDirectory);
				const stateDirectory = path.join(tempDirectory, 'state');
				const cgroupRoot = path.join(tempDirectory, 'cgroup');
				const mountsPath = path.join(tempDirectory, 'mounts');
				const helperPath = path.join(tempDirectory, 'helper');
				const rawFailurePayload = `private-${failureStage}-failure:${tempDirectory}`;
				await Promise.all([
					mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
					mkdir(cgroupRoot, { recursive: true, mode: 0o700 }),
					writeFile(mountsPath, `none ${cgroupRoot} cgroup2 rw 0 0\n`, 'utf8'),
				]);
				const helperSource = processSupervisorHelperTestInternals
					.buildOpenClawProcessSupervisorHelperSource()
					.replaceAll('/run/agent-vm/openclaw-process-supervisor', stateDirectory)
					.replaceAll('/sys/fs/cgroup', cgroupRoot)
					.replaceAll('/proc/mounts', mountsPath);
				for (const expectedStage of [
					'ensure-cgroup2',
					'create-cgroup',
					'inspect-created-cgroup',
					'bind-process',
				]) {
					expect(helperSource.split(`recordOperationStage('${expectedStage}')`)).toHaveLength(2);
				}
				const injectedHelperSource = helperSource.replace(
					injectionTarget,
					`throw new Error(${JSON.stringify(rawFailurePayload)});`,
				);
				expect(injectedHelperSource).not.toBe(helperSource);
				await writeFile(helperPath, injectedHelperSource, 'utf8');
				const request = {
					actionId: `action-fail-${failureStage}`,
					contractVersion: 1,
					expectedProcessEpoch: null,
					gateway: {
						controllerEpoch: 'controller-1',
						gatewayEpochId: 'gateway-epoch-1',
						gatewayVmId: 'gateway-vm-1',
					},
					kind: 'start',
					selectedProcessEpoch: 'process-1',
				};

				const outcome = await runNodeHelperWithStdin(helperPath, `${JSON.stringify(request)}\n`);
				expect(outcome).toMatchObject({
					stderr: `agent-vm-process-supervisor-failure:${failureStage}\n`,
				});
				expect((outcome as { readonly stderr: string }).stderr).not.toContain(rawFailurePayload);
				expect((outcome as { readonly stderr: string }).stderr).not.toContain(tempDirectory);
				const persistedStateContent = await readFile(
					path.join(stateDirectory, 'state-v1.json'),
					'utf8',
				);
				expect(JSON.parse(persistedStateContent)).toMatchObject({
					lastOperation: {
						actionId: `action-fail-${failureStage}`,
						kind: 'start',
						stage: failureStage,
					},
				});
				expect(persistedStateContent).not.toContain(rawFailurePayload);
				expect(persistedStateContent).not.toContain(tempDirectory);
				expect(
					JSON.parse(await readFile(path.join(stateDirectory, 'request-v1.json'), 'utf8')),
				).toEqual(request);
			},
		);

		it('reads one exact stdin request and persists the guest audit before acting', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-process-supervisor-request-stdin-'),
			);
			createdDirectories.push(tempDirectory);
			const stateDirectory = path.join(tempDirectory, 'state');
			const cgroupRoot = path.join(tempDirectory, 'cgroup');
			const mountsPath = path.join(tempDirectory, 'mounts');
			const helperPath = path.join(tempDirectory, 'helper');
			await Promise.all([
				mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
				mkdir(cgroupRoot, { recursive: true, mode: 0o700 }),
				writeFile(mountsPath, `none ${cgroupRoot} cgroup2 rw 0 0\n`, 'utf8'),
			]);
			const helperSource = processSupervisorHelperTestInternals
				.buildOpenClawProcessSupervisorHelperSource()
				.replaceAll('/run/agent-vm/openclaw-process-supervisor', stateDirectory)
				.replaceAll('/sys/fs/cgroup', cgroupRoot)
				.replaceAll('/proc/mounts', mountsPath);
			await writeFile(helperPath, helperSource, 'utf8');
			const request = {
				actionId: 'action-stdin-request',
				contractVersion: 1,
				expectedProcessEpoch: null,
				gateway: {
					controllerEpoch: 'controller-1',
					gatewayEpochId: 'gateway-epoch-1',
					gatewayVmId: 'gateway-vm-1',
				},
				kind: 'observe',
			};
			const serializedRequest = `${JSON.stringify(request)}\n`;

			await expect(runNodeHelperWithStdin(helperPath, serializedRequest)).resolves.toMatchObject({
				exitCode: 0,
				stderr: '',
			});
			expect(await readFile(path.join(stateDirectory, 'request-v1.json'), 'utf8')).toBe(
				serializedRequest,
			);
			expect(
				JSON.parse(await readFile(path.join(stateDirectory, 'receipt-v1.json'), 'utf8')),
			).toMatchObject({
				actionId: 'action-stdin-request',
				expectedProcessEpoch: null,
				kind: 'observe',
				observedProcessEpoch: null,
				status: 'completed',
			});
		});

		it('bounds invalid stdin without persisting an audit or performing an action', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-process-supervisor-request-read-invalid-'),
			);
			createdDirectories.push(tempDirectory);
			const stateDirectory = path.join(tempDirectory, 'state');
			const cgroupRoot = path.join(tempDirectory, 'cgroup');
			const mountsPath = path.join(tempDirectory, 'mounts');
			const helperPath = path.join(tempDirectory, 'helper');
			await Promise.all([
				mkdir(stateDirectory, { recursive: true, mode: 0o700 }),
				mkdir(cgroupRoot, { recursive: true, mode: 0o700 }),
				writeFile(mountsPath, `none ${cgroupRoot} cgroup2 rw 0 0\n`, 'utf8'),
			]);
			const helperSource = processSupervisorHelperTestInternals
				.buildOpenClawProcessSupervisorHelperSource()
				.replaceAll('/run/agent-vm/openclaw-process-supervisor', stateDirectory)
				.replaceAll('/sys/fs/cgroup', cgroupRoot)
				.replaceAll('/proc/mounts', mountsPath);
			await writeFile(helperPath, helperSource, 'utf8');

			const outcome = await runNodeHelperWithStdin(helperPath, '{"contractVersion":');
			expect(outcome).toMatchObject({
				stderr: 'agent-vm-process-supervisor-failure:parse-request-json\n',
			});
			expect((outcome as { readonly stderr: string }).stderr).not.toContain(
				'Unexpected end of JSON input',
			);
			expect((outcome as { readonly stderr: string }).stderr).not.toContain(tempDirectory);
			expect(outcome.exitCode).not.toBe(0);
			expect(await pathExists(path.join(stateDirectory, 'request-v1.json'))).toBe(false);
			expect(await pathExists(path.join(stateDirectory, 'state-v1.json'))).toBe(false);
			expect(await pathExists(path.join(stateDirectory, 'receipt-v1.json'))).toBe(false);
			expect(await readdir(cgroupRoot)).toEqual([]);
		});

		it('executes the generated helper through start, reliability termination, containment, and successor start', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-process-supervisor-behavior-'),
			);
			createdDirectories.push(tempDirectory);
			const stateDirectory = path.join(tempDirectory, 'state');
			const cgroupRoot = path.join(tempDirectory, 'cgroup');
			const mountsPath = path.join(tempDirectory, 'mounts');
			const helperPath = path.join(tempDirectory, 'helper');
			const watcherPath = path.join(tempDirectory, 'fixture-cgroup-watcher.mjs');
			const watcherModePath = path.join(tempDirectory, 'fixture-cgroup-mode');
			const cgroupRemovalMarkerPath = path.join(tempDirectory, 'fixture-cgroup-removed');
			const bootLogPath = path.join(tempDirectory, 'gateway.log');
			const gateway = {
				controllerEpoch: 'controller-1',
				gatewayEpochId: 'gateway-epoch-1',
				gatewayVmId: 'gateway-vm-1',
			} as const;
			const processEpoch = 'process-1';
			const successorProcessEpoch = 'process-2';
			const cgroupName = `agent-vm-${createHash('sha256')
				.update(`${gateway.gatewayEpochId}\0${processEpoch}`)
				.digest('hex')
				.slice(0, 24)}`;
			const successorCgroupName = `agent-vm-${createHash('sha256')
				.update(`${gateway.gatewayEpochId}\0${successorProcessEpoch}`)
				.digest('hex')
				.slice(0, 24)}`;
			const cgroupPath = path.join(cgroupRoot, cgroupName);
			const successorCgroupPath = path.join(cgroupRoot, successorCgroupName);
			await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
			await Promise.all(
				[cgroupPath, successorCgroupPath].map(async (fixtureCgroupPath) => {
					await mkdir(fixtureCgroupPath, { recursive: true, mode: 0o700 });
					await Promise.all([
						writeFile(path.join(fixtureCgroupPath, 'cgroup.events'), 'populated 0\n', 'utf8'),
						writeFile(path.join(fixtureCgroupPath, 'cgroup.kill'), '', 'utf8'),
						writeFile(path.join(fixtureCgroupPath, 'cgroup.procs'), '', 'utf8'),
					]);
				}),
			);
			await writeFile(watcherModePath, 'normal', 'utf8');
			await writeFile(mountsPath, `none ${cgroupRoot} cgroup2 rw 0 0\n`, 'utf8');
			const helperSource = processSupervisorHelperTestInternals
				.buildOpenClawProcessSupervisorHelperSource()
				.replaceAll('/run/agent-vm/openclaw-process-supervisor', stateDirectory)
				.replaceAll('/sys/fs/cgroup', cgroupRoot)
				.replaceAll('/proc/mounts', mountsPath)
				.replaceAll('/agent-vm/logs/gateway-boot-latest.log', bootLogPath)
				.replace(
					'mkdirSync(groupPath, { mode: 0o700 });',
					'mkdirSync(groupPath, { mode: 0o700, recursive: true });',
				)
				.replace(
					'rmdirSync(groupPath);',
					"writeFileSync(path.join(groupPath, 'cgroup.kill'), ''); writeFileSync(path.join(groupPath, 'cgroup.procs'), '');",
				);
			await writeFile(
				watcherPath,
				`import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
const groupPaths = ${JSON.stringify([cgroupPath, successorCgroupPath])};
const modePath = ${JSON.stringify(watcherModePath)};
const cgroupWatches = groupPaths.flatMap((groupPath) => {
  const processPath = groupPath + '/cgroup.procs';
  const killPath = groupPath + '/cgroup.kill';
  const eventsPath = groupPath + '/cgroup.events';
  return [
    watch(processPath, () => {
      if (readFileSync(modePath, 'utf8').trim() === 'ignore-membership') return;
      const pid = Number.parseInt(readFileSync(processPath, 'utf8').trim(), 10);
      if (Number.isInteger(pid)) writeFileSync(eventsPath, 'populated 1\\n');
    }),
    watch(killPath, () => {
      if (readFileSync(modePath, 'utf8').trim() === 'ignore-kill') return;
      if (!existsSync(killPath) || readFileSync(killPath, 'utf8').trim() !== '1') return;
      const pid = Number.parseInt(readFileSync(processPath, 'utf8').trim(), 10);
      if (Number.isInteger(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
      writeFileSync(eventsPath, 'populated 0\\n');
    }),
  ];
});
process.stdout.write('ready\\n');
await new Promise((resolve) => process.once('SIGTERM', resolve));
for (const cgroupWatch of cgroupWatches) cgroupWatch.close();
`,
				'utf8',
			);
			const watcher = spawn(process.execPath, [watcherPath], {
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			try {
				await once(watcher.stdout, 'data');
				const invoke = async (
					request: Record<string, unknown>,
				): Promise<{
					readonly outcome: {
						readonly exitCode: number;
						readonly stderr: string;
						readonly stdout: string;
					};
					readonly receipt: unknown;
				}> => {
					await rm(path.join(stateDirectory, 'receipt-v1.json'), { force: true });
					const outcome = await runNodeHelperWithStdin(helperPath, `${JSON.stringify(request)}\n`);
					const receiptContent = await readFile(
						path.join(stateDirectory, 'receipt-v1.json'),
						'utf8',
					).catch((error: unknown) => {
						throw new Error(`Helper produced no receipt: ${JSON.stringify(outcome)}`, {
							cause: error,
						});
					});
					return {
						outcome,
						receipt: JSON.parse(receiptContent) as unknown,
					};
				};
				const startRequest = {
					actionId: 'action-a',
					contractVersion: 1,
					expectedProcessEpoch: null,
					gateway,
					kind: 'start',
					selectedProcessEpoch: processEpoch,
				};
				const interruptedHelperSource = helperSource.replace(
					"if (!waitForPopulation(groupPath, true)) throw new Error('cgroup-membership-unproven');",
					"if (!waitForPopulation(groupPath, true)) throw new Error('cgroup-membership-unproven'); throw new Error('injected-after-launch-interruption');",
				);
				expect(interruptedHelperSource).not.toBe(helperSource);
				await writeFile(helperPath, interruptedHelperSource, 'utf8');
				const interruptedStart = await invoke({
					...startRequest,
					actionId: 'action-interrupted-start',
				});
				expect(interruptedStart).toMatchObject({
					outcome: { exitCode: 2 },
					receipt: {
						actionId: 'action-interrupted-start',
						cgroup: { name: cgroupName, populated: true },
						observedProcessEpoch: processEpoch,
						reason: 'helper-failed',
						status: 'incomplete',
					},
				});
				await writeFile(helperPath, helperSource, 'utf8');
				await expect(
					invoke({
						actionId: 'action-interrupted-observe',
						contractVersion: 1,
						expectedProcessEpoch: processEpoch,
						gateway,
						kind: 'observe',
					}),
				).resolves.toMatchObject({
					receipt: {
						cgroup: { name: cgroupName },
						observedProcessEpoch: processEpoch,
					},
				});
				await expect(
					invoke({
						actionId: 'action-interrupted-contain',
						contractVersion: 1,
						expectedProcessEpoch: processEpoch,
						gateway,
						kind: 'contain',
					}),
				).resolves.toMatchObject({
					receipt: {
						cgroup: { emptyObserved: true, name: cgroupName, populated: false },
						observedProcessEpoch: processEpoch,
						status: 'completed',
					},
				});
				await writeFile(watcherModePath, 'ignore-membership', 'utf8');
				const membershipFailed = await invoke({
					...startRequest,
					actionId: 'action-membership-failed-start',
				});
				expect(membershipFailed).toMatchObject({
					outcome: { exitCode: 2 },
					receipt: {
						actionId: 'action-membership-failed-start',
						cgroup: { name: cgroupName, populated: false },
						observedProcessEpoch: processEpoch,
						reason: 'cgroup-unavailable',
						status: 'incomplete',
					},
				});
				await expect(
					invoke({
						actionId: 'action-membership-failed-observe',
						contractVersion: 1,
						expectedProcessEpoch: processEpoch,
						gateway,
						kind: 'observe',
					}),
				).resolves.toMatchObject({
					receipt: {
						cgroup: { name: cgroupName, populated: false },
						observedProcessEpoch: processEpoch,
					},
				});
				await expect(
					invoke({
						actionId: 'action-membership-failed-contain',
						contractVersion: 1,
						expectedProcessEpoch: processEpoch,
						gateway,
						kind: 'contain',
					}),
				).resolves.toMatchObject({
					receipt: {
						cgroup: { emptyObserved: true, name: cgroupName, populated: false },
						observedProcessEpoch: processEpoch,
						status: 'completed',
					},
				});
				await writeFile(watcherModePath, 'normal', 'utf8');
				const started = await invoke(startRequest);
				expect(started).toMatchObject({
					outcome: { exitCode: 0 },
					receipt: {
						actionId: 'action-a',
						cgroup: { name: cgroupName, populated: true },
						observedProcessEpoch: processEpoch,
						status: 'completed',
					},
				});
				await expect(invoke(startRequest)).resolves.toEqual(started);
				await expect(
					invoke({
						...startRequest,
						actionId: 'action-interrupted-start',
						selectedProcessEpoch: 'process-changed-after-interruption',
					}),
				).resolves.toMatchObject({
					outcome: { exitCode: 2 },
					receipt: {
						actionId: 'action-interrupted-start',
						reason: 'action-reused',
						status: 'refused',
					},
				});
				const changedActionA = await invoke({
					...startRequest,
					selectedProcessEpoch: 'process-changed',
				});
				expect(changedActionA).toMatchObject({
					outcome: { exitCode: 2 },
					receipt: { actionId: 'action-a', reason: 'action-reused', status: 'refused' },
				});
				const observed = await invoke({
					actionId: 'action-b',
					contractVersion: 1,
					expectedProcessEpoch: processEpoch,
					gateway,
					kind: 'observe',
				});
				expect(observed).toMatchObject({
					outcome: { exitCode: 0 },
					receipt: { observedProcessEpoch: processEpoch, status: 'completed' },
				});
				await expect(
					invoke({ ...startRequest, selectedProcessEpoch: 'process-changed-after-b' }),
				).resolves.toMatchObject({
					outcome: { exitCode: 2 },
					receipt: { actionId: 'action-a', reason: 'action-reused' },
				});
				const unavailableContainHelperSource = helperSource.replace(
					"if (!existsSync(path.join(groupPath, 'cgroup.kill'))) throw new Error('cgroup-kill-unavailable');",
					"throw new Error('cgroup-kill-unavailable');",
				);
				expect(unavailableContainHelperSource).not.toBe(helperSource);
				await writeFile(helperPath, unavailableContainHelperSource, 'utf8');
				await expect(
					invoke({
						actionId: 'action-contain-unavailable',
						contractVersion: 1,
						expectedProcessEpoch: processEpoch,
						gateway,
						kind: 'contain',
					}),
				).resolves.toMatchObject({
					outcome: { exitCode: 2 },
					receipt: {
						actionId: 'action-contain-unavailable',
						cgroup: { name: cgroupName, populated: true },
						observedProcessEpoch: processEpoch,
						reason: 'cgroup-unavailable',
						status: 'incomplete',
					},
				});
				await writeFile(helperPath, helperSource, 'utf8');
				await writeFile(watcherModePath, 'ignore-kill', 'utf8');
				await expect(
					invoke({
						actionId: 'action-contain-still-populated',
						contractVersion: 1,
						expectedProcessEpoch: processEpoch,
						gateway,
						kind: 'contain',
					}),
				).resolves.toMatchObject({
					outcome: { exitCode: 2 },
					receipt: {
						actionId: 'action-contain-still-populated',
						cgroup: { name: cgroupName, populated: true },
						observedProcessEpoch: processEpoch,
						reason: 'cgroup-empty-unproven',
						status: 'incomplete',
					},
				});
				await writeFile(path.join(cgroupPath, 'cgroup.kill'), '', 'utf8');
				await writeFile(watcherModePath, 'normal', 'utf8');
				await writeFile(path.join(stateDirectory, 'operation.lock'), 'stale', 'utf8');
				await expect(
					runNodeHelperWithStdin(helperPath, `${JSON.stringify(startRequest)}\n`),
				).resolves.toMatchObject({ exitCode: 73 });
				await rm(path.join(stateDirectory, 'operation.lock'), { force: true });
				await expect(
					invoke({
						actionId: 'action-reliability-terminate-wrong-process',
						contractVersion: 1,
						expectedProcessEpoch: 'process-wrong',
						gateway,
						kind: 'terminate-for-reliability-test',
					}),
				).resolves.toMatchObject({
					outcome: { exitCode: 2 },
					receipt: {
						cgroup: { name: cgroupName, populated: true },
						observedProcessEpoch: processEpoch,
						reason: 'process-fence-mismatch',
						status: 'refused',
					},
				});
				const reliabilityTerminationRequest = {
					actionId: 'action-reliability-terminate',
					contractVersion: 1,
					expectedProcessEpoch: processEpoch,
					gateway,
					kind: 'terminate-for-reliability-test',
				};
				const reliabilityTermination = await invoke(reliabilityTerminationRequest);
				expect(reliabilityTermination).toMatchObject({
					outcome: { exitCode: 0 },
					receipt: {
						cgroup: { emptyObserved: true, name: cgroupName, populated: false },
						observedProcessEpoch: processEpoch,
						status: 'completed',
					},
				});
				await expect(invoke(reliabilityTerminationRequest)).resolves.toEqual(
					reliabilityTermination,
				);
				await expect(
					invoke({
						...reliabilityTerminationRequest,
						expectedProcessEpoch: 'process-changed',
					}),
				).resolves.toMatchObject({
					outcome: { exitCode: 2 },
					receipt: {
						actionId: 'action-reliability-terminate',
						reason: 'action-reused',
						status: 'refused',
					},
				});
				await expect(
					invoke({
						actionId: 'action-observe-empty-bound-process',
						contractVersion: 1,
						expectedProcessEpoch: processEpoch,
						gateway,
						kind: 'observe',
					}),
				).resolves.toMatchObject({
					outcome: { exitCode: 0 },
					receipt: {
						cgroup: { name: cgroupName, populated: false },
						observedProcessEpoch: processEpoch,
						status: 'completed',
					},
				});
				expect(
					JSON.parse(await readFile(path.join(stateDirectory, 'state-v1.json'), 'utf8')),
				).toMatchObject({
					cgroupName,
					currentProcessEpoch: processEpoch,
					status: 'exited',
				});
				const removeFixtureCgroupHelperSource = helperSource.replace(
					"writeFileSync(path.join(groupPath, 'cgroup.kill'), ''); writeFileSync(path.join(groupPath, 'cgroup.procs'), '');",
					`writeFileSync(${JSON.stringify(cgroupRemovalMarkerPath)}, groupPath); writeFileSync(path.join(groupPath, 'cgroup.kill'), ''); writeFileSync(path.join(groupPath, 'cgroup.procs'), '');`,
				);
				expect(removeFixtureCgroupHelperSource).not.toBe(helperSource);
				await rm(path.join(cgroupPath, 'cgroup.kill'));
				await writeFile(helperPath, removeFixtureCgroupHelperSource, 'utf8');
				const contained = await invoke({
					actionId: 'action-c',
					contractVersion: 1,
					expectedProcessEpoch: processEpoch,
					gateway,
					kind: 'contain',
				});
				expect(contained).toMatchObject({
					outcome: { exitCode: 0 },
					receipt: {
						cgroup: { emptyObserved: true, name: cgroupName, populated: false },
						observedProcessEpoch: processEpoch,
						status: 'completed',
					},
				});
				expect(await readFile(cgroupRemovalMarkerPath, 'utf8')).toBe(cgroupPath);
				expect(
					JSON.parse(await readFile(path.join(stateDirectory, 'state-v1.json'), 'utf8')),
				).toMatchObject({
					cgroupName: null,
					currentProcessEpoch: null,
					status: 'contained',
				});
				await writeFile(helperPath, helperSource, 'utf8');
				const successorStarted = await invoke({
					actionId: 'action-start-successor',
					contractVersion: 1,
					expectedProcessEpoch: null,
					gateway,
					kind: 'start',
					selectedProcessEpoch: successorProcessEpoch,
				});
				expect(successorStarted).toMatchObject({
					outcome: { exitCode: 0 },
					receipt: {
						cgroup: { name: successorCgroupName, populated: true },
						observedProcessEpoch: successorProcessEpoch,
						status: 'completed',
					},
				});
				await expect(
					invoke({
						actionId: 'action-reliability-terminate-successor',
						contractVersion: 1,
						expectedProcessEpoch: successorProcessEpoch,
						gateway,
						kind: 'terminate-for-reliability-test',
					}),
				).resolves.toMatchObject({
					outcome: { exitCode: 0 },
					receipt: {
						cgroup: { emptyObserved: true, name: successorCgroupName, populated: false },
						observedProcessEpoch: successorProcessEpoch,
						status: 'completed',
					},
				});
				await rm(successorCgroupPath, { recursive: true });
				await writeFile(helperPath, removeFixtureCgroupHelperSource, 'utf8');
				await expect(
					invoke({
						actionId: 'action-contain-already-absent',
						contractVersion: 1,
						expectedProcessEpoch: successorProcessEpoch,
						gateway,
						kind: 'contain',
					}),
				).resolves.toMatchObject({
					outcome: { exitCode: 0 },
					receipt: {
						cgroup: { emptyObserved: true, name: successorCgroupName, populated: false },
						observedProcessEpoch: successorProcessEpoch,
						status: 'completed',
					},
				});
				expect(
					JSON.parse(await readFile(path.join(stateDirectory, 'state-v1.json'), 'utf8')),
				).toMatchObject({
					cgroupName: null,
					currentProcessEpoch: null,
					status: 'contained',
				});
				const unprovenAbsentProcessEpoch = 'process-unproven-absent';
				const unprovenAbsentCgroupName = 'agent-vm-unproven-absent';
				const containedState = JSON.parse(
					await readFile(path.join(stateDirectory, 'state-v1.json'), 'utf8'),
				) as Record<string, unknown>;
				await writeFile(
					path.join(stateDirectory, 'state-v1.json'),
					`${JSON.stringify({
						...containedState,
						cgroupName: unprovenAbsentCgroupName,
						currentProcessEpoch: unprovenAbsentProcessEpoch,
						status: 'running',
					})}\n`,
					'utf8',
				);
				await expect(
					invoke({
						actionId: 'action-contain-unproven-absent',
						contractVersion: 1,
						expectedProcessEpoch: unprovenAbsentProcessEpoch,
						gateway,
						kind: 'contain',
					}),
				).resolves.toMatchObject({
					outcome: { exitCode: 2 },
					receipt: {
						cgroup: { name: unprovenAbsentCgroupName, populated: false },
						observedProcessEpoch: unprovenAbsentProcessEpoch,
						reason: 'cgroup-unavailable',
						status: 'incomplete',
					},
				});
				expect(
					JSON.parse(await readFile(path.join(stateDirectory, 'state-v1.json'), 'utf8')),
				).toMatchObject({
					cgroupName: unprovenAbsentCgroupName,
					currentProcessEpoch: unprovenAbsentProcessEpoch,
					status: 'running',
				});
				const state = JSON.parse(
					await readFile(path.join(stateDirectory, 'state-v1.json'), 'utf8'),
				) as { actionOrder: string[]; actions: Record<string, unknown> };
				expect(state.actionOrder).toEqual([
					'action-interrupted-start',
					'action-interrupted-observe',
					'action-interrupted-contain',
					'action-membership-failed-start',
					'action-membership-failed-observe',
					'action-membership-failed-contain',
					'action-a',
					'action-b',
					'action-contain-unavailable',
					'action-contain-still-populated',
					'action-reliability-terminate-wrong-process',
					'action-reliability-terminate',
					'action-observe-empty-bound-process',
					'action-c',
					'action-start-successor',
					'action-reliability-terminate-successor',
					'action-contain-already-absent',
					'action-contain-unproven-absent',
				]);
				expect(Object.keys(state.actions)).toEqual(state.actionOrder);
			} finally {
				if (watcher.exitCode === null && watcher.signalCode === null) {
					watcher.kill('SIGKILL');
					await once(watcher, 'exit').catch(() => undefined);
				}
			}
		}, 60_000);

		it('refreshes the managed diagnostics-otel registry before observable gateway startup', () => {
			const processSpec = openclawLifecycle.buildProcessSpec(
				createZone({
					observability: createObservabilityConfig(),
				}),
				resolvedSecrets,
			);

			expect(processSpec.bootstrapCommand).toContain('openclaw plugins registry --refresh');
			expect(processSpec.bootstrapCommand).not.toContain('node -e');
			expect(processSpec.bootstrapCommand).not.toContain('const pluginId');
			expect(processSpec.bootstrapCommand).not.toContain('installRecords');
			expect(processSpec.bootstrapCommand).not.toContain(
				'/home/openclaw/.openclaw/state/plugins/installs.json',
			);
			expect(processSpec.bootstrapCommand).not.toContain('npm-pack');
			expect(processSpec.bootstrapCommand).not.toContain('openclaw plugins install');
		});

		it('rejects control bytes in env-injected secrets before building the bootstrap command', () => {
			for (const secretValue of [
				'gateway\nENVEOF\ncommand',
				'gateway\rcommand',
				`gateway${String.fromCharCode(0)}command`,
				`gateway${String.fromCharCode(7)}command`,
			]) {
				expect(() =>
					openclawLifecycle.buildProcessSpec(createZone(), {
						...resolvedSecrets,
						OPENCLAW_GATEWAY_TOKEN: secretValue,
					}),
				).toThrow(/single-line value without control bytes/u);
			}
		});

		it('rejects unallowlisted authored env secrets before building the bootstrap command', () => {
			expect(() =>
				openclawLifecycle.buildProcessSpec(
					createZone({
						gateway: {
							rawEnvSecrets: [],
						},
					}),
					resolvedSecrets,
				),
			).toThrow(/DISCORD_BOT_TOKEN.*rawEnvSecrets/u);
		});

		it('renders an empty runtime secrets file when no env secrets are resolved', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-bootstrap-empty-'));
			createdDirectories.push(tempDirectory);
			const processSpec = openclawLifecycle.buildProcessSpec(createZone(), {});

			await renderBootstrapFiles(processSpec.bootstrapCommand, tempDirectory, {
				...process.env,
				DISCORD_BOT_TOKEN: resolvedSecrets.DISCORD_BOT_TOKEN,
				OPENCLAW_GATEWAY_TOKEN: resolvedSecrets.OPENCLAW_GATEWAY_TOKEN,
			});

			await expect(
				readFile(path.join(tempDirectory, 'run', 'openclaw', 'secrets.env'), 'utf8'),
			).resolves.toBe('');
		});

		it('round-trips shell-sensitive env secrets through the generated secrets file', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-bootstrap-secrets-'));
			createdDirectories.push(tempDirectory);
			const gatewayToken = "gateway' $ ` token";
			const discordToken = "discord' $ ` token";
			const processSpec = openclawLifecycle.buildProcessSpec(createZone(), {
				...resolvedSecrets,
				DISCORD_BOT_TOKEN: discordToken,
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
			});

			expect(processSpec.bootstrapCommand).not.toContain(gatewayToken);
			expect(processSpec.bootstrapCommand).not.toContain(discordToken);
			await renderBootstrapFiles(processSpec.bootstrapCommand, tempDirectory, {
				...process.env,
				DISCORD_BOT_TOKEN: discordToken,
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
			});

			const secretsFilePath = path.join(tempDirectory, 'run', 'openclaw', 'secrets.env');
			const { stdout } = await execFileAsync(
				'bash',
				[
					'-lc',
					`set -eu; . ${shellQuoteForTest(secretsFilePath)}; printf '%s\\n%s' "$OPENCLAW_GATEWAY_TOKEN" "$DISCORD_BOT_TOKEN"`,
				],
				{
					env: {
						PATH: process.env.PATH,
					},
				},
			);

			expect(stdout).toBe(`${gatewayToken}\n${discordToken}`);
		});

		it('writes a token-only admin env file without requiring other raw gateway secrets for SSH', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-bootstrap-admin-token-'),
			);
			createdDirectories.push(tempDirectory);
			const gatewayToken = "gateway' $ ` token";
			const discordToken = "discord' $ ` token";
			const processSpec = openclawLifecycle.buildProcessSpec(createZone(), {
				...resolvedSecrets,
				DISCORD_BOT_TOKEN: discordToken,
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
			});

			await renderBootstrapFiles(processSpec.bootstrapCommand, tempDirectory, {
				...process.env,
				DISCORD_BOT_TOKEN: discordToken,
				OPENCLAW_GATEWAY_TOKEN: gatewayToken,
			});

			const gatewayTokenEnvFilePath = path.join(
				tempDirectory,
				'run',
				'openclaw',
				'gateway-token.env',
			);
			const tokenEnvFile = await readFile(gatewayTokenEnvFilePath, 'utf8');
			expect(tokenEnvFile).toContain('OPENCLAW_GATEWAY_TOKEN');
			expect(tokenEnvFile).not.toContain('DISCORD_BOT_TOKEN');
			expect(tokenEnvFile).not.toContain(discordToken);
			const { stdout } = await execFileAsync(
				'bash',
				[
					'-lc',
					`set -eu; . ${shellQuoteForTest(gatewayTokenEnvFilePath)}; printf '%s' "$OPENCLAW_GATEWAY_TOKEN"`,
				],
				{ env: { PATH: process.env.PATH } },
			);

			expect(stdout).toBe(gatewayToken);
		});

		it('writes profile scripts without expanding runtime shell expressions', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-bootstrap-'));
			createdDirectories.push(tempDirectory);
			const processSpec = openclawLifecycle.buildProcessSpec(createZone(), resolvedSecrets);

			await renderBootstrapFiles(processSpec.bootstrapCommand, tempDirectory, {
				...process.env,
				DISCORD_BOT_TOKEN: resolvedSecrets.DISCORD_BOT_TOKEN,
				OPENCLAW_GATEWAY_TOKEN: resolvedSecrets.OPENCLAW_GATEWAY_TOKEN,
			});

			const environmentShellScript = await readFile(
				path.join(tempDirectory, 'etc', 'profile.d', 'openclaw-env.sh'),
				'utf8',
			);
			await expect(
				readFile(path.join(tempDirectory, 'etc', 'profile.d', 'openclaw-admin.sh'), 'utf8'),
			).rejects.toThrow();
			expect(environmentShellScript).toContain('export PATH=/pnpm:$PATH');
			// The NODE_OPTIONS profile export is idempotent so it keeps
			// interactive shells safe without duplicating the forced flags
			// that the VM env already provides.
			expect(environmentShellScript).toContain(
				'case " ${NODE_OPTIONS:-} " in *" --dns-result-order=ipv4first "*) ;; *) export NODE_OPTIONS="--dns-result-order=ipv4first${NODE_OPTIONS:+ ${NODE_OPTIONS}}";; esac',
			);
			expect(environmentShellScript).toContain(
				'case " ${NODE_OPTIONS:-} " in *" --no-network-family-autoselection "*) ;; *) export NODE_OPTIONS="--no-network-family-autoselection${NODE_OPTIONS:+ ${NODE_OPTIONS}}";; esac',
			);
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
			expect(effectiveOpenClawConfigContent).not.toContain('controller.vm.host:18800');
			expect(effectiveOpenClawConfigContent).not.toContain('"controllerUrl"');
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

		it('writes config-backed auth profiles during host preparation', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-config-auth-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(path.join(configDirectory, 'openclaw.json'), '{}', 'utf8');
			const zone = createZone({
				authProfilesRef: {
					source: 'config',
					value: '{"profiles":["main-inline"]}',
				},
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
					authProfilesByAgent: {
						shravan: {
							source: 'config',
							value: '{"profiles":["shravan-inline"]}',
						},
					},
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) =>
					secretRef.source === 'config' ? secretRef.value : 'unexpected',
				resolveAll: async () => ({}),
			};

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			await expect(
				readFile(
					path.join(zone.gateway.stateDir, 'agents', 'main', 'agent', 'auth-profiles.json'),
					'utf8',
				),
			).resolves.toBe('{"profiles":["main-inline"]}');
			await expect(
				readFile(
					path.join(zone.gateway.stateDir, 'agents', 'shravan', 'agent', 'auth-profiles.json'),
					'utf8',
				),
			).resolves.toBe('{"profiles":["shravan-inline"]}');
		});

		it('strips stale MCP Portal plugin config from the managed effective config', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-mcp-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(
					{
						plugins: {
							allow: ['mcp-portal'],
							entries: {
								'mcp-portal': {
									enabled: true,
									hooks: { allowPromptInjection: true },
									config: {
										binPath: '/custom/bin/stale-portal-binary',
										promptContext: { enabled: true },
									},
								},
							},
							load: {
								paths: [
									'/home/openclaw/.openclaw/extensions/mcp-portal',
									'/home/openclaw/.openclaw/extensions/acme-mcp-portal-bridge',
								],
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
				},
				toolPortal: { configDir: configDirectory },
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/auth-profiles') {
						return '{"profiles":["main"]}';
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
			const effectiveOpenClawConfig = JSON.parse(effectiveOpenClawConfigContent) as {
				readonly plugins?: {
					readonly allow?: readonly string[];
					readonly entries?: Record<string, unknown>;
					readonly load?: { readonly paths?: readonly string[] };
				};
			};
			expect(effectiveOpenClawConfig.plugins?.allow).not.toContain('mcp-portal');
			expect(effectiveOpenClawConfig.plugins?.entries?.['mcp-portal']).toBeUndefined();
			expect(effectiveOpenClawConfig.plugins?.load?.paths).toEqual([
				'/home/openclaw/.openclaw/extensions/acme-mcp-portal-bridge',
			]);
			expect(effectiveOpenClawConfigContent).not.toContain('stale-portal-binary');
			expect(effectiveOpenClawConfigContent).not.toContain('binPath');
			expect(effectiveOpenClawConfigContent).not.toContain('promptContext');
		});

		it.each([
			{
				config: { controllerUrl: 'http://controller.vm.host:18800' },
				error: /Gondolin plugin config no longer accepts controllerUrl/u,
				name: 'controllerUrl',
			},
			{
				config: { zoneGitToken: 'stale-zone-git-token' },
				error: /Gondolin plugin config no longer accepts zone git token fields/u,
				name: 'zoneGitToken',
			},
			{
				config: { zoneGitTokenEnv: 'AGENT_VM_ZONE_GIT_TOKEN' },
				error: /Gondolin plugin config no longer accepts zone git token fields/u,
				name: 'zoneGitTokenEnv',
			},
			{
				config: { controlSession: { callerContextProofKey: 'stale-proof-key' } },
				error: /Gondolin plugin controlSession no longer accepts callerContextProofKey/u,
				name: 'controlSession.callerContextProofKey',
			},
		] satisfies readonly {
			readonly config: Record<string, unknown>;
			readonly error: RegExp;
			readonly name: string;
		}[])(
			'rejects stale Gondolin raw-control $name in managed OpenClaw config',
			async (testCase) => {
				const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-raw-'));
				createdDirectories.push(tempDirectory);
				const configDirectory = path.join(tempDirectory, 'config');
				await mkdir(configDirectory, { recursive: true });
				await writeFile(
					path.join(configDirectory, 'openclaw.json'),
					JSON.stringify(
						{
							plugins: {
								allow: ['gondolin'],
								entries: {
									gondolin: {
										enabled: true,
										config: {
											...testCase.config,
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
					},
				});
				const secretResolver: SecretResolver = {
					resolve: async (secretRef) => {
						if (secretRef.ref === 'op://vault/item/auth-profiles') {
							return '{"profiles":["main"]}';
						}
						if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
							return 'resolved-gateway-token';
						}
						throw new Error(`Unexpected ref: ${secretRef.ref}`);
					},
					resolveAll: async () => ({}),
				};

				await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
					testCase.error,
				);
			},
		);

		it('rejects non-object authored managed Gondolin config before writing the effective config', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-gondolin-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(
					{
						plugins: {
							allow: ['gondolin'],
							entries: {
								gondolin: {
									enabled: true,
									config: true,
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
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/auth-profiles') {
						return '{"profiles":["main"]}';
					}
					if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
						return 'resolved-gateway-token';
					}
					throw new Error(`Unexpected ref: ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
				/Gondolin plugin config must be an object when present/u,
			);
		});

		it.each([
			{ fieldName: 'controlSession', value: true },
			{ fieldName: 'toolPortal', value: true },
		] satisfies readonly {
			readonly fieldName: 'controlSession' | 'toolPortal';
			readonly value: boolean;
		}[])(
			'rejects malformed managed Gondolin $fieldName config before writing the effective config',
			async ({ fieldName, value }) => {
				const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-gondolin-'));
				createdDirectories.push(tempDirectory);
				const configDirectory = path.join(tempDirectory, 'config');
				await mkdir(configDirectory, { recursive: true });
				await writeFile(
					path.join(configDirectory, 'openclaw.json'),
					JSON.stringify(
						{
							plugins: {
								allow: ['gondolin'],
								entries: {
									gondolin: {
										enabled: true,
										config: {
											[fieldName]: value,
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
					},
				});
				const secretResolver: SecretResolver = {
					resolve: async (secretRef) => {
						if (secretRef.ref === 'op://vault/item/auth-profiles') {
							return '{"profiles":["main"]}';
						}
						if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
							return 'resolved-gateway-token';
						}
						throw new Error(`Unexpected ref: ${secretRef.ref}`);
					},
					resolveAll: async () => ({}),
				};

				await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
					`Gondolin plugin ${fieldName} must be an object when present.`,
				);
			},
		);

		it.each([
			{
				authoredConfig: {
					toolPortal: {
						configDir: 42,
					},
					zoneId: 'shravan',
				},
				error: /Gondolin plugin toolPortal requires string configDir/u,
				name: 'toolPortal.configDir',
				runtimeConfig: {
					toolPortal: {
						configDir: '/home/openclaw/.openclaw/config',
					},
				},
			},
			{
				authoredConfig: {
					controlSession: {
						bootId: 42,
					},
					zoneId: 'shravan',
				},
				error: /Gondolin plugin controlSession requires string bootId/u,
				name: 'controlSession.bootId',
				runtimeConfig: {
					controlSession: {
						bootId: 'boot-a',
						controllerEpoch: 'epoch-a',
						generationId: 'generation-a',
						peerId: 'gateway-shravan',
						processEpoch: 'process-a',
						verifierPublicKeyPem: 'public-key',
					},
				},
			},
		] satisfies readonly {
			readonly authoredConfig: Record<string, unknown>;
			readonly error: RegExp;
			readonly name: string;
			readonly runtimeConfig: Record<string, unknown>;
		}[])(
			'rejects malformed authored Gondolin $name field before runtime config can overwrite it',
			async (testCase) => {
				const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-gondolin-'));
				createdDirectories.push(tempDirectory);
				const configDirectory = path.join(tempDirectory, 'config');
				await mkdir(configDirectory, { recursive: true });
				await writeFile(
					path.join(configDirectory, 'openclaw.json'),
					JSON.stringify(
						{
							plugins: {
								allow: ['gondolin'],
								entries: {
									gondolin: {
										enabled: true,
										config: testCase.authoredConfig,
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
					},
					runtimePluginConfigs: {
						gondolin: testCase.runtimeConfig,
					},
				});
				const secretResolver: SecretResolver = {
					resolve: async (secretRef) => {
						if (secretRef.ref === 'op://vault/item/auth-profiles') {
							return '{"profiles":["main"]}';
						}
						if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
							return 'resolved-gateway-token';
						}
						throw new Error(`Unexpected ref: ${secretRef.ref}`);
					},
					resolveAll: async () => ({}),
				};

				await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
					testCase.error,
				);
			},
		);

		it.each([
			{ fieldName: 'controlSession', value: true },
			{ fieldName: 'toolPortal', value: true },
		] satisfies readonly {
			readonly fieldName: 'controlSession' | 'toolPortal';
			readonly value: boolean;
		}[])(
			'rejects malformed authored Gondolin $fieldName even when runtime config provides a managed object',
			async ({ fieldName, value }) => {
				const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-gondolin-'));
				createdDirectories.push(tempDirectory);
				const configDirectory = path.join(tempDirectory, 'config');
				await mkdir(configDirectory, { recursive: true });
				await writeFile(
					path.join(configDirectory, 'openclaw.json'),
					JSON.stringify(
						{
							plugins: {
								allow: ['gondolin'],
								entries: {
									gondolin: {
										enabled: true,
										config: {
											[fieldName]: value,
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
					},
					runtimePluginConfigs: {
						gondolin: {
							[fieldName]: { managed: true },
						},
					},
				});
				const secretResolver: SecretResolver = {
					resolve: async (secretRef) => {
						if (secretRef.ref === 'op://vault/item/auth-profiles') {
							return '{"profiles":["main"]}';
						}
						if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
							return 'resolved-gateway-token';
						}
						throw new Error(`Unexpected ref: ${secretRef.ref}`);
					},
					resolveAll: async () => ({}),
				};

				await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
					`Gondolin plugin ${fieldName} must be an object when present.`,
				);
			},
		);

		it.each([
			{
				error: /Gondolin plugin controlSession requires string controllerEpoch/u,
				name: 'partial controlSession',
				runtimeConfig: {
					controlSession: {
						bootId: 'boot-a',
					},
				},
			},
			{
				error: /Gondolin plugin toolPortal requires string configDir/u,
				name: 'empty toolPortal',
				runtimeConfig: {
					toolPortal: {},
				},
			},
		] satisfies readonly InvalidFinalManagedGondolinConfigTestCase[])(
			'rejects final managed Gondolin $name config before writing the effective config',
			async (testCase) => {
				const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-gondolin-'));
				createdDirectories.push(tempDirectory);
				const configDirectory = path.join(tempDirectory, 'config');
				await mkdir(configDirectory, { recursive: true });
				await writeFile(
					path.join(configDirectory, 'openclaw.json'),
					JSON.stringify(
						{
							plugins: {
								allow: ['gondolin'],
								entries: {
									gondolin: {
										enabled: true,
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
					},
					runtimePluginConfigs: {
						gondolin: testCase.runtimeConfig,
					},
				});
				const secretResolver: SecretResolver = {
					resolve: async (secretRef) => {
						if (secretRef.ref === 'op://vault/item/auth-profiles') {
							return '{"profiles":["main"]}';
						}
						if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
							return 'resolved-gateway-token';
						}
						throw new Error(`Unexpected ref: ${secretRef.ref}`);
					},
					resolveAll: async () => ({}),
				};

				await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
					testCase.error,
				);
			},
		);

		it('rejects runtime MCP Portal plugin config for managed OpenClaw', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-mcp-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(
					{
						plugins: {
							allow: ['gondolin'],
							entries: { gondolin: { enabled: true } },
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
				toolPortal: { configDir: configDirectory },
				runtimePluginConfigs: {
					'mcp-portal': { configDir: '/home/openclaw/.openclaw/config' },
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/auth-profiles') {
						return '{"profiles":["main"]}';
					}
					if (secretRef.ref === 'op://vault/item/openclaw-gateway-token') {
						return 'resolved-gateway-token';
					}
					throw new Error(`Unexpected ref: ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
				/managed OpenClaw does not accept runtime mcp-portal plugin config/u,
			);
		});

		it('does not serialize the gateway caller-context proof key into effective OpenClaw config', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-proof-'));
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(
					{
						plugins: {
							allow: ['gondolin'],
							entries: { gondolin: { enabled: true } },
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
				runtimePluginConfigs: {
					gondolin: {
						controlSession: {
							bootId: 'boot-a',
							controllerEpoch: 'epoch-a',
							generationId: 'generation-a',
							peerId: 'gateway-shravan',
							processEpoch: 'process-a',
							verifierPublicKeyPem: 'public-key',
						},
					},
				},
				runtimePrivateEnvironment: {
					[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV]: 'private-proof-key',
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					if (secretRef.ref === 'op://vault/item/auth-profiles') {
						return '{"profiles":["main"]}';
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
			expect(effectiveOpenClawConfigContent).not.toContain('private-proof-key');
			expect(effectiveOpenClawConfigContent).not.toContain(
				GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV,
			);
			expect(JSON.parse(effectiveOpenClawConfigContent)).toMatchObject({
				plugins: {
					entries: {
						gondolin: {
							config: {
								controlSession: {
									bootId: 'boot-a',
									controllerEpoch: 'epoch-a',
									generationId: 'generation-a',
									peerId: 'gateway-shravan',
									processEpoch: 'process-a',
									verifierPublicKeyPem: 'public-key',
								},
								zoneId: 'shravan',
							},
						},
					},
				},
			});
		});

		it('resolves all per-agent auth profiles before writing files', async () => {
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
				/Failed to resolve 1 OpenClaw auth profile secret/u,
			);
			await expect(
				readFile(
					path.join(zone.gateway.stateDir, 'agents', 'alevtina', 'agent', 'auth-profiles.json'),
					'utf8',
				),
			).rejects.toThrow(/ENOENT/u);
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

		it('writes effective diagnostics OTLP config for observability-enabled zones', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-observability-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify(
					{
						diagnostics: {
							enabled: false,
							otel: {
								captureContent: { enabled: true },
								endpoint: 'http://stale-collector.example.test:4318',
								headers: { authorization: 'stale-token' },
								logsEndpoint: 'http://stale-logs.example.test/v1/logs',
								metricsEndpoint: 'http://stale-metrics.example.test/v1/metrics',
								tracesEndpoint: 'http://stale-traces.example.test/v1/traces',
							},
						},
						gateway: {
							auth: { mode: 'token' },
							bind: 'loopback',
						},
						logging: {
							level: 'debug',
						},
						plugins: {
							allow: ['gondolin'],
							entries: {
								'diagnostics-otel': {
									enabled: false,
									config: {
										endpoint: 'http://stale-plugin.example.test:4318',
										headers: { authorization: 'stale-plugin-token' },
									},
								},
								gondolin: {
									enabled: true,
									config: {},
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
				},
				observability: createObservabilityConfig(),
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
			const effectiveOpenClawConfig = JSON.parse(effectiveOpenClawConfigContent);
			expect(effectiveOpenClawConfig.plugins.allow).toEqual(['gondolin', 'diagnostics-otel']);
			expect(effectiveOpenClawConfig.plugins.load).toBeUndefined();
			expect(effectiveOpenClawConfig.plugins.installs).toEqual({
				'diagnostics-otel': {
					source: 'npm',
					spec: '@openclaw/diagnostics-otel',
					installPath: '/pnpm/global/5/node_modules/@openclaw/diagnostics-otel',
				},
			});
			expect(effectiveOpenClawConfig.plugins.entries['diagnostics-otel']).toEqual({
				enabled: true,
			});
			expect(effectiveOpenClawConfig.diagnostics).toEqual({
				enabled: true,
				flags: ['scheduler.debug'],
				otel: {
					captureContent: { enabled: false },
					enabled: true,
					endpoint: 'http://otel-collector.observability.vm.host:4318',
					flushIntervalMs: 10_000,
					logs: true,
					metrics: true,
					protocol: 'http/protobuf',
					sampleRate: 1,
					serviceName: 'agent-vm-openclaw-shravan',
					traces: true,
				},
			});
			expect(effectiveOpenClawConfigContent).not.toContain('stale-collector.example.test');
			expect(effectiveOpenClawConfigContent).not.toContain('stale-logs.example.test');
			expect(effectiveOpenClawConfigContent).not.toContain('stale-metrics.example.test');
			expect(effectiveOpenClawConfigContent).not.toContain('stale-traces.example.test');
			expect(effectiveOpenClawConfigContent).not.toContain('stale-plugin.example.test');
			expect(effectiveOpenClawConfigContent).not.toContain('stale-token');
			expect(effectiveOpenClawConfigContent).not.toContain('stale-plugin-token');
			expect(effectiveOpenClawConfigContent).not.toContain('logsEndpoint');
			expect(effectiveOpenClawConfigContent).not.toContain('metricsEndpoint');
			expect(effectiveOpenClawConfigContent).not.toContain('tracesEndpoint');
			expect(effectiveOpenClawConfigContent).not.toContain('prompt');
			expect(effectiveOpenClawConfigContent).not.toContain('payload');
			expect(effectiveOpenClawConfigContent).not.toContain('resolved-gateway-token');

			const pluginInstallIndexContent = await readFile(
				path.join(zone.gateway.stateDir, 'plugins', 'installs.json'),
				'utf8',
			);
			expect(JSON.parse(pluginInstallIndexContent)).toEqual({
				installRecords: {
					'diagnostics-otel': {
						source: 'npm',
						spec: '@openclaw/diagnostics-otel',
						installPath: '/pnpm/global/5/node_modules/@openclaw/diagnostics-otel',
					},
				},
			});
			expect(
				(await stat(path.join(zone.gateway.stateDir, 'plugins', 'installs.json'))).mode & 0o777,
			).toBe(0o600);
		});

		it('preserves existing OpenClaw plugin install records when adding managed diagnostics', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-observability-registry-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify({ gateway: { auth: { mode: 'token' }, bind: 'loopback' } }, null, 2),
				'utf8',
			);
			const stateDirectory = path.join(tempDirectory, 'state');
			await mkdir(path.join(stateDirectory, 'plugins'), { recursive: true });
			await writeFile(
				path.join(stateDirectory, 'plugins', 'installs.json'),
				JSON.stringify(
					{
						installRecords: {
							'user-plugin': {
								source: 'npm',
								spec: '@example/user-plugin',
								installPath: '/home/openclaw/.openclaw/plugins/user-plugin',
							},
						},
						version: 1,
					},
					null,
					2,
				),
				'utf8',
			);
			const zone = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: stateDirectory,
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
				observability: createObservabilityConfig(),
				withoutAuthProfilesRef: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async () => 'resolved-gateway-token',
				resolveAll: async () => ({}),
			};

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			const pluginInstallIndex = JSON.parse(
				await readFile(path.join(stateDirectory, 'plugins', 'installs.json'), 'utf8'),
			);
			expect(pluginInstallIndex).toMatchObject({
				installRecords: {
					'user-plugin': {
						source: 'npm',
						spec: '@example/user-plugin',
					},
					'diagnostics-otel': {
						source: 'npm',
						spec: '@openclaw/diagnostics-otel',
						installPath: '/pnpm/global/5/node_modules/@openclaw/diagnostics-otel',
					},
				},
				version: 1,
			});
		});

		it('treats an empty OpenClaw plugin registry index as empty state', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-empty-registry-index-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify({ gateway: { auth: { mode: 'token' }, bind: 'loopback' } }, null, 2),
				'utf8',
			);
			const stateDirectory = path.join(tempDirectory, 'state');
			await mkdir(path.join(stateDirectory, 'plugins'), { recursive: true });
			await writeFile(path.join(stateDirectory, 'plugins', 'installs.json'), '', 'utf8');
			const zone = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: stateDirectory,
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
				observability: createObservabilityConfig(),
				withoutAuthProfilesRef: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async () => 'resolved-gateway-token',
				resolveAll: async () => ({}),
			};

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			const pluginInstallIndex = JSON.parse(
				await readFile(path.join(stateDirectory, 'plugins', 'installs.json'), 'utf8'),
			);
			expect(pluginInstallIndex).toEqual({
				installRecords: {
					'diagnostics-otel': {
						source: 'npm',
						spec: '@openclaw/diagnostics-otel',
						installPath: '/pnpm/global/5/node_modules/@openclaw/diagnostics-otel',
					},
				},
			});
		});

		it('rejects a symlinked OpenClaw plugin registry directory before host preparation writes', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-registry-dir-symlink-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify({ gateway: { auth: { mode: 'token' }, bind: 'loopback' } }, null, 2),
				'utf8',
			);
			const stateDirectory = path.join(tempDirectory, 'state');
			const sentinelDirectory = path.join(tempDirectory, 'sentinel');
			await mkdir(stateDirectory, { recursive: true });
			await mkdir(sentinelDirectory, { recursive: true });
			await symlink(sentinelDirectory, path.join(stateDirectory, 'plugins'));
			const zone = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: stateDirectory,
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
				observability: createObservabilityConfig(),
				withoutAuthProfilesRef: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async () => 'resolved-gateway-token',
				resolveAll: async () => ({}),
			};

			await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
				/plugin registry directory.*symlink/u,
			);
			await expect(pathExists(path.join(sentinelDirectory, 'installs.json'))).resolves.toBe(false);
		});

		it('rejects a symlinked OpenClaw plugin registry index before host preparation writes', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-registry-index-symlink-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify({ gateway: { auth: { mode: 'token' }, bind: 'loopback' } }, null, 2),
				'utf8',
			);
			const stateDirectory = path.join(tempDirectory, 'state');
			const sentinelFilePath = path.join(tempDirectory, 'sentinel-installs.json');
			await mkdir(path.join(stateDirectory, 'plugins'), { recursive: true });
			await writeFile(sentinelFilePath, '{"sentinel":true}\n', 'utf8');
			await symlink(sentinelFilePath, path.join(stateDirectory, 'plugins', 'installs.json'));
			const zone = createZone({
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: stateDirectory,
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
				observability: createObservabilityConfig(),
				withoutAuthProfilesRef: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async () => 'resolved-gateway-token',
				resolveAll: async () => ({}),
			};

			await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
				/plugin registry index.*symlink/u,
			);
			await expect(readFile(sentinelFilePath, 'utf8')).resolves.toBe('{"sentinel":true}\n');
		});

		it.each([false, 'off', 'OFF', ' off ', 'false', 0, 'disabled'])(
			'rejects observability when authored OpenClaw logging disables sensitive redaction as %s',
			async (redactSensitive) => {
				const tempDirectory = await mkdtemp(
					path.join(os.tmpdir(), 'openclaw-lifecycle-observability-redaction-'),
				);
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
							logging: {
								redactSensitive,
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
					observability: createObservabilityConfig(),
					withoutAuthProfilesRef: true,
				});
				const secretResolver: SecretResolver = {
					resolve: async () => 'resolved-gateway-token',
					resolveAll: async () => ({}),
				};

				await expect(openclawLifecycle.prepareHostState?.(zone, secretResolver)).rejects.toThrow(
					/logging\.redactSensitive/u,
				);
			},
		);

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
				/Failed to build effective OpenClaw config for zone 'shravan'.*must be a JSON object/u,
			);
			await expect(openclawLifecycle.preflightHostState?.(zone, secretResolver)).rejects.toThrow(
				/Failed to build effective OpenClaw config for zone 'shravan'.*must be a JSON object/u,
			);
		});

		it('redacts configured 1Password refs from effective config errors', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-redacted-config-error-'),
			);
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
				withoutAuthProfilesRef: true,
			});
			const secretResolver: SecretResolver = {
				resolve: async () => {
					throw new Error('auth profile resolution should not run');
				},
				resolveAll: async () => ({}),
			};

			const message = await captureThrownMessage(
				openclawLifecycle.prepareHostState?.(zone, secretResolver),
			);

			expect(message).toContain('<1password-ref>');
			expect(message).toContain('must be a JSON object');
			expect(message).not.toContain('op://');
			expect(message).not.toContain('op://vault/item/openclaw-gateway-token');
		});

		it('redacts configured 1Password refs from auth profile resolution errors', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-redacted-auth-profile-error-'),
			);
			createdDirectories.push(tempDirectory);
			const configDirectory = path.join(tempDirectory, 'config');
			await mkdir(configDirectory, { recursive: true });
			await writeFile(
				path.join(configDirectory, 'openclaw.json'),
				JSON.stringify({
					gateway: {
						auth: { mode: 'token' },
						bind: 'loopback',
					},
				}),
				'utf8',
			);
			const authProfileReference = 'op://vault/private-auth-profiles/credential';
			const zone = createZone({
				authProfilesRef: {
					source: '1password',
					ref: authProfileReference,
				},
				gateway: {
					config: path.join(configDirectory, 'openclaw.json'),
					stateDir: path.join(tempDirectory, 'state'),
					zoneFilesDir: path.join(tempDirectory, 'zone-files'),
				},
			});
			const secretResolver: SecretResolver = {
				resolve: async (secretRef) => {
					throw new Error(`lookup failed for ${secretRef.ref}`);
				},
				resolveAll: async () => ({}),
			};

			const error = await captureThrownError(
				openclawLifecycle.prepareHostState?.(zone, secretResolver),
			);
			const message = error.message;
			const childMessages = aggregateChildMessages(error);

			expect(message).toContain('Failed to resolve 1 OpenClaw auth profile secret');
			expect(message).not.toContain('op://');
			expect(childMessages.join('\n')).toContain('<1password-ref>');
			expect(childMessages.join('\n')).toContain('lookup failed for <1password-ref>');
			expect(childMessages.join('\n')).not.toContain('op://');
			expect(message).not.toContain(authProfileReference);
			expect(childMessages.join('\n')).not.toContain(authProfileReference);
		});

		it('preflights effective-openclaw config without writing the final config file', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-preflight-effective-config-'),
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
			const secretResolver: SecretResolver = {
				resolve: async () => {
					throw new Error('auth profile resolution should not run');
				},
				resolveAll: async () => ({}),
			};

			await expect(openclawLifecycle.preflightHostState?.(zone, secretResolver)).resolves.toBe(
				undefined,
			);

			expect(await pathExists(path.join(zone.gateway.stateDir, 'effective-openclaw.json'))).toBe(
				false,
			);
			expect(
				(await readdir(zone.gateway.stateDir)).filter((entryName) =>
					entryName.includes('.agent-vm-effective-openclaw-preflight'),
				),
			).toEqual([]);
		});

		it('preflight fails before restart when effective-openclaw path is a directory', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-preflight-directory-'),
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

			await expect(openclawLifecycle.preflightHostState?.(zone, secretResolver)).rejects.toThrow(
				/Failed to preflight effective OpenClaw config.*is a directory/u,
			);
			expect(
				(await readdir(zone.gateway.stateDir)).filter((entryName) =>
					entryName.includes('.agent-vm-effective-openclaw-preflight'),
				),
			).toEqual([]);
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
