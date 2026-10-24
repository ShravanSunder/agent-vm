import type { PersonTokenVerifier } from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import type { AgentManagementAuthority } from '#tool-host-core/organization-authority/agent-retirement';

const clientOperationSchema = z.strictObject({ requestId: z.uuid() });
export type ManagedAgentClientResult =
	| { readonly kind: 'registered'; readonly clientId: string; readonly clientSecret: string }
	| { readonly kind: 'disabled'; readonly clientId: string }
	| { readonly kind: 'incomplete'; readonly clientId: string }
	| { readonly kind: 'refused'; readonly reason: string };

/** The sign-in binding verifies the raw E7 again and checks its live bound owner session in D1. */
export interface AgentClientManagementPort {
	readonly humanCheckStatus: () => Promise<
		| { readonly kind: 'ready'; readonly level: 'remembered-login' }
		| {
				readonly kind: 'not-implemented';
				readonly level: 'fresh-verified-uv' | 'exact-operation-binding';
		  }
	>;
	readonly isLiveOwner: (props: {
		readonly token: string;
		readonly organizationId: string;
	}) => Promise<boolean>;
	readonly ownsAgentClient: (props: {
		readonly token: string;
		readonly organizationId: string;
		readonly clientId: string;
	}) => Promise<boolean>;
	readonly changeClient: (props: {
		readonly token: string;
		readonly operation:
			| { readonly kind: 'register'; readonly requestId: string; readonly organizationId: string }
			| {
					readonly kind: 'disable';
					readonly requestId: string;
					readonly organizationId: string;
					readonly clientId: string;
			  };
	}) => Promise<ManagedAgentClientResult>;
}

/** Coordinates two authorities without sharing their storage or trusting caller-supplied identity. */
export function createOrganizationAgentManagement(props: {
	readonly verifier: PersonTokenVerifier;
	readonly signIn: AgentClientManagementPort;
	readonly organizations: {
		readonly forOrganization: (organizationId: string) => AgentManagementAuthority;
	};
}): { readonly handle: (request: Request) => Promise<Response> } {
	async function authorized(token: string, organizationId: string): Promise<boolean> {
		return (
			(await props.verifier.verify(token)).kind === 'verified' &&
			(await props.signIn.isLiveOwner({ token, organizationId }))
		);
	}
	async function finishRetirement(input: {
		readonly token: string;
		readonly organizationId: string;
		readonly clientId: string;
		readonly authority: AgentManagementAuthority;
		readonly requestId: string;
	}): Promise<Response> {
		const result = await props.signIn.changeClient({
			token: input.token,
			operation: {
				kind: 'disable',
				organizationId: input.organizationId,
				clientId: input.clientId,
				requestId: input.requestId,
			},
		});
		if (result.kind !== 'disabled' || result.clientId !== input.clientId)
			return Response.json({ kind: 'removal-pending', clientId: input.clientId }, { status: 202 });
		await input.authority.completeAgentRetirement(input.clientId);
		if (
			(await input.authority.isAgentListed(input.clientId)) ||
			(await input.authority.readAgentRetirement(input.clientId))?.kind !== 'complete'
		)
			throw new Error('Agent retirement readback incomplete');
		return Response.json({ kind: 'removed', clientId: input.clientId });
	}
	return {
		async handle(request): Promise<Response> {
			const match = /^\/management\/organizations\/([^/]+)\/agents(?:\/([^/]+))?$/.exec(
				new URL(request.url).pathname,
			);
			if (match === null) return Response.json({ error: 'not-found' }, { status: 404 });
			const organization = z.uuid().safeParse(match[1]);
			const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
			if (!organization.success || token === undefined)
				return Response.json({ error: 'not-authorized' }, { status: 403 });
			try {
				const organizationId = organization.data;
				if ((await props.verifier.verify(token)).kind !== 'verified')
					return Response.json({ error: 'not-authorized' }, { status: 403 });
				const humanCheck = await props.signIn.humanCheckStatus();
				if (humanCheck.kind === 'not-implemented')
					return Response.json(
						{ error: 'management-human-check-not-implemented', level: humanCheck.level },
						{ status: 501 },
					);
				if (!(await authorized(token, organizationId)))
					return Response.json({ error: 'not-authorized' }, { status: 403 });
				const authority = props.organizations.forOrganization(organizationId);
				const clientId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
				if (clientId !== undefined) {
					if (!(await props.signIn.ownsAgentClient({ token, organizationId, clientId })))
						return Response.json({ error: 'not-authorized' }, { status: 403 });
					const retirement = await authority.readAgentRetirement(clientId);
					// An owner retry, including GET, completes an earlier interrupted removal before any other action.
					if (retirement?.kind === 'pending')
						return await finishRetirement({
							token,
							organizationId,
							clientId,
							authority,
							requestId: retirement.requestId,
						});
					if (retirement?.kind === 'complete') return Response.json({ kind: 'removed', clientId });
					if (request.method === 'GET')
						return Response.json({
							kind: (await authority.isAgentListed(clientId)) ? 'listed' : 'unlisted',
							clientId,
						});
					if (request.method !== 'DELETE')
						return Response.json({ error: 'method-not-allowed' }, { status: 405 });
					const parsed = clientOperationSchema.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: 'invalid-operation' }, { status: 400 });
					const pending = await authority.beginAgentRetirement(clientId, parsed.data.requestId);
					return await finishRetirement({
						token,
						organizationId,
						clientId,
						authority,
						requestId: pending.requestId,
					});
				}
				if (request.method !== 'POST')
					return Response.json({ error: 'method-not-allowed' }, { status: 405 });
				const parsed = clientOperationSchema.safeParse(await request.json());
				if (!parsed.success) return Response.json({ error: 'invalid-operation' }, { status: 400 });
				const result = await props.signIn.changeClient({
					token,
					operation: { kind: 'register', organizationId, requestId: parsed.data.requestId },
				});
				if (result.kind !== 'registered')
					return Response.json(result, { status: result.kind === 'refused' ? 403 : 503 });
				await authority.setAgentAdmission(result.clientId, 'listed');
				// Neither a storage acknowledgement nor an earlier owner check permits credential release.
				if (
					!(await authority.isAgentListed(result.clientId)) ||
					!(await authorized(token, organizationId))
				)
					return Response.json({ kind: 'incomplete', clientId: result.clientId }, { status: 503 });
				return Response.json(result, { headers: { 'cache-control': 'no-store' } });
			} catch {
				return Response.json({ error: 'management-unavailable' }, { status: 503 });
			}
		},
	};
}
