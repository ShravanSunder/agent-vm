import type { GatewayZoneConfig } from '@agent-vm/gateway-lifecycle';
import { describe, expect, it } from 'vitest';

import {
	buildHermesFrameworkServiceBootMetadata,
	hermesLifecycle,
	HERMES_AGENT_DISTRIBUTION,
	isReservedHermesProfileProjectionSourceName,
	isReservedHermesProfileProjectionTargetName,
	renderHermesManagedImageRecipe,
} from './index.js';

function createHermesZone(toolPortalMaterial: unknown): GatewayZoneConfig {
	return {
		id: 'hermes-zone',
		gateway: {
			config: '/deployment/config/hermes.yaml',
			cpus: 2,
			profileSecretProjectionsByAgent: {
				researcher: {
					API_SERVER_KEY: 'API_SERVER_KEY_RESEARCHER',
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_RESEARCHER',
					OPENROUTER_API_KEY: 'OPENROUTER_API_KEY_RESEARCHER',
				},
			},
			memory: '4G',
			port: 8642,
			profilesByAgent: { researcher: 'researcher' },
			runtimeRootfsSize: '16G',
			ssh: { secretEnv: 'never' },
			stateDir: '/deployment/state/hermes',
			type: 'hermes',
		},
		runtimePluginConfigs: {
			gondolin: { toolPortal: toolPortalMaterial },
		},
		secrets: {
			API_SERVER_KEY: {
				audience: 'gateway',
				envVar: 'HERMES_API_SERVER_KEY',
				injection: 'env',
				source: 'environment',
			},
			API_SERVER_KEY_RESEARCHER: {
				audience: 'gateway',
				envVar: 'API_SERVER_KEY_RESEARCHER',
				injection: 'env',
				source: 'environment',
			},
			DISCORD_BOT_TOKEN_RESEARCHER: {
				audience: 'gateway',
				envVar: 'DISCORD_BOT_TOKEN_RESEARCHER',
				injection: 'env',
				source: 'environment',
			},
			OPENROUTER_API_KEY_RESEARCHER: {
				audience: 'gateway',
				envVar: 'OPENROUTER_API_KEY_RESEARCHER',
				hosts: ['openrouter.ai'],
				injection: 'http-mediation',
				source: 'environment',
			},
		},
		egressHosts: [],
	} as unknown as GatewayZoneConfig;
}

function createHermesAdapterMaterial(): Readonly<Record<string, unknown>> {
	return Object.freeze({
		agentProjections: Object.freeze({
			researcher: Object.freeze({
				agentId: 'researcher',
				frameworkIdentity: Object.freeze({ kind: 'hermes', profileName: 'researcher' }),
				profileAssignmentRevision: 'revision-researcher',
				toolPortalProfileId: 'profile-researcher',
			}),
		}),
		attachment: Object.freeze({
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: Object.freeze(['researcher']),
			frameworkEpoch: 'framework-epoch',
			gatewayEpoch: 'gateway-epoch',
			protocolVersion: 1,
			projectionCohortDigest: `projection-cohort:${'a'.repeat(64)}`,
			runtimeEpoch: 'runtime-epoch',
			schemaVersion: 1,
		}),
	});
}

