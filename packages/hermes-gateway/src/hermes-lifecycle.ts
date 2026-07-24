import path from 'node:path';

import type {
	BuildGatewayVmRequirementsOptions,
	BuildManagedFrameworkServiceBootInputsOptions,
	GatewayZoneConfig,
	GatewayVmRequirements,
	ManagedFrameworkServiceBootInputs,
	ManagedGatewayLifecycle,
	ManagedHermesServiceBootMetadata,
} from '@agent-vm/gateway-lifecycle';
import {
	buildGatewaySessionLabel,
	gatewayVmAllowedHosts,
	mergeRuntimeGatewaySecrets,
	splitResolvedGatewaySecrets,
} from '@agent-vm/gateway-lifecycle';

import { loadHermesManagedConfiguration } from './hermes-managed-configuration.js';
import {
	preflightHermesProfileDirectories,
	prepareHermesProfileDirectories,
} from './hermes-profile-directory-materialization.js';

const hermesGatewayGuestPort = 8642;
const managedFrameworkConfigurationInputPath =
	'/run/agent-vm/managed-gateway/framework-service.json';
const managedFrameworkEnvironmentInputPath =
	'/run/agent-vm/managed-gateway-environment/framework.environment.sh';
const managedHermesConfigurationDirectoryPath = '/run/agent-vm/managed-gateway';
const protectedHermesHomeVmPath = '/home/hermes/.hermes';
const hermesCacheDirVmPath = '/home/hermes/.cache';
const agentVmLogsDirVmPath = '/agent-vm/logs';
const hermesGatewayGuestPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

type UnknownRecord = Readonly<Record<string, unknown>>;
type HermesGatewayConfig = Extract<GatewayZoneConfig['gateway'], { readonly type: 'hermes' }>;

function isObjectRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireHermesGatewayConfig(zone: GatewayZoneConfig): HermesGatewayConfig {
	const gateway = zone.gateway;
	if (gateway.type !== 'hermes') {
		throw new Error(`Hermes lifecycle cannot build gateway type '${gateway.type}'.`);
	}
	return gateway;
}

function requireHermesAdapterMaterial(zone: GatewayZoneConfig): UnknownRecord {
	const gateway = requireHermesGatewayConfig(zone);
	const gondolinConfig = zone.runtimePluginConfigs?.gondolin;
	if (!isObjectRecord(gondolinConfig)) {
		throw new Error('Managed Hermes requires the controller-authored Gondolin runtime config.');
	}
	const toolPortalMaterial = gondolinConfig.toolPortal;
	if (!isObjectRecord(toolPortalMaterial)) {
		throw new Error('Managed Hermes requires immutable Gondolin toolPortal adapter material.');
	}
	if (
		!isObjectRecord(toolPortalMaterial.attachment) ||
		toolPortalMaterial.attachment.clientKind !== 'hermes-managed-plugin'
	) {
		throw new Error('Managed Hermes requires a hermes-managed-plugin attachment.');
	}
	if (!isObjectRecord(toolPortalMaterial.agentProjections)) {
		throw new Error('Managed Hermes requires exact controller-authored agent projections.');
	}
	const discordBotTokenSecretsByAgent = gateway.discordBotTokenSecretsByAgent;
	if (discordBotTokenSecretsByAgent === undefined) {
		return toolPortalMaterial;
	}
	const discordBotTokenEnvironmentVariablesByProfile = Object.fromEntries(
		Object.entries(discordBotTokenSecretsByAgent).map(([agentId, secretName]) => {
			const profileName = gateway.profilesByAgent[agentId];
			if (profileName === undefined) {
				throw new Error(
					`Managed Hermes Discord token mapping references agent '${agentId}' without a profile.`,
				);
			}
			return [profileName, secretName];
		}),
	);
	return Object.freeze({
		...toolPortalMaterial,
		discordBotTokenEnvironmentVariablesByProfile: Object.freeze(
			discordBotTokenEnvironmentVariablesByProfile,
		),
	});
}

function buildGatewayTcpHosts(tcpPool: {
	readonly basePort: number;
	readonly size: number;
}): Record<string, string> {
	return Object.fromEntries(
		Array.from({ length: tcpPool.size }, (_, slot) => [
			`tool-${String(slot)}.vm.host:22`,
			`127.0.0.1:${String(tcpPool.basePort + slot)}`,
		]),
	);
}

