import { describe, expect, it } from 'vitest';

import type { JsonObject } from './json-schema.js';
import { buildZodValidatorFromJsonSchema } from './zod-schema-loader.js';

describe('zod from JSON Schema loader', () => {
	it('validates object arguments before upstream calls', () => {
		const validator = buildZodValidatorFromJsonSchema({
			properties: {
				title: { minLength: 1, type: 'string' },
			},
			required: ['title'],
			type: 'object',
		});

		expect(validator.ok).toBe(true);
		if (!validator.ok) {
			throw new Error('validator should build');
		}

		expect(validator.validate({ title: 'Fix auth' })).toEqual({
			ok: true,
			value: { title: 'Fix auth' },
		});
		expect(validator.validate({ title: '' })).toMatchObject({
			error: {
				kind: 'input_validation',
				issues: [{ path: ['title'] }],
			},
			ok: false,
		});
	});

	it('reports actionable validation issue details for agent correction', () => {
		const validator = buildZodValidatorFromJsonSchema({
			additionalProperties: false,
			properties: {
				max_results: { type: 'number' },
				search_depth: { enum: ['basic', 'advanced'], type: 'string' },
				title: { type: 'string' },
			},
			required: ['title'],
			type: 'object',
		});

		expect(validator.ok).toBe(true);
		if (!validator.ok) {
			throw new Error('validator should build');
		}

		expect(
			validator.validate({
				extra: true,
				max_results: '3',
				search_depth: 'deep',
			}),
		).toMatchObject({
			error: {
				kind: 'input_validation',
				issues: expect.arrayContaining([
					expect.objectContaining({
						code: 'invalid_type',
						expected: 'string',
						path: ['title'],
						received: { type: 'undefined' },
					}),
					expect.objectContaining({
						code: 'invalid_type',
						expected: 'number',
						path: ['max_results'],
						received: { preview: '3', type: 'string' },
					}),
					expect.objectContaining({
						code: 'invalid_value',
						path: ['search_depth'],
						received: { preview: 'deep', type: 'string' },
						values: ['basic', 'advanced'],
					}),
					expect.objectContaining({
						code: 'unrecognized_keys',
						keys: ['extra'],
						path: [],
					}),
				]),
			},
			ok: false,
		});
	});

	it('names unsupported JSON Schema features instead of calling upstream blind', () => {
		const validator = buildZodValidatorFromJsonSchema({
			properties: {
				value: { type: 'string' },
			},
			unevaluatedProperties: false,
			type: 'object',
		});

		expect(validator).toEqual({
			error: {
				feature: 'unevaluatedProperties',
				kind: 'schema_validation_unavailable',
				message:
					'JSON Schema feature "unevaluatedProperties" is not supported by the portal validator.',
				path: ['unevaluatedProperties'],
			},
			ok: false,
		});
	});

	it('does not mutate supported or hard fixture schemas while reporting build status', () => {
		const fixtures: JsonObject[] = [
			{
				$defs: {
					node: {
						properties: {
							child: { $ref: '#/$defs/node' },
							name: { type: 'string' },
						},
						type: 'object',
					},
				},
				$ref: '#/$defs/node',
			},
			{
				allOf: [{ type: 'object' }, { properties: { title: { type: 'string' } }, type: 'object' }],
			},
			{ oneOf: [{ type: 'string' }, { type: 'number' }] },
			{ anyOf: [{ type: 'string' }, { type: 'number' }] },
			{ items: [{ type: 'string' }, { type: 'number' }], type: 'array' },
			{ prefixItems: [{ type: 'string' }, { type: 'number' }], type: 'array' },
			{ patternProperties: { '^x-': { type: 'string' } }, type: 'object' },
		];

		for (const fixture of fixtures) {
			const before = JSON.stringify(fixture);
			const validator = buildZodValidatorFromJsonSchema(fixture);

			expect(JSON.stringify(fixture)).toBe(before);
			if (!validator.ok) {
				expect(validator.error.kind).toBe('schema_validation_unavailable');
				expect(validator.error.feature.length).toBeGreaterThan(0);
			}
		}
	});

	it('names each unsupported fixture feature and path', () => {
		for (const feature of [
			'not',
			'unevaluatedProperties',
			'if',
			'then',
			'else',
			'dependentSchemas',
			'contains',
			'uniqueItems',
		]) {
			const validator = buildZodValidatorFromJsonSchema({
				[feature]: feature === 'uniqueItems' ? true : {},
				type: feature === 'contains' || feature === 'uniqueItems' ? 'array' : 'object',
			});

			expect(validator).toMatchObject({
				error: {
					feature,
					kind: 'schema_validation_unavailable',
					path: [feature],
				},
				ok: false,
			});
		}
	});
});
