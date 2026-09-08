import { randomBytes, randomUUID } from 'node:crypto';

import {
	googleOAuthApplicationIdSchema,
	type GoogleOAuthApplicationId,
	type OAuthConfig,
} from '@agent-vm/config-contracts';
import {
	googleAccountPolicySnapshotSchema,
	googleAccountPolicyBindingSchema,
} from '@agent-vm/oauth-broker-contracts';
import { z } from 'zod';

import {
	createOAuthEnvelopeCodec,
	createOAuthPolicyEnvelopeCodec,
	oauthEnvelopeBindingSchema,
	oauthPolicyEnvelopeBindingSchema,
	type OAuthKeyEncryptionKey,
} from '../envelope-codec.js';
import { type OAuthCompletionSession } from '../oauth-ceremony-contracts.js';
import {
	oauthEnrollmentGrantInputSchema,
	type OAuthCredentialCatalog,
	type OAuthStoredAuthorization,
} from '../oauth-credential-catalog-contracts.js';
import { readGoogleAccountPolicySnapshot } from './google-account-policy-envelope.js';
import { googleStoredCredentialPayloadSchema } from './google-credential-payload.js';
import {
	googleProviderAuthorizationSchema,
	type GoogleProviderAuthorization,
	type GoogleWebClientCredentials,
} from './google-oauth-adapter.js';
import { type GoogleOAuthPermissionPolicy } from './google-oauth-permission-policy.js';
import { getGooglePermissionGroups } from './google-permission-catalog.js';

export interface OAuthAuthorizationContainmentTarget {
	readonly accountId: OAuthStoredAuthorization['accountId'];
	readonly agentId: string;
	readonly applicationId: OAuthStoredAuthorization['applicationId'];
	readonly authorizationId: OAuthStoredAuthorization['authorizationId'];
	/** Contains any older material for this authorization, including a pre-refresh token. */
	readonly throughGeneration: number;
	readonly zoneId: string;
}
export type GoogleAuthorizationCommitResult =
	| { readonly kind: 'committed'; readonly authorization: OAuthStoredAuthorization }
	| {
			readonly kind: 'replacement-pending' | 'containment-failed';
			readonly authorization: OAuthStoredAuthorization;
	  }
	| {
			readonly kind:
				| 'authorization-denied'
				| 'duplicate-authorization'
				| 'stale-authorization'
				| 'configuration-change-required'
				| 'subject-mismatch'
				| 'scope-mismatch'
				| 'unavailable';
	  };

export interface GoogleAuthorizationCommitter {
	/** Host-only: the broker has claimed the completion once using a freshly verified session. */
	commitConfirmedGrant(props: {
		readonly session: Extract<
			OAuthCompletionSession<GoogleProviderAuthorization>,
			{ kind: 'committing' }
		>;
		readonly accountAlias: string;
	}): Promise<GoogleAuthorizationCommitResult>;
}

