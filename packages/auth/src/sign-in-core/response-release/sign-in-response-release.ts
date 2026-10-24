import { workspaceResourceIdentifier } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import type { AgentRegistration } from '#auth/sign-in-core/agent-clients/agent-registration';
import {
	workspaceResourceHasIssuancePolicy,
	type WorkspaceResource,
} from '#auth/sign-in-core/agent-clients/workspace-resource';

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
	workspace_id: z.string().optional(),
});
export type AccessTokenReleaseClaims = z.infer<typeof accessTokenReleaseClaimsSchema>;

export interface IssuedPersonSession {
	readonly personId: string;
	readonly sessionId: string;
}
export interface SignInResponseReleasePorts {
	readonly issuer: string;
	readonly toolPortalOrigin: string;
	readonly requestedResource: string | null;
	readonly managementAudience: string;
	readonly accessTokenSeconds: number;
	readonly now: () => number;
	readonly inspectSignedToken: (token: string) => AccessTokenReleaseClaims;
	readonly readAgent: (clientId: string) => Promise<AgentRegistration | null>;
	readonly readWorkspaceResource: (identifier: string) => Promise<WorkspaceResource | null>;
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
		error: 'invalid_client' | 'invalid_target' | 'invalid_grant' | 'not-allowed',
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
				claims.workspace_id === undefined ||
				props.ports.requestedResource === null ||
				claims.aud !== props.ports.requestedResource ||
				claims.sub !== claims.client_id ||
				claims.azp !== claims.client_id
			)
				return refuse('invalid_client');
			const registration = await props.ports.readAgent(claims.client_id);
			if (
				registration === null ||
				registration.disabled ||
				registration.clientId !== claims.client_id ||
				registration.metadata.organizationId !== claims.organization_id
			)
				return refuse('invalid_client');
			const resource = await props.ports.readWorkspaceResource(props.ports.requestedResource);
			if (resource === null || !workspaceResourceHasIssuancePolicy(resource))
				return refuse('invalid_target');
			if (
				resource.identifier !== props.ports.requestedResource ||
				workspaceResourceIdentifier({
					toolPortalOrigin: props.ports.toolPortalOrigin,
					workspaceId: resource.metadata.workspaceId,
				}) !== resource.identifier ||
				resource.metadata.organizationId !== registration.metadata.organizationId ||
				resource.metadata.workspaceId !== claims.workspace_id
			)
				return refuse('invalid_client');
		} else {
			const resource = await props.ports.readWorkspaceResource(claims.aud);
			if (resource !== null) return refuse('invalid_target');
			if (
				claims.sid === undefined ||
				claims.aud !== props.ports.managementAudience ||
				!(await props.ports.isPersonSessionActive(claims.sub, claims.sid))
			)
				return refuse('invalid_grant');
		}
		return props.response;
	} catch {
		if (props.tokenGrant === 'introspection')
			return Response.json({ active: false }, { headers: { 'cache-control': 'no-store' } });
		return refuse(props.tokenGrant === 'client_credentials' ? 'invalid_client' : 'invalid_grant');
	}
}
