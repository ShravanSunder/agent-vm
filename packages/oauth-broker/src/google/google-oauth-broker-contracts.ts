import { type GoogleOAuthApplicationId } from '@agent-vm/config-contracts';
import {
	type OAuthAccountProfileId,
	type OAuthApplicationId,
	type OAuthAuthorizationActionRequest,
	type OAuthAuthorizationActionResult,
	type OAuthCredentialId,
	type OAuthMaterialRevision,
	type OAuthMinimumPermission,
	type OAuthPermissionChoice,
	type OAuthPermissionSelections,
	type OAuthServiceId,
	type OAuthToolAvailability,
	type OAuthToolRequirement,
	type OAuthTransactionId,
} from '@agent-vm/oauth-broker-contracts';

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
	readonly expiresAtMs: number;
	readonly transactionId: OAuthTransactionId;
}

export interface GoogleOAuthConfirmationPageData {
	readonly accountLabel: string;
	readonly applicationLabel: string;
	readonly browserBindingSecret: string;
	readonly completionSessionId: string;
	readonly csrfToken: string;
	readonly expiresAtMs: number;
	readonly grantedPermissionLabels: readonly string[];
}

export interface GoogleOAuthApplicationProgress {
	readonly applicationId: OAuthApplicationId;
	readonly label: string;
	readonly status: 'pending' | 'authorizing' | 'completed' | 'failed';
}

export interface GoogleOAuthRedirectResult {
	readonly applicationId: OAuthApplicationId;
	readonly applicationLabel: string;
	readonly authorizationUrl: string;
	readonly browserBindingSecret: string;
	readonly expiresAtMs: number;
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
			readonly csrfToken: string;
			readonly expiresAtMs: number;
			readonly kind: 'redirect';
			readonly transactionId: OAuthTransactionId;
	  }
	| { readonly kind: 'authorization-denied' }
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
			readonly credentialId: OAuthCredentialId;
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

export type GoogleOAuthRuntimeCredentialSnapshotValidation =
	| { readonly kind: 'current' }
	| {
			readonly kind: 'stale';
			readonly reason:
				| 'account-policy-changed'
				| 'credential-changed'
				| 'credential-unavailable'
				| 'scope-insufficient';
	  };

export interface GoogleOAuthBrokerService {
	cancelBrowserTransaction(props: {
		readonly browserBindingSecret: string;
		readonly csrfToken: string;
		readonly tailnetLogin: string;
		readonly transactionId: OAuthTransactionId;
	}): boolean;
	cancelBrowserCompletion(props: {
		readonly browserBindingSecret: string;
		readonly completionSessionId: string;
		readonly csrfToken: string;
		readonly tailnetLogin: string;
	}): boolean;
	close(): Promise<void>;
	drain(): Promise<void>;
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
	validateRuntimeCredentialSnapshot(props: {
		readonly accountProfileId: OAuthAccountProfileId;
		readonly agentId: string;
		readonly applicationId: OAuthApplicationId;
		readonly credentialId: OAuthCredentialId;
		readonly materialRevision: OAuthMaterialRevision;
		readonly minimumPermission: OAuthMinimumPermission;
		readonly serviceId: OAuthServiceId;
	}): GoogleOAuthRuntimeCredentialSnapshotValidation;
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
