import type {
	GatewayControlToolVmBindingAccessGrant,
	GatewayControlToolVmBindingPublication,
	GatewayControlToolVmBindingPublicationAuthority,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import { createGatewayControlBindingPublicationCoordinator } from './gateway-control-binding-publication.js';
import type { GatewayControlTrustedCallerContext } from './gateway-control-caller-context.js';

const stablePrincipal = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const authority: GatewayControlToolVmBindingPublicationAuthority = {
	attachmentGeneration: 3,
	connectionId: '11111111-1111-4111-8111-111111111111',
	controllerEpoch: 'controller-epoch-a',
	gatewayEpoch: 'gateway-epoch-a',
	processEpoch: 'process-epoch-a',
	sessionId: '33333333-3333-4333-8333-333333333333',
	zoneId: 'zone-a',
};
const gateway: GatewayEpochIdentity = {
	bootId: 'boot-a',
	controllerEpoch: authority.controllerEpoch,
	gatewayEpochId: authority.gatewayEpoch,
	gatewayVmId: 'gateway-vm-a',
	generationId: 'generation-a',
	zoneId: authority.zoneId,
};
const callerContext: GatewayControlTrustedCallerContext = {
	agentId: 'agent-a',
	bootId: authority.processEpoch,
	callerContextId: '44444444-4444-4444-8444-444444444444',
	connectionId: authority.connectionId,
	controllerEpoch: authority.controllerEpoch,
	peerId: 'gateway-zone-a',
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'assignment-a',
		toolPortalProfileId: 'profile-a',
	},
	purpose: 'tool_vm_lease',
	sessionId: authority.sessionId,
	stablePrincipal,
	zoneId: authority.zoneId,
};

function binding(leaseId = 'lease-a'): GatewayControlToolVmBindingAccessGrant {
	return {
		agentId: callerContext.agentId,
		idleTtlMs: 60_000,
		leafGeneration: `leaf-${leaseId}`,
		leaseId,
		profileAssignmentRevision: callerContext.principal.profileAssignmentRevision,
		ssh: {
			host: 'tool-0.vm.host',
			identityPem: 'private-key',
			knownHostsLine: 'tool-0.vm.host ssh-ed25519 AAAA',
			port: 22,
			user: 'root',
		},
		sshBindingId: `ssh-${leaseId}`,
		stablePrincipal,
		tcpSlot: 0,
		transport: 'ssh-sandbox',
		workdir: '/work',
		zoneId: authority.zoneId,
	};
}

function deferred<TValue>(): {
	readonly promise: Promise<TValue>;
	readonly resolve: (value: TValue) => void;
} {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value: TValue): void => {
			if (resolvePromise === undefined) throw new Error('Deferred promise is not initialized.');
			resolvePromise(value);
		},
	};
}

