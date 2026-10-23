import { z } from 'zod';

import {
	agentRegistrationAllowsToken,
	type AgentRegistration,
} from '#auth/sign-in-core/agent-clients/agent-registration';

export const accessTokenReleaseClaimsSchema = z.looseObject({
	iss: z.string(),
	sub: z.string(),
	aud: z.string(),
	iat: z.number().int(),
	exp: z.number().int(),
	client_id: z.string(),
	azp: z.string(),
	sid: z.string().optional(),
	organization_id: z.string().optional(),
});
export type AccessTokenReleaseClaims = z.infer<typeof accessTokenReleaseClaimsSchema>;

export interface IssuedPersonSession {
	readonly personId: string;
	readonly sessionId: string;
}
export interface SignInResponseReleasePorts {
	readonly issuer: string;
	readonly agentAudience: string;
	readonly managementAudience: string;
	readonly accessTokenSeconds: number;
	readonly now: () => number;
	readonly inspectSignedToken: (token: string) => AccessTokenReleaseClaims;
	readonly readAgent: (clientId: string) => Promise<AgentRegistration | null>;
	readonly isPersonSessionActive: (personId: string, sessionId: string) => Promise<boolean>;
	readonly deleteSession: (sessionId: string) => Promise<void>;
	readonly cleanupUnboundPerson: (personId: string) => Promise<void>;
}

/** This is the outermost fence, after the real provider's insert/sign/inspection and before response release. */
export async function releaseSignInResponse(props: {
	readonly response: Response;
	readonly tokenGrant: 'client_credentials' | 'person' | 'introspection' | 'none';
	readonly issuedSessions: readonly IssuedPersonSession[];
	readonly createdUserIds: readonly string[];
	readonly ports: SignInResponseReleasePorts;
}): Promise<Response> {
	async function refuse(
		error: 'invalid_client' | 'invalid_grant' | 'not-allowed',
	): Promise<Response> {
		await Promise.all(
			props.issuedSessions.map((session) => props.ports.deleteSession(session.sessionId)),
		);
		await Promise.all(
			props.createdUserIds.map((personId) => props.ports.cleanupUnboundPerson(personId)),
		);
		return Response.json(
			{ error },
			{ status: error === 'not-allowed' ? 403 : 400, headers: { 'cache-control': 'no-store' } },
		);
	}
	try {
		const sessionsActive = await Promise.all(
			props.issuedSessions.map((session) =>
				props.ports.isPersonSessionActive(session.personId, session.sessionId),
			),
		);
		if (sessionsActive.some((active) => !active)) return refuse('not-allowed');
		if (props.tokenGrant === 'introspection' && props.response.ok) {
			const body = z
				.looseObject({
					active: z.boolean(),
					sub: z.string().optional(),
					sid: z.string().optional(),
					aud: z.string().optional(),
					exp: z.number().optional(),
				})
				.parse(await props.response.clone().json());
			if (!body.active) return props.response;
			if (
				body.sub === undefined ||
				body.sid === undefined ||
				body.aud !== props.ports.managementAudience ||
				body.exp === undefined ||
				body.exp <= Math.floor(props.ports.now() / 1000) ||
				!(await props.ports.isPersonSessionActive(body.sub, body.sid))
			)
				return Response.json({ active: false }, { headers: { 'cache-control': 'no-store' } });
			return Response.json(
				{ ...body, checkedAt: props.ports.now() },
				{ headers: { 'cache-control': 'no-store' } },
			);
		}
		if (props.tokenGrant === 'introspection') return props.response;
		if (props.tokenGrant === 'none' || !props.response.ok) return props.response;
		const body = z
			.object({ access_token: z.string(), refresh_token: z.unknown().optional() })
			.safeParse(await props.response.clone().json());
		if (!body.success)
			return refuse(props.tokenGrant === 'client_credentials' ? 'invalid_client' : 'invalid_grant');
		if (body.data.refresh_token !== undefined) return refuse('invalid_grant');
		const claims = props.ports.inspectSignedToken(body.data.access_token);
		const invalid = props.tokenGrant === 'client_credentials' ? 'invalid_client' : 'invalid_grant';
		if (
			claims.iss !== props.ports.issuer ||
			claims.exp <= Math.floor(props.ports.now() / 1000) ||
			claims.exp - claims.iat > props.ports.accessTokenSeconds ||
			claims.exp <= claims.iat
		)
			return refuse(invalid);
		if (props.tokenGrant === 'client_credentials') {
			if (
				Object.hasOwn(claims, 'sid') ||
				claims.organization_id === undefined ||
				claims.sub !== claims.client_id ||
				claims.azp !== claims.client_id
			)
				return refuse('invalid_client');
			const registration = await props.ports.readAgent(claims.client_id);
			if (
				registration === null ||
				!agentRegistrationAllowsToken({
					registration,
					clientId: claims.client_id,
					audience: props.ports.agentAudience,
					signedOrganizationId: claims.organization_id,
				}) ||
				claims.aud !== props.ports.agentAudience
			)
				return refuse('invalid_client');
		} else if (
			claims.sid === undefined ||
			claims.aud !== props.ports.managementAudience ||
			!(await props.ports.isPersonSessionActive(claims.sub, claims.sid))
		)
			return refuse('invalid_grant');
		return props.response;
	} catch {
		if (props.tokenGrant === 'introspection')
			return Response.json({ active: false }, { headers: { 'cache-control': 'no-store' } });
		return refuse(props.tokenGrant === 'client_credentials' ? 'invalid_client' : 'invalid_grant');
	}
}
