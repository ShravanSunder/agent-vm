import { compileOAuthPolicy } from '@agent-vm/config-contracts';
import {
	createOAuthBrowserNavigationStore,
	createOAuthLoginContinuationStore,
} from '@agent-vm/oauth-broker';
import { afterEach, describe, expect, it } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import {
	createBrokerFacadeFixture,
	facadeApplicationId,
	facadeIdentity,
} from '../../../../oauth-broker/src/google/google-broker-facade-test-fixture.js';
import { wrappingKey } from '../../../../oauth-broker/src/oauth-catalog-test-fixture.js';
import { createGooglePermissionPolicyService } from './google-permission-policy-service.js';
import { createOAuthHttpsApp } from './oauth-https-server.js';

function nativeForm(
	html: string,
	actionSuffix?: string,
): { readonly action: string; readonly fields: URLSearchParams } {
	const form = [...html.matchAll(/<form[^>]*action="([^"]+)"[^>]*>(.*?)<\/form>/gsu)].find(
		(candidate) => actionSuffix === undefined || candidate[1]?.endsWith(actionSuffix),
	);
	if (form?.[1] === undefined || form[2] === undefined) throw new Error('Expected native form.');
	const fields = new URLSearchParams();
	for (const input of form[2].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/gu))
		if (input[1] !== undefined && input[2] !== undefined) fields.append(input[1], input[2]);
	for (const select of form[2].matchAll(/<select[^>]*name="([^"]+)"[^>]*>(.*?)<\/select>/gsu)) {
		const selected = /<option[^>]*value="([^"]*)"[^>]*selected[^>]*>/u.exec(select[2] ?? '');
		if (select[1] !== undefined && selected?.[1] !== undefined)
			fields.append(select[1], selected[1]);
	}
	return { action: form[1].replaceAll('&amp;', '&'), fields };
}
describe('website account-policy journey with real broker, SQLite and native forms', () => {
	let fixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>> | undefined;
	afterEach(async () => {
		await fixture?.broker.close();
		fixture?.catalog.close();
	});
	it('signs in, opens the owned account, previews a change and applies it only to Sun', async () => {
		// Arrange: provider, Clerk and VM are synthetic boundaries; broker, SQL, routing and rendering are real.
		fixture = await createBrokerFacadeFixture();
		const account = await fixture.enroll('sun');
		await fixture.enroll('ember');
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		fixture.catalog.activatePolicyDefaults({
			zoneId: 'test-zone',
			defaultsRevision: compiled.defaultsRevision,
			snapshot: compiled.defaultsSnapshot,
		});
		const policy = createGooglePermissionPolicyService({
			catalog: fixture.catalog,
			compiled,
			configRevision: 'config-1',
			clientBindingRevisionsByApplication: {
				'gmail-app': 'client-binding-1',
				'workspace-app': 'client-binding-2',
				'youtube-app': 'client-binding-3',
			},
			keyEncryptionKey: wrappingKey,
			keyEncryptionKeyVersion: 1,
			isAdmissionOpen: () => true,
			verifySession: async (identity) => ({ kind: 'verified', identity }),
			containPolicyMaterial: async () => 'contained',
		});
		let bootstrapEnabled = true;
		const app = createOAuthHttpsApp({
			assets: {
				files: {},
				manifest: {
					css: 'oauth.1111111111111111.css',
					javascript: 'oauth.2222222222222222.js',
					onboarding: 'onboarding.3333333333333333.js',
				},
			},
			config: compiled.oauthConfig,
			brokerService: fixture.broker,
			policyService: policy,
			navigation: createOAuthBrowserNavigationStore(),
			loginContinuations: createOAuthLoginContinuationStore(),
			isAdmissionOpen: () => true,
			publicBaseUrl: compiled.oauthConfig.browser.publicBaseUrl,
			tailnetIdentityResolver: {
				resolvePeerIdentity: async () => ({ loginName: 'network-person@example.test' }),
			},
			browserIdentityVerifier: {
				verifyBootstrap: async () =>
					bootstrapEnabled
						? {
								kind: 'verified',
								identity: facadeIdentity,
								setCookies: [],
							}
						: {
								kind: 'redirect',
								location: 'https://identity.example.test/handshake',
								setCookies: [],
							},
				verifyCurrentCookie: async () => ({ kind: 'not-current' }),
				verifySession: async (identity) => ({ kind: 'verified', identity }),
				revokeSession: async () => ({ kind: 'revoked' }),
				verifyGoogleIdentity: async (identity) => ({
					kind: 'verified',
					identity,
					emailAddress: 'member@example.test',
				}),
			},
		});
		const cookies = new Map<string, string>();
		const request = async (route: string, fields?: URLSearchParams): Promise<Response> => {
			const response = await app.request(
				`${compiled.oauthConfig.browser.publicBaseUrl}${route}`,
				{
					method: fields === undefined ? 'GET' : 'POST',
					headers: {
						cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
						...(fields === undefined
							? {}
							: {
									origin: compiled.oauthConfig.browser.publicBaseUrl,
									'content-type': 'application/x-www-form-urlencoded',
								}),
					},
					...(fields === undefined ? {} : { body: fields }),
				},
				{ incoming: { socket: { remoteAddress: '100.100.100.10', remotePort: 49000 } } },
			);
			for (const cookie of response.headers.getSetCookie()) {
				const pair = cookie.split(';')[0] ?? '';
				const separator = pair.indexOf('=');
				cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
			}
			return response;
		};
		// Act: follow only server-owned safe redirects, then submit the actual rendered native forms.
		const first = await request('/oauth/agents');
		expect(first.status).toBe(303);
		const login = await request(first.headers.get('location') ?? '');
		expect(login.status).toBe(303);
		const index = await request(login.headers.get('location') ?? '');
		const indexHtml = await index.text();
		expect(indexHtml).toContain('sun mailbox');
		// An aged Clerk cookie would need an external handshake on another
		// bootstrap. A verified same-origin form must not trigger that chain.
		bootstrapEnabled = false;
		const connect = nativeForm(indexHtml, '/sun/connect');
		connect.fields.set('applicationId', 'gmail-app');
		const connected = await request(connect.action, connect.fields);
		expect(connected.status).toBe(303);
		const consent = await request(connected.headers.get('location') ?? '');
		expect(consent.status).toBe(200);
		expect(await consent.text()).toContain('Choose Google access');
		expect(consent.headers.get('content-security-policy')).toContain("form-action 'self'");
		bootstrapEnabled = true;
		const target = `/oauth/agents/sun/accounts/${account.accountId}?application=gmail-app`;
		const accountLogin = await request(target);
		expect(accountLogin.status).toBe(303);
		const returned = await request(accountLogin.headers.get('location') ?? '');
		const page = await request(returned.headers.get('location') ?? '');
		expect(page.status).toBe(200);
		const edit = nativeForm(await page.text());
		expect(edit.fields.get('read.gmail')).toBe('inherit');
		edit.fields.set('read.gmail', 'deny');
		const preview = await request(edit.action, edit.fields);
		expect(preview.status).toBe(200);
		const confirmation = nativeForm(await preview.text());
		expect(confirmation.fields.has('read.gmail')).toBe(false);
		const saved = await request(confirmation.action, confirmation.fields);
		// Assert
		expect(saved.status).toBe(303);
		expect(
			policy.resolveActivityAvailability({
				accountId: account.accountId,
				agentId: 'sun',
				applicationId: facadeApplicationId,
				operationId: 'gmail.search',
			}),
		).toEqual({ kind: 'denied' });
		expect(
			policy.resolveActivityAvailability({
				accountId: account.accountId,
				agentId: 'ember',
				applicationId: facadeApplicationId,
				operationId: 'gmail.search',
			}),
		).toMatchObject({ kind: 'ready', disposition: 'ask' });
		await policy.drain();
	});
});
