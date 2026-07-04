import fs from 'node:fs/promises';
import path from 'node:path';

import type {
	GatewayHealthCheck,
	GatewayLifecycle,
	GatewayZoneConfig,
} from '@agent-vm/gateway-interface';
import { createWebSocketUpgradeRequestGuard } from '@agent-vm/gateway-interface';
import {
	createManagedVm as createManagedVmFromCore,
	type ManagedVm,
} from '@agent-vm/gondolin-adapter';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import {
	buildGatewayControlEndpoint,
	buildGatewayControlRuntimePluginConfig,
	connectGatewayControlSession,
	createControlSessionDispatcher,
	createControlSessionFenceRegistry,
	createGatewayControlCallerContextRegistry,
	createGatewayControlDomainHandler,
	createGatewayControlSessionMaterial,
	writeGatewayControlSessionMaterial,
	type GatewayControlCallerContextRegisterPayload,
	type GatewayControlSessionMaterial,
} from '../controller/control-session/index.js';
import { cleanupOrphanedToolVmsIfPresent } from '../controller/leases/tool-vm-recovery.js';
import {
	createObservabilityRuntimeConfig,
	type ObservabilityRuntimeConfig,
} from '../observability/observability-config.js';
import { checkObservabilityStackReadiness as checkObservabilityStackReadinessDefault } from '../observability/observability-readiness.js';
import { assertOpenClawToolVmRequirements } from '../operations/openclaw-deployment-requirements.js';
import { runTaskWithResult, type RunTaskFn } from '../shared/run-task.js';
import { resolveZoneSecrets } from './credential-manager.js';
import { runGatewayHealthCheck } from './gateway-health-check.js';
import {
	buildGatewayImage,
	type GatewayImageBuilderDependencies,
} from './gateway-image-builder.js';
import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';
import { GatewayOwnershipUnsafeError } from './gateway-ownership-evidence.js';
import {
	cleanupOrphanedGatewayIfPresent,
	preflightOrphanedGatewayCleanupIfPresent,
} from './gateway-recovery.js';
import {
	buildGatewayRuntimeRecord,
	writeGatewayRuntimeRecord,
	type GatewayRuntimeRecord,
} from './gateway-runtime-record.js';
import {
	findGatewayZone,
	mapSystemGatewayZoneToLifecycleZone,
	type GatewayZone,
	type GatewayControlSessionConnector,
	type GatewayControlSessionMaterialFactory,
	type GatewayManagedVmFactoryOptions,
	type GatewayZoneStartResult,
	type StartGatewayZoneOptions,
} from './gateway-zone-support.js';
import {
	preflightMcpPortalEffectiveConfig,
	writeMcpPortalEffectiveConfig,
} from './mcp-portal-effective-config.js';

const defaultGatewayReadinessRetryDelayMs = 500;
const defaultGatewayReadinessTimeoutMs = 60_000;
const defaultGatewayReadinessMaxAttempts = Math.ceil(
	defaultGatewayReadinessTimeoutMs / defaultGatewayReadinessRetryDelayMs,
);

export function validateGatewayControlCallerContextRegistration(options: {
	readonly payload: GatewayControlCallerContextRegisterPayload;
	readonly zone: GatewayZone;
}): void {
	const evidence = options.payload.adapterEvidence;
	const configuredAgentIds = new Set((options.zone.agents ?? []).map((agent) => agent.id));
	if (configuredAgentIds.size === 0 || !configuredAgentIds.has(evidence.agentId)) {
		throw new Error(
			`Gateway control caller context rejected undeclared OpenClaw agent '${evidence.agentId}'.`,
		);
	}
	if (configuredAgentIds.size !== 1) {
		throw new Error(
			`Gateway control caller context rejected multi-agent OpenClaw zone '${options.zone.id}' until controller-signed agent attestation is implemented.`,
		);
	}
	if (
		evidence.purpose === 'tool_portal_controller_host_action' &&
		options.zone.toolPortal === undefined
	) {
		throw new Error(
			'Gateway control caller context rejected Tool Portal host action without zone Tool Portal config.',
		);
	}
}

export interface GatewayManagerDependencies extends GatewayImageBuilderDependencies {
	readonly checkObservabilityStackReadiness?: typeof checkObservabilityStackReadinessDefault;
	readonly cleanupOrphanedGatewayIfPresent?: typeof cleanupOrphanedGatewayIfPresent;
	readonly cleanupOrphanedToolVmsIfPresent?: typeof cleanupOrphanedToolVmsIfPresent;
	readonly connectGatewayControlSession?: GatewayControlSessionConnector;
	readonly createManagedVm?: (options: GatewayManagedVmFactoryOptions) => Promise<ManagedVm>;
	readonly createGatewayControlSessionMaterial?: GatewayControlSessionMaterialFactory;
	readonly gatewayReadinessMaxAttempts?: number;
	readonly gatewayReadinessRetryDelayMs?: number;
	readonly loadGatewayLifecycle?: (type: GatewayZoneConfig['gateway']['type']) => GatewayLifecycle;
	readonly preflightOrphanedGatewayCleanupIfPresent?: typeof preflightOrphanedGatewayCleanupIfPresent;
	// Injected by tests so the gateway record build doesn't shell out to ps
	// against a fake pid. Production omits this; uses the real default.
	readonly readProcessIdentity?: (
		pid: number,
	) => Promise<{ readonly command: string; readonly lstart: string } | null>;
	readonly writeGatewayControlSessionMaterial?: (
		runtimeDirectory: string,
		material: GatewayControlSessionMaterial,
	) => Promise<void>;
	readonly writeGatewayRuntimeRecord?: (
		stateDirectory: string,
		record: GatewayRuntimeRecord,
	) => Promise<void>;
}

