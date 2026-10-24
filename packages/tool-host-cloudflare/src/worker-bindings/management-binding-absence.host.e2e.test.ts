import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';

import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

it('returns the production unbound management response with the service actually absent', async () => {
	const guard = startWorkerdSocketGuard();
	let runtime: Miniflare | undefined;
	try {
		const bundle = await build({
			entryPoints: [
				'packages/tool-host-cloudflare/src/test-fixtures/management-binding-proof-entrypoint.ts',
			],
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
			conditions: ['workerd', 'worker', 'browser'],
			external: ['cloudflare:workers'],
		});
		const script = bundle.outputFiles[0]?.text;
		if (script === undefined) throw new Error('Missing management proof module.');
		runtime = new Miniflare(
			convertV4MiniflareOptions({
				workers: [
					{
						name: 'unbound-management',
						script,
						modules: true,
						compatibilityDate: '2025-09-24',
						bindings: {
							SIGN_IN_ISSUER: 'https://sign-in.example.invalid',
							SIGN_IN_JWKS_URL: 'https://sign-in.example.invalid/jwks',
							TOOL_PORTAL_AUDIENCE: 'https://portal.example.invalid/mcp',
							ORGANIZATION_CONFIGURATIONS: '{}',
						},
						durableObjects: {
							ORGANIZATIONS: { className: 'OrganizationAuthorization', useSQLite: true },
						},
					},
				],
			}),
		);
		const worker = await runtime.getWorker('unbound-management');
		// This is read from the same workerd environment that will execute production fetch.
		const presence = await worker.fetch('http://proof/__binding-presence');
		expect(presence.status).toBe(200);
		expect(await presence.json()).toEqual({
			signInPresent: false,
			signInUndefined: true,
			managementAudiencePresent: false,
			managementAudienceUndefined: true,
		});
		const response = await worker.fetch(
			'http://proof/management/organizations/11111111-1111-4111-8111-111111111111/agents',
			{ method: 'POST' },
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'management-unavailable' });
		guard.check();
	} finally {
		try {
			await runtime?.dispose();
		} finally {
			await guard.stop();
		}
	}
});
