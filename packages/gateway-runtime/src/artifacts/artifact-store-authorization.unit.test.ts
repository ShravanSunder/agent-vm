import { createHash } from 'node:crypto';

import type { PortalArtifactReadRequest } from '@agent-vm/agent-portal-sdk/artifact-surface';
import { describe, expect, it } from 'vitest';

import {
	type ArtifactReadCaller,
	baseAuthorization,
	baseCaller,
	callerMutations,
	createRecordingStorage,
	createStoreFixture,
	currentAuthorityMutations,
	defaultLimits,
	expectStoreError,
	fixedNowMilliseconds,
	loadArtifactStoreModule,
	readRequest,
	writeArtifact,
} from './artifact-store-test-fixture.js';

describe('Gateway runtime epoch-local artifact store', () => {
	it('requires an exact server-derived read authority resolver at construction', async () => {
		// Arrange
		const module = await loadArtifactStoreModule();
		const storage = createRecordingStorage();

		// Act
		const createWithoutAuthorityResolver = (): unknown =>
			Reflect.apply(module.createGatewayRuntimeArtifactStore, undefined, [
				{
					epochId: 'gateway-epoch-a',
					limits: defaultLimits,
					storageBackend: storage.backend,
				},
			]);

		// Assert
		expect(createWithoutAuthorityResolver).toThrow();
	});

	it('commits the exact SHA-256 reference, reconciles reservation bytes, and reads truthful ranges', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5]);

		// Act
		const reference = await writeArtifact(fixture, bytes, { maximumBytes: 10 });
		const middle = await fixture.store.read({
			caller: baseCaller,
			request: readRequest(reference, { maxBytes: 2, offsetBytes: 2 }),
		});
		const tail = await fixture.store.read({
			caller: baseCaller,
			request: readRequest(reference, { maxBytes: 10, offsetBytes: 4 }),
		});
		const overrunHandle = await fixture.store.beginWrite({
			authorization: baseAuthorization,
			lifetimeMs: 100,
			maximumBytes: 1,
		});
		const overrunError = await expectStoreError(
			fixture.module,
			() => overrunHandle.write(Uint8Array.from([8, 9])),
			'capacity',
		);

		// Assert
		expect(reference).toEqual({
			byteLength: 6,
			expiresAt: new Date(fixedNowMilliseconds + 500).toISOString(),
			fingerprint: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
			id: `${createHash('sha256').update('gateway-epoch-a').digest('hex').slice(0, 16)}-artifact-1`,
			mediaType: 'application/octet-stream',
		});
		expect(middle).toEqual({
			contentBase64: Buffer.from([2, 3]).toString('base64'),
			mediaType: 'application/octet-stream',
			offsetBytes: 2,
			reference,
			truncated: true,
		});
		expect(tail).toMatchObject({
			contentBase64: Buffer.from([4, 5]).toString('base64'),
			offsetBytes: 4,
			truncated: false,
		});
		expect(fixture.authority.calls).toEqual([
			{ caller: baseCaller, storedAuthorization: baseAuthorization },
			{ caller: baseCaller, storedAuthorization: baseAuthorization },
		]);
		expect(overrunError.code).toBe('capacity');
		expect(fixture.store.inspectCounters()).toEqual({
			activeReservations: 0,
			artifactCount: 1,
			committedBytes: 6,
			orphanedArtifactCount: 0,
			orphanedBytes: 0,
			reservedBytes: 0,
			retired: false,
		});
	});

	it('denies an ID-only read and rejects tampered reference authority before storage access', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const reference = await writeArtifact(fixture, Uint8Array.from([1, 2, 3]));
		const idOnlyRequest = { artifactId: reference.id, maxBytes: 3, offsetBytes: 0 };
		const tamperedReference = { ...reference, byteLength: reference.byteLength + 1 };

		// Act
		const idOnlyError = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.read({
					caller: baseCaller,
					request: idOnlyRequest as unknown as PortalArtifactReadRequest,
				}),
			'not-authorized',
		);
		const tamperError = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.read({
					caller: baseCaller,
					request: readRequest(tamperedReference),
				}),
			'not-authorized',
		);

		// Assert
		expect([idOnlyError.code, tamperError.code]).toEqual(['not-authorized', 'not-authorized']);
		expect(fixture.storage.readRequests).toEqual([]);
	});

	it('rejects an artifact fingerprint mismatch before storage access', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const reference = await writeArtifact(fixture, Uint8Array.from([4, 5, 6]));
		const wrongFingerprint = `sha256:${'0'.repeat(64)}`;

		// Act
		const error = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.read({
					caller: baseCaller,
					request: readRequest({ ...reference, fingerprint: wrongFingerprint }),
				}),
			'not-authorized',
		);

		// Assert
		expect(error.code).toBe('not-authorized');
		expect(fixture.storage.readRequests).toEqual([]);
	});

	it.each(callerMutations)(
		'denies a mismatched server-derived $label principal before storage access',
		async ({ mutate }): Promise<void> => {
			// Arrange
			const fixture = await createStoreFixture();
			const reference = await writeArtifact(fixture, Uint8Array.from([7, 8]));
			const mismatchedCaller = mutate();

			// Act
			const error = await expectStoreError(
				fixture.module,
				() =>
					fixture.store.read({
						caller: mismatchedCaller,
						request: readRequest(reference),
					}),
				'not-authorized',
			);

			// Assert
			expect(error.code).toBe('not-authorized');
			expect(fixture.authority.calls).toEqual([
				{ caller: mismatchedCaller, storedAuthorization: baseAuthorization },
			]);
			expect(fixture.storage.readRequests).toEqual([]);
		},
	);

	it('denies a cross-surface caller before storage access', async () => {
		// Arrange
		const fixture = await createStoreFixture();
		const reference = await writeArtifact(fixture, Uint8Array.from([7, 8]));
		const crossSurfaceCaller = {
			principal: baseCaller.principal,
			surfaceClass: 'protected_uds',
		} as const satisfies ArtifactReadCaller;

		// Act
		const error = await expectStoreError(
			fixture.module,
			() =>
				fixture.store.read({
					caller: crossSurfaceCaller,
					request: readRequest(reference),
				}),
			'not-authorized',
		);

		// Assert
		expect(error.code).toBe('not-authorized');
		expect(fixture.authority.calls).toEqual([
			{ caller: crossSurfaceCaller, storedAuthorization: baseAuthorization },
		]);
		expect(fixture.storage.readRequests).toEqual([]);
	});

	it.each(currentAuthorityMutations)(
		'denies stale stored $label authority before storage access',
		async ({ mutate }): Promise<void> => {
			// Arrange
			const fixture = await createStoreFixture();
			const reference = await writeArtifact(fixture, Uint8Array.from([7, 8]));
			fixture.authority.controls.currentAuthorization = mutate();

			// Act
			const error = await expectStoreError(
				fixture.module,
				() =>
					fixture.store.read({
						caller: baseCaller,
						request: readRequest(reference),
					}),
				'not-authorized',
			);

			// Assert
			expect(error.code).toBe('not-authorized');
			expect(fixture.authority.calls).toEqual([
				{ caller: baseCaller, storedAuthorization: baseAuthorization },
			]);
			expect(fixture.storage.readRequests).toEqual([]);
		},
	);
});
