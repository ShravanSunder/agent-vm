import { describe, expect, it } from 'vitest';

import { decideApprovalTokenUse } from '#tool-host-core/workspace-authority/approval-token-use-rules';

const input = { tokenId: 'agent:token', expiresAtMs: 200, nowMs: 100, cap: 1024 };

describe('approval token use transitions', () => {
	it('records first use with byte-identical keys and values', () => {
		const decision = decideApprovalTokenUse({ ...input, state: undefined });
		expect(decision).toEqual({ result: { ok: true }, next: { 'agent:token': 200 } });
		if (!('next' in decision)) throw new Error('Expected a write.');
		expect(JSON.stringify(decision.next)).toBe('{"agent:token":200}');
	});

	it('refuses a replay without changing or pruning the stored state', () => {
		const state = { expired: 50, 'agent:token': 200 };
		expect(decideApprovalTokenUse({ ...input, state })).toEqual({
			result: { ok: false, reason: 'replayed' },
		});
		expect(state).toEqual({ expired: 50, 'agent:token': 200 });
	});

	it('allows reuse exactly at stored expiry and preserves acceptance of already-expired input', () => {
		expect(decideApprovalTokenUse({ ...input, state: { 'agent:token': 100 } })).toEqual({
			result: { ok: true },
			next: { 'agent:token': 200 },
		});
		expect(decideApprovalTokenUse({ ...input, state: {}, expiresAtMs: 99 })).toEqual({
			result: { ok: true },
			next: { 'agent:token': 99 },
		});
	});

	it('prunes expired rows before the cap check and retains live entries in insertion order', () => {
		const state = { gone: 99, live: 201, boundary: 100 };
		const decision = decideApprovalTokenUse({ ...input, cap: 30, state });
		expect(decision).toEqual({ result: { ok: true }, next: { live: 201, 'agent:token': 200 } });
		if (!('next' in decision)) throw new Error('Expected a write.');
		expect(JSON.stringify(decision.next)).toBe('{"live":201,"agent:token":200}');
		expect(state).toEqual({ gone: 99, live: 201, boundary: 100 });
	});

	it('admits exactly at the UTF8 byte cap and refuses one byte below it', () => {
		const unicode = { ...input, tokenId: 'é', state: {} };
		expect(decideApprovalTokenUse({ ...unicode, cap: 10 })).toEqual({
			result: { ok: true },
			next: { é: 200 },
		});
		expect(decideApprovalTokenUse({ ...unicode, cap: 9 })).toEqual({
			result: { ok: false, reason: 'replay-cache-full' },
		});
	});
});
