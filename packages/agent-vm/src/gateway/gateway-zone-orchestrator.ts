import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { GatewayRuntimeFrameworkIdentity } from '@agent-vm/agent-portal-sdk/contracts';
import { CONTROL_PROTOCOL_VERSION } from '@agent-vm/control-protocol-contracts';
import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcMessageSchema,
	gatewayControlCommandExecutionTimeoutMsByOperation,
	gatewayControlDeliveryPolicyByOperation,
	type GatewayControlToolVmBindingPublication,
	type GatewayControlToolVmBindingPublicationAuthority,
	type GatewayRuntimePortalAdmissionMaterial,
	type GatewayRuntimeReadinessSnapshot,
	type GatewayControlCallerContextProof,
	type ManagedAgentProjection,
} from '@agent-vm/gateway-control-contracts';
import type {
	AgentVmHealthEvent,
	GatewayHealthCheck,
	GatewayLifecycle,
	GatewayZoneConfig,
} from '@agent-vm/gateway-lifecycle';
import { createWebSocketUpgradeRequestGuard } from '@agent-vm/gateway-lifecycle';
import type {
	ManagedVm,
	ManagedVmExactProcessTerminationCapability,
	ManagedVmFactory,
	ManagedVmImageBuildResult,
	ManagedVmMediatedSecretDescriptor,
	ManagedVmOwnedDirectoryCapability,
} from '@agent-vm/managed-vm';
import { redactCredentialText } from '@agent-vm/mcp-portal/core';
import {
	redactOnePasswordReferences,
	type SecretRef,
	type SecretResolver,
} from '@agent-vm/secret-management';

import {
	buildGatewayControlPrivateEnvironment,
	buildGatewayControlEndpoint,
	connectGatewayControlSession,
	createControlSessionDispatcher,
	createControlSessionFenceRegistry,
	createGatewayControlCallerContextRegistry,
	createGatewayControlBindingPublicationCoordinator,
	createGatewayControlDomainHandler,
	deleteGatewayControlSessionMaterial,
	resolveGatewayControlInboundStablePrincipal,
	createGatewayControlSessionMaterial,
	createGatewaySemanticResultLedger,
	writeGatewayControlSessionMaterial,
	type GatewayControlCallerContextRegisterPayload,
	type GatewayDisposableControlSessionClient,
	type GatewayControlSessionMaterial,
} from '../controller/control-session/index.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
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
import { readProcessIdentity, sleep } from '../shared/managed-vm-process.js';
import { runTaskWithResult, type RunTaskFn } from '../shared/run-task.js';
import { resolveZoneSecrets } from './credential-manager.js';
import type {
	GatewayExpectedAdmissionCohort,
	GatewayIngressRouteIdentity,
} from './gateway-aggregate-admission-state.js';
import {
	createGatewayAggregateReadinessObserver,
	type GatewayControlSessionReadinessEvidence,
	type GatewayFrameworkNativeReadinessEvidence,
	type GatewayVmLivenessEvidence,
} from './gateway-aggregate-readiness-observer.js';
import type { GatewayAtomicAdmissionCandidate } from './gateway-atomic-admission-contract.js';
import { createGatewayAtomicAdmissionController } from './gateway-atomic-admission-controller.js';
import { runGatewayHealthCheck } from './gateway-health-check.js';
import {
	buildGatewayImage,
	type GatewayImageBuilderDependencies,
} from './gateway-image-builder.js';
import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';
import { createGatewayObservabilityOtlpRequestMediation } from './gateway-observability-otlp-request-mediation.js';
import { writeGatewayRuntimePortalAdmissionFile } from './gateway-runtime-portal-admission-file.js';
import { materializeGatewayRuntimePortalAdmission } from './gateway-runtime-portal-admission-material.js';
import type { GatewayRuntimeRoleReadinessEvidence } from './gateway-runtime-readiness-plane-mapper.js';
import {
	deleteManagedGatewayRuntimeRecord,
	buildManagedGatewayRuntimeRecord,
	writeManagedGatewayRuntimeRecord,
	type ManagedGatewayRuntimeRecord,
} from './gateway-runtime-record.js';
import { createGatewayZoneDestructionTransaction } from './gateway-zone-destruction-transaction.js';
import {
	createGatewayZoneVmOperations,
	findGatewayZone,
	mapSystemGatewayZoneToLifecycleZone,
	observabilityCollectorHost,
	type GatewayZone,
	type GatewayControlSessionConnector,
	type GatewayControlSessionMaterialFactory,
	type GatewayZoneDestroyResult,
	type GatewayZonePreflightOptions,
	type GatewayZoneStartResult,
	type StartGatewayZoneOptions,
} from './gateway-zone-support.js';
import {
	materializeManagedAgentGitDirectoryRoot,
	materializeManagedAgentRootStorage,
} from './managed-agent-root-storage.js';
import { buildManagedFrameworkAgentProjectionInputs } from './managed-framework-agent-projections.js';
import {
	createManagedGatewayBootContract,
	managedGatewayBootInputPaths,
} from './managed-gateway-boot-contract.js';
import { serializeManagedGatewayBootInputs } from './managed-gateway-boot-input-materializer.js';
import {
	buildManagedGatewayExpectedAdmissionCohort,
	buildManagedGatewayFrameworkAdapterMaterial,
	buildManagedGatewayRuntimeAttachmentMetadata,
	buildManagedGatewayRuntimeServiceConfig,
	type GatewayRuntimeArtifactLimits,
} from './managed-gateway-runtime-input-builders.js';
import {
	preflightMcpPortalEffectiveConfig,
	writeMcpPortalEffectiveConfig,
} from './mcp-portal-effective-config.js';
import {
	buildWorkerRuntimeRecord,
	deleteWorkerRuntimeRecord,
	writeWorkerRuntimeRecord,
	type WorkerRuntimeRecord,
} from './worker-runtime-record.js';

const defaultGatewayReadinessRetryDelayMs = 500;

function isCurrentExpectedAttachmentLoss(props: {
	readonly expectedCohort: GatewayExpectedAdmissionCohort;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly snapshot: GatewayRuntimeReadinessSnapshot;
}): boolean {
	if (props.snapshot.uds.attachment.status !== 'attachment-lost') {
		return false;
	}
	const expectedAttachment = buildManagedGatewayRuntimeAttachmentMetadata(props.expectedCohort);
	const normalizedAttachment = {
		...props.snapshot.uds.attachment.expected,
		configuredAgentIds: [...props.snapshot.uds.attachment.expected.configuredAgentIds].toSorted(),
	};
	const normalizedExpectedAttachment = {
		...expectedAttachment,
		configuredAgentIds: [...expectedAttachment.configuredAgentIds].toSorted(),
	};
	return (
		isDeepStrictEqual(normalizedAttachment, normalizedExpectedAttachment) &&
		isDeepStrictEqual(props.snapshot.controlEndpoint.identity, {
			bootId: props.gatewayIdentity.bootId,
			controllerEpoch: props.expectedCohort.controlIdentity.controllerEpoch,
			generationId: props.expectedCohort.controlIdentity.generationId,
			peerId: props.expectedCohort.controlIdentity.peerId,
			processEpoch: props.expectedCohort.controlIdentity.processEpoch,
			zoneId: props.gatewayIdentity.zoneId,
		}) &&
		isDeepStrictEqual(props.snapshot.serviceIdentity, {
			processEpoch: props.expectedCohort.toolPortalIdentity.processEpoch,
			role: props.expectedCohort.toolPortalIdentity.role,
			serviceId: props.expectedCohort.toolPortalIdentity.serviceId,
		}) &&
		props.snapshot.semanticRevision === props.expectedCohort.semanticRevision &&
		props.snapshot.providerRevision === props.expectedCohort.providerRevision &&
		props.snapshot.requiredBackends.revision === props.expectedCohort.requiredBackendRevision &&
		isDeepStrictEqual(props.snapshot.uds.publication, {
			identity: 'managed-plugin-private-uds',
			protocolVersion: 1,
			schemaVersion: 1,
			socketPath: props.expectedCohort.udsIdentity.socketPath,
			status: 'published',
		})
	);
}
const defaultGatewayReadinessTimeoutMs = 60_000;
const defaultGatewayReadinessMaxAttempts = Math.ceil(
	defaultGatewayReadinessTimeoutMs / defaultGatewayReadinessRetryDelayMs,
);

function createGatewayObservabilityCollectorRequestMediation(
	zone: GatewayZoneConfig,
): ((request: Request) => Promise<Response | undefined>) | undefined {
	const observability = zone.observability;
	if (observability?.mode !== 'collector') {
		return undefined;
	}
	return createGatewayObservabilityOtlpRequestMediation({ collector: observability.collector });
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
	const observabilityRewrite = createGatewayObservabilityCollectorRequestMediation(options.zone);
	return async (request: Request): Promise<Request | Response | void> => {
		const websocketDecision = await websocketGuard(request);
		if (websocketDecision !== undefined) {
			return websocketDecision;
		}
		return observabilityRewrite?.(request);
	};
}

