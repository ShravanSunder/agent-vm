import { isDeepStrictEqual } from 'node:util';

import { createToolVmActiveUseHandle } from '@agent-vm/gateway-lifecycle';
import type { ManagedVm } from '@agent-vm/managed-vm';

import type {
	Lease,
	LeaseManager,
	ToolVmLeaseActiveUseExecutionProof,
	ToolVmLeaseRequestAuthority,
} from '../leases/lease-manager.js';
import {
	createOperationFolderGuestAccess,
	operationFolderPythonExecutable,
	OperationFolderAccessError,
	type OperationFolderGuestAccess,
} from './operation-folder-guest-access.js';

export interface ToolVmWorkFileBinding {
	readonly leaseId: string;
	readonly leafGeneration: string;
	readonly vmId: string;
}

export interface ToolVmWorkFileAccess {
	readonly binding: ToolVmWorkFileBinding;
	readonly files: OperationFolderGuestAccess;
	readonly signal: AbortSignal;
	readonly authorityIsCurrent: () => boolean;
}

type WorkFileLease = Pick<Lease, 'agentId' | 'zoneId' | 'id'> & {
	readonly vm: Pick<ManagedVm, 'id' | 'exec'>;
};

export type ToolVmWorkFileLeaseManager = Pick<
	LeaseManager,
	| 'getCurrentLeaseBinding'
	| 'getLeaseAuthority'
	| 'startActiveUse'
	| 'endActiveUse'
	| 'heartbeatActiveUse'
	| 'subscribeLeaseRetirement'
> & { readonly listLeases: () => readonly WorkFileLease[] };

/** Reuse current lease authority and heartbeat ownership; never provision or switch VMs here. */
export async function withCurrentToolVmWorkFiles<TResult>(props: {
	readonly agentId: string;
	readonly authority: ToolVmLeaseRequestAuthority;
	readonly executionProof: ToolVmLeaseActiveUseExecutionProof;
	readonly expectedBinding?: ToolVmWorkFileBinding;
	readonly leaseManager: ToolVmWorkFileLeaseManager;
	readonly program: string;
	readonly signal: AbortSignal;
	readonly use: (access: ToolVmWorkFileAccess) => Promise<TResult>;
}): Promise<TResult> {
	props.signal.throwIfAborted();
	const authority = structuredClone(props.authority);
	const proof = structuredClone(props.executionProof);
	const matches = props.leaseManager.listLeases().filter((lease) => {
		if (lease.agentId !== props.agentId || lease.zoneId !== authority.gateway.zoneId) return false;
		const current = props.leaseManager.getLeaseAuthority(lease.id);
		return (
			current !== undefined &&
			isDeepStrictEqual(current.authority.gateway, authority.gateway) &&
			isDeepStrictEqual(current.authority.principal, authority.principal)
		);
	});
	const lease = matches[0];
	if (matches.length !== 1 || lease === undefined)
		throw new OperationFolderAccessError('unavailable');
	const leaf = props.leaseManager.getCurrentLeaseBinding(lease.id);
	if (leaf === undefined || leaf.runtimeBinding.vmId !== lease.vm.id)
		throw new OperationFolderAccessError('unavailable');
	const binding: ToolVmWorkFileBinding = {
		leaseId: lease.id,
		leafGeneration: leaf.leafGeneration,
		vmId: lease.vm.id,
	};
	if (props.expectedBinding !== undefined && !isDeepStrictEqual(binding, props.expectedBinding))
		throw new OperationFolderAccessError('unavailable');
	const retirement = new AbortController();
	const lifetime = new AbortController();
	const authorityIsCurrent = (): boolean => {
		if (props.signal.aborted || retirement.signal.aborted || lifetime.signal.aborted) return false;
		const current = props.leaseManager.getCurrentLeaseBinding(lease.id);
		const currentAuthority = props.leaseManager.getLeaseAuthority(lease.id);
		return (
			current?.leafGeneration === binding.leafGeneration &&
			current.runtimeBinding.vmId === binding.vmId &&
			currentAuthority !== undefined &&
			isDeepStrictEqual(currentAuthority.authority.gateway, authority.gateway) &&
			isDeepStrictEqual(currentAuthority.authority.principal, authority.principal)
		);
	};
	const requireCurrent = (): void => {
		if (!authorityIsCurrent()) throw new OperationFolderAccessError('unavailable');
	};
	const unsubscribe = props.leaseManager.subscribeLeaseRetirement(async (event) => {
		if (event.leaseId === lease.id) retirement.abort(new OperationFolderAccessError('unavailable'));
	});
	let outcome: 'completed' | 'failed' = 'failed';
	let handle: Awaited<ReturnType<typeof createToolVmActiveUseHandle>> | undefined;
	try {
		handle = await createToolVmActiveUseHandle({
			startActiveUse: async (request) => {
				requireCurrent();
				const started = props.leaseManager.startActiveUse(lease.id, {
					...request,
					...proof,
					authority,
				});
				if (started === undefined) throw new OperationFolderAccessError('unavailable');
				return started;
			},
			heartbeatActiveUse: async (useId, request) => {
				try {
					requireCurrent();
					const heartbeat = props.leaseManager.heartbeatActiveUse(lease.id, useId, {
						...request,
						...proof,
						authority,
					});
					if (heartbeat === undefined) throw new OperationFolderAccessError('unavailable');
					return heartbeat;
				} catch (error) {
					retirement.abort(error);
					throw error;
				}
			},
			endActiveUse: async (useId, request) => {
				const ended = props.leaseManager.endActiveUse(lease.id, useId, {
					...request,
					...proof,
					authority,
				});
				if (ended?.kind !== 'ended' && !retirement.signal.aborted)
					throw new OperationFolderAccessError('unavailable');
			},
		});
		requireCurrent();
		const signal = AbortSignal.any([
			props.signal,
			retirement.signal,
			lifetime.signal,
			handle.signal,
		]);
		const result = await props.use({
			binding: { ...binding },
			files: createOperationFolderGuestAccess({
				vm: lease.vm,
				root: '/work',
				program: props.program,
				pythonExecutable: operationFolderPythonExecutable,
				signal,
			}),
			signal,
			authorityIsCurrent,
		});
		requireCurrent();
		outcome = 'completed';
		return result;
	} finally {
		lifetime.abort(new OperationFolderAccessError('unavailable'));
		unsubscribe();
		await handle?.end(outcome);
	}
}
