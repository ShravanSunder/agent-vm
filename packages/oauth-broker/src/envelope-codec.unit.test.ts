import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	createOAuthEnvelopeCodec,
	encryptedOAuthEnvelopeSchema,
	oauthEnvelopeBindingSchema,
} from './envelope-codec.js';

const testPayloadSchema = z
	.object({
		accessToken: z.string().min(1),
		refreshToken: z.string().min(1),
	})
	.strict();

const binding = oauthEnvelopeBindingSchema.parse({
	accountProfileId: 'personal-google',
	applicationId: 'gmail-app',
	credentialId: '11111111-1111-4111-8111-111111111111',
	providerId: 'google',
	providerSubject: 'google-subject-1',
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
					accountProfileId: 'work-google',
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
			encryptedOAuthEnvelopeSchema.safeParse({ ...envelope, envelopeVersion: 2 }).success,
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
});
