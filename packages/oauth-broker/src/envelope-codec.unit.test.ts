import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	createOAuthEnvelopeCodec,
	createOAuthPolicyEnvelopeCodec,
	encryptedOAuthEnvelopeSchema,
	oauthEnvelopeBindingSchema,
	oauthPolicyEnvelopeBindingSchema,
} from './envelope-codec.js';

const testPayloadSchema = z
	.object({
		accessToken: z.string().min(1),
		refreshToken: z.string().min(1),
	})
	.strict();

const binding = oauthEnvelopeBindingSchema.parse({
	accountId: '22222222-2222-4222-8222-222222222222',
	agentId: 'sun',
	applicationId: 'gmail-app',
	authorizationId: '33333333-3333-4333-8333-333333333333',
	authorizationMetadataRevision: 1,
	catalogVersion: 'google-v1',
	clientBindingRevision: 'client-binding-1',
	clientId: 'test-google-client',
	credentialId: '11111111-1111-4111-8111-111111111111',
	generation: 1,
	owner: { issuer: 'https://clerk.example.test', userId: 'user-owner-1' },
	providerId: 'google',
	providerSubject: 'google-subject-1',
	zoneId: 'household',
});

function deterministicRandomBytes(): (byteLength: number) => Uint8Array {
	let nextByte = 1;
	return (byteLength) => {
		const bytes = new Uint8Array(byteLength);
		for (let index = 0; index < byteLength; index += 1) {
			bytes[index] = nextByte;
			nextByte = (nextByte + 1) % 256;
		}
		return bytes;
	};
}

function mutateBase64Url(encoded: string): string {
	const bytes = Buffer.from(encoded, 'base64url');
	bytes[0] = (bytes[0] ?? 0) ^ 0xff;
	return bytes.toString('base64url');
}

