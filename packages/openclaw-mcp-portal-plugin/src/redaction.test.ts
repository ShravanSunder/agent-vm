import { describe, expect, it } from 'vitest';

import { redactPortalSecrets } from './redaction.js';

describe('portal redaction', () => {
	it('redacts binding and upstream credential values', () => {
		const redacted = redactPortalSecrets(
			'Authorization: Bearer upstream-secret and binding-secret',
			['binding-secret'],
		);

		expect(redacted).toBe('Authorization: [REDACTED] and [REDACTED]');
	});
});
