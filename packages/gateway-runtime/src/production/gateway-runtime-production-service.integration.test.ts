import { generateKeyPairSync, randomUUID, sign as signPayload, type KeyObject } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, watch, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PortalListRequestSchema } from '@agent-vm/agent-portal-sdk';
import {
	GatewayRuntimeClient,
	type GatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeClientTrustedInvocationContext,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import {
	managedToolPortalConfigSchema,
	mcpConfigSchema,
	type FormattedSecretValue,
	type ToolPortalBackendKind,
} from '@agent-vm/config-contracts';
import {
	CONTROL_HANDSHAKE_HEADER_NAMES,
	CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
	CONTROL_PROTOCOL_VERSION,
	CONTROL_READY_HEADER_NAMES,
	CONTROL_SESSION_TIMING_MS,
	ControlEnvelopeSchema,
	buildControlHandshakeSignaturePayload,
	buildControlReadyRequestSignaturePayload,
	type ControlEnvelope,
	type ControlHandshakeCredential,
	type ControlReadyRequestCredential,
} from '@agent-vm/control-protocol-contracts';
import {
	deriveGatewayRuntimePortalSemanticSnapshot,
	GatewayControlHelloResponseSchema,
	GatewayControlRpcMessageSchema,
	GatewayRuntimeReadinessSnapshotSchema,
	type GatewayControlHello,
	type GatewayControlRpcMessage,
	type GatewayRuntimeReadinessSnapshot,
} from '@agent-vm/gateway-control-contracts';
import type { ManagedMcpProviderBackendFactory } from '@agent-vm/mcp-portal/mcp-provider-backend';
import type { ToolPortalBackendPort } from '@agent-vm/tool-portal';
import { io as createSocketIoClient, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
	GatewayControlApplicationMessageContext,
	GatewayControlApplicationMessageHandler,
} from '../control-endpoint/gateway-control-endpoint-contracts.js';
import {
	GATEWAY_CONTROL_READY_PATH,
	GATEWAY_CONTROL_SOCKET_PATH,
	startGatewayControlEndpoint,
	type GatewayControlIssuedCredential,
} from '../control-endpoint/gateway-control-endpoint.js';
import { createGatewayRuntimeManagedToolPortalComposition } from '../managed-tool-portal-composition.js';
import { rejectUnavailableGatewayRuntimeSandboxDispatch } from '../testing/gateway-runtime-unavailable-ports.js';
import { startGatewayRuntimeUdsServer } from '../uds/gateway-runtime-uds-server.js';
import { createGatewayRuntimeProductionControlRuntime } from './gateway-runtime-production-control-runtime.js';
import {
	startGatewayRuntimeProductionService,
	type GatewayRuntimeProductionService,
} from './gateway-runtime-production-service.js';
import type { GatewayRuntimeServiceConfig } from './gateway-runtime-service-config.js';
import type { GatewayRuntimeToolPortalTelemetryRuntime } from './gateway-runtime-tool-portal-telemetry.js';

const temporaryRoots: string[] = [];
const runningServices: GatewayRuntimeProductionService[] = [];
const runningControlClients: Socket[] = [];
const READINESS_EVIDENCE_WAIT_MILLISECONDS = 2_000;

interface ScheduledControlHeartbeatInterval {
	readonly callback: () => void;
	readonly delayMs: number;
	readonly handle: NodeJS.Timeout;
}

function createManualControlHeartbeatInterval(): {
	readonly active: () => readonly ScheduledControlHeartbeatInterval[];
	readonly clearIntervalImpl: (handle: NodeJS.Timeout) => void;
	readonly fire: () => void;
	readonly setIntervalImpl: (callback: () => void, delayMs: number) => NodeJS.Timeout;
	readonly unrefCount: () => number;
} {
	const scheduled: ScheduledControlHeartbeatInterval[] = [];
	let timerUnrefCount = 0;
	return {
		active: (): readonly ScheduledControlHeartbeatInterval[] => scheduled.slice(),
		clearIntervalImpl: (handle): void => {
			const scheduledIndex = scheduled.findIndex((interval) => interval.handle === handle);
			if (scheduledIndex >= 0) scheduled.splice(scheduledIndex, 1);
		},
		fire: (): void => {
			for (const interval of scheduled.slice()) interval.callback();
		},
		setIntervalImpl: (callback, delayMs): NodeJS.Timeout => {
			const handle = {
				unref: (): void => {
					timerUnrefCount += 1;
				},
			} as NodeJS.Timeout;
			scheduled.push({ callback, delayMs, handle });
			return handle;
		},
		unrefCount: (): number => timerUnrefCount,
	};
}

type GatewayControlHeartbeatMessage = Extract<GatewayControlRpcMessage, { kind: 'heartbeat' }>;

interface CollectedControlHeartbeat {
	readonly acknowledge: (receipt: unknown) => void;
	readonly envelope: ControlEnvelope;
	readonly message: GatewayControlHeartbeatMessage;
}

function createControlHeartbeatCollector(client: Socket): {
	readonly count: () => number;
	readonly holdNext: () => void;
	readonly releaseHeld: (receipt: unknown) => void;
	readonly waitForCount: (count: number) => Promise<readonly CollectedControlHeartbeat[]>;
} {
	const heartbeats: CollectedControlHeartbeat[] = [];
	const countWaiters = new Map<number, () => void>();
	let holdNextHeartbeat = false;
	let heldAcknowledgement: ((receipt: unknown) => void) | undefined;
	client.on('control:message', (envelopePayload, messagePayload, acknowledge) => {
		const message = GatewayControlRpcMessageSchema.parse(messagePayload);
		if (message.kind !== 'heartbeat') {
			acknowledge({ received: true });
			return;
		}
		const heartbeat = {
			acknowledge,
			envelope: ControlEnvelopeSchema.parse(envelopePayload),
			message,
		} satisfies CollectedControlHeartbeat;
		heartbeats.push(heartbeat);
		const countWaiter = countWaiters.get(heartbeats.length);
		if (countWaiter !== undefined) {
			countWaiters.delete(heartbeats.length);
			countWaiter();
		}
		if (holdNextHeartbeat) {
			holdNextHeartbeat = false;
			heldAcknowledgement = acknowledge;
			return;
		}
		acknowledge({ received: true });
	});
	return {
		count: (): number => heartbeats.length,
		holdNext: (): void => {
			if (heldAcknowledgement !== undefined) {
				throw new Error('A control heartbeat acknowledgement is already held.');
			}
			holdNextHeartbeat = true;
		},
		releaseHeld: (receipt): void => {
			const acknowledge = heldAcknowledgement;
			if (acknowledge === undefined) {
				throw new Error('No control heartbeat acknowledgement is held.');
			}
			heldAcknowledgement = undefined;
			acknowledge(receipt);
		},
		waitForCount: async (count): Promise<readonly CollectedControlHeartbeat[]> => {
			if (heartbeats.length >= count) return heartbeats.slice();
			const timeoutSignal = AbortSignal.timeout(READINESS_EVIDENCE_WAIT_MILLISECONDS);
			await new Promise<void>((resolve, reject) => {
				const rejectTimedOutWait = (): void => {
					countWaiters.delete(count);
					reject(new Error(`Timed out waiting for ${String(count)} control heartbeats.`));
				};
				timeoutSignal.addEventListener('abort', rejectTimedOutWait, { once: true });
				countWaiters.set(count, () => {
					timeoutSignal.removeEventListener('abort', rejectTimedOutWait);
					resolve();
				});
			});
			return heartbeats.slice();
		},
	};
}

async function waitForReadinessEvidenceStatus(props: {
	readonly evidencePath: string;
	readonly minimumObservationSequence?: number;
	readonly status: GatewayRuntimeReadinessSnapshot['uds']['attachment']['status'];
}): Promise<GatewayRuntimeReadinessSnapshot> {
	const signal = AbortSignal.timeout(READINESS_EVIDENCE_WAIT_MILLISECONDS);
	const watcher = watch(path.dirname(props.evidencePath), { signal });
	const readMatchingSnapshot = async (): Promise<GatewayRuntimeReadinessSnapshot | undefined> => {
		try {
			const snapshot = GatewayRuntimeReadinessSnapshotSchema.parse(
				JSON.parse(await readFile(props.evidencePath, 'utf8')),
			);
			return snapshot.uds.attachment.status === props.status &&
				snapshot.uds.attachment.observationSequence >= (props.minimumObservationSequence ?? 0)
				? snapshot
				: undefined;
		} catch (error: unknown) {
			if (
				typeof error === 'object' &&
				error !== null &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				return undefined;
			}
			throw error;
		}
	};
	try {
		const currentSnapshot = await readMatchingSnapshot();
		if (currentSnapshot !== undefined) return currentSnapshot;
		for await (const event of watcher) {
			if (event.filename !== path.basename(props.evidencePath)) continue;
			const snapshot = await readMatchingSnapshot();
			if (snapshot !== undefined) return snapshot;
		}
	} catch (error: unknown) {
		if (signal.aborted) {
			throw new Error(`Timed out waiting for readiness evidence status '${props.status}'.`, {
				cause: error,
			});
		}
		throw error;
	}
	throw new Error(`Readiness evidence watcher ended before status '${props.status}'.`);
}

async function createServiceConfig(
	options: {
		readonly includeControllerHostAction?: boolean;
		readonly includeMcpProvider?: boolean;
		readonly includeProcessLogs?: boolean;
		readonly verifierPublicKeyPem?: string;
	} = {},
): Promise<GatewayRuntimeServiceConfig> {
	const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'gr-'));
	temporaryRoots.push(temporaryRoot);
	const runtimeRoot = temporaryRoot;
	const mcpConfig = mcpConfigSchema.parse({ providers: {}, schemaVersion: 1 });
	const toolPortalConfig = managedToolPortalConfigSchema.parse({
		agents: {
			'agent-a': { profile: 'profile-a' },
			'agent-b': { profile: 'profile-b' },
		},
		mode: 'managed',
		profiles: {
			'profile-a': {
				namespaces: {
					...(options.includeControllerHostAction === true
						? {
								controller: {
									backend: { kind: 'controller_host_action' as const },
									calls: {
										requiresApproval: { allow: [], deny: [] },
										withoutApproval: { allow: ['workspace_git_push'], deny: [] },
									},
									tools: { allow: ['workspace_git_push'], deny: [] },
								},
							}
						: {}),
					...(options.includeMcpProvider === true
						? {
								github: {
									backend: { kind: 'mcp_provider' as const },
									calls: {
										requiresApproval: { allow: [], deny: [] },
										withoutApproval: { allow: ['get_issue'], deny: [] },
									},
									tools: { allow: ['get_issue'], deny: [] },
								},
							}
						: {}),
					sandbox: {
						backend: {
							kind: 'tool_vm_runner',
							operations: {
								exec: {
									description: 'Run the fixture command.',
									executable: '/usr/bin/true',
									kind: 'command.fixed',
									mandatoryArgvPrefix: [],
									workingDirectory: '.',
								},
								...(options.includeProcessLogs === true
									? {
											logs: {
												description: 'Read process logs.',
												kind: 'process.logs' as const,
											},
										}
									: {}),
							},
							profile: 'sandbox_ssh',
						},
						calls: {
							requiresApproval: { allow: [], deny: [] },
							withoutApproval: { allow: ['exec'], deny: [] },
						},
						tools: { allow: ['exec'], deny: [] },
					},
				},
			},
			'profile-b': { namespaces: {} },
		},
		schemaVersion: 1,
	});
	const semanticSnapshot = deriveGatewayRuntimePortalSemanticSnapshot({
		agentProjections: [
			{
				agentId: 'agent-a',
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-a-profile' },
				toolPortalNamespaceNames: [
					...(options.includeControllerHostAction === true ? ['controller'] : []),
					...(options.includeMcpProvider === true ? ['github'] : []),
					'sandbox',
				],
				toolPortalProfileId: 'profile-a',
			},
			{
				agentId: 'agent-b',
				frameworkIdentity: { kind: 'hermes', profileName: 'agent-b-profile' },
				toolPortalNamespaceNames: [],
				toolPortalProfileId: 'profile-b',
			},
		],
		mcpConfig,
		surfaceEligibilityByProfile: {
			'profile-a': {
				...(options.includeControllerHostAction === true
					? { controller: ['protected_uds'] as const }
					: {}),
				...(options.includeMcpProvider === true ? { github: ['protected_uds'] as const } : {}),
				sandbox: ['protected_uds'],
			},
			'profile-b': {},
		},
		toolPortalConfig,
	});
	await writeFile(path.join(temporaryRoot, 'placeholder'), 'preserve');
	await writeFile(path.join(temporaryRoot, 'mcp.config.json'), JSON.stringify(mcpConfig), {
		mode: 0o600,
	});
	const defaultVerifierPublicKey = generateKeyPairSync('ed25519').publicKey.export({
		format: 'pem',
		type: 'spki',
	});
	return {
		artifactLimits: {
			maximumArtifactBytes: 1_024,
			maximumArtifactCount: 8,
			maximumLifetimeMs: 60_000,
			maximumTotalBytes: 8_192,
		},
		attachment: {
			attachmentGeneration: 1,
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: ['agent-a', 'agent-b'],
			frameworkEpoch: 'framework-epoch-1',
			gatewayEpoch: 'gateway-epoch-1',
			projectionCohortDigest: semanticSnapshot.projectionCohortDigest,
			runtimeEpoch: 'runtime-epoch-1',
		},
		controlEndpoint: {
			authority: {
				callerContextAgentAuthorityKeys: {
					'agent-a': 'agent-a-authority-key',
					'agent-b': 'agent-b-authority-key',
				},
				callerContextProofKey: 'caller-context-proof-key',
				verifierPublicKeyPem: options.verifierPublicKeyPem ?? defaultVerifierPublicKey,
			},
			identity: {
				bootId: 'boot-1',
				controllerEpoch: 'controller-epoch-1',
				generationId: 'generation-1',
				peerId: 'peer-1',
				processEpoch: 'process-epoch-1',
				zoneId: 'zone-a',
			},
			listen: { host: '127.0.0.1', port: 0 },
		},
		mcpConfigPath: path.join(temporaryRoot, 'mcp.config.json'),
		observability: { kind: 'disabled' },
		runtimeRoot,
		schemaVersion: 1,
		semanticSnapshot,
		serviceIdentity: {
			processEpoch: 'process-epoch-1',
			role: 'tool-portal',
			serviceId: 'tool-portal-zone-a',
		},
		toolPortalConfig,
	};
}

