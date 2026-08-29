import { describe, expect, it } from 'vitest';

import {
	createGatewayOwnershipCoordinator,
	GatewayOwnershipCoordinatorError,
	type GatewayEpochSeedHandle,
	type GatewayOwnershipCoordinator,
} from './gateway-ownership-coordinator.js';
import type { GatewayEpochIdentity } from './vm-ownership-contracts.js';

function createCoordinator(): GatewayOwnershipCoordinator {
	return createGatewayOwnershipCoordinator({
		controllerEpoch: 'controller-epoch-1',
		createGatewayEpochId: () => 'gateway-epoch-1',
	});
}

function beginAttachedGateway(): {
	readonly coordinator: GatewayOwnershipCoordinator;
	readonly gateway: GatewayEpochIdentity;
	readonly seedHandle: GatewayEpochSeedHandle;
} {
	const coordinator = createCoordinator();
	const seedHandle = coordinator.beginGatewayEpoch({
		bootId: 'boot-1',
		generationId: 'generation-1',
		zoneId: 'hermes',
	});
	const gateway = seedHandle.attachGatewayVm('gateway-vm-1');
	return { coordinator, gateway, seedHandle };
}

function expectCoordinatorError(
	error: unknown,
	code: GatewayOwnershipCoordinatorError['code'],
): void {
	expect(error).toBeInstanceOf(GatewayOwnershipCoordinatorError);
	expect((error as GatewayOwnershipCoordinatorError).code).toBe(code);
}

