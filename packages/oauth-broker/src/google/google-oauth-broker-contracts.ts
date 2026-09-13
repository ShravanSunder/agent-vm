import { type GoogleOAuthApplicationId } from '@agent-vm/config-contracts';
import {
	type OAuthAccountActivityAvailability,
	type OAuthApplicationId,
	type OAuthAuthorizationActionRequest,
	type OAuthAuthorizationActionResult,
	type OAuthBrowserSessionIdentity,
	type OAuthCredentialId,
	type OAuthCompletionSessionId,
	type OAuthMaterialRevision,
	type OAuthPermissionSelections,
	type OAuthTransactionId,
	type oauthAccountIdSchema,
	type oauthAuthorizationIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import type { z } from 'zod';

export interface GoogleOAuthPermissionPageData {
	readonly agentId: string;
	readonly ownerLabel: string;
	readonly intent: 'enroll' | 'reauthorize' | 'disconnect';
	readonly accountAlias?: string | undefined;
	readonly suggestedAlias?: string | undefined;
	readonly accountId?: z.infer<typeof oauthAccountIdSchema> | undefined;
	readonly applications: readonly {
		readonly applicationId: GoogleOAuthApplicationId;
		readonly description: string;
		readonly label: string;
		readonly recommendedGroupIds: readonly string[];
		readonly selectedGroupIds: readonly string[];
		readonly suggestedGroupIds?: readonly string[] | undefined;
		readonly groups: readonly {
			readonly groupId: string;
			readonly serviceId: string;
			readonly effect: 'read' | 'write';
			readonly label: string;
			readonly warning: string;
			readonly offered: boolean;
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
	readonly completionSessionId: OAuthCompletionSessionId;
	readonly csrfToken: string;
	readonly expiresAtMs: number;
	/** Present only for reauthorization, from the authenticated existing credential payload. */
	readonly previousPermissionLabels?: readonly string[] | undefined;
	readonly grantedPermissionLabels: readonly string[];
}
export interface GoogleOAuthRetryPageData {
	readonly completed: readonly string[];
	readonly csrfToken: string;
	readonly retryable: readonly string[];
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
	| { readonly kind: 'no-selections' }
	| GoogleOAuthRedirectResult;
export type GoogleOAuthConfirmationResult =
	| {
			readonly accountAlias: string;
			readonly accountId: z.infer<typeof oauthAccountIdSchema>;
			readonly kind: 'completed';
	  }
	| (GoogleOAuthRedirectResult & {
			readonly applications: readonly GoogleOAuthApplicationProgress[];
			readonly csrfToken: string;
	  })
	| {
			readonly kind:
				| 'authorization-denied'
				| 'subject-mismatch'
				| 'duplicate-authorization'
				| 'stale-authorization'
				| 'configuration-change-required'
				| 'scope-mismatch'
				| 'unavailable'
				| 'replacement-pending'
				| 'containment-failed';
	  };
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

export interface GoogleOAuthRuntimeCredentialRequest {
	readonly accountId: z.infer<typeof oauthAccountIdSchema>;
	readonly agentId: string;
	readonly applicationId: OAuthApplicationId;
	readonly operationId: string;
	/** Host-resolved effective policy, never a public Gog argument. */
	readonly gmailWriteAllowed: boolean;
}
export interface GoogleOAuthRuntimeCredentialBinding {
	readonly accountId: z.infer<typeof oauthAccountIdSchema>;
	readonly authorizationId: z.infer<typeof oauthAuthorizationIdSchema>;
	readonly generation: number;
	readonly authorizationMetadataRevision: number;
	readonly credentialId: OAuthCredentialId;
	readonly materialRevision: OAuthMaterialRevision;
}
export type GoogleOAuthRuntimeCredentialResolution =
	| (GoogleOAuthRuntimeCredentialBinding & {
			readonly accessToken: Uint8Array;
			readonly allowedHosts: readonly string[];
			readonly gmailNoSend: boolean;
			readonly kind: 'ready';
	  })
	| {
			readonly kind: 'unavailable';
			readonly reason:
				| 'authorization-missing'
				| 'degraded'
				| 'reauthorization-required'
				| 'scope-insufficient'
				| 'stale-write'
				| 'authorization-unavailable';
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
export interface GoogleOAuthBrowserDecision {
	readonly browserBindingSecret: string;
	readonly csrfToken: string;
	readonly identity: OAuthBrowserSessionIdentity;
}
export type GoogleOAuthAccountActivityReader = (props: {
	readonly agentId: string;
	readonly accountId: z.infer<typeof oauthAccountIdSchema>;
	readonly applicationId: OAuthApplicationId;
	readonly operationId: string;
}) => OAuthAccountActivityAvailability;
export interface GoogleOAuthBrokerService {
	cancelBrowserTransaction(
		props: GoogleOAuthBrowserDecision & { readonly transactionId: OAuthTransactionId },
	): boolean;
	cancelBrowserCompletion(
		props: GoogleOAuthBrowserDecision & { readonly completionSessionId: string },
	): boolean;
	cancelBrowserCeremonies(identity: OAuthBrowserSessionIdentity): number;
	getBrowserSession(
		target: {
			readonly kind: 'transaction' | 'completion';
			readonly id: string;
		},
		browserBindingSecret: string,
	): OAuthBrowserSessionIdentity | undefined;
	close(): Promise<void>;
	drain(): Promise<void>;
	executeAuthorizationAction(props: {
		readonly agentId: string;
		readonly request: OAuthAuthorizationActionRequest;
	}): Promise<OAuthAuthorizationActionResult>;
	beginWebsiteAuthorization(props: {
		readonly agentId: string;
		readonly identity: OAuthBrowserSessionIdentity;
		readonly request: Extract<
			OAuthAuthorizationActionRequest,
			{
				actionId:
					| 'oauth_authorization.begin'
					| 'oauth_authorization.reauthorize'
					| 'oauth_authorization.disconnect';
			}
		>;
	}): OAuthAuthorizationActionResult;
	getPermissionPage(props: {
		readonly identity: OAuthBrowserSessionIdentity;
		readonly transactionId: OAuthTransactionId;
	}): GoogleOAuthPermissionPageData;
	getConfirmationPage(props: {
		readonly browserBindingSecret: string;
		readonly completionSessionId: OAuthCompletionSessionId;
		readonly identity: OAuthBrowserSessionIdentity;
	}): GoogleOAuthConfirmationPageData;
	getRetryPage(props: {
		readonly browserBindingSecret: string;
		readonly identity: OAuthBrowserSessionIdentity;
		readonly transactionId: OAuthTransactionId;
	}): GoogleOAuthRetryPageData;
	resolveRuntimeCredential(
		props: GoogleOAuthRuntimeCredentialRequest,
	): Promise<GoogleOAuthRuntimeCredentialResolution>;
	validateRuntimeCredentialSnapshot(
		props: GoogleOAuthRuntimeCredentialRequest & GoogleOAuthRuntimeCredentialBinding,
	): GoogleOAuthRuntimeCredentialSnapshotValidation;
	reapExpiredTransactions(): {
		readonly completionSessionCount: number;
		readonly transactionCount: number;
	};
	retryApplication(
		props: GoogleOAuthBrowserDecision & { readonly transactionId: OAuthTransactionId },
	): GoogleOAuthRedirectResult;
	stopAdmission(): void;
	handleGoogleCallback(props: {
		readonly authorizationCode: string;
		readonly browserBindingSecret: string;
		readonly oauthState: string;
		readonly redirectUri: string;
		readonly identity: OAuthBrowserSessionIdentity;
		readonly transactionId: OAuthTransactionId;
	}): Promise<GoogleOAuthCallbackResult>;
	submitPermissions(
		props: GoogleOAuthBrowserDecision & {
			readonly selections: OAuthPermissionSelections;
			readonly transactionId: OAuthTransactionId;
		},
	): GoogleOAuthPermissionSubmissionResult;
	confirmAccount(
		props: GoogleOAuthBrowserDecision & {
			readonly accountAlias: string;
			readonly completionSessionId: string;
		},
	): Promise<GoogleOAuthConfirmationResult>;
	confirmDisconnect(
		props: GoogleOAuthBrowserDecision & { readonly transactionId: OAuthTransactionId },
	): Promise<OAuthAuthorizationActionResult>;
}
