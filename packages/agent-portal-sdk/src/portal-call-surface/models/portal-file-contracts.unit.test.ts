import { describe, expect, it } from 'vitest';

import { PortalFileRequestSchema, PortalFileResultSchema } from './portal-file-contracts.js';

const referenceId = '55555555-5555-4555-8555-555555555555';

describe('Portal operation file contracts', () => {
	it('rejects obsolete list/materialize RPCs and caller-selected VM or root', () => {
		// Arrange / Act / Assert
		expect(PortalFileRequestSchema.safeParse({ action: 'list', referenceId }).success).toBe(false);
		expect(
			PortalFileRequestSchema.safeParse({
				action: 'materialize',
				referenceId,
				path: './report.pdf',
			}).success,
		).toBe(false);
		expect(
			PortalFileRequestSchema.safeParse({ action: 'list', referenceId, root: '/etc' }).success,
		).toBe(false);
		expect(
			PortalFileRequestSchema.safeParse({
				action: 'materialize',
				referenceId,
				path: 'report.pdf',
				vmId: 'other',
			}).success,
		).toBe(false);
	});

	it('returns native attachment metadata without payloads or obsolete copy results', () => {
		// Arrange
		const result = {
			kind: 'attached',
			messageId: 'recorded-message',
			fileName: 'report.pdf',
			byteLength: 0,
			sha256: 'a'.repeat(64),
			cleanup: 'complete',
		};
		// Act / Assert
		expect(PortalFileResultSchema.safeParse(result).success).toBe(true);
		expect(PortalFileResultSchema.safeParse({ ...result, contentBase64: 'AA==' }).success).toBe(
			false,
		);
		expect(
			PortalFileResultSchema.safeParse({ ...result, path: '/controller/report.pdf' }).success,
		).toBe(false);
		expect(
			PortalFileResultSchema.safeParse({ kind: 'listed', entries: [], limitReached: false })
				.success,
		).toBe(false);
		expect(PortalFileResultSchema.safeParse({ ...result, kind: 'materialized' }).success).toBe(
			false,
		);
		expect(
			PortalFileResultSchema.safeParse({ kind: 'failed', reason: 'unavailable' }).success,
		).toBe(true);
	});
});
