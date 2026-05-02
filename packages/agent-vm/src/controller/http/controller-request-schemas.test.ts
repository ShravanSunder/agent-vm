import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { controllerLeaseCreateRequestSchema } from './controller-request-schemas.js';

describe('controller request schemas', () => {
	it('converts the production lease create request schema with native z.toJSONSchema', () => {
		const jsonSchema = z.toJSONSchema(controllerLeaseCreateRequestSchema, {
			io: 'input',
			target: 'draft-7',
		});

		expect(jsonSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				agentWorkspaceDir: { minLength: 1, type: 'string' },
				profileId: { minLength: 1, type: 'string' },
				scopeKey: { minLength: 1, type: 'string' },
				workMountDir: { minLength: 1, type: 'string' },
				zoneId: { minLength: 1, type: 'string' },
			},
			required: ['agentWorkspaceDir', 'profileId', 'scopeKey', 'workMountDir', 'zoneId'],
			type: 'object',
		});
	});
});
