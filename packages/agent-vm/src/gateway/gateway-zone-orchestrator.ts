import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	type GatewayControlCallerContextProof,
} from '@agent-vm/gateway-control-contracts';
import type {
	GatewayHealthCheck,
	GatewayLifecycle,
	GatewayProcessSpec,
	GatewayZoneConfig,
} from '@agent-vm/gateway-interface';
import {
	createWebSocketUpgradeRequestGuard,
	translateRuntimePath,
} from '@agent-vm/gateway-interface';
import {
	createManagedVm as createManagedVmFromCore,
	type ManagedVm,
} from '@agent-vm/gondolin-adapter';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';

import {
	buildGatewayControlPrivateEnvironment,
	buildGatewayControlEndpoint,
	buildGatewayControlRuntimePluginConfig,
	connectGatewayControlSession,
	createControlSessionDispatcher,
	createControlSessionFenceRegistry,
	createGatewayControlCallerContextRegistry,
	createGatewayControlDomainHandler,
	resolveGatewayControlInboundStablePrincipal,
	createGatewayControlSessionMaterial,
	createGatewaySemanticResultLedger,
	writeGatewayControlSessionMaterial,
	type GatewayControlCallerContextRegisterPayload,
	type GatewayDisposableControlSessionClient,
	type GatewayControlSessionMaterial,
} from '../controller/control-session/index.js';
import { findOpenClawLeaseWorkMountAgentMismatch } from '../controller/leases/lease-work-mount-paths.js';
import { assertCanonicalOpenClawAgentWorkspaceDir } from '../controller/leases/openclaw-agent-workspace-paths.js';
import { createOpenClawGatewayLeasePathMapping } from '../controller/leases/openclaw-gateway-lease-path-mapping.js';
import { OPENCLAW_PROCESS_SUPERVISOR_GUEST_STATE_DIRECTORY } from '../controller/process-supervisor/openclaw-process-supervisor-contracts.js';
import {
	createManagedVmOpenClawProcessSupervisorPorts,
	type OpenClawProcessReliabilityFaultActuator,
	type OpenClawProcessSupervisor,
} from '../controller/process-supervisor/openclaw-process-supervisor.js';
import type {
	GatewayEpochIdentity,
	GatewayEpochSeed,
} from '../controller/vm-ownership/vm-ownership-contracts.js';
import {
	createObservabilityRuntimeConfig,
	type ObservabilityRuntimeConfig,
} from '../observability/observability-config.js';
import { checkObservabilityStackReadiness as checkObservabilityStackReadinessDefault } from '../observability/observability-readiness.js';
import { assertOpenClawToolVmRequirements } from '../operations/openclaw-deployment-requirements.js';
import {
	terminateLiveManagedVm,
	type ManagedVmProcessTarget,
} from '../shared/controller-managed-vm-termination.js';
import {
	isProcessAlive,
	killProcess,
	readProcessCommand,
	readProcessIdentity,
	sleep,
	type ManagedVmKillDependencies,
} from '../shared/managed-vm-process.js';
import { runTaskWithResult, type RunTaskFn } from '../shared/run-task.js';
import { resolveZoneSecrets } from './credential-manager.js';
import { runGatewayHealthCheck } from './gateway-health-check.js';
import {
	buildGatewayImage,
	type GatewayImageBuilderDependencies,
} from './gateway-image-builder.js';
import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';
import {
	buildGatewayRuntimeRecord,
	deleteGatewayRuntimeRecord,
	writeGatewayRuntimeRecord,
	type GatewayRuntimeRecord,
} from './gateway-runtime-record.js';
import {
	findGatewayZone,
	mapSystemGatewayZoneToLifecycleZone,
	observabilityCollectorHost,
	type GatewayZone,
	type GatewayControlSessionConnector,
	type GatewayControlSessionMaterialFactory,
	type GatewayManagedVmFactoryOptions,
	type GatewayZonePreflightOptions,
	type GatewayZoneStartResult,
	type StartGatewayZoneOptions,
} from './gateway-zone-support.js';
import {
	preflightMcpPortalEffectiveConfig,
	writeMcpPortalEffectiveConfig,
} from './mcp-portal-effective-config.js';
import { createOpenClawGatewayProcessEpochOwner } from './openclaw-gateway-process-epoch-owner.js';

const defaultGatewayReadinessRetryDelayMs = 500;
const defaultGatewayReadinessTimeoutMs = 60_000;
const defaultGatewayReadinessMaxAttempts = Math.ceil(
	defaultGatewayReadinessTimeoutMs / defaultGatewayReadinessRetryDelayMs,
);

export function resolveOpenClawProcessSupervisorStateMount(options: {
	readonly gatewaySeed: GatewayEpochSeed;
	readonly runtimeDirectory: string;
}): { readonly guestPath: string; readonly hostPath: string } {
	const exactGatewayDigest = createHash('sha256')
		.update(options.gatewaySeed.controllerEpoch, 'utf8')
		.update('\0')
		.update(options.gatewaySeed.gatewayEpochId, 'utf8')
		.digest('hex');
	return {
		guestPath: OPENCLAW_PROCESS_SUPERVISOR_GUEST_STATE_DIRECTORY,
		hostPath: path.join(
			options.runtimeDirectory,
			'zones',
			options.gatewaySeed.zoneId,
			'openclaw-process-supervisor',
			exactGatewayDigest,
		),
	};
}

