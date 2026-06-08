import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { workerConfigSchema } from '../config/worker-config.js';

describe('Zod native JSON Schema conversion', () => {
	it('uses z.toJSONSchema for draft-7 input object schemas', () => {
		const schema = z
			.object({
				count: z.number().int().optional(),
				labels: z.array(z.string()).default([]),
				name: z.string().min(1),
			})
			.strict();

		const jsonSchema = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' });

		expect(jsonSchema).toMatchObject({
			$schema: 'http://json-schema.org/draft-07/schema#',
			additionalProperties: false,
			properties: {
				count: {
					maximum: 9007199254740991,
					minimum: -9007199254740991,
					type: 'integer',
				},
				labels: {
					default: [],
					items: { type: 'string' },
					type: 'array',
				},
				name: {
					minLength: 1,
					type: 'string',
				},
			},
			required: ['name'],
			type: 'object',
		});
	});

	it('uses z.toJSONSchema for OpenAPI nullable output schemas', () => {
		const jsonSchema = z.toJSONSchema(z.string().nullable(), {
			io: 'output',
			target: 'openapi-3.0',
		});

		expect(jsonSchema).toEqual({
			nullable: true,
			type: 'string',
		});
	});

	it('converts the production worker config schema with native z.toJSONSchema', () => {
		const jsonSchema = z.toJSONSchema(workerConfigSchema, {
			io: 'input',
			target: 'draft-7',
		});

		expect(jsonSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				branchPrefix: {
					default: 'agent/',
					type: 'string',
				},
				mcpServers: {
					default: [],
					type: 'array',
				},
				phases: {
					additionalProperties: false,
					type: 'object',
				},
				runtimeInstructions: {
					minLength: 1,
					type: 'string',
				},
			},
			required: ['runtimeInstructions', 'phases'],
			type: 'object',
		});
	});
});