function attachmentForConfig(
	config: GatewayRuntimeServiceConfig,
): GatewayRuntimeAttachmentMetadata {
	return {
		...config.attachment,
		protocolVersion: 1,
		schemaVersion: 1,
	};
}

function enableToolPortalObservability(config: GatewayRuntimeServiceConfig): void {
	config.observability = {
		admissionLimits: {
			maxExportBatchRecords: 64,
			maxQueuedRecordsPerSignal: 256,
			maxRecordBytes: 65_536,
		},
		endpoint: 'http://otel-collector.observability.vm.host:4318',
		flushIntervalMs: 1_000,
		kind: 'otlp-http',
		logs: true,
		metrics: true,
		sampleRate: 1,
		serviceName: 'agent-vm-tool-portal',
		sourcePolicy: { admitBaggage: false, captureContent: false },
		traces: true,
	};
}

function createTelemetryRuntimeProbe(
	options: {
		readonly shutdownFailure?: Error;
	} = {},
): {
	readonly backendPortKinds: ToolPortalBackendKind[];
	readonly runtime: GatewayRuntimeToolPortalTelemetryRuntime;
	readonly sandboxMethods: string[];
	readonly shutdown: ReturnType<typeof vi.fn>;
	readonly tracedMethods: string[];
} {
	const backendPortKinds: ToolPortalBackendKind[] = [];
	const sandboxMethods: string[] = [];
	const tracedMethods: string[] = [];
	const shutdown = vi.fn(async (): Promise<void> => {
		if (options.shutdownFailure !== undefined) throw options.shutdownFailure;
	});
	return {
		backendPortKinds,
		runtime: {
			getDiagnostics: () => ({
				admittedRecords: 0,
				derivedMaxAdmittedPayloadBytesPerSignal: 0,
				droppedOversizedRecords: 0,
				providerOperationFailures: 0,
				signals: {
					logs: {
						currentPayloadBytes: 0,
						currentRecords: 0,
						highWaterPayloadBytes: 0,
						highWaterRecords: 0,
						saturationDroppedRecords: 0,
					},
					metrics: {
						currentPayloadBytes: 0,
						currentRecords: 0,
						highWaterPayloadBytes: 0,
						highWaterRecords: 0,
						saturationDroppedRecords: 0,
					},
					traces: {
						currentPayloadBytes: 0,
						currentRecords: 0,
						highWaterPayloadBytes: 0,
						highWaterRecords: 0,
						saturationDroppedRecords: 0,
					},
				},
			}),
			shutdown,
			traceContextDispatch: async (traceOptions, dispatch) => {
				tracedMethods.push(traceOptions.method);
				return await dispatch();
			},
			wrapBackendPort: <TBackendKind extends ToolPortalBackendKind>(
				backendPort: ToolPortalBackendPort<TBackendKind>,
			): ToolPortalBackendPort<TBackendKind> => {
				backendPortKinds.push(backendPort.backendKind);
				return backendPort;
			},
			wrapSandboxDispatch: (dispatch) => async (request) => {
				sandboxMethods.push(request.method);
				return await dispatch(request);
			},
		},
		sandboxMethods,
		shutdown,
		tracedMethods,
	};
}

