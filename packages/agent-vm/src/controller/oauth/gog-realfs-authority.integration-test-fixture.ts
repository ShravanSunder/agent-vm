import path from 'node:path';

import type { ManagedVm } from '@agent-vm/managed-vm';

import { TEST_SSH_SERVER_HOST_KEY } from '../../testing/managed-vm-test-helpers.js';
import type { GatewayControlTrustedCallerContext } from '../control-session/gateway-control-caller-context.js';
import type { createControllerSharedStaging } from '../files/controller-shared-staging.js';
import type { ToolVmWorkFileBinding } from '../files/current-tool-vm-work-files.js';
import { createLeaseManager, type ToolVmLeaseRequestAuthority } from '../leases/lease-manager.js';
import { createTcpPool } from '../leases/tcp-pool.js';
import { createGatewayOwnershipCoordinator } from '../vm-ownership/gateway-ownership-coordinator.js';

export async function prepareGogRealFsLeaseFixture(props: {
	readonly principal: GatewayControlTrustedCallerContext['principal'];
	readonly root: string;
	readonly sharedStaging: ReturnType<typeof createControllerSharedStaging>;
	readonly zoneId: string;
}): Promise<{
	readonly authority: ToolVmLeaseRequestAuthority;
	readonly close: () => Promise<void>;
	readonly leaseManager: ReturnType<typeof createLeaseManager>;
	readonly receiver: ToolVmWorkFileBinding;
	readonly receiverHostRoot: string;
}> {
	const ownershipCoordinator = createGatewayOwnershipCoordinator({
		controllerEpoch: 'controller-realfs',
		createGatewayEpochId: () => 'gateway-epoch-realfs',
	});
	const gateway = ownershipCoordinator
		.beginGatewayEpoch({
			bootId: 'gateway-realfs-boot',
			generationId: 'gateway-generation-realfs',
			zoneId: props.zoneId,
		})
		.attachGatewayVm('gateway-vm-realfs');
	let receiverHostRoot: string | undefined;
	let hostProcessId: number | null = 52_000;
	const leaseManager = createLeaseManager({
		controllerPort: 18_800,
		createLeafGeneration: () => 'leaf-sun',
		createLeaseId: () => 'lease-sun',
		createRuntimeRecordId: () => '44444444-4444-4444-8444-444444444444',
		createManagedVm: async ({ leafGeneration }) => {
			const store = await props.sharedStaging.getStore(props.zoneId, props.principal.agentId);
			receiverHostRoot = await store.prepareReceiverRoot(leafGeneration);
			return {
				close: async () => {
					hostProcessId = null;
				},
				configureIngressRoutes: () => {},
				enableIngress: async () => ({
					close: async () => {},
					host: '127.0.0.1',
					port: 19_001,
				}),
				enableSsh: async () => ({
					close: async () => {},
					command: 'ssh sandbox@127.0.0.1',
					host: '127.0.0.1',
					identityFile: '/tmp/gog-realfs-tool-vm-key',
					port: 19_000,
					serverHostKey: TEST_SSH_SERVER_HOST_KEY,
					user: 'sandbox',
				}),
				exec: () => {
					throw new Error('The fake receiving VM does not execute guest file helpers.');
				},
				fileTransfer: { createDirectory: async () => {}, writeFileStream: async () => {} },
				getHostProcessId: () => hostProcessId,
				id: 'tool-vm-sun',
				start: async () => {},
			} satisfies ManagedVm;
		},
		deleteToolVmRuntimeRecord: async () => {},
		managedVmExactProcessTermination: {
			terminateRecordedHostProcess: async ({ identity }) => ({
				hostProcessId: identity.hostProcessId,
				kind: 'terminated',
			}),
		},
		managedVmTerminationSleep: async () => {},
		now: () => 1_000,
		ownershipCoordinator,
		projectNamespace: 'gog-realfs-journey',
		readProcessIdentity: async () => ({ command: 'fake-qemu', lstart: 'fake-start' }),
		readTcpListenPortOwner: async () => null,
		systemConfigPath: path.join(props.root, 'config', 'system.jsonc'),
		tcpPool: createTcpPool({ basePort: 19_000, size: 2 }),
		toolLeaseRecordsTargetFor: (requestedZoneId) => ({
			directoryPath: path.join(props.root, 'state', requestedZoneId, 'tool-leases'),
			kind: 'controller-tool-lease-records',
			zoneId: requestedZoneId,
		}),
		writeToolVmRuntimeRecord: async () => {},
	});
	const lease = await leaseManager.createLease({
		agentId: props.principal.agentId,
		expectedGateway: gateway,
		guestWorkdir: '/work',
		hostWorkspaceRoot: path.join(props.root, 'workspace'),
		principal: props.principal,
		profile: { cpus: 1, imageProfile: 'default', memory: '1G' },
		profileId: props.principal.toolPortalProfileId,
		zoneId: props.zoneId,
	});
	if (receiverHostRoot === undefined) throw new Error('Lease did not prepare its receiver root.');
	const current = leaseManager.getCurrentLeaseBinding(lease.id);
	if (current === undefined) throw new Error('Lease did not expose a current leaf binding.');
	return {
		authority: { gateway, principal: props.principal },
		close: async () => await leaseManager.destroyGatewayOwnedLeases(gateway),
		leaseManager,
		receiver: {
			leaseId: lease.id,
			leafGeneration: current.leafGeneration,
			vmId: current.runtimeBinding.vmId,
		},
		receiverHostRoot,
	};
}