describe('managed Hermes package contracts', () => {
	it('wires host-authoritative profile preflight and preparation hooks', () => {
		expect(hermesLifecycle.preflightHostState).toBeTypeOf('function');
		expect(hermesLifecycle.prepareHostState).toBeTypeOf('function');
	});

	it('owns its framework-ready interactive SSH session contract', () => {
		expect(hermesLifecycle.interactiveSsh.buildSession({ requestAllSecrets: false })).toEqual({
			remoteShellCommand: "bash -lc 'source /etc/profile.d/hermes-env.sh && exec bash -l'",
			requireSecretEnvironmentEnabled: false,
			secretEnvironment: 'default',
		});
		expect(() => hermesLifecycle.interactiveSsh.buildSession({ requestAllSecrets: true })).toThrow(
			'--all-secrets is supported only for OpenClaw zones.',
		);
	});

	it('pins the researched Hermes Python distribution and source revision', () => {
		expect(HERMES_AGENT_DISTRIBUTION).toEqual({
			containerImage:
				'docker.io/nousresearch/hermes-agent@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e',
			distributionName: 'hermes-agent',
			projectVersion: '0.20.0',
			pythonRequirement: '>=3.11,<3.14',
			sourceRepository: 'https://github.com/NousResearch/hermes-agent.git',
			sourceRevision: '3c27eb6234bf91b8ceee9e9071591b31e9b148cb',
		});
	});

	it('owns fixed profile projection source and target name defenses', () => {
		for (const sourceName of [
			'AGENT_VM_HERMES_MANAGED_CONFIG_PATH',
			'API_SERVER_KEY',
			'GATEWAY_MULTIPLEX_PROFILES',
			'HERMES_ALLOW_ROOT_GATEWAY',
			'HERMES_HOME',
			'HOME',
			'LD_AUDIT',
			'LD_PRELOAD',
			'OTEL_SERVICE_NAME',
			'PATH',
			'PYTHONIOENCODING',
			'PYTHONWARNINGS',
			'REQUESTS_CA_BUNDLE',
			'SSL_CERT_FILE',
			'TMPDIR',
		] as const) {
			expect(isReservedHermesProfileProjectionSourceName(sourceName)).toBe(true);
		}
		for (const targetName of [
			'HERMES_ALLOW_ROOT_GATEWAY',
			'HERMES_HOME',
			'HERMES_KANBAN_DB',
			'HERMES_TELEGRAM_BATCH_DELAY',
			'LD_AUDIT',
			'LD_PRELOAD',
			'PATH',
			'PYTHONIOENCODING',
			'PYTHONWARNINGS',
			'REQUESTS_CA_BUNDLE',
			'SSL_CERT_FILE',
			'TERMINAL_BACKEND',
		] as const) {
			expect(isReservedHermesProfileProjectionTargetName(targetName)).toBe(true);
		}
		expect(isReservedHermesProfileProjectionTargetName('API_SERVER_KEY')).toBe(false);
		expect(isReservedHermesProfileProjectionSourceName('OPENROUTER_API_KEY_SOURCE')).toBe(false);
		expect(isReservedHermesProfileProjectionTargetName('OPENROUTER_API_KEY')).toBe(false);
	});

	it('builds closed Hermes boot metadata without executable or supervisor authority', () => {
		const metadata = buildHermesFrameworkServiceBootMetadata(
			createHermesZone(createHermesAdapterMaterial()),
		);

		expect(metadata).toMatchObject({
			bootEntry: 'hermes-gateway',
			environmentInputPath: '/run/agent-vm/managed-gateway-environment/framework.environment.sh',
			framework: 'hermes',
			role: 'framework-service',
		});
		expect(metadata).not.toHaveProperty('argv');
		expect(metadata).not.toHaveProperty('executable');
		expect(metadata).not.toHaveProperty('supervisor');
	});

	it('rejects OpenClaw lifecycle input instead of accepting cross-framework material', () => {
		const openClawZone = {
			...createHermesZone(createHermesAdapterMaterial()),
			gateway: {
				...createHermesZone(createHermesAdapterMaterial()).gateway,
				type: 'openclaw',
			},
		} as GatewayZoneConfig;

		expect(() => buildHermesFrameworkServiceBootMetadata(openClawZone)).toThrow(
			/Hermes lifecycle cannot build gateway type 'openclaw'/u,
		);
	});

	it('serializes the exact immutable controller material and managed environment', async () => {
		const material = createHermesAdapterMaterial();
		const zone = {
			...createHermesZone(material),
			observability: {
				collector: {
					host: 'otel-collector.observability.vm.host',
					grpcPort: 4317,
					httpPort: 4318,
					targetGrpcPort: 4317,
					targetHost: '127.0.0.1',
					targetHttpPort: 4318,
				},
				framework: {
					admissionLimits: {
						maxExportBatchRecords: 64,
						maxQueuedRecordsPerSignal: 256,
						maxRecordBytes: 65_536,
					},
					flushIntervalMs: 1000,
					logs: true,
					metrics: true,
					sampleRate: 1,
					serviceName: 'agent-vm-hermes',
					sourcePolicy: { admitBaggage: false, captureContent: false },
					traces: true,
				},
				mode: 'collector' as const,
				toolPortal: {
					admissionLimits: {
						maxExportBatchRecords: 64,
						maxQueuedRecordsPerSignal: 256,
						maxRecordBytes: 65_536,
					},
					flushIntervalMs: 1000,
					logs: true,
					metrics: true,
					sampleRate: 1,
					serviceName: 'agent-vm-tool-portal',
					sourcePolicy: { admitBaggage: false, captureContent: false },
					traces: true,
				},
			},
			runtimeEnvironment: {
				OTEL_RESOURCE_ATTRIBUTES:
					'dev.repo.hash=0123456789abcdef,dev.worktree.hash=fedcba9876543210',
			},
		} satisfies GatewayZoneConfig;

		const bootInputs = await hermesLifecycle.buildFrameworkServiceBootInputs({
			resolvedSecrets: {
				API_SERVER_KEY: 'test-only-key',
				API_SERVER_KEY_RESEARCHER: 'researcher-profile-test-only-key',
				DISCORD_BOT_TOKEN_RESEARCHER: 'discord-test-only-key',
				OPENROUTER_API_KEY_RESEARCHER: 'provider-test-only-key',
			},
			zone,
		});

		expect(bootInputs.configuration).toEqual({
			...material,
			profileEnvironmentSourceNamesByProfile: {
				researcher: {
					API_SERVER_KEY: 'API_SERVER_KEY_RESEARCHER',
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_RESEARCHER',
					OPENROUTER_API_KEY: 'OPENROUTER_API_KEY_RESEARCHER',
				},
			},
		});
		expect(bootInputs).toMatchObject({
			kind: 'hermes-managed-scope',
		});
		expect(bootInputs).not.toHaveProperty('managedConfigurationSource');
		expect(bootInputs.environment).toMatchObject({
			AGENT_VM_HERMES_MANAGED_CONFIG_PATH: '/run/agent-vm/managed-gateway/framework-service.json',
			API_SERVER_ENABLED: 'true',
			API_SERVER_KEY: 'test-only-key',
			DISCORD_BOT_TOKEN_RESEARCHER: 'discord-test-only-key',
			GATEWAY_MULTIPLEX_PROFILES: 'true',
			HERMES_ALLOW_ROOT_GATEWAY: '1',
			HERMES_HOME: '/home/hermes/.hermes',
			OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: '64',
			OTEL_BLRP_MAX_QUEUE_SIZE: '256',
			OTEL_BLRP_SCHEDULE_DELAY: '1000',
			OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '64',
			OTEL_BSP_MAX_QUEUE_SIZE: '256',
			OTEL_BSP_SCHEDULE_DELAY: '1000',
			OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector.observability.vm.host:4318',
			OTEL_LOGS_EXPORTER: 'otlp',
			OTEL_METRIC_EXPORT_INTERVAL: '1000',
			OTEL_METRICS_EXPORTER: 'otlp',
			OTEL_RESOURCE_ATTRIBUTES: 'dev.repo.hash=0123456789abcdef,dev.worktree.hash=fedcba9876543210',
			OTEL_SERVICE_NAME: 'agent-vm-hermes',
			OTEL_TRACES_EXPORTER: 'otlp',
			OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
			OTEL_TRACES_SAMPLER_ARG: '1',
			AGENT_VM_HERMES_OTEL_MAX_INFLIGHT_OBSERVATIONS: '256',
			AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES: '65536',
			REQUESTS_CA_BUNDLE: '/run/gondolin/ca-certificates.crt',
			SSL_CERT_FILE: '/run/gondolin/ca-certificates.crt',
		});
		expect(bootInputs.environment).not.toHaveProperty('HERMES_MANAGED');
		expect(bootInputs.environment).not.toHaveProperty('HERMES_MANAGED_DIR');
	});

	it('disables each Hermes telemetry signal independently through exact exporter selectors', async () => {
		const signalCases = [
			{
				frameworkSignals: { logs: false, metrics: true, traces: true },
				selectors: {
					OTEL_LOGS_EXPORTER: 'none',
					OTEL_METRICS_EXPORTER: 'otlp',
					OTEL_TRACES_EXPORTER: 'otlp',
				},
			},
			{
				frameworkSignals: { logs: true, metrics: false, traces: true },
				selectors: {
					OTEL_LOGS_EXPORTER: 'otlp',
					OTEL_METRICS_EXPORTER: 'none',
					OTEL_TRACES_EXPORTER: 'otlp',
				},
			},
			{
				frameworkSignals: { logs: true, metrics: true, traces: false },
				selectors: {
					OTEL_LOGS_EXPORTER: 'otlp',
					OTEL_METRICS_EXPORTER: 'otlp',
					OTEL_TRACES_EXPORTER: 'none',
				},
			},
		] as const;

		await Promise.all(
			signalCases.map(async (signalCase) => {
				const zone = {
					...createHermesZone(createHermesAdapterMaterial()),
					observability: {
						collector: {
							host: 'otel-collector.observability.vm.host',
							grpcPort: 4317,
							httpPort: 4318,
							targetGrpcPort: 4317,
							targetHost: '127.0.0.1',
							targetHttpPort: 4318,
						},
						framework: {
							admissionLimits: {
								maxExportBatchRecords: 64,
								maxQueuedRecordsPerSignal: 256,
								maxRecordBytes: 65_536,
							},
							flushIntervalMs: 1000,
							...signalCase.frameworkSignals,
							sampleRate: 1,
							serviceName: 'agent-vm-hermes',
							sourcePolicy: { admitBaggage: false, captureContent: false },
						},
						mode: 'collector' as const,
						toolPortal: {
							admissionLimits: {
								maxExportBatchRecords: 64,
								maxQueuedRecordsPerSignal: 256,
								maxRecordBytes: 65_536,
							},
							flushIntervalMs: 1000,
							logs: true,
							metrics: true,
							sampleRate: 1,
							serviceName: 'agent-vm-tool-portal',
							sourcePolicy: { admitBaggage: false, captureContent: false },
							traces: true,
						},
					},
				} satisfies GatewayZoneConfig;

				const bootInputs = await hermesLifecycle.buildFrameworkServiceBootInputs({
					resolvedSecrets: { API_SERVER_KEY: 'test-only-key' },
					zone,
				});

				expect(bootInputs.environment).toMatchObject(signalCase.selectors);
			}),
		);
	});

	it('rejects deployment-authored overrides of lifecycle-owned Hermes telemetry settings', async () => {
		await Promise.all(
			[
				'AGENT_VM_HERMES_OTEL_MAX_INFLIGHT_OBSERVATIONS',
				'AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES',
				'OTEL_LOGS_EXPORTER',
				'OTEL_METRICS_EXPORTER',
				'OTEL_RESOURCE_ATTRIBUTES',
				'OTEL_SDK_DISABLED',
				'OTEL_TRACES_EXPORTER',
			].map(async (environmentName) => {
				const baseZone = createHermesZone(createHermesAdapterMaterial());
				const zone = {
					...baseZone,
					secrets: {
						...baseZone.secrets,
						[environmentName]: {
							audience: 'gateway',
							envVar: environmentName,
							injection: 'env',
							source: 'environment',
						},
					},
				} satisfies GatewayZoneConfig;

				await expect(
					hermesLifecycle.buildFrameworkServiceBootInputs({
						resolvedSecrets: {
							API_SERVER_KEY: 'test-only-key',
							[environmentName]: 'deployment-authored-override',
						},
						zone,
					}),
				).rejects.toThrow(new RegExp(environmentName, 'u'));
			}),
		);
	});

	it('rejects non-controller runtime overrides of lifecycle-owned Hermes telemetry settings', async () => {
		await Promise.all(
			[
				'AGENT_VM_HERMES_OTEL_MAX_INFLIGHT_OBSERVATIONS',
				'AGENT_VM_HERMES_OTEL_MAX_RECORD_BYTES',
				'OTEL_LOGS_EXPORTER',
				'OTEL_METRICS_EXPORTER',
				'OTEL_RESOURCE_ATTRIBUTES',
				'OTEL_SDK_DISABLED',
				'OTEL_TRACES_EXPORTER',
			].map(async (environmentName) => {
				const zone = {
					...createHermesZone(createHermesAdapterMaterial()),
					runtimeEnvironment: { [environmentName]: 'deployment-authored-override' },
				} satisfies GatewayZoneConfig;

				await expect(
					hermesLifecycle.buildFrameworkServiceBootInputs({
						resolvedSecrets: { API_SERVER_KEY: 'test-only-key' },
						zone,
					}),
				).rejects.toThrow(new RegExp(environmentName, 'u'));
			}),
		);
	});

	it('mounts durable state with exact memory-only profile token files', () => {
		const baseZone = createHermesZone(createHermesAdapterMaterial());
		const baseHermesGateway = baseZone.gateway as Extract<
			GatewayZoneConfig['gateway'],
			{ readonly type: 'hermes' }
		>;
		const requirements = hermesLifecycle.buildVmRequirements({
			controllerPort: 7777,
			gatewayCacheDir: '/deployment/cache/hermes',
			projectNamespace: 'deployment-a',
			resolvedSecrets: {
				API_SERVER_KEY: 'test-only-key',
				API_SERVER_KEY_BETA: 'beta-profile-test-only-key',
				API_SERVER_KEY_RESEARCHER: 'researcher-profile-test-only-key',
				DISCORD_BOT_TOKEN_BETA: 'beta-discord-test-only-key',
				DISCORD_BOT_TOKEN_RESEARCHER: 'discord-test-only-key',
			},
			zoneRuntimeDir: '/deployment/runtime',
			tcpPool: { basePort: 22_000, size: 2 },
			zone: {
				...baseZone,
				secrets: {
					...baseZone.secrets,
					API_SERVER_KEY_BETA: {
						audience: 'gateway',
						envVar: 'API_SERVER_KEY_BETA',
						injection: 'env',
						source: 'environment',
					},
					DISCORD_BOT_TOKEN_BETA: {
						audience: 'gateway',
						envVar: 'DISCORD_BOT_TOKEN_BETA',
						injection: 'env',
						source: 'environment',
					},
				},
				gateway: {
					...baseHermesGateway,
					profilesByAgent: {
						beta: 'beta',
						researcher: 'researcher',
					},
					profileSecretProjectionsByAgent: {
						beta: {
							API_SERVER_KEY: 'API_SERVER_KEY_BETA',
							DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_BETA',
						},
						researcher: {
							API_SERVER_KEY: 'API_SERVER_KEY_RESEARCHER',
							DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_RESEARCHER',
							OPENROUTER_API_KEY: 'OPENROUTER_API_KEY_RESEARCHER',
						},
					},
				},
			},
		});

		expect(requirements.environment).not.toHaveProperty('API_SERVER_KEY');
		expect(requirements.environment).not.toHaveProperty('HERMES_ALLOW_ROOT_GATEWAY');
		expect(requirements.environment).toMatchObject({
			HERMES_HOME: '/home/hermes/.hermes',
		});
		expect(requirements.mounts).toEqual({
			'/etc/hermes': {
				access: 'read-only',
				hostPath: '/deployment/config',
				kind: 'host-directory',
			},
			'/agent-vm/logs': {
				access: 'read-write',
				hostPath: '/deployment/runtime/logs',
				kind: 'host-directory',
			},
			'/home/hermes/.cache': {
				access: 'read-write',
				hostPath: '/deployment/cache/hermes',
				kind: 'host-directory',
			},
			'/home/hermes/.hermes': {
				deny: [],
				hostPath: '/deployment/state/hermes',
				kind: 'shadow',
				temporaryFilesystems: ['/profiles/beta/.env', '/profiles/researcher/.env'],
			},
		});
		expect(requirements.mounts).not.toHaveProperty('/workspace');
		expect(requirements.tcpHosts).toEqual({
			'tool-0.vm.host:22': '127.0.0.1:22000',
			'tool-1.vm.host:22': '127.0.0.1:22001',
		});
	});

	it('protects generated framework environment names from runtime overrides', async () => {
		for (const environmentName of [
			'GATEWAY_MULTIPLEX_PROFILES',
			'HERMES_ALLOW_ROOT_GATEWAY',
			'HERMES_MANAGED_DIR',
		] as const) {
			const zone = {
				...createHermesZone(createHermesAdapterMaterial()),
				runtimeEnvironment: { [environmentName]: 'deployment-authored-override' },
			} satisfies GatewayZoneConfig;
			await expect(
				hermesLifecycle.buildFrameworkServiceBootInputs({
					resolvedSecrets: { API_SERVER_KEY: 'test-only-key' },
					zone,
				}),
			).rejects.toThrow(`cannot override '${environmentName}'`);
		}
	});

	it('rejects deployment-secret overrides of the fixed root gateway allowance', async () => {
		const baseZone = createHermesZone(createHermesAdapterMaterial());
		const zone = {
			...baseZone,
			secrets: {
				...baseZone.secrets,
				HERMES_ALLOW_ROOT_GATEWAY: {
					audience: 'gateway',
					envVar: 'HERMES_ALLOW_ROOT_GATEWAY',
					injection: 'env',
					source: 'environment',
				},
			},
		} satisfies GatewayZoneConfig;

		await expect(
			hermesLifecycle.buildFrameworkServiceBootInputs({
				resolvedSecrets: {
					API_SERVER_KEY: 'test-only-key',
					HERMES_ALLOW_ROOT_GATEWAY: 'deployment-authored-override',
				},
				zone,
			}),
		).rejects.toThrow("cannot override 'HERMES_ALLOW_ROOT_GATEWAY'");
	});

	it('rejects missing, malformed, and wrong-framework immutable input', async () => {
		await Promise.all(
			[
				undefined,
				{},
				{
					agentProjections: {},
					attachment: { clientKind: 'openclaw-managed-plugin' },
				},
			].map(async (toolPortalMaterial) => {
				await expect(
					hermesLifecycle.buildFrameworkServiceBootInputs({
						resolvedSecrets: { API_SERVER_KEY: 'test-only-key' },
						zone: createHermesZone(toolPortalMaterial),
					}),
				).rejects.toThrow(/Hermes|hermes-managed-plugin/u);
			}),
		);
	});

	it('renders the complete custom Hermes image recipe from explicit local artifacts', () => {
		const recipe = renderHermesManagedImageRecipe({
			artifactContext: {
				kind: 'local-artifact-context',
				gatewayRuntime: {
					executablePath:
						'/opt/agent-vm/local-packages/node_modules/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js',
					packageArchiveFiles: [
						'local-agent-vm/agent-vm-gateway-runtime-0.0.116.tgz',
						'local-agent-vm/agent-vm-tool-portal-0.0.116.tgz',
					],
					packageManifestFile: 'local-agent-vm/package.json',
				},
				pythonWheels: {
					agentPortalSdk: 'local-agent-vm/agent_vm_agent_portal_sdk-0.0.116-py3-none-any.whl',
					hermesAdapter: 'local-agent-vm/agent_vm_hermes_adapter-0.0.116-py3-none-any.whl',
				},
			},
			buildTarget: {
				architecture: 'x86_64',
				kind: 'gondolin-custom-dockerfile',
				ociImage: 'agent-vm-hermes:latest',
				rootfsSizeMb: 4096,
			},
		});

		expect(recipe.kind).toBe('hermes-managed-image-recipe');
		expect(recipe.baseImage).toBe(HERMES_AGENT_DISTRIBUTION.containerImage);
		expect(recipe.frameworkBootEntry).toBe('hermes-gateway');
		expect(recipe.buildNetworkAccess).toEqual({
			aptPackages: 'public-debian-repositories',
			containerImages: [HERMES_AGENT_DISTRIBUTION.containerImage],
			kind: 'upstream-hermes-image-with-public-package-indexes',
			npmPackages: 'public-npm-registry',
			pythonPackages: 'public-python-package-index',
			pythonRuntime: 'upstream-hermes-image',
		});
		expect(recipe.buildConfig).toEqual({
			arch: 'x86_64',
			distro: 'alpine',
			alpine: {
				version: '3.23.0',
				kernelPackage: 'linux-virt',
				kernelImage: 'vmlinuz-virt',
				rootfsPackages: [],
				initramfsPackages: [],
			},
			oci: { image: 'agent-vm-hermes:latest', pullPolicy: 'never' },
			rootfs: { label: 'gondolin-root', sizeMb: 4096 },
		});
		expect(recipe.dockerfile).toContain(`FROM ${HERMES_AGENT_DISTRIBUTION.containerImage}`);
		expect(recipe.dockerfile).toContain('npm install -g pnpm@10.33.0');
		expect(recipe.dockerfile).toContain('uv pip install --python /opt/hermes/.venv/bin/python');
		expect(recipe.dockerfile).toContain(
			'COPY local-agent-vm/agent_vm_agent_portal_sdk-0.0.116-py3-none-any.whl /tmp/agent_vm_agent_portal_sdk-0.0.116-py3-none-any.whl',
		);
		expect(recipe.dockerfile).toContain(
			'COPY local-agent-vm/agent_vm_hermes_adapter-0.0.116-py3-none-any.whl /tmp/agent_vm_hermes_adapter-0.0.116-py3-none-any.whl',
		);
		expect(recipe.dockerfile).toContain(
			'COPY local-agent-vm/package.json /opt/agent-vm/local-packages/package.json',
		);
		expect(recipe.dockerfile).toContain(
			'COPY local-agent-vm/agent-vm-gateway-runtime-0.0.116.tgz /opt/agent-vm/local-packages/agent-vm-gateway-runtime-0.0.116.tgz',
		);
		expect(recipe.dockerfile).not.toContain('hermes-agent[messaging]');
		expect(recipe.dockerfile).not.toContain('git clone');
		expect(recipe.dockerfile).not.toContain('HERMES_ALLOW_ROOT_GATEWAY');
		expect(recipe.dockerfile).not.toContain('install.sh');
		expect(recipe.dockerfile).toContain('pnpm install --prod --ignore-scripts');
		expect(recipe.dockerfile).toContain('/usr/local/bin/agent-vm-hermes-gateway');
		expect(recipe.dockerfile).toContain('/etc/profile.d/hermes-env.sh');
		expect(recipe.dockerfile).toContain('test -f /opt/hermes/ui-tui/dist/entry.js');
		expect(recipe.dockerfile).toContain('export HERMES_TUI_DIR=/opt/hermes/ui-tui');
		expect(recipe.dockerfile).toContain(
			'export PATH=/opt/hermes/.venv/bin:/opt/hermes/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
		);
		expect(recipe.dockerfile).toContain('export SSL_CERT_FILE=/run/gondolin/ca-certificates.crt');
		expect(recipe.dockerfile).toContain(
			'export REQUESTS_CA_BUNDLE=/run/gondolin/ca-certificates.crt',
		);
		expect(recipe.dockerfile).toContain(
			'gateway_runtime_bin="/opt/agent-vm/local-packages/node_modules/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js"',
		);
		expect(recipe.dockerfile).toContain(
			'ln -sfn "$gateway_runtime_bin" /usr/local/bin/agent-vm-gateway-runtime',
		);
		expect(recipe.dockerfile).not.toContain(
			'node_modules/.bin/agent-vm-gateway-runtime /usr/local/bin/agent-vm-gateway-runtime',
		);
		expect(recipe.dockerfile).not.toMatch(/CMD|ENTRYPOINT/iu);
		expect(recipe.dockerfile).not.toMatch(
			/(?:ARG|ENV|RUN)\s+[^\n]*(?:TOKEN|SECRET|CREDENTIAL)|\.npmrc|\.docker\/config\.json|\.netrc|_authToken|_password|_secret/iu,
		);
		expect(JSON.stringify(recipe)).not.toMatch(/complete|missingRuntimeJoins/u);
	});

	it('renders a production Hermes image recipe from exact public registry versions', () => {
		const recipe = renderHermesManagedImageRecipe({
			artifactContext: {
				agentVmVersion: '0.0.116',
				kind: 'public-registry-context',
			},
			buildTarget: {
				architecture: 'x86_64',
				kind: 'gondolin-custom-dockerfile',
				ociImage: 'agent-vm-hermes:latest',
				rootfsSizeMb: 4096,
			},
		});

		expect(recipe.dockerfile).toContain('"@agent-vm/gateway-runtime":"0.0.116"');
		expect(recipe.dockerfile).toContain('"hono":"4.12.24"');
		expect(recipe.dockerfile).toContain('"@hono/node-server":"2.0.4"');
		expect(recipe.dockerfile).toContain(
			'pnpm install --prod --ignore-scripts --registry=https://registry.npmjs.org/',
		);
		expect(recipe.dockerfile).not.toContain('pnpm add');
		expect(recipe.dockerfile).toContain("'agent-vm-agent-portal-sdk==0.0.116'");
		expect(recipe.dockerfile).toContain("'agent-vm-hermes-adapter==0.0.116'");
		expect(recipe.dockerfile).not.toContain('hermes-agent[messaging]');
		expect(recipe.dockerfile).toContain('--default-index https://pypi.org/simple');
		expect(recipe.dockerfile).toContain('--exclude-newer-package agent-vm-agent-portal-sdk=false');
		expect(recipe.dockerfile).toContain('--exclude-newer-package agent-vm-hermes-adapter=false');
		expect(recipe.dockerfile).not.toContain('--no-config');
		expect(recipe.dockerfile).toContain(
			'gateway_runtime_bin="/opt/agent-vm/registry-packages/node_modules/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js"',
		);
		expect(recipe.dockerfile).toContain('/usr/local/bin/agent-vm-gateway-runtime');
		expect(recipe.dockerfile).toContain('/usr/local/bin/agent-vm-hermes-gateway');
		expect(recipe.dockerfile).toContain('test -f /opt/hermes/ui-tui/dist/entry.js');
		expect(recipe.dockerfile).toContain('export HERMES_TUI_DIR=/opt/hermes/ui-tui');
		expect(recipe.dockerfile).toContain(
			'metadata.version("agent-vm-agent-portal-sdk") == "0.0.116"',
		);
		expect(recipe.dockerfile).toContain('metadata.version("agent-vm-hermes-adapter") == "0.0.116"');
		expect(recipe.dockerfile).not.toMatch(/COPY (?!--from=)/u);
		expect(recipe.dockerfile).not.toMatch(/\.tgz|\.whl|file:|worktree/iu);
		expect(recipe.dockerfile).not.toMatch(/local-(?:agent-vm|packages)/u);
		expect(recipe.dockerfile).not.toMatch(
			/(?:ARG|ENV|RUN)\s+[^\n]*(?:TOKEN|SECRET|CREDENTIAL)|\.npmrc|\.docker\/config\.json|\.netrc|_authToken|_password|_secret/iu,
		);
	});

	it('rejects non-exact public registry package versions', () => {
		expect(() =>
			renderHermesManagedImageRecipe({
				artifactContext: {
					agentVmVersion: '^0.0.116',
					kind: 'public-registry-context',
				},
				buildTarget: {
					architecture: 'x86_64',
					kind: 'gondolin-custom-dockerfile',
					ociImage: 'agent-vm-hermes:latest',
					rootfsSizeMb: 4096,
				},
			}),
		).toThrow(/must use an exact numeric semantic version/u);
	});

	it('rejects artifact paths that escape the caller-owned Docker context', () => {
		expect(() =>
			renderHermesManagedImageRecipe({
				artifactContext: {
					kind: 'local-artifact-context',
					gatewayRuntime: {
						executablePath:
							'/opt/agent-vm/local-packages/node_modules/@agent-vm/gateway-runtime/dist/bin/gateway-runtime.js',
						packageArchiveFiles: ['../gateway-runtime.tgz'],
						packageManifestFile: 'local-agent-vm/package.json',
					},
					pythonWheels: {
						agentPortalSdk: 'local-agent-vm/agent-portal-sdk.whl',
						hermesAdapter: 'local-agent-vm/hermes-adapter.whl',
					},
				},
				buildTarget: {
					architecture: 'aarch64',
					kind: 'gondolin-custom-dockerfile',
					ociImage: 'agent-vm-hermes:latest',
					rootfsSizeMb: 4096,
				},
			}),
		).toThrow(/relative Docker-context path/u);
	});
});