function trustedContext(
	config: GatewayRuntimeServiceConfig,
): GatewayRuntimeClientTrustedInvocationContext {
	const projection = config.semanticSnapshot.agentProjections['agent-a'];
	if (projection === undefined) throw new Error('Missing agent-a semantic projection.');
	return {
		correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
		principal: {
			agentId: 'agent-a',
			frameworkIdentity: projection.frameworkIdentity,
			profileAssignmentRevision: projection.profileAssignmentRevision,
			toolPortalProfileId: projection.toolPortalProfileId,
		},
		requester: { authenticatedSubjectId: 'subject-a' },
	};
}

function createProviderFactory(): ManagedMcpProviderBackendFactory {
	return {
		close: vi.fn(async () => undefined),
		createBackend: vi.fn(() => ({
			call: vi.fn(),
			describe: vi.fn(),
			list: vi.fn(async (request) => ({
				items: PortalListRequestSchema.parse(request).requests.map(({ id }) => ({
					id,
					status: 'ok' as const,
					value: { namespaces: ['github'], tools: [] },
				})),
				ok: true,
			})),
			search: vi.fn(),
		})),
		retireSession: vi.fn(async () => undefined),
	};
}

function controlApplicationMessageContext(
	operation: 'control_ping' | 'tool_vm_binding_publish',
): GatewayControlApplicationMessageContext {
	return {
		envelope: {
			bootId: 'boot-1',
			commandId: '11111111-1111-4111-8111-111111111111',
			connectionId: '22222222-2222-4222-8222-222222222222',
			controllerEpoch: 'controller-epoch-1',
			createdAtMs: 100,
			deliveryPolicy: 'critical_idempotent',
			domain: 'gateway_control',
			expiresAtMs: 10_100,
			idempotencyKey: `production-startup:${operation}`,
			kind: 'command',
			messageId: '33333333-3333-4333-8333-333333333333',
			operation,
			peerId: 'peer-1',
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			sequence: 1,
			sessionId: '44444444-4444-4444-8444-444444444444',
			zoneId: 'zone-a',
		},
		payload: { kind: 'command', operation, payload: {} },
	};
}

afterEach(async (): Promise<void> => {
	for (const client of runningControlClients.splice(0)) client.close();
	await Promise.allSettled(
		runningServices.splice(0).map(async (service) => await service.retire()),
	);
	await Promise.all(
		temporaryRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
	);
});

function controlReadyHeaders(props: {
	readonly config: GatewayRuntimeServiceConfig;
	readonly privateKey: KeyObject;
}): Readonly<Record<string, string>> {
	const issuedAtMs = Date.now();
	const credential = {
		audience: 'gateway_control',
		bootId: props.config.controlEndpoint.identity.bootId,
		controllerEpoch: props.config.controlEndpoint.identity.controllerEpoch,
		generationId: props.config.controlEndpoint.identity.generationId,
		issuedAtMs,
		peerId: props.config.controlEndpoint.identity.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		requestId: randomUUID(),
		zoneId: props.config.controlEndpoint.identity.zoneId,
	} satisfies ControlReadyRequestCredential;
	const signature = signPayload(
		null,
		Buffer.from(buildControlReadyRequestSignaturePayload(credential)),
		props.privateKey,
	).toString('base64url');
	return {
		[CONTROL_READY_HEADER_NAMES.bootId]: credential.bootId,
		[CONTROL_READY_HEADER_NAMES.controllerEpoch]: credential.controllerEpoch,
		[CONTROL_READY_HEADER_NAMES.domain]: credential.audience,
		[CONTROL_READY_HEADER_NAMES.generationId]: credential.generationId,
		[CONTROL_READY_HEADER_NAMES.issuedAtMs]: String(credential.issuedAtMs),
		[CONTROL_READY_HEADER_NAMES.peerId]: credential.peerId,
		[CONTROL_READY_HEADER_NAMES.protocol]: CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
		[CONTROL_READY_HEADER_NAMES.requestId]: credential.requestId,
		[CONTROL_READY_HEADER_NAMES.signature]: signature,
		[CONTROL_READY_HEADER_NAMES.zoneId]: credential.zoneId,
	};
}

function controlHandshakeHeaders(props: {
	readonly credential: GatewayControlIssuedCredential;
	readonly privateKey: KeyObject;
}): Readonly<Record<string, string>> {
	const credential = {
		audience: props.credential.audience,
		bootId: props.credential.bootId,
		controllerEpoch: props.credential.controllerEpoch,
		credentialId: props.credential.credentialId,
		expiresAtMs: props.credential.expiresAtMs,
		generationId: props.credential.generationId,
		issuedAtMs: props.credential.issuedAtMs,
		nonce: props.credential.nonce,
		peerId: props.credential.peerId,
		protocolVersion: props.credential.protocolVersion,
		zoneId: props.credential.zoneId,
	} satisfies ControlHandshakeCredential;
	const signature = signPayload(
		null,
		Buffer.from(buildControlHandshakeSignaturePayload(credential)),
		props.privateKey,
	).toString('base64url');
	return {
		[CONTROL_HANDSHAKE_HEADER_NAMES.bootId]: credential.bootId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.controllerEpoch]: credential.controllerEpoch,
		[CONTROL_HANDSHAKE_HEADER_NAMES.credentialId]: credential.credentialId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.domain]: credential.audience,
		[CONTROL_HANDSHAKE_HEADER_NAMES.expiresAtMs]: String(credential.expiresAtMs),
		[CONTROL_HANDSHAKE_HEADER_NAMES.generationId]: credential.generationId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.issuedAtMs]: String(credential.issuedAtMs),
		[CONTROL_HANDSHAKE_HEADER_NAMES.nonce]: credential.nonce,
		[CONTROL_HANDSHAKE_HEADER_NAMES.peerId]: credential.peerId,
		[CONTROL_HANDSHAKE_HEADER_NAMES.protocol]: CONTROL_HANDSHAKE_PROTOCOL_HEADER_VALUE,
		[CONTROL_HANDSHAKE_HEADER_NAMES.signature]: signature,
		[CONTROL_HANDSHAKE_HEADER_NAMES.zoneId]: credential.zoneId,
	};
}

