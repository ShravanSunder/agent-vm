import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FormattedSecretValue, ToolPortalBackendKind } from '@agent-vm/config-contracts';
import {
	CONTROL_PROTOCOL_VERSION,
	CONTROL_SESSION_TIMING_MS,
} from '@agent-vm/control-protocol-contracts';
import {
	assertGatewayRuntimePortalSemanticSnapshotMatchesInputs,
	createGatewayRuntimeReadinessSnapshot,
	GATEWAY_RUNTIME_READINESS_SNAPSHOT_VERSION,
	GatewayRuntimeFatalEvidenceSchema,
	GatewayControlRpcMessageSchema,
	gatewayControlDeliveryPolicyByKind,
	gatewayControlDeliveryPolicyByOperation,
	type GatewayRuntimeAttachmentSnapshot,
	type GatewayRuntimeReadinessSnapshot,
} from '@agent-vm/gateway-control-contracts';
import {
	createManagedMcpProviderBackendFactoryFromConfig,
	type ManagedMcpProviderBackendFactory,
} from '@agent-vm/mcp-portal/mcp-provider-backend';
import { createToolPortalMcpProviderBackendPort } from '@agent-vm/tool-portal';

import { createGatewayControlDeferredApplicationMessageHandler } from '../control-endpoint/gateway-control-deferred-application-message-handler.js';
import {
	startGatewayControlEndpoint,
	type GatewayControlAcceptedSession,
	type GatewayControlEndpoint,
} from '../control-endpoint/gateway-control-endpoint.js';
import {
	createGatewayRuntimeManagedToolPortalComposition,
	type GatewayRuntimeManagedToolPortalComposition,
} from '../managed-tool-portal-composition.js';
import {
	GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
	type GatewayRuntimePrivateUdsProjectionFactoryProps,
} from '../tool-portal-projections.js';
import {
	createGatewayRuntimePaths,
	prepareGatewayRuntimeDirectory,
} from '../uds/gateway-runtime-paths.js';
import {
	startGatewayRuntimeUdsServer,
	type GatewayRuntimeUdsRetirementReceipt,
	type GatewayRuntimeUdsServer,
} from '../uds/gateway-runtime-uds-server.js';
import {
	createManagedPluginAttachmentState,
	GATEWAY_RUNTIME_PROTOCOL_VERSION,
	GATEWAY_RUNTIME_SCHEMA_VERSION,
} from '../uds/managed-plugin-attachment-policy.js';
import {
	createGatewayRuntimePrivateUdsDispatcher,
	resolveGatewayRuntimeOperationGroup,
	type GatewayRuntimeSandboxDispatchRequest,
} from './gateway-runtime-private-uds-dispatcher.js';
import {
	createGatewayRuntimeProductionControlRuntime,
	type GatewayRuntimeProductionControlRuntime,
} from './gateway-runtime-production-control-runtime.js';
import {
	cleanupPartiallyStartedGatewayRuntimeProductionLifecycle,
	createGatewayRuntimeProductionLifecycle,
} from './gateway-runtime-production-lifecycle.js';
import {
	loadGatewayRuntimeMcpConfig,
	type GatewayRuntimeServiceConfig,
} from './gateway-runtime-service-config.js';
import {
	createGatewayRuntimeToolPortalTelemetryRuntime,
	type GatewayRuntimeToolPortalTelemetryRuntime,
} from './gateway-runtime-tool-portal-telemetry.js';

const READY_EVIDENCE_FILENAME = 'tool-portal.readiness.json';
const FATAL_EVIDENCE_FILENAME = 'tool-portal.fatal.json';
const RETIREMENT_EVIDENCE_FILENAME = 'tool-portal.retirement.json';

export interface GatewayRuntimeProductionPrivateUdsProjection {
	readonly artifactOperations: GatewayRuntimePrivateUdsProjectionFactoryProps['artifactOperations'];
	readonly capabilityCore: GatewayRuntimePrivateUdsProjectionFactoryProps['capabilityCore'];
	readonly portalOperations: GatewayRuntimePrivateUdsProjectionFactoryProps['portalOperations'];
	readonly semanticSnapshot: GatewayRuntimePrivateUdsProjectionFactoryProps['semanticSnapshot'];
}

export type GatewayRuntimeProductionComposition =
	GatewayRuntimeManagedToolPortalComposition<GatewayRuntimeProductionPrivateUdsProjection>;

