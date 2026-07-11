import { describe, expect, it, vi } from 'vitest';

import type {
	ProvisionalToolVmOwnershipHandle,
	ToolVmProvisionalOwnershipProof,
} from '../vm-ownership/gateway-ownership-coordinator.js';
import {
	createToolVmLeaseAuthorityRuntime,
	RejectedToolVmProvisioningCleanupError,
} from './tool-vm-lease-authority-runtime.js';
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
	RUNTIME_BINDING,
	SSH_BINDING,
	type TestLease,
} from './tool-vm-lease-authority-runtime.test-helpers.js';

describe('createToolVmLeaseAuthorityRuntime', () => {
	it('awaits ownership.ready as the sole destroy-target source before publishing authority', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const verifiedDestroyTarget = createVerifiedDestroyTarget();
		const ready = createDeferred<ToolVmProvisionalOwnershipProof>();
		const ownership = createOwnershipHandle(verifiedDestroyTarget, { ready: ready.promise });
		const expectedProof = await createOwnershipHandle(verifiedDestroyTarget).ready;
		runtime.registerGateway(GATEWAY_ONE);

		// Act
		const provisioning = runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
			ownership,
		});

		// Assert
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);

		// Act
		ready.resolve(expectedProof);
		await provisioning;

		// Assert
		expect(runtime.getLease(authority.leaseId)).toBeUndefined();
		expect(runtime.listLeases()).toEqual([]);
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([authority.leaseId]);
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_TWO)).toEqual([]);
	});

	it('rejects a mismatched ready proof before reducer or resource publication', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const mismatchedTarget = createVerifiedDestroyTarget('tool-vm-1', {
			gateway: GATEWAY_TWO,
		});
		runtime.registerGateway(GATEWAY_ONE);

		// Act / Assert
		await expect(
			runtime.beginProvisioning({
				authority,
				compatibility: COMPATIBILITY,
				idleExpiresAtMs: 10_000,
				ownership: createOwnershipHandle(mismatchedTarget),
			}),
		).rejects.toThrow(/ownership proof.*Gateway authority|Gateway authority.*ownership proof/iu);
		expect(runtime.getLease(authority.leaseId)).toBeUndefined();
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
	});

	it('does not record a second runtime resource when the pure reducer refuses provisioning', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const firstAuthority = createAuthority();
		const secondAuthority = createAuthority({
			leaseId: 'lease-2',
			leafGeneration: 'leaf-generation-2',
		});
		const firstTarget = createVerifiedDestroyTarget();
		const secondTarget = createVerifiedDestroyTarget('tool-vm-2');
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority: firstAuthority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
			ownership: createOwnershipHandle(firstTarget),
		});

		// Act / Assert
		await expectTransitionError(
			async () =>
				await runtime.beginProvisioning({
					authority: secondAuthority,
					compatibility: COMPATIBILITY,
					idleExpiresAtMs: 10_000,
					ownership: createOwnershipHandle(secondTarget),
				}),
			'leaf-already-exists',
		);
		expect(runtime.getLease(secondAuthority.leaseId)).toBeUndefined();
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([firstAuthority.leaseId]);
	});

	it('exactly destroys a post-ready duplicate admission rejected by the reducer', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const firstAuthority = createAuthority();
		const rejectedAuthority = createAuthority({
			leaseId: 'lease-rejected',
			leafGeneration: 'leaf-generation-rejected',
		});
		const firstTarget = createVerifiedDestroyTarget();
		const rejectedTarget = createVerifiedDestroyTarget('tool-vm-rejected');
		const destroyRejected = vi.fn(async () => createMatchingDestroyReceipt(rejectedTarget));
		const rejectedOwnership = createOwnershipHandle(rejectedTarget, {
			destroyDetached: destroyRejected,
		});
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority: firstAuthority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
			ownership: createOwnershipHandle(firstTarget),
		});

		// Act / Assert
		await expectTransitionError(
			async () =>
				await runtime.beginProvisioning({
					authority: rejectedAuthority,
					compatibility: COMPATIBILITY,
					idleExpiresAtMs: 10_000,
					ownership: rejectedOwnership,
				}),
			'leaf-already-exists',
		);
		expect(destroyRejected).toHaveBeenCalledOnce();
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([firstAuthority.leaseId]);
	});

	it('retains a failed same-authority rejection under its exact cleanup identity', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const liveTarget = createVerifiedDestroyTarget();
		const rejectedTarget = createVerifiedDestroyTarget('tool-vm-rejected', {
			reservationId: 'reservation-tool-vm-rejected',
		});
		const rejectedCleanupFailure = new Error('rejected reservation destroy failed');
		const destroyRejected = vi
			.fn<ProvisionalToolVmOwnershipHandle['destroyDetached']>()
			.mockRejectedValueOnce(rejectedCleanupFailure)
			.mockResolvedValueOnce(createMatchingDestroyReceipt(rejectedTarget));
		const rejectedOwnership = createOwnershipHandle(rejectedTarget, {
			destroyDetached: destroyRejected,
		});
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
			ownership: createOwnershipHandle(liveTarget),
		});

		// Act
		let rejection: unknown;
		try {
			await runtime.beginProvisioning({
				authority,
				compatibility: COMPATIBILITY,
				idleExpiresAtMs: 10_000,
				ownership: rejectedOwnership,
			});
		} catch (error) {
			rejection = error;
		}

		// Assert
		expect(rejection).toBeInstanceOf(RejectedToolVmProvisioningCleanupError);
		expect(rejection).toMatchObject({
			cleanupId: expect.any(String),
			cause: expect.objectContaining({ code: 'leaf-already-exists' }),
		});
		if (!(rejection instanceof RejectedToolVmProvisioningCleanupError)) {
			throw new Error('expected rejected provisioning cleanup error');
		}
		const { cleanupId } = rejection;
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([authority.leaseId]);
		expect(runtime.rejectedCleanupIdsOwnedByGateway(GATEWAY_ONE)).toEqual([cleanupId]);

		// Act
		runtime.sealGateway(GATEWAY_ONE);
		await runtime.destroyExact({
			authority,
			destroyedAtMs: 30_000,
			mode: { kind: 'detached' },
			reason: 'dispose-live-leaf',
		});

		// Assert
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
		expect(runtime.rejectedCleanupIdsOwnedByGateway(GATEWAY_ONE)).toEqual([cleanupId]);
		await expectTransitionError(() => runtime.retireGateway(GATEWAY_ONE), 'parent-has-live-leaves');

		// Act
		await runtime.retryRejectedProvisioningCleanup(cleanupId);
		runtime.retireGateway(GATEWAY_ONE);

		// Assert
		expect(destroyRejected).toHaveBeenCalledTimes(2);
		expect(runtime.rejectedCleanupIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
	});

	it('retains a failed cross-Gateway lease-ID collision under the rejected Gateway cleanup identity', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const firstAuthority = createAuthority();
		const rejectedAuthority = createAuthority({
			gateway: GATEWAY_TWO,
			leaseId: firstAuthority.leaseId,
			leafGeneration: 'leaf-generation-gateway-2',
		});
		const firstTarget = createVerifiedDestroyTarget();
		const rejectedTarget = createVerifiedDestroyTarget('tool-vm-gateway-2', {
			gateway: GATEWAY_TWO,
		});
		const destroyRejected = vi
			.fn<ProvisionalToolVmOwnershipHandle['destroyDetached']>()
			.mockRejectedValueOnce(new Error('cross-Gateway rejected cleanup failed'))
			.mockResolvedValueOnce(createMatchingDestroyReceipt(rejectedTarget));
		runtime.registerGateway(GATEWAY_ONE);
		runtime.registerGateway(GATEWAY_TWO);
		await runtime.beginProvisioning({
			authority: firstAuthority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
			ownership: createOwnershipHandle(firstTarget),
		});

		// Act
		let rejection: unknown;
		try {
			await runtime.beginProvisioning({
				authority: rejectedAuthority,
				compatibility: COMPATIBILITY,
				idleExpiresAtMs: 10_000,
				ownership: createOwnershipHandle(rejectedTarget, {
					destroyDetached: destroyRejected,
				}),
			});
		} catch (error) {
			rejection = error;
		}

		// Assert
		expect(rejection).toBeInstanceOf(RejectedToolVmProvisioningCleanupError);
		if (!(rejection instanceof RejectedToolVmProvisioningCleanupError)) {
			throw new Error('expected cross-Gateway rejected provisioning cleanup error');
		}
		const { cleanupId } = rejection;
		expect(destroyRejected).toHaveBeenCalledOnce();
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([firstAuthority.leaseId]);
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_TWO)).toEqual([]);
		expect(runtime.rejectedCleanupIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
		expect(runtime.rejectedCleanupIdsOwnedByGateway(GATEWAY_TWO)).toEqual([cleanupId]);

		// Act
		await runtime.retryRejectedProvisioningCleanup(cleanupId);

		// Assert
		expect(destroyRejected).toHaveBeenCalledTimes(2);
		expect(runtime.rejectedCleanupIdsOwnedByGateway(GATEWAY_TWO)).toEqual([]);
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([firstAuthority.leaseId]);
	});

	it('exactly destroys a ready admission that loses a race with Gateway sealing', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const verifiedDestroyTarget = createVerifiedDestroyTarget();
		const ready = createDeferred<ToolVmProvisionalOwnershipProof>();
		const destroyRejected = vi.fn(async () => createMatchingDestroyReceipt(verifiedDestroyTarget));
		const ownership = createOwnershipHandle(verifiedDestroyTarget, {
			destroyDetached: destroyRejected,
			ready: ready.promise,
		});
		const expectedProof = await createOwnershipHandle(verifiedDestroyTarget).ready;
		runtime.registerGateway(GATEWAY_ONE);
		const provisioning = runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 10_000,
			ownership,
		});
		const rejectedProvisioning = expect(provisioning).rejects.toMatchObject({
			code: 'parent-not-admitting',
		});

		// Act
		runtime.sealGateway(GATEWAY_ONE);
		ready.resolve(expectedProof);

		// Assert
		await rejectedProvisioning;
		expect(destroyRejected).toHaveBeenCalledOnce();
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
	});

	it('publishes a current lease only after durable ownership commit succeeds', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		const verifiedDestroyTarget = createVerifiedDestroyTarget();
		const commitCurrent = vi.fn(async () => {
			throw new Error('durable ownership commit failed');
		});
		const ownership = createOwnershipHandle(verifiedDestroyTarget, { commitCurrent });
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: lease.idleExpiresAtMs,
			ownership,
		});

		// Act / Assert
		await expect(
			runtime.commitCurrent({
				authority,
				lease,
				runtimeBinding: RUNTIME_BINDING,
				sshBinding: SSH_BINDING,
			}),
		).rejects.toThrow('durable ownership commit failed');
		expect(commitCurrent).toHaveBeenCalledOnce();
		expect(runtime.getLease(lease.id)).toBeUndefined();
		expect(
			runtime.findCurrentLeaseByPrincipal({
				gateway: GATEWAY_ONE,
				principal: PRINCIPAL_MAIN,
			}),
		).toBeUndefined();
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([authority.leaseId]);
	});

	it('single-flights concurrent durable current commits', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		const verifiedDestroyTarget = createVerifiedDestroyTarget();
		const durableCommit = createDeferred<void>();
		const commitCurrent = vi.fn(() => durableCommit.promise);
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: lease.idleExpiresAtMs,
			ownership: createOwnershipHandle(verifiedDestroyTarget, { commitCurrent }),
		});

		// Act
		const firstCommit = runtime.commitCurrent({
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});
		const secondCommit = runtime.commitCurrent({
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});
		durableCommit.resolve();
		const outcomes = await Promise.allSettled([firstCommit, secondCommit]);

		// Assert
		expect(commitCurrent).toHaveBeenCalledOnce();
		expect(outcomes).toEqual([
			{ status: 'fulfilled', value: undefined },
			{ status: 'fulfilled', value: undefined },
		]);
		expect(runtime.getLease(lease.id)).toBe(lease);
	});

	it('shares only identical commit retries during and after durable commit', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		const verifiedDestroyTarget = createVerifiedDestroyTarget();
		const durableCommit = createDeferred<void>();
		const commitCurrent = vi.fn(() => durableCommit.promise);
		const canonicalCommit = {
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		};
		const changedLeaseCommit = {
			...canonicalCommit,
			lease: createLease({ id: 'lease-other' }),
		};
		const changedBehaviorCommit = {
			...canonicalCommit,
			lease: createLease({
				idleExpiresAtMs: lease.idleExpiresAtMs + 1_000,
				label: 'behavior-changed lease',
			}),
		};
		const changedRuntimeCommit = {
			...canonicalCommit,
			runtimeBinding: {
				...RUNTIME_BINDING,
				runtimeRecordId: 'runtime-tool-vm-other',
			},
		};
		const changedSshCommit = {
			...canonicalCommit,
			sshBinding: {
				...SSH_BINDING,
				bindingId: 'ssh-tool-vm-other',
			},
		};
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: lease.idleExpiresAtMs,
			ownership: createOwnershipHandle(verifiedDestroyTarget, { commitCurrent }),
		});

		// Act
		const firstCommit = runtime.commitCurrent(canonicalCommit);
		const identicalInFlightRetry = runtime.commitCurrent(canonicalCommit);
		const changedBehaviorInFlightOutcome = runtime.commitCurrent(changedBehaviorCommit).then(
			() => ({ kind: 'fulfilled' as const }),
			(error: unknown) => ({ error, kind: 'rejected' as const }),
		);

		// Assert
		await expect(runtime.commitCurrent(changedLeaseCommit)).rejects.toThrow();
		await expect(runtime.commitCurrent(changedRuntimeCommit)).rejects.toThrow(
			/commit retry changed lease or binding identity/iu,
		);
		await expect(runtime.commitCurrent(changedSshCommit)).rejects.toThrow(
			/commit retry changed lease or binding identity/iu,
		);
		expect(commitCurrent).toHaveBeenCalledOnce();

		// Act
		durableCommit.resolve();
		await Promise.all([firstCommit, identicalInFlightRetry]);
		await runtime.commitCurrent(canonicalCommit);

		// Assert
		expect(await changedBehaviorInFlightOutcome).toMatchObject({
			error: expect.any(Error),
			kind: 'rejected',
		});
		await expect(runtime.commitCurrent(changedLeaseCommit)).rejects.toThrow();
		await expect(runtime.commitCurrent(changedBehaviorCommit)).rejects.toThrow(
			/commit retry changed/iu,
		);
		await expect(runtime.commitCurrent(changedRuntimeCommit)).rejects.toThrow(
			/commit retry changed lease or binding identity/iu,
		);
		await expect(runtime.commitCurrent(changedSshCommit)).rejects.toThrow(
			/commit retry changed lease or binding identity/iu,
		);
		expect(commitCurrent).toHaveBeenCalledOnce();
		expect(runtime.getLease(lease.id)).toBe(lease);
	});

	it('retains a sealed pending commit for exact disposal after durable membership wins', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		const verifiedDestroyTarget = createVerifiedDestroyTarget();
		const durableCommit = createDeferred<void>();
		const destroyDetached = vi.fn(async () => createMatchingDestroyReceipt(verifiedDestroyTarget));
		const ownership = createOwnershipHandle(verifiedDestroyTarget, {
			commitCurrent: vi.fn(() => durableCommit.promise),
			destroyDetached,
		});
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: lease.idleExpiresAtMs,
			ownership,
		});
		const pendingCommit = runtime.commitCurrent({
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});
		const commitOutcome = pendingCommit.then(
			() => undefined,
			(error: unknown) => error,
		);

		// Act
		runtime.sealGateway(GATEWAY_ONE);
		durableCommit.resolve();

		// Assert
		expect(await commitOutcome).toMatchObject({ code: 'parent-not-admitting' });
		expect(runtime.getLease(lease.id)).toBeUndefined();
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([lease.id]);

		// Act
		await runtime.destroyExact({
			authority,
			destroyedAtMs: 30_000,
			mode: { kind: 'detached' },
			reason: 'sealed-after-durable-commit',
		});

		// Assert
		expect(destroyDetached).toHaveBeenCalledOnce();
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
	});

	it('serializes exact destruction after a pending durable commit', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		const verifiedDestroyTarget = createVerifiedDestroyTarget();
		const durableCommit = createDeferred<void>();
		const operationOrder: string[] = [];
		const commitCurrent = vi.fn(async () => {
			operationOrder.push('commit-started');
			await durableCommit.promise;
			operationOrder.push('commit-finished');
		});
		const destroyDetached = vi.fn(async () => {
			operationOrder.push('destroy-started');
			return createMatchingDestroyReceipt(verifiedDestroyTarget);
		});
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: lease.idleExpiresAtMs,
			ownership: createOwnershipHandle(verifiedDestroyTarget, {
				commitCurrent,
				destroyDetached,
			}),
		});

		// Act
		const pendingCommit = runtime.commitCurrent({
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});
		const pendingDestroy = runtime.destroyExact({
			authority,
			destroyedAtMs: 30_000,
			mode: { kind: 'detached' },
			reason: 'serialized-after-commit',
		});
		const destroyStartedBeforeCommitSettled = destroyDetached.mock.calls.length > 0;
		durableCommit.resolve();
		const outcomes = await Promise.allSettled([pendingCommit, pendingDestroy]);

		// Assert
		expect(destroyStartedBeforeCommitSettled).toBe(false);
		expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
		expect(operationOrder).toEqual(['commit-started', 'commit-finished', 'destroy-started']);
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
	});

	it('refuses durable commit retry after failure until exact disposal completes', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		const verifiedDestroyTarget = createVerifiedDestroyTarget();
		const commitCurrent = vi.fn(async () => {
			throw new Error('durable commit failed');
		});
		const destroyDetached = vi.fn(async () => createMatchingDestroyReceipt(verifiedDestroyTarget));
		runtime.registerGateway(GATEWAY_ONE);
		await runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: lease.idleExpiresAtMs,
			ownership: createOwnershipHandle(verifiedDestroyTarget, {
				commitCurrent,
				destroyDetached,
			}),
		});

		// Act / Assert
		await expect(
			runtime.commitCurrent({
				authority,
				lease,
				runtimeBinding: RUNTIME_BINDING,
				sshBinding: SSH_BINDING,
			}),
		).rejects.toThrow('durable commit failed');
		await expect(
			runtime.commitCurrent({
				authority,
				lease,
				runtimeBinding: RUNTIME_BINDING,
				sshBinding: SSH_BINDING,
			}),
		).rejects.toThrow(
			/commit.*(?:failed|uncertain).*exact destruction|exact destruction.*commit/iu,
		);
		expect(commitCurrent).toHaveBeenCalledOnce();

		// Act
		await runtime.destroyExact({
			authority,
			destroyedAtMs: 30_000,
			mode: { kind: 'detached' },
			reason: 'failed-durable-commit',
		});

		// Assert
		expect(destroyDetached).toHaveBeenCalledOnce();
		expect(runtime.leaseIdsOwnedByGateway(GATEWAY_ONE)).toEqual([]);
	});
});
