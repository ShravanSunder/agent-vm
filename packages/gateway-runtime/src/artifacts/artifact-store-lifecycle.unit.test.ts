import { describe, expect, it } from 'vitest';

import {
	type ArtifactAuthorization,
	baseAuthorization,
	baseCaller,
	createDeferredSignal,
	createRecordingAuthorityResolver,
	createRecordingStorage,
	createStoreFixture,
	expectStoreError,
	readRequest,
	writeArtifact,
} from './artifact-store-test-fixture.js';

describe('Gateway runtime epoch-local artifact store', () => {
	it('retirement invalidates reads and writes and removes committed and active artifacts', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const reference = await writeArtifact(fixture, Uint8Array.from([1, 2]));
		const activeHandle = await fixture.store.beginWrite({
			authorization: baseAuthorization,
			lifetimeMs: 100,
			maximumBytes: 3,
		});
		await activeHandle.write(Uint8Array.from([3]));

		// Act
		await fixture.store.retireEpoch();
		const readError = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.read({
					caller: baseCaller,
					request: readRequest(reference),
				}),
			'retired',
		);
		const writeError = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.beginWrite({
					authorization: baseAuthorization,
					lifetimeMs: 100,
					maximumBytes: 1,
				}),
			'retired',
		);

		// Assert
		expect([readError.code, writeError.code]).toEqual(['retired', 'retired']);
		expect(fixture.storage.readRequests).toEqual([]);
		expect(fixture.storage.removedArtifactIds).toEqual([reference.id]);
		expect(fixture.storage.discardedArtifactIds).toEqual([activeHandle.artifactId]);
		expect(fixture.store.inspectCounters()).toEqual({
			activeReservations: 0,
			artifactCount: 0,
			committedBytes: 0,
			orphanedArtifactCount: 0,
			orphanedBytes: 0,
			reservedBytes: 0,
			retired: true,
		});
	});

	it('makes retirement fencing observable while an existing backend write is stalled', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const handle = await fixture.store.beginWrite({
			authorization: baseAuthorization,
			lifetimeMs: 100,
			maximumBytes: 4,
		});
		const writeStarted = createDeferredSignal();
		const writeMayFinish = createDeferredSignal();
		fixture.storage.controls.beforeWrite = async (): Promise<void> => {
			writeStarted.resolve();
			await writeMayFinish.promise;
		};
		const stalledWritePromise = handle.write(Uint8Array.from([1, 2]));
		await writeStarted.promise;

		// Act
		const retirementPromise = fixture.store.retireEpoch();
		const countersWhileWriteIsStalled = fixture.store.inspectCounters();
		writeMayFinish.resolve();
		await stalledWritePromise;
		await retirementPromise;

		// Assert
		expect(countersWhileWriteIsStalled).toMatchObject({ retired: true });
		expect(fixture.store.inspectCounters()).toMatchObject({ retired: true });
	});

	it('transfers a failed retirement removal from committed to orphan accounting', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const reference = await writeArtifact(fixture, Uint8Array.from([1, 2, 3]));
		fixture.storage.controls.failRemove = new Error(
			'/private/artifacts secret-token retirement cleanup',
		);

		// Act
		const cleanupError = await expectStoreError(
			fixture.module,
			() => fixture.store.retireEpoch(),
			'cleanup-failed',
		);

		// Assert
		expect(cleanupError.code).toBe('cleanup-failed');
		expect(fixture.storage.removedArtifactIds).toEqual([]);
		expect(fixture.storage.bytesByArtifactId.has(reference.id)).toBe(true);
		expect(fixture.store.inspectCounters()).toEqual({
			activeReservations: 0,
			artifactCount: 0,
			committedBytes: 0,
			orphanedArtifactCount: 1,
			orphanedBytes: 3,
			reservedBytes: 0,
			retired: true,
		});
	});

	it('does not rebind a retired-epoch reference when a successor reuses its opaque ID', async () => {
		// Arrange
		const storage = createRecordingStorage();
		const predecessor = await createStoreFixture({
			createArtifactId: () => 'reused-id',
			epochId: 'gateway-epoch-old',
			storage,
		});
		const oldReference = await writeArtifact(predecessor, Uint8Array.from([1, 2]));
		await predecessor.store.retireEpoch();
		const successor = await createStoreFixture({
			createArtifactId: () => 'reused-id',
			epochId: 'gateway-epoch-new',
			storage,
		});
		const newReference = await writeArtifact(successor, Uint8Array.from([9, 9, 9]));

		// Act
		const staleReferenceError = await expectStoreError(
			successor.module,
			() =>
				successor.store.read({
					caller: baseCaller,
					request: readRequest(oldReference),
				}),
			'not-authorized',
		);
		const readRequestsAfterStaleReference = [...successor.storage.readRequests];
		const currentResult = await successor.store.read({
			caller: baseCaller,
			request: readRequest(newReference),
		});

		// Assert
		expect(staleReferenceError.code).toBe('not-authorized');
		expect(readRequestsAfterStaleReference).toEqual([]);
		expect(currentResult.contentBase64).toBe(Buffer.from([9, 9, 9]).toString('base64'));
	});

	it('rejects an identical predecessor reference after owning epoch and generation rotate with opaque ID reuse', async () => {
		// Arrange
		const storage = createRecordingStorage();
		const predecessor = await createStoreFixture({
			createArtifactId: () => 'reused-id',
			epochId: 'gateway-epoch-old',
			storage,
		});
		const artifactBytes = Uint8Array.from([1, 2]);
		const predecessorReference = await writeArtifact(predecessor, artifactBytes);
		await predecessor.store.retireEpoch();
		const successorAuthorization = {
			...baseAuthorization,
			owningGeneration: 'generation-b',
		} as const satisfies ArtifactAuthorization;
		const successorAuthority = createRecordingAuthorityResolver();
		successorAuthority.controls.currentAuthorization = successorAuthorization;
		const successor = await createStoreFixture({
			authority: successorAuthority,
			createArtifactId: () => 'reused-id',
			epochId: 'gateway-epoch-new',
			storage,
		});
		const successorHandle = await successor.store.beginWrite({
			authorization: successorAuthorization,
			lifetimeMs: 500,
			maximumBytes: artifactBytes.byteLength,
			mediaType: 'application/octet-stream',
		});
		await successorHandle.write(artifactBytes);
		const successorReference = await successorHandle.commit();

		// Act
		const staleReferenceError = await expectStoreError(
			successor.module,
			() =>
				successor.store.read({
					caller: baseCaller,
					request: readRequest(predecessorReference),
				}),
			'not-authorized',
		);

		// Assert
		expect(successorReference).not.toEqual(predecessorReference);
		expect(staleReferenceError.code).toBe('not-authorized');
		expect(successor.storage.readRequests).toEqual([]);
	});

	it('never exposes backend paths, credentials, or authority in references, results, or errors', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const reference = await writeArtifact(fixture, Uint8Array.from([4, 2]));
		const result = await fixture.store.read({
			caller: baseCaller,
			request: readRequest(reference),
		});
		fixture.storage.controls.failCreateWriter = new Error(
			'/private/artifacts/credential-file contained secret-token',
		);

		// Act
		const error = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.beginWrite({
					authorization: baseAuthorization,
					lifetimeMs: 100,
					maximumBytes: 1,
				}),
			'write-failed',
		);
		const publicText = `${JSON.stringify(reference)}${JSON.stringify(result)}${String(error)}`;

		// Assert
		expect(publicText).not.toMatch(/private\/artifacts|credential-file|secret-token/u);
		expect(publicText).not.toContain(baseAuthorization.toolPortalProfileId);
		expect(publicText).not.toContain(baseAuthorization.executionFingerprint);
		expect(Object.keys(reference)).toEqual([
			'byteLength',
			'expiresAt',
			'fingerprint',
			'id',
			'mediaType',
		]);
	});
});
