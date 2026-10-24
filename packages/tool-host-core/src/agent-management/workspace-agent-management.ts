import {
	workspaceResourceIdentifier,
	type PersonTokenVerifier,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import {
	disableResultSchema,
	linkResultSchema,
	registerAndLinkResultSchema,
	unlinkResultSchema,
	type AgentClientManagementPort,
} from '#tool-host-core/agent-management/agent-client-management-port';
import type { WorkspaceConfigurationSource } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import type {
	AgentManagementAuthority,
	AgentRemoval,
} from '#tool-host-core/workspace-authority/agent-retirement';

const removeBodySchema = z.strictObject({ requestId: z.uuid() });
const addBodySchema = removeBodySchema.extend({
	persona: z.string().min(1),
	clientId: z.string().min(1).optional(),
});
interface ClientScope {
	readonly token: string;
	readonly organizationId: string;
	readonly clientId: string;
}

function pendingRemovalResponse(clientId: string): Response {
	return Response.json({ kind: 'removal-pending', clientId }, { status: 202 });
}

/** Coordinates workspace membership and sign-in links without sharing either owner's storage. */
export function createWorkspaceAgentManagement(props: {
	readonly verifier: PersonTokenVerifier;
	readonly signIn: AgentClientManagementPort;
	readonly toolPortalOrigin: string;
	readonly configurations: WorkspaceConfigurationSource;
	readonly workspaces: { readonly forWorkspace: (workspaceId: string) => AgentManagementAuthority };
}): { readonly handle: (request: Request) => Promise<Response> } {
	async function authorized(token: string, organizationId: string): Promise<boolean> {
		return (
			(await props.verifier.verify(token)).kind === 'verified' &&
			(await props.signIn.isLiveOwner({ token, organizationId }))
		);
	}
	async function finishUnlink(
		scope: ClientScope,
		workspaceId: string,
		removal: AgentRemoval,
	): Promise<Response> {
		const authority = props.workspaces.forWorkspace(workspaceId);
		const parsed = unlinkResultSchema.safeParse(
			await props.signIn.unlink({ ...scope, workspaceId, requestId: removal.requestId }),
		);
		const result = parsed.success ? parsed.data : null;
		if (
			result?.kind !== 'unlinked' ||
			result.clientId !== scope.clientId ||
			result.workspaceId !== workspaceId ||
			result.resource !==
				workspaceResourceIdentifier({ toolPortalOrigin: props.toolPortalOrigin, workspaceId })
		)
			return pendingRemovalResponse(scope.clientId);
		await authority.completeAgentRemoval(scope.clientId, removal.requestId, 'unlink');
		const completed = await authority.readAgentRemoval(scope.clientId);
		if (
			(await authority.readMembership(scope.clientId)) !== null ||
			completed?.kind !== 'complete' ||
			completed.operation !== 'unlink' ||
			completed.requestId !== removal.requestId
		)
			throw new Error('Membership removal readback incomplete');
		return Response.json({ kind: 'removed', clientId: scope.clientId, workspaceId });
	}
	async function finishRetirement(
		scope: ClientScope,
		requestId: string,
		workspaceIds: readonly string[],
	): Promise<Response> {
		// Every removal completes before the global disable; retirement never unlinks resources.
		const removals = await Promise.allSettled(
			workspaceIds.map(async (workspaceId): Promise<void> => {
				const authority = props.workspaces.forWorkspace(workspaceId);
				await authority.beginAgentRemoval(scope.clientId, requestId, 'disable');
				if ((await authority.readMembership(scope.clientId)) !== null)
					throw new Error('Membership removal readback incomplete');
			}),
		);
		if (removals.some((result) => result.status === 'rejected'))
			throw new Error('Workspace retirement removal incomplete');
		const parsed = disableResultSchema.safeParse(
			await props.signIn.disable({ ...scope, requestId }),
		);
		if (
			!parsed.success ||
			parsed.data.kind !== 'disabled' ||
			parsed.data.clientId !== scope.clientId
		)
			return pendingRemovalResponse(scope.clientId);
		const completions = await Promise.allSettled(
			workspaceIds.map(async (workspaceId): Promise<void> => {
				const authority = props.workspaces.forWorkspace(workspaceId);
				await authority.completeAgentRemoval(scope.clientId, requestId, 'disable');
				const completed = await authority.readAgentRemoval(scope.clientId);
				if (
					completed?.kind !== 'complete' ||
					completed.operation !== 'disable' ||
					completed.requestId !== requestId ||
					(await authority.readMembership(scope.clientId)) !== null
				)
					throw new Error('Retirement readback incomplete');
			}),
		);
		if (completions.some((result) => result.status === 'rejected'))
			throw new Error('Workspace retirement completion incomplete');
		return Response.json({ kind: 'removed', clientId: scope.clientId });
	}
	async function resumeRetirement(
		scope: ClientScope,
		workspaceIds: readonly string[],
	): Promise<Response | null> {
		const removals = await Promise.all(
			workspaceIds.map((workspaceId) =>
				props.workspaces.forWorkspace(workspaceId).readAgentRemoval(scope.clientId),
			),
		);
		const retirement = removals.find((removal) => removal?.operation === 'disable');
		if (retirement !== undefined && retirement !== null) {
			const completed = removals.every(
				(removal) =>
					removal?.operation === 'disable' &&
					removal.kind === 'complete' &&
					removal.requestId === retirement.requestId,
			);
			return completed
				? Response.json({ kind: 'removed', clientId: scope.clientId })
				: finishRetirement(scope, retirement.requestId, workspaceIds);
		}
		return null;
	}
	return {
		async handle(request): Promise<Response> {
			const path = new URL(request.url).pathname;
			const workspaceMatch = /^\/management\/workspaces\/([^/]+)\/agents(?:\/([^/]+))?$/u.exec(
				path,
			);
			const retirementMatch = /^\/management\/organizations\/([^/]+)\/agents\/([^/]+)$/u.exec(path);
			if (workspaceMatch === null && retirementMatch === null)
				return Response.json({ error: 'not-found' }, { status: 404 });
			const selectedId = z.uuid().safeParse(workspaceMatch?.[1] ?? retirementMatch?.[1]);
			const token = /^Bearer ([^\s]+)$/iu.exec(request.headers.get('authorization') ?? '')?.[1];
			if (!selectedId.success || token === undefined)
				return Response.json({ error: 'not-authorized' }, { status: 403 });
			try {
				if (
					retirementMatch !== null &&
					(await props.configurations.workspaceIdsForOrganization(selectedId.data)).length === 0
				)
					return Response.json({ error: 'not-authorized' }, { status: 403 });
				if ((await props.verifier.verify(token)).kind !== 'verified')
					return Response.json({ error: 'not-authorized' }, { status: 403 });
				const human = await props.signIn.humanCheckStatus();
				if (human.kind === 'not-implemented')
					return Response.json(
						{ error: 'management-human-check-not-implemented', level: human.level },
						{ status: 501 },
					);
				const configuration =
					workspaceMatch === null ? null : await props.configurations.read(selectedId.data);
				const organizationId = configuration?.organizationId ?? selectedId.data;
				if (!(await authorized(token, organizationId)))
					return Response.json({ error: 'not-authorized' }, { status: 403 });
				const workspaceIds = await props.configurations.workspaceIdsForOrganization(organizationId);
				const rawClientId = workspaceMatch?.[2] ?? retirementMatch?.[2];
				const clientId = rawClientId === undefined ? undefined : decodeURIComponent(rawClientId);
				if (clientId !== undefined) {
					const scope = { token, organizationId, clientId };
					if (!(await props.signIn.ownsAgentClient(scope)))
						return Response.json({ error: 'not-authorized' }, { status: 403 });
					const resumed = await resumeRetirement(scope, workspaceIds);
					if (resumed !== null) return resumed;
					if (retirementMatch !== null) {
						if (request.method === 'GET') return Response.json({ kind: 'not-retired', clientId });
						if (request.method !== 'DELETE')
							return Response.json({ error: 'method-not-allowed' }, { status: 405 });
						const body = removeBodySchema.safeParse(await request.json());
						if (!body.success)
							return Response.json({ error: 'invalid-operation' }, { status: 400 });
						return await finishRetirement(scope, body.data.requestId, workspaceIds);
					}
					const authority = props.workspaces.forWorkspace(selectedId.data);
					const removal = await authority.readAgentRemoval(clientId);
					if (removal?.kind === 'pending')
						return await finishUnlink(scope, selectedId.data, removal);
					if (request.method === 'GET')
						return Response.json({
							kind: (await authority.readMembership(clientId)) === null ? 'removed' : 'member',
							clientId,
							workspaceId: selectedId.data,
						});
					if (request.method !== 'DELETE')
						return Response.json({ error: 'method-not-allowed' }, { status: 405 });
					const body = removeBodySchema.safeParse(await request.json());
					if (!body.success) return Response.json({ error: 'invalid-operation' }, { status: 400 });
					return await finishUnlink(
						scope,
						selectedId.data,
						await authority.beginAgentRemoval(clientId, body.data.requestId, 'unlink'),
					);
				}
				if (request.method !== 'POST' || configuration === null)
					return Response.json({ error: 'method-not-allowed' }, { status: 405 });
				const body = addBodySchema.safeParse(await request.json());
				if (!body.success || configuration.portal.profiles[body.data.persona] === undefined)
					return Response.json({ error: 'invalid-operation' }, { status: 400 });
				const { requestId, persona } = body.data;
				const workspaceId = selectedId.data;
				if (
					body.data.clientId !== undefined &&
					!(await props.signIn.ownsAgentClient({
						token,
						organizationId,
						clientId: body.data.clientId,
					}))
				)
					return Response.json({ error: 'not-authorized' }, { status: 403 });
				if (body.data.clientId !== undefined) {
					const scope = { token, organizationId, clientId: body.data.clientId };
					const resumed = await resumeRetirement(scope, workspaceIds);
					if (resumed !== null) return resumed;
					const removal = await props.workspaces
						.forWorkspace(workspaceId)
						.readAgentRemoval(body.data.clientId);
					if (removal?.kind === 'pending') return await finishUnlink(scope, workspaceId, removal);
				}
				const context = { token, requestId, organizationId, workspaceId };
				const parsed =
					body.data.clientId === undefined
						? registerAndLinkResultSchema.safeParse(await props.signIn.registerAndLink(context))
						: linkResultSchema.safeParse(
								await props.signIn.link({ ...context, clientId: body.data.clientId }),
							);
				if (!parsed.success) throw new Error('Sign-in result shape mismatch');
				const result = parsed.data;
				if (result.kind === 'refused' || result.kind === 'incomplete')
					return Response.json(result, { status: result.kind === 'refused' ? 403 : 503 });
				if (
					result.workspaceId !== workspaceId ||
					result.resource !==
						workspaceResourceIdentifier({
							toolPortalOrigin: props.toolPortalOrigin,
							workspaceId,
						}) ||
					(body.data.clientId !== undefined && result.clientId !== body.data.clientId)
				)
					throw new Error('Sign-in result scope mismatch');
				const authority = props.workspaces.forWorkspace(workspaceId);
				await authority.setMembership(result.clientId, persona);
				if (
					(await authority.readMembership(result.clientId))?.persona !== persona ||
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
