import { describe, expect, it } from 'vitest';

import {
	oauthAccountPolicyPageSchema,
	renderOAuthAccountPolicyPage,
} from './oauth-account-policy-renderer.js';

describe('account-policy form authority', () => {
	it.each([
		{ canEdit: false, state: 'active', preview: false },
		{ canEdit: false, state: 'active', preview: true },
		{ canEdit: true, state: 'applying', preview: false },
	])(
		'hides policy submit controls for $canEdit/$state/$preview even with stale form metadata',
		(scenario) => {
			// Arrange
			const services = { gmail: { read: { kind: 'inherit' }, write: { kind: 'inherit' } } };
			const model = oauthAccountPolicyPageSchema.parse({
				agentId: 'ember',
				accountAlias: 'Test account',
				applicationLabel: 'Gmail',
				ownerLabel: 'Test owner',
				activities: [],
				services,
				defaults: { gmail: { read: 'ask', write: 'deny' } },
				maximums: { gmail: ['read'] },
				canEdit: scenario.canEdit,
				state: scenario.state,
				configRevision: 'test-config',
				overrideRevision: 1,
				formAction: '/oauth/policy/preview',
				csrfToken: 'c'.repeat(43),
				navigationCsrf: 'n'.repeat(43),
				history: [],
				connectionActions: [],
				...(scenario.preview ? { after: services } : {}),
			});
			// Act
			const html = renderOAuthAccountPolicyPage({
				model,
				stylesheet: 'oauth.0123456789abcdef.css',
			});
			// Assert
			expect(html).not.toContain('Preview changes');
			expect(html).not.toContain('Confirm this account policy');
			expect(html).not.toContain('<select');
		},
	);
});