async function waitForControlClientConnect(client: Socket): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		client.once('connect', resolve);
		client.once('connect_error', reject);
	});
}

async function connectAcceptedControlClient(props: {
	readonly attachmentGeneration: number;
	readonly config: GatewayRuntimeServiceConfig;
	readonly controlBaseUrl: string;
	readonly privateKey: KeyObject;
}): Promise<{
	readonly client: Socket;
	readonly collector: ReturnType<typeof createControlHeartbeatCollector>;
	readonly helloResponse: ReturnType<typeof GatewayControlHelloResponseSchema.parse>;
}> {
	const readyResponse = await fetch(`${props.controlBaseUrl}${GATEWAY_CONTROL_READY_PATH}`, {
		headers: controlReadyHeaders({ config: props.config, privateKey: props.privateKey }),
	});
	if (!readyResponse.ok) {
		throw new Error(
			`Control readiness credential request failed: ${String(readyResponse.status)}.`,
		);
	}
	const credential = (await readyResponse.json()) as GatewayControlIssuedCredential;
	const client = createSocketIoClient(props.controlBaseUrl, {
		addTrailingSlash: false,
		extraHeaders: controlHandshakeHeaders({ credential, privateKey: props.privateKey }),
		forceNew: true,
		path: GATEWAY_CONTROL_SOCKET_PATH,
		reconnection: false,
		transports: ['websocket'],
	});
	runningControlClients.push(client);
	const collector = createControlHeartbeatCollector(client);
	await waitForControlClientConnect(client);
	const hello = {
		attachmentGeneration: props.attachmentGeneration,
		controllerEpoch: props.config.controlEndpoint.identity.controllerEpoch,
		domain: 'gateway_control',
		gatewayEpoch: props.config.controlEndpoint.identity.generationId,
		peerId: props.config.controlEndpoint.identity.peerId,
		processEpoch: props.config.controlEndpoint.identity.processEpoch,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
	} satisfies GatewayControlHello;
	const helloResponse = GatewayControlHelloResponseSchema.parse(
		await client.timeout(1_000).emitWithAck('control:hello', hello),
	);
	if (helloResponse.outcome !== 'accepted') {
		throw new Error(`Control hello was not accepted: ${helloResponse.outcome}.`);
	}
	return { client, collector, helloResponse };
}

function createReadinessControlEventCollector(client: Socket): {
	readonly getReceivedCount: () => number;
	readonly waitForStatus: (
		status: GatewayRuntimeReadinessSnapshot['uds']['attachment']['status'],
	) => Promise<GatewayRuntimeReadinessSnapshot>;
} {
	let receivedCount = 0;
	const receivedSnapshots: GatewayRuntimeReadinessSnapshot[] = [];
	const waiters = new Map<
		GatewayRuntimeReadinessSnapshot['uds']['attachment']['status'],
		(snapshot: GatewayRuntimeReadinessSnapshot) => void
	>();
	client.on('control:message', (_envelope, payload, acknowledge) => {
		acknowledge({ received: true });
		const message = GatewayControlRpcMessageSchema.parse(payload);
		if (message.kind !== 'event' || message.operation !== 'gateway_runtime_readiness') return;
		receivedCount += 1;
		const status = message.payload.uds.attachment.status;
		const waiter = waiters.get(status);
		if (waiter === undefined) receivedSnapshots.push(message.payload);
		else {
			waiters.delete(status);
			waiter(message.payload);
		}
	});
	return {
		getReceivedCount: () => receivedCount,
		waitForStatus: async (status) => {
			const receivedIndex = receivedSnapshots.findIndex(
				(snapshot) => snapshot.uds.attachment.status === status,
			);
			if (receivedIndex >= 0) {
				const receivedSnapshot = receivedSnapshots.splice(receivedIndex, 1)[0];
				if (receivedSnapshot === undefined) {
					throw new Error(`Readiness control status '${status}' disappeared before delivery.`);
				}
				return receivedSnapshot;
			}
			const timeoutSignal = AbortSignal.timeout(READINESS_EVIDENCE_WAIT_MILLISECONDS);
			return await new Promise<GatewayRuntimeReadinessSnapshot>((resolve, reject) => {
				const rejectTimedOutWait = (): void => {
					waiters.delete(status);
					reject(new Error(`Timed out waiting for readiness control status '${status}'.`));
				};
				timeoutSignal.addEventListener('abort', rejectTimedOutWait, { once: true });
				waiters.set(status, (snapshot) => {
					timeoutSignal.removeEventListener('abort', rejectTimedOutWait);
					resolve(snapshot);
				});
			});
		},
	};
}

