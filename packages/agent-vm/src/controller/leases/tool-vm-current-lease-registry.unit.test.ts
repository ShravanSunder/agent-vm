import { describe, expect, it, vi } from 'vitest';

import {
	createTestVmDestroyTarget,
	createTestVmOwnershipReservationReference,
} from '../../testing/managed-vm-test-helpers.js';
import type { ProvisionalToolVmOwnershipHandle } from '../vm-ownership/gateway-ownership-coordinator.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { createToolVmCurrentLeaseRegistry } from './tool-vm-current-lease-registry.js';

interface TestLease {
	readonly agentId: string;
	readonly id: string;
	readonly lastUsedAt: number;
	readonly label: string;
	readonly zoneId: string;
}

const TEST_GATEWAY_IDENTITY = {
	bootId: 'gateway-boot-1',
	controllerEpoch: 'controller-epoch-1',
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

const TEST_OWNERSHIP_RESERVATION = createTestVmOwnershipReservationReference('tool-vm-1', {
	controllerEpoch: TEST_GATEWAY_IDENTITY.controllerEpoch,
	parentGateway: {
		epoch: TEST_GATEWAY_IDENTITY.gatewayEpochId,
		vmId: TEST_GATEWAY_IDENTITY.gatewayVmId,
	},
	role: 'tool',
});

const TEST_DESTROY_TARGET = createTestVmDestroyTarget('tool-vm-1', {
	controllerEpoch: TEST_GATEWAY_IDENTITY.controllerEpoch,
	parentGateway: {
		epoch: TEST_GATEWAY_IDENTITY.gatewayEpochId,
		vmId: TEST_GATEWAY_IDENTITY.gatewayVmId,
	},
	role: 'tool',
});

function createGatewayIdentity(
	overrides: Partial<GatewayEpochIdentity> = {},
): GatewayEpochIdentity {
	return {
		...TEST_GATEWAY_IDENTITY,
		...overrides,
	};
}

function createLease(overrides: Partial<TestLease> = {}): TestLease {
	return {
		agentId: 'main',
		id: 'lease-1',
		label: 'primary lease',
		lastUsedAt: 1_000,
		zoneId: 'shravan',
		...overrides,
	};
}

function createOwnershipHandle(): ProvisionalToolVmOwnershipHandle {
	return {
		ready: Promise.resolve({
			destructionIdentity: {
				reservationId: TEST_DESTROY_TARGET.reservationId,
				reservationPath: TEST_DESTROY_TARGET.reservationPath,
				vmId: TEST_DESTROY_TARGET.vmId,
			},
			ownershipReservation: TEST_OWNERSHIP_RESERVATION,
			verifiedDestroyTarget: TEST_DESTROY_TARGET,
		}),
		commitCurrent: vi.fn(async () => {}),
		destroyDetached: vi.fn(async () => {
			throw new Error('not exercised by registry tests');
		}),
		destroyLive: vi.fn(async () => {
			throw new Error('not exercised by registry tests');
		}),
	};
}

describe('createToolVmCurrentLeaseRegistry', () => {
	it('records and forgets the lease, Gateway identity, and ownership handle as one current entry', () => {
		// Arrange
		const registry = createToolVmCurrentLeaseRegistry<TestLease>();
		const lease = createLease();
		const gatewayIdentity = createGatewayIdentity();
		const ownership = createOwnershipHandle();

		// Act
		registry.recordCurrent({ gatewayIdentity, lease, ownership });

		// Assert
		expect(registry.get(lease.id)).toBe(lease);
		expect(registry.findByAgent(lease)).toBe(lease);
		expect(registry.resolveGatewayIdentity(lease.id)).toEqual(gatewayIdentity);
		expect(registry.requireOwnership(lease.id)).toBe(ownership);
		expect(registry.list()).toEqual([lease]);
		expect([...registry.values()]).toEqual([lease]);

		// Act
		registry.forget(lease);

		// Assert
		expect(registry.get(lease.id)).toBeUndefined();
		expect(registry.findByAgent(lease)).toBeUndefined();
		expect(registry.resolveGatewayIdentity(lease.id)).toBeUndefined();
		expect(registry.list()).toEqual([]);
		expect([...registry.values()]).toEqual([]);
		expect(() => registry.requireOwnership(lease.id)).toThrow(
			`Lease '${lease.id}' is missing its Tool VM ownership handle.`,
		);
	});

	it('isolates agent lookup by both zone and agent identity', () => {
		// Arrange
		const registry = createToolVmCurrentLeaseRegistry<TestLease>();
		const shravanMain = createLease({ id: 'lease-shravan-main' });
		const shravanReviewer = createLease({
			agentId: 'reviewer',
			id: 'lease-shravan-reviewer',
		});
		const workMain = createLease({ id: 'lease-work-main', zoneId: 'work' });

		// Act
		for (const lease of [shravanMain, shravanReviewer, workMain]) {
			registry.recordCurrent({
				gatewayIdentity: createGatewayIdentity({ zoneId: lease.zoneId }),
				lease,
				ownership: createOwnershipHandle(),
			});
		}

		// Assert
		expect(registry.findByAgent({ agentId: 'main', zoneId: 'shravan' })).toBe(shravanMain);
		expect(registry.findByAgent({ agentId: 'reviewer', zoneId: 'shravan' })).toBe(shravanReviewer);
		expect(registry.findByAgent({ agentId: 'main', zoneId: 'work' })).toBe(workMain);
		expect(registry.findByAgent({ agentId: 'reviewer', zoneId: 'work' })).toBeUndefined();
	});

	it.each([
		['bootId', 'gateway-boot-2'],
		['controllerEpoch', 'controller-epoch-2'],
		['gatewayEpochId', 'gateway-epoch-2'],
		['gatewayVmId', 'gateway-vm-2'],
		['generationId', 'gateway-generation-2'],
		['zoneId', 'work'],
	] as const)(
		'filters Gateway ownership by the complete identity when %s differs',
		(field, value) => {
			// Arrange
			const registry = createToolVmCurrentLeaseRegistry<TestLease>();
			const exactLease = createLease({ id: `lease-exact-${field}` });
			const otherLease = createLease({ agentId: `other-${field}`, id: `lease-other-${field}` });
			registry.recordCurrent({
				gatewayIdentity: createGatewayIdentity(),
				lease: exactLease,
				ownership: createOwnershipHandle(),
			});
			registry.recordCurrent({
				gatewayIdentity: createGatewayIdentity({ [field]: value }),
				lease: otherLease,
				ownership: createOwnershipHandle(),
			});

			// Act
			const leaseIds = registry.leaseIdsOwnedByGateway(createGatewayIdentity());

			// Assert
			expect(leaseIds).toEqual([exactLease.id]);
		},
	);

	it('does not let stale lease cleanup remove a replacement from the same agent index', () => {
		// Arrange
		const registry = createToolVmCurrentLeaseRegistry<TestLease>();
		const staleLease = createLease({ id: 'lease-stale' });
		const replacementLease = createLease({ id: 'lease-replacement', lastUsedAt: 2_000 });
		registry.recordCurrent({
			gatewayIdentity: createGatewayIdentity(),
			lease: staleLease,
			ownership: createOwnershipHandle(),
		});
		registry.recordCurrent({
			gatewayIdentity: createGatewayIdentity(),
			lease: replacementLease,
			ownership: createOwnershipHandle(),
		});

		// Act
		registry.forget(staleLease);

		// Assert
		expect(registry.get(staleLease.id)).toBeUndefined();
		expect(registry.get(replacementLease.id)).toBe(replacementLease);
		expect(registry.findByAgent(staleLease)).toBe(replacementLease);
	});

	it('refuses ownership lookup for an unknown or forgotten lease', () => {
		// Arrange
		const registry = createToolVmCurrentLeaseRegistry<TestLease>();
		const lease = createLease();

		// Act and assert
		expect(() => registry.requireOwnership(lease.id)).toThrow(
			`Lease '${lease.id}' is missing its Tool VM ownership handle.`,
		);

		// Arrange
		registry.recordCurrent({
			gatewayIdentity: createGatewayIdentity(),
			lease,
			ownership: createOwnershipHandle(),
		});
		registry.forget(lease);

		// Act and assert
		expect(() => registry.requireOwnership(lease.id)).toThrow(
			`Lease '${lease.id}' is missing its Tool VM ownership handle.`,
		);
	});

	it('touches only last-used time while preserving Gateway parentage and ownership', () => {
		// Arrange
		const registry = createToolVmCurrentLeaseRegistry<TestLease>();
		const lease = createLease();
		const gatewayIdentity = createGatewayIdentity();
		const ownership = createOwnershipHandle();
		registry.recordCurrent({ gatewayIdentity, lease, ownership });

		// Act
		const touchedLease = registry.touch(lease, 9_876);

		// Assert
		expect(touchedLease).toEqual({ ...lease, lastUsedAt: 9_876 });
		expect(touchedLease).not.toBe(lease);
		expect(registry.get(lease.id)).toBe(touchedLease);
		expect(registry.findByAgent(lease)).toBe(touchedLease);
		expect(registry.resolveGatewayIdentity(lease.id)).toEqual(gatewayIdentity);
		expect(registry.requireOwnership(lease.id)).toBe(ownership);
	});
});
