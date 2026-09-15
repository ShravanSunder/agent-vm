import { createHash } from 'node:crypto';

import type { CompiledCatalogTypescriptBundle } from '@agent-vm/mcp-portal/catalog-typescript';
import { describe, expect, it, vi } from 'vitest';

import {
	PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_BYTES,
	PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_ENTRIES,
	PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_OFFERS,
	createPreparedCatalogSourceCache,
	type PreparedCatalogSourceAuthority,
} from './prepared-catalog-source-cache.js';

const fingerprintA = 'a'.repeat(64);
const fingerprintB = 'b'.repeat(64);
const fingerprintC = 'c'.repeat(64);

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function authority(
	overrides: Partial<PreparedCatalogSourceAuthority> = {},
): PreparedCatalogSourceAuthority {
	return {
		activeRevision: 'active-1',
		catalogRevision: 'catalog-1',
		connectionId: 'connection-1',
		gatewayEpoch: 'gateway-1',
		profileAssignmentRevision: 'assignment-1',
		profileId: 'profile-1',
		profilePolicyRevision: 'policy-1',
		providerRevision: 'provider-1',
		schemaRevision: 'schema-1',
		sessionId: 'session-1',
		stablePrincipal: 'principal-1',
		turnId: 'turn-1',
		...overrides,
	};
}

function bundle(
	definitionFingerprint: string,
	sources: readonly string[],
): CompiledCatalogTypescriptBundle {
	const files = sources.map((source, index) => ({
		byteLength: Buffer.byteLength(source),
		namespace: `namespace-${index}`,
		path: `namespace-${index}.ts`,
		sha256: sha256(source),
		source,
	}));
	return {
		definitionFingerprint,
		files,
		manifest: {
			definitionFingerprint,
			generatorVersion: '1',
			namespaces: files.map((file, index) => ({
				exportedFactoryName: `bindNamespace${index}Tools`,
				modulePath: file.path,
				namespace: file.namespace,
				tools: [],
			})),
			sdkContractVersion: '1',
			tools: [],
		},
		nativeTools: [],
	};
}

