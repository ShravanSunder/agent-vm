import { describe, expect, it } from 'vitest';

import {
	oauthAccountPolicyPageSchema,
	renderOAuthAccountPolicyPage,
	renderOAuthOwnerIndex,
} from './oauth-account-policy-renderer.js';

describe('owner index presentation', () => {
	it('retains application selection only when there is a real choice and escapes identity text', () => {
		const html = renderOAuthOwnerIndex({
			stylesheet: 'oauth.0123456789abcdef.css',
			model: {
				signedInEmail: '<script>not markup</script>',
				csrfToken: 'n'.repeat(43),
				agents: [
					{
						agentId: 'sun',
						accounts: [{ accountAlias: 'Work Gmail', href: '/oauth/agents/sun/accounts/work' }],
						applications: [
							{ applicationId: 'gmail-app', label: 'Gmail' },
							{ applicationId: 'workspace-app', label: 'Drive' },
						],
					},
				],
			},
		});
		expect(html).toContain('<select name="applicationId">');
		expect(html).toContain('1 connection');
		expect(html).toContain('Work Gmail');
		expect(html).toContain('Manage access');
		expect(html).not.toContain('<script>not markup</script>');
		expect(html).toContain('&lt;script&gt;');
	});
	it('does not render a broken connect form when no application is enabled', () => {
		const html = renderOAuthOwnerIndex({
			stylesheet: 'oauth.0123456789abcdef.css',
			model: {
				signedInEmail: 'member@example.test',
				csrfToken: 'n'.repeat(43),
				agents: [{ agentId: 'sun', accounts: [], applications: [] }],
			},
		});
		expect(html).toContain('No Google applications are enabled');
		expect(html).not.toContain('action="/oauth/agents/sun/connect"');
	});
	it('shows verified identity, connection status and a direct single-application action', () => {
		const html = renderOAuthOwnerIndex({
			stylesheet: 'oauth.0123456789abcdef.css',
			model: {
				signedInEmail: 'member@example.test',
				csrfToken: 'n'.repeat(43),
				agents: [
					{
						agentId: 'sun',
						accounts: [],
						applications: [{ applicationId: 'gmail-app', label: 'Gmail' }],
					},
				],
			},
		});
		expect(html).toContain('Signed in as');
		expect(html).toContain('member@example.test');
		expect(html).toContain('Switch account');
		expect(html).toContain('No accounts connected');
		expect(html).not.toContain('<select');
		expect(html).toContain('name="applicationId" value="gmail-app"');
		expect(html).toContain('action="/oauth/agents/sun/connect"');
		expect(html).toContain('Connect Google account');
	});
});

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
