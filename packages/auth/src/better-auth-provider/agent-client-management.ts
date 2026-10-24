import {
	workspaceResourceIdentifier,
	type PersonProof,
} from '@agent-collaboration/tool-access/contracts';
import { z } from 'zod';

import {
	createSignInProvider,
	type SignInProviderProps,
	type ManagementObserver,
} from '#auth/better-auth-provider/provider-configuration';
import { createAgentRegistrationStore } from '#auth/d1-persistence/agent-registration-store';
import { createPersonAdmissionStore } from '#auth/d1-persistence/person-admission-store';
import {
	createWorkspaceManagementAudit,
	ManagementOperationConflict,
} from '#auth/d1-persistence/workspace-management-audit';
import { createWorkspaceResourceStore } from '#auth/d1-persistence/workspace-resource-store';
import {
	agentManagementOperationSchema,
	type AgentManagementResult,
} from '#auth/sign-in-core/agent-clients/agent-registration';
import {
	disableAgentClient,
	registerAgentClient,
} from '#auth/sign-in-core/agent-clients/change-agent-client';
import { workspaceResourceHasIssuancePolicy } from '#auth/sign-in-core/agent-clients/workspace-resource';

/** Verified Person context is request-owned; the route changes only issuer-owned clients, resources and links. */
export async function manageAgentClient(props: {
	readonly provider: Omit<SignInProviderProps, 'authority' | 'generatedClientId'>;
	readonly proof: PersonProof;
	readonly operation: unknown;
	readonly observeManagement?: ManagementObserver;
}): Promise<AgentManagementResult> {
	const operation = agentManagementOperationSchema.parse(props.operation);
	if (!props.provider.configuration.organizationIds.includes(operation.organizationId))
		return { kind: 'refused', reason: 'foreign-organization' };
	const persons = createPersonAdmissionStore({
		database: props.provider.database,
		ownerEmail: props.provider.configuration.ownerEmail,
		now: props.provider.now,
	});
	if ((await persons.readOwnerSession(props.proof.subject, props.proof.sessionRef)) === null)
		return { kind: 'refused', reason: 'not-owner' };
	const clientId =
		operation.kind === 'registerAndLink'
			? `agent-${operation.organizationId}-${operation.requestId}`
			: operation.clientId;
	const records = createAgentRegistrationStore(props.provider);
	const resources = createWorkspaceResourceStore(props.provider.database);
	const audit = createWorkspaceManagementAudit(props.provider);
	try {
		await audit.checkOperation(operation, props.proof.subject, clientId);
		const existing = await records.read(clientId);
		if (existing !== null && existing.metadata.organizationId !== operation.organizationId)
			return { kind: 'refused', reason: 'foreign-organization' };
		if (
			operation.kind !== 'registerAndLink' &&
			(existing === null ||
				(operation.kind !== 'disable' && (!existing.registrationComplete || existing.disabled)))
		)
			return { kind: 'refused', reason: 'invalid-client' };
		await audit.reserve(operation, props.proof.subject, clientId);
		const auth = createSignInProvider(
			{
				...props.provider,
				authority: { kind: 'person-proof', proof: props.proof },
				generatedClientId: clientId,
			},
			props.observeManagement === undefined
				? {}
				: { management: { requestId: operation.requestId, observe: props.observeManagement } },
		);
		const headers = new Headers();
		const provider = {
			async create(): Promise<{ clientId: string; clientSecret: string }> {
				const result = await auth.api.adminCreateOAuthClient({
					headers,
					body: {
						client_name: clientId,
						token_endpoint_auth_method: 'client_secret_basic',
						grant_types: ['client_credentials'],
						client_credentials_scopes: ['tool-portal:agent'],
						scope: 'tool-portal:agent',
						metadata: { kind: 'agent', organizationId: operation.organizationId },
					},
				});
				return z
					.object({ client_id: z.string(), client_secret: z.string() })
					.transform((value) => ({ clientId: value.client_id, clientSecret: value.client_secret }))
					.parse(result);
			},
			async rotate(): Promise<string> {
				return z
					.object({ client_secret: z.string() })
					.parse(await auth.api.rotateClientSecret({ headers, body: { client_id: clientId } }))
					.client_secret;
			},
			async disable(): Promise<void> {
				await auth.api.adminUpdateOAuthClient({
					headers,
					body: { client_id: clientId, update: { disabled: true } },
				});
			},
		};
		const base = {
			records,
			clientId,
			organizationId: operation.organizationId,
			actorUserId: props.proof.subject,
			requestId: operation.requestId,
		};
		if (operation.kind === 'disable') {
			const result = await disableAgentClient({
				...base,
				provider: { disable: async (): Promise<void> => provider.disable() },
			});
			if (result.kind === 'disabled') await audit.finish(operation, props.proof.subject, clientId);
			return result.kind === 'registered' ? { kind: 'incomplete', clientId } : result;
		}
		const resource = workspaceResourceIdentifier({
			toolPortalOrigin: props.provider.configuration.toolPortalOrigin,
			workspaceId: operation.workspaceId,
		});
		const priorResource = await resources.read(resource);
		if (
			priorResource !== null &&
			(priorResource.metadata.organizationId !== operation.organizationId ||
				priorResource.metadata.workspaceId !== operation.workspaceId ||
				!workspaceResourceHasIssuancePolicy(priorResource) ||
				priorResource.customClaims !== null)
		)
			return { kind: 'refused', reason: 'resource-conflict' };
		if (priorResource === null && (await resources.exists(resource)))
			return { kind: 'refused', reason: 'resource-conflict' };
		const resourceEvent = {
			requestId: operation.requestId,
			actorUserId: props.proof.subject,
			kind: 'resource-changed',
			change: 'registered',
			targetId: resource,
		} satisfies Omit<Parameters<typeof audit.record>[0], 'phase'>;
		if (operation.kind !== 'unlink') {
			await audit.record({ ...resourceEvent, phase: 'intent' });
			if (priorResource === null)
				await auth.api.adminCreateOAuthResource({
					headers,
					body: {
						identifier: resource,
						metadata: {
							kind: 'workspace',
							organizationId: operation.organizationId,
							workspaceId: operation.workspaceId,
						},
						allowedScopes: ['tool-portal:agent'],
						customClaims: null,
						accessTokenTtl: props.provider.configuration.accessTokenSeconds,
					},
				});
			await audit.record({ ...resourceEvent, phase: 'outcome' });
		}
		const currentResource = await resources.read(resource);
		if (
			currentResource === null ||
			currentResource.metadata.organizationId !== operation.organizationId ||
			currentResource.metadata.workspaceId !== operation.workspaceId ||
			!workspaceResourceHasIssuancePolicy(currentResource) ||
			currentResource.customClaims !== null
		)
			return { kind: 'refused', reason: 'resource-conflict' };
		const linkEvent = {
			requestId: operation.requestId,
			actorUserId: props.proof.subject,
			kind: 'client-link-changed',
			change: operation.kind === 'unlink' ? 'unlinked' : 'linked',
			targetId: JSON.stringify({ clientId, resource }),
		} satisfies Omit<Parameters<typeof audit.record>[0], 'phase'>;
		async function changeLink(): Promise<void> {
			await audit.record({ ...linkEvent, phase: 'intent' });
			const params = { identifier: resource, client_id: clientId };
			if (operation.kind === 'unlink')
				await auth.api.adminUnlinkClientResource({ headers, params });
			else await auth.api.adminLinkClientResource({ headers, params });
			await audit.record({ ...linkEvent, phase: 'outcome' });
		}
		const scope = { clientId, workspaceId: operation.workspaceId, resource };
		async function resourceStillMatches(): Promise<boolean> {
			const finalResource = await resources.read(resource);
			return (
				finalResource !== null &&
				finalResource.metadata.organizationId === operation.organizationId &&
				finalResource.metadata.workspaceId === scope.workspaceId &&
				workspaceResourceHasIssuancePolicy(finalResource) &&
				finalResource.customClaims === null
			);
		}
		if (operation.kind === 'registerAndLink') {
			const result = await registerAgentClient({
				...base,
				audience: resource,
				provider: { ...provider, link: changeLink },
			});
			if (!(await resourceStillMatches())) return { kind: 'incomplete', clientId };
			if (result.kind === 'registered')
				await audit.finish(operation, props.proof.subject, clientId);
			return result.kind === 'registered'
				? { ...result, ...scope }
				: result.kind === 'disabled'
					? { kind: 'incomplete', clientId }
					: result;
		}
		await changeLink();
		const changed = await records.read(clientId);
		if (
			!(await resourceStillMatches()) ||
			changed === null ||
			changed.disabled ||
			!changed.registrationComplete ||
			changed.metadata.organizationId !== operation.organizationId ||
			changed.resourceIds.includes(resource) !== (operation.kind === 'link')
		)
			return { kind: 'incomplete', clientId };
		await audit.finish(operation, props.proof.subject, clientId);
		return operation.kind === 'link'
			? { kind: 'linked', ...scope }
			: { kind: 'unlinked', ...scope };
	} catch (error) {
		return error instanceof ManagementOperationConflict
			? { kind: 'refused', reason: 'operation-conflict' }
			: { kind: 'incomplete', clientId };
	}
}
