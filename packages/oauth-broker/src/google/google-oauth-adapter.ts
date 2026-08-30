import {
	oauthScopeSchema,
	oauthTokenLifecycleSchema,
	type OAuthScope,
	type OAuthTokenLifecycle,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

const googleAuthorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
const googleTokenEndpoint = 'https://oauth2.googleapis.com/token';
const googleUserInfoEndpoint = 'https://openidconnect.googleapis.com/v1/userinfo';
const googleRevocationEndpoint = 'https://oauth2.googleapis.com/revoke';

export const googleIdentityScopes = [
	oauthScopeSchema.parse('email'),
	oauthScopeSchema.parse('openid'),
] as const;

export const googleWebClientCredentialsSchema = z
	.object({
		web: z
			.object({
				auth_provider_x509_cert_url: z.url().optional(),
				auth_uri: z.literal(googleAuthorizationEndpoint),
				client_id: z.string().min(1).max(1_024),
				client_secret: z.string().min(1).max(4_096),
				javascript_origins: z.array(z.url()).optional(),
				project_id: z.string().min(1).max(1_024).optional(),
				redirect_uris: z.array(z.url()).min(1),
				token_uri: z.literal(googleTokenEndpoint),
			})
			.strict(),
	})
	.strict();
export type GoogleWebClientCredentials = z.infer<typeof googleWebClientCredentialsSchema>;

const googleTokenSuccessResponseSchema = z
	.object({
		access_token: z.string().min(1),
		expires_in: z.number().int().positive(),
		id_token: z.string().min(1).optional(),
		refresh_token: z.string().min(1).optional(),
		scope: z.string().min(1).optional(),
		token_type: z.literal('Bearer'),
	})
	.strict();

const googleOAuthErrorResponseSchema = z
	.object({
		error: z.string().min(1),
		error_description: z.string().optional(),
		error_subtype: z.string().optional(),
		error_uri: z.url().optional(),
	})
	.strict();

const googleUserInfoResponseSchema = z
	.object({
		email: z.email(),
		email_verified: z.boolean(),
		family_name: z.string().optional(),
		given_name: z.string().optional(),
		hd: z.string().optional(),
		locale: z.string().optional(),
		name: z.string().optional(),
		picture: z.url().optional(),
		sub: z.string().min(1).max(1_024),
	})
	.strict();

export const googleProviderAuthorizationSchema = z
	.object({
		accessToken: z.string().min(1),
		accessTokenExpiresAtMs: z.number().int().positive(),
		accountEmail: z.email(),
		accountSubject: z.string().min(1).max(1_024),
		grantedScopes: z.array(oauthScopeSchema).min(1).readonly(),
		kind: z.literal('google-provider-authorization'),
		refreshToken: z.string().min(1),
	})
	.strict();
export type GoogleProviderAuthorization = z.infer<typeof googleProviderAuthorizationSchema>;

export const googleProviderRefreshSuccessSchema = z
	.object({
		accessToken: z.string().min(1),
		accessTokenExpiresAtMs: z.number().int().positive(),
		grantedScopes: z.array(oauthScopeSchema).min(1).readonly(),
		kind: z.literal('refreshed'),
		replacementRefreshToken: z.string().min(1).optional(),
	})
	.strict();
export type GoogleProviderRefreshSuccess = z.infer<typeof googleProviderRefreshSuccessSchema>;

export const googleProviderFailureSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('invalid-grant') }).strict(),
	z
		.object({
			kind: z.literal('provider-rejected'),
			providerError: z.string().min(1).max(128),
		})
		.strict(),
	z.object({ kind: z.literal('provider-unavailable'), retryable: z.literal(true) }).strict(),
	z.object({ kind: z.literal('scope-response-missing') }).strict(),
	z.object({ kind: z.literal('unverified-email') }).strict(),
]);
export type GoogleProviderFailure = z.infer<typeof googleProviderFailureSchema>;

export type GoogleAuthorizationCodeExchangeResult =
	| { readonly authorization: GoogleProviderAuthorization; readonly kind: 'authorized' }
	| { readonly failure: GoogleProviderFailure; readonly kind: 'failed' };

export type GoogleRefreshResult =
	| GoogleProviderRefreshSuccess
	| { readonly failure: GoogleProviderFailure; readonly kind: 'failed' };

export type GoogleRevokeResult =
	| { readonly kind: 'revoked' }
	| { readonly failure: GoogleProviderFailure; readonly kind: 'failed' };

export interface GoogleOAuthAdapter {
	readonly tokenLifecycle: OAuthTokenLifecycle;
	buildAuthorizationUrl(props: {
		readonly clientCredentials: GoogleWebClientCredentials;
		readonly pkceChallenge: string;
		readonly redirectUri: string;
		readonly requestedScopes: readonly OAuthScope[];
		readonly state: string;
	}): string;
	exchangeAuthorizationCode(props: {
		readonly authorizationCode: string;
		readonly clientCredentials: GoogleWebClientCredentials;
		readonly pkceVerifier: string;
		readonly redirectUri: string;
	}): Promise<GoogleAuthorizationCodeExchangeResult>;
	refreshAuthorization(props: {
		readonly clientCredentials: GoogleWebClientCredentials;
		readonly currentGrantedScopes: readonly OAuthScope[];
		readonly refreshToken: string;
	}): Promise<GoogleRefreshResult>;
	revokeAuthorization(props: { readonly refreshToken: string }): Promise<GoogleRevokeResult>;
}

