import { describe, expect, it } from 'vitest';

import { ttlForLeaseScope } from './lease-idle-policy.js';

describe('ttlForLeaseScope', () => {
	it('maps the named scope kinds explicitly', () => {
		const policy = {
			defaultMs: 1_800_000,
			byScopeKind: {
				agent: 7_200_000,
				discord: 600_000,
				project: 3_600_000,
				session: 900_000,
				shared: 86_400_000,
				workspace: 1_200_000,
			},
			byScopePrefix: {},
		};

		expect(ttlForLeaseScope({ policy, scopeKey: 'agent:shravan' })).toBe(7_200_000);
		expect(ttlForLeaseScope({ policy, scopeKey: 'discord:channel:123' })).toBe(600_000);
		expect(ttlForLeaseScope({ policy, scopeKey: 'project:repo' })).toBe(3_600_000);
		expect(ttlForLeaseScope({ policy, scopeKey: 'session:abc' })).toBe(900_000);
		expect(ttlForLeaseScope({ policy, scopeKey: 'shared:home' })).toBe(86_400_000);
		expect(ttlForLeaseScope({ policy, scopeKey: 'workspace:repo' })).toBe(1_200_000);
	});

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
