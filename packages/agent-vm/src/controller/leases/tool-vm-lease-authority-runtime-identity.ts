import type { ManagedVmDestroyTargetV1 } from '@agent-vm/gondolin-adapter';

import type { ToolVmProvisionalOwnershipProof } from '../vm-ownership/gateway-ownership-coordinator.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import type { ToolVmRuntimeLeaseIdentity } from './tool-vm-lease-authority-runtime-contracts.js';
import type {
	ToolVmLeafAuthorityReference,
	ToolVmRuntimeBinding,
	ToolVmSshBinding,
} from './tool-vm-lease-authority-state.js';

export function gatewayAuthorityKey(gateway: GatewayEpochIdentity): string {
	return JSON.stringify([
		gateway.controllerEpoch,
		gateway.zoneId,
		gateway.gatewayVmId,
		gateway.gatewayEpochId,
		gateway.bootId,
		gateway.generationId,
	]);
}

export function authorityResourceKey(authority: ToolVmLeafAuthorityReference): string {
	return `${gatewayAuthorityKey(authority.gateway)}\0${authority.leafGeneration}`;
}

export function rejectedCleanupId(options: {
	readonly authority: ToolVmLeafAuthorityReference;
	readonly ownershipProof: ToolVmProvisionalOwnershipProof;
}): string {
	return JSON.stringify([
		gatewayAuthorityKey(options.authority.gateway),
		options.authority.leafGeneration,
		options.ownershipProof.destructionIdentity.reservationId,
		options.ownershipProof.destructionIdentity.reservationPath,
		options.ownershipProof.destructionIdentity.vmId,
	]);
}

export function commitIdentity(options: {
	readonly authority: ToolVmLeafAuthorityReference;
	readonly lease: ToolVmRuntimeLeaseIdentity;
	readonly runtimeBinding: ToolVmRuntimeBinding;
	readonly sshBinding: ToolVmSshBinding;
}): string {
	return JSON.stringify([
		authorityResourceKey(options.authority),
		options.lease.id,
		options.lease.agentId,
		options.lease.zoneId,
		options.lease.vm.id,
		options.runtimeBinding.runtimeRecordId,
		options.runtimeBinding.tcpSlot,
		options.runtimeBinding.vmId,
		options.sshBinding.bindingId,
		options.sshBinding.host,
		options.sshBinding.identityFile,
		options.sshBinding.port,
		options.sshBinding.serverIdentity,
		options.sshBinding.user,
	]);
}

export function assertDestroyTargetMatchesAuthority(options: {
	readonly authority: ToolVmLeafAuthorityReference;
	readonly ownershipProof: ToolVmProvisionalOwnershipProof;
}): void {
	const target = options.ownershipProof.verifiedDestroyTarget;
	const parentGateway = target.parentGateway;
	if (
		target.controllerEpoch !== options.authority.gateway.controllerEpoch ||
		target.role !== 'tool' ||
		parentGateway === null ||
		parentGateway.epoch !== options.authority.gateway.gatewayEpochId ||
		parentGateway.vmId !== options.authority.gateway.gatewayVmId ||
		options.ownershipProof.destructionIdentity.reservationId !== target.reservationId ||
		options.ownershipProof.destructionIdentity.reservationPath !== target.reservationPath ||
		options.ownershipProof.destructionIdentity.vmId !== target.vmId ||
		options.ownershipProof.ownershipReservation.reservationId !== target.reservationId ||
		options.ownershipProof.ownershipReservation.reservationPath !== target.reservationPath
	) {
		throw new Error('Verified Tool VM ownership proof does not match its exact Gateway authority.');
	}
}

export function assertLeaseMatchesRuntime(options: {
	readonly authority: ToolVmLeafAuthorityReference;
	readonly lease: ToolVmRuntimeLeaseIdentity;
	readonly runtimeBinding: ToolVmRuntimeBinding;
	readonly verifiedDestroyTarget: ManagedVmDestroyTargetV1;
}): void {
	if (
		options.lease.id !== options.authority.leaseId ||
		options.lease.agentId !== options.authority.principal.agentId ||
		options.lease.zoneId !== options.authority.principal.zoneId ||
		options.lease.vm.id !== options.runtimeBinding.vmId ||
		options.runtimeBinding.vmId !== options.verifiedDestroyTarget.vmId
	) {
		throw new Error(
			'Committed Tool VM lease does not match its authority and exact runtime target.',
		);
	}
}