export interface GatewayZoneStartPreflightResult {
	readonly image?: import('@agent-vm/gondolin-adapter').BuildImageResult | undefined;
	readonly secretResolver: SecretResolver;
}

interface GatewayZoneStartPrerequisitePreflightResult {
	readonly secretResolver: SecretResolver;
}

interface PreflightCachingSecretResolver {
	readonly resolver: SecretResolver;
	readonly freeze: () => SecretResolver;
}

type EnabledObservabilityRuntimeConfig = Extract<
	ObservabilityRuntimeConfig,
	{ readonly enabled: true }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
	}
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.toSorted()
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

function mergeRuntimePluginConfigs(
	base: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
	override: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined {
	if (base === undefined) {
		return override;
	}
	if (override === undefined) {
		return base;
	}
	const mergedEntries: Record<string, Readonly<Record<string, unknown>>> = { ...base };
	for (const [pluginId, pluginConfig] of Object.entries(override)) {
		mergedEntries[pluginId] = {
			...mergedEntries[pluginId],
			...pluginConfig,
		};
	}
	return mergedEntries;
}

function buildControlSessionRuntimePluginConfigs(options: {
	readonly material: ReturnType<typeof createGatewayControlSessionMaterial>;
}): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
	return {
		gondolin: {
			controlSession: buildGatewayControlRuntimePluginConfig(options.material),
		},
	};
}

function secretRefCacheKey(secretRef: SecretRef): string {
	return stableJson(secretRef);
}

function selectGatewayObservabilityStartupCheck(options: {
	readonly systemConfig: StartGatewayZoneOptions['systemConfig'];
	readonly zoneId: string;
}): EnabledObservabilityRuntimeConfig | undefined {
	const observabilityConfig = createObservabilityRuntimeConfig(options.systemConfig);
	if (!observabilityConfig.enabled || observabilityConfig.controllerStartPolicy === 'off') {
		return undefined;
	}
	const selectedZones = observabilityConfig.zones.filter((zone) => zone.zoneId === options.zoneId);
	if (selectedZones.length === 0) {
		return undefined;
	}
	return {
		...observabilityConfig,
		zones: selectedZones,
	};
}

async function assertObservabilityStackReady(options: {
	readonly checkObservabilityStackReadiness: typeof checkObservabilityStackReadinessDefault;
	readonly config: EnabledObservabilityRuntimeConfig;
}): Promise<void> {
	const result = await options.checkObservabilityStackReadiness({ config: options.config });
	if (!result.ok) {
		throw new Error(`Host observability stack is not ready: ${result.reason}`);
	}
}

async function checkGatewayObservabilityStartup(options: {
	readonly checkObservabilityStackReadiness: typeof checkObservabilityStackReadinessDefault;
	readonly runTaskStep: RunTaskFn;
	readonly systemConfig: StartGatewayZoneOptions['systemConfig'];
	readonly writeLog?: StartGatewayZoneOptions['writeLog'];
	readonly zoneId: string;
}): Promise<void> {
	const observabilityStartupCheck = selectGatewayObservabilityStartupCheck({
		systemConfig: options.systemConfig,
		zoneId: options.zoneId,
	});
	if (observabilityStartupCheck === undefined) {
		return;
	}
	const checkStack = async (): Promise<void> => {
		await assertObservabilityStackReady({
			checkObservabilityStackReadiness: options.checkObservabilityStackReadiness,
			config: observabilityStartupCheck,
		});
		options.writeLog?.(`Host observability stack is ready for zone '${options.zoneId}'.`);
	};
	if (observabilityStartupCheck.controllerStartPolicy === 'require-ready') {
		await options.runTaskStep('Checking host observability stack', checkStack);
		return;
	}
	void checkStack().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		options.writeLog?.(
			`Host observability stack degraded for zone '${options.zoneId}': ${message}`,
		);
	});
}

