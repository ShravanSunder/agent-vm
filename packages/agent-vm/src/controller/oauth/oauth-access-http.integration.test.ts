import { createServer } from 'node:net';

import { compileOAuthPolicy } from '@agent-vm/config-contracts';
import {
	createOAuthBrowserNavigationStore,
	createOAuthLoginContinuationStore,
} from '@agent-vm/oauth-broker';
import {
	oauthCompletionSessionIdSchema,
	oauthTransactionIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOAuthPolicyCompilerTestInput } from '../../../../config-contracts/src/oauth-policy-compiler-test-fixture.js';
import {
	createBrokerFacadeFixture,
	facadeApplicationId,
	facadeIdentity,
} from '../../../../oauth-broker/src/google/google-broker-facade-test-fixture.js';
import { wrappingKey } from '../../../../oauth-broker/src/oauth-catalog-test-fixture.js';
import type { CloudflareAccessIdentityVerifier } from './cloudflare-access-identity-verifier.js';
import { createGooglePermissionPolicyService } from './google-permission-policy-service.js';
import { createOAuthBrowserSessionRoutes } from './oauth-browser-session-routes.js';
import { createOAuthHttpApp, startOAuthHttpServer } from './oauth-https-server.js';

async function reserveLoopbackPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('Missing reserved port.');
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error === undefined ? resolve() : reject(error))),
	);
	return address.port;
}

function mergeCookies(current: Map<string, string>, response: Response): void {
	for (const value of response.headers.getSetCookie()) {
		const pair = value.slice(0, value.indexOf(';'));
		const separator = pair.indexOf('=');
		if (separator > 0) {
			const name = pair.slice(0, separator);
			const cookieValue = pair.slice(separator + 1);
			if (cookieValue.length === 0) current.delete(name);
			else current.set(name, cookieValue);
		}
	}
}

function cookieHeader(cookies: ReadonlyMap<string, string>): string {
	return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function requestWithCookies(props: {
	readonly app: Hono;
	readonly baseUrl: string;
	readonly cookies: Map<string, string>;
	readonly fields?: URLSearchParams;
	readonly origin?: string;
	readonly route: string;
}): Promise<Response> {
	const response = await props.app.request(`${props.baseUrl}${props.route}`, {
		method: props.fields === undefined ? 'GET' : 'POST',
		headers: {
			cookie: cookieHeader(props.cookies),
			...(props.fields === undefined
				? {}
				: {
						'content-type': 'application/x-www-form-urlencoded',
						origin: props.origin ?? props.baseUrl,
					}),
		},
		...(props.fields === undefined ? {} : { body: props.fields }),
	});
	mergeCookies(props.cookies, response);
	return response;
}

function nativeForm(
	html: string,
	actionSuffix?: string,
): { readonly action: string; readonly fields: URLSearchParams } {
	const form = [...html.matchAll(/<form[^>]*action="([^"]+)"[^>]*>(.*?)<\/form>/gsu)].find(
		(candidate) => actionSuffix === undefined || candidate[1]?.endsWith(actionSuffix),
	);
	if (form?.[1] === undefined || form[2] === undefined) throw new Error('Expected native form.');
	const fields = new URLSearchParams();
	for (const input of form[2].matchAll(/<input\b[^>]*>/gu)) {
		const inputTag = input[0];
		const name = /\bname="([^"]+)"/u.exec(inputTag)?.[1];
		const value = /\bvalue="([^"]*)"/u.exec(inputTag)?.[1];
		const checkedInput = /\btype="(?:checkbox|radio)"/u.test(inputTag);
		if (
			name !== undefined &&
			value !== undefined &&
			!/\bdisabled(?:\s|=|>)/u.test(inputTag) &&
			(!checkedInput || /\bchecked(?:\s|=|>)/u.test(inputTag))
		)
			fields.append(name, value);
	}
	for (const select of form[2].matchAll(/<select[^>]*name="([^"]+)"[^>]*>(.*?)<\/select>/gsu)) {
		const selected = /<option[^>]*value="([^"]*)"[^>]*selected[^>]*>/u.exec(select[2] ?? '');
		if (select[1] !== undefined && selected?.[1] !== undefined)
			fields.append(select[1], selected[1]);
	}
	return { action: form[1].replaceAll('&amp;', '&'), fields };
}

