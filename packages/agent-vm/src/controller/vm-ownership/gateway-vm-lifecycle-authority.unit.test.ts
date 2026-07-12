import type { ManagedVm } from '@agent-vm/managed-vm';
import { describe, expect, it, vi } from 'vitest';

import {
	createGatewayOwnershipCoordinator,
	type GatewayOwnershipCoordinatorError,
	type GatewayOwnershipCoordinator,
	type ToolVmMembershipHandle,
} from './gateway-ownership-coordinator.js';
import { createGatewayVmLifecycleAuthority } from './gateway-vm-lifecycle-authority.js';
import type { GatewayEpochIdentity } from './vm-ownership-contracts.js';

interface DeferredPromise<TValue> {
	readonly promise: Promise<TValue>;
	reject(error: unknown): void;
	resolve(value: TValue): void;
}

function createDeferredPromise<TValue>(): DeferredPromise<TValue> {
	let rejectPromise: ((error: unknown) => void) | undefined;
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	return {
		promise,
		reject(error): void {
			rejectPromise?.(error);
		},
		resolve(value): void {
			resolvePromise?.(value);
		},
	};
}

function createCoordinator(): GatewayOwnershipCoordinator {
	return createGatewayOwnershipCoordinator({
		controllerEpoch: 'controller-epoch-1',
		createGatewayEpochId: () => 'gateway-epoch-1',
	});
}

function admitCurrentToolVm(options: {
	readonly agentId: string;
	readonly coordinator: GatewayOwnershipCoordinator;
	readonly gatewayIdentity: GatewayEpochIdentity;
	readonly leafId: string;
	readonly toolVmId: string;
}): ToolVmMembershipHandle {
	const membership = options.coordinator.admitProvisionalToolVm({
		agentId: options.agentId,
		expectedGateway: options.gatewayIdentity,
		leafId: options.leafId,
	});
	membership.attachToolVm(options.toolVmId);
	membership.commitCurrent();
	return membership;
}