function assertManagedGatewayTcpHostsOverrideDoesNotBypassObservabilityMediation(options: {
	readonly tcpHostsOverride: Readonly<Record<string, string>> | undefined;
	readonly zone: GatewayZone;
}): void {
	if (!isManagedGatewayZone(options.zone) || options.tcpHostsOverride === undefined) {
		return;
	}
	for (const tcpHostKey of Object.keys(options.tcpHostsOverride)) {
		if (
			tcpHostKey === observabilityCollectorHost ||
			tcpHostKey.startsWith(`${observabilityCollectorHost}:`)
		) {
			throw new Error(
				`Managed Gateway tcpHostsOverride cannot map observability collector host '${observabilityCollectorHost}'; use mediated OTLP HTTP observability instead.`,
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
	if (!isManagedGatewayZone(options.zone)) {
		return;
	}
	if (options.controlSessionMaterial === undefined) {
		throw new Error(
			`Managed Gateway zone '${options.zone.id}' requires one shared Gateway and control identity.`,
		);
	}
	if (
		gatewaySeed.bootId !== options.controlSessionMaterial.bootId ||
		gatewaySeed.controllerEpoch !== options.controlSessionMaterial.controllerEpoch ||
		gatewaySeed.generationId !== options.controlSessionMaterial.generationId ||
		gatewaySeed.zoneId !== options.controlSessionMaterial.zoneId
	) {
		throw new Error(
			`Managed Gateway zone '${options.zone.id}' ownership identity does not match its control material.`,
		);
	}
}

type ManagedGatewayZone = GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'hermes' | 'openclaw' }>;
};

function isManagedGatewayZone(zone: GatewayZone): zone is ManagedGatewayZone {
	return zone.gateway.type === 'openclaw' || zone.gateway.type === 'hermes';
}

function formatGatewayCleanupOutcome(
	destroyResult: Extract<
		GatewayZoneDestroyResult,
		{ readonly kind: 'destroyed-cleanup-incomplete' }
	>,
): string {
	return [...new Set(destroyResult.cleanupFailures.map(({ stage }) => stage))].toSorted().join(':');
}

function frameworkIdentitiesMatch(
	leftIdentity: GatewayRuntimeFrameworkIdentity,
	rightIdentity: GatewayRuntimeFrameworkIdentity,
): boolean {
	switch (leftIdentity.kind) {
		case 'openclaw':
			return rightIdentity.kind === 'openclaw' && leftIdentity.agentId === rightIdentity.agentId;
		case 'hermes':
			return (
				rightIdentity.kind === 'hermes' && leftIdentity.profileName === rightIdentity.profileName
			);
	}
}

function requireConfiguredFrameworkIdentity(options: {
	readonly agentId: string;
	readonly zone: ManagedGatewayZone;
}): GatewayRuntimeFrameworkIdentity {
	if (options.zone.gateway.type === 'openclaw') {
		return { agentId: options.agentId, kind: 'openclaw' };
	}
	const profileName = options.zone.gateway.profilesByAgent[options.agentId];
	if (profileName === undefined) {
		throw new Error(
			`Gateway control caller context rejected Hermes agent '${options.agentId}' without an authored profile assignment.`,
		);
	}
	return { kind: 'hermes', profileName };
}

export function validateGatewayControlCallerContextRegistration(options: {
	readonly agentAuthorityKeys: Readonly<Record<string, string>>;
	readonly agentProjections: Readonly<Record<string, ManagedAgentProjection>>;
	readonly callerContextProofKey: string;
	readonly payload: GatewayControlCallerContextRegisterPayload;
	readonly zone: GatewayZone;
}): void {
	const evidence = options.payload.adapterEvidence;
	const principal = evidence.principal;
	if (!isManagedGatewayZone(options.zone)) {
		throw new Error('Gateway control caller context registration requires a managed Gateway zone.');
	}
	const configuredAgentIds = new Set((options.zone.agents ?? []).map((agent) => agent.id));
	if (configuredAgentIds.size === 0 || !configuredAgentIds.has(principal.agentId)) {
		throw new Error(
			`Gateway control caller context rejected undeclared managed agent '${principal.agentId}'.`,
		);
	}
	const expectedFrameworkIdentity = requireConfiguredFrameworkIdentity({
		agentId: principal.agentId,
		zone: options.zone,
	});
	if (!frameworkIdentitiesMatch(principal.frameworkIdentity, expectedFrameworkIdentity)) {
		throw new Error(
			`Gateway control caller context rejected mismatched ${options.zone.gateway.type} framework identity for agent '${principal.agentId}'.`,
		);
	}
	const expectedProjection = options.agentProjections[principal.agentId];
	if (
		expectedProjection === undefined ||
		expectedProjection.agentId !== principal.agentId ||
		!frameworkIdentitiesMatch(expectedProjection.frameworkIdentity, principal.frameworkIdentity) ||
		expectedProjection.profileAssignmentRevision !== principal.profileAssignmentRevision ||
		expectedProjection.toolPortalProfileId !== principal.toolPortalProfileId
	) {
		throw new Error(
			`Gateway control caller context rejected principal outside the immutable projection for managed agent '${principal.agentId}'.`,
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
	const agentAuthorityKey = options.agentAuthorityKeys[principal.agentId];
	if (agentAuthorityKey === undefined) {
		throw new Error(
			`Gateway control caller context rejected missing agent authority for managed agent '${principal.agentId}'.`,
		);
	}
	if (evidence.agentAuthority === undefined) {
		throw new Error(
			`Gateway control caller context rejected missing agent authority proof for managed agent '${principal.agentId}'.`,
		);
	}
	if (
		evidence.agentAuthority.keyId !== principal.agentId ||
		!verifyGatewayControlCallerContextProof({
			proof: evidence.agentAuthority,
			proofKey: agentAuthorityKey,
			proofPayload: buildGatewayControlCallerContextAgentAuthorityPayload(evidence),
		})
	) {
		throw new Error('Gateway control caller context rejected invalid agent authority proof.');
	}
	if (
		evidence.purpose === 'tool_portal_controller_execution' &&
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
	readonly gatewayRuntimeArtifactLimits?: GatewayRuntimeArtifactLimits;
	readonly managedVmFactory: ManagedVmFactory;
	readonly managedVmOwnedDirectories?: ManagedVmOwnedDirectoryCapability;
	readonly createGatewayControlSessionMaterial?: GatewayControlSessionMaterialFactory;
	readonly gatewayReadinessMaxAttempts?: number;
	readonly gatewayReadinessRetryDelayMs?: number;
	readonly loadGatewayLifecycle?: (type: GatewayZoneConfig['gateway']['type']) => GatewayLifecycle;
	readonly managedVmExactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly managedVmTerminationSleep?: (delayMs: number) => Promise<void>;
	/** Test-only crash-cut seam. Production leaves this unset. The callback runs
	 * after the real host VM process starts and before its durable identity is
	 * captured or published. */
	readonly onManagedVmStartedBeforeIdentityPublication?: (target: {
		readonly hostPid: number;
		readonly vmId: string;
	}) => Promise<void>;
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
		target:
			| import('../controller/durable-state/controller-state-record-paths.js').ControllerManagedGatewayRuntimeRecordTarget
			| import('../controller/durable-state/controller-state-record-paths.js').ControllerWorkerTaskRuntimeRecordTarget,
		record: ManagedGatewayRuntimeRecord | WorkerRuntimeRecord,
	) => Promise<void>;
}

interface ControllerStartGatewayZoneOptions extends StartGatewayZoneOptions {}

export interface GatewayZoneStartPreflightResult {
	readonly image?: ManagedVmImageBuildResult | undefined;
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

function createAggregateErrorWithCause(options: {
	readonly cause: unknown;
	readonly errors: readonly unknown[];
	readonly message: string;
}): AggregateError {
	return new AggregateError(options.errors, options.message, { cause: options.cause });
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
		options.writeLog?.('info', {
			operation: 'check-host-observability-stack',
			zoneId: options.zoneId,
		});
	};
	if (observabilityStartupCheck.controllerStartPolicy === 'require-ready') {
		await options.runTaskStep('Checking host observability stack', checkStack);
		return;
	}
	void checkStack().catch(() => {
		options.writeLog?.('warning', {
			operation: 'check-host-observability-stack',
			zoneId: options.zoneId,
		});
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
const MAX_GATEWAY_PROCESS_IDENTITY_CHARACTERS = 8 * 1024;
const MAX_GATEWAY_LISTENING_SOCKET_CHARACTERS = 8 * 1024;
const MANAGED_GATEWAY_STARTUP_DIAGNOSTIC_TIMEOUT_MS = 2_000;
const GATEWAY_LOG_TAIL_TRUNCATION_MARKER = '[gateway log tail truncated]\n';
const GATEWAY_PROCESS_IDENTITY_TRUNCATION_MARKER =
	'[gateway process identity diagnostics truncated]\n';
const GATEWAY_LISTENING_SOCKET_TRUNCATION_MARKER =
	'[gateway listening socket diagnostics truncated]\n';
const onePasswordServiceAccountTokenPattern = /\bops_[A-Za-z0-9._=-]{16,}\b/gu;

const managedGatewayProcessIdentityDiagnosticCommand = [
	'sh',
	'-c',
	[
		'for process_directory in /proc/[0-9]*; do',
		'  [ -r "$process_directory/cmdline" ] || continue',
		'  command_line="$(tr \'\\000\' \' \' < "$process_directory/cmdline" | head -c 2048)"',
		'  case "$command_line" in',
		'    *agent-vm-gateway-runtime*) process_role=tool-portal ;;',
		'    *openclaw*) process_role=openclaw ;;',
		'    *) continue ;;',
		'  esac',
		'  process_name="$(cat "$process_directory/comm" 2>/dev/null || true)"',
		'  process_parent_id=',
		'  process_user_id=',
		"  while IFS=':' read -r status_key status_value; do",
		'    case "$status_key" in',
		'      PPid) set -- $status_value; process_parent_id=${1:-unknown} ;;',
		'      Uid) set -- $status_value; process_user_id=${1:-unknown} ;;',
		'    esac',
		'  done < "$process_directory/status"',
		'  printf \'role=%s pid=%s ppid=%s uid=%s name=%s\\n\' "$process_role" "${process_directory##*/}" "$process_parent_id" "$process_user_id" "$process_name"',
		'done',
	].join('\n'),
] as const;

const managedGatewayListeningSocketDiagnosticCommand = [
	'sh',
	'-c',
	[
		'for socket_table in /proc/net/tcp /proc/net/tcp6; do',
		'  [ -r "$socket_table" ] || continue',
		'  while read -r _ local_address _ socket_state _; do',
		'    [ "$socket_state" = 0A ] || continue',
		'    printf \'table=%s local=%s state=LISTEN\\n\' "$socket_table" "$local_address"',
		'  done < "$socket_table"',
		'done',
	].join('\n'),
] as const;

function boundGatewayDiagnosticSection(options: {
	readonly maximumCharacters: number;
	readonly output: string;
	readonly truncationMarker: string;
}): string {
	if (options.output.length <= options.maximumCharacters) {
		return options.output;
	}
	return `${options.truncationMarker}${options.output.slice(
		-(options.maximumCharacters - options.truncationMarker.length),
	)}`;
}

function boundGatewayLogTail(logTail: string): string {
	return boundGatewayDiagnosticSection({
		maximumCharacters: MAX_GATEWAY_LOG_TAIL_CHARACTERS,
		output: logTail,
		truncationMarker: GATEWAY_LOG_TAIL_TRUNCATION_MARKER,
	});
}

function formatGatewayDiagnosticCommandOutput(result: GatewayCommandResult): string {
	return [result.stdout.trim(), result.stderr.trim()]
		.filter((outputChunk) => outputChunk.length > 0)
		.join('\n');
}

function scrubGatewayDiagnosticOutput(options: {
	readonly output: string;
	readonly sensitiveValues: readonly string[];
}): string {
	return redactCredentialText(redactOnePasswordReferences(options.output), {
		exactValues: options.sensitiveValues,
	}).replaceAll(onePasswordServiceAccountTokenPattern, '[REDACTED]');
}

async function readManagedGatewayStartupDiagnosticSection(options: {
	readonly command: readonly string[];
	readonly managedVm: ManagedVm;
	readonly maximumCharacters: number;
	readonly sensitiveValues: readonly string[];
	readonly signal: AbortSignal;
	readonly truncationMarker: string;
}): Promise<string | undefined> {
	try {
		const result = await options.managedVm.exec(options.command, { signal: options.signal });
		const output = formatGatewayDiagnosticCommandOutput(result);
		if (output.length === 0) {
			return undefined;
		}
		return boundGatewayDiagnosticSection({
			maximumCharacters: options.maximumCharacters,
			output: scrubGatewayDiagnosticOutput({
				output,
				sensitiveValues: options.sensitiveValues,
			}),
			truncationMarker: options.truncationMarker,
		});
	} catch {
		return undefined;
	}
}

async function readManagedGatewayStartupDiagnostics(options: {
	readonly evidenceFiles?: readonly {
		readonly label: string;
		readonly path: string;
	}[];
	readonly logFiles: readonly {
		readonly label: string;
		readonly path: string;
	}[];
	readonly managedVm: ManagedVm;
	readonly sensitiveValues: readonly string[];
}): Promise<string | undefined> {
	const diagnosticSignal = AbortSignal.timeout(MANAGED_GATEWAY_STARTUP_DIAGNOSTIC_TIMEOUT_MS);
	const diagnosticFileSections = await Promise.all([
		...options.logFiles.map(async (logFile) => ({
			label: logFile.label,
			output: await readManagedGatewayStartupDiagnosticSection({
				command: ['tail', '-c', String(MAX_GATEWAY_LOG_TAIL_CHARACTERS), '--', logFile.path],
				managedVm: options.managedVm,
				maximumCharacters: MAX_GATEWAY_LOG_TAIL_CHARACTERS,
				sensitiveValues: options.sensitiveValues,
				signal: diagnosticSignal,
				truncationMarker: GATEWAY_LOG_TAIL_TRUNCATION_MARKER,
			}),
		})),
		...(options.evidenceFiles ?? []).map(async (evidenceFile) => ({
			label: evidenceFile.label,
			output: await readManagedGatewayStartupDiagnosticSection({
				command: [
					'sh',
					'-c',
					'if [ -f "$1" ]; then cat -- "$1"; fi',
					'managed-gateway-diagnostic',
					evidenceFile.path,
				],
				managedVm: options.managedVm,
				maximumCharacters: MAX_GATEWAY_LOG_TAIL_CHARACTERS,
				sensitiveValues: options.sensitiveValues,
				signal: diagnosticSignal,
				truncationMarker: GATEWAY_LOG_TAIL_TRUNCATION_MARKER,
			}),
		})),
	]);
	const [frameworkProcessIdentities, listeningTcpSockets] = await Promise.all([
		readManagedGatewayStartupDiagnosticSection({
			command: managedGatewayProcessIdentityDiagnosticCommand,
			managedVm: options.managedVm,
			maximumCharacters: MAX_GATEWAY_PROCESS_IDENTITY_CHARACTERS,
			sensitiveValues: options.sensitiveValues,
			signal: diagnosticSignal,
			truncationMarker: GATEWAY_PROCESS_IDENTITY_TRUNCATION_MARKER,
		}),
		readManagedGatewayStartupDiagnosticSection({
			command: managedGatewayListeningSocketDiagnosticCommand,
			managedVm: options.managedVm,
			maximumCharacters: MAX_GATEWAY_LISTENING_SOCKET_CHARACTERS,
			sensitiveValues: options.sensitiveValues,
			signal: diagnosticSignal,
			truncationMarker: GATEWAY_LISTENING_SOCKET_TRUNCATION_MARKER,
		}),
	]);
	const diagnosticSections = [
		...diagnosticFileSections.map(({ label, output }) =>
			output === undefined ? undefined : `${label}:\n${output}`,
		),
		frameworkProcessIdentities === undefined
			? undefined
			: `Framework process identities:\n${frameworkProcessIdentities}`,
		listeningTcpSockets === undefined
			? undefined
			: `Listening TCP sockets:\n${listeningTcpSockets}`,
	].filter((section): section is string => section !== undefined);
	return diagnosticSections.length === 0 ? undefined : diagnosticSections.join('\n');
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

interface ConfiguredRuntimeMcpPortalLifecycleMaterial {
	readonly egressHosts: GatewayZoneConfig['egressHosts'];
	readonly runtimeEnvironment: NonNullable<GatewayZoneConfig['runtimeEnvironment']>;
	readonly runtimeMediatedSecrets: NonNullable<GatewayZoneConfig['runtimeMediatedSecrets']>;
}

interface ManagedGatewayMediatedSecretBootProjection {
	readonly descriptors: readonly ManagedVmMediatedSecretDescriptor[];
	readonly frameworkEnvironment: Readonly<Record<string, string>>;
	readonly toolPortalEnvironment: Readonly<Record<string, string>>;
}

function createManagedGatewayMediatedSecretBootProjection(props: {
	readonly mediatedSecrets: Readonly<
		Record<string, { readonly hosts: readonly string[]; readonly value: string }>
	>;
	readonly toolPortalMediatedSecretNames: ReadonlySet<string>;
}): ManagedGatewayMediatedSecretBootProjection {
	const descriptors: ManagedVmMediatedSecretDescriptor[] = [];
	const frameworkEnvironment: Record<string, string> = {};
	const toolPortalEnvironment: Record<string, string> = {};
	const generatedPlaceholders = new Set<string>();

	for (const [environmentVariable, mediatedSecret] of Object.entries(props.mediatedSecrets)) {
		let guestPlaceholder: string;
		do {
			guestPlaceholder = `GONDOLIN_SECRET_${randomBytes(24).toString('hex')}`;
		} while (
			generatedPlaceholders.has(guestPlaceholder) ||
			guestPlaceholder === mediatedSecret.value
		);
		generatedPlaceholders.add(guestPlaceholder);
		descriptors.push({
			allowedHosts: mediatedSecret.hosts,
			environmentVariable,
			guestPlaceholder,
			value: mediatedSecret.value,
		});
		if (props.toolPortalMediatedSecretNames.has(environmentVariable)) {
			toolPortalEnvironment[environmentVariable] = guestPlaceholder;
		} else {
			frameworkEnvironment[environmentVariable] = guestPlaceholder;
		}
	}

	return Object.freeze({
		descriptors: Object.freeze(descriptors),
		frameworkEnvironment: Object.freeze(frameworkEnvironment),
		toolPortalEnvironment: Object.freeze(toolPortalEnvironment),
	});
}

type RuntimeMcpPortalMaterialization =
	| { readonly kind: 'disabled' }
	| {
			readonly kind: 'configured';
			readonly lifecycle: ConfiguredRuntimeMcpPortalLifecycleMaterial;
			readonly mcpConfig: unknown;
			readonly mode: 'preflight';
	  }
	| {
			readonly kind: 'configured';
			readonly lifecycle: ConfiguredRuntimeMcpPortalLifecycleMaterial;
			readonly mcpConfig: unknown;
			readonly mode: 'runtime';
			readonly portalAdmission: GatewayRuntimePortalAdmissionMaterial;
			readonly credentialedRuntimeRegistrySnapshot: import('../controller/credentialed-runtime/credentialed-runtime-registry.js').ControllerCredentialedRuntimeRegistrySnapshot;
	  };

function applyRuntimeMcpPortalMaterialization(props: {
	readonly lifecycleZone: GatewayZoneConfig;
	readonly materialization: RuntimeMcpPortalMaterialization;
}): GatewayZoneConfig {
	if (props.materialization.kind === 'disabled') {
		return props.lifecycleZone;
	}
	return {
		...props.lifecycleZone,
		...props.materialization.lifecycle,
	};
}

async function buildRuntimeMcpPortalMaterialization(props: {
	readonly cacheDir: string;
	readonly controlSessionMaterial: GatewayControlSessionMaterial | undefined;
	readonly managedVmImages: GatewayManagerDependencies['managedVmImages'];
	readonly mode: 'preflight' | 'write';
	readonly secretResolver: StartGatewayZoneOptions['secretResolver'];
	readonly zone: GatewayZone;
}): Promise<RuntimeMcpPortalMaterialization> {
	const zone = props.zone;
	if (!isManagedGatewayZone(zone) || zone.toolPortal === undefined) {
		return { kind: 'disabled' };
	}
	if (props.mode === 'write' && props.controlSessionMaterial === undefined) {
		throw new Error(
			`Managed Gateway zone '${zone.id}' requires controller-issued identity material before Tool Portal admission materialization.`,
		);
	}
	const allowedRawEnvSecretNames =
		zone.gateway.type === 'openclaw'
			? ['OPENCLAW_GATEWAY_TOKEN', ...(zone.gateway.rawEnvSecrets ?? [])]
			: [];
	const effectiveHostConfigDir = path.join(
		props.cacheDir,
		'gateways',
		zone.id,
		'tool-portal-effective',
	);
	const buildEffectiveConfig =
		props.mode === 'preflight' ? preflightMcpPortalEffectiveConfig : writeMcpPortalEffectiveConfig;
	const materialization = await buildEffectiveConfig({
		approvalAccessConfigured: zone.approvalAccess !== undefined,
		authoredConfigDir: zone.toolPortal.configDir,
		effectiveHostConfigDir,
		managedVmImages: props.managedVmImages,
		allowedRawEnvSecretNames,
		declaredAgentIds: (zone.agents ?? []).map((agent) => agent.id),
		secretResolver: props.secretResolver,
		workspaceGitPushAgentEligibility: {
			eligibleAgentIds: (zone.agents ?? [])
				.filter((agent) => agent.workspaceGit?.mode === 'remote')
				.map((agent) => agent.id),
		},
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
	const configuredLifecycle = {
		egressHosts: [...zone.egressHosts, ...generatedGatewayEgressHosts],
		runtimeEnvironment: materialization.runtimeEnvironment,
		runtimeMediatedSecrets: materialization.runtimeMediatedSecrets,
	} satisfies ConfiguredRuntimeMcpPortalLifecycleMaterial;
	if (props.mode === 'preflight') {
		return {
			kind: 'configured',
			lifecycle: configuredLifecycle,
			mcpConfig: materialization.effectiveMcpConfig,
			mode: 'preflight',
		};
	}
	const controlSessionMaterial = props.controlSessionMaterial;
	if (controlSessionMaterial === undefined) {
		throw new Error(
			`Managed Gateway zone '${zone.id}' requires controller-issued identity material before Tool Portal admission materialization.`,
		);
	}
	const portalAdmission = materializeGatewayRuntimePortalAdmission({
		agentProjections: buildManagedFrameworkAgentProjectionInputs(
			zone.gateway.type === 'openclaw'
				? {
						configuredAgents: zone.agents ?? [],
						frameworkKind: 'openclaw',
						toolPortalAgents: materialization.effectiveToolPortalConfig.agents,
					}
				: {
						configuredAgents: zone.agents ?? [],
						frameworkKind: 'hermes',
						profilesByAgent: zone.gateway.profilesByAgent,
						toolPortalAgents: materialization.effectiveToolPortalConfig.agents,
					},
		),
		effectivePlan: materialization,
		surfaceEligibilityByProfile: zone.toolPortal.surfaceEligibilityByProfile,
	});
	await writeGatewayRuntimePortalAdmissionFile({
		directoryPath: effectiveHostConfigDir,
		material: portalAdmission,
	});
	return {
		credentialedRuntimeRegistrySnapshot: materialization.credentialedRuntimeRegistrySnapshot,
		kind: 'configured',
		lifecycle: configuredLifecycle,
		mcpConfig: materialization.effectiveMcpConfig,
		mode: 'runtime',
		portalAdmission,
	};
}

async function buildGatewayImageForZone(
	options: {
		readonly systemConfig: StartGatewayZoneOptions['systemConfig'];
		readonly zone: GatewayZone;
	},
	dependencies: GatewayImageBuilderDependencies,
): Promise<ManagedVmImageBuildResult> {
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
		dependencies,
	);
}

export async function preflightGatewayZoneStart(
	options: GatewayZonePreflightOptions,
	dependencies: Pick<
		GatewayManagerDependencies,
		'checkObservabilityStackReadiness' | 'loadGatewayLifecycle' | 'managedVmImages'
	>,
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
	dependencies: Pick<GatewayManagerDependencies, 'loadGatewayLifecycle' | 'managedVmImages'>,
): Promise<GatewayZoneStartPrerequisitePreflightResult> {
	const zone = options.zoneOverride ?? findGatewayZone(options.systemConfig, options.zoneId);
	const mappedLifecycleZone = mapSystemGatewayZoneToLifecycleZone(zone, {
		hostObservability: options.systemConfig.host.observability,
	});
	const controlSessionMaterial =
		isManagedGatewayZone(zone) && options.controlSession !== undefined
			? createGatewayControlSessionMaterial({
					agentIds: (zone.agents ?? []).map((agent) => agent.id),
					controllerEpoch: options.controlSession.controllerEpoch,
					zoneId: zone.id,
				})
			: undefined;
	const controlSessionRuntimePrivateEnvironment =
		controlSessionMaterial === undefined
			? undefined
			: buildControlSessionRuntimePrivateEnvironment({ material: controlSessionMaterial });
	const lifecycle: GatewayLifecycle = (dependencies.loadGatewayLifecycle ?? loadGatewayLifecycle)(
		zone.gateway.type,
	);
	const cachingSecretResolver = createPreflightCachingSecretResolver(options.secretResolver);
	const [toolPortalMaterialization] = await Promise.all([
		buildRuntimeMcpPortalMaterialization({
			cacheDir: options.systemConfig.cacheDir,
			controlSessionMaterial,
			managedVmImages: dependencies.managedVmImages,
			mode: 'preflight',
			secretResolver: cachingSecretResolver.resolver,
			zone,
		}),
		resolveZoneSecrets({
			audience: 'gateway',
			secretResolver: cachingSecretResolver.resolver,
			systemConfig: options.systemConfig,
			zoneId: zone.id,
		}),
	]);
	const lifecycleZoneWithToolPortal = applyRuntimeMcpPortalMaterialization({
		lifecycleZone: mappedLifecycleZone,
		materialization: toolPortalMaterialization,
	});
	const runtimePluginConfigs = options.runtimePluginConfigs;
	const lifecycleZone = {
		...lifecycleZoneWithToolPortal,
		...(options.gitReadAllowlistRepos === undefined
			? {}
			: { gitReadAllowlistRepos: options.gitReadAllowlistRepos }),
		...(options.runtimeEnvironment === undefined
			? {}
			: {
					runtimeEnvironment: {
						...lifecycleZoneWithToolPortal.runtimeEnvironment,
						...options.runtimeEnvironment,
					},
				}),
		...(runtimePluginConfigs === undefined ? {} : { runtimePluginConfigs }),
		...(controlSessionRuntimePrivateEnvironment === undefined ||
		lifecycle.executionModel === 'managed-gateway'
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
	dependencies: GatewayManagerDependencies,
): Promise<GatewayZoneStartResult> {
	return await startGatewayZoneImplementation(options, dependencies);
}

export async function startGatewayZoneForController(
	options: ControllerStartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies,
): Promise<GatewayZoneStartResult> {
	return await startGatewayZoneImplementation(options, dependencies);
}

async function startGatewayZoneImplementation(
	options: StartGatewayZoneOptions,
	dependencies: GatewayManagerDependencies,
): Promise<GatewayZoneStartResult> {
	const runTaskStep =
		options.runTask ?? (async (_title: string, fn: () => Promise<void>) => await fn());
	const zone = options.zoneOverride ?? findGatewayZone(options.systemConfig, options.zoneId);
	const mappedLifecycleZone = mapSystemGatewayZoneToLifecycleZone(zone, {
		hostObservability: options.systemConfig.host.observability,
	});
	const controlSessionMaterial =
		isManagedGatewayZone(zone) && options.controlSession !== undefined
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
	const lifecycle: GatewayLifecycle = (dependencies.loadGatewayLifecycle ?? loadGatewayLifecycle)(
		zone.gateway.type,
	);

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

	// Phase D: prove read-only and self-contained startup prerequisites in parallel.
	//
	// The three branches operate on disjoint resources. Secret work is shared
	// through the preflight cache so overlapping refs await one in-flight
	// underlying resolution:
	//   - assertions reads $zone.gateway.config (pure validation)
	//   - resolveZoneSecrets reads zone.secrets
	//   - image is the prebuilt Phase B image whenever protected preflight ran
	//
	// Mutating Tool Portal materialization intentionally starts only after this
	// group succeeds. If image preparation or validation fails, no writer may
	// continue beneath a cache root that the caller is now free to tear down or
	// reuse for a retry.
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
	// Cost of fail-fast: if multiple prerequisites reject simultaneously, the
	// other reasons are lost (only the first reaches the caller). Background
	// completion of the other prerequisite branches is harmless because none
	// writes Tool Portal runtime state.
	const [, resolvedSecrets, image] = await Promise.all([
		assertionsPromise,
		resolvedSecretsPromise,
		imagePromise,
	]);
	const toolPortalMaterialization = await runTaskWithResult(
		runTaskStep,
		'Materializing Tool Portal runtime',
		async () =>
			await buildRuntimeMcpPortalMaterialization({
				cacheDir: options.systemConfig.cacheDir,
				controlSessionMaterial,
				managedVmImages: dependencies.managedVmImages,
				mode: 'write',
				secretResolver: startupSecretResolver,
				zone,
			}),
	);
	const mappedLifecycleZoneWithToolPortal = applyRuntimeMcpPortalMaterialization({
		lifecycleZone: mappedLifecycleZone,
		materialization: toolPortalMaterialization,
	});
	const {
		runtimeEnvironment: mappedRuntimeEnvironment,
		runtimePrivateEnvironment: mappedRuntimePrivateEnvironment,
		...mappedLifecycleZoneBase
	} = mappedLifecycleZoneWithToolPortal;
	const baseRuntimePluginConfigs = options.runtimePluginConfigs;
	const buildLifecycleZoneForControlMaterial = (
		material: GatewayControlSessionMaterial | undefined,
	): GatewayZoneConfig => {
		const runtimePluginConfigs = mergeRuntimePluginConfigs(baseRuntimePluginConfigs, undefined);
		const runtimePrivateEnvironment =
			material === undefined || lifecycle.executionModel === 'managed-gateway'
				? mappedRuntimePrivateEnvironment
				: {
						...mappedRuntimePrivateEnvironment,
						...buildControlSessionRuntimePrivateEnvironment({ material }),
					};
		return {
			...mappedLifecycleZoneBase,
			...(options.gitReadAllowlistRepos === undefined
				? {}
				: { gitReadAllowlistRepos: options.gitReadAllowlistRepos }),
			...(mappedRuntimeEnvironment === undefined && options.runtimeEnvironment === undefined
				? {}
				: {
						runtimeEnvironment: {
							...mappedRuntimeEnvironment,
							...options.runtimeEnvironment,
						},
					}),
			...(runtimePluginConfigs === undefined ? {} : { runtimePluginConfigs }),
			...(runtimePrivateEnvironment === undefined ? {} : { runtimePrivateEnvironment }),
		};
	};
	const lifecycleZone = buildLifecycleZoneForControlMaterial(controlSessionMaterial);
	await fs.mkdir(zone.gateway.stateDir, { recursive: true });
	if (isManagedGatewayZone(zone)) {
		await fs.mkdir(zone.gateway.zoneFilesDir, { recursive: true });
		if (lifecycle.executionModel === 'managed-gateway') {
			const configuredAgents = zone.agents ?? [];
			const agentIds = configuredAgents.map((agent) => agent.id);
			await materializeManagedAgentRootStorage({
				agentIds,
				controllerStateDir: options.systemConfig.controllerStateDir,
				stateDir: zone.gateway.stateDir,
				zoneFilesDir: zone.gateway.zoneFilesDir,
			});
			await fs.mkdir(zone.gateway.zoneRuntimeDir, {
				mode: 0o700,
				recursive: true,
			});
			await Promise.all(
				configuredAgents
					.filter((agent) => agent.workspaceGit !== undefined)
					.map(async (agent): Promise<void> => {
						await materializeManagedAgentGitDirectoryRoot({
							agentId: agent.id,
							zoneRuntimeDir: zone.gateway.zoneRuntimeDir,
						});
					}),
			);
		}
	}
	const gatewayCacheDir = path.join(options.systemConfig.cacheDir, 'gateways', zone.id);
	await fs.mkdir(gatewayCacheDir, { recursive: true });
	if (isManagedGatewayZone(zone)) {
		const logDir = path.join(zone.gateway.zoneRuntimeDir, 'logs');
		await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
		await fs.chmod(logDir, 0o700);
	}
	const vmSpec = lifecycle.buildVmRequirements({
		controllerPort: options.systemConfig.host.controllerPort,
		gatewayCacheDir,
		projectNamespace: options.systemConfig.host.projectNamespace,
		resolvedSecrets,
		zoneRuntimeDir: zone.gateway.zoneRuntimeDir,
		tcpPool: options.systemConfig.tcpPool,
		zone: lifecycleZone,
	});
	const managedGatewayMediatedSecretBootProjection =
		lifecycle.executionModel === 'managed-gateway' &&
		toolPortalMaterialization.kind === 'configured'
			? createManagedGatewayMediatedSecretBootProjection({
					mediatedSecrets: vmSpec.mediatedSecrets,
					toolPortalMediatedSecretNames: new Set(
						Object.keys(toolPortalMaterialization.lifecycle.runtimeMediatedSecrets),
					),
				})
			: undefined;
	const environment = {
		...vmSpec.environment,
		...options.environmentOverride,
	};
	assertManagedGatewayTcpHostsOverrideDoesNotBypassObservabilityMediation({
		tcpHostsOverride: options.tcpHostsOverride,
		zone,
	});
	const tcpHosts = {
		...vmSpec.tcpHosts,
		...options.tcpHostsOverride,
	};
	const vfsMounts = {
		...vmSpec.mounts,
		...options.vfsMountsOverride,
	};
	if (lifecycle.executionModel === 'managed-gateway') {
		if (
			toolPortalMaterialization.kind !== 'configured' ||
			toolPortalMaterialization.mode !== 'runtime'
		) {
			throw new Error(
				`Managed Gateway zone '${zone.id}' requires validated Tool Portal admission material.`,
			);
		}
		if (controlSessionMaterial === undefined) {
			throw new Error(
				`Managed Gateway zone '${zone.id}' requires controller-issued control session material.`,
			);
		}
		if (dependencies.gatewayRuntimeArtifactLimits === undefined) {
			throw new Error(
				`Managed Gateway zone '${zone.id}' requires explicit Gateway Runtime artifact limits.`,
			);
		}
	} else {
		// Direct Worker host state remains fully prepared before VM ownership is
		// reserved and before any guest process command can run.
		await runTaskStep('Preparing host state', async () => {
			await lifecycle.prepareHostState?.(lifecycleZone, startupSecretResolver);
		});
	}
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
				kind: lifecycle.executionModel === 'managed-gateway' ? 'gateway-epoch' : 'standalone',
				sessionLabel: vmSpec.sessionLabel,
				zoneId: zone.id,
			}),
	);
	assertGatewayVmOwnershipMatchesControlIdentity({
		controlSessionMaterial,
		vmOwnership,
		zone,
	});
	const createManagedVmForMounts = async (
		mounts: Parameters<ManagedVmFactory['createManagedVm']>[0]['mounts'],
		cleanupUnattachedResources: () => Promise<void>,
	): Promise<ManagedVm> => {
		let pendingCreateContainment: Promise<void> | undefined;
		const createManagedVmPromise = runTaskWithResult(
			runTaskStep,
			'Booting gateway VM',
			async () =>
				await dependencies.managedVmFactory.createManagedVm({
					allowedHosts: vmSpec.allowedHosts,
					environment,
					imageReference: image.imageReference,
					mediatedSecrets:
						managedGatewayMediatedSecretBootProjection?.descriptors ??
						Object.entries(vmSpec.mediatedSecrets).map(([environmentVariable, secret]) => ({
							allowedHosts: secret.hosts,
							environmentVariable,
							value: secret.value,
						})),
					mediation: {
						onRequest: createGatewayVmRequestHook({ vmSpec, zone: lifecycleZone }),
					},
					mounts,
					resources: {
						cpuCount: zone.gateway.cpus,
						memory: zone.gateway.memory,
					},
					rootfsMode: vmSpec.rootfsMode,
					...(vmSpec.runtimeRootfsSize ? { runtimeRootfsSize: vmSpec.runtimeRootfsSize } : {}),
					sessionLabel: vmSpec.sessionLabel,
					...(vmSpec.sshEgress ? { sshEgress: vmSpec.sshEgress } : {}),
					tcpHosts: Object.entries(tcpHosts).map(([guestHost, target]) => ({ guestHost, target })),
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
		try {
			const managedVm = await createManagedVmPromise;
			if (pendingCreateContainment !== undefined) {
				await pendingCreateContainment;
				throw new Error(`Pending Gateway VM creation was contained for zone '${zone.id}'.`);
			}
			return managedVm;
		} catch (createError) {
			try {
				await vmOwnership.abandonUnattachedGatewaySeedAfter(async () => {
					if (pendingCreateContainment !== undefined) {
						await pendingCreateContainment;
					}
					await cleanupUnattachedResources();
				});
			} catch (cleanupError: unknown) {
				throw createAggregateErrorWithCause({
					cause: cleanupError,
					errors: [createError, cleanupError],
					message: `Gateway VM creation failed for zone '${zone.id}' and unattached cleanup did not complete.`,
				});
			}
			throw createError;
		}
	};
	const managedVmTerminationSleep = dependencies.managedVmTerminationSleep ?? sleep;

	if (lifecycle.executionModel === 'direct-process') {
		if (options.runtimeRecordTarget.kind !== 'controller-worker-task-runtime-record') {
			throw new Error(`Worker zone '${zone.id}' requires a Worker task runtime record target.`);
		}
		const workerRuntimeRecordTarget = options.runtimeRecordTarget;
		const processSpec = lifecycle.buildProcessSpec(lifecycleZone, resolvedSecrets);
		const managedVm = await createManagedVmForMounts(vfsMounts, async () => {});
		let gatewayIdentity: ReturnType<typeof vmOwnership.attachGatewayVm>;
		try {
			gatewayIdentity = vmOwnership.attachGatewayVm(managedVm.id);
		} catch (error: unknown) {
			try {
				await vmOwnership.abandonUnattachedGatewaySeedAfter(async () => {
					const unattachedRunnerPid = managedVm.getHostProcessId();
					if (unattachedRunnerPid !== null) {
						throw new Error(
							`Worker VM '${managedVm.id}' attachment failed after runner pid ${String(unattachedRunnerPid)} appeared; refusing raw close without exact process identity.`,
							{ cause: error },
						);
					}
					await managedVm.close();
				});
			} catch (cleanupError: unknown) {
				throw createAggregateErrorWithCause({
					cause: cleanupError,
					errors: [error, cleanupError],
					message: `Worker VM '${managedVm.id}' attachment failed and unattached cleanup did not complete.`,
				});
			}
			throw error;
		}
		let startupProcessTarget: ManagedVmProcessTarget | undefined;
		let gatewayIngressAccess: Awaited<ReturnType<ManagedVm['enableIngress']>> | undefined;
		const captureProcessTarget = async (): Promise<ManagedVmProcessTarget> => {
			const hostPid = managedVm.getHostProcessId();
			if (hostPid === null || !Number.isInteger(hostPid) || hostPid <= 0) {
				throw new Error(
					`Worker VM '${managedVm.id}' does not expose a valid live runner pid for controller-owned cleanup.`,
				);
			}
			const processIdentity = await (dependencies.readProcessIdentity ?? readProcessIdentity)(
				hostPid,
			);
			if (processIdentity === null) {
				throw new Error(
					`Worker VM '${managedVm.id}' pid ${String(hostPid)} disappeared before process identity capture.`,
				);
			}
			return { hostPid, processIdentity, vmId: managedVm.id };
		};
		const withdrawWorkerIngress = async (): Promise<void> => {
			const withdrawalErrors: unknown[] = [];
			try {
				managedVm.configureIngressRoutes([]);
			} catch (error: unknown) {
				withdrawalErrors.push(error);
			}
			try {
				await gatewayIngressAccess?.close();
			} catch (error: unknown) {
				withdrawalErrors.push(error);
			}
			if (withdrawalErrors.length > 1) {
				throw new AggregateError(
					withdrawalErrors,
					`Worker ingress withdrawal failed for VM '${managedVm.id}'.`,
				);
			}
			if (withdrawalErrors.length === 1) throw withdrawalErrors[0];
		};
		const terminateExactWorkerVm = async (): Promise<void> => {
			if (startupProcessTarget === undefined && managedVm.getHostProcessId() !== null) {
				startupProcessTarget = await captureProcessTarget();
			}
			if (startupProcessTarget === undefined) {
				const unexpectedRunnerPid = managedVm.getHostProcessId();
				if (unexpectedRunnerPid !== null) {
					throw new Error(
						`Worker VM '${managedVm.id}' runner pid ${String(unexpectedRunnerPid)} appeared without a captured process identity; refusing raw close.`,
					);
				}
				await managedVm.close();
				return;
			}
			await terminateLiveManagedVm({
				contextLabel: `Worker VM '${managedVm.id}' for zone '${zone.id}'`,
				exactProcessTermination: dependencies.managedVmExactProcessTermination,
				sleep: managedVmTerminationSleep,
				target: startupProcessTarget,
				vm: managedVm,
			});
		};
		const destructionTransaction = createGatewayZoneDestructionTransaction({
			destroyExactGateway: async () => await vmOwnership.destroyLive(terminateExactWorkerVm),
			gatewayLabel: `Worker VM '${managedVm.id}' for zone '${zone.id}'`,
			postDestructionCleanup: [
				{
					cleanup: async () => await deleteWorkerRuntimeRecord(workerRuntimeRecordTarget),
					stage: 'runtime-record-deletion',
				},
			],
			withdrawAdmission: [{ cleanup: withdrawWorkerIngress, stage: 'ingress-withdrawal' }],
		});
		try {
			await managedVm.start();
			startupProcessTarget = await captureProcessTarget();
			const startupRuntimeRecord = await buildWorkerRuntimeRecord({
				controllerPort: options.systemConfig.host.controllerPort,
				gatewayIdentity,
				managedVm,
				processSpec,
				projectNamespace: options.systemConfig.host.projectNamespace,
				readProcessIdentity: async (hostPid) =>
					hostPid === startupProcessTarget?.hostPid ? startupProcessTarget.processIdentity : null,
				systemConfigPath: options.systemConfig.systemConfigPath,
				taskId: workerRuntimeRecordTarget.taskId,
				zoneId: zone.id,
			});
			if (dependencies.writeGatewayRuntimeRecord === undefined) {
				await writeWorkerRuntimeRecord(workerRuntimeRecordTarget, startupRuntimeRecord);
			} else {
				await dependencies.writeGatewayRuntimeRecord(
					workerRuntimeRecordTarget,
					startupRuntimeRecord,
				);
			}
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
			await runTaskStep('Waiting for service health', async () => {
				await waitForGatewayServiceHealth({
					healthCheck: processSpec.serviceHealthCheck ?? processSpec.healthCheck,
					logPath: processSpec.logPath,
					managedVm,
					...(dependencies.gatewayReadinessMaxAttempts === undefined
						? {}
						: { maxAttempts: dependencies.gatewayReadinessMaxAttempts }),
					...(dependencies.gatewayReadinessRetryDelayMs === undefined
						? {}
						: { retryDelayMs: dependencies.gatewayReadinessRetryDelayMs }),
				});
			});
			managedVm.configureIngressRoutes([
				{ port: processSpec.guestListenPort, prefix: '/', stripPrefix: true },
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
			await runTaskStep('Recording gateway runtime', async () => {
				const admittedRuntimeRecord = await buildWorkerRuntimeRecord({
					controllerPort: options.systemConfig.host.controllerPort,
					gatewayIdentity,
					ingressPort: ingress.port,
					managedVm,
					processSpec,
					projectNamespace: options.systemConfig.host.projectNamespace,
					readProcessIdentity: async (hostPid) =>
						hostPid === startupProcessTarget?.hostPid ? startupProcessTarget.processIdentity : null,
					systemConfigPath: options.systemConfig.systemConfigPath,
					taskId: workerRuntimeRecordTarget.taskId,
					zoneId: zone.id,
				});
				if (dependencies.writeGatewayRuntimeRecord === undefined) {
					await writeWorkerRuntimeRecord(workerRuntimeRecordTarget, admittedRuntimeRecord);
				} else {
					await dependencies.writeGatewayRuntimeRecord(
						workerRuntimeRecordTarget,
						admittedRuntimeRecord,
					);
				}
			});
			return {
				destroyGateway: async () => await destructionTransaction.destroyGateway(),
				executionModel: 'direct-process',
				gatewayIdentity,
				image,
				ingress: { host: ingress.host, port: ingress.port },
				processSpec,
				processTarget: startupProcessTarget,
				vm: createGatewayZoneVmOperations(managedVm),
				zone,
			};
		} catch (error: unknown) {
			let destroyResult: Awaited<ReturnType<typeof destructionTransaction.destroyGateway>>;
			try {
				destroyResult = await destructionTransaction.destroyGateway();
			} catch (cleanupError: unknown) {
				throw createAggregateErrorWithCause({
					cause: cleanupError,
					errors: [error, cleanupError],
					message: `Worker startup failed and VM '${managedVm.id}' teardown was not proven complete.`,
				});
			}
			if (destroyResult.kind === 'destroyed-cleanup-incomplete') {
				throw createAggregateErrorWithCause({
					cause: error,
					errors: [error, ...destroyResult.cleanupFailures.map((failure) => failure.error)],
					message: `Worker startup failed after VM '${managedVm.id}' destruction with incomplete ancillary cleanup.`,
				});
			}
			throw error;
		}
	}
	if (options.runtimeRecordTarget.kind !== 'controller-managed-gateway-runtime-record') {
		throw new Error(`Managed Gateway zone '${zone.id}' requires a managed runtime record target.`);
	}
	const managedGatewayRuntimeRecordTarget = options.runtimeRecordTarget;

	const managedPortalMaterialization = toolPortalMaterialization;
	const managedControlSessionMaterial = controlSessionMaterial;
	const gatewayRuntimeArtifactLimits = dependencies.gatewayRuntimeArtifactLimits;
	if (
		managedPortalMaterialization.kind !== 'configured' ||
		managedPortalMaterialization.mode !== 'runtime' ||
		managedControlSessionMaterial === undefined ||
		gatewayRuntimeArtifactLimits === undefined
	) {
		throw new Error(`Managed Gateway zone '${zone.id}' lost validated startup prerequisites.`);
	}
	const exactManagedVm = await createManagedVmForMounts(
		{
			...vfsMounts,
			[managedGatewayBootInputPaths.environmentRoot]: {
				access: 'read-write',
				kind: 'finalizable-memory',
			},
			[managedGatewayBootInputPaths.structuredRoot]: {
				access: 'read-only',
				kind: 'finalizable-memory',
			},
		},
		async () => {},
	);
	let gatewayIdentity: ReturnType<typeof vmOwnership.attachGatewayVm>;
	try {
		gatewayIdentity = vmOwnership.attachGatewayVm(exactManagedVm.id);
	} catch (error: unknown) {
		try {
			await vmOwnership.abandonUnattachedGatewaySeedAfter(async () => {
				const cleanupErrors: unknown[] = [];
				try {
					const unattachedRunnerPid = exactManagedVm.getHostProcessId();
					if (unattachedRunnerPid !== null) {
						throw new Error(
							`Managed Gateway VM '${exactManagedVm.id}' attachment failed after runner pid ${String(unattachedRunnerPid)} appeared; refusing raw close without exact process identity.`,
							{ cause: error },
						);
					}
					await exactManagedVm.close();
				} catch (cleanupError: unknown) {
					cleanupErrors.push(cleanupError);
				}
				if (cleanupErrors.length > 1) {
					throw createAggregateErrorWithCause({
						cause: cleanupErrors[0],
						errors: cleanupErrors,
						message: `Managed Gateway VM '${exactManagedVm.id}' unattached cleanup encountered multiple failures.`,
					});
				}
				if (cleanupErrors.length === 1) throw cleanupErrors[0];
			});
		} catch (cleanupError: unknown) {
			throw createAggregateErrorWithCause({
				cause: cleanupError,
				errors: [error, cleanupError],
				message: `Managed Gateway VM '${exactManagedVm.id}' attachment failed and cleanup did not complete.`,
			});
		}
		throw error;
	}
	let activeControlSession: GatewayDisposableControlSessionClient | undefined;
	let currentBindingPublicationAuthority:
		| GatewayControlToolVmBindingPublicationAuthority
		| undefined;
	let unsubscribeBindingRetirements: (() => void) | undefined;
	let appliedIngressRoutes: readonly GatewayIngressRouteIdentity[] = [];
	let frameworkReadinessEvidence: GatewayFrameworkNativeReadinessEvidence = { kind: 'pending' };
	let runtimeReadinessEvidence: GatewayRuntimeRoleReadinessEvidence = { kind: 'pending' };
	let terminalAttachmentLossReported = false;
	let vmLivenessEvidence: GatewayVmLivenessEvidence = { kind: 'pending' };
	let startupProcessTarget: ManagedVmProcessTarget | undefined;
	let gatewayIngressAccess: Awaited<ReturnType<ManagedVm['enableIngress']>> | undefined;
	const captureProcessTarget = async (): Promise<ManagedVmProcessTarget> => {
		const hostPid = exactManagedVm.getHostProcessId();
		if (hostPid === null || !Number.isInteger(hostPid) || hostPid <= 0) {
			throw new Error(
				`Managed Gateway VM '${exactManagedVm.id}' does not expose a valid live runner pid.`,
			);
		}
		const processIdentity = await (dependencies.readProcessIdentity ?? readProcessIdentity)(
			hostPid,
		);
		if (processIdentity === null) {
			throw new Error(
				`Managed Gateway VM '${exactManagedVm.id}' pid ${String(hostPid)} disappeared before identity capture.`,
			);
		}
		return { hostPid, processIdentity, vmId: exactManagedVm.id };
	};
	const disposeControlSession = async (): Promise<void> => {
		unsubscribeBindingRetirements?.();
		unsubscribeBindingRetirements = undefined;
		currentBindingPublicationAuthority = undefined;
		activeControlSession?.close();
	};
	const withdrawManagedGatewayIngress = async (): Promise<void> => {
		const withdrawalErrors: unknown[] = [];
		try {
			exactManagedVm.configureIngressRoutes([]);
			appliedIngressRoutes = [];
		} catch (error: unknown) {
			withdrawalErrors.push(error);
		}
		try {
			await gatewayIngressAccess?.close();
		} catch (error: unknown) {
			withdrawalErrors.push(error);
		}
		if (withdrawalErrors.length > 1) {
			throw new AggregateError(
				withdrawalErrors,
				`Managed Gateway ingress withdrawal failed for VM '${exactManagedVm.id}'.`,
			);
		}
		if (withdrawalErrors.length === 1) throw withdrawalErrors[0];
	};
	const terminateExactManagedGatewayVm = async (): Promise<void> => {
		if (startupProcessTarget === undefined && exactManagedVm.getHostProcessId() !== null) {
			startupProcessTarget = await captureProcessTarget();
		}
		if (startupProcessTarget === undefined) {
			const unexpectedRunnerPid = exactManagedVm.getHostProcessId();
			if (unexpectedRunnerPid !== null) {
				throw new Error(
					`Managed Gateway VM '${exactManagedVm.id}' runner pid ${String(unexpectedRunnerPid)} appeared without a captured process identity; refusing raw close.`,
				);
			}
			await exactManagedVm.close();
			return;
		}
		await terminateLiveManagedVm({
			contextLabel: `Managed Gateway VM '${exactManagedVm.id}' for zone '${zone.id}'`,
			exactProcessTermination: dependencies.managedVmExactProcessTermination,
			sleep: managedVmTerminationSleep,
			target: startupProcessTarget,
			vm: exactManagedVm,
		});
	};
	const destructionTransaction = createGatewayZoneDestructionTransaction({
		destroyExactGateway: async () => await vmOwnership.destroyLive(terminateExactManagedGatewayVm),
		gatewayLabel: `Managed Gateway VM '${exactManagedVm.id}' for zone '${zone.id}'`,
		postDestructionCleanup: [
			{
				cleanup: async () =>
					await deleteManagedGatewayRuntimeRecord(managedGatewayRuntimeRecordTarget),
				stage: 'runtime-record-deletion',
			},
			{
				cleanup: async () => await deleteGatewayControlSessionMaterial(zone.gateway.zoneRuntimeDir),
				stage: 'control-session-material-deletion',
			},
		],
		withdrawAdmission: [
			{ cleanup: disposeControlSession, stage: 'control-session-disposal' },
			{ cleanup: withdrawManagedGatewayIngress, stage: 'ingress-withdrawal' },
		],
	});
	const containManagedGatewayVm = async (): Promise<void> => {
		const result = await destructionTransaction.destroyGateway();
		if (result.kind === 'destroyed-cleanup-incomplete') {
			options.writeLog?.('warning', {
				operation: 'destroy-managed-gateway-cleanup-incomplete',
				outcome: formatGatewayCleanupOutcome(result),
				zoneId: zone.id,
			});
		}
	};

	try {
		const frameworkServiceMetadata = lifecycle.buildFrameworkServiceBootMetadata(lifecycleZone);
		const bootContract = createManagedGatewayBootContract(frameworkServiceMetadata);
		const generatedIdentity = {
			attachmentGeneration: 1,
			frameworkEpoch: randomUUID(),
			runtimeEpoch: randomUUID(),
		};
		const expectedCohort = buildManagedGatewayExpectedAdmissionCohort({
			bootContract,
			controlSessionMaterial: managedControlSessionMaterial,
			gatewayIdentity,
			generatedIdentity,
			portalAdmission: managedPortalMaterialization.portalAdmission,
		});
		const managedFrameworkAdapterMaterial = buildManagedGatewayFrameworkAdapterMaterial({
			cohort: expectedCohort,
			portalAdmission: managedPortalMaterialization.portalAdmission,
		});
		const managedFrameworkRuntimePluginConfigs = mergeRuntimePluginConfigs(
			lifecycleZone.runtimePluginConfigs,
			{
				gondolin: {
					toolPortal: managedFrameworkAdapterMaterial,
				},
			},
		);
		if (managedFrameworkRuntimePluginConfigs === undefined) {
			throw new Error(`Managed Gateway zone '${zone.id}' failed to build framework plugin inputs.`);
		}
		const {
			runtimeEnvironment: _toolPortalRuntimeEnvironment,
			runtimeMediatedSecrets: _toolPortalRuntimeMediatedSecrets,
			...frameworkLifecycleZoneBase
		} = lifecycleZone;
		const managedFrameworkLifecycleZone = {
			...frameworkLifecycleZoneBase,
			...(options.runtimeEnvironment === undefined
				? {}
				: { runtimeEnvironment: options.runtimeEnvironment }),
			runtimePluginConfigs: managedFrameworkRuntimePluginConfigs,
		} satisfies GatewayZoneConfig;
		await runTaskStep('Preparing host state', async () => {
			await lifecycle.prepareHostState?.(managedFrameworkLifecycleZone, startupSecretResolver);
		});
		const frameworkServiceInputs = await lifecycle.buildFrameworkServiceBootInputs({
			resolvedSecrets,
			zone: managedFrameworkLifecycleZone,
		});
		const toolPortalEnvironment: Record<string, string> = {
			...options.runtimeEnvironment,
			...managedPortalMaterialization.lifecycle.runtimeEnvironment,
			...managedGatewayMediatedSecretBootProjection?.toolPortalEnvironment,
		};
		for (const environmentName of ['HOME', 'NODE_EXTRA_CA_CERTS', 'PATH'] as const) {
			const environmentValue = vmSpec.environment[environmentName];
			if (environmentValue !== undefined) {
				toolPortalEnvironment[environmentName] = environmentValue;
			}
		}
		const toolPortalServiceConfig = buildManagedGatewayRuntimeServiceConfig({
			artifactLimits: gatewayRuntimeArtifactLimits,
			cohort: expectedCohort,
			controlSessionMaterial: managedControlSessionMaterial,
			observability: lifecycleZone.observability,
			portalAdmission: managedPortalMaterialization.portalAdmission,
		});
		const frameworkBootInput = (() => {
			if (frameworkServiceInputs.kind === 'hermes-managed-scope') {
				return {
					frameworkInputKind: frameworkServiceInputs.kind,
				} as const;
			}
			if (lifecycleZone.gateway.type !== 'openclaw') {
				throw new Error(
					`Managed Gateway configuration-only framework for zone '${zone.id}' must be OpenClaw.`,
				);
			}
			return {
				frameworkInputKind: frameworkServiceInputs.kind,
				openClawControlAuthSecretName: lifecycleZone.gateway.controlAuth.secret,
			} as const;
		})();
		const frameworkMediatedEnvironment =
			managedGatewayMediatedSecretBootProjection?.frameworkEnvironment ?? {};
		for (const environmentName of Object.keys(frameworkMediatedEnvironment)) {
			if (Object.hasOwn(frameworkServiceInputs.environment, environmentName)) {
				throw new Error(
					`Managed Gateway framework mediated source '${environmentName}' collides with the constructed framework environment.`,
				);
			}
		}
		const bootInputInventories = serializeManagedGatewayBootInputs({
			cohort: expectedCohort,
			frameworkConfig: frameworkServiceInputs.configuration,
			frameworkEnvironment: {
				...frameworkServiceInputs.environment,
				...frameworkMediatedEnvironment,
			},
			...frameworkBootInput,
			mcpConfig: managedPortalMaterialization.mcpConfig,
			toolPortalEnvironment,
			toolPortalServiceConfig,
		});
		if (exactManagedVm.finalizeMemoryMount === undefined) {
			throw new Error(
				`Managed Gateway VM '${exactManagedVm.id}' does not support finalizable memory mounts.`,
			);
		}
		await exactManagedVm.finalizeMemoryMount({
			files: bootInputInventories.environmentFiles,
			guestPath: managedGatewayBootInputPaths.environmentRoot,
		});
		await exactManagedVm.finalizeMemoryMount({
			files: bootInputInventories.structuredInputFiles,
			guestPath: managedGatewayBootInputPaths.structuredRoot,
		});

		const candidate: GatewayAtomicAdmissionCandidate = {
			containGatewayVm: containManagedGatewayVm,
			expectedCohort,
			replaceIngressRoutes: async (routes) => {
				exactManagedVm.configureIngressRoutes(
					routes.map((route) => ({
						port: route.guestPort,
						prefix: route.prefix,
						stripPrefix: route.stripPrefix,
					})),
				);
				appliedIngressRoutes = Object.freeze(routes.map((route) => Object.freeze({ ...route })));
			},
			startGatewayVm: async () => {
				await exactManagedVm.start();
				if (dependencies.onManagedVmStartedBeforeIdentityPublication !== undefined) {
					const unpublishedHostPid = exactManagedVm.getHostProcessId();
					if (
						unpublishedHostPid === null ||
						!Number.isInteger(unpublishedHostPid) ||
						unpublishedHostPid <= 0
					) {
						throw new Error(
							`Managed Gateway VM '${exactManagedVm.id}' did not expose a live host pid at the pre-identity crash cut.`,
						);
					}
					await dependencies.onManagedVmStartedBeforeIdentityPublication({
						hostPid: unpublishedHostPid,
						vmId: exactManagedVm.id,
					});
				}
				startupProcessTarget = await captureProcessTarget();
				vmLivenessEvidence = { identity: expectedCohort.fence, kind: 'current' };
			},
		};
		const admissionController = createGatewayAtomicAdmissionController({
			createSuccessorCandidate: async () => {
				throw new Error(
					'Managed Gateway successor creation belongs to the zone recovery state machine.',
				);
			},
		});
		const readinessObserver = createGatewayAggregateReadinessObserver({
			expectedCohort,
			readAppliedIngressRoutes: () => appliedIngressRoutes,
			readControlSessionEvidence: (): GatewayControlSessionReadinessEvidence | undefined =>
				activeControlSession === undefined
					? { kind: 'pending' }
					: {
							diagnostics: activeControlSession.getDiagnostics(),
							identity: expectedCohort.controlIdentity,
							kind: 'current',
						},
			readFatalEvidence: () => ({ kind: 'none' }),
			readFrameworkNativeReadinessEvidence: () => frameworkReadinessEvidence,
			readRuntimeReadinessEvidence: () => runtimeReadinessEvidence,
			readVmLivenessEvidence: () => vmLivenessEvidence,
		});

		await admissionController.start(candidate);
		const exactStartupProcessTarget = startupProcessTarget;
		if (exactStartupProcessTarget === undefined) {
			throw new Error(
				`Managed Gateway VM '${exactManagedVm.id}' started without publishing its exact process target.`,
			);
		}
		const ingress = await exactManagedVm.enableIngress({
			allowWebSockets: true,
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
		const gatewaySemanticLedger = createGatewaySemanticResultLedger({
			gateway: gatewayIdentity,
			nowMs: Date.now,
		});
		const sessionFenceRegistry = createControlSessionFenceRegistry();
		const dispatcher = createControlSessionDispatcher({
			semanticLedger: gatewaySemanticLedger,
			sessionFenceRegistry,
		});
		const validateCallerContextRegistration = (
			payload: GatewayControlCallerContextRegisterPayload,
		): void =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: managedControlSessionMaterial.agentAuthorityKeys,
				agentProjections:
					managedPortalMaterialization.portalAdmission.semanticSnapshot.agentProjections,
				callerContextProofKey: managedControlSessionMaterial.callerContextProofKey,
				payload,
				zone,
			});
		const callerContexts = createGatewayControlCallerContextRegistry({
			agentAuthorityKeys: managedControlSessionMaterial.agentAuthorityKeys,
			callerContextProofKey: managedControlSessionMaterial.callerContextProofKey,
			validateRegistration: validateCallerContextRegistration,
		});
		const managedGatewayStartupSensitiveValues = [
			...Object.values(resolvedSecrets),
			managedControlSessionMaterial.callerContextProofKey,
			...Object.values(managedControlSessionMaterial.agentAuthorityKeys),
		];
		const bindingPublication =
			options.gatewayControlBindingPublicationSource === undefined
				? undefined
				: createGatewayControlBindingPublicationCoordinator({
						createBinding: options.gatewayControlBindingPublicationSource.createBinding,
						publish: async (
							publication: GatewayControlToolVmBindingPublication,
							publicationOptions?: { readonly sourceCommandExpiresAtMs: number },
						) => {
							const controlSession = activeControlSession;
							if (controlSession === undefined) {
								throw new Error('Gateway control binding publication has no active session.');
							}
							const messageId = randomUUID();
							const message = GatewayControlRpcMessageSchema.parse({
								kind: 'command',
								operation: 'tool_vm_binding_publish',
								payload: publication,
							});
							const response = GatewayControlRpcCommandResultMessageSchema.parse(
								await controlSession.emitApplicationMessage(
									{
										bootId: publication.authority.processEpoch,
										commandId: randomUUID(),
										connectionId: publication.authority.connectionId,
										controllerEpoch: publication.authority.controllerEpoch,
										createdAtMs: publication.observedAtMs,
										deliveryPolicy: gatewayControlDeliveryPolicyByOperation.tool_vm_binding_publish,
										domain: 'gateway_control',
										expiresAtMs: Math.min(
											publicationOptions?.sourceCommandExpiresAtMs ?? Number.MAX_SAFE_INTEGER,
											publication.observedAtMs +
												gatewayControlCommandExecutionTimeoutMsByOperation.tool_vm_binding_publish,
										),
										idempotencyKey: [
											'tool-vm-binding-publication',
											publication.kind,
											publication.binding.leaseId,
											publication.binding.leafGeneration,
										].join(':'),
										kind: 'command',
										messageId,
										operation: 'tool_vm_binding_publish',
										peerId: managedControlSessionMaterial.peerId,
										protocolVersion: CONTROL_PROTOCOL_VERSION,
										sequence: 1,
										sessionId: publication.authority.sessionId,
										zoneId: publication.authority.zoneId,
									},
									{ kind: 'command', operation: 'tool_vm_binding_publish' },
									message,
									{
										commandResultTimeoutMs:
											gatewayControlCommandExecutionTimeoutMsByOperation.tool_vm_binding_publish,
									},
								),
							);
							if (
								response.operation !== 'tool_vm_binding_publish' ||
								response.payload.result !== 'ok'
							) {
								throw new Error('Gateway rejected the Tool VM binding publication.');
							}
						},
						readCurrentAuthority: () => currentBindingPublicationAuthority,
					});
		const managedApprovalAuthority = zone.approvalAccess?.approvers.find(
			(approver) => approver.kind === 'managed_gateway',
		);
		dispatcher.register(
			'gateway_control',
			createGatewayControlDomainHandler({
				...(options.gatewayControlApprovalLedger === undefined
					? {}
					: { approvalLedger: options.gatewayControlApprovalLedger }),
				...(managedApprovalAuthority === undefined ? {} : { managedApprovalAuthority }),
				callerContexts,
				...(bindingPublication === undefined ? {} : { bindingPublication }),
				gateway: gatewayIdentity,
				...(options.gatewayControlControllerExecutions === undefined
					? {}
					: { controllerExecutions: options.gatewayControlControllerExecutions }),
				...(options.gatewayControlLeaseRpc === undefined
					? {}
					: { leaseRpc: options.gatewayControlLeaseRpc }),
				recordGatewayRuntimeReadiness: (snapshot: GatewayRuntimeReadinessSnapshot): void => {
					runtimeReadinessEvidence = { kind: 'current', snapshot };
					if (
						!terminalAttachmentLossReported &&
						snapshot.uds.attachment.connectionId !== undefined &&
						isCurrentExpectedAttachmentLoss({ expectedCohort, gatewayIdentity, snapshot })
					) {
						terminalAttachmentLossReported = true;
						options.onGatewayRuntimeAttachmentLost?.({
							connectionId: snapshot.uds.attachment.connectionId,
							gateway: gatewayIdentity,
							observationSequence: snapshot.uds.attachment.observationSequence,
						});
					}
				},
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
										processEpoch: managedControlSessionMaterial.processEpoch,
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
					bootId: managedControlSessionMaterial.processEpoch,
					controllerEpoch: managedControlSessionMaterial.controllerEpoch,
					peerId: managedControlSessionMaterial.peerId,
					zoneId: managedControlSessionMaterial.zoneId,
				},
			}),
		);
		let lastLoggedControlAttemptOutcome: string | undefined;
		if (
			bindingPublication !== undefined &&
			options.gatewayControlBindingPublicationSource !== undefined
		) {
			unsubscribeBindingRetirements =
				options.gatewayControlBindingPublicationSource.subscribeBindingRetirement(async (event) => {
					const authority = currentBindingPublicationAuthority;
					if (authority === undefined) return;
					try {
						await bindingPublication.retireBinding({
							authority,
							leaseId: event.leaseId,
							reason: event.reason,
						});
					} catch (error) {
						options.writeLog?.('warning', {
							leaseId: event.leaseId,
							operation: 'retire-gateway-tool-vm-binding',
							zoneId: zone.id,
						});
						throw error;
					}
				});
		}
		try {
			activeControlSession = await runTaskWithResult(
				runTaskStep,
				'Connecting gateway control session',
				async () =>
					await (dependencies.connectGatewayControlSession ?? connectGatewayControlSession)({
						dispatcher,
						endpoint: buildGatewayControlEndpoint(ingress),
						material: managedControlSessionMaterial,
						onHelloResponse: (response) => {
							currentBindingPublicationAuthority =
								response.outcome === 'accepted'
									? {
											attachmentGeneration: response.attachmentGeneration,
											connectionId: response.connectionId,
											controllerEpoch: response.controllerEpoch,
											gatewayEpoch: gatewayIdentity.generationId,
											processEpoch: managedControlSessionMaterial.processEpoch,
											sessionId: response.sessionId,
											zoneId: managedControlSessionMaterial.zoneId,
										}
									: undefined;
						},
						onAttemptOutcome: (outcome) => {
							const boundedOutcome =
								outcome.kind === 'hello_response'
									? `hello_response:${outcome.outcome}`
									: 'connect_error';
							if (lastLoggedControlAttemptOutcome !== boundedOutcome) {
								lastLoggedControlAttemptOutcome = boundedOutcome;
								options.writeLog?.(
									boundedOutcome === 'hello_response:accepted' ? 'info' : 'warning',
									{
										operation: 'gateway-control-attachment-attempt',
										outcome: boundedOutcome,
										zoneId: zone.id,
									},
								);
							}
							options.onControlSessionAttemptOutcome?.({
								...outcome,
								gateway: gatewayIdentity,
								processEpoch: managedControlSessionMaterial.processEpoch,
							});
						},
						...(options.healthEventStore === undefined &&
						options.onControlSessionHealthEvidence === undefined
							? {}
							: {
									recordHealthEvent: (
										event: Extract<
											AgentVmHealthEvent,
											{
												readonly kind: 'caller-context-rejection' | 'gateway-control-session';
											}
										>,
									): void => {
										if (event.kind === 'caller-context-rejection') {
											options.healthEventStore?.record(event);
											return;
										}
										if (options.onControlSessionHealthEvidence !== undefined) {
											options.onControlSessionHealthEvidence({
												event,
												gateway: gatewayIdentity,
												recordKind: 'durable-and-live',
											});
											return;
										}
										if (event.windowState === 'closed' && event.terminalReason !== 'accepted') {
											options.healthEventStore?.recordEvidenceOnly(event);
										} else {
											options.healthEventStore?.record(event);
										}
									},
								}),
						resolveInboundStablePrincipal: ({ envelope, message }) =>
							resolveGatewayControlInboundStablePrincipal({
								callerContexts,
								envelope,
								message,
							}),
						onAttachmentGap: (transition) => {
							assertCurrentControlSessionTransition(managedControlSessionMaterial, transition);
							if (
								currentBindingPublicationAuthority?.attachmentGeneration ===
								transition.attachmentGeneration
							) {
								currentBindingPublicationAuthority = undefined;
							}
							options.onControlSessionAttachmentGap?.({
								...transition,
								gateway: gatewayIdentity,
							});
						},
						recordLiveHealthEvent: (event) => {
							if (options.onControlSessionHealthEvidence !== undefined) {
								options.onControlSessionHealthEvidence({
									event,
									gateway: gatewayIdentity,
									recordKind: 'live-only',
								});
								return;
							}
							options.healthEventStore?.recordLiveOnly(event);
						},
						...(options.onControlSessionReconnectExhausted === undefined
							? {}
							: {
									onReconnectExhausted: (transition) => {
										assertCurrentControlSessionTransition(
											managedControlSessionMaterial,
											transition,
										);
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
					}),
			);
			await activeControlSession.ready;
		} catch (error: unknown) {
			const toolPortalReadinessEvidencePath = bootContract.toolPortalService.readiness.evidencePath;
			const startupDiagnostics = await readManagedGatewayStartupDiagnostics({
				evidenceFiles: [
					{
						label: 'Tool Portal readiness evidence',
						path: toolPortalReadinessEvidencePath,
					},
					{
						label: 'Tool Portal fatal evidence',
						path: path.join(
							path.dirname(toolPortalReadinessEvidencePath),
							'tool-portal.fatal.json',
						),
					},
				],
				logFiles: [
					{
						label: `Tool Portal log tail (${bootContract.toolPortalService.logIdentity.guestPath})`,
						path: bootContract.toolPortalService.logIdentity.guestPath,
					},
				],
				managedVm: exactManagedVm,
				sensitiveValues: managedGatewayStartupSensitiveValues,
			});
			if (startupDiagnostics !== undefined && error instanceof Error) {
				error.message = `${error.message}\nManaged Gateway pre-containment diagnostics:\n${startupDiagnostics}`;
			}
			throw error;
		}

		const maximumAttempts =
			dependencies.gatewayReadinessMaxAttempts ?? defaultGatewayReadinessMaxAttempts;
		const retryDelayMs =
			dependencies.gatewayReadinessRetryDelayMs ?? defaultGatewayReadinessRetryDelayMs;
		let admitted = false;
		let lastFrameworkProbe: Awaited<ReturnType<typeof runGatewayHealthCheck>> | undefined;
		let lastAdmissionObservation:
			| Awaited<ReturnType<typeof admissionController.observe>>
			| undefined;
		for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
			// The managed health probe is observation-only: it cannot launch,
			// signal, adopt, or restart either image-owned sibling.
			// oxlint-disable-next-line no-await-in-loop -- readiness samples must be sequential.
			lastFrameworkProbe = await runGatewayHealthCheck({
				exec: async (command) => {
					const result = await exactManagedVm.exec(command);
					return {
						exitCode: result.exitCode,
						stderr: result.stderr,
						stdout: result.stdout,
					};
				},
				healthCheck: {
					path: bootContract.frameworkService.readiness.path,
					port: bootContract.frameworkService.readiness.guestPort,
					type: 'http',
				},
			});
			frameworkReadinessEvidence = lastFrameworkProbe.ok
				? {
						identity: expectedCohort.frameworkIdentity,
						kind: 'current',
						probe: lastFrameworkProbe,
					}
				: { kind: 'pending' };
			if (exactManagedVm.getHostProcessId() !== startupProcessTarget?.hostPid) {
				vmLivenessEvidence = { identity: expectedCohort.fence, kind: 'lost' };
			}
			// oxlint-disable-next-line no-await-in-loop -- each atomic observation consumes one coherent snapshot.
			lastAdmissionObservation = await admissionController.observe(readinessObserver.getSnapshot());
			if (lastAdmissionObservation.kind === 'admitted') {
				admitted = true;
				break;
			}
			if (lastAdmissionObservation.kind === 'publishing-ingress') {
				continue;
			}
			if (lastAdmissionObservation.kind !== 'waiting') {
				const containmentReason =
					lastAdmissionObservation.kind === 'startup-contained'
						? `: ${lastAdmissionObservation.reason}`
						: '';
				throw new Error(
					`Managed Gateway admission entered unexpected '${lastAdmissionObservation.kind}' state${containmentReason}.`,
				);
			}
			if (attempt < maximumAttempts) {
				// oxlint-disable-next-line no-await-in-loop -- bounded polling has no guest event source.
				await sleep(retryDelayMs);
			}
		}
		if (!admitted) {
			let startupDiagnostics: string | undefined;
			try {
				startupDiagnostics = await readManagedGatewayStartupDiagnostics({
					logFiles: [
						{
							label: `Framework log tail (${bootContract.frameworkService.logIdentity.guestPath})`,
							path: bootContract.frameworkService.logIdentity.guestPath,
						},
					],
					managedVm: exactManagedVm,
					sensitiveValues: managedGatewayStartupSensitiveValues,
				});
			} finally {
				await admissionController.expireStartupJoin('aggregate-readiness-timeout');
			}
			throw new Error(
				`Managed Gateway aggregate readiness timed out after ${String(maximumAttempts)} attempts; last framework observation: ${lastFrameworkProbe?.observation ?? 'none'}; last admission state: ${lastAdmissionObservation?.kind ?? 'none'}.${startupDiagnostics ? `\nManaged Gateway pre-containment diagnostics:\n${startupDiagnostics}` : ''}`,
			);
		}
		await (dependencies.writeGatewayControlSessionMaterial ?? writeGatewayControlSessionMaterial)(
			zone.gateway.zoneRuntimeDir,
			managedControlSessionMaterial,
		);
		const startupRuntimeRecord = await buildManagedGatewayRuntimeRecord({
			appliedIngressRoutes,
			bootContract,
			controllerPort: options.systemConfig.host.controllerPort,
			expectedCohort,
			gatewayIdentity,
			image,
			ingressPort: ingress.port,
			managedVm: exactManagedVm,
			processTarget: exactStartupProcessTarget,
			projectNamespace: options.systemConfig.host.projectNamespace,
			readProcessIdentity: async (hostPid) =>
				hostPid === exactStartupProcessTarget.hostPid
					? exactStartupProcessTarget.processIdentity
					: null,
			systemConfigPath: options.systemConfig.systemConfigPath,
			zoneId: zone.id,
		});
		await runTaskStep('Recording gateway runtime', async () => {
			if (dependencies.writeGatewayRuntimeRecord === undefined) {
				await writeManagedGatewayRuntimeRecord(
					managedGatewayRuntimeRecordTarget,
					startupRuntimeRecord,
				);
			} else {
				await dependencies.writeGatewayRuntimeRecord(
					managedGatewayRuntimeRecordTarget,
					startupRuntimeRecord,
				);
			}
		});
		if (
			toolPortalMaterialization.kind === 'configured' &&
			toolPortalMaterialization.mode === 'runtime'
		) {
			options.onCredentialedRuntimeZoneStarted?.();
			options.credentialedRuntimeRegistryPublisher?.activate(
				toolPortalMaterialization.credentialedRuntimeRegistrySnapshot,
			);
		}
		return {
			bootContract,
			controlSession: activeControlSession,
			destroyGateway: async () => {
				options.credentialedRuntimeRegistryPublisher?.withdraw(zone.id);
				await options.onCredentialedRuntimeZoneStopping?.();
				return await destructionTransaction.destroyGateway();
			},
			executionModel: 'managed-gateway',
			expectedCohort,
			gatewayIdentity,
			image,
			ingress: { host: ingress.host, port: ingress.port },
			vm: createGatewayZoneVmOperations(exactManagedVm),
			zone,
		};
	} catch (error: unknown) {
		options.credentialedRuntimeRegistryPublisher?.withdraw(zone.id);
		let destroyResult: Awaited<ReturnType<typeof destructionTransaction.destroyGateway>>;
		try {
			destroyResult = await destructionTransaction.destroyGateway();
		} catch (cleanupError: unknown) {
			throw createAggregateErrorWithCause({
				cause: cleanupError,
				errors: [error, cleanupError],
				message: `Managed Gateway startup failed and VM '${exactManagedVm.id}' teardown was not proven complete.`,
			});
		}
		if (destroyResult.kind === 'destroyed-cleanup-incomplete') {
			throw createAggregateErrorWithCause({
				cause: error,
				errors: [error, ...destroyResult.cleanupFailures.map((failure) => failure.error)],
				message: `Managed Gateway startup failed after VM '${exactManagedVm.id}' destruction with incomplete ancillary cleanup.`,
			});
		}
		throw error;
	}
}
