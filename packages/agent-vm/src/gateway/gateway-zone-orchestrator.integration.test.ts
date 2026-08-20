import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { GatewayRuntimeTrustedInvocationPrincipal } from '@agent-vm/agent-portal-sdk/contracts';
import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import {
	buildGatewayControlCallerContextAgentAuthorityPayload,
	buildGatewayControlCallerContextProofPayload,
	createGatewayRuntimeReadinessSnapshot,
	GatewayControlRpcMessageSchema,
	GATEWAY_RUNTIME_PORTAL_ADMISSION_FILE_NAME,
	GatewayRuntimePortalAdmissionMaterialSchema,
	type GatewayRuntimeReadinessSnapshot,
	type GatewayControlCallerContextRegisterPayload,
	type GatewayControlCallerContextProof,
	type GatewayControlPrivateLeaseSnapshot,
	GatewayControlRpcCommandResultMessageSchema,
	type GatewayControlCallerContextProofPayloadInput,
	type ManagedAgentProjection,
} from '@agent-vm/gateway-control-contracts';
import type { GatewayZoneConfig } from '@agent-vm/gateway-lifecycle';
import { GatewayRuntimeServiceConfigSchema } from '@agent-vm/gateway-runtime';
import type {
	ManagedVm,
	ManagedVmCreateRequest,
	ManagedVmFactory,
	ManagedVmFinalizeMemoryMountRequest,
	ManagedVmImageBuildResult,
	ManagedVmImageCapability,
	ManagedVmOwnedDirectoryCapability,
	OwnedHostDirectory,
} from '@agent-vm/managed-vm';
import type { SecretRef, SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import type {
	GatewayControlBindingPublicationSource,
	GatewayControlLeaseRpcOperations,
	GatewayDisposableControlSessionClient,
} from '../controller/control-session/index.js';
import {
	createGatewayControlProcessAdmissionCoordinator,
	createGatewayControlSessionMaterial,
	resolveGatewayControlSessionMaterialPath,
} from '../controller/control-session/index.js';
import type { ControllerDiagnosticTelemetry } from '../controller/controller-diagnostic-logging.js';
import {
	createControllerStateRoot,
	type ControllerGatewayStateRoot,
	resolveControllerGatewayStateRoot,
} from '../controller/durable-state/controller-state-paths.js';
import {
	type ControllerManagedGatewayRuntimeRecordTarget,
	type ControllerWorkerTaskRuntimeRecordTarget,
	resolveControllerGatewayRecordTargets,
	resolveControllerWorkerTaskRuntimeRecordTarget,
} from '../controller/durable-state/controller-state-record-paths.js';
import { HealthEventStore } from '../controller/health/health-event-store.js';
import type { GatewayVmLifecycleAuthority } from '../controller/vm-ownership/gateway-vm-lifecycle-authority.js';
import type { GatewayEpochIdentity } from '../controller/vm-ownership/vm-ownership-contracts.js';
import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../testing/managed-vm-test-helpers.js';
import { selectToolVmMediatedSecretNamesForAgent } from '../tool-vm/tool-vm-secret-selection.js';
import { loadGatewayLifecycle } from './gateway-lifecycle-loader.js';
import {
	preflightGatewayZoneStart,
	startGatewayZone as startGatewayZonePublicProduction,
	startGatewayZoneForController as startGatewayZoneProduction,
	validateGatewayControlCallerContextRegistration,
	waitForGatewayServiceHealth,
	type GatewayManagerDependencies,
} from './gateway-zone-orchestrator.js';
import type {
	GatewayControlSessionConnector,
	DirectProcessGatewayZoneStartResult,
	GatewayZoneStartResult,
	ManagedGatewayZoneStartResult,
	PendingGatewayVmCreationContainment,
	StartGatewayZoneOptions,
} from './gateway-zone-support.js';
import { managedGatewayBootInputPaths } from './managed-gateway-boot-contract.js';
import type { GatewayRuntimeArtifactLimits } from './managed-gateway-runtime-input-builders.js';
import { loadWorkerRuntimeRecord } from './worker-runtime-record.js';

type GatewayManagedVmFactoryOptions = ManagedVmCreateRequest;

interface DeferredPromise<TResult> {
	readonly promise: Promise<TResult>;
	readonly resolve: (result: TResult) => void;
}

type ControllerStartGatewayZoneOptions = Parameters<typeof startGatewayZoneProduction>[0];
type TestStartGatewayZoneOptions = Omit<
	ControllerStartGatewayZoneOptions,
	'createVmOwnership' | 'runtimeRecordTarget'
> &
	Partial<Pick<ControllerStartGatewayZoneOptions, 'createVmOwnership'>>;
type TestStartGatewayZoneOptionsWithRuntimeRecordTarget = TestStartGatewayZoneOptions &
	Pick<ControllerStartGatewayZoneOptions, 'runtimeRecordTarget'>;

interface TestGatewayStartHarnessOptions {
	readonly dispatchRuntimeReadiness?: boolean;
	readonly onRuntimeReadinessDispatched?: (props: {
		readonly connectOptions: Parameters<GatewayControlSessionConnector>[0];
		readonly snapshot: GatewayRuntimeReadinessSnapshot;
	}) => void;
	readonly preserveMissingFinalizableMemoryMountCapability?: boolean;
	readonly runtimeReadinessSemanticRevision?: string;
}

interface TestVmOwnershipHarness {
	readonly createVmOwnership: Mock<StartGatewayZoneOptions['createVmOwnership']>;
	readonly abandonUnattachedGatewaySeedAfter: Mock<
		GatewayVmLifecycleAuthority['abandonUnattachedGatewaySeedAfter']
	>;
	readonly attachGatewayVm: Mock<GatewayVmLifecycleAuthority['attachGatewayVm']>;
	readonly containPendingCreate: Mock<GatewayVmLifecycleAuthority['containPendingCreate']>;
	readonly destroyLive: Mock<GatewayVmLifecycleAuthority['destroyLive']>;
	readonly vmOwnership: GatewayVmLifecycleAuthority;
}

const testGatewayBootId = 'gateway-boot-exact';
const testGatewayGenerationId = 'gateway-generation-exact';
const testWorkerTaskId = 'gateway-zone-orchestrator-integration-task';
const testManagedVmImages = {
	prepareImage: vi.fn(async () => ({
		built: false,
		fingerprint: 'test-gateway-image',
		imageReference: '/tmp/gateway-image',
	})),
} satisfies ManagedVmImageCapability;
const unexpectedManagedVmFactory = {
	createManagedVm: vi.fn(async (): Promise<ManagedVm> => {
		throw new Error('Managed VM creation was not expected in this test.');
	}),
} satisfies ManagedVmFactory;

let nextOwnedDirectoryInode = 10_000;
const testManagedVmOwnedDirectories = {
	openHostDirectory(hostPath: string): OwnedHostDirectory {
		let state: OwnedHostDirectory['state'] = 'acquired';
		const identity = {
			canonicalPath: path.resolve(hostPath),
			device: 1,
			inode: nextOwnedDirectoryInode,
		};
		nextOwnedDirectoryInode += 1;
		return {
			close(): void {
				state = 'closed';
			},
			consume() {
				if (state !== 'acquired') {
					throw new Error(`Test owned directory '${identity.canonicalPath}' was consumed twice.`);
				}
				state = 'adapter-owned';
				return {
					close(): void {
						state = 'closed';
					},
					identity,
					get state() {
						return state === 'closed' ? ('closed' as const) : ('adapter-owned' as const);
					},
				};
			},
			identity,
			get state() {
				return state;
			},
		};
	},
} satisfies ManagedVmOwnedDirectoryCapability;
const testGatewayRuntimeArtifactLimits = Object.freeze({
	maximumArtifactBytes: 1_024 * 1_024,
	maximumArtifactCount: 32,
	maximumLifetimeMs: 5 * 60 * 1_000,
	maximumTotalBytes: 8 * 1_024 * 1_024,
}) satisfies GatewayRuntimeArtifactLimits;
const expectedWorkerProcessSpec = Object.freeze({
	bootstrapCommand:
		'export PNPM_HOME=/pnpm PATH=/pnpm:$PATH && mkdir -p /workspace /work/repos /work/tmp /work/cache/npm /work/cache/pnpm/store /work/cache/pip /work/cache/uv && if [ -f /state/agent-vm-worker-packages/package.json ]; then cd /state/agent-vm-worker-packages && pnpm install --prod --ignore-scripts && worker_package_root="/state/agent-vm-worker-packages/node_modules"; elif [ -f /state/agent-vm-worker.tgz ]; then pnpm add -g --ignore-scripts /state/agent-vm-worker.tgz && worker_package_root="$(pnpm root -g --silent)"; fi && if [ -n "${worker_package_root:-}" ]; then worker_bin_target="$worker_package_root/@agent-vm/agent-vm-worker/dist/main.js" && test -f "$worker_bin_target" && chmod 755 "$worker_bin_target" && ln -sfn "$worker_bin_target" /pnpm/agent-vm-worker; fi',
	guestListenPort: 18_789,
	healthCheck: Object.freeze({ path: '/health', port: 18_789, type: 'http' as const }),
	logPath: '/tmp/agent-vm-worker.log',
	serviceHealthCheck: Object.freeze({ path: '/health', port: 18_789, type: 'http' as const }),
	startCommand:
		'export PNPM_HOME=/pnpm PATH=/pnpm:$PATH && { printf \'worker-boot: NODE_OPTIONS=%s\\n\' "$NODE_OPTIONS" > /tmp/agent-vm-worker.log; } && cd /work && nohup agent-vm-worker serve --port 18789 --config /state/effective-worker.json --state-dir /state >> /tmp/agent-vm-worker.log 2>&1 &',
});
const expectedManagedOpenClawReadinessCommand =
	'curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/readyz 2>/dev/null || true';

function createGatewayZoneToolPortalConfig(
	configDir: string,
): NonNullable<LoadedSystemConfig['zones'][number]['toolPortal']> {
	return {
		configDir,
		surfaceEligibilityByProfile: { default: {} },
	};
}

function createTestGatewayEpochIdentity(
	vmId: string,
	controllerEpoch = 'controller-epoch-test',
): GatewayEpochIdentity {
	return {
		bootId: testGatewayBootId,
		controllerEpoch,
		gatewayEpochId: `gateway-epoch-${vmId}`,
		gatewayVmId: vmId,
		generationId: testGatewayGenerationId,
		zoneId: 'shravan',
	};
}

const createExactTestGatewayControlSessionMaterial: GatewayManagerDependencies['createGatewayControlSessionMaterial'] =
	({ controllerEpoch, zoneId }) =>
		createGatewayControlSessionMaterial({
			agentIds: ['main'],
			bootId: testGatewayBootId,
			controllerEpoch,
			generationId: testGatewayGenerationId,
			zoneId,
		});

function createTestVmOwnershipHarness(
	vmId = 'gateway-vm-ownership-test',
	gatewayIdentity?: GatewayEpochIdentity,
): TestVmOwnershipHarness {
	const gatewaySeed = {
		bootId: gatewayIdentity?.bootId ?? testGatewayBootId,
		controllerEpoch: gatewayIdentity?.controllerEpoch ?? 'controller-epoch-test',
		gatewayEpochId: gatewayIdentity?.gatewayEpochId ?? `gateway-epoch-${vmId}`,
		generationId: gatewayIdentity?.generationId ?? testGatewayGenerationId,
		zoneId: gatewayIdentity?.zoneId ?? 'shravan',
	};
	let attachedGatewayIdentity = gatewayIdentity;
	const attachGatewayVm = vi.fn((attachedVmId: string): GatewayEpochIdentity => {
		attachedGatewayIdentity = { ...gatewaySeed, gatewayVmId: attachedVmId };
		return attachedGatewayIdentity;
	});
	const containPendingCreate = vi.fn(
		async (options: {
			readonly closeLateCreatedVm: (createdVm: ManagedVm) => Promise<void>;
			readonly pendingCreate: Promise<ManagedVm>;
		}): Promise<void> => {
			await options.closeLateCreatedVm(await options.pendingCreate);
		},
	);
	const destroyLive = vi.fn(async (destroyGatewayVm: () => Promise<void>): Promise<void> => {
		await destroyGatewayVm();
	});
	const abandonUnattachedGatewaySeedAfter = vi.fn(
		async (cleanupOwnedResources: () => Promise<void>): Promise<void> => {
			await cleanupOwnedResources();
		},
	);
	const vmOwnership: GatewayVmLifecycleAuthority = {
		abandonUnattachedGatewaySeedAfter,
		attachGatewayVm,
		containPendingCreate,
		destroyLive,
		get gatewayIdentity(): GatewayEpochIdentity | undefined {
			return attachedGatewayIdentity;
		},
		gatewaySeed,
	};
	return {
		createVmOwnership: vi.fn(async () => vmOwnership),
		abandonUnattachedGatewaySeedAfter,
		attachGatewayVm,
		containPendingCreate,
		destroyLive,
		vmOwnership,
	};
}

async function createDefaultTestVmOwnership(
	options: Parameters<StartGatewayZoneOptions['createVmOwnership']>[0],
	controllerEpoch: string,
	resolveCreatedVmId: () => string | undefined,
): Promise<GatewayVmLifecycleAuthority> {
	const reservedGatewayVmId = `test-gateway-vm-${options.zoneId}`;
	// The real adapter derives its VM id from the ownership reservation. Older
	// test factories choose an arbitrary fake id internally, so the shared test
	// fixture binds that id when the fake factory returns. Focused ownership
	// tests below use fixed identities and do not take this compatibility path.
	const gatewayIdentity: GatewayEpochIdentity | undefined =
		options.kind === 'gateway-epoch' && options.controlIdentity !== undefined
			? {
					bootId: options.controlIdentity.bootId,
					controllerEpoch,
					gatewayEpochId: `test-gateway-epoch-${options.zoneId}`,
					gatewayVmId: resolveCreatedVmId() ?? reservedGatewayVmId,
					generationId: options.controlIdentity.generationId,
					zoneId: options.zoneId,
				}
			: undefined;
	return createTestVmOwnershipHarness(
		options.kind === 'gateway-epoch' ? reservedGatewayVmId : 'test-standalone-vm',
		gatewayIdentity,
	).vmOwnership;
}

function withTestVmOwnership(
	options: TestStartGatewayZoneOptionsWithRuntimeRecordTarget,
	resolveCreatedVmId: () => string | undefined = () => undefined,
): ControllerStartGatewayZoneOptions {
	const controllerEpoch = options.controlSession?.controllerEpoch ?? 'controller-epoch-test';
	return {
		createVmOwnership: async (createOptions) =>
			await createDefaultTestVmOwnership(createOptions, controllerEpoch, resolveCreatedVmId),
		...options,
	};
}

const testControlConnectionId = '55555555-5555-4555-8555-555555555555';
const testControlSessionId = '33333333-3333-4333-8333-333333333333';
const managedGatewayBootInputCaptures = new WeakMap<
	ManagedVmCreateRequest,
	Map<string, ManagedVmFinalizeMemoryMountRequest>
>();

const connectTestGatewayControlSession: GatewayControlSessionConnector = async () => ({
	close: vi.fn(),
	closeForControllerShutdown: vi.fn(),
	emitApplicationMessage: vi.fn(async () => ({ ok: true })),
	ensureDialing: vi.fn(() => ({ status: 'accepted-current' as const })),
	fenceCurrentSession: vi.fn(() => ({ status: 'not-current' as const })),
	getDiagnostics: vi.fn(() => ({
		accepted: true,
		attachmentGeneration: 1,
		connected: true,
		endpointPath: '/__agent-vm/gateway-control',
		helloCount: 1,
		lastHelloResponse: {
			attachmentGeneration: 1,
			connectionId: testControlConnectionId,
			controllerEpoch: 'controller-epoch-test',
			outcome: 'accepted' as const,
			sessionId: testControlSessionId,
		},
		ready: true,
		reconnectAttempts: 0,
		reconnectExhausted: false,
		transportName: 'websocket',
	})),
	ready: Promise.resolve({
		attachmentGeneration: 1,
		connectionId: testControlConnectionId,
		controllerEpoch: 'controller-epoch-test',
		outcome: 'accepted',
		sessionId: testControlSessionId,
	}),
});

async function dispatchTestGatewayRuntimeReadiness(options: {
	readonly connectOptions: Parameters<GatewayControlSessionConnector>[0];
	readonly managedVmCreateRequest: ManagedVmCreateRequest;
	readonly semanticRevision?: string;
}): Promise<GatewayRuntimeReadinessSnapshot> {
	const serviceConfig = GatewayRuntimeServiceConfigSchema.parse(
		JSON.parse(
			requireManagedGatewayBootInputFile(
				options.managedVmCreateRequest,
				managedGatewayBootInputPaths.structuredRoot,
				'tool-portal-service.json',
			),
		),
	);
	const expectedAttachment = {
		...serviceConfig.attachment,
		protocolVersion: 1,
		schemaVersion: 1,
	};
	const readiness = createGatewayRuntimeReadinessSnapshot({
		controlEndpoint: {
			identity: serviceConfig.controlEndpoint.identity,
			listener: {
				...serviceConfig.controlEndpoint.listen,
				readyPath: '/__agent-vm/ready',
				socketPath: '/__agent-vm/gateway-control',
			},
		},
		kind: 'tool-portal-role-readiness',
		providerRevision: serviceConfig.semanticSnapshot.providerRevision,
		requiredBackends: {
			readyBackendKinds: [],
			revision: serviceConfig.semanticSnapshot.bindingRevision,
			status: 'ready',
		},
		semanticRevision: options.semanticRevision ?? serviceConfig.semanticSnapshot.activeRevision,
		serviceIdentity: serviceConfig.serviceIdentity,
		snapshotVersion: 1,
		uds: {
			attachment: {
				connectionId: testControlConnectionId,
				expected: expectedAttachment,
				observationSequence: 1,
				snapshotVersion: 1,
				status: 'attached',
			},
			publication: {
				identity: 'managed-plugin-private-uds',
				protocolVersion: 1,
				schemaVersion: 1,
				socketPath: '/run/agent-vm/gateway-runtime/managed-plugin.sock',
				status: 'published',
			},
		},
	});
	options.connectOptions.sessionFenceRegistry?.acceptSession({
		bootId: options.connectOptions.material.processEpoch,
		connectionId: testControlConnectionId,
		controllerEpoch: options.connectOptions.material.controllerEpoch,
		domain: 'gateway_control',
		peerId: options.connectOptions.material.peerId,
		sessionId: testControlSessionId,
		zoneId: options.connectOptions.material.zoneId,
	});
	const envelope = {
		bootId: options.connectOptions.material.processEpoch,
		connectionId: testControlConnectionId,
		controllerEpoch: options.connectOptions.material.controllerEpoch,
		createdAtMs: 1,
		deliveryPolicy: 'latest_wins',
		domain: 'gateway_control',
		kind: 'event',
		messageId: '22222222-2222-4222-8222-222222222222',
		operation: 'gateway_runtime_readiness',
		peerId: options.connectOptions.material.peerId,
		protocolVersion: CONTROL_PROTOCOL_VERSION,
		sequence: 1,
		sessionId: testControlSessionId,
		zoneId: options.connectOptions.material.zoneId,
	} satisfies ControlEnvelope;
	await options.connectOptions.dispatcher?.dispatch({
		attachmentGeneration: 1,
		envelope,
		payload: GatewayControlRpcMessageSchema.parse({
			kind: 'event',
			operation: 'gateway_runtime_readiness',
			payload: readiness,
		}),
	});
	return readiness;
}

async function dispatchTestGatewayRuntimeReadinessSnapshot(options: {
	readonly connectOptions: Parameters<GatewayControlSessionConnector>[0];
	readonly sequence: number;
	readonly snapshot: GatewayRuntimeReadinessSnapshot;
}): Promise<void> {
	await options.connectOptions.dispatcher?.dispatch({
		attachmentGeneration: 1,
		envelope: {
			bootId: options.connectOptions.material.processEpoch,
			connectionId: testControlConnectionId,
			controllerEpoch: options.connectOptions.material.controllerEpoch,
			createdAtMs: options.sequence,
			deliveryPolicy: 'latest_wins',
			domain: 'gateway_control',
			kind: 'event',
			messageId: `22222222-2222-4222-8222-${String(options.sequence).padStart(12, '0')}`,
			operation: 'gateway_runtime_readiness',
			peerId: options.connectOptions.material.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			sequence: options.sequence,
			sessionId: testControlSessionId,
			zoneId: options.connectOptions.material.zoneId,
		} satisfies ControlEnvelope,
		payload: GatewayControlRpcMessageSchema.parse({
			kind: 'event',
			operation: 'gateway_runtime_readiness',
			payload: options.snapshot,
		}),
	});
}

function requireManagedGatewayResult(
	result: GatewayZoneStartResult,
): ManagedGatewayZoneStartResult {
	expect(result.executionModel).toBe('managed-gateway');
	if (result.executionModel !== 'managed-gateway') {
		throw new Error('Expected a managed Gateway result.');
	}
	return result;
}

function requireDirectProcessGatewayResult(
	result: GatewayZoneStartResult,
): DirectProcessGatewayZoneStartResult {
	expect(result.executionModel).toBe('direct-process');
	if (result.executionModel !== 'direct-process') {
		throw new Error('Expected a direct-process Gateway result.');
	}
	return result;
}

function startGatewayZone(
	options: TestStartGatewayZoneOptions,
	dependencies: Omit<GatewayManagerDependencies, 'managedVmExactProcessTermination'> &
		Partial<Pick<GatewayManagerDependencies, 'managedVmExactProcessTermination'>>,
	entrypoint: 'controller-internal' | 'public' = 'controller-internal',
	harnessOptions: TestGatewayStartHarnessOptions = {},
): Promise<GatewayZoneStartResult> {
	let createdVmId: string | undefined;
	let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
	let runnerDetached = false;
	const suppliedManagedVmFactory = dependencies.managedVmFactory;
	const startOptions = withTestVmOwnership(
		{
			controlSession: { controllerEpoch: 'controller-epoch-test' },
			runtimeRecordTarget: resolveTestRuntimeRecordTarget(options),
			...options,
		},
		() => createdVmId,
	);
	const effectiveDependencies: GatewayManagerDependencies = {
		gatewayRuntimeArtifactLimits: testGatewayRuntimeArtifactLimits,
		managedVmOwnedDirectories: testManagedVmOwnedDirectories,
		managedVmExactProcessTermination: {
			terminateRecordedHostProcess: async ({ identity }) => {
				if (runnerDetached) {
					return { hostProcessId: identity.hostProcessId, kind: 'already-absent' };
				}
				runnerDetached = true;
				return { hostProcessId: identity.hostProcessId, kind: 'terminated' };
			},
		},
		managedVmTerminationSleep: async () => {},
		...dependencies,
		connectGatewayControlSession: async (connectOptions) => {
			const controlSession = await (
				dependencies.connectGatewayControlSession ?? connectTestGatewayControlSession
			)(connectOptions);
			if (
				harnessOptions.dispatchRuntimeReadiness !== false &&
				managedVmCreateRequest !== undefined
			) {
				const snapshot = await dispatchTestGatewayRuntimeReadiness({
					connectOptions,
					managedVmCreateRequest,
					...(harnessOptions.runtimeReadinessSemanticRevision === undefined
						? {}
						: {
								semanticRevision: harnessOptions.runtimeReadinessSemanticRevision,
							}),
				});
				harnessOptions.onRuntimeReadinessDispatched?.({ connectOptions, snapshot });
			}
			return controlSession;
		},
		managedVmFactory: {
			createManagedVm: async (createOptions: GatewayManagedVmFactoryOptions) => {
				managedVmCreateRequest = createOptions;
				const capturedFinalizations = new Map<string, ManagedVmFinalizeMemoryMountRequest>();
				managedGatewayBootInputCaptures.set(createOptions, capturedFinalizations);
				const managedVm = await suppliedManagedVmFactory.createManagedVm(createOptions);
				const finalizeMemoryMount = managedVm.finalizeMemoryMount?.bind(managedVm);
				if (
					finalizeMemoryMount !== undefined ||
					harnessOptions.preserveMissingFinalizableMemoryMountCapability !== true
				) {
					Object.defineProperty(managedVm, 'finalizeMemoryMount', {
						configurable: true,
						value: async (request: ManagedVmFinalizeMemoryMountRequest): Promise<void> => {
							await finalizeMemoryMount?.(request);
							capturedFinalizations.set(request.guestPath, {
								files: request.files.map((file) => ({
									contents: new Uint8Array(file.contents),
									mode: file.mode,
									relativePath: file.relativePath,
								})),
								guestPath: request.guestPath,
							});
						},
					});
				}
				const getHostProcessId = managedVm.getHostProcessId.bind(managedVm);
				Object.defineProperty(managedVm, 'getHostProcessId', {
					configurable: true,
					value: (): number | null => (runnerDetached ? null : getHostProcessId()),
				});
				createdVmId = managedVm.id;
				return managedVm;
			},
		},
	};
	return entrypoint === 'public'
		? startGatewayZonePublicProduction(startOptions, effectiveDependencies)
		: startGatewayZoneProduction(startOptions, effectiveDependencies);
}

function resolveTestRuntimeRecordTarget(
	options: Pick<TestStartGatewayZoneOptions, 'systemConfig' | 'zoneId' | 'zoneOverride'>,
): StartGatewayZoneOptions['runtimeRecordTarget'] {
	const zone =
		options.zoneOverride ??
		options.systemConfig.zones.find((candidateZone) => candidateZone.id === options.zoneId);
	if (zone === undefined) {
		// The production entrypoint rejects the unknown zone before it observes this
		// structurally valid target. Supplying it keeps that validation path intact.
		return resolveTestManagedGatewayRuntimeRecordTarget(options);
	}
	if (zone.gateway.type === 'worker') {
		return resolveTestWorkerRuntimeRecordTarget(options);
	}
	return resolveTestManagedGatewayRuntimeRecordTarget(options);
}

function resolveTestGatewayStateRoot(
	options: Pick<TestStartGatewayZoneOptions, 'systemConfig' | 'zoneId'>,
): ControllerGatewayStateRoot {
	const controllerStateRoot = createControllerStateRoot({
		controllerStateDirectoryPath: options.systemConfig.controllerStateDir,
	});
	return resolveControllerGatewayStateRoot({ controllerStateRoot, zoneId: options.zoneId });
}

function resolveTestManagedGatewayRuntimeRecordTarget(
	options: Pick<TestStartGatewayZoneOptions, 'systemConfig' | 'zoneId'>,
): ControllerManagedGatewayRuntimeRecordTarget {
	const gatewayStateRoot = resolveTestGatewayStateRoot(options);
	return resolveControllerGatewayRecordTargets({ gatewayStateRoot }).managedGatewayRuntimeRecord;
}

function resolveTestWorkerRuntimeRecordTarget(
	options: Pick<TestStartGatewayZoneOptions, 'systemConfig' | 'zoneId'>,
): ControllerWorkerTaskRuntimeRecordTarget {
	return resolveControllerWorkerTaskRuntimeRecordTarget({
		gatewayStateRoot: resolveTestGatewayStateRoot(options),
		taskId: testWorkerTaskId,
	});
}

const testCallerContextProofKey = 'test-caller-context-proof-key';
const testAgentAuthorityKeys: Readonly<Record<string, string>> = {
	main: 'test-main-agent-authority-key-with-enough-length',
	second: 'test-second-agent-authority-key-with-enough-length',
};

function createTestInvocationPrincipal(
	agentId: string,
	overrides: Partial<GatewayRuntimeTrustedInvocationPrincipal> = {},
): GatewayRuntimeTrustedInvocationPrincipal {
	return {
		agentId,
		frameworkIdentity: { agentId, kind: 'openclaw' },
		profileAssignmentRevision: `profile-assignment:${agentId}`,
		toolPortalProfileId: 'default',
		...overrides,
	};
}

function createTestAgentProjections(
	agentIds: readonly string[],
): Readonly<Record<string, ManagedAgentProjection>> {
	return Object.fromEntries(
		agentIds.map((agentId) => {
			const principal = createTestInvocationPrincipal(agentId);
			return [
				agentId,
				{
					agentId,
					frameworkIdentity: principal.frameworkIdentity,
					profileAssignmentRevision: principal.profileAssignmentRevision,
					toolPortalNamespaceNames: [],
					toolPortalProfileId: principal.toolPortalProfileId,
				},
			];
		}),
	);
}

function createTestCallerContextProofInput(options: {
	readonly agentId: string;
	readonly principal?: GatewayRuntimeTrustedInvocationPrincipal;
	readonly proofZoneId?: string;
	readonly purpose?: 'tool_vm_lease' | 'tool_portal_controller_execution';
}): GatewayControlCallerContextProofPayloadInput {
	return {
		principal: options.principal ?? createTestInvocationPrincipal(options.agentId),
		...(options.purpose === undefined ? {} : { purpose: options.purpose }),
		zoneId: options.proofZoneId ?? 'shravan',
	};
}

function signTestCallerContextProof(
	input: GatewayControlCallerContextProofPayloadInput,
	proofKey = testCallerContextProofKey,
): GatewayControlCallerContextProof {
	return {
		algorithm: 'hmac-sha256',
		digest: createHmac('sha256', proofKey)
			.update(buildGatewayControlCallerContextProofPayload(input), 'utf8')
			.digest('base64url'),
	};
}

function signTestCallerContextAgentAuthority(
	input: GatewayControlCallerContextProofPayloadInput,
	key = testAgentAuthorityKeys[input.principal.agentId] ?? 'missing',
): {
	readonly algorithm: 'hmac-sha256';
	readonly digest: string;
	readonly keyId: string;
} {
	return {
		algorithm: 'hmac-sha256',
		digest: createHmac('sha256', key)
			.update(buildGatewayControlCallerContextAgentAuthorityPayload(input), 'utf8')
			.digest('base64url'),
		keyId: input.principal.agentId,
	};
}

function createSignedTestCallerContextRegisterPayload(
	input: GatewayControlCallerContextProofPayloadInput,
	options: {
		readonly agentAuthorityKey?: string;
		readonly callerContextProofKey?: string;
	} = {},
): GatewayControlCallerContextRegisterPayload {
	return {
		adapterEvidence: {
			...input,
			agentAuthority: signTestCallerContextAgentAuthority(input, options.agentAuthorityKey),
			proof: signTestCallerContextProof(input, options.callerContextProofKey),
		},
	};
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(rawJson: string): Record<string, unknown> {
	const parsedJson = JSON.parse(rawJson) as unknown;
	if (!isJsonRecord(parsedJson)) {
		throw new Error('Expected JSON object.');
	}
	return parsedJson;
}

function requireObjectProperty(
	record: Record<string, unknown>,
	propertyName: string,
): Record<string, unknown> {
	const property = record[propertyName];
	if (!isJsonRecord(property)) {
		throw new Error(`Expected JSON object property '${propertyName}'.`);
	}
	return property;
}

const {
	cleanupOrphanedGatewayIfPresentMock,
	cleanupOrphanedToolVmsIfPresentMock,
	preflightOrphanedGatewayCleanupIfPresentMock,
} = vi.hoisted(() => ({
	cleanupOrphanedGatewayIfPresentMock: vi.fn(async () => ({
		cleanedUp: false,
		killedPid: null,
	})),
	cleanupOrphanedToolVmsIfPresentMock: vi.fn(async () => ({
		cleanedCount: 0,
		killedPids: [] as readonly number[],
		quarantinedCount: 0,
		warnings: [] as readonly string[],
	})),
	preflightOrphanedGatewayCleanupIfPresentMock: vi.fn(async () => ({})),
}));

// Stub the ps shell-out so buildGatewayRuntimeRecord doesn't try to query a
// real pid in the test environment. Production uses the real implementation.
vi.mock('../shared/managed-vm-process.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../shared/managed-vm-process.js')>();
	return {
		...actual,
		readProcessIdentity: vi.fn(async () => ({
			command: 'qemu-system-x86_64 -m 4G',
			lstart: 'Fri May 22 10:00:00 2026',
		})),
	};
});