describe('Gateway VM lifecycle authority', () => {
	it('allocates a Gateway seed before construction and attaches the stock VM identity once', () => {
		const coordinator = createCoordinator();
		const authority = createGatewayVmLifecycleAuthority({
			bootId: 'boot-1',
			destroyGatewayOwnedLeases: async () => {},
			generationId: 'generation-1',
			ownershipCoordinator: coordinator,
			zoneId: 'openclaw',
		});

		expect(authority.gatewayIdentity).toBeUndefined();
		expect(authority.gatewaySeed).toEqual({
			bootId: 'boot-1',
			controllerEpoch: 'controller-epoch-1',
			gatewayEpochId: 'gateway-epoch-1',
			generationId: 'generation-1',
			zoneId: 'openclaw',
		});
		const identity = authority.attachGatewayVm('gateway-vm-1');
		expect(identity).toEqual({ ...authority.gatewaySeed, gatewayVmId: 'gateway-vm-1' });
		expect(authority.gatewayIdentity).toEqual(identity);
		expect(() => authority.attachGatewayVm('gateway-vm-2')).toThrowError(
			expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
				code: 'gateway-already-attached',
			}),
		);
	});

	it('contains one late unstarted create through the supplied cleanup boundary', async () => {
		const coordinator = createCoordinator();
		const authority = createGatewayVmLifecycleAuthority({
			bootId: 'boot-1',
			destroyGatewayOwnedLeases: async () => {},
			generationId: 'generation-1',
			ownershipCoordinator: coordinator,
			zoneId: 'openclaw',
		});
		const pendingCreate = createDeferredPromise<ManagedVm>();
		const close = vi.fn(async () => {});
		/* oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript-eslint/no-unsafe-type-assertion -- the containment boundary only preserves and forwards the unresolved stock VM handle. */
		const unstartedVm = {
			close,
			getHostProcessId: () => null,
			id: 'late-gateway-vm',
		} as unknown as ManagedVm;
		const closeLateCreatedVm = vi.fn(async (createdVm: ManagedVm) => {
			expect(createdVm.getHostProcessId()).toBeNull();
			await createdVm.close();
		});

		const containment = authority.containPendingCreate({
			closeLateCreatedVm,
			pendingCreate: pendingCreate.promise,
		});
		expect(closeLateCreatedVm).not.toHaveBeenCalled();
		pendingCreate.resolve(unstartedVm);
		await containment;

		expect(closeLateCreatedVm).toHaveBeenCalledOnce();
		expect(closeLateCreatedVm).toHaveBeenCalledWith(unstartedVm);
		expect(close).toHaveBeenCalledOnce();
	});

	it('seals admission and destroys every child before the Gateway and retirement', async () => {
		const coordinator = createCoordinator();
		const destructionOrder: string[] = [];
		const childMembershipRef: { current?: ToolVmMembershipHandle } = {};
		const authority = createGatewayVmLifecycleAuthority({
			bootId: 'boot-1',
			destroyGatewayOwnedLeases: async (gatewayIdentity) => {
				destructionOrder.push('destroy-tool');
				expect(() =>
					coordinator.admitProvisionalToolVm({
						agentId: 'late-agent',
						expectedGateway: gatewayIdentity,
						leafId: 'late-leaf',
					}),
				).toThrowError(
					expect.objectContaining<Partial<GatewayOwnershipCoordinatorError>>({
						code: 'gateway-not-admitting',
					}),
				);
				childMembershipRef.current?.beginDestroying();
				childMembershipRef.current?.recordDestroyed();
			},
			generationId: 'generation-1',
			ownershipCoordinator: coordinator,
			zoneId: 'openclaw',
		});
		const gatewayIdentity = authority.attachGatewayVm('gateway-vm-1');
		childMembershipRef.current = admitCurrentToolVm({
			agentId: 'agent-1',
			coordinator,
			gatewayIdentity,
			leafId: 'leaf-1',
			toolVmId: 'tool-vm-1',
		});

		await authority.destroyLive(async () => {
			destructionOrder.push('destroy-gateway');
			expect(coordinator.snapshotGateway(gatewayIdentity).state).toBe('sealed');
		});

		expect(destructionOrder).toEqual(['destroy-tool', 'destroy-gateway']);
		expect(coordinator.snapshotGateway(gatewayIdentity).state).toBe('retired');
	});

	it('retires only after the exact Gateway termination operation succeeds', async () => {
		const coordinator = createCoordinator();
		const gatewayTermination = createDeferredPromise<void>();
		const authority = createGatewayVmLifecycleAuthority({
			bootId: 'boot-1',
			destroyGatewayOwnedLeases: async () => {},
			generationId: 'generation-1',
			ownershipCoordinator: coordinator,
			zoneId: 'openclaw',
		});
		const gatewayIdentity = authority.attachGatewayVm('gateway-vm-1');
		const destruction = authority.destroyLive(async () => await gatewayTermination.promise);
		await vi.waitFor(() => {
			expect(coordinator.snapshotGateway(gatewayIdentity).state).toBe('sealed');
		});

		gatewayTermination.resolve();
		await destruction;

		expect(coordinator.snapshotGateway(gatewayIdentity).state).toBe('retired');
	});

	it('fails closed with retained identity when exact Gateway termination is unavailable', async () => {
		const coordinator = createCoordinator();
		const exactGatewayTermination = vi.fn(async () => {
			throw new Error('recorded Gateway process still reports the runner');
		});
		const authority = createGatewayVmLifecycleAuthority({
			bootId: 'boot-1',
			destroyGatewayOwnedLeases: async () => {},
			generationId: 'generation-1',
			ownershipCoordinator: coordinator,
			zoneId: 'openclaw',
		});
		const gatewayIdentity = authority.attachGatewayVm('gateway-vm-1');

		await expect(authority.destroyLive(exactGatewayTermination)).rejects.toThrow(
			'recorded Gateway process still reports the runner',
		);

		expect(exactGatewayTermination).toHaveBeenCalledOnce();
		expect(authority.gatewayIdentity).toEqual(gatewayIdentity);
		expect(coordinator.snapshotGateway(gatewayIdentity).state).toBe('owner-unsafe');
		await expect(authority.destroyLive(exactGatewayTermination)).rejects.toMatchObject({
			code: 'owner-unsafe',
		});
		expect(exactGatewayTermination).toHaveBeenCalledOnce();
	});

	it('delegates live destruction without directly receiving or closing a stock VM handle', async () => {
		const coordinator = createCoordinator();
		const stockClose = vi.fn(async () => {});
		let runnerAttached = true;
		const terminateExactGateway = vi.fn(async () => {
			expect(runnerAttached).toBe(true);
			expect(stockClose).not.toHaveBeenCalled();
			runnerAttached = false;
			await stockClose();
		});
		const authority = createGatewayVmLifecycleAuthority({
			bootId: 'boot-1',
			destroyGatewayOwnedLeases: async () => {},
			generationId: 'generation-1',
			ownershipCoordinator: coordinator,
			zoneId: 'openclaw',
		});
		authority.attachGatewayVm('gateway-vm-1');

		await authority.destroyLive(terminateExactGateway);

		expect(terminateExactGateway).toHaveBeenCalledOnce();
		expect(runnerAttached).toBe(false);
		expect(stockClose).toHaveBeenCalledOnce();
	});
});
