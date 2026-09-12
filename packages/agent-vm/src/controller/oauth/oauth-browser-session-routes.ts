import type { OAuthConfig } from '@agent-vm/config-contracts';
import type { OAuthApprovalAssetManifest } from '@agent-vm/oauth-approval-ui';
import type {
	OAuthBrowserNavigationStore,
	OAuthLoginContinuationStore,
} from '@agent-vm/oauth-broker';
import type { OAuthBrowserSessionIdentity } from '@agent-vm/oauth-broker-contracts';
import type { GoogleOAuthBrokerService } from '@agent-vm/oauth-broker/google';
import { Hono } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';

import type { ClerkBrowserIdentityVerifier } from './clerk-browser-identity-verifier.js';
import { createClerkLoginRoutes } from './clerk-login-routes.js';

export const oauthNavigationCookieName = 'agent_vm_oauth_navigation';
export const oauthNavigationBindingCookieName = 'agent_vm_oauth_navigation_binding';

export function createOAuthNavigationCookies(
	created: Extract<ReturnType<OAuthBrowserNavigationStore['create']>, { kind: 'created' }>,
): readonly string[] {
	return [
		`${oauthNavigationCookieName}=${created.contextId}; Path=/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
		`${oauthNavigationBindingCookieName}=${created.browserBindingSecret}; Path=/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
	];
}

export interface OAuthBrowserSessionRoutes {
	readonly routes: Hono;
	readIdentity(
		request: Request,
		target:
			| { readonly kind: 'transaction' | 'completion'; readonly id: string }
			| { readonly kind: 'navigation' },
	): Promise<
		| { readonly kind: 'verified'; readonly identity: OAuthBrowserSessionIdentity }
		| { readonly kind: 'login-required' | 'denied' | 'unavailable' }
	>;
}

/** Network admission is supplied by the outer website. Only safe GET bootstrap may redirect to Clerk. */
export function createOAuthBrowserSessionRoutes(props: {
	readonly assets: OAuthApprovalAssetManifest;
	readonly broker: GoogleOAuthBrokerService;
	readonly config: OAuthConfig;
	readonly verifier: ClerkBrowserIdentityVerifier;
	readonly continuations: OAuthLoginContinuationStore;
	readonly navigation: OAuthBrowserNavigationStore;
	readonly cancelPolicyContexts: (identity: OAuthBrowserSessionIdentity) => void;
}): OAuthBrowserSessionRoutes {
	const routes = new Hono();
	const readCookies = (request: Request): ReadonlyMap<string, string> =>
		new Map(
			(request.headers.get('cookie') ?? '').split(';').map((part) => {
				const separator = part.indexOf('=');
				return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
			}),
		);
	const cancelSession = (identity: OAuthBrowserSessionIdentity): void => {
		props.broker.cancelBrowserCeremonies(identity);
		props.navigation.cancelSession(identity);
		props.cancelPolicyContexts(identity);
	};
	const readIdentity: OAuthBrowserSessionRoutes['readIdentity'] = async (request, target) => {
		const cookies = readCookies(request);
		let identity: OAuthBrowserSessionIdentity | undefined;
		const navigation = props.navigation.read({
			contextId: cookies.get(oauthNavigationCookieName) ?? '',
			browserBindingSecret: cookies.get(oauthNavigationBindingCookieName) ?? '',
		});
		if (target.kind === 'navigation') identity = navigation?.identity;
		else {
			const cookiePrefix =
				target.kind === 'transaction' ? 'agent_vm_oauth_transaction' : 'agent_vm_oauth_completion';
			if (cookies.get(cookiePrefix) === target.id && cookies.has(`${cookiePrefix}_binding`)) {
				identity = props.broker.getBrowserSession(
					target,
					cookies.get(`${cookiePrefix}_binding`) ?? '',
				);
				if (identity === undefined) return { kind: 'denied' };
			}
			if (
				identity === undefined &&
				target.kind === 'transaction' &&
				navigation?.target.kind === 'authorization' &&
				navigation.target.transactionId === target.id
			)
				identity = navigation.identity;
		}
		if (identity === undefined) return { kind: 'login-required' };
		const currentCookie = await props.verifier.verifyCurrentCookie(request);
		if (currentCookie.kind === 'verification-unavailable') return { kind: 'unavailable' };
		if (
			currentCookie.kind === 'identity-mismatch' ||
			(currentCookie.kind === 'verified' &&
				(currentCookie.identity.issuer !== identity.issuer ||
					currentCookie.identity.userId !== identity.userId ||
					currentCookie.identity.sessionId !== identity.sessionId))
		) {
			cancelSession(identity);
			return { kind: 'denied' };
		}
		const active = await props.verifier.verifySession(identity);
		if (active.kind !== 'verified') {
			cancelSession(identity);
			return { kind: active.kind === 'verification-unavailable' ? 'unavailable' : 'denied' };
		}
		if (
			active.identity.issuer !== identity.issuer ||
			active.identity.userId !== identity.userId ||
			active.identity.sessionId !== identity.sessionId
		)
			return { kind: 'denied' };
		return { kind: 'verified', identity };
	};
	routes.route(
		'/',
		createClerkLoginRoutes({
			websiteOrigin: props.config.browser.publicBaseUrl,
			issuer: props.config.browser.identity.issuer,
			publishableKey: props.config.browser.identity.publishableKey,
			assets: props.assets,
			verifier: props.verifier,
			continuations: props.continuations,
			bindVerifiedContinuation: async ({ identity, target }) => {
				if (identity.issuer !== props.config.browser.identity.issuer) return { kind: 'denied' };
				if (
					!Object.values(props.config.owners).some((owner) => owner.clerkUserId === identity.userId)
				)
					return { kind: 'waiting-for-access' };
				if (target.kind === 'authorization') {
					try {
						props.broker.getPermissionPage({ identity, transactionId: target.transactionId });
					} catch {
						return { kind: 'denied' };
					}
				}
				const created = props.navigation.create({ identity, target });
				return created.kind === 'created'
					? { kind: 'bound', cookies: createOAuthNavigationCookies(created) }
					: { kind: 'denied' };
			},
		}),
	);
	routes.post('/oauth/auth/change-person', async (context) => {
		if (context.req.header('origin') !== props.config.browser.publicBaseUrl)
			return context.text('Invalid browser origin.', 403);
		const navigation = props.navigation.read({
			contextId: getCookie(context, oauthNavigationCookieName) ?? '',
			browserBindingSecret: getCookie(context, oauthNavigationBindingCookieName) ?? '',
		});
		if (navigation === undefined) return context.text('Browser context expired.', 403);
		const form = await context.req.formData();
		if (form.getAll('csrfToken').length !== 1 || form.get('csrfToken') !== navigation.csrfToken)
			return context.text('Invalid browser form.', 403);
		cancelSession(navigation.identity);
		for (const name of [
			oauthNavigationCookieName,
			oauthNavigationBindingCookieName,
			'agent_vm_oauth_transaction',
			'agent_vm_oauth_transaction_binding',
			'agent_vm_oauth_completion',
			'agent_vm_oauth_completion_binding',
		])
			deleteCookie(context, name, { path: '/oauth', secure: true });
		const revoked = await props.verifier.revokeSession(navigation.identity);
		return revoked.kind === 'revoked'
			? context.redirect('/oauth/auth/signed-out', 303)
			: context.text(
					'Local forms were cancelled, but browser sign-out could not be confirmed. Try signing out in Clerk.',
					503,
				);
	});
	return { routes, readIdentity };
}
