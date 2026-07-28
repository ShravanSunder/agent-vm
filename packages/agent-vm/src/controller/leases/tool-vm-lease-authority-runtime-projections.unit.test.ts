import { describe, expect, it, vi } from 'vitest';

import { createToolVmLeaseAuthorityRuntime } from './tool-vm-lease-authority-runtime.js';
import {
	COMPATIBILITY,
	createAuthority,
	createDeferred,
	createLease,
	GATEWAY_ONE,
	PRINCIPAL_MAIN,
	RUNTIME_BINDING,
	SSH_BINDING,
	type TestLease,
} from './tool-vm-lease-authority-runtime.test-helpers.js';
import type { ToolVmLeaseAuthorityCommand } from './tool-vm-lease-authority-state.js';

const PROCESS_EPOCH = 'process-epoch-1';
const FIRST_ATTACHMENT_GENERATION = 1;
const RESUMED_ATTACHMENT_GENERATION = 2;
const USE_ID = 'use-1';
const SEMANTIC_OPERATION_ID = 'semantic-operation-1';
const OPERATION_PAYLOAD_DIGEST = 'payload-digest-1';

async function createCurrentLeaseRuntime(): Promise<{
	readonly authority: ReturnType<typeof createAuthority>;
	readonly lease: TestLease;
	readonly runtime: ReturnType<typeof createToolVmLeaseAuthorityRuntime<TestLease>>;
}> {
	const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
	const authority = createAuthority();
	const lease = createLease();
	runtime.registerGateway(GATEWAY_ONE);
	runtime.beginProvisioning({
		authority,
		compatibility: COMPATIBILITY,
		idleExpiresAtMs: lease.idleExpiresAtMs,
	});
	await runtime.commitCurrent({
		authority,
		lease,
		runtimeBinding: RUNTIME_BINDING,
		sshBinding: SSH_BINDING,
	});
	return { authority, lease, runtime };
}

function startUseCommand(
	authority: ReturnType<typeof createAuthority>,
): Extract<ToolVmLeaseAuthorityCommand, { readonly kind: 'start-active-use' }> {
	return {
		authority,
		kind: 'start-active-use' as const,
		use: {
			lastHeartbeatAtMs: 100,
			operationPayloadDigest: OPERATION_PAYLOAD_DIGEST,
			processEpoch: PROCESS_EPOCH,
			semanticOperationId: SEMANTIC_OPERATION_ID,
			sessionAttachmentGeneration: FIRST_ATTACHMENT_GENERATION,
			startedAtMs: 100,
			useId: USE_ID,
		},
	};
}

