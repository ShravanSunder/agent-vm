import {
	deriveGatewayControlStablePrincipal,
	GatewayControlLeaseCreateIntentPayloadSchema,
	GatewayControlLeaseIdPayloadSchema,
	GatewayControlLeaseReacquireIntentPayloadSchema,
	GatewayControlLeaseSnapshotSchema,
	GatewayControlLeaseUseEndPayloadSchema,
	GatewayControlLeaseUseHeartbeatPayloadSchema,
	GatewayControlLeaseUseStartPayloadSchema,
	type GatewayControlLeaseSnapshot,
} from '@agent-vm/gateway-control-contracts';
import type { AgentVmHealthEvent } from '@agent-vm/gateway-lifecycle';
import { describe, expect, it, vi } from 'vitest';

import {
	TEST_SSH_SERVER_HOST_KEY,
	createManagedExecProcessStub,
} from '../../testing/managed-vm-test-helpers.js';
import type { ControllerToolLeaseRecordsTarget } from '../durable-state/controller-state-record-paths.js';
import { createLeaseManager } from '../leases/lease-manager.js';
import { createTcpPool } from '../leases/tcp-pool.js';
import type {
	GatewayOwnershipCoordinator,
	ToolVmMembershipHandle,
} from '../vm-ownership/gateway-ownership-coordinator.js';
import {
	gatewayIdentitiesEqual,
	type GatewayEpochIdentity,
} from '../vm-ownership/vm-ownership-contracts.js';
import type { GatewayControlTrustedCallerContext } from './gateway-control-caller-context.js';
import type {
	GatewayControlLeaseRpcOperations,
	GatewayControlLeaseSemanticMutationOperation,
	GatewayControlLeaseSemanticMutationPayload,
	GatewayControlLeaseSemanticMutationResult,
	GatewayControlPreparedLeaseSemanticMutation,
} from './gateway-control-domain-handler.js';
import { createGatewayControlLeaseRpcOperations } from './gateway-control-lease-rpc.js';
import {
	createGatewaySemanticResultLedger,
	type GatewaySemanticExecutionProof,
} from './gateway-semantic-result-ledger.js';

const callerPrincipal = {
	agentId: 'main',
	frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
	profileAssignmentRevision: 'assignment-main',
	toolPortalProfileId: 'standard',
} as const;
const optionalToolCorrelationSessionKeyDigest = '0123456789abcdef0123456789abcdef';
const testHostGitDirectoryRoot = '/host/runtime/zones/zone-a/gitdirs/agents/main';

const callerContext = {
	agentId: 'main',
	bootId: 'gateway-boot-a',
	callerContextId: '44444444-4444-4444-8444-444444444444',
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'epoch-a',
	peerId: 'gateway-zone-a',
	principal: callerPrincipal,
	purpose: 'tool_vm_lease',
	sessionId: '33333333-3333-4333-8333-333333333333',
	stablePrincipal: deriveGatewayControlStablePrincipal({
		principal: callerPrincipal,
	}),
	zoneId: 'zone-a',
} satisfies GatewayControlTrustedCallerContext;

const otherCallerContext = {
	...callerContext,
	agentId: 'other',
	callerContextId: '55555555-5555-4555-8555-555555555555',
	principal: {
		...callerPrincipal,
		agentId: 'other',
		frameworkIdentity: { agentId: 'other', kind: 'openclaw' },
	},
	stablePrincipal: deriveGatewayControlStablePrincipal({
		principal: {
			...callerPrincipal,
			agentId: 'other',
			frameworkIdentity: { agentId: 'other', kind: 'openclaw' },
		},
	}),
} satisfies GatewayControlTrustedCallerContext;

const refreshedCallerContext = {
	...callerContext,
	callerContextId: '66666666-6666-4666-8666-666666666666',
	connectionId: '77777777-7777-4777-8777-777777777777',
	sessionId: '88888888-8888-4888-8888-888888888888',
} satisfies GatewayControlTrustedCallerContext;

const refreshedCallerContextIdOnly = {
	...callerContext,
	callerContextId: refreshedCallerContext.callerContextId,
} satisfies GatewayControlTrustedCallerContext;

const sameAgentDifferentSessionCallerContext = {
	...callerContext,
	callerContextId: '99999999-9999-4999-8999-999999999999',
	connectionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	sessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
	stablePrincipal: callerContext.stablePrincipal,
} satisfies GatewayControlTrustedCallerContext;

const callerContextPayload = {
	callerContext: {
		callerContextId: callerContext.callerContextId,
	},
};

const TEST_GATEWAY_EPOCH = {
	bootId: callerContext.bootId,
	controllerEpoch: callerContext.controllerEpoch,
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'gateway-generation-a',
	zoneId: callerContext.zoneId,
} satisfies GatewayEpochIdentity;

const OTHER_GATEWAY_EPOCH = {
	...TEST_GATEWAY_EPOCH,
	bootId: 'gateway-boot-b',
	controllerEpoch: 'epoch-b',
	gatewayEpochId: 'gateway-epoch-b',
	gatewayVmId: 'gateway-vm-b',
	generationId: 'gateway-generation-b',
} satisfies GatewayEpochIdentity;

const TEST_PROCESS_EPOCH = 'gateway-control-lease-rpc-process-epoch';
const TEST_ATTACHMENT_GENERATION = 1;
const TEST_OPERATION_PAYLOAD_DIGEST =
	'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createDeferredValue<TValue>(): {
	readonly promise: Promise<TValue>;
	resolve(value: TValue): void;
} {
	let resolveDeferredValue: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolveDeferredValue = resolve;
	});
	return {
		promise,
		resolve(value: TValue): void {
			if (resolveDeferredValue === undefined) {
				throw new Error('deferred value resolver was not initialized');
			}
			resolveDeferredValue(value);
		},
	};
}

type ExpectedLeaseRpcSurface = 'getLease' | 'prepareSemanticMutation';

const leaseRpcHasNoDirectMutationMethods: Exclude<
	keyof GatewayControlLeaseRpcOperations,
	ExpectedLeaseRpcSurface
> extends never
	? true
	: false = true;
const leaseRpcHasEveryHardCutMethod: Exclude<
	ExpectedLeaseRpcSurface,
	keyof GatewayControlLeaseRpcOperations
> extends never
	? true
	: false = true;

interface TestLeaseSemanticMutationRequest {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly gateway?: GatewayEpochIdentity;
	readonly payload: GatewayControlLeaseSemanticMutationPayload;
}

