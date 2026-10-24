import { describe, expect, it } from 'vitest';

import { advertisedVersions } from '#node-host/manual-tests/advertised-protocol-versions';

describe('manual proof advertised protocol evidence', () => {
	it('excludes the rejected request before the supported clause', () => {
		const response = JSON.stringify({
			error: {
				message:
					'Unsupported protocol version: 2026-07-28. Supported versions: 2024-11-05, 2025-11-25',
			},
		});
		expect(advertisedVersions(response)).toEqual(['2024-11-05', '2025-11-25']);
	});
	it.each([
		{ result: { supportedVersions: ['2026-07-28'] } },
		{ error: { message: 'Unsupported request', data: { supported: ['2026-07-28'] } } },
	])('reads the explicit structured list', (payload) => {
		expect(advertisedVersions(JSON.stringify(payload))).toEqual(['2026-07-28']);
	});
	it('reads an SSE data response', () => {
		const response =
			'event: message\ndata: {"error":{"message":"Supported protocol versions: 2025-11-25"}}\n\n';
		expect(advertisedVersions(response)).toEqual(['2025-11-25']);
	});
	it('does not invent offers from an unsupported request or selected version', () => {
		expect(
			advertisedVersions('{"error":{"message":"Unsupported protocol version: 2026-07-28"}}'),
		).toEqual([]);
		expect(advertisedVersions('{"result":{"protocolVersion":"2025-11-25"}}')).toEqual([]);
	});
});