export type GatewayRuntimeProductionServiceReadiness = GatewayRuntimeReadinessSnapshot;

export interface GatewayRuntimeProductionServiceRetirementReceipt {
	readonly artifactEpochRetired: true;
	readonly controlEndpointClosed: true;
	readonly kind: 'retired';
	readonly providerRuntimeClosed: true;
	readonly semanticRevision: string;
	readonly serviceIdentity: GatewayRuntimeServiceConfig['serviceIdentity'];
	readonly uds: GatewayRuntimeUdsRetirementReceipt;
}

export interface GatewayRuntimeProductionService {
	readonly composition: GatewayRuntimeProductionComposition;
	readonly controlEndpoint: GatewayControlEndpoint;
	readonly evidencePaths: {
		readonly fatal: string;
		readonly readiness: string;
		readonly retirement: string;
	};
	readonly providerFactory: ManagedMcpProviderBackendFactory;
	readonly readiness: GatewayRuntimeProductionServiceReadiness;
	readonly retire: (props?: {
		readonly drainTimeoutMs?: number;
	}) => Promise<GatewayRuntimeProductionServiceRetirementReceipt>;
	readonly udsServer: GatewayRuntimeUdsServer;
}

export interface StartGatewayRuntimeProductionServiceDependencies {
	readonly clearControlHeartbeatIntervalImpl?: (timer: NodeJS.Timeout) => void;
	readonly createMcpProviderFactory?: (props: {
		readonly mcpConfig: Awaited<ReturnType<typeof loadGatewayRuntimeMcpConfig>>;
		readonly resolveSecret: (secret: FormattedSecretValue) => Promise<string>;
	}) => Promise<ManagedMcpProviderBackendFactory>;
	readonly createControlRuntime?: typeof createGatewayRuntimeProductionControlRuntime;
	readonly createManagedComposition?: typeof createGatewayRuntimeManagedToolPortalComposition;
	readonly createToolPortalTelemetryRuntime?: typeof createGatewayRuntimeToolPortalTelemetryRuntime;
	readonly now?: () => number;
	readonly resolveMcpSecret?: (secret: FormattedSecretValue) => Promise<string>;
	readonly sandboxDispatch?: (request: GatewayRuntimeSandboxDispatchRequest) => Promise<unknown>;
	readonly setControlHeartbeatIntervalImpl?: (
		callback: () => void,
		delayMs: number,
	) => NodeJS.Timeout;
	readonly startControlEndpoint?: typeof startGatewayControlEndpoint;
	readonly startUdsServer?: typeof startGatewayRuntimeUdsServer;
}

export interface StartGatewayRuntimeProductionServiceProps {
	readonly config: GatewayRuntimeServiceConfig;
	readonly dependencies: StartGatewayRuntimeProductionServiceDependencies;
}

function evidencePaths(runtimeRoot: string): GatewayRuntimeProductionService['evidencePaths'] {
	return Object.freeze({
		fatal: path.join(runtimeRoot, FATAL_EVIDENCE_FILENAME),
		readiness: path.join(runtimeRoot, READY_EVIDENCE_FILENAME),
		retirement: path.join(runtimeRoot, RETIREMENT_EVIDENCE_FILENAME),
	});
}