function createPolicyService(props: {
	readonly compiled: ReturnType<typeof compileOAuthPolicy>;
	readonly fixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>>;
	readonly now?: () => number;
}): ReturnType<typeof createGooglePermissionPolicyService> {
	props.fixture.catalog.activatePolicyDefaults({
		zoneId: 'test-zone',
		defaultsRevision: props.compiled.defaultsRevision,
		snapshot: props.compiled.defaultsSnapshot,
	});
	return createGooglePermissionPolicyService({
		catalog: props.fixture.catalog,
		compiled: props.compiled,
		configRevision: 'access-integration',
		clientBindingRevisionsByApplication: {
			'gmail-app': 'client-binding-1',
			'workspace-app': 'client-binding-2',
			'youtube-app': 'client-binding-3',
		},
		containPolicyMaterial: async () => 'contained',
		isAdmissionOpen: () => true,
		keyEncryptionKey: wrappingKey,
		keyEncryptionKeyVersion: 1,
		...(props.now === undefined ? {} : { now: props.now }),
	});
}

describe('Cloudflare Access OAuth HTTP integration', () => {
	let fixture: Awaited<ReturnType<typeof createBrokerFacadeFixture>> | undefined;
	afterEach(async () => {
		await fixture?.broker.close();
		fixture?.catalog.close();
		fixture = undefined;
	});

	it('admits an Access principal, continues after same-principal token renewal, rejects identity replacement, and excludes admin routes', async () => {
		let currentTimeMs = 1_000;
		fixture = await createBrokerFacadeFixture({ now: () => currentTimeMs });
		await fixture.enroll('sun');
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		const policy = createPolicyService({
			compiled,
			fixture,
			now: () => currentTimeMs,
		});
		let currentIdentity = facadeIdentity;
		let authenticationExpiresAtMs = 2_000;
		let verificationKind: 'verified' | 'denied' | 'verification-unavailable' = 'verified';
		let verificationCallCount = 0;
		let unavailableOnVerificationCall: number | undefined;
		const verifier: CloudflareAccessIdentityVerifier = {
			verifyRequest: async () =>
				++verificationCallCount === unavailableOnVerificationCall
					? { kind: 'verification-unavailable' }
					: verificationKind === 'verified'
						? {
								kind: 'verified',
								human: {
									authenticationExpiresAtMs,
									emailAddress: 'member@example.test',
									identity: currentIdentity,
								},
							}
						: { kind: verificationKind },
		};
		const navigation = createOAuthBrowserNavigationStore({ now: () => currentTimeMs });
		const continuations = createOAuthLoginContinuationStore({ now: () => currentTimeMs });
		const app = createOAuthHttpApp({
			assets: {
				files: {},
				manifest: { css: 'oauth.1111111111111111.css', javascript: 'oauth.2222222222222222.js' },
			},
			brokerService: fixture.broker,
			browserIdentityVerifier: verifier,
			config: compiled.oauthConfig,
			isAdmissionOpen: () => true,
			loginContinuations: continuations,
			navigation,
			policyService: policy,
			now: () => currentTimeMs,
			publicBaseUrl: compiled.oauthConfig.browser.publicBaseUrl,
		});
		const cookies = new Map<string, string>();
		verificationKind = 'denied';
		expect(
			(await app.request(`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/auth/start`)).status,
		).toBe(403);
		verificationKind = 'verification-unavailable';
		expect(
			(await app.request(`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/auth/start`)).status,
		).toBe(503);
		verificationKind = 'verified';
		const first = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/auth/start`,
		);
		expect(first.status).toBe(303);
		mergeCookies(cookies, first);
		const cookie = (): string => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
		const admitted = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/auth/start`,
			{ headers: { cookie: cookie() } },
		);
		expect(admitted.status).toBe(303);
		expect(admitted.headers.get('location')).toBe('/oauth/agents');
		mergeCookies(cookies, admitted);
		currentTimeMs = 3_000;
		authenticationExpiresAtMs = 60_000;
		const accounts = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/agents`,
			{ headers: { cookie: cookie() } },
		);
		expect(accounts.status).toBe(200);
		const accountsHtml = await accounts.text();
		expect(accountsHtml).toContain('sun mailbox');
		expect(accounts.headers.get('content-security-policy')).toContain("default-src 'none'");
		expect(accounts.headers.get('referrer-policy')).toBe('same-origin');
		expect(currentTimeMs).toBeGreaterThan(2_000);
		const inaccessibleNavigation = navigation.create({
			identity: facadeIdentity,
			target: {
				kind: 'authorization',
				transactionId: oauthTransactionIdSchema.parse('transaction_identifier_1234567890abcdef'),
			},
		});
		if (inaccessibleNavigation.kind !== 'created')
			throw new Error('Expected bound inaccessible transaction navigation.');
		const inaccessibleTransaction = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/transactions/transaction_identifier_1234567890abcdef`,
			{
				headers: {
					cookie: `agent_vm_oauth_navigation=${inaccessibleNavigation.contextId}; agent_vm_oauth_navigation_binding=${inaccessibleNavigation.browserBindingSecret}`,
				},
			},
		);
		expect(inaccessibleTransaction.status).toBe(403);
		expect(await inaccessibleTransaction.text()).not.toContain('sun mailbox');
		expect((await app.request(`${compiled.oauthConfig.browser.publicBaseUrl}/health`)).status).toBe(
			404,
		);

		const csrfToken = /name="csrfToken" value="([^"]+)"/u.exec(accountsHtml)?.[1];
		if (csrfToken === undefined) throw new Error('Missing switch-person CSRF token.');
		const cancelCeremonies = vi.spyOn(fixture.broker, 'cancelBrowserCeremonies');
		const wrongOrigin = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/auth/change-person`,
			{
				method: 'POST',
				headers: { cookie: cookie(), origin: 'https://other.example.test' },
				body: new URLSearchParams({ csrfToken }),
			},
		);
		expect(wrongOrigin.status).toBe(403);
		expect(cancelCeremonies).not.toHaveBeenCalled();
		const signedOut = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/auth/change-person`,
			{
				method: 'POST',
				headers: { cookie: cookie(), origin: compiled.oauthConfig.browser.publicBaseUrl },
				body: new URLSearchParams({ csrfToken }),
			},
		);
		expect(signedOut.status).toBe(303);
		expect(signedOut.headers.get('location')).toBe(
			'https://permissions.example.test/cdn-cgi/access/logout',
		);
		expect(cancelCeremonies).toHaveBeenCalledOnce();

		const replacementNavigation = navigation.create({
			identity: facadeIdentity,
			target: { kind: 'agents' },
		});
		const unaffectedNavigation = navigation.create({
			identity: facadeIdentity,
			target: { kind: 'agents' },
		});
		if (replacementNavigation.kind !== 'created' || unaffectedNavigation.kind !== 'created')
			throw new Error('Expected isolated replacement navigation contexts.');
		const replacementCookie = `agent_vm_oauth_navigation=${replacementNavigation.contextId}; agent_vm_oauth_navigation_binding=${replacementNavigation.browserBindingSecret}`;
		const unaffectedCookie = `agent_vm_oauth_navigation=${unaffectedNavigation.contextId}; agent_vm_oauth_navigation_binding=${unaffectedNavigation.browserBindingSecret}`;
		const browser = createOAuthBrowserSessionRoutes({
			assets: { css: 'oauth.1111111111111111.css', javascript: 'oauth.2222222222222222.js' },
			broker: fixture.broker,
			cancelPolicyContexts: () => {},
			config: compiled.oauthConfig,
			continuations,
			navigation,
			verifier,
		});
		expect(
			(
				await browser.readIdentity(
					new Request(`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/agents`, {
						headers: { cookie: replacementCookie },
					}),
					{ kind: 'navigation' },
				)
			).kind,
		).toBe('verified');
		currentIdentity = { ...facadeIdentity, subject: 'different-person' };
		const changedSignIn = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/agents`,
			{ headers: { cookie: replacementCookie } },
		);
		expect(changedSignIn.status).toBe(403);
		expect(await changedSignIn.text()).toContain('Your sign-in changed. Start again.');
		expect(cancelCeremonies).toHaveBeenCalledOnce();

		currentIdentity = facadeIdentity;
		const unaffected = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/agents`,
			{ headers: { cookie: unaffectedCookie } },
		);
		expect(unaffected.status).toBe(200);
		expect(await unaffected.text()).toContain('sun mailbox');
		verificationCallCount = 0;
		unavailableOnVerificationCall = 3;
		const unavailableAfterAdmission = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/agents`,
			{ headers: { cookie: unaffectedCookie } },
		);
		expect(unavailableAfterAdmission.status).toBe(503);
		unavailableOnVerificationCall = undefined;
		currentIdentity = { ...facadeIdentity, issuer: 'https://wrong-issuer.example.test' };
		const wrongIssuer = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/agents`,
			{ headers: { cookie: unaffectedCookie } },
		);
		expect(wrongIssuer.status).toBe(403);
	});

	it('renders Waiting for access without account disclosure when an unconfigured assertion has no email', async () => {
		fixture = await createBrokerFacadeFixture();
		await fixture.enroll('sun');
		const providerRequestCount = fixture.providerRequests.length;
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		const app = createOAuthHttpApp({
			assets: {
				files: {},
				manifest: { css: 'oauth.1111111111111111.css', javascript: 'oauth.2222222222222222.js' },
			},
			brokerService: fixture.broker,
			browserIdentityVerifier: {
				verifyRequest: async () => ({
					kind: 'verified',
					human: {
						authenticationExpiresAtMs: 1_000_000,
						identity: { ...facadeIdentity, subject: 'unconfigured-access-subject' },
					},
				}),
			},
			config: compiled.oauthConfig,
			isAdmissionOpen: () => true,
			loginContinuations: createOAuthLoginContinuationStore(),
			navigation: createOAuthBrowserNavigationStore(),
			policyService: createPolicyService({ compiled, fixture }),
			publicBaseUrl: compiled.oauthConfig.browser.publicBaseUrl,
		});
		const cookies = new Map<string, string>();
		const first = await requestWithCookies({
			app,
			baseUrl: compiled.oauthConfig.browser.publicBaseUrl,
			cookies,
			route: '/oauth/auth/start',
		});
		const waiting = await requestWithCookies({
			app,
			baseUrl: compiled.oauthConfig.browser.publicBaseUrl,
			cookies,
			route: first.headers.get('location') ?? '',
		});
		const html = await waiting.text();

		expect(waiting.status).toBe(403);
		expect(html).toContain('Waiting for access');
		expect(html).toContain('Authenticated Access user');
		expect(html).not.toContain('sun mailbox');
		expect(fixture.providerRequests).toHaveLength(providerRequestCount);
		expect(
			waiting.headers
				.getSetCookie()
				.some((cookie) => cookie.startsWith('agent_vm_oauth_navigation=')),
		).toBe(false);
	});

	it('wires Access-authenticated website consent through the protected Google callback without forged-form side effects', async () => {
		fixture = await createBrokerFacadeFixture();
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		const otherDeploymentInput = createOAuthPolicyCompilerTestInput();
		otherDeploymentInput.oauthConfig.browser.publicBaseUrl =
			'https://permissions-beta.example.test';
		const otherDeployment = compileOAuthPolicy(otherDeploymentInput);
		const policy = createPolicyService({ compiled, fixture });
		const assetBytes = new TextEncoder().encode('body { color: black; }');
		let currentIdentity = facadeIdentity;
		const verifier: CloudflareAccessIdentityVerifier = {
			verifyRequest: async () => ({
				kind: 'verified',
				human: {
					authenticationExpiresAtMs: 1_000_000,
					emailAddress: 'member@example.test',
					identity: currentIdentity,
				},
			}),
		};
		const app = createOAuthHttpApp({
			assets: {
				files: { 'oauth.1111111111111111.css': assetBytes },
				manifest: { css: 'oauth.1111111111111111.css', javascript: 'oauth.2222222222222222.js' },
			},
			brokerService: fixture.broker,
			browserIdentityVerifier: verifier,
			config: compiled.oauthConfig,
			isAdmissionOpen: () => true,
			loginContinuations: createOAuthLoginContinuationStore(),
			navigation: createOAuthBrowserNavigationStore(),
			policyService: policy,
			now: () => 1_000,
			publicBaseUrl: compiled.oauthConfig.browser.publicBaseUrl,
		});
		const cookies = new Map<string, string>();
		const stylesheet = await app.request(
			`${compiled.oauthConfig.browser.publicBaseUrl}/oauth/assets/oauth.1111111111111111.css`,
		);
		expect(stylesheet.status).toBe(200);
		expect(await stylesheet.text()).toBe('body { color: black; }');
		expect(stylesheet.headers.get('cache-control')).toContain('immutable');
		const request = async (
			route: string,
			fields?: URLSearchParams,
			origin?: string,
		): Promise<Response> =>
			await requestWithCookies({
				app,
				baseUrl: compiled.oauthConfig.browser.publicBaseUrl,
				cookies,
				...(fields === undefined ? {} : { fields }),
				...(origin === undefined ? {} : { origin }),
				route,
			});
		const start = await request('/oauth/agents');
		const login = await request(start.headers.get('location') ?? '');
		const index = await request(login.headers.get('location') ?? '');
		const connect = nativeForm(await index.text(), '/sun/connect');
		connect.fields.set('applicationId', 'gmail-app');

		expect(
			(
				await request(
					connect.action,
					connect.fields,
					otherDeployment.oauthConfig.browser.publicBaseUrl,
				)
			).status,
		).toBe(403);
		const wrongCsrf = new URLSearchParams(connect.fields);
		wrongCsrf.set('csrfToken', 'wrong-csrf');
		expect((await request(connect.action, wrongCsrf)).status).toBe(403);
		currentIdentity = { ...facadeIdentity, subject: 'different-person' };
		expect((await request(connect.action, connect.fields)).status).toBe(403);
		expect(fixture.providerRequests).toHaveLength(0);
		expect(fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual([]);

		currentIdentity = facadeIdentity;
		const freshIndex = await request('/oauth/agents');
		expect(freshIndex.status).toBe(200);
		const freshConnect = nativeForm(await freshIndex.text(), '/sun/connect');
		freshConnect.fields.set('applicationId', 'gmail-app');
		const connected = await request(freshConnect.action, freshConnect.fields);
		expect(connected.status).toBe(303);
		const permissionPage = await request(connected.headers.get('location') ?? '');
		expect(permissionPage.headers.getSetCookie()).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/agent_vm_oauth_transaction=.*Max-Age=[1-9][0-9]*/u),
				expect.stringMatching(/agent_vm_oauth_transaction_binding=.*Max-Age=[1-9][0-9]*/u),
			]),
		);
		const permissionForm = nativeForm(await permissionPage.text(), '/permissions');
		const wrongPermissionOrigin = await request(
			permissionForm.action,
			permissionForm.fields,
			otherDeployment.oauthConfig.browser.publicBaseUrl,
		);
		expect(wrongPermissionOrigin.status).toBe(403);
		expect(fixture.providerRequests).toHaveLength(0);
		const invalidPermissions = new URLSearchParams(permissionForm.fields);
		invalidPermissions.set('mode.gmail-app', 'invalid-mode');
		const invalidSubmission = await request(permissionForm.action, invalidPermissions);
		expect(invalidSubmission.status).toBe(400);
		expect(fixture.providerRequests).toHaveLength(0);
		const submitted = await request(permissionForm.action, permissionForm.fields);
		expect(submitted.status).toBe(200);
		const authorizationHref = /href="(https:\/\/accounts\.google\.com\/[^" ]+)"/u.exec(
			await submitted.text(),
		)?.[1];
		if (authorizationHref === undefined) throw new Error('Missing Google authorization link.');
		const authorizationUrl = new URL(authorizationHref.replaceAll('&amp;', '&'));
		const state = authorizationUrl.searchParams.get('state');
		if (state === null) throw new Error('Missing Google OAuth state.');
		const callbackRoute = `/oauth/google/callback?code=${encodeURIComponent(state)}&state=${encodeURIComponent(state)}`;
		const secretShapedError =
			'provider code=secret-code cookie=secret-cookie scope=https://private.example';
		const callbackHandler = vi
			.spyOn(fixture.broker, 'handleGoogleCallback')
			.mockResolvedValueOnce({ kind: 'failed', reason: 'expired' })
			.mockRejectedValueOnce(new Error(secretShapedError));
		const expiredCallback = await request(callbackRoute);
		expect(expiredCallback.status).toBe(410);
		expect(await expiredCallback.text()).toContain('authorization link expired');
		const rejectedCallback = await request(callbackRoute);
		expect(rejectedCallback.status).toBe(403);
		const rejectedCallbackHtml = await rejectedCallback.text();
		expect(rejectedCallbackHtml).toContain('could not be verified');
		expect(rejectedCallbackHtml).not.toContain(secretShapedError);
		callbackHandler.mockRestore();
		const callback = await request(callbackRoute);

		expect(callback.status).toBe(303);
		expect(callback.headers.get('location')).toMatch(/^\/oauth\/completions\//u);
		expect(fixture.providerRequests).toEqual([
			'https://oauth2.googleapis.com/token',
			'https://openidconnect.googleapis.com/v1/userinfo',
		]);
		expect(fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' })).toEqual([]);
		const completionRoute = callback.headers.get('location');
		const validCompletionBinding = cookies.get('agent_vm_oauth_completion_binding');
		if (completionRoute === null || validCompletionBinding === undefined)
			throw new Error('Missing bound completion response.');
		cookies.set('agent_vm_oauth_completion_binding', 'wrong-binding');
		const wrongBinding = await request(completionRoute);
		expect(wrongBinding.status).toBe(403);
		expect(await wrongBinding.text()).not.toContain('synthetic@example.test');
		cookies.set('agent_vm_oauth_completion_binding', validCompletionBinding);
		const completion = await request(completionRoute);
		expect(completion.status).toBe(200);
		const confirmation = nativeForm(await completion.text(), '/confirm');
		const confirmed = await request(confirmation.action, confirmation.fields);
		expect(confirmed.status).toBe(200);
		expect(
			fixture.catalog.listGrantsForAgent({ agentId: 'sun', zoneId: 'test-zone' }),
		).toHaveLength(1);
	});

	it('keeps cancellation, retry, partial completion, and next-application routes bound to Access', async () => {
		fixture = await createBrokerFacadeFixture();
		const account = await fixture.enroll('sun');
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		const transactionId = oauthTransactionIdSchema.parse('transaction_identifier_1234567890abcdef');
		const completionId = oauthCompletionSessionIdSchema.parse(
			'completion_session_1234567890abcdef',
		);
		const binding = 'browser_binding_secret_1234567890abcdefghi';
		const csrfToken = 'csrf_token_1234567890abcdefghijklmnop';
		const redirect = {
			applicationId: facadeApplicationId,
			applicationLabel: 'Gmail',
			authorizationUrl: 'https://accounts.google.test/authorize-next',
			browserBindingSecret: binding,
			expiresAtMs: 15_000,
			kind: 'redirect' as const,
			transactionId,
		};
		vi.spyOn(fixture.broker, 'getBrowserSession').mockReturnValue(facadeIdentity);
		const cancelTransaction = vi
			.spyOn(fixture.broker, 'cancelBrowserTransaction')
			.mockReturnValue(true);
		const cancelCompletion = vi
			.spyOn(fixture.broker, 'cancelBrowserCompletion')
			.mockReturnValue(true);
		const retryApplication = vi.spyOn(fixture.broker, 'retryApplication').mockReturnValue(redirect);
		vi.spyOn(fixture.broker, 'getRetryPage').mockReturnValue({
			completed: ['Gmail'],
			csrfToken,
			retryable: ['Workspace'],
		});
		const callback = vi.spyOn(fixture.broker, 'handleGoogleCallback').mockResolvedValue({
			completed: ['Gmail'],
			kind: 'partial-completion',
			retry: redirect,
			retryCsrfToken: csrfToken,
			retryable: ['Workspace'],
		});
		const confirmAccount = vi.spyOn(fixture.broker, 'confirmAccount');
		const disconnect = vi.spyOn(fixture.broker, 'confirmDisconnect').mockResolvedValue({
			accountId: account.accountId,
			applicationId: facadeApplicationId,
			kind: 'authorization-disconnected',
		});
		const app = createOAuthHttpApp({
			assets: {
				files: {},
				manifest: { css: 'oauth.1111111111111111.css', javascript: 'oauth.2222222222222222.js' },
			},
			brokerService: fixture.broker,
			browserIdentityVerifier: {
				verifyRequest: async () => ({
					kind: 'verified',
					human: { authenticationExpiresAtMs: 20_000, identity: facadeIdentity },
				}),
			},
			config: compiled.oauthConfig,
			isAdmissionOpen: () => true,
			loginContinuations: createOAuthLoginContinuationStore(),
			navigation: createOAuthBrowserNavigationStore(),
			now: () => 10_000,
			policyService: createPolicyService({ compiled, fixture }),
			publicBaseUrl: compiled.oauthConfig.browser.publicBaseUrl,
		});
		const origin = compiled.oauthConfig.browser.publicBaseUrl;
		const transactionCookies = `agent_vm_oauth_transaction=${transactionId}; agent_vm_oauth_transaction_binding=${binding}`;
		const completionCookies = `agent_vm_oauth_completion=${completionId}; agent_vm_oauth_completion_binding=${binding}`;
		const post = async (
			route: string,
			cookie: string,
			submittedOrigin = origin,
		): Promise<Response> =>
			await app.request(`${origin}${route}`, {
				body: new URLSearchParams({ accountAlias: 'Personal Google', csrfToken }),
				headers: { cookie, origin: submittedOrigin },
				method: 'POST',
			});
		const partial = await app.request(`${origin}/oauth/google/callback?code=test&state=test`, {
			headers: { cookie: transactionCookies },
		});
		expect(partial.status).toBe(303);
		expect(partial.headers.get('location')).toBe(`/oauth/completions/${transactionId}/retry`);
		expect(callback).toHaveBeenCalledOnce();
		expect(partial.headers.getSetCookie()).toEqual(
			expect.arrayContaining([expect.stringMatching(/agent_vm_oauth_transaction=.*Max-Age=5/u)]),
		);
		const retryPage = await app.request(`${origin}/oauth/completions/${transactionId}/retry`, {
			headers: { cookie: transactionCookies },
		});
		expect(retryPage.status).toBe(200);
		expect(await retryPage.text()).toContain('Workspace');
		expect(
			(
				await post(
					`/oauth/completions/${transactionId}/retry`,
					transactionCookies,
					'https://wrong.example.test',
				)
			).status,
		).toBe(403);
		expect(retryApplication).not.toHaveBeenCalled();
		const retried = await post(`/oauth/completions/${transactionId}/retry`, transactionCookies);
		expect(retried.status).toBe(200);
		expect(await retried.text()).toContain('authorize-next');
		expect(retryApplication).toHaveBeenCalledOnce();
		expect(
			(
				await post(
					`/oauth/transactions/${transactionId}/disconnect`,
					transactionCookies,
					'https://wrong.example.test',
				)
			).status,
		).toBe(403);
		expect(disconnect).not.toHaveBeenCalled();
		expect(
			(await post(`/oauth/transactions/${transactionId}/disconnect`, transactionCookies)).status,
		).toBe(200);
		expect(disconnect).toHaveBeenCalledWith(
			expect.objectContaining({ authenticationExpiresAtMs: 20_000 }),
		);
		expect(
			(await post(`/oauth/transactions/${transactionId}/cancel`, transactionCookies)).status,
		).toBe(200);
		expect(cancelTransaction).toHaveBeenCalledOnce();
		expect(
			(await post(`/oauth/completions/${completionId}/cancel`, completionCookies)).status,
		).toBe(200);
		expect(cancelCompletion).toHaveBeenCalledOnce();
		confirmAccount.mockResolvedValueOnce({ kind: 'replacement-pending' });
		expect(
			(await post(`/oauth/completions/${completionId}/confirm`, completionCookies)).status,
		).toBe(202);
		confirmAccount.mockResolvedValueOnce({
			...redirect,
			applications: [{ applicationId: facadeApplicationId, label: 'Gmail', status: 'authorizing' }],
			csrfToken,
		});
		const nextApplication = await post(
			`/oauth/completions/${completionId}/confirm`,
			completionCookies,
		);
		expect(nextApplication.status).toBe(200);
		expect(await nextApplication.text()).toContain('authorize-next');
		expect(confirmAccount).toHaveBeenCalledWith(
			expect.objectContaining({ authenticationExpiresAtMs: 20_000 }),
		);
	});

	it('wires account-policy preview and commit while wrong Origin, CSRF, and expired local context remain side-effect free', async () => {
		let currentTimeMs = 1_000;
		fixture = await createBrokerFacadeFixture({ now: () => currentTimeMs });
		const account = await fixture.enroll('sun');
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		const policy = createPolicyService({
			compiled,
			fixture,
			now: () => currentTimeMs,
		});
		const verifier: CloudflareAccessIdentityVerifier = {
			verifyRequest: async () => ({
				kind: 'verified',
				human: {
					authenticationExpiresAtMs: 1_000_000,
					emailAddress: 'member@example.test',
					identity: facadeIdentity,
				},
			}),
		};
		const app = createOAuthHttpApp({
			assets: {
				files: {},
				manifest: { css: 'oauth.1111111111111111.css', javascript: 'oauth.2222222222222222.js' },
			},
			brokerService: fixture.broker,
			browserIdentityVerifier: verifier,
			config: compiled.oauthConfig,
			isAdmissionOpen: () => true,
			loginContinuations: createOAuthLoginContinuationStore({ now: () => currentTimeMs }),
			navigation: createOAuthBrowserNavigationStore({ now: () => currentTimeMs }),
			now: () => currentTimeMs,
			policyService: policy,
			publicBaseUrl: compiled.oauthConfig.browser.publicBaseUrl,
		});
		const cookies = new Map<string, string>();
		const request = async (
			route: string,
			fields?: URLSearchParams,
			origin?: string,
		): Promise<Response> =>
			await requestWithCookies({
				app,
				baseUrl: compiled.oauthConfig.browser.publicBaseUrl,
				cookies,
				...(fields === undefined ? {} : { fields }),
				...(origin === undefined ? {} : { origin }),
				route,
			});
		const start = await request('/oauth/agents');
		const login = await request(start.headers.get('location') ?? '');
		await request(login.headers.get('location') ?? '');
		const accountPath = `/oauth/agents/sun/accounts/${account.accountId}?application=gmail-app`;
		const accountStart = await request(accountPath);
		const accountLogin = await request(accountStart.headers.get('location') ?? '');
		const accountPage = await request(accountLogin.headers.get('location') ?? '');
		const edit = nativeForm(await accountPage.text(), '/preview');
		edit.fields.set('read.gmail', 'deny');
		const activity = (): ReturnType<typeof policy.resolveActivityAvailability> =>
			policy.resolveActivityAvailability({
				accountId: account.accountId,
				agentId: 'sun',
				applicationId: facadeApplicationId,
				operationId: 'gmail.search',
			});

		expect((await request(edit.action, edit.fields, 'https://other.example.test')).status).toBe(
			403,
		);
		expect(activity()).toMatchObject({ kind: 'ready', disposition: 'allow' });
		const wrongCsrf = new URLSearchParams(edit.fields);
		wrongCsrf.set('csrfToken', 'wrong-csrf');
		expect((await request(edit.action, wrongCsrf)).status).toBe(409);
		expect(activity()).toMatchObject({ kind: 'ready', disposition: 'allow' });
		const preview = await request(edit.action, edit.fields);
		expect(preview.status).toBe(200);
		const confirmation = nativeForm(await preview.text(), '/confirm');
		const saved = await request(confirmation.action, confirmation.fields);
		expect(saved.status).toBe(303);
		expect(activity()).toEqual({ kind: 'denied' });

		const secondAccountStart = await request(accountPath);
		const secondAccountLogin = await request(secondAccountStart.headers.get('location') ?? '');
		const secondAccountPage = await request(secondAccountLogin.headers.get('location') ?? '');
		const secondEdit = nativeForm(await secondAccountPage.text(), '/preview');
		secondEdit.fields.set('read.gmail', 'allow');
		const secondPreview = await request(secondEdit.action, secondEdit.fields);
		const secondConfirmation = nativeForm(await secondPreview.text(), '/confirm');
		currentTimeMs += 10 * 60_000 + 1;
		const expired = await request(secondConfirmation.action, secondConfirmation.fields);

		expect(expired.status).toBe(403);
		expect(activity()).toEqual({ kind: 'denied' });
	});

	it('binds the real Access app only to loopback HTTP without controller admin or lease routes', async () => {
		fixture = await createBrokerFacadeFixture();
		await fixture.enroll('sun');
		const compiled = compileOAuthPolicy(createOAuthPolicyCompilerTestInput());
		const app = createOAuthHttpApp({
			assets: {
				files: {},
				manifest: { css: 'oauth.1111111111111111.css', javascript: 'oauth.2222222222222222.js' },
			},
			brokerService: fixture.broker,
			browserIdentityVerifier: {
				verifyRequest: async () => ({
					kind: 'verified',
					human: {
						authenticationExpiresAtMs: Date.now() + 60_000,
						identity: facadeIdentity,
					},
				}),
			},
			config: compiled.oauthConfig,
			isAdmissionOpen: () => true,
			loginContinuations: createOAuthLoginContinuationStore(),
			navigation: createOAuthBrowserNavigationStore(),
			policyService: createPolicyService({ compiled, fixture }),
			publicBaseUrl: compiled.oauthConfig.browser.publicBaseUrl,
		});
		const port = await reserveLoopbackPort();
		await expect(startOAuthHttpServer({ app, bindAddress: '0.0.0.0', port })).rejects.toThrow(
			'loopback',
		);
		const listener = await startOAuthHttpServer({ app, bindAddress: '127.0.0.1', port });
		try {
			const response = await fetch(`http://127.0.0.1:${String(port)}/oauth/auth/start`, {
				redirect: 'manual',
			});
			expect(response.status).toBe(303);
			const adminResponses = await Promise.all(
				['/zones/apollofam/execute-command', '/stop-controller', '/lease'].map(
					async (route) =>
						await fetch(`http://127.0.0.1:${String(port)}${route}`, { method: 'POST' }),
				),
			);
			for (const adminResponse of adminResponses) expect(adminResponse.status).toBe(404);
		} finally {
			await listener.close();
		}
	});
});
