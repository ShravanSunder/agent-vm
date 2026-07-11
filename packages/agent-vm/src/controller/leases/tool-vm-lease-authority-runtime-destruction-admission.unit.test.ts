import type { ManagedVmDestroyReceiptV1 } from '@agent-vm/gondolin-adapter';
import { describe, expect, it, vi } from 'vitest';

import type { ProvisionalToolVmOwnershipHandle } from '../vm-ownership/gateway-ownership-coordinator.js';
import { createToolVmLeaseAuthorityRuntime } from './tool-vm-lease-authority-runtime.js';
import {
	COMPATIBILITY,
	createAuthority,
	createDeferred,
	createLease,
	createMatchingDestroyReceipt,
	createOwnershipHandle,
	createVerifiedDestroyTarget,
	GATEWAY_ONE,
	PRINCIPAL_MAIN,
	RUNTIME_BINDING,
	SSH_BINDING,
	type TestLease,
} from './tool-vm-lease-authority-runtime.test-helpers.js';
import type { ToolVmLeaseAuthorityCommand } from './tool-vm-lease-authority-state.js';

interface AdmissionTestLease extends TestLease {
	readonly lastUsedAt: number;
}

const PROCESS_EPOCH = 'process-epoch-1';
const SESSION_ATTACHMENT_GENERATION = 1;

function createAdmissionLease(overrides: Partial<AdmissionTestLease> = {}): AdmissionTestLease {
	return {
		...createLease(),
		lastUsedAt: 1_000,
		...overrides,
	};
}

function startActiveUseCommand(
	authority: ReturnType<typeof createAuthority>,
): Extract<ToolVmLeaseAuthorityCommand, { readonly kind: 'start-active-use' }> {
	return {
		authority,
		kind: 'start-active-use',
		use: {
			lastHeartbeatAtMs: 100,
			operationPayloadDigest: 'payload-digest-1',
			processEpoch: PROCESS_EPOCH,
			semanticOperationId: 'semantic-operation-1',
			sessionAttachmentGeneration: SESSION_ATTACHMENT_GENERATION,
			startedAtMs: 100,
			useId: 'use-1',
		},
	};
}

async function createCurrentRuntime(options: {
	readonly destroyDetached?: ProvisionalToolVmOwnershipHandle['destroyDetached'];
	readonly lease?: AdmissionTestLease;
}): Promise<{
	readonly authority: ReturnType<typeof createAuthority>;
	readonly lease: AdmissionTestLease;
	readonly runtime: ReturnType<typeof createToolVmLeaseAuthorityRuntime<AdmissionTestLease>>;
	readonly verifiedDestroyTarget: ReturnType<typeof createVerifiedDestroyTarget>;
}> {
	const runtime = createToolVmLeaseAuthorityRuntime<AdmissionTestLease>();
	const authority = createAuthority();
	const lease = options.lease ?? createAdmissionLease();
	const verifiedDestroyTarget = createVerifiedDestroyTarget();
	const ownership = createOwnershipHandle(
		verifiedDestroyTarget,
		options.destroyDetached === undefined ? {} : { destroyDetached: options.destroyDetached },
	);
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
	return { authority, lease, runtime, verifiedDestroyTarget };
}