function buildHermesFrameworkEnvironment(
	zone: GatewayZoneConfig,
	resolvedSecrets: Record<string, string>,
): Readonly<Record<string, string>> {
	const { environmentSecrets } = mergeRuntimeGatewaySecrets(
		splitResolvedGatewaySecrets(zone, resolvedSecrets),
		{
			logPrefix: 'hermes-managed-framework-service-runtime-secrets',
			runtimeEnvironment: zone.runtimeEnvironment,
			runtimeMediatedSecrets: zone.runtimeMediatedSecrets,
		},
	);
	if (environmentSecrets.API_SERVER_KEY === undefined) {
		throw new Error(
			'Managed Hermes requires API_SERVER_KEY so its readiness/API listener cannot start unauthenticated.',
		);
	}
	const observabilityEnvironment =
		zone.observability === undefined
			? {}
			: {
					OTEL_BLRP_MAX_EXPORT_BATCH_SIZE: String(
						zone.observability.framework.admissionLimits.maxExportBatchRecords,
					),
					OTEL_BLRP_MAX_QUEUE_SIZE: String(
						zone.observability.framework.admissionLimits.maxQueuedRecordsPerSignal,
					),
					OTEL_BLRP_SCHEDULE_DELAY: String(zone.observability.framework.flushIntervalMs),
					OTEL_BSP_MAX_EXPORT_BATCH_SIZE: String(
						zone.observability.framework.admissionLimits.maxExportBatchRecords,
					),
					OTEL_BSP_MAX_QUEUE_SIZE: String(
						zone.observability.framework.admissionLimits.maxQueuedRecordsPerSignal,
					),
					OTEL_BSP_SCHEDULE_DELAY: String(zone.observability.framework.flushIntervalMs),
					OTEL_EXPORTER_OTLP_ENDPOINT: `http://${zone.observability.collector.host}:${String(zone.observability.collector.httpPort)}`,
					OTEL_METRIC_EXPORT_INTERVAL: String(zone.observability.framework.flushIntervalMs),
					OTEL_SERVICE_NAME: zone.observability.framework.serviceName,
					OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
					OTEL_TRACES_SAMPLER_ARG: String(zone.observability.framework.sampleRate),
				};
	for (const protectedEnvironmentName of [
		'AGENT_VM_HERMES_MANAGED_CONFIG_PATH',
		'API_SERVER_ENABLED',
		'API_SERVER_HOST',
		'API_SERVER_PORT',
		'GATEWAY_MULTIPLEX_PROFILES',
		'HERMES_MANAGED_DIR',
		'HERMES_HOME',
	] as const) {
		if (Object.hasOwn(environmentSecrets, protectedEnvironmentName)) {
			throw new Error(
				`Managed Hermes runtime environment cannot override '${protectedEnvironmentName}'.`,
			);
		}
	}
	return Object.freeze({
		...environmentSecrets,
		...observabilityEnvironment,
		AGENT_VM_HERMES_MANAGED_CONFIG_PATH: managedFrameworkConfigurationInputPath,
		API_SERVER_ENABLED: 'true',
		API_SERVER_HOST: '0.0.0.0',
		API_SERVER_PORT: String(hermesGatewayGuestPort),
		GATEWAY_MULTIPLEX_PROFILES: 'true',
		HERMES_MANAGED_DIR: managedHermesConfigurationDirectoryPath,
		HERMES_HOME: protectedHermesHomeVmPath,
		HOME: '/home/hermes',
		NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
		PATH: hermesGatewayGuestPath,
		TEMP: '/work/tmp',
		TMP: '/work/tmp',
		TMPDIR: '/work/tmp',
		UV_CACHE_DIR: '/work/cache/uv',
	});
}

