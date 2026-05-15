import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
	hashCallArguments,
	signApprovalToken,
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
	const signature = createHmac('sha256', testKey).update(payloadEncoded).digest('base64url');
	return `${payloadEncoded}.${signature}`;
}

describe('hashCallArguments', () => {
	it('is deterministic regardless of object property order', () => {
		expect(hashCallArguments({ a: 1, b: 2 })).toBe(hashCallArguments({ b: 2, a: 1 }));
	});
});

describe('signApprovalToken / verifyApprovalToken', () => {
	it('verifies a freshly signed token', () => {
		const token = signApprovalToken({
			agentId: 'shravan',
			calls: [sampleCallDigest],
			expiresAtMs: 20_000,
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
});
