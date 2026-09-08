import {
	googleOAuthApplicationIdSchema,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';

import { type OAuthKeyEncryptionKey } from '../envelope-codec.js';
import {
	type OAuthStoredGrant,
	type OAuthCredentialCatalog,
} from '../oauth-credential-catalog-contracts.js';
import { decryptGoogleCredentialPayload } from './google-credential-payload.js';
import { type GoogleCredentialRefreshCoordinator } from './google-credential-refresh-coordinator.js';
import { getGoogleGogCommandDescriptors } from './google-gog-command-catalog.js';
import { type GoogleWebClientCredentials } from './google-oauth-adapter.js';
import {
	type GoogleOAuthRuntimeCredentialRequest,
	type GoogleOAuthRuntimeCredentialBinding,
	type GoogleOAuthRuntimeCredentialResolution,
	type GoogleOAuthRuntimeCredentialSnapshotValidation,
} from './google-oauth-broker-contracts.js';
import {
	type GoogleOAuthPermissionPolicy,
	type GoogleOfferedPermissionGroups,
} from './google-oauth-permission-policy.js';
import { evaluateGoogleOperationGrant } from './google-operation-grant-policy.js';

export interface GoogleRuntimeCredentialPolicy {
	resolveRuntimeCredential(
		props: GoogleOAuthRuntimeCredentialRequest,
	): Promise<GoogleOAuthRuntimeCredentialResolution>;
	validateRuntimeCredentialSnapshot(
		props: GoogleOAuthRuntimeCredentialRequest & GoogleOAuthRuntimeCredentialBinding,
	): GoogleOAuthRuntimeCredentialSnapshotValidation;
}
export function createGoogleRuntimeCredentialPolicy(props: {
	readonly catalog: OAuthCredentialCatalog;
	readonly clientCredentialsByApplication: Readonly<
		Record<GoogleOAuthApplicationId, GoogleWebClientCredentials>
	>;
	readonly clientBindingRevisionsByApplication: Readonly<Record<GoogleOAuthApplicationId, string>>;
	readonly allowedHostsByApplication: Readonly<Record<GoogleOAuthApplicationId, readonly string[]>>;
	readonly config: OAuthConfig;
	readonly offeredGroupIdsByAgentApplication: GoogleOfferedPermissionGroups;
	readonly operationIdsByAgent: Readonly<Record<string, readonly string[]>>;
	readonly permissionPolicy: GoogleOAuthPermissionPolicy;
	readonly isAdmissionOpen: () => boolean;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	readonly keyEncryptionKeyVersion: number;
	readonly providerSignal: AbortSignal;
	readonly refreshCoordinator: GoogleCredentialRefreshCoordinator;
}): GoogleRuntimeCredentialPolicy {
	const operations = new Map(
		getGoogleGogCommandDescriptors().map((operation) => [operation.operationId, operation]),
	);
	const readCurrent = (
		request: GoogleOAuthRuntimeCredentialRequest,
	): OAuthStoredGrant | undefined => {
		if (!props.isAdmissionOpen()) return undefined;
		const application = googleOAuthApplicationIdSchema.safeParse(request.applicationId);
		if (
			!application.success ||
			!props.operationIdsByAgent[request.agentId]?.includes(request.operationId)
		)
			return undefined;
		const applicationId = application.data;
		const operation = operations.get(request.operationId);
		if (
			operation === undefined ||
			operation.familyId !==
				props.config.providers.google.applications[applicationId].catalogFamilyId
		)
			return undefined;
		const grant = props.catalog.getGrantForAccountApplication({
			accountId: request.accountId,
			agentId: request.agentId,
			applicationId: request.applicationId,
			zoneId: props.config.zoneId,
		});
		if (
			grant === undefined ||
			grant.owner.issuer !== props.config.browser.identity.issuer ||
			!Object.values(props.config.owners).some(
				(owner) =>
					owner.clerkUserId === grant.owner.userId &&
					owner.allowedAgentIds.includes(request.agentId),
			) ||
			grant.clientId !== props.clientCredentialsByApplication[applicationId].web.client_id ||
			grant.clientBindingRevision !== props.clientBindingRevisionsByApplication[applicationId] ||
			grant.catalogVersion !== props.config.providers.google.catalogVersion
		)
			return undefined;
		try {
			decryptGoogleCredentialPayload({ grant, keyEncryptionKey: props.keyEncryptionKey });
			props.permissionPolicy.validateSelections({
				agentId: request.agentId,
				selections: { [applicationId]: grant.selectedGroupIds },
			});
		} catch {
			return undefined;
		}
		const permission = evaluateGoogleOperationGrant({
			operationId: request.operationId,
			selectedGroupIds: grant.selectedGroupIds,
			ceiling: props.offeredGroupIdsByAgentApplication[request.agentId]?.[applicationId] ?? [],
			actualScopes: grant.grantedScopes,
		});
		if (permission.kind !== 'admitted' || (operation.sendsMail && !request.gmailWriteAllowed))
			return undefined;
		return grant;
	};
	const snapshot = (
		request: GoogleOAuthRuntimeCredentialRequest & GoogleOAuthRuntimeCredentialBinding,
	): GoogleOAuthRuntimeCredentialSnapshotValidation => {
		const current = readCurrent(request);
		if (current === undefined || current.lifecycleKind !== 'active')
			return { kind: 'stale', reason: 'credential-unavailable' };
		if (
			current.authorizationId !== request.authorizationId ||
			current.generation !== request.generation ||
			current.authorizationMetadataRevision !== request.authorizationMetadataRevision ||
			current.credentialId !== request.credentialId ||
			current.materialRevision !== request.materialRevision
		)
			return { kind: 'stale', reason: 'credential-changed' };
		return { kind: 'current' };
	};
	return {
		validateRuntimeCredentialSnapshot: snapshot,
		resolveRuntimeCredential: async (request): Promise<GoogleOAuthRuntimeCredentialResolution> => {
			const grant = readCurrent(request);
			if (grant === undefined) return { kind: 'unavailable', reason: 'authorization-unavailable' };
			const applicationId = googleOAuthApplicationIdSchema.parse(request.applicationId);
			const credential = await props.refreshCoordinator.resolveAccessToken({
				clientCredentials: props.clientCredentialsByApplication[applicationId],
				grant,
				keyEncryptionKey: props.keyEncryptionKey,
				keyEncryptionKeyVersion: props.keyEncryptionKeyVersion,
				requiredScopes: grant.requestedScopes,
				signal: props.providerSignal,
			});
			if (credential.kind !== 'ready') return { kind: 'unavailable', reason: credential.kind };
			const resolved = credential.grant;
			const binding: GoogleOAuthRuntimeCredentialBinding = {
				accountId: resolved.accountId,
				authorizationId: resolved.authorizationId,
				generation: resolved.generation,
				authorizationMetadataRevision: resolved.authorizationMetadataRevision,
				credentialId: resolved.credentialId,
				materialRevision: resolved.materialRevision,
			};
			if (snapshot({ ...request, ...binding }).kind !== 'current')
				return { kind: 'unavailable', reason: 'stale-write' };
			return {
				...binding,
				accessToken: new TextEncoder().encode(credential.accessToken),
				allowedHosts: props.allowedHostsByApplication[applicationId],
				gmailNoSend:
					!request.gmailWriteAllowed || !resolved.selectedGroupIds.includes('gmail.write'),
				kind: 'ready',
			};
		},
	};
}