function parseScopeField(scopeField: string): readonly OAuthScope[] {
	const scopes = scopeField
		.split(/\s+/u)
		.map((scope) => scope.trim())
		.filter((scope) => scope.length > 0)
		.map((scope) => oauthScopeSchema.parse(scope));
	return z
		.array(oauthScopeSchema)
		.min(1)
		.readonly()
		.parse([...new Set(scopes)].toSorted());
}

function withIdentityScopes(requestedScopes: readonly OAuthScope[]): readonly OAuthScope[] {
	return [...new Set([...requestedScopes, ...googleIdentityScopes])].toSorted();
}

function assertRegisteredRedirect(
	clientCredentials: GoogleWebClientCredentials,
	redirectUri: string,
): string {
	const parsedCredentials = googleWebClientCredentialsSchema.parse(clientCredentials);
	const parsedRedirectUri = z.url().parse(redirectUri);
	if (!parsedCredentials.web.redirect_uris.includes(parsedRedirectUri)) {
		throw new Error('Google Web client does not register the configured OAuth redirect URI.');
	}
	return parsedRedirectUri;
}

async function parseResponseJson(response: Response): Promise<unknown> {
	return (await response.json()) as unknown;
}

function classifyProviderFailure(props: {
	readonly responseBody: unknown;
	readonly retryableStatus: boolean;
}): GoogleProviderFailure {
	const parsedError = googleOAuthErrorResponseSchema.safeParse(props.responseBody);
	if (parsedError.success && parsedError.data.error === 'invalid_grant') {
		return { kind: 'invalid-grant' };
	}
	if (props.retryableStatus) return { kind: 'provider-unavailable', retryable: true };
	return {
		kind: 'provider-rejected',
		providerError: parsedError.success ? parsedError.data.error : 'invalid-provider-response',
	};
}

export function parseGoogleWebClientCredentials(props: {
	readonly expectedRedirectUri: string;
	readonly rawClientCredentials: string;
}): GoogleWebClientCredentials {
	const parsedJson = JSON.parse(props.rawClientCredentials) as unknown;
	const credentials = googleWebClientCredentialsSchema.parse(parsedJson);
	assertRegisteredRedirect(credentials, props.expectedRedirectUri);
	return credentials;
}

