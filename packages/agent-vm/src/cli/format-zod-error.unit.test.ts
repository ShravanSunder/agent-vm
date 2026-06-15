import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { formatZodError } from './format-zod-error.js';

const mediatedSecretSchema = z.union([
	z
		.object({
			source: z.literal('1password'),
			ref: z.string().min(1),
			injection: z.literal('http-mediation'),
			audience: z.literal('gateway'),
			hosts: z.array(z.string().min(1)).min(1),
		})
		.strict(),
	z
		.object({
			source: z.literal('1password'),
			ref: z.string().min(1),
			injection: z.literal('http-mediation'),
			audience: z.enum(['tool-vm', 'both']),
			hosts: z.array(z.string().min(1)).min(1),
			agentAccess: z.union([z.literal('all'), z.array(z.string().min(1)).min(1)]),
		})
		.strict(),
]);

const systemConfigSliceSchema = z.object({
	zones: z.array(
		z.object({
			secrets: z.record(z.string().min(1), mediatedSecretSchema),
		}),
	),
});

describe('formatZodError', () => {
	it('surfaces nested union errors from the closest matching branch', () => {
		const parsedConfig = systemConfigSliceSchema.safeParse({
			zones: [
				{
					secrets: {
						PERPLEXITY_API_KEY: {
							source: '1password',
							ref: 'op://vault/item/field',
							injection: 'http-mediation',
							audience: 'both',
							hosts: ['api.perplexity.ai'],
						},
					},
				},
			],
		});

		expect(parsedConfig.success).toBe(false);
		if (parsedConfig.success) {
			return;
		}

		expect(formatZodError('Invalid config/system.jsonc configuration:', parsedConfig.error)).toBe(
			[
				'Invalid config/system.jsonc configuration:',
				'  zones[0].secrets.PERPLEXITY_API_KEY.agentAccess: agentAccess must be "all" or a non-empty array of declared zone agent ids',
			].join('\n'),
		);
	});
});
