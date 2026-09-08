import { describe, expect, it } from 'vitest';

import {
	controllerEnableSshRequestSchema,
	controllerRetireCredentialedRuntimeRequestSchema,
} from './controller-request-schemas.js';
import * as controllerRequestSchemas from './controller-request-schemas.js';

describe('controller request schemas', () => {
	it('accepts only the optional zone admin token for SSH', () => {
		expect(controllerEnableSshRequestSchema.parse({})).toEqual({});
		expect(controllerEnableSshRequestSchema.parse({ adminToken: 'zone-admin-token' })).toEqual({
			adminToken: 'zone-admin-token',
		});
	});

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

	it.each(['default', 'gateway-token', 'all-secrets'])(
		'rejects removed SSH secret environment mode %s',
		(secretEnv) => {
			expect(controllerEnableSshRequestSchema.safeParse({ secretEnv }).success).toBe(false);
		},
	);
});
