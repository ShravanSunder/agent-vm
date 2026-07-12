import type { ToolVmSshFailureKind, ToolVmSshLease } from '@agent-vm/gateway-contracts';

import {
	ControllerLeaseRequestError,
	type LeaseClient,
	type OpenClawGondolinLeaseReacquireRequest,
	type OpenClawGondolinLeaseStaleEvidence,
} from '../lease-client-contract.js';

export type ToolVmHandleBindingSshOperation = 'command' | 'file-bridge' | 'finalize' | 'probe';

export type ToolVmHandleMarkStaleResult =
	| {
			readonly kind: 'stale-current';
			readonly reacquireRequest: OpenClawGondolinLeaseReacquireRequest;
	  }
	| {
			readonly kind: 'superseded';
	  };

interface ToolVmHandleStaleBinding {
	readonly lease: ToolVmSshLease;
	readonly observedAtMs: number;
	readonly staleEvidence: OpenClawGondolinLeaseStaleEvidence;
}

export interface ToolVmHandleBinding {
	currentLease(): ToolVmSshLease;
	markStale(options: {
		readonly lease: ToolVmSshLease;
		readonly observedAtMs?: number;
		readonly operation: ToolVmHandleBindingSshOperation;
		readonly reason: ToolVmSshFailureKind;
	}): ToolVmHandleMarkStaleResult;
	resolveCurrentLease(): Promise<ToolVmSshLease>;
}

function staleEvidenceForReason(params: {
	readonly operation: ToolVmHandleBindingSshOperation;
	readonly reason: ToolVmSshFailureKind;
}): OpenClawGondolinLeaseStaleEvidence {
	if (params.reason === 'active-use-refreshable-failure') {
		return {
			kind: 'caller-context',
			reason: 'stale',
		};
	}
	return {
		kind: 'tool-vm-ssh',
		operation: params.operation,
	};
}

function isTerminalReacquireError(error: unknown): error is ControllerLeaseRequestError {
	if (!(error instanceof ControllerLeaseRequestError)) {
		return false;
	}
	return (
		error.leaseRejectionReason === 'lease_absent' ||
		error.leaseRejectionReason === 'lease_authority_absent' ||
		error.leaseRejectionReason === 'lease_force_released' ||
		error.leaseRejectionReason === 'lease_generation_stale' ||
		error.leaseRejectionReason === 'lease_retired' ||
		error.leaseRejectionReason === 'lease_use_tombstoned' ||
		error.leaseRejectionReason === 'ownership_denied'
	);
}

export function createToolVmHandleBinding(options: {
	readonly initialLease: ToolVmSshLease;
	readonly leaseClient: Pick<LeaseClient, 'getRetiredLeaseReacquireRequest' | 'reacquireLease'>;
	readonly now?: () => number;
	readonly onReplacementLease?: (lease: ToolVmSshLease) => void;
}): ToolVmHandleBinding {
	const now = options.now ?? (() => Date.now());
	let currentLease = options.initialLease;
	let staleBinding: ToolVmHandleStaleBinding | undefined;
	let pendingReacquire: Promise<ToolVmSshLease> | undefined;
	let terminalReacquireError: ControllerLeaseRequestError | undefined;

	const resolveStaleBinding = (): ToolVmHandleStaleBinding | undefined => {
		if (staleBinding !== undefined) {
			return staleBinding;
		}
		const retiredReacquireRequest = options.leaseClient.getRetiredLeaseReacquireRequest?.(
			currentLease.leaseId,
		);
		if (retiredReacquireRequest === undefined) {
			return undefined;
		}
		staleBinding = {
			lease: currentLease,
			observedAtMs: retiredReacquireRequest.observedAtMs,
			staleEvidence: retiredReacquireRequest.staleEvidence,
		};
		return staleBinding;
	};

	const resolveCurrentLease = async (): Promise<ToolVmSshLease> => {
		if (terminalReacquireError !== undefined) {
			throw terminalReacquireError;
		}
		const bindingToReplace = resolveStaleBinding();
		if (bindingToReplace === undefined) {
			return currentLease;
		}
		if (pendingReacquire !== undefined) {
			return await pendingReacquire;
		}
		const reacquirePromise = options.leaseClient
			.reacquireLease(bindingToReplace.lease.leaseId, {
				observedAtMs: bindingToReplace.observedAtMs,
				staleEvidence: bindingToReplace.staleEvidence,
			})
			.then((replacementLease) => {
				if (replacementLease.leaseId === bindingToReplace.lease.leaseId) {
					throw new Error(
						`Tool VM lease reacquire returned the stale lease id '${bindingToReplace.lease.leaseId}'.`,
					);
				}
				currentLease = replacementLease;
				if (staleBinding === bindingToReplace) {
					staleBinding = undefined;
				}
				options.onReplacementLease?.(replacementLease);
				return replacementLease;
			})
			.catch((error: unknown) => {
				if (isTerminalReacquireError(error)) {
					terminalReacquireError = error;
				}
				throw error;
			})
			.finally(() => {
				if (pendingReacquire === reacquirePromise) {
					pendingReacquire = undefined;
				}
			});
		pendingReacquire = reacquirePromise;
		return await reacquirePromise;
	};

	return {
		currentLease: () => currentLease,
		markStale: (markOptions) => {
			if (currentLease.leaseId !== markOptions.lease.leaseId) {
				return { kind: 'superseded' };
			}
			const reacquireRequest = {
				observedAtMs: markOptions.observedAtMs ?? now(),
				staleEvidence: staleEvidenceForReason(markOptions),
			} satisfies OpenClawGondolinLeaseReacquireRequest;
			staleBinding = {
				lease: markOptions.lease,
				observedAtMs: reacquireRequest.observedAtMs,
				staleEvidence: reacquireRequest.staleEvidence,
			};
			return { kind: 'stale-current', reacquireRequest };
		},
		resolveCurrentLease,
	};
}
