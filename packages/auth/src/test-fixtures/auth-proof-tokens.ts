import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { signJWT } from 'better-auth/plugins/jwt';
import { z } from 'zod';

import { createSignInProvider } from '#auth/better-auth-provider/provider-configuration';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';

/** Negative controls only: authentic issuer keys sign a deliberately invalid Person or legacy Agent profile. */
export async function handleAuthProofTokenRequest(
	request: Request,
	bindings: AuthWorkerEnv,
): Promise<Response | null> {
	const pathname = new URL(request.url).pathname;
	if (
		![
			'/api/auth/__proof/without-sid',
			'/api/auth/__proof/legacy-agent',
			'/__auth-proof/no-hook',
		].includes(pathname)
	)
		return null;
	const provider = signInWorkerConfiguration(bindings);
	const auth = createSignInProvider({
		...provider,
		authority: { kind: 'public' },
		requestState: { createdUserIds: [], issuedSessions: [] },
	});
	if (pathname === '/__auth-proof/no-hook') {
		try {
			await auth.api.adminCreateOAuthClient({
				headers: new Headers(),
				body: {
					client_name: 'no-hook-upgrade-guard',
					grant_types: ['client_credentials'],
					client_credentials_scopes: ['tool-portal:agent'],
					token_endpoint_auth_method: 'client_secret_basic',
					metadata: { kind: 'agent', organizationId: provider.configuration.organizationIds[0] },
				},
			});
			return Response.json({ refused: false });
		} catch (error) {
			if (error instanceof APIError && (error.statusCode === 401 || error.statusCode === 403))
				return Response.json({ refused: true });
			throw error;
		}
	}
	return betterAuth({
		...auth.options,
		plugins: [
			...auth.options.plugins,
			{
				id: 'negative-person-profile-proof',
				endpoints: {
					legacyAgent: createAuthEndpoint(
						'/__proof/legacy-agent',
						{
							method: 'POST',
							body: z.strictObject({ clientId: z.string().min(1), organizationId: z.uuid() }),
						},
						async (context) => {
							const now = Math.floor(provider.now() / 1000);
							const token = await signJWT(context, {
								options: {
									jwt: { issuer: provider.configuration.issuer },
									jwks: { keyPairConfig: { alg: 'EdDSA' } },
								},
								header: { typ: 'at+jwt' },
								payload: {
									iss: provider.configuration.issuer,
									sub: context.body.clientId,
									aud: `${provider.configuration.toolPortalOrigin}/mcp`,
									iat: now,
									exp: now + 300,
									client_id: context.body.clientId,
									azp: context.body.clientId,
									organization_id: context.body.organizationId,
									scope: 'tool-portal:agent',
									jti: crypto.randomUUID(),
								},
							});
							return context.json({ token });
						},
					),
					withoutPersonSid: createAuthEndpoint(
						'/__proof/without-sid',
						{
							method: 'POST',
							body: z.strictObject({ subject: z.string().min(1), clientId: z.string().min(1) }),
						},
						async (context) => {
							const now = Math.floor(provider.now() / 1000);
							const token = await signJWT(context, {
								options: {
									jwt: { issuer: provider.configuration.issuer },
									jwks: { keyPairConfig: { alg: 'EdDSA' } },
								},
								header: { typ: 'at+jwt' },
								payload: {
									iss: provider.configuration.issuer,
									sub: context.body.subject,
									aud: provider.configuration.managementAudience,
									iat: now,
									exp: now + 300,
									client_id: context.body.clientId,
									azp: context.body.clientId,
									scope: 'tool-portal:management',
									jti: crypto.randomUUID(),
								},
							});
							return context.json({ token });
						},
					),
				},
			},
		],
	}).handler(request);
}