function executeLeaseSemanticMutation(
	leaseRpc: GatewayControlLeaseRpcOperations,
	operation: 'lease_create',
	request: TestLeaseSemanticMutationRequest,
): Promise<GatewayControlLeaseSnapshot>;
function executeLeaseSemanticMutation(
	leaseRpc: GatewayControlLeaseRpcOperations,
	operation: Exclude<GatewayControlLeaseSemanticMutationOperation, 'lease_create'>,
	request: TestLeaseSemanticMutationRequest,
): Promise<GatewayControlLeaseSemanticMutationResult>;
async function executeLeaseSemanticMutation(
	leaseRpc: GatewayControlLeaseRpcOperations,
	operation: GatewayControlLeaseSemanticMutationOperation,
	request: TestLeaseSemanticMutationRequest,
): Promise<GatewayControlLeaseSemanticMutationResult> {
	const gateway = request.gateway ?? TEST_GATEWAY_EPOCH;
	const preparationBase = {
		attachmentGeneration: TEST_ATTACHMENT_GENERATION,
		callerContext: request.callerContext,
		gateway,
		processEpoch: TEST_PROCESS_EPOCH,
	};
	const preparedMutation =
		await (async (): Promise<GatewayControlPreparedLeaseSemanticMutation> => {
			switch (operation) {
				case 'lease_create':
					return await leaseRpc.prepareSemanticMutation({
						...preparationBase,
						operation,
						payload: GatewayControlLeaseCreateIntentPayloadSchema.parse(request.payload),
					});
				case 'lease_reacquire':
					return await leaseRpc.prepareSemanticMutation({
						...preparationBase,
						operation,
						payload: GatewayControlLeaseReacquireIntentPayloadSchema.parse(request.payload),
					});
				case 'lease_release':
				case 'lease_renew':
					return await leaseRpc.prepareSemanticMutation({
						...preparationBase,
						operation,
						payload: GatewayControlLeaseIdPayloadSchema.parse(request.payload),
					});
				case 'lease_use_end':
					return await leaseRpc.prepareSemanticMutation({
						...preparationBase,
						operation,
						payload: GatewayControlLeaseUseEndPayloadSchema.parse(request.payload),
					});
				case 'lease_use_heartbeat':
					return await leaseRpc.prepareSemanticMutation({
						...preparationBase,
						operation,
						payload: GatewayControlLeaseUseHeartbeatPayloadSchema.parse(request.payload),
					});
				case 'lease_use_start':
					return await leaseRpc.prepareSemanticMutation({
						...preparationBase,
						operation,
						payload: GatewayControlLeaseUseStartPayloadSchema.parse(request.payload),
					});
			}
			operation satisfies never;
			throw new Error('Unsupported test lease semantic mutation operation.');
		})();
	const proof = {
		identity: {
			commandId: `test-${operation}-command`,
			gateway,
			idempotencyKey: `test-${operation}-idempotency`,
			operation,
			profile: preparedMutation.profile,
			target: preparedMutation.target,
			validUntilMs: 60_000,
		},
		operationPayloadDigest: {
			algorithm: 'sha256',
			canonicalVersion: 1,
			digest: TEST_OPERATION_PAYLOAD_DIGEST,
		},
		semanticOperationId: `test-${operation}-semantic-operation`,
	} satisfies GatewaySemanticExecutionProof;
	const result = await preparedMutation.execute(proof);
	return operation === 'lease_create' ? GatewayControlLeaseSnapshotSchema.parse(result) : result;
}

const TEST_TOOL_VM_KNOWN_HOSTS_LINE = `tool-0.vm.host ${TEST_SSH_SERVER_HOST_KEY.algorithm} ${TEST_SSH_SERVER_HOST_KEY.publicKeyBase64}`;

function refuseUnexpectedGatewayOwnershipOperation(): never {
	throw new Error('unexpected Gateway ownership operation in lease RPC test');
}

function createOwnershipCoordinatorStub(
	currentGateway: GatewayEpochIdentity = TEST_GATEWAY_EPOCH,
	observedExpectedGateways: GatewayEpochIdentity[] = [],
): GatewayOwnershipCoordinator {
	return {
		beginGatewayEpoch: () => refuseUnexpectedGatewayOwnershipOperation(),
		abandonUnattachedGatewaySeed: () => refuseUnexpectedGatewayOwnershipOperation(),
		admitProvisionalToolVm: vi.fn(
			(
				options: Parameters<GatewayOwnershipCoordinator['admitProvisionalToolVm']>[0],
			): ReturnType<GatewayOwnershipCoordinator['admitProvisionalToolVm']> => {
				observedExpectedGateways.push(structuredClone(options.expectedGateway));
				if (!gatewayIdentitiesEqual(currentGateway, options.expectedGateway)) {
					throw new Error('Tool VM admission refused a stale Gateway VM epoch.');
				}
				let state: ReturnType<ToolVmMembershipHandle['snapshot']>['state'] = 'provisional';
				let toolVmId: string | undefined;
				return {
					agentId: options.agentId,
					leafId: options.leafId,
					attachToolVm(attachedToolVmId): void {
						toolVmId = attachedToolVmId;
					},
					beginDestroying(): void {
						state = 'destroying';
					},
					commitCurrent(): void {
						state = 'current';
					},
					recordAccessFenced(): void {
						state = 'retiring';
					},
					recordDestroyed(): void {
						state = 'destroyed';
					},
					recordUnavailable(): void {
						state = 'owner-unsafe';
					},
					snapshot: () => ({
						agentId: options.agentId,
						leafId: options.leafId,
						state,
						...(toolVmId === undefined ? {} : { toolVmId }),
					}),
				};
			},
		),
		recordGatewayDestroyUnavailable: () => refuseUnexpectedGatewayOwnershipOperation(),
		resolveGatewayEpoch: () => currentGateway,
		retireGateway: async () => refuseUnexpectedGatewayOwnershipOperation(),
		sealGatewayEpoch: () => refuseUnexpectedGatewayOwnershipOperation(),
		snapshotGateway: () => refuseUnexpectedGatewayOwnershipOperation(),
	};
}

function withCallerContextPayload<TPayload>(
	payload: TPayload,
	context: GatewayControlTrustedCallerContext = callerContext,
	gateway: GatewayEpochIdentity = TEST_GATEWAY_EPOCH,
): {
	readonly callerContext: GatewayControlTrustedCallerContext;
	readonly gateway: GatewayEpochIdentity;
	readonly payload: TPayload;
} {
	return {
		callerContext: context,
		gateway,
		payload,
	};
}

function createManagedVmStub(
	options: {
		readonly closeError?: Error;
		readonly isLive?: () => boolean;
		readonly omitServerHostKey?: boolean;
		readonly serverHostKeyOverride?: unknown;
		readonly sshCloseError?: Error;
	} = {},
): Parameters<typeof createLeaseManager>[0]['createManagedVm'] {
	return vi.fn(async () => {
		let closePromise: Promise<void> | undefined;
		let hostPidReadCount = 0;
		const sshAccess = {
			close: vi.fn(async () => {
				if (options.sshCloseError !== undefined) {
					throw options.sshCloseError;
				}
			}),
			command: 'ssh sandbox@127.0.0.1',
			host: '127.0.0.1',
			identityFile: '/tmp/tool-vm-key',
			port: 19000,
			serverHostKey: TEST_SSH_SERVER_HOST_KEY,
			user: 'sandbox',
		};
		if (options.omitServerHostKey === true) {
			Reflect.deleteProperty(sshAccess, 'serverHostKey');
		} else if (options.serverHostKeyOverride !== undefined) {
			Reflect.set(sshAccess, 'serverHostKey', options.serverHostKeyOverride);
		}
		const vm = {
			close: vi.fn((): Promise<void> => {
				closePromise ??=
					options.closeError === undefined ? Promise.resolve() : Promise.reject(options.closeError);
				return closePromise;
			}),
			enableIngress: vi.fn(async () => ({
				close: vi.fn(async () => {}),
				host: '127.0.0.1',
				port: 18791,
			})),
			enableSsh: vi.fn(async () => sshAccess),
			exec: vi.fn(() =>
				options.isLive?.() === false
					? createManagedExecProcessStub({ exitCode: 1, stderr: 'dead', stdout: '' })
					: createManagedExecProcessStub(),
			),
			getHostProcessId: () => {
				hostPidReadCount += 1;
				return hostPidReadCount === 1 ? 12345 : null;
			},
			id: 'tool-vm-1',
			configureIngressRoutes: vi.fn(),
			start: vi.fn(async () => {}),
		};
		return vm;
	});
}

