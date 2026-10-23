import { decodeJwt, decodeProtectedHeader } from 'jose';
import { z } from 'zod';

import { createSignInHttpHandler } from '#auth/better-auth-provider/sign-in-http-handler';
import { signInWorkerConfiguration } from '#auth/cloudflare-host/worker-configuration';
import { handleAuthProofTokenRequest } from '#auth/test-fixtures/auth-proof-tokens';

interface SigningHold {
	readonly entered: PromiseWithResolvers<{
		readonly clientId: string;
		readonly organizationId: string | null;
	}>;
	readonly release: PromiseWithResolvers<void>;
}
const holds = new Map<string, SigningHold>();

/** Test-only controls hold after the actual Better Auth signing effect, before the production final D1 read. */
export async function handleAuthProofRequest(
	request: Request,
	bindings: AuthWorkerEnv,
): Promise<Response> {
	const negativeControl = await handleAuthProofTokenRequest(request, bindings);
	if (negativeControl !== null) return negativeControl;
	const url = new URL(request.url);
	if (url.pathname.startsWith('/__auth-proof/hold/')) {
		const clientId = z.string().min(1).parse(url.searchParams.get('client'));
		if (url.pathname === '/__auth-proof/hold/arm' && request.method === 'POST') {
			if (holds.has(clientId)) return Response.json({ error: 'already-armed' }, { status: 409 });
			holds.set(clientId, {
				entered: Promise.withResolvers<{
					readonly clientId: string;
					readonly organizationId: string | null;
				}>(),
				release: Promise.withResolvers<void>(),
			});
			return Response.json({ armed: true });
		}
		const hold = holds.get(clientId);
		if (hold === undefined) return Response.json({ error: 'not-armed' }, { status: 404 });
		if (url.pathname === '/__auth-proof/hold/entered') {
			const claims = await hold.entered.promise;
			return Response.json({ signed: true, ...claims });
		}
		if (url.pathname === '/__auth-proof/hold/release' && request.method === 'POST') {
			hold.release.resolve();
			holds.delete(clientId);
			return Response.json({ released: true });
		}
		return Response.json({ error: 'invalid-control' }, { status: 400 });
	}
	return createSignInHttpHandler(signInWorkerConfiguration(bindings), {
		beforeFinalCheck: async (response): Promise<void> => {
			if (url.pathname !== '/api/auth/oauth2/token' || !response.ok) return;
			const body = z.object({ access_token: z.string() }).safeParse(await response.clone().json());
			if (!body.success || decodeProtectedHeader(body.data.access_token).typ !== 'at+jwt') return;
			const claims = z
				.object({ client_id: z.string(), organization_id: z.string().optional() })
				.parse(decodeJwt(body.data.access_token));
			const hold = holds.get(claims.client_id);
			if (hold === undefined) return;
			hold.entered.resolve({
				clientId: claims.client_id,
				organizationId: claims.organization_id ?? null,
			});
			await hold.release.promise;
		},
	})(request);
}
