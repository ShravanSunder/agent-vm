import { createHash } from 'node:crypto';

import {
	oauthBrowserSessionIdentitySchema,
	type OAuthBrowserIdentityVerification,
	type OAuthBrowserSessionIdentity,
} from '@agent-vm/oauth-broker-contracts';
import { createClerkClient, verifyToken, type ClerkClient } from '@clerk/backend';
import { z } from 'zod';

export type ClerkBrowserBootstrapResult =
	| {
			readonly kind: 'verified';
			readonly identity: OAuthBrowserSessionIdentity;
			readonly setCookies: readonly string[];
	  }
	| { readonly kind: 'redirect'; readonly location: string; readonly setCookies: readonly string[] }
	| Exclude<OAuthBrowserIdentityVerification, { kind: 'verified' }>;

export interface ClerkBrowserIdentityVerifier {
	verifyBootstrap(request: Request): Promise<ClerkBrowserBootstrapResult>;
	verifyCurrentCookie(
		request: Request,
	): Promise<OAuthBrowserIdentityVerification | { readonly kind: 'not-current' }>;
	verifySession(identity: OAuthBrowserSessionIdentity): Promise<OAuthBrowserIdentityVerification>;
	revokeSession(
		identity: OAuthBrowserSessionIdentity,
	): Promise<{ readonly kind: 'revoked' | 'identity-mismatch' | 'verification-unavailable' }>;
	signInUrl(): string;
}

export interface CreateClerkBrowserIdentityVerifierProps {
	readonly verifySessionToken: (token: string) => Promise<unknown>;
	readonly sessionCookieNames: readonly string[];
	readonly client: Pick<ClerkClient, 'authenticateRequest'> & {
		readonly sessions: Pick<ClerkClient['sessions'], 'getSession' | 'revokeSession'>;
	};
	readonly issuer: string;
	readonly websiteOrigin: string;
	readonly hostedSignInUrl: string;
	readonly now?: () => number;
	readonly requestTimeoutMs?: number;
}

export interface ConfiguredClerkBrowserIdentityVerifierProps extends Omit<
	CreateClerkBrowserIdentityVerifierProps,
	'client' | 'verifySessionToken' | 'sessionCookieNames'
> {
	readonly publishableKey: string;
	readonly secretKey: string;
}

export function createConfiguredClerkBrowserIdentityVerifier(
	props: ConfiguredClerkBrowserIdentityVerifierProps,
): ClerkBrowserIdentityVerifier {
	return createClerkBrowserIdentityVerifier({
		...props,
		// Clerk shared 4.31.0 keys.getCookieSuffix: naming only, never an authentication hash.
		sessionCookieNames: [
			'__session',
			`__session_${createHash('sha1').update(props.publishableKey).digest('base64url').slice(0, 8)}`,
		],
		verifySessionToken: async (token) =>
			await verifyToken(token, {
				secretKey: props.secretKey,
				authorizedParties: [props.websiteOrigin],
				clockSkewInMs: 0,
			}),
		client: createClerkClient({
			publishableKey: props.publishableKey,
			secretKey: props.secretKey,
			telemetry: { disabled: true },
		}),
	});
}

const bootstrapPaths = new Set(['/oauth/auth/start', '/oauth/auth/return']);
// Only the SDK's handshake transport belongs on these code-free bootstrap URLs.
const bootstrapQueryKeys = new Set([
	'__clerk_handshake',
	'__clerk_handshake_nonce',
	'__clerk_synced',
	'__clerk_status',
	'__clerk_db_jwt',
	'__clerk_redirect_count',
]);
const sessionClaimsSchema = z.object({
	iss: z.string(),
	azp: z.string(),
	sub: z.string().min(1).max(256),
	sid: z.string().min(1).max(256),
	exp: z.number().int().positive(),
	iat: z.number().int().nonnegative(),
	nbf: z.number().int().nonnegative(),
	act: z.never().optional(),
	sts: z.literal('active').optional(),
});
const backendSessionSchema = z.object({
	id: z.string().min(1).max(256),
	userId: z.string().min(1).max(256),
	status: z.string(),
	expireAt: z.number().int().positive(),
	actor: z.null(),
});

function configuredHttpsUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
		throw new Error('Clerk browser configuration requires a fixed HTTPS URL.');
	}
	return url;
}

async function boundedClerkRequest<TResult>(
	operation: () => Promise<TResult>,
	timeoutMs: number,
): Promise<TResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(operation),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('Clerk verification timed out.')), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function sessionMatchesIdentity(
	session: z.infer<typeof backendSessionSchema>,
	identity: OAuthBrowserSessionIdentity,
): boolean {
	return session.id === identity.sessionId && session.userId === identity.userId;
}

export function createClerkBrowserIdentityVerifier(
	props: CreateClerkBrowserIdentityVerifierProps,
): ClerkBrowserIdentityVerifier {
	const website = configuredHttpsUrl(props.websiteOrigin);
	const clerkIssuer = configuredHttpsUrl(props.issuer);
	const signIn = configuredHttpsUrl(props.hostedSignInUrl);
	if (website.origin !== props.websiteOrigin || clerkIssuer.origin !== props.issuer) {
		throw new Error('Clerk website and issuer must be exact origins without paths.');
	}
	const fixedReturnUrl = new URL('/oauth/auth/return', website).toString();
	const now = props.now ?? Date.now;
	const requestTimeoutMs = props.requestTimeoutMs ?? 10_000;
	if (
		!Number.isSafeInteger(requestTimeoutMs) ||
		requestTimeoutMs < 1 ||
		requestTimeoutMs > 30_000
	) {
		throw new Error('Clerk verification timeout must be between 1 and 30000 milliseconds.');
	}
	const identityMatchesIssuer = (identity: OAuthBrowserSessionIdentity): boolean =>
		oauthBrowserSessionIdentitySchema.safeParse(identity).success &&
		identity.issuer === props.issuer;

	return {
		verifyCurrentCookie: async (request) => {
			const header = request.headers.get('cookie') ?? '';
			if (header.length > 32_768) return { kind: 'identity-mismatch' };
			const tokens = new Map<string, string>();
			for (const field of header.split(';')) {
				const separator = field.indexOf('=');
				if (separator === -1) continue;
				const name = field.slice(0, separator).trim();
				if (!props.sessionCookieNames.includes(name)) continue;
				if (tokens.has(name)) return { kind: 'identity-mismatch' };
				tokens.set(name, field.slice(separator + 1).trim());
			}
			let identity: OAuthBrowserSessionIdentity | undefined;
			for (const token of tokens.values()) {
				if (token === '') continue;
				try {
					// oxlint-disable-next-line no-await-in-loop -- at most two configured cookie spellings; neither carries a callback URL or redirects.
					const claims = sessionClaimsSchema.safeParse(
						await boundedClerkRequest(() => props.verifySessionToken(token), requestTimeoutMs),
					);
					if (
						!claims.success ||
						claims.data.iss !== props.issuer ||
						claims.data.azp !== website.origin ||
						claims.data.exp * 1000 <= now() ||
						claims.data.iat * 1000 > now() ||
						claims.data.nbf * 1000 > now()
					)
						return { kind: 'identity-mismatch' };
					const current = {
						issuer: claims.data.iss,
						userId: claims.data.sub,
						sessionId: claims.data.sid,
					};
					if (
						identity !== undefined &&
						(identity.userId !== current.userId || identity.sessionId !== current.sessionId)
					)
						return { kind: 'identity-mismatch' };
					identity = current;
				} catch (error) {
					// A rejected token contributes no identity. A separate live BAPI lookup is still mandatory.
					if (
						!(
							typeof error === 'object' &&
							error !== null &&
							'reason' in error &&
							typeof error.reason === 'string' &&
							error.reason.startsWith('token-')
						)
					)
						return { kind: 'verification-unavailable' };
				}
			}
			return identity === undefined ? { kind: 'not-current' } : { kind: 'verified', identity };
		},
		verifyBootstrap: async (request) => {
			const incomingUrl = new URL(request.url);
			if (
				request.method !== 'GET' ||
				!bootstrapPaths.has(incomingUrl.pathname) ||
				[...incomingUrl.searchParams.keys()].some((key) => !bootstrapQueryKeys.has(key)) ||
				incomingUrl.search.length > 16_384
			) {
				return { kind: 'identity-mismatch' };
			}
			const trustedUrl = new URL(incomingUrl.pathname, website);
			trustedUrl.search = incomingUrl.search;
			const headers = new Headers();
			for (const name of [
				'cookie',
				'authorization',
				'accept',
				'sec-fetch-dest',
				'sec-fetch-mode',
			]) {
				const value = request.headers.get(name);
				if (value !== null) headers.set(name, value);
			}
			try {
				const state = await boundedClerkRequest(
					() =>
						props.client.authenticateRequest(new Request(trustedUrl, { headers }), {
							acceptsToken: 'session_token',
							authorizedParties: [website.origin],
							clockSkewInMs: 0,
						}),
					requestTimeoutMs,
				);
				if (state.tokenType !== 'session_token') return { kind: 'identity-mismatch' };
				if (state.status === 'handshake') {
					const location = state.headers.get('location');
					if (location === null) return { kind: 'verification-unavailable' };
					const destination = new URL(location);
					if (
						destination.protocol !== 'https:' ||
						destination.username ||
						destination.password ||
						destination.hash ||
						(destination.origin !== clerkIssuer.origin &&
							destination.origin !== signIn.origin &&
							destination.toString() !== fixedReturnUrl)
					) {
						return { kind: 'identity-mismatch' };
					}
					return {
						kind: 'redirect',
						location: destination.toString(),
						setCookies: state.headers.getSetCookie(),
					};
				}
				if (state.status === 'signed-out') return { kind: 'signed-out' };
				const auth = state.toAuth();
				const claims = sessionClaimsSchema.safeParse(auth.sessionClaims);
				if (
					!claims.success ||
					claims.data.iss !== props.issuer ||
					claims.data.azp !== website.origin ||
					claims.data.sub !== auth.userId ||
					claims.data.sid !== auth.sessionId ||
					auth.actor !== undefined ||
					claims.data.exp * 1000 <= now() ||
					claims.data.iat * 1000 > now() ||
					claims.data.nbf * 1000 > now()
				) {
					return { kind: 'identity-mismatch' };
				}
				return {
					kind: 'verified',
					identity: { issuer: props.issuer, userId: claims.data.sub, sessionId: claims.data.sid },
					setCookies: state.headers.getSetCookie(),
				};
			} catch {
				return { kind: 'verification-unavailable' };
			}
		},
		verifySession: async (identity) => {
			if (!identityMatchesIssuer(identity)) return { kind: 'identity-mismatch' };
			try {
				const session = backendSessionSchema.safeParse(
					await boundedClerkRequest(
						() => props.client.sessions.getSession(identity.sessionId),
						requestTimeoutMs,
					),
				);
				if (!session.success) return { kind: 'identity-mismatch' };
				if (!sessionMatchesIdentity(session.data, identity)) return { kind: 'identity-mismatch' };
				if (session.data.status !== 'active' || session.data.expireAt <= now())
					return { kind: 'signed-out' };
				return { kind: 'verified', identity: oauthBrowserSessionIdentitySchema.parse(identity) };
			} catch {
				return { kind: 'verification-unavailable' };
			}
		},
		revokeSession: async (identity) => {
			if (!identityMatchesIssuer(identity)) return { kind: 'identity-mismatch' };
			try {
				const session = backendSessionSchema.safeParse(
					await boundedClerkRequest(
						() => props.client.sessions.revokeSession(identity.sessionId),
						requestTimeoutMs,
					),
				);
				if (!session.success || !sessionMatchesIdentity(session.data, identity))
					return { kind: 'identity-mismatch' };
				return { kind: session.data.status === 'revoked' ? 'revoked' : 'verification-unavailable' };
			} catch {
				return { kind: 'verification-unavailable' };
			}
		},
		signInUrl: () => {
			const target = new URL(signIn);
			target.searchParams.set('redirect_url', fixedReturnUrl);
			return target.toString();
		},
	};
}
