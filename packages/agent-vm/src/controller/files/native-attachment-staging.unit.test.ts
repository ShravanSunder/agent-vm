import { describe, expect, it, vi } from 'vitest';

import { createNativeAttachmentStaging } from './native-attachment-staging.js';
import { createOperationFileRetentionBudget } from './operation-file-retention-budget.js';

function fixture(): {
	readonly staging: ReturnType<typeof createNativeAttachmentStaging>;
	readonly request: Parameters<ReturnType<typeof createNativeAttachmentStaging>['stage']>[0];
	readonly removed: ReturnType<typeof vi.fn>;
} {
	const removed = vi.fn(async () => {});
	return {
		staging: createNativeAttachmentStaging({
			retentionBudget: createOperationFileRetentionBudget(),
		}),
		removed,
		request: {
			destinationRoot: '/work',
			owner: {
				agentId: 'sun',
				zoneId: 'zone',
				gatewayVmId: 'gateway',
				stablePrincipal: 'principal',
				profileName: 'sun',
				sessionId: 'session',
			},
			source: {
				read: async function* () {
					yield new Uint8Array([0, 255, 128, 1]);
				},
			},
			sourceRelativePath: 'report.bin',
			destination: {
				createDirectory: async () => {},
				publish: async () => ({ kind: 'published', cleanup: 'complete' }),
				removeOwned: removed,
			},
			destinationWriter: {
				writeFileStream: async ({ contents }) => {
					for await (const chunk of contents) void chunk;
				},
			},
			sourceAuthorityIsCurrent: () => true,
			destinationAuthorityIsCurrent: () => true,
			signal: new AbortController().signal,
		},
	};
}

describe('native attachment staging lifecycle', () => {
	it('retries failed settled-file cleanup without resending', async () => {
		// Arrange
		const current = fixture();
		const staged = await current.staging.stage(current.request);
		if (staged.kind !== 'staged') throw new Error('Expected staged file.');
		current.removed.mockRejectedValueOnce(new Error('temporary filesystem failure'));
		// Act / Assert
		expect(
			await current.staging.settle({
				owner: current.request.owner,
				stagingId: staged.stagingId,
				outcome: 'failed',
			}),
		).toEqual({ kind: 'retained' });
		await current.staging.reapPendingCleanup();
		expect(current.removed).toHaveBeenCalledTimes(2);
		expect(
			await current.staging.settle({
				owner: current.request.owner,
				stagingId: staged.stagingId,
				outcome: 'failed',
			}),
		).toEqual({ kind: 'unavailable' });
	});
	it('cleans after a settled sender even when delivery remains unconfirmed', async () => {
		// Arrange
		const current = fixture();
		const staged = await current.staging.stage(current.request);
		if (staged.kind !== 'staged') throw new Error('Expected staged file.');
		// Act / Assert
		expect(
			await current.staging.settle({
				owner: current.request.owner,
				stagingId: staged.stagingId,
				outcome: 'unconfirmed',
			}),
		).toEqual({ kind: 'cleaned' });
		expect(current.removed).toHaveBeenCalledOnce();
	});
	it('does not overlap writes from two agents to the same Gateway VM', async () => {
		// Arrange: distinct agent/source authority, one shared destination.
		const current = fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const writeFileStream = vi.fn<typeof current.request.destinationWriter.writeFileStream>(
			async ({ contents }) => {
				entered.resolve();
				await release.promise;
				for await (const chunk of contents) void chunk;
			},
		);
		const first = current.staging.stage({
			...current.request,
			destinationWriter: { writeFileStream },
		});
		await entered.promise;
		try {
			// Act: a second agent must be refused before its writer starts.
			const second = current.staging.stage({
				...current.request,
				owner: { ...current.request.owner, agentId: 'ember', profileName: 'ember' },
				destinationWriter: { writeFileStream },
			});
			// The second call enters while the first owns the destination reservation.
			release.resolve();
			expect(await second).toEqual({ kind: 'failed', reason: 'capacity' });
			expect(writeFileStream).toHaveBeenCalledOnce();
			expect(await first).toMatchObject({ kind: 'staged' });
		} finally {
			release.resolve();
			await first;
		}
	});

	it('releases only the destroyed Gateway reservations, never those belonging to another VM', async () => {
		// Arrange: each unknown send keeps its existing staging reservation.
		const current = fixture();
		const first = await current.staging.stage(current.request);
		const otherOwner = { ...current.request.owner, gatewayVmId: 'other-gateway' };
		const second = await current.staging.stage({ ...current.request, owner: otherOwner });
		if (first.kind !== 'staged' || second.kind !== 'staged') throw new Error('Expected files.');
		// Act: called only by the controller after exact Gateway destruction resolves.
		await current.staging.releaseGatewayAfterContainment({
			zoneId: 'zone',
			gatewayVmId: 'gateway',
		});
		// Assert: the owned host directory is deleted; unrelated staging is retained.
		expect(current.removed).toHaveBeenCalledExactlyOnceWith(first.path.split('/').at(-2));
		expect(
			await current.staging.settle({
				owner: current.request.owner,
				stagingId: first.stagingId,
				outcome: 'sent',
			}),
		).toEqual({ kind: 'unavailable' });
		expect(
			await current.staging.settle({
				owner: otherOwner,
				stagingId: second.stagingId,
				outcome: 'sender-pending',
			}),
		).toEqual({ kind: 'retained' });
	});

	it('retains a staged file while the sender is pending, and removes only its owned directory after settlement', async () => {
		// Arrange
		const current = fixture();
		// Act
		const staged = await current.staging.stage(current.request);
		if (staged.kind !== 'staged') throw new Error('Expected staged file.');
		// Assert
		expect(staged.path).toMatch(/^\/work\/portal-native-sun-[a-f0-9-]+\/report.bin$/u);
		expect(staged.byteLength).toBe(4);
		expect(
			await current.staging.settle({
				owner: current.request.owner,
				stagingId: staged.stagingId,
				outcome: 'sender-pending',
			}),
		).toEqual({ kind: 'retained' });
		expect(current.removed).not.toHaveBeenCalled();
		expect(
			await current.staging.settle({
				owner: current.request.owner,
				stagingId: staged.stagingId,
				outcome: 'sent',
			}),
		).toEqual({ kind: 'cleaned' });
		expect(current.removed).toHaveBeenCalledExactlyOnceWith(staged.path.split('/').at(-2));
	});
	it('rejects another profile or session without deleting the source staging file', async () => {
		// Arrange
		const current = fixture();
		const staged = await current.staging.stage(current.request);
		if (staged.kind !== 'staged') throw new Error('Expected staged file.');
		// Act / Assert
		expect(
			await current.staging.settle({
				owner: { ...current.request.owner, sessionId: 'other-session' },
				stagingId: staged.stagingId,
				outcome: 'sent',
			}),
		).toEqual({ kind: 'unavailable' });
		expect(current.removed).not.toHaveBeenCalled();
	});
});
