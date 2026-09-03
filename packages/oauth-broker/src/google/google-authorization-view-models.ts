import { googleOAuthApplicationIdSchema, type OAuthConfig } from '@agent-vm/config-contracts';
import {
	oauthAccountProfileIdSchema,
	oauthAuthorizationActionResultSchema,
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthServiceIdSchema,
	type OAuthAccountProfileId,
	type OAuthApplicationId,
	type OAuthAuthorizationActionResult,
} from '@agent-vm/oauth-broker-contracts';

import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import { type OAuthCeremonyTransaction } from '../oauth-transaction-store.js';
import {
	type GoogleOAuthApplicationProgress,
	type GoogleOAuthPermissionPageData,
} from './google-oauth-broker-contracts.js';
import { googleApplicationSelections } from './google-oauth-permission-policy.js';

type GoogleOAuthAgent = OAuthConfig['agents'][string];
type GoogleOAuthAccountProfile = GoogleOAuthAgent['accountProfiles'][OAuthAccountProfileId];

export interface GoogleAuthorizationViewModels {
	applicationProgress(props: {
		readonly authorizingApplication: OAuthApplicationId;
		readonly completedApplications: readonly OAuthApplicationId[];
		readonly remainingApplications: readonly OAuthApplicationId[];
	}): readonly GoogleOAuthApplicationProgress[];
	getPermissionPage(props: {
		readonly transaction: Extract<
			OAuthCeremonyTransaction,
			{ readonly kind: 'selecting-permissions' }
		>;
	}): GoogleOAuthPermissionPageData;
	listAuthorizations(agentId: string): OAuthAuthorizationActionResult;
}

