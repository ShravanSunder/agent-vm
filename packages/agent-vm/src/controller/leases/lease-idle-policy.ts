export interface LeaseIdleTtlPolicy {
	readonly defaultMs: number;
	readonly byScopeKind: Readonly<Record<string, number>>;
	readonly byScopePrefix: Readonly<Record<string, number>>;
}

function scopePrefixes(scopeKey: string): readonly string[] {
	const segments = scopeKey.split(':').filter((segment) => segment.length > 0);
	return segments.map((_segment, index) => segments.slice(0, index + 1).join(':')).toReversed();
}

export function ttlForLeaseScope(options: {
	readonly policy: LeaseIdleTtlPolicy;
	readonly scopeKey: string;
}): number {
	for (const prefix of scopePrefixes(options.scopeKey)) {
		const ttl = options.policy.byScopePrefix[prefix];
		if (ttl !== undefined) {
			return ttl;
		}
	}
	const scopeKind = options.scopeKey.split(':')[0] ?? '';
	return options.policy.byScopeKind[scopeKind] ?? options.policy.defaultMs;
}
