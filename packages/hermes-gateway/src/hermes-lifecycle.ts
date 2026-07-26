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

import {
	preflightHermesProfileDirectories,
	prepareHermesProfileDirectories,
} from './hermes-profile-directory-materialization.js';

const hermesGatewayGuestPort = 8642;
const managedFrameworkConfigurationInputPath =
	'/run/agent-vm/managed-gateway/framework-service.json';
const managedFrameworkEnvironmentInputPath =
	'/run/agent-vm/managed-gateway-environment/framework.environment.sh';
const protectedHermesHomeVmPath = '/home/hermes/.hermes';
const hermesCacheDirVmPath = '/home/hermes/.cache';
const agentVmLogsDirVmPath = '/agent-vm/logs';
const hermesGatewayGuestPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const reservedHermesProfileProjectionSourceNames: ReadonlySet<string> = new Set([
	'AGENT_VM_HERMES_MANAGED_CONFIG_PATH',
	'API_SERVER_ENABLED',
	'API_SERVER_HOST',
	'API_SERVER_KEY',
	'API_SERVER_PORT',
	'GATEWAY_MULTIPLEX_PROFILES',
	'HERMES_HOME',
	'HERMES_MANAGED',
	'HERMES_MANAGED_DIR',
	'HOME',
	'NODE_EXTRA_CA_CERTS',
	'PATH',
	'REQUESTS_CA_BUNDLE',
	'SSL_CERT_FILE',
	'TEMP',
	'TMP',
	'TMPDIR',
	'UV_CACHE_DIR',
]);
const hermesProfileGlobalEnvironmentNames: ReadonlySet<string> = new Set([
	'HERMES_HOME',
	'HERMES_PROFILE',
	'HERMES_GATEWAY_LOCK_DIR',
	'HERMES_MAX_ITERATIONS',
	'HERMES_MAX_TOKENS',
	'HERMES_API_TIMEOUT',
	'HERMES_REDACT_SECRETS',
	'HERMES_NOUS_TIMEOUT_SECONDS',
	'_HERMES_GATEWAY',
	'PATH',
	'HOME',
	'USER',
	'LANG',
	'LC_ALL',
	'TZ',
	'PWD',
	'SHELL',
	'TMPDIR',
	'VIRTUAL_ENV',
	'PYTHONPATH',
	'SSL_CERT_FILE',
	'HERMES_KANBAN_DB',
	'HERMES_KANBAN_WORKSPACES_ROOT',
	'HERMES_KANBAN_BOARD',
]);
const hermesProfileGlobalEnvironmentPrefixes = [
	'HERMES_KANBAN_',
	'HERMES_TELEGRAM_',
	'TERMINAL_',
] as const;

export function isReservedHermesProfileProjectionSourceName(sourceName: string): boolean {
	return (
		reservedHermesProfileProjectionSourceNames.has(sourceName) ||
		sourceName.startsWith('LD_') ||
		sourceName.startsWith('OTEL_') ||
		sourceName.startsWith('PYTHON')
	);
}

export function isReservedHermesProfileProjectionTargetName(targetName: string): boolean {
	return (
		isReservedHermesProfileProjectionSourceName(targetName) ||
		hermesProfileGlobalEnvironmentNames.has(targetName) ||
		hermesProfileGlobalEnvironmentPrefixes.some((prefix) => targetName.startsWith(prefix))
	);
}

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
	const profileEnvironmentSourceNamesByProfile = Object.fromEntries(
		Object.entries(gateway.profileSecretProjectionsByAgent).map(([agentId, projections]) => {
			const profileName = gateway.profilesByAgent[agentId];
			if (profileName === undefined) {
				throw new Error(
					`Managed Hermes profile secret projection references agent '${agentId}' without a profile.`,
				);
			}
			return [profileName, Object.freeze({ ...projections })];
		}),
	);
	return Object.freeze({
		...toolPortalMaterial,
		profileEnvironmentSourceNamesByProfile: Object.freeze(profileEnvironmentSourceNamesByProfile),
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
		HERMES_HOME: protectedHermesHomeVmPath,
		HOME: '/home/hermes',
		NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
		PATH: hermesGatewayGuestPath,
		REQUESTS_CA_BUNDLE: '/run/gondolin/ca-certificates.crt',
		SSL_CERT_FILE: '/run/gondolin/ca-certificates.crt',
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
	return Object.freeze({
		configuration,
		environment: buildHermesFrameworkEnvironment(options.zone, options.resolvedSecrets),
		kind: 'hermes-managed-scope',
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
		const profileEnvironmentShadowNames = Object.values(gateway.profilesByAgent).toSorted();
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
				'/etc/hermes': {
					access: 'read-only',
					hostPath: path.dirname(gateway.config),
					kind: 'host-directory',
				},
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
					deny: [],
					kind: 'shadow',
					temporaryFilesystems: profileEnvironmentShadowNames.map(
						(profileName) => `/profiles/${profileName}/.env`,
					),
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
