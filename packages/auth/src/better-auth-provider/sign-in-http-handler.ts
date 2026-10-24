import { decodeJwt, decodeProtectedHeader } from 'jose';

import {
	minimalOwnerPage,
	ownerAuthorizationResume,
} from '#auth/better-auth-provider/minimal-owner-pages';
import { bootstrapOwnerClient } from '#auth/better-auth-provider/owner-client-bootstrap';
import {
	createSignInProvider,
	type SignInProviderProps,
	type ProviderRequestState,
} from '#auth/better-auth-provider/provider-configuration';
import { createAgentRegistrationStore } from '#auth/d1-persistence/agent-registration-store';
import { createPersonAdmissionStore } from '#auth/d1-persistence/person-admission-store';
import {
	handleSignInRequest,
	isPublicSignInRoute,
} from '#auth/sign-in-core/response-release/sign-in-request-handler';
import {
	accessTokenReleaseClaimsSchema,
	type SignInResponseReleasePorts,
} from '#auth/sign-in-core/response-release/sign-in-response-release';

export type SignInHttpConfiguration = Omit<
	SignInProviderProps,
	'authority' | 'generatedClientId' | 'requestState' | 'tokenClientId'
>;

/** Real Better Auth HTTP always returns through the portable release fence. No raw person API is published. */
export function createSignInHttpHandler(
	configuration: SignInHttpConfiguration,
	controls: {
		readonly beforeFinalCheck?: (response: Response) => Promise<void>;
	} = {},
): (request: Request) => Promise<Response> {
	return async (request: Request): Promise<Response> => {
		const state: ProviderRequestState = { createdUserIds: [], issuedSessions: [] };
		const persons = createPersonAdmissionStore({
			database: configuration.database,
			ownerEmail: configuration.configuration.ownerEmail,
			now: configuration.now,
		});
		try {
			const url = new URL(request.url);
			if (!isPublicSignInRoute(url.pathname))
				return Response.json({ error: 'not-found' }, { status: 404 });
			if (request.method === 'GET' && ['/sign-in', '/owner-ready'].includes(url.pathname)) {
				const resumedAuthorization = new URL(
					'/api/auth/oauth2/authorize',
					configuration.configuration.issuer,
				);
				resumedAuthorization.search = url.search;
				return minimalOwnerPage({
					ready: url.pathname === '/owner-ready',
					configuration: configuration.configuration,
					resume: ownerAuthorizationResume(
						url.searchParams.get('authorize') ??
							(url.searchParams.has('client_id') ? resumedAuthorization.toString() : null),
						configuration.configuration,
					),
				});
			}
			await persons.seedOwnerEntry();
			const body =
				url.pathname === '/api/auth/oauth2/token'
					? new URLSearchParams(await request.clone().text())
					: undefined;
			const basic = request.headers.get('authorization')?.match(/^Basic ([^\s]+)$/iu)?.[1];
			const tokenClientId =
				body?.get('client_id') ?? (basic === undefined ? undefined : atob(basic).split(':')[0]);
			const providerProps = {
				...configuration,
				requestState: state,
				...(tokenClientId === null || tokenClientId === undefined ? {} : { tokenClientId }),
			};
			if (url.pathname === '/api/auth/owner/bootstrap')
				return bootstrapOwnerClient({ request, provider: providerProps });
			const provider = createSignInProvider({ ...providerProps, authority: { kind: 'public' } });
			const agents = createAgentRegistrationStore(configuration);
			const ports: SignInResponseReleasePorts = {
				issuer: configuration.configuration.issuer,
				agentAudience: configuration.configuration.agentAudience,
				managementAudience: configuration.configuration.managementAudience,
				accessTokenSeconds: configuration.configuration.accessTokenSeconds,
				now: configuration.now,
				inspectSignedToken: (token) => {
					if (decodeProtectedHeader(token).typ !== 'at+jwt')
						throw new Error('Wrong signed access token type');
					return accessTokenReleaseClaimsSchema.parse(decodeJwt(token));
				},
				readAgent: agents.read,
				isPersonSessionActive: persons.isPersonSessionActive,
				deleteSession: persons.deleteSession,
				cleanupUnboundPerson: persons.cleanupUnboundPerson,
			};
			const response = await handleSignInRequest({
				request,
				providerHandler: provider.handler,
				issuedSessions: state.issuedSessions,
				createdUserIds: state.createdUserIds,
				ports,
				...controls,
			});
			const method = /\/callback\/(google|github)$/u.exec(url.pathname)?.[1];
			if (method !== undefined) {
				const actor = state.issuedSessions[0]?.personId ?? 'anonymous';
				const outcome =
					response.headers.has('set-cookie') && state.issuedSessions.length > 0
						? 'succeeded'
						: 'failed';
				const requestId = crypto.randomUUID();
				await configuration.database
					.prepare(
						'INSERT INTO sign_in_audit (id, kind, actor_user_id, request_id, phase, change_kind, target_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
					)
					.bind(
						requestId,
						'sign-in',
						actor,
						requestId,
						'outcome',
						outcome,
						method,
						configuration.now(),
					)
					.run();
			}
			return response;
		} catch {
			await Promise.allSettled(
				state.issuedSessions.map((session) => persons.deleteSession(session.sessionId)),
			);
			await Promise.allSettled(
				state.createdUserIds.map((personId) => persons.cleanupUnboundPerson(personId)),
			);
			return Response.json(
				{ error: 'sign-in-unavailable' },
				{ status: 503, headers: { 'cache-control': 'no-store' } },
			);
		}
	};
}