describe('prepared catalog source cache', () => {
	it('publishes the designed independent cache and offer capacities', () => {
		expect(PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_BYTES).toBe(64 * 1_024 * 1_024);
		expect(PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_ENTRIES).toBe(128);
		expect(PREPARED_CATALOG_SOURCE_CACHE_MAXIMUM_OFFERS).toBe(128);
	});

	it('uses the real compiler, reuses unchanged input, and serves immutable stateless ranges', async () => {
		const cache = createPreparedCatalogSourceCache();
		const input = {
			tools: [{ inputSchema: { type: 'object' }, name: 'lookup', namespace: 'google' }],
		};
		const first = await cache.prepare({ authority: authority(), input });
		const second = await cache.prepare({ authority: authority(), input });
		expect(first.kind).toBe('complete');
		expect(second).toMatchObject({ cacheDisposition: 'reused', kind: 'complete' });
		if (first.kind !== 'complete') throw new Error('Expected complete catalog.');
		const offered = cache.offer({
			authority: authority(),
			definitionFingerprint: first.manifest.definitionFingerprint,
		});
		expect(offered.kind).toBe('offered');
		if (offered.kind !== 'offered') throw new Error('Expected offered catalog.');
		const firstRange = cache.read({
			authority: authority(),
			definitionFingerprint: offered.manifest.definitionFingerprint,
			length: 64,
			offerId: offered.offerId,
			offset: 0,
		});
		const repeatedRange = cache.read({
			authority: authority(),
			definitionFingerprint: offered.manifest.definitionFingerprint,
			length: 64,
			offerId: offered.offerId,
			offset: 0,
		});
		expect(repeatedRange).toEqual(firstRange);
		expect(firstRange).toMatchObject({
			byteLength: 64,
			eof: false,
			kind: 'content',
			totalLength: offered.manifest.bundleByteLength,
		});
	});

	it('admits only complete startup or foreground offer scopes', async () => {
		const cache = createPreparedCatalogSourceCache({
			compile: async () => bundle(fingerprintA, ['content']),
			fingerprint: () => fingerprintA,
		});
		const {
			sessionId: _startupSessionId,
			turnId: _startupTurnId,
			...startupAuthority
		} = authority();
		const { turnId: _sessionOnlyTurnId, ...sessionOnlyAuthority } = authority();
		const { sessionId: _turnOnlySessionId, ...turnOnlyAuthority } = authority();
		await cache.prepare({ authority: startupAuthority, input: { tools: [] } });
		const startupOffer = cache.offer({
			authority: startupAuthority,
			definitionFingerprint: fingerprintA,
		});
		expect(startupOffer.kind).toBe('offered');
		if (startupOffer.kind !== 'offered') throw new Error('Expected startup offer.');
		expect(
			cache.read({
				authority: startupAuthority,
				definitionFingerprint: fingerprintA,
				length: 1,
				offerId: startupOffer.offerId,
				offset: 0,
			}).kind,
		).toBe('content');
		expect(
			cache.offer({
				authority: sessionOnlyAuthority,
				definitionFingerprint: fingerprintA,
			}).kind,
		).toBe('unavailable');
		expect(
			cache.offer({
				authority: turnOnlyAuthority,
				definitionFingerprint: fingerprintA,
			}).kind,
		).toBe('unavailable');
		expect(
			cache.read({
				authority: authority(),
				definitionFingerprint: fingerprintA,
				length: 1,
				offerId: startupOffer.offerId,
				offset: 0,
			}).kind,
		).toBe('unavailable');
		expect(
			cache.release({
				authority: startupAuthority,
				definitionFingerprint: fingerprintA,
				offerId: startupOffer.offerId,
			}).kind,
		).toBe('released');
	});

	it('joins concurrent preparation for one authority revision', async () => {
		const compilation = Promise.withResolvers<CompiledCatalogTypescriptBundle>();
		const compile = vi.fn(async () => await compilation.promise);
		const cache = createPreparedCatalogSourceCache({
			compile,
			fingerprint: (input) => (input.tools[0]?.name === 'first' ? fingerprintA : fingerprintB),
		});
		const first = cache.prepare({
			authority: authority(),
			input: { tools: [{ inputSchema: {}, name: 'first', namespace: 'n' }] },
		});
		const joined = cache.prepare({
			authority: authority(),
			input: { tools: [{ inputSchema: {}, name: 'second', namespace: 'n' }] },
		});
		compilation.resolve(bundle(fingerprintA, ['source']));

		expect(await Promise.all([first, joined])).toEqual([
			expect.objectContaining({ kind: 'complete' }),
			expect.objectContaining({ kind: 'complete' }),
		]);
		expect(compile).toHaveBeenCalledTimes(1);
	});

	it('retains and reads a bundle above the operation artifact limit without time expiry', async () => {
		const largeBundle = bundle(fingerprintA, ['x'.repeat(600_000), 'y'.repeat(600_000)]);
		let now = 0;
		const cache = createPreparedCatalogSourceCache({
			compile: vi.fn(async () => largeBundle),
			fingerprint: () => fingerprintA,
		});
		const prepared = await cache.prepare({ authority: authority(), input: { tools: [] } });
		expect(prepared.kind).toBe('complete');
		if (prepared.kind !== 'complete') throw new Error('Expected complete catalog.');
		expect(prepared.manifest.bundleByteLength).toBeGreaterThan(1_024 * 1_024);
		now += 6 * 60_000;
		const offered = cache.offer({ authority: authority(), definitionFingerprint: fingerprintA });
		expect(now).toBeGreaterThan(5 * 60_000);
		expect(offered.kind).toBe('offered');
	});

	it('does not replace the prior complete source when refresh compilation fails', async () => {
		const compile = vi
			.fn()
			.mockResolvedValueOnce(bundle(fingerprintA, ['first']))
			.mockRejectedValueOnce(new Error('refresh failed'));
		const fingerprints = [fingerprintA, fingerprintB];
		const cache = createPreparedCatalogSourceCache({
			compile,
			fingerprint: () => fingerprints.shift() ?? fingerprintB,
		});
		expect((await cache.prepare({ authority: authority(), input: { tools: [] } })).kind).toBe(
			'complete',
		);
		const refreshedAuthority = authority({
			activeRevision: 'active-2',
			catalogRevision: 'catalog-2',
		});
		const failed = await cache.prepare({
			authority: refreshedAuthority,
			input: { tools: [{ inputSchema: {}, name: 'changed', namespace: 'n' }] },
		});
		expect(failed).toMatchObject({
			kind: 'incomplete',
			reason: 'catalog-preparation-failed',
			retainedDefinitionFingerprint: fingerprintA,
		});
		expect(
			cache.offer({ authority: refreshedAuthority, definitionFingerprint: fingerprintA }).kind,
		).toBe('offered');
	});

	it('rejects forged principal, profile, session, turn, connection, stale fingerprint, and invalid ranges', async () => {
		const cache = createPreparedCatalogSourceCache({
			compile: async () => bundle(fingerprintA, ['content']),
			fingerprint: () => fingerprintA,
		});
		await cache.prepare({ authority: authority(), input: { tools: [] } });
		const offered = cache.offer({ authority: authority(), definitionFingerprint: fingerprintA });
		if (offered.kind !== 'offered') throw new Error('Expected offered catalog.');
		for (const forged of [
			authority({ activeRevision: 'other' }),
			authority({ catalogRevision: 'other' }),
			authority({ gatewayEpoch: 'other' }),
			authority({ profileAssignmentRevision: 'other' }),
			authority({ stablePrincipal: 'other' }),
			authority({ profileId: 'other' }),
			authority({ profilePolicyRevision: 'other' }),
			authority({ providerRevision: 'other' }),
			authority({ schemaRevision: 'other' }),
			authority({ sessionId: 'other' }),
			authority({ turnId: 'other' }),
			authority({ connectionId: 'other' }),
		]) {
			expect(
				cache.read({
					authority: forged,
					definitionFingerprint: fingerprintA,
					length: 1,
					offerId: offered.offerId,
					offset: 0,
				}).kind,
			).toBe('unavailable');
		}
		expect(
			cache.read({
				authority: authority(),
				definitionFingerprint: fingerprintB,
				length: 1,
				offerId: offered.offerId,
				offset: 0,
			}).kind,
		).toBe('unavailable');
		expect(
			cache.read({
				authority: authority(),
				definitionFingerprint: fingerprintA,
				length: 65_537,
				offerId: offered.offerId,
				offset: 0,
			}).kind,
		).toBe('unavailable');
		expect(
			cache.read({
				authority: authority(),
				definitionFingerprint: fingerprintA,
				length: 1,
				offerId: offered.offerId,
				offset: offered.manifest.bundleByteLength,
			}).kind,
		).toBe('unavailable');
	});

	it('retains offered superseded entries, releases them, and refuses protected-capacity overflow', async () => {
		const bundles = [
			bundle(fingerprintA, ['a'.repeat(200)]),
			bundle(fingerprintB, ['b'.repeat(200)]),
			bundle(fingerprintC, ['c'.repeat(1_500)]),
		];
		const fingerprints = [fingerprintA, fingerprintB, fingerprintC];
		const cache = createPreparedCatalogSourceCache({
			compile: async () => bundles.shift() ?? bundle(fingerprintC, ['c']),
			fingerprint: () => fingerprints.shift() ?? fingerprintC,
			limits: { maximumBytes: 2_000, maximumEntries: 2, maximumOffers: 1 },
		});
		await cache.prepare({ authority: authority(), input: { tools: [] } });
		const offer = cache.offer({ authority: authority(), definitionFingerprint: fingerprintA });
		if (offer.kind !== 'offered') throw new Error('Expected offered catalog.');
		expect(cache.offer({ authority: authority(), definitionFingerprint: fingerprintA }).kind).toBe(
			'unavailable',
		);
		expect(
			(
				await cache.prepare({
					authority: authority(),
					input: { tools: [{ inputSchema: {}, name: 'b', namespace: 'n' }] },
				})
			).kind,
		).toBe('complete');
		const overflow = await cache.prepare({
			authority: authority(),
			input: { tools: [{ inputSchema: {}, name: 'c', namespace: 'n' }] },
		});
		expect(overflow).toMatchObject({
			kind: 'incomplete',
			reason: 'catalog-capacity-exhausted',
			retainedDefinitionFingerprint: fingerprintB,
		});
		const releaseRequest = {
			authority: authority(),
			definitionFingerprint: fingerprintA,
			offerId: offer.offerId,
		};
		expect(cache.release(releaseRequest).kind).toBe('released');
		expect(cache.release(releaseRequest).kind).toBe('released');
		expect(cache.offer({ authority: authority(), definitionFingerprint: fingerprintB }).kind).toBe(
			'offered',
		);
	});

	it('retires connection offers and the complete epoch without affecting operation artifacts', async () => {
		const cache = createPreparedCatalogSourceCache({
			compile: async () => bundle(fingerprintA, ['content']),
			fingerprint: () => fingerprintA,
		});
		await cache.prepare({ authority: authority(), input: { tools: [] } });
		const first = cache.offer({ authority: authority(), definitionFingerprint: fingerprintA });
		if (first.kind !== 'offered') throw new Error('Expected offered catalog.');
		cache.retireConnection('connection-1');
		expect(
			cache.read({
				authority: authority(),
				definitionFingerprint: fingerprintA,
				length: 1,
				offerId: first.offerId,
				offset: 0,
			}).kind,
		).toBe('unavailable');
		cache.retireEpoch();
		expect(cache.inspect()).toEqual({ byteLength: 0, entries: 0, offers: 0, retired: true });
	});

	it('does not resurrect an entry when epoch retirement wins an active compilation', async () => {
		const compilation = Promise.withResolvers<CompiledCatalogTypescriptBundle>();
		const cache = createPreparedCatalogSourceCache({
			compile: async () => await compilation.promise,
			fingerprint: () => fingerprintA,
		});
		const preparation = cache.prepare({ authority: authority(), input: { tools: [] } });

		cache.retireEpoch();
		compilation.resolve(bundle(fingerprintA, ['content']));

		expect(await preparation).toMatchObject({ kind: 'incomplete' });
		expect(cache.inspect()).toEqual({ byteLength: 0, entries: 0, offers: 0, retired: true });
	});
});
