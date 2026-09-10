import { googleOAuthApplicationIdSchema, type OAuthConfig } from '@agent-vm/config-contracts';
import type { GoogleOAuthApplicationId } from '@agent-vm/config-contracts';
import {
	oauthApplicationIdSchema,
	oauthAuthorizationActionResultSchema,
	type OAuthApplicationId,
	type OAuthAuthorizationActionResult,
	type OAuthCredentialLifecycleState,
	type OAuthPermissionSelections,
	type OAuthAccountActivityAvailability,
} from '@agent-vm/oauth-broker-contracts';

import { type OAuthKeyEncryptionKey } from '../envelope-codec.js';
import {
	oauthStoredGrantSchema,
	type OAuthCredentialCatalog,
	type OAuthStoredAuthorization,
	type OAuthStoredGrant,
} from '../oauth-credential-catalog-contracts.js';
import { type OAuthCeremonyTransaction } from '../oauth-transaction-store.js';
import {
	decryptGoogleCredentialPayload,
	type GoogleStoredCredentialPayload,
} from './google-credential-payload.js';
import { getGoogleGogCommandDescriptors } from './google-gog-command-catalog.js';
import type { GoogleWebClientCredentials } from './google-oauth-adapter.js';
import {
	type GoogleOAuthAccountActivityReader,
	type GoogleOAuthApplicationProgress,
	type GoogleOAuthPermissionPageData,
} from './google-oauth-broker-contracts.js';
import {
	type GoogleOAuthPermissionPolicy,
	type GoogleOfferedPermissionGroups,
} from './google-oauth-permission-policy.js';
import { evaluateGoogleOperationGrant } from './google-operation-grant-policy.js';
import { getGooglePermissionGroups } from './google-permission-catalog.js';

