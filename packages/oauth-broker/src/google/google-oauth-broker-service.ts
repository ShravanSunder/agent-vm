import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
	googleOAuthApplicationIdSchema,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import {
	oauthAccountProfileIdSchema,
	oauthAuthorizationActionRequestSchema,
	oauthAuthorizationActionResultSchema,
	oauthApplicationIdSchema,
	oauthCompletionSessionIdSchema,
	oauthCredentialIdSchema,
	oauthMaterialRevisionSchema,
	oauthPermissionSelectionsSchema,
	oauthScopeSchema,
	oauthServiceIdSchema,
	oauthProviderIdSchema,
	type OAuthAccountProfileId,
	type OAuthApplicationId,
	type OAuthAuthorizationActionRequest,
	type OAuthAuthorizationActionResult,
	type OAuthMaterialRevision,
	type OAuthMinimumPermission,
	type OAuthPermissionChoice,
	type OAuthPermissionSelections,
	type OAuthScope,
	type OAuthServiceId,
	type OAuthToolAvailability,
	type OAuthToolRequirement,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import {
	createOAuthEnvelopeCodec,
	oauthEnvelopeBindingSchema,
	type OAuthKeyEncryptionKey,
} from '../envelope-codec.js';
import { type OAuthCredentialCatalog } from '../oauth-credential-catalog.js';
import {
	createOAuthTransactionStore,
	type OAuthCeremonyTransaction,
	type OAuthTransactionStore,
} from '../oauth-transaction-store.js';
import {
	createGoogleCredentialRefreshCoordinator,
	googleStoredCredentialPayloadSchema,
} from './google-credential-refresh-coordinator.js';
import {
	googleIdentityScopes,
	googleProviderAuthorizationSchema,
	type GoogleOAuthAdapter,
	type GoogleProviderAuthorization,
	type GoogleWebClientCredentials,
} from './google-oauth-adapter.js';

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

export interface GoogleOAuthPermissionPageData {
	readonly accountProfileLabel: string;
	readonly applications: readonly {
		readonly applicationId: GoogleOAuthApplicationId;
		readonly description: string;
		readonly label: string;
		readonly services: readonly {
			readonly allowedChoices: readonly OAuthPermissionChoice[];
			readonly label: string;
			readonly selectedChoice: OAuthPermissionChoice;
			readonly serviceId: string;
			readonly suggestedChoice?: OAuthPermissionChoice | undefined;
		}[];
	}[];
	readonly browserBindingSecret: string;
	readonly csrfToken: string;
	readonly transactionId: OAuthTransactionId;
}

export interface GoogleOAuthConfirmationPageData {
	readonly accountLabel: string;
	readonly applicationLabel: string;
	readonly browserBindingSecret: string;
	readonly completionSessionId: string;
	readonly csrfToken: string;
	readonly grantedPermissionLabels: readonly string[];
}

export interface GoogleOAuthApplicationProgress {
	readonly applicationId: OAuthApplicationId;
	readonly label: string;
	readonly status: 'pending' | 'authorizing' | 'completed' | 'failed';
}

export interface GoogleOAuthRedirectResult {
	readonly authorizationUrl: string;
	readonly browserBindingSecret: string;
	readonly kind: 'redirect';
	readonly transactionId: OAuthTransactionId;
}

export type GoogleOAuthPermissionSubmissionResult =
	| { readonly kind: 'already-satisfied' }
	| GoogleOAuthRedirectResult;

export type GoogleOAuthConfirmationResult =
	| { readonly accountLabel: string; readonly kind: 'completed' }
	| {
			readonly applications: readonly GoogleOAuthApplicationProgress[];
			readonly authorizationUrl: string;
			readonly browserBindingSecret: string;
			readonly kind: 'redirect';
			readonly transactionId: OAuthTransactionId;
	  }
	| { readonly kind: 'subject-mismatch' };

export type GoogleOAuthCallbackResult =
	| { readonly confirmation: GoogleOAuthConfirmationPageData; readonly kind: 'confirmation' }
	| {
			readonly completed: readonly string[];
			readonly kind: 'partial-completion';
			readonly retry: GoogleOAuthRedirectResult;
			readonly retryCsrfToken: string;
			readonly retryable: readonly string[];
	  }
	| { readonly kind: 'failed'; readonly reason: string };

export type GoogleOAuthRuntimeCredentialResolution =
	| {
			readonly accessToken: Uint8Array;
			readonly allowedHosts: readonly string[];
			readonly credentialId: string;
			readonly kind: 'ready';
			readonly materialRevision: OAuthMaterialRevision;
	  }
	| {
			readonly kind: 'unavailable';
			readonly reason:
				| 'authorization-missing'
				| 'degraded'
				| 'reauthorization-required'
				| 'scope-insufficient'
				| 'stale-write';
	  };

export interface GoogleOAuthBrokerService {
	cancelBrowserTransaction(props: {
		readonly browserBindingSecret: string;
		readonly csrfToken: string;
		readonly tailnetLogin: string;
		readonly transactionId: OAuthTransactionId;
	}): boolean;
	close(): Promise<void>;
	executeAuthorizationAction(props: {
		readonly agentId: string;
		readonly request: OAuthAuthorizationActionRequest;
	}): Promise<OAuthAuthorizationActionResult>;
	getPermissionPage(props: {
		readonly tailnetLogin: string;
		readonly transactionId: OAuthTransactionId;
	}): GoogleOAuthPermissionPageData;
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
	reapExpiredTransactions(): {
		readonly completionSessionCount: number;
		readonly transactionCount: number;
	};
	retryApplication(props: {
		readonly browserBindingSecret: string;
		readonly csrfToken: string;
		readonly tailnetLogin: string;
		readonly transactionId: OAuthTransactionId;
	}): GoogleOAuthRedirectResult;
	stopAdmission(): void;
	handleGoogleCallback(props: {
		readonly authorizationCode: string;
		readonly browserBindingSecret: string;
		readonly oauthState: string;
		readonly redirectUri: string;
		readonly tailnetLogin: string;
		readonly transactionId: OAuthTransactionId;
	}): Promise<GoogleOAuthCallbackResult>;
	submitPermissions(props: {
		readonly browserBindingSecret: string;
		readonly csrfToken: string;
		readonly selections: OAuthPermissionSelections;
		readonly tailnetLogin: string;
		readonly transactionId: OAuthTransactionId;
	}): GoogleOAuthPermissionSubmissionResult;
	confirmAccount(props: {
		readonly browserBindingSecret: string;
		readonly completionSessionId: string;
		readonly csrfToken: string;
		readonly tailnetLogin: string;
	}): Promise<GoogleOAuthConfirmationResult>;
}

function secretsEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function materialRevision(): OAuthMaterialRevision {
	return oauthMaterialRevisionSchema.parse(`sha256:${randomBytes(32).toString('base64url')}`);
}

function permissionRank(permission: OAuthPermissionChoice): number {
	switch (permission) {
		case 'none':
			return 0;
		case 'read':
			return 1;
		case 'write':
			return 2;
	}
}

function activeTransactionKey(agentId: string, accountProfileId: OAuthAccountProfileId): string {
	return `${agentId}\0${accountProfileId}`;
}

function applicationSelections(
	selections: OAuthPermissionSelections,
	applicationId: string,
): Readonly<Record<OAuthServiceId, OAuthPermissionChoice>> | undefined {
	return selections[oauthApplicationIdSchema.parse(applicationId)];
}

export function createGoogleOAuthBrokerService(props: {
	readonly catalog: OAuthCredentialCatalog;
	readonly clientCredentialsByApplication: Readonly<
		Record<GoogleOAuthApplicationId, GoogleWebClientCredentials>
	>;
	readonly config: OAuthConfig;
	readonly googleAdapter: GoogleOAuthAdapter;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	readonly keyEncryptionKeyVersion: number;
	readonly now?: () => number;
	readonly onCredentialMaterialChanged?: (props: {
		readonly agentId: string;
		readonly zoneId: string;
	}) => Promise<void>;
	readonly transactionStore?: OAuthTransactionStore<GoogleProviderAuthorization>;
	readonly zoneId: string;
}): GoogleOAuthBrokerService {
	const now = props.now ?? Date.now;
	const transactionStore =
		props.transactionStore ??
		createOAuthTransactionStore({
			now,
			providerGrantSchema: googleProviderAuthorizationSchema,
		});
	const activeTransactionIds = new Map<string, OAuthTransactionId>();
	const inFlightOperations = new Set<Promise<unknown>>();
	const providerAbortController = new AbortController();
	let admissionOpen = true;
	const requireAdmission = (): void => {
		if (!admissionOpen) throw new Error('OAuth broker admission is closed.');
	};
	const stopAdmission = (): void => {
		if (!admissionOpen) return;
		admissionOpen = false;
		providerAbortController.abort(new Error('OAuth broker is shutting down.'));
		activeTransactionIds.clear();
	};
	const trackOperation = async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
		requireAdmission();
		const operationPromise = operation();
		inFlightOperations.add(operationPromise);
		try {
			return await operationPromise;
		} finally {
			inFlightOperations.delete(operationPromise);
		}
	};
	const envelopeCodec = createOAuthEnvelopeCodec({
		payloadSchema: googleStoredCredentialPayloadSchema,
	});
	const refreshCoordinator = createGoogleCredentialRefreshCoordinator({
		catalog: props.catalog,
		googleAdapter: props.googleAdapter,
		now,
	});

	const requireAgent = (agentId: string): OAuthConfig['agents'][string] => {
		const agent = props.config.agents[agentId];
		if (agent === undefined) throw new Error(`OAuth agent "${agentId}" is not configured.`);
		return agent;
	};

	const requireAccountProfile = (
		agentId: string,
		accountProfileId: OAuthAccountProfileId,
	): ReturnType<typeof requireAgent>['accountProfiles'][OAuthAccountProfileId] => {
		const profile = requireAgent(agentId).accountProfiles[accountProfileId];
		if (profile === undefined) {
			throw new Error(
				`OAuth account profile "${accountProfileId}" is not assigned to agent "${agentId}".`,
			);
		}
		return profile;
	};

	const validateSelections = (propsForSelections: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly selections: OAuthPermissionSelections;
	}): OAuthPermissionSelections => {
		const profile = requireAccountProfile(
			propsForSelections.agentId,
			propsForSelections.accountProfileId,
		);
		const selections = oauthPermissionSelectionsSchema.parse(propsForSelections.selections);
		for (const [applicationId, serviceSelections] of Object.entries(selections)) {
			const parsedApplicationId = googleOAuthApplicationIdSchema.safeParse(applicationId);
			if (!parsedApplicationId.success)
				throw new Error(`Unknown Google OAuth application "${applicationId}".`);
			const maximums = profile.applications[parsedApplicationId.data]?.maximumPermissions;
			if (maximums === undefined) {
				throw new Error(
					`OAuth application "${applicationId}" is not assigned to this account profile.`,
				);
			}
			for (const [serviceId, selection] of Object.entries(serviceSelections)) {
				const maximum = maximums[oauthServiceIdSchema.parse(serviceId)];
				if (maximum === undefined || permissionRank(selection) > permissionRank(maximum)) {
					throw new Error(
						`OAuth selection exceeds the authored maximum for ${applicationId}/${serviceId}.`,
					);
				}
			}
		}
		return selections;
	};

	const completeSelections = (propsForSelections: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly selections: OAuthPermissionSelections;
	}): OAuthPermissionSelections => {
		const profile = requireAccountProfile(
			propsForSelections.agentId,
			propsForSelections.accountProfileId,
		);
		const validated = validateSelections(propsForSelections);
		return oauthPermissionSelectionsSchema.parse(
			Object.fromEntries(
				Object.entries(profile.applications).map(([applicationId, applicationMaximum]) => [
					applicationId,
					Object.fromEntries(
						Object.keys(applicationMaximum.maximumPermissions).map((serviceId) => [
							serviceId,
							applicationSelections(validated, applicationId)?.[
								oauthServiceIdSchema.parse(serviceId)
							] ?? 'none',
						]),
					),
				]),
			),
		);
	};

	const scopesForApplication = (
		applicationId: GoogleOAuthApplicationId,
		selections: OAuthPermissionSelections,
	): readonly OAuthScope[] => {
		const application = props.config.providers.google.applications[applicationId];
		const parsedApplicationId = oauthApplicationIdSchema.parse(applicationId);
		const serviceSelections = selections[parsedApplicationId] ?? {};
		const scopes = Object.entries(serviceSelections).flatMap(([serviceId, permission]) => {
			if (permission === 'none') return [];
			const service = application.services[oauthServiceIdSchema.parse(serviceId)];
			if (service === undefined)
				throw new Error(`Unknown service "${serviceId}" for ${applicationId}.`);
			return permission === 'read' ? service.read : (service.write ?? []);
		});
		return z
			.array(oauthScopeSchema)
			.readonly()
			.parse([...new Set(scopes)].toSorted());
	};

	const startApplication = (startProps: {
		readonly applicationId: GoogleOAuthApplicationId;
		readonly completedApplications: readonly OAuthApplicationId[];
		readonly selections: OAuthPermissionSelections;
		readonly transaction: Extract<
			OAuthCeremonyTransaction,
			{ readonly kind: 'selecting-permissions' }
		>;
		readonly remainingApplications: readonly GoogleOAuthApplicationId[];
	}): Extract<GoogleOAuthPermissionSubmissionResult, { readonly kind: 'redirect' }> => {
		const confirmedScopes = scopesForApplication(startProps.applicationId, startProps.selections);
		const authorizing = transactionStore.beginApplicationAuthorization({
			applicationId: oauthApplicationIdSchema.parse(startProps.applicationId),
			completedApplications: startProps.completedApplications,
			confirmedScopes,
			confirmedSelections: startProps.selections,
			redirectUri: new URL('/oauth/google/callback', props.config.browser.publicBaseUrl).toString(),
			remainingApplications: startProps.remainingApplications.map((applicationId) =>
				oauthApplicationIdSchema.parse(applicationId),
			),
			transactionId: startProps.transaction.transactionId,
		});
		return {
			authorizationUrl: props.googleAdapter.buildAuthorizationUrl({
				clientCredentials: props.clientCredentialsByApplication[startProps.applicationId],
				pkceChallenge: authorizing.pkceChallenge,
				redirectUri: authorizing.redirectUri,
				requestedScopes: confirmedScopes,
				state: authorizing.oauthState,
			}),
			browserBindingSecret: authorizing.browserBindingSecret,
			kind: 'redirect' as const,
			transactionId: authorizing.transactionId,
		};
	};

	const applicationProgress = (progressProps: {
		readonly authorizingApplication: OAuthApplicationId;
		readonly completedApplications: readonly OAuthApplicationId[];
		readonly remainingApplications: readonly OAuthApplicationId[];
	}): readonly GoogleOAuthApplicationProgress[] => [
		...progressProps.completedApplications.map((applicationId) => ({
			applicationId,
			label:
				props.config.providers.google.applications[
					googleOAuthApplicationIdSchema.parse(applicationId)
				].label,
			status: 'completed' as const,
		})),
		{
			applicationId: progressProps.authorizingApplication,
			label:
				props.config.providers.google.applications[
					googleOAuthApplicationIdSchema.parse(progressProps.authorizingApplication)
				].label,
			status: 'authorizing' as const,
		},
		...progressProps.remainingApplications.map((applicationId) => ({
			applicationId,
			label:
				props.config.providers.google.applications[
					googleOAuthApplicationIdSchema.parse(applicationId)
				].label,
			status: 'pending' as const,
		})),
	];

	const prepareCallbackRetry = (retryProps: {
		readonly transaction: Extract<
			OAuthCeremonyTransaction,
			{ readonly kind: 'consuming-callback' }
		>;
	}): Extract<GoogleOAuthCallbackResult, { readonly kind: 'partial-completion' }> => {
		const transaction = retryProps.transaction;
		transactionStore.cancelTransaction({
			agentId: transaction.agentId,
			transactionId: transaction.transactionId,
		});
		const retryApplicationIds = [transaction.applicationId, ...transaction.remainingApplications];
		const retryTransaction = transactionStore.createTransaction({
			accountProfileId: transaction.accountProfileId,
			agentId: transaction.agentId,
			applicationIds: retryApplicationIds,
			suggestedSelections: transaction.confirmedSelections,
		});
		const boundRetryTransaction = transactionStore.bindTailnetIdentity({
			tailnetLogin: transaction.tailnetLogin,
			transactionId: retryTransaction.transactionId,
		});
		const retry = startApplication({
			applicationId: googleOAuthApplicationIdSchema.parse(transaction.applicationId),
			completedApplications: transaction.completedApplications,
			remainingApplications: transaction.remainingApplications.map((applicationId) =>
				googleOAuthApplicationIdSchema.parse(applicationId),
			),
			selections: transaction.confirmedSelections,
			transaction: boundRetryTransaction,
		});
		activeTransactionIds.set(
			activeTransactionKey(transaction.agentId, transaction.accountProfileId),
			retry.transactionId,
		);
		return {
			completed: transaction.completedApplications.map(
				(applicationId) =>
					props.config.providers.google.applications[
						googleOAuthApplicationIdSchema.parse(applicationId)
					].label,
			),
			kind: 'partial-completion',
			retry,
			retryCsrfToken: boundRetryTransaction.csrfSecret,
			retryable: retryApplicationIds.map(
				(applicationId) =>
					props.config.providers.google.applications[
						googleOAuthApplicationIdSchema.parse(applicationId)
					].label,
			),
		};
	};

	const listAuthorizations = (agentId: string): OAuthAuthorizationActionResult => {
		const agent = requireAgent(agentId);
		const grants = props.catalog.listGrantsForAgent({ agentId, zoneId: props.zoneId });
		return oauthAuthorizationActionResultSchema.parse({
			kind: 'authorization-list',
			profiles: Object.entries(agent.accountProfiles).map(([accountProfileId, profile]) => {
				const profileGrants = grants.filter((grant) => grant.accountProfileId === accountProfileId);
				return {
					...(profileGrants[0]?.accountLabel === undefined
						? {}
						: { accountLabel: profileGrants[0].accountLabel }),
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
												grant.nextRefreshEligibleAtMs ?? now(),
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
					kind:
						profileGrants.length === 0
							? 'unbound'
							: profileGrants.length === Object.keys(profile.applications).length
								? 'enrolled'
								: 'partially-enrolled',
				};
			}),
		});
	};

	const resolveToolAvailability = (availabilityProps: {
		readonly agentId: string;
		readonly requirement: Extract<OAuthToolRequirement, { readonly kind: 'oauth-account-profile' }>;
	}): OAuthToolAvailability => {
		const agent = requireAgent(availabilityProps.agentId);
		const applicationId = googleOAuthApplicationIdSchema.safeParse(
			availabilityProps.requirement.applicationId,
		);
		if (!applicationId.success) return { kind: 'scope-insufficient' };
		const service =
			props.config.providers.google.applications[applicationId.data].services[
				availabilityProps.requirement.serviceId
			];
		if (service === undefined) return { kind: 'scope-insufficient' };
		const requiredScopes =
			availabilityProps.requirement.minimumPermission === 'write'
				? (service.write ?? [])
				: service.read;
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
				permissionRank(maximumPermission) <
					permissionRank(availabilityProps.requirement.minimumPermission)
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

	const resolveRuntimeCredential = async (runtimeProps: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly applicationId: OAuthApplicationId;
		readonly minimumPermission: OAuthMinimumPermission;
		readonly serviceId: string;
	}): Promise<GoogleOAuthRuntimeCredentialResolution> => {
		const applicationId = googleOAuthApplicationIdSchema.parse(runtimeProps.applicationId);
		const serviceId = oauthServiceIdSchema.parse(runtimeProps.serviceId);
		const profile = requireAccountProfile(runtimeProps.agentId, runtimeProps.accountProfileId);
		const maximumPermission = profile.applications[applicationId]?.maximumPermissions[serviceId];
		if (
			maximumPermission === undefined ||
			permissionRank(maximumPermission) < permissionRank(runtimeProps.minimumPermission)
		) {
			return { kind: 'unavailable', reason: 'scope-insufficient' };
		}
		const service = props.config.providers.google.applications[applicationId].services[serviceId];
		if (service === undefined) return { kind: 'unavailable', reason: 'scope-insufficient' };
		const requiredScopes =
			runtimeProps.minimumPermission === 'write' ? (service.write ?? []) : service.read;
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
		const credential = await refreshCoordinator.resolveAccessToken({
			clientCredentials: props.clientCredentialsByApplication[applicationId],
			grant,
			keyEncryptionKey: props.keyEncryptionKey,
			keyEncryptionKeyVersion: props.keyEncryptionKeyVersion,
			requiredScopes,
			signal: providerAbortController.signal,
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
	};

	const beginAuthorization = (beginProps: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly applicationIds: readonly GoogleOAuthApplicationId[];
		readonly suggestedSelections?: OAuthPermissionSelections | undefined;
	}): OAuthAuthorizationActionResult => {
		requireAccountProfile(beginProps.agentId, beginProps.accountProfileId);
		const suggestedSelections =
			beginProps.suggestedSelections === undefined
				? undefined
				: validateSelections({
						accountProfileId: beginProps.accountProfileId,
						agentId: beginProps.agentId,
						selections: beginProps.suggestedSelections,
					});
		const key = activeTransactionKey(beginProps.agentId, beginProps.accountProfileId);
		transactionStore.reapExpired();
		const existingTransactionId = activeTransactionIds.get(key);
		const existingTransaction =
			existingTransactionId === undefined
				? undefined
				: transactionStore.getTransaction(existingTransactionId);
		if (existingTransaction !== undefined && existingTransaction.kind !== 'selecting-permissions') {
			return oauthAuthorizationActionResultSchema.parse({
				kind: 'authorization-pending',
				transactionId: existingTransaction.transactionId,
			});
		}
		const transaction =
			existingTransaction ??
			transactionStore.createTransaction({
				accountProfileId: beginProps.accountProfileId,
				agentId: beginProps.agentId,
				applicationIds: beginProps.applicationIds.map((applicationId) =>
					oauthApplicationIdSchema.parse(applicationId),
				),
				suggestedSelections,
			});
		activeTransactionIds.set(key, transaction.transactionId);
		return oauthAuthorizationActionResultSchema.parse({
			authorizationUrl: new URL(
				`/oauth/transactions/${transaction.transactionId}`,
				props.config.browser.publicBaseUrl,
			).toString(),
			expiresAt: new Date(transaction.expiresAtMs).toISOString(),
			kind: 'authorization-begun',
			transactionId: transaction.transactionId,
		});
	};

	return {
		cancelBrowserTransaction: (cancelProps) => {
			requireAdmission();
			const transaction = transactionStore.getTransaction(cancelProps.transactionId);
			if (
				transaction?.kind !== 'selecting-permissions' ||
				transaction.tailnetLogin !== cancelProps.tailnetLogin ||
				!secretsEqual(transaction.browserBindingSecret, cancelProps.browserBindingSecret) ||
				!secretsEqual(transaction.csrfSecret, cancelProps.csrfToken)
			) {
				return false;
			}
			const cancelled = transactionStore.cancelTransaction({
				agentId: transaction.agentId,
				transactionId: transaction.transactionId,
			});
			if (cancelled) {
				activeTransactionIds.delete(
					activeTransactionKey(transaction.agentId, transaction.accountProfileId),
				);
			}
			return cancelled;
		},
		close: async (): Promise<void> => {
			stopAdmission();
			await Promise.allSettled(inFlightOperations);
			transactionStore.invalidateAll();
		},
		confirmAccount: async (confirmProps) =>
			await trackOperation(async () => {
				const completion = transactionStore.beginCompletionCommit({
					browserBindingSecret: confirmProps.browserBindingSecret,
					completionSessionId: oauthCompletionSessionIdSchema.parse(
						confirmProps.completionSessionId,
					),
					csrfToken: confirmProps.csrfToken,
					tailnetLogin: confirmProps.tailnetLogin,
				});
				if (completion.kind !== 'accepted') {
					throw new Error(`OAuth completion was rejected: ${completion.reason}.`);
				}
				const session = completion.session;
				const existingGrant = props.catalog.getGrantForAccountApplication({
					accountProfileId: session.accountProfileId,
					agentId: session.agentId,
					applicationId: session.applicationId,
					zoneId: props.zoneId,
				});
				const credentialId =
					existingGrant?.credentialId ?? oauthCredentialIdSchema.parse(randomUUID());
				const envelope = envelopeCodec.encrypt({
					binding: oauthEnvelopeBindingSchema.parse({
						accountProfileId: session.accountProfileId,
						applicationId: session.applicationId,
						credentialId,
						providerId: oauthProviderIdSchema.parse('google'),
						providerSubject: session.providerGrant.accountSubject,
					}),
					keyEncryptionKey: props.keyEncryptionKey,
					keyEncryptionKeyVersion: props.keyEncryptionKeyVersion,
					payload: {
						accessToken: session.providerGrant.accessToken,
						accessTokenExpiresAtMs: session.providerGrant.accessTokenExpiresAtMs,
						refreshToken: session.providerGrant.refreshToken,
					},
				});
				const committed = props.catalog.commitEnrollmentGrant({
					accountLabel: session.providerGrant.accountEmail,
					accountProfileId: session.accountProfileId,
					agentId: session.agentId,
					applicationId: session.applicationId,
					credentialId,
					envelope,
					grantedScopes: session.providerGrant.grantedScopes,
					materialRevision: materialRevision(),
					providerCredentialVersion: (existingGrant?.providerCredentialVersion ?? 0) + 1,
					providerId: oauthProviderIdSchema.parse('google'),
					providerSubject: session.providerGrant.accountSubject,
					zoneId: props.zoneId,
				});
				transactionStore.finishCompletion(session.completionSessionId);
				if (committed.kind === 'subject-mismatch') return { kind: 'subject-mismatch' };
				await props.onCredentialMaterialChanged?.({
					agentId: session.agentId,
					zoneId: props.zoneId,
				});
				activeTransactionIds.delete(
					activeTransactionKey(session.agentId, session.accountProfileId),
				);
				const nextApplication = session.remainingApplications[0];
				if (nextApplication === undefined) {
					return { accountLabel: session.providerGrant.accountEmail, kind: 'completed' };
				}
				const nextTransaction = transactionStore.createTransaction({
					accountProfileId: session.accountProfileId,
					agentId: session.agentId,
					applicationIds: session.remainingApplications,
					suggestedSelections: session.confirmedSelections,
				});
				const boundNextTransaction = transactionStore.bindTailnetIdentity({
					tailnetLogin: session.tailnetLogin,
					transactionId: nextTransaction.transactionId,
				});
				activeTransactionIds.set(
					activeTransactionKey(session.agentId, session.accountProfileId),
					nextTransaction.transactionId,
				);
				const redirect = startApplication({
					applicationId: googleOAuthApplicationIdSchema.parse(nextApplication),
					completedApplications: [...session.completedApplications, session.applicationId],
					remainingApplications: session.remainingApplications
						.slice(1)
						.map((applicationId) => googleOAuthApplicationIdSchema.parse(applicationId)),
					selections: session.confirmedSelections,
					transaction: boundNextTransaction,
				});
				return {
					...redirect,
					applications: applicationProgress({
						authorizingApplication: oauthApplicationIdSchema.parse(nextApplication),
						completedApplications: [...session.completedApplications, session.applicationId],
						remainingApplications: session.remainingApplications.slice(1),
					}),
				};
			}),
		executeAuthorizationAction: async ({ agentId, request: unparsedRequest }) =>
			await trackOperation(async () => {
				const request = oauthAuthorizationActionRequestSchema.parse(unparsedRequest);
				switch (request.actionId) {
					case 'oauth_authorization.list':
						return listAuthorizations(agentId);
					case 'oauth_authorization.begin': {
						const profile = requireAccountProfile(agentId, request.accountProfileId);
						return beginAuthorization({
							accountProfileId: request.accountProfileId,
							agentId,
							applicationIds: Object.keys(profile.applications).map((applicationId) =>
								googleOAuthApplicationIdSchema.parse(applicationId),
							),
							suggestedSelections: request.suggestedSelections,
						});
					}
					case 'oauth_authorization.status': {
						const transaction = transactionStore.getTransaction(request.transactionId);
						return transaction === undefined || transaction.agentId !== agentId
							? { failure: { kind: 'consumed' }, kind: 'authorization-failed' }
							: { kind: 'authorization-pending', transactionId: request.transactionId };
					}
					case 'oauth_authorization.cancel': {
						const transaction = transactionStore.getTransaction(request.transactionId);
						if (transaction !== undefined && transaction.agentId === agentId) {
							transactionStore.cancelTransaction({ agentId, transactionId: request.transactionId });
							activeTransactionIds.delete(
								activeTransactionKey(agentId, transaction.accountProfileId),
							);
						}
						return { kind: 'authorization-cancelled' };
					}
					case 'oauth_authorization.reauthorize': {
						const applicationId = googleOAuthApplicationIdSchema.parse(request.applicationId);
						const profile = requireAccountProfile(agentId, request.accountProfileId);
						if (profile.applications[applicationId] === undefined) {
							throw new Error('OAuth application is not assigned to this account profile.');
						}
						return beginAuthorization({
							accountProfileId: request.accountProfileId,
							agentId,
							applicationIds: [applicationId],
							suggestedSelections: request.suggestedSelections,
						});
					}
					case 'oauth_authorization.revoke': {
						const applicationId = googleOAuthApplicationIdSchema.parse(request.applicationId);
						const grant = props.catalog.getGrantForAccountApplication({
							accountProfileId: request.accountProfileId,
							agentId,
							applicationId: oauthApplicationIdSchema.parse(applicationId),
							zoneId: props.zoneId,
						});
						if (grant === undefined) return { kind: 'authorization-revoked' };
						const payload = envelopeCodec.decrypt({
							binding: oauthEnvelopeBindingSchema.parse({
								accountProfileId: grant.accountProfileId,
								applicationId: grant.applicationId,
								credentialId: grant.credentialId,
								providerId: grant.providerId,
								providerSubject: grant.providerSubject,
							}),
							envelope: grant.envelope,
							keyEncryptionKey: props.keyEncryptionKey,
						});
						const revoked = await props.googleAdapter.revokeAuthorization({
							refreshToken: payload.refreshToken,
							signal: providerAbortController.signal,
						});
						if (revoked.kind === 'failed') {
							return {
								failure: {
									kind:
										revoked.failure.kind === 'provider-unavailable'
											? 'unavailable'
											: 'authorization-denied',
								},
								kind: 'authorization-failed',
							};
						}
						props.catalog.deleteGrantForAccountApplication({
							accountProfileId: request.accountProfileId,
							agentId,
							applicationId: oauthApplicationIdSchema.parse(applicationId),
							zoneId: props.zoneId,
						});
						await props.onCredentialMaterialChanged?.({ agentId, zoneId: props.zoneId });
						return { kind: 'authorization-revoked' };
					}
				}
			}),
		getPermissionPage: ({ tailnetLogin, transactionId }) => {
			requireAdmission();
			const transaction = transactionStore.getTransaction(transactionId);
			if (transaction?.kind !== 'selecting-permissions') {
				throw new Error('OAuth transaction is not available for permission selection.');
			}
			const profile = requireAccountProfile(transaction.agentId, transaction.accountProfileId);
			if (!profile.authorizedTailnetLogins.includes(tailnetLogin)) {
				throw new Error('Tailnet identity cannot authorize this OAuth account profile.');
			}
			const boundTransaction = transactionStore.bindTailnetIdentity({
				tailnetLogin,
				transactionId,
			});
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
								([serviceId, maximumPermission]) => ({
									allowedChoices:
										maximumPermission === 'write'
											? (['none', 'read', 'write'] as const)
											: (['none', 'read'] as const),
									label:
										application.services[oauthServiceIdSchema.parse(serviceId)]?.label ?? serviceId,
									selectedChoice:
										applicationSelections(
											boundTransaction.suggestedSelections ??
												oauthPermissionSelectionsSchema.parse({}),
											parsedApplicationId,
										)?.[oauthServiceIdSchema.parse(serviceId)] ?? 'none',
									serviceId,
									...(applicationSelections(
										boundTransaction.suggestedSelections ??
											oauthPermissionSelectionsSchema.parse({}),
										parsedApplicationId,
									)?.[oauthServiceIdSchema.parse(serviceId)] === undefined
										? {}
										: {
												suggestedChoice: applicationSelections(
													boundTransaction.suggestedSelections ??
														oauthPermissionSelectionsSchema.parse({}),
													parsedApplicationId,
												)?.[oauthServiceIdSchema.parse(serviceId)],
											}),
								}),
							),
						};
					}),
				browserBindingSecret: boundTransaction.browserBindingSecret,
				csrfToken: boundTransaction.csrfSecret,
				transactionId: boundTransaction.transactionId,
			};
		},
		resolveRuntimeCredential: async (runtimeProps) =>
			await trackOperation(async () => await resolveRuntimeCredential(runtimeProps)),
		resolveToolAvailability: (availabilityProps) => {
			requireAdmission();
			return resolveToolAvailability(availabilityProps);
		},
		reapExpiredTransactions: () => transactionStore.reapExpired(),
		retryApplication: (retryProps) => {
			requireAdmission();
			const transaction = transactionStore.getTransaction(retryProps.transactionId);
			if (transaction?.kind !== 'authorizing-application') {
				throw new Error('OAuth retry transaction is not authorizing an application.');
			}
			if (transaction.expiresAtMs <= now()) {
				transactionStore.cancelTransaction({
					agentId: transaction.agentId,
					transactionId: transaction.transactionId,
				});
				throw new Error('OAuth retry transaction expired.');
			}
			if (
				transaction.tailnetLogin !== retryProps.tailnetLogin ||
				!secretsEqual(transaction.browserBindingSecret, retryProps.browserBindingSecret) ||
				!secretsEqual(transaction.csrfSecret, retryProps.csrfToken)
			) {
				throw new Error('OAuth retry authority is invalid.');
			}
			const applicationId = googleOAuthApplicationIdSchema.parse(transaction.applicationId);
			return {
				authorizationUrl: props.googleAdapter.buildAuthorizationUrl({
					clientCredentials: props.clientCredentialsByApplication[applicationId],
					pkceChallenge: transaction.pkceChallenge,
					redirectUri: transaction.redirectUri,
					requestedScopes: transaction.confirmedScopes,
					state: transaction.oauthState,
				}),
				browserBindingSecret: transaction.browserBindingSecret,
				kind: 'redirect',
				transactionId: transaction.transactionId,
			};
		},
		stopAdmission,
		handleGoogleCallback: async (callbackProps) =>
			await trackOperation(async () => {
				const current = transactionStore.getTransaction(callbackProps.transactionId);
				if (
					current?.kind !== 'authorizing-application' ||
					!secretsEqual(current.browserBindingSecret, callbackProps.browserBindingSecret)
				) {
					return { kind: 'failed', reason: 'browser-binding-mismatch' };
				}
				const consumption = transactionStore.beginCallbackConsumption(callbackProps);
				if (consumption.kind !== 'accepted') return { kind: 'failed', reason: consumption.reason };
				const applicationId = googleOAuthApplicationIdSchema.parse(
					consumption.transaction.applicationId,
				);
				const exchange = await props.googleAdapter.exchangeAuthorizationCode({
					authorizationCode: callbackProps.authorizationCode,
					clientCredentials: props.clientCredentialsByApplication[applicationId],
					pkceVerifier: consumption.transaction.pkceVerifier,
					redirectUri: consumption.transaction.redirectUri,
					signal: providerAbortController.signal,
				});
				if (exchange.kind === 'failed') {
					if (!admissionOpen) return { kind: 'failed', reason: exchange.failure.kind };
					return prepareCallbackRetry({ transaction: consumption.transaction });
				}
				const actualScopes = new Set(exchange.authorization.grantedScopes);
				const allowedScopes = new Set([
					...consumption.transaction.confirmedScopes,
					...googleIdentityScopes,
				]);
				if (exchange.authorization.grantedScopes.some((scope) => !allowedScopes.has(scope))) {
					transactionStore.cancelTransaction({
						agentId: current.agentId,
						transactionId: current.transactionId,
					});
					return { kind: 'failed', reason: 'scope-insufficient' };
				}
				if (consumption.transaction.confirmedScopes.some((scope) => !actualScopes.has(scope))) {
					return prepareCallbackRetry({ transaction: consumption.transaction });
				}
				const existingSubjects = new Set(
					props.catalog
						.listGrantsForAgent({ agentId: current.agentId, zoneId: props.zoneId })
						.filter((grant) => grant.accountProfileId === current.accountProfileId)
						.map((grant) => grant.providerSubject),
				);
				if (
					existingSubjects.size > 0 &&
					!existingSubjects.has(exchange.authorization.accountSubject)
				) {
					transactionStore.cancelTransaction({
						agentId: current.agentId,
						transactionId: current.transactionId,
					});
					return { kind: 'failed', reason: 'subject-mismatch' };
				}
				const completion = transactionStore.completeCallback({
					providerGrant: exchange.authorization,
					transactionId: current.transactionId,
				});
				const application = props.config.providers.google.applications[applicationId];
				return {
					confirmation: {
						accountLabel: exchange.authorization.accountEmail,
						applicationLabel: application.label,
						browserBindingSecret: completion.browserBindingSecret,
						completionSessionId: completion.completionSessionId,
						csrfToken: completion.csrfSecret,
						grantedPermissionLabels: Object.values(application.services)
							.filter((service) => service.read.some((scope) => actualScopes.has(scope)))
							.map((service) => service.label),
					},
					kind: 'confirmation',
				};
			}),
		submitPermissions: (submissionProps) => {
			requireAdmission();
			const transaction = transactionStore.getTransaction(submissionProps.transactionId);
			if (transaction?.kind !== 'selecting-permissions') {
				throw new Error('OAuth transaction is not selecting permissions.');
			}
			if (
				transaction.tailnetLogin !== submissionProps.tailnetLogin ||
				!secretsEqual(transaction.browserBindingSecret, submissionProps.browserBindingSecret) ||
				!secretsEqual(transaction.csrfSecret, submissionProps.csrfToken)
			) {
				throw new Error('OAuth permission submission authority is invalid.');
			}
			const selections = completeSelections({
				accountProfileId: transaction.accountProfileId,
				agentId: transaction.agentId,
				selections: submissionProps.selections,
			});
			const queue = transaction.applicationIds
				.map((applicationId) => googleOAuthApplicationIdSchema.parse(applicationId))
				.filter((applicationId) => scopesForApplication(applicationId, selections).length > 0);
			const firstApplication = queue[0];
			if (firstApplication === undefined) {
				transactionStore.cancelTransaction({
					agentId: transaction.agentId,
					transactionId: transaction.transactionId,
				});
				activeTransactionIds.delete(
					activeTransactionKey(transaction.agentId, transaction.accountProfileId),
				);
				return { kind: 'already-satisfied' };
			}
			return startApplication({
				applicationId: firstApplication,
				completedApplications: [],
				remainingApplications: queue.slice(1),
				selections,
				transaction,
			});
		},
	};
}
