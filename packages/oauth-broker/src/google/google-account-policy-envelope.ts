import {
	googleAccountPolicySnapshotSchema,
	type GoogleAccountPolicyBinding,
	type GoogleAccountPolicySnapshot,
} from '@agent-vm/oauth-broker-contracts';

import {
	createOAuthPolicyEnvelopeCodec,
	oauthPolicyEnvelopeBindingSchema,
	type OAuthKeyEncryptionKey,
} from '../envelope-codec.js';
import {
	oauthStoredPolicySchema,
	type OAuthStoredPolicy,
} from '../oauth-credential-catalog-contracts.js';

const policyCodec = createOAuthPolicyEnvelopeCodec({
	payloadSchema: googleAccountPolicySnapshotSchema,
});

/** Missing or corrupt policy is unavailable, never implicit inheritance. No provider call occurs. */
export function readGoogleAccountPolicySnapshot(props: {
	readonly binding: GoogleAccountPolicyBinding;
	readonly policy: OAuthStoredPolicy | undefined;
	readonly keyEncryptionKey: OAuthKeyEncryptionKey;
}):
	| { readonly kind: 'verified'; readonly snapshot: GoogleAccountPolicySnapshot }
	| { readonly kind: 'unavailable' } {
	if (props.policy === undefined) return { kind: 'unavailable' };
	try {
		const policy = oauthStoredPolicySchema.parse(props.policy);
		if (policy.authorizationId !== props.binding.authorizationId) return { kind: 'unavailable' };
		const binding = oauthPolicyEnvelopeBindingSchema.parse({
			...props.binding,
			format: 1,
			overrideRevision: policy.overrideRevision,
		});
		const snapshot = policyCodec.decrypt({
			binding,
			envelope: policy.envelope,
			keyEncryptionKey: props.keyEncryptionKey,
		});
		if (
			snapshot.state !== policy.state ||
			JSON.stringify(oauthPolicyEnvelopeBindingSchema.strip().parse(snapshot)) !==
				JSON.stringify(binding)
		)
			return { kind: 'unavailable' };
		return { kind: 'verified', snapshot };
	} catch {
		return { kind: 'unavailable' };
	}
}
