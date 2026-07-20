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

export function assertLeaseMatchesRuntime(options: {
	readonly authority: ToolVmLeafAuthorityReference;
	readonly lease: ToolVmRuntimeLeaseIdentity;
	readonly runtimeBinding: ToolVmRuntimeBinding;
}): void {
	if (
		options.lease.id !== options.authority.leaseId ||
		options.lease.agentId !== options.authority.principal.agentId ||
		options.lease.zoneId !== options.authority.gateway.zoneId ||
		options.lease.vm.id !== options.runtimeBinding.vmId
	) {
		throw new Error(
			'Committed Tool VM lease does not match its authority and exact runtime target.',
		);
	}
}
