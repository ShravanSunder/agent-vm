import { describe, expect, it } from 'vitest';

import { ttlForLeaseScope } from './lease-idle-policy.js';

describe('ttlForLeaseScope', () => {
	it('prefers the longest scope prefix over scope kind and default', () => {
		expect(
			ttlForLeaseScope({
				scopeKey: 'agent:shravan:session-1',
				policy: {
					defaultMs: 1_800_000,
					byScopeKind: { agent: 7_200_000 },
					byScopePrefix: { 'agent:shravan': 21_600_000 },
				},
			}),
		).toBe(21_600_000);
	});

	it('uses scope kind when there is no scope prefix override', () => {
		expect(
			ttlForLeaseScope({
				scopeKey: 'agent:alevtina:session-1',
				policy: {
					defaultMs: 1_800_000,
					byScopeKind: { agent: 7_200_000 },
					byScopePrefix: {},
				},
			}),
		).toBe(7_200_000);
	});

	it('falls back to default for unknown scope kinds', () => {
		expect(
			ttlForLeaseScope({
				scopeKey: 'project:shared',
				policy: {
					defaultMs: 1_800_000,
					byScopeKind: { agent: 7_200_000 },
					byScopePrefix: {},
				},
			}),
		).toBe(1_800_000);
	});
});
