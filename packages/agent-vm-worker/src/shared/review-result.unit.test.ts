import { describe, expect, test } from 'vitest';

import { reviewResultSchema } from './review-result.js';

describe('reviewResultSchema', () => {
	test('rejects missing reviewer comment text', () => {
		expect(() =>
			reviewResultSchema.parse({
				approved: false,
				summary: 'format drift',
				comments: [{ file: 'README.md', severity: 'suggestion' }],
			}),
		).toThrow();
	});

	test('rejects missing reviewer comment file', () => {
		expect(() =>
			reviewResultSchema.parse({
				approved: false,
				summary: 'format drift',
				comments: [{ severity: 'suggestion', comment: 'missing file' }],
			}),
		).toThrow();
	});
});
