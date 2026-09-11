import { createServer } from 'node:http';

import {
	loadOAuthApprovalAssetBundle,
	renderGoogleOnboardingPage,
	renderOAuthApprovalPage,
	renderWaitingForAccessPage,
} from '../dist/index.js';

// Loopback-only visual preview. It never verifies identity or grants application access.
const assets = await loadOAuthApprovalAssetBundle();
const publishableKey = process.env['OAUTH_UI_PREVIEW_PUBLISHABLE_KEY'];
if (publishableKey === undefined)
	throw new Error('Set OAUTH_UI_PREVIEW_PUBLISHABLE_KEY to a Clerk development publishable key.');
const server = createServer((request, response) => {
	const url = new URL(request.url ?? '/', 'http://localhost');
	response.setHeader('Cache-Control', 'no-store');
	response.setHeader('Referrer-Policy', 'no-referrer');
	if (url.pathname === '/confirmation') {
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end(
			renderOAuthApprovalPage({
				assetBasePath: '/oauth/assets',
				stylesheetAssetName: assets.manifest.css,
				javascriptAssetName: assets.manifest.javascript,
				csrfToken: 'preview-only'.repeat(4),
				formAction: '/oauth/auth/return',
				cancelAction: '/oauth/auth/return',
				model: {
					kind: 'account-confirmation',
					accountLabel: 'example.member@gmail.com',
					applicationLabel: 'Gmail',
					grantedPermissionLabels: ['Read Gmail'],
				},
			}),
		);
		return;
	}
	if (url.pathname === '/waiting') {
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.statusCode = 403;
		response.end(
			renderWaitingForAccessPage({
				emailAddress: 'member@example.test',
				stylesheet: assets.manifest.css,
			}),
		);
		return;
	}
	if (
		url.pathname === '/phone' ||
		url.pathname === '/waiting-phone' ||
		url.pathname === '/confirmation-phone'
	) {
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		const framePath =
			url.pathname === '/confirmation-phone'
				? '/confirmation'
				: url.pathname === '/waiting-phone'
					? '/waiting'
					: '/oauth/auth/start?mode=setup';
		response.end(
			`<!doctype html><html><head><title>390px onboarding preview</title></head><body style="margin:0;background:#18181b;display:flex;justify-content:center"><iframe title="Phone-width onboarding" width="390" height="844" style="border:0" src="${framePath}"></iframe></body></html>`,
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
