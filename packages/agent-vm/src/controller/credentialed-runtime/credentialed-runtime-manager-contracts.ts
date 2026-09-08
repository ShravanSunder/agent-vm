import type { ControllerConfiguredCliInput } from '@agent-vm/config-contracts';

import type { CredentialedManagedVmCommandResult } from './credentialed-managed-vm.js';
import type {
	CredentialedRuntimeOAuthAuthorization,
	CredentialedRuntimeInvalidationScope,
} from './credentialed-runtime-material-scope.js';
import type { CredentialedRuntimeResolution } from './credentialed-runtime-registry.js';
import type { SharedStagingOperationSession } from './shared-staging-operation-session.js';

export interface CredentialedRuntimeOwnerIdentity {
	readonly controllerEpoch: string;
	readonly gatewayEpoch: string;
	readonly parentGatewayVmId: string;
	readonly runtimeEpoch: string;
	readonly stablePrincipal: string;
}

export interface CredentialedRuntimeDynamicHttpMediation {
	readonly gmailNoSend: boolean;
	readonly authorization: CredentialedRuntimeOAuthAuthorization;
	readonly allowedHosts: readonly string[];
	readonly credentialId: string;
	readonly environmentName: string;
	readonly kind: 'dynamic_http_mediation';
	readonly materialRevision: string;
	readonly placeholderValue: string;
	readonly secretValue: Uint8Array;
}

export interface CredentialedRuntimeMaterialization {
	readonly dynamicHttpMediation?: CredentialedRuntimeDynamicHttpMediation | undefined;
	readonly resolution: CredentialedRuntimeResolution;
}

export type AcquireCredentialedRuntimeCommandResult =
	| { readonly command: CredentialedRuntimeCommandHandle; readonly kind: 'acquired' }
	| { readonly kind: 'busy'; readonly retryable: true }
	| { readonly kind: 'not-dispatched'; readonly reason: string }
	| { readonly kind: 'owner-unsafe'; readonly reason: string };

export type CredentialedRuntimeCommandOutcome =
	| { readonly kind: 'completed' }
	| { readonly kind: 'retire'; readonly reason: string };

export interface CredentialedRuntimeCommandHandle {
	prepareSharedStagingOperation?(request: {
		readonly maximumBytes: number;
		readonly authorityIsCurrent: () => boolean;
	}): Promise<SharedStagingOperationSession>;
	complete(outcome: CredentialedRuntimeCommandOutcome): Promise<void>;
	exec(
		input: ControllerConfiguredCliInput,
		options?: { readonly signal?: AbortSignal },
	): Promise<CredentialedManagedVmCommandResult>;
}

export type RetireCredentialedRuntimeResult =
	| { readonly kind: 'retired' }
	| { readonly kind: 'absent' }
	| { readonly kind: 'active'; readonly retryable: true }
	| { readonly kind: 'owner-unsafe'; readonly retryable: false };

export type InvalidateCredentialedRuntimeMaterialResult =
	| { readonly kind: 'retired' }
	| { readonly kind: 'absent' }
	| { readonly kind: 'owner-unsafe' };

export interface CredentialedRuntimeManager {
	acquireCommand(
		request: {
			readonly admissionSignal?: AbortSignal;
			readonly finalAuthorization: () => Promise<boolean>;
			readonly finalMaterialAuthorization?: (() => boolean) | undefined;
			readonly operationId: string;
			readonly ownerIdentity: CredentialedRuntimeOwnerIdentity;
		} & (
			| { readonly resolution: CredentialedRuntimeResolution }
			| {
					readonly materializationFailureReason?: ((error: unknown) => string) | undefined;
					readonly materializeResolution: () => Promise<CredentialedRuntimeMaterialization>;
					readonly runtimeIdentity: { readonly agentId: string; readonly zoneId: string };
			  }
		),
	): Promise<AcquireCredentialedRuntimeCommandResult>;
	closeZone(zoneId: string): Promise<void>;
	invalidateMaterial(request: {
		readonly scope: CredentialedRuntimeInvalidationScope;
		readonly agentId: string;
		readonly reason: string;
		readonly zoneId: string;
	}): Promise<InvalidateCredentialedRuntimeMaterialResult>;
	openZone(zoneId: string): void;
	reapExpired(): Promise<void>;
	recoverZone(zoneId: string): Promise<{ readonly kind: 'contained' | 'owner-unsafe' }>;
	retire(request: {
		readonly agentId: string;
		readonly force: boolean;
		readonly zoneId: string;
	}): Promise<RetireCredentialedRuntimeResult>;
}
