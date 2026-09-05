import {
	googleOAuthApplicationIdSchema,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import {
	oauthAccountProfileIdSchema,
	oauthApplicationIdSchema,
	oauthServiceIdSchema,
	type OAuthAccountProfileId,
	type OAuthApplicationId,
	type OAuthCredentialId,
	type OAuthMaterialRevision,
	type OAuthMinimumPermission,
	type OAuthServiceId,
	type OAuthToolAvailability,
	type OAuthToolRequirement,
} from '@agent-vm/oauth-broker-contracts';

import { type OAuthKeyEncryptionKey } from '../envelope-codec.js';
import { type OAuthCredentialCatalog } from '../oauth-credential-catalog-contracts.js';
import { type GoogleCredentialRefreshCoordinator } from './google-credential-refresh-coordinator.js';
import { type GoogleWebClientCredentials } from './google-oauth-adapter.js';
import {
	type GoogleOAuthRuntimeCredentialResolution,
	type GoogleOAuthRuntimeCredentialSnapshotValidation,
} from './google-oauth-broker-contracts.js';
import {
	googleOAuthPermissionRank,
	requiredGoogleScopesForServicePermission,
} from './google-oauth-permission-policy.js';

const googleRuntimeAllowedHostsByApplication = {
	'gmail-app': ['gmail.googleapis.com'],
	'workspace-app': [
		'calendar.googleapis.com',
		'docs.googleapis.com',
		'drive.googleapis.com',
		'forms.googleapis.com',
		'people.googleapis.com',
		'sheets.googleapis.com',
		'slides.googleapis.com',
		'www.googleapis.com',
	],
	'youtube-app': ['youtube.googleapis.com', 'www.googleapis.com'],
} as const satisfies Readonly<Record<GoogleOAuthApplicationId, readonly string[]>>;

type GoogleOAuthAccountProfile =
	OAuthConfig['agents'][string]['accountProfiles'][OAuthAccountProfileId];

export interface GoogleRuntimeCredentialPolicy {
	resolveRuntimeCredential(props: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly applicationId: OAuthApplicationId;
		readonly minimumPermission: OAuthMinimumPermission;
		readonly serviceId: string;
	}): Promise<GoogleOAuthRuntimeCredentialResolution>;
	resolveToolAvailability(props: {
		readonly agentId: string;
		readonly requirement: Extract<OAuthToolRequirement, { readonly kind: 'oauth-account-profile' }>;
	}): OAuthToolAvailability;
	validateRuntimeCredentialSnapshot(props: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly applicationId: OAuthApplicationId;
		readonly credentialId: OAuthCredentialId;
		readonly materialRevision: OAuthMaterialRevision;
		readonly minimumPermission: OAuthMinimumPermission;
		readonly serviceId: OAuthServiceId;
	}): GoogleOAuthRuntimeCredentialSnapshotValidation;
}

