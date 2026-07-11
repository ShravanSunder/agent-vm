import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ToolVmActiveUseCorrelation } from '@agent-vm/gateway-interface';
import type {
	ManagedVm,
	VmDestroyReceiptV1,
	VmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IncompleteVmDestructionError } from '../../shared/vm-destruction-receipt.js';
import {
	createCompleteVmDestroyReceipt,
	createManagedExecProcessStub,
	createManagedVmFsStub,
	createTestVmDestroyTarget,
} from '../../testing/managed-vm-test-helpers.js';
import { GatewayDestructionTimeoutError } from '../vm-ownership/gateway-destruction-budget.js';
import {
	GatewayMembershipError,
	registerGatewayMembershipBarrier,
} from '../vm-ownership/gateway-membership-barrier.js';
import type {
	GatewayOwnershipCoordinator,
	ProvisionalToolVmOwnershipHandle,
} from '../vm-ownership/gateway-ownership-coordinator.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { createVmOwnershipJournal } from '../vm-ownership/vm-ownership-journal.js';
import {
	AgentLeaseCompatibilityConflictError,
	createLeaseManager,
	LeaseActiveUseConflictError,
} from './lease-manager.js';
import { createTcpPool } from './tcp-pool.js';
import { deleteToolVmRuntimeRecord, writeToolVmRuntimeRecord } from './tool-vm-runtime-record.js';

// Runtime-record persistence is exercised by tool-vm-runtime-record.test.ts.
// In lease-manager tests we only need the in-memory lease lifecycle behavior,
// so default the write/delete to no-ops via injection. readProcessIdentity is
// stubbed to a synthetic value so buildToolVmRuntimeRecord doesn't shell out
// to `ps` against the fake pid.
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
	reservationPath: '/tmp/lease-manager-tests/shravan/tool-reservation-1/reservation-v1.json',
} satisfies VmOwnershipReservationReferenceV1;

function createProvisionalToolVmOwnershipHandle(
	overrides: Partial<ProvisionalToolVmOwnershipHandle> = {},
): ProvisionalToolVmOwnershipHandle {
	return {
		ready: Promise.resolve(TEST_TOOL_VM_OWNERSHIP_RESERVATION),
		commitCurrent: async () => {},
		destroyDetached: async () => createCompleteVmDestroyReceipt('tool-vm-1'),
		destroyLive: async (closeLiveVm) => await closeLiveVm(),
		...overrides,
	};
}

function createOwnershipCoordinatorStub(
	overrides: Partial<GatewayOwnershipCoordinator> = {},
): GatewayOwnershipCoordinator {
	return {
		beginGatewayEpoch: async () => ({
			gatewayIdentity: TEST_GATEWAY_EPOCH,
			ownershipReservation: TEST_TOOL_VM_OWNERSHIP_RESERVATION,
		}),
		admitProvisionalToolVm: () => createProvisionalToolVmOwnershipHandle(),
		destroyGatewayDetached: async () => createCompleteVmDestroyReceipt('gateway-vm-1'),
		recordGatewayDestroyReceipt: async () => {},
		recordGatewayDestroyUnavailable: async () => {},
		reconcileControllerStartup: async () => {},
		resolveGatewayEpoch: () => TEST_GATEWAY_EPOCH,
		sealGatewayEpoch: () => ({
			barrier: Promise.resolve({
				gatewayEpochId: TEST_GATEWAY_EPOCH.gatewayEpochId,
				kind: 'children-destroyed',
			}),
			childReservationIds: [],
		}),
		...overrides,
	};
}

const defaultRuntimeRecordOptions = {
	controllerPort: 18800,
	deleteToolVmRuntimeRecord: vi.fn(async () => {}),
	projectNamespace: 'claw-tests-a1b2c3d4',
	readProcessIdentity: async () => ({
		command: 'qemu-system-x86_64 -m 1G',
		lstart: 'Fri May 22 10:00:00 2026',
	}),
	ownershipCoordinator: createOwnershipCoordinatorStub(),
	stateDirFor: (zoneId: string) => `/tmp/lease-manager-tests/${zoneId}`,
	systemConfigPath: '/etc/agent-vm/system.json',
	writeToolVmRuntimeRecord: vi.fn(async () => {}),
};

const OPENCLAW_TOOL_VM_WORKSPACE_MOUNT = '/workspace';

const incompleteVmDestroyReceipt = {
	contractVersion: 1,
	reservationId: 'reservation-incomplete',
	vmId: 'tool-vm-incomplete',
	controllerEpoch: 'controller-epoch-1',
	parentGateway: { vmId: 'gateway-vm-1', epoch: 'gateway-epoch-1' },
	role: 'tool',
	requestedRunner: {
		backend: 'qemu',
		executableName: 'qemu-system-aarch64',
		discoveryIdentity: 'runner-incomplete',
	},
	complete: false,
	completedAt: '2026-07-10T00:00:00.000Z',
	resources: {
		exactRunner: { status: 'unproven', reason: 'runner-resistant' },
		ingressListener: { status: 'already-absent' },
		ingressSockets: { status: 'already-absent' },
		sshListener: { status: 'destroyed' },
		sshSessions: { status: 'destroyed' },
		sessionIpc: { status: 'already-absent' },
		qmp: { status: 'destroyed' },
		disposableStorage: { status: 'destroyed' },
	},
} satisfies VmDestroyReceiptV1;

function createManagedVmStub(id: string = 'tool-vm-1'): ManagedVm {
	return {
		close: vi.fn(async () => createCompleteVmDestroyReceipt(id)),
		enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
		enableSsh: vi.fn(async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19000,
			user: 'sandbox',
		})),
		exec: vi.fn(() => createManagedExecProcessStub()),
		fs: createManagedVmFsStub(),
		getDestroyTarget: vi.fn(() => createTestVmDestroyTarget(id)),
		id,
		setIngressRoutes: vi.fn(),
		getHostPid: () => 12345,
		getVmInstance: vi.fn(),
	};
}

async function captureOperationError(operation: () => Promise<unknown>): Promise<unknown> {
	try {
		await operation();
		return undefined;
	} catch (error) {
		return error;
	}
}

