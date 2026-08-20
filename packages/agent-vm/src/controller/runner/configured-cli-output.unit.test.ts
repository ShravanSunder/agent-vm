import { describe, expect, it } from 'vitest';

import { fixedSafeConfiguredCliStderrSummary } from './configured-cli-output.js';

describe('configured CLI output projection', () => {
	it('keeps fixed stderr summaries within the encoded UTF-8 byte ceiling', () => {
		const summary = fixedSafeConfiguredCliStderrSummary(
			Buffer.concat([Buffer.from('x'.repeat(4_095)), Buffer.from('🙂')]),
		);

		expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(4_096);
		expect(summary).not.toContain('�');
	});

	it.each([
		'api_key=credential-value',
		'api-key: credential-value',
		'cookie=session=value',
		'set-cookie: session=value',
		'-----BEGIN PRIVATE KEY----- private-material -----END PRIVATE KEY-----',
		'-----BEGIN RSA PRIVATE KEY----- private-material -----END RSA PRIVATE KEY-----',
	])('redacts credential-shaped stderr: %s', (stderr) => {
		const summary = fixedSafeConfiguredCliStderrSummary(Buffer.from(stderr, 'utf8'));

		expect(summary).toContain('[REDACTED]');
		expect(summary).not.toContain('credential-value');
		expect(summary).not.toContain('private-material');
	});
});