export function createGoogleAuthorizationViewModels(props: {
	readonly catalog: OAuthCredentialCatalog;
	readonly config: OAuthConfig;
	readonly now: () => number;
	readonly requireAccountProfile: (
		agentId: string,
		accountProfileId: OAuthAccountProfileId,
	) => GoogleOAuthAccountProfile;
	readonly requireAgent: (agentId: string) => GoogleOAuthAgent;
	readonly zoneId: string;
}): GoogleAuthorizationViewModels {
	return {
		applicationProgress: (progressProps): readonly GoogleOAuthApplicationProgress[] => [
			...progressProps.completedApplications.map(
				(applicationId) =>
					({
						applicationId,
						label:
							props.config.providers.google.applications[
								googleOAuthApplicationIdSchema.parse(applicationId)
							].label,
						status: 'completed',
					}) satisfies GoogleOAuthApplicationProgress,
			),
			{
				applicationId: progressProps.authorizingApplication,
				label:
					props.config.providers.google.applications[
						googleOAuthApplicationIdSchema.parse(progressProps.authorizingApplication)
					].label,
				status: 'authorizing',
			},
			...progressProps.remainingApplications.map(
				(applicationId) =>
					({
						applicationId,
						label:
							props.config.providers.google.applications[
								googleOAuthApplicationIdSchema.parse(applicationId)
							].label,
						status: 'pending',
					}) satisfies GoogleOAuthApplicationProgress,
			),
		],
		getPermissionPage: ({ transaction }): GoogleOAuthPermissionPageData => {
			const profile = props.requireAccountProfile(
				transaction.agentId,
				transaction.accountProfileId,
			);
			return {
				accountProfileLabel: transaction.accountProfileId,
				applications: Object.entries(profile.applications)
					.filter(([applicationId]) =>
						transaction.applicationIds.includes(oauthApplicationIdSchema.parse(applicationId)),
					)
					.map(([applicationId, maximum]) => {
						const parsedApplicationId = googleOAuthApplicationIdSchema.parse(applicationId);
						const application = props.config.providers.google.applications[parsedApplicationId];
						return {
							applicationId: parsedApplicationId,
							description: application.description,
							label: application.label,
							services: Object.entries(maximum.maximumPermissions).map(
								([serviceId, maximumPermission]) => {
									const parsedServiceId = oauthServiceIdSchema.parse(serviceId);
									const suggestedChoice = googleApplicationSelections(
										transaction.suggestedSelections ?? oauthPermissionSelectionsSchema.parse({}),
										parsedApplicationId,
									)?.[parsedServiceId];
									const serviceView: GoogleOAuthPermissionPageData['applications'][number]['services'][number] =
										{
											allowedChoices:
												maximumPermission === 'write'
													? ['none', 'read', 'write']
													: ['none', 'read'],
											label: application.services[parsedServiceId]?.label ?? serviceId,
											selectedChoice: suggestedChoice ?? 'none',
											serviceId,
										};
									if (suggestedChoice !== undefined) {
										Object.assign(serviceView, { suggestedChoice });
									}
									return serviceView;
								},
							),
						};
					}),
				browserBindingSecret: transaction.browserBindingSecret,
				csrfToken: transaction.csrfSecret,
				expiresAtMs: transaction.expiresAtMs,
				transactionId: transaction.transactionId,
			};
		},
		listAuthorizations: (agentId): OAuthAuthorizationActionResult => {
			const agent = props.requireAgent(agentId);
			const grants = props.catalog.listGrantsForAgent({ agentId, zoneId: props.zoneId });
			return oauthAuthorizationActionResultSchema.parse({
				kind: 'authorization-list',
				profiles: Object.entries(agent.accountProfiles).map(([accountProfileId, profile]) => {
					const profileGrants = grants.filter(
						(grant) => grant.accountProfileId === accountProfileId,
					);
					const profileMetadata = props.catalog.getAccountProfileMetadata({
						accountProfileId: oauthAccountProfileIdSchema.parse(accountProfileId),
						agentId,
						zoneId: props.zoneId,
					});
					const profileView = {
						accountProfileId,
						applications: profileGrants.map((grant) => ({
							applicationId: grant.applicationId,
							grantedScopes: grant.grantedScopes,
							lifecycle:
								grant.lifecycleKind === 'active'
									? { kind: 'active' }
									: grant.lifecycleKind === 'degraded'
										? {
												failureClass: grant.failureClass ?? 'provider-unavailable',
												kind: 'degraded',
												nextRefreshEligibleAt: new Date(
													grant.nextRefreshEligibleAtMs ?? props.now(),
												).toISOString(),
											}
										: {
												kind: 'reauthorization-required',
												reason:
													grant.reauthorizationReason === 'invalid-grant'
														? 'invalid-grant'
														: grant.reauthorizationReason === 'revoked'
															? 'revoked'
															: grant.reauthorizationReason === 'scope-insufficient'
																? 'scope-insufficient'
																: 'credential-corrupt',
											},
						})),
						authorizationOptions: Object.entries(profile.applications).map(
							([applicationId, applicationMaximum]) => {
								const parsedApplicationId = googleOAuthApplicationIdSchema.parse(applicationId);
								const application = props.config.providers.google.applications[parsedApplicationId];
								return {
									applicationId: parsedApplicationId,
									applicationLabel: application.label,
									services: Object.entries(applicationMaximum.maximumPermissions).map(
										([serviceId, maximumPermission]) => {
											const parsedServiceId = oauthServiceIdSchema.parse(serviceId);
											const service = application.services[parsedServiceId];
											if (service === undefined) {
												throw new Error(
													`OAuth service "${serviceId}" is not configured for application "${applicationId}".`,
												);
											}
											return {
												maximumPermission,
												serviceId: parsedServiceId,
												serviceLabel: service.label,
											};
										},
									),
								};
							},
						),
						kind:
							profileMetadata === undefined
								? 'unbound'
								: profileGrants.length === Object.keys(profile.applications).length
									? 'enrolled'
									: 'partially-enrolled',
					};
					if (profileMetadata !== undefined) {
						Object.assign(profileView, { accountLabel: profileMetadata.accountLabel });
					}
					return profileView;
				}),
			});
		},
	};
}
