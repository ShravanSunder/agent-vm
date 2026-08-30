import { describe, expect, it } from 'vitest';

import { oauthApprovalPageModelSchema } from '../contracts.js';
import { renderOAuthApprovalPage } from './index.js';

const assets = {
	assetBasePath: '/oauth/assets',
	javascriptAssetName: 'oauth.0123456789abcdef.js',
	stylesheetAssetName: 'oauth.0123456789abcdef.css',
} as const;

describe('server-rendered OAuth approval page', () => {
	it('renders semantic native permission controls and labels Hermes suggestions as advisory', () => {
		const html = renderOAuthApprovalPage({
			...assets,
			cancelAction: '/oauth/transactions/transaction/cancel',
			csrfToken: 'c'.repeat(43),
			formAction: '/oauth/transactions/transaction/permissions',
			model: oauthApprovalPageModelSchema.parse({
				accountProfileLabel: 'Personal Google',
				applications: [
					{
						applicationId: 'gmail-app',
						description: 'Gmail account access.',
						label: 'Gmail',
						services: [
							{
								allowedChoices: ['none', 'read', 'write'],
								label: 'Gmail messages',
								selectedChoice: 'read',
								serviceId: 'gmail',
								suggestedChoice: 'read',
							},
						],
					},
				],
				kind: 'permission-selection',
			}),
		});

		expect(html).toContain('<fieldset');
		expect(html).toContain('<legend>Gmail messages</legend>');
		expect(html).toContain('Hermes suggested read. You decide.');
		expect(html).toContain('type="radio"');
		expect(html).toContain('name="csrfToken"');
		expect(html).toContain('method="post"');
		expect(html).not.toContain('accessToken');
		expect(html).not.toContain('oauthState');
	});

	it('escapes account labels and renders errors through an alert summary', () => {
		const html = renderOAuthApprovalPage({
			...assets,
			csrfToken: 'c'.repeat(43),
			formAction: '/oauth/transactions/transaction/permissions',
			model: oauthApprovalPageModelSchema.parse({
				accountProfileLabel: '<script>alert(1)</script>',
				applications: [
					{
						applicationId: 'gmail-app',
						description: 'Gmail account access.',
						label: 'Gmail',
						services: [
							{
								allowedChoices: ['none', 'read'],
								label: 'Gmail messages',
								selectedChoice: 'none',
								serviceId: 'gmail',
							},
						],
					},
				],
				errors: ['Select at least one service.'],
				kind: 'permission-selection',
			}),
		});
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).toContain('role="alert"');
		expect(html).toContain('tabindex="-1"');
	});

	it.each([
		{ accountLabel: 'Personal Google', kind: 'completed' },
		{ kind: 'expired', message: 'Start again from Hermes.' },
		{ kind: 'cancelled', message: 'Nothing was changed.' },
		{ kind: 'failed', message: 'Google authorization failed.' },
	] as const)('renders terminal $kind state without requiring a form', (model) => {
		const html = renderOAuthApprovalPage({
			...assets,
			model: oauthApprovalPageModelSchema.parse(model),
		});
		expect(html).toContain('<!doctype html>');
		expect(html).not.toContain('name="csrfToken"');
	});
});
