import { describe, expect, it, vi } from 'vitest';

import { createToolVmLeaseAuthorityRuntime } from './tool-vm-lease-authority-runtime.js';
import {
	COMPATIBILITY,
	GATEWAY_ONE,
	RUNTIME_BINDING,
	SSH_BINDING,
	createAuthority,
	createDeferred,
	createLease,
	type TestLease,
} from './tool-vm-lease-authority-runtime.test-helpers.js';

async function createCurrentRuntime(lease: TestLease = createLease()): Promise<{
	readonly authority: ReturnType<typeof createAuthority>;
	readonly runtime: ReturnType<typeof createToolVmLeaseAuthorityRuntime<TestLease>>;
}> {
	const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
	const authority = createAuthority();
	runtime.registerGateway(GATEWAY_ONE);
	runtime.beginProvisioning({ authority, compatibility: COMPATIBILITY, idleExpiresAtMs: 10_000 });
	await runtime.commitCurrent({
		authority,
		lease,
		runtimeBinding: RUNTIME_BINDING,
		sshBinding: SSH_BINDING,
	});
	return { authority, runtime };
}

describe('Tool VM lease authority destruction admission', () => {
	it('blocks policy destruction while reducer-owned active work exists', async () => {
		const { authority, runtime } = await createCurrentRuntime();
		runtime.applyAuthorityCommand({
			authority,
			kind: 'start-active-use',
			use: {
				lastHeartbeatAtMs: 1_000,
				operationPayloadDigest: 'digest',
				processEpoch: 'process-1',
				semanticOperationId: 'operation-1',
				sessionAttachmentGeneration: 1,
				startedAtMs: 1_000,
				useId: 'use-1',
			},
		});
		const destroy = vi.fn(async () => {});

		expect(
			runtime.admitExactDestruction({
				authority,
				destroy,
				destroyedAtMs: 2_000,
				policy: { kind: 'require-no-active-use' },
				reason: 'idle',
			}),
		).toEqual({ kind: 'blocked-active-use' });
		expect(destroy).not.toHaveBeenCalled();
	});

	it('skips conditional destruction after a more recent lease use', async () => {
		const { authority, runtime } = await createCurrentRuntime(createLease({ lastUsedAt: 2_000 }));
		const destroy = vi.fn(async () => {});

		expect(
			runtime.admitExactDestruction({
				authority,
				destroy,
				destroyedAtMs: 3_000,
				policy: { ifLastUsedAtBeforeOrAt: 1_999, kind: 'require-no-active-use' },
				reason: 'idle',
			}),
		).toEqual({ kind: 'skip-recently-used' });
		expect(destroy).not.toHaveBeenCalled();
	});

	it('force-admits destruction while active work exists', async () => {
		const { authority, runtime } = await createCurrentRuntime();
		runtime.applyAuthorityCommand({
			authority,
			kind: 'start-active-use',
			use: {
				lastHeartbeatAtMs: 1_000,
				operationPayloadDigest: 'digest',
				processEpoch: 'process-1',
				semanticOperationId: 'operation-1',
				sessionAttachmentGeneration: 1,
				startedAtMs: 1_000,
				useId: 'use-1',
			},
		});
		const destroy = vi.fn(async () => {});

		const admitted = runtime.admitExactDestruction({
			authority,
			destroy,
			destroyedAtMs: 2_000,
			policy: { kind: 'force' },
			reason: 'gateway-lost',
		});
		expect(admitted.kind).toBe('started');
		if (admitted.kind === 'started') await admitted.completion;
		expect(destroy).toHaveBeenCalledOnce();
	});

	it('shares one callback completion across duplicate admitted calls', async () => {
		const { authority, runtime } = await createCurrentRuntime();
		const deferred = createDeferred<void>();
		const destroy = vi.fn(() => deferred.promise);
		const options = {
			authority,
			destroy,
			destroyedAtMs: 2_000,
			policy: { kind: 'force' } as const,
			reason: 'gateway-lost',
		};

		const first = runtime.admitExactDestruction(options);
		const second = runtime.admitExactDestruction(options);
		expect(first.kind).toBe('started');
		expect(second.kind).toBe('started');
		if (first.kind !== 'started' || second.kind !== 'started') throw new Error('not admitted');
		expect(first.completion).toBe(second.completion);
		deferred.resolve();
		await Promise.all([first.completion, second.completion]);
		expect(destroy).toHaveBeenCalledOnce();
	});

	it('retains owner-unsafe authority after callback failure and admits forced retry', async () => {
		const { authority, runtime } = await createCurrentRuntime();
		const failure = new Error('cleanup failed');
		const first = runtime.admitExactDestruction({
			authority,
			destroy: async () => {
				throw failure;
			},
			destroyedAtMs: 2_000,
			policy: { kind: 'force' },
			reason: 'gateway-lost',
		});
		if (first.kind !== 'started') throw new Error('not admitted');
		await expect(first.completion).rejects.toBe(failure);
		expect(runtime.leafSnapshotForLease(authority.leaseId)).toMatchObject({ kind: 'owner-unsafe' });

		const retryDestroy = vi.fn(async () => {});
		const retry = runtime.admitExactDestruction({
			authority,
			destroy: retryDestroy,
			destroyedAtMs: 3_000,
			policy: { kind: 'force' },
			reason: 'retry',
		});
		if (retry.kind !== 'started') throw new Error('retry not admitted');
		await retry.completion;
		expect(retryDestroy).toHaveBeenCalledOnce();
	});
});