function createTestLeaseManager(
	options: {
		readonly closeError?: Error;
		readonly createManagedVm?: Parameters<typeof createLeaseManager>[0]['createManagedVm'];
		readonly isLive?: () => boolean;
		readonly leaseIds?: readonly string[];
		readonly now?: () => number;
		readonly ownershipCoordinator?: GatewayOwnershipCoordinator;
		readonly tcpPool?: ReturnType<typeof createTcpPool>;
		readonly omitServerHostKey?: boolean;
		readonly serverHostKeyOverride?: unknown;
	} = {},
): ReturnType<typeof createLeaseManager> {
	let leaseIdIndex = 0;
	return createLeaseManager({
		controllerPort: 18800,
		managedVmExactProcessTermination: {
			terminateRecordedHostProcess: async ({ identity }) => ({
				hostProcessId: identity.hostProcessId,
				kind: 'already-absent',
			}),
		},
		managedVmTerminationSleep: async () => {},
		createLeaseId: () => {
			const leaseId = options.leaseIds?.[leaseIdIndex] ?? 'lease-main';
			leaseIdIndex += 1;
			return leaseId;
		},
		createManagedVm:
			options.createManagedVm ??
			createManagedVmStub({
				...(options.closeError === undefined ? {} : { closeError: options.closeError }),
				...(options.isLive === undefined ? {} : { isLive: options.isLive }),
				...(options.omitServerHostKey === undefined
					? {}
					: { omitServerHostKey: options.omitServerHostKey }),
				...(options.serverHostKeyOverride === undefined
					? {}
					: { serverHostKeyOverride: options.serverHostKeyOverride }),
			}),
		deleteToolVmRuntimeRecord: vi.fn(async () => {}),
		now: options.now ?? (() => 1_000),
		readTcpListenPortOwner: async () => null,
		ownershipCoordinator: options.ownershipCoordinator ?? createOwnershipCoordinatorStub(),
		projectNamespace: 'gateway-control-lease-rpc-tests',
		readProcessIdentity: async () => ({
			command: 'qemu-system-x86_64 -m 1G',
			lstart: 'Fri May 22 10:00:00 2026',
		}),
		systemConfigPath: '/etc/agent-vm/system.json',
		tcpPool: options.tcpPool ?? createTcpPool({ basePort: 19000, size: 2 }),
		toolLeaseRecordsTargetFor: (zoneId) =>
			({
				directoryPath: `/tmp/gateway-control-lease-rpc-tests/${zoneId}/tool-leases`,
				kind: 'controller-tool-lease-records',
				zoneId,
			}) satisfies ControllerToolLeaseRecordsTarget,
		toolVmUsePolicy: {
			endedUseTombstoneTtlMs: 10_000,
			heartbeatAfterMs: 1_000,
			heartbeatStaleMs: 4_000,
		},
		writeToolVmRuntimeRecord: vi.fn(async () => {}),
	});
}

