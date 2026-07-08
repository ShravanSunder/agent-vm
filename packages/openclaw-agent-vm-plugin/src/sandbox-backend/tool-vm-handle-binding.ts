import type { ToolVmSshFailureKind, ToolVmSshLease } from '@agent-vm/gateway-interface';

import type { LeaseClient, OpenClawGondolinLeaseStaleEvidence } from '../lease-client-contract.js';

export type ToolVmHandleBindingSshOperation = 'command' | 'file-bridge' | 'finalize' | 'probe';

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
	}): void;
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

export function createToolVmHandleBinding(options: {
	readonly initialLease: ToolVmSshLease;
	readonly leaseClient: Pick<LeaseClient, 'reacquireLease'>;
	readonly now?: () => number;
	readonly onReplacementLease?: (lease: ToolVmSshLease) => void;
}): ToolVmHandleBinding {
	const now = options.now ?? (() => Date.now());
	let currentLease = options.initialLease;
	let staleBinding: ToolVmHandleStaleBinding | undefined;
	let pendingReacquire: Promise<ToolVmSshLease> | undefined;

	const resolveCurrentLease = async (): Promise<ToolVmSshLease> => {
		if (staleBinding === undefined) {
			return currentLease;
		}
		if (pendingReacquire !== undefined) {
			return await pendingReacquire;
		}
		const bindingToReplace = staleBinding;
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
				return;
			}
			staleBinding = {
				lease: markOptions.lease,
				observedAtMs: markOptions.observedAtMs ?? now(),
				staleEvidence: staleEvidenceForReason(markOptions),
			};
		},
		resolveCurrentLease,
	};
}
