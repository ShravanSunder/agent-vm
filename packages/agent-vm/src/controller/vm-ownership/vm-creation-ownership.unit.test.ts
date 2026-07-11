import path from 'node:path';

import type {
	CreatedManagedVmOwnershipReservation,
	CreateManagedVmOwnershipReservationOptions,
	ManagedVmDestroyReceiptV1,
	ManagedVmDestroyTargetV1,
	ManagedVmOwnershipReservationReferenceV1,
} from '@agent-vm/gondolin-adapter';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	IncompleteVmDestructionError,
	VmDestructionReceiptMismatchError,
} from '../../shared/vm-destruction-receipt.js';
import {
	createCompleteVmDestroyReceipt,
	createTestVmDestroyTarget,
} from '../../testing/managed-vm-test-helpers.js';
import {
	GATEWAY_DESTRUCTION_TARGET_TIMEOUT_MS,
	GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS,
} from './gateway-destruction-budget.js';
import type {
	GatewayOwnershipCoordinator,
	GatewayOwnershipEpochHandle,
} from './gateway-ownership-coordinator.js';
import {
	createGatewayVmCreationOwnership,
	createStandaloneVmCreationOwnership,
} from './vm-creation-ownership.js';
import type {
	GatewayEpochIdentity,
	VmOwnershipDeploymentIdentity,
} from './vm-ownership-contracts.js';

const TEST_DEPLOYMENT_IDENTITY = {
	configPath: '/deployments/sunfam/config/system.jsonc',
	controllerPort: 18_800,
	projectNamespace: 'sunfam-test-deployment',
} satisfies VmOwnershipDeploymentIdentity;

const GATEWAY_IDENTITY = {
	bootId: 'control-boot-a',
	controllerEpoch: 'controller-epoch-a',
	gatewayEpochId: 'gateway-epoch-a',
	gatewayVmId: 'gateway-vm-a',
	generationId: 'control-generation-a',
	zoneId: 'sunfam',
} satisfies GatewayEpochIdentity;

const GATEWAY_RESERVATION = {
	expectedContractVersion: 1,
	expectedRevision: 1,
	reservationId: 'gateway-reservation-a',
	reservationPath:
		'/state/sunfam/vm-ownership/reservations/gateway-reservation-a/reservation-v1.json',
} satisfies ManagedVmOwnershipReservationReferenceV1;

afterEach(() => {
	vi.useRealTimers();
});

interface DeferredCompletion {
	readonly promise: Promise<void>;
	resolve(): void;
}

interface DeferredResult<TResult> {
	readonly promise: Promise<TResult>;
	reject(error: unknown): void;
	resolve(result: TResult): void;
}

interface PendingGatewayCreationContainmentPort {
	containPendingCreate<TResult>(options: {
		readonly closeLateCreatedVm: (lateCreatedVm: TResult) => Promise<ManagedVmDestroyReceiptV1>;
		readonly pendingCreate: Promise<TResult>;
	}): Promise<ManagedVmDestroyReceiptV1>;
}

interface PendingGatewayDetachedDestroyAttemptPort {
	attemptGatewayDetachedDestroy(
		expectedGateway: GatewayEpochIdentity,
	): Promise<ManagedVmDestroyReceiptV1>;
}

function createDeferredCompletion(): DeferredCompletion {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(): void {
			resolvePromise?.();
		},
	};
}

function createDeferredResult<TResult>(): DeferredResult<TResult> {
	let rejectPromise: ((error: unknown) => void) | undefined;
	let resolvePromise: ((result: TResult) => void) | undefined;
	const promise = new Promise<TResult>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	return {
		promise,
		reject(error): void {
			rejectPromise?.(error);
		},
		resolve(result): void {
			resolvePromise?.(result);
		},
	};
}

function isPendingCreateContainmentPort(
	ownership: unknown,
): ownership is PendingGatewayCreationContainmentPort {
	return typeof ownership !== 'object' || ownership === null
		? false
		: 'containPendingCreate' in ownership && typeof ownership.containPendingCreate === 'function';
}

function requirePendingCreateContainment(
	ownership: unknown,
): PendingGatewayCreationContainmentPort {
	if (!isPendingCreateContainmentPort(ownership)) {
		throw new Error('Gateway VM creation ownership must expose containPendingCreate().');
	}
	return ownership;
}

