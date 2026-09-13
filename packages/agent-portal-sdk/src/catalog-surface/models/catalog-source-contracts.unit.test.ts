import { describe, expect, it } from 'vitest';

import {
	PORTAL_CATALOG_MAXIMUM_READ_BYTES,
	PortalCatalogReadRequestSchema,
	PortalCatalogReadResultSchema,
	PortalCatalogSourceManifestSchema,
} from './catalog-source-contracts.js';

describe('catalog source contracts', () => {
	it('accepts the maximum stateless read and rejects larger ranges', () => {
		const request = {
			definitionFingerprint: 'a'.repeat(64),
			length: PORTAL_CATALOG_MAXIMUM_READ_BYTES,
			offerId: 'offer-1',
			offset: 0,
		};
		expect(PortalCatalogReadRequestSchema.safeParse(request).success).toBe(true);
		expect(
			PortalCatalogReadRequestSchema.safeParse({
				...request,
				length: PORTAL_CATALOG_MAXIMUM_READ_BYTES + 1,
			}).success,
		).toBe(false);
	});

	it('rejects malformed base64 and traversal paths at the portable contract boundary', () => {
		expect(
			PortalCatalogReadResultSchema.safeParse({
				byteLength: 1,
				contentBase64: '***',
				eof: true,
				kind: 'content',
				totalLength: 1,
			}).success,
		).toBe(false);
		expect(
			PortalCatalogSourceManifestSchema.safeParse({
				bundleByteLength: 1,
				bundleSha256: `sha256:${'b'.repeat(64)}`,
				definitionFingerprint: 'a'.repeat(64),
				files: [{ byteLength: 1, namespace: 'n', path: '../escape.ts', sha256: 'c'.repeat(64) }],
				generatorVersion: '1',
				namespaces: [],
				sdkContractVersion: '1',
			}).success,
		).toBe(false);
	});
});
