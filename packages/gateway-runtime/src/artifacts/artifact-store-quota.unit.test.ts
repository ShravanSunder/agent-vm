import { describe, expect, it } from 'vitest';

import {
	baseAuthorization,
	baseCaller,
	createDeferredSignal,
	createStoreFixture,
	expectStoreError,
	fixedNowMilliseconds,
	readRequest,
	writeArtifact,
} from './artifact-store-test-fixture.js';

describe('Gateway runtime epoch-local artifact store', () => {
	it('rejects expired artifacts using the injected clock', async () => {
		// Arrange
		let nowMilliseconds = fixedNowMilliseconds;
		const fixture = await createStoreFixture({ now: () => nowMilliseconds });
		const reference = await writeArtifact(fixture, Uint8Array.from([1]), { lifetimeMs: 10 });

		// Act
		nowMilliseconds += 11;
		const error = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.read({
					caller: baseCaller,
					request: readRequest(reference),
				}),
			'expired',
		);

		// Assert
		expect(error.code).toBe('expired');
		expect(fixture.storage.readRequests).toEqual([]);
	});

	it('reclaims expired committed artifact count and byte quota before admitting a successor write', async () => {
		// Arrange
		let nowMilliseconds = fixedNowMilliseconds;
		const fixture = await createStoreFixture({
			limits: { maximumArtifactCount: 1, maximumTotalBytes: 4 },
			now: () => nowMilliseconds,
		});
		const expiredReference = await writeArtifact(fixture, Uint8Array.from([1, 2, 3, 4]), {
			lifetimeMs: 10,
			maximumBytes: 4,
		});
		nowMilliseconds += 11;

		// Act
		const successorReference = await writeArtifact(fixture, Uint8Array.from([5, 6, 7, 8]), {
			maximumBytes: 4,
		});

		// Assert
		expect(successorReference.id).not.toBe(expiredReference.id);
		expect(fixture.storage.removedArtifactIds).toEqual([expiredReference.id]);
		expect(fixture.store.inspectCounters()).toEqual({
			activeReservations: 0,
			artifactCount: 1,
			committedBytes: 4,
			orphanedArtifactCount: 0,
			orphanedBytes: 0,
			reservedBytes: 0,
			retired: false,
		});
	});

	it('retains failed zero-byte removal inside artifact count quota', async () => {
		// Arrange
		let nowMilliseconds = fixedNowMilliseconds;
		const fixture = await createStoreFixture({
			limits: { maximumArtifactCount: 1 },
			now: () => nowMilliseconds,
		});
		const emptyHandle = await fixture.store.beginWrite({
			authorization: baseAuthorization,
			lifetimeMs: 10,
			maximumBytes: 1,
		});
		const emptyReference = await emptyHandle.commit();
		nowMilliseconds += 11;
		fixture.storage.controls.failRemove = new Error('retained empty artifact cleanup failed');
		const cleanupError = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.beginWrite({
					authorization: baseAuthorization,
					lifetimeMs: 100,
					maximumBytes: 1,
				}),
			'cleanup-failed',
		);

		// Act
		const successorAdmissionError = await expectStoreError(
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
		expect(emptyReference.byteLength).toBe(0);
		expect([cleanupError.code, successorAdmissionError.code]).toEqual([
			'cleanup-failed',
			'capacity',
		]);
		expect(fixture.storage.bytesByArtifactId.has(emptyReference.id)).toBe(true);
	});

	it('keeps committed count and bytes visible while expired removal is pending', async () => {
		// Arrange
		let nowMilliseconds = fixedNowMilliseconds;
		const fixture = await createStoreFixture({ now: () => nowMilliseconds });
		const reference = await writeArtifact(fixture, Uint8Array.from([1, 2, 3]), {
			lifetimeMs: 10,
		});
		nowMilliseconds += 11;
		const removalStarted = createDeferredSignal();
		const removalMayFinish = createDeferredSignal();
		fixture.storage.controls.beforeRemove = async (): Promise<void> => {
			removalStarted.resolve();
			await removalMayFinish.promise;
		};
		const expiredReadErrorPromise = expectStoreError(
			fixture.module,
			() =>
				fixture.store.read({
					caller: baseCaller,
					request: readRequest(reference),
				}),
			'expired',
		);
		await removalStarted.promise;

		// Act
		const countersDuringRemoval = fixture.store.inspectCounters();
		removalMayFinish.resolve();
		const expiredReadError = await expiredReadErrorPromise;

		// Assert
		expect(expiredReadError.code).toBe('expired');
		expect(countersDuringRemoval).toMatchObject({
			artifactCount: 1,
			committedBytes: 3,
			orphanedBytes: 0,
		});
	});

	it('rejects offsets beyond the artifact and arithmetic range overflow', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const reference = await writeArtifact(fixture, Uint8Array.from([1, 2]));

		// Act
		const beyondEnd = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.read({
					caller: baseCaller,
					request: readRequest(reference, { maxBytes: 1, offsetBytes: 3 }),
				}),
			'range',
		);
		const arithmeticOverflow = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.read({
					caller: baseCaller,
					request: readRequest(reference, {
						maxBytes: 2,
						offsetBytes: Number.MAX_SAFE_INTEGER,
					}),
				}),
			'range',
		);

		// Assert
		expect([beyondEnd.code, arithmeticOverflow.code]).toEqual(['range', 'range']);
		expect(fixture.storage.readRequests).toEqual([]);
	});

	it.each([
		{ label: 'count', limits: { maximumArtifactCount: 1, maximumTotalBytes: 64 } },
		{ label: 'byte', limits: { maximumArtifactCount: 4, maximumTotalBytes: 8 } },
	])('reserves $label capacity atomically before backend writer creation', async ({ limits }) => {
		// Arrange
		const fixture = await createStoreFixture({ limits });

		// Act
		const firstHandlePromise = fixture.store.beginWrite({
			authorization: baseAuthorization,
			lifetimeMs: 100,
			maximumBytes: 8,
		});
		const competingAdmissionPromise = expectStoreError(
			fixture.module,
			() =>
				fixture.store.beginWrite({
					authorization: baseAuthorization,
					lifetimeMs: 100,
					maximumBytes: 1,
				}),
			'capacity',
		);
		const [firstHandle, competingAdmissionError] = await Promise.all([
			firstHandlePromise,
			competingAdmissionPromise,
		]);

		// Assert
		expect(competingAdmissionError.code).toBe('capacity');
		expect(fixture.store.inspectCounters()).toMatchObject({
			activeReservations: 1,
			reservedBytes: 8,
		});
		await firstHandle.abort();
	});

	it.each([
		{ label: 'per-artifact bytes', limits: {}, lifetimeMs: 100, maximumBytes: 33 },
		{ label: 'lifetime', limits: {}, lifetimeMs: 1_001, maximumBytes: 1 },
		{
			label: 'total bytes',
			limits: { maximumTotalBytes: 4 },
			lifetimeMs: 100,
			maximumBytes: 5,
		},
	])('rejects $label cap exhaustion before backend creation', async (testCase) => {
		// Arrange
		const fixture = await createStoreFixture({ limits: testCase.limits });

		// Act
		const error = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.beginWrite({
					authorization: baseAuthorization,
					lifetimeMs: testCase.lifetimeMs,
					maximumBytes: testCase.maximumBytes,
				}),
			'capacity',
		);

		// Assert
		expect(error.code).toBe('capacity');
		expect(fixture.store.inspectCounters()).toMatchObject({
			activeReservations: 0,
			reservedBytes: 0,
		});
	});
});