describe('Gateway runtime production service', () => {
	it('starts its built-in controller host action backend and retires production resources', async () => {
		// Arrange
		const config = await createServiceConfig({ includeControllerHostAction: true });

		// Act
		const service = await startGatewayRuntimeProductionService({ config, dependencies: {} });
		runningServices.push(service);

		// Assert
		expect(service.readiness).toMatchObject({
			requiredBackends: {
				readyBackendKinds: ['controller_host_action', 'tool_vm_runner'],
				status: 'ready',
			},
			uds: { publication: { status: 'published' } },
		});
		await expect(lstat(service.udsServer.readiness.socketPath)).resolves.toBeDefined();

		await expect(service.retire({ drainTimeoutMs: 100 })).resolves.toMatchObject({
			artifactEpochRetired: true,
			controlEndpointClosed: true,
			kind: 'retired',
			providerRuntimeClosed: true,
			uds: { socketRemoved: true },
		});
		await expect(lstat(service.udsServer.readiness.socketPath)).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});

	it('uses the production control runtime Sandbox dispatcher when no test override is supplied', async () => {
		// Arrange
		const config = await createServiceConfig();
		const sandboxDispatch = vi.fn(async () => ({
			environment: {
				handleId: 'environment-a',
				kind: 'environment' as const,
				owningGeneration: 'environment-generation-a',
			},
			kind: 'opened' as const,
			logicalCwd: 'workspace',
		}));
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: {
				createControlRuntime: async (runtimeProps) => ({
					...(await createGatewayRuntimeProductionControlRuntime(runtimeProps)),
					sandboxDispatch,
				}),
			},
		});
		runningServices.push(service);
		const client = new GatewayRuntimeClient({
			attachment: attachmentForConfig(config),
			socketPath: service.udsServer.readiness.socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});

		try {
			// Act
			await client.connect();
			const result = await client.sandbox.environment.open(
				{ logicalCwd: 'workspace' },
				{ trustedContext: trustedContext(config) },
			);

			// Assert
			expect(result).toMatchObject({ kind: 'opened', logicalCwd: 'workspace' });
			expect(sandboxDispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					method: 'sandbox.environment.open',
					publicRequest: { logicalCwd: 'workspace' },
				}),
			);
		} finally {
			await client.disconnect();
		}
	});

	it('routes real UDS portal and Sandbox requests through one telemetry runtime', async () => {
		// Arrange
		const config = await createServiceConfig({ includeMcpProvider: true });
		enableToolPortalObservability(config);
		const providerFactory = createProviderFactory();
		const telemetryProbe = createTelemetryRuntimeProbe({
			shutdownFailure: new Error('telemetry shutdown must remain non-authoritative'),
		});
		const sandboxDispatch = vi.fn(async () => ({
			environment: {
				handleId: 'environment-a',
				kind: 'environment' as const,
				owningGeneration: 'environment-generation-a',
			},
			kind: 'opened' as const,
			logicalCwd: 'workspace',
		}));
		const createToolPortalTelemetryRuntime = vi.fn(() => telemetryProbe.runtime);
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: {
				createMcpProviderFactory: async () => providerFactory,
				createToolPortalTelemetryRuntime,
				sandboxDispatch,
			},
		});
		runningServices.push(service);
		const client = new GatewayRuntimeClient({
			attachment: attachmentForConfig(config),
			socketPath: service.udsServer.readiness.socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
			traceContextProvider: () => ({
				traceparent: `00-${'55'.repeat(16)}-${'66'.repeat(8)}-01`,
			}),
		});

		try {
			// Act
			await client.connect();
			await client.portal.list(
				{ requests: [{ id: 'list-1', limit: 20, namespaces: ['github'] }] },
				{ trustedContext: trustedContext(config) },
			);
			await client.sandbox.environment.open(
				{ logicalCwd: 'workspace' },
				{ trustedContext: trustedContext(config) },
			);
			const retirement = await service.retire({ drainTimeoutMs: 100 });

			// Assert
			expect(createToolPortalTelemetryRuntime).toHaveBeenCalledWith({
				config: config.observability,
				identity: {
					frameworkKind: 'hermes',
					gatewayEpoch: config.attachment.gatewayEpoch,
					zoneId: config.controlEndpoint.identity.zoneId,
				},
			});
			expect(telemetryProbe.backendPortKinds.toSorted()).toEqual([
				'controller_host_action',
				'mcp_provider',
				'tool_vm_runner',
			]);
			expect(telemetryProbe.tracedMethods).toEqual(['portal.list', 'sandbox.environment.open']);
			expect(telemetryProbe.sandboxMethods).toEqual(['sandbox.environment.open']);
			expect(sandboxDispatch).toHaveBeenCalledOnce();
			expect(telemetryProbe.shutdown).toHaveBeenCalledOnce();
			expect(retirement.kind).toBe('retired');
		} finally {
			await client.disconnect();
		}
	});

	it('starts control before its runtime and composes the portal before UDS readiness', async () => {
		const config = await createServiceConfig();
		const startupEvents: string[] = [];
		let approvalPortFromControlRuntime: unknown;
		let startupPublicationResult: Promise<unknown> | undefined;
		const applicationMessageHandler = {
			handle: vi.fn(async (context) => ({
				kind: 'command_result',
				operation: 'tool_vm_binding_publish',
				payload: {
					responseToMessageId: context.envelope.messageId,
					result: 'ok',
				},
			})),
			messageIdentity: ({ envelope }) => ({
				kind: envelope.kind,
				...(envelope.operation === undefined ? {} : { operation: envelope.operation }),
			}),
		} satisfies GatewayControlApplicationMessageHandler;
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: {
				createControlRuntime: async (runtimeProps) => {
					expect(runtimeProps.controlEndpoint.readiness.port).toBeGreaterThan(0);
					expect(runtimeProps.owningGeneration).toBe(config.attachment.runtimeEpoch);
					expect(runtimeProps.zoneId).toBe(config.controlEndpoint.identity.zoneId);
					startupEvents.push('control-runtime');
					const runtime = await createGatewayRuntimeProductionControlRuntime(runtimeProps);
					approvalPortFromControlRuntime = runtime.approvalPort;
					return { ...runtime, applicationMessageHandler };
				},
				createManagedComposition: async (compositionProps) => {
					expect(compositionProps.approvalPort).toBe(approvalPortFromControlRuntime);
					startupEvents.push('managed-composition');
					return await createGatewayRuntimeManagedToolPortalComposition(compositionProps);
				},
				createMcpProviderFactory: async () => {
					startupEvents.push('provider');
					return createProviderFactory();
				},
				sandboxDispatch: rejectUnavailableGatewayRuntimeSandboxDispatch,
				startControlEndpoint: async (endpointOptions) => {
					const endpoint = await startGatewayControlEndpoint(endpointOptions);
					startupEvents.push('control-listening');
					const deferredHandler = endpointOptions.applicationMessageHandler;
					if (deferredHandler === undefined) {
						throw new Error('Production startup did not install a deferred control handler.');
					}
					startupPublicationResult = deferredHandler.handle(
						controlApplicationMessageContext('tool_vm_binding_publish'),
					);
					return endpoint;
				},
				startUdsServer: async (udsOptions) => {
					startupEvents.push('private-uds');
					return await startGatewayRuntimeUdsServer(udsOptions);
				},
			},
		});
		runningServices.push(service);
		startupEvents.push('readiness-returned');

		expect(startupEvents).toEqual([
			'provider',
			'control-listening',
			'control-runtime',
			'managed-composition',
			'private-uds',
			'readiness-returned',
		]);
		if (startupPublicationResult === undefined) {
			throw new Error('Startup publication did not reach the deferred control handler.');
		}
		await expect(startupPublicationResult).resolves.toMatchObject({
			operation: 'tool_vm_binding_publish',
			payload: { result: 'ok' },
		});
		expect(applicationMessageHandler.handle).toHaveBeenCalledOnce();
	});

	it('fails pending control application work and closes the endpoint when control composition fails', async () => {
		// Arrange
		const config = await createServiceConfig();
		const startupFailure = new Error('injected control runtime startup failure');
		let pendingApplicationResult: Promise<unknown> | undefined;
		const closeControlEndpoint = vi.fn();

		// Act
		const startupResult = startGatewayRuntimeProductionService({
			config,
			dependencies: {
				createControlRuntime: async () => {
					throw startupFailure;
				},
				createMcpProviderFactory: async () => createProviderFactory(),
				sandboxDispatch: rejectUnavailableGatewayRuntimeSandboxDispatch,
				startControlEndpoint: async (endpointOptions) => {
					const endpoint = await startGatewayControlEndpoint(endpointOptions);
					const deferredHandler = endpointOptions.applicationMessageHandler;
					if (deferredHandler === undefined) {
						throw new Error('Production startup did not install a deferred control handler.');
					}
					pendingApplicationResult = deferredHandler.handle(
						controlApplicationMessageContext('control_ping'),
					);
					void pendingApplicationResult.catch(() => undefined);
					return {
						...endpoint,
						close: async (options): Promise<void> => {
							closeControlEndpoint();
							await endpoint.close(options);
						},
					};
				},
			},
		});

		// Assert
		await expect(startupResult).rejects.toBe(startupFailure);
		if (pendingApplicationResult === undefined) {
			throw new Error('Startup failure did not settle pending control application work.');
		}
		await expect(pendingApplicationResult).rejects.toBe(startupFailure);
		expect(closeControlEndpoint).toHaveBeenCalledOnce();
	});

	it('constructs one shared service/provider cohort with UDS as its only caller surface', async () => {
		// Arrange
		const config = await createServiceConfig({ includeMcpProvider: true });
		const providerFactory = createProviderFactory();
		const createMcpProviderFactory = vi.fn(
			async (_factoryInput: {
				readonly mcpConfig: unknown;
				readonly resolveSecret: (secret: FormattedSecretValue) => Promise<string>;
			}) => providerFactory,
		);
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: {
				createMcpProviderFactory,
				sandboxDispatch: rejectUnavailableGatewayRuntimeSandboxDispatch,
			},
		});
		runningServices.push(service);
		expect(service.readiness).toMatchObject({
			kind: 'tool-portal-role-readiness',
			requiredBackends: {
				readyBackendKinds: ['mcp_provider', 'tool_vm_runner'],
				revision: config.semanticSnapshot.bindingRevision,
				status: 'ready',
			},
			uds: {
				attachment: { status: 'awaiting-attachment' },
				publication: {
					socketPath: service.udsServer.readiness.socketPath,
					status: 'published',
				},
			},
		});
		const client = new GatewayRuntimeClient({
			attachment: attachmentForConfig(config),
			socketPath: service.udsServer.readiness.socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});

		try {
			// Act
			const attachedEvidencePromise = waitForReadinessEvidenceStatus({
				evidencePath: service.evidencePaths.readiness,
				status: 'attached',
			});
			await client.connect();
			const attachedEvidence = await attachedEvidencePromise;
			const attachedReadiness = service.readiness;
			expect(service.readiness.uds.attachment).toMatchObject({
				status: 'attached',
			});
			const listResult = await client.portal.list(
				{ requests: [{ id: 'list-1', limit: 20, namespaces: ['github'] }] },
				{ trustedContext: trustedContext(config) },
			);
			const callResult = await client.portal.call(
				{
					calls: [{ arguments: {}, id: 'call-1', name: 'exec', namespace: 'sandbox' }],
				},
				{ trustedContext: trustedContext(config) },
			);
			const socketStatus = await lstat(service.udsServer.readiness.socketPath);
			const lostEvidencePromise = waitForReadinessEvidenceStatus({
				evidencePath: service.evidencePaths.readiness,
				status: 'attachment-lost',
			});
			await client.disconnect();
			const lostEvidence = await lostEvidencePromise;
			const retiredEvidencePromise = waitForReadinessEvidenceStatus({
				evidencePath: service.evidencePaths.readiness,
				status: 'retired',
			});
			const retirement = await service.retire({ drainTimeoutMs: 100 });
			const retiredEvidence = await retiredEvidencePromise;
			const retirementEvidence = JSON.parse(
				await readFile(service.evidencePaths.retirement, 'utf8'),
			) as unknown;

			// Assert
			expect(service.composition.service.capabilityCore).toBe(
				service.composition.privateUdsProjection.capabilityCore,
			);
			expect(service.composition.semanticSnapshot).toBe(
				service.composition.service.capabilityCore.semanticSnapshot,
			);
			expect(service.composition.privateUdsProjection.semanticSnapshot).toBe(
				service.composition.semanticSnapshot,
			);
			expect(service.providerFactory).toBe(providerFactory);
			expect(createMcpProviderFactory).toHaveBeenCalledWith({
				mcpConfig: { providers: {}, schemaVersion: 1 },
				resolveSecret: expect.any(Function),
			});
			expect(createMcpProviderFactory.mock.calls[0]?.[0]).not.toHaveProperty('mcpConfigPath');
			expect(providerFactory.createBackend).toHaveBeenCalledWith(
				expect.objectContaining({ agentId: 'agent-a', profile: 'profile-a' }),
				{
					portalAgentScopeSource: 'tool-portal-service',
					sessionKey: expect.stringMatching(/^tool-portal:managed:mcp:[A-Za-z0-9_-]{43}$/u),
				},
			);
			expect(service).not.toHaveProperty('managedMcpHttpServer');
			expect(listResult).toMatchObject({ ok: true });
			expect(callResult).toMatchObject({
				items: [{ outcome: { kind: 'not-dispatched' }, status: 'error' }],
				ok: false,
			});
			expect(attachedEvidence).toEqual(attachedReadiness);
			expect(lostEvidence.uds.attachment).toMatchObject({ status: 'attachment-lost' });
			expect(retiredEvidence).toEqual(service.readiness);
			expect(service.readiness.controlEndpoint).toMatchObject({
				identity: config.controlEndpoint.identity,
				listener: {
					host: '127.0.0.1',
					readyPath: '/__agent-vm/ready',
					socketPath: '/__agent-vm/gateway-control',
				},
			});
			expect(service.readiness.controlEndpoint.listener.port).toBeGreaterThan(0);
			expect(service.readiness).toMatchObject({
				kind: 'tool-portal-role-readiness',
				snapshotVersion: 1,
				uds: {
					attachment: { status: 'retired' },
					publication: { status: 'retired' },
				},
			});
			expect((await stat(config.runtimeRoot)).mode & 0o777).toBe(0o700);
			expect(socketStatus.mode & 0o777).toBe(0o600);
			expect(retirement).toMatchObject({
				artifactEpochRetired: true,
				controlEndpointClosed: true,
				providerRuntimeClosed: true,
				uds: { socketRemoved: true },
			});
			expect(retirementEvidence).toEqual(retirement);
			expect(providerFactory.close).toHaveBeenCalledTimes(1);
			await expect(stat(config.mcpConfigPath)).resolves.toMatchObject({ size: 34 });
		} finally {
			await client.disconnect();
		}
	});

	it('publishes awaiting, attached, and attachment-lost readiness over accepted control', async () => {
		// Arrange
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const config = await createServiceConfig({
			verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
		});
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: {
				createMcpProviderFactory: async () => createProviderFactory(),
				sandboxDispatch: rejectUnavailableGatewayRuntimeSandboxDispatch,
			},
		});
		runningServices.push(service);
		const controlBaseUrl = `http://${service.controlEndpoint.readiness.host}:${String(service.controlEndpoint.readiness.port)}`;
		const readyResponse = await fetch(`${controlBaseUrl}${GATEWAY_CONTROL_READY_PATH}`, {
			headers: controlReadyHeaders({ config, privateKey }),
		});
		expect(readyResponse.status).toBe(200);
		const credential = (await readyResponse.json()) as GatewayControlIssuedCredential;
		const controlClient = createSocketIoClient(controlBaseUrl, {
			addTrailingSlash: false,
			extraHeaders: controlHandshakeHeaders({ credential, privateKey }),
			forceNew: true,
			path: GATEWAY_CONTROL_SOCKET_PATH,
			reconnection: false,
			transports: ['websocket'],
		});
		runningControlClients.push(controlClient);
		const readinessEvents = createReadinessControlEventCollector(controlClient);
		await waitForControlClientConnect(controlClient);
		const awaitingReadinessPromise = readinessEvents.waitForStatus('awaiting-attachment');
		const hello = {
			attachmentGeneration: 1,
			controllerEpoch: config.controlEndpoint.identity.controllerEpoch,
			domain: 'gateway_control',
			gatewayEpoch: config.controlEndpoint.identity.generationId,
			peerId: config.controlEndpoint.identity.peerId,
			processEpoch: config.controlEndpoint.identity.processEpoch,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
		} satisfies GatewayControlHello;
		const helloResponse = GatewayControlHelloResponseSchema.parse(
			await controlClient.timeout(1_000).emitWithAck('control:hello', hello),
		);
		expect(helloResponse.outcome).toBe('accepted');
		const awaitingReadiness = await awaitingReadinessPromise;
		const frameworkClient = new GatewayRuntimeClient({
			attachment: attachmentForConfig(config),
			socketPath: service.udsServer.readiness.socketPath,
			startupRetryPolicy: { maxAttempts: 1 },
		});

		try {
			// Act
			const attachedReadinessPromise = readinessEvents.waitForStatus('attached');
			await frameworkClient.connect();
			const attachedReadiness = await attachedReadinessPromise;
			const lostReadinessPromise = readinessEvents.waitForStatus('attachment-lost');
			await frameworkClient.disconnect();
			const lostReadiness = await lostReadinessPromise;

			// Assert
			expect([
				awaitingReadiness.uds.attachment.status,
				attachedReadiness.uds.attachment.status,
				lostReadiness.uds.attachment.status,
			]).toEqual(['awaiting-attachment', 'attached', 'attachment-lost']);
			expect([
				awaitingReadiness.uds.attachment.observationSequence,
				attachedReadiness.uds.attachment.observationSequence,
				lostReadiness.uds.attachment.observationSequence,
			]).toEqual([0, 1, 2]);
			expect(lostReadiness).toEqual(service.readiness);
			expect(readinessEvents.getReceivedCount()).toBe(3);

			const originalControlDisconnected = new Promise<void>((resolve) => {
				controlClient.once('disconnect', () => resolve());
			});
			const replacementReadyResponse = await fetch(
				`${controlBaseUrl}${GATEWAY_CONTROL_READY_PATH}`,
				{
					headers: controlReadyHeaders({ config, privateKey }),
				},
			);
			expect(replacementReadyResponse.status).toBe(200);
			const replacementCredential =
				(await replacementReadyResponse.json()) as GatewayControlIssuedCredential;
			const replacementControlClient = createSocketIoClient(controlBaseUrl, {
				addTrailingSlash: false,
				extraHeaders: controlHandshakeHeaders({
					credential: replacementCredential,
					privateKey,
				}),
				forceNew: true,
				path: GATEWAY_CONTROL_SOCKET_PATH,
				reconnection: false,
				transports: ['websocket'],
			});
			runningControlClients.push(replacementControlClient);
			const replacementReadinessEvents =
				createReadinessControlEventCollector(replacementControlClient);
			await waitForControlClientConnect(replacementControlClient);
			const replacementLostReadinessPromise =
				replacementReadinessEvents.waitForStatus('attachment-lost');
			const replacementHelloResponse = GatewayControlHelloResponseSchema.parse(
				await replacementControlClient.timeout(1_000).emitWithAck('control:hello', {
					...hello,
					attachmentGeneration: 2,
				} satisfies GatewayControlHello),
			);
			expect(replacementHelloResponse.outcome).toBe('accepted');
			const replacementLostReadiness = await replacementLostReadinessPromise;
			await originalControlDisconnected;
			expect(readinessEvents.getReceivedCount()).toBe(3);
			expect(replacementReadinessEvents.getReceivedCount()).toBe(1);
			expect(replacementLostReadiness.uds.attachment).toMatchObject({
				observationSequence: 2,
				status: 'attachment-lost',
			});
			expect(replacementLostReadiness).toEqual(service.readiness);

			const controlDisconnected = new Promise<void>((resolve) => {
				replacementControlClient.once('disconnect', () => resolve());
			});
			replacementControlClient.close();
			await controlDisconnected;
			await expect(frameworkClient.connect()).rejects.toMatchObject({
				code: 'retired-attachment',
			});
			expect(service.readiness).toEqual(replacementLostReadiness);
			await expect(service.retire({ drainTimeoutMs: 100 })).resolves.toMatchObject({
				controlEndpointClosed: true,
				kind: 'retired',
			});
		} finally {
			await frameworkClient.disconnect();
		}
	});

	it('owns a serialized control heartbeat across accepted sessions and stops it on retirement', async () => {
		// Arrange
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const config = await createServiceConfig({
			verifierPublicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }),
		});
		const heartbeatInterval = createManualControlHeartbeatInterval();
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: {
				clearControlHeartbeatIntervalImpl: heartbeatInterval.clearIntervalImpl,
				createMcpProviderFactory: async () => createProviderFactory(),
				now: () => 10_000,
				sandboxDispatch: rejectUnavailableGatewayRuntimeSandboxDispatch,
				setControlHeartbeatIntervalImpl: heartbeatInterval.setIntervalImpl,
			},
		});
		runningServices.push(service);
		const controlBaseUrl = `http://${service.controlEndpoint.readiness.host}:${String(service.controlEndpoint.readiness.port)}`;

		// Act / Assert: the first accepted attachment receives a prompt, schema-valid heartbeat.
		const firstSession = await connectAcceptedControlClient({
			attachmentGeneration: 1,
			config,
			controlBaseUrl,
			privateKey,
		});
		const [firstHeartbeat] = await firstSession.collector.waitForCount(1);
		expect(firstHeartbeat).toMatchObject({
			envelope: {
				connectionId: firstSession.helloResponse.connectionId,
				deliveryPolicy: 'critical_idempotent',
				domain: 'gateway_control',
				kind: 'heartbeat',
				sessionId: firstSession.helloResponse.sessionId,
			},
			message: {
				kind: 'heartbeat',
				payload: { elapsedMs: 0, observedAtMs: 10_000 },
			},
		});
		expect(heartbeatInterval.active()).toHaveLength(1);
		expect(heartbeatInterval.active()[0]?.delayMs).toBe(
			CONTROL_SESSION_TIMING_MS.engineIoPingInterval,
		);
		expect(heartbeatInterval.unrefCount()).toBe(1);

		const firstSessionDisconnected = new Promise<void>((resolve) => {
			firstSession.client.once('disconnect', () => resolve());
		});
		firstSession.client.close();
		await firstSessionDisconnected;
		const secondSession = await connectAcceptedControlClient({
			attachmentGeneration: 2,
			config,
			controlBaseUrl,
			privateKey,
		});
		await secondSession.collector.waitForCount(1);

		// A slow acknowledgement coalesces cadence ticks instead of overlapping publications.
		secondSession.collector.holdNext();
		heartbeatInterval.fire();
		await secondSession.collector.waitForCount(2);
		heartbeatInterval.fire();
		heartbeatInterval.fire();
		expect(secondSession.collector.count()).toBe(2);
		secondSession.collector.releaseHeld({ received: true });
		await secondSession.collector.waitForCount(3);

		// A failed send retires only that attachment; a later accepted session resumes promptly.
		secondSession.collector.holdNext();
		heartbeatInterval.fire();
		await secondSession.collector.waitForCount(4);
		const secondSessionDisconnected = new Promise<void>((resolve) => {
			secondSession.client.once('disconnect', () => resolve());
		});
		secondSession.collector.releaseHeld({
			errorClass: 'integration_test_rejected_heartbeat',
			received: false,
		});
		await secondSessionDisconnected;
		const thirdSession = await connectAcceptedControlClient({
			attachmentGeneration: 3,
			config,
			controlBaseUrl,
			privateKey,
		});
		await thirdSession.collector.waitForCount(1);

		const heartbeatCountBeforeRetirement = thirdSession.collector.count();
		await expect(service.retire({ drainTimeoutMs: 100 })).resolves.toMatchObject({
			controlEndpointClosed: true,
			kind: 'retired',
		});
		heartbeatInterval.fire();
		expect(heartbeatInterval.active()).toHaveLength(0);
		expect(thirdSession.collector.count()).toBe(heartbeatCountBeforeRetirement);
	});

	it('publishes UDS readiness when configured process logs use the shared process transport', async () => {
		// Arrange
		const config = await createServiceConfig({ includeProcessLogs: true });
		const providerFactory = createProviderFactory();
		const startUdsServer = vi.fn(startGatewayRuntimeUdsServer);

		// Act
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: {
				createMcpProviderFactory: async () => providerFactory,
				sandboxDispatch: rejectUnavailableGatewayRuntimeSandboxDispatch,
				startUdsServer,
			},
		});
		runningServices.push(service);

		// Assert
		expect(startUdsServer).toHaveBeenCalledOnce();
		expect(service.readiness).toMatchObject({
			requiredBackends: {
				readyBackendKinds: ['tool_vm_runner'],
				status: 'ready',
			},
			uds: { publication: { status: 'published' } },
		});
		await expect(lstat(service.udsServer.readiness.socketPath)).resolves.toBeDefined();
		await expect(lstat(service.evidencePaths.readiness)).resolves.toBeDefined();
	});

	it.each([
		{
			label: 'Tool VM command authority changes without a matching revision cohort',
			mutate: async (config: GatewayRuntimeServiceConfig): Promise<void> => {
				const profile = config.toolPortalConfig.profiles['profile-a'];
				const namespace = profile?.namespaces.sandbox;
				const operation =
					namespace?.backend.kind === 'tool_vm_runner'
						? namespace.backend.operations.exec
						: undefined;
				if (operation?.kind !== 'command.fixed') {
					throw new Error('Missing configured command fixture.');
				}
				operation.executable = '/usr/bin/false';
			},
		},
		{
			label: 'MCP provider material changes without a matching revision cohort',
			mutate: async (config: GatewayRuntimeServiceConfig): Promise<void> => {
				await writeFile(
					config.mcpConfigPath,
					JSON.stringify({
						providers: {
							changed: {
								kind: 'mcp',
								namespace: 'changed',
								transport: {
									kind: 'streamable-http',
									requiredEgressHosts: ['changed.example.com'],
									url: 'https://changed.example.com/mcp',
								},
							},
						},
						schemaVersion: 1,
					}),
					{ mode: 0o600 },
				);
			},
		},
	])('rejects $label before provider or service construction', async ({ mutate }) => {
		// Arrange
		const config = await createServiceConfig();
		await mutate(config);
		const createMcpProviderFactory = vi.fn(async () => createProviderFactory());

		// Act / Assert
		await expect(
			startGatewayRuntimeProductionService({
				config,
				dependencies: {
					createMcpProviderFactory,
					sandboxDispatch: rejectUnavailableGatewayRuntimeSandboxDispatch,
				},
			}),
		).rejects.toThrow('semantic snapshot does not match');
		expect(createMcpProviderFactory).not.toHaveBeenCalled();
	});

	it('emits safe fatal evidence and closes partial resources when startup fails', async () => {
		// Arrange
		const config = await createServiceConfig();
		const providerFactory = createProviderFactory();
		await mkdir(path.join(config.runtimeRoot, 'tool-portal.readiness.json'), { mode: 0o700 });

		// Act
		const startupError = await startGatewayRuntimeProductionService({
			config,
			dependencies: {
				createMcpProviderFactory: async () => providerFactory,
				sandboxDispatch: rejectUnavailableGatewayRuntimeSandboxDispatch,
			},
		}).then(
			() => undefined,
			(error: unknown) => error,
		);

		// Assert
		expect(startupError).toBeInstanceOf(AggregateError);
		if (!(startupError instanceof AggregateError)) {
			throw new Error('Expected startup and rollback failures to be aggregated.');
		}
		expect(startupError.message).toBe('Gateway runtime startup and ordered rollback failed.');
		expect(startupError.errors).toHaveLength(2);
		expect(startupError.errors[0]).toMatchObject({
			message: 'Gateway runtime readiness evidence could not be persisted.',
		});
		expect(startupError.errors[1]).toMatchObject({
			message: 'Gateway runtime production lifecycle retirement failed.',
		});
		const fatalEvidence = JSON.parse(
			await readFile(path.join(config.runtimeRoot, 'tool-portal.fatal.json'), 'utf8'),
		) as Record<string, unknown>;
		expect(fatalEvidence).toEqual({
			failureCode: 'startup-failed',
			kind: 'fatal',
			observedGatewayEpoch: 'gateway-epoch-1',
			role: 'tool-portal-service',
			processEpoch: 'process-epoch-1',
			schemaVersion: 1,
			serviceId: 'tool-portal-zone-a',
		});
		expect(fatalEvidence).not.toHaveProperty('message');
		expect(providerFactory.close).toHaveBeenCalledTimes(1);
	});

	it('keeps telemetry shutdown failure non-authoritative during startup rollback', async () => {
		// Arrange
		const config = await createServiceConfig();
		enableToolPortalObservability(config);
		const startupFailure = new Error('expected UDS startup failure');
		const telemetryProbe = createTelemetryRuntimeProbe({
			shutdownFailure: new Error('telemetry shutdown failure'),
		});

		// Act
		const startupResult = startGatewayRuntimeProductionService({
			config,
			dependencies: {
				createToolPortalTelemetryRuntime: () => telemetryProbe.runtime,
				sandboxDispatch: rejectUnavailableGatewayRuntimeSandboxDispatch,
				startUdsServer: async (): Promise<never> => {
					throw startupFailure;
				},
			},
		});

		// Assert
		await expect(startupResult).rejects.toBe(startupFailure);
		expect(telemetryProbe.shutdown).toHaveBeenCalledOnce();
	});

	it('attempts every retirement stage and records a safe terminal failure receipt', async () => {
		// Arrange
		const config = await createServiceConfig();
		const retirementEvents: string[] = [];
		const bindingRetire = vi.fn(async (): Promise<void> => undefined);
		const artifactRetire = vi.fn(async (): Promise<void> => undefined);
		const providerClose = vi.fn(async (): Promise<void> => {
			retirementEvents.push('provider');
		});
		const providerFactory = { ...createProviderFactory(), close: providerClose };
		const service = await startGatewayRuntimeProductionService({
			config,
			dependencies: {
				createControlRuntime: async (runtimeProps) => {
					const runtime = await createGatewayRuntimeProductionControlRuntime(runtimeProps);
					bindingRetire.mockImplementation(async (): Promise<void> => {
						retirementEvents.push('binding');
						await runtime.retire();
					});
					return { ...runtime, retire: bindingRetire };
				},
				createManagedComposition: async (compositionProps) => {
					const composition =
						await createGatewayRuntimeManagedToolPortalComposition(compositionProps);
					artifactRetire.mockImplementation(async (): Promise<void> => {
						retirementEvents.push('artifact');
						await composition.retireEpoch();
					});
					return { ...composition, retireEpoch: artifactRetire };
				},
				createMcpProviderFactory: async () => providerFactory,
				sandboxDispatch: rejectUnavailableGatewayRuntimeSandboxDispatch,
			},
		});
		const udsRetire = vi
			.spyOn(service.udsServer, 'retire')
			.mockImplementationOnce(async (): Promise<never> => {
				retirementEvents.push('uds');
				throw new Error('injected UDS close failure');
			});
		const originalControlClose = service.controlEndpoint.close;
		const controlClose = vi
			.spyOn(service.controlEndpoint, 'close')
			.mockImplementation(async (options): Promise<void> => {
				retirementEvents.push('control');
				await originalControlClose(options);
			});

		// Act
		const retirementAttempt = service.retire({ drainTimeoutMs: 100 });

		// Assert
		await expect(retirementAttempt).rejects.toThrow(
			'Gateway runtime production lifecycle retirement failed.',
		);
		expect(udsRetire).toHaveBeenCalledTimes(1);
		expect(controlClose).toHaveBeenCalledTimes(1);
		expect(providerClose).toHaveBeenCalledTimes(1);
		expect(artifactRetire).toHaveBeenCalledTimes(1);
		expect(retirementEvents).toEqual(['uds', 'binding', 'control', 'provider', 'artifact']);
		expect(JSON.parse(await readFile(service.evidencePaths.retirement, 'utf8'))).toMatchObject({
			failureCodes: ['uds-retirement-failed'],
			kind: 'retirement-failed',
			semanticRevision: config.semanticSnapshot.activeRevision,
			serviceIdentity: config.serviceIdentity,
		});
		await expect(service.retire({ drainTimeoutMs: 100 })).rejects.toBe(
			await retirementAttempt.catch((error: unknown) => error),
		);
	});
});
