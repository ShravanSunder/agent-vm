import path from 'node:path';

import type {
	ManagedVmDestroyTargetV1,
	ManagedVmOwnershipReservationV1,
	VmDestroyReceiptV1,
} from '@agent-vm/gondolin-adapter';
import { describe, expect, it, vi } from 'vitest';

import {
	GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS,
	GatewayDestructionTimeoutError,
	type GatewayDestructionBudget,
} from './gateway-destruction-budget.js';
import type { VmOwnershipDeploymentIdentity } from './vm-ownership-contracts.js';
import type { VmOwnershipReservationAuthority } from './vm-ownership-reservation-authority.js';
import { reconcileUnreferencedVmOwnershipReservations } from './vm-ownership-reservation-reconciliation.js';

const DEPLOYMENT_IDENTITY = {
	configPath: '/deployment/config/system.jsonc',
	controllerPort: 3210,
	projectNamespace: 'deployment-1',
} satisfies VmOwnershipDeploymentIdentity;
const RESERVATION_ROOT = '/state/vm-ownership/reservations';

interface OwnedReservationFixture {
	readonly reservation: ManagedVmOwnershipReservationV1;
	readonly reservationPath: string;
	readonly target: ManagedVmDestroyTargetV1;
}

interface DeferredDestruction {
	readonly promise: Promise<never>;
}

function createDeferredDestruction(): DeferredDestruction {
	return { promise: new Promise<never>(() => {}) };
}

function createControlledSubtreeBudget(): {
	readonly budget: GatewayDestructionBudget;
	readonly createAttemptCount: () => number;
	expire(): void;
} {
	const abortController = new AbortController();
	const timeoutError = new GatewayDestructionTimeoutError(
		'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
		'Gateway subtree',
		GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS,
	);
	let createAttemptCount = 0;
	let rejectDeadline: ((error: unknown) => void) | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		rejectDeadline = reject;
	});
	return {
		budget: {
			createSubtreeAttempt: () => {
				createAttemptCount += 1;
				return {
					signal: abortController.signal,
					runSubtree: async (operation) =>
						await Promise.race([operation(abortController.signal), deadline]),
					runTarget: async (_target, operation) => await operation(),
					throwIfExpired: () => {
						if (abortController.signal.aborted) throw timeoutError;
					},
				};
			},
			runTarget: async (_target, operation) => await operation(),
		},
		createAttemptCount: () => createAttemptCount,
		expire(): void {
			abortController.abort(timeoutError);
			rejectDeadline?.(timeoutError);
		},
	};
}

function createOwnedReservationFixture(options: {
	readonly childIndex?: number;
	readonly role: 'gateway' | 'standalone' | 'tool';
}): OwnedReservationFixture {
	const isGateway = options.role === 'gateway';
	const identitySuffix = isGateway
		? 'gateway'
		: `${options.role}-${String(options.childIndex ?? 0)}`;
	const reservationId = `${identitySuffix}-reservation`;
	const reservationPath = path.join(RESERVATION_ROOT, reservationId, 'reservation-v1.json');
	const parentGateway =
		options.role === 'tool' ? { epoch: 'gateway-epoch-1', vmId: 'gateway-vm-1' } : null;
	const principal = JSON.stringify(
		isGateway
			? {
					...DEPLOYMENT_IDENTITY,
					kind: 'gateway-zone',
					zoneId: 'sunfam',
				}
			: options.role === 'tool'
				? {
						...DEPLOYMENT_IDENTITY,
						agentId: `agent-${String(options.childIndex ?? 0)}`,
						kind: 'stable-agent',
						zoneId: 'sunfam',
					}
				: {
						...DEPLOYMENT_IDENTITY,
						kind: 'worker-task',
						taskId: `task-${String(options.childIndex ?? 0)}`,
						zoneId: 'sunfam',
					},
	);
	const ownerProcess = {
		command: 'agent-vm-reservation-reconciliation-unit-test',
		pid: 42,
		startCookie: 'owner-cookie',
	};
	const resources = {
		disposableStoragePaths: [],
		ingressListener: false,
		ingressSockets: false,
		retainedStoragePaths: [],
		sshListener: false,
		sshSessions: false,
	};
	const runner = {
		backend: 'qemu' as const,
		discoveryIdentity: `gondolin-exact-vm:${identitySuffix}`,
		executable: '/usr/bin/qemu-system-aarch64',
	};
	const vmId = isGateway ? 'gateway-vm-1' : `${identitySuffix}-vm`;
	const reservation = {
		contractVersion: 1,
		controllerEpoch: 'controller-1',
		createdAt: '2026-07-10T00:00:00.000Z',
		discoveryKey: `discovery-${identitySuffix}`,
		ownerProcess,
		parentGateway,
		principal,
		reservationId,
		resources,
		revision: 1,
		role: options.role,
		runner,
		sessionLabel: `${identitySuffix}-session`,
		state: 'reserved' as const,
		vmId,
	} satisfies ManagedVmOwnershipReservationV1;
	const target = {
		contractVersion: 1,
		controllerEpoch: reservation.controllerEpoch,
		ownerProcess,
		parentGateway,
		principal,
		reservationId,
		reservationPath,
		resources,
		role: options.role,
		runner,
		sessionLabel: reservation.sessionLabel,
		vmId,
	} satisfies ManagedVmDestroyTargetV1;
	return { reservation, reservationPath, target };
}