vi.mock('./gateway-recovery.js', () => ({
	cleanupOrphanedGatewayIfPresent: cleanupOrphanedGatewayIfPresentMock,
	preflightOrphanedGatewayCleanupIfPresent: preflightOrphanedGatewayCleanupIfPresentMock,
}));

vi.mock('../controller/leases/tool-vm-recovery.js', () => ({
	cleanupOrphanedToolVmsIfPresent: cleanupOrphanedToolVmsIfPresentMock,
}));

const createdDirectories: string[] = [];

const openClawToolVmSandbox = {
	backend: 'gondolin',
	mode: 'all',
	scope: 'agent',
	workspaceAccess: 'rw',
} satisfies Record<string, string>;

function createDeferredPromise<TResult>(): DeferredPromise<TResult> {
	let resolveDeferred: ((result: TResult) => void) | null = null;
	const promise = new Promise<TResult>((resolve) => {
		resolveDeferred = resolve;
	});
	return {
		promise,
		resolve: (result: TResult): void => {
			if (resolveDeferred === null) {
				throw new Error('Deferred promise resolve callback was not initialized.');
			}
			resolveDeferred(result);
		},
	};
}

async function flushPendingEventLoopWork(): Promise<void> {
	for (let iterationIndex = 0; iterationIndex < 20; iterationIndex += 1) {
		// oxlint-disable-next-line no-await-in-loop -- sequential event-loop turns are intentional.
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

afterEach(async () => {
	cleanupOrphanedGatewayIfPresentMock.mockClear();
	cleanupOrphanedToolVmsIfPresentMock.mockClear();
	preflightOrphanedGatewayCleanupIfPresentMock.mockClear();
	vi.unstubAllEnvs();
	await Promise.all(
		createdDirectories
			.splice(0)
			.map((directoryPath) => rm(directoryPath, { recursive: true, force: true })),
	);
});

async function createGatewayConfigPath(): Promise<string> {
	const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-gateway-zone-'));
	createdDirectories.push(workingDirectoryPath);
	const configDirectory = path.join(workingDirectoryPath, 'config', 'shravan');
	await mkdir(configDirectory, { recursive: true });
	const configPath = path.join(configDirectory, 'openclaw.json');
	await writeFile(
		configPath,
		JSON.stringify({
			agents: {
				defaults: {
					sandbox: openClawToolVmSandbox,
					workspace: '/zone/agents/default',
				},
			},
			gateway: {
				auth: { mode: 'token' },
				bind: 'loopback',
				controlUi: {
					allowedOrigins: ['http://127.0.0.1:18791', 'http://localhost:18791'],
				},
			},
			tools: {
				sandbox: {
					tools: {
						alsoAllow: ['group:plugins'],
					},
				},
			},
		}),
		'utf8',
	);
	return configPath;
}

async function writeMinimalMcpPortalConfigs(
	configDir: string,
	mcpConfig: unknown = {
		providers: {},
		schemaVersion: 1,
	},
	options: {
		readonly portalAgentId?: string;
	} = {},
): Promise<void> {
	const portalAgentId = options.portalAgentId ?? 'main';
	await writeFile(path.join(configDir, 'mcp.config.jsonc'), JSON.stringify(mcpConfig), 'utf8');
	await writeFile(
		path.join(configDir, 'tool-portal.config.jsonc'),
		JSON.stringify({
			agents: { [portalAgentId]: { profile: 'default' } },
			mode: 'managed',
			profiles: { default: { namespaces: {} } },
			schemaVersion: 1,
		}),
		'utf8',
	);
}

async function createSystemConfigPath(): Promise<string> {
	const workingDirectoryPath = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-gateway-cache-id-'));
	createdDirectories.push(workingDirectoryPath);
	const configDirectory = path.join(workingDirectoryPath, 'config');
	await mkdir(configDirectory, { recursive: true });
	return path.join(configDirectory, 'system.json');
}

function createHttpHealthGatewayLifecycle(): {
	readonly executionModel: 'direct-process';
	readonly buildProcessSpec: () => {
		readonly bootstrapCommand: string;
		readonly guestListenPort: number;
		readonly healthCheck: { readonly type: 'http'; readonly port: number; readonly path: string };
		readonly logPath: string;
		readonly startCommand: string;
	};
	readonly buildVmRequirements: () => {
		readonly allowedHosts: readonly string[];
		readonly environment: Record<string, never>;
		readonly mediatedSecrets: Record<string, never>;
		readonly rootfsMode: 'cow';
		readonly sessionLabel: string;
		readonly tcpHosts: Record<string, never>;
		readonly mounts: Record<string, never>;
	};
} {
	return {
		executionModel: 'direct-process',
		buildProcessSpec: () => ({
			bootstrapCommand: 'bootstrap-http-gateway',
			guestListenPort: 18789,
			healthCheck: { type: 'http', port: 18789, path: '/' },
			logPath: '/tmp/http-gateway.log',
			startCommand: 'start-http-gateway',
		}),
		buildVmRequirements: () => ({
			allowedHosts: [],
			environment: {},
			mediatedSecrets: {},
			rootfsMode: 'cow',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			tcpHosts: {},
			mounts: {},
		}),
	};
}

async function createSystemConfig(): Promise<LoadedSystemConfig> {
	const workingDirectoryPath = await mkdtemp(
		path.join(os.tmpdir(), 'agent-vm-gateway-zone-state-'),
	);
	createdDirectories.push(workingDirectoryPath);
	const gatewayConfigPath = await createGatewayConfigPath();
	const toolPortalConfigDir = path.dirname(gatewayConfigPath);
	await writeMinimalMcpPortalConfigs(toolPortalConfigDir);
	return createLoadedSystemConfig(
		{
			schemaVersion: 2,
			storageRootDir: workingDirectoryPath,
			host: {
				controllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				secretsProvider: {
					type: '1password',
					tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
				},
			},
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'openclaw',
						buildConfig: './vm-images/gateways/openclaw/build-config.json',
					},
					worker: {
						type: 'worker',
						buildConfig: './vm-images/gateways/worker/build-config.json',
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: './vm-images/tool-vms/default/build-config.json',
					},
				},
			},
			zones: [
				{
					agents: [
						{
							id: 'main',
							workspaceGit: {
								mode: 'remote',
								remote: {
									branch: 'agent/main',
									repoUrl: 'ShravanSunder/zone-files',
								},
							},
						},
					],
					id: 'shravan',
					gateway: {
						type: 'openclaw',
						controlAuth: {
							mode: 'token',
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
						imageProfile: 'openclaw',
						memory: '2G',
						cpus: 2,
						port: 18791,
						config: gatewayConfigPath,
						rawEnvSecrets: ['DISCORD_BOT_TOKEN'],
						runtimeRootfsSize: '12G',
					},
					toolPortal: createGatewayZoneToolPortalConfig(toolPortalConfigDir),
					secrets: {
						PERPLEXITY_API_KEY: {
							source: '1password',
							ref: 'op://agent-vm/shravan-perplexity/credential',
							injection: 'http-mediation',
							audience: 'gateway',
							hosts: ['api.perplexity.ai'],
						},
						DISCORD_BOT_TOKEN: {
							source: '1password',
							ref: 'op://agent-vm/shravan-discord/bot-token',
							injection: 'env',
							audience: 'gateway',
						},
						OPENCLAW_GATEWAY_TOKEN: {
							source: '1password',
							ref: 'op://agent-vm/shravan-gateway-auth/password',
							injection: 'env',
							audience: 'gateway',
						},
					},
					egressHosts: ['api.anthropic.com', 'api.openai.com', 'api.perplexity.ai'].map((host) => ({
						host,
						audience: 'gateway' as const,
					})),
					defaultToolVmProfile: 'standard',
					agentToolVmProfiles: {},
				},
			],
			toolVmProfiles: {
				standard: {
					memory: '1G',
					cpus: 1,
					imageProfile: 'default',
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 5,
			},
		},
		{ systemConfigPath: await createSystemConfigPath() },
	);
}

async function createHermesSystemConfig(): Promise<LoadedSystemConfig> {
	const systemConfig = await createSystemConfig();
	const openClawZone = systemConfig.zones[0];
	if (openClawZone === undefined || openClawZone.gateway.type !== 'openclaw') {
		throw new Error('Expected the base OpenClaw test zone.');
	}
	const configDir = path.dirname(openClawZone.gateway.config);
	const hermesManagedConfigDir = path.join(configDir, 'hermes-managed');
	await mkdir(hermesManagedConfigDir, { recursive: true });
	await Promise.all([
		writeFile(
			path.join(configDir, 'tool-portal.config.jsonc'),
			JSON.stringify({
				agents: {
					main: { profile: 'default' },
					second: { profile: 'default' },
				},
				mode: 'managed',
				profiles: { default: { namespaces: {} } },
				schemaVersion: 1,
			}),
			'utf8',
		),
		writeFile(
			path.join(hermesManagedConfigDir, 'config.yaml'),
			'plugins:\n  enabled:\n    - agent-vm-tool-portal\n  disabled: []\n',
			'utf8',
		),
	]);
	return {
		...systemConfig,
		imageProfiles: {
			...systemConfig.imageProfiles,
			gateways: {
				...systemConfig.imageProfiles.gateways,
				hermes: {
					buildConfig: path.join(configDir, 'hermes-image.json'),
					type: 'hermes',
				},
			},
		},
		zones: [
			{
				...openClawZone,
				agents: [{ id: 'main' }, { id: 'second' }],
				gateway: {
					config: path.join(hermesManagedConfigDir, 'config.yaml'),
					cpus: openClawZone.gateway.cpus,
					profileSecretProjectionsByAgent: {
						main: {
							API_SERVER_KEY: 'API_SERVER_KEY_MAIN',
							DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_MAIN',
						},
						second: {
							API_SERVER_KEY: 'API_SERVER_KEY_SECOND',
							DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SECOND',
						},
					},
					imageProfile: 'hermes',
					memory: openClawZone.gateway.memory,
					port: openClawZone.gateway.port,
					profilesByAgent: {
						main: 'beta-main',
						second: 'beta-second',
					},
					runtimeRootfsSize: openClawZone.gateway.runtimeRootfsSize,
					stateDir: openClawZone.gateway.stateDir,
					type: 'hermes',
					zoneFilesDir: openClawZone.gateway.zoneFilesDir,
					zoneRuntimeDir: openClawZone.gateway.zoneRuntimeDir,
				},
				secrets: {
					API_SERVER_KEY: {
						audience: 'gateway',
						injection: 'env',
						source: 'config',
						value: 'test-hermes-api-server-key',
					},
					API_SERVER_KEY_MAIN: {
						audience: 'gateway',
						injection: 'env',
						source: 'config',
						value: 'test-hermes-main-api-server-key',
					},
					API_SERVER_KEY_SECOND: {
						audience: 'gateway',
						injection: 'env',
						source: 'config',
						value: 'test-hermes-second-api-server-key',
					},
					DISCORD_BOT_TOKEN_MAIN: {
						audience: 'gateway',
						injection: 'env',
						source: 'config',
						value: 'test-hermes-main-discord-token',
					},
					DISCORD_BOT_TOKEN_SECOND: {
						audience: 'gateway',
						injection: 'env',
						source: 'config',
						value: 'test-hermes-second-discord-token',
					},
				},
			},
		],
	};
}

async function createWorkerSystemConfig(): Promise<LoadedSystemConfig> {
	const systemConfig = await createSystemConfig();
	return {
		...systemConfig,
		zones: systemConfig.zones.map((zone) => ({
			...zone,
			gateway: {
				...zone.gateway,
				type: 'worker' as const,
			},
			secrets: {
				OPENAI_API_KEY: {
					audience: 'gateway' as const,
					hosts: ['api.openai.com'],
					injection: 'http-mediation' as const,
					source: 'config' as const,
					value: 'test-openai-key',
				},
			},
		})),
	};
}

function createObservabilitySystemConfig(
	systemConfig: LoadedSystemConfig,
	options: {
		readonly controllerStartPolicy?: 'degraded' | 'require-ready' | 'off';
		readonly zoneEnabled?: boolean;
	} = {},
): LoadedSystemConfig {
	const {
		cacheDir: _cacheDir,
		controllerRuntimeDir: _controllerRuntimeDir,
		controllerStateDir: _controllerStateDir,
		systemConfigPath,
		...baseConfig
	} = systemConfig;
	const zoneEnabled = options.zoneEnabled ?? false;
	const authoredZones = baseConfig.zones.map((zone) => {
		const { gateway, ...authoredZone } = zone;
		const observability = zoneEnabled
			? {
					observability: {
						enabled: true as const,
						services: {
							framework: { traces: true, metrics: true, logs: true },
							toolPortal: { traces: true, metrics: true, logs: true },
						},
					},
				}
			: {};
		if (gateway.type === 'worker') {
			const { stateDir: _stateDir, zoneRuntimeDir: _zoneRuntimeDir, ...authoredGateway } = gateway;
			return { ...authoredZone, ...observability, gateway: authoredGateway };
		}
		const {
			stateDir: _stateDir,
			zoneFilesDir: _zoneFilesDir,
			zoneRuntimeDir: _zoneRuntimeDir,
			...authoredGateway
		} = gateway;
		return { ...authoredZone, ...observability, gateway: authoredGateway };
	});
	return createLoadedSystemConfig(
		{
			...baseConfig,
			host: {
				...baseConfig.host,
				observability: {
					enabled: true,
					stack: {
						mode: 'managed',
						scrubbing: { responsibility: 'agent-vm-managed-collector' },
					},
					runner: 'docker-compose',
					mode: 'collector',
					dataDir: path.join(path.dirname(systemConfig.cacheDir), 'observability-data'),
					...(options.controllerStartPolicy === undefined
						? {}
						: { controllerStartPolicy: options.controllerStartPolicy }),
					retention: {
						metrics: { period: '30d', minFreeDiskSpaceBytes: '5GiB' },
						logs: { period: '14d', maxDiskSpaceUsageBytes: '50GiB' },
						traces: { period: '7d', maxDiskSpaceUsageBytes: '20GiB' },
					},
				},
			},
			zones: authoredZones,
		},
		{ systemConfigPath },
	);
}

function completeGatewayVmClose(_vmId: string): void {}

function createTestSshAccess(port = 2222): Awaited<ReturnType<ManagedVm['enableSsh']>> {
	return {
		close: vi.fn(async () => {}),
		command: `ssh -i /tmp/key sandbox@127.0.0.1 -p ${String(port)}`,
		host: '127.0.0.1',
		identityFile: '/tmp/key',
		port,
		serverHostKey: TEST_SSH_SERVER_HOST_KEY,
		user: 'sandbox',
	};
}

function createTestIngressAccess(port = 18791): Awaited<ReturnType<ManagedVm['enableIngress']>> {
	return {
		close: vi.fn(async () => {}),
		host: '127.0.0.1',
		port,
	};
}

function createHealthyGatewayVmStub(
	vmId: string,
	pid: number | null,
): {
	readonly close: Mock<ManagedVm['close']>;
	readonly configureIngressRoutes: Mock<ManagedVm['configureIngressRoutes']>;
	readonly enableIngress: Mock<ManagedVm['enableIngress']>;
	readonly exec: Mock<ManagedVm['exec']>;
	readonly finalizeMemoryMount: Mock<NonNullable<ManagedVm['finalizeMemoryMount']>>;
	readonly managedVm: ManagedVm;
	readonly start: Mock<ManagedVm['start']>;
} {
	const close = vi.fn(async () => {});
	const configureIngressRoutes = vi.fn<ManagedVm['configureIngressRoutes']>();
	const enableIngress = vi.fn(async () => createTestIngressAccess());
	const exec = vi.fn(() => createManagedExecProcessStub({ stdout: '200' }));
	const finalizeMemoryMount = vi.fn<NonNullable<ManagedVm['finalizeMemoryMount']>>(async () => {});
	const start = vi.fn(async () => {});
	return {
		close,
		configureIngressRoutes,
		enableIngress,
		exec,
		finalizeMemoryMount,
		managedVm: {
			id: vmId,
			start,
			close,
			enableIngress,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec,
			finalizeMemoryMount,
			getHostProcessId: vi.fn(() => pid),
			configureIngressRoutes,
		},
		start,
	};
}

function requireManagedGatewayBootInputFile(
	createRequest: ManagedVmCreateRequest | undefined,
	guestPath: string,
	relativePath: string,
): string {
	if (createRequest === undefined) {
		throw new Error('Expected managed Gateway VM creation request.');
	}
	const finalization = managedGatewayBootInputCaptures.get(createRequest)?.get(guestPath);
	const file = finalization?.files.find((candidate) => candidate.relativePath === relativePath);
	if (file === undefined) {
		throw new Error(`Expected managed Gateway RAM boot input '${guestPath}/${relativePath}'.`);
	}
	return new TextDecoder().decode(file.contents);
}

function createOpenClawSecretResolver(resolvedSecrets: Record<string, string>): SecretResolver {
	const resolveKnownSecretRef = (secretRef: SecretRef): string => {
		if (secretRef.source === 'config') {
			return secretRef.value;
		}

		if (secretRef.ref === 'op://agent-vm/shravan-discord/bot-token') {
			return resolvedSecrets.DISCORD_BOT_TOKEN ?? 'resolved-discord-token';
		}

		if (secretRef.ref === 'op://agent-vm/shravan-perplexity/credential') {
			return resolvedSecrets.PERPLEXITY_API_KEY ?? 'resolved-perplexity-key';
		}

		if (secretRef.ref === 'op://agent-vm/shravan-gateway-auth/password') {
			return resolvedSecrets.OPENCLAW_GATEWAY_TOKEN ?? 'resolved-gateway-token';
		}

		const resolvedSecret = resolvedSecrets[secretRef.ref];
		if (resolvedSecret !== undefined) {
			return resolvedSecret;
		}

		throw new Error(`Unexpected secret ref: ${secretRef.ref}`);
	};
	return {
		resolve: async (secretRef): Promise<string> => resolveKnownSecretRef(secretRef),
		resolveAll: async (secretRefs): Promise<Record<string, string>> =>
			Object.fromEntries(
				Object.entries(secretRefs).map(([secretName, secretRef]) => [
					secretName,
					resolveKnownSecretRef(secretRef),
				]),
			),
	};
}

describe('startGatewayZone', () => {
	it.each(['openclaw', 'hermes'] as const)(
		'reports exact current %s attachment loss once and ignores stale or wrong-kind readiness',
		async (frameworkKind) => {
			// Arrange
			const systemConfig =
				frameworkKind === 'openclaw'
					? await createSystemConfig()
					: await createHermesSystemConfig();
			const zone = systemConfig.zones[0];
			if (zone === undefined) {
				throw new Error(`Expected ${frameworkKind} test zone.`);
			}
			const { managedVm } = createHealthyGatewayVmStub(
				`vm-terminal-attachment-loss-${frameworkKind}`,
				28_282,
			);
			const onGatewayRuntimeAttachmentLost = vi.fn();
			let readinessDispatch:
				| {
						readonly connectOptions: Parameters<GatewayControlSessionConnector>[0];
						readonly snapshot: GatewayRuntimeReadinessSnapshot;
				  }
				| undefined;

			// Act
			const result = await startGatewayZone(
				{
					onGatewayRuntimeAttachmentLost,
					secretResolver: createOpenClawSecretResolver({}),
					systemConfig,
					zoneId: zone.id,
				},
				{
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					managedVmImages: testManagedVmImages,
				},
				'controller-internal',
				{
					onRuntimeReadinessDispatched: (dispatched) => {
						readinessDispatch = dispatched;
					},
				},
			);
			if (readinessDispatch === undefined) {
				throw new Error('Expected the test harness to capture runtime readiness dispatch.');
			}
			const staleLoss = {
				...readinessDispatch.snapshot,
				semanticRevision: 'semantic-revision:stale',
				uds: {
					...readinessDispatch.snapshot.uds,
					attachment: {
						...readinessDispatch.snapshot.uds.attachment,
						observationSequence: 2,
						status: 'attachment-lost' as const,
					},
				},
			} satisfies GatewayRuntimeReadinessSnapshot;
			const currentLoss = {
				...staleLoss,
				semanticRevision: readinessDispatch.snapshot.semanticRevision,
				uds: {
					...staleLoss.uds,
					attachment: {
						...staleLoss.uds.attachment,
						observationSequence: 4,
					},
				},
			} satisfies GatewayRuntimeReadinessSnapshot;
			const wrongFrameworkKindLoss = {
				...currentLoss,
				uds: {
					...currentLoss.uds,
					attachment: {
						...currentLoss.uds.attachment,
						expected: {
							...currentLoss.uds.attachment.expected,
							clientKind:
								frameworkKind === 'openclaw'
									? ('hermes-managed-plugin' as const)
									: ('openclaw-managed-plugin' as const),
						},
						observationSequence: 3,
					},
				},
			} satisfies GatewayRuntimeReadinessSnapshot;
			await dispatchTestGatewayRuntimeReadinessSnapshot({
				connectOptions: readinessDispatch.connectOptions,
				sequence: 2,
				snapshot: staleLoss,
			});
			await dispatchTestGatewayRuntimeReadinessSnapshot({
				connectOptions: readinessDispatch.connectOptions,
				sequence: 3,
				snapshot: wrongFrameworkKindLoss,
			});
			await dispatchTestGatewayRuntimeReadinessSnapshot({
				connectOptions: readinessDispatch.connectOptions,
				sequence: 4,
				snapshot: currentLoss,
			});
			await dispatchTestGatewayRuntimeReadinessSnapshot({
				connectOptions: readinessDispatch.connectOptions,
				sequence: 5,
				snapshot: currentLoss,
			});

			// Assert
			const managedResult = requireManagedGatewayResult(result);
			expect(onGatewayRuntimeAttachmentLost).toHaveBeenCalledOnce();
			expect(onGatewayRuntimeAttachmentLost).toHaveBeenCalledWith({
				connectionId: testControlConnectionId,
				gateway: managedResult.gatewayIdentity,
				observationSequence: 4,
			});
		},
	);

	it('builds the image, resolves secrets, creates the vm, and enables ingress', async () => {
		const taskTitles: string[] = [];
		const closeMock = vi.fn(async () => {});
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const enableSshMock = vi.fn(async () => createTestSshAccess());
		const execMock = vi.fn((command: string) =>
			createManagedExecProcessStub({
				stdout: command.includes('curl -sS -o /dev/null -w "%{http_code}"') ? '200' : '',
			}),
		);
		const finalizeMemoryMountMock = vi.fn<NonNullable<ManagedVm['finalizeMemoryMount']>>(
			async () => {},
		);
		const startMock = vi.fn(async () => {});
		const configureIngressRoutesMock = vi.fn();
		const writeGatewayRuntimeRecord = vi.fn<
			NonNullable<GatewayManagerDependencies['writeGatewayRuntimeRecord']>
		>(async () => {});
		const managedVm: ManagedVm = {
			id: 'vm-123',
			start: startMock,
			close: closeMock,
			enableIngress: enableIngressMock,
			enableSsh: enableSshMock,
			exec: execMock,
			finalizeMemoryMount: finalizeMemoryMountMock,
			getHostProcessId: vi.fn(() => 28282),
			configureIngressRoutes: configureIngressRoutesMock,
		};
		const secretResolver = createOpenClawSecretResolver({
			PERPLEXITY_API_KEY: 'resolved-key',
			DISCORD_BOT_TOKEN: 'resolved-key',
			OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
		});
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fingerprint-123',
			imageReference: '/tmp/gateway-image',
		}));
		const createManagedVm = vi.fn(
			async (_options: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);
		vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent-vm-test-agent.sock');

		const systemConfig = await createSystemConfig();
		const ownership = createTestVmOwnershipHarness(
			'vm-123',
			createTestGatewayEpochIdentity('vm-123'),
		);
		const result = await startGatewayZone(
			{
				createVmOwnership: ownership.createVmOwnership,
				runTask: async (title, fn) => {
					taskTitles.push(title);
					await fn();
				},
				secretResolver,
				systemConfig,
				zoneId: 'shravan',
			},
			{
				managedVmImages: { prepareImage: buildImage },
				createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
				managedVmFactory: { createManagedVm },
				writeGatewayRuntimeRecord,
			},
		);

		const zone = systemConfig.zones[0];
		if (zone === undefined) {
			throw new Error('Expected configured test zone.');
		}
		const logDirectoryPath = path.join(zone.gateway.zoneRuntimeDir, 'logs');
		expect((await stat(logDirectoryPath)).mode & 0o777).toBe(0o700);
		expect(buildImage).toHaveBeenCalled();
		expect(ownership.createVmOwnership.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			createManagedVm.mock.invocationCallOrder[0] ?? 0,
		);
		expect(ownership.attachGatewayVm).toHaveBeenCalledWith('vm-123');
		expect(ownership.attachGatewayVm.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			finalizeMemoryMountMock.mock.invocationCallOrder[0] ?? 0,
		);
		expect(finalizeMemoryMountMock.mock.calls.map(([request]) => request.guestPath)).toEqual([
			managedGatewayBootInputPaths.environmentRoot,
			managedGatewayBootInputPaths.structuredRoot,
		]);
		expect(finalizeMemoryMountMock.mock.invocationCallOrder[1] ?? 0).toBeLessThan(
			startMock.mock.invocationCallOrder[0] ?? 0,
		);
		expect(startMock).toHaveBeenCalledOnce();
		expect(startMock.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			execMock.mock.invocationCallOrder[0] ?? 0,
		);
		expect(writeGatewayRuntimeRecord).toHaveBeenCalledOnce();
		expect(writeGatewayRuntimeRecord.mock.calls[0]?.[0]).toEqual(
			resolveTestManagedGatewayRuntimeRecordTarget({ systemConfig, zoneId: 'shravan' }),
		);
		expect(writeGatewayRuntimeRecord.mock.calls[0]?.[1]).toMatchObject({
			appliedIngressRoutes: [
				expect.objectContaining({ kind: 'tool-portal-control' }),
				expect.objectContaining({ kind: 'framework-root' }),
			],
			gateway: expect.objectContaining({ gatewayVmId: 'vm-123' }),
			ingressPort: 18791,
			runtimeKind: 'managed-gateway',
			schemaVersion: 4,
			vmId: 'vm-123',
		});
		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.arrayContaining([
					'api.anthropic.com',
					'api.openai.com',
					'api.perplexity.ai',
				]),
				environment: expect.objectContaining({
					HOME: '/home/openclaw',
					NODE_EXTRA_CA_CERTS: '/run/gondolin/ca-certificates.crt',
					OPENCLAW_HOME: '/home/openclaw',
					OPENCLAW_CONFIG_PATH: '/home/openclaw/.openclaw/state/effective-openclaw.json',
					OPENCLAW_STATE_DIR: '/home/openclaw/.openclaw/state',
				}),
				imageReference: '/tmp/gateway-image',
				mediatedSecrets: expect.arrayContaining([
					expect.objectContaining({
						allowedHosts: ['api.perplexity.ai'],
						environmentVariable: 'PERPLEXITY_API_KEY',
						value: 'resolved-key',
					}),
				]),
				mounts: expect.objectContaining({
					'/agent-vm/logs': {
						access: 'read-write',
						hostPath: path.join(zone.gateway.zoneRuntimeDir, 'logs'),
						kind: 'host-directory',
					},
					'/home/openclaw/.openclaw/cache': {
						access: 'read-write',
						hostPath: path.join(systemConfig.cacheDir, 'gateways', 'shravan'),
						kind: 'host-directory',
					},
				}),
				resources: { cpuCount: 2, memory: '2G' },
				rootfsMode: 'cow',
				runtimeRootfsSize: '12G',
				sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
				tcpHosts: expect.not.arrayContaining([
					expect.objectContaining({ guestHost: 'controller.vm.host:18800' }),
				]),
			}),
		);
		const createdVmOptions = createManagedVm.mock.calls[0]?.[0];
		if (createdVmOptions === undefined) {
			throw new Error('Expected gateway VM creation call');
		}
		expect(createdVmOptions.mounts[managedGatewayBootInputPaths.environmentRoot]).toEqual({
			access: 'read-write',
			kind: 'finalizable-memory',
		});
		expect(createdVmOptions.mounts[managedGatewayBootInputPaths.structuredRoot]).toEqual({
			access: 'read-only',
			kind: 'finalizable-memory',
		});
		const protectedFrameworkEnvironment = requireManagedGatewayBootInputFile(
			createdVmOptions,
			managedGatewayBootInputPaths.environmentRoot,
			'framework.environment.sh',
		);
		expect(createdVmOptions.allowedHosts).not.toContain('controller.vm.host');
		expect(createdVmOptions.environment).not.toHaveProperty('DISCORD_BOT_TOKEN');
		expect(createdVmOptions.environment).not.toHaveProperty('OPENCLAW_GATEWAY_TOKEN');
		expect(createdVmOptions.environment).not.toHaveProperty('PERPLEXITY_API_KEY');
		expect(protectedFrameworkEnvironment).toContain("export DISCORD_BOT_TOKEN='resolved-key'");
		expect(protectedFrameworkEnvironment).toContain(
			"export OPENCLAW_GATEWAY_TOKEN='resolved-gateway-token'",
		);
		expect(createdVmOptions.sshEgress).toBeUndefined();
		expect(createdVmOptions.tcpHosts).not.toContainEqual(
			expect.objectContaining({ guestHost: 'controller.vm.host:18800' }),
		);
		expect(requireManagedGatewayResult(result)).not.toHaveProperty('processEpoch');
		expect(configureIngressRoutesMock).toHaveBeenNthCalledWith(1, [
			{
				port: 18_790,
				prefix: '/__agent-vm',
				stripPrefix: false,
			},
		]);
		expect(configureIngressRoutesMock).toHaveBeenNthCalledWith(2, [
			{
				port: 18_790,
				prefix: '/__agent-vm',
				stripPrefix: false,
			},
			{
				port: 18_789,
				prefix: '/',
				stripPrefix: true,
			},
		]);
		expect(enableIngressMock).toHaveBeenCalledWith({
			allowWebSockets: true,
			bufferResponseBody: false,
			listenPort: 18791,
		});
		// OpenClaw ownership reconciliation is controller-start work, not
		// gateway-zone startup work. Mutating Tool Portal materialization starts
		// only after the image, assertions, and secret prerequisites succeed.
		expect(taskTitles).toEqual([
			'Preflighting gateway start',
			'Validating OpenClaw Tool VM requirements',
			'Resolving zone secrets',
			'Building gateway image',
			'Materializing Tool Portal runtime',
			'Reserving gateway VM ownership',
			'Booting gateway VM',
			'Preparing host state',
			'Connecting gateway control session',
			'Recording gateway runtime',
		]);
		expect(cleanupOrphanedToolVmsIfPresentMock).not.toHaveBeenCalled();
		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			image: {
				fingerprint: 'fingerprint-123',
				imageReference: '/tmp/gateway-image',
			},
			ingress: {
				host: '127.0.0.1',
				port: 18791,
			},
			executionModel: 'managed-gateway',
		});
		expect(result).not.toHaveProperty('processSpec');
		expect(execMock.mock.calls.map(([command]) => command)).toEqual([
			expectedManagedOpenClawReadinessCommand,
			expectedManagedOpenClawReadinessCommand,
		]);
	});

	it('contains a managed Gateway when aggregate readiness times out without launching guest services', async () => {
		const vmId = 'vm-managed-readiness-timeout';
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		const { close, configureIngressRoutes, enableIngress, managedVm, start } =
			createHealthyGatewayVmStub(vmId, 28_410);
		const lifecycleEvents: string[] = [];
		let vmDestroyed = false;
		close.mockImplementation(async () => {
			vmDestroyed = true;
			lifecycleEvents.push('destroy');
		});
		const rawCredentialValues = [
			'op://agent-vm-testing/private-item/credential',
			'OP_SERVICE_ACCOUNT_TOKEN=ops_service_account_value_123456789',
			'ops_standalone_service_account_value_123456789',
			'Bearer direct-mcp-bearer-value',
			'password=framework-password-value',
			'token=framework-token-value',
		] as const;
		const oversizedFrameworkLogTail = `${'x'.repeat(20 * 1_024)}\n${rawCredentialValues.join('\n')}\nretained-diagnostic-sentinel`;
		const exec = vi.fn((command: Parameters<ManagedVm['exec']>[0]) => {
			if (command === expectedManagedOpenClawReadinessCommand) {
				lifecycleEvents.push('readiness');
				return createManagedExecProcessStub({ stdout: '000' });
			}
			lifecycleEvents.push('diagnostics');
			if (vmDestroyed) {
				throw new Error('VM already destroyed before diagnostic capture');
			}
			if (typeof command === 'string') {
				if (command.startsWith('tail -n 80 ')) {
					return createManagedExecProcessStub({ stdout: oversizedFrameworkLogTail });
				}
				throw new Error(`Unexpected managed Gateway command '${command}'.`);
			}
			if (command[0] === 'tail') {
				return createManagedExecProcessStub({ stdout: oversizedFrameworkLogTail });
			}
			if (command[0] === 'sh' && command[2]?.includes('/proc/[0-9]*')) {
				return createManagedExecProcessStub({
					stdout:
						'221 /usr/local/bin/agent-vm-gateway-runtime --config /run/agent-vm/managed-gateway/tool-portal-service.json\n222 /usr/local/bin/openclaw gateway --port 18789',
				});
			}
			if (command[0] === 'sh' && command[2]?.includes('/proc/net/tcp')) {
				return createManagedExecProcessStub({ stdout: '/proc/net/tcp 0100007F:4968' });
			}
			throw new Error(`Unexpected managed Gateway diagnostic command '${command.join(' ')}'.`);
		});
		managedVm.exec = exec;
		const writeGatewayRuntimeRecord = vi.fn<
			NonNullable<GatewayManagerDependencies['writeGatewayRuntimeRecord']>
		>(async () => {});

		let caughtError: Error | undefined;
		try {
			await startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					gatewayReadinessMaxAttempts: 1,
					gatewayReadinessRetryDelayMs: 0,
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					managedVmImages: testManagedVmImages,
					writeGatewayRuntimeRecord,
				},
				'controller-internal',
				{ dispatchRuntimeReadiness: false },
			);
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			caughtError = error;
		}

		expect(caughtError?.message).toMatch(
			/Managed Gateway aggregate readiness timed out after 1 attempts.*Managed Gateway pre-containment diagnostics.*Framework log tail.*\[gateway log tail truncated\].*retained-diagnostic-sentinel.*Framework process identities.*agent-vm-gateway-runtime.*openclaw gateway.*Listening TCP sockets.*0100007F:4968/su,
		);
		expect(caughtError?.message).toContain('[REDACTED]');
		for (const rawCredentialValue of rawCredentialValues) {
			expect(caughtError?.message).not.toContain(rawCredentialValue);
		}
		expect(lifecycleEvents.at(0)).toBe('readiness');
		expect(lifecycleEvents.at(-1)).toBe('destroy');
		expect(lifecycleEvents.filter((event) => event === 'diagnostics')).toHaveLength(3);
		expect(start).toHaveBeenCalledOnce();
		expect(enableIngress).toHaveBeenCalledOnce();
		expect(ownership.destroyLive).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
		expect(writeGatewayRuntimeRecord).not.toHaveBeenCalled();
		expect(exec).toHaveBeenCalledTimes(4);
		expect(
			exec.mock.calls
				.map(([command]) => (typeof command === 'string' ? command : command.join(' ')))
				.join('\n'),
		).not.toMatch(/\b(?:bootstrap|nohup|serve|supervis(?:e|or))\b/u);
		expect(configureIngressRoutes).toHaveBeenLastCalledWith([]);
		expect(
			configureIngressRoutes.mock.calls.some(([routes]) =>
				routes.some((route) => route.port === 18_789),
			),
		).toBe(false);
	});

	it('retains bounded cleanup stages in managed Gateway containment logs without cleanup errors', async () => {
		const vmId = 'vm-managed-cleanup-stage-log';
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		const { configureIngressRoutes, managedVm } = createHealthyGatewayVmStub(vmId, 28_415);
		const writeLog =
			vi.fn<(level: 'info' | 'warning', telemetry?: ControllerDiagnosticTelemetry) => void>();
		configureIngressRoutes.mockImplementation((routes) => {
			if (routes.length === 0) {
				throw new Error('secret-bearing ingress cleanup detail');
			}
		});

		await expect(
			startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					writeLog,
					zoneId: 'shravan',
				},
				{
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					gatewayReadinessMaxAttempts: 1,
					gatewayReadinessRetryDelayMs: 0,
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					managedVmImages: testManagedVmImages,
				},
				'controller-internal',
				{ dispatchRuntimeReadiness: false },
			),
		).rejects.toThrow();

		const cleanupLog = writeLog.mock.calls.find(
			([, telemetry]) => telemetry?.operation === 'destroy-managed-gateway-cleanup-incomplete',
		);
		expect(cleanupLog).toEqual([
			'warning',
			{
				operation: 'destroy-managed-gateway-cleanup-incomplete',
				outcome: 'ingress-withdrawal',
				zoneId: 'shravan',
			},
		]);
		expect(JSON.stringify(writeLog.mock.calls)).not.toContain(
			'secret-bearing ingress cleanup detail',
		);
	});

	it('captures Tool Portal startup evidence before containing an initial control attachment failure', async () => {
		// Arrange
		const vmId = 'vm-managed-control-attachment-failure';
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		const { close, managedVm } = createHealthyGatewayVmStub(vmId, 28_413);
		const lifecycleEvents: string[] = [];
		let vmDestroyed = false;
		close.mockImplementation(async () => {
			vmDestroyed = true;
			lifecycleEvents.push('destroy');
		});
		const controlAttachmentError = new Error(
			'Gateway control credential readiness failed with HTTP 502 before the 3000ms deadline.',
		);
		const rawCredentialValues = [
			'op://agent-vm-testing/private-item/credential',
			'ops_service_account_value_123456789',
			'gateway-token-123',
		] as const;
		const diagnosticOutputs = {
			fatalEvidence: `{"kind":"fatal","detail":"${rawCredentialValues[0]}"}`,
			processes:
				'role=tool-portal pid=221 ppid=1 uid=0 command=agent-vm-gateway-runtime\nrole=openclaw pid=222 ppid=1 uid=0 command=openclaw gateway',
			readinessEvidence: `{"kind":"starting","token":"${rawCredentialValues[1]}"}`,
			sockets: 'table=/proc/net/tcp local=0100007F:496E state=LISTEN',
			toolPortalLog: `tool portal failed before bind: password=${rawCredentialValues[2]}`,
		} as const;
		const exec = vi.fn((command: Parameters<ManagedVm['exec']>[0]) => {
			lifecycleEvents.push('diagnostics');
			if (vmDestroyed) {
				throw new Error('VM already destroyed before diagnostic capture');
			}
			if (typeof command === 'string') {
				throw new Error(`Unexpected managed Gateway command '${command}'.`);
			}
			if (command[0] === 'tail') {
				return createManagedExecProcessStub({ stdout: diagnosticOutputs.toolPortalLog });
			}
			if (command[0] === 'sh' && command[2]?.includes('/proc/[0-9]*')) {
				return createManagedExecProcessStub({ stdout: diagnosticOutputs.processes });
			}
			if (command[0] === 'sh' && command[2]?.includes('/proc/net/tcp')) {
				return createManagedExecProcessStub({ stdout: diagnosticOutputs.sockets });
			}
			const evidencePath = command.at(-1);
			if (evidencePath?.endsWith('tool-portal.readiness.json')) {
				return createManagedExecProcessStub({ stdout: diagnosticOutputs.readinessEvidence });
			}
			if (evidencePath?.endsWith('tool-portal.fatal.json')) {
				return createManagedExecProcessStub({ stdout: diagnosticOutputs.fatalEvidence });
			}
			throw new Error(`Unexpected managed Gateway diagnostic command '${command.join(' ')}'.`);
		});
		managedVm.exec = exec;
		const connectGatewayControlSession = vi.fn<GatewayControlSessionConnector>(async () => {
			lifecycleEvents.push('control-attachment');
			throw controlAttachmentError;
		});
		const writeGatewayRuntimeRecord = vi.fn<
			NonNullable<GatewayManagerDependencies['writeGatewayRuntimeRecord']>
		>(async () => {});

		// Act
		let caughtError: Error | undefined;
		try {
			await startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					connectGatewayControlSession,
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					managedVmImages: testManagedVmImages,
					writeGatewayRuntimeRecord,
				},
				'controller-internal',
				{ dispatchRuntimeReadiness: false },
			);
		} catch (error) {
			if (!(error instanceof Error)) {
				throw error;
			}
			caughtError = error;
		}

		// Assert
		expect(caughtError).toBe(controlAttachmentError);
		expect(caughtError?.message).toMatch(
			/HTTP 502.*Managed Gateway pre-containment diagnostics.*Tool Portal log tail.*Tool Portal readiness evidence.*Tool Portal fatal evidence.*Framework process identities.*agent-vm-gateway-runtime.*openclaw.*Listening TCP sockets.*0100007F:496E/su,
		);
		expect(caughtError?.message).toContain('[REDACTED]');
		for (const rawCredentialValue of rawCredentialValues) {
			expect(caughtError?.message).not.toContain(rawCredentialValue);
		}
		expect(lifecycleEvents.at(0)).toBe('control-attachment');
		expect(lifecycleEvents.at(-1)).toBe('destroy');
		expect(lifecycleEvents.filter((event) => event === 'diagnostics')).toHaveLength(5);
		expect(ownership.destroyLive).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
		expect(writeGatewayRuntimeRecord).not.toHaveBeenCalled();
	});

	it('includes the exact aggregate containment reason in managed Gateway startup failures', async () => {
		const vmId = 'vm-managed-readiness-mismatch';
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		const { close, configureIngressRoutes, managedVm } = createHealthyGatewayVmStub(vmId, 28_412);
		const writeGatewayRuntimeRecord = vi.fn<
			NonNullable<GatewayManagerDependencies['writeGatewayRuntimeRecord']>
		>(async () => {});

		await expect(
			startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					managedVmImages: testManagedVmImages,
					writeGatewayRuntimeRecord,
				},
				'controller-internal',
				{ runtimeReadinessSemanticRevision: 'unexpected-semantic-revision' },
			),
		).rejects.toThrow(
			"Managed Gateway admission entered unexpected 'startup-contained' state: semantic-revision-mismatch.",
		);

		expect(ownership.destroyLive).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
		expect(configureIngressRoutes).toHaveBeenLastCalledWith([]);
		expect(writeGatewayRuntimeRecord).not.toHaveBeenCalled();
	});

	it('coalesces duplicate control-attempt logs without exposing transport identities', async () => {
		const vmId = 'vm-safe-control-attempt-log';
		const { managedVm } = createHealthyGatewayVmStub(vmId, 28_411);
		const writeLog =
			vi.fn<(level: 'info' | 'warning', telemetry?: ControllerDiagnosticTelemetry) => void>();
		let connectedMaterial: Parameters<GatewayControlSessionConnector>[0]['material'] | undefined;
		const connectGatewayControlSession = vi.fn<GatewayControlSessionConnector>(
			async (connectOptions) => {
				connectedMaterial = connectOptions.material;
				connectOptions.onAttemptOutcome?.({
					attachmentGeneration: 1,
					kind: 'connect_error',
				});
				connectOptions.onAttemptOutcome?.({
					attachmentGeneration: 2,
					kind: 'connect_error',
				});
				connectOptions.onAttemptOutcome?.({
					attachmentGeneration: 3,
					kind: 'hello_response',
					outcome: 'rejected',
				});
				connectOptions.onAttemptOutcome?.({
					attachmentGeneration: 4,
					kind: 'hello_response',
					outcome: 'rejected',
				});
				connectOptions.onAttemptOutcome?.({
					attachmentGeneration: 5,
					kind: 'hello_response',
					outcome: 'generation_mismatch',
				});
				connectOptions.onAttemptOutcome?.({
					attachmentGeneration: 6,
					kind: 'hello_response',
					outcome: 'generation_mismatch',
				});
				connectOptions.onAttemptOutcome?.({
					attachmentGeneration: 7,
					kind: 'hello_response',
					outcome: 'stale_attachment',
				});
				connectOptions.onAttemptOutcome?.({
					attachmentGeneration: 8,
					kind: 'hello_response',
					outcome: 'stale_attachment',
				});
				connectOptions.onAttemptOutcome?.({
					attachmentGeneration: 9,
					kind: 'hello_response',
					outcome: 'accepted',
				});
				connectOptions.onAttemptOutcome?.({
					attachmentGeneration: 10,
					kind: 'hello_response',
					outcome: 'accepted',
				});
				return await connectTestGatewayControlSession(connectOptions);
			},
		);

		await startGatewayZone(
			{
				createVmOwnership: createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId))
					.createVmOwnership,
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				writeLog,
				zoneId: 'shravan',
			},
			{
				connectGatewayControlSession,
				createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
				managedVmImages: testManagedVmImages,
			},
		);

		expect(writeLog.mock.calls).toEqual([
			[
				'warning',
				{
					operation: 'gateway-control-attachment-attempt',
					outcome: 'connect_error',
					zoneId: 'shravan',
				},
			],
			[
				'warning',
				{
					operation: 'gateway-control-attachment-attempt',
					outcome: 'hello_response:rejected',
					zoneId: 'shravan',
				},
			],
			[
				'warning',
				{
					operation: 'gateway-control-attachment-attempt',
					outcome: 'hello_response:generation_mismatch',
					zoneId: 'shravan',
				},
			],
			[
				'warning',
				{
					operation: 'gateway-control-attachment-attempt',
					outcome: 'hello_response:stale_attachment',
					zoneId: 'shravan',
				},
			],
			[
				'info',
				{
					operation: 'gateway-control-attachment-attempt',
					outcome: 'hello_response:accepted',
					zoneId: 'shravan',
				},
			],
		]);
		if (connectedMaterial === undefined) {
			throw new Error('Expected captured Gateway control material.');
		}
		const loggedOutput = JSON.stringify(writeLog.mock.calls);
		expect(loggedOutput).not.toContain(connectedMaterial.processEpoch);
		expect(loggedOutput).not.toContain(testControlConnectionId);
		expect(loggedOutput).not.toContain(testControlSessionId);
		expect(loggedOutput).not.toContain('gateway-token-123');
	});

	it('withdraws control and ingress before exact Gateway runner termination', async () => {
		const teardownEvents: string[] = [];
		let runnerAlive = true;
		const ingressCloseRelease = createDeferredPromise<void>();
		const controlSessionClose = vi.fn(() => {
			teardownEvents.push('control-session-close');
		});
		const ingressClose = vi.fn(async () => {
			teardownEvents.push('ingress-close-start');
			await ingressCloseRelease.promise;
			teardownEvents.push('ingress-close-complete');
		});
		const vmClose = vi.fn(async () => {
			teardownEvents.push('vm-close');
		});
		const { managedVm } = createHealthyGatewayVmStub('vm-ingress-close-order', 28_294);
		managedVm.close = vmClose;
		managedVm.enableIngress = vi.fn(async () => ({
			close: ingressClose,
			host: '127.0.0.1',
			port: 18791,
		}));
		managedVm.getHostProcessId = vi.fn(() => (runnerAlive ? 28_294 : null));
		const connectGatewayControlSession = vi.fn<GatewayControlSessionConnector>(
			async (connectOptions) => ({
				...(await connectTestGatewayControlSession(connectOptions)),
				close: controlSessionClose,
			}),
		);

		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				connectGatewayControlSession,
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
				managedVmExactProcessTermination: {
					terminateRecordedHostProcess: async ({ identity }) => {
						if (!runnerAlive) {
							return { hostProcessId: identity.hostProcessId, kind: 'already-absent' };
						}
						teardownEvents.push('runner-termination');
						runnerAlive = false;
						return { hostProcessId: identity.hostProcessId, kind: 'terminated' };
					},
				},
				managedVmTerminationSleep: async () => {},
			},
		);

		requireManagedGatewayResult(result).controlSession?.close();
		const gatewayTermination = result.destroyGateway();
		await flushPendingEventLoopWork();
		expect(teardownEvents).not.toContain('runner-termination');
		ingressCloseRelease.resolve();
		await gatewayTermination;
		await result.destroyGateway();

		expect(teardownEvents[0]).toBe('control-session-close');
		expect(teardownEvents.indexOf('ingress-close-complete')).toBeLessThan(
			teardownEvents.indexOf('runner-termination'),
		);
		expect(teardownEvents).toContain('vm-close');
		expect(ingressClose).toHaveBeenCalledOnce();
		expect(vmClose).toHaveBeenCalledOnce();
	});

	it('passes configured gateway ingress timeouts to Gondolin', async () => {
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const managedVm: ManagedVm = {
			id: 'vm-123',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-123')),
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn((command: string) =>
				createManagedExecProcessStub({
					stdout: command.includes('curl -sS -o /dev/null -w "%{http_code}"') ? '200' : '',
				}),
			),
			getHostProcessId: vi.fn(() => 28282),
			configureIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('expected OpenClaw test zone');
		}
		const systemConfigWithIngressTimeouts: LoadedSystemConfig = {
			...systemConfig,
			zones: [
				{
					...zone,
					gateway: {
						...zone.gateway,
						ingress: {
							upstreamHeaderTimeoutMs: 5_000,
							upstreamResponseTimeoutMs: 120_000,
						},
					},
				},
			],
		};

		await startGatewayZone(
			{
				runTask: async (_title, fn) => {
					await fn();
				},
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: systemConfigWithIngressTimeouts,
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fingerprint-123',
						imageReference: '/tmp/gateway-image',
					})),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
			},
		);

		expect(enableIngressMock).toHaveBeenCalledWith({
			allowWebSockets: true,
			bufferResponseBody: false,
			listenPort: 18791,
			upstreamHeaderTimeoutMs: 5_000,
			upstreamResponseTimeoutMs: 120_000,
		});
	});

	it('omits unset gateway ingress response timeout when only header timeout is configured', async () => {
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const managedVm: ManagedVm = {
			id: 'vm-123',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-123')),
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn((command: string) =>
				createManagedExecProcessStub({
					stdout: command.includes('curl -sS -o /dev/null -w "%{http_code}"') ? '200' : '',
				}),
			),
			getHostProcessId: vi.fn(() => 28282),
			configureIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('expected OpenClaw test zone');
		}
		const systemConfigWithHeaderTimeout: LoadedSystemConfig = {
			...systemConfig,
			zones: [
				{
					...zone,
					gateway: {
						...zone.gateway,
						ingress: {
							upstreamHeaderTimeoutMs: 5_000,
						},
					},
				},
			],
		};

		await startGatewayZone(
			{
				runTask: async (_title, fn) => {
					await fn();
				},
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: systemConfigWithHeaderTimeout,
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fingerprint-123',
						imageReference: '/tmp/gateway-image',
					})),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
			},
		);

		expect(enableIngressMock).toHaveBeenCalledWith({
			allowWebSockets: true,
			bufferResponseBody: false,
			listenPort: 18791,
			upstreamHeaderTimeoutMs: 5_000,
		});
	});

	it('omits unset gateway ingress header timeout when only response timeout is configured', async () => {
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const managedVm: ManagedVm = {
			id: 'vm-123',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-123')),
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn((command: string) =>
				createManagedExecProcessStub({
					stdout: command.includes('curl -sS -o /dev/null -w "%{http_code}"') ? '200' : '',
				}),
			),
			getHostProcessId: vi.fn(() => 28282),
			configureIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('expected OpenClaw test zone');
		}
		const systemConfigWithResponseTimeout: LoadedSystemConfig = {
			...systemConfig,
			zones: [
				{
					...zone,
					gateway: {
						...zone.gateway,
						ingress: {
							upstreamResponseTimeoutMs: 120_000,
						},
					},
				},
			],
		};

		await startGatewayZone(
			{
				runTask: async (_title, fn) => {
					await fn();
				},
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: systemConfigWithResponseTimeout,
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fingerprint-123',
						imageReference: '/tmp/gateway-image',
					})),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
			},
		);

		expect(enableIngressMock).toHaveBeenCalledWith({
			allowWebSockets: true,
			bufferResponseBody: false,
			listenPort: 18791,
			upstreamResponseTimeoutMs: 120_000,
		});
	});

	it('does not clean orphaned gateway runtime before rejecting invalid OpenClaw Tool VM requirements', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		await writeFile(
			zone.gateway.config,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: {
							backend: 'host',
							mode: 'all',
							scope: 'agent',
							workspaceAccess: 'rw',
						},
						workspace: '/zone/agents/default',
					},
					list: [],
				},
			}),
			'utf8',
		);
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imageReference: '/tmp/img',
		}));

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({}),
					systemConfig,
					zoneId: 'shravan',
				},
				{
					managedVmFactory: unexpectedManagedVmFactory,
					managedVmImages: { prepareImage: buildImage },
				},
			),
		).rejects.toThrow("OpenClaw zone 'shravan' Tool VM requirements failed");

		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(buildImage).not.toHaveBeenCalled();
	});

	it('does not build the gateway image when secret preflight fails', async () => {
		const systemConfig = await createSystemConfig();
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imageReference: '/tmp/img',
		}));
		const secretResolver: SecretResolver = {
			resolve: async () => {
				throw new Error('Failed to resolve zone secrets: op failed');
			},
			resolveAll: async () => {
				throw new Error('Failed to resolve zone secrets: op failed');
			},
		};

		await expect(
			startGatewayZone(
				{
					secretResolver,
					systemConfig,
					zoneId: 'shravan',
				},
				{
					managedVmFactory: unexpectedManagedVmFactory,
					managedVmImages: { prepareImage: buildImage },
				},
			),
		).rejects.toThrow('Failed to resolve zone secrets: op failed');

		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(buildImage).not.toHaveBeenCalled();
	});

	it('rejects invalid OpenClaw Tool VM requirements during protected restart preflight', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		await writeFile(
			zone.gateway.config,
			JSON.stringify({
				agents: {
					defaults: {
						sandbox: {
							backend: 'host',
							mode: 'all',
							scope: 'agent',
							workspaceAccess: 'rw',
						},
						workspace: '/zone/agents/default',
					},
					list: [],
				},
			}),
			'utf8',
		);

		await expect(
			preflightGatewayZoneStart(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'resolved-discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
						PERPLEXITY_API_KEY: 'resolved-perplexity-key',
					}),
					systemConfig,
					zoneId: 'shravan',
				},
				{ managedVmImages: testManagedVmImages },
			),
		).rejects.toThrow("OpenClaw zone 'shravan' Tool VM requirements failed");
	});

	it('does not consult legacy cleanup or create a gateway VM when OpenClaw image build fails', async () => {
		const systemConfig = await createSystemConfig();
		const buildError = new Error('gateway image build failed');
		const taskTitles: string[] = [];
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => {
			throw new Error('createManagedVm should not run after image build fails');
		});
		const buildImage = vi.fn(async () => {
			throw buildError;
		});

		await expect(
			startGatewayZone(
				{
					runTask: async (title, run) => {
						taskTitles.push(title);
						await run();
					},
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'resolved-discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
						PERPLEXITY_API_KEY: 'resolved-perplexity-key',
					}),
					systemConfig,
					zoneId: 'shravan',
				},
				{
					managedVmImages: { prepareImage: buildImage },
					managedVmFactory: { createManagedVm },
				},
			),
		).rejects.toBe(buildError);

		expect(buildImage).toHaveBeenCalledOnce();
		expect(taskTitles).not.toContain('Materializing Tool Portal runtime');
		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('starts mutating Tool Portal materialization only after image preparation completes', async () => {
		const systemConfig = await createSystemConfig();
		const imageBuildEntered = createDeferredPromise<void>();
		const releaseImageBuild = createDeferredPromise<ManagedVmImageBuildResult>();
		const taskEvents: string[] = [];
		const { managedVm } = createHealthyGatewayVmStub('vm-materialization-order', 28_412);

		const startPromise = startGatewayZone(
			{
				runTask: async (title, run) => {
					taskEvents.push(`${title}:start`);
					await run();
					taskEvents.push(`${title}:complete`);
				},
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'resolved-discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					PERPLEXITY_API_KEY: 'resolved-perplexity-key',
				}),
				systemConfig,
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => {
						imageBuildEntered.resolve();
						return await releaseImageBuild.promise;
					}),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
			},
		);

		await imageBuildEntered.promise;
		expect(taskEvents).not.toContain('Materializing Tool Portal runtime:start');

		releaseImageBuild.resolve({
			built: true,
			fingerprint: 'materialization-order-image',
			imageReference: '/tmp/materialization-order-image',
		});
		await startPromise;

		expect(taskEvents.indexOf('Building gateway image:complete')).toBeLessThan(
			taskEvents.indexOf('Materializing Tool Portal runtime:start'),
		);
	});

	it('surfaces OpenClaw secret failure before image build', async () => {
		const systemConfig = await createSystemConfig();
		const secretResolver: SecretResolver = {
			resolve: async () => {
				throw new Error('Failed to resolve zone secrets: op failed');
			},
			resolveAll: async () => {
				throw new Error('Failed to resolve zone secrets: op failed');
			},
		};
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imageReference: '/tmp/img',
		}));

		await expect(
			startGatewayZone(
				{
					secretResolver,
					systemConfig,
					zoneId: 'shravan',
				},
				{
					managedVmFactory: unexpectedManagedVmFactory,
					managedVmImages: { prepareImage: buildImage },
				},
			),
		).rejects.toThrow(
			"Failed to resolve zone secrets for zone 'shravan': Failed to resolve zone secrets: op failed",
		);

		expect(preflightOrphanedGatewayCleanupIfPresentMock).not.toHaveBeenCalled();
		expect(buildImage).not.toHaveBeenCalled();
	});

	it('skips host observability readiness before gateway startup when no OpenClaw zone opted in', async () => {
		const systemConfig = createObservabilitySystemConfig(await createSystemConfig(), {
			controllerStartPolicy: 'require-ready',
		});
		const taskTitles: string[] = [];
		const checkObservabilityStackReadiness = vi.fn(async () => ({
			ok: false as const,
			reason: 'collector health check failed: connection refused',
			status: 'unavailable' as const,
		}));
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imageReference: '/tmp/img',
		}));
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => {
			throw new Error('createManagedVm should not be called');
		});

		await expect(
			startGatewayZone(
				{
					runTask: async (title, fn) => {
						taskTitles.push(title);
						await fn();
					},
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'resolved-discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
						PERPLEXITY_API_KEY: 'resolved-perplexity-key',
					}),
					systemConfig,
					zoneId: 'shravan',
				},
				{
					managedVmImages: { prepareImage: buildImage },
					checkObservabilityStackReadiness,
					managedVmFactory: { createManagedVm },
				},
			),
		).rejects.toThrow('createManagedVm should not be called');

		expect(taskTitles).not.toContain('Preflighting gateway runtime ownership');
		expect(taskTitles).not.toContain('Cleaning orphaned gateway runtime');
		expect(taskTitles).not.toContain('Checking host observability stack');
		expect(checkObservabilityStackReadiness).not.toHaveBeenCalled();
		expect(buildImage).toHaveBeenCalled();
		expect(createManagedVm).toHaveBeenCalled();
	});

	it('routes OpenClaw zone observability through mediated HTTP without collector tcpHosts', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return new Response('collector-response', {
				headers: {
					'content-type': 'application/x-protobuf',
					'retry-after': '2',
					'set-cookie': 'must-not-reach-guest=true',
				},
				status: 200,
			});
		});
		const systemConfig = createObservabilitySystemConfig(await createSystemConfig(), {
			controllerStartPolicy: 'off',
			zoneEnabled: true,
		});
		const createManagedVm = vi.fn(
			async (_options: GatewayManagedVmFactoryOptions): Promise<ManagedVm> => {
				throw new Error('stop after vm options');
			},
		);

		try {
			await expect(
				startGatewayZone(
					{
						secretResolver: createOpenClawSecretResolver({
							DISCORD_BOT_TOKEN: 'resolved-discord-token',
							OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
							PERPLEXITY_API_KEY: 'resolved-perplexity-key',
						}),
						systemConfig,
						zoneId: 'shravan',
					},
					{
						managedVmImages: {
							prepareImage: vi.fn(async () => ({
								built: true,
								fingerprint: 'fp',
								imageReference: '/tmp/img',
							})),
						},
						managedVmFactory: { createManagedVm },
					},
				),
			).rejects.toThrow('stop after vm options');

			const vmOptions = createManagedVm.mock.calls[0]?.[0];
			if (vmOptions === undefined) {
				throw new Error('Expected gateway VM creation call.');
			}
			expect(vmOptions.allowedHosts).toContain('otel-collector.observability.vm.host');
			expect(vmOptions.allowedHosts).not.toContain('127.0.0.1');
			expect(vmOptions.mediation).not.toHaveProperty('internalDestinations');
			expect(vmOptions.tcpHosts).toEqual([
				{ guestHost: 'tool-0.vm.host:22', target: '127.0.0.1:19000' },
				{ guestHost: 'tool-1.vm.host:22', target: '127.0.0.1:19001' },
				{ guestHost: 'tool-2.vm.host:22', target: '127.0.0.1:19002' },
				{ guestHost: 'tool-3.vm.host:22', target: '127.0.0.1:19003' },
				{ guestHost: 'tool-4.vm.host:22', target: '127.0.0.1:19004' },
			]);
			expect(vmOptions.tcpHosts).not.toContainEqual({
				guestHost: 'otel-collector.observability.vm.host:4318',
				target: '127.0.0.1:4318',
			});
			expect(vmOptions.mediation?.onRequest).toEqual(expect.any(Function));
			const otlpSignalRequests = [
				['/v1/traces', 'trace-payload'],
				['/v1/metrics', 'metric-payload'],
				['/v1/logs', 'log-payload'],
			] as const;
			await Promise.all(
				otlpSignalRequests.map(async ([signalPath, payload]) => {
					const mediatedResponse = await vmOptions.mediation?.onRequest?.(
						new Request(`http://otel-collector.observability.vm.host:4318${signalPath}`, {
							body: payload,
							headers: {
								authorization: 'Bearer must-not-forward',
								'content-type': 'application/x-protobuf',
							},
							method: 'POST',
						}),
					);
					if (!(mediatedResponse instanceof Response)) {
						throw new Error(`Expected ${signalPath} request to return a Response.`);
					}
					expect(mediatedResponse.status).toBe(200);
					expect(await mediatedResponse.text()).toBe('collector-response');
					expect(Object.fromEntries(mediatedResponse.headers)).toEqual({
						'content-type': 'application/x-protobuf',
						'retry-after': '2',
					});
				}),
			);
			expect(fetchMock).toHaveBeenCalledTimes(3);
			for (const [callIndex, signalPath] of [
				[0, '/v1/traces'],
				[1, '/v1/metrics'],
				[2, '/v1/logs'],
			] as const) {
				const [targetUrl, requestInit] = fetchMock.mock.calls[callIndex] ?? [];
				expect(targetUrl).toBe(`http://127.0.0.1:4318${signalPath}`);
				expect(requestInit).toEqual(
					expect.objectContaining({
						duplex: 'half',
						headers: new Headers({ 'content-type': 'application/x-protobuf' }),
						method: 'POST',
						redirect: 'manual',
						signal: expect.any(AbortSignal),
					}),
				);
			}

			const directTargetRequest = await vmOptions.mediation?.onRequest?.(
				new Request('http://127.0.0.1:4318/v1/traces', {
					body: 'direct-target-payload',
					headers: { 'content-type': 'application/x-protobuf' },
					method: 'POST',
				}),
			);
			expect(directTargetRequest).toBeInstanceOf(Response);
			expect((directTargetRequest as Response).status).toBe(403);
			expect(fetchMock).toHaveBeenCalledTimes(3);
		} finally {
			fetchMock.mockRestore();
		}
	});

	it('rejects OpenClaw collector tcpHosts overrides that bypass mediated observability', async () => {
		const systemConfig = createObservabilitySystemConfig(await createSystemConfig(), {
			controllerStartPolicy: 'off',
			zoneEnabled: true,
		});
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => {
			throw new Error('createManagedVm should not be called');
		});

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'resolved-discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
						PERPLEXITY_API_KEY: 'resolved-perplexity-key',
					}),
					systemConfig,
					tcpHostsOverride: {
						'otel-collector.observability.vm.host:4318': '127.0.0.1:4318',
					},
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					managedVmFactory: { createManagedVm },
				},
			),
		).rejects.toThrow(
			"Managed Gateway tcpHostsOverride cannot map observability collector host 'otel-collector.observability.vm.host'",
		);
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('rejects Hermes collector tcpHosts overrides that bypass mediated observability', async () => {
		const systemConfig = await createHermesSystemConfig();
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => {
			throw new Error('createManagedVm should not be called');
		});

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({}),
					systemConfig,
					tcpHostsOverride: {
						'otel-collector.observability.vm.host:4318': '127.0.0.1:4318',
					},
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					managedVmFactory: { createManagedVm },
				},
			),
		).rejects.toThrow(
			"Managed Gateway tcpHostsOverride cannot map observability collector host 'otel-collector.observability.vm.host'",
		);
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('preflights lifecycle host state without OpenClaw observability before protected restart image work', async () => {
		const systemConfig = createObservabilitySystemConfig(await createSystemConfig(), {
			controllerStartPolicy: 'require-ready',
		});
		const preflightHostState = vi.fn(async () => {});
		const buildImage = vi.fn(async () => ({
			built: true,
			fingerprint: 'fp',
			imageReference: '/tmp/img',
		}));

		await preflightGatewayZoneStart(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'resolved-discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					PERPLEXITY_API_KEY: 'resolved-perplexity-key',
				}),
				systemConfig,
				zoneId: 'shravan',
			},
			{
				checkObservabilityStackReadiness: vi.fn(async () => ({
					ok: true as const,
					status: 'ready' as const,
				})),
				managedVmImages: {
					prepareImage: async () => {
						const result = await buildImage();
						return result;
					},
				},
				loadGatewayLifecycle: () => ({
					...loadGatewayLifecycle('openclaw'),
					preflightHostState,
				}),
			},
		);

		expect(preflightHostState).toHaveBeenCalledWith(
			expect.not.objectContaining({ observability: expect.anything() }),
			expect.any(Object),
		);
		expect(buildImage).toHaveBeenCalled();
	});

	it('does not invoke legacy PID cleanup for OpenClaw zones after ownership reconciliation', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-tool-cleanup',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-tool-cleanup')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28301),
			configureIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
			},
		);

		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
	});

	it('does not preflight or mutate legacy OpenClaw runtime records before exact ownership boot', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-ordered-recovery',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-ordered-recovery')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28303),
			configureIngressRoutes: vi.fn(),
		};
		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
			},
		);

		expect(preflightOrphanedGatewayCleanupIfPresentMock).not.toHaveBeenCalled();
		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
	});

	it('starts one Worker gateway VM without legacy cleanup phases', async () => {
		const systemConfig = await createSystemConfig();
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
				secrets: {
					OPENAI_API_KEY: {
						source: '1password' as const,
						ref: 'op://agent-vm/shravan-openai/credential',
						injection: 'http-mediation' as const,
						audience: 'gateway' as const,
						hosts: ['api.openai.com'],
					},
				},
			})),
		};
		const secretResolver: SecretResolver = {
			resolve: async () => 'openai-key',
			resolveAll: async () => ({ OPENAI_API_KEY: 'openai-key' }),
		};
		const taskTitles: string[] = [];
		const exec = vi.fn(() => createManagedExecProcessStub({ stdout: '200' }));
		const managedVm: ManagedVm = {
			close: vi.fn(async () => completeGatewayVmClose('worker-vm-no-legacy-cleanup')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(),
			exec,
			getHostProcessId: vi.fn(() => 12346),
			id: 'worker-vm-no-legacy-cleanup',
			start: vi.fn(async () => {}),
			configureIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async () => managedVm);
		const writeGatewayRuntimeRecord = vi.fn<
			NonNullable<GatewayManagerDependencies['writeGatewayRuntimeRecord']>
		>(async () => {});

		const result = await startGatewayZone(
			{
				runTask: async (title, run) => {
					taskTitles.push(title);
					await run();
				},
				secretResolver,
				systemConfig: workerSystemConfig,
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp-worker',
						imageReference: '/tmp/worker-image',
					})),
				},
				managedVmFactory: { createManagedVm },
				writeGatewayRuntimeRecord,
			},
		);

		const workerResult = requireDirectProcessGatewayResult(result);
		expect(workerResult.vm).not.toBe(managedVm);
		expect(workerResult.vm).toMatchObject({ id: managedVm.id });
		expect(workerResult.vm).not.toHaveProperty('close');
		expect(workerResult.vm).not.toHaveProperty('configureIngressRoutes');
		expect(workerResult.vm).not.toHaveProperty('enableIngress');
		expect(workerResult.vm).not.toHaveProperty('start');
		expect(workerResult.processSpec).toEqual(expectedWorkerProcessSpec);
		expect(exec).toHaveBeenNthCalledWith(1, expectedWorkerProcessSpec.bootstrapCommand);
		expect(exec).toHaveBeenNthCalledWith(2, expectedWorkerProcessSpec.startCommand);
		expect(exec).toHaveBeenNthCalledWith(
			3,
			'curl -sS -o /dev/null -w "%{http_code}" --max-time 2 http://127.0.0.1:18789/health 2>/dev/null || true',
		);
		expect(createManagedVm).toHaveBeenCalledOnce();
		expect(taskTitles).not.toContain('Preflighting gateway runtime ownership');
		expect(taskTitles).not.toContain('Cleaning orphaned gateway runtime');
		expect(cleanupOrphanedToolVmsIfPresentMock).not.toHaveBeenCalled();
		expect(preflightOrphanedGatewayCleanupIfPresentMock).not.toHaveBeenCalled();
		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(writeGatewayRuntimeRecord).toHaveBeenCalledTimes(2);
		for (const [writtenTarget, writtenRecord] of writeGatewayRuntimeRecord.mock.calls) {
			expect(writtenTarget).toEqual(
				resolveTestWorkerRuntimeRecordTarget({
					systemConfig: workerSystemConfig,
					zoneId: 'shravan',
				}),
			);
			expect(writtenRecord).toMatchObject({
				runtimeKind: 'worker-direct-process',
				taskId: testWorkerTaskId,
				zoneId: 'shravan',
			});
		}
	});

	it('resolves only gateway audience secrets while starting the gateway VM', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-gateway-only',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-gateway-only')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28286),
			configureIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected gateway test system config to include a zone.');
		}
		zone.secrets.LINEAR_API_KEY = {
			source: '1password',
			ref: 'op://agent-vm/shravan-linear/credential',
			injection: 'http-mediation',
			audience: 'tool-vm',
			hosts: ['api.linear.app'],
			agentAccess: 'all',
		};
		zone.egressHosts = [...zone.egressHosts, { host: 'api.linear.app', audience: 'tool-vm' }];
		const createManagedVm = vi.fn(
			async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'pplx-key',
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.not.arrayContaining(['api.linear.app']),
				environment: expect.not.objectContaining({
					LINEAR_API_KEY: expect.any(String),
				}),
				mediatedSecrets: expect.not.arrayContaining([
					expect.objectContaining({ environmentVariable: 'LINEAR_API_KEY' }),
				]),
			}),
		);
	});

	it('materializes the thin Tool Portal adapter into protected framework boot input', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, undefined, { portalAgentId: 'shravan' });
		let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
		const preflightHostState = vi.fn(
			async (_zone: GatewayZoneConfig, _secretResolver: SecretResolver) => {},
		);
		const prepareHostState = vi.fn(
			async (_zone: GatewayZoneConfig, _secretResolver: SecretResolver) => {},
		);
		const managedVm: ManagedVm = {
			id: 'vm-mcp',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28290),
			configureIngressRoutes: vi.fn(),
		};

		await startGatewayZone(
			{
				runtimePluginConfigs: {
					'observability-test-plugin': { enabled: true },
				},
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					agents: [{ id: 'shravan' }],
					toolPortal: createGatewayZoneToolPortalConfig(configDir),
				},
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: {
					createManagedVm: vi.fn(async (createRequest) => {
						managedVmCreateRequest = createRequest;
						return managedVm;
					}),
				},
				loadGatewayLifecycle: () => ({
					...loadGatewayLifecycle('openclaw'),
					preflightHostState,
					prepareHostState,
				}),
			},
		);

		const preflightLifecycleZone = preflightHostState.mock.calls[0]?.[0];
		const preparedLifecycleZone = prepareHostState.mock.calls[0]?.[0];
		expect(preflightLifecycleZone).toBeDefined();
		expect(preflightLifecycleZone).toHaveProperty(
			'runtimePluginConfigs.observability-test-plugin.enabled',
			true,
		);
		expect(preflightLifecycleZone).not.toHaveProperty('runtimePluginConfigs.gondolin.toolPortal');
		expect(preparedLifecycleZone).toBeDefined();
		expect(preparedLifecycleZone).toHaveProperty(
			'runtimePluginConfigs.observability-test-plugin.enabled',
			true,
		);
		expect(preparedLifecycleZone).toHaveProperty(
			'runtimePluginConfigs.gondolin.toolPortal.attachment.clientKind',
			'openclaw-managed-plugin',
		);
		const protectedFrameworkConfig = parseJsonObject(
			requireManagedGatewayBootInputFile(
				managedVmCreateRequest,
				managedGatewayBootInputPaths.structuredRoot,
				'framework-service.json',
			),
		);
		const pluginsConfig = requireObjectProperty(protectedFrameworkConfig, 'plugins');
		const pluginEntries = requireObjectProperty(pluginsConfig, 'entries');
		const gondolinEntry = requireObjectProperty(pluginEntries, 'gondolin');
		const gondolinConfig = requireObjectProperty(gondolinEntry, 'config');
		const toolPortalConfig = requireObjectProperty(gondolinConfig, 'toolPortal');
		expect(toolPortalConfig).toMatchObject({
			agentProjections: {
				shravan: {
					agentId: 'shravan',
					frameworkIdentity: { agentId: 'shravan', kind: 'openclaw' },
					profileAssignmentRevision: expect.any(String),
					toolPortalProfileId: 'default',
				},
			},
			attachment: {
				clientKind: 'openclaw-managed-plugin',
				configuredAgentIds: ['shravan'],
				protocolVersion: 1,
				projectionCohortDigest: expect.stringMatching(/^projection-cohort:[a-f0-9]{64}$/u),
				schemaVersion: 1,
			},
		});
		expect(gondolinConfig).not.toHaveProperty('controlSession');
		expect(toolPortalConfig).not.toHaveProperty('configDir');
		expect(
			requireObjectProperty(requireObjectProperty(protectedFrameworkConfig, 'mcp'), 'servers'),
		).toEqual({});
	});

	it('writes the strict Gateway runtime portal admission artifact during authoritative zone startup', async () => {
		// Arrange
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		const resolvedSecretValue = 'resolved-admission-secret-value';
		const secretRef = 'op://agent-vm/testing/gateway-runtime-admission-secret';
		await writeMinimalMcpPortalConfigs(
			configDir,
			{
				providers: {
					secret_provider: {
						kind: 'mcp',
						namespace: 'secret_provider',
						secretPolicies: {
							AUTHORIZATION: {
								hosts: ['api.example.test'],
								injection: 'http-mediation',
							},
						},
						transport: {
							headers: {
								AUTHORIZATION: { ref: secretRef, source: '1password' },
							},
							kind: 'streamable-http',
							url: 'https://api.example.test/mcp',
						},
					},
				},
				schemaVersion: 1,
			},
			{ portalAgentId: 'shravan' },
		);
		const { managedVm } = createHealthyGatewayVmStub('vm-portal-admission', 28_293);
		const toolPortal = createGatewayZoneToolPortalConfig(configDir);
		const admissionFilePath = path.join(
			systemConfig.cacheDir,
			'gateways',
			baseZone.id,
			'tool-portal-effective',
			GATEWAY_RUNTIME_PORTAL_ADMISSION_FILE_NAME,
		);

		// Act
		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					[secretRef]: resolvedSecretValue,
				}),
				systemConfig,
				zoneId: baseZone.id,
				zoneOverride: {
					...baseZone,
					agents: [{ id: 'shravan' }],
					toolPortal,
				},
			},
			{
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
				managedVmImages: testManagedVmImages,
			},
		);
		const serializedAdmissionMaterial = await readFile(admissionFilePath, 'utf8');
		const admissionMaterial = GatewayRuntimePortalAdmissionMaterialSchema.parse(
			JSON.parse(serializedAdmissionMaterial),
		);

		// Assert
		expect(serializedAdmissionMaterial).not.toContain(resolvedSecretValue);
		expect(admissionMaterial.semanticSnapshot.desiredRevision).toBe(
			admissionMaterial.semanticSnapshot.activeRevision,
		);
		const admittedAgentIds = Object.keys(admissionMaterial.semanticSnapshot.agentProjections);
		const admittedAgent = admissionMaterial.semanticSnapshot.agentProjections.shravan;
		expect(admittedAgentIds).toEqual(['shravan']);
		expect(admittedAgent?.agentId).toBe('shravan');
		expect(admittedAgent?.frameworkIdentity).toEqual({ agentId: 'shravan', kind: 'openclaw' });
		expect(admittedAgent?.toolPortalProfileId).toBe('default');
		expect(admittedAgent?.profileAssignmentRevision).toMatch(/^profile-assignment:[a-f0-9]{64}$/u);
		expect(admissionMaterial.semanticSnapshot.projectionCohortDigest).toMatch(
			/^projection-cohort:[a-f0-9]{64}$/u,
		);
		expect(admissionMaterial.effectiveToolPortalConfig).toEqual({
			agents: { shravan: { profile: 'default' } },
			mode: 'managed',
			profiles: { default: { namespaces: {} } },
			schemaVersion: 1,
		});
	});

	it('materializes one workspace root for every managed Gateway agent', async () => {
		// Arrange
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const agentIds = ['main', 'second'] as const;
		const zoneFilesDir = zone.gateway.zoneFilesDir;
		const stateSentinelPath = path.join(zone.gateway.stateDir, 'preserved-state.txt');
		const controllerStateSentinelPath = path.join(
			systemConfig.controllerStateDir,
			'preserved-controller-state.txt',
		);
		await Promise.all([
			mkdir(zone.gateway.stateDir, { recursive: true }),
			mkdir(systemConfig.controllerStateDir, { recursive: true }),
		]);
		await Promise.all([
			writeFile(stateSentinelPath, 'state-preserved\n', 'utf8'),
			writeFile(controllerStateSentinelPath, 'controller-state-preserved\n', 'utf8'),
		]);
		const toolPortalConfigDir = path.dirname(zone.gateway.config);
		await writeFile(
			path.join(toolPortalConfigDir, 'tool-portal.config.jsonc'),
			JSON.stringify({
				agents: {
					main: { profile: 'default' },
					second: { profile: 'default' },
				},
				mode: 'managed',
				profiles: { default: { namespaces: {} } },
				schemaVersion: 1,
			}),
			'utf8',
		);
		const { managedVm } = createHealthyGatewayVmStub('vm-managed-agent-workspaces', 28_294);

		// Act
		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token',
					PERPLEXITY_API_KEY: 'perplexity-key',
				}),
				systemConfig,
				zoneId: zone.id,
				zoneOverride: { ...zone, agents: agentIds.map((agentId) => ({ id: agentId })) },
			},
			{
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
				managedVmImages: testManagedVmImages,
			},
		);

		// Assert
		expect((await readdir(path.join(zoneFilesDir, 'agents'))).toSorted()).toEqual(agentIds);
		const managedAgentWorkspaceStats = await Promise.all(
			agentIds.map((agentId) => stat(path.join(zoneFilesDir, 'agents', agentId))),
		);
		expect(managedAgentWorkspaceStats.every((workspaceStats) => workspaceStats.isDirectory())).toBe(
			true,
		);
		await expect(stat(path.join(zone.gateway.zoneRuntimeDir, 'gitdirs'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
		expect(await readFile(stateSentinelPath, 'utf8')).toBe('state-preserved\n');
		expect(await readFile(controllerStateSentinelPath, 'utf8')).toBe(
			'controller-state-preserved\n',
		);
		expect(result.zone.gateway.stateDir).toBe(zone.gateway.stateDir);
		expect(path.relative(systemConfig.controllerStateDir, zoneFilesDir)).toMatch(/^\.\./u);
		expect(path.relative(zone.gateway.stateDir, zoneFilesDir)).toMatch(/^\.\./u);
	});

	it('rejects a shared workspace Git push profile assigned to a local-mode agent', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeFile(
			path.join(configDir, 'tool-portal.config.jsonc'),
			JSON.stringify({
				agents: {
					'local-agent': { profile: 'default' },
					main: { profile: 'default' },
				},
				mode: 'managed',
				profiles: {
					default: {
						namespaces: {
							controller_execution: {
								backend: {
									kind: 'controller_execution',
									operations: {
										controller_host_probe: { kind: 'registered_action' },
										workspace_git_push: { kind: 'registered_action' },
										push_branch: { kind: 'registered_action' },
										protected_uds: { kind: 'registered_action' },
									},
								},
								calls: {
									requiresApproval: { allow: [] },
									withoutApproval: { allow: ['workspace_git_push'] },
								},
								tools: { allow: ['workspace_git_push'] },
							},
						},
					},
				},
				schemaVersion: 1,
			}),
			'utf8',
		);

		await expect(
			preflightGatewayZoneStart(
				{
					prebuiltImage: {
						built: false,
						fingerprint: 'fingerprint',
						imageReference: '/tmp/gateway-image',
					},
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'resolved-discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
						PERPLEXITY_API_KEY: 'resolved-perplexity-key',
					}),
					systemConfig,
					zoneId: baseZone.id,
					zoneOverride: {
						...baseZone,
						agents: [
							...(baseZone.agents ?? []),
							{ id: 'local-agent', workspaceGit: { mode: 'local' as const } },
						],
					},
				},
				{ managedVmImages: testManagedVmImages },
			),
		).rejects.toThrow(
			/managed agent "local-agent" assigned profile "default" cannot allow workspace_git_push/u,
		);
	});

	it('does not write MCP Portal effective config files during protected restart preflight', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, undefined, { portalAgentId: 'shravan' });
		const effectiveConfigDir = path.join(
			systemConfig.cacheDir,
			'gateways',
			baseZone.id,
			'tool-portal-effective',
		);

		await preflightGatewayZoneStart(
			{
				prebuiltImage: {
					built: false,
					fingerprint: 'fingerprint',
					imageReference: '/tmp/gateway-image',
				},
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'resolved-discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					PERPLEXITY_API_KEY: 'resolved-perplexity-key',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					agents: [{ id: 'shravan' }],
					toolPortal: createGatewayZoneToolPortalConfig(configDir),
				},
			},
			{ managedVmImages: testManagedVmImages },
		);

		await expect(readdir(effectiveConfigDir)).resolves.toEqual([]);
	});

	it('deduplicates overlapping MCP Portal and zone secret refs during protected restart preflight', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const overlappingRef = 'op://agent-vm/shravan-perplexity/credential';
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(
			configDir,
			{
				providers: {
					perplexity: {
						kind: 'mcp',
						namespace: 'perplexity',
						secretPolicies: {
							PERPLEXITY_API_KEY: {
								hosts: ['api.perplexity.ai'],
								injection: 'http-mediation',
							},
						},
						transport: {
							args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
							command: 'npx',
							env: {
								PERPLEXITY_API_KEY: {
									ref: overlappingRef,
									source: '1password',
								},
							},
							kind: 'stdio',
							networkAccess: 'declared',
							requiredEgressHosts: ['api.perplexity.ai'],
						},
					},
				},
				schemaVersion: 1,
			},
			{ portalAgentId: 'shravan' },
		);
		const firstResolveAllStarted = createDeferredPromise<void>();
		const releaseFirstResolveAll = createDeferredPromise<void>();
		const resolveSecretRef = (secretRef: SecretRef): string => {
			if (secretRef.source === 'config') {
				return secretRef.value;
			}
			switch (secretRef.ref) {
				case 'op://agent-vm/shravan-discord/bot-token':
					return 'resolved-discord-token';
				case 'op://agent-vm/shravan-gateway-auth/password':
					return 'resolved-gateway-token';
				case overlappingRef:
					return 'resolved-shared-perplexity-key';
				default:
					throw new Error(`Unexpected secret ref: ${secretRef.ref}`);
			}
		};
		const resolveAllMock = vi.fn(async (secretRefs: Record<string, SecretRef>) => {
			if (resolveAllMock.mock.calls.length === 1) {
				firstResolveAllStarted.resolve(undefined);
				await releaseFirstResolveAll.promise;
			}
			return Object.fromEntries(
				Object.entries(secretRefs).map(([secretName, secretRef]) => [
					secretName,
					resolveSecretRef(secretRef),
				]),
			);
		});
		const secretResolver: SecretResolver = {
			resolve: async (secretRef) => resolveSecretRef(secretRef),
			resolveAll: resolveAllMock,
		};

		const preflightPromise = preflightGatewayZoneStart(
			{
				prebuiltImage: {
					built: false,
					fingerprint: 'fingerprint',
					imageReference: '/tmp/gateway-image',
				},
				secretResolver,
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					agents: [{ id: 'shravan' }],
					toolPortal: createGatewayZoneToolPortalConfig(configDir),
				},
			},
			{ managedVmImages: testManagedVmImages },
		);
		await firstResolveAllStarted.promise;
		await flushPendingEventLoopWork();
		releaseFirstResolveAll.resolve(undefined);
		await preflightPromise;

		const overlappingResolveCount = resolveAllMock.mock.calls
			.flatMap(([secretRefs]) => Object.values(secretRefs))
			.filter(
				(secretRef) => secretRef.source === '1password' && secretRef.ref === overlappingRef,
			).length;
		expect(overlappingResolveCount).toBe(1);
	});

	it('does not generate OpenClaw mcp.servers entries for managed MCP Portal', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, undefined, { portalAgentId: 'shravan' });
		const lifecycleZones: GatewayZoneConfig[] = [];
		const managedVm: ManagedVm = {
			id: 'vm-mcp-native',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp-native')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28290),
			configureIngressRoutes: vi.fn(),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					agents: [{ id: 'shravan' }],
					toolPortal: createGatewayZoneToolPortalConfig(configDir),
				},
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
				loadGatewayLifecycle: () => ({
					...loadGatewayLifecycle('openclaw'),
					buildVmRequirements: (options) => {
						lifecycleZones.push(options.zone);
						return {
							allowedHosts: [],
							environment: {},
							mediatedSecrets: {},
							rootfsMode: 'cow' as const,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							tcpHosts: {},
							mounts: {},
						};
					},
				}),
			},
		);

		expect(lifecycleZones[0]?.runtimeMcpServers).toBeUndefined();
	});

	it('adds MCP Portal upstream hosts to effective gateway egress', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				deepwiki: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://mcp.deepwiki.com/mcp' },
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-generated-egress',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp-generated-egress')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28291),
			configureIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(
			async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					toolPortal: createGatewayZoneToolPortalConfig(configDir),
				},
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.arrayContaining(['mcp.deepwiki.com']),
			}),
		);
	});

	it('does not duplicate MCP Portal upstream hosts declared for gateway egress', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				deepwiki: {
					kind: 'mcp',
					namespace: 'deepwiki',
					transport: { kind: 'streamable-http', url: 'https://mcp.deepwiki.com/mcp' },
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-egress',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp-egress')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28291),
			configureIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(
			async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					egressHosts: [...baseZone.egressHosts, { audience: 'gateway', host: 'mcp.deepwiki.com' }],
					toolPortal: createGatewayZoneToolPortalConfig(configDir),
				},
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.arrayContaining(['mcp.deepwiki.com']),
			}),
		);
		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall;
		expect(vmOptions.allowedHosts.filter((host) => host === 'mcp.deepwiki.com')).toHaveLength(1);
	});

	it('passes websocket upgrade URL policy to the gateway VM request hook', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const managedVm: ManagedVm = {
			id: 'vm-websocket-policy',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-websocket-policy')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28291),
			configureIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(
			async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					egressHosts: [
						...baseZone.egressHosts,
						{ audience: 'both', host: 'discord.gg' },
						{ audience: 'both', host: '*.discord.gg' },
					],
					websocketUpgrades: [
						{
							audience: 'gateway',
							scheme: 'wss',
							host: 'gateway.discord.gg',
							port: 443,
							path: '/',
						},
						{
							audience: 'gateway',
							scheme: 'wss',
							host: 'gateway-*.discord.gg',
							port: 443,
							path: '/',
						},
					],
				},
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall;
		expect(vmOptions.mediation?.onRequest).toEqual(expect.any(Function));
		const allowedResult = await vmOptions.mediation?.onRequest?.(
			new Request('https://gateway-us-east1-c.discord.gg/?v=10&encoding=json', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		expect(allowedResult).toBeUndefined();
		const blockedResult = await vmOptions.mediation?.onRequest?.(
			new Request('https://unapproved.discord.gg/?v=10&encoding=json', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		expect(blockedResult).toBeInstanceOf(Response);
		expect((blockedResult as Response).status).toBe(403);
	});

	it('blocks gateway websocket requests when only Tool VM websocket policy exists', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const managedVm: ManagedVm = {
			id: 'vm-tool-websocket-policy',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-tool-websocket-policy')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28292),
			configureIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(
			async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					egressHosts: [
						...baseZone.egressHosts,
						{ audience: 'tool-vm', host: 'tool-websocket.example.com' },
					],
					websocketUpgrades: [
						{
							audience: 'tool-vm',
							scheme: 'wss',
							host: 'tool-websocket.example.com',
						},
					],
				},
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall;
		expect(vmOptions.mediation?.onRequest).toEqual(expect.any(Function));
		const blockedResult = await vmOptions.mediation?.onRequest?.(
			new Request('https://tool-websocket.example.com/socket', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		expect(blockedResult).toBeInstanceOf(Response);
		expect((blockedResult as Response).status).toBe(403);
	});

	it('blocks gateway websocket requests when no websocket policy exists', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const managedVm: ManagedVm = {
			id: 'vm-no-websocket-policy',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-no-websocket-policy')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28293),
			configureIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(
			async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					egressHosts: [
						...baseZone.egressHosts,
						{ audience: 'gateway', host: 'ordinary-websocket.example.com' },
					],
					websocketUpgrades: [],
				},
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall;
		expect(vmOptions.mediation?.onRequest).toEqual(expect.any(Function));
		const blockedResult = await vmOptions.mediation?.onRequest?.(
			new Request('https://ordinary-websocket.example.com/socket', {
				headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
			}),
		);
		expect(blockedResult).toBeInstanceOf(Response);
		expect((blockedResult as Response).status).toBe(403);
	});

	it('passes stdio MCP Portal http-mediation secrets to the gateway VM as generated mediated secrets', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				perplexity: {
					kind: 'mcp',
					namespace: 'perplexity',
					secretPolicies: {
						PERPLEXITY_API_KEY: {
							hosts: ['api.perplexity.ai'],
							injection: 'http-mediation',
						},
					},
					transport: {
						args: ['-y', '-p', '@perplexity-ai/mcp-server', 'perplexity-mcp'],
						command: 'npx',
						env: {
							PERPLEXITY_API_KEY: {
								ref: 'op://agent-vm/sunfam-perplexity/credential',
								source: '1password',
							},
						},
						kind: 'stdio',
						networkAccess: 'declared',
						requiredEgressHosts: ['api.perplexity.ai'],
					},
				},
				vendor: {
					kind: 'mcp',
					namespace: 'vendor',
					secretPolicies: {
						VENDOR_TOKEN: {
							hosts: [],
							injection: 'env',
						},
					},
					transport: {
						args: ['vendor-mcp'],
						command: 'node',
						env: {
							VENDOR_TOKEN: {
								name: 'VENDOR_TOKEN',
								source: 'environment',
							},
						},
						kind: 'stdio',
						networkAccess: 'declared',
						requiredEgressHosts: ['api.vendor.example'],
					},
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-mediated-stdio',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp-mediated-stdio')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28293),
			configureIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(
			async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);

		await startGatewayZone(
			{
				secretResolver: {
					resolve: async (secretRef) => {
						if (secretRef.ref === 'op://agent-vm/shravan-discord/bot-token') {
							return 'discord-token';
						}
						if (secretRef.ref === 'op://agent-vm/shravan-gateway-auth/password') {
							return 'resolved-gateway-token';
						}
						if (secretRef.ref === 'op://agent-vm/sunfam-perplexity/credential') {
							return 'resolved-pplx-key';
						}
						if (secretRef.ref === 'op://agent-vm/shravan-perplexity/credential') {
							return 'zone-pplx-key';
						}
						if (secretRef.ref === 'VENDOR_TOKEN') {
							return 'resolved-vendor-key';
						}
						throw new Error(`Unexpected secret ref: ${secretRef.ref}`);
					},
					resolveAll: async (secretRefs) =>
						Object.fromEntries(
							Object.entries(secretRefs).map(([secretName, secretRef]) => {
								if (secretRef.ref === 'op://agent-vm/shravan-discord/bot-token') {
									return [secretName, 'discord-token'];
								}
								if (secretRef.ref === 'op://agent-vm/shravan-gateway-auth/password') {
									return [secretName, 'resolved-gateway-token'];
								}
								if (secretRef.ref === 'op://agent-vm/sunfam-perplexity/credential') {
									return [secretName, 'resolved-pplx-key'];
								}
								if (secretRef.ref === 'op://agent-vm/shravan-perplexity/credential') {
									return [secretName, 'zone-pplx-key'];
								}
								if (secretRef.ref === 'VENDOR_TOKEN') {
									return [secretName, 'resolved-vendor-key'];
								}
								throw new Error(`Unexpected secret ref: ${secretRef.ref}`);
							}),
						),
				},
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					gateway: {
						...baseZone.gateway,
						rawEnvSecrets: [
							...(baseZone.gateway.rawEnvSecrets ?? []),
							'AGENT_VM_MCP_VENDOR_VENDOR_TOKEN',
						],
					},
					toolPortal: createGatewayZoneToolPortalConfig(configDir),
				},
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall;
		const mediatedSecret = vmOptions.mediatedSecrets.find(
			(secret) => secret.environmentVariable === 'AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY',
		);
		expect(mediatedSecret).toEqual(
			expect.objectContaining({
				allowedHosts: ['api.perplexity.ai'],
				environmentVariable: 'AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY',
				value: 'resolved-pplx-key',
			}),
		);
		if (
			mediatedSecret === undefined ||
			!('guestPlaceholder' in mediatedSecret) ||
			typeof mediatedSecret.guestPlaceholder !== 'string'
		) {
			throw new Error('Expected the managed VM descriptor to carry a guest placeholder.');
		}
		expect(mediatedSecret.guestPlaceholder).toMatch(/^GONDOLIN_SECRET_[0-9a-f]{48}$/u);
		const toolPortalEnvironment = requireManagedGatewayBootInputFile(
			vmOptions,
			managedGatewayBootInputPaths.environmentRoot,
			'tool-portal.environment.sh',
		);
		const frameworkEnvironment = requireManagedGatewayBootInputFile(
			vmOptions,
			managedGatewayBootInputPaths.environmentRoot,
			'framework.environment.sh',
		);
		expect(toolPortalEnvironment).toContain(
			`export AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY='${mediatedSecret.guestPlaceholder}'`,
		);
		expect(frameworkEnvironment).not.toContain('AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY');
		expect(toolPortalEnvironment).toContain(
			"export AGENT_VM_MCP_VENDOR_VENDOR_TOKEN='resolved-vendor-key'",
		);
		expect(frameworkEnvironment).not.toContain('AGENT_VM_MCP_VENDOR_VENDOR_TOKEN');
		expect(toolPortalEnvironment).not.toContain('resolved-pplx-key');
		expect(frameworkEnvironment).not.toContain('resolved-pplx-key');
		expect(vmOptions.environment).not.toHaveProperty('AGENT_VM_MCP_PERPLEXITY_PERPLEXITY_API_KEY');
	});

	it('keeps loopback MCP Portal provider URLs out of gateway egress', async () => {
		const systemConfig = await createSystemConfig();
		const baseZone = systemConfig.zones[0];
		if (baseZone === undefined || baseZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const configDir = path.dirname(baseZone.gateway.config);
		await writeMinimalMcpPortalConfigs(configDir, {
			providers: {
				local_proxy: {
					kind: 'mcp',
					namespace: 'local_proxy',
					transport: { kind: 'streamable-http', url: 'http://127.0.0.1:18791/mcp' },
				},
			},
			schemaVersion: 1,
		});
		const managedVm: ManagedVm = {
			id: 'vm-mcp-loopback',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-mcp-loopback')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28292),
			configureIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(async () => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig,
				zoneId: 'shravan',
				zoneOverride: {
					...baseZone,
					toolPortal: createGatewayZoneToolPortalConfig(configDir),
				},
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				allowedHosts: expect.not.arrayContaining(['127.0.0.1', 'localhost']),
			}),
		);
	});

	it('merges environmentOverride into vm environment before boot', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-override',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-override')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28286),
			configureIngressRoutes: vi.fn(),
		};
		const createManagedVm = vi.fn(
			async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);

		await startGatewayZone(
			{
				environmentOverride: {
					DATABASE_URL: 'postgres://app:secret@postgres.local:5432/app',
				},
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'resolved-key',
					DISCORD_BOT_TOKEN: 'resolved-key',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp-env-override',
						imageReference: '/tmp/gateway-image',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				environment: expect.objectContaining({
					DATABASE_URL: 'postgres://app:secret@postgres.local:5432/app',
				}),
			}),
		);
	});

	it('throws for an unknown zone id', async () => {
		const secretResolver: SecretResolver = {
			resolve: async (): Promise<string> => {
				throw new Error('not used');
			},
			resolveAll: async () => ({}),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver,
					systemConfig: await createSystemConfig(),
					zoneId: 'does-not-exist',
				},
				{
					managedVmImages: { prepareImage: vi.fn() },
					managedVmFactory: { createManagedVm: vi.fn() },
				},
			),
		).rejects.toThrow("Unknown zone 'does-not-exist'.");
	});

	it('loads the worker lifecycle for worker gateway zones', async () => {
		const systemConfig = await createSystemConfig();
		const workerSystemConfig: LoadedSystemConfig = {
			...systemConfig,
			zones: systemConfig.zones.map((zone) => ({
				...zone,
				gateway: {
					...zone.gateway,
					type: 'worker' as const,
				},
				secrets: {
					OPENAI_API_KEY: {
						source: '1password' as const,
						ref: 'op://agent-vm/shravan-openai/credential',
						injection: 'http-mediation' as const,
						audience: 'gateway' as const,
						hosts: ['api.openai.com'],
					},
				},
			})),
		};
		const secretResolver: SecretResolver = {
			resolve: async () => 'openai-key',
			resolveAll: async () => ({ OPENAI_API_KEY: 'openai-key' }),
		};
		const execMock = vi.fn(() => createManagedExecProcessStub({ stdout: '200' }));
		const configureIngressRoutesMock = vi.fn();
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());

		const result = await startGatewayZone(
			{
				secretResolver,
				systemConfig: workerSystemConfig,
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp-worker',
						imageReference: '/tmp/worker-image',
					})),
				},
				managedVmFactory: {
					createManagedVm: vi.fn(async () => ({
						close: vi.fn(async () => completeGatewayVmClose('worker-vm-123')),
						enableIngress: enableIngressMock,
						enableSsh: vi.fn(),
						exec: execMock,
						getHostProcessId: vi.fn(() => 12345),
						id: 'worker-vm-123',
						start: vi.fn(async () => {}),
						configureIngressRoutes: configureIngressRoutesMock,
					})),
				},
				writeGatewayRuntimeRecord: vi.fn(async () => {}),
			},
		);

		const workerResult = requireDirectProcessGatewayResult(result);
		expect(workerResult.processSpec.startCommand).toContain('agent-vm-worker');
		expect(workerResult.processSpec.healthCheck).toEqual({
			type: 'http',
			port: 18789,
			path: '/health',
		});
	});

	it('splits env secrets from http-mediation secrets based on injection config', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-456'));
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const execMock = vi.fn(() => createManagedExecProcessStub({ stdout: '200' }));
		const configureIngressRoutesMock = vi.fn();
		const managedVm: ManagedVm = {
			id: 'vm-456',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			getHostProcessId: vi.fn(() => 28283),
			configureIngressRoutes: configureIngressRoutesMock,
		};
		const secretResolver = createOpenClawSecretResolver({
			PERPLEXITY_API_KEY: 'pplx-key',
			DISCORD_BOT_TOKEN: 'discord-token',
			OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
		});
		const createManagedVm = vi.fn(
			async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);

		await startGatewayZone(
			{
				secretResolver,
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall;

		// PERPLEXITY_API_KEY should be mediated only to its allowed hosts.
		const frameworkMediatedSecret = vmOptions.mediatedSecrets.find(
			(secret) => secret.environmentVariable === 'PERPLEXITY_API_KEY',
		);
		expect(frameworkMediatedSecret).toEqual(
			expect.objectContaining({
				allowedHosts: ['api.perplexity.ai'],
				environmentVariable: 'PERPLEXITY_API_KEY',
				value: 'pplx-key',
			}),
		);
		if (frameworkMediatedSecret?.guestPlaceholder === undefined) {
			throw new Error('Expected the framework mediated secret to carry a guest placeholder.');
		}
		expect(frameworkMediatedSecret.guestPlaceholder).toMatch(/^GONDOLIN_SECRET_[0-9a-f]{48}$/u);
		const protectedFrameworkEnvironment = requireManagedGatewayBootInputFile(
			vmOptions,
			managedGatewayBootInputPaths.environmentRoot,
			'framework.environment.sh',
		);
		const gatewayTokenEnvironment = requireManagedGatewayBootInputFile(
			vmOptions,
			managedGatewayBootInputPaths.environmentRoot,
			'openclaw-gateway-token.environment.sh',
		);
		const allSecretsEnvironment = requireManagedGatewayBootInputFile(
			vmOptions,
			managedGatewayBootInputPaths.environmentRoot,
			'openclaw-all-secrets.environment.sh',
		);

		// Raw framework secrets are scoped to the protected framework process input.
		expect(protectedFrameworkEnvironment).toContain("export DISCORD_BOT_TOKEN='discord-token'");
		expect(protectedFrameworkEnvironment).toContain(
			"export OPENCLAW_GATEWAY_TOKEN='resolved-gateway-token'",
		);
		expect(protectedFrameworkEnvironment).toContain(
			`export PERPLEXITY_API_KEY='${frameworkMediatedSecret.guestPlaceholder}'`,
		);
		expect(gatewayTokenEnvironment).toBe(
			"export OPENCLAW_GATEWAY_TOKEN='resolved-gateway-token'\n",
		);
		expect(gatewayTokenEnvironment).not.toContain('DISCORD_BOT_TOKEN');
		expect(gatewayTokenEnvironment).not.toContain('PERPLEXITY_API_KEY');
		expect(allSecretsEnvironment).toBe(protectedFrameworkEnvironment);
		expect(vmOptions.environment).not.toHaveProperty('DISCORD_BOT_TOKEN');
		expect(vmOptions.environment).not.toHaveProperty('OPENCLAW_GATEWAY_TOKEN');

		// The raw mediated value must not enter the guest environment.
		expect(vmOptions.environment).not.toHaveProperty('PERPLEXITY_API_KEY');
	});

	it('builds tcp hosts with Tool VM SSH entries only', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-789'));
		const execMock = vi.fn(() => createManagedExecProcessStub({ stdout: '200' }));
		const managedVm: ManagedVm = {
			id: 'vm-789',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28284),
		};
		const createManagedVm = vi.fn(
			async (_request: ManagedVmCreateRequest): Promise<ManagedVm> => managedVm,
		);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					PERPLEXITY_API_KEY: 'key',
					DISCORD_BOT_TOKEN: 'token',
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
			},
		);

		const createManagedVmCall = createManagedVm.mock.calls[0];
		if (!createManagedVmCall) {
			throw new Error('Expected gateway VM creation call');
		}
		const [vmOptions] = createManagedVmCall;
		expect(vmOptions.mediation).not.toHaveProperty('internalDestinations');
		expect(vmOptions.tcpHosts).toEqual([
			{ guestHost: 'tool-0.vm.host:22', target: '127.0.0.1:19000' },
			{ guestHost: 'tool-1.vm.host:22', target: '127.0.0.1:19001' },
			{ guestHost: 'tool-2.vm.host:22', target: '127.0.0.1:19002' },
			{ guestHost: 'tool-3.vm.host:22', target: '127.0.0.1:19003' },
			{ guestHost: 'tool-4.vm.host:22', target: '127.0.0.1:19004' },
		]);
	});

	it('throws with the Worker log tail and closes the vm when service health polling exhausts all attempts', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-timeout'));
		const execMock = vi.fn((command: string) => {
			if (command === `tail -n 80 ${expectedWorkerProcessSpec.logPath} 2>/dev/null || true`) {
				return createManagedExecProcessStub({
					stdout: 'Worker failed to parse config: unknown verification mode\n',
				});
			}
			if (command.includes('http://127.0.0.1:18789/health')) {
				return createManagedExecProcessStub({ exitCode: 1 });
			}
			return createManagedExecProcessStub({ stdout: '000' });
		});
		const managedVm: ManagedVm = {
			id: 'vm-timeout',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28285),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createWorkerSystemConfig(),
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					gatewayReadinessMaxAttempts: 2,
					gatewayReadinessRetryDelayMs: 0,
				},
			),
		).rejects.toThrow(
			/Gateway service health check failed after 2 attempts.*Last probe: http \(empty\).*Gateway process may still be booting, or it may have crashed before opening its health port.*Worker failed to parse config/su,
		);
		expect(execMock).toHaveBeenCalledWith(
			`tail -n 80 ${expectedWorkerProcessSpec.logPath} 2>/dev/null || true`,
		);
		expect(execMock).toHaveBeenNthCalledWith(1, expectedWorkerProcessSpec.bootstrapCommand);
		expect(execMock).toHaveBeenNthCalledWith(2, expectedWorkerProcessSpec.startCommand);
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('defaults Worker service health polling to about 60 seconds', async () => {
		const execMock = vi.fn((command: string) => {
			if (command.includes('tail -n 80')) {
				return createManagedExecProcessStub();
			}
			if (command.includes('http://127.0.0.1:18789/health')) {
				return createManagedExecProcessStub({ exitCode: 1 });
			}
			return createManagedExecProcessStub({ stdout: '000' });
		});
		const managedVm: ManagedVm = {
			id: 'vm-default-timeout',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-default-timeout')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28285),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createWorkerSystemConfig(),
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					gatewayReadinessRetryDelayMs: 0,
				},
			),
		).rejects.toThrow(/Gateway service health check failed after 120 attempts/su);
	});

	it('throws command stdout and stderr and closes the vm when Worker configuration fails', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-config-failed'));
		const managedVm: ManagedVm = {
			id: 'vm-config-failed',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn((command: string) =>
				command === expectedWorkerProcessSpec.bootstrapCommand
					? createManagedExecProcessStub({
							exitCode: 42,
							stdout: 'bootstrap stdout',
							stderr: 'bootstrap stderr',
						})
					: createManagedExecProcessStub({ stdout: '200' }),
			),
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28285),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createWorkerSystemConfig(),
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					gatewayReadinessMaxAttempts: 5,
					gatewayReadinessRetryDelayMs: 0,
				},
			),
		).rejects.toThrow(/Configuring gateway failed.*exit 42.*bootstrap stdout.*bootstrap stderr/su);
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('does not treat non-2xx Worker http responses as ready', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-not-ready-500',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-not-ready-500')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi
				.fn()
				.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '500' }))
				.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '500' }))
				.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '500' }))
				.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '500' }))
				.mockReturnValueOnce(createManagedExecProcessStub({ stdout: '500' }))
				.mockReturnValue(createManagedExecProcessStub({ stdout: '500' })),
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28286),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig: await createWorkerSystemConfig(),
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					gatewayReadinessMaxAttempts: 5,
					gatewayReadinessRetryDelayMs: 0,
					loadGatewayLifecycle: createHttpHealthGatewayLifecycle,
				},
			),
		).rejects.toThrow(/500/u);
	});

	it('supports command-based Worker health checks', async () => {
		const execMock = vi.fn((_command: string) => createManagedExecProcessStub());
		const managedVm: ManagedVm = {
			id: 'vm-command-health',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-command-health')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28287),
		};

		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createWorkerSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
				loadGatewayLifecycle: () => ({
					executionModel: 'direct-process',
					buildProcessSpec: () => ({
						bootstrapCommand: 'bootstrap-worker',
						guestListenPort: 18789,
						healthCheck: { type: 'command', command: 'check-health' } as const,
						logPath: '/tmp/worker.log',
						startCommand: 'start-worker',
					}),
					buildVmRequirements: () => ({
						allowedHosts: [],
						environment: {},
						mediatedSecrets: {},
						rootfsMode: 'cow' as const,
						sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
						tcpHosts: {},
						mounts: {},
					}),
				}),
			},
		);

		expect(execMock).toHaveBeenCalledWith('check-health');
		expect(requireDirectProcessGatewayResult(result).processSpec.logPath).toBe('/tmp/worker.log');
	});

	it('omits full Worker commands from command failure messages', async () => {
		const secretBearingBootstrapCommand =
			"export FUTURE_SECRET='do-not-leak-command-material' && false";
		const managedVm: ManagedVm = {
			id: 'vm-failed-bootstrap',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-failed-bootstrap')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn((command: string) =>
				command === secretBearingBootstrapCommand
					? createManagedExecProcessStub({
							exitCode: 1,
							stdout: 'bootstrap stdout',
							stderr: 'bootstrap stderr',
						})
					: createManagedExecProcessStub({ stdout: '200' }),
			),
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28287),
		};
		const systemConfig = await createWorkerSystemConfig();

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
					}),
					systemConfig,
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					loadGatewayLifecycle: () => ({
						executionModel: 'direct-process',
						buildProcessSpec: () => ({
							bootstrapCommand: secretBearingBootstrapCommand,
							guestListenPort: 18789,
							healthCheck: { type: 'http', port: 18789, path: '/' } as const,
							logPath: '/tmp/worker.log',
							startCommand: 'start-worker',
						}),
						buildVmRequirements: () => ({
							allowedHosts: [],
							environment: {},
							mediatedSecrets: {},
							rootfsMode: 'cow' as const,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							tcpHosts: {},
							mounts: {},
						}),
					}),
				},
			),
		).rejects.toThrow(
			/^(?!.*(?:do-not-leak-command-material|Command:))Configuring gateway failed with exit 1/u,
		);
		await expect(
			loadWorkerRuntimeRecord(
				resolveTestWorkerRuntimeRecordTarget({ systemConfig, zoneId: 'shravan' }),
			),
		).resolves.toBeNull();
	});

	it('retries Worker health checks until a 2xx response is returned', async () => {
		const execMock = vi.fn((command: string) => {
			if (!command.includes('curl -sS -o /dev/null -w "%{http_code}"')) {
				return createManagedExecProcessStub();
			}
			healthProbeCount += 1;
			return createManagedExecProcessStub({
				stdout: healthProbeCount === 1 ? '000' : '200',
			});
		});
		let healthProbeCount = 0;
		const managedVm: ManagedVm = {
			id: 'vm-retry-health',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-retry-health')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28288),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					OPENCLAW_GATEWAY_TOKEN: 'resolved-gateway-token',
				}),
				systemConfig: await createWorkerSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
				loadGatewayLifecycle: createHttpHealthGatewayLifecycle,
			},
		);

		expect(execMock).toHaveBeenNthCalledWith(
			3,
			expect.stringContaining('curl -sS -o /dev/null -w "%{http_code}"'),
		);
		expect(execMock).toHaveBeenNthCalledWith(
			4,
			expect.stringContaining('curl -sS -o /dev/null -w "%{http_code}"'),
		);
		expect(healthProbeCount).toBe(2);
	});

	it('aborts a pending gateway service-health retry without starting another probe', async () => {
		vi.useFakeTimers();
		try {
			const { exec, managedVm } = createHealthyGatewayVmStub('vm-successor-health-abort', 28_399);
			exec.mockImplementation(() => createManagedExecProcessStub({ stdout: '000' }));
			const healthAbortController = new AbortController();
			const exactDeadlineReason = new Error(
				"OpenClaw successor process 'process-2' exceeded its 45000ms phase deadline.",
			);
			const healthWait = waitForGatewayServiceHealth({
				healthCheck: { path: '/health', port: 18_789, type: 'http' },
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
				managedVm,
				maxAttempts: 5,
				retryDelayMs: 60_000,
				signal: healthAbortController.signal,
			});

			for (
				let microtaskFlush = 0;
				microtaskFlush < 10 && vi.getTimerCount() === 0;
				microtaskFlush += 1
			) {
				// oxlint-disable-next-line no-await-in-loop -- bounded fake-timer microtask flushing is intentionally sequential
				await Promise.resolve();
			}
			expect(exec).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(1);

			healthAbortController.abort(exactDeadlineReason);

			await expect(healthWait).rejects.toBe(exactDeadlineReason);
			expect(vi.getTimerCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(120_000);
			expect(exec).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('materializes the managed OpenClaw config path in protected framework input', async () => {
		const execMock = vi.fn((_command: string) => createManagedExecProcessStub({ stdout: '200' }));
		let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
		const managedVm: ManagedVm = {
			id: 'vm-token',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-token')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: execMock,
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28289),
		};

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: {
					createManagedVm: vi.fn(async (createRequest) => {
						managedVmCreateRequest = createRequest;
						return managedVm;
					}),
				},
			},
		);

		const protectedFrameworkEnvironment = requireManagedGatewayBootInputFile(
			managedVmCreateRequest,
			managedGatewayBootInputPaths.environmentRoot,
			'framework.environment.sh',
		);
		expect(protectedFrameworkEnvironment).toContain(
			"export OPENCLAW_CONFIG_PATH='/run/agent-vm/managed-gateway/framework-service.json'",
		);
		const managedExecCommands = execMock.mock.calls.map(([command]) => command);
		expect(managedExecCommands).toHaveLength(2);
		expect(
			managedExecCommands.every((command) => command === expectedManagedOpenClawReadinessCommand),
		).toBe(true);
	});

	it('reserves exact ownership immediately before VM creation and returns the same ownership handle', async () => {
		const taskTitles: string[] = [];
		const ownership = createTestVmOwnershipHarness(
			'vm-owned-start',
			createTestGatewayEpochIdentity('vm-owned-start'),
		);
		const { managedVm } = createHealthyGatewayVmStub('vm-owned-start', 28_294);
		const createManagedVm = vi.fn(async () => managedVm);

		const result = await startGatewayZone(
			{
				createVmOwnership: ownership.createVmOwnership,
				runTask: async (title, run) => {
					taskTitles.push(title);
					await run();
				},
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
				managedVmFactory: { createManagedVm },
			},
		);

		const reservationTaskIndex = taskTitles.indexOf('Reserving gateway VM ownership');
		expect(taskTitles.slice(reservationTaskIndex, reservationTaskIndex + 2)).toEqual([
			'Reserving gateway VM ownership',
			'Booting gateway VM',
		]);
		expect(ownership.createVmOwnership.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			createManagedVm.mock.invocationCallOrder[0] ?? 0,
		);
		expect(ownership.createVmOwnership).toHaveBeenCalledWith({
			controlIdentity: {
				bootId: testGatewayBootId,
				generationId: testGatewayGenerationId,
			},
			kind: 'gateway-epoch',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			zoneId: 'shravan',
		});
		expect(result.gatewayIdentity).toBe(ownership.vmOwnership.gatewayIdentity);
		expect(ownership.attachGatewayVm).toHaveBeenCalledWith(result.vm.id);
		expect(ownership.destroyLive).not.toHaveBeenCalled();
	});

	it('holds final managed runtime publication behind the pre-identity crash cut', async () => {
		const vmId = 'vm-pre-identity-crash-cut';
		const hostPid = 28_395;
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		const { close, managedVm, start } = createHealthyGatewayVmStub(vmId, hostPid);
		const crashCutReached = createDeferredPromise<{
			readonly hostPid: number;
			readonly vmId: string;
		}>();
		const releaseCrashCut = createDeferredPromise<void>();
		const publicationOrder: string[] = [];
		const readProcessIdentity = vi.fn(async (observedHostPid: number) => {
			publicationOrder.push(`identity:${String(observedHostPid)}`);
			return {
				command: 'qemu-system-x86_64 -m 4G',
				lstart: 'Fri May 22 10:00:00 2026',
			};
		});
		const writeGatewayRuntimeRecord = vi.fn<
			NonNullable<GatewayManagerDependencies['writeGatewayRuntimeRecord']>
		>(async () => {
			publicationOrder.push('runtime-record');
		});

		const systemConfig = await createSystemConfig();
		const startPromise = startGatewayZone(
			{
				createVmOwnership: ownership.createVmOwnership,
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig,
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'pre-identity-crash-cut-image',
						imageReference: '/tmp/pre-identity-crash-cut-image',
					})),
				},
				createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
				onManagedVmStartedBeforeIdentityPublication: async (target) => {
					publicationOrder.push('crash-cut-reached');
					crashCutReached.resolve(target);
					await releaseCrashCut.promise;
					publicationOrder.push('crash-cut-released');
				},
				readProcessIdentity,
				writeGatewayRuntimeRecord,
			},
		);

		const unpublishedProcess = await crashCutReached.promise;
		expect(start).toHaveBeenCalledOnce();
		expect(unpublishedProcess).toEqual({ hostPid, vmId });
		expect(publicationOrder).toEqual(['crash-cut-reached']);
		expect(readProcessIdentity).not.toHaveBeenCalled();
		expect(writeGatewayRuntimeRecord).not.toHaveBeenCalled();

		releaseCrashCut.resolve();
		const result = await startPromise;
		expect(readProcessIdentity).toHaveBeenCalledOnce();
		expect(readProcessIdentity).toHaveBeenCalledWith(hostPid);
		expect(writeGatewayRuntimeRecord).toHaveBeenCalledOnce();
		expect(writeGatewayRuntimeRecord.mock.calls[0]?.[0]).toEqual(
			resolveTestManagedGatewayRuntimeRecordTarget({ systemConfig, zoneId: 'shravan' }),
		);
		expect(publicationOrder).toEqual([
			'crash-cut-reached',
			'crash-cut-released',
			`identity:${String(hostPid)}`,
			'runtime-record',
		]);

		requireManagedGatewayResult(result).controlSession?.close();
		await result.destroyGateway();
		expect(close).toHaveBeenCalledOnce();
	});

	it('publishes pending VM containment and never configures a late Gateway create after containment starts', async () => {
		const pendingManagedVm = createDeferredPromise<ManagedVm>();
		const containmentPublished = createDeferredPromise<void>();
		const { close, exec, managedVm } = createHealthyGatewayVmStub(
			'vm-late-after-containment',
			28_394,
		);
		let pendingContainment: PendingGatewayVmCreationContainment | undefined;
		const gatewayIdentity = createTestGatewayEpochIdentity('vm-late-after-containment');
		const vmOwnership: GatewayVmLifecycleAuthority = {
			abandonUnattachedGatewaySeedAfter: async (cleanupOwnedResources) => {
				await cleanupOwnedResources();
			},
			attachGatewayVm: vi.fn(() => gatewayIdentity),
			containPendingCreate: async (containmentOptions) => {
				const lateCreatedVm = await containmentOptions.pendingCreate;
				return await containmentOptions.closeLateCreatedVm(lateCreatedVm);
			},
			destroyLive: vi.fn(
				async (destroyGatewayVm: () => Promise<void>): Promise<void> => await destroyGatewayVm(),
			),
			gatewayIdentity: undefined,
			gatewaySeed: gatewayIdentity,
		};

		const startPromise = startGatewayZone(
			{
				createVmOwnership: vi.fn(async () => vmOwnership),
				onPendingVmCreation: (containment) => {
					pendingContainment = containment;
					containmentPublished.resolve();
				},
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
				managedVmFactory: { createManagedVm: vi.fn(async () => await pendingManagedVm.promise) },
			},
		);
		await containmentPublished.promise;
		if (pendingContainment === undefined) {
			throw new Error('Expected pending Gateway VM containment to be published.');
		}
		const containmentPromise = pendingContainment.contain();

		pendingManagedVm.resolve(managedVm);

		await expect(containmentPromise).resolves.toBeUndefined();
		await expect(startPromise).rejects.toThrow('Pending Gateway VM creation was contained');
		expect(close).toHaveBeenCalledOnce();
		expect(exec).not.toHaveBeenCalled();
	});

	it('passes exact control identity to ownership without inventing a VM when creation rejects', async () => {
		const ownership = createTestVmOwnershipHarness(
			'vm-create-reject',
			createTestGatewayEpochIdentity('vm-create-reject', 'controller-epoch-exact'),
		);
		const createError = new Error('gateway VM create rejected');
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => {
			throw createError;
		});

		await expect(
			startGatewayZone(
				{
					controlSession: { controllerEpoch: 'controller-epoch-exact' },
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					managedVmFactory: { createManagedVm },
				},
			),
		).rejects.toBe(createError);

		expect(ownership.createVmOwnership).toHaveBeenCalledWith({
			controlIdentity: {
				bootId: testGatewayBootId,
				generationId: testGatewayGenerationId,
			},
			kind: 'gateway-epoch',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			zoneId: 'shravan',
		});
		expect(ownership.attachGatewayVm).not.toHaveBeenCalled();
		expect(ownership.destroyLive).not.toHaveBeenCalled();
	});

	it('uses live ownership destruction for startup rollback after VM creation succeeds', async () => {
		const ownership = createTestVmOwnershipHarness(
			'vm-owned-rollback',
			createTestGatewayEpochIdentity('vm-owned-rollback'),
		);
		const { close, managedVm } = createHealthyGatewayVmStub('vm-owned-rollback', 28_295);
		const recordError = new Error('runtime record write failed');

		await expect(
			startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					writeGatewayRuntimeRecord: vi.fn(async () => {
						throw recordError;
					}),
				},
			),
		).rejects.toBe(recordError);

		expect(ownership.destroyLive).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('closes the booted gateway VM if writing the runtime record fails', async () => {
		const closeMock = vi.fn(async () => completeGatewayVmClose('vm-record-fail'));
		const managedVm: ManagedVm = {
			id: 'vm-record-fail',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28290),
		};

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					writeGatewayRuntimeRecord: vi.fn(async () => {
						throw new Error('disk full');
					}),
				},
			),
		).rejects.toThrow(/disk full/u);

		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	it('surfaces failed stock close during startup rollback', async () => {
		const closeError = new Error('stock close failed after runner termination');
		const closeMock = vi.fn(async () => {
			throw closeError;
		});
		const managedVm: ManagedVm = {
			id: 'vm-record-fail-incomplete-close',
			start: vi.fn(async () => {}),
			close: closeMock,
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28290),
		};

		let thrownError: unknown;
		try {
			await startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					writeGatewayRuntimeRecord: vi.fn(async () => {
						throw new Error('disk full');
					}),
				},
			);
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		const aggregateError = thrownError as AggregateError;
		expect(aggregateError.errors).toEqual([
			expect.objectContaining({ message: 'disk full' }),
			expect.objectContaining({
				cause: closeError,
				message: expect.stringMatching(/not proven complete/u),
			}),
		]);
		expect(closeMock).toHaveBeenCalledOnce();
	});

	it('preserves startup, ingress-close, and stock-close failures during rollback', async () => {
		const startupError = new Error('control session connect failed');
		const ingressCloseError = new Error('ingress close failed');
		const stockCloseError = new Error('stock close failed');
		const ingressClose = vi.fn(async () => {
			throw ingressCloseError;
		});
		const stockVmClose = vi.fn(async () => {
			throw stockCloseError;
		});
		const { managedVm } = createHealthyGatewayVmStub('vm-ingress-rollback-errors', 28_297);
		managedVm.enableIngress = vi.fn(async () => ({
			close: ingressClose,
			host: '127.0.0.1',
			port: 18791,
		}));
		managedVm.close = stockVmClose;

		let thrownError: unknown;
		try {
			await startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					connectGatewayControlSession: vi.fn(async () => {
						throw startupError;
					}),
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
				},
			);
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(AggregateError);
		const startupAggregate = thrownError as AggregateError;
		expect(startupAggregate.errors[0]).toBe(startupError);
		expect(startupAggregate.errors[1]).toBeInstanceOf(AggregateError);
		const cleanupAggregate = startupAggregate.errors[1] as AggregateError;
		expect(cleanupAggregate.errors[0]).toBe(ingressCloseError);
		expect(cleanupAggregate.errors[1]).toMatchObject({ cause: stockCloseError });
		expect(ingressClose).toHaveBeenCalledOnce();
		expect(stockVmClose).toHaveBeenCalledOnce();
	});

	it('closes the created VM without creating disk staging when ownership attachment fails', async () => {
		// Arrange
		const attachmentError = new Error('gateway ownership attachment failed');
		const vmId = 'vm-attachment-failure';
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		ownership.attachGatewayVm.mockImplementation(() => {
			throw attachmentError;
		});
		const { close, managedVm, start } = createHealthyGatewayVmStub(vmId, null);
		let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
		const createManagedVm = vi.fn(async (request: ManagedVmCreateRequest): Promise<ManagedVm> => {
			managedVmCreateRequest = request;
			return managedVm;
		});

		// Act / Assert
		await expect(
			startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					managedVmFactory: { createManagedVm },
					managedVmImages: testManagedVmImages,
				},
			),
		).rejects.toBe(attachmentError);
		expect(createManagedVm).toHaveBeenCalledOnce();
		expect(ownership.attachGatewayVm).toHaveBeenCalledWith(vmId);
		expect(ownership.destroyLive).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
		expect(managedVmCreateRequest?.mounts[managedGatewayBootInputPaths.environmentRoot]).toEqual({
			access: 'read-write',
			kind: 'finalizable-memory',
		});
		expect(managedVmCreateRequest?.mounts[managedGatewayBootInputPaths.structuredRoot]).toEqual({
			access: 'read-only',
			kind: 'finalizable-memory',
		});
	});

	it('refuses raw close when ownership attachment fails after a managed Gateway runner appears', async () => {
		// Arrange
		const attachmentError = new Error('gateway ownership attachment failed');
		const vmId = 'vm-live-attachment-failure';
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		ownership.attachGatewayVm.mockImplementation(() => {
			throw attachmentError;
		});
		const { close, managedVm, start } = createHealthyGatewayVmStub(vmId, 28_407);
		let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
		const createManagedVm = vi.fn(async (request: ManagedVmCreateRequest): Promise<ManagedVm> => {
			managedVmCreateRequest = request;
			return managedVm;
		});

		// Act
		let thrownError: unknown;
		try {
			await startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					managedVmFactory: { createManagedVm },
					managedVmImages: testManagedVmImages,
				},
			);
		} catch (error: unknown) {
			thrownError = error;
		}

		// Assert
		expect(thrownError).toBeInstanceOf(AggregateError);
		const attachmentAggregate = thrownError as AggregateError;
		expect(attachmentAggregate.errors[0]).toBe(attachmentError);
		expect(attachmentAggregate.errors[1]).toMatchObject({
			message: expect.stringContaining('refusing raw close without exact process identity'),
		});
		expect(ownership.abandonUnattachedGatewaySeedAfter).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
		expect(managedVmCreateRequest?.mounts[managedGatewayBootInputPaths.environmentRoot]).toEqual({
			access: 'read-write',
			kind: 'finalizable-memory',
		});
		expect(managedVmCreateRequest?.mounts[managedGatewayBootInputPaths.structuredRoot]).toEqual({
			access: 'read-only',
			kind: 'finalizable-memory',
		});
	});

	it('contains the created managed Gateway VM when protected host-state preparation fails', async () => {
		const prepError = new Error('prep failed: disk full');
		const vmId = 'vm-host-state-failure';
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		const { close, managedVm, start } = createHealthyGatewayVmStub(vmId, 28_405);
		const createManagedVm = vi.fn(async (): Promise<ManagedVm> => managedVm);
		const prepareHostState = vi.fn(async () => {
			throw prepError;
		});

		await expect(
			startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					managedVmImages: {
						prepareImage: vi.fn(async () => ({
							built: true,
							fingerprint: 'fp',
							imageReference: '/tmp/img',
						})),
					},
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					managedVmFactory: { createManagedVm },
					loadGatewayLifecycle: () => ({
						...loadGatewayLifecycle('openclaw'),
						prepareHostState,
					}),
				},
			),
		).rejects.toThrow(prepError.message);

		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(prepareHostState).toHaveBeenCalledOnce();
		expect(createManagedVm).toHaveBeenCalledOnce();
		expect(ownership.attachGatewayVm).toHaveBeenCalledWith(vmId);
		expect(ownership.destroyLive).toHaveBeenCalledOnce();
		expect(start).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it('contains the unstarted managed Gateway VM when finalizable memory mounts are unsupported', async () => {
		const vmId = 'vm-finalizable-memory-unsupported';
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		const { close, managedVm, start } = createHealthyGatewayVmStub(vmId, null);
		const {
			finalizeMemoryMount: _unsupportedFinalizeMemoryMount,
			...managedVmWithoutFinalization
		} = managedVm;

		await expect(
			startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					managedVmFactory: {
						createManagedVm: vi.fn(async () => managedVmWithoutFinalization),
					},
					managedVmImages: testManagedVmImages,
				},
				'controller-internal',
				{ preserveMissingFinalizableMemoryMountCapability: true },
			),
		).rejects.toThrow('does not support finalizable memory mounts');

		expect(ownership.attachGatewayVm).toHaveBeenCalledWith(vmId);
		expect(ownership.destroyLive).toHaveBeenCalledOnce();
		expect(start).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it('contains the unstarted managed Gateway VM when environment mount finalization fails', async () => {
		const vmId = 'vm-environment-finalization-failure';
		const finalizationError = new Error('environment finalization failed');
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		const { close, finalizeMemoryMount, managedVm, start } = createHealthyGatewayVmStub(vmId, null);
		finalizeMemoryMount.mockRejectedValueOnce(finalizationError);

		await expect(
			startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					managedVmImages: testManagedVmImages,
				},
			),
		).rejects.toBe(finalizationError);

		expect(finalizeMemoryMount).toHaveBeenCalledOnce();
		expect(finalizeMemoryMount.mock.calls[0]?.[0].guestPath).toBe(
			managedGatewayBootInputPaths.environmentRoot,
		);
		expect(ownership.destroyLive).toHaveBeenCalledOnce();
		expect(start).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it('contains the unstarted managed Gateway VM when structured mount finalization fails', async () => {
		const vmId = 'vm-structured-finalization-failure';
		const finalizationError = new Error('structured finalization failed');
		const ownership = createTestVmOwnershipHarness(vmId, createTestGatewayEpochIdentity(vmId));
		const { close, finalizeMemoryMount, managedVm, start } = createHealthyGatewayVmStub(vmId, null);
		finalizeMemoryMount.mockResolvedValueOnce().mockRejectedValueOnce(finalizationError);

		await expect(
			startGatewayZone(
				{
					createVmOwnership: ownership.createVmOwnership,
					secretResolver: createOpenClawSecretResolver({
						DISCORD_BOT_TOKEN: 'discord-token',
						OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
						PERPLEXITY_API_KEY: 'pplx-key',
					}),
					systemConfig: await createSystemConfig(),
					zoneId: 'shravan',
				},
				{
					createGatewayControlSessionMaterial: createExactTestGatewayControlSessionMaterial,
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					managedVmImages: testManagedVmImages,
				},
			),
		).rejects.toBe(finalizationError);

		expect(finalizeMemoryMount).toHaveBeenCalledTimes(2);
		expect(finalizeMemoryMount.mock.calls.map(([request]) => request.guestPath)).toEqual([
			managedGatewayBootInputPaths.environmentRoot,
			managedGatewayBootInputPaths.structuredRoot,
		]);
		expect(ownership.destroyLive).toHaveBeenCalledOnce();
		expect(start).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it('prepares protected framework host state after VM creation and before VM start', async () => {
		const prepareHostState = vi.fn(async () => {});
		const startManagedVm = vi.fn(async () => {});
		const managedVm: ManagedVm = {
			id: 'vm-prep-before-boot',
			start: startManagedVm,
			close: vi.fn(async () => completeGatewayVmClose('vm-prep-before-boot')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			configureIngressRoutes: vi.fn(),
			getHostProcessId: vi.fn(() => 28291),
		};
		const createManagedVm = vi.fn(async () => managedVm);

		await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm },
				loadGatewayLifecycle: () => ({
					...loadGatewayLifecycle('openclaw'),
					prepareHostState,
				}),
			},
		);

		expect(createManagedVm.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			prepareHostState.mock.invocationCallOrder[0] ?? 0,
		);
		expect(prepareHostState.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
			startManagedVm.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it('starts OpenClaw without consulting legacy foreign-runtime cleanup authority', async () => {
		const managedVm: ManagedVm = {
			id: 'vm-quarantine',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-quarantine')),
			enableIngress: vi.fn(async () => createTestIngressAccess()),
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28293),
			configureIngressRoutes: vi.fn(),
		};

		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
			},
		);

		expect(cleanupOrphanedGatewayIfPresentMock).not.toHaveBeenCalled();
		expect(result.vm).not.toBe(managedVm);
		expect(result.vm).toMatchObject({ id: managedVm.id });
		expect(result.vm).not.toHaveProperty('close');
		expect(result.vm).not.toHaveProperty('configureIngressRoutes');
		expect(result.vm).not.toHaveProperty('enableIngress');
		expect(result.vm).not.toHaveProperty('start');
		expect(result.ingress).toEqual({ host: '127.0.0.1', port: 18791 });
	});

	it('provisions protected Tool Portal authority and connects the control session after ingress', async () => {
		const taskTitles: string[] = [];
		const loggedMessages: string[] = [];
		const controlSessionClose = vi.fn();
		const retirementPublicationObserved = Promise.withResolvers<void>();
		const retirementPublicationAcknowledgement = Promise.withResolvers<void>();
		const emitApplicationMessage = vi.fn(
			async (envelope: ControlEnvelope, _identity: unknown, payload: unknown) => {
				const message = GatewayControlRpcMessageSchema.parse(payload);
				if (
					message.kind === 'command' &&
					message.operation === 'tool_vm_binding_publish' &&
					message.payload.kind === 'retired'
				) {
					retirementPublicationObserved.resolve();
					await retirementPublicationAcknowledgement.promise;
				}
				return GatewayControlRpcCommandResultMessageSchema.parse({
					kind: 'command_result',
					operation: 'tool_vm_binding_publish',
					payload: { responseToMessageId: envelope.messageId, result: 'ok' },
				});
			},
		);
		const controlSessionClient: GatewayDisposableControlSessionClient = {
			ready: Promise.resolve({
				attachmentGeneration: 1,
				connectionId: '55555555-5555-4555-8555-555555555555',
				controllerEpoch: 'controller-epoch-test',
				outcome: 'accepted',
				sessionId: '33333333-3333-4333-8333-333333333333',
			}),
			close: controlSessionClose,
			closeForControllerShutdown: vi.fn(),
			emitApplicationMessage,
			ensureDialing: vi.fn(() => ({ status: 'accepted-current' as const })),
			fenceCurrentSession: vi.fn(() => ({ status: 'not-current' as const })),
			getDiagnostics: vi.fn(() => ({
				accepted: true,
				attachmentGeneration: 1,
				connected: true,
				endpointPath: '/__agent-vm/gateway-control',
				helloCount: 1,
				lastHelloResponse: {
					attachmentGeneration: 1,
					connectionId: testControlConnectionId,
					controllerEpoch: 'controller-epoch-test',
					outcome: 'accepted' as const,
					sessionId: testControlSessionId,
				},
				ready: true,
				reconnectAttempts: 0,
				reconnectExhausted: false,
				transportName: 'websocket',
			})),
		};
		const leaseSnapshot = {
			agentId: 'main',
			idleTtlMs: 120_000,
			leafGeneration: 'leaf-generation-main-1',
			leaseId: 'lease-main',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'identity-pem',
				knownHostsLine: `tool-0.vm.host ${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}`,
				port: 22,
				user: 'root',
			},
			sshBindingId: 'ssh-binding-main-1',
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/workspace',
			zoneId: 'shravan',
		} satisfies GatewayControlPrivateLeaseSnapshot;
		const enableIngressMock = vi.fn(async () => createTestIngressAccess());
		const prepareSemanticMutation = vi.fn(async () => ({
			execute: vi.fn(async () => leaseSnapshot),
			profile: {
				compatibilityId: 'compatibility-main',
				currentLeafTargetId: null,
				kind: 'lease_authority' as const,
				stablePrincipal: 'shravan/main',
			},
			target: 'agent:main',
		}));
		const gatewayControlLeaseRpc = {
			getLease: vi.fn(async () => undefined),
			prepareSemanticMutation,
		} satisfies GatewayControlLeaseRpcOperations;
		let bindingRetirementListener:
			| Parameters<GatewayControlBindingPublicationSource['subscribeBindingRetirement']>[0]
			| undefined;
		const unsubscribeBindingRetirement = vi.fn();
		const createBinding = vi.fn<GatewayControlBindingPublicationSource['createBinding']>(
			async ({ callerContext }) => ({
				agentId: callerContext.agentId,
				idleTtlMs: 120_000,
				leafGeneration: 'leaf-generation-main-1',
				leaseId: 'lease-main',
				profileAssignmentRevision: callerContext.principal.profileAssignmentRevision,
				ssh: {
					host: 'tool-0.vm.host',
					identityPem: 'identity-pem',
					knownHostsLine: `tool-0.vm.host ${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}`,
					port: 22,
					user: 'root',
				},
				sshBindingId: 'ssh-binding-main-1',
				stablePrincipal: callerContext.stablePrincipal,
				tcpSlot: 0,
				transport: 'ssh-sandbox',
				workdir: '/work',
				zoneId: callerContext.zoneId,
			}),
		);
		const gatewayControlBindingPublicationSource = {
			createBinding,
			subscribeBindingRetirement: vi.fn((listener) => {
				bindingRetirementListener = listener;
				return unsubscribeBindingRetirement;
			}),
		} satisfies GatewayControlBindingPublicationSource;
		const pushedWorkspaceGitHead = 'a'.repeat(40);
		const pushWorkspaceGit = vi.fn(async () => ({
			branch: 'agent/main',
			localHead: pushedWorkspaceGitHead,
			pushedCommits: [{ sha: pushedWorkspaceGitHead, subject: 'docs: update memory' }],
			remoteHead: pushedWorkspaceGitHead,
		}));
		const managedVm: ManagedVm = {
			id: 'vm-control-session',
			start: vi.fn(async () => {}),
			close: vi.fn(async () => completeGatewayVmClose('vm-control-session')),
			enableIngress: enableIngressMock,
			enableSsh: vi.fn(async () => createTestSshAccess()),
			exec: vi.fn(() => createManagedExecProcessStub({ stdout: '200' })),
			getHostProcessId: vi.fn(() => 28283),
			configureIngressRoutes: vi.fn(),
		};
		const systemConfig = await createSystemConfig();
		const configuredZone = systemConfig.zones[0];
		if (configuredZone === undefined || configuredZone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const toolPortalConfigDir = path.dirname(configuredZone.gateway.config);
		await writeMinimalMcpPortalConfigs(toolPortalConfigDir);
		const systemConfigWithToolPortal: LoadedSystemConfig = {
			...systemConfig,
			zones: [
				{
					...configuredZone,
					toolPortal: {
						...createGatewayZoneToolPortalConfig(toolPortalConfigDir),
					},
				},
			],
		};
		let connectedGatewayControlSessionOptions:
			| Parameters<GatewayControlSessionConnector>[0]
			| undefined;
		let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
		const connectGatewayControlSession = vi.fn<GatewayControlSessionConnector>(
			async (connectOptions) => {
				connectedGatewayControlSessionOptions = connectOptions;
				connectOptions.onHelloResponse?.({
					attachmentGeneration: 1,
					connectionId: testControlConnectionId,
					controllerEpoch: 'controller-epoch-test',
					outcome: 'accepted',
					sessionId: testControlSessionId,
				});
				return controlSessionClient;
			},
		);
		const gatewayControlProcessAdmissionCoordinator =
			createGatewayControlProcessAdmissionCoordinator();
		const healthEventStore = new HealthEventStore({
			eventHistoryLimit: 16,
			staleAfterMs: 30_000,
		});
		const onControlSessionAttachmentGap = vi.fn();
		const onControlSessionHeartbeat = vi.fn();
		const onControlSessionReconnectExhausted = vi.fn();

		const result = await startGatewayZone(
			{
				controlSession: { controllerEpoch: 'controller-epoch-test' },
				gatewayControlControllerExecutions: {
					authorizeControllerExecution: vi.fn(async () => ({ authorized: true }) as const),
					pushWorkspaceGit,
					runControllerHostProbe: vi.fn(async () => ({
						entryNames: ['agent-vm-host-probe.txt'],
						probeKind: 'controller_cache_dir_listing' as const,
					})),
				},
				gatewayControlBindingPublicationSource,
				gatewayControlLeaseRpc,
				gatewayControlProcessAdmissionCoordinator,
				healthEventStore,
				onControlSessionAttachmentGap,
				onControlSessionHeartbeat,
				onControlSessionReconnectExhausted,
				runTask: async (title, fn) => {
					taskTitles.push(title);
					await fn();
				},
				writeLog: (_level, telemetry) =>
					loggedMessages.push(telemetry?.operation ?? 'unknown-operation'),
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: systemConfigWithToolPortal,
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'fp',
						imageReference: '/tmp/img',
					})),
				},
				connectGatewayControlSession,
				managedVmFactory: {
					createManagedVm: vi.fn(async (createRequest) => {
						managedVmCreateRequest = createRequest;
						return managedVm;
					}),
				},
			},
		);

		expect(connectGatewayControlSession).toHaveBeenCalledWith({
			dispatcher: expect.objectContaining({
				dispatch: expect.any(Function),
				register: expect.any(Function),
			}),
			endpoint: {
				host: '127.0.0.1',
				path: '/__agent-vm/gateway-control',
				port: 18791,
			},
			material: expect.objectContaining({
				controllerEpoch: 'controller-epoch-test',
				peerId: 'gateway-shravan',
				zoneId: 'shravan',
			}),
			onAttachmentGap: expect.any(Function),
			onAttemptOutcome: expect.any(Function),
			onHelloResponse: expect.any(Function),
			onReconnectExhausted: expect.any(Function),
			processAdmissionCoordinator: gatewayControlProcessAdmissionCoordinator,
			recordHealthEvent: expect.any(Function),
			recordLiveHealthEvent: expect.any(Function),
			resolveInboundStablePrincipal: expect.any(Function),
			sessionFenceRegistry: expect.objectContaining({
				acceptSession: expect.any(Function),
				assertEnvelopeAccepted: expect.any(Function),
			}),
		});
		const connectedOptions = connectedGatewayControlSessionOptions;
		const connectedDispatcher = connectedOptions?.dispatcher;
		if (connectedOptions === undefined || connectedDispatcher === undefined) {
			throw new Error('Expected gateway control dispatcher.');
		}
		const runtimeServiceConfig = GatewayRuntimeServiceConfigSchema.parse(
			JSON.parse(
				requireManagedGatewayBootInputFile(
					managedVmCreateRequest,
					managedGatewayBootInputPaths.structuredRoot,
					'tool-portal-service.json',
				),
			),
		);
		const runtimeAgentProjection = runtimeServiceConfig.semanticSnapshot.agentProjections.main;
		if (runtimeAgentProjection === undefined) {
			throw new Error('Expected a runtime projection for the main agent.');
		}
		expect(runtimeServiceConfig.attachment.projectionCohortDigest).toBe(
			runtimeServiceConfig.semanticSnapshot.projectionCohortDigest,
		);
		const runtimePrincipal = {
			agentId: runtimeAgentProjection.agentId,
			frameworkIdentity: runtimeAgentProjection.frameworkIdentity,
			profileAssignmentRevision: runtimeAgentProjection.profileAssignmentRevision,
			toolPortalProfileId: runtimeAgentProjection.toolPortalProfileId,
		} satisfies GatewayRuntimeTrustedInvocationPrincipal;
		connectedOptions.recordHealthEvent?.({
			kind: 'caller-context-rejection',
			observedAtMs: 1_234,
			operation: 'lease_renew',
			reason: 'caller_context_stale',
			result: 'failed',
			zoneId: 'shravan',
		});
		expect(healthEventStore.listHistory()).toContainEqual({
			kind: 'caller-context-rejection',
			observedAtMs: 1_234,
			operation: 'lease_renew',
			reason: 'caller_context_stale',
			result: 'failed',
			zoneId: 'shravan',
		});
		const acceptedReconnectEvent = {
			attemptCount: 2,
			bootId: connectedOptions.material.processEpoch,
			domain: 'gateway_control',
			elapsedMs: 100,
			firstObservedAtMs: 2_000,
			kind: 'gateway-control-session',
			latestObservedAtMs: 2_100,
			observedAtMs: 2_100,
			operation: 'control-session-reconnect',
			outcome: 'accepted',
			peerId: connectedOptions.material.peerId,
			reconnectPhase: 'accepted',
			result: 'ok',
			terminalReason: 'accepted',
			windowState: 'closed',
			zoneId: connectedOptions.material.zoneId,
		} as const;
		connectedOptions.recordHealthEvent?.(acceptedReconnectEvent);
		connectedOptions.recordLiveHealthEvent?.({
			...acceptedReconnectEvent,
			latestObservedAtMs: 2_200,
			observedAtMs: 2_200,
			reconnectPhase: 'stable',
		});
		expect(healthEventStore.listLatestEventsForZone('shravan')).toContainEqual(
			expect.objectContaining({ reconnectPhase: 'stable' }),
		);
		const gatewayIdentity = result.gatewayIdentity;
		connectedOptions.onAttachmentGap?.({
			attachmentGeneration: 7,
			gapReason: 'transport close',
			gatewayEpoch: connectedOptions.material.generationId,
			kind: 'attachment_gap',
			observedAtMs: 123_456,
			processEpoch: connectedOptions.material.processEpoch,
			zoneId: connectedOptions.material.zoneId,
		});
		expect(onControlSessionAttachmentGap).toHaveBeenCalledExactlyOnceWith({
			attachmentGeneration: 7,
			gapReason: 'transport close',
			gateway: gatewayIdentity,
			gatewayEpoch: connectedOptions.material.generationId,
			kind: 'attachment_gap',
			observedAtMs: 123_456,
			processEpoch: connectedOptions.material.processEpoch,
			zoneId: connectedOptions.material.zoneId,
		});
		expect(() =>
			connectedOptions.onAttachmentGap?.({
				attachmentGeneration: 8,
				gapReason: 'stale process',
				gatewayEpoch: connectedOptions.material.generationId,
				kind: 'attachment_gap',
				observedAtMs: 123_457,
				processEpoch: 'stale-process',
				zoneId: connectedOptions.material.zoneId,
			}),
		).toThrow('does not match the current zone/process material');
		expect(onControlSessionAttachmentGap).toHaveBeenCalledTimes(1);
		connectedOptions.sessionFenceRegistry?.acceptSession({
			bootId: connectedOptions.material.processEpoch,
			connectionId: '55555555-5555-4555-8555-555555555555',
			controllerEpoch: 'controller-epoch-test',
			domain: 'gateway_control',
			peerId: 'gateway-shravan',
			sessionId: '33333333-3333-4333-8333-333333333333',
			zoneId: 'shravan',
		});
		await connectedDispatcher.dispatch({
			envelope: {
				bootId: connectedOptions.material.processEpoch,
				connectionId: '55555555-5555-4555-8555-555555555555',
				controllerEpoch: 'controller-epoch-test',
				createdAtMs: 1,
				deliveryPolicy: 'critical_idempotent',
				domain: 'gateway_control',
				kind: 'heartbeat',
				messageId: '11111111-1111-4111-8111-111111111111',
				peerId: 'gateway-shravan',
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				sequence: 1,
				sessionId: '33333333-3333-4333-8333-333333333333',
				zoneId: 'shravan',
			},
			payload: {
				kind: 'heartbeat',
				payload: { elapsedMs: 3, observedAtMs: 123_458 },
			},
		});
		expect(onControlSessionHeartbeat).toHaveBeenCalledExactlyOnceWith({
			gateway: gatewayIdentity,
			observedAtMs: 123_458,
			processEpoch: connectedOptions.material.processEpoch,
		});
		const semanticCommandCreatedAtMs = Date.now();
		const createEnvelope = (input: {
			readonly commandId: string;
			readonly deliveryPolicy: 'critical_idempotent' | 'single_use_critical';
			readonly expiresAtMs?: number;
			readonly idempotencyKey: string;
			readonly messageId: string;
			readonly operation:
				| 'caller_context_register'
				| 'lease_create'
				| 'tool_vm_binding_request'
				| 'tool_portal_controller_execution';
			readonly sequence: number;
		}): ControlEnvelope => ({
			bootId: connectedOptions.material.processEpoch,
			commandId: input.commandId,
			connectionId: '55555555-5555-4555-8555-555555555555',
			controllerEpoch: 'controller-epoch-test',
			createdAtMs: semanticCommandCreatedAtMs,
			deliveryPolicy: input.deliveryPolicy,
			domain: 'gateway_control',
			expiresAtMs: input.expiresAtMs ?? semanticCommandCreatedAtMs + 60_000,
			idempotencyKey: input.idempotencyKey,
			kind: 'command',
			messageId: input.messageId,
			operation: input.operation,
			peerId: 'gateway-shravan',
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			sequence: input.sequence,
			sessionId: '33333333-3333-4333-8333-333333333333',
			zoneId: 'shravan',
		});
		const leaseCallerEvidence = createTestCallerContextProofInput({
			agentId: 'main',
			principal: runtimePrincipal,
		});
		const registerResult = GatewayControlRpcCommandResultMessageSchema.parse(
			await connectedDispatcher.dispatch({
				envelope: createEnvelope({
					commandId: '44444444-4444-4444-8444-444444444444',
					deliveryPolicy: 'critical_idempotent',
					idempotencyKey: 'register-context',
					messageId: '22222222-2222-4222-8222-222222222222',
					operation: 'caller_context_register',
					sequence: 1,
				}),
				payload: {
					kind: 'command',
					operation: 'caller_context_register',
					payload: {
						adapterEvidence: {
							agentAuthority: signTestCallerContextAgentAuthority(
								leaseCallerEvidence,
								connectedOptions.material.agentAuthorityKeys.main,
							),
							...leaseCallerEvidence,
							proof: signTestCallerContextProof(
								leaseCallerEvidence,
								connectedOptions.material.callerContextProofKey,
							),
						},
					},
				},
			}),
		);
		const callerContextId = registerResult.payload.callerContext?.callerContextId;
		if (callerContextId === undefined) {
			throw new Error('Expected caller_context_register result to include callerContextId.');
		}
		await connectedDispatcher.dispatch({
			attachmentGeneration: 1,
			envelope: createEnvelope({
				commandId: '55555555-5555-4555-8555-555555555555',
				deliveryPolicy: 'critical_idempotent',
				idempotencyKey: 'lease-create',
				messageId: '66666666-6666-4666-8666-666666666666',
				operation: 'lease_create',
				sequence: 2,
			}),
			payload: {
				kind: 'command',
				operation: 'lease_create',
				payload: {
					callerContext: { callerContextId },
				},
			},
		});
		expect(prepareSemanticMutation).toHaveBeenCalledWith({
			attachmentGeneration: 1,
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId,
				zoneId: 'shravan',
			}),
			gateway: expect.objectContaining({
				bootId: connectedOptions.material.bootId,
				controllerEpoch: 'controller-epoch-test',
				generationId: connectedOptions.material.generationId,
				zoneId: 'shravan',
			}),
			operation: 'lease_create',
			payload: {
				callerContext: { callerContextId },
			},
			processEpoch: connectedOptions.material.processEpoch,
		});
		const bindingRequestExpiresAtMs = semanticCommandCreatedAtMs + 5_000;
		const bindingRequestResult = GatewayControlRpcCommandResultMessageSchema.parse(
			await connectedDispatcher.dispatch({
				attachmentGeneration: 1,
				envelope: createEnvelope({
					commandId: '12121212-1212-4212-8212-121212121212',
					deliveryPolicy: 'critical_idempotent',
					expiresAtMs: bindingRequestExpiresAtMs,
					idempotencyKey: 'tool-vm-binding-request',
					messageId: '13131313-1313-4313-8313-131313131313',
					operation: 'tool_vm_binding_request',
					sequence: 3,
				}),
				payload: {
					kind: 'command',
					operation: 'tool_vm_binding_request',
					payload: { callerContext: { callerContextId } },
				},
			}),
		);
		expect(bindingRequestResult).toMatchObject({
			kind: 'command_result',
			operation: 'tool_vm_binding_request',
			payload: { bindingRequest: { agentId: 'main', status: 'publication_pending' }, result: 'ok' },
		});
		expect(gatewayControlBindingPublicationSource.createBinding).toHaveBeenCalledOnce();
		expect(emitApplicationMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				bootId: connectedOptions.material.processEpoch,
				expiresAtMs: bindingRequestExpiresAtMs,
				operation: 'tool_vm_binding_publish',
			}),
			{ kind: 'command', operation: 'tool_vm_binding_publish' },
			expect.objectContaining({
				operation: 'tool_vm_binding_publish',
				payload: expect.objectContaining({
					authority: expect.objectContaining({
						gatewayEpoch: connectedOptions.material.generationId,
						processEpoch: connectedOptions.material.processEpoch,
					}),
					binding: expect.objectContaining({ agentId: 'main', leaseId: 'lease-main' }),
					kind: 'current',
				}),
			}),
			expect.objectContaining({ commandResultTimeoutMs: expect.any(Number) }),
		);
		const hostActionRegisterResult = GatewayControlRpcCommandResultMessageSchema.parse(
			await connectedDispatcher.dispatch({
				envelope: createEnvelope({
					commandId: '99999999-9999-4999-8999-999999999999',
					deliveryPolicy: 'critical_idempotent',
					idempotencyKey: 'register-host-action-context',
					messageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
					operation: 'caller_context_register',
					sequence: 3,
				}),
				payload: {
					kind: 'command',
					operation: 'caller_context_register',
					payload: {
						adapterEvidence: {
							agentAuthority: signTestCallerContextAgentAuthority(
								{
									...leaseCallerEvidence,
									purpose: 'tool_portal_controller_execution',
								},
								connectedOptions.material.agentAuthorityKeys.main,
							),
							...leaseCallerEvidence,
							proof: signTestCallerContextProof(
								{
									...leaseCallerEvidence,
									purpose: 'tool_portal_controller_execution',
								},
								connectedOptions.material.callerContextProofKey,
							),
							purpose: 'tool_portal_controller_execution',
						},
					},
				},
			}),
		);
		const hostActionCallerContextId =
			hostActionRegisterResult.payload.callerContext?.callerContextId;
		if (hostActionCallerContextId === undefined) {
			throw new Error(
				'Expected host-action caller_context_register result to include callerContextId.',
			);
		}
		const hostActionResult = GatewayControlRpcCommandResultMessageSchema.parse(
			await connectedDispatcher.dispatch({
				attachmentGeneration: 1,
				envelope: createEnvelope({
					commandId: '77777777-7777-4777-8777-777777777777',
					deliveryPolicy: 'single_use_critical',
					idempotencyKey: 'workspace-git-push',
					messageId: '88888888-8888-4888-8888-888888888888',
					operation: 'tool_portal_controller_execution',
					sequence: 4,
				}),
				payload: {
					kind: 'command',
					operation: 'tool_portal_controller_execution',
					payload: {
						actionId: 'workspace_git_push',
						callerContext: { callerContextId: hostActionCallerContextId },
						correlation: {
							capability: {
								name: 'workspace_git_push',
								namespace: 'controller_execution',
							},
						},
						expectedHead: pushedWorkspaceGitHead,
					},
				},
			}),
		);
		expect(pushWorkspaceGit).toHaveBeenCalledWith({
			callerContext: expect.objectContaining({
				agentId: 'main',
				callerContextId: hostActionCallerContextId,
				purpose: 'tool_portal_controller_execution',
				zoneId: 'shravan',
			}),
			payload: {
				actionId: 'workspace_git_push',
				callerContext: { callerContextId: hostActionCallerContextId },
				correlation: {
					capability: {
						name: 'workspace_git_push',
						namespace: 'controller_execution',
					},
				},
				expectedHead: pushedWorkspaceGitHead,
			},
			session: expect.objectContaining({
				peerId: 'gateway-shravan',
				zoneId: 'shravan',
			}),
		});
		expect(hostActionResult).toMatchObject({
			kind: 'command_result',
			operation: 'tool_portal_controller_execution',
			payload: {
				controllerExecution: {
					actionId: 'workspace_git_push',
					result: {
						branch: 'agent/main',
						localHead: pushedWorkspaceGitHead,
						pushedCommits: [{ sha: pushedWorkspaceGitHead, subject: 'docs: update memory' }],
						remoteHead: pushedWorkspaceGitHead,
					},
				},
				result: 'ok',
			},
		});
		expect(taskTitles).toContain('Connecting gateway control session');
		expect(taskTitles.indexOf('Connecting gateway control session')).toBeLessThan(
			taskTitles.indexOf('Recording gateway runtime'),
		);
		expect(requireManagedGatewayResult(result).controlSession).toBe(controlSessionClient);

		const zone = systemConfigWithToolPortal.zones.find((candidate) => candidate.id === 'shravan');
		if (zone?.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw test zone.');
		}
		const effectiveConfig = parseJsonObject(
			await readFile(path.join(zone.gateway.stateDir, 'effective-openclaw.json'), 'utf8'),
		);
		const effectiveGondolinConfig = requireObjectProperty(
			requireObjectProperty(
				requireObjectProperty(requireObjectProperty(effectiveConfig, 'plugins'), 'entries'),
				'gondolin',
			),
			'config',
		);
		expect(effectiveGondolinConfig).not.toHaveProperty('controlSession');
		expect(requireObjectProperty(effectiveGondolinConfig, 'toolPortal')).toMatchObject({
			agentProjections: {
				main: {
					agentId: 'main',
					frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
					profileAssignmentRevision: expect.any(String),
					toolPortalProfileId: 'default',
				},
			},
			attachment: {
				clientKind: 'openclaw-managed-plugin',
				configuredAgentIds: ['main'],
				projectionCohortDigest: expect.stringMatching(/^projection-cohort:[a-f0-9]{64}$/u),
			},
		});
		const toolPortalServiceConfig = GatewayRuntimeServiceConfigSchema.parse(
			JSON.parse(
				requireManagedGatewayBootInputFile(
					managedVmCreateRequest,
					managedGatewayBootInputPaths.structuredRoot,
					'tool-portal-service.json',
				),
			),
		);
		expect(toolPortalServiceConfig.controlEndpoint.identity).toMatchObject({
			controllerEpoch: 'controller-epoch-test',
			peerId: 'gateway-shravan',
		});
		expect(toolPortalServiceConfig.controlEndpoint.authority.verifierPublicKeyPem).toMatch(
			/^-----BEGIN PUBLIC KEY-----/u,
		);

		const controllerRuntimeRecordTarget = resolveTestManagedGatewayRuntimeRecordTarget({
			systemConfig: systemConfigWithToolPortal,
			zoneId: 'shravan',
		});
		const controllerRuntimeRecordText = await readFile(
			controllerRuntimeRecordTarget.filePath,
			'utf8',
		);
		const controllerRuntimeRecord = parseJsonObject(controllerRuntimeRecordText);
		expect(controllerRuntimeRecord).not.toHaveProperty('controlSession');
		expect(controllerRuntimeRecordText).not.toContain('privateKeyPkcs8Pem');
		expect(controllerRuntimeRecordText).not.toContain('BEGIN PRIVATE KEY');
		await expect(
			readFile(path.join(zone.gateway.stateDir, 'gateway-runtime.json'), 'utf8'),
		).rejects.toMatchObject({ code: 'ENOENT' });

		const controllerOnlyMaterialText = await readFile(
			resolveGatewayControlSessionMaterialPath(zone.gateway.zoneRuntimeDir),
			'utf8',
		);
		const controllerOnlyMaterial = requireObjectProperty(
			parseJsonObject(controllerOnlyMaterialText),
			'material',
		);
		const connectedMaterial = connectedOptions.material;
		expect(controllerOnlyMaterial).toMatchObject({
			bootId: connectedMaterial.bootId,
			controllerEpoch: connectedMaterial.controllerEpoch,
			generationId: connectedMaterial.generationId,
			peerId: connectedMaterial.peerId,
			zoneId: connectedMaterial.zoneId,
		});
		expect(controllerOnlyMaterialText).toContain('privateKeyPkcs8Pem');
		expect(controllerOnlyMaterialText).toContain('BEGIN PRIVATE KEY');
		if (bindingRetirementListener === undefined) {
			throw new Error('Expected the Gateway binding retirement subscription.');
		}
		let retirementListenerSettled = false;
		const retirementListenerPromise = Promise.resolve(
			bindingRetirementListener({ leaseId: 'lease-main', reason: 'dead' }),
		).then(() => {
			retirementListenerSettled = true;
		});
		await retirementPublicationObserved.promise;
		await Promise.resolve();
		expect(retirementListenerSettled).toBe(false);
		expect(emitApplicationMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ operation: 'tool_vm_binding_publish' }),
			{ kind: 'command', operation: 'tool_vm_binding_publish' },
			expect.objectContaining({
				payload: expect.objectContaining({
					binding: expect.not.objectContaining({ ssh: expect.anything() }),
					kind: 'retired',
					reason: 'dead',
				}),
			}),
			expect.any(Object),
		);
		retirementPublicationAcknowledgement.resolve();
		await retirementListenerPromise;
		expect(retirementListenerSettled).toBe(true);
		await result.destroyGateway();
		expect(unsubscribeBindingRetirement).toHaveBeenCalledOnce();
	});

	it('accepts caller context registration for declared non-default agents in multi-agent OpenClaw zones', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};
		const agentProjections = createTestAgentProjections(['main', 'second']);
		const callerEvidence = createTestCallerContextProofInput({ agentId: 'second' });

		expect(
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				agentProjections,
				callerContextProofKey: testCallerContextProofKey,
				payload: createSignedTestCallerContextRegisterPayload(callerEvidence),
				zone: multiAgentZone,
			}),
		).toBeUndefined();
	});

	it('accepts caller context registration only for the exact authored Hermes profile', async () => {
		// Arrange
		const systemConfig = await createHermesSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'hermes') {
			throw new Error('Expected Hermes gateway test zone.');
		}
		const principal = createTestInvocationPrincipal('second', {
			frameworkIdentity: { kind: 'hermes', profileName: 'beta-second' },
		});
		const agentProjections = {
			second: {
				agentId: 'second',
				frameworkIdentity: principal.frameworkIdentity,
				profileAssignmentRevision: principal.profileAssignmentRevision,
				toolPortalNamespaceNames: [],
				toolPortalProfileId: principal.toolPortalProfileId,
			},
		};
		const callerEvidence = createTestCallerContextProofInput({ agentId: 'second', principal });

		// Act / Assert
		expect(
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				agentProjections,
				callerContextProofKey: testCallerContextProofKey,
				payload: createSignedTestCallerContextRegisterPayload(callerEvidence),
				zone,
			}),
		).toBeUndefined();
		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				agentProjections,
				callerContextProofKey: testCallerContextProofKey,
				payload: createSignedTestCallerContextRegisterPayload(
					createTestCallerContextProofInput({
						agentId: 'second',
						principal: {
							...principal,
							frameworkIdentity: { kind: 'hermes', profileName: 'beta-main' },
						},
					}),
				),
				zone,
			}),
		).toThrow(/framework identity/u);
	});

	it('rejects caller context registration with a mismatched OpenClaw framework identity', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};
		const agentProjections = createTestAgentProjections(['main', 'second']);
		const callerEvidence = createTestCallerContextProofInput({
			agentId: 'second',
			principal: createTestInvocationPrincipal('second', {
				frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
			}),
		});

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				agentProjections,
				callerContextProofKey: testCallerContextProofKey,
				payload: createSignedTestCallerContextRegisterPayload(callerEvidence),
				zone: multiAgentZone,
			}),
		).toThrow(/framework identity/u);
	});

	it('rejects caller context registration outside the immutable projection revision', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};
		const agentProjections = createTestAgentProjections(['main', 'second']);
		const callerEvidence = createTestCallerContextProofInput({
			agentId: 'second',
			principal: createTestInvocationPrincipal('second', {
				profileAssignmentRevision: 'profile-assignment:stale',
			}),
		});

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				agentProjections,
				callerContextProofKey: testCallerContextProofKey,
				payload: createSignedTestCallerContextRegisterPayload(callerEvidence),
				zone: multiAgentZone,
			}),
		).toThrow(/immutable projection/u);
	});

	it('rejects caller context registration without per-agent authority proof in multi-agent OpenClaw zones', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};
		const agentProjections = createTestAgentProjections(['main', 'second']);
		const callerEvidence = createTestCallerContextProofInput({ agentId: 'second' });

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				agentProjections,
				callerContextProofKey: testCallerContextProofKey,
				payload: {
					adapterEvidence: {
						...callerEvidence,
						proof: signTestCallerContextProof(callerEvidence),
					},
				} as unknown as GatewayControlCallerContextRegisterPayload,
				zone: multiAgentZone,
			}),
		).toThrow(/agent authority/u);
	});

	it('rejects caller context registration when the proof was not issued for the session material', async () => {
		const systemConfig = await createSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'openclaw') {
			throw new Error('Expected OpenClaw gateway test zone.');
		}
		const multiAgentZone = {
			...zone,
			agents: [{ id: 'main' }, { id: 'second' }],
		};
		const agentProjections = createTestAgentProjections(['main', 'second']);
		const callerEvidence = createTestCallerContextProofInput({ agentId: 'second' });

		expect(() =>
			validateGatewayControlCallerContextRegistration({
				agentAuthorityKeys: testAgentAuthorityKeys,
				agentProjections,
				callerContextProofKey: testCallerContextProofKey,
				payload: createSignedTestCallerContextRegisterPayload(callerEvidence, {
					callerContextProofKey: 'wrong-caller-context-proof-key',
				}),
				zone: multiAgentZone,
			}),
		).toThrow(/caller-context proof/u);
	});

	it('boots Hermes through the common managed Gateway cohort with exact per-agent profiles', async () => {
		// Arrange
		const systemConfig = await createHermesSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'hermes') {
			throw new Error('Expected Hermes gateway test zone.');
		}
		const agentIds = ['main', 'second'] as const;
		const mainAgent = zone.agents?.find((agent) => agent.id === 'main');
		if (mainAgent === undefined) {
			throw new Error('Expected Hermes main agent.');
		}
		mainAgent.workspaceGit = { mode: 'local' };
		const zoneFilesDir = zone.gateway.zoneFilesDir;
		let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
		const { exec, managedVm } = createHealthyGatewayVmStub('vm-managed-hermes', 28_402);
		const createControlSessionMaterial = vi.fn(
			(
				options: Parameters<
					NonNullable<GatewayManagerDependencies['createGatewayControlSessionMaterial']>
				>[0],
			) =>
				createGatewayControlSessionMaterial({
					agentIds,
					bootId: testGatewayBootId,
					controllerEpoch: options.controllerEpoch,
					generationId: testGatewayGenerationId,
					zoneId: options.zoneId,
				}),
		);

		// Act
		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					API_SERVER_KEY: 'test-hermes-api-server-key',
					DISCORD_BOT_TOKEN_MAIN: 'test-hermes-main-discord-token',
					DISCORD_BOT_TOKEN_SECOND: 'test-hermes-second-discord-token',
				}),
				systemConfig,
				zoneId: zone.id,
			},
			{
				createGatewayControlSessionMaterial: createControlSessionMaterial,
				managedVmFactory: {
					createManagedVm: vi.fn(async (createRequest) => {
						managedVmCreateRequest = createRequest;
						return managedVm;
					}),
				},
				managedVmImages: testManagedVmImages,
			},
		);

		// Assert
		const managedResult = requireManagedGatewayResult(result);
		expect(createControlSessionMaterial).toHaveBeenCalledOnce();
		expect(createControlSessionMaterial).toHaveBeenCalledWith({
			agentIds,
			controllerEpoch: 'controller-epoch-test',
			zoneId: zone.id,
		});
		expect(managedResult.expectedCohort.frameworkIdentity).toMatchObject({
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: agentIds,
			frameworkKind: 'hermes',
		});
		expect(managedResult.bootContract.frameworkService).toMatchObject({
			framework: 'hermes',
			role: 'framework-service',
		});
		const frameworkServiceConfig = parseJsonObject(
			requireManagedGatewayBootInputFile(
				managedVmCreateRequest,
				managedGatewayBootInputPaths.structuredRoot,
				'framework-service.json',
			),
		);
		expect(frameworkServiceConfig).toMatchObject({
			agentProjections: {
				main: {
					agentId: 'main',
					frameworkIdentity: { kind: 'hermes', profileName: 'beta-main' },
					toolPortalProfileId: 'default',
				},
				second: {
					agentId: 'second',
					frameworkIdentity: { kind: 'hermes', profileName: 'beta-second' },
					toolPortalProfileId: 'default',
				},
			},
			attachment: {
				clientKind: 'hermes-managed-plugin',
				configuredAgentIds: agentIds,
			},
			profileEnvironmentSourceNamesByProfile: {
				'beta-main': {
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_MAIN',
				},
				'beta-second': {
					DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_SECOND',
				},
			},
		});
		const frameworkEnvironment = requireManagedGatewayBootInputFile(
			managedVmCreateRequest,
			managedGatewayBootInputPaths.environmentRoot,
			'framework.environment.sh',
		);
		expect(frameworkEnvironment).toContain(
			"export DISCORD_BOT_TOKEN_MAIN='test-hermes-main-discord-token'",
		);
		expect(frameworkEnvironment).toContain(
			"export DISCORD_BOT_TOKEN_SECOND='test-hermes-second-discord-token'",
		);
		expect(() =>
			requireManagedGatewayBootInputFile(
				managedVmCreateRequest,
				managedGatewayBootInputPaths.environmentRoot,
				'openclaw-gateway-token.environment.sh',
			),
		).toThrow();
		expect(() =>
			requireManagedGatewayBootInputFile(
				managedVmCreateRequest,
				managedGatewayBootInputPaths.environmentRoot,
				'openclaw-all-secrets.environment.sh',
			),
		).toThrow();
		expect(managedVmCreateRequest?.environment).not.toHaveProperty('DISCORD_BOT_TOKEN_MAIN');
		expect(managedVmCreateRequest?.environment).not.toHaveProperty('DISCORD_BOT_TOKEN_SECOND');
		const toolPortalServiceConfig = GatewayRuntimeServiceConfigSchema.parse(
			JSON.parse(
				requireManagedGatewayBootInputFile(
					managedVmCreateRequest,
					managedGatewayBootInputPaths.structuredRoot,
					'tool-portal-service.json',
				),
			),
		);
		expect(toolPortalServiceConfig.attachment).toMatchObject({
			clientKind: 'hermes-managed-plugin',
			configuredAgentIds: agentIds,
		});
		const workspaceRootStats = await Promise.all(
			agentIds.map(async (agentId) => await stat(path.join(zoneFilesDir, 'agents', agentId))),
		);
		expect(workspaceRootStats.every((rootStats) => rootStats.isDirectory())).toBe(true);
		expect(
			(
				await stat(path.join(zone.gateway.zoneRuntimeDir, 'gitdirs', 'agents', 'main'))
			).isDirectory(),
		).toBe(true);
		await expect(
			stat(path.join(zone.gateway.zoneRuntimeDir, 'gitdirs', 'agents', 'second')),
		).rejects.toMatchObject({ code: 'ENOENT' });
		expect((await stat(path.join(zone.gateway.zoneRuntimeDir, 'logs'))).isDirectory()).toBe(true);
		const execCallCountBeforeDestroy = exec.mock.calls.length;
		await managedResult.destroyGateway();
		expect(exec).toHaveBeenCalledTimes(execCallCountBeforeDestroy);
	});

	it('keeps Hermes profile projection and Tool VM agent access selectors isolated', async () => {
		const sourceName = 'PROFILE_A_PROVIDER_KEY';
		const sourceRef = 'op://agent-vm/hermes-profile-a-provider/credential';
		const systemConfig = await createHermesSystemConfig();
		const zone = systemConfig.zones[0];
		if (zone === undefined || zone.gateway.type !== 'hermes') {
			throw new Error('Expected Hermes gateway test zone.');
		}
		zone.gateway.profileSecretProjectionsByAgent.main = {
			...zone.gateway.profileSecretProjectionsByAgent.main,
			OPENROUTER_API_KEY: sourceName,
		};
		zone.secrets[sourceName] = {
			agentAccess: ['second'],
			audience: 'both',
			hosts: ['openrouter.ai'],
			injection: 'http-mediation',
			ref: sourceRef,
			source: '1password',
		};
		zone.egressHosts = [...zone.egressHosts, { audience: 'both', host: 'openrouter.ai' }];
		let managedVmCreateRequest: ManagedVmCreateRequest | undefined;
		const { managedVm } = createHealthyGatewayVmStub('vm-hermes-selector-isolation', 28_403);

		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					[sourceRef]: 'test-profile-a-provider-key',
				}),
				systemConfig,
				zoneId: zone.id,
			},
			{
				managedVmFactory: {
					createManagedVm: vi.fn(async (createRequest) => {
						managedVmCreateRequest = createRequest;
						return managedVm;
					}),
				},
				managedVmImages: testManagedVmImages,
			},
		);

		expect(selectToolVmMediatedSecretNamesForAgent({ agentId: 'main', zone }).has(sourceName)).toBe(
			false,
		);
		expect(
			selectToolVmMediatedSecretNamesForAgent({ agentId: 'second', zone }).has(sourceName),
		).toBe(true);
		const frameworkServiceConfig = parseJsonObject(
			requireManagedGatewayBootInputFile(
				managedVmCreateRequest,
				managedGatewayBootInputPaths.structuredRoot,
				'framework-service.json',
			),
		);
		const profileSources = frameworkServiceConfig.profileEnvironmentSourceNamesByProfile as Record<
			string,
			Record<string, string>
		>;
		expect(profileSources['beta-main']).toMatchObject({ OPENROUTER_API_KEY: sourceName });
		expect(profileSources['beta-second']).not.toHaveProperty('OPENROUTER_API_KEY');
		const projectedDescriptor = managedVmCreateRequest?.mediatedSecrets.find(
			(secret) => secret.environmentVariable === sourceName,
		);
		expect(projectedDescriptor?.guestPlaceholder).toMatch(/^GONDOLIN_SECRET_[0-9a-f]{48}$/u);
		const toolPortalEnvironment = requireManagedGatewayBootInputFile(
			managedVmCreateRequest,
			managedGatewayBootInputPaths.environmentRoot,
			'tool-portal.environment.sh',
		);
		expect(toolPortalEnvironment).not.toContain(sourceName);
		expect(toolPortalEnvironment).not.toContain('OPENROUTER_API_KEY');
		await requireManagedGatewayResult(result).destroyGateway();
	});

	it('rejects a projected mediated source colliding with constructed Hermes OTel environment', async () => {
		const collisionSourceName = 'OTEL_SERVICE_NAME';
		const collisionSourceRef = 'op://agent-vm/hermes-otel-collision/credential';
		const hermesSystemConfig = await createHermesSystemConfig();
		const observabilitySystemConfig = createObservabilitySystemConfig(await createSystemConfig(), {
			controllerStartPolicy: 'off',
			zoneEnabled: true,
		});
		const zone = hermesSystemConfig.zones[0];
		const observabilityZone = observabilitySystemConfig.zones[0];
		if (
			zone === undefined ||
			zone.gateway.type !== 'hermes' ||
			observabilityZone?.observability === undefined
		) {
			throw new Error('Expected Hermes and observability gateway test zones.');
		}
		zone.observability = observabilityZone.observability;
		zone.gateway.profileSecretProjectionsByAgent.main = {
			...zone.gateway.profileSecretProjectionsByAgent.main,
			OPENROUTER_API_KEY: collisionSourceName,
		};
		zone.secrets[collisionSourceName] = {
			audience: 'gateway',
			hosts: ['openrouter.ai'],
			injection: 'http-mediation',
			ref: collisionSourceRef,
			source: '1password',
		};
		zone.egressHosts = [...zone.egressHosts, { audience: 'gateway', host: 'openrouter.ai' }];
		const systemConfig = {
			...observabilitySystemConfig,
			imageProfiles: hermesSystemConfig.imageProfiles,
			zones: [zone],
		};
		const { finalizeMemoryMount, managedVm, start } = createHealthyGatewayVmStub(
			'vm-hermes-otel-collision',
			28_404,
		);

		await expect(
			startGatewayZone(
				{
					secretResolver: createOpenClawSecretResolver({
						[collisionSourceRef]: 'test-hermes-otel-collision-key',
					}),
					systemConfig,
					zoneId: zone.id,
				},
				{
					managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
					managedVmImages: testManagedVmImages,
				},
			),
		).rejects.toThrow(
			"Managed Gateway framework mediated source 'OTEL_SERVICE_NAME' collides with the constructed framework environment.",
		);
		expect(finalizeMemoryMount).not.toHaveBeenCalled();
		expect(start).not.toHaveBeenCalled();
	});

	it('exposes managed OpenClaw as an image-owned cohort without controller process authority', async () => {
		const { exec, managedVm } = createHealthyGatewayVmStub('vm-managed-openclaw-hard-cut', 28_401);
		const result = await startGatewayZone(
			{
				secretResolver: createOpenClawSecretResolver({
					DISCORD_BOT_TOKEN: 'discord-token',
					OPENCLAW_GATEWAY_TOKEN: 'gateway-token-123',
					PERPLEXITY_API_KEY: 'pplx-key',
				}),
				systemConfig: await createSystemConfig(),
				zoneId: 'shravan',
			},
			{
				managedVmImages: {
					prepareImage: vi.fn(async () => ({
						built: true,
						fingerprint: 'managed-openclaw-hard-cut-image',
						imageReference: '/tmp/managed-openclaw-hard-cut-image',
					})),
				},
				managedVmFactory: { createManagedVm: vi.fn(async () => managedVm) },
			},
		);

		const managedResult = requireManagedGatewayResult(result);
		expect(managedResult.bootContract).toMatchObject({
			contractVersion: 1,
			frameworkService: {
				framework: 'openclaw',
				role: 'framework-service',
			},
			kind: 'managed-gateway-exact-two-role',
			toolPortalService: {
				role: 'tool-portal-service',
			},
		});
		expect(managedResult.expectedCohort.frameworkIdentity).toMatchObject({
			configuredAgentIds: ['main'],
			frameworkKind: 'openclaw',
		});
		expect(managedResult).not.toHaveProperty('openClawProcessEpochOwner');
		expect(managedResult).not.toHaveProperty('processEpoch');
		expect(managedResult).not.toHaveProperty('processSpec');
		const managedExecCommands = exec.mock.calls.map(([command]) => command);
		expect(managedExecCommands).toEqual([
			expectedManagedOpenClawReadinessCommand,
			expectedManagedOpenClawReadinessCommand,
		]);
		expect(
			managedExecCommands.some((command) =>
				typeof command === 'string'
					? /(?:nohup|bootstrap|start-(?:openclaw|hermes)|gateway-runtime)/u.test(command)
					: true,
			),
		).toBe(false);
	});
});
