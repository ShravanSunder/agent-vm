import { googleAccountPolicyBindingSchema } from '@agent-vm/oauth-broker-contracts';
import { describe, expect, it } from 'vitest';

import { enrollmentInput, wrappingKey } from '../oauth-catalog-test-fixture.js';
import { oauthStoredPolicySchema } from '../oauth-credential-catalog-contracts.js';
import { readGoogleAccountPolicySnapshot } from './google-account-policy-envelope.js';

function fixture(): Parameters<typeof readGoogleAccountPolicySnapshot>[0] {
	const enrollment = enrollmentInput({
		accountId: '11111111-1111-4111-8111-111111111111',
		agentId: 'sun',
	});
	return {
		binding: googleAccountPolicyBindingSchema.strip().parse(enrollment),
		keyEncryptionKey: wrappingKey,
		policy: oauthStoredPolicySchema.parse({
			authorizationId: enrollment.authorizationId,
			envelope: enrollment.initialPolicyEnvelope,
			overrideRevision: 1,
			state: 'active',
			transitionId: '22222222-2222-4222-8222-222222222222',
			updatedAtMs: 1_000,
		}),
	};
}
describe('authenticated account policy reads', () => {
	it('verifies the inherit snapshot without a credential refresh', () => {
		// Arrange / Act / Assert
		expect(readGoogleAccountPolicySnapshot(fixture())).toMatchObject({
			kind: 'verified',
			snapshot: { services: { gmail: { read: { kind: 'inherit' }, write: { kind: 'inherit' } } } },
		});
	});
	it('does not use defaults for a missing policy row', () => {
		// Arrange / Act / Assert
		expect(readGoogleAccountPolicySnapshot({ ...fixture(), policy: undefined })).toEqual({
			kind: 'unavailable',
		});
	});
	it.each(['state', 'revision', 'key', 'agent', 'owner'] as const)(
		'rejects an altered %s',
		(field) => {
			// Arrange
			const input = fixture();
			if (input.policy === undefined) throw new Error('Expected policy.');
			// Act
			const result = readGoogleAccountPolicySnapshot({
				...input,
				keyEncryptionKey: field === 'key' ? new Uint8Array(32) : input.keyEncryptionKey,
				binding: {
					...input.binding,
					agentId: field === 'agent' ? 'ember' : input.binding.agentId,
					owner:
						field === 'owner'
							? { ...input.binding.owner, userId: 'other-owner' }
							: input.binding.owner,
				},
				policy: {
					...input.policy,
					state: field === 'state' ? 'applying' : input.policy.state,
					overrideRevision: field === 'revision' ? 2 : 1,
				},
			});
			// Assert
			expect(result).toEqual({ kind: 'unavailable' });
		},
	);
});
