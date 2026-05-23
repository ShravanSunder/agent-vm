import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	controllerLeaseCreateRequestSchema,
	controllerPullDefaultResponseSchema,
} from './controller-request-schemas.js';

describe('controller request schemas', () => {
	it('converts the production lease create request schema with native z.toJSONSchema', () => {
		const jsonSchema = z.toJSONSchema(controllerLeaseCreateRequestSchema, {
			io: 'input',
			target: 'draft-7',
		});

		expect(jsonSchema).toMatchObject({
			additionalProperties: false,
			properties: {
				agentId: { minLength: 1, type: 'string' },
				agentWorkspaceDir: { minLength: 1, type: 'string' },
				profileId: { minLength: 1, type: 'string' },
				sandbox: expect.objectContaining({
					required: ['backend', 'mode', 'scope', 'workspaceAccess'],
					type: 'object',
				}),
				scopeKey: { minLength: 1, type: 'string' },
				sessionKey: { minLength: 1, type: 'string' },
				workMountDir: { minLength: 1, type: 'string' },
				zoneId: { minLength: 1, type: 'string' },
			},
			required: [
				'agentId',
				'agentWorkspaceDir',
				'profileId',
				'sandbox',
				'scopeKey',
				'sessionKey',
				'workMountDir',
				'zoneId',
			],
			type: 'object',
		});
	});

	it('converts the production pull-default response schema with native z.toJSONSchema', () => {
		const jsonSchema = z.toJSONSchema(controllerPullDefaultResponseSchema, {
			io: 'output',
			target: 'draft-7',
		});

		expect(jsonSchema).toMatchObject({
			oneOf: [
				expect.objectContaining({
					properties: expect.objectContaining({
						kind: { const: 'advanced', type: 'string' },
					}),
				}),
				expect.objectContaining({
					properties: expect.objectContaining({
						kind: { const: 'refused-not-fast-forward', type: 'string' },
					}),
				}),
				expect.objectContaining({
					properties: expect.objectContaining({
						kind: { const: 'failed', type: 'string' },
					}),
				}),
			],
		});
	});
});
