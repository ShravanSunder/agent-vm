import type { OAuthConfig } from '@agent-vm/config-contracts';
import {
	renderWaitingForAccessPage,
	type OAuthApprovalAssetManifest,
} from '@agent-vm/oauth-approval-ui';
import type {
	OAuthBrowserNavigationStore,
	OAuthLoginContinuationStore,
	OAuthLoginContinuationTarget,
} from '@agent-vm/oauth-broker';
import type { OAuthBrowserSessionIdentity } from '@agent-vm/oauth-broker-contracts';
import type { GoogleOAuthBrokerService } from '@agent-vm/oauth-broker/google';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { CloudflareAccessIdentityVerifier } from './cloudflare-access-identity-verifier.js';

export const oauthNavigationCookieName = 'agent_vm_oauth_navigation';
export const oauthNavigationBindingCookieName = 'agent_vm_oauth_navigation_binding';
const continuationCookieName = 'agent_vm_oauth_login';
const continuationBindingCookieName = 'agent_vm_oauth_login_binding';
const oauthCookiePath = '/oauth';

export function createOAuthNavigationCookies(
	created: Extract<ReturnType<OAuthBrowserNavigationStore['create']>, { kind: 'created' }>,
): readonly string[] {
	return [
		`${oauthNavigationCookieName}=${created.contextId}; Path=/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
		`${oauthNavigationBindingCookieName}=${created.browserBindingSecret}; Path=/oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
	];
}

export function beginAccessLogin(props: {
	readonly context: Context;
	readonly continuations: OAuthLoginContinuationStore;
	readonly target: OAuthLoginContinuationTarget;
}): Response {
	const created = props.continuations.create(props.target);
	if (created.kind !== 'created')
		return props.context.text('Login capacity reached. Try again later.', 503);
	for (const [name, value] of [
		[continuationCookieName, created.continuationId],
		[continuationBindingCookieName, created.browserBindingSecret],
	] as const)
		setCookie(props.context, name, value, {
			httpOnly: true,
			maxAge: 600,
			path: oauthCookiePath,
			sameSite: 'Lax',
			secure: true,
		});
	return props.context.redirect('/oauth/auth/start', 303);
}

function continuationDestination(target: OAuthLoginContinuationTarget): string {
	switch (target.kind) {
		case 'agents':
			return '/oauth/agents';
		case 'account':
			return `/oauth/agents/${encodeURIComponent(target.agentId)}/accounts/${encodeURIComponent(target.accountId)}${target.applicationId === undefined ? '' : `?application=${encodeURIComponent(target.applicationId)}`}`;
		case 'authorization':
			return `/oauth/transactions/${encodeURIComponent(target.transactionId)}`;
		default: {
			const exhaustive: never = target;
			throw new Error(`Unsupported login continuation: ${String(exhaustive)}`);
		}
	}
}

export interface OAuthBrowserSessionRoutes {
	readonly routes: Hono;
	readIdentity(
		request: Request,
		target:
			| { readonly kind: 'transaction' | 'completion'; readonly id: string }
			| { readonly kind: 'navigation' },
	): Promise<
		| {
				readonly kind: 'verified';
				readonly authenticationExpiresAtMs: number;
				readonly identity: OAuthBrowserSessionIdentity;
		  }
		| { readonly kind: 'login-required' | 'denied' | 'unavailable' }
	>;
}

