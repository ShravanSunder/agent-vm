import { execFile } from 'node:child_process';
import {
	access,
	chmod,
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

import type { GatewayZoneConfig } from '@agent-vm/gateway-interface';
import type { SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openclawLifecycle } from './openclaw-lifecycle.js';

const createdDirectories: string[] = [];
const execFileAsync = promisify(execFile);
type OpenClawGatewayConfig = Extract<GatewayZoneConfig['gateway'], { readonly type: 'openclaw' }>;
type ExecFileError = Error & {
	readonly code?: number | string;
	readonly killed?: boolean;
	readonly signal?: NodeJS.Signals | null;
};

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
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
		.replaceAll('/work', path.join(rootDirectory, 'work'))
		.replace(`chown -R openclaw:openclaw ${path.join(rootDirectory, 'work')} && `, '');
	await execFileAsync('sh', ['-lc', rootedCommand], { env });
}

function renderStartCommandForHost(
	command: string,
	props: {
		readonly fakeOpenClawPath: string;
		readonly rootDirectory: string;
	},
): string {
	return command
		.replaceAll('/usr/local/bin/openclaw', props.fakeOpenClawPath)
		.replaceAll('/run/openclaw', path.join(props.rootDirectory, 'run', 'openclaw'))
		.replaceAll('/agent-vm/logs', path.join(props.rootDirectory, 'agent-vm', 'logs'))
		.replaceAll('/home/openclaw', path.join(props.rootDirectory, 'home', 'openclaw'))
		.replace('nohup sh -c', 'sh -c')
		.replace(/ &$/u, '');
}