export function createGoogleOAuthAdapter(
	props: {
		readonly fetchImpl?: typeof fetch;
		readonly now?: () => number;
	} = {},
): GoogleOAuthAdapter {
	const fetchImpl = props.fetchImpl ?? fetch;
	const now = props.now ?? Date.now;
	return {
		buildAuthorizationUrl: (authorizationProps) => {
			const credentials = googleWebClientCredentialsSchema.parse(
				authorizationProps.clientCredentials,
			);
			const redirectUri = assertRegisteredRedirect(credentials, authorizationProps.redirectUri);
			const authorizationUrl = new URL(googleAuthorizationEndpoint);
			authorizationUrl.search = new URLSearchParams({
				access_type: 'offline',
				client_id: credentials.web.client_id,
				code_challenge: z.string().min(43).max(128).parse(authorizationProps.pkceChallenge),
				code_challenge_method: 'S256',
				include_granted_scopes: 'true',
				prompt: 'consent',
				redirect_uri: redirectUri,
				response_type: 'code',
				scope: withIdentityScopes(authorizationProps.requestedScopes).join(' '),
				state: z.string().min(32).max(256).parse(authorizationProps.state),
			}).toString();
			return authorizationUrl.toString();
		},
		exchangeAuthorizationCode: async (exchangeProps) => {
			const credentials = googleWebClientCredentialsSchema.parse(exchangeProps.clientCredentials);
			const redirectUri = assertRegisteredRedirect(credentials, exchangeProps.redirectUri);
			let tokenResponse: Response;
			try {
				tokenResponse = await fetchImpl(googleTokenEndpoint, {
					body: new URLSearchParams({
						client_id: credentials.web.client_id,
						client_secret: credentials.web.client_secret,
						code: z.string().min(1).max(8_192).parse(exchangeProps.authorizationCode),
						code_verifier: z.string().min(43).max(128).parse(exchangeProps.pkceVerifier),
						grant_type: 'authorization_code',
						redirect_uri: redirectUri,
					}),
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					method: 'POST',
				});
			} catch {
				return {
					failure: { kind: 'provider-unavailable', retryable: true },
					kind: 'failed',
				};
			}
			const tokenBody = await parseResponseJson(tokenResponse).catch(() => undefined);
			if (!tokenResponse.ok) {
				return {
					failure: classifyProviderFailure({
						responseBody: tokenBody,
						retryableStatus: tokenResponse.status >= 500 || tokenResponse.status === 429,
					}),
					kind: 'failed',
				};
			}
			const parsedToken = googleTokenSuccessResponseSchema.safeParse(tokenBody);
			if (!parsedToken.success || parsedToken.data.scope === undefined) {
				return { failure: { kind: 'scope-response-missing' }, kind: 'failed' };
			}
			if (parsedToken.data.refresh_token === undefined) {
				return {
					failure: { kind: 'provider-rejected', providerError: 'refresh-token-missing' },
					kind: 'failed',
				};
			}
			const grantedScopes = parseScopeField(parsedToken.data.scope);
			if (!googleIdentityScopes.every((scope) => grantedScopes.includes(scope))) {
				return { failure: { kind: 'scope-response-missing' }, kind: 'failed' };
			}
			let userInfoResponse: Response;
			try {
				userInfoResponse = await fetchImpl(googleUserInfoEndpoint, {
					headers: { authorization: `Bearer ${parsedToken.data.access_token}` },
				});
			} catch {
				return {
					failure: { kind: 'provider-unavailable', retryable: true },
					kind: 'failed',
				};
			}
			const userInfoBody = await parseResponseJson(userInfoResponse).catch(() => undefined);
			if (!userInfoResponse.ok) {
				return {
					failure: classifyProviderFailure({
						responseBody: userInfoBody,
						retryableStatus: userInfoResponse.status >= 500 || userInfoResponse.status === 429,
					}),
					kind: 'failed',
				};
			}
			const userInfo = googleUserInfoResponseSchema.safeParse(userInfoBody);
			if (!userInfo.success) {
				return {
					failure: { kind: 'provider-rejected', providerError: 'invalid-userinfo-response' },
					kind: 'failed',
				};
			}
			if (!userInfo.data.email_verified) {
				return { failure: { kind: 'unverified-email' }, kind: 'failed' };
			}
			return {
				authorization: googleProviderAuthorizationSchema.parse({
					accessToken: parsedToken.data.access_token,
					accessTokenExpiresAtMs: now() + parsedToken.data.expires_in * 1_000,
					accountEmail: userInfo.data.email,
					accountSubject: userInfo.data.sub,
					grantedScopes,
					kind: 'google-provider-authorization',
					refreshToken: parsedToken.data.refresh_token,
				}),
				kind: 'authorized',
			};
		},
		refreshAuthorization: async (refreshProps) => {
			const credentials = googleWebClientCredentialsSchema.parse(refreshProps.clientCredentials);
			let response: Response;
			try {
				response = await fetchImpl(googleTokenEndpoint, {
					body: new URLSearchParams({
						client_id: credentials.web.client_id,
						client_secret: credentials.web.client_secret,
						grant_type: 'refresh_token',
						refresh_token: z.string().min(1).parse(refreshProps.refreshToken),
					}),
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					method: 'POST',
				});
			} catch {
				return {
					failure: { kind: 'provider-unavailable', retryable: true },
					kind: 'failed',
				};
			}
			const responseBody = await parseResponseJson(response).catch(() => undefined);
			if (!response.ok) {
				return {
					failure: classifyProviderFailure({
						responseBody,
						retryableStatus: response.status >= 500 || response.status === 429,
					}),
					kind: 'failed',
				};
			}
			const token = googleTokenSuccessResponseSchema.safeParse(responseBody);
			if (!token.success) {
				return {
					failure: { kind: 'provider-rejected', providerError: 'invalid-token-response' },
					kind: 'failed',
				};
			}
			return googleProviderRefreshSuccessSchema.parse({
				accessToken: token.data.access_token,
				accessTokenExpiresAtMs: now() + token.data.expires_in * 1_000,
				grantedScopes:
					token.data.scope === undefined
						? refreshProps.currentGrantedScopes
						: parseScopeField(token.data.scope),
				kind: 'refreshed',
				...(token.data.refresh_token === undefined
					? {}
					: { replacementRefreshToken: token.data.refresh_token }),
			});
		},
		revokeAuthorization: async ({ refreshToken }) => {
			let response: Response;
			try {
				response = await fetchImpl(googleRevocationEndpoint, {
					body: new URLSearchParams({ token: z.string().min(1).parse(refreshToken) }),
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					method: 'POST',
				});
			} catch {
				return {
					failure: { kind: 'provider-unavailable', retryable: true },
					kind: 'failed',
				};
			}
			if (response.ok) return { kind: 'revoked' };
			const responseBody = await parseResponseJson(response).catch(() => undefined);
			return {
				failure: classifyProviderFailure({
					responseBody,
					retryableStatus: response.status >= 500 || response.status === 429,
				}),
				kind: 'failed',
			};
		},
		tokenLifecycle: oauthTokenLifecycleSchema.parse({
			kind: 'refreshable',
			refreshMode: 'stable-refresh-token',
		}),
	};
}
