import { randomUUID } from 'node:crypto';

import {
	googleAccountPolicySnapshotSchema,
	oauthScopeSchema,
} from '@agent-vm/oauth-broker-contracts';

import {
	createOAuthEnvelopeCodec,
	createOAuthPolicyEnvelopeCodec,
	oauthEnvelopeBindingSchema,
	oauthPolicyEnvelopeBindingSchema,
} from './envelope-codec.js';
import { googleStoredCredentialPayloadSchema } from './google/google-credential-payload.js';
import { googleWebClientCredentialsSchema } from './google/google-oauth-adapter.js';
import {
	oauthEnrollmentGrantInputSchema,
	type OAuthEnrollmentGrantInput,
} from './oauth-credential-catalog-contracts.js';

export const wrappingKey = new Uint8Array(32).fill(53);
const gmailReadScope = oauthScopeSchema.parse('https://www.googleapis.com/auth/gmail.readonly');
export const owner = { issuer: 'https://identity.example.test', userId: 'test-owner' };
export const credentialPayloadSchema = googleStoredCredentialPayloadSchema;
export const clientCredentials = googleWebClientCredentialsSchema.parse({
	web: {
		auth_uri: 'https://accounts.google.com/o/oauth2/v2/auth',
		client_id: 'test-client',
		client_secret: 'synthetic-client-secret',
		redirect_uris: ['https://auth.example.test/oauth/google/callback'],
		token_uri: 'https://oauth2.googleapis.com/token',
	},
});

export function enrollmentInput(props: {
	readonly accountId: string;
	readonly agentId: string;
	readonly accessTokenExpiresAtMs?: number;
	readonly ownerUserId?: string;
	readonly providerSubject?: string;
	readonly retainedAuthorization?: {
		readonly authorizationId: string;
		readonly authorizationMetadataRevision: number;
		readonly generation: number;
		readonly recordRevision: number;
	};
}): OAuthEnrollmentGrantInput {
	const binding = oauthEnvelopeBindingSchema.parse({
		accountId: props.accountId,
		agentId: props.agentId,
		applicationId: 'gmail-app',
		authorizationId: props.retainedAuthorization?.authorizationId ?? randomUUID(),
		authorizationMetadataRevision:
			(props.retainedAuthorization?.authorizationMetadataRevision ?? 0) + 1,
		catalogVersion: 'google-v1',
		clientBindingRevision: 'client-binding-1',
		clientId: 'test-client',
		credentialId: randomUUID(),
		generation: (props.retainedAuthorization?.generation ?? 0) + 1,
		owner: { ...owner, userId: props.ownerUserId ?? owner.userId },
		providerId: 'google',
		providerSubject: props.providerSubject ?? 'same-test-google-subject',
		zoneId: 'test-zone',
	});
	const policyBinding = oauthPolicyEnvelopeBindingSchema.parse({
		accountId: binding.accountId,
		agentId: binding.agentId,
		applicationId: binding.applicationId,
		authorizationId: binding.authorizationId,
		format: 1,
		overrideRevision: 1,
		owner: binding.owner,
		zoneId: binding.zoneId,
	});
	const policySnapshot = googleAccountPolicySnapshotSchema.parse({
		...policyBinding,
		state: 'active',
		lastEditor: null,
		lastEditedAtMs: null,
		services: { gmail: { read: { kind: 'inherit' }, write: { kind: 'inherit' } } },
	});
	return oauthEnrollmentGrantInputSchema.parse({
		...binding,
		accountAlias: 'My mailbox',
		accountLabel: 'Test account',
		envelope: createOAuthEnvelopeCodec({ payloadSchema: credentialPayloadSchema }).encrypt({
			binding,
			keyEncryptionKey: wrappingKey,
			keyEncryptionKeyVersion: 1,
			payload: {
				accessToken: `credential-for-${props.agentId}`,
				refreshToken: `refresh-for-${props.agentId}`,
				accessTokenExpiresAtMs: props.accessTokenExpiresAtMs ?? 1_000_000,
				authority: {
					accountAlias: 'My mailbox',
					authorizationMetadataRevision: binding.authorizationMetadataRevision,
					grantedScopes: [gmailReadScope],
					requestedScopes: [gmailReadScope],
					selectedGroupIds: ['gmail.read'],
				},
			},
		}),
		expectedRecordRevision: props.retainedAuthorization?.recordRevision ?? null,
		grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
		initialPolicyEnvelope:
			props.retainedAuthorization === undefined
				? createOAuthPolicyEnvelopeCodec({
						payloadSchema: googleAccountPolicySnapshotSchema,
					}).encrypt({
						binding: policyBinding,
						keyEncryptionKey: wrappingKey,
						keyEncryptionKeyVersion: 1,
						payload: policySnapshot,
					})
				: undefined,
		materialRevision: `sha256:${'A'.repeat(43)}`,
		requestedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
		selectedGroupIds: ['gmail.read'],
	});
}