export function createGoogleRuntimeCredentialPolicy(props: {
	readonly catalog: OAuthCredentialCatalog;
	readonly clientCredentialsByApplication: Readonly<
		Record<GoogleOAuthApplicationId, GoogleWebClientCredentials>
	>;
	readonly config: OAuthConfig;
	readonly isAdmissionOpen: () => boolean;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	readonly keyEncryptionKeyVersion: number;
	readonly providerSignal: AbortSignal;
	readonly refreshCoordinator: GoogleCredentialRefreshCoordinator;
	readonly requireAccountProfile: (
		agentId: string,
		accountProfileId: OAuthAccountProfileId,
	) => GoogleOAuthAccountProfile;
	readonly requireAgent: (agentId: string) => OAuthConfig['agents'][string];
	readonly zoneId: string;
}): GoogleRuntimeCredentialPolicy {
	const resolveToolAvailability = (availabilityProps: {
		readonly agentId: string;
		readonly requirement: Extract<OAuthToolRequirement, { readonly kind: 'oauth-account-profile' }>;
	}): OAuthToolAvailability => {
		const agent = props.requireAgent(availabilityProps.agentId);
		const applicationId = googleOAuthApplicationIdSchema.safeParse(
			availabilityProps.requirement.applicationId,
		);
		if (!applicationId.success) return { kind: 'scope-insufficient' };
		const service =
			props.config.providers.google.applications[applicationId.data].services[
				availabilityProps.requirement.serviceId
			];
		if (service === undefined) return { kind: 'scope-insufficient' };
		const requiredScopes = requiredGoogleScopesForServicePermission({
			minimumPermission: availabilityProps.requirement.minimumPermission,
			readScopes: service.read,
			writeScopes: service.write,
		});
		if (requiredScopes.length === 0) return { kind: 'scope-insufficient' };
		const readyAccountProfiles: {
			readonly accountLabel: string;
			readonly accountProfileId: OAuthAccountProfileId;
		}[] = [];
		let eligibleProfileMissingGrant = false;
		let reauthorizationRequired = false;
		let scopeInsufficient = false;
		let authorizationStatusUnavailable = false;
		for (const [accountProfileId, accountProfile] of Object.entries(agent.accountProfiles)) {
			const maximumPermission =
				accountProfile.applications[applicationId.data]?.maximumPermissions[
					availabilityProps.requirement.serviceId
				];
			if (
				maximumPermission === undefined ||
				googleOAuthPermissionRank(maximumPermission) <
					googleOAuthPermissionRank(availabilityProps.requirement.minimumPermission)
			) {
				continue;
			}
			const parsedAccountProfileId = oauthAccountProfileIdSchema.parse(accountProfileId);
			const grant = props.catalog.getGrantForAccountApplication({
				accountProfileId: parsedAccountProfileId,
				agentId: availabilityProps.agentId,
				applicationId: oauthApplicationIdSchema.parse(applicationId.data),
				zoneId: props.zoneId,
			});
			if (grant === undefined) {
				eligibleProfileMissingGrant = true;
				continue;
			}
			if (grant.lifecycleKind === 'reauthorization-required') {
				reauthorizationRequired = true;
				continue;
			}
			if (grant.lifecycleKind === 'degraded') {
				authorizationStatusUnavailable = true;
				continue;
			}
			if (!requiredScopes.every((scope) => grant.grantedScopes.includes(scope))) {
				scopeInsufficient = true;
				continue;
			}
			readyAccountProfiles.push({
				accountLabel: grant.accountLabel,
				accountProfileId: parsedAccountProfileId,
			});
		}
		if (readyAccountProfiles.length > 0) {
			return {
				accountProfiles: readyAccountProfiles.toSorted((left, right) =>
					left.accountProfileId.localeCompare(right.accountProfileId),
				),
				kind: 'ready',
			};
		}
		if (reauthorizationRequired) return { kind: 'reauthorization-required' };
		if (authorizationStatusUnavailable) return { kind: 'authorization-status-unavailable' };
		if (scopeInsufficient) return { kind: 'scope-insufficient' };
		return eligibleProfileMissingGrant
			? { kind: 'authorization-required' }
			: { kind: 'scope-insufficient' };
	};

	return {
		resolveRuntimeCredential: async (
			runtimeProps,
		): Promise<GoogleOAuthRuntimeCredentialResolution> => {
			const applicationId = googleOAuthApplicationIdSchema.parse(runtimeProps.applicationId);
			const serviceId = oauthServiceIdSchema.parse(runtimeProps.serviceId);
			const profile = props.requireAccountProfile(
				runtimeProps.agentId,
				runtimeProps.accountProfileId,
			);
			const maximumPermission = profile.applications[applicationId]?.maximumPermissions[serviceId];
			if (
				maximumPermission === undefined ||
				googleOAuthPermissionRank(maximumPermission) <
					googleOAuthPermissionRank(runtimeProps.minimumPermission)
			) {
				return { kind: 'unavailable', reason: 'scope-insufficient' };
			}
			const service = props.config.providers.google.applications[applicationId].services[serviceId];
			if (service === undefined) return { kind: 'unavailable', reason: 'scope-insufficient' };
			const requiredScopes = requiredGoogleScopesForServicePermission({
				minimumPermission: runtimeProps.minimumPermission,
				readScopes: service.read,
				writeScopes: service.write,
			});
			if (requiredScopes.length === 0) {
				return { kind: 'unavailable', reason: 'scope-insufficient' };
			}
			const grant = props.catalog.getGrantForAccountApplication({
				accountProfileId: runtimeProps.accountProfileId,
				agentId: runtimeProps.agentId,
				applicationId: oauthApplicationIdSchema.parse(applicationId),
				zoneId: props.zoneId,
			});
			if (grant === undefined) return { kind: 'unavailable', reason: 'authorization-missing' };
			const credential = await props.refreshCoordinator.resolveAccessToken({
				clientCredentials: props.clientCredentialsByApplication[applicationId],
				grant,
				keyEncryptionKey: props.keyEncryptionKey,
				keyEncryptionKeyVersion: props.keyEncryptionKeyVersion,
				requiredScopes,
				signal: props.providerSignal,
			});
			if (credential.kind !== 'ready') {
				return {
					kind: 'unavailable',
					reason:
						credential.kind === 'degraded'
							? 'degraded'
							: credential.kind === 'reauthorization-required'
								? 'reauthorization-required'
								: credential.kind,
				};
			}
			return {
				accessToken: new TextEncoder().encode(credential.accessToken),
				allowedHosts: googleRuntimeAllowedHostsByApplication[applicationId],
				credentialId: credential.grant.credentialId,
				kind: 'ready',
				materialRevision: credential.grant.materialRevision,
			};
		},
		resolveToolAvailability,
		validateRuntimeCredentialSnapshot: (
			runtimeProps,
		): GoogleOAuthRuntimeCredentialSnapshotValidation => {
			if (!props.isAdmissionOpen()) {
				return { kind: 'stale', reason: 'credential-unavailable' };
			}
			const applicationId = googleOAuthApplicationIdSchema.parse(runtimeProps.applicationId);
			const serviceId = oauthServiceIdSchema.parse(runtimeProps.serviceId);
			let profile: GoogleOAuthAccountProfile;
			try {
				profile = props.requireAccountProfile(runtimeProps.agentId, runtimeProps.accountProfileId);
			} catch {
				return { kind: 'stale', reason: 'account-policy-changed' };
			}
			const maximumPermission = profile.applications[applicationId]?.maximumPermissions[serviceId];
			if (
				maximumPermission === undefined ||
				googleOAuthPermissionRank(maximumPermission) <
					googleOAuthPermissionRank(runtimeProps.minimumPermission)
			) {
				return { kind: 'stale', reason: 'account-policy-changed' };
			}
			const service = props.config.providers.google.applications[applicationId].services[serviceId];
			if (service === undefined) return { kind: 'stale', reason: 'account-policy-changed' };
			const requiredScopes = requiredGoogleScopesForServicePermission({
				minimumPermission: runtimeProps.minimumPermission,
				readScopes: service.read,
				writeScopes: service.write,
			});
			if (requiredScopes.length === 0) return { kind: 'stale', reason: 'scope-insufficient' };
			const grant = props.catalog.getGrantForAccountApplication({
				accountProfileId: runtimeProps.accountProfileId,
				agentId: runtimeProps.agentId,
				applicationId: oauthApplicationIdSchema.parse(applicationId),
				zoneId: props.zoneId,
			});
			if (grant === undefined || grant.lifecycleKind !== 'active') {
				return { kind: 'stale', reason: 'credential-unavailable' };
			}
			if (
				grant.credentialId !== runtimeProps.credentialId ||
				grant.materialRevision !== runtimeProps.materialRevision
			) {
				return { kind: 'stale', reason: 'credential-changed' };
			}
			if (!requiredScopes.every((scope) => grant.grantedScopes.includes(scope))) {
				return { kind: 'stale', reason: 'scope-insufficient' };
			}
			return { kind: 'current' };
		},
	};
}