export function buildHermesFrameworkServiceBootMetadata(
	zone: GatewayZoneConfig,
): ManagedHermesServiceBootMetadata {
	requireHermesGatewayConfig(zone);
	return Object.freeze({
		bootEntry: 'hermes-gateway',
		configurationInputPath: managedFrameworkConfigurationInputPath,
		environmentInputPath: managedFrameworkEnvironmentInputPath,
		framework: 'hermes',
		ingress: Object.freeze({ guestPort: hermesGatewayGuestPort, kind: 'framework-http' }),
		logIdentity: Object.freeze({
			guestPath: '/var/log/agent-vm/hermes-service.log',
			serviceName: 'agent-vm-hermes',
		}),
		readiness: Object.freeze({
			guestPort: hermesGatewayGuestPort,
			kind: 'framework-http',
			path: '/health',
		}),
		role: 'framework-service',
	});
}

export async function buildHermesFrameworkServiceBootInputs(
	options: BuildManagedFrameworkServiceBootInputsOptions,
): Promise<ManagedFrameworkServiceBootInputs> {
	const configuration = requireHermesAdapterMaterial(options.zone);
	const managedConfiguration = await loadHermesManagedConfiguration(options.zone.gateway.config);
	return Object.freeze({
		configuration,
		environment: buildHermesFrameworkEnvironment(options.zone, options.resolvedSecrets),
		kind: 'hermes-managed-scope',
		managedConfigurationSource: managedConfiguration.source,
	});
}

export const hermesLifecycle = {
	executionModel: 'managed-gateway',
	buildFrameworkServiceBootInputs: buildHermesFrameworkServiceBootInputs,
	buildFrameworkServiceBootMetadata: buildHermesFrameworkServiceBootMetadata,
	preflightHostState: preflightHermesProfileDirectories,
	prepareHostState: prepareHermesProfileDirectories,
	buildVmRequirements({
		gatewayCacheDir,
		projectNamespace,
		resolvedSecrets,
		zoneRuntimeDir,
		tcpPool,
		zone,
	}: BuildGatewayVmRequirementsOptions): GatewayVmRequirements {
		const gateway = requireHermesGatewayConfig(zone);
		const { mediatedSecrets } = mergeRuntimeGatewaySecrets(
			splitResolvedGatewaySecrets(zone, resolvedSecrets),
			{
				logPrefix: 'hermes-managed-gateway-vm-runtime-secrets',
				runtimeEnvironment: zone.runtimeEnvironment,
				runtimeMediatedSecrets: zone.runtimeMediatedSecrets,
			},
		);
		const discordBotTokenProfileNames = Object.keys(
			gateway.discordBotTokenSecretsByAgent ?? {},
		).map((agentId) => {
			const profileName = gateway.profilesByAgent[agentId];
			if (profileName === undefined) {
				throw new Error(
					`Managed Hermes Discord token mapping references agent '${agentId}' without a profile.`,
				);
			}
			return profileName;
		});
		return {
			allowedHosts: gatewayVmAllowedHosts(zone.egressHosts),
			environment: {
				HERMES_HOME: protectedHermesHomeVmPath,
				HOME: '/home/hermes',
				NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
				PATH: hermesGatewayGuestPath,
			},
			mediatedSecrets,
			mounts: {
				[agentVmLogsDirVmPath]: {
					access: 'read-write',
					hostPath: path.join(zoneRuntimeDir, 'logs'),
					kind: 'host-directory',
				},
				[hermesCacheDirVmPath]: {
					access: 'read-write',
					hostPath: gatewayCacheDir,
					kind: 'host-directory',
				},
				[protectedHermesHomeVmPath]: {
					hostPath: zone.gateway.stateDir,
					...(discordBotTokenProfileNames.length === 0
						? { access: 'read-write' as const, kind: 'host-directory' as const }
						: {
								deny: [],
								kind: 'shadow' as const,
								temporaryFilesystems: discordBotTokenProfileNames
									.toSorted()
									.map((profileName) => `/profiles/${profileName}/.env`),
							}),
				},
			},
			rootfsMode: 'cow',
			...(zone.gateway.runtimeRootfsSize === undefined
				? {}
				: { runtimeRootfsSize: zone.gateway.runtimeRootfsSize }),
			sessionLabel: buildGatewaySessionLabel(projectNamespace, zone.id),
			tcpHosts: buildGatewayTcpHosts(tcpPool),
			websocketUpgrades: zone.websocketUpgrades ?? [],
		};
	},
} satisfies ManagedGatewayLifecycle;
