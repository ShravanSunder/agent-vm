import { describe, expect, it, vi } from 'vitest';

import {
	GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS,
	GatewayDestructionTimeoutError,
	type GatewayDestructionBudget,
} from './gateway-destruction-budget.js';
import { reconcilePersistedGatewayMembership } from './gateway-membership-reconciliation.js';
import type { GatewayMembershipRecord } from './vm-ownership-contracts.js';
import type { VmOwnershipJournal } from './vm-ownership-journal.js';
import type {
	MatchingVmOwnershipReservationOptions,
	VmOwnershipReservationAuthority,
} from './vm-ownership-reservation-authority.js';

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

function createMembershipRecord(childCount: number): GatewayMembershipRecord {
	const gateway = {
		bootId: 'boot-1',
		controllerEpoch: 'controller-1',
		gatewayEpochId: 'gateway-epoch-1',
		gatewayVmId: 'gateway-vm-1',
		generationId: 'generation-1',
		zoneId: 'sunfam',
	};
	const deploymentIdentity = {
		configPath: '/deployment/config/system.jsonc',
		controllerPort: 3210,
		projectNamespace: 'deployment-1',
	};
	return {
		children: Array.from({ length: childCount }, (_unused, childIndex) => ({
			controllerEpoch: gateway.controllerEpoch,
			expectedRevision: 1,
			observedReservationRevision: 1,
			parentGateway: {
				gatewayEpochId: gateway.gatewayEpochId,
				gatewayVmId: gateway.gatewayVmId,
			},
			principal: {
				...deploymentIdentity,
				agentId: `agent-${String(childIndex + 1)}`,
				kind: 'stable-agent' as const,
				zoneId: gateway.zoneId,
			},
			reservationId: `tool-reservation-${String(childIndex + 1)}`,
			reservationPath: `/state/vm-ownership/reservations/tool-${String(childIndex + 1)}/reservation-v1.json`,
			role: 'tool' as const,
			sessionLabel: `tool-session-${String(childIndex + 1)}`,
			state: 'current' as const,
			vmId: `tool-vm-${String(childIndex + 1)}`,
		})),
		controllerEpoch: gateway.controllerEpoch,
		createdAtMs: 1,
		gateway,
		gatewayReservation: {
			controllerEpoch: gateway.controllerEpoch,
			expectedRevision: 1,
			parentGateway: null,
			principal: {
				...deploymentIdentity,
				kind: 'gateway-zone',
				zoneId: gateway.zoneId,
			},
			reservationId: 'gateway-reservation-1',
			reservationPath: '/state/vm-ownership/reservations/gateway-1/reservation-v1.json',
			role: 'gateway',
			sessionLabel: 'gateway-session-1',
			vmId: gateway.gatewayVmId,
		},
		revision: 1,
		schemaVersion: 1,
		state: 'sealed',
		updatedAtMs: 1,
	};
}

function createJournal(): VmOwnershipJournal {
	return {
		assertReservationPathOwned: vi.fn(),
		captureTimestampMs: () => 2,
		createGatewayMembership: vi.fn(
			async (record: GatewayMembershipRecord): Promise<GatewayMembershipRecord> => record,
		),
		ensureStorage: vi.fn(async () => undefined),
		inspectMembershipFile: vi.fn(async () => ({ directoryMode: 0o700, fileMode: 0o600 })),
		loadAllGatewayMemberships: vi.fn(async () => []),
		loadGatewayMembership: vi.fn(async () => {
			throw new Error('not used by reconciliation test');
		}),
		membershipPathForTesting: (gatewayEpochId) => `/state/${gatewayEpochId}.json`,
		replaceGatewayMembership: vi.fn(
			async (
				options: Parameters<VmOwnershipJournal['replaceGatewayMembership']>[0],
			): Promise<GatewayMembershipRecord> => options.record,
		),
		reservationPathFor: (reservationId) => `/state/${reservationId}/reservation-v1.json`,
	};
}

describe('persisted Gateway membership reconciliation budget', () => {
	it('starts at most four child destroys in parallel and never reaches the parent after the frozen subtree attempt expires', async () => {
		// Arrange
		const loadedRecord = createMembershipRecord(6);
		const controlledBudget = createControlledSubtreeBudget();
		const pendingDestructions: DeferredDestruction[] = [];
		let activeChildDestructions = 0;
		let maximumActiveChildDestructions = 0;
		const destroyMatchingReservationMock = vi.fn(
			async (options: MatchingVmOwnershipReservationOptions) => {
				if (options.role === 'gateway') {
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
			},
		);
		const authority = {
			destroyManagedVmTarget: vi.fn(async () => {
				throw new Error('not used by persisted reconciliation');
			}),
			destroyMatchingReservation: destroyMatchingReservationMock,
			managedReservationReference: vi.fn(() => {
				throw new Error('not used by persisted reconciliation');
			}),
			readMatchingDestroyInputs: vi.fn(async () => {
				throw new Error('not used by persisted reconciliation');
			}),
			referencesEqual: vi.fn(() => false),
			reservationPathFor: vi.fn(() => ''),
			reservationPathForRoot: vi.fn(() => ''),
			reservationRootForStateDirectory: vi.fn(() => ''),
			targetMatchesReservation: vi.fn(() => false),
		} satisfies VmOwnershipReservationAuthority;

		// Act
		const reconciliation = reconcilePersistedGatewayMembership({
			authority,
			destructionBudget: controlledBudget.budget,
			journal: createJournal(),
			loadedRecord,
			nowMs: () => 2,
		});
		await Promise.resolve();
		await Promise.resolve();

		// Assert
		expect.soft(destroyMatchingReservationMock).toHaveBeenCalledTimes(4);
		expect.soft(maximumActiveChildDestructions).toBe(4);
		expect
			.soft(destroyMatchingReservationMock.mock.calls.every(([options]) => options.role === 'tool'))
			.toBe(true);
		expect(controlledBudget.createAttemptCount()).toBe(1);

		controlledBudget.expire();
		await expect(reconciliation).rejects.toMatchObject({
			code: 'GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT',
			timeoutMs: GATEWAY_SUBTREE_DESTRUCTION_TIMEOUT_MS,
		});
		expect(
			destroyMatchingReservationMock.mock.calls.some(([options]) => options.role === 'gateway'),
		).toBe(false);
	});
});