function createPreflightCachingSecretResolver(
	secretResolver: SecretResolver,
): PreflightCachingSecretResolver {
	const cachedSecrets = new Map<string, string>();
	const inFlightSecrets = new Map<string, Promise<string>>();
	let frozen = false;
	const resolver: SecretResolver = {
		resolve: async (secretRef) => {
			const cacheKey = secretRefCacheKey(secretRef);
			if (cachedSecrets.has(cacheKey)) {
				const cachedSecret = cachedSecrets.get(cacheKey);
				if (cachedSecret === undefined) {
					throw new Error('Preflight secret cache contained an undefined value.');
				}
				return cachedSecret;
			}
			const inFlightSecret = inFlightSecrets.get(cacheKey);
			if (inFlightSecret !== undefined) {
				return await inFlightSecret;
			}
			if (frozen) {
				throw new Error('Gateway secret preflight cache missed a post-preflight resolve call.');
			}
			const freshSecret = Promise.resolve()
				.then(async () => await secretResolver.resolve(secretRef))
				.then((resolvedSecret) => {
					cachedSecrets.set(cacheKey, resolvedSecret);
					return resolvedSecret;
				})
				.finally(() => {
					inFlightSecrets.delete(cacheKey);
				});
			inFlightSecrets.set(cacheKey, freshSecret);
			return await freshSecret;
		},
		resolveAll: async (secretRefs) => {
			const resolvedSecrets: Record<string, string> = {};
			const pendingSecrets: {
				readonly promise: Promise<string>;
				readonly secretName: string;
			}[] = [];
			const newSecretGroupsByCacheKey = new Map<
				string,
				{
					readonly resolverSecretName: string;
					readonly requestedSecretNames: string[];
					readonly secretRef: SecretRef;
				}
			>();
			for (const [secretName, secretRef] of Object.entries(secretRefs)) {
				const cacheKey = secretRefCacheKey(secretRef);
				if (cachedSecrets.has(cacheKey)) {
					const cachedSecret = cachedSecrets.get(cacheKey);
					if (cachedSecret === undefined) {
						throw new Error('Preflight secret cache contained an undefined value.');
					}
					resolvedSecrets[secretName] = cachedSecret;
					continue;
				}
				const inFlightSecret = inFlightSecrets.get(cacheKey);
				if (inFlightSecret !== undefined) {
					pendingSecrets.push({ promise: inFlightSecret, secretName });
					continue;
				}
				const newSecretGroup = newSecretGroupsByCacheKey.get(cacheKey);
				if (newSecretGroup !== undefined) {
					newSecretGroup.requestedSecretNames.push(secretName);
				} else {
					newSecretGroupsByCacheKey.set(cacheKey, {
						requestedSecretNames: [secretName],
						resolverSecretName: secretName,
						secretRef,
					});
				}
			}
			if (newSecretGroupsByCacheKey.size === 0) {
				await Promise.all(
					pendingSecrets.map(async ({ promise, secretName }) => {
						resolvedSecrets[secretName] = await promise;
					}),
				);
				return resolvedSecrets;
			}
			if (frozen) {
				throw new Error(
					`Gateway secret preflight cache missed ${String(newSecretGroupsByCacheKey.size)} post-preflight resolveAll secret(s).`,
				);
			}
			const missingSecretRefs: Record<string, SecretRef> = Object.fromEntries(
				[...newSecretGroupsByCacheKey.values()].map((group) => [
					group.resolverSecretName,
					group.secretRef,
				]),
			);
			const freshSecretsPromise = Promise.resolve().then(
				async () => await secretResolver.resolveAll(missingSecretRefs),
			);
			for (const [cacheKey, group] of newSecretGroupsByCacheKey.entries()) {
				const freshSecret = freshSecretsPromise
					.then((freshSecrets) => {
						const resolvedSecret = freshSecrets[group.resolverSecretName];
						if (resolvedSecret === undefined) {
							throw new Error(
								`Secret resolver omitted preflight secret '${group.resolverSecretName}'.`,
							);
						}
						cachedSecrets.set(cacheKey, resolvedSecret);
						return resolvedSecret;
					})
					.finally(() => {
						inFlightSecrets.delete(cacheKey);
					});
				inFlightSecrets.set(cacheKey, freshSecret);
				for (const secretName of group.requestedSecretNames) {
					pendingSecrets.push({ promise: freshSecret, secretName });
				}
			}
			await Promise.all(
				pendingSecrets.map(async ({ promise, secretName }) => {
					resolvedSecrets[secretName] = await promise;
				}),
			);
			return resolvedSecrets;
		},
	};
	return {
		freeze: () => {
			frozen = true;
			return resolver;
		},
		resolver,
	};
}

interface GatewayCommandResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}

function selectGatewayImageProfile(options: {
	readonly systemConfig: import('../config/system-config.js').SystemConfig;
	readonly zone: GatewayZone;
}): import('../config/system-config.js').SystemConfig['imageProfiles']['gateways'][string] {
	const profile = options.systemConfig.imageProfiles.gateways[options.zone.gateway.imageProfile];
	if (!profile) {
		throw new Error(
			`Gateway image profile '${options.zone.gateway.imageProfile}' is not configured.`,
		);
	}
	return profile;
}

function formatCommandOutput(name: string, value: string): string {
	const trimmedValue = value.trim();
	return trimmedValue.length > 0 ? `\n${name}:\n${trimmedValue}` : '';
}

function formatGatewayCommandFailure(stepName: string, result: GatewayCommandResult): string {
	return `${stepName} failed with exit ${result.exitCode}.${formatCommandOutput('stdout', result.stdout)}${formatCommandOutput('stderr', result.stderr)}`;
}

async function execGatewayCommand(options: {
	readonly command: string;
	readonly managedVm: ManagedVm;
	readonly stepName: string;
}): Promise<GatewayCommandResult> {
	const result = await options.managedVm.exec(options.command);
	if (result.exitCode !== 0) {
		throw new Error(formatGatewayCommandFailure(options.stepName, result));
	}
	return result;
}

