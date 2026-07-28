import { describe, expect, it, vi } from 'vitest';

import { createToolVmLeaseAuthorityRuntime } from './tool-vm-lease-authority-runtime.js';
import {
	COMPATIBILITY,
	GATEWAY_ONE,
	PRINCIPAL_MAIN,
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
	it.each(['running', 'observation-gap'] as const)(
		'classifies %s work as leaf-rollover ambiguity before fencing access',
		async (activeUseKind) => {
			// Arrange
			const { authority, runtime } = await createCurrentRuntime();
			runtime.applyAuthorityCommand({
				authority,
				kind: 'start-active-use',
				use: {
					lastHeartbeatAtMs: 1_000,
					operationPayloadDigest: 'digest-1',
					processEpoch: 'process-1',
					semanticOperationId: 'operation-1',
					sessionAttachmentGeneration: 1,
					startedAtMs: 1_000,
					useId: 'use-1',
				},
			});
			if (activeUseKind === 'observation-gap') {
				runtime.applyAuthorityCommand({
					gateway: GATEWAY_ONE,
					kind: 'session-disconnected',
					observedAtMs: 1_500,
					processEpoch: 'process-1',
					sessionAttachmentGeneration: 1,
				});
			}
			const cleanupCompletion = createDeferred<void>();
			const expectedAmbiguousUse = expect.objectContaining({
				ambiguousAtMs: 20_000,
				kind: 'ambiguous',
				reason: 'leaf-rollover',
			});
			const fenceAccess = vi.fn(async () => {
				expect(runtime.leafSnapshotForLease(authority.leaseId)).toMatchObject({
					activeUses: new Map([['use-1', expectedAmbiguousUse]]),
					kind: 'destroying',
				});
			});

			// Act
			const progress = runtime.destroyExact({
				authority,
				cleanup: () => cleanupCompletion.promise,
				destroyedAtMs: 20_000,
				fenceAccess,
				reason: 'health-rollover',
			});
			await progress.accessFenced;

			// Assert
			expect(fenceAccess).toHaveBeenCalledOnce();
			expect(runtime.leafSnapshotForLease(authority.leaseId)).toMatchObject({
				activeUses: new Map([['use-1', expectedAmbiguousUse]]),
				kind: 'retiring',
			});
			cleanupCompletion.resolve();
			await progress.completion;
			expect(runtime.leafSnapshotForLease(authority.leaseId)).toBeUndefined();
		},
	);

	it('single-flights A fencing while one non-routable B provisions before the access fence', async () => {
		// Arrange
		const { authority: authorityA, runtime } = await createCurrentRuntime();
		const accessFenceCompletion = createDeferred<void>();
		const cleanupCompletion = createDeferred<void>();
		const fenceAccess = vi.fn(() => accessFenceCompletion.promise);
		const cleanup = vi.fn(() => cleanupCompletion.promise);

		// Act
		const first = runtime.destroyExact({
			authority: authorityA,
			cleanup,
			destroyedAtMs: 20_000,
			fenceAccess,
			reason: 'rollover',
		});
		const second = runtime.destroyExact({
			authority: authorityA,
			cleanup,
			destroyedAtMs: 20_000,
			fenceAccess,
			reason: 'rollover',
		});

		// Assert
		expect(first.accessFenced).toBe(second.accessFenced);
		expect(first.completion).toBe(second.completion);
		expect(fenceAccess).toHaveBeenCalledOnce();
		expect(runtime.getLease(authorityA.leaseId)).toBeUndefined();
		expect(
			runtime.findCurrentLeaseByPrincipal({
				gateway: GATEWAY_ONE,
				principal: PRINCIPAL_MAIN,
			}),
		).toBeUndefined();
		expect(runtime.leafSnapshotForLease(authorityA.leaseId)).toMatchObject({ kind: 'destroying' });

		// Act
		const authorityB = createAuthority({ leaseId: 'lease-2', leafGeneration: 'leaf-generation-2' });
		runtime.beginProvisioning({
			authority: authorityB,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 30_000,
		});
		const leaseB = createLease({
			id: authorityB.leaseId,
			label: 'successor',
			vm: { id: 'tool-vm-2' },
		});

		// Assert
		expect(runtime.leafSnapshotForLease(authorityB.leaseId)).toMatchObject({
			kind: 'provisioning',
		});
		expect(runtime.getLease(authorityB.leaseId)).toBeUndefined();
		expect(
			runtime.authorityForPrincipal({ gateway: GATEWAY_ONE, principal: PRINCIPAL_MAIN }),
		).toBeUndefined();
		expect(
			runtime.authorityForCurrentAgent({ agentId: PRINCIPAL_MAIN.agentId, gateway: GATEWAY_ONE }),
		).toBeUndefined();
		await expect(
			runtime.commitCurrent({
				authority: authorityB,
				lease: leaseB,
				runtimeBinding: {
					...RUNTIME_BINDING,
					runtimeRecordId: 'runtime-2',
					vmId: 'tool-vm-2',
				},
				sshBinding: { ...SSH_BINDING, bindingId: 'ssh-2' },
			}),
		).rejects.toMatchObject({ code: 'predecessor-access-not-fenced' });

		// Act
		accessFenceCompletion.resolve();
		await first.accessFenced;
		await runtime.commitCurrent({
			authority: authorityB,
			lease: leaseB,
			runtimeBinding: { ...RUNTIME_BINDING, runtimeRecordId: 'runtime-2', vmId: 'tool-vm-2' },
			sshBinding: { ...SSH_BINDING, bindingId: 'ssh-2' },
		});

		// Assert
		expect(runtime.leafSnapshotForLease(authorityA.leaseId)).toMatchObject({ kind: 'retiring' });
		expect(
			runtime.authorityForPrincipal({ gateway: GATEWAY_ONE, principal: PRINCIPAL_MAIN }),
		).toEqual(authorityB);
		expect(
			runtime.authorityForCurrentAgent({ agentId: PRINCIPAL_MAIN.agentId, gateway: GATEWAY_ONE }),
		).toEqual(authorityB);
		expect(runtime.getLease(authorityB.leaseId)).toBe(leaseB);
		expect(cleanup).toHaveBeenCalledOnce();

		// Act
		cleanupCompletion.resolve();
		await Promise.all([first.completion, second.completion]);

		// Assert
		expect(runtime.authorityForLease(authorityA.leaseId)).toBeUndefined();
		expect(runtime.authorityForLease(authorityB.leaseId)).toEqual(authorityB);
		expect(
			runtime.authorityForPrincipal({ gateway: GATEWAY_ONE, principal: PRINCIPAL_MAIN }),
		).toEqual(authorityB);
		expect(
			runtime.authorityForCurrentAgent({ agentId: PRINCIPAL_MAIN.agentId, gateway: GATEWAY_ONE }),
		).toEqual(authorityB);
		expect(runtime.getLease(authorityB.leaseId)).toBe(leaseB);
	});

	it('keeps containment-unproven authority owner-unsafe until close retry succeeds', async () => {
		// Arrange
		const { authority, runtime } = await createCurrentRuntime();
		const firstFailure = new Error('ManagedVm close containment unproven');
		runtime.applyAuthorityCommand({
			authority,
			kind: 'start-active-use',
			use: {
				lastHeartbeatAtMs: 1_000,
				operationPayloadDigest: 'digest-1',
				processEpoch: 'process-1',
				semanticOperationId: 'operation-1',
				sessionAttachmentGeneration: 1,
				startedAtMs: 1_000,
				useId: 'use-1',
			},
		});

		// Act
		const first = runtime.destroyExact({
			authority,
			cleanup: async () => {},
			destroyedAtMs: 20_000,
			fenceAccess: async () => {
				expect(runtime.activeUseSnapshots(authority.leaseId)).toEqual([
					expect.objectContaining({
						ambiguousAtMs: 20_000,
						kind: 'ambiguous',
						reason: 'leaf-rollover',
					}),
				]);
				throw firstFailure;
			},
			reason: 'health-rollover',
		});

		// Assert
		await expect(first.accessFenced).rejects.toBe(firstFailure);
		await expect(first.completion).rejects.toBe(firstFailure);
		expect(runtime.leafSnapshotForLease(authority.leaseId)).toMatchObject({
			activeUses: new Map([
				[
					'use-1',
					expect.objectContaining({
						ambiguousAtMs: 20_000,
						kind: 'ambiguous',
						reason: 'leaf-rollover',
					}),
				],
			]),
			kind: 'owner-unsafe',
			ownerUnsafeReason: 'controller-destruction-failed',
		});
		const authorityB = createAuthority({
			leaseId: 'lease-2',
			leafGeneration: 'leaf-generation-2',
		});
		runtime.beginProvisioning({
			authority: authorityB,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 30_000,
		});
		expect(runtime.leafSnapshotForLease(authorityB.leaseId)).toMatchObject({
			kind: 'provisioning',
		});
		expect(() =>
			runtime.beginProvisioning({
				authority: createAuthority({ leaseId: 'lease-3', leafGeneration: 'leaf-generation-3' }),
				compatibility: COMPATIBILITY,
				idleExpiresAtMs: 30_000,
			}),
		).toThrow(/already has/iu);

		// Act
		const retry = runtime.destroyExact({
			authority,
			cleanup: async () => {},
			destroyedAtMs: 21_000,
			fenceAccess: async () => {
				expect(runtime.activeUseSnapshots(authority.leaseId)).toEqual([
					expect.objectContaining({
						ambiguousAtMs: 20_000,
						kind: 'ambiguous',
						reason: 'leaf-rollover',
					}),
				]);
			},
			reason: 'retry',
		});

		// Assert
		await expect(retry.accessFenced).resolves.toBeUndefined();
		await expect(retry.completion).resolves.toMatchObject({ authority });
	});

	it('records post-containment cleanup debt without re-fencing or revoking B', async () => {
		// Arrange
		const { authority, runtime } = await createCurrentRuntime();
		const cleanupFailure = new Error('provider cleanup failed');
		runtime.applyAuthorityCommand({
			authority,
			kind: 'start-active-use',
			use: {
				lastHeartbeatAtMs: 1_000,
				operationPayloadDigest: 'digest-1',
				processEpoch: 'process-1',
				semanticOperationId: 'operation-1',
				sessionAttachmentGeneration: 1,
				startedAtMs: 1_000,
				useId: 'use-1',
			},
		});
		const first = runtime.destroyExact({
			authority,
			cleanup: async () => await Promise.reject(cleanupFailure),
			destroyedAtMs: 20_000,
			fenceAccess: async () => {},
			reason: 'rollover',
		});
		await first.accessFenced;

		// Act
		await expect(first.completion).rejects.toBe(cleanupFailure);

		// Assert
		expect(runtime.leafSnapshotForLease(authority.leaseId)).toMatchObject({
			activeUses: new Map([
				[
					'use-1',
					expect.objectContaining({
						ambiguousAtMs: 20_000,
						kind: 'ambiguous',
						reason: 'leaf-rollover',
					}),
				],
			]),
			cleanupIncompleteReason: 'controller-destruction-failed',
			kind: 'retiring',
		});
		const authorityB = createAuthority({ leaseId: 'lease-2', leafGeneration: 'leaf-generation-2' });
		runtime.beginProvisioning({
			authority: authorityB,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: 30_000,
		});
		const leaseB = createLease({
			id: authorityB.leaseId,
			label: 'successor',
			vm: { id: 'tool-vm-2' },
		});
		await runtime.commitCurrent({
			authority: authorityB,
			lease: leaseB,
			runtimeBinding: { ...RUNTIME_BINDING, runtimeRecordId: 'runtime-2', vmId: 'tool-vm-2' },
			sshBinding: { ...SSH_BINDING, bindingId: 'ssh-2' },
		});
		const retryFence = vi.fn(async () => {});
		const retry = runtime.destroyExact({
			authority,
			cleanup: async () => {
				expect(runtime.activeUseSnapshots(authority.leaseId)).toEqual([
					expect.objectContaining({
						ambiguousAtMs: 20_000,
						kind: 'ambiguous',
						reason: 'leaf-rollover',
					}),
				]);
			},
			destroyedAtMs: 21_000,
			fenceAccess: retryFence,
			reason: 'cleanup-retry',
		});
		await retry.accessFenced;
		await retry.completion;
		expect(retryFence).not.toHaveBeenCalled();
		expect(runtime.getLease(authorityB.leaseId)).toBe(leaseB);
		expect(runtime.authorityForLease(authorityB.leaseId)).toEqual(authorityB);
	});

	it('tombstones a provisioning leaf after access fence and cleanup without invented VM identity', async () => {
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const fenceAccess = vi.fn(async () => {});
		const cleanup = vi.fn(async () => {});
		runtime.registerGateway(GATEWAY_ONE);
		runtime.beginProvisioning({ authority, compatibility: COMPATIBILITY, idleExpiresAtMs: 10_000 });

		const progress = runtime.destroyExact({
			authority,
			cleanup,
			destroyedAtMs: 20_000,
			fenceAccess,
			reason: 'provisioning',
		});
		await progress.completion;

		expect(fenceAccess).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(runtime.authorityForLease(authority.leaseId)).toBeUndefined();
		expect(() =>
			runtime.beginProvisioning({
				authority,
				compatibility: COMPATIBILITY,
				idleExpiresAtMs: 30_000,
			}),
		).toThrow(/already used/iu);
	});

	it('reserves the final tombstone slot before concurrent cleanup settles', async () => {
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
		const firstCleanupCompletion = createDeferred<void>();
		const first = runtime.destroyExact({
			authority: firstAuthority,
			cleanup: () => firstCleanupCompletion.promise,
			destroyedAtMs: 20_000,
			fenceAccess: async () => {},
			reason: 'first',
		});
		await first.accessFenced;

		await expectTransitionError(() => {
			runtime.destroyExact({
				authority: secondAuthority,
				cleanup: async () => {},
				destroyedAtMs: 20_000,
				fenceAccess: async () => {},
				reason: 'second',
			});
		}, 'tombstone-capacity-exhausted');
		firstCleanupCompletion.resolve();
		await first.completion;
	});

	it('retains the Gateway parent until every retiring resource cleanup completes', async () => {
		const { authority, runtime } = await createCurrentRuntime();
		const cleanupCompletion = createDeferred<void>();
		runtime.sealGateway(GATEWAY_ONE);
		const progress = runtime.destroyExact({
			authority,
			cleanup: () => cleanupCompletion.promise,
			destroyedAtMs: 20_000,
			fenceAccess: async () => {},
			reason: 'shutdown',
		});
		await progress.accessFenced;

		await expectTransitionError(() => runtime.retireGateway(GATEWAY_ONE), 'parent-has-live-leaves');

		cleanupCompletion.resolve();
		await progress.completion;
		expect(() => runtime.retireGateway(GATEWAY_ONE)).not.toThrow();
	});
});
