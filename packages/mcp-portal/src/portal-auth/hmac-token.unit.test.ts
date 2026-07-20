import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
	hashCallArguments,
	mcpPortalApprovalTokenAudience,
	signAudienceScopedApprovalToken,
	signApprovalToken,
	verifyAudienceScopedApprovalToken,
	verifyApprovalToken,
	type ApprovalTokenCallDigest,
} from './hmac-token.js';

const testKey = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

const sampleCallDigest: ApprovalTokenCallDigest = {
	argumentsHash: hashCallArguments({ team: 'core', title: 'hi' }),
	namespace: 'linear',
	toolName: 'create_issue',
};

function base64UrlEncode(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64url');
}

function signPayload(payloadEncoded: string): string {
	const signature = createHmac('sha256', testKey)
		.update(`${mcpPortalApprovalTokenAudience}\0${payloadEncoded}`)
		.digest('base64url');
	return `${payloadEncoded}.${signature}`;
}

describe('hashCallArguments', () => {
	it('is deterministic regardless of object property order', () => {
		expect(hashCallArguments({ a: 1, b: 2 })).toBe(hashCallArguments({ b: 2, a: 1 }));
	});
});

describe('signApprovalToken / verifyApprovalToken', () => {
	it('cryptographically separates product audiences', () => {
		const token = signAudienceScopedApprovalToken({
			agentId: 'shravan',
			audience: 'mcp-portal:approval',
			calls: [sampleCallDigest],
			expiresAtMs: 20_000,
			issuedAtMs: 10_000,
			jti: 'approval-audience',
			key: testKey,
		});

		expect(
			verifyAudienceScopedApprovalToken({
				agentId: 'shravan',
				audience: 'tool-portal:approval',
				calls: [sampleCallDigest],
				key: testKey,
				nowMs: 10_000,
				token,
			}),
		).toEqual({ ok: false, reason: 'signature-mismatch' });
		expect(
			verifyAudienceScopedApprovalToken({
				agentId: 'shravan',
				audience: 'mcp-portal:approval',
				calls: [sampleCallDigest],
				key: testKey,
				nowMs: 10_000,
				token,
			}),
		).toEqual({ ok: true });
	});

	it('rejects an empty approval audience instead of falling back', () => {
		expect(() =>
			signAudienceScopedApprovalToken({
				agentId: 'shravan',
				audience: '',
				calls: [sampleCallDigest],
				expiresAtMs: 20_000,
				issuedAtMs: 10_000,
				jti: 'approval-empty-audience',
				key: testKey,
			}),
		).toThrow(/audience/u);
	});

	it('verifies a freshly signed token', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleCallDigest],
			expiresAtMs: 20_000,
			issuedAtMs: 10_000,
			jti: 'approval-1',
			key: testKey,
		});

		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [sampleCallDigest],
				key: testKey,
				nowMs: 10_000,
				token,
			}),
		).toEqual({ ok: true });
	});

	it('rejects expired tokens', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleCallDigest],
			expiresAtMs: 10_000,
			issuedAtMs: 1_000,
			jti: 'approval-expired',
			key: testKey,
		});

		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [sampleCallDigest],
				key: testKey,
				nowMs: 10_001,
				token,
			}),
		).toEqual({ ok: false, reason: 'expired' });
	});

	it('rejects tokens for a different agent', () => {
		const token = signApprovalToken({
			agentId: 'other-agent',
			calls: [sampleCallDigest],
			expiresAtMs: 20_000,
			issuedAtMs: 10_000,
			jti: 'approval-agent',
			key: testKey,
		});

		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [sampleCallDigest],
				key: testKey,
				nowMs: 10_000,
				token,
			}),
		).toEqual({ ok: false, reason: 'agent-mismatch' });
	});

	it('rejects tokens for different call arguments', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleCallDigest],
			expiresAtMs: 20_000,
			issuedAtMs: 10_000,
			jti: 'approval-calls',
			key: testKey,
		});

		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [
					{
						...sampleCallDigest,
						argumentsHash: hashCallArguments({ team: 'core', title: 'changed' }),
					},
				],
				key: testKey,
				nowMs: 10_000,
				token,
			}),
		).toEqual({ ok: false, reason: 'call-mismatch' });
	});

	it('rejects malformed token shapes and payloads', () => {
		const malformedPayloadToken = signPayload(base64UrlEncode('not json'));

		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [sampleCallDigest],
				key: testKey,
				nowMs: 10_000,
				token: 'only-one-part',
			}),
		).toEqual({ ok: false, reason: 'malformed' });
		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [sampleCallDigest],
				key: testKey,
				nowMs: 10_000,
				token: 'a.b.c',
			}),
		).toEqual({ ok: false, reason: 'malformed' });
		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [sampleCallDigest],
				key: testKey,
				nowMs: 10_000,
				token: malformedPayloadToken,
			}),
		).toEqual({ ok: false, reason: 'malformed' });
	});

	it('rejects tokens with mismatched signatures', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleCallDigest],
			expiresAtMs: 20_000,
			issuedAtMs: 10_000,
			jti: 'approval-signature',
			key: testKey,
		});
		const [payloadEncoded] = token.split('.');
		if (payloadEncoded === undefined) {
			throw new Error('signed token did not contain a payload');
		}

		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [sampleCallDigest],
				key: testKey,
				nowMs: 10_000,
				token: `${payloadEncoded}.not-the-signature`,
			}),
		).toEqual({ ok: false, reason: 'signature-mismatch' });
	});

	it('rejects tokens whose signer-chosen lifetime exceeds the verifier cap', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleCallDigest],
			expiresAtMs: 20_001,
			issuedAtMs: 10_000,
			jti: 'approval-long-lived',
			key: testKey,
		});

		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [sampleCallDigest],
				key: testKey,
				maxLifetimeMs: 10_000,
				nowMs: 10_001,
				token,
			}),
		).toEqual({ ok: false, reason: 'ttl-exceeded' });
	});

	it('rejects replayed token identifiers through the verifier consumed-token hook', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleCallDigest],
			expiresAtMs: 20_000,
			issuedAtMs: 10_000,
			jti: 'approval-replay',
			key: testKey,
		});
		const consumed = new Set<string>();
		const consumeTokenId = (
			jti: string,
		): { readonly ok: true } | { readonly ok: false; readonly reason: 'replayed' } => {
			if (consumed.has(jti)) {
				return { ok: false, reason: 'replayed' };
			}
			consumed.add(jti);
			return { ok: true };
		};
		const verificationProps = {
			agentId: 'shravan',
			calls: [sampleCallDigest],
			consumeTokenId,
			key: testKey,
			nowMs: 10_001,
			token,
		};

		expect(verifyApprovalToken(verificationProps)).toEqual({ ok: true });
		expect(verifyApprovalToken(verificationProps)).toEqual({
			ok: false,
			reason: 'replayed',
		});
	});

	it('uses structured consumed-token hook rejection reasons directly', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleCallDigest],
			expiresAtMs: 20_000,
			issuedAtMs: 10_000,
			jti: 'approval-cache-full',
			key: testKey,
		});

		expect(
			verifyApprovalToken({
				agentId: 'shravan',
				calls: [sampleCallDigest],
				consumeTokenId: () => ({ ok: false, reason: 'replay-cache-full' }),
				key: testKey,
				nowMs: 10_001,
				token,
			}),
		).toEqual({ ok: false, reason: 'replay-cache-full' });
	});
});
