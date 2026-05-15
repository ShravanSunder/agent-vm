import { describe, expect, it } from 'vitest';

import { assertJsonObject, jsonObjectSchema, jsonValueSchema } from './json-schema.js';

describe('json schema value helpers', () => {
	it('accepts recursively JSON-serializable object values', () => {
		const parsed = jsonValueSchema.parse({
			properties: {
				labels: {
					items: { type: 'string' },
					type: 'array',
				},
			},
			required: ['labels'],
			type: 'object',
		});

		expect(parsed).toEqual({
			properties: {
				labels: {
					items: { type: 'string' },
					type: 'array',
				},
			},
			required: ['labels'],
			type: 'object',
		});
	});

	it('rejects non-JSON values', () => {
		expect(() => jsonObjectSchema.parse({ run: () => 'nope' })).toThrow();
		expect(() => jsonObjectSchema.parse({ maybe: undefined })).toThrow();
	});

	it('asserts plain JSON objects with a useful label', () => {
		expect(() => assertJsonObject(['not-object'], 'inputSchema')).toThrow(
			'inputSchema must be a JSON object.',
		);
	});
});
