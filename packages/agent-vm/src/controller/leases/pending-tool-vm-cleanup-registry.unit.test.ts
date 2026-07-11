import type {
	ManagedVm,
	VmDestroyReceiptV1,
	VmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';
import { describe, expect, it, type Mock, vi } from 'vitest';

import {
	createCompleteVmDestroyReceipt,
	createManagedExecProcessStub,
	createManagedVmFsStub,
	createTestVmDestroyTarget,
} from '../../testing/managed-vm-test-helpers.js';
import type { ProvisionalToolVmOwnershipHandle } from '../vm-ownership/gateway-ownership-coordinator.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import {
	createPendingToolVmCleanupRegistry,
	type PendingToolVmCleanupRegistry,
} from './pending-tool-vm-cleanup-registry.js';

const TEST_GATEWAY_EPOCH = {
	bootId: 'gateway-boot-1',
	controllerEpoch: 'controller-epoch-1',
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

const TEST_TOOL_VM_OWNERSHIP_RESERVATION = {
	expectedContractVersion: 1,
	expectedRevision: 1,
	reservationId: 'tool-reservation-1',
	reservationPath: '/tmp/pending-tool-vm-cleanup-tests/tool-reservation-1/reservation.json',
} satisfies VmOwnershipReservationReferenceV1;

const incompleteVmDestroyReceipt = {
	...createCompleteVmDestroyReceipt('tool-vm-incomplete', {
		controllerEpoch: TEST_GATEWAY_EPOCH.controllerEpoch,
		parentGateway: {
			epoch: TEST_GATEWAY_EPOCH.gatewayEpochId,
			vmId: TEST_GATEWAY_EPOCH.gatewayVmId,
		},
		role: 'tool',
	}),
	complete: false,
	resources: {
		...createCompleteVmDestroyReceipt().resources,
		exactRunner: { status: 'unproven', reason: 'runner-resistant' },
	},
} satisfies VmDestroyReceiptV1;

function createGatewayEpoch(overrides: Partial<GatewayEpochIdentity> = {}): GatewayEpochIdentity {
	return {
		...TEST_GATEWAY_EPOCH,
		...overrides,
	};
}

function createOwnershipHandle(
	overrides: Partial<ProvisionalToolVmOwnershipHandle> = {},
): ProvisionalToolVmOwnershipHandle {
	return {
		ready: Promise.resolve(TEST_TOOL_VM_OWNERSHIP_RESERVATION),
		commitCurrent: async () => {},
		destroyDetached: async () => createCompleteVmDestroyReceipt('tool-vm-detached'),
		destroyLive: async (closeLiveVm) => await closeLiveVm(),
		...overrides,
	};
}

function createManagedVmStub(close: ManagedVm['close'], id: string = 'tool-vm-live'): ManagedVm {
	return {
		close,
		enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
		enableSsh: vi.fn(async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19_000,
			user: 'sandbox',
		})),
		exec: vi.fn(() => createManagedExecProcessStub()),
		fs: createManagedVmFsStub(),
		getDestroyTarget: vi.fn(() =>
			createTestVmDestroyTarget(id, {
				controllerEpoch: TEST_GATEWAY_EPOCH.controllerEpoch,
				parentGateway: {
					epoch: TEST_GATEWAY_EPOCH.gatewayEpochId,
					vmId: TEST_GATEWAY_EPOCH.gatewayVmId,
				},
				role: 'tool',
			}),
		),
		getHostPid: () => 12_345,
		getVmInstance: vi.fn(),
		id,
		setIngressRoutes: vi.fn(),
	};
}

interface RegistryHarness {
	readonly deleteRuntimeRecord: Mock<(stateDirectory: string, recordId: string) => Promise<void>>;
	readonly registry: PendingToolVmCleanupRegistry;
	readonly releaseTcpSlot: Mock<(tcpSlot: number) => void>;
	readonly writeWarning: Mock<(message: string) => void>;
}