describe('Gateway control binding publication coordinator', () => {
	it('coalesces same-agent demand and publishes an active-use-free exact grant once', async () => {
		const createBinding = vi.fn(async () => binding());
		const publications: GatewayControlToolVmBindingPublication[] = [];
		const publish = vi.fn(async (publication: GatewayControlToolVmBindingPublication) => {
			publications.push(publication);
		});
		const coordinator = createGatewayControlBindingPublicationCoordinator({
			createBinding,
			now: () => 1_000,
			publish,
			readCurrentAuthority: () => authority,
		});
		const request = {
			authority,
			callerContext,
			gateway,
			payload: { callerContext: { callerContextId: callerContext.callerContextId } },
		} as const;

		const [first, second] = await Promise.all([
			coordinator.requestBinding(request),
			coordinator.requestBinding(request),
		]);

		expect(first).toEqual(second);
		expect(createBinding).toHaveBeenCalledOnce();
		expect(publish).toHaveBeenCalledOnce();
		expect(publications[0]).not.toHaveProperty('binding.activeUseId');
	});

	it('fences stale session authority before creating or publishing', async () => {
		const createBinding = vi.fn(async () => binding());
		const publish = vi.fn(async (_publication: GatewayControlToolVmBindingPublication) => {});
		const coordinator = createGatewayControlBindingPublicationCoordinator({
			createBinding,
			publish,
			readCurrentAuthority: () => ({ ...authority, attachmentGeneration: 4 }),
		});

		await expect(
			coordinator.requestBinding({
				authority,
				callerContext,
				gateway,
				payload: { callerContext: { callerContextId: callerContext.callerContextId } },
			}),
		).rejects.toThrow(/authority is stale/iu);
		expect(createBinding).not.toHaveBeenCalled();
		expect(publish).not.toHaveBeenCalled();
	});

	it('revalidates exact session authority after asynchronous binding creation', async () => {
		let currentAuthority = authority;
		const createBinding = vi.fn(async () => {
			currentAuthority = { ...authority, attachmentGeneration: 4 };
			return binding();
		});
		const publish = vi.fn(async (_publication: GatewayControlToolVmBindingPublication) => {});
		const coordinator = createGatewayControlBindingPublicationCoordinator({
			createBinding,
			publish,
			readCurrentAuthority: () => currentAuthority,
		});

		await expect(
			coordinator.requestBinding({
				authority,
				callerContext,
				gateway,
				payload: { callerContext: { callerContextId: callerContext.callerContextId } },
			}),
		).rejects.toThrow(/authority is stale/iu);
		expect(createBinding).toHaveBeenCalledOnce();
		expect(publish).not.toHaveBeenCalled();
	});

	it('does not coalesce demand across attachment authority generations', async () => {
		let currentAuthority = authority;
		const firstBinding = deferred<GatewayControlToolVmBindingAccessGrant>();
		const createBinding = vi
			.fn<() => Promise<GatewayControlToolVmBindingAccessGrant>>()
			.mockImplementationOnce(async () => await firstBinding.promise)
			.mockImplementationOnce(async () => binding('lease-b'));
		const publish = vi.fn(async (_publication: GatewayControlToolVmBindingPublication) => {});
		const coordinator = createGatewayControlBindingPublicationCoordinator({
			createBinding,
			publish,
			readCurrentAuthority: () => currentAuthority,
		});
		const firstRequest = coordinator.requestBinding({
			authority,
			callerContext,
			gateway,
			payload: { callerContext: { callerContextId: callerContext.callerContextId } },
		});
		const successorAuthority = { ...authority, attachmentGeneration: 4 };
		currentAuthority = successorAuthority;

		const successorResult = await coordinator.requestBinding({
			authority: successorAuthority,
			callerContext,
			gateway,
			payload: { callerContext: { callerContextId: callerContext.callerContextId } },
		});
		firstBinding.resolve(binding());

		expect(successorResult).toMatchObject({ agentId: 'agent-a', status: 'publication_pending' });
		await expect(firstRequest).rejects.toThrow(/authority is stale/iu);
		expect(createBinding).toHaveBeenCalledTimes(2);
		expect(publish).toHaveBeenCalledOnce();
	});

	it('rejects a grant for a different profile assignment revision', async () => {
		const createBinding = vi.fn(async () => ({
			...binding(),
			profileAssignmentRevision: 'assignment-b',
		}));
		const publish = vi.fn(async (_publication: GatewayControlToolVmBindingPublication) => {});
		const coordinator = createGatewayControlBindingPublicationCoordinator({
			createBinding,
			publish,
			readCurrentAuthority: () => authority,
		});

		await expect(
			coordinator.requestBinding({
				authority,
				callerContext,
				gateway,
				payload: { callerContext: { callerContextId: callerContext.callerContextId } },
			}),
		).rejects.toThrow(/does not match its requested agent/iu);
		expect(publish).not.toHaveBeenCalled();
	});

	it('retires only the exact published binding and tombstones replacements before successors', async () => {
		let nextBinding = binding();
		const publications: GatewayControlToolVmBindingPublication[] = [];
		const publish = vi.fn(async (publication: GatewayControlToolVmBindingPublication) => {
			publications.push(publication);
		});
		const coordinator = createGatewayControlBindingPublicationCoordinator({
			createBinding: async () => nextBinding,
			now: () => 1_000,
			publish,
			readCurrentAuthority: () => authority,
		});
		const request = {
			authority,
			callerContext,
			gateway,
			payload: { callerContext: { callerContextId: callerContext.callerContextId } },
		} as const;
		await coordinator.requestBinding(request);
		nextBinding = binding('lease-b');
		await coordinator.requestBinding(request);

		expect(publications.map((publication) => publication.kind)).toEqual([
			'current',
			'retired',
			'current',
		]);
		await coordinator.retireBinding({
			authority,
			leaseId: 'lease-a',
			reason: 'released',
		});
		expect(publish).toHaveBeenCalledTimes(3);
		await coordinator.retireBinding({
			authority,
			leaseId: nextBinding.leaseId,
			reason: 'released',
		});
		expect(publications.at(-1)).toMatchObject({
			binding: { leaseId: 'lease-b' },
			kind: 'retired',
			reason: 'released',
		});
	});

	it('does not erase successor tracking when predecessor retirement publication is delayed', async () => {
		let nextBinding = binding();
		const delayedRetirement = deferred<void>();
		const publications: GatewayControlToolVmBindingPublication[] = [];
		const publish = vi.fn(async (publication: GatewayControlToolVmBindingPublication) => {
			publications.push(publication);
			if (publication.kind === 'retired' && publication.reason === 'released') {
				await delayedRetirement.promise;
			}
		});
		const coordinator = createGatewayControlBindingPublicationCoordinator({
			createBinding: async () => nextBinding,
			publish,
			readCurrentAuthority: () => authority,
		});
		const request = {
			authority,
			callerContext,
			gateway,
			payload: { callerContext: { callerContextId: callerContext.callerContextId } },
		} as const;
		await coordinator.requestBinding(request);
		const predecessorRetirement = coordinator.retireBinding({
			authority,
			leaseId: nextBinding.leaseId,
			reason: 'released',
		});
		nextBinding = binding('lease-b');
		await coordinator.requestBinding(request);
		delayedRetirement.resolve(undefined);
		await predecessorRetirement;

		await coordinator.retireBinding({
			authority,
			leaseId: nextBinding.leaseId,
			reason: 'released',
		});
		delayedRetirement.resolve(undefined);

		expect(publications.at(-1)).toMatchObject({
			binding: { leaseId: 'lease-b' },
			kind: 'retired',
			reason: 'released',
		});
	});
});
