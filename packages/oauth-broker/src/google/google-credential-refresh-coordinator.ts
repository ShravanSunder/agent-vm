import { randomBytes } from 'node:crypto';

import {
	oauthMaterialRevisionSchema,
	oauthScopeSchema,
	type OAuthMaterialRevision,
	type OAuthScope,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import {
	createOAuthEnvelopeCodec,
	oauthEnvelopeBindingSchema,
	type OAuthEnvelopeBinding,
	type OAuthKeyEncryptionKey,
} from '../envelope-codec.js';
import {
	type OAuthCredentialCatalog,
	type OAuthStoredGrant,
} from '../oauth-credential-catalog-contracts.js';
import {
	googleWebClientCredentialsSchema,
	type GoogleOAuthAdapter,
	type GoogleWebClientCredentials,
} from './google-oauth-adapter.js';

export const googleStoredCredentialPayloadSchema = z
	.object({
		accessToken: z.string().min(1),
		accessTokenExpiresAtMs: z.number().int().positive(),
		refreshToken: z.string().min(1),
	})
	.strict();
export type GoogleStoredCredentialPayload = z.infer<typeof googleStoredCredentialPayloadSchema>;

export type GoogleCredentialResolution =
	| {
			readonly accessToken: string;
			readonly grant: OAuthStoredGrant;
			readonly kind: 'ready';
	  }
	| {
			readonly kind: 'degraded';
			readonly nextRefreshEligibleAtMs: number;
	  }
	| { readonly kind: 'reauthorization-required' }
	| { readonly kind: 'scope-insufficient' }
	| { readonly kind: 'stale-write' };

export interface GoogleCredentialRefreshCoordinator {
	resolveAccessToken(props: {
		readonly clientCredentials: GoogleWebClientCredentials;
		readonly grant: OAuthStoredGrant;
		readonly keyEncryptionKey: OAuthKeyEncryptionKey;
		readonly keyEncryptionKeyVersion: number;
		readonly requiredScopes: readonly OAuthScope[];
		readonly signal?: AbortSignal | undefined;
	}): Promise<GoogleCredentialResolution>;
}

function createMaterialRevision(): OAuthMaterialRevision {
	return oauthMaterialRevisionSchema.parse(`sha256:${randomBytes(32).toString('base64url')}`);
}

function sameScopeSet(left: readonly OAuthScope[], right: readonly OAuthScope[]): boolean {
	if (left.length !== right.length) return false;
	const rightScopes = new Set(right);
	return left.every((scope) => rightScopes.has(scope));
}

function containsRequiredScopes(
	grantedScopes: readonly OAuthScope[],
	requiredScopes: readonly OAuthScope[],
): boolean {
	const granted = new Set(grantedScopes);
	return requiredScopes.every((scope) => granted.has(scope));
}

function envelopeBinding(grant: OAuthStoredGrant): OAuthEnvelopeBinding {
	return oauthEnvelopeBindingSchema.parse({
		accountProfileId: grant.accountProfileId,
		applicationId: grant.applicationId,
		credentialId: grant.credentialId,
		providerId: grant.providerId,
		providerSubject: grant.providerSubject,
	});
}

export function createGoogleCredentialRefreshCoordinator(props: {
	readonly accessTokenRefreshSkewMs?: number;
	readonly catalog: OAuthCredentialCatalog;
	readonly degradedRetryDelayMs?: number;
	readonly googleAdapter: GoogleOAuthAdapter;
	readonly now?: () => number;
}): GoogleCredentialRefreshCoordinator {
	const now = props.now ?? Date.now;
	const accessTokenRefreshSkewMs = props.accessTokenRefreshSkewMs ?? 60_000;
	const degradedRetryDelayMs = props.degradedRetryDelayMs ?? 30_000;
	for (const [fieldName, value] of [
		['accessTokenRefreshSkewMs', accessTokenRefreshSkewMs],
		['degradedRetryDelayMs', degradedRetryDelayMs],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(`${fieldName} must be a non-negative safe integer.`);
		}
	}
	const envelopeCodec = createOAuthEnvelopeCodec({
		payloadSchema: googleStoredCredentialPayloadSchema,
	});
	const inFlightByCredentialId = new Map<string, Promise<GoogleCredentialResolution>>();

	const resolveLeader = async (resolutionProps: {
		readonly clientCredentials: GoogleWebClientCredentials;
		readonly grant: OAuthStoredGrant;
		readonly keyEncryptionKey: OAuthKeyEncryptionKey;
		readonly keyEncryptionKeyVersion: number;
		readonly requiredScopes: readonly OAuthScope[];
		readonly signal?: AbortSignal | undefined;
	}): Promise<GoogleCredentialResolution> => {
		const grant = resolutionProps.grant;
		if (grant.providerId !== 'google')
			throw new Error('Google refresh received a non-Google grant.');
		if (grant.lifecycleKind === 'reauthorization-required') {
			return { kind: 'reauthorization-required' };
		}
		const requiredScopes = z
			.array(oauthScopeSchema)
			.readonly()
			.parse(resolutionProps.requiredScopes);
		if (!containsRequiredScopes(grant.grantedScopes, requiredScopes)) {
			return { kind: 'scope-insufficient' };
		}
		const currentTimeMs = now();
		if (
			grant.lifecycleKind === 'degraded' &&
			grant.nextRefreshEligibleAtMs !== null &&
			grant.nextRefreshEligibleAtMs > currentTimeMs
		) {
			return { kind: 'degraded', nextRefreshEligibleAtMs: grant.nextRefreshEligibleAtMs };
		}
		let payload: z.infer<typeof googleStoredCredentialPayloadSchema>;
		try {
			payload = envelopeCodec.decrypt({
				binding: envelopeBinding(grant),
				envelope: grant.envelope,
				keyEncryptionKey: resolutionProps.keyEncryptionKey,
			});
		} catch {
			const updateResult = props.catalog.replaceGrantEnvelope({
				credentialId: grant.credentialId,
				envelope: grant.envelope,
				expectedRecordRevision: grant.recordRevision,
				failureClass: 'credential-corrupt',
				lastRefreshAttemptAtMs: now(),
				lastRefreshSucceededAtMs: grant.lastRefreshSucceededAtMs,
				lifecycleKind: 'reauthorization-required',
				materialRevision: grant.materialRevision,
				nextRefreshEligibleAtMs: null,
				providerCredentialVersion: grant.providerCredentialVersion,
				reauthorizationReason: 'credential-corrupt',
			});
			return updateResult.kind === 'stale'
				? { kind: 'stale-write' }
				: { kind: 'reauthorization-required' };
		}
		if (payload.accessTokenExpiresAtMs > currentTimeMs + accessTokenRefreshSkewMs) {
			return { accessToken: payload.accessToken, grant, kind: 'ready' };
		}

		const refreshResult = await props.googleAdapter.refreshAuthorization({
			clientCredentials: googleWebClientCredentialsSchema.parse(resolutionProps.clientCredentials),
			currentGrantedScopes: grant.grantedScopes,
			refreshToken: payload.refreshToken,
			signal: resolutionProps.signal,
		});
		if (resolutionProps.signal?.aborted === true) {
			const abortReason: unknown = resolutionProps.signal.reason;
			throw abortReason instanceof Error
				? abortReason
				: new Error('Google OAuth credential refresh was cancelled.');
		}
		if (refreshResult.kind === 'failed') {
			if (refreshResult.failure.kind === 'invalid-grant') {
				const updateResult = props.catalog.replaceGrantEnvelope({
					credentialId: grant.credentialId,
					envelope: grant.envelope,
					expectedRecordRevision: grant.recordRevision,
					failureClass: 'invalid-grant',
					lastRefreshAttemptAtMs: currentTimeMs,
					lastRefreshSucceededAtMs: grant.lastRefreshSucceededAtMs,
					lifecycleKind: 'reauthorization-required',
					materialRevision: grant.materialRevision,
					nextRefreshEligibleAtMs: null,
					providerCredentialVersion: grant.providerCredentialVersion,
					reauthorizationReason: 'invalid-grant',
				});
				return updateResult.kind === 'stale'
					? { kind: 'stale-write' }
					: { kind: 'reauthorization-required' };
			}
			const nextRefreshEligibleAtMs = currentTimeMs + degradedRetryDelayMs;
			const updateResult = props.catalog.replaceGrantEnvelope({
				credentialId: grant.credentialId,
				envelope: grant.envelope,
				expectedRecordRevision: grant.recordRevision,
				failureClass: refreshResult.failure.kind,
				lastRefreshAttemptAtMs: currentTimeMs,
				lastRefreshSucceededAtMs: grant.lastRefreshSucceededAtMs,
				lifecycleKind: 'degraded',
				materialRevision: grant.materialRevision,
				nextRefreshEligibleAtMs,
				providerCredentialVersion: grant.providerCredentialVersion,
				reauthorizationReason: null,
			});
			return updateResult.kind === 'stale'
				? { kind: 'stale-write' }
				: { kind: 'degraded', nextRefreshEligibleAtMs };
		}

		if (!sameScopeSet(refreshResult.grantedScopes, grant.grantedScopes)) {
			const updateResult = props.catalog.replaceGrantEnvelope({
				credentialId: grant.credentialId,
				envelope: grant.envelope,
				expectedRecordRevision: grant.recordRevision,
				failureClass: 'scope-insufficient',
				lastRefreshAttemptAtMs: currentTimeMs,
				lastRefreshSucceededAtMs: grant.lastRefreshSucceededAtMs,
				lifecycleKind: 'reauthorization-required',
				materialRevision: grant.materialRevision,
				nextRefreshEligibleAtMs: null,
				providerCredentialVersion: grant.providerCredentialVersion,
				reauthorizationReason: 'scope-insufficient',
			});
			return updateResult.kind === 'stale'
				? { kind: 'stale-write' }
				: { kind: 'reauthorization-required' };
		}
		const refreshedPayload = {
			accessToken: refreshResult.accessToken,
			accessTokenExpiresAtMs: refreshResult.accessTokenExpiresAtMs,
			refreshToken: refreshResult.replacementRefreshToken ?? payload.refreshToken,
		};
		const refreshedEnvelope = envelopeCodec.encrypt({
			binding: envelopeBinding(grant),
			keyEncryptionKey: resolutionProps.keyEncryptionKey,
			keyEncryptionKeyVersion: resolutionProps.keyEncryptionKeyVersion,
			payload: refreshedPayload,
		});
		const updateResult = props.catalog.replaceGrantEnvelope({
			credentialId: grant.credentialId,
			envelope: refreshedEnvelope,
			expectedRecordRevision: grant.recordRevision,
			failureClass: null,
			lastRefreshAttemptAtMs: currentTimeMs,
			lastRefreshSucceededAtMs: currentTimeMs,
			lifecycleKind: 'active',
			materialRevision: createMaterialRevision(),
			nextRefreshEligibleAtMs: null,
			providerCredentialVersion: grant.providerCredentialVersion + 1,
			reauthorizationReason: null,
		});
		if (updateResult.kind !== 'updated') return { kind: 'stale-write' };
		return {
			accessToken: refreshedPayload.accessToken,
			grant: updateResult.grant,
			kind: 'ready',
		};
	};

	return {
		resolveAccessToken: async (resolutionProps) => {
			const credentialId = resolutionProps.grant.credentialId;
			const existing = inFlightByCredentialId.get(credentialId);
			if (existing !== undefined) {
				const sharedResult = await existing;
				return sharedResult.kind === 'ready' &&
					!containsRequiredScopes(sharedResult.grant.grantedScopes, resolutionProps.requiredScopes)
					? { kind: 'scope-insufficient' }
					: sharedResult;
			}
			const leader = resolveLeader(resolutionProps);
			inFlightByCredentialId.set(credentialId, leader);
			try {
				return await leader;
			} finally {
				if (inFlightByCredentialId.get(credentialId) === leader) {
					inFlightByCredentialId.delete(credentialId);
				}
			}
		},
	};
}