function withParentGateway(
	fixture: OwnedReservationFixture,
	parentGateway: NonNullable<ManagedVmOwnershipReservationV1['parentGateway']>,
): OwnedReservationFixture {
	return {
		reservation: { ...fixture.reservation, parentGateway },
		reservationPath: fixture.reservationPath,
		target: { ...fixture.target, parentGateway },
	};
}

function createMatchingDestroyReceipt(target: ManagedVmDestroyTargetV1): VmDestroyReceiptV1 {
	return {
		complete: true,
		completedAt: '2026-07-10T00:00:01.000Z',
		contractVersion: target.contractVersion,
		controllerEpoch: target.controllerEpoch,
		parentGateway: target.parentGateway,
		requestedRunner: {
			backend: target.runner.backend,
			discoveryIdentity: target.runner.discoveryIdentity,
			executableName: path.basename(target.runner.executable),
			...(target.runner.pid === undefined ? {} : { pid: target.runner.pid }),
			...(target.runner.startCookie === undefined
				? {}
				: { startCookie: target.runner.startCookie }),
		},
		reservationId: target.reservationId,
		resources: {
			disposableStorage: { status: 'destroyed' },
			exactRunner: { status: 'destroyed' },
			ingressListener: { status: 'already-absent' },
			ingressSockets: { status: 'already-absent' },
			qmp: { status: 'destroyed' },
			sessionIpc: { status: 'destroyed' },
			sshListener: { status: 'already-absent' },
			sshSessions: { status: 'already-absent' },
		},
		role: target.role,
		vmId: target.vmId,
	};
}

function createReservationAuthority(
	destroyManagedVmTarget: VmOwnershipReservationAuthority['destroyManagedVmTarget'],
): VmOwnershipReservationAuthority {
	return {
		destroyManagedVmTarget,
		destroyMatchingReservation: vi.fn(async () => {
			throw new Error('not used by orphan reconciliation');
		}),
		managedReservationReference: vi.fn(() => {
			throw new Error('not used by orphan reconciliation');
		}),
		readMatchingDestroyInputs: vi.fn(async () => {
			throw new Error('not used by orphan reconciliation');
		}),
		referencesEqual: vi.fn(() => false),
		reservationPathFor: vi.fn(() => ''),
		reservationPathForRoot: (_reservationRoot: string, reservationId: string) =>
			path.join(RESERVATION_ROOT, reservationId, 'reservation-v1.json'),
		reservationRootForStateDirectory: vi.fn(() => RESERVATION_ROOT),
		targetMatchesReservation: vi.fn(() => true),
	};
}

async function reconcileFixtures(options: {
	readonly allowedRoles?: ReadonlySet<ManagedVmOwnershipReservationV1['role']>;
	readonly authority: VmOwnershipReservationAuthority;
	readonly fixtures: readonly OwnedReservationFixture[];
}): Promise<Awaited<ReturnType<typeof reconcileUnreferencedVmOwnershipReservations>>> {
	const fixtureByPath = new Map(
		options.fixtures.map((fixture) => [fixture.reservationPath, fixture]),
	);
	return await reconcileUnreferencedVmOwnershipReservations({
		allowedRoles: options.allowedRoles ?? new Set(['gateway', 'tool']),
		authority: options.authority,
		deploymentIdentity: DEPLOYMENT_IDENTITY,
		listReservationPaths: async () => options.fixtures.map((fixture) => fixture.reservationPath),
		readReservation: async (reservationPath) => {
			const fixture = fixtureByPath.get(reservationPath);
			if (fixture === undefined) {
				throw new Error(`missing fixture for ${reservationPath}`);
			}
			return fixture.reservation;
		},
		readTarget: async (reservationPath) => {
			const fixture = fixtureByPath.get(reservationPath);
			if (fixture === undefined) {
				throw new Error(`missing fixture for ${reservationPath}`);
			}
			return fixture.target;
		},
		referencedReservationPaths: new Set(),
		reservationRoot: RESERVATION_ROOT,
		zoneId: 'sunfam',
	});
}

