export const leaseScopeKinds = [
	'agent',
	'discord',
	'project',
	'session',
	'shared',
	'workspace',
] as const;

export type LeaseScopeKind = (typeof leaseScopeKinds)[number];

export interface LeaseIdleTtlPolicy {
	readonly defaultMs: number;
	readonly byScopeKind: Partial<Readonly<Record<LeaseScopeKind, number>>>;
	readonly byScopePrefix: Readonly<Record<string, number>>;
}

function scopePrefixes(scopeKey: string): readonly string[] {
	const segments = scopeKey.split(':').filter((segment) => segment.length > 0);
	return segments.map((_segment, index) => segments.slice(0, index + 1).join(':')).toReversed();
}

function isLeaseScopeKind(scopeKind: string): scopeKind is LeaseScopeKind {
	return leaseScopeKinds.some((candidate) => candidate === scopeKind);
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
	return isLeaseScopeKind(scopeKind)
		? (options.policy.byScopeKind[scopeKind] ?? options.policy.defaultMs)
		: options.policy.defaultMs;
}
