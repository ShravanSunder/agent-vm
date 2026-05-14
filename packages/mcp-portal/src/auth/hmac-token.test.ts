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
});