export function createGoogleAuthorizationCommitter(props: {
	readonly runAuthorityCommit?: <TResult>(commit: () => TResult) => Promise<TResult>;
	readonly catalog: OAuthCredentialCatalog;
	readonly clientCredentialsByApplication: Readonly<
		Record<GoogleOAuthApplicationId, GoogleWebClientCredentials>
	>;
	readonly clientBindingRevisionsByApplication: Readonly<Record<GoogleOAuthApplicationId, string>>;
	readonly config: OAuthConfig;
	readonly configRevision: string;
	readonly containAuthorizationMaterial: (
		target: OAuthAuthorizationContainmentTarget,
	) => Promise<'contained' | 'pending' | 'failed'>;
	readonly isAdmissionOpen: () => boolean;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	readonly keyEncryptionKeyVersion: number;
	readonly now: () => number;
	readonly permissionPolicy: GoogleOAuthPermissionPolicy;
}): GoogleAuthorizationCommitter {
	const credentialCodec = createOAuthEnvelopeCodec({
		payloadSchema: googleStoredCredentialPayloadSchema,
	});
	const policyCodec = createOAuthPolicyEnvelopeCodec({
		payloadSchema: googleAccountPolicySnapshotSchema,
	});
	return {
		commitConfirmedGrant: async ({
			session,
			accountAlias,
		}): Promise<GoogleAuthorizationCommitResult> => {
			if (!props.isAdmissionOpen() || session.expiresAtMs <= props.now())
				return { kind: 'unavailable' };
			if (session.kind !== 'committing' || session.configRevision !== props.configRevision)
				return { kind: 'configuration-change-required' };
			const owner = { issuer: session.identity.issuer, userId: session.identity.userId };
			if (
				owner.issuer !== props.config.browser.identity.issuer ||
				!Object.values(props.config.owners).some(
					(admission) =>
						admission.clerkUserId === owner.userId &&
						admission.allowedAgentIds.includes(session.agentId),
				)
			)
				return { kind: 'authorization-denied' };
			if (
				session.initiator.kind === 'website_owner' &&
				(session.initiator.ownerIdentity.issuer !== owner.issuer ||
					session.initiator.ownerIdentity.userId !== owner.userId)
			)
				return { kind: 'authorization-denied' };
			if (session.initiator.kind === 'agent' && session.initiator.agentId !== session.agentId)
				return { kind: 'authorization-denied' };
			const application = googleOAuthApplicationIdSchema.safeParse(session.applicationId);
			const alias = z.string().trim().min(1).max(320).safeParse(accountAlias);
			if (
				!application.success ||
				!alias.success ||
				!session.applicationIds.includes(session.applicationId) ||
				session.target.kind === 'disconnect'
			)
				return { kind: 'authorization-denied' };
			const applicationId = application.data;
			const provider = googleProviderAuthorizationSchema.safeParse(session.providerGrant);
			if (!provider.success) return { kind: 'unavailable' };
			const candidate = provider.data;
			let scopes: ReturnType<GoogleOAuthPermissionPolicy['scopesForApplication']>;
			try {
				const selections = props.permissionPolicy.validateSelections({
					agentId: session.agentId,
					selections: session.confirmedSelections,
				});
				scopes = props.permissionPolicy.scopesForApplication(applicationId, selections);
			} catch {
				return { kind: 'configuration-change-required' };
			}
			const expected = new Set(scopes);
			const actual = new Set(candidate.grantedScopes);
			const confirmed = new Set(session.confirmedScopes);
			if (
				expected.size === 0 ||
				expected.size !== actual.size ||
				expected.size !== confirmed.size ||
				[...expected].some((scope) => !actual.has(scope) || !confirmed.has(scope))
			)
				return { kind: 'scope-mismatch' };

			const target = session.target;
			const knownAccount = target.kind === 'enroll' ? target.accountBinding : target;
			if (knownAccount !== undefined && knownAccount.providerSubject !== candidate.accountSubject)
				return { kind: 'subject-mismatch' };
			const account = props.catalog.findAccount({
				zoneId: props.config.zoneId,
				providerId: 'google',
				providerSubject: candidate.accountSubject,
			});
			if (
				account !== undefined &&
				(account.owner.issuer !== owner.issuer || account.owner.userId !== owner.userId)
			)
				return { kind: 'authorization-denied' };
			if (knownAccount !== undefined && account?.accountId !== knownAccount.accountId)
				return { kind: 'subject-mismatch' };
			const existing =
				account === undefined
					? undefined
					: props.catalog.getAuthorizationForAccountApplication({
							accountId: account.accountId,
							agentId: session.agentId,
							applicationId: session.applicationId,
							zoneId: props.config.zoneId,
						});
			if (
				target.kind === 'enroll' &&
				existing !== undefined &&
				existing.accessState !== 'disconnected'
			)
				return { kind: 'duplicate-authorization' };
			if (
				target.kind === 'reauthorize' &&
				(target.applicationId !== session.applicationId ||
					existing?.accessState !== 'connected' ||
					existing.authorizationId !== target.authorizationId ||
					existing.generation !== target.generation ||
					existing.authorizationMetadataRevision !== target.authorizationMetadataRevision)
			)
				return { kind: 'stale-authorization' };

			const binding = oauthEnvelopeBindingSchema.parse({
				accountId: account?.accountId ?? randomUUID(),
				agentId: session.agentId,
				applicationId: session.applicationId,
				authorizationId: existing?.authorizationId ?? randomUUID(),
				authorizationMetadataRevision: (existing?.authorizationMetadataRevision ?? 0) + 1,
				catalogVersion: props.config.providers.google.catalogVersion,
				clientBindingRevision: props.clientBindingRevisionsByApplication[applicationId],
				clientId: props.clientCredentialsByApplication[applicationId].web.client_id,
				credentialId: randomUUID(),
				generation: (existing?.generation ?? 0) + 1,
				owner,
				providerId: 'google',
				providerSubject: candidate.accountSubject,
				zoneId: props.config.zoneId,
			});
			let initialPolicyEnvelope;
			if (existing !== undefined) {
				// Reconnect and replacement retain the authenticated companion, never
				// infer inheritance from a missing/corrupt row or the latest defaults.
				const policy = readGoogleAccountPolicySnapshot({
					binding: googleAccountPolicyBindingSchema.strip().parse(binding),
					policy: props.catalog.getPolicy(existing.authorizationId),
					keyEncryptionKey: props.keyEncryptionKey,
				});
				if (policy.kind !== 'verified' || policy.snapshot.state !== 'active')
					return { kind: 'unavailable' };
			} else {
				const policyBinding = oauthPolicyEnvelopeBindingSchema.parse({
					accountId: binding.accountId,
					agentId: binding.agentId,
					applicationId: binding.applicationId,
					authorizationId: binding.authorizationId,
					format: 1,
					overrideRevision: 1,
					owner,
					zoneId: binding.zoneId,
				});
				const familyId = props.config.providers.google.applications[applicationId].catalogFamilyId;
				const services = [
					...new Set(
						getGooglePermissionGroups()
							.filter((group) => group.familyId === familyId)
							.map((group) => group.serviceId),
					),
				];
				initialPolicyEnvelope = policyCodec.encrypt({
					binding: policyBinding,
					keyEncryptionKey: props.keyEncryptionKey,
					keyEncryptionKeyVersion: props.keyEncryptionKeyVersion,
					payload: googleAccountPolicySnapshotSchema.parse({
						...policyBinding,
						state: 'active',
						lastEditor: null,
						lastEditedAtMs: null,
						services: Object.fromEntries(
							services.map((serviceId) => [
								serviceId,
								{ read: { kind: 'inherit' }, write: { kind: 'inherit' } },
							]),
						),
					}),
				});
			}
			const selectedGroupIds = session.confirmedSelections[session.applicationId] ?? [];
			const envelope = credentialCodec.encrypt({
				binding,
				keyEncryptionKey: props.keyEncryptionKey,
				keyEncryptionKeyVersion: props.keyEncryptionKeyVersion,
				payload: {
					accessToken: candidate.accessToken,
					accessTokenExpiresAtMs: candidate.accessTokenExpiresAtMs,
					refreshToken: candidate.refreshToken,
					authority: {
						accountAlias: alias.data,
						authorizationMetadataRevision: binding.authorizationMetadataRevision,
						grantedScopes: candidate.grantedScopes,
						requestedScopes: scopes,
						selectedGroupIds,
					},
				},
			});
			const input = oauthEnrollmentGrantInputSchema.parse({
				...binding,
				accountAlias: alias.data,
				accountLabel: candidate.accountEmail,
				envelope,
				expectedRecordRevision: existing?.recordRevision ?? null,
				initialPolicyEnvelope,
				grantedScopes: candidate.grantedScopes,
				requestedScopes: scopes,
				selectedGroupIds,
				materialRevision: `sha256:${randomBytes(32).toString('base64url')}`,
			});
			// No await between current-authority checks and the synchronous SQLite CAS.
			const commit = (): ReturnType<typeof props.catalog.commitEnrollmentGrant> =>
				target.kind === 'reauthorize'
					? props.catalog.replaceAuthorization(input)
					: props.catalog.commitEnrollmentGrant(input);
			const committed =
				props.runAuthorityCommit === undefined ? commit() : await props.runAuthorityCommit(commit);
			if (committed.kind !== 'committed')
				return {
					kind:
						committed.kind === 'duplicate-authorization'
							? 'duplicate-authorization'
							: committed.kind === 'owner-mismatch'
								? 'authorization-denied'
								: 'stale-authorization',
				};
			const authorization = committed.authorization;
			if (authorization.accessState !== 'replacing') return { kind: 'committed', authorization };
			if (existing === undefined) throw new Error('Replacement has no previous authorization.');
			let containment: 'contained' | 'pending' | 'failed';
			try {
				containment = await props.containAuthorizationMaterial({
					accountId: existing.accountId,
					agentId: existing.agentId,
					applicationId: existing.applicationId,
					authorizationId: existing.authorizationId,
					throughGeneration: existing.generation,
					zoneId: existing.zoneId,
				});
			} catch {
				containment = 'failed';
			}
			if (containment !== 'contained')
				return {
					kind: containment === 'pending' ? 'replacement-pending' : 'containment-failed',
					authorization,
				};
			if (!props.isAdmissionOpen()) return { kind: 'replacement-pending', authorization };
			try {
				const settled = props.catalog.settleAuthorizationTransition({
					authorizationId: authorization.authorizationId,
					expectedRecordRevision: authorization.recordRevision,
					transitionId: authorization.transitionId,
				});
				return settled.kind === 'updated'
					? { kind: 'committed', authorization: settled.authorization }
					: { kind: 'stale-authorization' };
			} catch {
				return { kind: 'replacement-pending', authorization };
			}
		},
	};
}
