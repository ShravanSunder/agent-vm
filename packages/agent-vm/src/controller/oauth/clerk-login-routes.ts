import type {
	OAuthLoginContinuationStore,
	OAuthLoginContinuationTarget,
} from '@agent-vm/oauth-broker';
import type { OAuthBrowserSessionIdentity } from '@agent-vm/oauth-broker-contracts';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { ClerkBrowserIdentityVerifier } from './clerk-browser-identity-verifier.js';

const loginCookieName = 'agent_vm_oauth_login';
const bindingCookieName = 'agent_vm_oauth_login_binding';
const loginCookiePath = '/oauth/auth';

function clearLoginCookies(context: Context): void {
	for (const name of [loginCookieName, bindingCookieName])
		deleteCookie(context, name, { path: loginCookiePath, secure: true });
}

export function beginClerkLogin(props: {
	readonly context: Context;
	readonly target: OAuthLoginContinuationTarget;
	readonly continuations: OAuthLoginContinuationStore;
}): Response {
	const created = props.continuations.create(props.target);
	if (created.kind !== 'created')
		return props.context.text('Login capacity reached. Try again later.', 503);
	for (const [name, value] of [
		[loginCookieName, created.continuationId],
		[bindingCookieName, created.browserBindingSecret],
	] as const)
		setCookie(props.context, name, value, {
			httpOnly: true,
			secure: true,
			sameSite: 'Lax',
			path: loginCookiePath,
			maxAge: 600,
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

// Mount beneath the OAuth website's socket-peer network gate, never on admin ingress.
export function createClerkLoginRoutes(props: {
	readonly verifier: ClerkBrowserIdentityVerifier;
	readonly continuations: OAuthLoginContinuationStore;
	readonly bindVerifiedContinuation: (value: {
		readonly identity: OAuthBrowserSessionIdentity;
		readonly target: OAuthLoginContinuationTarget;
	}) => Promise<readonly string[] | undefined>;
}): Hono {
	const app = new Hono();
	app.use('/oauth/auth/*', async (context, next) => {
		context.header('Cache-Control', 'no-store');
		context.header('Referrer-Policy', 'no-referrer');
		context.header('X-Content-Type-Options', 'nosniff');
		context.header(
			'Content-Security-Policy',
			"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
		);
		await next();
	});
	const bootstrap = async (context: Context): Promise<Response> => {
		let continuationId = getCookie(context, loginCookieName);
		let browserBindingSecret = getCookie(context, bindingCookieName);
		const isStart = context.req.path === '/oauth/auth/start';
		if (continuationId === undefined || browserBindingSecret === undefined) {
			if (!isStart) return context.text('Login context missing. Start again.', 409);
			const created = props.continuations.create({ kind: 'agents' });
			if (created.kind !== 'created')
				return context.text('Login capacity reached. Try again later.', 503);
			continuationId = created.continuationId;
			browserBindingSecret = created.browserBindingSecret;
			for (const [name, value] of [
				[loginCookieName, continuationId],
				[bindingCookieName, browserBindingSecret],
			]) {
				if (name === undefined || value === undefined)
					throw new Error('Missing login cookie identity.');
				setCookie(context, name, value, {
					httpOnly: true,
					secure: true,
					sameSite: 'Lax',
					path: loginCookiePath,
					maxAge: 600,
				});
			}
		}
		try {
			const verified = await props.verifier.verifyBootstrap(context.req.raw);
			if (verified.kind === 'redirect' || (verified.kind === 'signed-out' && isStart)) {
				if (!props.continuations.acceptRedirect({ continuationId, browserBindingSecret })) {
					clearLoginCookies(context);
					return context.text('Login expired or redirected too many times. Start again.', 409);
				}
				if (verified.kind === 'redirect') {
					for (const cookie of verified.setCookies)
						context.header('Set-Cookie', cookie, { append: true });
					return context.redirect(verified.location, 307);
				}
				return context.redirect(props.verifier.signInUrl(), 303);
			}
			if (verified.kind !== 'verified') {
				clearLoginCookies(context);
				return context.text(
					'Browser authentication could not be verified.',
					verified.kind === 'verification-unavailable' ? 503 : 403,
				);
			}
			const active = await props.verifier.verifySession(verified.identity);
			if (active.kind !== 'verified') {
				clearLoginCookies(context);
				return context.text(
					'Browser session is not available.',
					active.kind === 'verification-unavailable' ? 503 : 403,
				);
			}
			const consumed = props.continuations.consume({
				continuationId,
				browserBindingSecret,
				identity: active.identity,
			});
			clearLoginCookies(context);
			if (consumed.kind !== 'accepted')
				return context.text('Login context expired or already consumed.', 409);
			const cookies = await props.bindVerifiedContinuation({
				target: consumed.target,
				identity: consumed.identity,
			});
			if (cookies === undefined)
				return context.text('This account or agent is not available.', 403);
			for (const cookie of [...verified.setCookies, ...cookies])
				context.header('Set-Cookie', cookie, { append: true });
			return context.redirect(continuationDestination(consumed.target), 303);
		} catch {
			clearLoginCookies(context);
			return context.text('Browser authentication is unavailable. Start again.', 503);
		}
	};
	app.get('/oauth/auth/start', bootstrap);
	app.get('/oauth/auth/return', bootstrap);
	return app;
}