function shellQuoteForTest(value: string): string {
	return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function buildExpectedOpenClawGatewaySupervisorScriptForTest(): string {
	return [
		'restart_delay_seconds="${AGENT_VM_OPENCLAW_SUPERVISOR_RESTART_DELAY_SECONDS:-5}"',
		'restart_window_seconds="${AGENT_VM_OPENCLAW_SUPERVISOR_RESTART_WINDOW_SECONDS:-60}"',
		'max_restarts="${AGENT_VM_OPENCLAW_SUPERVISOR_MAX_RESTARTS:-6}"',
		'attempt=0',
		'failure_count=0',
		'first_failure_at=0',
		'while true',
		'do attempt=$((attempt + 1))',
		'printf "gateway-supervisor: starting openclaw gateway attempt=%s at=%s\\n" "$attempt" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
		'set -a',
		'if ! . /run/openclaw/secrets.env; then printf "gateway-supervisor: failed to source runtime secrets attempt=%s at=%s\\n" "$attempt" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; exit 1; fi',
		'set +a',
		'/usr/local/bin/openclaw gateway --port 18789',
		'exit_code=$?',
		'now=$(date -u +%s)',
		'if [ "$first_failure_at" -eq 0 ] || [ $((now - first_failure_at)) -gt "$restart_window_seconds" ]; then first_failure_at=$now; failure_count=1; else failure_count=$((failure_count + 1)); fi',
		'printf "gateway-supervisor: openclaw gateway exited attempt=%s exit_code=%s failure_count=%s window_seconds=%s at=%s\\n" "$attempt" "$exit_code" "$failure_count" "$restart_window_seconds" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
		'if [ "$failure_count" -ge "$max_restarts" ]; then printf "gateway-supervisor: restart limit exceeded failure_count=%s max_restarts=%s window_seconds=%s at=%s\\n" "$failure_count" "$max_restarts" "$restart_window_seconds" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; if [ "$exit_code" -eq 0 ]; then exit 1; fi; exit "$exit_code"; fi',
		'sleep "$restart_delay_seconds"',
		'done',
	].join('; ');
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
	readonly mcpPortal?: GatewayZoneConfig['mcpPortal'];
	readonly runtimeMcpServers?: GatewayZoneConfig['runtimeMcpServers'];
	readonly runtimeEnvironment?: GatewayZoneConfig['runtimeEnvironment'];
	readonly runtimeMediatedSecrets?: GatewayZoneConfig['runtimeMediatedSecrets'];
	readonly observability?: GatewayZoneConfig['observability'];
	readonly runtimePluginConfigs?: GatewayZoneConfig['runtimePluginConfigs'];
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
		rawEnvSecrets: ['AGENT_VM_ZONE_GIT_TOKEN', 'DISCORD_BOT_TOKEN'],
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
		...(overrides?.mcpPortal ? { mcpPortal: overrides.mcpPortal } : {}),
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
		...(overrides?.runtimeEnvironment ? { runtimeEnvironment: overrides.runtimeEnvironment } : {}),
		...(overrides?.runtimeMediatedSecrets
			? { runtimeMediatedSecrets: overrides.runtimeMediatedSecrets }
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

		it('rejects authored env secrets that are not explicit raw-env exceptions', () => {
			expect(() =>
				openclawLifecycle.buildVmSpec({
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
					rawEnvSecrets: ['AGENT_VM_ZONE_GIT_TOKEN', 'DISCORD_BOT_TOKEN', 'OPENCLAW_DIAGNOSTICS'],
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
				openclawLifecycle.buildVmSpec({
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

		it('injects generated runtime mediated secrets without authored zone secret config entries', () => {
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
					runtimeMediatedSecrets: {
						AGENT_VM_MCP_TAVILY_API_KEY: {
							hosts: ['api.tavily.com'],
							value: 'runtime-tavily-token',
						},
					},
				}),
			});

			expect(vmSpec.mediatedSecrets.AGENT_VM_MCP_TAVILY_API_KEY).toEqual({
				hosts: ['api.tavily.com'],
				value: 'runtime-tavily-token',
			});
			expect(vmSpec.environment.AGENT_VM_MCP_TAVILY_API_KEY).toBeUndefined();
		});

		it('rejects generated runtime secrets that collide with authored zone secrets', () => {
			expect(() =>
				openclawLifecycle.buildVmSpec({
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
			expect(vmSpec.environment.NODE_OPTIONS).toBe(
				'--dns-result-order=ipv4first --no-network-family-autoselection',
			);
			expect(vmSpec.environment.OPENCLAW_PLUGIN_STAGE_DIR).toBeUndefined();
			expect(vmSpec.environment.TMPDIR).toBe('/work/tmp');
			expect(vmSpec.environment.PNPM_HOME).toBe('/pnpm');
			expect(vmSpec.environment.PATH).toBe(
				'/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
			);
			expect(vmSpec.environment.npm_config_cache).toBe('/work/cache/npm');
			// IPv4-preference egress for the Node OpenClaw process to defeat
			// Happy Eyeballs racing on gondolin's shared synthetic AAAA.
			// See FORCE_IPV4_EGRESS_NODE_OPTIONS in @agent-vm/gateway-interface.
			expect(vmSpec.environment.NODE_OPTIONS).toBe(
				'--dns-result-order=ipv4first --no-network-family-autoselection',
			);
			expect(vmSpec.allowedHosts).toEqual([
				'controller.vm.host',
				'api.openai.com',
				'api.perplexity.ai',
			]);
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
				'tool-0.vm.host:22': '127.0.0.1:19000',
				'tool-1.vm.host:22': '127.0.0.1:19001',
			});
			expect(vmSpec.sessionLabel).toBe('claw-tests-a1b2c3d4:shravan:gateway');
		});

		it('maps host observability collector endpoints into the gateway VM tcp hosts', () => {
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
				zone: createZone({
					observability: createObservabilityConfig(),
				}),
			});

			expect(vmSpec.tcpHosts).toMatchObject({
				'otel-collector.observability.vm.host:4317': '127.0.0.1:24317',
				'otel-collector.observability.vm.host:4318': '127.0.0.1:24318',
			});
			expect(vmSpec.allowedHosts).toEqual([
				'controller.vm.host',
				'api.openai.com',
				'api.perplexity.ai',
			]);
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
				zone: createZone({ websocketUpgrades }),
			});

			expect(vmSpec.websocketUpgrades).toEqual(websocketUpgrades);
		});

		it('preserves the forced IPv4-preference flags even when a zone secret supplies NODE_OPTIONS', () => {
			// Regression test for the merge-order bug surfaced in PR #93
			// review: a zone secret named NODE_OPTIONS must NOT drop our
			// forced flags, because Happy Eyeballs would race the
			// synthetic AAAA again.
			const baseZone = createZone({
				gateway: {
					rawEnvSecrets: ['AGENT_VM_ZONE_GIT_TOKEN', 'DISCORD_BOT_TOKEN', 'NODE_OPTIONS'],
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

			const vmSpec = openclawLifecycle.buildVmSpec({
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
			expect(vmSpec.environment.NODE_OPTIONS).toBe(
				'--dns-result-order=ipv4first --no-network-family-autoselection --inspect=0.0.0.0:9229',
			);
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
			expect(processSpec.bootstrapCommand).toContain('OPENCLAW_GATEWAY_TOKEN');
			expect(processSpec.bootstrapCommand).toContain('AGENT_VM_ZONE_GIT_TOKEN');
			expect(processSpec.bootstrapCommand).not.toContain('discord-token');
			expect(processSpec.bootstrapCommand).not.toContain("gateway'token");
			expect(processSpec.bootstrapCommand).not.toContain('runtime-zone-git-token');
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
			expect(processSpec.startCommand).toContain('. /run/openclaw/secrets.env');
			expect(processSpec.startCommand).toContain('cd /home/openclaw');
			expect(processSpec.bootstrapCommand).toContain('/etc/profile.d/openclaw-env.sh');
			expect(processSpec.bootstrapCommand).toContain('source /root/.bashrc');
			expect(processSpec.startCommand).toContain(
				`nohup sh -c ${shellQuoteForTest(buildExpectedOpenClawGatewaySupervisorScriptForTest())}`,
			);
			expect(processSpec.startCommand).toContain(
				'gateway-supervisor: starting openclaw gateway attempt=',
			);
			expect(processSpec.startCommand).toContain(
				'gateway-supervisor: openclaw gateway exited attempt=',
			);
			expect(processSpec.startCommand).toContain(
				'gateway-supervisor: restart limit exceeded failure_count=',
			);
			expect(processSpec.startCommand).toContain('sleep "$restart_delay_seconds"');
			expect(processSpec.startCommand).not.toContain(
				'nohup /usr/local/bin/openclaw gateway --port 18789',
			);
			expect(processSpec.startCommand).toContain('> /agent-vm/logs/gateway-boot-latest.log 2>&1');
			expect(processSpec.healthCheck).toEqual({
				type: 'http',
				port: 18789,
				path: '/readyz',
			});
			expect(processSpec.logPath).toBe('/agent-vm/logs/gateway-boot-latest.log');
		});

		it('fails hard after a bounded fast crash loop so controller recovery can escalate', async () => {
			const tempDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-supervisor-crash-loop-'),
			);
			createdDirectories.push(tempDirectory);
			await mkdir(path.join(tempDirectory, 'run', 'openclaw'), { recursive: true });
			await mkdir(path.join(tempDirectory, 'agent-vm', 'logs'), { recursive: true });
			await mkdir(path.join(tempDirectory, 'home', 'openclaw'), { recursive: true });
			const fakeOpenClawPath = path.join(tempDirectory, 'fake-openclaw');
			const attemptsLogPath = path.join(tempDirectory, 'fake-openclaw-attempts.log');
			await writeFile(
				fakeOpenClawPath,
				['#!/bin/sh', 'printf "attempt\\n" >> "$FAKE_OPENCLAW_ATTEMPTS_LOG"', 'exit 42'].join('\n'),
				'utf8',
			);
			await chmod(fakeOpenClawPath, 0o700);
			await writeFile(
				path.join(tempDirectory, 'run', 'openclaw', 'secrets.env'),
				['NODE_OPTIONS=--dns-result-order=ipv4first', 'OPENCLAW_GATEWAY_TOKEN=test-token'].join(
					'\n',
				),
				'utf8',
			);
			const processSpec = openclawLifecycle.buildProcessSpec(createZone(), resolvedSecrets);
			const foregroundStartCommand = renderStartCommandForHost(processSpec.startCommand, {
				fakeOpenClawPath,
				rootDirectory: tempDirectory,
			});

			const supervisorExit = (await captureThrownError(
				execFileAsync('sh', ['-lc', foregroundStartCommand], {
					env: {
						...process.env,
						AGENT_VM_OPENCLAW_SUPERVISOR_MAX_RESTARTS: '3',
						AGENT_VM_OPENCLAW_SUPERVISOR_RESTART_DELAY_SECONDS: '0',
						AGENT_VM_OPENCLAW_SUPERVISOR_RESTART_WINDOW_SECONDS: '60',
						FAKE_OPENCLAW_ATTEMPTS_LOG: attemptsLogPath,
					},
					timeout: 5_000,
				}),
			)) as ExecFileError;
			expect(supervisorExit.code).toBe(42);
			expect(supervisorExit.killed).not.toBe(true);
			expect(supervisorExit.signal).toBeNull();

			const attemptsLog = await readFile(attemptsLogPath, 'utf8');
			expect(attemptsLog.trim().split('\n')).toHaveLength(3);
			const bootLog = await readFile(
				path.join(tempDirectory, 'agent-vm', 'logs', 'gateway-boot-latest.log'),
				'utf8',
			);
			expect(bootLog).toContain(
				'gateway-supervisor: restart limit exceeded failure_count=3 max_restarts=3',
			);
		});

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
								gatewayControlLinkMonitor: {
									baseIntervalMs: 10_000,
									enabled: true,
									maxIntervalMs: 120_000,
								},
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

		it('injects MCP Portal configDir and replaces stale plugin config', async () => {
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
				mcpPortal: { configDir: configDirectory },
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

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			const effectiveOpenClawConfigContent = await readFile(
				path.join(zone.gateway.stateDir, 'effective-openclaw.json'),
				'utf8',
			);
			expect(JSON.parse(effectiveOpenClawConfigContent)).toMatchObject({
				plugins: {
					entries: {
						'mcp-portal': {
							config: { configDir: '/home/openclaw/.openclaw/config' },
						},
					},
				},
			});
			expect(effectiveOpenClawConfigContent).not.toContain('stale-portal-binary');
			expect(effectiveOpenClawConfigContent).not.toContain('binPath');
			expect(effectiveOpenClawConfigContent).not.toContain('promptContext');
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
