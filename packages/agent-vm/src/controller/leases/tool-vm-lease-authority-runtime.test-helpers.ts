import type {
	ManagedVmDestroyReceiptV1,
	ManagedVmDestroyTargetV1,
} from '@agent-vm/gondolin-adapter';
import { expect, vi } from 'vitest';

import {
	createCompleteVmDestroyReceipt,
	createTestVmDestroyTarget,
	createTestVmOwnershipReservationReference,
} from '../../testing/managed-vm-test-helpers.js';
import type {
	ProvisionalToolVmOwnershipHandle,
	ToolVmProvisionalOwnershipProof,
} from '../vm-ownership/gateway-ownership-coordinator.js';
import type { GatewayEpochIdentity } from '../vm-ownership/vm-ownership-contracts.js';
import {
	ToolVmLeaseAuthorityTransitionError,
	type StableToolVmLeasePrincipal,
	type ToolVmLeafAuthorityReference,
	type ToolVmLeaseCompatibility,
	type ToolVmRuntimeBinding,
	type ToolVmSshBinding,
} from './tool-vm-lease-authority-state.js';

export interface TestLease {
	readonly agentId: string;
	readonly id: string;
	readonly idleExpiresAtMs: number;
	readonly lastUsedAt: number;
	readonly label: string;
	readonly vm: { readonly id: string };
	readonly zoneId: string;
}

export const GATEWAY_ONE = {
	bootId: 'gateway-boot-1',
	controllerEpoch: 'controller-epoch-1',
	gatewayEpochId: 'gateway-epoch-1',
	gatewayVmId: 'gateway-vm-1',
	generationId: 'gateway-generation-1',
	zoneId: 'shravan',
} satisfies GatewayEpochIdentity;

export const GATEWAY_TWO = {
	...GATEWAY_ONE,
	bootId: 'gateway-boot-2',
	gatewayEpochId: 'gateway-epoch-2',
	gatewayVmId: 'gateway-vm-2',
	generationId: 'gateway-generation-2',
} satisfies GatewayEpochIdentity;

export const PRINCIPAL_MAIN = {
	agentId: 'main',
	zoneId: GATEWAY_ONE.zoneId,
} satisfies StableToolVmLeasePrincipal;

export const PRINCIPAL_SIBLING = {
	agentId: 'sibling',
	zoneId: GATEWAY_ONE.zoneId,
} satisfies StableToolVmLeasePrincipal;

export const COMPATIBILITY = {
	policyFingerprint: 'policy-a',
	profileId: 'standard',
	purpose: 'coding',
	workMountDir: '/home/openclaw/work',
} satisfies ToolVmLeaseCompatibility;

export const RUNTIME_BINDING = {
	runtimeRecordId: 'runtime-tool-vm-1',
	tcpSlot: 1,
	vmId: 'tool-vm-1',
} satisfies ToolVmRuntimeBinding;

export const SSH_BINDING = {
	bindingId: 'ssh-tool-vm-1',
	host: '127.0.0.1',
	identityFile: '/tmp/tool-vm-1-key',
	port: 19_000,
	serverIdentity: 'ssh-ed25519 host-key-tool-vm-1',
	user: 'sandbox',
} satisfies ToolVmSshBinding;

export function createAuthority(
	overrides: {
		readonly gateway?: GatewayEpochIdentity;
		readonly leaseId?: string;
		readonly leafGeneration?: string;
		readonly principal?: StableToolVmLeasePrincipal;
	} = {},
): ToolVmLeafAuthorityReference {
	return {
		gateway: overrides.gateway ?? GATEWAY_ONE,
		leaseId: overrides.leaseId ?? 'lease-1',
		leafGeneration: overrides.leafGeneration ?? 'leaf-generation-1',
		principal: overrides.principal ?? PRINCIPAL_MAIN,
	};
}

export function createLease(overrides: Partial<TestLease> = {}): TestLease {
	return {
		agentId: PRINCIPAL_MAIN.agentId,
		id: 'lease-1',
		idleExpiresAtMs: 10_000,
		lastUsedAt: 1_000,
		label: 'primary lease',
		vm: { id: RUNTIME_BINDING.vmId },
		zoneId: PRINCIPAL_MAIN.zoneId,
		...overrides,
	};
}

export function createVerifiedDestroyTarget(
	vmId = 'tool-vm-1',
	overrides: {
		readonly gateway?: GatewayEpochIdentity;
		readonly reservationId?: string;
	} = {},
): ManagedVmDestroyTargetV1 {
	const gateway = overrides.gateway ?? GATEWAY_ONE;
	return createTestVmDestroyTarget(vmId, {
		controllerEpoch: gateway.controllerEpoch,
		parentGateway: {
			epoch: gateway.gatewayEpochId,
			vmId: gateway.gatewayVmId,
		},
		...(overrides.reservationId === undefined ? {} : { reservationId: overrides.reservationId }),
		role: 'tool',
	});
}

export function createOwnershipHandle(
	verifiedDestroyTarget: ManagedVmDestroyTargetV1,
	overrides: Partial<ProvisionalToolVmOwnershipHandle> = {},
): ProvisionalToolVmOwnershipHandle {
	const proof = {
		destructionIdentity: {
			reservationId: verifiedDestroyTarget.reservationId,
			reservationPath: verifiedDestroyTarget.reservationPath,
			vmId: verifiedDestroyTarget.vmId,
		},
		ownershipReservation: createTestVmOwnershipReservationReference(verifiedDestroyTarget.vmId, {
			reservationId: verifiedDestroyTarget.reservationId,
		}),
		verifiedDestroyTarget,
	} satisfies ToolVmProvisionalOwnershipProof;
	return {
		ready: Promise.resolve(proof),
		commitCurrent: vi.fn(async () => {}),
		destroyDetached: vi.fn(async () => createMatchingDestroyReceipt(verifiedDestroyTarget)),
		destroyLive: vi.fn<ProvisionalToolVmOwnershipHandle['destroyLive']>(
			async (closeLiveVm) => await closeLiveVm(),
		),
		...overrides,
	};
}

export interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	resolve(value: TValue): void;
}

export function createDeferred<TValue>(): Deferred<TValue> {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => {
			if (resolvePromise === undefined) {
				throw new Error('deferred promise resolver was not initialized');
			}
			resolvePromise(value);
		},
	};
}

export function createMatchingDestroyReceipt(
	verifiedDestroyTarget: ManagedVmDestroyTargetV1,
): ManagedVmDestroyReceiptV1 {
	return {
		...createCompleteVmDestroyReceipt(verifiedDestroyTarget.vmId, {
			controllerEpoch: verifiedDestroyTarget.controllerEpoch,
			parentGateway: verifiedDestroyTarget.parentGateway,
			reservationId: verifiedDestroyTarget.reservationId,
			role: verifiedDestroyTarget.role,
		}),
		requestedRunner: {
			backend: verifiedDestroyTarget.runner.backend,
			discoveryIdentity: verifiedDestroyTarget.runner.discoveryIdentity,
			executableName: 'qemu-system-aarch64',
		},
	};
}

export async function expectTransitionError(
	operation: () => void | Promise<unknown>,
	code: ToolVmLeaseAuthorityTransitionError['code'],
): Promise<void> {
	let thrownError: unknown;
	try {
		await operation();
	} catch (error) {
		thrownError = error;
	}
	expect(thrownError).toBeInstanceOf(ToolVmLeaseAuthorityTransitionError);
	expect(thrownError).toMatchObject({ code });
}