interface RequestInitWithDuplex extends RequestInit {
	readonly duplex?: 'half';
}

function requestHasBody(request: Request): boolean {
	return request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;
}

function cloneRequestToUrl(request: Request, url: URL): Request {
	const init: RequestInitWithDuplex = {
		headers: request.headers,
		method: request.method,
		...(requestHasBody(request) ? { body: request.body, duplex: 'half' } : {}),
	};
	return new Request(url, init);
}

function normalizeUrlHostname(hostname: string): string {
	return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function createOpenClawObservabilityCollectorRequestRewrite(
	zone: GatewayZoneConfig,
): ((request: Request) => Promise<Request | void>) | undefined {
	const observability = zone.observability;
	if (observability?.mode !== 'collector') {
		return undefined;
	}
	const { collector } = observability;
	return async (request: Request): Promise<Request | void> => {
		const url = new URL(request.url);
		const requestPort = url.port.length === 0 ? '80' : url.port;
		if (url.hostname !== collector.host || requestPort !== String(collector.httpPort)) {
			return undefined;
		}

		url.protocol = 'http:';
		url.hostname = normalizeUrlHostname(collector.targetHost);
		url.port = String(collector.targetHttpPort);
		return cloneRequestToUrl(request, url);
	};
}

function createGatewayVmRequestHook(options: {
	readonly vmSpec: {
		readonly websocketUpgrades?: GatewayZoneConfig['websocketUpgrades'];
	};
	readonly zone: GatewayZoneConfig;
}): (request: Request) => Promise<Request | Response | void> {
	const websocketGuard = createWebSocketUpgradeRequestGuard({
		rules: options.vmSpec.websocketUpgrades ?? [],
		runtimeAudience: 'gateway',
	});
	const observabilityRewrite = createOpenClawObservabilityCollectorRequestRewrite(options.zone);
	return async (request: Request): Promise<Request | Response | void> => {
		const websocketDecision = await websocketGuard(request);
		if (websocketDecision !== undefined) {
			return websocketDecision;
		}
		return observabilityRewrite?.(request);
	};
}

function assertOpenClawTcpHostsOverrideDoesNotBypassObservabilityMediation(options: {
	readonly tcpHostsOverride: Readonly<Record<string, string>> | undefined;
	readonly zone: GatewayZone;
}): void {
	if (options.zone.gateway.type !== 'openclaw' || options.tcpHostsOverride === undefined) {
		return;
	}
	for (const tcpHostKey of Object.keys(options.tcpHostsOverride)) {
		if (
			tcpHostKey === observabilityCollectorHost ||
			tcpHostKey.startsWith(`${observabilityCollectorHost}:`)
		) {
			throw new Error(
				`OpenClaw tcpHostsOverride cannot map observability collector host '${observabilityCollectorHost}'; use mediated OTLP HTTP observability instead.`,
			);
		}
	}
}

function assertGatewayVmOwnershipMatchesControlIdentity(options: {
	readonly controlSessionMaterial: GatewayControlSessionMaterial | undefined;
	readonly vmOwnership: Awaited<ReturnType<StartGatewayZoneOptions['createVmOwnership']>>;
	readonly zone: GatewayZone;
}): void {
	const gatewaySeed = options.vmOwnership.gatewaySeed;
	if (options.zone.gateway.type !== 'openclaw') {
		return;
	}
	if (options.controlSessionMaterial === undefined) {
		throw new Error(
			`OpenClaw zone '${options.zone.id}' requires one shared Gateway and control identity.`,
		);
	}
	if (
		gatewaySeed.bootId !== options.controlSessionMaterial.bootId ||
		gatewaySeed.controllerEpoch !== options.controlSessionMaterial.controllerEpoch ||
		gatewaySeed.generationId !== options.controlSessionMaterial.generationId ||
		gatewaySeed.zoneId !== options.controlSessionMaterial.zoneId
	) {
		throw new Error(
			`OpenClaw zone '${options.zone.id}' Gateway ownership identity does not match its control material.`,
		);
	}
}

export function validateGatewayControlCallerContextRegistration(options: {
	readonly agentAuthorityKeys: Readonly<Record<string, string>>;
	readonly callerContextProofKey: string;
	readonly payload: GatewayControlCallerContextRegisterPayload;
	readonly zone: GatewayZone;
}): void {
	const evidence = options.payload.adapterEvidence;
	if (options.zone.gateway.type !== 'openclaw') {
		throw new Error('Gateway control caller context registration requires an OpenClaw zone.');
	}
	const configuredAgentIds = new Set((options.zone.agents ?? []).map((agent) => agent.id));
	if (configuredAgentIds.size === 0 || !configuredAgentIds.has(evidence.agentId)) {
		throw new Error(
			`Gateway control caller context rejected undeclared OpenClaw agent '${evidence.agentId}'.`,
		);
	}
	if (
		!verifyGatewayControlCallerContextProof({
			proof: evidence.proof,
			proofKey: options.callerContextProofKey,
			proofPayload: buildGatewayControlCallerContextProofPayload(evidence),
		})
	) {
		throw new Error('Gateway control caller context rejected invalid caller-context proof.');
	}
	const agentAuthorityKey = options.agentAuthorityKeys[evidence.agentId];
	if (agentAuthorityKey === undefined) {
		throw new Error(
			`Gateway control caller context rejected missing agent authority for OpenClaw agent '${evidence.agentId}'.`,
		);
	}
	if (evidence.agentAuthority === undefined) {
		throw new Error(
			`Gateway control caller context rejected missing agent authority proof for OpenClaw agent '${evidence.agentId}'.`,
		);
	}
	if (
		evidence.agentAuthority.keyId !== evidence.agentId ||
		!verifyGatewayControlCallerContextProof({
			proof: evidence.agentAuthority,
			proofKey: agentAuthorityKey,
			proofPayload: buildGatewayControlCallerContextAgentAuthorityPayload(evidence),
		})
	) {
		throw new Error('Gateway control caller context rejected invalid agent authority proof.');
	}
	assertCanonicalOpenClawAgentWorkspaceDir({
		agentId: evidence.agentId,
		agentWorkspaceDir: evidence.agentWorkspaceDir,
		context: 'Gateway control caller context',
	});
	const workMountTranslation = translateRuntimePath({
		inputPath: evidence.workMountDir,
		mapping: createOpenClawGatewayLeasePathMapping({
			stateDir: options.zone.gateway.stateDir,
			zoneFilesDir: options.zone.gateway.zoneFilesDir,
		}),
		purpose: 'leaseMount',
		sourceNamespace: 'openclaw-gateway',
		targetNamespace: 'controller-host',
	});
	if (!workMountTranslation.ok) {
		throw new Error(
			`Gateway control caller context rejected invalid OpenClaw workMountDir '${evidence.workMountDir}': ${workMountTranslation.error.message}`,
		);
	}
	const workMountAgentMismatch = findOpenClawLeaseWorkMountAgentMismatch({
		agentId: evidence.agentId,
		relativePath: workMountTranslation.value.relativePath,
		rootId: workMountTranslation.value.rootId,
		workMountDir: evidence.workMountDir,
	});
	if (workMountAgentMismatch !== undefined) {
		throw new Error(
			`Gateway control caller context rejected OpenClaw workMountDir '${evidence.workMountDir}': ${workMountAgentMismatch}`,
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

function verifyGatewayControlCallerContextProof(options: {
	readonly proof: GatewayControlCallerContextProof;
	readonly proofKey: string;
	readonly proofPayload: string;
}): boolean {
	if (options.proof.algorithm !== 'hmac-sha256') {
		return false;
	}
	const expectedDigest = createHmac('sha256', options.proofKey)
		.update(options.proofPayload, 'utf8')
		.digest('base64url');
	const receivedDigestBuffer = Buffer.from(options.proof.digest, 'utf8');
	const expectedDigestBuffer = Buffer.from(expectedDigest, 'utf8');
	return (
		receivedDigestBuffer.length === expectedDigestBuffer.length &&
		timingSafeEqual(receivedDigestBuffer, expectedDigestBuffer)
	);
}

export interface GatewayManagerDependencies extends GatewayImageBuilderDependencies {
	readonly checkObservabilityStackReadiness?: typeof checkObservabilityStackReadinessDefault;
	readonly connectGatewayControlSession?: GatewayControlSessionConnector;
	readonly createManagedVm?: (options: GatewayManagedVmFactoryOptions) => Promise<ManagedVm>;
	readonly createGatewayControlSessionMaterial?: GatewayControlSessionMaterialFactory;
	readonly createOpenClawProcessSupervisorPorts?: typeof createManagedVmOpenClawProcessSupervisorPorts;
	readonly gatewayReadinessMaxAttempts?: number;
	readonly gatewayReadinessRetryDelayMs?: number;
	readonly loadGatewayLifecycle?: (type: GatewayZoneConfig['gateway']['type']) => GatewayLifecycle;
	readonly managedVmKillDependencies?: ManagedVmKillDependencies;
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

interface ControllerStartGatewayZoneOptions extends StartGatewayZoneOptions {
	readonly onOpenClawProcessReliabilityFaultTarget?: (target: {
		readonly controlSession?: GatewayDisposableControlSessionClient | undefined;
		readonly gateway: GatewayEpochIdentity;
		readonly processEpoch: string;
		readonly reliabilityFaultActuator: OpenClawProcessReliabilityFaultActuator;
	}) => void;
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

function buildControlSessionRuntimePrivateEnvironment(options: {
	readonly material: ReturnType<typeof createGatewayControlSessionMaterial>;
}): GatewayZoneConfig['runtimePrivateEnvironment'] {
	return buildGatewayControlPrivateEnvironment(options.material);
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

const MAX_GATEWAY_LOG_TAIL_CHARACTERS = 16 * 1024;
const GATEWAY_LOG_TAIL_TRUNCATION_MARKER = '[gateway log tail truncated]\n';

function boundGatewayLogTail(logTail: string): string {
	if (logTail.length <= MAX_GATEWAY_LOG_TAIL_CHARACTERS) {
		return logTail;
	}
	return `${GATEWAY_LOG_TAIL_TRUNCATION_MARKER}${logTail.slice(
		-(MAX_GATEWAY_LOG_TAIL_CHARACTERS - GATEWAY_LOG_TAIL_TRUNCATION_MARKER.length),
	)}`;
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
		return output.length > 0 ? boundGatewayLogTail(output) : undefined;
	} catch {
		return undefined;
	}
}

function formatElapsedSeconds(startedAtMs: number): string {
	return ((Date.now() - startedAtMs) / 1000).toFixed(1);
}

export async function waitForGatewayServiceHealth(options: {
	readonly attempt?: number;
	readonly healthCheck: GatewayHealthCheck;
	readonly lastObservation?: string;
	readonly logPath: string;
	readonly managedVm: ManagedVm;
	readonly maxAttempts?: number;
	readonly retryDelayMs?: number;
	readonly signal?: AbortSignal;
	readonly startedAtMs?: number;
}): Promise<void> {
	options.signal?.throwIfAborted();
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
	options.signal?.throwIfAborted();
	if (result.ok) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		const retryTimeout = setTimeout(() => {
			options.signal?.removeEventListener('abort', abortRetry);
			resolve();
		}, retryDelayMs);
		const abortRetry = (): void => {
			clearTimeout(retryTimeout);
			reject(options.signal?.reason);
		};
		if (options.signal?.aborted === true) {
			abortRetry();
			return;
		}
		options.signal?.addEventListener('abort', abortRetry, { once: true });
	});
	await waitForGatewayServiceHealth({
		attempt: attempt + 1,
		healthCheck: options.healthCheck,
		lastObservation: result.observation,
		logPath: options.logPath,
		managedVm: options.managedVm,
		maxAttempts,
		retryDelayMs,
		...(options.signal === undefined ? {} : { signal: options.signal }),
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
	options: GatewayZonePreflightOptions,
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
	options: GatewayZonePreflightOptions,
	dependencies: Pick<GatewayManagerDependencies, 'loadGatewayLifecycle'> = {},
): Promise<GatewayZoneStartPrerequisitePreflightResult> {
	const zone = options.zoneOverride ?? findGatewayZone(options.systemConfig, options.zoneId);
	const mappedLifecycleZone = mapSystemGatewayZoneToLifecycleZone(zone, {
		hostObservability: options.systemConfig.host.observability,
	});
	const controlSessionMaterial =
		zone.gateway.type === 'openclaw' && options.controlSession !== undefined
			? createGatewayControlSessionMaterial({
					agentIds: (zone.agents ?? []).map((agent) => agent.id),
					controllerEpoch: options.controlSession.controllerEpoch,
					zoneId: zone.id,
				})
			: undefined;
	const controlSessionRuntimePluginConfigs =
		controlSessionMaterial === undefined
			? undefined
			: buildControlSessionRuntimePluginConfigs({ material: controlSessionMaterial });
	const controlSessionRuntimePrivateEnvironment =
		controlSessionMaterial === undefined
			? undefined
			: buildControlSessionRuntimePrivateEnvironment({ material: controlSessionMaterial });
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
		...(controlSessionRuntimePrivateEnvironment === undefined
			? {}
			: { runtimePrivateEnvironment: controlSessionRuntimePrivateEnvironment }),
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
	return await startGatewayZoneImplementation(options, dependencies);
}

export async function startGatewayZoneForController(
	options: ControllerStartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies = {},
): Promise<GatewayZoneStartResult> {
	return await startGatewayZoneImplementation(
		options,
		dependencies,
		options.onOpenClawProcessReliabilityFaultTarget,
	);
}

async function startGatewayZoneImplementation(
	options: StartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies,
	onOpenClawProcessReliabilityFaultTarget?: ControllerStartGatewayZoneOptions['onOpenClawProcessReliabilityFaultTarget'],
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
					agentIds: (zone.agents ?? []).map((agent) => agent.id),
					controllerEpoch: options.controlSession.controllerEpoch,
					zoneId: zone.id,
				})
			: undefined;
	const assertCurrentControlSessionTransition = (
		expectedMaterial: GatewayControlSessionMaterial,
		transition: {
			readonly gatewayEpoch: string;
			readonly processEpoch: string;
			readonly zoneId: string;
		},
	): void => {
		if (
			transition.gatewayEpoch !== expectedMaterial.generationId ||
			transition.processEpoch !== expectedMaterial.processEpoch ||
			transition.zoneId !== expectedMaterial.zoneId
		) {
			throw new Error(
				`Gateway control transition does not match the current zone/process material for zone '${zone.id}'.`,
			);
		}
	};
	const lifecycle = (dependencies.loadGatewayLifecycle ?? loadGatewayLifecycle)(zone.gateway.type);

	// Phase A: prove standalone Worker ownership before doing any other startup work.
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
	const {
		runtimePrivateEnvironment: mappedRuntimePrivateEnvironment,
		runtimePluginConfigs: mappedRuntimePluginConfigs,
		...mappedLifecycleZoneBase
	} = mappedLifecycleZone;
	const baseRuntimePluginConfigs = mergeRuntimePluginConfigs(
		mergeRuntimePluginConfigs(
			mappedRuntimePluginConfigs,
			toolPortalMaterialization.runtimePluginConfigs,
		),
		options.runtimePluginConfigs,
	);
	const buildLifecycleZoneForControlMaterial = (
		material: GatewayControlSessionMaterial | undefined,
	): GatewayZoneConfig => {
		const runtimePluginConfigs = mergeRuntimePluginConfigs(
			baseRuntimePluginConfigs,
			material === undefined ? undefined : buildControlSessionRuntimePluginConfigs({ material }),
		);
		const runtimePrivateEnvironment =
			material === undefined
				? mappedRuntimePrivateEnvironment
				: {
						...mappedRuntimePrivateEnvironment,
						...buildControlSessionRuntimePrivateEnvironment({ material }),
					};
		return {
			...mappedLifecycleZoneBase,
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
			...(runtimePrivateEnvironment === undefined ? {} : { runtimePrivateEnvironment }),
		};
	};
	const lifecycleZone = buildLifecycleZoneForControlMaterial(controlSessionMaterial);
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
	assertOpenClawTcpHostsOverrideDoesNotBypassObservabilityMediation({
		tcpHostsOverride: options.tcpHostsOverride,
		zone,
	});
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
	const vmOwnership = await runTaskWithResult(
		runTaskStep,
		'Reserving gateway VM ownership',
		async () =>
			await options.createVmOwnership({
				...(controlSessionMaterial === undefined
					? {}
					: {
							controlIdentity: {
								bootId: controlSessionMaterial.bootId,
								generationId: controlSessionMaterial.generationId,
							},
						}),
				kind: zone.gateway.type === 'openclaw' ? 'gateway-epoch' : 'standalone',
				sessionLabel: vmSpec.sessionLabel,
				zoneId: zone.id,
			}),
	);
	assertGatewayVmOwnershipMatchesControlIdentity({
		controlSessionMaterial,
		vmOwnership,
		zone,
	});
	let exactGatewayVfsMounts = vfsMounts;
	let openClawProcessSupervisorStateMount:
		| { readonly guestPath: string; readonly hostPath: string }
		| undefined;
	if (zone.gateway.type === 'openclaw') {
		const supervisorStateMount = resolveOpenClawProcessSupervisorStateMount({
			gatewaySeed: vmOwnership.gatewaySeed,
			runtimeDirectory: options.systemConfig.runtimeDir,
		});
		await fs.mkdir(supervisorStateMount.hostPath, { mode: 0o700, recursive: true });
		await fs.chmod(supervisorStateMount.hostPath, 0o700);
		openClawProcessSupervisorStateMount = supervisorStateMount;
		exactGatewayVfsMounts = {
			...vfsMounts,
			[supervisorStateMount.guestPath]: {
				hostPath: supervisorStateMount.hostPath,
				kind: 'realfs',
			},
		};
	}
	let pendingCreateContainment: Promise<void> | undefined;
	const createManagedVmPromise = runTaskWithResult(
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
				onRequest: createGatewayVmRequestHook({ vmSpec, zone: lifecycleZone }),
				secrets: vmSpec.mediatedSecrets,
				sessionLabel: vmSpec.sessionLabel,
				...(vmSpec.sshEgress ? { sshEgress: vmSpec.sshEgress } : {}),
				tcpHosts,
				vfsMounts: exactGatewayVfsMounts,
			}),
	);
	if (options.onPendingVmCreation !== undefined) {
		options.onPendingVmCreation({
			contain(): Promise<void> {
				pendingCreateContainment ??= vmOwnership.containPendingCreate({
					closeLateCreatedVm: async (lateCreatedVm) => await lateCreatedVm.close(),
					pendingCreate: createManagedVmPromise,
				});
				void pendingCreateContainment.catch(() => undefined);
				return pendingCreateContainment;
			},
		});
	}
	let managedVm: ManagedVm;
	try {
		managedVm = await createManagedVmPromise;
		if (pendingCreateContainment !== undefined) {
			await pendingCreateContainment;
			throw new Error(`Pending Gateway VM creation was contained for zone '${zone.id}'.`);
		}
	} catch (createError) {
		if (pendingCreateContainment !== undefined) {
			await pendingCreateContainment;
			throw createError;
		}
		throw createError;
	}
	let gatewayIdentity: GatewayEpochIdentity;
	let startupRuntimeRecord: GatewayRuntimeRecord | undefined;
	let startupProcessTarget: ManagedVmProcessTarget | undefined;
	let gatewayIngressAccess: Awaited<ReturnType<ManagedVm['enableIngress']>> | undefined;
	let gatewayIngressClosePromise: Promise<void> | undefined;
	let gatewayTerminationPromise: Promise<void> | undefined;
	const managedVmKillDependencies = dependencies.managedVmKillDependencies ?? {
		isProcessAlive,
		killProcess,
		readProcessCommand,
		readProcessIdentity,
		sleep,
	};
	const captureGatewayProcessTarget = async (): Promise<ManagedVmProcessTarget> => {
		const hostPid = managedVm.getHostPid();
		if (hostPid === null || !Number.isInteger(hostPid) || hostPid <= 0) {
			throw new Error(
				`Gateway VM '${managedVm.id}' does not expose a valid live runner pid for controller-owned cleanup.`,
			);
		}
		const processIdentityReader = dependencies.readProcessIdentity ?? readProcessIdentity;
		const processIdentity = await processIdentityReader(hostPid);
		if (processIdentity === null) {
			throw new Error(
				`Gateway VM '${managedVm.id}' pid ${String(hostPid)} disappeared before process identity capture.`,
			);
		}
		return { hostPid, processIdentity, vmId: managedVm.id };
	};
	const closeGatewayIngress = async (): Promise<void> => {
		if (gatewayIngressAccess === undefined) {
			return;
		}
		gatewayIngressClosePromise ??= gatewayIngressAccess.close();
		await gatewayIngressClosePromise;
	};
	const terminateManagedGatewayVm = async (): Promise<void> => {
		if (startupProcessTarget === undefined) {
			if (managedVm.getHostPid() === null) {
				await managedVm.close();
				return;
			}
			startupProcessTarget = await captureGatewayProcessTarget();
		}
		await terminateLiveManagedVm({
			contextLabel: `Gateway VM '${managedVm.id}' for zone '${zone.id}'`,
			dependencies: managedVmKillDependencies,
			target: startupProcessTarget,
			vm: managedVm,
		});
	};
	const performGatewayTermination = async (): Promise<void> => {
		// Start draining ingress before terminating the runner so no new work is
		// admitted. Do not await the drain yet: Node's server.close() waits for
		// upgraded Socket.IO connections, and those connections settle when the
		// Gateway runner is terminated below.
		const ingressCloseOutcome = closeGatewayIngress().then(
			() => undefined,
			(error: unknown) => error,
		);
		let vmTerminationError: unknown;
		try {
			await terminateManagedGatewayVm();
		} catch (error) {
			vmTerminationError = error;
		}
		const ingressCloseError = await ingressCloseOutcome;
		if (ingressCloseError !== undefined && vmTerminationError !== undefined) {
			throw new AggregateError(
				[ingressCloseError, vmTerminationError],
				`Gateway ingress and VM '${managedVm.id}' teardown both failed.`,
				{ cause: ingressCloseError },
			);
		}
		if (ingressCloseError !== undefined) {
			throw ingressCloseError;
		}
		if (vmTerminationError !== undefined) {
			throw vmTerminationError;
		}
	};
	const terminateGatewayVm = (): Promise<void> => {
		gatewayTerminationPromise ??= performGatewayTermination();
		return gatewayTerminationPromise;
	};
	try {
		gatewayIdentity = vmOwnership.attachGatewayVm(managedVm.id);
		await managedVm.start();
		const capturedStartupProcessTarget = await captureGatewayProcessTarget();
		startupProcessTarget = capturedStartupProcessTarget;
		startupRuntimeRecord = await buildGatewayRuntimeRecord({
			controllerPort: options.systemConfig.host.controllerPort,
			gatewayIdentity,
			gatewayType: zone.gateway.type,
			managedVm,
			processSpec,
			projectNamespace: options.systemConfig.host.projectNamespace,
			readProcessIdentity: async (hostPid) =>
				hostPid === capturedStartupProcessTarget.hostPid
					? capturedStartupProcessTarget.processIdentity
					: null,
			systemConfigPath: options.systemConfig.systemConfigPath,
			zoneId: zone.id,
		});
		await (dependencies.writeGatewayRuntimeRecord ?? writeGatewayRuntimeRecord)(
			zone.gateway.stateDir,
			startupRuntimeRecord,
		);
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
		let openClawProcessSupervisor: OpenClawProcessSupervisor | undefined;
		let openClawProcessReliabilityFaultActuator:
			| OpenClawProcessReliabilityFaultActuator
			| undefined;
		const gatewaySemanticLedger = createGatewaySemanticResultLedger({
			gateway: gatewayIdentity,
			nowMs: Date.now,
		});
		const processEpoch = controlSessionMaterial?.processEpoch ?? randomUUID();
		if (zone.gateway.type === 'openclaw') {
			if (openClawProcessSupervisorStateMount === undefined) {
				throw new Error(
					`OpenClaw zone '${zone.id}' cannot start its process without exact Gateway supervisor state.`,
				);
			}
			const processSupervisorPorts = (
				dependencies.createOpenClawProcessSupervisorPorts ??
				createManagedVmOpenClawProcessSupervisorPorts
			)({
				gateway: {
					controllerEpoch: gatewayIdentity.controllerEpoch,
					gatewayEpochId: gatewayIdentity.gatewayEpochId,
					gatewayVmId: gatewayIdentity.gatewayVmId,
				},
				hostStateDirectory: openClawProcessSupervisorStateMount.hostPath,
				vm: managedVm,
			});
			const processSupervisor = processSupervisorPorts.supervisor;
			openClawProcessSupervisor = processSupervisor;
			openClawProcessReliabilityFaultActuator = processSupervisorPorts.reliabilityFaultActuator;
			await runTaskStep('Starting OpenClaw process', async () => {
				await processSupervisor.start({
					actionId: `process-start-${randomUUID()}`,
					expectedProcessEpoch: null,
					selectedProcessEpoch: processEpoch,
				});
			});
			const processObservation = await runTaskWithResult(
				runTaskStep,
				'Observing OpenClaw process',
				async () =>
					await processSupervisor.observe({
						actionId: `process-observe-${randomUUID()}`,
						expectedProcessEpoch: processEpoch,
					}),
			);
			if (
				processObservation.kind !== 'observe' ||
				processObservation.observedProcessEpoch !== processEpoch ||
				!processObservation.cgroup.populated
			) {
				const logTail = await readGatewayLogTail({
					logPath: processSpec.logPath,
					managedVm,
				});
				throw new Error(
					`OpenClaw process '${processEpoch}' was not positively observed in its exact cgroup.${logTail ? `\nGateway log tail (${processSpec.logPath}):\n${logTail}` : ''}`,
				);
			}
		}
		const startupHealthCheck = processSpec.serviceHealthCheck ?? processSpec.healthCheck;
		await runTaskStep('Waiting for service health', async () => {
			await waitForGatewayServiceHealth({
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
		gatewayIngressAccess = ingress;
		const connectControlSessionForMaterial = async (
			material: GatewayControlSessionMaterial,
			connectOptions: { readonly signal?: AbortSignal } = {},
		): Promise<GatewayDisposableControlSessionClient> => {
			if (gatewayIdentity === undefined || gatewaySemanticLedger === undefined) {
				throw new Error(
					`OpenClaw zone '${zone.id}' cannot bind semantic control authority without an exact Gateway identity.`,
				);
			}
			const sessionFenceRegistry = createControlSessionFenceRegistry();
			const dispatcher = createControlSessionDispatcher({
				semanticLedger: gatewaySemanticLedger,
				sessionFenceRegistry,
			});
			const callerContexts = createGatewayControlCallerContextRegistry({
				agentAuthorityKeys: material.agentAuthorityKeys,
				callerContextProofKey: material.callerContextProofKey,
			});
			const validateCallerContextRegistration = (
				payload: GatewayControlCallerContextRegisterPayload,
			): void => {
				validateGatewayControlCallerContextRegistration({
					agentAuthorityKeys: material.agentAuthorityKeys,
					callerContextProofKey: material.callerContextProofKey,
					payload,
					zone,
				});
			};
			let lastLoggedControlAttemptOutcome: string | undefined;
			dispatcher.register(
				'gateway_control',
				createGatewayControlDomainHandler({
					callerContexts,
					gateway: gatewayIdentity,
					...(options.gatewayControlControllerHostActions === undefined
						? {}
						: { controllerHostActions: options.gatewayControlControllerHostActions }),
					...(options.gatewayControlLeaseRpc === undefined
						? {}
						: { leaseRpc: options.gatewayControlLeaseRpc }),
					...(options.healthEventStore === undefined &&
					options.onControlSessionHeartbeat === undefined
						? {}
						: {
								recordHealthEvent: (event) => {
									options.healthEventStore?.record(event);
									if (
										event.kind === 'gateway-control-session' &&
										event.operation === 'control-session-heartbeat' &&
										event.result === 'ok'
									) {
										options.onControlSessionHeartbeat?.({
											gateway: gatewayIdentity,
											observedAtMs: event.observedAtMs,
											processEpoch: material.processEpoch,
										});
									}
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
						bootId: material.processEpoch,
						controllerEpoch: material.controllerEpoch,
						peerId: material.peerId,
						zoneId: material.zoneId,
					},
					validateCallerContextRegistration,
				}),
			);
			return await (dependencies.connectGatewayControlSession ?? connectGatewayControlSession)({
				dispatcher,
				endpoint: buildGatewayControlEndpoint(ingress),
				material,
				onAttemptOutcome: (outcome) => {
					const boundedOutcome =
						outcome.kind === 'hello_response'
							? `hello_response:${outcome.outcome}`
							: 'connect_error';
					if (lastLoggedControlAttemptOutcome !== boundedOutcome) {
						lastLoggedControlAttemptOutcome = boundedOutcome;
						process.stderr.write(
							`[gateway-zone-orchestrator] control attachment for zone '${zone.id}' process '${material.processEpoch}': ${boundedOutcome}\n`,
						);
					}
					options.onControlSessionAttemptOutcome?.({
						...outcome,
						gateway: gatewayIdentity,
						processEpoch: material.processEpoch,
					});
				},
				...(connectOptions.signal === undefined ? {} : { signal: connectOptions.signal }),
				resolveInboundStablePrincipal: ({ envelope, message }) =>
					resolveGatewayControlInboundStablePrincipal({
						callerContexts,
						envelope,
						message,
						validateCallerContextRegistration,
					}),
				...(options.onControlSessionAttachmentGap === undefined
					? {}
					: {
							onAttachmentGap: (transition) => {
								assertCurrentControlSessionTransition(material, transition);
								options.onControlSessionAttachmentGap?.({
									...transition,
									gateway: gatewayIdentity,
								});
							},
						}),
				...(options.onControlSessionReconnectExhausted === undefined
					? {}
					: {
							onReconnectExhausted: (transition) => {
								assertCurrentControlSessionTransition(material, transition);
								options.onControlSessionReconnectExhausted?.({
									...transition,
									gateway: gatewayIdentity,
								});
							},
						}),
				...(options.gatewayControlProcessAdmissionCoordinator === undefined
					? {}
					: {
							processAdmissionCoordinator: options.gatewayControlProcessAdmissionCoordinator,
						}),
				sessionFenceRegistry,
			});
		};
		const controlSession =
			controlSessionMaterial === undefined
				? undefined
				: await runTaskWithResult(
						runTaskStep,
						'Connecting gateway control session',
						async () => await connectControlSessionForMaterial(controlSessionMaterial),
					);
		let lastSuccessfullyPersistedControlMaterial: GatewayControlSessionMaterial | undefined;
		const persistGatewayProcessBinding = async (
			material: GatewayControlSessionMaterial | undefined,
			bindingProcessSpec: GatewayProcessSpec,
		): Promise<void> => {
			const writeControlSessionMaterial =
				dependencies.writeGatewayControlSessionMaterial ?? writeGatewayControlSessionMaterial;
			const previousControlMaterial = lastSuccessfullyPersistedControlMaterial;
			if (material !== undefined) {
				await writeControlSessionMaterial(options.systemConfig.runtimeDir, material);
			}
			try {
				await (dependencies.writeGatewayRuntimeRecord ?? writeGatewayRuntimeRecord)(
					zone.gateway.stateDir,
					await buildGatewayRuntimeRecord({
						controllerPort: options.systemConfig.host.controllerPort,
						gatewayIdentity,
						gatewayType: zone.gateway.type,
						ingressPort: ingress.port,
						managedVm,
						processSpec: bindingProcessSpec,
						projectNamespace: options.systemConfig.host.projectNamespace,
						...(dependencies.readProcessIdentity !== undefined
							? { readProcessIdentity: dependencies.readProcessIdentity }
							: {}),
						systemConfigPath: options.systemConfig.systemConfigPath,
						zoneId: zone.id,
					}),
				);
			} catch (runtimeRecordError) {
				if (material === undefined || previousControlMaterial === undefined) {
					throw runtimeRecordError;
				}
				try {
					await writeControlSessionMaterial(
						options.systemConfig.runtimeDir,
						previousControlMaterial,
					);
				} catch (materialRestorationError) {
					const aggregateError = new AggregateError(
						[runtimeRecordError, materialRestorationError],
						`Gateway process binding for zone '${zone.id}' failed and its previous control material could not be restored.`,
					);
					aggregateError.cause = runtimeRecordError;
					throw aggregateError;
				}
				throw runtimeRecordError;
			}
			lastSuccessfullyPersistedControlMaterial = material;
		};
		await runTaskStep('Recording gateway runtime', async () => {
			await persistGatewayProcessBinding(controlSessionMaterial, processSpec);
		});
		const openClawProcessEpochOwner =
			controlSessionMaterial === undefined ||
			controlSession === undefined ||
			gatewayIdentity === undefined ||
			openClawProcessSupervisor === undefined ||
			options.beginProcessEpochLoss === undefined
				? undefined
				: createOpenClawGatewayProcessEpochOwner({
						beginProcessEpochLoss: options.beginProcessEpochLoss,
						connectControlSession: async (material, connectOptions) =>
							await runTaskWithResult(
								runTaskStep,
								'Connecting successor gateway control session',
								async () =>
									await connectControlSessionForMaterial(material, {
										signal: connectOptions.signal,
									}),
							),
						gateway: gatewayIdentity,
						initialBinding: {
							controlSession,
							material: controlSessionMaterial,
							processSpec,
						},
						persistBinding: async (binding) =>
							await runTaskStep('Recording successor gateway runtime', async () => {
								await persistGatewayProcessBinding(binding.material, binding.processSpec);
							}),
						prepareProcess: async (material) => {
							const successorLifecycleZone = buildLifecycleZoneForControlMaterial(material);
							await runTaskStep('Preparing successor OpenClaw host state', async () => {
								await lifecycle.prepareHostState?.(successorLifecycleZone, startupSecretResolver);
							});
							const successorProcessSpec = lifecycle.buildProcessSpec(
								successorLifecycleZone,
								resolvedSecrets,
							);
							await runTaskStep('Configuring successor OpenClaw process', async () => {
								await execGatewayCommand({
									command: successorProcessSpec.bootstrapCommand,
									managedVm,
									stepName: 'Configuring successor OpenClaw process',
								});
							});
							return successorProcessSpec;
						},
						rollbackPersistedBinding: async (binding) =>
							await runTaskStep('Restoring previous gateway runtime', async () => {
								await persistGatewayProcessBinding(binding.material, binding.processSpec);
							}),
						supervisor: openClawProcessSupervisor,
						waitForServiceHealth: async (successorProcessSpec, healthOptions) => {
							await waitForGatewayServiceHealth({
								healthCheck:
									successorProcessSpec.serviceHealthCheck ?? successorProcessSpec.healthCheck,
								logPath: successorProcessSpec.logPath,
								managedVm,
								signal: healthOptions.signal,
								...(dependencies.gatewayReadinessMaxAttempts === undefined
									? {}
									: { maxAttempts: dependencies.gatewayReadinessMaxAttempts }),
								...(dependencies.gatewayReadinessRetryDelayMs === undefined
									? {}
									: { retryDelayMs: dependencies.gatewayReadinessRetryDelayMs }),
							});
						},
					});
		if (
			controlSession !== undefined &&
			gatewayIdentity !== undefined &&
			openClawProcessReliabilityFaultActuator !== undefined
		) {
			onOpenClawProcessReliabilityFaultTarget?.({
				controlSession,
				gateway: gatewayIdentity,
				processEpoch,
				reliabilityFaultActuator: openClawProcessReliabilityFaultActuator,
			});
		}
		return {
			...(controlSession === undefined ? {} : { controlSession }),
			...(openClawProcessSupervisor === undefined
				? {}
				: { openClawProcessSupervisor, processEpoch }),
			...(openClawProcessEpochOwner === undefined ? {} : { openClawProcessEpochOwner }),
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
			ingress: { host: ingress.host, port: ingress.port },
			processSpec,
			terminateVm: terminateGatewayVm,
			vm: managedVm,
			vmOwnership,
			zone,
		};
	} catch (error) {
		let closeError: unknown;
		try {
			await vmOwnership.destroyLive(terminateGatewayVm);
			if (startupRuntimeRecord !== undefined) {
				await deleteGatewayRuntimeRecord(zone.gateway.stateDir);
			}
		} catch (caughtCloseError) {
			closeError = caughtCloseError;
		}
		if (closeError !== undefined) {
			const aggregateError = new AggregateError(
				[error, closeError],
				`Gateway startup failed and VM '${managedVm.id}' teardown was not proven complete.`,
			);
			aggregateError.cause = error;
			throw aggregateError;
		}
		throw error;
	}
}
