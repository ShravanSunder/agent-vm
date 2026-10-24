import {
	releaseSignInResponse,
	type IssuedPersonSession,
	type SignInResponseReleasePorts,
} from '#auth/sign-in-core/response-release/sign-in-response-release';

/** S1 exposes provider sign-in and token flows; account administration waits for its audited slices. */
export function isPublicSignInRoute(pathname: string): boolean {
	return [
		'/sign-in', // Starts the owner browser authorization journey.
		'/owner-ready', // Resumes native CLI authorization after provider sign-in.
		'/api/auth/owner/bootstrap', // Audited cookie-only bootstrap uses the in-process provider API.
		'/api/auth/sign-in/social', // Starts configured Google/GitHub provider sign-in.
		'/api/auth/callback/google', // Receives the configured Google OAuth callback.
		'/api/auth/callback/github', // Receives the configured GitHub OAuth callback.
		'/api/auth/oauth2/authorize', // Issues the native owner CLI authorization code with S256.
		'/api/auth/oauth2/token', // Exchanges owner codes or authenticates registered agent clients.
		'/api/auth/oauth2/introspect', // Confirms current person/session status through the release fence.
		'/api/auth/jwks', // Publishes signing keys for audience-bound proof verification.
		'/api/auth/.well-known/oauth-authorization-server', // Publishes provider-base OAuth metadata.
		'/api/auth/.well-known/openid-configuration', // Publishes provider-base OIDC metadata.
		'/.well-known/oauth-authorization-server', // Publishes issuer-root OAuth metadata.
		'/.well-known/openid-configuration', // Publishes issuer-root OIDC metadata.
	].includes(pathname);
}

export async function handleSignInRequest(props: {
	readonly request: Request;
	readonly providerHandler: (request: Request) => Promise<Response>;
	readonly issuedSessions: readonly IssuedPersonSession[];
	readonly createdUserIds: readonly string[];
	readonly ports: SignInResponseReleasePorts;
	readonly beforeFinalCheck?: (response: Response) => Promise<void>;
}): Promise<Response> {
	const pathname = new URL(props.request.url).pathname;
	if (!isPublicSignInRoute(pathname)) return Response.json({ error: 'not-found' }, { status: 404 });
	let tokenGrant: 'client_credentials' | 'person' | 'introspection' | 'none' = 'none';
	if (pathname === '/api/auth/oauth2/introspect') tokenGrant = 'introspection';
	if (pathname === '/api/auth/oauth2/token' && props.request.method === 'POST') {
		const body = new URLSearchParams(await props.request.clone().text());
		tokenGrant = body.get('grant_type') === 'client_credentials' ? 'client_credentials' : 'person';
	}
	const response = await props.providerHandler(props.request);
	await props.beforeFinalCheck?.(response);
	return releaseSignInResponse({
		response,
		tokenGrant,
		issuedSessions: props.issuedSessions,
		createdUserIds: props.createdUserIds,
		ports: props.ports,
	});
}
