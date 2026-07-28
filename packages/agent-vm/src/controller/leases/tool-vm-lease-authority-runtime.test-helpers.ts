import { expect } from 'vitest';

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
	frameworkIdentity: { agentId: 'main', kind: 'openclaw' },
	profileAssignmentRevision: 'assignment-main',
	toolPortalProfileId: 'standard',
} satisfies StableToolVmLeasePrincipal;

export const PRINCIPAL_SIBLING = {
	...PRINCIPAL_MAIN,
	agentId: 'sibling',
	frameworkIdentity: { agentId: 'sibling', kind: 'openclaw' },
	profileAssignmentRevision: 'assignment-sibling',
} satisfies StableToolVmLeasePrincipal;

export const COMPATIBILITY = {
	policyFingerprint: 'policy-a',
	profileId: 'standard',
	profileAssignmentRevision: 'assignment-main',
	purpose: 'coding',
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
		zoneId: GATEWAY_ONE.zoneId,
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
