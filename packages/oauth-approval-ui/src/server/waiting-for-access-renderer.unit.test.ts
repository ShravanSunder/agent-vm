import { describe, expect, it } from 'vitest';

import { renderWaitingForAccessPage } from './waiting-for-access-renderer.js';

describe('waiting for access page', () => {
	it('shows verified identity and a local retry without permission or login scripts', () => {
		const html = renderWaitingForAccessPage({
			emailAddress: 'member@example.test',
			stylesheet: 'oauth.1111111111111111.css',
		});
		expect(html).toContain('Signed in as member@example.test');
		expect(html).toContain('<h1>Waiting for access</h1>');
		expect(html).toContain('Check access again');
		expect(html).toContain('name="viewport"');
		expect(html).not.toMatch(/<script|<form|data-google-onboarding/u);
	});
	it('rejects an external stylesheet', () => {
		expect(() =>
			renderWaitingForAccessPage({
				emailAddress: 'member@example.test',
				stylesheet: 'https://external.example/style.css',
			}),
		).toThrow();
	});
});