async function writeAtomicProtectedJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
	const temporaryPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${randomUUID()}.tmp`,
	);
	await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
	await chmod(temporaryPath, 0o600);
	await rename(temporaryPath, filePath);
}

interface SerializedReadinessEvidenceWriter {
	readonly enqueue: (snapshot: GatewayRuntimeProductionServiceReadiness) => void;
	readonly flush: () => Promise<void>;
}

function createSerializedReadinessEvidenceWriter(
	filePath: string,
): SerializedReadinessEvidenceWriter {
	let firstWriteFailure: { readonly cause: unknown } | undefined;
	let writeTail: Promise<void> = Promise.resolve();
	return {
		enqueue: (snapshot): void => {
			writeTail = writeTail
				.then(async () => await writeAtomicProtectedJson(filePath, snapshot))
				.catch((error: unknown) => {
					firstWriteFailure ??= { cause: error };
				});
		},
		flush: async (): Promise<void> => {
			await writeTail;
			if (firstWriteFailure !== undefined) {
				throw new Error('Gateway runtime readiness evidence could not be persisted.', {
					cause: firstWriteFailure.cause,
				});
			}
		},
	};
}

interface SerializedReadinessControlPublisher {
	readonly enqueue: (snapshot: GatewayRuntimeProductionServiceReadiness) => void;
	readonly flush: () => Promise<void>;
	readonly unsubscribe: () => void;
}

function createSerializedReadinessControlPublisher(props: {
	readonly controlEndpoint: GatewayControlEndpoint;
	readonly now: () => number;
}): SerializedReadinessControlPublisher {
	let closed = false;
	let drainPromise: Promise<void> | undefined;
	let latestSnapshot: GatewayRuntimeProductionServiceReadiness | undefined;
	let lastAttemptedPublication:
		| {
				readonly connectionId: string;
				readonly sessionId: string;
				readonly snapshot: GatewayRuntimeProductionServiceReadiness;
		  }
		| undefined;

	const publishSnapshot = async (propsForPublication: {
		readonly acceptedSession: GatewayControlAcceptedSession;
		readonly snapshot: GatewayRuntimeProductionServiceReadiness;
	}): Promise<void> => {
		const message = GatewayControlRpcMessageSchema.parse({
			kind: 'event',
			operation: 'gateway_runtime_readiness',
			payload: propsForPublication.snapshot,
		});
		await props.controlEndpoint.service.emitApplicationMessage({
			buildEnvelope: ({ acceptedSession, sequence }) => {
				if (
					acceptedSession.connectionId !== propsForPublication.acceptedSession.connectionId ||
					acceptedSession.sessionId !== propsForPublication.acceptedSession.sessionId
				) {
					throw new Error('Gateway runtime readiness target control session is no longer current.');
				}
				return {
					bootId: acceptedSession.bootId,
					connectionId: acceptedSession.connectionId,
					controllerEpoch: acceptedSession.controllerEpoch,
					createdAtMs: Math.max(1, props.now()),
					deliveryPolicy: gatewayControlDeliveryPolicyByOperation.gateway_runtime_readiness,
					domain: 'gateway_control',
					kind: 'event',
					messageId: randomUUID(),
					operation: 'gateway_runtime_readiness',
					peerId: acceptedSession.peerId,
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					sequence,
					sessionId: acceptedSession.sessionId,
					zoneId: acceptedSession.zoneId,
				};
			},
			domainMessage: { kind: 'event', operation: 'gateway_runtime_readiness' },
			payload: message,
		});
	};

	const publicationNeeded = (): boolean => {
		const acceptedSession = props.controlEndpoint.service.getCurrentAcceptedSession();
		if (closed || acceptedSession === undefined || latestSnapshot === undefined) return false;
		return !(
			lastAttemptedPublication?.connectionId === acceptedSession.connectionId &&
			lastAttemptedPublication.sessionId === acceptedSession.sessionId &&
			lastAttemptedPublication.snapshot === latestSnapshot
		);
	};

	const drainLatestSnapshot = async (): Promise<void> => {
		const acceptedSession = props.controlEndpoint.service.getCurrentAcceptedSession();
		const snapshot = latestSnapshot;
		if (closed || acceptedSession === undefined || snapshot === undefined) return;
		lastAttemptedPublication = {
			connectionId: acceptedSession.connectionId,
			sessionId: acceptedSession.sessionId,
			snapshot,
		};
		try {
			await publishSnapshot({ acceptedSession, snapshot });
		} catch {
			// A stale/disconnected target is not retried until a new session or snapshot exists.
		}
	};

	const scheduleDrain = (): void => {
		if (!publicationNeeded() || drainPromise !== undefined) return;
		drainPromise = drainLatestSnapshot().finally(() => {
			drainPromise = undefined;
			scheduleDrain();
		});
	};

	const acceptedSessionObservation = props.controlEndpoint.service.observeAcceptedSessions(
		() => scheduleDrain(),
		() => undefined,
	);
	const waitForDrainCompletion = async (): Promise<void> => {
		const activeDrain = drainPromise;
		if (activeDrain === undefined) return;
		await activeDrain;
		if (drainPromise !== undefined && drainPromise !== activeDrain) {
			await waitForDrainCompletion();
		}
	};

	return {
		enqueue: (snapshot): void => {
			if (closed) return;
			latestSnapshot = snapshot;
			scheduleDrain();
		},
		flush: async (): Promise<void> => {
			await waitForDrainCompletion();
		},
		unsubscribe: (): void => {
			if (closed) return;
			closed = true;
			latestSnapshot = undefined;
			acceptedSessionObservation.unsubscribe();
		},
	};
}

interface GatewayControlHeartbeatPublisher {
	readonly flush: () => Promise<void>;
	readonly stop: () => void;
}

function startGatewayControlHeartbeatPublisher(props: {
	readonly clearIntervalImpl?: (timer: NodeJS.Timeout) => void;
	readonly controlEndpoint: GatewayControlEndpoint;
	readonly now: () => number;
	readonly setIntervalImpl?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
}): GatewayControlHeartbeatPublisher {
	const clearIntervalImpl = props.clearIntervalImpl ?? clearInterval;
	const setIntervalImpl = props.setIntervalImpl ?? setInterval;
	let stopped = false;
	let publicationPending = false;
	let publicationPromise: Promise<void> | undefined;

	const publishHeartbeat = async (
		acceptedSession: GatewayControlAcceptedSession,
	): Promise<void> => {
		const observedAtMs = Math.max(1, props.now());
		const message = GatewayControlRpcMessageSchema.parse({
			kind: 'heartbeat',
			payload: {
				elapsedMs: Math.max(0, props.now() - observedAtMs),
				observedAtMs,
			},
		});
		await props.controlEndpoint.service.emitApplicationMessage({
			buildEnvelope: ({ acceptedSession: currentAcceptedSession, sequence }) => {
				if (
					currentAcceptedSession.connectionId !== acceptedSession.connectionId ||
					currentAcceptedSession.sessionId !== acceptedSession.sessionId
				) {
					throw new Error('Gateway control heartbeat target session is no longer current.');
				}
				return {
					bootId: currentAcceptedSession.bootId,
					connectionId: currentAcceptedSession.connectionId,
					controllerEpoch: currentAcceptedSession.controllerEpoch,
					createdAtMs: Math.max(1, props.now()),
					deliveryPolicy: gatewayControlDeliveryPolicyByKind.heartbeat,
					domain: 'gateway_control',
					kind: 'heartbeat',
					messageId: randomUUID(),
					peerId: currentAcceptedSession.peerId,
					protocolVersion: CONTROL_PROTOCOL_VERSION,
					sequence,
					sessionId: currentAcceptedSession.sessionId,
					zoneId: currentAcceptedSession.zoneId,
				};
			},
			domainMessage: { kind: 'heartbeat' },
			payload: message,
		});
	};

	const drainPendingPublication = async (): Promise<void> => {
		if (stopped || !publicationPending) return;
		publicationPending = false;
		const acceptedSession = props.controlEndpoint.service.getCurrentAcceptedSession();
		if (acceptedSession === undefined) return;
		try {
			await publishHeartbeat(acceptedSession);
		} catch {
			// A failed or replaced attachment is retried only after a cadence tick or new acceptance.
		}
	};

	const schedulePublication = (): void => {
		if (stopped || props.controlEndpoint.service.getCurrentAcceptedSession() === undefined) return;
		publicationPending = true;
		if (publicationPromise !== undefined) return;
		publicationPromise = drainPendingPublication().finally(() => {
			publicationPromise = undefined;
			if (publicationPending) schedulePublication();
		});
	};

	const acceptedSessionObservation = props.controlEndpoint.service.observeAcceptedSessions(
		() => schedulePublication(),
		() => undefined,
	);
	const timer = setIntervalImpl(
		() => schedulePublication(),
		CONTROL_SESSION_TIMING_MS.engineIoPingInterval,
	);
	timer.unref?.();

	return {
		flush: async (): Promise<void> => {
			const activePublication = publicationPromise;
			if (activePublication === undefined) return;
			await activePublication;
			if (publicationPromise !== undefined && publicationPromise !== activePublication) {
				await publicationPromise;
			}
		},
		stop: (): void => {
			if (stopped) return;
			stopped = true;
			publicationPending = false;
			clearIntervalImpl(timer);
			acceptedSessionObservation.unsubscribe();
		},
	};
}

function createProductionReadinessSnapshot(props: {
	readonly attachment: GatewayRuntimeAttachmentSnapshot;
	readonly config: GatewayRuntimeServiceConfig;
	readonly controlEndpoint: GatewayControlEndpoint;
	readonly readyBackendKinds: readonly ToolPortalBackendKind[];
	readonly udsSocketPath: string;
}): GatewayRuntimeProductionServiceReadiness {
	const publicationStatus = props.attachment.status === 'retired' ? 'retired' : 'published';
	return createGatewayRuntimeReadinessSnapshot({
		controlEndpoint: {
			identity: props.config.controlEndpoint.identity,
			listener: props.controlEndpoint.readiness,
		},
		kind: 'tool-portal-role-readiness',
		providerRevision: props.config.semanticSnapshot.providerRevision,
		requiredBackends: {
			readyBackendKinds: props.readyBackendKinds,
			revision: props.config.semanticSnapshot.bindingRevision,
			status: 'ready',
		},
		semanticRevision: props.config.semanticSnapshot.activeRevision,
		serviceIdentity: props.config.serviceIdentity,
		snapshotVersion: GATEWAY_RUNTIME_READINESS_SNAPSHOT_VERSION,
		uds: {
			attachment: props.attachment,
			publication: {
				identity: 'managed-plugin-private-uds',
				protocolVersion: GATEWAY_RUNTIME_PROTOCOL_VERSION,
				schemaVersion: GATEWAY_RUNTIME_SCHEMA_VERSION,
				socketPath: props.udsSocketPath,
				status: publicationStatus,
			},
		},
	});
}

function requiredBackendKinds(
	config: GatewayRuntimeServiceConfig,
): readonly ToolPortalBackendKind[] {
	const kinds = new Set<ToolPortalBackendKind>();
	for (const profile of Object.values(config.toolPortalConfig.profiles)) {
		for (const namespacePolicy of Object.values(profile.namespaces)) {
			kinds.add(namespacePolicy.backend.kind);
		}
	}
	return Object.freeze([...kinds].toSorted());
}

function assertRequiredBackendKindsReady(
	config: GatewayRuntimeServiceConfig,
): readonly ToolPortalBackendKind[] {
	const requiredKinds = requiredBackendKinds(config);
	const readyKinds = new Set<ToolPortalBackendKind>([
		'controller_host_action',
		'mcp_provider',
		'tool_vm_runner',
	]);
	const unavailableKinds = requiredKinds.filter((backendKind) => !readyKinds.has(backendKind));
	if (unavailableKinds.length > 0) {
		throw new Error(
			`Gateway runtime required backend ports are unavailable: ${unavailableKinds.join(', ')}.`,
		);
	}
	return requiredKinds;
}

export async function writeGatewayRuntimeFatalEvidence(props: {
	readonly config: GatewayRuntimeServiceConfig;
	readonly failureCode: 'configuration-failed' | 'startup-failed';
}): Promise<void> {
	await prepareGatewayRuntimeDirectory(
		createGatewayRuntimePaths({ runtimeRoot: props.config.runtimeRoot }),
	);
	await writeAtomicProtectedJson(
		evidencePaths(props.config.runtimeRoot).fatal,
		GatewayRuntimeFatalEvidenceSchema.parse({
			failureCode: props.failureCode,
			kind: 'fatal',
			observedGatewayEpoch: props.config.attachment.gatewayEpoch,
			processEpoch: props.config.serviceIdentity.processEpoch,
			role: 'tool-portal-service',
			schemaVersion: 1,
			serviceId: props.config.serviceIdentity.serviceId,
		}),
	);
}

async function resolveEnvironmentOnlyMcpSecret(secret: FormattedSecretValue): Promise<string> {
	if (secret.source !== 'environment') {
		throw new Error('Gateway runtime accepts only controller-materialized environment secrets.');
	}
	const value = process.env[secret.name];
	if (value === undefined || value.length === 0) {
		throw new Error('Gateway runtime MCP environment secret is unavailable.');
	}
	return value;
}

export async function startGatewayRuntimeProductionService(
	props: StartGatewayRuntimeProductionServiceProps,
): Promise<GatewayRuntimeProductionService> {
	const mcpConfig = await loadGatewayRuntimeMcpConfig(props.config.mcpConfigPath);
	assertGatewayRuntimePortalSemanticSnapshotMatchesInputs({
		mcpConfig,
		semanticSnapshot: props.config.semanticSnapshot,
		toolPortalConfig: props.config.toolPortalConfig,
	});
	const paths = createGatewayRuntimePaths({ runtimeRoot: props.config.runtimeRoot });
	await prepareGatewayRuntimeDirectory(paths);
	const configuredEvidencePaths = evidencePaths(props.config.runtimeRoot);
	const createProviderFactory =
		props.dependencies.createMcpProviderFactory ?? createManagedMcpProviderBackendFactoryFromConfig;
	const createControlEndpoint =
		props.dependencies.startControlEndpoint ?? startGatewayControlEndpoint;
	const createControlRuntime =
		props.dependencies.createControlRuntime ?? createGatewayRuntimeProductionControlRuntime;
	const createManagedComposition =
		props.dependencies.createManagedComposition ?? createGatewayRuntimeManagedToolPortalComposition;
	const createUdsServer = props.dependencies.startUdsServer ?? startGatewayRuntimeUdsServer;
	let providerFactory: ManagedMcpProviderBackendFactory | undefined;
	let composition: GatewayRuntimeProductionComposition | undefined;
	let controlEndpoint: GatewayControlEndpoint | undefined;
	let controlRuntime: GatewayRuntimeProductionControlRuntime | undefined;
	let controlHeartbeatPublisher: GatewayControlHeartbeatPublisher | undefined;
	let readinessEvidenceWriter: SerializedReadinessEvidenceWriter | undefined;
	let readinessControlPublisher: SerializedReadinessControlPublisher | undefined;
	let udsServer: GatewayRuntimeUdsServer | undefined;
	let telemetryRuntime: GatewayRuntimeToolPortalTelemetryRuntime | undefined;
	let unsubscribeAttachmentSnapshots: (() => void) | undefined;
	const deferredApplicationMessageHandler = createGatewayControlDeferredApplicationMessageHandler();
	let applicationMessageHandlerBound = false;
	try {
		telemetryRuntime = (
			props.dependencies.createToolPortalTelemetryRuntime ??
			createGatewayRuntimeToolPortalTelemetryRuntime
		)({
			config: props.config.observability,
			identity: {
				frameworkKind:
					props.config.attachment.clientKind === 'openclaw-managed-plugin' ? 'openclaw' : 'hermes',
				gatewayEpoch: props.config.attachment.gatewayEpoch,
				zoneId: props.config.controlEndpoint.identity.zoneId,
			},
		});
		const startedTelemetryRuntime = telemetryRuntime;
		providerFactory = await createProviderFactory({
			mcpConfig,
			resolveSecret: props.dependencies.resolveMcpSecret ?? resolveEnvironmentOnlyMcpSecret,
		});
		const startedProviderFactory = providerFactory;
		const readyBackendKinds = assertRequiredBackendKindsReady(props.config);
		controlEndpoint = await createControlEndpoint({
			applicationMessageHandler: deferredApplicationMessageHandler.handler,
			identity: props.config.controlEndpoint.identity,
			listen: props.config.controlEndpoint.listen,
			verifierPublicKeyPem: props.config.controlEndpoint.authority.verifierPublicKeyPem,
		});
		const startedControlEndpoint = controlEndpoint;
		controlRuntime = await createControlRuntime({
			artifactLifetimeMs: props.config.artifactLimits.maximumLifetimeMs,
			controlAuthority: {
				callerContextAgentAuthorityKeys:
					props.config.controlEndpoint.authority.callerContextAgentAuthorityKeys,
				callerContextProofKey: props.config.controlEndpoint.authority.callerContextProofKey,
			},
			controlEndpoint: startedControlEndpoint,
			owningGeneration: props.config.attachment.runtimeEpoch,
			toolPortalConfig: props.config.toolPortalConfig,
			zoneId: props.config.controlEndpoint.identity.zoneId,
		});
		const startedControlRuntime = controlRuntime;
		deferredApplicationMessageHandler.bind(startedControlRuntime.applicationMessageHandler);
		applicationMessageHandlerBound = true;
		composition = await createManagedComposition({
			approvalPort: startedControlRuntime.approvalPort,
			artifactRuntime: {
				artifactsDirectoryPath: path.join(props.config.runtimeRoot, 'artifacts'),
				epochId: props.config.attachment.runtimeEpoch,
				limits: props.config.artifactLimits,
				now: props.dependencies.now ?? Date.now,
			},
			authenticatedPrivateUdsOperationGroups:
				GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
			backendPortFactories: {
				controllerHostAction: (runtime) =>
					startedTelemetryRuntime.wrapBackendPort(
						startedControlRuntime.controllerHostActionBackendPortFactory(runtime),
					),
				mcpProvider: () =>
					startedTelemetryRuntime.wrapBackendPort(
						createToolPortalMcpProviderBackendPort({
							backendFactory: startedProviderFactory,
							mode: 'managed',
							toolPortalConfig: props.config.toolPortalConfig,
						}),
					),
				toolVmRunner: (runtime) =>
					startedTelemetryRuntime.wrapBackendPort(
						startedControlRuntime.toolVmRunnerBackendPortFactory(runtime),
					),
			},
			createPrivateUdsProjection: (projectionProps) => ({
				artifactOperations: projectionProps.artifactOperations,
				capabilityCore: projectionProps.capabilityCore,
				portalOperations: projectionProps.portalOperations,
				semanticSnapshot: projectionProps.semanticSnapshot,
			}),
			managedPluginAttachment: {
				clientKind: props.config.attachment.clientKind,
				configuredAgentIds: props.config.attachment.configuredAgentIds,
				projectionCohortDigest: props.config.attachment.projectionCohortDigest,
			},
			semanticSnapshot: props.config.semanticSnapshot,
			toolPortalConfig: props.config.toolPortalConfig,
		});
		const startedComposition = composition;
		controlHeartbeatPublisher = startGatewayControlHeartbeatPublisher({
			...(props.dependencies.clearControlHeartbeatIntervalImpl === undefined
				? {}
				: { clearIntervalImpl: props.dependencies.clearControlHeartbeatIntervalImpl }),
			controlEndpoint: startedControlEndpoint,
			now: props.dependencies.now ?? Date.now,
			...(props.dependencies.setControlHeartbeatIntervalImpl === undefined
				? {}
				: { setIntervalImpl: props.dependencies.setControlHeartbeatIntervalImpl }),
		});
		const startedControlHeartbeatPublisher = controlHeartbeatPublisher;

		const dispatcher = createGatewayRuntimePrivateUdsDispatcher({
			artifactOperations: startedComposition.privateUdsProjection.artifactOperations,
			portalOperations: startedComposition.privateUdsProjection.portalOperations,
			sandboxDispatch: startedTelemetryRuntime.wrapSandboxDispatch(
				props.dependencies.sandboxDispatch ?? startedControlRuntime.sandboxDispatch,
			),
			traceContextDispatch: startedTelemetryRuntime.traceContextDispatch,
		});
		udsServer = await createUdsServer({
			attachmentState: createManagedPluginAttachmentState({
				...props.config.attachment,
				serverAuthority: {
					allowedOperationGroups: GATEWAY_RUNTIME_AUTHENTICATED_PRIVATE_UDS_OPERATION_GROUPS,
					surface: 'managed-plugin',
				},
			}),
			dispatch: dispatcher.dispatch,
			paths,
			resolveOperationGroup: resolveGatewayRuntimeOperationGroup,
		});
		const startedUdsServer = udsServer;

		readinessEvidenceWriter = createSerializedReadinessEvidenceWriter(
			configuredEvidencePaths.readiness,
		);
		const startedReadinessEvidenceWriter = readinessEvidenceWriter;
		const startedReadinessControlPublisher = createSerializedReadinessControlPublisher({
			controlEndpoint: startedControlEndpoint,
			now: props.dependencies.now ?? Date.now,
		});
		readinessControlPublisher = startedReadinessControlPublisher;
		let readiness = createProductionReadinessSnapshot({
			attachment: startedUdsServer.getAttachmentSnapshot(),
			config: props.config,
			controlEndpoint: startedControlEndpoint,
			readyBackendKinds,
			udsSocketPath: startedUdsServer.readiness.socketPath,
		});
		const attachmentSnapshotObservation = startedUdsServer.observeAttachmentSnapshots(
			(attachment): void => {
				readiness = createProductionReadinessSnapshot({
					attachment,
					config: props.config,
					controlEndpoint: startedControlEndpoint,
					readyBackendKinds,
					udsSocketPath: startedUdsServer.readiness.socketPath,
				});
				startedReadinessEvidenceWriter.enqueue(readiness);
				startedReadinessControlPublisher.enqueue(readiness);
			},
			(error): never => {
				throw new Error('Gateway runtime attachment readiness observation failed.', {
					cause: error,
				});
			},
		);
		unsubscribeAttachmentSnapshots = attachmentSnapshotObservation.unsubscribe;
		startedReadinessEvidenceWriter.enqueue(readiness);
		startedReadinessControlPublisher.enqueue(readiness);
		await startedReadinessEvidenceWriter.flush();

		const lifecycle = createGatewayRuntimeProductionLifecycle({
			createRetirementReceipt: ({ udsRetirementReceipt }) =>
				Object.freeze({
					artifactEpochRetired: true,
					controlEndpointClosed: true,
					kind: 'retired',
					providerRuntimeClosed: true,
					semanticRevision: props.config.semanticSnapshot.activeRevision,
					serviceIdentity: props.config.serviceIdentity,
					uds: udsRetirementReceipt,
				}) satisfies GatewayRuntimeProductionServiceRetirementReceipt,
			resources: {
				artifactEpoch: { retire: startedComposition.retireEpoch },
				attachmentPublisher: { unsubscribe: attachmentSnapshotObservation.unsubscribe },
				bindingRuntime: startedControlRuntime,
				controlEndpoint: startedControlEndpoint,
				heartbeatPublisher: startedControlHeartbeatPublisher,
				providerRuntime: { close: startedProviderFactory.close },
				readinessLifecycle: {
					flushControlPublisher: startedReadinessControlPublisher.flush,
					flushEvidence: startedReadinessEvidenceWriter.flush,
					unsubscribeControlPublisher: startedReadinessControlPublisher.unsubscribe,
				},
				udsServer: startedUdsServer,
			},
			terminalEvidence: {
				write: async (outcome): Promise<void> => {
					await writeAtomicProtectedJson(
						configuredEvidencePaths.retirement,
						outcome.kind === 'retired'
							? outcome.receipt
							: {
									...outcome,
									semanticRevision: props.config.semanticSnapshot.activeRevision,
									serviceIdentity: props.config.serviceIdentity,
								},
					);
				},
			},
		});

		let retirementPromise: Promise<GatewayRuntimeProductionServiceRetirementReceipt> | undefined;
		return {
			composition: startedComposition,
			controlEndpoint: startedControlEndpoint,
			evidencePaths: configuredEvidencePaths,
			providerFactory: startedProviderFactory,
			get readiness(): GatewayRuntimeProductionServiceReadiness {
				return readiness;
			},
			retire: (options = {}): Promise<GatewayRuntimeProductionServiceRetirementReceipt> => {
				retirementPromise ??=
					(async (): Promise<GatewayRuntimeProductionServiceRetirementReceipt> => {
						try {
							return await lifecycle.retire(options);
						} finally {
							await startedTelemetryRuntime.shutdown().catch(() => undefined);
						}
					})();
				return retirementPromise;
			},
			udsServer: startedUdsServer,
		};
	} catch (error: unknown) {
		if (!applicationMessageHandlerBound) deferredApplicationMessageHandler.fail(error);
		let rollbackError: unknown;
		try {
			await cleanupPartiallyStartedGatewayRuntimeProductionLifecycle({
				drainTimeoutMs: 1,
				resources: {
					...(composition === undefined
						? {}
						: { artifactEpoch: { retire: composition.retireEpoch } }),
					...(unsubscribeAttachmentSnapshots === undefined
						? {}
						: { attachmentPublisher: { unsubscribe: unsubscribeAttachmentSnapshots } }),
					...(controlRuntime === undefined ? {} : { bindingRuntime: controlRuntime }),
					...(controlEndpoint === undefined ? {} : { controlEndpoint }),
					...(controlHeartbeatPublisher === undefined
						? {}
						: { heartbeatPublisher: controlHeartbeatPublisher }),
					...(providerFactory === undefined
						? {}
						: { providerRuntime: { close: providerFactory.close } }),
					...(readinessEvidenceWriter === undefined && readinessControlPublisher === undefined
						? {}
						: {
								readinessLifecycle: {
									flushControlPublisher:
										readinessControlPublisher?.flush ?? (async (): Promise<void> => undefined),
									flushEvidence:
										readinessEvidenceWriter?.flush ?? (async (): Promise<void> => undefined),
									unsubscribeControlPublisher:
										readinessControlPublisher?.unsubscribe ?? (() => undefined),
								},
							}),
					...(udsServer === undefined ? {} : { udsServer }),
				},
			});
		} catch (cleanupError: unknown) {
			rollbackError = cleanupError;
		}
		await writeGatewayRuntimeFatalEvidence({
			config: props.config,
			failureCode: 'startup-failed',
		}).catch(() => undefined);
		await telemetryRuntime?.shutdown().catch(() => undefined);
		if (rollbackError !== undefined) {
			const startupRollbackError = new AggregateError(
				[error, rollbackError],
				'Gateway runtime startup and ordered rollback failed.',
				{ cause: error },
			);
			throw startupRollbackError;
		}
		throw error;
	}
}
