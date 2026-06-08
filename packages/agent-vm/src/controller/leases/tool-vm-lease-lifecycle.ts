export interface ToolVmLeaseTimingInput {
	readonly effectiveIdleTtlMs: number;
	readonly lastUsedAt: number;
	readonly nowMs: number;
}

export interface ToolVmLeaseExpirationInput extends ToolVmLeaseTimingInput {
	readonly activeUseCount: number;
}

export interface ToolVmLeaseRenewalInput extends ToolVmLeaseExpirationInput {
	readonly vmLive: boolean;
}

export type ToolVmLeaseRenewalDecision =
	| { readonly kind: 'renew' }
	| { readonly kind: 'evict-expired' }
	| { readonly kind: 'evict-dead' };

export interface ToolVmLeaseReleaseRequestInput {
	readonly activeUseCount: number;
	readonly force?: boolean | undefined;
	readonly ifLastUsedAtBeforeOrAt?: number | undefined;
	readonly lastUsedAt: number;
}

export type ToolVmLeaseReleaseRequestDecision =
	| { readonly kind: 'release' }
	| { readonly kind: 'skip-recently-used' }
	| { readonly kind: 'blocked-active-use' };

export type ToolVmLeaseCloseOutcome =
	| { readonly kind: 'release-tcp-and-delete-record' }
	| { readonly kind: 'quarantine-tcp-and-preserve-record' };

export function isToolVmLeaseIdleExpired(input: ToolVmLeaseTimingInput): boolean {
	return input.lastUsedAt + input.effectiveIdleTtlMs < input.nowMs;
}

export function isToolVmLeaseExpired(input: ToolVmLeaseExpirationInput): boolean {
	return isToolVmLeaseIdleExpired(input) && input.activeUseCount === 0;
}

export function classifyToolVmLeaseRenewal(
	input: ToolVmLeaseRenewalInput,
): ToolVmLeaseRenewalDecision {
	if (isToolVmLeaseExpired(input)) {
		return { kind: 'evict-expired' };
	}
	return input.vmLive ? { kind: 'renew' } : { kind: 'evict-dead' };
}

export function classifyToolVmLeaseReleaseRequest(
	input: ToolVmLeaseReleaseRequestInput,
): ToolVmLeaseReleaseRequestDecision {
	if (
		input.ifLastUsedAtBeforeOrAt !== undefined &&
		input.lastUsedAt > input.ifLastUsedAtBeforeOrAt
	) {
		return { kind: 'skip-recently-used' };
	}
	if (input.force !== true && input.activeUseCount > 0) {
		return { kind: 'blocked-active-use' };
	}
	return { kind: 'release' };
}

export function classifyToolVmLeaseCloseOutcome(input: {
	readonly closeSucceeded: boolean;
}): ToolVmLeaseCloseOutcome {
	return input.closeSucceeded
		? { kind: 'release-tcp-and-delete-record' }
		: { kind: 'quarantine-tcp-and-preserve-record' };
}