describe('Tool VM lease authority destruction admission', () => {
	it('blocks a policy release while reducer-owned active work exists', async () => {
		// Arrange
		const destroyDetached = vi.fn<ProvisionalToolVmOwnershipHandle['destroyDetached']>();
		const { authority, lease, runtime } = await createCurrentRuntime({ destroyDetached });
		runtime.applyAuthorityCommand(startActiveUseCommand(authority));

		// Act
		const admission = runtime.admitExactDestruction({
			authority,
			destroyedAtMs: 2_000,
			mode: { kind: 'detached' },
			policy: { kind: 'require-no-active-use' },
			reason: 'idle-release',
		});

		// Assert
		expect(admission).toEqual({ kind: 'blocked-active-use' });
		expect(destroyDetached).not.toHaveBeenCalled();
		expect(runtime.getLease(lease.id)).toBe(lease);
		expect(runtime.leafSnapshotForLease(lease.id)).toMatchObject({ kind: 'current' });
	});

	it('skips a conditional release when the committed lease was used after the cutoff', async () => {
		// Arrange
		const destroyDetached = vi.fn<ProvisionalToolVmOwnershipHandle['destroyDetached']>();
		const lease = createAdmissionLease({ lastUsedAt: 1_000 });
		const { authority, runtime } = await createCurrentRuntime({ destroyDetached, lease });

		// Act
		const admission = runtime.admitExactDestruction({
			authority,
			destroyedAtMs: 2_000,
			mode: { kind: 'detached' },
			policy: { ifLastUsedAtBeforeOrAt: 900, kind: 'require-no-active-use' },
			reason: 'idle-release',
		});

		// Assert
		expect(admission).toEqual({ kind: 'skip-recently-used' });
		expect(destroyDetached).not.toHaveBeenCalled();
		expect(runtime.getLease(lease.id)).toBe(lease);
	});

	it('makes an admitted idle release unavailable before mechanical destruction settles', async () => {
		// Arrange
		const destroyReceipt = createDeferred<ManagedVmDestroyReceiptV1>();
		const destroyDetached = vi.fn(() => destroyReceipt.promise);
		const { authority, lease, runtime, verifiedDestroyTarget } = await createCurrentRuntime({
			destroyDetached,
			lease: createAdmissionLease({ lastUsedAt: 800 }),
		});

		// Act
		const admission = runtime.admitExactDestruction({
			authority,
			destroyedAtMs: 2_000,
			mode: { kind: 'detached' },
			policy: { ifLastUsedAtBeforeOrAt: 900, kind: 'require-no-active-use' },
			reason: 'idle-release',
		});

		// Assert
		expect(admission.kind).toBe('started');
		if (admission.kind !== 'started') {
			throw new Error('expected admitted exact destruction');
		}
		expect(destroyDetached).toHaveBeenCalledOnce();
		expect(runtime.getLease(lease.id)).toBeUndefined();
		expect(
			runtime.findCurrentLeaseByPrincipal({
				gateway: GATEWAY_ONE,
				principal: PRINCIPAL_MAIN,
			}),
		).toBeUndefined();
		expect(() => runtime.applyAuthorityCommand(startActiveUseCommand(authority))).toThrow();

		// Act
		destroyReceipt.resolve(createMatchingDestroyReceipt(verifiedDestroyTarget));
		await admission.completion;

		// Assert
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
	});

	it('force-admits exact destruction even while active work exists', async () => {
		// Arrange
		const { authority, runtime } = await createCurrentRuntime({});
		runtime.applyAuthorityCommand(startActiveUseCommand(authority));

		// Act
		const admission = runtime.admitExactDestruction({
			authority,
			destroyedAtMs: 2_000,
			mode: { kind: 'detached' },
			policy: { kind: 'force' },
			reason: 'Gateway containment',
		});

		// Assert
		expect(admission.kind).toBe('started');
		if (admission.kind !== 'started') {
			throw new Error('expected forced exact destruction');
		}
		await expect(admission.completion).resolves.toMatchObject({ authority });
	});

	it('shares one mechanical completion across duplicate admitted calls', async () => {
		// Arrange
		const destroyReceipt = createDeferred<ManagedVmDestroyReceiptV1>();
		const destroyDetached = vi.fn(() => destroyReceipt.promise);
		const { authority, runtime, verifiedDestroyTarget } = await createCurrentRuntime({
			destroyDetached,
		});
		const options = {
			authority,
			destroyedAtMs: 2_000,
			mode: { kind: 'detached' as const },
			policy: { kind: 'force' as const },
			reason: 'duplicate release',
		};

		// Act
		const firstAdmission = runtime.admitExactDestruction(options);
		const secondAdmission = runtime.admitExactDestruction(options);

		// Assert
		expect(firstAdmission.kind).toBe('started');
		expect(secondAdmission.kind).toBe('started');
		if (firstAdmission.kind !== 'started' || secondAdmission.kind !== 'started') {
			throw new Error('expected duplicate admitted exact destruction');
		}
		expect(secondAdmission.completion).toBe(firstAdmission.completion);
		expect(destroyDetached).toHaveBeenCalledOnce();

		// Act
		destroyReceipt.resolve(createMatchingDestroyReceipt(verifiedDestroyTarget));
		await Promise.all([firstAdmission.completion, secondAdmission.completion]);
	});

	it('retains owner-unsafe authority after unproven destroy and admits exact retry', async () => {
		// Arrange
		const verifiedDestroyTarget = createVerifiedDestroyTarget();
		const destroyDetached = vi
			.fn<ProvisionalToolVmOwnershipHandle['destroyDetached']>()
			.mockRejectedValueOnce(new Error('mechanical destruction unproven'))
			.mockResolvedValueOnce(createMatchingDestroyReceipt(verifiedDestroyTarget));
		const { authority, lease, runtime } = await createCurrentRuntime({ destroyDetached });

		// Act
		const firstAdmission = runtime.admitExactDestruction({
			authority,
			destroyedAtMs: 2_000,
			mode: { kind: 'detached' },
			policy: { kind: 'force' },
			reason: 'first release',
		});
		if (firstAdmission.kind !== 'started') {
			throw new Error('expected first admitted exact destruction');
		}
		await expect(firstAdmission.completion).rejects.toThrow('mechanical destruction unproven');

		// Assert
		expect(runtime.getLease(lease.id)).toBeUndefined();
		expect(runtime.leafSnapshotForLease(lease.id)).toMatchObject({ kind: 'owner-unsafe' });
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([lease.id]);

		// Act
		const retryAdmission = runtime.admitExactDestruction({
			authority,
			destroyedAtMs: 2_100,
			mode: { kind: 'detached' },
			policy: { kind: 'force' },
			reason: 'exact retry',
		});

		// Assert
		expect(retryAdmission.kind).toBe('started');
		if (retryAdmission.kind !== 'started') {
			throw new Error('expected admitted exact retry');
		}
		await retryAdmission.completion;
		expect(destroyDetached).toHaveBeenCalledTimes(2);
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
	});
});
