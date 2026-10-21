import { describe, it, expect } from 'vitest';

import { createInMemoryApprovalTokenUse } from '#mcp-gateway/call-approvals/approval-token-use';

describe('machine approval replay authority', () => {
	it('atomically permits one overlapping first use and refuses the other', async () => {
		const consume = createInMemoryApprovalTokenUse({ now: () => 0 });
		expect(await Promise.all([consume('token', 100), consume('token', 100)])).toEqual([
			{ ok: true },
			{ ok: false, reason: 'replayed' },
		]);
	});
	it('keeps live records at capacity and frees only expired records', async () => {
		let now = 0;
		const consume = createInMemoryApprovalTokenUse({ now: () => now, limit: 1 });
		expect(await consume('first', 100)).toEqual({ ok: true });
		expect(await consume('second', 200)).toEqual({ ok: false, reason: 'replay-cache-full' });
		expect(await consume('first', 100)).toEqual({ ok: false, reason: 'replayed' });
		now = 100;
		expect(await consume('second', 200)).toEqual({ ok: true });
	});
});