describe('createLeaseManager', () => {
	function createAgentLeaseOptions(
		overrides: Partial<Parameters<ReturnType<typeof createLeaseManager>['createLease']>[0]> & {
			readonly agentId?: string;
		} = {},
	): Parameters<ReturnType<typeof createLeaseManager>['createLease']>[0] & {
		readonly agentId: string;
	} {
		return {
			agentId: 'beta',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
			...overrides,
		};
	}

	async function createSealedGatewayLeaseHarness(
		options: {
			readonly startActiveUseBeforeSeal?: boolean;
		} = {},
	): Promise<{
		readonly closeMock: ReturnType<typeof vi.fn<ManagedVm['close']>>;
		readonly lease: Awaited<ReturnType<ReturnType<typeof createLeaseManager>['createLease']>>;
		readonly leaseManager: ReturnType<typeof createLeaseManager>;
		setNow(nowMs: number): void;
	}> {
		let gatewayState: 'admitting' | 'sealed' = 'admitting';
		let nowMs = 100;
		const assertGatewayAdmitting = (): void => {
			if (gatewayState !== 'admitting') {
				throw new GatewayMembershipError('gateway-not-admitting');
			}
		};
		const ownershipCoordinator = createOwnershipCoordinatorStub({
			admitProvisionalToolVm: () => {
				assertGatewayAdmitting();
				return createProvisionalToolVmOwnershipHandle();
			},
			resolveGatewayEpoch: () => {
				assertGatewayAdmitting();
				return structuredClone(TEST_GATEWAY_EPOCH);
			},
			sealGatewayEpoch: () => {
				gatewayState = 'sealed';
				return {
					barrier: Promise.resolve({
						gatewayEpochId: TEST_GATEWAY_EPOCH.gatewayEpochId,
						kind: 'children-destroyed',
					}),
					childReservationIds: [TEST_TOOL_VM_OWNERSHIP_RESERVATION.reservationId],
				};
			},
		});
		const closeMock = vi.fn<ManagedVm['close']>(async () =>
			createCompleteVmDestroyReceipt('tool-vm-sealed-gateway'),
		);
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub('tool-vm-sealed-gateway'),
				close: closeMock,
			})),
			now: () => nowMs,
			ownershipCoordinator,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease(createAgentLeaseOptions());
		if (options.startActiveUseBeforeSeal) {
			leaseManager.startActiveUse(lease.id, {
				useId: '01890f00-0000-7000-8000-000000000000',
			});
		}
		ownershipCoordinator.sealGatewayEpoch(TEST_GATEWAY_EPOCH);

		return {
			closeMock,
			lease,
			leaseManager,
			setNow(nextNowMs: number): void {
				nowMs = nextNowMs;
			},
		};
	}

	it('creates opaque UUIDv7 lease ids instead of encoding zone, agent, or createdAt', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000000',
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 1_700_000_000_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});

		const lease = await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
			}),
		);

		expect(lease.id).toBe('01890f00-0000-7000-8000-000000000000');
		expect(lease.id).not.toContain('beta');
		expect(lease.id).not.toContain('shravan');
		expect(lease.id).not.toContain('1700000000000');
	});

	it('admits ownership before VM creation and commits only after SSH and runtime persistence', async () => {
		const callOrder: string[] = [];
		const ownershipCoordinator = createOwnershipCoordinatorStub({
			admitProvisionalToolVm: vi.fn((options) => {
				callOrder.push('admit-provisional');
				expect(options).toMatchObject({
					agentId: 'beta',
					expectedGateway: TEST_GATEWAY_EPOCH,
				});
				return createProvisionalToolVmOwnershipHandle({
					ready: Promise.resolve().then(() => {
						callOrder.push('ownership-ready');
						return TEST_TOOL_VM_OWNERSHIP_RESERVATION;
					}),
					commitCurrent: vi.fn(async () => {
						expect(leaseManager.listLeases()).toHaveLength(0);
						callOrder.push('commit-current');
					}),
				});
			}),
		});
		const createManagedVm = vi.fn(async (options) => {
			expect(options.ownershipReservation).toEqual(TEST_TOOL_VM_OWNERSHIP_RESERVATION);
			callOrder.push('create-vm');
			return {
				...createManagedVmStub('tool-vm-owned'),
				enableSsh: vi.fn(async () => {
					callOrder.push('enable-ssh');
					return {
						command: 'ssh ...',
						host: '127.0.0.1',
						identityFile: '/tmp/key',
						port: 19000,
						user: 'sandbox',
					};
				}),
			};
		});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			ownershipCoordinator,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
			writeToolVmRuntimeRecord: vi.fn(async () => {
				callOrder.push('persist-runtime');
			}),
		});

		const lease = await leaseManager.createLease(createAgentLeaseOptions());

		expect(lease.vm.id).toBe('tool-vm-owned');
		expect(callOrder).toEqual([
			'admit-provisional',
			'ownership-ready',
			'create-vm',
			'enable-ssh',
			'persist-runtime',
			'commit-current',
		]);
		expect(leaseManager.listLeases()).toHaveLength(1);
	});

	it('destroys a lease sealed after durable current membership but before registry publication', async () => {
		const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-lease-publication-gap-'));
		try {
			let journalOperationCount = 0;
			let markCurrentTransitionExposed: (() => void) | undefined;
			const currentTransitionExposed = new Promise<void>((resolve) => {
				markCurrentTransitionExposed = resolve;
			});
			let releaseCurrentPersistence: (() => void) | undefined;
			const currentPersistenceMaySettle = new Promise<void>((resolve) => {
				releaseCurrentPersistence = resolve;
			});
			const journal = createVmOwnershipJournal({
				nowMs: () => 100,
				onCrossProcessLockAcquired: async () => {
					journalOperationCount += 1;
					if (journalOperationCount === 3) {
						markCurrentTransitionExposed?.();
						await currentPersistenceMaySettle;
					}
				},
				stateDirectory,
			});
			const barrier = await registerGatewayMembershipBarrier({
				gateway: TEST_GATEWAY_EPOCH,
				gatewayReservation: {
					controllerEpoch: TEST_GATEWAY_EPOCH.controllerEpoch,
					expectedRevision: 1,
					parentGateway: null,
					principal: {
						configPath: '/etc/agent-vm/system.json',
						controllerPort: 18_800,
						kind: 'gateway-zone',
						projectNamespace: 'lease-publication-gap',
						zoneId: TEST_GATEWAY_EPOCH.zoneId,
					},
					reservationId: 'gateway-reservation-publication-gap',
					reservationPath: journal.reservationPathFor('gateway-reservation-publication-gap'),
					role: 'gateway',
					sessionLabel: 'gateway publication gap',
					vmId: TEST_GATEWAY_EPOCH.gatewayVmId,
				},
				journal,
			});
			const managedReservation = {
				expectedContractVersion: 1,
				expectedRevision: 1,
				reservationId: 'tool-reservation-publication-gap',
				reservationPath: journal.reservationPathFor('tool-reservation-publication-gap'),
			} satisfies VmOwnershipReservationReferenceV1;
			const toolReservation = {
				controllerEpoch: TEST_GATEWAY_EPOCH.controllerEpoch,
				expectedRevision: managedReservation.expectedRevision,
				parentGateway: {
					gatewayEpochId: TEST_GATEWAY_EPOCH.gatewayEpochId,
					gatewayVmId: TEST_GATEWAY_EPOCH.gatewayVmId,
				},
				principal: {
					agentId: 'beta',
					configPath: '/etc/agent-vm/system.json',
					controllerPort: 18_800,
					kind: 'stable-agent',
					projectNamespace: 'lease-publication-gap',
					zoneId: TEST_GATEWAY_EPOCH.zoneId,
				},
				reservationId: managedReservation.reservationId,
				reservationPath: managedReservation.reservationPath,
				role: 'tool',
				sessionLabel: 'tool publication gap',
				vmId: 'tool-vm-publication-gap',
			} as const;
			const admission = barrier.admitProvisionalChild(TEST_GATEWAY_EPOCH, toolReservation);
			const closeMock = vi.fn<ManagedVm['close']>(async () =>
				createCompleteVmDestroyReceipt(toolReservation.vmId),
			);
			const destroyLive = vi.fn<ProvisionalToolVmOwnershipHandle['destroyLive']>(
				async (closeLiveVm) => {
					await admission.beginDestroying();
					const receipt = await closeLiveVm();
					await admission.recordDestroyDisposition(
						receipt.complete
							? { complete: true, observedReservationRevision: 1 }
							: {
									complete: false,
									observedReservationRevision: 1,
									reason: 'exact-destroy-incomplete',
								},
					);
					return receipt;
				},
			);
			const ownershipCoordinator = createOwnershipCoordinatorStub({
				admitProvisionalToolVm: () => ({
					commitCurrent: async () => await admission.commitCurrent(),
					destroyDetached: async () => createCompleteVmDestroyReceipt(toolReservation.vmId),
					destroyLive,
					ready: Promise.resolve(managedReservation),
				}),
				recordGatewayDestroyReceipt: async () => {
					await barrier.recordGatewayDestroyDisposition(TEST_GATEWAY_EPOCH, {
						complete: true,
					});
				},
				sealGatewayEpoch: (expectedGateway) => barrier.sealGatewayEpoch(expectedGateway),
			});
			const leaseManager = createLeaseManager({
				...defaultRuntimeRecordOptions,
				createManagedVm: vi.fn(async () => ({
					...createManagedVmStub(toolReservation.vmId),
					close: closeMock,
				})),
				now: () => 100,
				ownershipCoordinator,
				tcpPool: createTcpPool({ basePort: 19_000, size: 1 }),
			});

			const leaseCreation = leaseManager.createLease(createAgentLeaseOptions());
			await currentTransitionExposed;
			expect(barrier.snapshot().children).toEqual([
				expect.objectContaining({
					reservationId: managedReservation.reservationId,
					state: 'current',
				}),
			]);
			const sealed = ownershipCoordinator.sealGatewayEpoch(TEST_GATEWAY_EPOCH);
			expect(sealed.childReservationIds).toEqual([managedReservation.reservationId]);
			expect(() =>
				barrier.admitProvisionalChild(TEST_GATEWAY_EPOCH, {
					...toolReservation,
					principal: { ...toolReservation.principal, agentId: 'successor' },
					reservationId: 'tool-reservation-successor-before-gateway-receipt',
					reservationPath: journal.reservationPathFor(
						'tool-reservation-successor-before-gateway-receipt',
					),
					vmId: 'tool-vm-successor-before-gateway-receipt',
				}),
			).toThrowError(expect.objectContaining({ code: 'gateway-not-admitting' }));
			const gatewayLeaseDestruction = leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH);
			await Promise.resolve();
			releaseCurrentPersistence?.();

			await leaseCreation;
			await gatewayLeaseDestruction;
			await journal.loadGatewayMembership(TEST_GATEWAY_EPOCH.gatewayEpochId);

			expect(destroyLive).toHaveBeenCalledOnce();
			expect(closeMock).toHaveBeenCalledOnce();
			expect(leaseManager.listLeases()).toHaveLength(0);
			let childBarrierSettled = false;
			void sealed.barrier.then(() => {
				childBarrierSettled = true;
			});
			await Promise.resolve();
			await Promise.resolve();
			expect(childBarrierSettled).toBe(true);
			await sealed.barrier;
			await barrier.beginGatewayDestroying(TEST_GATEWAY_EPOCH);
			expect(() =>
				barrier.admitProvisionalChild(TEST_GATEWAY_EPOCH, {
					...toolReservation,
					principal: { ...toolReservation.principal, agentId: 'successor' },
					reservationId: 'tool-reservation-successor-before-final-receipt',
					reservationPath: journal.reservationPathFor(
						'tool-reservation-successor-before-final-receipt',
					),
					vmId: 'tool-vm-successor-before-final-receipt',
				}),
			).toThrowError(expect.objectContaining({ code: 'gateway-not-admitting' }));
			await ownershipCoordinator.recordGatewayDestroyReceipt(
				TEST_GATEWAY_EPOCH,
				createCompleteVmDestroyReceipt(TEST_GATEWAY_EPOCH.gatewayVmId),
			);
			expect(barrier.snapshot().state).toBe('destroyed');
			expect(() =>
				barrier.admitProvisionalChild(TEST_GATEWAY_EPOCH, {
					...toolReservation,
					principal: { ...toolReservation.principal, agentId: 'successor' },
					reservationId: 'tool-reservation-successor-after-final-receipt',
					reservationPath: journal.reservationPathFor(
						'tool-reservation-successor-after-final-receipt',
					),
					vmId: 'tool-vm-successor-after-final-receipt',
				}),
			).toThrowError(expect.objectContaining({ code: 'gateway-not-admitting' }));
		} finally {
			await rm(stateDirectory, { force: true, recursive: true });
		}
	});

	it('deletes the persisted runtime record when commitCurrent fails and exact rollback completes', async () => {
		const callOrder: string[] = [];
		const commitFailure = new Error('ownership commit failed');
		const closeMock = vi.fn(async () => {
			callOrder.push('close-vm');
			return createCompleteVmDestroyReceipt('tool-vm-commit-rollback-complete');
		});
		const destroyLive = vi.fn(
			async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> => {
				callOrder.push('destroy-live');
				return await closeLiveVm();
			},
		);
		const ownershipCoordinator = createOwnershipCoordinatorStub({
			admitProvisionalToolVm: () =>
				createProvisionalToolVmOwnershipHandle({
					commitCurrent: vi.fn(async () => {
						expect(leaseManager.listLeases()).toHaveLength(0);
						callOrder.push('commit-current');
						throw commitFailure;
					}),
					destroyLive,
				}),
		});
		const deleteToolVmRuntimeRecordMock = vi.fn(async () => {
			callOrder.push('delete-runtime');
		});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000100',
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub('tool-vm-commit-rollback-complete'),
				close: closeMock,
			})),
			createRuntimeRecordId: () => '01890f00-0000-7000-8000-000000000101',
			deleteToolVmRuntimeRecord: deleteToolVmRuntimeRecordMock,
			now: () => 100,
			ownershipCoordinator,
			tcpPool,
			writeToolVmRuntimeRecord: vi.fn(async () => {
				callOrder.push('persist-runtime');
			}),
		});

		await expect(leaseManager.createLease(createAgentLeaseOptions())).rejects.toBe(commitFailure);

		expect(callOrder).toEqual([
			'persist-runtime',
			'commit-current',
			'destroy-live',
			'close-vm',
			'delete-runtime',
		]);
		expect(destroyLive).toHaveBeenCalledOnce();
		expect(deleteToolVmRuntimeRecordMock).toHaveBeenCalledWith(
			'/tmp/lease-manager-tests/shravan',
			'01890f00-0000-7000-8000-000000000101',
		);
		expect(leaseManager.listLeases()).toHaveLength(0);
		expect(leaseManager.peekLease('01890f00-0000-7000-8000-000000000100')).toBeUndefined();
		expect(tcpPool.allocate()).toBe(0);
	});

	it.each([
		{
			destroyKind: 'incomplete receipt',
			expectedCloseCount: 1,
			expectedCleanupMessage: /incomplete/u,
			destroyLive: async (
				closeLiveVm: () => Promise<VmDestroyReceiptV1>,
			): Promise<VmDestroyReceiptV1> => await closeLiveVm(),
			vmClose: async (): Promise<VmDestroyReceiptV1> => incompleteVmDestroyReceipt,
		},
		{
			destroyKind: 'throw',
			expectedCloseCount: 0,
			expectedCleanupMessage: /ownership destroy failed/u,
			destroyLive: async (): Promise<VmDestroyReceiptV1> => {
				throw new Error('ownership destroy failed');
			},
			vmClose: async (): Promise<VmDestroyReceiptV1> =>
				createCompleteVmDestroyReceipt('tool-vm-unreached-close'),
		},
	])(
		'preserves the runtime record and quarantines TCP when commitCurrent rollback returns $destroyKind',
		async ({
			destroyLive: destroyLiveImplementation,
			expectedCleanupMessage,
			expectedCloseCount,
			vmClose,
		}) => {
			const commitFailure = new Error('ownership commit failed');
			const closeMock = vi.fn(vmClose);
			const destroyLive = vi.fn(destroyLiveImplementation);
			const ownershipCoordinator = createOwnershipCoordinatorStub({
				admitProvisionalToolVm: () =>
					createProvisionalToolVmOwnershipHandle({
						commitCurrent: vi.fn(async () => {
							throw commitFailure;
						}),
						destroyLive,
					}),
			});
			const deleteToolVmRuntimeRecordMock = vi.fn(async () => {});
			const writeToolVmRuntimeRecordMock = vi.fn(async () => {});
			const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
			const leaseManager = createLeaseManager({
				...defaultRuntimeRecordOptions,
				createLeaseId: () => '01890f00-0000-7000-8000-000000000102',
				createManagedVm: vi.fn(async () => ({
					...createManagedVmStub('tool-vm-commit-rollback-owner-unsafe'),
					close: closeMock,
				})),
				createRuntimeRecordId: () => '01890f00-0000-7000-8000-000000000103',
				deleteToolVmRuntimeRecord: deleteToolVmRuntimeRecordMock,
				now: () => 100,
				ownershipCoordinator,
				tcpPool,
				writeToolVmRuntimeRecord: writeToolVmRuntimeRecordMock,
			});
			let createError: unknown;

			try {
				await leaseManager.createLease(createAgentLeaseOptions());
			} catch (error) {
				createError = error;
			}

			expect(createError).toBeInstanceOf(AggregateError);
			expect((createError as AggregateError).errors[0]).toBe(commitFailure);
			expect((createError as AggregateError).errors[1]).toEqual(
				expect.objectContaining({
					message: expect.stringMatching(expectedCleanupMessage),
				}),
			);
			expect(destroyLive).toHaveBeenCalledOnce();
			expect(closeMock).toHaveBeenCalledTimes(expectedCloseCount);
			expect(writeToolVmRuntimeRecordMock).toHaveBeenCalledOnce();
			expect(deleteToolVmRuntimeRecordMock).not.toHaveBeenCalled();
			expect(leaseManager.listLeases()).toHaveLength(0);
			expect(leaseManager.peekLease('01890f00-0000-7000-8000-000000000102')).toBeUndefined();
			expect(tcpPool.isQuarantined(0)).toBe(true);
			expect(() => tcpPool.allocate()).toThrow('No TCP slots available');
		},
	);

	it('retries receipt-bound release without dropping ownership after an incomplete destroy', async () => {
		const closeMock = vi
			.fn()
			.mockResolvedValueOnce(incompleteVmDestroyReceipt)
			.mockResolvedValueOnce(createCompleteVmDestroyReceipt('tool-vm-release-retry'));
		const destroyLive = vi.fn(
			async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> =>
				await closeLiveVm(),
		);
		const ownershipCoordinator = createOwnershipCoordinatorStub({
			admitProvisionalToolVm: () =>
				createProvisionalToolVmOwnershipHandle({
					destroyLive,
				}),
		});
		const deleteToolVmRuntimeRecordMock = vi.fn(async () => {});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub('tool-vm-release-retry'),
				close: closeMock,
			})),
			deleteToolVmRuntimeRecord: deleteToolVmRuntimeRecordMock,
			now: () => 100,
			ownershipCoordinator,
			tcpPool,
		});
		const lease = await leaseManager.createLease(createAgentLeaseOptions());

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow(/incomplete/u);

		expect(destroyLive).toHaveBeenCalledOnce();
		expect(leaseManager.peekLease(lease.id)?.lease.id).toBe(lease.id);
		expect(deleteToolVmRuntimeRecordMock).not.toHaveBeenCalled();
		expect(tcpPool.isQuarantined(0)).toBe(true);

		await expect(leaseManager.releaseLease(lease.id)).resolves.toBeUndefined();

		expect(destroyLive).toHaveBeenCalledTimes(2);
		expect(closeMock).toHaveBeenCalledTimes(2);
		expect(leaseManager.peekLease(lease.id)).toBeUndefined();
		expect(deleteToolVmRuntimeRecordMock).toHaveBeenCalledOnce();
		expect(tcpPool.allocate()).toBe(0);
	});

	it('refuses to reuse a live agent lease from a different Gateway epoch', async () => {
		const createManagedVm = vi.fn(async () => createManagedVmStub('tool-vm-gateway-fenced'));
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const firstLease = await leaseManager.createLease(createAgentLeaseOptions());
		const replacementGateway = {
			...TEST_GATEWAY_EPOCH,
			gatewayEpochId: 'gateway-epoch-2',
			gatewayVmId: 'gateway-vm-2',
		} satisfies GatewayEpochIdentity;

		await expect(
			leaseManager.createLease(
				createAgentLeaseOptions({
					expectedGateway: replacementGateway,
				}),
			),
		).rejects.toThrow(/gateway/iu);

		expect(createManagedVm).toHaveBeenCalledOnce();
		expect(leaseManager.peekLease(firstLease.id)?.lease.id).toBe(firstLease.id);
	});

	it.each([
		{
			invoke: async (
				leaseManager: ReturnType<typeof createLeaseManager>,
				_leaseId: string,
			): Promise<unknown> => await leaseManager.createLease(createAgentLeaseOptions()),
			name: 'existing-lease reuse',
			startActiveUseBeforeSeal: false,
		},
		{
			invoke: async (
				leaseManager: ReturnType<typeof createLeaseManager>,
				leaseId: string,
			): Promise<unknown> => await leaseManager.renewLease(leaseId),
			name: 'renewal',
			startActiveUseBeforeSeal: false,
		},
		{
			invoke: async (
				leaseManager: ReturnType<typeof createLeaseManager>,
				leaseId: string,
			): Promise<unknown> =>
				leaseManager.startActiveUse(leaseId, {
					useId: '01890f00-0000-7000-8000-000000000001',
				}),
			name: 'active-use start',
			startActiveUseBeforeSeal: false,
		},
		{
			invoke: async (
				leaseManager: ReturnType<typeof createLeaseManager>,
				leaseId: string,
			): Promise<unknown> =>
				leaseManager.heartbeatActiveUse(leaseId, '01890f00-0000-7000-8000-000000000000', {}),
			name: 'active-use heartbeat',
			startActiveUseBeforeSeal: true,
		},
		{
			invoke: async (
				leaseManager: ReturnType<typeof createLeaseManager>,
				leaseId: string,
			): Promise<unknown> =>
				leaseManager.endActiveUse(leaseId, '01890f00-0000-7000-8000-000000000000', {
					outcome: 'completed',
				}),
			name: 'active-use end',
			startActiveUseBeforeSeal: true,
		},
	] as const)(
		'refuses $name after the parent Gateway is sealed without mutating lease or use state',
		async ({ invoke, startActiveUseBeforeSeal }) => {
			// Arrange
			const harness = await createSealedGatewayLeaseHarness({ startActiveUseBeforeSeal });
			const beforeLease = harness.leaseManager.peekLease(harness.lease.id)?.lease;
			const beforeActiveUses = harness.leaseManager.getActiveUses(harness.lease.id);
			harness.setNow(200);

			// Act
			const operationError = await captureOperationError(
				async () => await invoke(harness.leaseManager, harness.lease.id),
			);

			// Assert
			expect.soft(operationError).toMatchObject({ code: 'gateway-not-admitting' });
			expect.soft(operationError).toBeInstanceOf(GatewayMembershipError);
			expect.soft(harness.leaseManager.peekLease(harness.lease.id)?.lease).toEqual(beforeLease);
			expect.soft(harness.leaseManager.getActiveUses(harness.lease.id)).toEqual(beforeActiveUses);
		},
	);

	it('still permits exact release and destruction after the parent Gateway is sealed', async () => {
		// Arrange
		const harness = await createSealedGatewayLeaseHarness();

		// Act
		await harness.leaseManager.releaseLease(harness.lease.id);

		// Assert
		expect(harness.closeMock).toHaveBeenCalledOnce();
		expect(harness.leaseManager.peekLease(harness.lease.id)).toBeUndefined();
	});

	it('destroys every exact-Gateway lease, aggregates failures, and leaves a sibling Gateway untouched', async () => {
		const firstDestroyFailure = new Error('first exact-Gateway destroy failed');
		const secondDestroyFailure = new Error('second exact-Gateway destroy failed');
		const destroyFirst = vi.fn(
			async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> =>
				await closeLiveVm(),
		);
		const destroySecond = vi
			.fn(
				async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> =>
					await closeLiveVm(),
			)
			.mockRejectedValueOnce(firstDestroyFailure);
		const destroyThird = vi.fn(
			async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> =>
				await closeLiveVm(),
		);
		const destroyFourth = vi
			.fn(
				async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> =>
					await closeLiveVm(),
			)
			.mockRejectedValueOnce(secondDestroyFailure);
		const destroySibling = vi.fn(
			async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> =>
				await closeLiveVm(),
		);
		const ownershipByAgent = new Map<string, ProvisionalToolVmOwnershipHandle>([
			['first', createProvisionalToolVmOwnershipHandle({ destroyLive: destroyFirst })],
			['second', createProvisionalToolVmOwnershipHandle({ destroyLive: destroySecond })],
			['third', createProvisionalToolVmOwnershipHandle({ destroyLive: destroyThird })],
			['fourth', createProvisionalToolVmOwnershipHandle({ destroyLive: destroyFourth })],
			['sibling', createProvisionalToolVmOwnershipHandle({ destroyLive: destroySibling })],
		]);
		const ownershipCoordinator = createOwnershipCoordinatorStub({
			admitProvisionalToolVm: (options) => {
				const ownership = ownershipByAgent.get(options.agentId);
				if (ownership === undefined) {
					throw new Error(`missing ownership stub for '${options.agentId}'`);
				}
				return ownership;
			},
		});
		const deleteToolVmRuntimeRecordMock = vi.fn(
			async (_stateDirectory: string, _recordId: string): Promise<void> => {},
		);
		const tcpPool = createTcpPool({ basePort: 19000, size: 5 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async (options) => createManagedVmStub(`tool-vm-${options.agentId}`)),
			deleteToolVmRuntimeRecord: deleteToolVmRuntimeRecordMock,
			now: () => 100,
			ownershipCoordinator,
			tcpPool,
		});
		const firstLease = await leaseManager.createLease(
			createAgentLeaseOptions({ agentId: 'first' }),
		);
		const secondLease = await leaseManager.createLease(
			createAgentLeaseOptions({ agentId: 'second' }),
		);
		const thirdLease = await leaseManager.createLease(
			createAgentLeaseOptions({ agentId: 'third' }),
		);
		const fourthLease = await leaseManager.createLease(
			createAgentLeaseOptions({ agentId: 'fourth' }),
		);
		const siblingGateway = {
			...TEST_GATEWAY_EPOCH,
			gatewayEpochId: 'gateway-epoch-sibling',
			gatewayVmId: 'gateway-vm-sibling',
			zoneId: 'alex',
		} satisfies GatewayEpochIdentity;
		const siblingLease = await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'sibling',
				expectedGateway: siblingGateway,
				zoneId: 'alex',
			}),
		);
		let gatewayDestroyError: unknown;

		try {
			await leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH);
		} catch (error) {
			gatewayDestroyError = error;
		}

		expect(gatewayDestroyError).toBeInstanceOf(AggregateError);
		expect((gatewayDestroyError as AggregateError).errors).toEqual([
			firstDestroyFailure,
			secondDestroyFailure,
		]);
		expect((gatewayDestroyError as Error).message).toMatch(/2 incomplete Tool VM dispositions/u);
		expect(destroyFirst).toHaveBeenCalledOnce();
		expect(destroySecond).toHaveBeenCalledOnce();
		expect(destroyThird).toHaveBeenCalledOnce();
		expect(destroyFourth).toHaveBeenCalledOnce();
		expect(destroySibling).not.toHaveBeenCalled();
		expect(leaseManager.peekLease(firstLease.id)).toBeUndefined();
		expect(leaseManager.peekLease(thirdLease.id)).toBeUndefined();
		expect(leaseManager.peekLease(secondLease.id)?.lease.id).toBe(secondLease.id);
		expect(leaseManager.peekLease(fourthLease.id)?.lease.id).toBe(fourthLease.id);
		expect(leaseManager.peekLease(siblingLease.id)?.lease.id).toBe(siblingLease.id);
		expect(tcpPool.isQuarantined(secondLease.tcpSlot)).toBe(true);
		expect(tcpPool.isQuarantined(fourthLease.tcpSlot)).toBe(true);
		const deletedRuntimeRecordIds = deleteToolVmRuntimeRecordMock.mock.calls.map((call) => call[1]);
		expect(deletedRuntimeRecordIds).toEqual(
			expect.arrayContaining([firstLease.runtimeRecordId, thirdLease.runtimeRecordId]),
		);
		expect(deletedRuntimeRecordIds).toHaveLength(2);
		expect(deletedRuntimeRecordIds).not.toContain(secondLease.runtimeRecordId);
		expect(deletedRuntimeRecordIds).not.toContain(fourthLease.runtimeRecordId);
		expect(deletedRuntimeRecordIds).not.toContain(siblingLease.runtimeRecordId);

		await expect(
			leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH),
		).resolves.toBeUndefined();

		expect(destroySecond).toHaveBeenCalledTimes(2);
		expect(destroyFourth).toHaveBeenCalledTimes(2);
		expect(destroySibling).not.toHaveBeenCalled();
		expect(leaseManager.peekLease(secondLease.id)).toBeUndefined();
		expect(leaseManager.peekLease(fourthLease.id)).toBeUndefined();
		expect(leaseManager.peekLease(siblingLease.id)?.lease.id).toBe(siblingLease.id);
		expect(tcpPool.isQuarantined(secondLease.tcpSlot)).toBe(false);
		expect(tcpPool.isQuarantined(fourthLease.tcpSlot)).toBe(false);
	});

	it('bounds exact-Gateway child destruction to four concurrent attempts', async () => {
		const agentIds = ['first', 'second', 'third', 'fourth', 'fifth'] as const;
		const destroyStartedAgentIds: string[] = [];
		let activeDestroyCount = 0;
		let maximumActiveDestroyCount = 0;
		let releaseDestroyAttempts: (() => void) | undefined;
		const destroyAttemptsMayFinish = new Promise<void>((resolve) => {
			releaseDestroyAttempts = resolve;
		});
		let markFourDestroysStarted: (() => void) | undefined;
		const fourDestroysStarted = new Promise<void>((resolve) => {
			markFourDestroysStarted = resolve;
		});
		const ownershipCoordinator = createOwnershipCoordinatorStub({
			admitProvisionalToolVm: (options) =>
				createProvisionalToolVmOwnershipHandle({
					destroyLive: async (closeLiveVm): Promise<VmDestroyReceiptV1> => {
						destroyStartedAgentIds.push(options.agentId);
						activeDestroyCount += 1;
						maximumActiveDestroyCount = Math.max(maximumActiveDestroyCount, activeDestroyCount);
						if (destroyStartedAgentIds.length === 4) {
							markFourDestroysStarted?.();
						}
						await destroyAttemptsMayFinish;
						const receipt = await closeLiveVm();
						activeDestroyCount -= 1;
						return receipt;
					},
				}),
		});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async (options) => createManagedVmStub(`tool-vm-${options.agentId}`)),
			now: () => 100,
			ownershipCoordinator,
			tcpPool: createTcpPool({ basePort: 19000, size: agentIds.length }),
		});
		await Promise.all(
			agentIds.map(
				async (agentId) => await leaseManager.createLease(createAgentLeaseOptions({ agentId })),
			),
		);

		const destruction = leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH);
		await fourDestroysStarted;
		const startedBeforeCapacityReleased = [...destroyStartedAgentIds];
		releaseDestroyAttempts?.();
		await destruction;

		expect(startedBeforeCapacityReleased).toHaveLength(4);
		expect(maximumActiveDestroyCount).toBe(4);
		expect(destroyStartedAgentIds).toHaveLength(agentIds.length);
		expect(new Set(destroyStartedAgentIds)).toEqual(new Set(agentIds));
		expect(leaseManager.listLeases()).toHaveLength(0);
	});

	it('stops dequeuing Tool VM destroys when the Gateway subtree attempt aborts', async () => {
		// Arrange
		const agentIds = ['first', 'second', 'third', 'fourth', 'fifth'] as const;
		const destroyStartedAgentIds: string[] = [];
		let releaseRunningDestroys: (() => void) | undefined;
		const runningDestroysMayFinish = new Promise<void>((resolve) => {
			releaseRunningDestroys = resolve;
		});
		let markFourDestroysStarted: (() => void) | undefined;
		const fourDestroysStarted = new Promise<void>((resolve) => {
			markFourDestroysStarted = resolve;
		});
		const ownershipCoordinator = createOwnershipCoordinatorStub({
			admitProvisionalToolVm: (options) =>
				createProvisionalToolVmOwnershipHandle({
					destroyLive: async (closeLiveVm): Promise<VmDestroyReceiptV1> => {
						destroyStartedAgentIds.push(options.agentId);
						if (destroyStartedAgentIds.length === 4) {
							markFourDestroysStarted?.();
						}
						await runningDestroysMayFinish;
						return await closeLiveVm();
					},
				}),
		});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async (options) => createManagedVmStub(`tool-vm-${options.agentId}`)),
			now: () => 100,
			ownershipCoordinator,
			tcpPool: createTcpPool({ basePort: 19000, size: agentIds.length }),
		});
		await Promise.all(
			agentIds.map(
				async (agentId) => await leaseManager.createLease(createAgentLeaseOptions({ agentId })),
			),
		);
		const abortController = new AbortController();
		const destruction = leaseManager.destroyGatewayOwnedLeases(
			TEST_GATEWAY_EPOCH,
			abortController.signal,
		);
		await fourDestroysStarted;

		// Act
		abortController.abort(
			new GatewayDestructionTimeoutError(
				'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
				'Gateway subtree',
				300_000,
			),
		);
		releaseRunningDestroys?.();

		// Assert
		await expect(destruction).rejects.toBeDefined();
		expect(destroyStartedAgentIds).toHaveLength(4);
		expect(destroyStartedAgentIds).not.toContain('fifth');
		expect(leaseManager.listLeases()).toHaveLength(1);
		expect(leaseManager.listLeases()[0]?.agentId).toBe('fifth');
	});

	it('includes pending partial-create ownership in exact-Gateway destruction', async () => {
		const commitFailure = new Error('ownership commit failed');
		const closeMock = vi
			.fn()
			.mockResolvedValueOnce(incompleteVmDestroyReceipt)
			.mockResolvedValueOnce(createCompleteVmDestroyReceipt('tool-vm-pending-cleanup'));
		const destroyLive = vi.fn(
			async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> =>
				await closeLiveVm(),
		);
		const ownershipCoordinator = createOwnershipCoordinatorStub({
			admitProvisionalToolVm: () =>
				createProvisionalToolVmOwnershipHandle({
					commitCurrent: vi.fn(async () => {
						throw commitFailure;
					}),
					destroyLive,
				}),
		});
		const deleteToolVmRuntimeRecordMock = vi.fn(
			async (_stateDirectory: string, _recordId: string): Promise<void> => {},
		);
		const writeToolVmRuntimeRecordMock = vi.fn(async () => {});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub('tool-vm-pending-cleanup'),
				close: closeMock,
			})),
			createRuntimeRecordId: () => '01890f00-0000-7000-8000-000000000104',
			deleteToolVmRuntimeRecord: deleteToolVmRuntimeRecordMock,
			now: () => 100,
			ownershipCoordinator,
			tcpPool,
			writeToolVmRuntimeRecord: writeToolVmRuntimeRecordMock,
		});

		await expect(leaseManager.createLease(createAgentLeaseOptions())).rejects.toBeInstanceOf(
			AggregateError,
		);
		expect(leaseManager.listLeases()).toHaveLength(0);
		expect(destroyLive).toHaveBeenCalledOnce();
		expect(writeToolVmRuntimeRecordMock).toHaveBeenCalledOnce();
		expect(deleteToolVmRuntimeRecordMock).not.toHaveBeenCalled();
		expect(tcpPool.isQuarantined(0)).toBe(true);

		await expect(
			leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH),
		).resolves.toBeUndefined();

		expect(destroyLive).toHaveBeenCalledTimes(2);
		expect(closeMock).toHaveBeenCalledTimes(2);
		expect(deleteToolVmRuntimeRecordMock).toHaveBeenCalledWith(
			'/tmp/lease-manager-tests/shravan',
			'01890f00-0000-7000-8000-000000000104',
		);
		expect(tcpPool.isQuarantined(0)).toBe(false);
		expect(tcpPool.allocate()).toBe(0);
	});

	it('retains owner-unsafe provisional ownership until exact-Gateway detached cleanup is proven complete', async () => {
		// Arrange
		const primaryCreateFailure = new IncompleteVmDestructionError(
			'Primary provisional Tool VM creation',
			incompleteVmDestroyReceipt,
		);
		const siblingCreateFailure = new IncompleteVmDestructionError(
			'Sibling provisional Tool VM creation',
			incompleteVmDestroyReceipt,
		);
		const primaryDetachedFailure = new Error('primary detached cleanup rejected');
		const primaryDestroyDetached = vi
			.fn<ProvisionalToolVmOwnershipHandle['destroyDetached']>()
			.mockRejectedValueOnce(primaryDetachedFailure)
			.mockResolvedValueOnce(createCompleteVmDestroyReceipt('tool-vm-primary-detached'));
		const siblingDestroyDetached = vi.fn<ProvisionalToolVmOwnershipHandle['destroyDetached']>(
			async () => createCompleteVmDestroyReceipt('tool-vm-sibling-detached'),
		);
		const ownershipByAgent = new Map<string, ProvisionalToolVmOwnershipHandle>([
			[
				'primary',
				createProvisionalToolVmOwnershipHandle({
					destroyDetached: primaryDestroyDetached,
					ready: Promise.reject(primaryCreateFailure),
				}),
			],
			[
				'sibling',
				createProvisionalToolVmOwnershipHandle({
					destroyDetached: siblingDestroyDetached,
					ready: Promise.reject(siblingCreateFailure),
				}),
			],
		]);
		const ownershipCoordinator = createOwnershipCoordinatorStub({
			admitProvisionalToolVm: (options) => {
				const ownership = ownershipByAgent.get(options.agentId);
				if (ownership === undefined) {
					throw new Error(`missing ownership stub for '${options.agentId}'`);
				}
				return ownership;
			},
		});
		const createManagedVm = vi.fn(async () => createManagedVmStub('unreachable-tool-vm'));
		const tcpPool = createTcpPool({ basePort: 19_000, size: 2 });
		const releaseQuarantinedTcpSlot = vi.spyOn(tcpPool, 'releaseQuarantined');
		const siblingGateway = {
			...TEST_GATEWAY_EPOCH,
			bootId: 'gateway-boot-sibling',
			gatewayEpochId: 'gateway-epoch-sibling',
			gatewayVmId: 'gateway-vm-sibling',
			generationId: 'gateway-generation-sibling',
		} satisfies GatewayEpochIdentity;
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			ownershipCoordinator,
			tcpPool,
		});
		const primaryRequest = createAgentLeaseOptions({ agentId: 'primary' });
		const siblingRequest = createAgentLeaseOptions({
			agentId: 'sibling',
			expectedGateway: siblingGateway,
		});
		await expect(leaseManager.createLease(primaryRequest)).rejects.toBe(primaryCreateFailure);
		await expect(leaseManager.createLease(siblingRequest)).rejects.toBe(siblingCreateFailure);
		expect(tcpPool.isQuarantined(0)).toBe(true);
		expect(tcpPool.isQuarantined(1)).toBe(true);
		expect(createManagedVm).not.toHaveBeenCalled();

		// Act
		let gatewayCleanupError: unknown;
		try {
			await leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH);
		} catch (error) {
			gatewayCleanupError = error;
		}

		// Assert
		expect(gatewayCleanupError).toBeInstanceOf(AggregateError);
		expect((gatewayCleanupError as AggregateError).errors).toEqual([primaryDetachedFailure]);
		expect(primaryDestroyDetached).toHaveBeenCalledOnce();
		expect(siblingDestroyDetached).not.toHaveBeenCalled();
		expect(tcpPool.isQuarantined(0)).toBe(true);
		expect(tcpPool.isQuarantined(1)).toBe(true);
		expect(releaseQuarantinedTcpSlot).not.toHaveBeenCalled();

		// Act
		await expect(
			leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH),
		).resolves.toBeUndefined();

		// Assert
		expect(primaryDestroyDetached).toHaveBeenCalledTimes(2);
		expect(siblingDestroyDetached).not.toHaveBeenCalled();
		expect(tcpPool.isQuarantined(0)).toBe(false);
		expect(tcpPool.isQuarantined(1)).toBe(true);
		expect(releaseQuarantinedTcpSlot).toHaveBeenCalledOnce();
		await expect(leaseManager.createLease(siblingRequest)).rejects.toBe(siblingCreateFailure);
	});

	it('serializes same-agent pending-create retry with exact-Gateway cleanup', async () => {
		// Arrange
		const commitFailure = new Error('ownership commit failed');
		let pendingDestroyAttempt = 0;
		let markRetryDestroyStarted: (() => void) | undefined;
		const retryDestroyStarted = new Promise<void>((resolve) => {
			markRetryDestroyStarted = resolve;
		});
		let allowRetryDestroyToFinish: (() => void) | undefined;
		const retryDestroyMayFinish = new Promise<void>((resolve) => {
			allowRetryDestroyToFinish = resolve;
		});
		const pendingClose = vi
			.fn<ManagedVm['close']>()
			.mockResolvedValueOnce(incompleteVmDestroyReceipt)
			.mockResolvedValue(createCompleteVmDestroyReceipt('tool-vm-pending-serialized'));
		const pendingDestroyLive = vi.fn(
			async (closeLiveVm: () => Promise<VmDestroyReceiptV1>): Promise<VmDestroyReceiptV1> => {
				pendingDestroyAttempt += 1;
				if (pendingDestroyAttempt > 1) {
					markRetryDestroyStarted?.();
					await retryDestroyMayFinish;
				}
				return await closeLiveVm();
			},
		);
		const firstOwnership = createProvisionalToolVmOwnershipHandle({
			commitCurrent: vi.fn(async () => {
				throw commitFailure;
			}),
			destroyLive: pendingDestroyLive,
		});
		const secondOwnership = createProvisionalToolVmOwnershipHandle();
		const ownershipCoordinator = createOwnershipCoordinatorStub({
			admitProvisionalToolVm: vi
				.fn()
				.mockReturnValueOnce(firstOwnership)
				.mockReturnValueOnce(secondOwnership),
		});
		const createManagedVm = vi
			.fn()
			.mockResolvedValueOnce({
				...createManagedVmStub('tool-vm-pending-serialized'),
				close: pendingClose,
			})
			.mockResolvedValueOnce(createManagedVmStub('tool-vm-successor'));
		const deleteToolVmRuntimeRecordMock = vi.fn(
			async (_stateDirectory: string, _recordId: string): Promise<void> => {},
		);
		const writeToolVmRuntimeRecordMock = vi.fn(async () => {});
		const tcpPool = createTcpPool({ basePort: 19_000, size: 1 });
		const releaseTcpSlot = vi.spyOn(tcpPool, 'release');
		const releaseQuarantinedTcpSlot = vi.spyOn(tcpPool, 'releaseQuarantined');
		const runtimeRecordIds = [
			'01890f00-0000-7000-8000-000000000201',
			'01890f00-0000-7000-8000-000000000202',
		];
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			createRuntimeRecordId: () => runtimeRecordIds.shift() ?? 'unexpected-runtime-record-id',
			deleteToolVmRuntimeRecord: deleteToolVmRuntimeRecordMock,
			now: () => 100,
			ownershipCoordinator,
			tcpPool,
			writeToolVmRuntimeRecord: writeToolVmRuntimeRecordMock,
		});
		const leaseRequest = createAgentLeaseOptions({ agentId: 'serialized-agent' });
		await expect(leaseManager.createLease(leaseRequest)).rejects.toBeInstanceOf(AggregateError);
		expect(pendingDestroyLive).toHaveBeenCalledOnce();
		expect(tcpPool.isQuarantined(0)).toBe(true);

		// Act
		const successorCreate = leaseManager.createLease(leaseRequest);
		await retryDestroyStarted;
		const gatewayCleanup = leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH);
		const destroyAttemptCountWhileRetryPaused = pendingDestroyLive.mock.calls.length;
		allowRetryDestroyToFinish?.();
		const [successorCreateResult, gatewayCleanupResult] = await Promise.allSettled([
			successorCreate,
			gatewayCleanup,
		]);

		// Assert
		expect([successorCreateResult.status, gatewayCleanupResult.status]).toEqual([
			'fulfilled',
			'fulfilled',
		]);
		expect(destroyAttemptCountWhileRetryPaused).toBe(2);
		expect(pendingDestroyLive).toHaveBeenCalledTimes(2);
		expect(pendingClose).toHaveBeenCalledTimes(2);
		expect(deleteToolVmRuntimeRecordMock).toHaveBeenCalledTimes(2);
		expect(deleteToolVmRuntimeRecordMock).toHaveBeenNthCalledWith(
			1,
			'/tmp/lease-manager-tests/shravan',
			'01890f00-0000-7000-8000-000000000201',
		);
		expect(deleteToolVmRuntimeRecordMock).toHaveBeenNthCalledWith(
			2,
			'/tmp/lease-manager-tests/shravan',
			'01890f00-0000-7000-8000-000000000202',
		);
		expect(releaseTcpSlot).toHaveBeenCalledTimes(2);
		expect(releaseQuarantinedTcpSlot).toHaveBeenCalledTimes(2);
		expect(tcpPool.isQuarantined(0)).toBe(false);
		expect(leaseManager.listLeases()).toHaveLength(0);
	});

	it('evicts and refuses to renew an expired lease instead of resurrecting it', async () => {
		let now = 1_000;
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000001',
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease(
			createAgentLeaseOptions({
				effectiveIdleTtlMs: 1_000,
			}),
		);
		now = 2_001;

		const renewal = await leaseManager.renewLease(lease.id);

		expect(renewal).toEqual({ kind: 'not-found', reason: 'expired' });
		expect(closeMock).toHaveBeenCalledOnce();
		expect(leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('evicts and refuses to renew a lease whose VM liveness check fails', async () => {
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000002',
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
				exec: vi.fn(() =>
					createManagedExecProcessStub({ exitCode: 1, stderr: 'dead', stdout: '' }),
				),
			})),
			now: () => 1_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease(createAgentLeaseOptions());

		const renewal = await leaseManager.renewLease(lease.id);

		expect(renewal).toEqual({ kind: 'not-found', reason: 'dead' });
		expect(closeMock).toHaveBeenCalledOnce();
		expect(leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('reaps dead idle leases without treating active-use heartbeat as liveness', async () => {
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000003',
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
				exec: vi.fn(() =>
					createManagedExecProcessStub({ exitCode: 1, stderr: 'dead', stdout: '' }),
				),
			})),
			now: () => 1_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease(createAgentLeaseOptions());

		await leaseManager.reapDeadIdleLeases();

		expect(closeMock).toHaveBeenCalledOnce();
		expect(leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('serializes renew and dead-idle reaping so one dead lease is evicted once', async () => {
		let resolveProbe: (() => void) | undefined;
		const probeBarrier = new Promise<void>((resolve) => {
			resolveProbe = resolve;
		});
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000004',
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
				exec: vi.fn(() =>
					createManagedExecProcessStub({
						exitCode: 1,
						stderr: 'dead',
						stdout: '',
						waitFor: probeBarrier,
					}),
				),
			})),
			now: () => 1_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease(createAgentLeaseOptions());

		const renewalPromise = leaseManager.renewLease(lease.id);
		const reaperPromise = leaseManager.reapDeadIdleLeases();
		resolveProbe?.();

		await expect(renewalPromise).resolves.toEqual({ kind: 'not-found', reason: 'dead' });
		await reaperPromise;

		expect(closeMock).toHaveBeenCalledOnce();
		expect(leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('does not expire a lease while an active operation is heartbeating', async () => {
		let now = 1_000;
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000005',
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease({
			...createAgentLeaseOptions(),
			effectiveIdleTtlMs: 1_000,
		});
		leaseManager.startActiveUse(lease.id, {
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		now = 2_001;

		expect(await leaseManager.renewLease(lease.id)).toMatchObject({ kind: 'renewed' });
	});

	it('creates, stores, and releases a lease while returning its tcp slot', async () => {
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const enableSshMock = vi.fn(async () => ({
			command: 'ssh ...',
			host: '127.0.0.1',
			identityFile: '/tmp/key',
			port: 19000,
			user: 'sandbox',
		}));
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: enableSshMock,
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				getDestroyTarget: vi.fn(() => createTestVmDestroyTarget('tool-vm-1')),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
				getHostPid: () => 12345,
				getVmInstance: vi.fn(),
			})),
			now: () => 123,
			tcpPool: createTcpPool({
				basePort: 19000,
				size: 2,
			}),
		});

		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
			zoneId: 'shravan',
		});

		expect(lease.tcpSlot).toBe(0);
		await expect(leaseManager.renewLease(lease.id)).resolves.toMatchObject({
			kind: 'renewed',
			lease: {
				id: lease.id,
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/work',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/session/work',
				zoneId: 'shravan',
			},
		});

		await leaseManager.releaseLease(lease.id);

		expect(closeMock).toHaveBeenCalled();
		await expect(leaseManager.renewLease(lease.id)).resolves.toEqual({
			kind: 'not-found',
			reason: 'missing',
		});
	});

	it('closes VM, releases tcpSlot, and clears the lease when writeToolVmRuntimeRecord throws', async () => {
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const createManagedVm = vi.fn(async () => ({
			close: closeMock,
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				command: 'ssh ...',
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			getDestroyTarget: vi.fn(() => createTestVmDestroyTarget('tool-vm-write-fails')),
			id: 'tool-vm-write-fails',
			setIngressRoutes: vi.fn(),
			getHostPid: () => 12345,
			getVmInstance: vi.fn(),
		}));
		const tcpPool = createTcpPool({ basePort: 19000, size: 2 });
		const writeFailure = new Error('disk full');
		// Throw on first call (the lease we want to verify gets rolled back),
		// succeed afterward so the subsequent reuse-after-failure createLease
		// can verify the tcpSlot was released cleanly.
		const writeToolVmRuntimeRecordMock = vi
			.fn()
			.mockImplementationOnce(async () => {
				throw writeFailure;
			})
			.mockImplementation(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 200,
			tcpPool,
			writeToolVmRuntimeRecord: writeToolVmRuntimeRecordMock,
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/home/openclaw/work',
				expectedGateway: TEST_GATEWAY_EPOCH,
				profile: { cpus: 1, memory: '1G', imageProfile: 'default' },
				profileId: 'standard',
				guestWorkdir: '/work',
				hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/x/work',
				zoneId: 'shravan',
			}),
		).rejects.toBe(writeFailure);

		expect(writeToolVmRuntimeRecordMock).toHaveBeenCalledTimes(1);
		// VM must be closed to avoid a leaked QEMU/krun process.
		expect(closeMock).toHaveBeenCalledTimes(1);
		// No in-memory lease left behind.
		expect(leaseManager.listLeases()).toHaveLength(0);
		// tcp slot must be reusable for a subsequent createLease.
		const reusable = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: { cpus: 1, memory: '1G', imageProfile: 'default' },
			profileId: 'standard',
			guestWorkdir: '/work',
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/y/work',
			zoneId: 'shravan',
		});
		expect(reusable.tcpSlot).toBe(0);
	});

	it('quarantines partial-create ownership when close resolves with an incomplete receipt', async () => {
		const closeMock = vi.fn(async () => incompleteVmDestroyReceipt);
		const createManagedVm = vi.fn(async () => ({
			...createManagedVmStub('tool-vm-partial-create-incomplete'),
			close: closeMock,
			enableSsh: vi.fn(async () => {
				throw new Error('ssh setup failed');
			}),
		}));
		const tcpPool = createTcpPool({ basePort: 19000, size: 2 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 200,
			tcpPool,
		});
		const request = createAgentLeaseOptions({ agentId: 'main' });
		let createError: unknown;

		try {
			await leaseManager.createLease(request);
		} catch (error) {
			createError = error;
		}

		expect(createError).toBeInstanceOf(AggregateError);
		expect((createError as AggregateError).errors).toEqual([
			expect.objectContaining({ message: 'ssh setup failed' }),
			expect.objectContaining({ message: expect.stringMatching(/incomplete/u) }),
		]);
		expect(closeMock).toHaveBeenCalledOnce();
		expect(tcpPool.isQuarantined(0)).toBe(true);
		await expect(leaseManager.createLease(request)).rejects.toThrow(/incomplete/u);
		expect(createManagedVm).toHaveBeenCalledOnce();
	});

	it('permits same-G replacement after exact detached cleanup completes a nested create rollback', async () => {
		const incompleteCleanup = new IncompleteVmDestructionError(
			'Tool VM create rollback',
			incompleteVmDestroyReceipt,
		);
		const createFailure = new AggregateError(
			[new Error('mediated bootstrap failed'), incompleteCleanup],
			'Tool VM creation failed and teardown was not proven complete.',
		);
		const createManagedVm = vi
			.fn()
			.mockRejectedValueOnce(createFailure)
			.mockResolvedValueOnce(createManagedVmStub('tool-vm-same-gateway-replacement'))
			.mockResolvedValueOnce(createManagedVmStub('tool-vm-fresh-gateway'));
		const tcpPool = createTcpPool({ basePort: 19000, size: 2 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 200,
			tcpPool,
		});
		const request = createAgentLeaseOptions({ agentId: 'main' });

		await expect(leaseManager.createLease(request)).rejects.toBe(createFailure);
		await expect(leaseManager.createLease(request)).resolves.toMatchObject({
			agentId: 'main',
			tcpSlot: 0,
			vm: { id: 'tool-vm-same-gateway-replacement' },
		});

		expect(tcpPool.isQuarantined(0)).toBe(false);
		expect(createManagedVm).toHaveBeenCalledTimes(2);

		await expect(
			leaseManager.destroyGatewayOwnedLeases(TEST_GATEWAY_EPOCH),
		).resolves.toBeUndefined();
		const freshGateway = {
			...TEST_GATEWAY_EPOCH,
			bootId: 'gateway-boot-2',
			gatewayEpochId: 'gateway-epoch-2',
			gatewayVmId: 'gateway-vm-2',
			generationId: 'gateway-generation-2',
		} satisfies GatewayEpochIdentity;

		await expect(
			leaseManager.createLease(
				createAgentLeaseOptions({
					agentId: 'main',
					expectedGateway: freshGateway,
				}),
			),
		).resolves.toMatchObject({
			agentId: 'main',
			vm: { id: 'tool-vm-fresh-gateway' },
		});
		expect(createManagedVm).toHaveBeenCalledTimes(3);
	});

	it('preserves the runtime record on disk when releaseLease vm.close() throws', async () => {
		const closeMock = vi.fn(async () => {
			throw new Error('close hung');
		});
		const createManagedVm = vi.fn(async () => ({
			close: closeMock,
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				command: 'ssh ...',
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			getDestroyTarget: vi.fn(() => createTestVmDestroyTarget('tool-vm-close-fails')),
			id: 'tool-vm-close-fails',
			setIngressRoutes: vi.fn(),
			getHostPid: () => 12345,
			getVmInstance: vi.fn(),
		}));
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const deleteToolVmRuntimeRecordMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			deleteToolVmRuntimeRecord: deleteToolVmRuntimeRecordMock,
			now: () => 300,
			tcpPool,
		});

		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/home/openclaw/work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: { cpus: 1, memory: '1G', imageProfile: 'default' },
			profileId: 'standard',
			guestWorkdir: '/work',
			hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/z/work',
			zoneId: 'shravan',
		});

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow(/close hung/u);

		// Invariant: runtime record must NOT be deleted when vm.close fails so
		// the next controller's Phase A cleanup can scope-fence + signal the
		// orphan QEMU.
		expect(deleteToolVmRuntimeRecordMock).not.toHaveBeenCalled();
	});

	it('refuses explicit release when close resolves with an incomplete receipt', async () => {
		const closeMock = vi.fn(async () => incompleteVmDestroyReceipt);
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const deleteToolVmRuntimeRecordMock = vi.fn(async () => {});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub('tool-vm-release-incomplete'),
				close: closeMock,
			})),
			deleteToolVmRuntimeRecord: deleteToolVmRuntimeRecordMock,
			now: () => 300,
			tcpPool,
		});
		const lease = await leaseManager.createLease(createAgentLeaseOptions({ agentId: 'main' }));
		const retirementEvents: unknown[] = [];
		leaseManager.subscribeLeaseRetirement((event) => retirementEvents.push(event));

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow(/incomplete/u);

		expect(deleteToolVmRuntimeRecordMock).not.toHaveBeenCalled();
		expect(tcpPool.isQuarantined(0)).toBe(true);
		expect(leaseManager.peekLease(lease.id)?.lease.id).toBe(lease.id);
		expect(retirementEvents).toEqual([]);
	});

	it('reuses a live lease for the same zone agent profile and workspace', async () => {
		let now = 100;
		const createManagedVm = vi.fn(async () => createManagedVmStub());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};

		const firstLease = await leaseManager.createLease(request);
		now = 150;
		const secondLease = await leaseManager.createLease(request);

		expect(secondLease.id).toBe(firstLease.id);
		expect(secondLease.tcpSlot).toBe(0);
		expect(secondLease.lastUsedAt).toBe(150);
		expect(createManagedVm).toHaveBeenCalledTimes(1);
	});

	it('reuses the same live Tool VM for different scope keys under one agent', async () => {
		const createManagedVm = vi.fn(async () => createManagedVmStub());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		const firstLease = await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
			}),
		);
		const secondLease = await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
			}),
		);

		expect(secondLease.id).toBe(firstLease.id);
		expect(secondLease.agentId).toBe('beta');
		expect(createManagedVm).toHaveBeenCalledTimes(1);
	});

	it('creates separate Tool VMs for separate agents in the same zone', async () => {
		const createManagedVm = vi.fn(async () =>
			createManagedVmStub(`tool-vm-${createManagedVm.mock.calls.length}`),
		);
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		const betaLease = await leaseManager.createLease(createAgentLeaseOptions({ agentId: 'beta' }));
		const lauraLease = await leaseManager.createLease(
			createAgentLeaseOptions({ agentId: 'laura' }),
		);

		expect(lauraLease.id).not.toBe(betaLease.id);
		expect(leaseManager.listLeases()).toHaveLength(2);
		expect(createManagedVm).toHaveBeenCalledTimes(2);
	});

	it('does not put agent provenance into lease id', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});

		const lease = await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
			}),
		);

		expect(lease.id).not.toContain('agent:');
		expect(lease.id).not.toContain('beta');
		expect(lease.id).not.toContain('shravan');
	});

	it('rejects an incompatible workspace request for an existing agent lease', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
				hostWorkMountDir: '/tmp/beta-workspace-a',
			}),
		);

		await expect(
			leaseManager.createLease(
				createAgentLeaseOptions({
					agentId: 'beta',
					hostWorkMountDir: '/tmp/beta-workspace-b',
				}),
			),
		).rejects.toThrow(/existing Tool VM lease for agent 'beta' is not compatible/u);
	});

	it('rejects an incompatible profile request for an existing agent lease', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease(
			createAgentLeaseOptions({
				agentId: 'beta',
				profileId: 'standard',
			}),
		);

		await expect(
			leaseManager.createLease(
				createAgentLeaseOptions({
					agentId: 'beta',
					profile: { cpus: 2, memory: '2G', imageProfile: 'large' },
					profileId: 'large',
				}),
			),
		).rejects.toThrow(/existing Tool VM lease for agent 'beta' is not compatible/u);
	});

	it('peeks a lease without extending its idle timestamp', async () => {
		let now = 100;
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};
		const lease = await leaseManager.createLease(request);
		now = 150;

		const peekedLease = leaseManager.peekLease(lease.id)?.lease;
		const renewal = await leaseManager.renewLease(lease.id);
		const renewedLease = renewal.kind === 'renewed' ? renewal.lease : undefined;

		expect(peekedLease).toMatchObject({ id: lease.id, lastUsedAt: 100 });
		expect(renewedLease).toMatchObject({ id: lease.id, lastUsedAt: 150 });
		expect(leaseManager.peekLease('missing-lease')).toBeUndefined();
	});

	it('rejects same-agent lease reuse when the workspace changes', async () => {
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/host/agent-work',
				expectedGateway: TEST_GATEWAY_EPOCH,
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/host/other-sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toThrow(/existing Tool VM lease for agent 'main' is not compatible/u);
		expect(closeMock).not.toHaveBeenCalled();
	});

	it('rejects same-agent lease reuse when the profile changes', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/host/agent-work',
				expectedGateway: TEST_GATEWAY_EPOCH,
				profile: {
					cpus: 2,
					memory: '2G',
					imageProfile: 'large',
				},
				profileId: 'large',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toBeInstanceOf(AgentLeaseCompatibilityConflictError);
	});

	it('rejects same-agent lease reuse when the agent workspace changes', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/host/other-agent-work',
				expectedGateway: TEST_GATEWAY_EPOCH,
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toBeInstanceOf(AgentLeaseCompatibilityConflictError);
	});

	it('does not reuse matching agent ids across zones', async () => {
		const createManagedVm = vi.fn(async () =>
			createManagedVmStub(`tool-vm-${createManagedVm.mock.calls.length}`),
		);
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
		};

		const firstLease = await leaseManager.createLease({ ...request, zoneId: 'shravan' });
		const secondLease = await leaseManager.createLease({
			...request,
			expectedGateway: { ...TEST_GATEWAY_EPOCH, zoneId: 'alex' },
			zoneId: 'alex',
		});

		expect(secondLease.id).not.toBe(firstLease.id);
		expect(secondLease.tcpSlot).toBe(1);
		expect(createManagedVm).toHaveBeenCalledTimes(2);
	});

	it('blocks a stale same-agent successor when exact destruction throws', async () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const staleClose = vi.fn(async () => {
			throw new Error('stale close failed');
		});
		const staleVm = {
			...createManagedVmStub('stale-vm'),
			close: staleClose,
			exec: vi.fn(() => {
				throw new Error('vm is gone');
			}),
		};
		const freshVm = createManagedVmStub('fresh-vm');
		const createManagedVm = vi.fn(async () =>
			createManagedVm.mock.calls.length === 1 ? staleVm : freshVm,
		);
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => createManagedVm.mock.calls.length * 100,
			// Pool size 2: when the stale VM's close fails, slot 0 is
			// quarantined (host port may still be held). The replacement lease
			// must get slot 1 — that's the correct, port-safe behavior.
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};

		try {
			const firstLease = await leaseManager.createLease(request);
			const retirementEvents: unknown[] = [];
			leaseManager.subscribeLeaseRetirement((event) => retirementEvents.push(event));

			await expect(leaseManager.createLease(request)).rejects.toThrow('stale close failed');

			expect(leaseManager.peekLease(firstLease.id)?.lease.id).toBe(firstLease.id);
			expect(retirementEvents).toEqual([]);
			expect(staleClose).toHaveBeenCalled();
			expect(createManagedVm).toHaveBeenCalledOnce();
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some((message) =>
					message.includes(`liveness check failed for lease '${firstLease.id}'`),
				),
			).toBe(true);
			expect(
				loggedMessages.some((message) =>
					message.includes(`failed to close evicted lease '${firstLease.id}'`),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it('preserves evicted lease ownership when close resolves with an incomplete receipt', async () => {
		const staleClose = vi.fn(async () => incompleteVmDestroyReceipt);
		const staleVm = {
			...createManagedVmStub('stale-vm-incomplete'),
			close: staleClose,
			exec: vi.fn(() => {
				throw new Error('vm is gone');
			}),
		};
		const freshVm = createManagedVmStub('fresh-vm-after-incomplete');
		const createManagedVm = vi.fn(async () =>
			createManagedVm.mock.calls.length === 1 ? staleVm : freshVm,
		);
		const deleteToolVmRuntimeRecordMock = vi.fn(async () => {});
		const tcpPool = createTcpPool({ basePort: 19000, size: 2 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			deleteToolVmRuntimeRecord: deleteToolVmRuntimeRecordMock,
			now: () => createManagedVm.mock.calls.length * 100,
			tcpPool,
		});
		const request = createAgentLeaseOptions({ agentId: 'main' });

		const firstLease = await leaseManager.createLease(request);
		const retirementEvents: unknown[] = [];
		leaseManager.subscribeLeaseRetirement((event) => retirementEvents.push(event));
		await expect(leaseManager.createLease(request)).rejects.toThrow(/incomplete/u);

		expect(staleClose).toHaveBeenCalledOnce();
		expect(createManagedVm).toHaveBeenCalledOnce();
		expect(leaseManager.peekLease(firstLease.id)?.lease.id).toBe(firstLease.id);
		expect(retirementEvents).toEqual([]);
		expect(tcpPool.isQuarantined(0)).toBe(true);
		expect(deleteToolVmRuntimeRecordMock).not.toHaveBeenCalled();
	});

	it('serializes concurrent createLease calls for the same zone agent', async () => {
		let releaseCreate: (() => void) | undefined;
		let markCreateStarted: (() => void) | undefined;
		const createStarted = new Promise<void>((resolve) => {
			markCreateStarted = resolve;
		});
		const createCanFinish = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		const createManagedVm = vi.fn(async () => {
			markCreateStarted?.();
			await createCanFinish;
			return createManagedVmStub();
		});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm,
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};

		const firstLeasePromise = leaseManager.createLease(request);
		const secondLeasePromise = leaseManager.createLease(request);
		await createStarted;
		expect(createManagedVm).toHaveBeenCalledTimes(1);
		releaseCreate?.();
		const [firstLease, secondLease] = await Promise.all([firstLeasePromise, secondLeasePromise]);

		expect(secondLease.id).toBe(firstLease.id);
		expect(createManagedVm).toHaveBeenCalledTimes(1);
	});

	it('serializes releaseLease with same-agent createLease reuse', async () => {
		let releaseExec: (() => void) | undefined;
		let markExecStarted: (() => void) | undefined;
		const execStarted = new Promise<void>((resolve) => {
			markExecStarted = resolve;
		});
		const execCanFinish = new Promise<void>((resolve) => {
			releaseExec = resolve;
		});
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const vm = {
			...createManagedVmStub(),
			close: closeMock,
			exec: vi.fn(() =>
				createManagedExecProcessStub({
					beforeResolve: () => markExecStarted?.(),
					waitFor: execCanFinish,
				}),
			),
		};
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => vm),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};
		const lease = await leaseManager.createLease(request);

		const reusePromise = leaseManager.createLease(request);
		await execStarted;
		const releasePromise = leaseManager.releaseLease(lease.id);
		await Promise.resolve();
		expect(closeMock).not.toHaveBeenCalled();
		releaseExec?.();
		const reusedLease = await reusePromise;
		await releasePromise;

		expect(reusedLease.id).toBe(lease.id);
		expect(closeMock).toHaveBeenCalledTimes(1);
		await expect(leaseManager.renewLease(lease.id)).resolves.toEqual({
			kind: 'not-found',
			reason: 'missing',
		});
	});

	it('rejects new active uses while the lease is releasing', async () => {
		let releaseClose: (() => void) | undefined;
		let markCloseStarted: (() => void) | undefined;
		const closeStarted = new Promise<void>((resolve) => {
			markCloseStarted = resolve;
		});
		const closeCanFinish = new Promise<void>((resolve) => {
			releaseClose = resolve;
		});
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: vi.fn(async () => {
					markCloseStarted?.();
					await closeCanFinish;
					return createCompleteVmDestroyReceipt('tool-vm-releasing');
				}),
			})),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		const releasePromise = leaseManager.releaseLease(lease.id);
		await closeStarted;

		expect(() =>
			leaseManager.startActiveUse(lease.id, {
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		).toThrow(LeaseActiveUseConflictError);

		releaseClose?.();
		await releasePromise;
		expect(leaseManager.peekLease(lease.id)).toBeUndefined();
	});

	it('does not release a lease that was touched after an idle reaper snapshot', async () => {
		let now = 100;
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};
		const lease = await leaseManager.createLease(request);
		now = 200;
		await leaseManager.createLease(request);

		await leaseManager.releaseLease(lease.id, { ifLastUsedAtBeforeOrAt: 150 });

		expect(closeMock).not.toHaveBeenCalled();
		await expect(leaseManager.renewLease(lease.id)).resolves.toMatchObject({
			kind: 'renewed',
			lease: { id: lease.id },
		});
	});

	it('listLeases returns all active leases across agents', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				close: vi.fn(async () => createCompleteVmDestroyReceipt('tool-vm-list')),
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({
					command: 'ssh ...',
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 19000,
					user: 'sandbox',
				})),
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				getDestroyTarget: vi.fn(() => createTestVmDestroyTarget('tool-vm-1')),
				id: 'tool-vm-1',
				setIngressRoutes: vi.fn(),
				getHostPid: () => 12345,
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 5 }),
		});

		const lease1 = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});
		const lease2 = await leaseManager.createLease({
			agentId: 'laura',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		const all = leaseManager.listLeases();
		expect(all).toHaveLength(2);
		expect(all.map((lease) => lease.id)).toContain(lease1.id);
		expect(all.map((lease) => lease.id)).toContain(lease2.id);
	});

	it('releaseLease is a no-op for non-existent lease ids', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 2 }),
		});

		// Should not throw
		await leaseManager.releaseLease('does-not-exist');

		expect(leaseManager.listLeases()).toHaveLength(0);
	});

	it('retains owner-unsafe bookkeeping when vm.close throws', async () => {
		const closeMock = vi.fn(async () => {
			throw new Error('close failed');
		});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({
					command: 'ssh ...',
					host: '127.0.0.1',
					identityFile: '/tmp/key',
					port: 19000,
					user: 'sandbox',
				})),
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				getDestroyTarget: vi.fn(() => createTestVmDestroyTarget('tool-vm-close-fail')),
				id: 'tool-vm-close-fail',
				setIngressRoutes: vi.fn(),
				getHostPid: () => 12345,
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool,
		});

		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow('close failed');
		expect(leaseManager.peekLease(lease.id)?.lease.id).toBe(lease.id);
		await expect(leaseManager.renewLease(lease.id)).rejects.toThrow(/releasing/u);
		// When close fails the QEMU may still hold the host port. The slot
		// must be quarantined — NOT re-allocatable until proven safe — to
		// prevent a same-process port collision.
		expect(tcpPool.isQuarantined(0)).toBe(true);
		expect(() => tcpPool.allocate()).toThrow('No TCP slots available');
	});

	it('releases the tcp slot when VM creation fails', async () => {
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => {
				throw new Error('vm create failed');
			}),
			now: () => 100,
			tcpPool,
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/host/agent-work',
				expectedGateway: TEST_GATEWAY_EPOCH,
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toThrow('vm create failed');

		expect(tcpPool.allocate()).toBe(0);
	});

	it('stores effective idle TTLs and rejects reuse with a mismatched requested TTL', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 100,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const request = {
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			effectiveIdleTtlMs: 60_000,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		};

		const lease = await leaseManager.createLease(request);
		const reusedLease = await leaseManager.createLease(request);

		expect(lease.effectiveIdleTtlMs).toBe(60_000);
		expect(reusedLease.id).toBe(lease.id);
		await expect(
			leaseManager.createLease({
				...request,
				effectiveIdleTtlMs: 120_000,
			}),
		).rejects.toBeInstanceOf(AgentLeaseCompatibilityConflictError);
	});

	it('tracks active uses, heartbeats, tombstones, and forced release cleanup', async () => {
		let now = 1_000;
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
			toolVmUsePolicy: {
				endedUseTombstoneTtlMs: 10_000,
				heartbeatAfterMs: 1_000,
				heartbeatStaleMs: 4_000,
			},
		});
		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			effectiveIdleTtlMs: 60_000,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});
		const unsafeCorrelation = {
			runId: 'run-123',
			sessionKey: 'raw-session-key',
			sessionKeyDigest: 'sha256:0123456789abcdef0123456789abcdef',
			toolCallId: 'tool-call-123',
			toolName: 'shell',
			traceId: '0123456789abcdef0123456789abcdef',
		} as unknown as ToolVmActiveUseCorrelation;

		const startedUse = leaseManager.startActiveUse(lease.id, {
			correlation: unsafeCorrelation,
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		const repeatedStart = leaseManager.startActiveUse(lease.id, {
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		now = 2_000;
		const heartbeat = leaseManager.heartbeatActiveUse(
			lease.id,
			'01890f00-0000-7000-8000-000000000000',
			{},
		);
		expect(leaseManager.getActiveUses(lease.id)).toEqual([
			expect.objectContaining({
				correlation: {
					runId: 'run-123',
					sessionKeyDigest: 'sha256:0123456789abcdef0123456789abcdef',
					toolCallId: 'tool-call-123',
					traceId: '0123456789abcdef0123456789abcdef',
				},
			}),
		]);
		leaseManager.endActiveUse(lease.id, '01890f00-0000-7000-8000-000000000000', {
			outcome: 'completed',
		});

		expect(startedUse).toEqual({
			expiresAt: 5_000,
			heartbeatAfterMs: 1_000,
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		expect(repeatedStart).toEqual(startedUse);
		expect(heartbeat).toEqual({ expiresAt: 6_000, heartbeatAfterMs: 1_000 });
		expect(leaseManager.getActiveUseCount(lease.id)).toBe(0);
		expect(() =>
			leaseManager.startActiveUse(lease.id, {
				useId: '01890f00-0000-7000-8000-000000000000',
			}),
		).toThrow(/already ended/u);
		expect(() =>
			leaseManager.startActiveUse(lease.id, {
				useId: '1b5c5d78-91b4-4c8e-a15e-f475dced59ef',
			}),
		).toThrow(/UUIDv7/u);

		await leaseManager.releaseLease(lease.id, { force: true });

		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(leaseManager.getActiveUseCount(lease.id)).toBe(0);
	});

	it('replaces active-use operation reports instead of accumulating report history', async () => {
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createLeaseId: () => '01890f00-0000-7000-8000-000000000004',
			createManagedVm: vi.fn(async () => createManagedVmStub()),
			now: () => 1_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});
		const lease = await leaseManager.createLease(createAgentLeaseOptions());
		leaseManager.startActiveUse(lease.id, {
			report: { observedAtMs: 1_000, phase: 'starting' },
			useId: '01890f00-0000-7000-8000-000000000000',
		});

		leaseManager.heartbeatActiveUse(lease.id, '01890f00-0000-7000-8000-000000000000', {
			report: {
				observedAtMs: 1_001,
				phase: 'failed',
				ssh: {
					failure: {
						kind: 'ssh-command-timed-out',
						message: 'SSH command exceeded 30000ms.',
					},
				},
			},
		});

		expect(leaseManager.getActiveUses(lease.id)).toEqual([
			expect.objectContaining({
				latestReport: {
					observedAtMs: 1_001,
					phase: 'failed',
					ssh: {
						failure: {
							kind: 'ssh-command-timed-out',
							message: 'SSH command exceeded 30000ms.',
						},
					},
				},
			}),
		]);
	});

	it('reaps stale active uses and expired tombstones without closing the lease', async () => {
		let now = 1_000;
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				...createManagedVmStub(),
				close: closeMock,
			})),
			now: () => now,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
			toolVmUsePolicy: {
				endedUseTombstoneTtlMs: 3_000,
				heartbeatAfterMs: 1_000,
				heartbeatStaleMs: 4_000,
			},
		});
		const lease = await leaseManager.createLease({
			agentId: 'main',
			agentWorkspaceDir: '/host/agent-work',
			expectedGateway: TEST_GATEWAY_EPOCH,
			effectiveIdleTtlMs: 60_000,
			profile: {
				cpus: 1,
				memory: '1G',
				imageProfile: 'default',
			},
			profileId: 'standard',
			guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
			hostWorkMountDir: '/host/sandbox-work',
			zoneId: 'shravan',
		});

		leaseManager.startActiveUse(lease.id, {
			useId: '01890f00-0000-7000-8000-000000000000',
		});
		leaseManager.startActiveUse(lease.id, {
			useId: '01890f00-0000-7000-8000-000000000001',
		});
		now = 2_000;
		leaseManager.heartbeatActiveUse(lease.id, '01890f00-0000-7000-8000-000000000001', {});
		now = 5_001;

		leaseManager.reapExpiredActiveUses();

		expect(leaseManager.getActiveUseCount(lease.id)).toBe(1);
		expect(closeMock).not.toHaveBeenCalled();

		leaseManager.endActiveUse(lease.id, '01890f00-0000-7000-8000-000000000001', {
			outcome: 'completed',
		});
		now = 9_000;
		leaseManager.reapExpiredActiveUses();

		expect(leaseManager.getActiveUseCount(lease.id)).toBe(0);
		expect(closeMock).not.toHaveBeenCalled();
	});

	it('closes the VM and releases the tcp slot when enabling SSH fails', async () => {
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => {
					throw new Error('ssh setup failed');
				}),
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				getDestroyTarget: vi.fn(() => createTestVmDestroyTarget('tool-vm-ssh-fail')),
				id: 'tool-vm-ssh-fail',
				setIngressRoutes: vi.fn(),
				getHostPid: () => 12345,
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool,
		});

		await expect(
			leaseManager.createLease({
				agentId: 'main',
				agentWorkspaceDir: '/host/agent-work',
				expectedGateway: TEST_GATEWAY_EPOCH,
				profile: {
					cpus: 1,
					memory: '1G',
					imageProfile: 'default',
				},
				profileId: 'standard',
				guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
				hostWorkMountDir: '/host/sandbox-work',
				zoneId: 'shravan',
			}),
		).rejects.toThrow('ssh setup failed');

		expect(closeMock).toHaveBeenCalledTimes(1);
		expect(tcpPool.allocate()).toBe(0);
	});

	it('logs rollback close failures when enabling SSH fails', async () => {
		const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		const closeMock = vi.fn(async () => {
			throw new Error('rollback close failed');
		});
		const tcpPool = createTcpPool({ basePort: 19000, size: 1 });
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => ({
				close: closeMock,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => {
					throw new Error('ssh setup failed');
				}),
				exec: vi.fn(() => createManagedExecProcessStub()),
				fs: createManagedVmFsStub(),
				getDestroyTarget: vi.fn(() => createTestVmDestroyTarget('tool-vm-ssh-fail-close-fail')),
				id: 'tool-vm-ssh-fail-close-fail',
				setIngressRoutes: vi.fn(),
				getHostPid: () => 12345,
				getVmInstance: vi.fn(),
			})),
			now: () => 100,
			tcpPool,
		});

		try {
			let createError: unknown;
			try {
				await leaseManager.createLease({
					agentId: 'main',
					agentWorkspaceDir: '/host/agent-work',
					expectedGateway: TEST_GATEWAY_EPOCH,
					profile: {
						cpus: 1,
						memory: '1G',
						imageProfile: 'default',
					},
					profileId: 'standard',
					guestWorkdir: OPENCLAW_TOOL_VM_WORKSPACE_MOUNT,
					hostWorkMountDir: '/host/sandbox-work',
					zoneId: 'shravan',
				});
			} catch (error) {
				createError = error;
			}
			expect(createError).toBeInstanceOf(AggregateError);
			expect((createError as AggregateError).errors).toEqual([
				expect.objectContaining({ message: 'ssh setup failed' }),
				expect.objectContaining({ message: 'rollback close failed' }),
			]);

			expect(closeMock).toHaveBeenCalledTimes(1);
			// VM created but close failed → slot must be quarantined, not freed,
			// because the QEMU may still hold the host port.
			expect(tcpPool.isQuarantined(0)).toBe(true);
			expect(() => tcpPool.allocate()).toThrow('No TCP slots available');
			const loggedMessages = stderrWrite.mock.calls.map(([message]) => String(message));
			expect(
				loggedMessages.some((message) =>
					message.includes(
						"failed to close partially-created lease VM for zone 'shravan' agent 'main'",
					),
				),
			).toBe(true);
		} finally {
			stderrWrite.mockRestore();
		}
	});
});

