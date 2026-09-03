import {
	googleOAuthApplicationIdSchema,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import {
	oauthApplicationIdSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
	oauthServiceIdSchema,
	type OAuthAccountProfileId,
	type OAuthMinimumPermission,
	type OAuthPermissionChoice,
	type OAuthPermissionSelections,
	type OAuthScope,
	type OAuthServiceId,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

type GoogleOAuthAccountProfile =
	OAuthConfig['agents'][string]['accountProfiles'][OAuthAccountProfileId];

export function googleOAuthPermissionRank(permission: OAuthPermissionChoice): number {
	switch (permission) {
		case 'none':
			return 0;
		case 'read':
			return 1;
		case 'write':
			return 2;
	}
}

export function requiredGoogleScopesForServicePermission(props: {
	readonly minimumPermission: OAuthMinimumPermission;
	readonly readScopes: readonly OAuthScope[];
	readonly writeScopes?: readonly OAuthScope[] | undefined;
}): readonly OAuthScope[] {
	if (
		props.minimumPermission === 'write' &&
		(props.writeScopes === undefined || props.writeScopes.length === 0)
	) {
		return [];
	}
	const requiredScopes =
		props.minimumPermission === 'read'
			? props.readScopes
			: [...props.readScopes, ...(props.writeScopes ?? [])];
	return z
		.array(oauthScopeSchema)
		.readonly()
		.parse([...new Set(requiredScopes)].toSorted());
}

export function googleApplicationSelections(
	selections: OAuthPermissionSelections,
	applicationId: string,
): Readonly<Record<OAuthServiceId, OAuthPermissionChoice>> | undefined {
	return selections[oauthApplicationIdSchema.parse(applicationId)];
}

export interface GoogleOAuthPermissionPolicy {
	completeSelections(props: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly selections: OAuthPermissionSelections;
	}): OAuthPermissionSelections;
	scopesForApplication(
		applicationId: GoogleOAuthApplicationId,
		selections: OAuthPermissionSelections,
	): readonly OAuthScope[];
	validateSelections(props: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly selections: OAuthPermissionSelections;
	}): OAuthPermissionSelections;
}

export function createGoogleOAuthPermissionPolicy(props: {
	readonly config: OAuthConfig;
	readonly requireAccountProfile: (
		agentId: string,
		accountProfileId: OAuthAccountProfileId,
	) => GoogleOAuthAccountProfile;
}): GoogleOAuthPermissionPolicy {
	const validateSelections = (selectionProps: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly selections: OAuthPermissionSelections;
	}): OAuthPermissionSelections => {
		const profile = props.requireAccountProfile(
			selectionProps.agentId,
			selectionProps.accountProfileId,
		);
		const selections = oauthPermissionSelectionsSchema.parse(selectionProps.selections);
		for (const [applicationId, serviceSelections] of Object.entries(selections)) {
			const parsedApplicationId = googleOAuthApplicationIdSchema.safeParse(applicationId);
			if (!parsedApplicationId.success) {
				throw new Error(`Unknown Google OAuth application "${applicationId}".`);
			}
			const maximums = profile.applications[parsedApplicationId.data]?.maximumPermissions;
			if (maximums === undefined) {
				throw new Error(
					`OAuth application "${applicationId}" is not assigned to this account profile.`,
				);
			}
			for (const [serviceId, selection] of Object.entries(serviceSelections)) {
				const maximum = maximums[oauthServiceIdSchema.parse(serviceId)];
				if (
					maximum === undefined ||
					googleOAuthPermissionRank(selection) > googleOAuthPermissionRank(maximum)
				) {
					throw new Error(
						`OAuth selection exceeds the authored maximum for ${applicationId}/${serviceId}.`,
					);
				}
			}
		}
		return selections;
	};

	return {
		completeSelections: (selectionProps): OAuthPermissionSelections => {
			const profile = props.requireAccountProfile(
				selectionProps.agentId,
				selectionProps.accountProfileId,
			);
			const validated = validateSelections(selectionProps);
			return oauthPermissionSelectionsSchema.parse(
				Object.fromEntries(
					Object.entries(profile.applications).map(([applicationId, applicationMaximum]) => [
						applicationId,
						Object.fromEntries(
							Object.keys(applicationMaximum.maximumPermissions).map((serviceId) => [
								serviceId,
								googleApplicationSelections(validated, applicationId)?.[
									oauthServiceIdSchema.parse(serviceId)
								] ?? 'none',
							]),
						),
					]),
				),
			);
		},
		scopesForApplication: (applicationId, selections): readonly OAuthScope[] => {
			const application = props.config.providers.google.applications[applicationId];
			const serviceSelections = selections[oauthApplicationIdSchema.parse(applicationId)] ?? {};
			const scopes = Object.entries(serviceSelections).flatMap(([serviceId, permission]) => {
				if (permission === 'none') return [];
				const service = application.services[oauthServiceIdSchema.parse(serviceId)];
				if (service === undefined) {
					throw new Error(`Unknown service "${serviceId}" for ${applicationId}.`);
				}
				return requiredGoogleScopesForServicePermission({
					minimumPermission: permission,
					readScopes: service.read,
					writeScopes: service.write,
				});
			});
			return z
				.array(oauthScopeSchema)
				.readonly()
				.parse([...new Set(scopes)].toSorted());
		},
		validateSelections,
	};
}
