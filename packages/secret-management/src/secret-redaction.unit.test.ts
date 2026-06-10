import { describe, expect, it } from 'vitest';

import { redactOnePasswordReferences } from './secret-redaction.js';

describe('redactOnePasswordReferences', () => {
	it('redacts ordinary 1Password refs without changing non-secret text', () => {
		expect(
			redactOnePasswordReferences('Failed to read op://agent-vm/sunfam-gateway-auth/password'),
		).toBe('Failed to read <1password-ref>');
	});

	it('redacts quoted 1Password refs that contain spaces or delimiters', () => {
		const redactedMessage = redactOnePasswordReferences(
			"Failed from 'op://vault/team item/field;with)delimiters': not found",
		);

		expect(redactedMessage).toBe("Failed from '<1password-ref>': not found");
		expect(redactedMessage).not.toContain('op://');
		expect(redactedMessage).not.toContain('team item');
		expect(redactedMessage).not.toContain('with)delimiters');
	});

	it('redacts unquoted 1Password refs through the end of the line', () => {
		const redactedMessage = redactOnePasswordReferences(
			'Failed op://vault/team item/field;with)delimiters before retry\nnext diagnostic line',
		);

		expect(redactedMessage).toBe('Failed <1password-ref>\nnext diagnostic line');
		expect(redactedMessage).not.toContain('op://');
		expect(redactedMessage).not.toContain('team item');
		expect(redactedMessage).not.toContain('before retry');
	});
});
