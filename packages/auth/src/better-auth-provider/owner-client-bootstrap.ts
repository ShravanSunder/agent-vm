import { betterAuth } from 'better-auth';
import {
	createAuthEndpoint,
	originCheckMiddleware,
	formCsrfMiddleware,
	sessionMiddleware,
} from 'better-auth/api';
import { z } from 'zod';

import {
	createSignInProvider,
	type SignInProviderProps,
	type SignInProvider,
} from '#auth/better-auth-provider/provider-configuration';
import { createPersonAdmissionStore } from '#auth/d1-persistence/person-admission-store';

interface OwnerBootstrapProps {
	readonly request: Request;
	readonly provider: Omit<SignInProviderProps, 'authority' | 'generatedClientId'>;
}

async function completeOwnerClient(
	props: OwnerBootstrapProps & { readonly auth: SignInProvider },
): Promise<Response> {
	const { configuration, database, now } = props.provider;
	if (
		props.request.method !== 'POST' ||
		props.request.headers.has('authorization') ||
		props.request.headers.get('origin') !== new URL(configuration.issuer).origin
	)
		return Response.json({ error: 'not-allowed' }, { status: 403 });
	const auth = props.auth;
	const current = await auth.api.getSession({
		headers: props.request.headers,
		query: { disableCookieCache: true },
	});
	const persons = createPersonAdmissionStore({
		database,
		ownerEmail: configuration.ownerEmail,
		now,
	});
	if (
		current === null ||
		(await persons.readOwnerSession(current.user.id, current.session.id)) === null
	)
		return Response.json({ error: 'not-allowed' }, { status: 403 });
	const clientId = configuration.ownerCliClientId;
	const actorUserId = current.user.id;
	const requestId = `owner-cli:${clientId}`;
	async function record(phase: 'intent' | 'outcome'): Promise<void> {
		await database
			.prepare(
				'INSERT OR IGNORE INTO sign_in_audit (id, kind, actor_user_id, request_id, phase, change_kind, target_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
			)
			.bind(
				`${requestId}:${phase}`,
				'client-changed',
				actorUserId,
				requestId,
				phase,
				'registered',
				clientId,
				now(),
			)
			.run();
	}
	try {
		await record('intent');
		const existing = await database
			.withSession('first-primary')
			.prepare('SELECT clientId FROM oauthClient WHERE clientId = ?')
			.bind(clientId)
			.first();
		if (existing === null) {
			await auth.api.adminCreateOAuthClient({
				headers: props.request.headers,
				body: {
					client_name: 'Owner management CLI',
					token_endpoint_auth_method: 'none',
					application_type: 'native',
					redirect_uris: [configuration.ownerCliRedirectUri],
					grant_types: ['authorization_code'],
					response_types: ['code'],
					require_pkce: true,
					subject_type: 'public',
					scope: 'tool-portal:management',
					skip_consent: true,
				},
			});
		}
		await auth.api.adminLinkClientResource({
			headers: props.request.headers,
			params: { identifier: configuration.managementAudience, client_id: clientId },
		});
		await record('outcome');
		const read = database.withSession('first-primary');
		const client = await read
			.prepare(
				'SELECT clientId, tokenEndpointAuthMethod, applicationType, grantTypes, redirectUris, requirePKCE FROM oauthClient WHERE clientId = ?',
			)
			.bind(clientId)
			.first();
		const parsed = z
			.object({
				clientId: z.literal(clientId),
				tokenEndpointAuthMethod: z.literal('none'),
				applicationType: z.literal('native'),
				grantTypes: z.string(),
				redirectUris: z.string(),
				requirePKCE: z.union([z.literal(1), z.literal(true)]),
			})
			.parse(client);
		if (
			JSON.stringify(JSON.parse(parsed.grantTypes)) !== JSON.stringify(['authorization_code']) ||
			JSON.stringify(JSON.parse(parsed.redirectUris)) !==
				JSON.stringify([configuration.ownerCliRedirectUri])
		)
			throw new Error('Fixed owner client metadata differs from configuration');
		const link = await database
			.withSession('first-primary')
			.prepare('SELECT resourceId FROM oauthClientResource WHERE clientId = ?')
			.bind(clientId)
			.all();
		if (
			link.results.length !== 1 ||
			z.object({ resourceId: z.string() }).parse(link.results[0]).resourceId !==
				configuration.managementAudience
		)
			throw new Error('Owner CLI resource link incomplete');
		const records = await database
			.withSession('first-primary')
			.prepare('SELECT id FROM sign_in_audit WHERE request_id = ? AND actor_user_id = ?')
			.bind(requestId, current.user.id)
			.all();
		if (records.results.length !== 2) throw new Error('Owner CLI audit readback incomplete');
		return Response.json(
			{ kind: 'complete', clientId },
			{ headers: { 'cache-control': 'no-store' } },
		);
	} catch {
		return Response.json({ kind: 'incomplete' }, { status: 503 });
	}
}

/** Normal Better Auth HTTP middleware enforces origin, CSRF and the genuine owner session. */
export async function bootstrapOwnerClient(props: OwnerBootstrapProps): Promise<Response> {
	if (props.request.headers.has('authorization'))
		return Response.json({ error: 'not-allowed' }, { status: 403 });
	const auth = createSignInProvider({
		...props.provider,
		authority: { kind: 'owner-bootstrap' },
		generatedClientId: props.provider.configuration.ownerCliClientId,
	});
	const guarded = betterAuth({
		...auth.options,
		plugins: [
			...auth.options.plugins,
			{
				id: 'fixed-owner-cli-bootstrap',
				endpoints: {
					bootstrapOwnerCli: createAuthEndpoint(
						'/owner/bootstrap',
						{
							method: 'POST',
							body: z.strictObject({}),
							use: [originCheckMiddleware, formCsrfMiddleware, sessionMiddleware],
						},
						async () => completeOwnerClient({ ...props, auth }),
					),
				},
			},
		],
	});
	return guarded.handler(props.request);
}