export interface GoogleAuthorizationViewModels {
	applicationProgress(props: {
		readonly authorizingApplication: OAuthApplicationId;
		readonly completedApplications: readonly OAuthApplicationId[];
		readonly remainingApplications: readonly OAuthApplicationId[];
	}): readonly GoogleOAuthApplicationProgress[];
	getPermissionPage(props: {
		readonly transaction: Extract<OAuthCeremonyTransaction, { kind: 'selecting-permissions' }>;
	}): GoogleOAuthPermissionPageData;
	listAuthorizations(agentId: string): OAuthAuthorizationActionResult;
}
function lifecycle(
	authorization: OAuthStoredAuthorization,
	now: number,
): OAuthCredentialLifecycleState {
	if (authorization.lifecycleKind === 'active') return { kind: 'active' };
	if (authorization.lifecycleKind === 'degraded')
		return {
			kind: 'degraded',
			failureClass: authorization.failureClass ?? 'provider-unavailable',
			nextRefreshEligibleAt: new Date(authorization.nextRefreshEligibleAtMs ?? now).toISOString(),
		};
	return {
		kind: 'reauthorization-required',
		reason:
			authorization.reauthorizationReason === 'invalid-grant'
				? 'invalid-grant'
				: authorization.reauthorizationReason === 'scope-insufficient'
					? 'scope-insufficient'
					: 'credential-corrupt',
	};
}
export function createGoogleAuthorizationViewModels(props: {
	readonly catalog: OAuthCredentialCatalog;
	readonly config: OAuthConfig;
	readonly now: () => number;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	readonly permissionPolicy: GoogleOAuthPermissionPolicy;
	readonly offeredGroupIdsByAgentApplication: GoogleOfferedPermissionGroups;
	readonly recommendationSelectionsByAgent: Readonly<Record<string, OAuthPermissionSelections>>;
	readonly operationIdsByAgent: Readonly<Record<string, readonly string[]>>;
	readonly readAccountActivity: GoogleOAuthAccountActivityReader;
	readonly clientCredentialsByApplication: Readonly<
		Record<GoogleOAuthApplicationId, GoogleWebClientCredentials>
	>;
	readonly clientBindingRevisionsByApplication: Readonly<Record<GoogleOAuthApplicationId, string>>;
}): GoogleAuthorizationViewModels {
	const groups = getGooglePermissionGroups();
	const operations = getGoogleGogCommandDescriptors();
	const label = (applicationId: OAuthApplicationId): string =>
		props.config.providers.google.applications[googleOAuthApplicationIdSchema.parse(applicationId)]
			.label;
	const readableGrant = (
		authorization: OAuthStoredAuthorization,
	):
		| { readonly grant: OAuthStoredGrant; readonly payload: GoogleStoredCredentialPayload }
		| undefined => {
		if (authorization.accessState !== 'connected') return undefined;
		try {
			const grant = oauthStoredGrantSchema.strip().parse(authorization);
			const payload = decryptGoogleCredentialPayload({
				grant,
				keyEncryptionKey: props.keyEncryptionKey,
			});
			return { grant, payload };
		} catch {
			return undefined;
		}
	};
	const activityAvailability = (
		grant: OAuthStoredGrant,
		operationId: string,
	): OAuthAccountActivityAvailability => {
		try {
			const applicationId = googleOAuthApplicationIdSchema.parse(grant.applicationId);
			if (
				grant.clientId !== props.clientCredentialsByApplication[applicationId].web.client_id ||
				grant.clientBindingRevision !== props.clientBindingRevisionsByApplication[applicationId] ||
				grant.catalogVersion !== props.config.providers.google.catalogVersion ||
				grant.owner.issuer !== props.config.browser.identity.issuer ||
				!Object.values(props.config.owners).some(
					(owner) =>
						owner.clerkUserId === grant.owner.userId &&
						owner.allowedAgentIds.includes(grant.agentId),
				)
			)
				return { kind: 'unavailable' };
			props.permissionPolicy.validateSelections({
				agentId: grant.agentId,
				selections: { [grant.applicationId]: grant.selectedGroupIds },
			});
			const local = props.readAccountActivity({
				agentId: grant.agentId,
				accountId: grant.accountId,
				applicationId: grant.applicationId,
				operationId,
			});
			if (local.kind === 'denied' || local.kind === 'unavailable') return local;
			const permission = evaluateGoogleOperationGrant({
				operationId,
				selectedGroupIds: grant.selectedGroupIds,
				ceiling: props.offeredGroupIdsByAgentApplication[grant.agentId]?.[applicationId] ?? [],
				actualScopes: grant.grantedScopes,
			});
			return permission.kind === 'admitted'
				? local
				: permission.kind === 'consent-required'
					? { kind: 'consent-required' }
					: { kind: 'unavailable' };
		} catch {
			return { kind: 'unavailable' };
		}
	};
	return {
		applicationProgress: (progress) => [
			...progress.completedApplications.map((applicationId) => ({
				applicationId,
				label: label(applicationId),
				status: 'completed' as const,
			})),
			{
				applicationId: progress.authorizingApplication,
				label: label(progress.authorizingApplication),
				status: 'authorizing' as const,
			},
			...progress.remainingApplications.map((applicationId) => ({
				applicationId,
				label: label(applicationId),
				status: 'pending' as const,
			})),
		],
		getPermissionPage: ({ transaction }): GoogleOAuthPermissionPageData => {
			const identity = transaction.identity;
			const owner = Object.values(props.config.owners).find(
				(entry) =>
					entry.clerkUserId === identity?.userId &&
					entry.allowedAgentIds.includes(transaction.agentId),
			);
			if (identity?.issuer !== props.config.browser.identity.issuer || owner === undefined)
				throw new Error('OAuth browser owner is not admitted.');
			const target = transaction.target;
			const accountBinding = target.kind === 'enroll' ? target.accountBinding : target;
			const existing =
				accountBinding === undefined
					? undefined
					: props.catalog.getAuthorizationForAccountApplication({
							accountId: accountBinding.accountId,
							agentId: transaction.agentId,
							applicationId: target.applicationId,
							zoneId: props.config.zoneId,
						});
			const readable = existing === undefined ? undefined : readableGrant(existing);
			return {
				agentId: transaction.agentId,
				ownerLabel: owner.label,
				intent: target.kind,
				accountAlias: readable?.payload.authority.accountAlias,
				suggestedAlias: transaction.suggestedAlias,
				accountId: accountBinding?.accountId,
				applications: transaction.applicationIds.map((id) => {
					const applicationId = googleOAuthApplicationIdSchema.parse(id);
					const application = props.config.providers.google.applications[applicationId];
					const recommendedGroupIds =
						props.recommendationSelectionsByAgent[transaction.agentId]?.[id] ?? [];
					const offered = new Set(
						props.offeredGroupIdsByAgentApplication[transaction.agentId]?.[applicationId] ?? [],
					);
					return {
						applicationId,
						description: application.description,
						label: application.label,
						recommendedGroupIds,
						suggestedGroupIds: transaction.suggestedSelections?.[id],
						selectedGroupIds:
							target.kind === 'disconnect'
								? []
								: readable?.grant.applicationId === id
									? readable.payload.authority.selectedGroupIds
									: target.applicationId === id
										? recommendedGroupIds
										: [],
						groups: groups
							.filter((group) => group.familyId === application.catalogFamilyId)
							.map((group) => ({
								groupId: group.groupId,
								serviceId: group.serviceId,
								effect: group.effect,
								label: group.label,
								warning: group.warning,
								offered: offered.has(group.groupId),
							})),
					};
				}),
				browserBindingSecret: transaction.browserBindingSecret,
				csrfToken: transaction.csrfSecret,
				expiresAtMs: transaction.expiresAtMs,
				transactionId: transaction.transactionId,
			};
		},
		listAuthorizations: (agentId): OAuthAuthorizationActionResult => {
			if (props.config.agents[agentId] === undefined)
				throw new Error('OAuth agent is not configured.');
			const authorizations = props.catalog.listAuthorizationsForAgent({
				agentId,
				zoneId: props.config.zoneId,
			});
			const accountIds = [
				...new Set(authorizations.map((authorization) => authorization.accountId)),
			];
			return oauthAuthorizationActionResultSchema.parse({
				kind: 'authorization-list',
				authorizationOptions: Object.entries(
					props.offeredGroupIdsByAgentApplication[agentId] ?? {},
				).flatMap(([id, offeredGroups]) => {
					if (offeredGroups.length === 0) return [];
					const applicationId = googleOAuthApplicationIdSchema.parse(id);
					const offered = groups.filter((group) => offeredGroups.includes(group.groupId));
					return [
						{
							applicationId,
							applicationLabel: label(oauthApplicationIdSchema.parse(id)),
							services: [...new Set(offered.map((group) => group.serviceId))].map((serviceId) => ({
								serviceId,
								serviceLabel: serviceId,
								groups: offered
									.filter((group) => group.serviceId === serviceId)
									.map((group) => ({
										groupId: group.groupId,
										label: group.label,
										effect: group.effect,
										scopeDescriptions: [group.warning],
									})),
							})),
						},
					];
				}),
				accounts: accountIds.map((accountId) => ({
					accountId,
					applications: authorizations
						.filter((authorization) => authorization.accountId === accountId)
						.map((authorization) => {
							const readable = readableGrant(authorization);
							const applicationId = googleOAuthApplicationIdSchema.parse(
								authorization.applicationId,
							);
							const usable =
								readable !== undefined &&
								authorization.accessState === 'connected' &&
								authorization.lifecycleKind === 'active';
							return {
								applicationId,
								applicationLabel: label(authorization.applicationId),
								accessState: authorization.accessState,
								lifecycle: lifecycle(authorization, props.now()),
								metadata:
									readable === undefined
										? { kind: 'unavailable' }
										: {
												kind: 'verified',
												accountAlias: readable.payload.authority.accountAlias,
												confirmedGroupIds: readable.payload.authority.selectedGroupIds,
												grantedScopes: readable.payload.authority.grantedScopes,
												scopeDescriptions: groups
													.filter((group) =>
														readable.payload.authority.selectedGroupIds.includes(group.groupId),
													)
													.map((group) => group.warning),
											},
								activities: operations
									.filter(
										(operation) =>
											operation.familyId ===
												props.config.providers.google.applications[applicationId].catalogFamilyId &&
											props.operationIdsByAgent[agentId]?.includes(operation.operationId),
									)
									.map((operation) => ({
										operationId: operation.operationId,
										availability:
											usable && readable !== undefined
												? activityAvailability(readable.grant, operation.operationId)
												: { kind: 'unavailable' },
									})),
							};
						}),
				})),
			});
		},
	};
}
