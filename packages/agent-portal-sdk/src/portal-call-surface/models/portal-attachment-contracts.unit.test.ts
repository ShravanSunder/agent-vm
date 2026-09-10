import { describe, expect, it } from 'vitest';

import {
	PortalAttachmentRequestSchema,
	PortalAttachmentResultSchema,
} from './portal-attachment-contracts.js';

describe('private native attachment metadata contracts', () => {
	it('accepts a selected source, never a caller-selected destination or recipient', () => {
		// Arrange
		const request = {
			action: 'stage',
			source: {
				kind: 'operation-file',
				referenceId: '11111111-1111-4111-8111-111111111111',
				path: 'report.pdf',
			},
		};
		// Act / Assert
		expect(PortalAttachmentRequestSchema.safeParse(request).success).toBe(true);
		expect(PortalAttachmentRequestSchema.safeParse({ ...request, chatId: 'other' }).success).toBe(
			false,
		);
		expect(
			PortalAttachmentRequestSchema.safeParse({ ...request, gatewayPath: '/secret' }).success,
		).toBe(false);
	});
	it('returns only bounded staging metadata and rejects payload bytes or host paths', () => {
		// Arrange
		const result = {
			kind: 'staged',
			stagingId: '11111111-1111-4111-8111-111111111111',
			path: '/home/hermes/.cache/agent-vm-native/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/portal-native-sun-11111111-1111-4111-8111-111111111111/report.pdf',
			byteLength: 4,
			sha256: 'a'.repeat(64),
		};
		// Act / Assert
		expect(PortalAttachmentResultSchema.safeParse(result).success).toBe(true);
		expect(PortalAttachmentResultSchema.safeParse({ ...result, contents: 'payload' }).success).toBe(
			false,
		);
		expect(
			PortalAttachmentResultSchema.safeParse({ ...result, path: '/Users/person/file' }).success,
		).toBe(false);
	});
});
