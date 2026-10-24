import type { PersonProof } from '@agent-collaboration/tool-access/contracts';
import { oauthProvider } from '@better-auth/oauth-provider';
import { passkey } from '@better-auth/passkey';
import { betterAuth, type Auth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { jwt } from 'better-auth/plugins/jwt';

import { createAgentRegistrationStore } from '#auth/d1-persistence/agent-registration-store';
import { createPersonAdmissionStore } from '#auth/d1-persistence/person-admission-store';
import { createWorkspaceResourceStore } from '#auth/d1-persistence/workspace-resource-store';
import { agentRegistrationMetadataSchema } from '#auth/sign-in-core/agent-clients/agent-registration';
import { workspaceResourceHasIssuancePolicy } from '#auth/sign-in-core/agent-clients/workspace-resource';
import type { SignInConfiguration } from '#auth/sign-in-core/models/deployment-configuration';
import type { IssuedPersonSession } from '#auth/sign-in-core/response-release/sign-in-response-release';

export type ProviderAuthority =
	| { readonly kind: 'public' }
	| { readonly kind: 'person-proof'; readonly proof: PersonProof }
	| { readonly kind: 'owner-bootstrap' };

export interface ProviderRequestState {
	readonly createdUserIds: string[];
	readonly issuedSessions: IssuedPersonSession[];
}

export interface SignInProviderProps {
	readonly database: AuthWorkerEnv['DB'];
	readonly configuration: SignInConfiguration;
	readonly secret: string;
	readonly google: { readonly clientId: string; readonly clientSecret: string };
	readonly github: { readonly clientId: string; readonly clientSecret: string };
	readonly authority: ProviderAuthority;
	readonly requestState: ProviderRequestState;
	readonly tokenClientId?: string;
	readonly generatedClientId?: string;
	readonly now: () => number;
}

type SignInProviderOptions = BetterAuthOptions & {
	plugins: [ReturnType<typeof jwt>, ReturnType<typeof oauthProvider>, ReturnType<typeof passkey>];
};
export type SignInProvider = Auth<SignInProviderOptions>;

export interface ManagementObservation {
	readonly point: 'before-provider-owner-read';
	readonly requestId: string;
}
export type ManagementObserver = (event: ManagementObservation) => Promise<void>;

/** Every invocation owns its context. Only the named-binding caller supplies person-proof authority. */
export function createSignInProvider(
	props: SignInProviderProps,
	controls: {
		readonly management?: { readonly requestId: string; readonly observe: ManagementObserver };
	} = {},
): SignInProvider {
	const persons = createPersonAdmissionStore({
		database: props.database,
		ownerEmail: props.configuration.ownerEmail,
		now: props.now,
	});
	const agents = createAgentRegistrationStore(props);
	const workspaces = createWorkspaceResourceStore(props.database);
	async function ownerPrivilege(
		userId: string | undefined,
		sessionId: string | undefined,
	): Promise<boolean> {
		if (props.authority.kind === 'public' || userId === undefined || sessionId === undefined)
			return false;
		return (await persons.readOwnerSession(userId, sessionId)) !== null;
	}
	const options: SignInProviderOptions = {
		baseURL: props.configuration.issuer,
		basePath: '/api/auth',
		secret: props.secret,
		database: props.database,
		logger: { disabled: true },
		emailAndPassword: { enabled: false },
		disabledPaths: ['/token'],
		trustedOrigins: [props.configuration.issuer],
		socialProviders: {
			google: { ...props.google, accessType: 'online', disableIdTokenSignIn: true },
			github: { ...props.github, disableIdTokenSignIn: true },
		},
		session: { cookieCache: { enabled: false } },
		account: {
			storeAccountCookie: false,
			accountLinking: { enabled: true, disableImplicitLinking: true, allowDifferentEmails: true },
		},
		user: {
			async validateUserInfo({ user, source }): Promise<void | { error: string }> {
				if (
					source.method !== 'oauth' ||
					!['google', 'github'].includes(source.oauth?.providerId ?? '')
				)
					return { error: 'not-allowed' };
				if (
					typeof user.email !== 'string' ||
					!(await persons.providerEmailAllowed(user.email, user.emailVerified === true))
				)
					return { error: 'not-allowed' };
			},
		},
		hooks: {
			...(props.authority.kind !== 'person-proof'
				? {}
				: {
						before: createAuthMiddleware(async () => {
							if (props.authority.kind !== 'person-proof') throw new APIError('FORBIDDEN');
							if (controls.management !== undefined)
								await controls.management.observe({
									point: 'before-provider-owner-read',
									requestId: controls.management.requestId,
								});
							const current = await persons.readOwnerSession(
								props.authority.proof.subject,
								props.authority.proof.sessionRef,
							);
							if (current === null) throw new APIError('FORBIDDEN');
							return { context: { context: { session: current } } };
						}),
					}),
			after: createAuthMiddleware(async (context) => {
				const candidate = context.context.newSession ?? context.context.session;
				if (
					context.path !== '/sign-out' &&
					candidate !== null &&
					candidate !== undefined &&
					context.context.responseHeaders?.has('set-cookie') === true &&
					!props.requestState.issuedSessions.some(
						(session) => session.sessionId === candidate.session.id,
					)
				)
					props.requestState.issuedSessions.push({
						personId: candidate.user.id,
						sessionId: candidate.session.id,
					});
			}),
		},
		databaseHooks: {
			user: {
				create: {
					async after(user): Promise<void> {
						props.requestState.createdUserIds.push(user.id);
					},
				},
			},
			session: {
				create: {
					async before(session): Promise<void> {
						if (!(await persons.ensurePersonActive(session.userId)))
							throw new APIError('FORBIDDEN', { message: 'not-allowed' });
					},
					async after(session): Promise<void> {
						props.requestState.issuedSessions.push({
							personId: session.userId,
							sessionId: session.id,
						});
					},
				},
			},
			account: {
				create: {
					async before(account) {
						return {
							data: {
								...account,
								accessToken: null,
								refreshToken: null,
								idToken: null,
								accessTokenExpiresAt: null,
								refreshTokenExpiresAt: null,
							},
						};
					},
				},
				update: {
					async before(account) {
						return {
							data: {
								...account,
								accessToken: null,
								refreshToken: null,
								idToken: null,
								accessTokenExpiresAt: null,
								refreshTokenExpiresAt: null,
							},
						};
					},
				},
			},
		},
		plugins: [
			jwt({
				jwt: { issuer: props.configuration.issuer },
				jwks: { keyPairConfig: { alg: 'EdDSA' } },
			}),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				grantTypes: ['authorization_code', 'client_credentials'],
				scopes: ['tool-portal:agent', 'tool-portal:management'],
				allowDynamicClientRegistration: false,
				allowClientKeyRotation: false,
				cachedTrustedClients: new Set<string>(),
				enforcePerClientResources: true,
				accessTokenExpiresIn: props.configuration.accessTokenSeconds,
				m2mAccessTokenExpiresIn: props.configuration.accessTokenSeconds,
				resources: [
					{
						identifier: props.configuration.managementAudience,
						accessTokenTtl: props.configuration.accessTokenSeconds,
						allowedScopes: ['tool-portal:management'],
					},
				],
				...(props.generatedClientId === undefined
					? {}
					: { generateClientId: () => props.generatedClientId ?? crypto.randomUUID() }),
				clientPrivileges: async ({ user, session }) => ownerPrivilege(user?.id, session?.id),
				resourcePrivileges: async ({ user, session }) => ownerPrivilege(user?.id, session?.id),
				async customAccessTokenClaims({
					user,
					metadata,
					resources,
				}): Promise<Record<string, unknown>> {
					if (user !== undefined && user !== null) {
						const requestedWorkspaces = await Promise.all(
							(resources ?? []).map((identifier: string) => workspaces.read(identifier)),
						);
						if (requestedWorkspaces.some((resource) => resource !== null))
							throw new APIError('BAD_REQUEST', { error: 'invalid_target' });
						if (!(await persons.ensurePersonActive(user.id)))
							throw new APIError('BAD_REQUEST', { error: 'invalid_grant' });
						return {};
					}
					const registration = agentRegistrationMetadataSchema.safeParse(metadata);
					if (!registration.success || props.tokenClientId === undefined)
						throw new APIError('BAD_REQUEST', { error: 'invalid_client' });
					const current = await agents.read(props.tokenClientId);
					if (
						current === null ||
						current.disabled ||
						!current.registrationComplete ||
						current.metadata.organizationId !== registration.data.organizationId
					)
						throw new APIError('BAD_REQUEST', { error: 'invalid_client' });
					if (resources?.length !== 1)
						throw new APIError('BAD_REQUEST', { error: 'invalid_target' });
					const identifier = resources[0];
					if (identifier === undefined || !current.resourceIds.includes(identifier))
						throw new APIError('BAD_REQUEST', { error: 'invalid_target' });
					const resource = await workspaces.read(identifier);
					if (
						resource === null ||
						!workspaceResourceHasIssuancePolicy(resource) ||
						resource.metadata.organizationId !== current.metadata.organizationId
					)
						throw new APIError('BAD_REQUEST', { error: 'invalid_target' });
					return {
						organization_id: current.metadata.organizationId,
						workspace_id: resource.metadata.workspaceId,
					};
				},
			}),
			passkey({
				rpID: new URL(props.configuration.issuer).hostname,
				origin: props.configuration.issuer,
				rpName: 'Agent sign-in',
			}),
		],
	};
	return betterAuth(options);
}
