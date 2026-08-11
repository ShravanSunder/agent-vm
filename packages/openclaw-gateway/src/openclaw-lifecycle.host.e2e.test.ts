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
import { fileURLToPath } from 'node:url';

import {
	createGatewayTelemetryProducerSafetyContract,
	GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV,
	gatewayFrameworkTelemetryServiceNames,
	gatewayToolPortalTelemetryServiceName,
	type GatewayZoneConfig,
} from '@agent-vm/gateway-lifecycle';
import type { SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openclawLifecycle } from './openclaw-lifecycle.js';

const createdDirectories: string[] = [];
type OpenClawGatewayConfig = Extract<GatewayZoneConfig['gateway'], { readonly type: 'openclaw' }>;

function createManagedToolPortalPluginConfig(): Readonly<Record<string, unknown>> {
	return {
		agentProjections: {
			'agent-a': {
				agentId: 'agent-a',
				frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
				profileAssignmentRevision: 'profile-revision-a',
				toolPortalNamespaceNames: ['filesystem', 'github'],
				toolPortalProfileId: 'profile-a',
			},
			'agent-b': {
				agentId: 'agent-b',
				frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
				profileAssignmentRevision: 'profile-revision-b',
				toolPortalNamespaceNames: ['filesystem', 'github'],
				toolPortalProfileId: 'profile-b',
			},
		},
		attachment: {
			attachmentGeneration: 7,
			clientKind: 'openclaw-managed-plugin',
			configuredAgentIds: ['agent-a', 'agent-b'],
			frameworkEpoch: 'openclaw-epoch-4',
			gatewayEpoch: 'gateway-epoch-3',
			protocolVersion: 1,
			projectionCohortDigest:
				'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			runtimeEpoch: 'runtime-epoch-5',
			schemaVersion: 1,
		},
	};
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
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

interface CreateZoneOverrides {
	readonly authProfilesRef?: OpenClawGatewayConfig['authProfilesRef'];
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
}

interface AuthoredConfigurationTreeSnapshot {
	readonly directoryEntries: readonly string[];
	readonly directoryMetadata: {
		readonly changedAtMs: number;
		readonly deviceId: number;
		readonly inode: number;
		readonly mode: number;
		readonly modifiedAtMs: number;
		readonly ownerGid: number;
		readonly ownerUid: number;
	};
	readonly files: Readonly<
		Record<
			string,
			{
				readonly changedAtMs: number;
				readonly contents: string;
				readonly deviceId: number;
				readonly inode: number;
				readonly mode: number;
				readonly modifiedAtMs: number;
				readonly ownerGid: number;
				readonly ownerUid: number;
				readonly size: number;
			}
		>
	>;
}

async function captureAuthoredConfigurationTreeSnapshot(
	directoryPath: string,
): Promise<AuthoredConfigurationTreeSnapshot> {
	const directoryEntries = (await readdir(directoryPath)).toSorted();
	const directoryStatus = await stat(directoryPath);
	const fileEntries = await Promise.all(
		directoryEntries.map(async (fileName) => {
			const filePath = path.join(directoryPath, fileName);
			const [contents, fileStatus] = await Promise.all([
				readFile(filePath, 'utf8'),
				stat(filePath),
			]);
			return [
				fileName,
				{
					changedAtMs: fileStatus.ctimeMs,
					contents,
					deviceId: fileStatus.dev,
					inode: fileStatus.ino,
					mode: fileStatus.mode & 0o777,
					modifiedAtMs: fileStatus.mtimeMs,
					ownerGid: fileStatus.gid,
					ownerUid: fileStatus.uid,
					size: fileStatus.size,
				},
			] as const;
		}),
	);
	return {
		directoryEntries,
		directoryMetadata: {
			changedAtMs: directoryStatus.ctimeMs,
			deviceId: directoryStatus.dev,
			inode: directoryStatus.ino,
			mode: directoryStatus.mode & 0o777,
			modifiedAtMs: directoryStatus.mtimeMs,
			ownerGid: directoryStatus.gid,
			ownerUid: directoryStatus.uid,
		},
		files: Object.fromEntries(fileEntries),
	};
}

function createZone(overrides?: CreateZoneOverrides): GatewayZoneConfig {
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

async function createZoneWithTemporaryConfig(
	overrides?: CreateZoneOverrides,
): Promise<GatewayZoneConfig> {
	const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-managed-boot-inputs-'));
	createdDirectories.push(tempDirectory);
	const configPath = path.join(tempDirectory, 'openclaw.json');
	await writeFile(configPath, '{}\n', 'utf8');
	return createZone({
		...overrides,
		gateway: {
			...overrides?.gateway,
			config: configPath,
		},
	});
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
		framework: {
			...createGatewayTelemetryProducerSafetyContract(),
			serviceName: gatewayFrameworkTelemetryServiceNames.openclaw,
			traces: true,
			metrics: true,
			logs: true,
			sampleRate: 1,
			flushIntervalMs: 10_000,
		},
		openclaw: {
			diagnosticsFlags: ['scheduler.debug'],
		},
		toolPortal: {
			...createGatewayTelemetryProducerSafetyContract(),
			serviceName: gatewayToolPortalTelemetryServiceName,
			traces: false,
			metrics: false,
			logs: false,
			sampleRate: 0,
			flushIntervalMs: 1_000,
		},
	};
}

describe('openclawLifecycle', () => {
	it('owns its token-backed interactive SSH session contract', () => {
		expect(openclawLifecycle.interactiveSsh.buildSession({ requestAllSecrets: false })).toEqual({
			remoteShellCommand:
				"bash -lc 'source /etc/profile.d/openclaw-env.sh && set -a && . /run/agent-vm/managed-gateway-environment/openclaw-gateway-token.environment.sh && set +a && exec bash -l'",
			requireSecretEnvironmentEnabled: true,
			secretEnvironment: 'gateway-token',
		});
		expect(openclawLifecycle.interactiveSsh.buildSession({ requestAllSecrets: true })).toEqual({
			remoteShellCommand:
				"bash -lc 'set -a && . /run/agent-vm/managed-gateway-environment/openclaw-all-secrets.environment.sh && set +a && source /etc/profile.d/openclaw-env.sh && exec bash -l'",
			requireSecretEnvironmentEnabled: true,
			secretEnvironment: 'all-secrets',
		});
	});

	describe('authConfig', () => {
		it('provides a list-providers command', () => {
			expect(openclawLifecycle.authConfig).toBeDefined();
			expect(openclawLifecycle.authConfig?.listProvidersCommand).toBe(
				'openclaw models auth list --format plain 2>/dev/null || echo ""',
			);
		});

		it('builds effective auth and protected service inputs from the default gateway token secret', async () => {
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

			const bootInputs = await openclawLifecycle.buildFrameworkServiceBootInputs({
				zone,
				resolvedSecrets: {
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
					DISCORD_BOT_TOKEN: 'discord-token',
				},
			});
			expect(bootInputs.environment).toMatchObject({
				DISCORD_BOT_TOKEN: 'discord-token',
				OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
			});
			expect(bootInputs.configuration).toMatchObject({
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
			expect(JSON.stringify(bootInputs.configuration)).not.toContain('gateway-token');
		});

		it('builds effective auth and protected service inputs from the configured control auth secret', async () => {
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

			const bootInputs = await openclawLifecycle.buildFrameworkServiceBootInputs({
				zone,
				resolvedSecrets: {
					CUSTOM_GATEWAY_TOKEN: 'custom-gateway-token',
				},
			});
			expect(bootInputs.environment.CUSTOM_GATEWAY_TOKEN).toBe('custom-gateway-token');
			expect(bootInputs.environment.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
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
		it('keeps raw secrets service-scoped while preserving VM-wide mediation', async () => {
			const zone = await createZoneWithTemporaryConfig();
			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				zoneRuntimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 3,
				},
				zone,
			});
			expect(vmRequirements.mounts).not.toHaveProperty('/run/agent-vm/openclaw-process-supervisor');

			expect(vmRequirements.environment.DISCORD_BOT_TOKEN).toBeUndefined();
			expect(vmRequirements.environment.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
			expect(vmRequirements.environment.PERPLEXITY_API_KEY).toBeUndefined();
			expect(vmRequirements.mediatedSecrets.PERPLEXITY_API_KEY).toEqual({
				hosts: ['api.perplexity.ai'],
				value: 'perplexity-token',
			});
			const bootInputs = await openclawLifecycle.buildFrameworkServiceBootInputs({
				resolvedSecrets,
				zone,
			});
			expect(bootInputs.environment.DISCORD_BOT_TOKEN).toBe('discord-token');
			expect(bootInputs.environment.OPENCLAW_GATEWAY_TOKEN).toBe("gateway'token");
			expect(bootInputs.environment.PERPLEXITY_API_KEY).toBeUndefined();
		});

		it('preserves shell-sensitive framework secrets as protected data values', async () => {
			const zone = await createZoneWithTemporaryConfig();
			const gatewayToken = "gateway' $ ` token";
			const discordToken = "discord' $ ` token";

			const bootInputs = await openclawLifecycle.buildFrameworkServiceBootInputs({
				resolvedSecrets: {
					...resolvedSecrets,
					DISCORD_BOT_TOKEN: discordToken,
					OPENCLAW_GATEWAY_TOKEN: gatewayToken,
				},
				zone,
			});

			expect(bootInputs.environment.DISCORD_BOT_TOKEN).toBe(discordToken);
			expect(bootInputs.environment.OPENCLAW_GATEWAY_TOKEN).toBe(gatewayToken);
			expect(Object.isFrozen(bootInputs.environment)).toBe(true);
		});

		it('rejects authored env secrets that are not explicit raw-env exceptions', () => {
			expect(() =>
				openclawLifecycle.buildVmRequirements({
					controllerPort: 18800,
					gatewayCacheDir: '/host/cache/gateways/shravan',
					projectNamespace: 'claw-tests-a1b2c3d4',
					resolvedSecrets,
					zoneRuntimeDir: '/host/runtime',
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
					zoneRuntimeDir: '/host/runtime',
					tcpPool: {
						basePort: 19000,
						size: 3,
					},
					zone,
				}),
			).toThrow(/OPENCLAW_DIAGNOSTICS/u);
		});

		it('materializes explicitly allowlisted runtime environment only for the framework service', async () => {
			const zone = await createZoneWithTemporaryConfig({
				gateway: {
					rawEnvSecrets: ['DISCORD_BOT_TOKEN', 'OPENCLAW_TEST_RUNTIME_SECRET'],
				},
				runtimeEnvironment: {
					OPENCLAW_TEST_RUNTIME_SECRET: 'runtime-test-secret',
				},
			});
			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				zoneRuntimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 3,
				},
				zone,
			});

			expect(vmRequirements.environment.OPENCLAW_TEST_RUNTIME_SECRET).toBeUndefined();
			expect(vmRequirements.mediatedSecrets.OPENCLAW_TEST_RUNTIME_SECRET).toBeUndefined();
			const bootInputs = await openclawLifecycle.buildFrameworkServiceBootInputs({
				resolvedSecrets,
				zone,
			});
			expect(bootInputs.environment.OPENCLAW_TEST_RUNTIME_SECRET).toBe('runtime-test-secret');
		});

		it('materializes controller-owned OpenTelemetry resource attributes for observable frameworks', async () => {
			const resourceAttributes =
				'dev.repo.hash=0123456789abcdef,dev.worktree.hash=fedcba9876543210';
			const zone = await createZoneWithTemporaryConfig({
				observability: createObservabilityConfig(),
				runtimeEnvironment: {
					OTEL_RESOURCE_ATTRIBUTES: resourceAttributes,
				},
			});

			const bootInputs = await openclawLifecycle.buildFrameworkServiceBootInputs({
				resolvedSecrets,
				zone,
			});

			expect(bootInputs.environment.OTEL_RESOURCE_ATTRIBUTES).toBe(resourceAttributes);
		});

		it('rejects OpenTelemetry resource attributes when framework observability is disabled', async () => {
			const zone = await createZoneWithTemporaryConfig({
				runtimeEnvironment: {
					OTEL_RESOURCE_ATTRIBUTES: 'dev.repo.hash=0123456789abcdef',
				},
			});

			await expect(
				openclawLifecycle.buildFrameworkServiceBootInputs({ resolvedSecrets, zone }),
			).rejects.toThrow(/OTEL_RESOURCE_ATTRIBUTES/u);
		});

		it('materializes controller-owned private environment only for the framework service', async () => {
			const zone = await createZoneWithTemporaryConfig({
				runtimePrivateEnvironment: {
					[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV]: 'private-proof-key',
				},
			});
			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				zoneRuntimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 3,
				},
				zone,
			});

			expect(
				vmRequirements.environment[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV],
			).toBeUndefined();
			expect(
				vmRequirements.mediatedSecrets[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV],
			).toBeUndefined();
			const bootInputs = await openclawLifecycle.buildFrameworkServiceBootInputs({
				resolvedSecrets,
				zone,
			});
			expect(bootInputs.environment[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV]).toBe(
				'private-proof-key',
			);
		});

		it('rejects user runtime environment that collides with controller-owned private names', async () => {
			const zone = await createZoneWithTemporaryConfig({
				gateway: {
					rawEnvSecrets: ['DISCORD_BOT_TOKEN', GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV],
				},
				runtimeEnvironment: {
					[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV]: 'user-proof-key',
				},
			});
			await expect(
				openclawLifecycle.buildFrameworkServiceBootInputs({ resolvedSecrets, zone }),
			).rejects.toThrow(/collides with a controller-owned private environment variable/u);
		});

		it('injects generated runtime mediated secrets without authored zone secret config entries', () => {
			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				zoneRuntimeDir: '/host/runtime',
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
					zoneRuntimeDir: '/host/runtime',
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

		it('keeps the image and framework-owned mounts free of service-account identity projection', async () => {
			const dockerfilePath = path.resolve(
				path.dirname(fileURLToPath(import.meta.url)),
				'../../../docker/base-images/openclaw-gateway/Dockerfile',
			);
			const dockerfile = await readFile(dockerfilePath, 'utf8');
			expect(dockerfile).not.toMatch(/\b(?:groupadd|useradd)\b[^\n]*\bopenclaw\b/u);
			expect(dockerfile).not.toMatch(/\bchown\b[^\n]*\bopenclaw(?::openclaw)?\b/u);

			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				zoneRuntimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 2,
				},
				zone: createZone(),
			});
			const frameworkOwnedMountPaths = [
				'/agent-vm/logs',
				'/home/openclaw/.openclaw/cache',
				'/home/openclaw/.openclaw/state',
				'/zone',
			] as const;
			for (const mountPath of frameworkOwnedMountPaths) {
				expect(Object.keys(vmRequirements.mounts[mountPath] ?? {}).toSorted()).toEqual([
					'access',
					'hostPath',
					'kind',
				]);
			}
		});

		it('builds the expected OpenClaw environment, mounts, and tcp hosts', () => {
			vi.stubEnv('PATH', '/host-only/bin');
			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				zoneRuntimeDir: '/host/runtime',
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
			expect(vmRequirements.mounts['/home/openclaw/.openclaw/config']).toBeUndefined();
			expect(vmRequirements.mounts['/home/openclaw/.openclaw/cache']).toEqual({
				access: 'read-write',
				hostPath: '/host/cache/gateways/shravan',
				kind: 'host-directory',
			});
			expect(vmRequirements.mounts['/home/openclaw/.openclaw/state']).toEqual({
				access: 'read-write',
				hostPath: '/host/state/shravan',
				kind: 'host-directory',
			});
			expect(vmRequirements.mounts['/agent-vm/logs']).toEqual({
				access: 'read-write',
				hostPath: '/host/runtime/logs',
				kind: 'host-directory',
			});
			expect(vmRequirements.mounts['/zone']).toEqual({
				access: 'read-write',
				hostPath: '/host/zone-files/shravan',
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

		it('excludes host authority paths from managed inputs without mutating authored configuration', async () => {
			const temporaryDirectory = await mkdtemp(
				path.join(os.tmpdir(), 'openclaw-lifecycle-host-authority-exclusion-'),
			);
			createdDirectories.push(temporaryDirectory);
			const authoredConfigurationDirectory = path.join(
				temporaryDirectory,
				'authored-configuration',
			);
			await mkdir(authoredConfigurationDirectory, { mode: 0o750, recursive: true });
			const authoredConfigurationPath = path.join(authoredConfigurationDirectory, 'openclaw.json');
			await Promise.all([
				writeFile(
					authoredConfigurationPath,
					JSON.stringify({ gateway: { bind: 'loopback' } }, null, 2),
					{ encoding: 'utf8', mode: 0o640 },
				),
				writeFile(
					path.join(authoredConfigurationDirectory, 'operator-owned-note.txt'),
					'operator-owned\n',
					{ encoding: 'utf8', mode: 0o600 },
				),
			]);
			const controllerStateDirectory = path.join(temporaryDirectory, 'controller-state-authority');
			const zone = createZone({
				gateway: {
					config: authoredConfigurationPath,
					stateDir: path.join(temporaryDirectory, 'gateway-state'),
					zoneFilesDir: path.join(temporaryDirectory, 'zone-files'),
				},
				withoutAuthProfilesRef: true,
			});
			const beforeSnapshot = await captureAuthoredConfigurationTreeSnapshot(
				authoredConfigurationDirectory,
			);

			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18_800,
				gatewayCacheDir: path.join(temporaryDirectory, 'gateway-cache'),
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				zoneRuntimeDir: path.join(temporaryDirectory, 'runtime'),
				tcpPool: { basePort: 19_000, size: 2 },
				zone,
			});
			const frameworkBootInputs = await openclawLifecycle.buildFrameworkServiceBootInputs({
				resolvedSecrets,
				zone,
			});
			const afterSnapshot = await captureAuthoredConfigurationTreeSnapshot(
				authoredConfigurationDirectory,
			);
			const managedInputInventory = JSON.stringify({
				frameworkBootInputs,
				vmEnvironment: vmRequirements.environment,
				vmMounts: vmRequirements.mounts,
			});

			expect(vmRequirements.mounts).toEqual({
				'/agent-vm/logs': {
					access: 'read-write',
					hostPath: path.join(temporaryDirectory, 'runtime', 'logs'),
					kind: 'host-directory',
				},
				'/home/openclaw/.openclaw/cache': {
					access: 'read-write',
					hostPath: path.join(temporaryDirectory, 'gateway-cache'),
					kind: 'host-directory',
				},
				'/home/openclaw/.openclaw/state': {
					access: 'read-write',
					hostPath: path.join(temporaryDirectory, 'gateway-state'),
					kind: 'host-directory',
				},
				'/zone': {
					access: 'read-write',
					hostPath: path.join(temporaryDirectory, 'zone-files'),
					kind: 'host-directory',
				},
			});
			expect(managedInputInventory).not.toContain(controllerStateDirectory);
			expect(managedInputInventory).not.toContain(authoredConfigurationDirectory);
			expect(managedInputInventory).not.toContain(authoredConfigurationPath);
			expect(afterSnapshot).toEqual(beforeSnapshot);
		});

		it('does not mount legacy Tool Portal effective config directories', () => {
			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				zoneRuntimeDir: '/host/runtime',
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

			expect(
				vmRequirements.mounts['/home/openclaw/.openclaw/cache/tool-portal-effective'],
			).toBeUndefined();
		});

		it('routes collector-mode observability through mediated HTTP instead of raw collector tcp hosts', () => {
			const vmRequirements = openclawLifecycle.buildVmRequirements({
				controllerPort: 18800,
				gatewayCacheDir: '/host/cache/gateways/shravan',
				projectNamespace: 'claw-tests-a1b2c3d4',
				resolvedSecrets,
				zoneRuntimeDir: '/host/runtime',
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
				zoneRuntimeDir: '/host/runtime',
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
				zoneRuntimeDir: '/host/runtime',
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
				zoneRuntimeDir: '/host/runtime',
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
				zoneRuntimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 2,
				},
				zone: createZone(),
			});

			expect(vmRequirements.sshEgress).toBeUndefined();
		});

		it('keeps VM-wide NODE_OPTIONS structural and preserves authored flags in service inputs', async () => {
			// Regression test for the merge-order bug surfaced in PR #93
			// review: a zone secret named NODE_OPTIONS must NOT drop our
			// forced flags, because Happy Eyeballs would race the
			// synthetic AAAA again.
			const baseZone = await createZoneWithTemporaryConfig({
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
				zoneRuntimeDir: '/host/runtime',
				tcpPool: {
					basePort: 19000,
					size: 2,
				},
				zone: zoneWithNodeOptions,
			});

			// VM-wide inputs carry only the safe baseline.
			expect(vmRequirements.environment.NODE_OPTIONS).toBe(
				'--dns-result-order=ipv4first --no-network-family-autoselection',
			);
			const bootInputs = await openclawLifecycle.buildFrameworkServiceBootInputs({
				resolvedSecrets: {
					...resolvedSecrets,
					NODE_OPTIONS: '--inspect=0.0.0.0:9229',
				},
				zone: zoneWithNodeOptions,
			});
			expect(bootInputs.environment.NODE_OPTIONS).toBe(
				'--dns-result-order=ipv4first --no-network-family-autoselection --inspect=0.0.0.0:9229',
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
				config: { controlSession: { bootId: 'stale-boot' } },
				error: /Gondolin plugin config does not accept field 'controlSession'/u,
				name: 'controlSession',
			},
			{
				config: { profileId: 'gpu' },
				error: /Gondolin plugin config does not accept field 'profileId'/u,
				name: 'profileId',
			},
			{
				config: {
					toolPortal: {
						configDir: '/home/openclaw/.openclaw/cache/tool-portal-effective',
					},
				},
				error: /Gondolin plugin toolPortal does not accept field 'configDir'/u,
				name: 'toolPortal.configDir',
			},
		] satisfies readonly {
			readonly config: Record<string, unknown>;
			readonly error: RegExp;
			readonly name: string;
		}[])('rejects removed Gondolin $name in managed OpenClaw config', async (testCase) => {
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
		});

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

		it.each([true, null, 'portal', ['portal']] satisfies readonly unknown[])(
			'rejects malformed managed Gondolin toolPortal config before writing the effective config',
			async (value) => {
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
											toolPortal: value,
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
					'Gondolin plugin toolPortal must be an object when present.',
				);
			},
		);

		it.each([
			{
				authoredConfig: {
					toolPortal: {
						configDir: '/home/openclaw/.openclaw/cache/tool-portal-effective',
					},
					zoneId: 'shravan',
				},
				error: /Gondolin plugin toolPortal does not accept field 'configDir'/u,
				name: 'toolPortal.configDir',
				runtimeConfig: {
					toolPortal: createManagedToolPortalPluginConfig(),
				},
			},
			{
				authoredConfig: {
					toolPortal: {
						...createManagedToolPortalPluginConfig(),
						attachment: {
							attachmentGeneration: 0,
							clientKind: 'openclaw-managed-plugin',
							configuredAgentIds: ['agent-a', 'agent-b'],
							frameworkEpoch: 'openclaw-epoch-4',
							gatewayEpoch: 'gateway-epoch-3',
							protocolVersion: 1,
							runtimeEpoch: 'runtime-epoch-5',
							schemaVersion: 1,
						},
					},
					zoneId: 'shravan',
				},
				error: /Gondolin plugin toolPortal attachment is invalid/u,
				name: 'toolPortal.attachment',
				runtimeConfig: {
					toolPortal: createManagedToolPortalPluginConfig(),
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
			{
				error: /Gondolin plugin toolPortal requires attachment/u,
				name: 'missing attachment',
				runtimeConfig: {
					toolPortal: {
						agentProjections: {
							'agent-a': {
								agentId: 'agent-a',
								frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
								profileAssignmentRevision: 'profile-revision-a',
								toolPortalNamespaceNames: ['filesystem', 'github'],
								toolPortalProfileId: 'profile-a',
							},
						},
					},
				},
			},
			{
				error: /agentProjections identity is invalid/u,
				name: 'overlong projection identity',
				runtimeConfig: {
					toolPortal: {
						...createManagedToolPortalPluginConfig(),
						agentProjections: {
							'agent-a': {
								agentId: 'agent-a',
								frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
								profileAssignmentRevision: 'x'.repeat(257),
								toolPortalProfileId: 'profile-a',
							},
							'agent-b': {
								agentId: 'agent-b',
								frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
								profileAssignmentRevision: 'profile-revision-b',
								toolPortalProfileId: 'profile-b',
							},
						},
					},
				},
			},
			{
				error: /agentProjections identity is invalid/u,
				name: 'reverse Unicode code-point namespace order',
				runtimeConfig: {
					toolPortal: {
						...createManagedToolPortalPluginConfig(),
						agentProjections: {
							'agent-a': {
								agentId: 'agent-a',
								frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
								profileAssignmentRevision: 'profile-revision-a',
								toolPortalNamespaceNames: ['\u{10000}', '\uE000'],
								toolPortalProfileId: 'profile-a',
							},
							'agent-b': {
								agentId: 'agent-b',
								frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
								profileAssignmentRevision: 'profile-revision-b',
								toolPortalNamespaceNames: ['filesystem', 'github'],
								toolPortalProfileId: 'profile-b',
							},
						},
					},
				},
			},
			{
				error: /does not accept field 'selfRoot'/u,
				name: 'retired selfRoot path authority',
				runtimeConfig: {
					toolPortal: {
						...createManagedToolPortalPluginConfig(),
						agentProjections: {
							'agent-a': {
								agentId: 'agent-a',
								frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
								profileAssignmentRevision: 'profile-revision-a',
								selfRoot: '/zone/agents/agent-a/self',
								toolPortalProfileId: 'profile-a',
							},
							'agent-b': {
								agentId: 'agent-b',
								frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
								profileAssignmentRevision: 'profile-revision-b',
								toolPortalProfileId: 'profile-b',
							},
						},
					},
				},
			},
			{
				error: /does not accept field 'workRoot'/u,
				name: 'retired workRoot path authority',
				runtimeConfig: {
					toolPortal: {
						...createManagedToolPortalPluginConfig(),
						agentProjections: {
							'agent-a': {
								agentId: 'agent-a',
								frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
								profileAssignmentRevision: 'profile-revision-a',
								toolPortalProfileId: 'profile-a',
								workRoot: '/zone/agents/agent-a/work',
							},
							'agent-b': {
								agentId: 'agent-b',
								frameworkIdentity: { agentId: 'agent-b', kind: 'openclaw' },
								profileAssignmentRevision: 'profile-revision-b',
								toolPortalProfileId: 'profile-b',
							},
						},
					},
				},
			},
			{
				error: /Gondolin plugin toolPortal agent sets must match exactly/u,
				name: 'mismatched multi-agent projections',
				runtimeConfig: {
					toolPortal: {
						...createManagedToolPortalPluginConfig(),
						agentProjections: {
							'agent-a': {
								agentId: 'agent-a',
								frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
								profileAssignmentRevision: 'profile-revision-a',
								toolPortalNamespaceNames: ['filesystem', 'github'],
								toolPortalProfileId: 'profile-a',
							},
						},
					},
				},
			},
		] satisfies readonly {
			readonly error: RegExp;
			readonly name: string;
			readonly runtimeConfig: Readonly<Record<string, unknown>>;
		}[])(
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

		it('materializes the exact multi-agent thin-adapter plugin config', async () => {
			const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'openclaw-lifecycle-adapter-'));
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
						toolPortal: createManagedToolPortalPluginConfig(),
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

			await openclawLifecycle.prepareHostState?.(zone, secretResolver);

			const effectiveOpenClawConfigContent = await readFile(
				path.join(zone.gateway.stateDir, 'effective-openclaw.json'),
				'utf8',
			);
			const effectiveOpenClawConfig = JSON.parse(effectiveOpenClawConfigContent) as {
				readonly plugins: {
					readonly entries: {
						readonly gondolin: { readonly config: Readonly<Record<string, unknown>> };
					};
				};
			};
			expect(effectiveOpenClawConfig.plugins.entries.gondolin.config).toEqual({
				toolPortal: createManagedToolPortalPluginConfig(),
				zoneId: 'shravan',
			});
			expect(effectiveOpenClawConfigContent).not.toContain('controlSession');
			expect(effectiveOpenClawConfigContent).not.toContain('controllerUrl');
			expect(effectiveOpenClawConfigContent).not.toContain('zoneGit');
			expect(effectiveOpenClawConfigContent).not.toContain('configDir');
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
					serviceName: 'agent-vm-openclaw',
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
