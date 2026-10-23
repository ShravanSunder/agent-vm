import { decodeJwt, decodeProtectedHeader } from 'jose';
import { z } from 'zod';

import { createSignInHttpHandler } from '#auth/better-auth-provider/sign-in-http-handler';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';
import { callAuthProofBarrier } from '#auth/test-fixtures/auth-proof-barrier-client';
import { handleAuthProofTokenRequest } from '#auth/test-fixtures/auth-proof-tokens';

/** Test-only controls hold after the actual Better Auth signing effect, before the production final D1 read. */
export async function handleAuthProofRequest(
	request: Request,
	bindings: AuthWorkerEnv,
): Promise<Response> {
	const negativeControl = await handleAuthProofTokenRequest(request, bindings);
	if (negativeControl !== null) return negativeControl;
	const url = new URL(request.url);

	return createSignInHttpHandler(signInWorkerConfiguration(bindings), {
		beforeFinalCheck: async (response): Promise<void> => {
			if (url.pathname !== '/api/auth/oauth2/token' || !response.ok) return;
			const body = z.object({ access_token: z.string() }).safeParse(await response.clone().json());
			if (!body.success || decodeProtectedHeader(body.data.access_token).typ !== 'at+jwt') return;
			const claims = z
				.object({ client_id: z.string(), organization_id: z.string().optional() })
				.parse(decodeJwt(body.data.access_token));
			await callAuthProofBarrier({
				bindings,
				channel: 'hold',
				operation: 'arrive',
				key: claims.client_id,
				event: {
					signed: true,
					clientId: claims.client_id,
					organizationId: claims.organization_id ?? null,
				},
			});
		},
	})(request);
}