export function createOAuthBrowserSessionRoutes(props: {
	readonly assets: OAuthApprovalAssetManifest;
	readonly broker: GoogleOAuthBrokerService;
	readonly cancelPolicyContexts: (identity: OAuthBrowserSessionIdentity) => void;
	readonly config: OAuthConfig;
	readonly continuations: OAuthLoginContinuationStore;
	readonly navigation: OAuthBrowserNavigationStore;
	readonly verifier: CloudflareAccessIdentityVerifier;
}): OAuthBrowserSessionRoutes {
	const routes = new Hono();
	const readCookies = (request: Request): ReadonlyMap<string, string> =>
		new Map(
			(request.headers.get('cookie') ?? '').split(';').flatMap((part) => {
				const separator = part.indexOf('=');
				return separator < 1
					? []
					: [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const];
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
			if (cookies.get(cookiePrefix) === target.id && cookies.has(`${cookiePrefix}_binding`))
				identity = props.broker.getBrowserSession(
					target,
					cookies.get(`${cookiePrefix}_binding`) ?? '',
				);
			if (
				identity === undefined &&
				target.kind === 'transaction' &&
				navigation?.target.kind === 'authorization' &&
				navigation.target.transactionId === target.id
			)
				identity = navigation.identity;
		}
		if (identity === undefined) return { kind: 'login-required' };
		const current = await props.verifier.verifyRequest(request);
		if (current.kind === 'verification-unavailable') return { kind: 'unavailable' };
		if (
			current.kind !== 'verified' ||
			current.human.identity.issuer !== identity.issuer ||
			current.human.identity.subject !== identity.subject
		)
			return { kind: 'denied' };
		return {
			kind: 'verified',
			authenticationExpiresAtMs: current.human.authenticationExpiresAtMs,
			identity: current.human.identity,
		};
	};

	routes.get('/oauth/auth/start', async (context) => {
		const continuationId = getCookie(context, continuationCookieName);
		const browserBindingSecret = getCookie(context, continuationBindingCookieName);
		if (continuationId === undefined || browserBindingSecret === undefined)
			return beginAccessLogin({
				context,
				continuations: props.continuations,
				target: { kind: 'agents' },
			});
		const verified = await props.verifier.verifyRequest(context.req.raw);
		if (verified.kind !== 'verified')
			return context.text(
				'Browser authentication could not be verified.',
				verified.kind === 'verification-unavailable' ? 503 : 403,
			);
		const consumed = props.continuations.consume({
			browserBindingSecret,
			continuationId,
			identity: verified.human.identity,
		});
		deleteCookie(context, continuationCookieName, { path: oauthCookiePath, secure: true });
		deleteCookie(context, continuationBindingCookieName, { path: oauthCookiePath, secure: true });
		if (consumed.kind !== 'accepted')
			return context.text('Login context expired. Start again.', 409);
		if (
			verified.human.identity.issuer !== props.config.browser.identity.issuer ||
			!Object.values(props.config.owners).some(
				(owner) => owner.subject === verified.human.identity.subject,
			)
		)
			return context.html(
				renderWaitingForAccessPage({
					...(verified.human.emailAddress === undefined
						? {}
						: { emailAddress: verified.human.emailAddress }),
					stylesheet: props.assets.css,
				}),
				403,
			);
		if (consumed.target.kind === 'authorization') {
			try {
				props.broker.getPermissionPage({
					identity: verified.human.identity,
					transactionId: consumed.target.transactionId,
				});
			} catch {
				return context.text('This account or agent is not available.', 403);
			}
		}
		const created = props.navigation.create({
			identity: verified.human.identity,
			target: consumed.target,
		});
		if (created.kind !== 'created') return context.text('Browser capacity reached.', 503);
		for (const cookie of createOAuthNavigationCookies(created))
			context.header('Set-Cookie', cookie, { append: true });
		return context.redirect(continuationDestination(consumed.target), 303);
	});

	routes.post('/oauth/auth/change-person', async (context) => {
		if (context.req.header('origin') !== props.config.browser.publicBaseUrl)
			return context.text('Invalid browser origin.', 403);
		const navigation = props.navigation.read({
			contextId: getCookie(context, oauthNavigationCookieName) ?? '',
			browserBindingSecret: getCookie(context, oauthNavigationBindingCookieName) ?? '',
		});
		if (navigation === undefined) return context.text('Browser context expired.', 403);
		const current = await props.verifier.verifyRequest(context.req.raw);
		if (
			current.kind !== 'verified' ||
			current.human.identity.issuer !== navigation.identity.issuer ||
			current.human.identity.subject !== navigation.identity.subject
		)
			return context.text(
				'Browser identity is unavailable.',
				current.kind === 'verification-unavailable' ? 503 : 403,
			);
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
			deleteCookie(context, name, { path: oauthCookiePath, secure: true });
		return context.redirect(
			new URL('/cdn-cgi/access/logout', props.config.browser.publicBaseUrl).toString(),
			303,
		);
	});
	return { routes, readIdentity };
}
