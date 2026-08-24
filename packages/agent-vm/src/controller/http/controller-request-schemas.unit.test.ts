import { describe, expect, it } from 'vitest';

import { controllerEnableSshRequestSchema } from './controller-request-schemas.js';

describe('controller enable SSH request schema', () => {
	it('accepts only the optional zone admin token', () => {
		expect(controllerEnableSshRequestSchema.parse({})).toEqual({});
		expect(controllerEnableSshRequestSchema.parse({ adminToken: 'zone-admin-token' })).toEqual({
			adminToken: 'zone-admin-token',
		});
	});

	it.each(['default', 'gateway-token', 'all-secrets'])(
		'rejects removed SSH secret environment mode %s',
		(secretEnv) => {
			expect(controllerEnableSshRequestSchema.safeParse({ secretEnv }).success).toBe(false);
		},
	);
});