describe('createGatewayControlLeaseRpcOperations', () => {
	it('keeps binding creation narrow beside the hard-cut lease RPC surface', () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			resolveLeaseCreateOptions: async () => {
				throw new Error('unexpected lease option resolution');
			},
		});

		expect([leaseRpcHasNoDirectMutationMethods, leaseRpcHasEveryHardCutMethod]).toEqual([
			true,
			true,
		]);
		expect(Object.keys(leaseRpc).toSorted()).toEqual([
			'createBinding',
			'getLease',
			'prepareSemanticMutation',
			'subscribeBindingRetirement',
		]);
	});

	it('creates an active-use-free Tool VM binding grant through controller-owned options', async () => {
		const leaseManager = createTestLeaseManager();
		const observedLeaseCreateRequests: unknown[] = [];
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			onLeaseCreateRequest: (request) => {
				observedLeaseCreateRequests.push(request);
			},
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				effectiveIdleTtlMs: 60_000,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});

		const grant = await leaseRpc.createBinding({
			callerContext,
			gateway: TEST_GATEWAY_EPOCH,
			payload: callerContextPayload,
		});

		expect(grant).toMatchObject({
			agentId: callerContext.agentId,
			leaseId: 'lease-main',
			profileAssignmentRevision: callerContext.principal.profileAssignmentRevision,
			stablePrincipal: callerContext.stablePrincipal,
			zoneId: callerContext.zoneId,
		});
		expect(grant).not.toHaveProperty('activeUseId');
		expect(grant).not.toHaveProperty('state');
		expect(leaseManager.getCurrentNonterminalUses(grant.leaseId)).toEqual([]);
		expect(observedLeaseCreateRequests).toEqual([
			{
				agentId: callerContext.agentId,
				idleTtlMs: 60_000,
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			},
		]);
	});

	it('creates and serializes leases through controller-owned create options', async () => {
		const resolveLeaseCreateOptions = vi.fn(async () => ({
			agentId: callerContext.agentId,
			effectiveIdleTtlMs: 60_000,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: callerContext.zoneId,
		}));
		const observedLeaseCreateRequests: unknown[] = [];
		const leaseManager = createTestLeaseManager();
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			onLeaseCreateRequest: (request) => {
				observedLeaseCreateRequests.push(request);
			},
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});

		const lease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		const currentBinding = leaseManager.getCurrentLeaseBinding(lease.leaseId);
		expect(currentBinding).toBeDefined();
		const peeked = await leaseRpc.getLease(
			withCallerContextPayload({ ...callerContextPayload, leaseId: lease.leaseId }),
			{ includeSsh: 'public' },
		);
		const renewed = await executeLeaseSemanticMutation(
			leaseRpc,
			'lease_renew',
			withCallerContextPayload({ ...callerContextPayload, leaseId: lease.leaseId }),
		);
		const released = await executeLeaseSemanticMutation(
			leaseRpc,
			'lease_release',
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: lease.leaseId,
			}),
		);

		expect(resolveLeaseCreateOptions).toHaveBeenCalledWith({
			callerContext,
			gateway: TEST_GATEWAY_EPOCH,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		expect(observedLeaseCreateRequests).toEqual([
			{
				agentId: 'main',
				idleTtlMs: 60_000,
				profileId: 'standard',
				zoneId: 'zone-a',
			},
		]);
		expect(lease).toEqual({
			agentId: 'main',
			idleTtlMs: 60_000,
			leafGeneration: currentBinding?.leafGeneration,
			leaseId: 'lease-main',
			ssh: {
				host: 'tool-0.vm.host',
				identityPem: 'identity-pem',
				knownHostsLine: TEST_TOOL_VM_KNOWN_HOSTS_LINE,
				port: 22,
				user: 'sandbox',
			},
			sshBindingId: currentBinding?.sshBinding.bindingId,
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/work',
			zoneId: 'zone-a',
		});
		expect(peeked).toEqual({
			agentId: 'main',
			idleTtlMs: 60_000,
			leaseId: 'lease-main',
			ssh: {
				host: 'tool-0.vm.host',
				port: 22,
				user: 'sandbox',
			},
			state: 'idle',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/work',
			zoneId: 'zone-a',
		});
		expect(renewed).toEqual(lease);
		expect(released).toEqual({
			agentId: 'main',
			idleTtlMs: 60_000,
			leaseId: 'lease-main',
			state: 'released',
			tcpSlot: 0,
			transport: 'ssh-sandbox',
			workdir: '/work',
			zoneId: 'zone-a',
		});
		expect(peeked).not.toHaveProperty('leafGeneration');
		expect(peeked).not.toHaveProperty('sshBindingId');
		expect(released).not.toHaveProperty('leafGeneration');
		expect(released).not.toHaveProperty('sshBindingId');
	});

	it('refuses private serialization when no current lease binding exists', async () => {
		// Arrange
		const leaseManager = createTestLeaseManager();
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async ({ callerContext: currentCallerContext, gateway }) => ({
				agentId: currentCallerContext.agentId,
				expectedGateway: gateway,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: currentCallerContext.zoneId,
			}),
		});
		const lease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		vi.spyOn(leaseManager, 'getCurrentLeaseBinding').mockReturnValue(undefined);

		// Act
		const privateLeaseRead = leaseRpc.getLease(
			withCallerContextPayload({ ...callerContextPayload, leaseId: lease.leaseId }),
			{ includeSsh: 'private' },
		);

		// Assert
		await expect(privateLeaseRead).rejects.toThrow(
			`Lease '${lease.leaseId}' does not have a current authority binding.`,
		);
	});

	it('refuses private serialization when the current binding does not match the live lease', async () => {
		// Arrange
		const leaseManager = createTestLeaseManager();
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async ({ callerContext: currentCallerContext, gateway }) => ({
				agentId: currentCallerContext.agentId,
				expectedGateway: gateway,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: currentCallerContext.zoneId,
			}),
		});
		const lease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		const currentBinding = leaseManager.getCurrentLeaseBinding(lease.leaseId);
		if (currentBinding === undefined) {
			throw new Error('test lease did not create a current binding');
		}
		vi.spyOn(leaseManager, 'getCurrentLeaseBinding').mockReturnValue({
			...currentBinding,
			runtimeBinding: {
				...currentBinding.runtimeBinding,
				vmId: 'stale-tool-vm',
			},
		});

		// Act
		const privateLeaseRead = leaseRpc.getLease(
			withCallerContextPayload({ ...callerContextPayload, leaseId: lease.leaseId }),
			{ includeSsh: 'private' },
		);

		// Assert
		await expect(privateLeaseRead).rejects.toThrow(
			`Lease '${lease.leaseId}' current authority binding does not match its live runtime.`,
		);
	});

	it('revalidates current authority after the asynchronous private identity read', async () => {
		// Arrange
		const leaseManager = createTestLeaseManager();
		const identityReadStarted = createDeferredValue<void>();
		const heldIdentityRead = createDeferredValue<string>();
		let holdIdentityRead = false;
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => {
				if (!holdIdentityRead) {
					return 'identity-pem';
				}
				identityReadStarted.resolve();
				return await heldIdentityRead.promise;
			},
			resolveLeaseCreateOptions: async ({ callerContext: currentCallerContext, gateway }) => ({
				agentId: currentCallerContext.agentId,
				expectedGateway: gateway,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: currentCallerContext.zoneId,
			}),
		});
		const lease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		holdIdentityRead = true;
		const currentBinding = vi.spyOn(leaseManager, 'getCurrentLeaseBinding');

		// Act
		const privateLeaseRead = leaseRpc.getLease(
			withCallerContextPayload({ ...callerContextPayload, leaseId: lease.leaseId }),
			{ includeSsh: 'private' },
		);
		await identityReadStarted.promise;
		currentBinding.mockReturnValue(undefined);
		heldIdentityRead.resolve('identity-pem');

		// Assert
		await expect(privateLeaseRead).rejects.toThrow(
			`Lease '${lease.leaseId}' current authority binding changed during private serialization.`,
		);
	});

	it('defers lease creation until the first admitted semantic execute and never repeats it on replay', async () => {
		// Arrange
		const leaseManager = createTestLeaseManager();
		const createLease = vi.spyOn(leaseManager, 'createLease');
		const resolveLeaseCreateOptions = vi.fn(async () => ({
			agentId: callerContext.agentId,
			effectiveIdleTtlMs: 60_000,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: callerContext.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const preparation = {
			attachmentGeneration: TEST_ATTACHMENT_GENERATION,
			callerContext,
			gateway: TEST_GATEWAY_EPOCH,
			operation: 'lease_create' as const,
			payload: GatewayControlLeaseCreateIntentPayloadSchema.parse(callerContextPayload),
			processEpoch: TEST_PROCESS_EPOCH,
		};

		// Act
		const firstPreparedMutation = await leaseRpc.prepareSemanticMutation(preparation);
		const replayPreparedMutation = await leaseRpc.prepareSemanticMutation(preparation);
		expect.soft(createLease).not.toHaveBeenCalled();
		const identity = {
			commandId: 'semantic-seed-command',
			gateway: TEST_GATEWAY_EPOCH,
			idempotencyKey: 'semantic-seed-idempotency',
			operation: 'lease_create',
			profile: firstPreparedMutation.profile,
			target: firstPreparedMutation.target,
			validUntilMs: 60_000,
		} satisfies GatewaySemanticExecutionProof['identity'];
		const semanticLedger = createGatewaySemanticResultLedger({
			gateway: TEST_GATEWAY_EPOCH,
			nowMs: () => 1,
		});
		const firstResult = await semanticLedger.executeMutating({
			handler: firstPreparedMutation.execute,
			identity,
			payload: callerContextPayload,
		});
		const replayResult = await semanticLedger.executeMutating({
			handler: replayPreparedMutation.execute,
			identity,
			payload: callerContextPayload,
		});

		// Assert
		expect(firstResult).toMatchObject({ kind: 'completed' });
		expect(replayResult).toEqual(firstResult);
		expect(createLease).toHaveBeenCalledOnce();
	});

	it('delegates one atomic semantic reacquire without RPC-owned workspace mutation', async () => {
		// Arrange
		const effectOrder: string[] = [];
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const originalCreateLease = leaseManager.createLease.bind(leaseManager);
		const originalReacquireLease = leaseManager.reacquireLease.bind(leaseManager);
		const createLease = vi
			.spyOn(leaseManager, 'createLease')
			.mockImplementation(async (options) => {
				effectOrder.push('create');
				return await originalCreateLease(options);
			});
		const reacquireLease = vi
			.spyOn(leaseManager, 'reacquireLease')
			.mockImplementation(async (oldLeaseId, options) => {
				effectOrder.push('reacquire');
				return await originalReacquireLease(oldLeaseId, options);
			});
		const releaseLease = vi.spyOn(leaseManager, 'releaseLease');
		const resolveLeaseCreateOptions = vi.fn(async () => ({
			agentId: callerContext.agentId,
			effectiveIdleTtlMs: 60_000,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: callerContext.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		effectOrder.splice(0);
		createLease.mockClear();
		reacquireLease.mockClear();
		releaseLease.mockClear();
		const reacquirePayload = {
			callerContext: {
				callerContextId: refreshedCallerContext.callerContextId,
			},
			oldLeaseId: oldLease.leaseId,
			staleEvidence: {
				kind: 'tool-vm-ssh',
				observedAtMs: 1_100,
				operation: 'command',
			},
		} satisfies GatewayControlLeaseSemanticMutationPayload;
		const preparation = {
			attachmentGeneration: TEST_ATTACHMENT_GENERATION,
			callerContext: refreshedCallerContextIdOnly,
			gateway: TEST_GATEWAY_EPOCH,
			operation: 'lease_reacquire' as const,
			payload: reacquirePayload,
			processEpoch: TEST_PROCESS_EPOCH,
		};

		// Act
		const firstPreparedMutation = await leaseRpc.prepareSemanticMutation(preparation);
		const replayPreparedMutation = await leaseRpc.prepareSemanticMutation(preparation);
		expect.soft(effectOrder).toEqual([]);
		expect.soft(releaseLease).not.toHaveBeenCalled();
		expect.soft(createLease).not.toHaveBeenCalled();
		const identity = {
			commandId: 'semantic-reacquire-command',
			gateway: TEST_GATEWAY_EPOCH,
			idempotencyKey: 'semantic-reacquire-idempotency',
			operation: 'lease_reacquire',
			profile: firstPreparedMutation.profile,
			target: firstPreparedMutation.target,
			validUntilMs: 60_000,
		} satisfies GatewaySemanticExecutionProof['identity'];
		const semanticLedger = createGatewaySemanticResultLedger({
			gateway: TEST_GATEWAY_EPOCH,
			nowMs: () => 1,
		});
		const firstResult = await semanticLedger.executeMutating({
			handler: firstPreparedMutation.execute,
			identity,
			payload: reacquirePayload,
		});
		const replayResult = await semanticLedger.executeMutating({
			handler: replayPreparedMutation.execute,
			identity,
			payload: reacquirePayload,
		});

		// Assert
		expect(firstResult).toMatchObject({ kind: 'completed' });
		expect(replayResult).toEqual(firstResult);
		expect(effectOrder).toEqual(['reacquire']);
		expect(reacquireLease).toHaveBeenCalledOnce();
		expect(reacquireLease).toHaveBeenCalledWith(oldLease.leaseId, expect.any(Object));
		expect(releaseLease).not.toHaveBeenCalled();
		expect(createLease).not.toHaveBeenCalled();
	});

	it.each([
		['missing', { omitServerHostKey: true }],
		[
			'malformed',
			{
				serverHostKeyOverride: {
					algorithm: 'ssh-rsa',
					publicKeyBase64: 'not-base64!',
				},
			},
		],
	] as const)(
		'fails closed instead of serializing a lease with a %s SSH server host identity',
		async (_identityKind, leaseManagerOptions) => {
			const leaseRpc = createGatewayControlLeaseRpcOperations({
				leaseManager: createTestLeaseManager(leaseManagerOptions),
				readIdentityPem: async () => 'identity-pem',
				resolveLeaseCreateOptions: async () => ({
					agentId: callerContext.agentId,
					expectedGateway: TEST_GATEWAY_EPOCH,
					guestWorkdir: '/work',
					hostGitDirectoryRoot: testHostGitDirectoryRoot,
					hostWorkspaceRoot: '/host/validated-work',
					profile: {
						cpus: 2,
						imageProfile: 'tool-default',
						memory: '2G',
					},
					profileId: 'standard',
					zoneId: callerContext.zoneId,
				}),
			});

			await expect(
				executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
					callerContext,
					payload: callerContextPayload,
				}),
			).rejects.toThrow("Lease 'lease-main' does not have a valid ssh-ed25519 server host key.");
		},
	);

	it('forwards the exact expected Gateway and refuses stale-G admission before VM creation', async () => {
		const staleGateway = {
			...TEST_GATEWAY_EPOCH,
			generationId: 'stale-gateway-generation',
		} satisfies GatewayEpochIdentity;
		const observedExpectedGateways: GatewayEpochIdentity[] = [];
		const ownershipCoordinator = createOwnershipCoordinatorStub(
			TEST_GATEWAY_EPOCH,
			observedExpectedGateways,
		);
		const createManagedVm = createManagedVmStub();
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager({ createManagedVm, ownershipCoordinator }),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: staleGateway,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
				callerContext,
				payload: callerContextPayload,
			}),
		).rejects.toThrow('Tool VM admission refused a stale Gateway VM epoch.');
		expect(observedExpectedGateways).toEqual([staleGateway]);
		expect(createManagedVm).not.toHaveBeenCalled();
	});

	it('records sanitized controller-request health evidence when lease create fails after resolution', async () => {
		const createFailure = new Error('raw ssh credential path /tmp/private-key should not leak');
		createFailure.name = 'ToolVmCreateFailed';
		const baseLeaseManager = createTestLeaseManager();
		const leaseManager = {
			...baseLeaseManager,
			createLease: vi.fn(async () => {
				throw createFailure;
			}),
		} satisfies ReturnType<typeof createTestLeaseManager>;
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		const resolveLeaseCreateOptions = vi.fn(async () => ({
			agentId: callerContext.agentId,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: callerContext.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			now: () => 1_000,
			readIdentityPem: async () => 'identity-pem',
			recordHealthEvent: (event) => {
				recordedHealthEvents.push(event);
			},
			resolveLeaseCreateOptions,
		});

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
				callerContext,
				payload: callerContextPayload,
			}),
		).rejects.toBe(createFailure);
		expect(recordedHealthEvents).toEqual([
			{
				attempt: 1,
				elapsedMs: 0,
				errorCode: 'lease_manager_create_lease:ToolVmCreateFailed',
				kind: 'controller-request',
				maxAttempts: 1,
				observedAtMs: 1_000,
				operation: 'lease-create',
				result: 'failed',
				statusCode: 500,
				zoneId: callerContext.zoneId,
			},
		]);
		expect(JSON.stringify(recordedHealthEvents)).not.toContain('/tmp/private-key');
	});

	it('maps active-use lifecycle through the lease manager with sanitized correlation', async () => {
		const leaseManager = createTestLeaseManager();
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});

		const started = await executeLeaseSemanticMutation(
			leaseRpc,
			'lease_use_start',
			withCallerContextPayload({
				...callerContextPayload,
				correlation: {
					runId: 'run-a',
					sessionKeyDigest: optionalToolCorrelationSessionKeyDigest,
					toolCallId: 'tool-call-a',
					traceId: 'fedcba9876543210fedcba9876543210',
				},
				leaseId: lease.leaseId,
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		);
		const heartbeat = await executeLeaseSemanticMutation(
			leaseRpc,
			'lease_use_heartbeat',
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: lease.leaseId,
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		);
		const ended = await executeLeaseSemanticMutation(
			leaseRpc,
			'lease_use_end',
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: lease.leaseId,
				reason: 'completed',
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		);

		expect(started).toEqual({
			expiresAt: 5_000,
			heartbeatAfterMs: 1_000,
			leaseId: 'lease-main',
			state: 'active',
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(heartbeat).toEqual({
			expiresAt: 5_000,
			heartbeatAfterMs: 1_000,
			leaseId: 'lease-main',
			state: 'active',
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(ended).toEqual({
			leaseId: 'lease-main',
			state: 'ended',
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(leaseManager.getActiveUses(lease.leaseId)).toEqual([]);
	});

	it('rejects post-create lease reads and mutations from a different caller context', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		const crossCallerLeasePayload = {
			callerContext: {
				callerContextId: otherCallerContext.callerContextId,
			},
			leaseId: lease.leaseId,
		};

		await expect(
			leaseRpc.getLease(withCallerContextPayload(crossCallerLeasePayload, otherCallerContext), {
				includeSsh: 'private',
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		await expect(
			executeLeaseSemanticMutation(
				leaseRpc,
				'lease_renew',
				withCallerContextPayload(crossCallerLeasePayload, otherCallerContext),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		await expect(
			executeLeaseSemanticMutation(
				leaseRpc,
				'lease_release',
				withCallerContextPayload(crossCallerLeasePayload, otherCallerContext),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
	});

	it.each([
		{
			changedPrincipal: { toolPortalProfileId: 'privileged' },
			field: 'toolPortalProfileId',
		},
		{
			changedPrincipal: { profileAssignmentRevision: 'assignment-main-next' },
			field: 'profileAssignmentRevision',
		},
		{
			changedPrincipal: {
				frameworkIdentity: { kind: 'hermes' as const, profileName: 'main' },
			},
			field: 'frameworkIdentity',
		},
	])('rejects lease reads when the trusted $field changes', async ({ changedPrincipal }) => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: { cpus: 2, imageProfile: 'tool-default', memory: '2G' },
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		const changedTrustedPrincipal = {
			...callerContext.principal,
			...changedPrincipal,
		};
		const changedCallerContext = {
			...callerContext,
			callerContextId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
			principal: changedTrustedPrincipal,
			stablePrincipal: deriveGatewayControlStablePrincipal({
				principal: changedTrustedPrincipal,
			}),
		} satisfies GatewayControlTrustedCallerContext;

		await expect(
			leaseRpc.getLease(
				withCallerContextPayload(
					{
						callerContext: { callerContextId: changedCallerContext.callerContextId },
						leaseId: lease.leaseId,
					},
					changedCallerContext,
				),
				{ includeSsh: 'private' },
			),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
	});

	it('keeps leases reachable after reconnect refreshes the caller context id', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const refreshedCallerContextPayload = {
			callerContext: {
				callerContextId: refreshedCallerContext.callerContextId,
			},
		};
		const lease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});

		const peeked = await leaseRpc.getLease(
			withCallerContextPayload(
				{ ...refreshedCallerContextPayload, leaseId: lease.leaseId },
				refreshedCallerContextIdOnly,
			),
			{ includeSsh: 'public' },
		);
		const renewed = await executeLeaseSemanticMutation(
			leaseRpc,
			'lease_renew',
			withCallerContextPayload(
				{ ...refreshedCallerContextPayload, leaseId: lease.leaseId },
				refreshedCallerContextIdOnly,
			),
		);
		const released = await executeLeaseSemanticMutation(
			leaseRpc,
			'lease_release',
			withCallerContextPayload(
				{ ...refreshedCallerContextPayload, leaseId: lease.leaseId },
				refreshedCallerContextIdOnly,
			),
		);

		expect(peeked).toEqual(
			expect.objectContaining({
				leaseId: lease.leaseId,
				state: 'idle',
			}),
		);
		expect(renewed).toEqual(
			expect.objectContaining({
				leaseId: lease.leaseId,
				state: 'idle',
			}),
		);
		expect(released).toEqual(
			expect.objectContaining({
				leaseId: lease.leaseId,
				state: 'released',
			}),
		);
	});

	it('returns the existing active use to a refreshed caller context after private revalidation', async () => {
		// Arrange
		let nowMs = 1_000;
		let identityReadCount = 0;
		const useId = '01890f00-0000-7000-8000-000000000000';
		const leaseManager = createTestLeaseManager({ now: () => nowMs });
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => {
				identityReadCount += 1;
				if (identityReadCount === 2) {
					nowMs = 2_000;
					leaseManager.heartbeatActiveUse('lease-main', useId, {
						authority: {
							gateway: TEST_GATEWAY_EPOCH,
							principal: callerPrincipal,
						},
						processEpoch: TEST_PROCESS_EPOCH,
						sessionAttachmentGeneration: TEST_ATTACHMENT_GENERATION,
					});
				}
				return 'identity-pem';
			},
			resolveLeaseCreateOptions: async ({ callerContext: currentCallerContext }) => ({
				agentId: currentCallerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: currentCallerContext.zoneId,
			}),
		});
		const firstLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		await executeLeaseSemanticMutation(
			leaseRpc,
			'lease_use_start',
			withCallerContextPayload({
				...callerContextPayload,
				leaseId: firstLease.leaseId,
				useId,
			}),
		);

		// Act
		const refreshedLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext: refreshedCallerContextIdOnly,
			payload: {
				callerContext: { callerContextId: refreshedCallerContext.callerContextId },
			},
		});

		// Assert
		expect(refreshedLease).toEqual(
			expect.objectContaining({
				activeUseId: useId,
				expiresAtMs: 6_000,
				leaseId: firstLease.leaseId,
				state: 'active',
			}),
		);
		expect(identityReadCount).toBe(2);
	});

	it('fails private serialization closed when the current-use projection fails', async () => {
		// Arrange
		const leaseManager = createTestLeaseManager();
		vi.spyOn(leaseManager, 'getCurrentNonterminalUses').mockImplementation(() => {
			throw new Error('current-use projection failed');
		});
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});

		// Act / Assert
		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
				callerContext,
				payload: callerContextPayload,
			}),
		).rejects.toThrow('current-use projection failed');
	});

	it('rejects current lease work when the same-gateway fence changes after caller-context resolution', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		const sameOwnerDifferentGatewayContext = {
			...refreshedCallerContextIdOnly,
			bootId: OTHER_GATEWAY_EPOCH.bootId,
			controllerEpoch: OTHER_GATEWAY_EPOCH.controllerEpoch,
			peerId: 'gateway-zone-b',
		} satisfies GatewayControlTrustedCallerContext;
		const driftedCallerContextPayload = {
			callerContext: {
				callerContextId: sameOwnerDifferentGatewayContext.callerContextId,
			},
			leaseId: lease.leaseId,
		};

		await expect(
			executeLeaseSemanticMutation(
				leaseRpc,
				'lease_renew',
				withCallerContextPayload(
					driftedCallerContextPayload,
					sameOwnerDifferentGatewayContext,
					OTHER_GATEWAY_EPOCH,
				),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		await expect(
			executeLeaseSemanticMutation(
				leaseRpc,
				'lease_release',
				withCallerContextPayload(
					driftedCallerContextPayload,
					sameOwnerDifferentGatewayContext,
					OTHER_GATEWAY_EPOCH,
				),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		await expect(
			executeLeaseSemanticMutation(
				leaseRpc,
				'lease_use_start',
				withCallerContextPayload(
					{
						...driftedCallerContextPayload,
						useId: '01890f00-0000-7000-8000-000000000001',
					},
					sameOwnerDifferentGatewayContext,
					OTHER_GATEWAY_EPOCH,
				),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
	});

	it('reacquires a replacement lease while retiring the old lease', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(2_000);
		try {
			const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
			const recordedHealthEvents: AgentVmHealthEvent[] = [];
			const leaseRpc = createGatewayControlLeaseRpcOperations({
				leaseManager,
				readIdentityPem: async () => 'identity-pem',
				recordHealthEvent: (event) => {
					recordedHealthEvents.push(event);
				},
				resolveLeaseCreateOptions: async () => ({
					agentId: callerContext.agentId,
					expectedGateway: TEST_GATEWAY_EPOCH,
					guestWorkdir: '/work',
					hostGitDirectoryRoot: testHostGitDirectoryRoot,
					hostWorkspaceRoot: '/host/validated-work',
					profile: {
						cpus: 2,
						imageProfile: 'tool-default',
						memory: '2G',
					},
					profileId: 'standard',
					zoneId: callerContext.zoneId,
				}),
			});
			const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
				callerContext,
				payload: callerContextPayload,
			});

			const replacementLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'released',
					},
				},
			});
			const replacementBinding = leaseManager.getCurrentLeaseBinding('lease-new');

			expect(replacementLease).toEqual(
				expect.objectContaining({
					leafGeneration: replacementBinding?.leafGeneration,
					leaseId: 'lease-new',
					sshBindingId: replacementBinding?.sshBinding.bindingId,
					state: 'idle',
				}),
			);
			expect(replacementLease).not.toEqual(expect.objectContaining({ leaseId: oldLease.leaseId }));
			expect(recordedHealthEvents).toEqual([
				expect.objectContaining({
					lifecycleEventRole: 'controller_final',
					observedAtMs: 2_000,
					oldLeaseId: oldLease.leaseId,
					replacementLeaseId: 'lease-new',
				}),
			]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects first reacquire when current resolver compatibility drifts from old authority', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		let profileId = 'standard';
		const resolveLeaseCreateOptions = vi.fn(async () => ({
			agentId: callerContext.agentId,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId,
			zoneId: callerContext.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});

		profileId = 'larger';

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'released',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		expect(resolveLeaseCreateOptions).toHaveBeenCalledTimes(2);
		expect(leaseManager.peekLease('lease-new')).toBeUndefined();
	});

	it('rejects reacquire when recorded profile assignment revision is stale', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async ({ callerContext: context }) => ({
				agentId: context.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: context.zoneId,
			}),
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		const readLeaseAuthority = leaseManager.getLeaseAuthority.bind(leaseManager);
		vi.spyOn(leaseManager, 'getLeaseAuthority').mockImplementation((leaseId) => {
			const leaseAuthority = readLeaseAuthority(leaseId);
			return leaseAuthority === undefined
				? undefined
				: {
						...leaseAuthority,
						compatibility: {
							...leaseAuthority.compatibility,
							profileAssignmentRevision: 'stale-assignment-revision',
						},
					};
		});

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'released',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		expect(leaseManager.peekLease('lease-new')).toBeUndefined();
	});

	it('revalidates current compatibility before returning a recorded replacement lease', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		let hostWorkspaceRoot = '/host/validated-work';
		const resolveLeaseCreateOptions = vi.fn(async () => ({
			agentId: callerContext.agentId,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot,
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: callerContext.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'released',
					},
				},
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: 'lease-new' }));

		hostWorkspaceRoot = '/host/other-work';

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_200,
						reason: 'released',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'lease_authority_absent',
			result: 'rejected',
		});
		expect(resolveLeaseCreateOptions).toHaveBeenCalledTimes(2);
	});

	it('allows reacquire after refreshable caller-context id rotates inside the same session attachment', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: {
					...callerContext,
					callerContextId: refreshedCallerContext.callerContextId,
				},
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'caller-context',
						observedAtMs: 1_100,
						reason: 'session_mismatch',
					},
				},
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: 'lease-new' }));
	});

	it('uses exact Gateway authority instead of a removed direct caller-attachment bypass', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			recordHealthEvent: (event) => {
				recordedHealthEvents.push(event);
			},
			resolveLeaseCreateOptions,
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		const sameOwnerDifferentSessionAttachment = {
			...callerContext,
			callerContextId: refreshedCallerContext.callerContextId,
			connectionId: refreshedCallerContext.connectionId,
			sessionId: refreshedCallerContext.sessionId,
		} satisfies GatewayControlTrustedCallerContext;

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: sameOwnerDifferentSessionAttachment,
				payload: {
					callerContext: {
						callerContextId: sameOwnerDifferentSessionAttachment.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'caller-context',
						observedAtMs: 1_100,
						reason: 'session_mismatch',
					},
				},
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: 'lease-new' }));
		expect(recordedHealthEvents).toEqual([
			expect.objectContaining({
				callerContextState: 'ok',
				lifecycleEventRole: 'controller_final',
				lifecycleTransition: 'stale_to_reacquired',
				oldLeaseId: oldLease.leaseId,
				replacementLeaseId: 'lease-new',
				result: 'ok',
				transitionId: `lease_reacquire:${oldLease.leaseId}`,
			}),
		]);
		expect(resolveLeaseCreateOptions).toHaveBeenCalledTimes(2);
	});

	it('uses exact Gateway G instead of caller-context gateway fields during reacquire', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		const sameOwnerDifferentGatewayContext = {
			...refreshedCallerContextIdOnly,
			bootId: 'gateway-boot-b',
			controllerEpoch: 'epoch-b',
			peerId: 'gateway-zone-b',
		} satisfies GatewayControlTrustedCallerContext;

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: sameOwnerDifferentGatewayContext,
				payload: {
					callerContext: {
						callerContextId: sameOwnerDifferentGatewayContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'caller-context',
						observedAtMs: 1_100,
						reason: 'session_mismatch',
					},
				},
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: 'lease-new' }));
		expect(resolveLeaseCreateOptions).toHaveBeenCalledTimes(2);
	});

	it('rejects old-lease reacquire when replacement ownership moved to another same-agent session', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		const firstReplacement = await executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
			callerContext: refreshedCallerContextIdOnly,
			payload: {
				callerContext: {
					callerContextId: refreshedCallerContext.callerContextId,
				},
				oldLeaseId: oldLease.leaseId,
				staleEvidence: {
					kind: 'lease-manager',
					observedAtMs: 1_100,
					reason: 'released',
				},
			},
		});
		expect(firstReplacement).toEqual(expect.objectContaining({ leaseId: 'lease-new' }));
		const sameAgentDifferentSessionPayload = {
			callerContext: {
				callerContextId: sameAgentDifferentSessionCallerContext.callerContextId,
			},
		};
		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
				callerContext: sameAgentDifferentSessionCallerContext,
				payload: sameAgentDifferentSessionPayload,
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: 'lease-new' }));

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_200,
						reason: 'released',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'lease_authority_absent',
			result: 'rejected',
		});
	});

	it('delegates reacquire atomically and serializes its replacement', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-race'] });
		const createLease = vi.spyOn(leaseManager, 'createLease');
		const reacquireLease = vi.spyOn(leaseManager, 'reacquireLease');
		const releaseLease = vi.spyOn(leaseManager, 'releaseLease');
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		createLease.mockClear();

		const replacement = await executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
			callerContext: refreshedCallerContextIdOnly,
			payload: {
				callerContext: {
					callerContextId: refreshedCallerContext.callerContextId,
				},
				oldLeaseId: oldLease.leaseId,
				staleEvidence: {
					kind: 'tool-vm-ssh',
					observedAtMs: 1_100,
					operation: 'command',
				},
			},
		});

		expect(replacement).toEqual(expect.objectContaining({ leaseId: 'lease-race' }));
		expect(reacquireLease).toHaveBeenCalledOnce();
		expect(reacquireLease).toHaveBeenCalledWith('lease-old', expect.any(Object));
		expect(releaseLease).not.toHaveBeenCalled();
		expect(createLease).not.toHaveBeenCalled();
		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'tool-vm-ssh',
						observedAtMs: 1_100,
						operation: 'command',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'lease_authority_absent',
			result: 'rejected',
		});
	});

	it('admits a successor after ManagedVm close while predecessor SSH cleanup remains failed', async () => {
		const leaseManager = createTestLeaseManager({
			createManagedVm: createManagedVmStub({
				sshCloseError: new Error('SSH cleanup failed after close'),
			}),
			leaseIds: ['lease-old', 'lease-new'],
		});
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context }) => ({
			agentId: context.agentId,
			expectedGateway: TEST_GATEWAY_EPOCH,
			guestWorkdir: '/work',
			hostGitDirectoryRoot: testHostGitDirectoryRoot,
			hostWorkspaceRoot: '/host/validated-work',
			profile: {
				cpus: 2,
				imageProfile: 'tool-default',
				memory: '2G',
			},
			profileId: 'standard',
			zoneId: context.zoneId,
		}));
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions,
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});

		const replacement = await executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
			callerContext: refreshedCallerContextIdOnly,
			payload: {
				callerContext: {
					callerContextId: refreshedCallerContext.callerContextId,
				},
				oldLeaseId: oldLease.leaseId,
				staleEvidence: {
					kind: 'tool-vm-ssh',
					observedAtMs: 1_100,
					operation: 'command',
				},
			},
		});

		expect(replacement).toEqual(expect.objectContaining({ leaseId: 'lease-new' }));
		expect(leaseManager.peekLease('lease-old')?.lease.id).toBe('lease-old');
		expect(leaseManager.getLeaseAuthority('lease-old')).toBeUndefined();
		expect(leaseManager.getCurrentLeaseBinding('lease-old')).toBeUndefined();
		expect(leaseManager.getLeaseAuthority('lease-new')).toBeDefined();
		expect(leaseManager.getCurrentLeaseBinding('lease-new')).toBeDefined();
		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'tool-vm-ssh',
						observedAtMs: 1_100,
						operation: 'command',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'lease_authority_absent',
			result: 'rejected',
		});
	});

	it('keeps post-fence cleanup-debt predecessor private while successor remains current', async () => {
		const closeError = new Error('containment close failed');
		const tcpPool = createTcpPool({ basePort: 19000, size: 2 });
		const leaseManager = createTestLeaseManager({
			closeError,
			leaseIds: ['lease-old', 'lease-new', 'lease-unexpected'],
			tcpPool,
		});
		const retirementEvents: unknown[] = [];
		leaseManager.subscribeLeaseRetirement(async (event) => {
			retirementEvents.push(event);
		});
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async ({ callerContext: context }) => ({
				agentId: context.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: context.zoneId,
			}),
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		const oldLeasePayload = withCallerContextPayload({
			...callerContextPayload,
			leaseId: oldLease.leaseId,
		});

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_release', oldLeasePayload),
		).rejects.toThrow(closeError);

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_renew', oldLeasePayload),
		).resolves.toBeUndefined();
		await expect(
			executeLeaseSemanticMutation(
				leaseRpc,
				'lease_use_start',
				withCallerContextPayload({
					...callerContextPayload,
					leaseId: oldLease.leaseId,
					useId: '01890f00-0000-7000-8000-000000000001',
				}),
			),
		).resolves.toBeUndefined();
		expect(leaseManager.peekLease(oldLease.leaseId)?.lease.id).toBe(oldLease.leaseId);
		expect(leaseManager.getLeaseAuthority(oldLease.leaseId)).toBeUndefined();
		expect(leaseManager.getCurrentLeaseBinding(oldLease.leaseId)).toBeUndefined();
		expect(retirementEvents).toEqual([{ leaseId: oldLease.leaseId, reason: 'released' }]);
		expect(tcpPool.isQuarantined(0)).toBe(true);

		const reacquireRequest = {
			callerContext: refreshedCallerContextIdOnly,
			payload: {
				callerContext: {
					callerContextId: refreshedCallerContext.callerContextId,
				},
				oldLeaseId: oldLease.leaseId,
				staleEvidence: {
					kind: 'tool-vm-ssh',
					observedAtMs: 1_100,
					operation: 'command',
				},
			},
		};
		const fencedReacquire = await executeLeaseSemanticMutation(
			leaseRpc,
			'lease_reacquire',
			reacquireRequest,
		);
		const successorLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext: refreshedCallerContext,
			payload: {
				callerContext: {
					callerContextId: refreshedCallerContext.callerContextId,
				},
			},
		});
		const repeatedCreate = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext: refreshedCallerContext,
			payload: {
				callerContext: {
					callerContextId: refreshedCallerContext.callerContextId,
				},
			},
		});
		const repeatedReacquire = await executeLeaseSemanticMutation(
			leaseRpc,
			'lease_reacquire',
			reacquireRequest,
		);

		expect(fencedReacquire).toEqual({
			leaseRejectionReason: 'lease_authority_absent',
			result: 'rejected',
		});
		expect(successorLease).toEqual(expect.objectContaining({ leaseId: 'lease-new' }));
		expect(repeatedCreate).toEqual(expect.objectContaining({ leaseId: 'lease-new' }));
		expect(repeatedReacquire).toEqual({
			leaseRejectionReason: 'lease_authority_absent',
			result: 'rejected',
		});
		expect(leaseManager.peekLease(oldLease.leaseId)).toBeDefined();
		expect(leaseManager.getLeaseAuthority(oldLease.leaseId)).toBeUndefined();
		expect(leaseManager.getCurrentLeaseBinding(oldLease.leaseId)).toBeUndefined();
		expect(leaseManager.listLeases().map((lease) => lease.id)).toEqual(['lease-new']);
		expect(leaseManager.getLeaseAuthority('lease-new')).toBeDefined();
		expect(leaseManager.getCurrentLeaseBinding('lease-new')).toBeDefined();
		expect(retirementEvents).toEqual([{ leaseId: oldLease.leaseId, reason: 'released' }]);
		expect(tcpPool.isQuarantined(0)).toBe(true);
		expect(tcpPool.isQuarantined(1)).toBe(false);
	});

	it('reacquires from current controller compatibility without runtime-status authority', async () => {
		const leaseManager = createTestLeaseManager({
			leaseIds: ['lease-old', 'lease-new', 'lease-newer'],
		});
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		const observedResolvedGateways: GatewayEpochIdentity[] = [];
		const resolveLeaseCreateOptions = vi.fn(async ({ callerContext: context, gateway }) => {
			observedResolvedGateways.push(structuredClone(gateway));
			return {
				agentId: context.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: context.zoneId,
			};
		});
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			recordHealthEvent: (event) => {
				recordedHealthEvents.push(event);
			},
			resolveLeaseCreateOptions,
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});
		const firstReplacement = await executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
			callerContext: refreshedCallerContextIdOnly,
			payload: {
				callerContext: {
					callerContextId: refreshedCallerContext.callerContextId,
				},
				oldLeaseId: oldLease.leaseId,
				staleEvidence: {
					kind: 'tool-vm-ssh',
					observedAtMs: 1_100,
					operation: 'command',
				},
			},
		});
		if (firstReplacement === undefined || !('leaseId' in firstReplacement)) {
			throw new Error('Expected first reacquire to return a replacement lease.');
		}

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: firstReplacement.leaseId,
					staleEvidence: {
						kind: 'tool-vm-ssh',
						observedAtMs: 1_200,
						operation: 'command',
					},
				},
			}),
		).resolves.toEqual(expect.objectContaining({ leaseId: 'lease-newer' }));
		expect(observedResolvedGateways).toEqual([
			TEST_GATEWAY_EPOCH,
			TEST_GATEWAY_EPOCH,
			TEST_GATEWAY_EPOCH,
		]);
		expect(recordedHealthEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					lifecycleEventRole: 'controller_final',
					lifecycleTransition: 'stale_to_reacquired',
					oldLeaseId: oldLease.leaseId,
					replacementLeaseId: 'lease-new',
					result: 'ok',
				}),
				expect.objectContaining({
					lifecycleEventRole: 'controller_final',
					lifecycleTransition: 'stale_to_reacquired',
					oldLeaseId: firstReplacement.leaseId,
					replacementLeaseId: 'lease-newer',
					result: 'ok',
				}),
			]),
		);
	});

	it('expires old-lease authority after dead idle lease disappearance', async () => {
		let nowMs = 1_000;
		let vmLive = true;
		const leaseManager = createTestLeaseManager({
			isLive: () => vmLive,
			leaseIds: ['lease-old', 'lease-new'],
			now: () => nowMs,
		});
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			now: () => nowMs,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});

		vmLive = false;
		await leaseManager.reapDeadIdleLeases();
		nowMs = 1_000 + 10 * 60 * 1000 + 1;

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'expired',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'lease_authority_absent',
			result: 'rejected',
		});
	});

	it('records controller-final reacquire success only after replacement SSH serialization succeeds', async () => {
		const leaseManager = createTestLeaseManager({ leaseIds: ['lease-old', 'lease-new'] });
		const recordedHealthEvents: AgentVmHealthEvent[] = [];
		let identityReadCount = 0;
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => {
				identityReadCount += 1;
				if (identityReadCount > 1) {
					throw new Error('identity read failed');
				}
				return 'identity-pem';
			},
			recordHealthEvent: (event) => {
				recordedHealthEvents.push(event);
			},
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const oldLease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: callerContextPayload,
		});

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext: refreshedCallerContextIdOnly,
				payload: {
					callerContext: {
						callerContextId: refreshedCallerContext.callerContextId,
					},
					oldLeaseId: oldLease.leaseId,
					staleEvidence: {
						kind: 'lease-manager',
						observedAtMs: 1_100,
						reason: 'released',
					},
				},
			}),
		).rejects.toThrow('identity read failed');
		expect(recordedHealthEvents).toEqual([]);
	});

	it('rejects reacquire when old lease authority is unavailable', async () => {
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager: createTestLeaseManager(),
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});

		await expect(
			executeLeaseSemanticMutation(leaseRpc, 'lease_reacquire', {
				callerContext,
				payload: {
					callerContext: {
						callerContextId: callerContext.callerContextId,
					},
					oldLeaseId: 'lease-missing-authority',
					staleEvidence: {
						kind: 'caller-context',
						observedAtMs: 1_100,
						reason: 'absent',
					},
				},
			}),
		).resolves.toEqual({
			leaseRejectionReason: 'lease_authority_absent',
			result: 'rejected',
		});
	});

	it('rejects active-use lifecycle from a different caller context', async () => {
		const leaseManager = createTestLeaseManager();
		const leaseRpc = createGatewayControlLeaseRpcOperations({
			leaseManager,
			readIdentityPem: async () => 'identity-pem',
			resolveLeaseCreateOptions: async () => ({
				agentId: callerContext.agentId,
				expectedGateway: TEST_GATEWAY_EPOCH,
				guestWorkdir: '/work',
				hostGitDirectoryRoot: testHostGitDirectoryRoot,
				hostWorkspaceRoot: '/host/validated-work',
				profile: {
					cpus: 2,
					imageProfile: 'tool-default',
					memory: '2G',
				},
				profileId: 'standard',
				zoneId: callerContext.zoneId,
			}),
		});
		const lease = await executeLeaseSemanticMutation(leaseRpc, 'lease_create', {
			callerContext,
			payload: {
				callerContext: {
					callerContextId: callerContext.callerContextId,
				},
			},
		});
		const useId = '01890f00-0000-7000-8000-000000000000';
		await expect(
			executeLeaseSemanticMutation(
				leaseRpc,
				'lease_use_start',
				withCallerContextPayload({
					callerContext: {
						callerContextId: callerContext.callerContextId,
					},
					leaseId: lease.leaseId,
					useId,
				}),
			),
		).resolves.toEqual(
			expect.objectContaining({
				state: 'active',
				useId,
			}),
		);
		const crossCallerUsePayload = {
			callerContext: {
				callerContextId: otherCallerContext.callerContextId,
			},
			leaseId: lease.leaseId,
			useId,
		};

		await expect(
			executeLeaseSemanticMutation(
				leaseRpc,
				'lease_use_heartbeat',
				withCallerContextPayload(crossCallerUsePayload, otherCallerContext),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		await expect(
			executeLeaseSemanticMutation(
				leaseRpc,
				'lease_use_end',
				withCallerContextPayload(
					{
						...crossCallerUsePayload,
						reason: 'completed',
					},
					otherCallerContext,
				),
			),
		).resolves.toEqual({
			leaseRejectionReason: 'ownership_denied',
			result: 'rejected',
		});
		expect(leaseManager.getActiveUses(lease.leaseId)).toEqual([expect.objectContaining({ useId })]);
	});
});