function createRegistryHarness(
	options: {
		readonly deleteRuntimeRecord?: (stateDirectory: string, recordId: string) => Promise<void>;
		readonly releaseTcpSlot?: (tcpSlot: number) => void;
		readonly writeWarning?: (message: string) => void;
	} = {},
): RegistryHarness {
	const deleteRuntimeRecord = vi.fn(options.deleteRuntimeRecord ?? (async () => {}));
	const releaseTcpSlot = vi.fn(options.releaseTcpSlot ?? (() => {}));
	const writeWarning = vi.fn(options.writeWarning ?? (() => {}));
	return {
		deleteRuntimeRecord,
		registry: createPendingToolVmCleanupRegistry({
			deleteRuntimeRecord,
			releaseTcpSlotAfterCompleteDestruction: releaseTcpSlot,
			writeWarning,
		}),
		releaseTcpSlot,
		writeWarning,
	};
}

function createDeferred<TValue>(): {
	readonly promise: Promise<TValue>;
	resolve(value: TValue): void;
} {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value): void {
			resolvePromise?.(value);
		},
	};
}

describe('createPendingToolVmCleanupRegistry', () => {
	it('retains detached cleanup after failure and releases its TCP slot only after success', async () => {
		// Arrange
		const destroyFailure = new Error('detached exact destruction failed');
		const destroyDetached = vi
			.fn<ProvisionalToolVmOwnershipHandle['destroyDetached']>()
			.mockRejectedValueOnce(destroyFailure)
			.mockResolvedValueOnce(createCompleteVmDestroyReceipt('tool-vm-detached'));
		const { registry, releaseTcpSlot } = createRegistryHarness();
		const agentIdentity = { agentId: 'main', zoneId: 'shravan' };
		registry.recordDetachedCleanup({
			...agentIdentity,
			gatewayIdentity: TEST_GATEWAY_EPOCH,
			ownership: createOwnershipHandle({ destroyDetached }),
			tcpSlot: 4,
		});

		// Act
		await expect(registry.retry(agentIdentity)).rejects.toBe(destroyFailure);

		// Assert
		expect(registry.pendingCleanupIdentitiesForGateway(TEST_GATEWAY_EPOCH)).toHaveLength(1);
		expect(releaseTcpSlot).not.toHaveBeenCalled();

		// Act
		await expect(registry.retry(agentIdentity)).resolves.toBeUndefined();

		// Assert
		expect(destroyDetached).toHaveBeenCalledTimes(2);
		expect(registry.pendingCleanupIdentitiesForGateway(TEST_GATEWAY_EPOCH)).toHaveLength(0);
		expect(releaseTcpSlot).toHaveBeenCalledOnce();
		expect(releaseTcpSlot).toHaveBeenCalledWith(4);
	});

	it('retains detached cleanup and its TCP slot after an incomplete exact receipt', async () => {
		// Arrange
		const destroyDetached = vi
			.fn<ProvisionalToolVmOwnershipHandle['destroyDetached']>()
			.mockResolvedValueOnce(incompleteVmDestroyReceipt)
			.mockResolvedValueOnce(createCompleteVmDestroyReceipt('tool-vm-detached'));
		const { registry, releaseTcpSlot } = createRegistryHarness();
		const agentIdentity = { agentId: 'main', zoneId: 'shravan' };
		registry.recordDetachedCleanup({
			...agentIdentity,
			gatewayIdentity: TEST_GATEWAY_EPOCH,
			ownership: createOwnershipHandle({ destroyDetached }),
			tcpSlot: 5,
		});

		// Act
		await expect(registry.retry(agentIdentity)).rejects.toThrow(/incomplete exact VM destruction/u);

		// Assert
		expect(registry.pendingCleanupIdentitiesForGateway(TEST_GATEWAY_EPOCH)).toEqual([
			agentIdentity,
		]);
		expect(releaseTcpSlot).not.toHaveBeenCalled();

		// Act
		await expect(registry.retry(agentIdentity)).resolves.toBeUndefined();

		// Assert
		expect(destroyDetached).toHaveBeenCalledTimes(2);
		expect(registry.pendingCleanupIdentitiesForGateway(TEST_GATEWAY_EPOCH)).toHaveLength(0);
		expect(releaseTcpSlot).toHaveBeenCalledOnce();
		expect(releaseTcpSlot).toHaveBeenCalledWith(5);
	});

	it('preserves live cleanup state across incomplete and thrown destruction before retry succeeds', async () => {
		// Arrange
		const closeFailure = new Error('live VM close failed');
		const close = vi
			.fn<ManagedVm['close']>()
			.mockResolvedValueOnce(incompleteVmDestroyReceipt)
			.mockRejectedValueOnce(closeFailure)
			.mockResolvedValueOnce(
				createCompleteVmDestroyReceipt('tool-vm-live', {
					controllerEpoch: TEST_GATEWAY_EPOCH.controllerEpoch,
					parentGateway: {
						epoch: TEST_GATEWAY_EPOCH.gatewayEpochId,
						vmId: TEST_GATEWAY_EPOCH.gatewayVmId,
					},
					role: 'tool',
				}),
			);
		const destroyLive = vi.fn(
			async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> =>
				await closeLiveVm(),
		);
		const { deleteRuntimeRecord, registry, releaseTcpSlot } = createRegistryHarness();
		const agentIdentity = { agentId: 'main', zoneId: 'shravan' };
		registry.recordLiveCleanup({
			...agentIdentity,
			gatewayIdentity: TEST_GATEWAY_EPOCH,
			ownership: createOwnershipHandle({ destroyLive }),
			persistedRuntimeRecord: {
				recordId: 'runtime-record-1',
				stateDirectory: '/tmp/pending-tool-vm-cleanup-tests/shravan',
			},
			tcpSlot: 7,
			vm: createManagedVmStub(close),
		});

		// Act
		await expect(registry.retry(agentIdentity)).rejects.toThrow(/incomplete exact VM destruction/u);

		// Assert
		expect(registry.pendingCleanupIdentitiesForGateway(TEST_GATEWAY_EPOCH)).toHaveLength(1);
		expect(deleteRuntimeRecord).not.toHaveBeenCalled();
		expect(releaseTcpSlot).not.toHaveBeenCalled();

		// Act
		await expect(registry.retry(agentIdentity)).rejects.toBe(closeFailure);

		// Assert
		expect(registry.pendingCleanupIdentitiesForGateway(TEST_GATEWAY_EPOCH)).toHaveLength(1);
		expect(deleteRuntimeRecord).not.toHaveBeenCalled();
		expect(releaseTcpSlot).not.toHaveBeenCalled();

		// Act
		await expect(registry.retry(agentIdentity)).resolves.toBeUndefined();

		// Assert
		expect(destroyLive).toHaveBeenCalledTimes(3);
		expect(close).toHaveBeenCalledTimes(3);
		expect(deleteRuntimeRecord).toHaveBeenCalledOnce();
		expect(deleteRuntimeRecord).toHaveBeenCalledWith(
			'/tmp/pending-tool-vm-cleanup-tests/shravan',
			'runtime-record-1',
		);
		expect(releaseTcpSlot).toHaveBeenCalledOnce();
		expect(releaseTcpSlot).toHaveBeenCalledWith(7);
		expect(registry.pendingCleanupIdentitiesForGateway(TEST_GATEWAY_EPOCH)).toHaveLength(0);
	});

	it('warns on best-effort runtime-record deletion after live destruction and still releases', async () => {
		// Arrange
		const events: string[] = [];
		const deleteFailure = new Error('runtime record filesystem unavailable');
		const { registry, releaseTcpSlot, writeWarning } = createRegistryHarness({
			deleteRuntimeRecord: async () => {
				events.push('delete-runtime-record');
				throw deleteFailure;
			},
			releaseTcpSlot: () => {
				events.push('release-tcp-slot');
			},
			writeWarning: () => {
				events.push('write-warning');
			},
		});
		const destroyLive = vi.fn(
			async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> => {
				const receipt = await closeLiveVm();
				events.push('destroy-live-complete');
				return receipt;
			},
		);
		const agentIdentity = { agentId: 'main', zoneId: 'shravan' };
		registry.recordLiveCleanup({
			...agentIdentity,
			gatewayIdentity: TEST_GATEWAY_EPOCH,
			ownership: createOwnershipHandle({ destroyLive }),
			persistedRuntimeRecord: {
				recordId: 'runtime-record-warning',
				stateDirectory: '/tmp/pending-tool-vm-cleanup-tests/shravan',
			},
			tcpSlot: 9,
			vm: createManagedVmStub(vi.fn(async () => createCompleteVmDestroyReceipt('tool-vm-live'))),
		});

		// Act
		await expect(registry.retry(agentIdentity)).resolves.toBeUndefined();

		// Assert
		expect(events).toEqual([
			'destroy-live-complete',
			'delete-runtime-record',
			'write-warning',
			'release-tcp-slot',
		]);
		expect(writeWarning).toHaveBeenCalledWith(
			"failed to delete recovered partial-create runtime record 'runtime-record-warning' in zone 'shravan': runtime record filesystem unavailable",
		);
		expect(releaseTcpSlot).toHaveBeenCalledWith(9);
		expect(registry.pendingCleanupIdentitiesForGateway(TEST_GATEWAY_EPOCH)).toHaveLength(0);
	});

	it('enumerates only exact-Gateway cleanup tasks and lets matching tasks start in parallel', async () => {
		// Arrange
		const detachedDestruction = createDeferred<VmDestroyReceiptV1>();
		const liveDestruction = createDeferred<VmDestroyReceiptV1>();
		const started: string[] = [];
		const { registry, releaseTcpSlot } = createRegistryHarness();
		registry.recordDetachedCleanup({
			agentId: 'detached',
			gatewayIdentity: TEST_GATEWAY_EPOCH,
			ownership: createOwnershipHandle({
				destroyDetached: async () => {
					started.push('detached');
					return await detachedDestruction.promise;
				},
			}),
			tcpSlot: 5,
			zoneId: 'shravan',
		});
		registry.recordLiveCleanup({
			agentId: 'live',
			gatewayIdentity: TEST_GATEWAY_EPOCH,
			ownership: createOwnershipHandle({
				destroyLive: async () => {
					started.push('live');
					return await liveDestruction.promise;
				},
			}),
			tcpSlot: 6,
			vm: createManagedVmStub(vi.fn(async () => createCompleteVmDestroyReceipt('unused'))),
			zoneId: 'shravan',
		});
		const foreignGateway = createGatewayEpoch({
			gatewayEpochId: 'gateway-epoch-foreign',
			gatewayVmId: 'gateway-vm-foreign',
		});
		registry.recordDetachedCleanup({
			agentId: 'foreign-detached',
			gatewayIdentity: foreignGateway,
			ownership: createOwnershipHandle({
				destroyDetached: vi.fn(async () =>
					createCompleteVmDestroyReceipt('tool-vm-foreign-detached'),
				),
			}),
			tcpSlot: 7,
			zoneId: 'shravan',
		});
		registry.recordLiveCleanup({
			agentId: 'foreign-live',
			gatewayIdentity: foreignGateway,
			ownership: createOwnershipHandle(),
			tcpSlot: 8,
			vm: createManagedVmStub(
				vi.fn(async () => createCompleteVmDestroyReceipt('tool-vm-foreign-live')),
			),
			zoneId: 'shravan',
		});

		// Act
		const cleanupIdentities = registry.pendingCleanupIdentitiesForGateway(TEST_GATEWAY_EPOCH);
		const cleanupPromise = Promise.all(
			cleanupIdentities.map(async (agentIdentity) => await registry.retry(agentIdentity)),
		);
		await Promise.resolve();

		// Assert
		expect(cleanupIdentities).toHaveLength(2);
		expect(started).toEqual(['detached', 'live']);
		expect(releaseTcpSlot).not.toHaveBeenCalled();

		// Act
		detachedDestruction.resolve(createCompleteVmDestroyReceipt('tool-vm-detached'));
		liveDestruction.resolve(createCompleteVmDestroyReceipt('tool-vm-live'));
		await cleanupPromise;

		// Assert
		expect(releaseTcpSlot.mock.calls.map(([tcpSlot]) => tcpSlot)).toEqual([5, 6]);
		expect(registry.pendingCleanupIdentitiesForGateway(TEST_GATEWAY_EPOCH)).toHaveLength(0);
		expect(registry.pendingCleanupIdentitiesForGateway(foreignGateway)).toHaveLength(2);
	});
});
