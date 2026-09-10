import { createServer } from 'node:http';

import { loadOAuthApprovalAssetBundle, renderGoogleOnboardingPage } from '../dist/index.js';

// Loopback-only visual preview. It never verifies identity or grants application access.
const assets = await loadOAuthApprovalAssetBundle();
const publishableKey = process.env['OAUTH_UI_PREVIEW_PUBLISHABLE_KEY'];
if (publishableKey === undefined)
	throw new Error('Set OAUTH_UI_PREVIEW_PUBLISHABLE_KEY to a Clerk development publishable key.');
const server = createServer((request, response) => {
	const url = new URL(request.url ?? '/', 'http://localhost');
	response.setHeader('Cache-Control', 'no-store');
	response.setHeader('Referrer-Policy', 'no-referrer');
	if (url.pathname === '/phone') {
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end(
			'<!doctype html><html><head><title>390px onboarding preview</title></head><body style="margin:0;background:#ddd;display:flex;justify-content:center"><iframe title="Phone-width onboarding" width="390" height="844" style="border:0" src="/oauth/auth/start?mode=setup"></iframe></body></html>',
		);
		return;
	}
	const bytes = assets.files[url.pathname.replace('/oauth/assets/', '')];
	if (url.pathname.startsWith('/oauth/assets/') && bytes !== undefined) {
		response.setHeader(
			'Content-Type',
			url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
		);
		response.end(bytes);
		return;
	}
	if (url.pathname === '/oauth/auth/prepare-google' || url.pathname === '/oauth/auth/return') {
		response.statusCode = 403;
		response.end('Visual preview only. Use the configured HTTPS website to complete login.');
		return;
	}
	const mode =
		url.searchParams.get('mode') === 'setup'
			? 'setup'
			: url.pathname.endsWith('/callback')
				? 'callback'
				: 'sign-in';
	response.setHeader('Content-Type', 'text/html; charset=utf-8');
	response.end(
		renderGoogleOnboardingPage({
			mode,
			publishableKey,
			stylesheet: assets.manifest.css,
			javascript: assets.manifest.onboarding,
		}),
	);
});
server.listen(0, '127.0.0.1', () => {
	const address = server.address();
	if (address !== null && typeof address !== 'string')
		console.log(`Onboarding visual preview: http://localhost:${address.port}/oauth/auth/start`);
});
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
