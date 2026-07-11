import type {
	ManagedVmDestroyReceiptV1,
	ManagedVmDestroyTargetV1,
} from '@agent-vm/gondolin-adapter';
import { describe, expect, it, vi } from 'vitest';

import { createToolVmLeaseAuthorityRuntime } from './tool-vm-lease-authority-runtime.js';
import {
	COMPATIBILITY,
	createAuthority,
	createDeferred,
	createLease,
	createMatchingDestroyReceipt,
	createOwnershipHandle,
	createVerifiedDestroyTarget,
	expectTransitionError,
	GATEWAY_ONE,
	GATEWAY_TWO,
	PRINCIPAL_MAIN,
	PRINCIPAL_SIBLING,
	RUNTIME_BINDING,
	SSH_BINDING,
	type TestLease,
} from './tool-vm-lease-authority-runtime.test-helpers.js';

describe('createToolVmLeaseAuthorityRuntime destruction', () => {
	it('commits, resolves, and touches a lease only under its exact Gateway', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		const verifiedDestroyTarget = createVerifiedDestroyTarget();
		const commitCurrent = vi.fn(async () => {});
		const ownership = createOwnershipHandle(verifiedDestroyTarget, { commitCurrent });
		runtime.registerGateway(GATEWAY_ONE);
		runtime.registerGateway(GATEWAY_TWO);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: lease.idleExpiresAtMs,
			ownership,
		});
		await runtime.commitCurrent({
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});

		const touchedLease = runtime.touchLease(authority, 5_000, 20_000, (currentLease) => ({
			...currentLease,
			idleExpiresAtMs: 20_000,
		}));

		expect(commitCurrent).toHaveBeenCalledOnce();
		expect(runtime.getLease(lease.id)).toBe(touchedLease);
		expect(runtime.listLeases()).toEqual([touchedLease]);
		expect(
			runtime.findCurrentLeaseByPrincipal({ gateway: GATEWAY_ONE, principal: PRINCIPAL_MAIN }),
		).toBe(touchedLease);
		expect(
			runtime.findCurrentLeaseByPrincipal({ gateway: GATEWAY_TWO, principal: PRINCIPAL_MAIN }),
		).toBeUndefined();
	});

	it('single-flights destruction and removes resources only after the exact receipt', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		const target = createVerifiedDestroyTarget();
		const destroyReceipt = createDeferred<ManagedVmDestroyReceiptV1>();
		const destroyDetached = vi.fn(() => destroyReceipt.promise);
		const ownership = createOwnershipHandle(target, { destroyDetached });
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: lease.idleExpiresAtMs,
			ownership,
		});
		await runtime.commitCurrent({
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});

		const firstAttempt = runtime.destroyExact({
			authority,
			destroyedAtMs: 30_000,
			mode: { kind: 'detached' },
			reason: 'lease-release',
		});
		const secondAttempt = runtime.destroyExact({
			authority,
			destroyedAtMs: 30_000,
			mode: { kind: 'detached' },
			reason: 'lease-release',
		});

		expect(secondAttempt).toBe(firstAttempt);
		expect(destroyDetached).toHaveBeenCalledOnce();
		expect(runtime.getLease(lease.id)).toBeUndefined();
		destroyReceipt.resolve(createMatchingDestroyReceipt(target));
		expect(await firstAttempt).toMatchObject({ authority, lease, ownership });
		expect(runtime.listLeases()).toEqual([]);
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
	});

	it.each([
		{
			name: 'mismatched',
			receiptFor: (target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 => ({
				...createMatchingDestroyReceipt(target),
				reservationId: 'reservation-other',
			}),
		},
		{
			name: 'incomplete',
			receiptFor: (target: ManagedVmDestroyTargetV1): ManagedVmDestroyReceiptV1 => ({
				...createMatchingDestroyReceipt(target),
				complete: false,
			}),
		},
	])('retains owner-unsafe resources after a $name receipt', async ({ receiptFor }) => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		const target = createVerifiedDestroyTarget();
		const destroyDetached = vi.fn(async () => receiptFor(target));
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: lease.idleExpiresAtMs,
			ownership: createOwnershipHandle(target, { destroyDetached }),
		});
		await runtime.commitCurrent({
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});

		await expect(
			runtime.destroyExact({
				authority,
				destroyedAtMs: 30_000,
				mode: { kind: 'detached' },
				reason: 'lease-release',
			}),
		).rejects.toThrow(/destruction receipt|exact VM destruction/iu);
		expect(runtime.getLease(lease.id)).toBeUndefined();
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([lease.id]);
		await expect(
			runtime.destroyExact({
				authority,
				destroyedAtMs: 31_000,
				mode: { kind: 'detached' },
				reason: 'explicit-exact-retry',
			}),
		).rejects.toThrow(/destruction receipt|exact VM destruction/iu);
		expect(destroyDetached).toHaveBeenCalledTimes(2);
	});

	it('reserves the final tombstone slot before concurrent destruction', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>({
			retentionPolicy: { maxLeafTombstones: 1 },
		});
		const firstAuthority = createAuthority();
		const secondAuthority = createAuthority({
			leaseId: 'lease-2',
			leafGeneration: 'leaf-generation-2',
			principal: PRINCIPAL_SIBLING,
		});
		const firstTarget = createVerifiedDestroyTarget();
		const secondTarget = createVerifiedDestroyTarget('tool-vm-2');
		const firstReceipt = createDeferred<ManagedVmDestroyReceiptV1>();
		const destroyFirst = vi.fn(() => firstReceipt.promise);
		const destroySecond = vi.fn(async () => createMatchingDestroyReceipt(secondTarget));
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority: firstAuthority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
			ownership: createOwnershipHandle(firstTarget, { destroyDetached: destroyFirst }),
		});
		await runtime.beginProvisioning({
			authority: secondAuthority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
			ownership: createOwnershipHandle(secondTarget, { destroyDetached: destroySecond }),
		});

		const firstDestruction = runtime.destroyExact({
			authority: firstAuthority,
			destroyedAtMs: 30_000,
			mode: { kind: 'detached' },
			reason: 'first-destruction',
		});
		await expectTransitionError(
			() =>
				runtime.destroyExact({
					authority: secondAuthority,
					destroyedAtMs: 30_000,
					mode: { kind: 'detached' },
					reason: 'second-destruction',
				}),
			'tombstone-capacity-exhausted',
		);
		expect(destroySecond).not.toHaveBeenCalled();
		firstReceipt.resolve(createMatchingDestroyReceipt(firstTarget));
		await firstDestruction;
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([secondAuthority.leaseId]);
	});

	it('retires a sealed Gateway only after every leaf is disposed', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const target = createVerifiedDestroyTarget();
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
			ownership: createOwnershipHandle(target),
		});
		runtime.sealGateway(GATEWAY_ONE);
		await expectTransitionError(() => runtime.retireGateway(GATEWAY_ONE), 'parent-has-live-leaves');
		await expectTransitionError(() => runtime.retireGateway(GATEWAY_TWO), 'parent-unregistered');
		await runtime.destroyExact({
			authority,
			destroyedAtMs: 40_000,
			mode: { kind: 'detached' },
			reason: 'gateway-replacement',
		});
		runtime.retireGateway(GATEWAY_ONE);
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
	});
});
