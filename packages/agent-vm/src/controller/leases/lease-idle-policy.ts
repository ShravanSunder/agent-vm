export const defaultToolVmLeaseIdleTtlMs = 100 * 60 * 1000;

export interface ToolVmLeaseIdleTtlPolicy {
	readonly defaultMs: number;
	readonly maxRequestedMs: number;
	readonly minRequestedMs: number;
}

export type ResolveToolVmLeaseIdleTtlResult =
	| {
			readonly kind: 'ok';
			readonly value: number;
	  }
	| {
			readonly kind: 'invalid';
			readonly message: string;
	  };

export function resolveToolVmLeaseIdleTtlMs(options: {
	readonly policy: ToolVmLeaseIdleTtlPolicy;
	readonly requestedIdleTtlMs?: number | undefined;
}): ResolveToolVmLeaseIdleTtlResult {
	if (options.requestedIdleTtlMs === undefined) {
		return {
			kind: 'ok',
			value: options.policy.defaultMs,
		};
	}

	if (options.requestedIdleTtlMs < options.policy.minRequestedMs) {
		return {
			kind: 'invalid',
			message: `Requested idleTtlMs must be at least ${String(options.policy.minRequestedMs)}ms.`,
		};
	}

	if (options.requestedIdleTtlMs > options.policy.maxRequestedMs) {
		return {
			kind: 'invalid',
			message: `Requested idleTtlMs must be at most ${String(options.policy.maxRequestedMs)}ms.`,
		};
	}

	return {
		kind: 'ok',
		value: options.requestedIdleTtlMs,
	};
}
