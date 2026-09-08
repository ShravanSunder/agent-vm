import {
	googleAccountPolicyBindingSchema,
	oauthAccountIdSchema,
	oauthApplicationIdSchema,
	oauthAuthorizationIdSchema,
	oauthBrowserOwnerIdentitySchema,
	oauthCredentialIdSchema,
	oauthProviderIdSchema,
} from '@agent-vm/oauth-broker-contracts';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { clean, randomBytes } from '@noble/ciphers/utils.js';
import { z } from 'zod';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const xchachaKeyByteLength = 32;
const xchachaNonceByteLength = 24;
const poly1305TagByteLength = 16;

const base64UrlBytesSchema = z
	.string()
	.min(1)
	.regex(/^[A-Za-z0-9_-]+$/u);

export const oauthProviderSubjectSchema = z
	.string()
	.min(1)
	.max(1_024)
	.refine((subject) => !subject.includes('\0'), {
		message: 'OAuth provider subjects must not contain NUL.',
	});

export const oauthEnvelopeBindingSchema = z
	.object({
		accountId: oauthAccountIdSchema,
		agentId: z.string().min(1).max(128),
		applicationId: oauthApplicationIdSchema,
		authorizationId: oauthAuthorizationIdSchema,
		authorizationMetadataRevision: z.number().int().positive(),
		catalogVersion: z.string().min(1).max(256),
		clientBindingRevision: z.string().min(1).max(256),
		clientId: z.string().min(1).max(1024),
		credentialId: oauthCredentialIdSchema,
		generation: z.number().int().positive(),
		owner: oauthBrowserOwnerIdentitySchema,
		providerId: oauthProviderIdSchema,
		providerSubject: oauthProviderSubjectSchema,
		zoneId: z.string().min(1).max(128),
	})
	.strict();
export type OAuthEnvelopeBinding = z.infer<typeof oauthEnvelopeBindingSchema>;

export const oauthPolicyEnvelopeBindingSchema = googleAccountPolicyBindingSchema
	.extend({
		format: z.literal(1),
		overrideRevision: z.number().int().positive(),
	})
	.strict();
export type OAuthPolicyEnvelopeBinding = z.infer<typeof oauthPolicyEnvelopeBindingSchema>;

export const encryptedOAuthEnvelopeSchema = z
	.object({
		dekCiphertext: base64UrlBytesSchema,
		dekWrapAlgorithm: z.literal('xchacha20-poly1305'),
		dekWrapNonce: base64UrlBytesSchema,
		envelopeVersion: z.literal(2),
		keyEncryptionKeyVersion: z.number().int().positive(),
		payloadAlgorithm: z.literal('xchacha20-poly1305'),
		payloadCiphertext: base64UrlBytesSchema,
		payloadNonce: base64UrlBytesSchema,
	})
	.strict();
export type EncryptedOAuthEnvelope = z.infer<typeof encryptedOAuthEnvelopeSchema>;

export const oauthKeyEncryptionKeySchema = z
	.instanceof(Uint8Array)
	.refine((key) => key.byteLength === xchachaKeyByteLength, {
		message: 'OAuth key-encryption keys must contain exactly 32 bytes.',
	});
export type OAuthKeyEncryptionKey = z.infer<typeof oauthKeyEncryptionKeySchema>;

function encodeBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

function decodeBase64Url(encoded: string, expectedByteLength?: number): Uint8Array {
	const decoded = new Uint8Array(Buffer.from(encoded, 'base64url'));
	if (encodeBase64Url(decoded) !== encoded) {
		throw new Error('OAuth envelope contains a non-canonical base64url value.');
	}
	if (expectedByteLength !== undefined && decoded.byteLength !== expectedByteLength) {
		throw new Error(
			`OAuth envelope field has ${String(decoded.byteLength)} bytes; expected ${String(expectedByteLength)}.`,
		);
	}
	return decoded;
}

function aadBytes(purpose: string, binding: unknown): Uint8Array {
	// The fixed strict binding schema determines property order, including nested
	// owner identity. JSON escaping avoids ambiguous delimiter-separated identities.
	return textEncoder.encode(JSON.stringify({ version: 2, purpose, binding }));
}

function serializePayload<TPayload>(
	payloadSchema: z.ZodType<TPayload>,
	payload: TPayload,
): Uint8Array {
	return textEncoder.encode(JSON.stringify(payloadSchema.parse(payload)));
}

function parsePayload<TPayload>(
	payloadSchema: z.ZodType<TPayload>,
	plaintextBytes: Uint8Array,
): TPayload {
	return payloadSchema.parse(JSON.parse(textDecoder.decode(plaintextBytes)) as unknown);
}

export interface OAuthEnvelopeCodec<TPayload, TBinding = OAuthEnvelopeBinding> {
	decrypt(props: {
		readonly binding: TBinding;
		readonly envelope: EncryptedOAuthEnvelope;
		readonly keyEncryptionKey: OAuthKeyEncryptionKey;
	}): TPayload;
	encrypt(props: {
		readonly binding: TBinding;
		readonly keyEncryptionKey: OAuthKeyEncryptionKey;
		readonly keyEncryptionKeyVersion: number;
		readonly payload: TPayload;
	}): EncryptedOAuthEnvelope;
}

export function createOAuthEnvelopeCodec<TPayload>(props: {
	readonly payloadSchema: z.ZodType<TPayload>;
	readonly randomBytes?: (byteLength: number) => Uint8Array;
}): OAuthEnvelopeCodec<TPayload> {
	return createBoundEnvelopeCodec({
		...props,
		bindingSchema: oauthEnvelopeBindingSchema,
		purpose: 'agent-vm/oauth/credential',
	});
}

