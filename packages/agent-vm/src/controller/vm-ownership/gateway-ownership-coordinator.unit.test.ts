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
		zoneId: 'openclaw',
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
	it('creates a seed before attaching the stock Gondolin VM identity exactly once', () => {
		const coordinator = createCoordinator();
		const handle = coordinator.beginGatewayEpoch({
			bootId: 'boot-1',
			generationId: 'generation-1',
			zoneId: 'openclaw',
		});

		expect(handle.seed).toEqual({
			bootId: 'boot-1',
			controllerEpoch: 'controller-epoch-1',
			gatewayEpochId: 'gateway-epoch-1',
			generationId: 'generation-1',
			zoneId: 'openclaw',
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
			zoneId: 'openclaw',
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

	it('enforces one active Tool VM leaf per stable agent', () => {
		const { coordinator, gateway } = beginAttachedGateway();
		coordinator.admitProvisionalToolVm({
			agentId: 'sun',
			expectedGateway: gateway,
			leafId: 'leaf-1',
		});

		expect(() =>
			coordinator.admitProvisionalToolVm({
				agentId: 'sun',
				expectedGateway: gateway,
				leafId: 'leaf-2',
			}),
		).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'agent-already-admitted',
			}),
		);
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

	it('never makes the Gateway ready to retire before all children are destroyed', async () => {
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
		firstChild.recordDestroyed();
		await Promise.resolve();
		expect(retired).toBe(false);
		secondChild.beginDestroying();
		secondChild.recordDestroyed();
		await retirement;
		expect(retired).toBe(true);
	});
});
