import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	controllerPullDefaultResponseSchema,
	controllerRetireCredentialedRuntimeRequestSchema,
} from './controller-request-schemas.js';
import * as controllerRequestSchemas from './controller-request-schemas.js';

describe('controller request schemas', () => {
	it('does not export the retired VM-facing lease create request schema', () => {
		expect(controllerRequestSchemas).not.toHaveProperty('controllerLeaseCreateRequestSchema');
	});

	it('accepts only bounded credentialed runtime retirement authority', () => {
		expect(
			controllerRetireCredentialedRuntimeRequestSchema.parse({
				adminToken: 'admin-token',
				agentId: 'sun',
				force: true,
			}),
		).toEqual({ adminToken: 'admin-token', agentId: 'sun', force: true });
		for (const forbiddenField of [
			'credentialBinding',
			'credentialRef',
			'filePath',
			'leaseId',
			'vmId',
		]) {
			expect(
				controllerRetireCredentialedRuntimeRequestSchema.safeParse({
					agentId: 'sun',
					force: false,
					[forbiddenField]: 'forbidden',
				}).success,
			).toBe(false);
		}
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