describe('createLeaseManager — runtime record disk integration', () => {
	const createdDirectories: string[] = [];
	afterEach(() => {
		for (const directoryPath of createdDirectories.splice(0)) {
			fs.rmSync(directoryPath, { force: true, recursive: true });
		}
	});

	function createTempStateDir(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-lease-mgr-fs-'));
		createdDirectories.push(dir);
		return dir;
	}

	function makeIntegrationManagedVm(): ManagedVm & { closeMock: ReturnType<typeof vi.fn> } {
		const closeMock = vi.fn(async () => createCompleteVmDestroyReceipt());
		return {
			close: closeMock,
			enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
			enableSsh: vi.fn(async () => ({
				command: 'ssh ...',
				host: '127.0.0.1',
				identityFile: '/tmp/key',
				port: 19000,
				user: 'sandbox',
			})),
			exec: vi.fn(() => createManagedExecProcessStub()),
			fs: createManagedVmFsStub(),
			getDestroyTarget: vi.fn(() => createTestVmDestroyTarget('tool-vm-integration')),
			id: 'tool-vm-integration',
			setIngressRoutes: vi.fn(),
			getHostPid: () => 31337,
			getVmInstance: vi.fn(),
			closeMock,
		} satisfies ManagedVm & { closeMock: ReturnType<typeof vi.fn> };
	}

	const integrationLeaseRequest = {
		agentId: 'main',
		agentWorkspaceDir: '/home/openclaw/work',
		expectedGateway: TEST_GATEWAY_EPOCH,
		profile: { cpus: 1, memory: '1G', imageProfile: 'default' as const },
		profileId: 'standard' as const,
		guestWorkdir: '/work',
		hostWorkMountDir: '/home/openclaw/.openclaw/state/sandboxes/integration/work',
		zoneId: 'shravan',
	};

	it('createLease writes a real file to $stateDir/tool-leases/ and releaseLease deletes it on success', async () => {
		const stateDir = createTempStateDir();
		const vm = makeIntegrationManagedVm();
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => vm),
			createRuntimeRecordId: () => '01890f00-0000-7000-8000-000000000001',
			// override the no-op defaults with the real fs writers
			deleteToolVmRuntimeRecord,
			writeToolVmRuntimeRecord,
			stateDirFor: () => stateDir,
			now: () => 1_700_000_000_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});

		const lease = await leaseManager.createLease(integrationLeaseRequest);
		const recordPath = path.join(stateDir, 'tool-leases', `${lease.runtimeRecordId}.json`);
		expect(fs.existsSync(recordPath)).toBe(true);
		const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			agentId: 'main',
			configPath: '/etc/agent-vm/system.json',
			controllerPort: 18800,
			gateway: {
				sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			},
			leaseId: lease.id,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 31337,
			recordId: '01890f00-0000-7000-8000-000000000001',
			schemaVersion: 1,
			tcpSlot: 0,
			vmId: 'tool-vm-integration',
			zoneId: 'shravan',
		});
		expect(parsed).not.toHaveProperty('scopeKey');

		await leaseManager.releaseLease(lease.id);
		expect(fs.existsSync(recordPath)).toBe(false);
	});

	it('releaseLease preserves the record on disk when vm.close() throws', async () => {
		const stateDir = createTempStateDir();
		const vm = makeIntegrationManagedVm();
		vm.closeMock.mockRejectedValueOnce(new Error('close hung'));
		const leaseManager = createLeaseManager({
			...defaultRuntimeRecordOptions,
			createManagedVm: vi.fn(async () => vm),
			createRuntimeRecordId: () => '01890f00-0000-7000-8000-000000000002',
			deleteToolVmRuntimeRecord,
			writeToolVmRuntimeRecord,
			stateDirFor: () => stateDir,
			now: () => 1_700_000_000_000,
			tcpPool: createTcpPool({ basePort: 19000, size: 1 }),
		});

		const lease = await leaseManager.createLease(integrationLeaseRequest);
		const recordPath = path.join(stateDir, 'tool-leases', `${lease.runtimeRecordId}.json`);
		expect(fs.existsSync(recordPath)).toBe(true);

		await expect(leaseManager.releaseLease(lease.id)).rejects.toThrow(/close hung/u);
		// Critical invariant: record must remain so the next controller startup's
		// Phase A cleanup can scope-fence + signal the orphan QEMU.
		expect(fs.existsSync(recordPath)).toBe(true);
	});
});
