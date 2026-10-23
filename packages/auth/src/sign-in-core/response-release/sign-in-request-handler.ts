import {
	releaseSignInResponse,
	type IssuedPersonSession,
	type SignInResponseReleasePorts,
} from '#auth/sign-in-core/response-release/sign-in-response-release';

/** S1 exposes provider sign-in and token flows; account administration waits for its audited slices. */
export function isPublicSignInRoute(pathname: string): boolean {
	if (pathname.startsWith('/api/auth/admin/') || pathname.startsWith('/api/auth/passkey/'))
		return false;
	if (
		pathname.startsWith('/api/auth/oauth2/') &&
		![
			'/api/auth/oauth2/authorize',
			'/api/auth/oauth2/token',
			'/api/auth/oauth2/introspect',
		].includes(pathname)
	)
		return false;
	return ![
		'/api/auth/link-social',
		'/api/auth/unlink-account',
		'/api/auth/update-user',
		'/api/auth/delete-user',
		'/api/auth/delete-user/callback',
		'/api/auth/change-email',
		'/api/auth/change-password',
		'/api/auth/set-password',
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
