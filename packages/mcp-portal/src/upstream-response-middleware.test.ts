import { describe, expect, it } from 'vitest';

import { redactCredentialText, redactUpstreamResponse } from './upstream-response-middleware.js';

describe('upstream response middleware', () => {
	it('redacts credential-shaped text from nested result content', () => {
		const redacted = redactUpstreamResponse({
			content: [{ text: 'Bearer secret-token', type: 'text' }],
			structuredContent: {
				authorization: 'Basic abc123',
				nested: { value: 'api_key=secret-value' },
			},
		});

		expect(JSON.stringify(redacted)).not.toContain('secret-token');
		expect(JSON.stringify(redacted)).not.toContain('abc123');
		expect(JSON.stringify(redacted)).toContain('[REDACTED]');
	});

	it('redacts exact configured secret values even when they are not credential-shaped', () => {
		const redacted = redactUpstreamResponse(
			{
				content: [{ text: 'opaque-header-value-12345', type: 'text' }],
				structuredContent: {
					trace: 'opaque-header-value-12345',
				},
			},
			{ exactValues: ['opaque-header-value-12345'] },
		);

		expect(JSON.stringify(redacted)).not.toContain('opaque-header-value-12345');
		expect(JSON.stringify(redacted)).toContain('[REDACTED]');
	});

	it('redacts thrown error messages', () => {
		expect(redactCredentialText('Authorization: Bearer super-secret')).toBe(
			'Authorization: [REDACTED]',
		);
	});

	it('does not redact non-credential author and oauth fields', () => {
		expect(
			redactUpstreamResponse({
				author: 'Ada',
				authoredAt: '2026-05-11T00:00:00.000Z',
				oauthUrl: 'https://example.test/oauth/authorize',
			}),
		).toEqual({
			author: 'Ada',
			authoredAt: '2026-05-11T00:00:00.000Z',
			oauthUrl: 'https://example.test/oauth/authorize',
		});
	});

	it('redacts credential-like object fields by anchored key shape', () => {
		expect(
			redactUpstreamResponse({
				authToken: 'secret-token',
				clientSecret: 'secret-client',
				headers: {
					'x-api-key': 'secret-api-key',
				},
				nested: {
					refresh_token: 'secret-refresh-token',
				},
			}),
		).toEqual({
			authToken: '[REDACTED]',
			clientSecret: '[REDACTED]',
			headers: {
				'x-api-key': '[REDACTED]',
			},
			nested: {
				refresh_token: '[REDACTED]',
			},
		});
	});
});