async function promiseSettled(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.finally(() => {
		settled = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	return settled;
}

function createGatewayCoordinatorStub(
	options: {
		readonly attemptGatewayDetachedDestroy?: (
			expectedGateway: GatewayEpochIdentity,
		) => Promise<ManagedVmDestroyReceiptV1>;
		readonly callOrder?: string[];
		readonly gatewayHandle?: GatewayOwnershipEpochHandle;
		readonly membershipBarrier?: Promise<void>;
		readonly recordGatewayDestroyReceipt?: (
			expectedGateway: GatewayEpochIdentity,
			receipt: ManagedVmDestroyReceiptV1,
		) => Promise<void>;
		readonly recordGatewayDestroyUnavailable?: (
			expectedGateway: GatewayEpochIdentity,
		) => Promise<void>;
	} = {},
): GatewayOwnershipCoordinator & PendingGatewayDetachedDestroyAttemptPort {
	const gatewayHandle = options.gatewayHandle ?? {
		gatewayIdentity: GATEWAY_IDENTITY,
		ownershipReservation: GATEWAY_RESERVATION,
	};
	return {
		admitProvisionalToolVm(): never {
			throw new Error('not used by VM creation ownership tests');
		},
		beginGatewayEpoch: vi.fn(async (): Promise<GatewayOwnershipEpochHandle> => {
			options.callOrder?.push('begin-gateway');
			return gatewayHandle;
		}),
		attemptGatewayDetachedDestroy: vi.fn(
			async (expectedGateway): Promise<ManagedVmDestroyReceiptV1> => {
				options.callOrder?.push('attempt-gateway-detached');
				return options.attemptGatewayDetachedDestroy === undefined
					? createGatewayAlreadyAbsentReceipt()
					: await options.attemptGatewayDetachedDestroy(expectedGateway);
			},
		),
		destroyGatewayDetached: vi.fn(async (): Promise<ManagedVmDestroyReceiptV1> => {
			options.callOrder?.push('destroy-gateway-detached');
			return createGatewayReceipt();
		}),
		recordGatewayDestroyReceipt: vi.fn(async (expectedGateway, receipt): Promise<void> => {
			options.callOrder?.push('record-gateway-receipt');
			await options.recordGatewayDestroyReceipt?.(expectedGateway, receipt);
		}),
		recordGatewayDestroyUnavailable: vi.fn(async (expectedGateway): Promise<void> => {
			options.callOrder?.push('record-gateway-owner-unsafe');
			await options.recordGatewayDestroyUnavailable?.(expectedGateway);
		}),
		reconcileControllerStartup: vi.fn(async (): Promise<void> => {}),
		resolveGatewayEpoch(): GatewayEpochIdentity {
			return GATEWAY_IDENTITY;
		},
		sealGatewayEpoch: vi.fn(() => {
			options.callOrder?.push('seal-gateway');
			return {
				barrier: (options.membershipBarrier ?? Promise.resolve()).then(() => ({
					gatewayEpochId: GATEWAY_IDENTITY.gatewayEpochId,
					kind: 'children-destroyed' as const,
				})),
				childReservationIds: [],
			};
		}),
	};
}

function createGatewayReceipt(): ManagedVmDestroyReceiptV1 {
	return createCompleteVmDestroyReceipt(GATEWAY_IDENTITY.gatewayVmId, {
		controllerEpoch: GATEWAY_IDENTITY.controllerEpoch,
		reservationId: GATEWAY_RESERVATION.reservationId,
		role: 'gateway',
	});
}

function createGatewayAlreadyAbsentReceipt(): ManagedVmDestroyReceiptV1 {
	return {
		...createGatewayReceipt(),
		resources: {
			disposableStorage: { status: 'already-absent' },
			exactRunner: { status: 'already-absent' },
			ingressListener: { status: 'already-absent' },
			ingressSockets: { status: 'already-absent' },
			qmp: { status: 'already-absent' },
			sessionIpc: { status: 'already-absent' },
			sshListener: { status: 'already-absent' },
			sshSessions: { status: 'already-absent' },
		},
	};
}

function createMatchingReceipt(target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 {
	const executableName = path.basename(target.runner.executable);
	return {
		...createCompleteVmDestroyReceipt(target.vmId, {
			controllerEpoch: target.controllerEpoch,
			parentGateway: target.parentGateway,
			reservationId: target.reservationId,
			role: target.role,
		}),
		requestedRunner: {
			backend: target.runner.backend,
			discoveryIdentity: target.runner.discoveryIdentity,
			executableName,
			...(target.runner.pid === undefined ? {} : { pid: target.runner.pid }),
			...(target.runner.startCookie === undefined
				? {}
				: { startCookie: target.runner.startCookie }),
		},
	};
}

function createStandaloneReservation(
	options: CreateManagedVmOwnershipReservationOptions,
): CreatedManagedVmOwnershipReservation {
	const target = {
		...createTestVmDestroyTarget(options.vmId, {
			controllerEpoch: options.controllerEpoch,
			reservationId: options.reservationId,
			role: 'standalone',
		}),
		...(options.principal === undefined ? {} : { principal: options.principal }),
		sessionLabel: options.sessionLabel,
	};
	const reservationPath = target.reservationPath;
	const reservationDirectory = path.dirname(reservationPath);
	return {
		reference: {
			expectedContractVersion: 1,
			expectedRevision: 1,
			reservationId: options.reservationId,
			reservationPath,
		},
		reservation: {
			contractVersion: 1,
			controllerEpoch: options.controllerEpoch,
			createdAt: '2026-07-10T00:00:00.000Z',
			discoveryKey: `discovery-${options.vmId}`,
			ownerProcess: target.ownerProcess,
			parentGateway: null,
			...(options.principal === undefined ? {} : { principal: options.principal }),
			reservationId: options.reservationId,
			resources: target.resources,
			revision: 1,
			role: 'standalone',
			runner: target.runner,
			sessionLabel: options.sessionLabel,
			state: 'reserved',
			vmId: options.vmId,
		},
		reservationDirectory,
		reservationPath,
		target,
	};
}

function standaloneOptions(
	overrides: {
		readonly createManagedVmOwnershipReservation?: (
			options: CreateManagedVmOwnershipReservationOptions,
		) => Promise<CreatedManagedVmOwnershipReservation>;
		readonly destroyManagedVmExact?: (
			target: ManagedVmDestroyTargetV1,
		) => Promise<ManagedVmDestroyReceiptV1>;
		readonly readManagedVmDestroyTarget?: (
			reservationPath: string,
		) => Promise<ManagedVmDestroyTargetV1>;
	} = {},
): Parameters<typeof createStandaloneVmCreationOwnership>[0] {
	return {
		controllerEpoch: 'controller-epoch-worker',
		createId: () => 'worker-task-a',
		principal: {
			...TEST_DEPLOYMENT_IDENTITY,
			kind: 'worker-task',
			taskId: 'task-a',
			zoneId: 'sunfam',
		},
		reservationRoot: '/state/sunfam/vm-ownership/reservations',
		sessionLabel: 'worker-task:task-a',
		...overrides,
	};
}

describe('Gateway VM creation ownership', () => {
	it('begins ownership with the exact control boot and generation identity', async () => {
		const ownershipCoordinator = createGatewayCoordinatorStub();

		const ownership = await createGatewayVmCreationOwnership({
			bootId: GATEWAY_IDENTITY.bootId,
			destroyGatewayOwnedLeases: async () => {},
			generationId: GATEWAY_IDENTITY.generationId,
			ownershipCoordinator,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});

		// oxlint-disable-next-line typescript/unbound-method -- Coordinator test doubles are Vitest arrow-function mocks without a this binding.
		expect(ownershipCoordinator.beginGatewayEpoch).toHaveBeenCalledWith({
			bootId: GATEWAY_IDENTITY.bootId,
			generationId: GATEWAY_IDENTITY.generationId,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});
		expect(ownership.gatewayIdentity).toEqual(GATEWAY_IDENTITY);
		expect(ownership.ownershipReservation).toBe(GATEWAY_RESERVATION);
	});

	it('seals synchronously, destroys exact-G children, awaits their barrier, then closes and records the Gateway', async () => {
		const callOrder: string[] = [];
		const membershipBarrier = createDeferredCompletion();
		const ownershipCoordinator = createGatewayCoordinatorStub({
			callOrder,
			membershipBarrier: membershipBarrier.promise,
		});
		const destroyGatewayOwnedLeases = vi.fn(
			async (gatewayIdentity: GatewayEpochIdentity): Promise<void> => {
				callOrder.push(`destroy-children:${gatewayIdentity.gatewayEpochId}`);
			},
		);
		const closeLiveVm = vi.fn(async (): Promise<ManagedVmDestroyReceiptV1> => {
			callOrder.push('close-gateway');
			return createGatewayReceipt();
		});
		const ownership = await createGatewayVmCreationOwnership({
			bootId: GATEWAY_IDENTITY.bootId,
			destroyGatewayOwnedLeases,
			generationId: GATEWAY_IDENTITY.generationId,
			ownershipCoordinator,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});
		callOrder.length = 0;

		const destruction = ownership.destroyLive(closeLiveVm);
		await Promise.resolve();

		expect(callOrder).toEqual([
			'seal-gateway',
			`destroy-children:${GATEWAY_IDENTITY.gatewayEpochId}`,
		]);
		expect(destroyGatewayOwnedLeases).toHaveBeenCalledWith(
			GATEWAY_IDENTITY,
			expect.any(AbortSignal),
		);
		expect(closeLiveVm).not.toHaveBeenCalled();

		membershipBarrier.resolve();
		await expect(destruction).resolves.toEqual(createGatewayReceipt());
		expect(callOrder).toEqual([
			'seal-gateway',
			`destroy-children:${GATEWAY_IDENTITY.gatewayEpochId}`,
			'close-gateway',
			'record-gateway-receipt',
		]);
		// oxlint-disable-next-line typescript/unbound-method -- Coordinator test doubles are Vitest arrow-function mocks without a this binding.
		expect(ownershipCoordinator.recordGatewayDestroyReceipt).toHaveBeenCalledWith(
			GATEWAY_IDENTITY,
			createGatewayReceipt(),
		);
	});

	it('forbids Gateway close when exact-G child destruction fails', async () => {
		const childFailure = new Error('Tool VM destruction remained incomplete');
		const ownerUnsafeFailure = Object.assign(
			new Error('Gateway ownership could not be durably marked unavailable'),
			{ code: 'owner-unsafe' as const },
		);
		const ownershipCoordinator = createGatewayCoordinatorStub({
			async recordGatewayDestroyUnavailable(): Promise<void> {
				throw ownerUnsafeFailure;
			},
		});
		const closeLiveVm = vi.fn(
			async (): Promise<ManagedVmDestroyReceiptV1> => createGatewayReceipt(),
		);
		const ownership = await createGatewayVmCreationOwnership({
			bootId: GATEWAY_IDENTITY.bootId,
			destroyGatewayOwnedLeases: async () => {
				throw childFailure;
			},
			generationId: GATEWAY_IDENTITY.generationId,
			ownershipCoordinator,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});

		const destructionError = await ownership
			.destroyLive(closeLiveVm)
			.catch((error: unknown) => error);

		expect(destructionError).toBeInstanceOf(AggregateError);
		expect(destructionError).toMatchObject({
			cause: childFailure,
			errors: [
				childFailure,
				expect.objectContaining({ code: 'owner-unsafe', cause: ownerUnsafeFailure }),
			],
		});
		expect(closeLiveVm).not.toHaveBeenCalled();
		// oxlint-disable-next-line typescript/unbound-method -- Coordinator test doubles are Vitest arrow-function mocks without a this binding.
		expect(ownershipCoordinator.recordGatewayDestroyReceipt).not.toHaveBeenCalled();
		// oxlint-disable-next-line typescript/unbound-method -- Coordinator test doubles are Vitest arrow-function mocks without a this binding.
		expect(ownershipCoordinator.recordGatewayDestroyUnavailable).toHaveBeenCalledWith(
			GATEWAY_IDENTITY,
		);
	});

	it('allows five child targets in two waves to finish after 60 seconds but before the subtree deadline', async () => {
		// Arrange
		vi.useFakeTimers();
		const targetIds = ['tool-a', 'tool-b', 'tool-c', 'tool-d', 'tool-e'] as const;
		const startedTargetIds: string[] = [];
		const completedTargetIds: string[] = [];
		const ownershipCoordinator = createGatewayCoordinatorStub();
		const runWave = async (waveTargetIds: readonly string[]): Promise<void> => {
			await Promise.all(
				waveTargetIds.map(
					(targetId) =>
						new Promise<void>((resolve) => {
							startedTargetIds.push(targetId);
							setTimeout(() => {
								completedTargetIds.push(targetId);
								resolve();
							}, 50_000);
						}),
				),
			);
		};
		const destroyGatewayOwnedLeases = vi.fn(
			async (_gatewayIdentity: GatewayEpochIdentity, signal: AbortSignal): Promise<void> => {
				expect(signal.aborted).toBe(false);
				await runWave(targetIds.slice(0, 4));
				await runWave(targetIds.slice(4));
			},
		);
		const closeLiveVm = vi.fn(async () => createGatewayReceipt());
		const ownership = await createGatewayVmCreationOwnership({
			bootId: GATEWAY_IDENTITY.bootId,
			destroyGatewayOwnedLeases,
			generationId: GATEWAY_IDENTITY.generationId,
			ownershipCoordinator,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});

		// Act
		const destruction = ownership.destroyLive(closeLiveVm);
		await vi.advanceTimersByTimeAsync(50_000);

		// Assert
		expect(startedTargetIds).toEqual(targetIds);
		expect(completedTargetIds).toEqual(targetIds.slice(0, 4));
		expect(closeLiveVm).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(50_000);
		await expect(destruction).resolves.toEqual(createGatewayReceipt());
		expect(completedTargetIds).toEqual(targetIds);
		expect(closeLiveVm).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(100_000).toBeGreaterThan(GATEWAY_DESTRUCTION_TARGET_TIMEOUT_MS);
		expect(100_000).toBeLessThan(GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS);
	});

	it('aborts the whole subtree at 300 seconds and never closes or completes the Gateway late', async () => {
		// Arrange
		vi.useFakeTimers();
		const ownerUnsafeFailure = Object.assign(
			new Error('Gateway ownership could not be durably marked unavailable'),
			{ code: 'owner-unsafe' as const },
		);
		const ownershipCoordinator = createGatewayCoordinatorStub({
			async recordGatewayDestroyUnavailable(): Promise<void> {
				throw ownerUnsafeFailure;
			},
		});
		let observedSignal: AbortSignal | undefined;
		const destroyGatewayOwnedLeases = vi.fn(
			async (_gatewayIdentity: GatewayEpochIdentity, signal: AbortSignal): Promise<void> => {
				observedSignal = signal;
				await new Promise<void>((resolve) => {
					signal.addEventListener('abort', () => resolve(), { once: true });
				});
			},
		);
		const closeLiveVm = vi.fn(async () => createGatewayReceipt());
		const ownership = await createGatewayVmCreationOwnership({
			bootId: GATEWAY_IDENTITY.bootId,
			destroyGatewayOwnedLeases,
			generationId: GATEWAY_IDENTITY.generationId,
			ownershipCoordinator,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});
		const destruction = ownership.destroyLive(closeLiveVm);
		const destructionError = destruction.catch((error: unknown) => error);
		await Promise.resolve();

		// Act
		await vi.advanceTimersByTimeAsync(GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS);

		// Assert
		const observedDestructionError = await destructionError;
		expect(observedDestructionError).toBeInstanceOf(AggregateError);
		expect(observedDestructionError).toMatchObject({
			cause: {
				code: 'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
				timeoutMs: GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS,
			},
			errors: [
				{
					code: 'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
					timeoutMs: GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS,
				},
				expect.objectContaining({ code: 'owner-unsafe', cause: ownerUnsafeFailure }),
			],
		});
		expect(observedSignal?.aborted).toBe(true);
		expect(closeLiveVm).not.toHaveBeenCalled();
		// oxlint-disable-next-line typescript/unbound-method -- Coordinator test doubles are Vitest arrow-function mocks without a this binding.
		expect(ownershipCoordinator.recordGatewayDestroyReceipt).not.toHaveBeenCalled();
		// oxlint-disable-next-line typescript/unbound-method -- Coordinator test doubles are Vitest arrow-function mocks without a this binding.
		expect(ownershipCoordinator.recordGatewayDestroyUnavailable).toHaveBeenCalledWith(
			GATEWAY_IDENTITY,
		);
		// oxlint-disable-next-line typescript/unbound-method -- The seal mock is an arrow-function mock without a this binding.
		expect(ownershipCoordinator.sealGatewayEpoch).toHaveBeenCalledOnce();
		await Promise.resolve();
		await Promise.resolve();
		expect(closeLiveVm).not.toHaveBeenCalled();
		// oxlint-disable-next-line typescript/unbound-method -- Coordinator test doubles are Vitest arrow-function mocks without a this binding.
		expect(ownershipCoordinator.recordGatewayDestroyReceipt).not.toHaveBeenCalled();
	});

	it('records Gateway ownership as unsafe when the live close throws', async () => {
		const closeFailure = new Error('Gateway runner close failed');
		const ownershipCoordinator = createGatewayCoordinatorStub();
		const ownership = await createGatewayVmCreationOwnership({
			bootId: GATEWAY_IDENTITY.bootId,
			destroyGatewayOwnedLeases: async () => {},
			generationId: GATEWAY_IDENTITY.generationId,
			ownershipCoordinator,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});

		await expect(
			ownership.destroyLive(async () => {
				throw closeFailure;
			}),
		).rejects.toMatchObject({
			cause: closeFailure,
			errors: [closeFailure, expect.objectContaining({ code: 'owner-unsafe' })],
		});
		// oxlint-disable-next-line typescript/unbound-method -- Coordinator test doubles are Vitest arrow-function mocks without a this binding.
		expect(ownershipCoordinator.recordGatewayDestroyUnavailable).toHaveBeenCalledWith(
			GATEWAY_IDENTITY,
		);
		// oxlint-disable-next-line typescript/unbound-method -- Coordinator test doubles are Vitest arrow-function mocks without a this binding.
		expect(ownershipCoordinator.recordGatewayDestroyReceipt).not.toHaveBeenCalled();
	});

	it('preserves both close and owner-unsafe recording failures as causality', async () => {
		const closeFailure = new Error('Gateway runner close failed');
		const recordFailure = new Error('ownership journal unavailable');
		const ownershipCoordinator = createGatewayCoordinatorStub();
		// oxlint-disable-next-line typescript/unbound-method -- Coordinator test doubles are Vitest arrow-function mocks without a this binding.
		vi.mocked(ownershipCoordinator.recordGatewayDestroyUnavailable).mockRejectedValueOnce(
			recordFailure,
		);
		const ownership = await createGatewayVmCreationOwnership({
			bootId: GATEWAY_IDENTITY.bootId,
			destroyGatewayOwnedLeases: async () => {},
			generationId: GATEWAY_IDENTITY.generationId,
			ownershipCoordinator,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});

		const destruction = ownership.destroyLive(async () => {
			throw closeFailure;
		});

		await expect(destruction).rejects.toMatchObject({
			cause: closeFailure,
			errors: [
				closeFailure,
				expect.objectContaining({ code: 'owner-unsafe', cause: recordFailure }),
			],
		});
	});

	it('starts exact detached containment before a pending Gateway create settles and final-retires only after closing the late success', async () => {
		// Arrange
		const callOrder: string[] = [];
		const childDestructionStarted = createDeferredCompletion();
		const detachedAttemptStarted = createDeferredCompletion();
		const membershipBarrier = createDeferredCompletion();
		const pendingCreate = createDeferredResult<{ readonly createdVmId: string }>();
		const ownershipCoordinator = createGatewayCoordinatorStub({
			async attemptGatewayDetachedDestroy(): Promise<ManagedVmDestroyReceiptV1> {
				detachedAttemptStarted.resolve();
				return createGatewayAlreadyAbsentReceipt();
			},
			callOrder,
			membershipBarrier: membershipBarrier.promise,
		});
		const ownership = await createGatewayVmCreationOwnership({
			bootId: GATEWAY_IDENTITY.bootId,
			destroyGatewayOwnedLeases: async (): Promise<void> => {
				callOrder.push('destroy-children');
				childDestructionStarted.resolve();
			},
			generationId: GATEWAY_IDENTITY.generationId,
			ownershipCoordinator,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});
		callOrder.length = 0;
		const closeLateCreatedVm = vi.fn(async (lateCreatedVm: { readonly createdVmId: string }) => {
			callOrder.push(`close-late:${lateCreatedVm.createdVmId}`);
			return createGatewayReceipt();
		});

		// Act
		const containment = requirePendingCreateContainment(ownership).containPendingCreate({
			closeLateCreatedVm,
			pendingCreate: pendingCreate.promise,
		});
		await childDestructionStarted.promise;

		// Assert
		expect(callOrder).toEqual(['seal-gateway', 'destroy-children']);
		expect(closeLateCreatedVm).not.toHaveBeenCalled();
		membershipBarrier.resolve();
		await detachedAttemptStarted.promise;
		expect(callOrder).toEqual(['seal-gateway', 'destroy-children', 'attempt-gateway-detached']);
		expect(await promiseSettled(containment)).toBe(false);
		// An early exact "already absent" receipt cannot retire G while create is pending.
		expect(callOrder).not.toContain('record-gateway-receipt');

		pendingCreate.resolve({ createdVmId: 'late-gateway-vm' });
		await expect(containment).resolves.toEqual(createGatewayReceipt());
		expect(closeLateCreatedVm).toHaveBeenCalledWith({ createdVmId: 'late-gateway-vm' });
		expect(callOrder).toEqual([
			'seal-gateway',
			'destroy-children',
			'attempt-gateway-detached',
			'close-late:late-gateway-vm',
			'record-gateway-receipt',
		]);
	});

	it('retries exact detached destruction after a pending Gateway create rejects and final-retires from that post-settlement receipt', async () => {
		// Arrange
		const callOrder: string[] = [];
		const firstDetachedAttemptStarted = createDeferredCompletion();
		let detachedAttemptCount = 0;
		const pendingCreate = createDeferredResult<{ readonly createdVmId: string }>();
		const ownershipCoordinator = createGatewayCoordinatorStub({
			async attemptGatewayDetachedDestroy(): Promise<ManagedVmDestroyReceiptV1> {
				detachedAttemptCount += 1;
				if (detachedAttemptCount === 1) {
					firstDetachedAttemptStarted.resolve();
				}
				return createGatewayAlreadyAbsentReceipt();
			},
			callOrder,
		});
		const ownership = await createGatewayVmCreationOwnership({
			bootId: GATEWAY_IDENTITY.bootId,
			destroyGatewayOwnedLeases: async (): Promise<void> => {
				callOrder.push('destroy-children');
			},
			generationId: GATEWAY_IDENTITY.generationId,
			ownershipCoordinator,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});
		callOrder.length = 0;
		const closeLateCreatedVm = vi.fn(async () => createGatewayReceipt());
		const containment = requirePendingCreateContainment(ownership).containPendingCreate({
			closeLateCreatedVm,
			pendingCreate: pendingCreate.promise,
		});
		await firstDetachedAttemptStarted.promise;
		expect(callOrder).toEqual(['seal-gateway', 'destroy-children', 'attempt-gateway-detached']);

		// Act
		pendingCreate.reject(new Error('Gateway create rejected after its caller timed out'));

		// Assert
		await expect(containment).resolves.toEqual(createGatewayAlreadyAbsentReceipt());
		expect(closeLateCreatedVm).not.toHaveBeenCalled();
		expect(callOrder).toEqual([
			'seal-gateway',
			'destroy-children',
			'attempt-gateway-detached',
			'attempt-gateway-detached',
			'record-gateway-receipt',
		]);
	});

	it('records owner-unsafe on containment-budget expiry but still closes a later Gateway create success without rehabilitating the epoch', async () => {
		// Arrange
		vi.useFakeTimers();
		const callOrder: string[] = [];
		const detachedAttemptStarted = createDeferredCompletion();
		const finalReceiptRecordAttempted = createDeferredCompletion();
		const lateCloseStarted = createDeferredCompletion();
		const pendingCreate = createDeferredResult<{ readonly createdVmId: string }>();
		const ownerUnsafeError = Object.assign(new Error('Gateway owner is unsafe'), {
			code: 'owner-unsafe' as const,
		});
		let ownerUnsafe = false;
		const ownershipCoordinator = createGatewayCoordinatorStub({
			async attemptGatewayDetachedDestroy(): Promise<ManagedVmDestroyReceiptV1> {
				detachedAttemptStarted.resolve();
				return createGatewayAlreadyAbsentReceipt();
			},
			callOrder,
			async recordGatewayDestroyReceipt(): Promise<void> {
				finalReceiptRecordAttempted.resolve();
				if (ownerUnsafe) {
					throw ownerUnsafeError;
				}
			},
			async recordGatewayDestroyUnavailable(): Promise<void> {
				ownerUnsafe = true;
				throw ownerUnsafeError;
			},
		});
		const ownership = await createGatewayVmCreationOwnership({
			bootId: GATEWAY_IDENTITY.bootId,
			destroyGatewayOwnedLeases: async (): Promise<void> => {
				callOrder.push('destroy-children');
			},
			generationId: GATEWAY_IDENTITY.generationId,
			ownershipCoordinator,
			sessionLabel: 'gateway:sunfam',
			zoneId: GATEWAY_IDENTITY.zoneId,
		});
		callOrder.length = 0;
		const closeLateCreatedVm = vi.fn(async (lateCreatedVm: { readonly createdVmId: string }) => {
			callOrder.push(`close-late:${lateCreatedVm.createdVmId}`);
			lateCloseStarted.resolve();
			return createGatewayReceipt();
		});
		const containment = requirePendingCreateContainment(ownership).containPendingCreate({
			closeLateCreatedVm,
			pendingCreate: pendingCreate.promise,
		});
		void containment.catch(() => {});
		await detachedAttemptStarted.promise;
		expect(callOrder).toEqual(['seal-gateway', 'destroy-children', 'attempt-gateway-detached']);

		// Act
		await vi.advanceTimersByTimeAsync(GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS);

		// Assert
		await expect(containment).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof AggregateError &&
				error.errors.some(
					(nestedError) =>
						typeof nestedError === 'object' &&
						nestedError !== null &&
						'code' in nestedError &&
						nestedError.code === 'owner-unsafe',
				),
		);
		expect(ownerUnsafe).toBe(true);
		expect(callOrder).toContain('record-gateway-owner-unsafe');
		pendingCreate.resolve({ createdVmId: 'late-after-budget-gateway-vm' });
		await lateCloseStarted.promise;
		await finalReceiptRecordAttempted.promise;
		expect(closeLateCreatedVm).toHaveBeenCalledWith({
			createdVmId: 'late-after-budget-gateway-vm',
		});
		expect(callOrder).toContain('record-gateway-receipt');
		expect(ownerUnsafe).toBe(true);
	});
});

describe('Standalone VM creation ownership', () => {
	it('publishes the required ownership reservation before the caller can create a VM', async () => {
		const callOrder: string[] = [];
		const reservationPublication = createDeferredCompletion();
		const createManagedVmOwnershipReservation = vi.fn(
			async (
				options: CreateManagedVmOwnershipReservationOptions,
			): Promise<CreatedManagedVmOwnershipReservation> => {
				callOrder.push('create-reservation');
				await reservationPublication.promise;
				callOrder.push('publish-reservation');
				return createStandaloneReservation(options);
			},
		);
		const createVmAfterOwnership = vi.fn(() => {
			callOrder.push('create-vm');
		});
		const ownershipPromise = createStandaloneVmCreationOwnership(
			standaloneOptions({ createManagedVmOwnershipReservation }),
		).then((ownership) => {
			createVmAfterOwnership();
			return ownership;
		});

		expect(callOrder).toEqual(['create-reservation']);
		expect(createVmAfterOwnership).not.toHaveBeenCalled();

		reservationPublication.resolve();
		const ownership = await ownershipPromise;
		expect(callOrder).toEqual(['create-reservation', 'publish-reservation', 'create-vm']);
		expect(createManagedVmOwnershipReservation).toHaveBeenCalledWith({
			controllerEpoch: 'controller-epoch-worker',
			parentGateway: null,
			principal: JSON.stringify({
				...TEST_DEPLOYMENT_IDENTITY,
				kind: 'worker-task',
				taskId: 'task-a',
				zoneId: 'sunfam',
			}),
			reservationId: 'standalone-reservation-worker-task-a',
			reservationRoot: '/state/sunfam/vm-ownership/reservations',
			role: 'standalone',
			sessionLabel: 'worker-task:task-a',
			vmId: 'standalone-vm-worker-task-a',
		});
		expect(ownership.ownershipReservation.reservationId).toBe(
			'standalone-reservation-worker-task-a',
		);
	});

	it.each([
		{
			label: 'mismatched',
			makeReceipt: (target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 => ({
				...createMatchingReceipt(target),
				vmId: 'different-vm',
			}),
			expectedError: VmDestructionReceiptMismatchError,
		},
		{
			label: 'incomplete',
			makeReceipt: (target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 => ({
				...createMatchingReceipt(target),
				complete: false,
			}),
			expectedError: IncompleteVmDestructionError,
		},
	])('rereads the detached destroy target and rejects a $label receipt', async (testCase) => {
		let createdReservation: CreatedManagedVmOwnershipReservation | undefined;
		const latestTarget = createTestVmDestroyTarget('standalone-vm-worker-task-a', {
			controllerEpoch: 'controller-epoch-worker',
			reservationId: 'standalone-reservation-worker-task-a',
			role: 'standalone',
		});
		const createManagedVmOwnershipReservation = vi.fn(
			async (
				options: CreateManagedVmOwnershipReservationOptions,
			): Promise<CreatedManagedVmOwnershipReservation> => {
				createdReservation = createStandaloneReservation(options);
				return createdReservation;
			},
		);
		const readManagedVmDestroyTarget = vi.fn(async () => latestTarget);
		const destroyManagedVmExact = vi.fn(
			async (target: ManagedVmDestroyTargetV1): Promise<ManagedVmDestroyReceiptV1> =>
				testCase.makeReceipt(target),
		);
		const ownership = await createStandaloneVmCreationOwnership(
			standaloneOptions({
				createManagedVmOwnershipReservation,
				destroyManagedVmExact,
				readManagedVmDestroyTarget,
			}),
		);

		await expect(ownership.destroyDetached()).rejects.toBeInstanceOf(testCase.expectedError);
		expect(readManagedVmDestroyTarget).toHaveBeenCalledWith(
			createdReservation?.reference.reservationPath,
		);
		expect(destroyManagedVmExact).toHaveBeenCalledWith(latestTarget);
	});

	it.each([
		{
			label: 'mismatched',
			makeReceipt: (target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 => ({
				...createMatchingReceipt(target),
				reservationId: 'different-reservation',
			}),
			expectedError: VmDestructionReceiptMismatchError,
		},
		{
			label: 'incomplete',
			makeReceipt: (target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 => ({
				...createMatchingReceipt(target),
				complete: false,
			}),
			expectedError: IncompleteVmDestructionError,
		},
	])('rereads the live destroy target and rejects a $label receipt', async (testCase) => {
		let createdReservation: CreatedManagedVmOwnershipReservation | undefined;
		const latestTarget = createTestVmDestroyTarget('standalone-vm-worker-task-a', {
			controllerEpoch: 'controller-epoch-worker',
			reservationId: 'standalone-reservation-worker-task-a',
			role: 'standalone',
		});
		const createManagedVmOwnershipReservation = vi.fn(
			async (
				options: CreateManagedVmOwnershipReservationOptions,
			): Promise<CreatedManagedVmOwnershipReservation> => {
				createdReservation = createStandaloneReservation(options);
				return createdReservation;
			},
		);
		const readManagedVmDestroyTarget = vi.fn(async () => latestTarget);
		const closeLiveVm = vi.fn(
			async (): Promise<ManagedVmDestroyReceiptV1> => testCase.makeReceipt(latestTarget),
		);
		const ownership = await createStandaloneVmCreationOwnership(
			standaloneOptions({
				createManagedVmOwnershipReservation,
				readManagedVmDestroyTarget,
			}),
		);

		await expect(ownership.destroyLive(closeLiveVm)).rejects.toBeInstanceOf(testCase.expectedError);
		expect(readManagedVmDestroyTarget).toHaveBeenCalledWith(
			createdReservation?.reference.reservationPath,
		);
		expect(closeLiveVm).toHaveBeenCalledOnce();
	});

	it('accepts a complete current-target receipt on both detached and live paths', async () => {
		const latestTarget = createTestVmDestroyTarget('standalone-vm-worker-task-a', {
			controllerEpoch: 'controller-epoch-worker',
			reservationId: 'standalone-reservation-worker-task-a',
			role: 'standalone',
		});
		const matchingReceipt = createMatchingReceipt(latestTarget);
		const ownership = await createStandaloneVmCreationOwnership(
			standaloneOptions({
				createManagedVmOwnershipReservation: async (options) =>
					createStandaloneReservation(options),
				destroyManagedVmExact: async () => matchingReceipt,
				readManagedVmDestroyTarget: async () => latestTarget,
			}),
		);

		await expect(ownership.destroyDetached()).resolves.toEqual(matchingReceipt);
		await expect(ownership.destroyLive(async () => matchingReceipt)).resolves.toEqual(
			matchingReceipt,
		);
	});
});
