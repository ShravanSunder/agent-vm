import { describe, expect, it } from 'vitest';

import { renderGoogleOnboardingPage } from './google-onboarding-renderer.js';

const assets = {
	publishableKey: 'pk_test_Zml4dHVyZSQ=',
	stylesheet: 'oauth.1111111111111111.css',
	javascript: 'onboarding.2222222222222222.js',
};
describe('Google-first entry rendering', () => {
	it.each(['sign-in', 'invitation', 'setup', 'callback'] as const)(
		'renders an accessible %s page without resource permission inputs',
		(mode) => {
			const html = renderGoogleOnboardingPage({ ...assets, mode });
			expect(html).toContain('name="viewport"');
			expect(html).toContain('role="status"');
			expect(html).toContain('JavaScript is needed');
			expect(html).toContain('Signing in does not give agents access');
			expect(html).not.toContain('csrfToken');
			expect(html).not.toContain('additionalScopes');
			if (mode !== 'callback') expect(html).toContain('Google');
		},
	);
	it('explains same-email sign-in and shows the direct setup action', () => {
		const html = renderGoogleOnboardingPage({ ...assets, mode: 'setup' });
		expect(html).toContain('Connect Google to finish setup');
		expect(html).toContain('Use the Google email that received your invitation');
	});
});