describe('controller-owned Gateway membership coordinator', () => {
	it('retires only the exact current unattached seed before admitting a successor', () => {
		const coordinator = createCoordinator();
		const firstSeed = coordinator.beginGatewayEpoch({
			bootId: 'boot-1',
			generationId: 'generation-1',
			zoneId: 'hermes',
		});

		expect(() =>
			coordinator.beginGatewayEpoch({
				bootId: 'boot-2',
				generationId: 'generation-2',
				zoneId: 'hermes',
			}),
		).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'gateway-already-current',
			}),
		);

		coordinator.abandonUnattachedGatewaySeed(firstSeed.seed);

		const successor = coordinator.beginGatewayEpoch({
			bootId: 'boot-2',
			generationId: 'generation-2',
			zoneId: 'hermes',
		});
		expect(successor.seed).toMatchObject({
			bootId: 'boot-2',
			generationId: 'generation-2',
		});
	});

	it('rejects mismatched, attached, sealed, and retired seed abandonment', async () => {
		const coordinator = createCoordinator();
		const seedHandle = coordinator.beginGatewayEpoch({
			bootId: 'boot-1',
			generationId: 'generation-1',
			zoneId: 'hermes',
		});

		expect(() =>
			coordinator.abandonUnattachedGatewaySeed({
				...seedHandle.seed,
				bootId: 'boot-other',
			}),
		).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'gateway-identity-mismatch',
			}),
		);
		const gatewayIdentity = seedHandle.attachGatewayVm('gateway-vm-1');
		expect(() => coordinator.abandonUnattachedGatewaySeed(seedHandle.seed)).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'gateway-already-attached',
			}),
		);

		coordinator.sealGatewayEpoch(gatewayIdentity);
		expect(() => coordinator.abandonUnattachedGatewaySeed(seedHandle.seed)).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'gateway-already-attached',
			}),
		);
		await coordinator.retireGateway(gatewayIdentity);
		expect(() => coordinator.abandonUnattachedGatewaySeed(seedHandle.seed)).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'gateway-already-attached',
			}),
		);
	});

	it('rejects repeated abandonment of an already retired unattached seed', () => {
		const coordinator = createCoordinator();
		const seedHandle = coordinator.beginGatewayEpoch({
			bootId: 'boot-1',
			generationId: 'generation-1',
			zoneId: 'hermes',
		});
		coordinator.abandonUnattachedGatewaySeed(seedHandle.seed);

		expect(() => coordinator.abandonUnattachedGatewaySeed(seedHandle.seed)).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'gateway-not-current',
			}),
		);
	});

	it('creates a seed before attaching the stock Gondolin VM identity exactly once', () => {
		const coordinator = createCoordinator();
		const handle = coordinator.beginGatewayEpoch({
			bootId: 'boot-1',
			generationId: 'generation-1',
			zoneId: 'hermes',
		});

		expect(handle.seed).toEqual({
			bootId: 'boot-1',
			controllerEpoch: 'controller-epoch-1',
			gatewayEpochId: 'gateway-epoch-1',
			generationId: 'generation-1',
			zoneId: 'hermes',
		});
		const gateway = handle.attachGatewayVm('gateway-vm-1');
		expect(gateway).toEqual({ ...handle.seed, gatewayVmId: 'gateway-vm-1' });
		expect(coordinator.resolveGatewayEpoch(handle.seed)).toEqual(gateway);
		expect(() => handle.attachGatewayVm('gateway-vm-2')).toThrow(GatewayOwnershipCoordinatorError);
	});

	it('does not admit a Tool VM before the Gateway VM identity is attached', () => {
		const coordinator = createCoordinator();
		const handle = coordinator.beginGatewayEpoch({
			bootId: 'boot-1',
			generationId: 'generation-1',
			zoneId: 'hermes',
		});
		const unattachedGateway = {
			...handle.seed,
			gatewayVmId: 'gateway-vm-1',
		} satisfies GatewayEpochIdentity;

		expect(() =>
			coordinator.admitProvisionalToolVm({
				agentId: 'sun',
				expectedGateway: unattachedGateway,
				leafId: 'leaf-1',
			}),
		).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'gateway-not-attached',
			}),
		);
	});

	it('provisions B while A is destroying and fences B commit until A access is fenced', () => {
		// Arrange
		const { coordinator, gateway } = beginAttachedGateway();
		const predecessorA = coordinator.admitProvisionalToolVm({
			agentId: 'sun',
			expectedGateway: gateway,
			leafId: 'leaf-a',
		});
		predecessorA.attachToolVm('tool-vm-a');
		predecessorA.commitCurrent();
		predecessorA.beginDestroying();

		// Act
		const successorB = coordinator.admitProvisionalToolVm({
			agentId: 'sun',
			expectedGateway: gateway,
			leafId: 'leaf-b',
		});
		successorB.attachToolVm('tool-vm-b');

		// Assert
		expect(predecessorA.snapshot()).toMatchObject({ leafId: 'leaf-a', state: 'destroying' });
		expect(successorB.snapshot()).toMatchObject({ leafId: 'leaf-b', state: 'provisional' });
		expect(coordinator.snapshotGateway(gateway)).toMatchObject({
			children: expect.arrayContaining([
				expect.objectContaining({ leafId: 'leaf-a', state: 'destroying' }),
				expect.objectContaining({ leafId: 'leaf-b', state: 'provisional' }),
			]),
			state: 'admitting',
		});
		expect(() => successorB.commitCurrent()).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'agent-already-admitted',
			}),
		);
		expect(() =>
			coordinator.admitProvisionalToolVm({
				agentId: 'sun',
				expectedGateway: gateway,
				leafId: 'leaf-c',
			}),
		).toThrowError(expect.objectContaining({ code: 'agent-already-admitted' }));

		// Act
		predecessorA.recordAccessFenced();
		successorB.commitCurrent();
		predecessorA.recordUnavailable();

		// Assert
		expect(predecessorA.snapshot()).toMatchObject({ leafId: 'leaf-a', state: 'retiring' });
		expect(successorB.snapshot()).toMatchObject({ leafId: 'leaf-b', state: 'current' });

		// Act
		predecessorA.recordDestroyed();

		// Assert
		expect(successorB.snapshot()).toMatchObject({ leafId: 'leaf-b', state: 'current' });
		expect(() => predecessorA.beginDestroying()).toThrowError(
			expect.objectContaining({ code: 'child-not-current' }),
		);
		expect(() =>
			coordinator.admitProvisionalToolVm({
				agentId: 'sun',
				expectedGateway: gateway,
				leafId: 'leaf-c',
			}),
		).toThrowError(expect.objectContaining({ code: 'agent-already-admitted' }));
	});

	it('keeps containment-unproven A owner-unsafe while allowing exact retry and unrelated agents', () => {
		// Arrange
		const { coordinator, gateway } = beginAttachedGateway();
		const predecessorA = coordinator.admitProvisionalToolVm({
			agentId: 'sun',
			expectedGateway: gateway,
			leafId: 'leaf-a',
		});
		predecessorA.attachToolVm('tool-vm-a');
		predecessorA.commitCurrent();
		predecessorA.beginDestroying();

		// Act
		predecessorA.recordUnavailable();

		// Assert
		expect(predecessorA.snapshot()).toMatchObject({ state: 'owner-unsafe' });
		expect(coordinator.snapshotGateway(gateway).state).toBe('admitting');
		expect(() =>
			coordinator.admitProvisionalToolVm({
				agentId: 'sun',
				expectedGateway: gateway,
				leafId: 'leaf-b',
			}),
		).toThrowError(expect.objectContaining({ code: 'owner-unsafe' }));
		expect(() =>
			coordinator.admitProvisionalToolVm({
				agentId: 'moon',
				expectedGateway: gateway,
				leafId: 'leaf-unrelated',
			}),
		).not.toThrow();

		// Act
		predecessorA.beginDestroying();
		const successorB = coordinator.admitProvisionalToolVm({
			agentId: 'sun',
			expectedGateway: gateway,
			leafId: 'leaf-b',
		});
		successorB.attachToolVm('tool-vm-b');
		predecessorA.recordUnavailable();

		// Assert
		expect(predecessorA.snapshot()).toMatchObject({ state: 'owner-unsafe' });
		expect(successorB.snapshot()).toMatchObject({ state: 'provisional' });
		expect(() => successorB.commitCurrent()).toThrowError(
			expect.objectContaining({ code: 'owner-unsafe' }),
		);
		expect(() =>
			coordinator.admitProvisionalToolVm({
				agentId: 'sun',
				expectedGateway: gateway,
				leafId: 'leaf-c',
			}),
		).toThrowError(expect.objectContaining({ code: 'agent-already-admitted' }));

		// Act
		predecessorA.beginDestroying();
		predecessorA.recordAccessFenced();
		successorB.commitCurrent();

		// Assert
		expect(predecessorA.snapshot()).toMatchObject({ state: 'retiring' });
		expect(successorB.snapshot()).toMatchObject({ state: 'current' });
	});

	it('recovers the child barrier after exact retry proves containment and destruction', async () => {
		// Arrange
		const { coordinator, gateway } = beginAttachedGateway();
		const predecessorA = coordinator.admitProvisionalToolVm({
			agentId: 'sun',
			expectedGateway: gateway,
			leafId: 'leaf-a',
		});
		predecessorA.attachToolVm('tool-vm-a');
		predecessorA.commitCurrent();
		predecessorA.beginDestroying();
		predecessorA.recordUnavailable();

		// Act
		predecessorA.beginDestroying();
		predecessorA.recordAccessFenced();
		const sealed = coordinator.sealGatewayEpoch(gateway);
		predecessorA.recordDestroyed();

		// Assert
		await expect(sealed.barrier).resolves.toEqual({
			gatewayEpochId: gateway.gatewayEpochId,
			kind: 'children-destroyed',
		});
		await expect(coordinator.retireGateway(gateway)).resolves.toBeUndefined();
		expect(coordinator.snapshotGateway(gateway)).toMatchObject({
			children: [expect.objectContaining({ leafId: 'leaf-a', state: 'destroyed' })],
			state: 'retired',
		});
	});

	it('requires a Tool VM identity before commit and attaches it only once', () => {
		const { coordinator, gateway } = beginAttachedGateway();
		const child = coordinator.admitProvisionalToolVm({
			agentId: 'sun',
			expectedGateway: gateway,
			leafId: 'leaf-1',
		});

		expect(() => child.commitCurrent()).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'child-vm-not-attached',
			}),
		);
		child.attachToolVm('tool-vm-1');
		expect(() => child.attachToolVm('tool-vm-2')).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'child-vm-already-attached',
			}),
		);
		child.commitCurrent();
		expect(child.snapshot()).toMatchObject({ state: 'current', toolVmId: 'tool-vm-1' });
	});

	it('seals synchronously against a provisioning commit and waits for child destruction', async () => {
		const { coordinator, gateway } = beginAttachedGateway();
		const child = coordinator.admitProvisionalToolVm({
			agentId: 'sun',
			expectedGateway: gateway,
			leafId: 'leaf-1',
		});
		child.attachToolVm('tool-vm-1');

		const sealed = coordinator.sealGatewayEpoch(gateway);
		expect(sealed.childLeafIds).toEqual(['leaf-1']);
		expect(() => child.commitCurrent()).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'gateway-not-admitting',
			}),
		);
		let retired = false;
		const retirement = coordinator.retireGateway(gateway).then(() => {
			retired = true;
		});
		await Promise.resolve();
		expect(retired).toBe(false);

		child.beginDestroying();
		child.recordDestroyed();
		await expect(sealed.barrier).resolves.toEqual({
			gatewayEpochId: gateway.gatewayEpochId,
			kind: 'children-destroyed',
		});
		await retirement;
		expect(retired).toBe(true);
		expect(coordinator.snapshotGateway(gateway).state).toBe('retired');
	});

	it('fails closed when child destruction becomes unavailable', async () => {
		const { coordinator, gateway } = beginAttachedGateway();
		const child = coordinator.admitProvisionalToolVm({
			agentId: 'sun',
			expectedGateway: gateway,
			leafId: 'leaf-1',
		});
		const sealed = coordinator.sealGatewayEpoch(gateway);
		child.beginDestroying();
		child.recordUnavailable();

		await expect(sealed.barrier).rejects.toMatchObject({ code: 'owner-unsafe' });
		await expect(coordinator.retireGateway(gateway)).rejects.toMatchObject({
			code: 'owner-unsafe',
		});
		expect(() => coordinator.resolveGatewayEpoch(gateway)).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'owner-unsafe',
			}),
		);
	});

	it('rejects operations carrying a different full Gateway identity', () => {
		const { coordinator, gateway } = beginAttachedGateway();
		const mismatchedGateway = { ...gateway, gatewayVmId: 'gateway-vm-other' };

		try {
			coordinator.sealGatewayEpoch(mismatchedGateway);
			throw new Error('Expected identity mismatch');
		} catch (error) {
			expectCoordinatorError(error, 'gateway-identity-mismatch');
		}
	});

	it('waits for every retiring predecessor cleanup before retiring the Gateway', async () => {
		const { coordinator, gateway } = beginAttachedGateway();
		const firstChild = coordinator.admitProvisionalToolVm({
			agentId: 'sun',
			expectedGateway: gateway,
			leafId: 'leaf-1',
		});
		const secondChild = coordinator.admitProvisionalToolVm({
			agentId: 'moon',
			expectedGateway: gateway,
			leafId: 'leaf-2',
		});
		coordinator.sealGatewayEpoch(gateway);
		let retired = false;
		const retirement = coordinator.retireGateway(gateway).then(() => {
			retired = true;
		});

		firstChild.beginDestroying();
		firstChild.recordAccessFenced();
		await Promise.resolve();
		expect(retired).toBe(false);
		secondChild.beginDestroying();
		secondChild.recordAccessFenced();
		await Promise.resolve();
		expect(retired).toBe(false);
		firstChild.recordDestroyed();
		await Promise.resolve();
		expect(retired).toBe(false);
		secondChild.recordDestroyed();
		await retirement;
		expect(retired).toBe(true);
		expect(coordinator.snapshotGateway(gateway).children).toEqual([
			expect.objectContaining({ leafId: 'leaf-1', state: 'destroyed' }),
			expect.objectContaining({ leafId: 'leaf-2', state: 'destroyed' }),
		]);
	});
});