export function createOAuthPolicyEnvelopeCodec<TPayload>(props: {
	readonly payloadSchema: z.ZodType<TPayload>;
	readonly randomBytes?: (byteLength: number) => Uint8Array;
}): OAuthEnvelopeCodec<TPayload, OAuthPolicyEnvelopeBinding> {
	return createBoundEnvelopeCodec({
		...props,
		bindingSchema: oauthPolicyEnvelopeBindingSchema,
		purpose: 'agent-vm/oauth/policy',
	});
}

function createBoundEnvelopeCodec<TPayload, TBinding>(props: {
	readonly bindingSchema: z.ZodType<TBinding>;
	readonly payloadSchema: z.ZodType<TPayload>;
	readonly purpose: 'agent-vm/oauth/credential' | 'agent-vm/oauth/policy';
	readonly randomBytes?: (byteLength: number) => Uint8Array;
}): OAuthEnvelopeCodec<TPayload, TBinding> {
	const payloadPurpose = `${props.purpose}/payload/v2`;
	const dekWrapPurpose = `${props.purpose}/dek-wrap/v2`;
	const randomBytesSource = props.randomBytes ?? randomBytes;
	return {
		decrypt: ({ binding: unparsedBinding, envelope: unparsedEnvelope, keyEncryptionKey }) => {
			const binding = props.bindingSchema.parse(unparsedBinding);
			const envelope = encryptedOAuthEnvelopeSchema.parse(unparsedEnvelope);
			const parsedKeyEncryptionKey = oauthKeyEncryptionKeySchema.parse(keyEncryptionKey);
			const payloadNonce = decodeBase64Url(envelope.payloadNonce, xchachaNonceByteLength);
			const dekWrapNonce = decodeBase64Url(envelope.dekWrapNonce, xchachaNonceByteLength);
			const encryptedDek = decodeBase64Url(
				envelope.dekCiphertext,
				xchachaKeyByteLength + poly1305TagByteLength,
			);
			const payloadCiphertext = decodeBase64Url(envelope.payloadCiphertext);
			if (payloadCiphertext.byteLength < poly1305TagByteLength) {
				throw new Error('OAuth payload ciphertext is shorter than its authentication tag.');
			}
			let dataEncryptionKey: Uint8Array | undefined;
			let plaintextBytes: Uint8Array | undefined;
			const wrapAad = aadBytes(dekWrapPurpose, binding);
			const payloadAad = aadBytes(payloadPurpose, binding);
			try {
				dataEncryptionKey = xchacha20poly1305(
					parsedKeyEncryptionKey,
					dekWrapNonce,
					wrapAad,
				).decrypt(encryptedDek);
				plaintextBytes = xchacha20poly1305(dataEncryptionKey, payloadNonce, payloadAad).decrypt(
					payloadCiphertext,
				);
				return parsePayload(props.payloadSchema, plaintextBytes);
			} catch (error: unknown) {
				throw new Error('OAuth envelope authentication or payload validation failed.', {
					cause: error,
				});
			} finally {
				if (dataEncryptionKey !== undefined) clean(dataEncryptionKey);
				if (plaintextBytes !== undefined) clean(plaintextBytes);
				clean(payloadNonce, dekWrapNonce, encryptedDek, payloadCiphertext, wrapAad, payloadAad);
			}
		},
		encrypt: ({ binding: unparsedBinding, keyEncryptionKey, keyEncryptionKeyVersion, payload }) => {
			const binding = props.bindingSchema.parse(unparsedBinding);
			const parsedKeyEncryptionKey = oauthKeyEncryptionKeySchema.parse(keyEncryptionKey);
			if (!Number.isSafeInteger(keyEncryptionKeyVersion) || keyEncryptionKeyVersion <= 0) {
				throw new Error('OAuth key-encryption-key versions must be positive safe integers.');
			}
			const dataEncryptionKey = randomBytesSource(xchachaKeyByteLength);
			const payloadNonce = randomBytesSource(xchachaNonceByteLength);
			const dekWrapNonce = randomBytesSource(xchachaNonceByteLength);
			const plaintextBytes = serializePayload(props.payloadSchema, payload);
			const wrapAad = aadBytes(dekWrapPurpose, binding);
			const payloadAad = aadBytes(payloadPurpose, binding);
			try {
				const payloadCiphertext = xchacha20poly1305(
					dataEncryptionKey,
					payloadNonce,
					payloadAad,
				).encrypt(plaintextBytes);
				const encryptedDek = xchacha20poly1305(
					parsedKeyEncryptionKey,
					dekWrapNonce,
					wrapAad,
				).encrypt(dataEncryptionKey);
				return encryptedOAuthEnvelopeSchema.parse({
					dekCiphertext: encodeBase64Url(encryptedDek),
					dekWrapAlgorithm: 'xchacha20-poly1305',
					dekWrapNonce: encodeBase64Url(dekWrapNonce),
					envelopeVersion: 2,
					keyEncryptionKeyVersion,
					payloadAlgorithm: 'xchacha20-poly1305',
					payloadCiphertext: encodeBase64Url(payloadCiphertext),
					payloadNonce: encodeBase64Url(payloadNonce),
				});
			} finally {
				clean(dataEncryptionKey, payloadNonce, dekWrapNonce, plaintextBytes, wrapAad, payloadAad);
			}
		},
	};
}
