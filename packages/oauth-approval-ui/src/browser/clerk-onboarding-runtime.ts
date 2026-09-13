import { Clerk } from '@clerk/clerk-js';

import type { GoogleOnboardingRuntime } from './google-onboarding-flow.js';

const startPath = '/oauth/auth/start';
const returnPath = '/oauth/auth/return';
const callbackPath = '/oauth/auth/callback';
const incompletePath = '/oauth/auth/start?issue=incomplete';

export async function loadClerkOnboarding(
	publishableKey: string,
	navigation: { readonly origin: string; replace(url: string): void },
): Promise<{
	readonly runtime: GoogleOnboardingRuntime;
	readonly hasGoogleIdentity: () => boolean;
	readonly completeCallback: () => Promise<void>;
}> {
	const clerk = new Clerk(publishableKey);
	await clerk.load({
		telemetry: false,
		signInUrl: startPath,
		signUpUrl: startPath,
		signInForceRedirectUrl: returnPath,
		signUpForceRedirectUrl: returnPath,
	});
	const requireClient = (): NonNullable<Clerk['client']> => {
		if (clerk.client === undefined) throw new Error('Login unavailable');
		return clerk.client;
	};
	const googleRedirect = {
		strategy: 'oauth_google' as const,
		redirectUrl: new URL(callbackPath, navigation.origin).href,
		redirectUrlComplete: new URL(returnPath, navigation.origin).href,
	};
	return {
		hasGoogleIdentity: () =>
			clerk.user?.externalAccounts.some(
				(account) => account.provider === 'google' && account.verification?.status === 'verified',
			) ?? false,
		runtime: {
			hasIncompleteSignup: () =>
				clerk.client?.signUp.status === 'missing_requirements' &&
				clerk.client.signUp.id !== undefined,
			hasSession: () => clerk.session !== null && clerk.session !== undefined,
			acceptInvitation: async (ticket) => {
				const signup = await requireClient().signUp.create({ strategy: 'ticket', ticket });
				if (signup.status === 'complete' && signup.createdSessionId !== null)
					return { kind: 'complete', sessionId: signup.createdSessionId };
				if (signup.status === 'missing_requirements') return { kind: 'incomplete' };
				throw new Error('Invitation unavailable');
			},
			activateSession: async (sessionId) => {
				await clerk.setActive({ session: sessionId });
			},
			prepareGoogle: async () => {
				// Ensure Clerk has minted the current browser cookie before the server pins its identity.
				await clerk.session?.getToken();
				const response = await fetch('/oauth/auth/prepare-google', {
					method: 'POST',
					credentials: 'same-origin',
					redirect: 'error',
				});
				if (!response.ok) throw new Error('Login context unavailable');
			},
			signOut: async () => {
				await clerk.signOut(() => {});
			},
			signInWithGoogle: async () => {
				await requireClient().signIn.authenticateWithRedirect(googleRedirect);
			},
			continueInvitationWithGoogle: async () => {
				await requireClient().signUp.authenticateWithRedirect({
					...googleRedirect,
					continueSignUp: true,
				});
			},
		},
		completeCallback: async () => {
			await clerk.handleRedirectCallback(
				{
					signInUrl: startPath,
					signUpUrl: startPath,
					signInForceRedirectUrl: returnPath,
					signUpForceRedirectUrl: returnPath,
					continueSignUpUrl: incompletePath,
					firstFactorUrl: incompletePath,
					secondFactorUrl: incompletePath,
					resetPasswordUrl: incompletePath,
					verifyEmailAddressUrl: incompletePath,
					verifyPhoneNumberUrl: incompletePath,
					signInProtectCheckUrl: incompletePath,
					signUpProtectCheckUrl: incompletePath,
				},
				async (destination) => {
					const url = new URL(destination, navigation.origin);
					if (url.origin !== navigation.origin || ![startPath, returnPath].includes(url.pathname))
						throw new Error('Unexpected login destination');
					navigation.replace(url.href);
				},
			);
		},
	};
}
