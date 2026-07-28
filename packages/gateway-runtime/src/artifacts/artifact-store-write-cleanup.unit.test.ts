import { describe, expect, it } from 'vitest';

import {
	type ArtifactStoreErrorCode,
	type RecordingStorage,
	baseAuthorization,
	createStoreFixture,
	expectStoreError,
} from './artifact-store-test-fixture.js';

describe('Gateway runtime epoch-local artifact store', () => {
	it('reconciles a partial write after a backend write failure', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const handle = await fixture.store.beginWrite({
			authorization: baseAuthorization,
			lifetimeMs: 100,
			maximumBytes: 8,
		});
		await handle.write(Uint8Array.from([1, 2, 3]));
		fixture.storage.controls.failWriteCall = 2;

		// Act
		const error = await expectStoreError(
			fixture.module,
			() => handle.write(Uint8Array.from([4, 5])),
			'write-failed',
		);

		// Assert
		expect(error.code).toBe('write-failed');
		expect(fixture.storage.discardedArtifactIds).toEqual([handle.artifactId]);
		expect(fixture.store.inspectCounters()).toEqual({
			activeReservations: 0,
			artifactCount: 0,
			committedBytes: 0,
			orphanedArtifactCount: 0,
			orphanedBytes: 0,
			reservedBytes: 0,
			retired: false,
		});
	});

	it.each([
		{
			failurePoint: 'create',
			configure: (storage: RecordingStorage) =>
				(storage.controls.failCreateWriter = new Error('disk full')),
		},
		{
			failurePoint: 'commit',
			configure: (storage: RecordingStorage) =>
				(storage.controls.failCommit = new Error('disk full')),
		},
	])('releases reservations after a backend $failurePoint failure', async ({ configure }) => {
		// Arrange
		const fixture = await createStoreFixture();
		configure(fixture.storage);

		// Act
		const error = await expectStoreError(
			fixture.module,
			async () => {
				const handle = await fixture.store.beginWrite({
					authorization: baseAuthorization,
					lifetimeMs: 100,
					maximumBytes: 4,
				});
				await handle.write(Uint8Array.from([1, 2]));
				await handle.commit();
			},
			'write-failed',
		);

		// Assert
		expect(error.code).toBe('write-failed');
		expect(fixture.store.inspectCounters()).toMatchObject({
			activeReservations: 0,
			artifactCount: 0,
			reservedBytes: 0,
		});
	});

	it('cancels before a backend write and reconciles the reservation', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const handle = await fixture.store.beginWrite({
			authorization: baseAuthorization,
			lifetimeMs: 100,
			maximumBytes: 4,
		});
		const cancellation = new AbortController();
		cancellation.abort();

		// Act
		const error = await expectStoreError(
			fixture.module,
			() => handle.write(Uint8Array.from([1, 2]), cancellation.signal),
			'write-cancelled',
		);

		// Assert
		expect(error.code).toBe('write-cancelled');
		expect(fixture.storage.writerWriteCalls).toEqual([]);
		expect(fixture.storage.discardedArtifactIds).toEqual([handle.artifactId]);
		expect(fixture.store.inspectCounters()).toMatchObject({
			activeReservations: 0,
			reservedBytes: 0,
		});
	});

	it('accounts known orphaned bytes when cleanup fails and keeps them inside the total cap', async () => {
		// Arrange
		const fixture = await createStoreFixture({ limits: { maximumTotalBytes: 4 } });
		const handle = await fixture.store.beginWrite({
			authorization: baseAuthorization,
			lifetimeMs: 100,
			maximumBytes: 4,
		});
		await handle.write(Uint8Array.from([1, 2, 3, 4]));
		fixture.storage.controls.failDiscard = new Error('/private/artifacts secret-token cleanup');

		// Act
		const cleanupError = await expectStoreError(
			fixture.module,
			() => handle.abort(),
			'cleanup-failed',
		);
		const capacityError = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.beginWrite({
					authorization: baseAuthorization,
					lifetimeMs: 100,
					maximumBytes: 1,
				}),
			'capacity',
		);

		// Assert
		expect([cleanupError.code, capacityError.code]).toEqual(['cleanup-failed', 'capacity']);
		expect(fixture.store.inspectCounters()).toEqual({
			activeReservations: 0,
			artifactCount: 0,
			committedBytes: 0,
			orphanedArtifactCount: 1,
			orphanedBytes: 4,
			reservedBytes: 0,
			retired: false,
		});
	});

	it('conservatively accounts a possibly persisted failing write when cleanup also fails', async () => {
		// Arrange
		const fixture = await createStoreFixture({ limits: { maximumTotalBytes: 4 } });
		const handle = await fixture.store.beginWrite({
			authorization: baseAuthorization,
			lifetimeMs: 100,
			maximumBytes: 4,
		});
		await handle.write(Uint8Array.from([1, 2]));
		fixture.storage.controls.failWriteAfterPersistCall = 2;
		fixture.storage.controls.failDiscard = new Error('/private/artifacts secret-token cleanup');

		// Act
		const cleanupError = await expectStoreError(
			fixture.module,
			() => handle.write(Uint8Array.from([3, 4])),
			'cleanup-failed',
		);
		const countersAfterCleanupFailure = fixture.store.inspectCounters();
		let successorAdmission: ArtifactStoreErrorCode | 'admitted' = 'admitted';
		try {
			await fixture.store.beginWrite({
				authorization: baseAuthorization,
				lifetimeMs: 100,
				maximumBytes: 1,
			});
		} catch (error: unknown) {
			if (!(error instanceof fixture.module.GatewayRuntimeArtifactStoreError)) {
				throw error;
			}
			successorAdmission = error.code;
		}

		// Assert
		expect({
			cleanupErrorCode: cleanupError.code,
			countersAfterCleanupFailure,
			successorAdmission,
			writerWriteCalls: fixture.storage.writerWriteCalls,
		}).toEqual({
			cleanupErrorCode: 'cleanup-failed',
			countersAfterCleanupFailure: {
				activeReservations: 0,
				artifactCount: 0,
				committedBytes: 0,
				orphanedArtifactCount: 1,
				orphanedBytes: 4,
				reservedBytes: 0,
				retired: false,
			},
			successorAdmission: 'capacity',
			writerWriteCalls: [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])],
		});
	});
});
