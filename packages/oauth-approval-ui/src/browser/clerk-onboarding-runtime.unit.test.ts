import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
	load: vi.fn(async () => {}),
	setActive: vi.fn(async () => {}),
	signOut: vi.fn(async () => {}),
	handleRedirectCallback: vi.fn<
		(params: unknown, navigate: (destination: string) => Promise<unknown>) => Promise<void>
	>(async () => {}),
	session: { getToken: vi.fn(async () => 'fixture-token') },
	user: { externalAccounts: [{ provider: 'google', verification: { status: 'verified' } }] },
	client: {
		signIn: { authenticateWithRedirect: vi.fn(async () => {}) },
		signUp: {
			status: 'missing_requirements',
			id: 'signup_fixture',
			create: vi.fn(async () => ({ status: 'complete', createdSessionId: 'sess_ticket' })),
			authenticateWithRedirect: vi.fn(async () => {}),
		},
	},
}));
vi.mock('@clerk/clerk-js', () => ({
	Clerk: class {
		constructor() {
			return sdk;
		}
	},
}));
import { loadClerkOnboarding } from './clerk-onboarding-runtime.js';

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal('window', { location: { origin: 'https://site.example.test', replace: vi.fn() } });
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => new Response(null, { status: 204 })),
	);
});
afterEach(() => vi.unstubAllGlobals());

describe('pinned public Clerk adapter contract', () => {
	it('executes the callback navigation guard and rejects an external destination', async () => {
		const navigation = { origin: 'https://site.example.test', replace: vi.fn() };
		const { completeCallback } = await loadClerkOnboarding('pk_test_fixture', navigation);
		await completeCallback();
		const navigate = sdk.handleRedirectCallback.mock.calls[0]?.[1];
		if (navigate === undefined) throw new Error('Missing callback navigator');
		await expect(navigate('https://hostile.example/oauth/auth/return')).rejects.toThrow(
			'Unexpected login destination',
		);
		await expect(navigate('/oauth/admin')).rejects.toThrow('Unexpected login destination');
		expect(navigation.replace).not.toHaveBeenCalled();
		await navigate('/oauth/auth/return');
		expect(navigation.replace).toHaveBeenCalledWith('https://site.example.test/oauth/auth/return');
	});
	it('requests only Google sign-in with fixed owned callbacks and no additional scopes', async () => {
		const { runtime } = await loadClerkOnboarding('pk_test_fixture', {
			origin: 'https://site.example.test',
			replace: vi.fn(),
		});
		await runtime.signInWithGoogle();
		expect(sdk.client.signIn.authenticateWithRedirect).toHaveBeenCalledWith({
			strategy: 'oauth_google',
			redirectUrl: 'https://site.example.test/oauth/auth/callback',
			redirectUrlComplete: 'https://site.example.test/oauth/auth/return',
		});
	});
	it('accepts the invitation separately and PATCH-continues the same signup', async () => {
		const { runtime } = await loadClerkOnboarding('pk_test_fixture', {
			origin: 'https://site.example.test',
			replace: vi.fn(),
		});
		expect(await runtime.acceptInvitation('private-ticket')).toEqual({
			kind: 'complete',
			sessionId: 'sess_ticket',
		});
		expect(sdk.client.signUp.create).toHaveBeenCalledWith({
			strategy: 'ticket',
			ticket: 'private-ticket',
		});
		await runtime.continueInvitationWithGoogle();
		expect(sdk.client.signUp.authenticateWithRedirect).toHaveBeenCalledWith({
			strategy: 'oauth_google',
			continueSignUp: true,
			redirectUrl: 'https://site.example.test/oauth/auth/callback',
			redirectUrlComplete: 'https://site.example.test/oauth/auth/return',
		});
	});
	it('prepares without trusting a user ID payload and suppresses default sign-out navigation', async () => {
		const { runtime } = await loadClerkOnboarding('pk_test_fixture', {
			origin: 'https://site.example.test',
			replace: vi.fn(),
		});
		await runtime.prepareGoogle();
		expect(fetch).toHaveBeenCalledWith('/oauth/auth/prepare-google', {
			method: 'POST',
			credentials: 'same-origin',
			redirect: 'error',
		});
		await runtime.signOut();
		expect(sdk.signOut).toHaveBeenCalledWith(expect.any(Function));
	});
	it('does not treat rejected server preparation as successful', async () => {
		vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }));
		const { runtime } = await loadClerkOnboarding('pk_test_fixture', {
			origin: 'https://site.example.test',
			replace: vi.fn(),
		});
		await expect(runtime.prepareGoogle()).rejects.toThrow('Login context unavailable');
	});
	it('configures callback completion and all extra-factor paths inside the website', async () => {
		const { completeCallback } = await loadClerkOnboarding('pk_test_fixture', {
			origin: 'https://site.example.test',
			replace: vi.fn(),
		});
		await completeCallback();
		expect(sdk.handleRedirectCallback).toHaveBeenCalledWith(
			expect.objectContaining({
				signInForceRedirectUrl: '/oauth/auth/return',
				signUpForceRedirectUrl: '/oauth/auth/return',
				secondFactorUrl: '/oauth/auth/start?issue=incomplete',
			}),
			expect.any(Function),
		);
	});
});