describe('OAuth envelope codec', () => {
	it('round-trips a strict provider payload with independent nonces', () => {
		const codec = createOAuthEnvelopeCodec({
			payloadSchema: testPayloadSchema,
			randomBytes: deterministicRandomBytes(),
		});
		const keyEncryptionKey = new Uint8Array(32).fill(91);
		const envelope = codec.encrypt({
			binding,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			payload: { accessToken: 'access-secret', refreshToken: 'refresh-secret' },
		});

		expect(envelope.payloadNonce).not.toBe(envelope.dekWrapNonce);
		expect(JSON.stringify(envelope)).not.toContain('access-secret');
		expect(JSON.stringify(envelope)).not.toContain('refresh-secret');
		expect(codec.decrypt({ binding, envelope, keyEncryptionKey })).toEqual({
			accessToken: 'access-secret',
			refreshToken: 'refresh-secret',
		});
	});

	it.each(['payloadCiphertext', 'dekCiphertext'] as const)(
		'rejects authenticated %s tampering',
		(fieldName) => {
			const codec = createOAuthEnvelopeCodec({
				payloadSchema: testPayloadSchema,
				randomBytes: deterministicRandomBytes(),
			});
			const keyEncryptionKey = new Uint8Array(32).fill(44);
			const envelope = codec.encrypt({
				binding,
				keyEncryptionKey,
				keyEncryptionKeyVersion: 1,
				payload: { accessToken: 'access-secret', refreshToken: 'refresh-secret' },
			});
			const tamperedEnvelope = encryptedOAuthEnvelopeSchema.parse({
				...envelope,
				[fieldName]: mutateBase64Url(envelope[fieldName]),
			});

			expect(() =>
				codec.decrypt({ binding, envelope: tamperedEnvelope, keyEncryptionKey }),
			).toThrow('authentication or payload validation failed');
		},
	);

	it('rejects metadata swaps through additional authenticated data', () => {
		const codec = createOAuthEnvelopeCodec({
			payloadSchema: testPayloadSchema,
			randomBytes: deterministicRandomBytes(),
		});
		const keyEncryptionKey = new Uint8Array(32).fill(17);
		const envelope = codec.encrypt({
			binding,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			payload: { accessToken: 'access-secret', refreshToken: 'refresh-secret' },
		});

		expect(() =>
			codec.decrypt({
				binding: oauthEnvelopeBindingSchema.parse({
					...binding,
					accountId: '44444444-4444-4444-8444-444444444444',
				}),
				envelope,
				keyEncryptionKey,
			}),
		).toThrow('authentication or payload validation failed');
	});

	it('rejects unknown versions, malformed lengths, and invalid KEK sizes', () => {
		const codec = createOAuthEnvelopeCodec({
			payloadSchema: testPayloadSchema,
			randomBytes: deterministicRandomBytes(),
		});
		const keyEncryptionKey = new Uint8Array(32).fill(33);
		const envelope = codec.encrypt({
			binding,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			payload: { accessToken: 'access-secret', refreshToken: 'refresh-secret' },
		});

		expect(
			encryptedOAuthEnvelopeSchema.safeParse({ ...envelope, envelopeVersion: 1 }).success,
		).toBe(false);
		expect(() =>
			codec.decrypt({
				binding,
				envelope: { ...envelope, payloadNonce: Buffer.alloc(23).toString('base64url') },
				keyEncryptionKey,
			}),
		).toThrow('expected 24');
		expect(() =>
			codec.encrypt({
				binding,
				keyEncryptionKey: new Uint8Array(31),
				keyEncryptionKeyVersion: 1,
				payload: { accessToken: 'access-secret', refreshToken: 'refresh-secret' },
			}),
		).toThrow();
	});

	it.each([
		{ agentId: 'ember' },
		{ zoneId: 'another-zone' },
		{ owner: { issuer: 'https://another-clerk.example.test', userId: 'user-owner-1' } },
		{ owner: { issuer: 'https://clerk.example.test', userId: 'another-owner' } },
		{ applicationId: 'another-app' },
		{ authorizationId: '44444444-4444-4444-8444-444444444444' },
		{ authorizationMetadataRevision: 2 },
		{ catalogVersion: 'another-catalog' },
		{ clientBindingRevision: 'another-client-binding' },
		{ clientId: 'another-client' },
		{ credentialId: '44444444-4444-4444-8444-444444444444' },
		{ generation: 2 },
		{ providerId: 'another-provider' },
		{ providerSubject: 'another-subject' },
	])('rejects changed authorization binding %j', (changedFields) => {
		// Arrange
		const codec = createOAuthEnvelopeCodec({ payloadSchema: testPayloadSchema });
		const keyEncryptionKey = new Uint8Array(32).fill(11);
		const envelope = codec.encrypt({
			binding,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			payload: { accessToken: 'test-access', refreshToken: 'test-refresh' },
		});

		// Act / Assert: a row swap cannot select another principal or consent generation.
		expect(() =>
			codec.decrypt({
				binding: oauthEnvelopeBindingSchema.parse({ ...binding, ...changedFields }),
				envelope,
				keyEncryptionKey,
			}),
		).toThrow('authentication or payload validation failed');
	});

	it('canonicalizes object key order without delimiting identity strings', () => {
		// Arrange
		const codec = createOAuthEnvelopeCodec({ payloadSchema: testPayloadSchema });
		const keyEncryptionKey = new Uint8Array(32).fill(21);
		const payload = { accessToken: 'test-access', refreshToken: 'test-refresh' };
		const envelope = codec.encrypt({
			binding,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			payload,
		});
		const reordered = oauthEnvelopeBindingSchema.parse({
			...Object.fromEntries(Object.entries(binding).toReversed()),
			owner: { userId: binding.owner.userId, issuer: binding.owner.issuer },
		});

		// Act / Assert
		expect(codec.decrypt({ binding: reordered, envelope, keyEncryptionKey })).toEqual(payload);
		expect(envelope.envelopeVersion).toBe(2);
	});

	it('binds policy snapshots independently of credential lifecycle and config defaults', () => {
		// Arrange: policy survives credential replacement and disconnect.
		// Use the same synthetic payload shape to isolate purpose separation from
		// schema mismatch; real policy payloads never contain Google tokens.
		const codec = createOAuthPolicyEnvelopeCodec({ payloadSchema: testPayloadSchema });
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
		const keyEncryptionKey = new Uint8Array(32).fill(41);
		const payload = { accessToken: 'synthetic-payload', refreshToken: 'synthetic-payload' };
		const envelope = codec.encrypt({
			binding: policyBinding,
			keyEncryptionKey,
			keyEncryptionKeyVersion: 1,
			payload,
		});

		// Act / Assert
		expect(codec.decrypt({ binding: policyBinding, envelope, keyEncryptionKey })).toEqual(payload);
		expect(() =>
			codec.decrypt({
				binding: { ...policyBinding, overrideRevision: 2 },
				envelope,
				keyEncryptionKey,
			}),
		).toThrow('authentication or payload validation failed');
		expect(() =>
			createOAuthEnvelopeCodec({ payloadSchema: testPayloadSchema }).decrypt({
				binding,
				envelope,
				keyEncryptionKey,
			}),
		).toThrow('authentication or payload validation failed');
	});

	it('rejects a different full-length wrapping key', () => {
		// Arrange
		const codec = createOAuthEnvelopeCodec({ payloadSchema: testPayloadSchema });
		const envelope = codec.encrypt({
			binding,
			keyEncryptionKey: new Uint8Array(32).fill(19),
			keyEncryptionKeyVersion: 1,
			payload: { accessToken: 'test-access', refreshToken: 'test-refresh' },
		});

		// Act / Assert
		expect(() =>
			codec.decrypt({
				binding,
				envelope,
				keyEncryptionKey: new Uint8Array(32).fill(20),
			}),
		).toThrow('authentication or payload validation failed');
	});
});