async function readGatewayLogTail(options: {
	readonly logPath: string;
	readonly managedVm: ManagedVm;
}): Promise<string | undefined> {
	try {
		const result = await options.managedVm.exec(
			`tail -n 80 ${options.logPath} 2>/dev/null || true`,
		);
		const output = [result.stdout.trim(), result.stderr.trim()]
			.filter((chunk) => chunk.length > 0)
			.join('\n');
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

function formatElapsedSeconds(startedAtMs: number): string {
	return ((Date.now() - startedAtMs) / 1000).toFixed(1);
}

async function waitForHealth(options: {
	readonly attempt?: number;
	readonly healthCheck: GatewayHealthCheck;
	readonly lastObservation?: string;
	readonly logPath: string;
	readonly managedVm: ManagedVm;
	readonly maxAttempts?: number;
	readonly retryDelayMs?: number;
	readonly startedAtMs?: number;
}): Promise<void> {
	const attempt = options.attempt ?? 0;
	const retryDelayMs = options.retryDelayMs ?? defaultGatewayReadinessRetryDelayMs;
	const maxAttempts = options.maxAttempts ?? defaultGatewayReadinessMaxAttempts;
	const startedAtMs = options.startedAtMs ?? Date.now();
	const lastObservation = options.lastObservation ?? 'none';
	if (attempt >= maxAttempts) {
		const logTail = await readGatewayLogTail({
			logPath: options.logPath,
			managedVm: options.managedVm,
		});
		throw new Error(
			`Gateway service health check failed after ${maxAttempts} attempts over ${formatElapsedSeconds(startedAtMs)}s. Last probe: ${lastObservation}. Gateway process may still be booting, or it may have crashed before opening its health port.${logTail ? `\nGateway log tail (${options.logPath}):\n${logTail}` : ''}`,
		);
	}

	const result = await runGatewayHealthCheck({
		exec: async (command) => await options.managedVm.exec(command),
		healthCheck: options.healthCheck,
	});
	if (result.ok) {
		return;
	}

	await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
	await waitForHealth({
		attempt: attempt + 1,
		healthCheck: options.healthCheck,
		lastObservation: result.observation,
		logPath: options.logPath,
		managedVm: options.managedVm,
		maxAttempts,
		retryDelayMs,
		startedAtMs,
	});
}

async function buildRuntimeMcpPortalMaterialization(props: {
	readonly cacheDir: string;
	readonly secretResolver: StartGatewayZoneOptions['secretResolver'];
	readonly writeEffectiveConfig?: boolean | undefined;
	readonly zone: GatewayZone;
}): Promise<
	Partial<
		Pick<
			GatewayZoneConfig,
			'egressHosts' | 'runtimeEnvironment' | 'runtimeMediatedSecrets' | 'runtimePluginConfigs'
		>
	>
> {
	const zone = props.zone;
	if (zone.gateway.type !== 'openclaw' || zone.toolPortal === undefined) {
		return {};
	}
	const allowedRawEnvSecretNames = [
		'OPENCLAW_GATEWAY_TOKEN',
		...(zone.gateway.rawEnvSecrets ?? []),
	];
	const effectiveHostConfigDir = path.join(
		props.cacheDir,
		'gateways',
		zone.id,
		'tool-portal-effective',
	);
	const effectiveVmConfigDir = '/home/openclaw/.openclaw/cache/tool-portal-effective';
	const buildEffectiveConfig =
		props.writeEffectiveConfig === false
			? preflightMcpPortalEffectiveConfig
			: writeMcpPortalEffectiveConfig;
	const materialization = await buildEffectiveConfig({
		authoredConfigDir: zone.toolPortal.configDir,
		effectiveHostConfigDir,
		effectiveVmConfigDir,
		allowedRawEnvSecretNames,
		declaredAgentIds: (zone.agents ?? []).map((agent) => agent.id),
		includeZoneGitControllerHostAction: zone.gateway.zoneGit !== undefined,
		secretResolver: props.secretResolver,
		zoneId: zone.id,
	});
	const declaredGatewayHosts = new Set(
		zone.egressHosts
			.filter((entry) => entry.audience === 'gateway' || entry.audience === 'both')
			.map((entry) => entry.host),
	);
	const generatedGatewayEgressHosts = materialization.requiredGatewayEgressHosts
		.filter((host) => !declaredGatewayHosts.has(host))
		.map((host) => ({ audience: 'gateway' as const, host }));
	return {
		egressHosts: [...zone.egressHosts, ...generatedGatewayEgressHosts],
		runtimeEnvironment: materialization.runtimeEnvironment,
		runtimeMediatedSecrets: materialization.runtimeMediatedSecrets,
		runtimePluginConfigs: {
			gondolin: { toolPortal: materialization.pluginConfig },
		},
	};
}

async function buildGatewayImageForZone(
	options: {
		readonly systemConfig: StartGatewayZoneOptions['systemConfig'];
		readonly zone: GatewayZone;
	},
	dependencies: GatewayImageBuilderDependencies = {},
): Promise<import('@agent-vm/gondolin-adapter').BuildImageResult> {
	const gatewayImageProfile = selectGatewayImageProfile({
		systemConfig: options.systemConfig,
		zone: options.zone,
	});
	return await buildGatewayImage(
		{
			buildConfigPath: gatewayImageProfile.buildConfig,
			cacheDir: path.join(
				options.systemConfig.cacheDir,
				'gateway-images',
				options.zone.gateway.imageProfile,
			),
		},
		{
			...(dependencies.buildImage ? { buildImage: dependencies.buildImage } : {}),
			...(dependencies.buildGondolinImage
				? { buildGondolinImage: dependencies.buildGondolinImage }
				: {}),
			...(dependencies.loadBuildConfig ? { loadBuildConfig: dependencies.loadBuildConfig } : {}),
		},
	);
}

export async function preflightGatewayZoneStart(
	options: StartGatewayZoneOptions,
	dependencies: Pick<
		GatewayManagerDependencies,
		| 'buildGondolinImage'
		| 'buildImage'
		| 'checkObservabilityStackReadiness'
		| 'loadBuildConfig'
		| 'loadGatewayLifecycle'
	> = {},
): Promise<GatewayZoneStartPreflightResult> {
	const runTaskStep =
		options.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	await checkGatewayObservabilityStartup({
		checkObservabilityStackReadiness:
			dependencies.checkObservabilityStackReadiness ?? checkObservabilityStackReadinessDefault,
		runTaskStep,
		systemConfig: options.systemConfig,
		...(options.writeLog === undefined ? {} : { writeLog: options.writeLog }),
		zoneId: options.zoneId,
	});
	const prerequisites = await preflightGatewayZoneStartPrerequisites(options, dependencies);
	const zone = options.zoneOverride ?? findGatewayZone(options.systemConfig, options.zoneId);
	const image =
		options.prebuiltImage ??
		(await buildGatewayImageForZone(
			{
				systemConfig: options.systemConfig,
				zone,
			},
			dependencies,
		));
	return { image, secretResolver: prerequisites.secretResolver };
}

async function preflightGatewayZoneStartPrerequisites(
	options: StartGatewayZoneOptions,
	dependencies: Pick<GatewayManagerDependencies, 'loadGatewayLifecycle'> = {},
): Promise<GatewayZoneStartPrerequisitePreflightResult> {
	const zone = options.zoneOverride ?? findGatewayZone(options.systemConfig, options.zoneId);
	const mappedLifecycleZone = mapSystemGatewayZoneToLifecycleZone(zone, {
		hostObservability: options.systemConfig.host.observability,
	});
	const controlSessionMaterial =
		zone.gateway.type === 'openclaw' && options.controlSession !== undefined
			? createGatewayControlSessionMaterial({
					controllerEpoch: options.controlSession.controllerEpoch,
					zoneId: zone.id,
				})
			: undefined;
	const controlSessionRuntimePluginConfigs =
		controlSessionMaterial === undefined
			? undefined
			: buildControlSessionRuntimePluginConfigs({ material: controlSessionMaterial });
	const lifecycle = (dependencies.loadGatewayLifecycle ?? loadGatewayLifecycle)(zone.gateway.type);
	const cachingSecretResolver = createPreflightCachingSecretResolver(options.secretResolver);
	const [toolPortalMaterialization] = await Promise.all([
		buildRuntimeMcpPortalMaterialization({
			cacheDir: options.systemConfig.cacheDir,
			secretResolver: cachingSecretResolver.resolver,
			writeEffectiveConfig: false,
			zone,
		}),
		resolveZoneSecrets({
			audience: 'gateway',
			secretResolver: cachingSecretResolver.resolver,
			systemConfig: options.systemConfig,
			zoneId: zone.id,
		}),
	]);
	const runtimePluginConfigs = mergeRuntimePluginConfigs(
		mergeRuntimePluginConfigs(
			toolPortalMaterialization.runtimePluginConfigs,
			options.runtimePluginConfigs,
		),
		controlSessionRuntimePluginConfigs,
	);
	const lifecycleZone = {
		...mappedLifecycleZone,
		...toolPortalMaterialization,
		egressHosts: toolPortalMaterialization.egressHosts ?? mappedLifecycleZone.egressHosts,
		...(options.gitReadAllowlistRepos === undefined
			? {}
			: { gitReadAllowlistRepos: options.gitReadAllowlistRepos }),
		...(options.runtimeEnvironment === undefined
			? {}
			: {
					runtimeEnvironment: {
						...toolPortalMaterialization.runtimeEnvironment,
						...options.runtimeEnvironment,
					},
				}),
		...(runtimePluginConfigs === undefined ? {} : { runtimePluginConfigs }),
	};
	if (zone.gateway.type === 'openclaw') {
		await assertOpenClawToolVmRequirements({ ...options.systemConfig, zones: [zone] }, zone.id);
	}
	await lifecycle.preflightHostState?.(lifecycleZone, cachingSecretResolver.resolver);
	return { secretResolver: cachingSecretResolver.freeze() };
}

export async function startGatewayZone(
	options: StartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies = {},
): Promise<GatewayZoneStartResult> {
	const runTaskStep =
		options.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const zone = options.zoneOverride ?? findGatewayZone(options.systemConfig, options.zoneId);
	const mappedLifecycleZone = mapSystemGatewayZoneToLifecycleZone(zone, {
		hostObservability: options.systemConfig.host.observability,
	});
	const controlSessionMaterial =
		zone.gateway.type === 'openclaw' && options.controlSession !== undefined
			? (dependencies.createGatewayControlSessionMaterial ?? createGatewayControlSessionMaterial)({
					controllerEpoch: options.controlSession.controllerEpoch,
					zoneId: zone.id,
				})
			: undefined;
	const controlSessionRuntimePluginConfigs =
		controlSessionMaterial === undefined
			? undefined
			: buildControlSessionRuntimePluginConfigs({ material: controlSessionMaterial });
	const lifecycle = (dependencies.loadGatewayLifecycle ?? loadGatewayLifecycle)(zone.gateway.type);

	// Phase A: prove ownership before doing any other startup work.
	//
	// This phase is ordered ahead of secret resolution and image work so
	// owner-unsafe evidence cannot be masked by a faster 1Password, config,
	// or build failure. Safety beats diagnostic speed here: if an unknown
	// process owns the gateway ingress, the controller must report that as
	// the current blocker and must not proceed toward a second gateway. This
	// preflight is intentionally non-destructive; actual cleanup happens only
	// after secrets, host-state preflight, and image build have succeeded.
	const preflightOrphanedGatewayCleanup = async (): Promise<void> => {
		const preflightResult = await (
			dependencies.preflightOrphanedGatewayCleanupIfPresent ??
			preflightOrphanedGatewayCleanupIfPresent
		)({
			configuredIngressPort: zone.gateway.port,
			expectedConfigPath: options.systemConfig.systemConfigPath,
			expectedControllerPort: options.systemConfig.host.controllerPort,
			mode: 'in-process-recovery',
			projectNamespace: options.systemConfig.host.projectNamespace,
			stateDir: zone.gateway.stateDir,
			zoneId: zone.id,
		});
		if (preflightResult.ownershipEvidence !== undefined) {
			throw new GatewayOwnershipUnsafeError({
				evidence: preflightResult.ownershipEvidence,
				message: `Gateway ownership is unsafe for zone '${zone.id}': ${preflightResult.ownershipEvidence.kind}.`,
			});
		}
	};
	await runTaskStep('Preflighting gateway runtime ownership', preflightOrphanedGatewayCleanup);
	if (options.observabilityStartupCheck !== 'skip') {
		await checkGatewayObservabilityStartup({
			checkObservabilityStackReadiness:
				dependencies.checkObservabilityStackReadiness ?? checkObservabilityStackReadinessDefault,
			runTaskStep,
			systemConfig: options.systemConfig,
			...(options.writeLog === undefined ? {} : { writeLog: options.writeLog }),
			zoneId: zone.id,
		});
	}

	// Phase B: prove non-ownership host-side prerequisites before any
	// destructive cleanup. The returned resolver is frozen to preflighted
	// secret values so post-cleanup startup cannot re-enter 1Password.
	const startupPreflight = await runTaskWithResult(
		runTaskStep,
		'Preflighting gateway start',
		async () => await preflightGatewayZoneStartPrerequisites(options, dependencies),
	);
	const startupSecretResolver = startupPreflight.secretResolver;

	// Phase C cleanup runs after replacement prerequisites are proven. Tool VM
	// children are cleaned before the gateway so an old gateway cannot continue
	// issuing work while child recovery runs.
	const cleanupOrphanedGateway = async (): Promise<void> => {
		const cleanupResult = await (
			dependencies.cleanupOrphanedGatewayIfPresent ?? cleanupOrphanedGatewayIfPresent
		)({
			configuredIngressPort: zone.gateway.port,
			expectedConfigPath: options.systemConfig.systemConfigPath,
			expectedControllerPort: options.systemConfig.host.controllerPort,
			mode: 'in-process-recovery',
			projectNamespace: options.systemConfig.host.projectNamespace,
			stateDir: zone.gateway.stateDir,
			zoneId: zone.id,
		});
		if (cleanupResult.ownershipEvidence !== undefined) {
			throw new GatewayOwnershipUnsafeError({
				evidence: cleanupResult.ownershipEvidence,
				message: `Gateway ownership is unsafe for zone '${zone.id}': ${cleanupResult.ownershipEvidence.kind}.`,
			});
		}
	};
	const cleanupOrphanedToolVms = async (): Promise<void> => {
		if (zone.gateway.type !== 'openclaw') {
			return;
		}
		await (dependencies.cleanupOrphanedToolVmsIfPresent ?? cleanupOrphanedToolVmsIfPresent)({
			expectedConfigPath: options.systemConfig.systemConfigPath,
			expectedControllerPort: options.systemConfig.host.controllerPort,
			mode: 'in-process-recovery',
			projectNamespace: options.systemConfig.host.projectNamespace,
			stateDir: zone.gateway.stateDir,
			tcpBasePort: options.systemConfig.tcpPool.basePort,
			zoneId: zone.id,
		});
	};

	// Phase D: collect startup artifacts in parallel.
	//
	// All four branches operate on disjoint host paths. Secret work is shared
	// through the preflight cache so overlapping refs await one in-flight
	// underlying resolution:
	//   - mcpPortalMaterialization writes $cacheDir/gateways/$zoneId/tool-portal-effective/
	//   - assertions reads $zone.gateway.config (pure validation)
	//   - resolveZoneSecrets reads zone.secrets
	//   - image is the prebuilt Phase B image whenever protected preflight ran
	//
	// mcpPortalMaterialization and resolveZoneSecrets both call
	// secretResolver.resolveAll concurrently. The
	// @1password/sdk JS client is documented in its source to be concurrency-
	// safe on a single Client instance (SharedCore WASM module handles
	// concurrent invocations). The op-CLI fallback layer is intentionally
	// two-tier only — SDK → op inject — with no further serial `op read`
	// tier; see packages/secret-management/src/onepassword-secret-resolver.ts
	// for the rationale (the previous third tier reintroduced a documented
	// concurrent `op read` hazard at the outer-call layer).
	const mcpPortalMaterializationPromise = buildRuntimeMcpPortalMaterialization({
		cacheDir: options.systemConfig.cacheDir,
		secretResolver: startupSecretResolver,
		zone,
	});
	const assertionsPromise =
		zone.gateway.type === 'openclaw'
			? runTaskStep('Validating OpenClaw Tool VM requirements', async () => {
					await assertOpenClawToolVmRequirements(options.systemConfig, zone.id);
				})
			: Promise.resolve();
	const resolvedSecretsPromise = runTaskWithResult(
		runTaskStep,
		'Resolving zone secrets',
		async () =>
			await resolveZoneSecrets({
				audience: 'gateway',
				systemConfig: options.systemConfig,
				zoneId: zone.id,
				secretResolver: startupSecretResolver,
			}),
	);
	const imagePromise = runTaskWithResult(
		runTaskStep,
		'Building gateway image',
		async () =>
			options.prebuiltImage ??
			(await buildGatewayImageForZone(
				{
					systemConfig: options.systemConfig,
					zone,
				},
				dependencies,
			)),
	);
	// Promise.all (fail-fast) rather than Promise.allSettled here. Rationale:
	//   - The image build branch can be slow on a cold cache (minutes for a
	//     full Gondolin rebuild). If any other branch fails fast (e.g., a
	//     config assertion at ~10ms), we want the operator to see the error
	//     immediately, not after the image build completes.
	//   - The realistic multi-failure mode (1Password is down) hits both
	//     secretResolver.resolveAll callers with the same root cause at the
	//     same op-CLI timeout (~30s). Promise.all surfaces the first; that's
	//     diagnostically sufficient.
	//   - Later phases create live QEMU resources and must keep narrower,
	//     sequential cleanup rules.
	//
	// Cost of fail-fast: if multiple branches reject simultaneously, the
	// other reasons are lost (only the first reaches the caller). Background
	// completion of the other branches is harmless — no Phase B branch
	// produces a host-visible resource that needs cleanup.
	const [toolPortalMaterialization, , resolvedSecrets, image] = await Promise.all([
		mcpPortalMaterializationPromise,
		assertionsPromise,
		resolvedSecretsPromise,
		imagePromise,
	]);
	if (zone.gateway.type === 'openclaw') {
		await runTaskStep('Cleaning orphaned tool VMs', async () => {
			await cleanupOrphanedToolVms();
			await runTaskStep('Cleaning orphaned gateway runtime', cleanupOrphanedGateway);
		});
	} else {
		await runTaskStep('Cleaning orphaned gateway runtime', cleanupOrphanedGateway);
	}
	const runtimePluginConfigs = mergeRuntimePluginConfigs(
		mergeRuntimePluginConfigs(
			toolPortalMaterialization.runtimePluginConfigs,
			options.runtimePluginConfigs,
		),
		controlSessionRuntimePluginConfigs,
	);
	const lifecycleZone = {
		...mappedLifecycleZone,
		...toolPortalMaterialization,
		egressHosts: toolPortalMaterialization.egressHosts ?? mappedLifecycleZone.egressHosts,
		...(options.gitReadAllowlistRepos === undefined
			? {}
			: { gitReadAllowlistRepos: options.gitReadAllowlistRepos }),
		...(options.runtimeEnvironment === undefined
			? {}
			: {
					runtimeEnvironment: {
						...toolPortalMaterialization.runtimeEnvironment,
						...options.runtimeEnvironment,
					},
				}),
		...(runtimePluginConfigs === undefined ? {} : { runtimePluginConfigs }),
	};
	await fs.mkdir(zone.gateway.stateDir, { recursive: true });
	if (zone.gateway.type === 'openclaw') {
		await fs.mkdir(zone.gateway.zoneFilesDir, { recursive: true });
	}
	const gatewayCacheDir = path.join(options.systemConfig.cacheDir, 'gateways', zone.id);
	await fs.mkdir(gatewayCacheDir, { recursive: true });
	if (zone.gateway.type === 'openclaw') {
		const logDir = path.join(options.systemConfig.runtimeDir, 'zones', zone.id, 'logs');
		await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
		await fs.chmod(logDir, 0o700);
	}
	const vmSpec = lifecycle.buildVmSpec({
		controllerPort: options.systemConfig.host.controllerPort,
		gatewayCacheDir,
		projectNamespace: options.systemConfig.host.projectNamespace,
		resolvedSecrets,
		runtimeDir: options.systemConfig.runtimeDir,
		tcpPool: options.systemConfig.tcpPool,
		zone: lifecycleZone,
	});
	const processSpec = lifecycle.buildProcessSpec(lifecycleZone, resolvedSecrets);
	const environment = {
		...vmSpec.environment,
		...options.environmentOverride,
	};
	const tcpHosts = {
		...vmSpec.tcpHosts,
		...options.tcpHostsOverride,
	};
	const vfsMounts = {
		...vmSpec.vfsMounts,
		...options.vfsMountsOverride,
	};
	const createManagedVm = dependencies.createManagedVm ?? createManagedVmFromCore;
	// Phase E: write host state before creating a new VM. This is deliberately
	// sequential: if the final write fails after orphan cleanup, startup aborts
	// without creating a second gateway VM that then needs cleanup.
	await runTaskStep('Preparing host state', async () => {
		await lifecycle.prepareHostState?.(lifecycleZone, startupSecretResolver);
	});
	const managedVm = await runTaskWithResult(
		runTaskStep,
		'Booting gateway VM',
		async () =>
			await createManagedVm({
				allowedHosts: vmSpec.allowedHosts,
				cpus: zone.gateway.cpus,
				env: environment,
				imagePath: image.imagePath,
				memory: zone.gateway.memory,
				rootfsMode: vmSpec.rootfsMode,
				...(vmSpec.runtimeRootfsSize ? { runtimeRootfsSize: vmSpec.runtimeRootfsSize } : {}),
				onRequest: createWebSocketUpgradeRequestGuard({
					rules: vmSpec.websocketUpgrades ?? [],
					runtimeAudience: 'gateway',
				}),
				secrets: vmSpec.mediatedSecrets,
				sessionLabel: vmSpec.sessionLabel,
				...(vmSpec.sshEgress ? { sshEgress: vmSpec.sshEgress } : {}),
				tcpHosts,
				vfsMounts,
			}),
	);
	try {
		await runTaskStep('Configuring gateway', async () => {
			await execGatewayCommand({
				command: processSpec.bootstrapCommand,
				managedVm,
				stepName: 'Configuring gateway',
			});
		});
		await runTaskStep('Starting gateway', async () => {
			await execGatewayCommand({
				command: processSpec.startCommand,
				managedVm,
				stepName: 'Starting gateway',
			});
		});
		const startupHealthCheck = processSpec.serviceHealthCheck ?? processSpec.healthCheck;
		await runTaskStep('Waiting for service health', async () => {
			await waitForHealth({
				healthCheck: startupHealthCheck,
				logPath: processSpec.logPath,
				managedVm,
				...(dependencies.gatewayReadinessMaxAttempts !== undefined
					? { maxAttempts: dependencies.gatewayReadinessMaxAttempts }
					: {}),
				...(dependencies.gatewayReadinessRetryDelayMs !== undefined
					? { retryDelayMs: dependencies.gatewayReadinessRetryDelayMs }
					: {}),
			});
		});
		managedVm.setIngressRoutes([
			{
				port: processSpec.guestListenPort,
				prefix: '/',
				stripPrefix: true,
			},
		]);
		const ingress = await managedVm.enableIngress({
			bufferResponseBody: false,
			listenPort: zone.gateway.port,
			...(zone.gateway.ingress?.upstreamHeaderTimeoutMs === undefined
				? {}
				: { upstreamHeaderTimeoutMs: zone.gateway.ingress.upstreamHeaderTimeoutMs }),
			...(zone.gateway.ingress?.upstreamResponseTimeoutMs === undefined
				? {}
				: { upstreamResponseTimeoutMs: zone.gateway.ingress.upstreamResponseTimeoutMs }),
		});
		const controlSession =
			controlSessionMaterial === undefined
				? undefined
				: await runTaskWithResult(runTaskStep, 'Connecting gateway control session', async () => {
						const sessionFenceRegistry = createControlSessionFenceRegistry();
						const dispatcher = createControlSessionDispatcher({ sessionFenceRegistry });
						dispatcher.register(
							'gateway_control',
							createGatewayControlDomainHandler({
								callerContexts: createGatewayControlCallerContextRegistry(),
								...(options.gatewayControlControllerHostActions === undefined
									? {}
									: {
											controllerHostActions: options.gatewayControlControllerHostActions,
										}),
								...(options.gatewayControlLeaseRpc === undefined
									? {}
									: { leaseRpc: options.gatewayControlLeaseRpc }),
								...(options.healthEventStore === undefined
									? {}
									: {
											recordHealthEvent: (event) => {
												options.healthEventStore?.record(event);
											},
										}),
								...(options.openClawRuntimeStatusStore === undefined
									? {}
									: {
											recordRuntimeStatus: (report) => {
												options.openClawRuntimeStatusStore?.record(report);
											},
										}),
								session: {
									bootId: controlSessionMaterial.bootId,
									controllerEpoch: controlSessionMaterial.controllerEpoch,
									peerId: controlSessionMaterial.peerId,
									zoneId: controlSessionMaterial.zoneId,
								},
								validateCallerContextRegistration: (payload) => {
									validateGatewayControlCallerContextRegistration({ payload, zone });
								},
							}),
						);
						return await (
							dependencies.connectGatewayControlSession ?? connectGatewayControlSession
						)({
							dispatcher,
							endpoint: buildGatewayControlEndpoint(ingress),
							material: controlSessionMaterial,
							sessionFenceRegistry,
						});
					});
		await runTaskStep('Recording gateway runtime', async () => {
			if (controlSessionMaterial !== undefined) {
				await (
					dependencies.writeGatewayControlSessionMaterial ?? writeGatewayControlSessionMaterial
				)(options.systemConfig.runtimeDir, controlSessionMaterial);
			}
			await (dependencies.writeGatewayRuntimeRecord ?? writeGatewayRuntimeRecord)(
				zone.gateway.stateDir,
				await buildGatewayRuntimeRecord({
					controllerPort: options.systemConfig.host.controllerPort,
					gatewayType: zone.gateway.type,
					ingressPort: ingress.port,
					managedVm,
					processSpec,
					projectNamespace: options.systemConfig.host.projectNamespace,
					...(dependencies.readProcessIdentity !== undefined
						? { readProcessIdentity: dependencies.readProcessIdentity }
						: {}),
					systemConfigPath: options.systemConfig.systemConfigPath,
					zoneId: zone.id,
				}),
			);
		});
		return {
			...(controlSession === undefined ? {} : { controlSession }),
			...(controlSessionMaterial === undefined
				? {}
				: {
						controlSessionRecoverySourceKey: {
							bootId: controlSessionMaterial.bootId,
							domain: 'gateway_control',
							gatewayVmId: managedVm.id,
							generationId: controlSessionMaterial.generationId,
							zoneId: controlSessionMaterial.zoneId,
						},
					}),
			image,
			ingress,
			processSpec,
			vm: managedVm,
			zone,
		};
	} catch (error) {
		await managedVm.close().catch((closeError: unknown) => {
			process.stderr.write(
				`[agent-vm] Failed to close gateway VM after startup failure: ${closeError instanceof Error ? closeError.message : JSON.stringify(closeError)}\n`,
			);
		});
		throw error;
	}
}