describe('Tool VM lease authority runtime projections', () => {
	it('projects exact authority, immutable leaf state, and reducer-derived active uses', async () => {
		// Arrange
		const { authority, lease, runtime } = await createCurrentLeaseRuntime();

		// Act
		const startedLeaf = runtime.applyAuthorityCommand(startUseCommand(authority));
		const idempotentLeaf = runtime.applyAuthorityCommand(startUseCommand(authority));

		// Assert
		expect(runtime.authorityForLease(lease.id)).toEqual(authority);
		expect(runtime.authorityForLease(lease.id)).not.toBe(authority);
		expect(startedLeaf).toMatchObject({
			kind: 'current',
			leaseId: lease.id,
			leafGeneration: authority.leafGeneration,
		});
		expect(idempotentLeaf).toEqual(startedLeaf);
		expect(idempotentLeaf).not.toBe(startedLeaf);
		expect(runtime.leafSnapshotForLease(lease.id)).toEqual(idempotentLeaf);
		expect(runtime.activeUseCount(lease.id)).toBe(1);
		expect(runtime.activeUseSnapshots(lease.id)).toEqual([
			expect.objectContaining({
				kind: 'running',
				operationPayloadDigest: OPERATION_PAYLOAD_DIGEST,
				processEpoch: PROCESS_EPOCH,
				semanticOperationId: SEMANTIC_OPERATION_ID,
				sessionAttachmentGeneration: FIRST_ATTACHMENT_GENERATION,
				useId: USE_ID,
			}),
		]);

		// Act / Assert
		expect(() =>
			runtime.applyAuthorityCommand({
				...startUseCommand(authority),
				use: {
					...startUseCommand(authority).use,
					operationPayloadDigest: 'payload-digest-collision',
				},
			}),
		).toThrow(/semantic|collision/iu);
	});

	it('projects heartbeat, observation gap, same-process resume, and terminal replay refusal', async () => {
		// Arrange
		const { authority, lease, runtime } = await createCurrentLeaseRuntime();
		runtime.applyAuthorityCommand(startUseCommand(authority));

		// Act
		const heartbeatLeaf = runtime.applyAuthorityCommand({
			authority,
			heartbeatAtMs: 120,
			kind: 'heartbeat-active-use',
			processEpoch: PROCESS_EPOCH,
			report: {
				reportedAtMs: 120,
				sequence: 1,
				status: 'running',
				summary: 'tool work is progressing',
			},
			sessionAttachmentGeneration: FIRST_ATTACHMENT_GENERATION,
			useId: USE_ID,
		});

		// Assert
		expect(heartbeatLeaf).toMatchObject({
			activeUses: new Map([
				[
					USE_ID,
					expect.objectContaining({
						lastHeartbeatAtMs: 120,
						latestReport: expect.objectContaining({ sequence: 1 }),
					}),
				],
			]),
		});

		// Act
		runtime.applyAuthorityCommand({
			gateway: GATEWAY_ONE,
			kind: 'session-disconnected',
			observedAtMs: 125,
			processEpoch: PROCESS_EPOCH,
			sessionAttachmentGeneration: FIRST_ATTACHMENT_GENERATION,
		});
		expect(runtime.activeUseSnapshots(lease.id)).toEqual([
			expect.objectContaining({
				kind: 'observation-gap',
				processEpoch: PROCESS_EPOCH,
				sessionAttachmentGeneration: FIRST_ATTACHMENT_GENERATION,
			}),
		]);
		const resumedLeaf = runtime.applyAuthorityCommand({
			authority,
			kind: 'resume-active-use',
			lastHeartbeatAtMs: 130,
			nowMs: 130,
			processEpoch: PROCESS_EPOCH,
			sessionAttachmentGeneration: RESUMED_ATTACHMENT_GENERATION,
			useId: USE_ID,
		});

		// Assert
		expect(resumedLeaf).toMatchObject({ kind: 'current' });
		expect(runtime.activeUseSnapshots(lease.id)).toEqual([
			expect.objectContaining({
				kind: 'running',
				processEpoch: PROCESS_EPOCH,
				sessionAttachmentGeneration: RESUMED_ATTACHMENT_GENERATION,
			}),
		]);

		// Act
		const endedLeaf = runtime.applyAuthorityCommand({
			authority,
			endedAtMs: 150,
			kind: 'end-active-use',
			outcome: 'completed',
			processEpoch: PROCESS_EPOCH,
			sessionAttachmentGeneration: RESUMED_ATTACHMENT_GENERATION,
			useId: USE_ID,
		});

		// Assert
		expect(endedLeaf).toMatchObject({ activeUses: new Map() });
		expect(runtime.activeUseCount(lease.id)).toBe(0);
		expect(runtime.activeUseSnapshots(lease.id)).toEqual([]);
		expect(() =>
			runtime.applyAuthorityCommand({
				...startUseCommand(authority),
				use: {
					...startUseCommand(authority).use,
					semanticOperationId: 'semantic-operation-replay-collision',
				},
			}),
		).toThrow(/semantic|collision/iu);
	});

	it('projects process-epoch loss as quarantined ambiguous work', async () => {
		// Arrange
		const { authority, lease, runtime } = await createCurrentLeaseRuntime();
		runtime.applyAuthorityCommand(startUseCommand(authority));

		// Act
		runtime.applyAuthorityCommand({
			ambiguousAtMs: 200,
			gateway: GATEWAY_ONE,
			kind: 'process-epoch-lost',
			processEpoch: PROCESS_EPOCH,
		});

		// Assert
		expect(runtime.leafSnapshotForLease(lease.id)).toMatchObject({
			kind: 'quarantined',
			quarantineReason: 'active-use-ambiguous',
		});
		expect(runtime.activeUseCount(lease.id)).toBe(1);
		expect(runtime.activeUseSnapshots(lease.id)).toEqual([
			expect.objectContaining({
				kind: 'ambiguous',
				processEpoch: PROCESS_EPOCH,
				reason: 'process-epoch-lost',
				useId: USE_ID,
			}),
		]);
	});

	it('makes an access-fenced lease unavailable while retained cleanup remains unsettled', async () => {
		// Arrange
		const runtime = createToolVmLeaseAuthorityRuntime<TestLease>();
		const authority = createAuthority();
		const lease = createLease();
		const cleanupCompletion = createDeferred<void>();
		const cleanup = vi.fn(() => cleanupCompletion.promise);
		const fenceAccess = vi.fn(async () => {});
		runtime.registerGateway(GATEWAY_ONE);
		runtime.beginProvisioning({
			authority,
			compatibility: COMPATIBILITY,
			idleExpiresAtMs: lease.idleExpiresAtMs,
		});
		await runtime.commitCurrent({
			authority,
			lease,
			runtimeBinding: RUNTIME_BINDING,
			sshBinding: SSH_BINDING,
		});

		// Act
		const destruction = runtime.destroyExact({
			authority,
			cleanup,
			destroyedAtMs: 300,
			fenceAccess,
			reason: 'lease-release',
		});
		await destruction.accessFenced;

		// Assert
		expect(fenceAccess).toHaveBeenCalledOnce();
		expect(cleanup).toHaveBeenCalledOnce();
		expect(runtime.getLease(lease.id)).toBeUndefined();
		expect(
			runtime.findCurrentLeaseByPrincipal({
				gateway: GATEWAY_ONE,
				principal: PRINCIPAL_MAIN,
			}),
		).toBeUndefined();
		expect(runtime.leafSnapshotForLease(lease.id)).toMatchObject({ kind: 'retiring' });

		// Act
		cleanupCompletion.resolve();
		await destruction.completion;

		// Assert
		expect(runtime.authorityForLease(lease.id)).toBeUndefined();
		expect(runtime.leafSnapshotForLease(lease.id)).toBeUndefined();
		expect(runtime.activeUseCount(lease.id)).toBe(0);
		expect(runtime.activeUseSnapshots(lease.id)).toEqual([]);
	});
});
