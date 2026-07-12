import { describe, expect, it, vi } from 'vitest';

import { createToolVmLeaseAuthorityRuntime } from './tool-vm-lease-authority-runtime.js';
import {
	COMPATIBILITY,
	GATEWAY_ONE,
	PRINCIPAL_SIBLING,
	RUNTIME_BINDING,
	SSH_BINDING,
	createAuthority,
	createDeferred,
	createLease,
	expectTransitionError,
	type TestLease,
} from './tool-vm-lease-authority-runtime.test-helpers.js';

async function createCurrentRuntime(): Promise<{
	readonly authority: ReturnType<typeof createAuthority>;
	readonly runtime: ReturnType<typeof createToolVmLeaseAuthorityRuntime<TestLease>>;
}> {
	const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
	const authority = createAuthority();
	runtime.registerGateway(GATEWAY_ONE);
	runtime.beginProvisioning({ authority, compatibility: COMPATIBILITY, idleExpiresAtMs: 10_000 });
	await runtime.commitCurrent({
		authority,
		lease: createLease(),
		runtimeBinding: RUNTIME_BINDING,
		sshBinding: SSH_BINDING,
	});
	return { authority, runtime };
}

describe('createToolVmLeaseAuthorityRuntime destruction', () => {
	it('single-flights destruction and removes authority only after callback completion', async () => {
		const { authority, runtime } = await createCurrentRuntime();
		const callbackCompletion = createDeferred<void>();
		const destroy = vi.fn(() => callbackCompletion.promise);

		const first = runtime.destroyExact({
			authority,
			destroy,
			destroyedAtMs: 20_000,
			reason: 'idle',
		});
		const second = runtime.destroyExact({
			authority,
			destroy,
			destroyedAtMs: 20_000,
			reason: 'idle',
		});
		expect(runtime.getLease(authority.leaseId)).toBeUndefined();
		expect(runtime.authorityForLease(authority.leaseId)).toEqual(authority);
		expect(runtime.leafSnapshotForLease(authority.leaseId)).toMatchObject({ kind: 'destroying' });

		callbackCompletion.resolve();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(destroy).toHaveBeenCalledOnce();
		expect(runtime.authorityForLease(authority.leaseId)).toBeUndefined();
	});

	it('retains owner-unsafe authority after callback failure and admits one retry', async () => {
		const { authority, runtime } = await createCurrentRuntime();
		const firstFailure = new Error('controller cleanup failed');
		const firstDestroy = vi.fn(async () => {
			throw firstFailure;
		});

		await expect(
			runtime.destroyExact({
				authority,
				destroy: firstDestroy,
				destroyedAtMs: 20_000,
				reason: 'idle',
			}),
		).rejects.toBe(firstFailure);
		expect(runtime.leafSnapshotForLease(authority.leaseId)).toMatchObject({
			kind: 'owner-unsafe',
			ownerUnsafeReason: 'controller-destruction-failed',
		});
		const retryDestroy = vi.fn(async () => {});
		await runtime.destroyExact({
			authority,
			destroy: retryDestroy,
			destroyedAtMs: 21_000,
			reason: 'retry',
		});
		expect(firstDestroy).toHaveBeenCalledOnce();
		expect(retryDestroy).toHaveBeenCalledOnce();
		expect(runtime.authorityForLease(authority.leaseId)).toBeUndefined();
	});

	it('tombstones a provisioning leaf after controller cleanup without invented VM identity', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const destroy = vi.fn(async () => {});
		runtime.registerGateway(GATEWAY_ONE);
		runtime.beginProvisioning({ authority, compatibility: COMPATIBILITY, idleExpiresAtMs: 10_000 });

		await runtime.destroyExact({
			authority,
			destroy,
			destroyedAtMs: 20_000,
			reason: 'provisioning',
		});

		expect(destroy).toHaveBeenCalledOnce();
		expect(runtime.authorityForLease(authority.leaseId)).toBeUndefined();
		expect(() =>
			runtime.beginProvisioning({
				authority,
				compatibility: COMPATIBILITY,
				idleExpiresAtMs: 30_000,
			}),
		).toThrow(/already used/iu);
	});

	it('reserves the final tombstone slot before concurrent callbacks settle', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>({
			retentionPolicy: { maxLeafTombstones: 1 },
		});
		const firstAuthority = createAuthority();
		const secondAuthority = createAuthority({
			leaseId: 'lease-2',
			leafGeneration: 'leaf-generation-2',
			principal: PRINCIPAL_SIBLING,
		});
		runtime.registerGateway(GATEWAY_ONE);
		for (const authority of [firstAuthority, secondAuthority]) {
			runtime.beginProvisioning({
				authority,
				compatibility: COMPATIBILITY,
				idleExpiresAtMs: 10_000,
			});
		}
		const firstCompletion = createDeferred<void>();
		const first = runtime.destroyExact({
			authority: firstAuthority,
			destroy: () => firstCompletion.promise,
			destroyedAtMs: 20_000,
			reason: 'first',
		});

		await expectTransitionError(
			() =>
				runtime.destroyExact({
					authority: secondAuthority,
					destroy: async () => {},
					destroyedAtMs: 20_000,
					reason: 'second',
				}),
			'tombstone-capacity-exhausted',
		);
		firstCompletion.resolve();
		await first;
	});

	it('retains Gateway parent until all controller-owned leaves are disposed', async () => {
		const { authority, runtime } = await createCurrentRuntime();
		runtime.sealGateway(GATEWAY_ONE);
		await expectTransitionError(() => runtime.retireGateway(GATEWAY_ONE), 'parent-has-live-leaves');

		await runtime.destroyExact({
			authority,
			destroy: async () => {},
			destroyedAtMs: 20_000,
			reason: 'shutdown',
		});
		expect(() => runtime.retireGateway(GATEWAY_ONE)).not.toThrow();
	});
});