describe('unreferenced VM ownership reservation reconciliation budget', () => {
	it('groups orphan children under their Gateway, starts only four concurrently, and never destroys the parent after subtree expiry', async () => {
		// Arrange
		const fixtures = [
			...Array.from({ length: 6 }, (_unused, childIndex) =>
				createOwnedReservationFixture({ childIndex: childIndex + 1, role: 'tool' }),
			),
			createOwnedReservationFixture({ role: 'gateway' }),
		];
		const fixtureByPath = new Map(fixtures.map((fixture) => [fixture.reservationPath, fixture]));
		const controlledBudget = createControlledSubtreeBudget();
		const pendingDestructions: DeferredDestruction[] = [];
		let activeChildDestructions = 0;
		let maximumActiveChildDestructions = 0;
		const destroyManagedVmTargetMock = vi.fn(async (target: ManagedVmDestroyTargetV1) => {
			if (target.role === 'gateway') {
				throw new Error('parent destruction must not start after subtree expiry');
			}
			activeChildDestructions += 1;
			maximumActiveChildDestructions = Math.max(
				maximumActiveChildDestructions,
				activeChildDestructions,
			);
			const pendingDestruction = createDeferredDestruction();
			pendingDestructions.push(pendingDestruction);
			try {
				return await pendingDestruction.promise;
			} finally {
				activeChildDestructions -= 1;
			}
		});
		const authority = {
			destroyManagedVmTarget: destroyManagedVmTargetMock,
			destroyMatchingReservation: vi.fn(async () => {
				throw new Error('not used by orphan reconciliation');
			}),
			managedReservationReference: vi.fn(() => {
				throw new Error('not used by orphan reconciliation');
			}),
			readMatchingDestroyInputs: vi.fn(async () => {
				throw new Error('not used by orphan reconciliation');
			}),
			referencesEqual: vi.fn(() => false),
			reservationPathFor: vi.fn(() => ''),
			reservationPathForRoot: (_reservationRoot: string, reservationId: string) =>
				path.join(RESERVATION_ROOT, reservationId, 'reservation-v1.json'),
			reservationRootForStateDirectory: vi.fn(() => RESERVATION_ROOT),
			targetMatchesReservation: vi.fn(() => true),
		} satisfies VmOwnershipReservationAuthority;

		// Act
		const reconciliation = reconcileUnreferencedVmOwnershipReservations({
			allowedRoles: new Set(['gateway', 'tool']),
			authority,
			destructionBudget: controlledBudget.budget,
			deploymentIdentity: DEPLOYMENT_IDENTITY,
			listReservationPaths: async () => fixtures.map((fixture) => fixture.reservationPath),
			readReservation: async (reservationPath) => {
				const fixture = fixtureByPath.get(reservationPath);
				if (fixture === undefined) {
					throw new Error(`missing fixture for ${reservationPath}`);
				}
				return fixture.reservation;
			},
			readTarget: async (reservationPath) => {
				const fixture = fixtureByPath.get(reservationPath);
				if (fixture === undefined) {
					throw new Error(`missing fixture for ${reservationPath}`);
				}
				return fixture.target;
			},
			referencedReservationPaths: new Set(),
			reservationRoot: RESERVATION_ROOT,
			zoneId: 'sunfam',
		});
		for (let microtaskIndex = 0; microtaskIndex < 20; microtaskIndex += 1) {
			// oxlint-disable-next-line no-await-in-loop -- drain the finite validation chain without wall-clock time.
			await Promise.resolve();
		}

		// Assert
		expect.soft(destroyManagedVmTargetMock).toHaveBeenCalledTimes(4);
		expect.soft(maximumActiveChildDestructions).toBe(4);
		expect
			.soft(destroyManagedVmTargetMock.mock.calls.every(([target]) => target.role === 'tool'))
			.toBe(true);
		expect(controlledBudget.createAttemptCount()).toBe(1);

		controlledBudget.expire();
		const result = await reconciliation;
		expect(result.errors).toContainEqual(
			expect.objectContaining({
				code: 'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
				timeoutMs: GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS,
			}),
		);
		expect(
			destroyManagedVmTargetMock.mock.calls.some(([target]) => target.role === 'gateway'),
		).toBe(false);
	});

	it('marks a missing exact parent Gateway reservation owner-unsafe after destroying the proven Tool child', async () => {
		// Arrange
		const toolFixture = createOwnedReservationFixture({ childIndex: 1, role: 'tool' });
		const destroyManagedVmTargetMock = vi.fn(async (target: ManagedVmDestroyTargetV1) =>
			createMatchingDestroyReceipt(target),
		);

		// Act
		const result = await reconcileFixtures({
			authority: createReservationAuthority(destroyManagedVmTargetMock),
			fixtures: [toolFixture],
		});

		// Assert
		expect(destroyManagedVmTargetMock).toHaveBeenCalledExactlyOnceWith(toolFixture.target);
		expect(result.blockedGatewayKeys).toContain('gateway-epoch-1\0gateway-vm-1');
		expect(result.errors).toContainEqual(expect.objectContaining({ code: 'owner-unsafe' }));
	});

	it('refuses to associate one Gateway reservation with children naming colliding parent epochs', async () => {
		// Arrange
		const firstToolFixture = withParentGateway(
			createOwnedReservationFixture({ childIndex: 1, role: 'tool' }),
			{ epoch: 'gateway-epoch-1', vmId: 'gateway-vm-1' },
		);
		const secondToolFixture = withParentGateway(
			createOwnedReservationFixture({ childIndex: 2, role: 'tool' }),
			{ epoch: 'gateway-epoch-2', vmId: 'gateway-vm-1' },
		);
		const gatewayFixture = createOwnedReservationFixture({ role: 'gateway' });
		const destroyManagedVmTargetMock = vi.fn(async (target: ManagedVmDestroyTargetV1) =>
			createMatchingDestroyReceipt(target),
		);

		// Act
		const result = await reconcileFixtures({
			authority: createReservationAuthority(destroyManagedVmTargetMock),
			fixtures: [firstToolFixture, secondToolFixture, gatewayFixture],
		});

		// Assert
		expect(
			destroyManagedVmTargetMock.mock.calls.filter(([target]) => target.role === 'gateway'),
		).toHaveLength(0);
		expect(result.blockedGatewayKeys).toEqual(
			new Set(['gateway-epoch-1\0gateway-vm-1', 'gateway-epoch-2\0gateway-vm-1']),
		);
		expect(result.errors).toContainEqual(expect.objectContaining({ code: 'owner-unsafe' }));
	});

	it('performs no destruction when one inventoried orphan has ambiguous ownership evidence', async () => {
		// Arrange
		const toolFixture = createOwnedReservationFixture({ childIndex: 1, role: 'tool' });
		const gatewayFixture = createOwnedReservationFixture({ role: 'gateway' });
		const standaloneFixture = createOwnedReservationFixture({
			childIndex: 1,
			role: 'standalone',
		});
		const malformedFixtureBase = createOwnedReservationFixture({ childIndex: 2, role: 'tool' });
		const malformedFixture = {
			...malformedFixtureBase,
			reservation: {
				...malformedFixtureBase.reservation,
				principal: '{malformed',
			},
		} satisfies OwnedReservationFixture;
		const destroyManagedVmTargetMock = vi.fn(async (target: ManagedVmDestroyTargetV1) =>
			createMatchingDestroyReceipt(target),
		);

		// Act
		const result = await reconcileFixtures({
			allowedRoles: new Set(['gateway', 'standalone', 'tool']),
			authority: createReservationAuthority(destroyManagedVmTargetMock),
			fixtures: [toolFixture, gatewayFixture, standaloneFixture, malformedFixture],
		});

		// Assert
		expect(result.blockAllGatewayDestruction).toBe(true);
		expect(result.errors).toContainEqual(
			expect.objectContaining({ code: 'reservation-identity-mismatch' }),
		);
		expect(destroyManagedVmTargetMock).not.toHaveBeenCalled();
	});
});
