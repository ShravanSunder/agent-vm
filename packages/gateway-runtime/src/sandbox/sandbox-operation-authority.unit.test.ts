import { describe, expect, it } from 'vitest';

import {
	createGatewayRuntimeSandboxOperationAuthority,
	type GatewayRuntimeSandboxOperationContext,
} from './sandbox-operation-authority.js';

const currentOperation = {
	activeUseId: 'active-use-9',
	environmentGeneration: 'environment-generation-9',
	gatewayEpoch: 'gateway-epoch-9',
	leafGeneration: 'leaf-generation-9',
	leaseId: 'lease-9',
	sshBindingId: 'ssh-binding-9',
	stablePrincipal: 'a'.repeat(64),
} as const satisfies GatewayRuntimeSandboxOperationContext;

describe('Gateway runtime sandbox operation authority', () => {
	it.each([
		['environment generation', { environmentGeneration: 'environment-generation-8' }],
		['gateway epoch', { gatewayEpoch: 'gateway-epoch-8' }],
		['leaf generation', { leafGeneration: 'leaf-generation-8' }],
		['lease identity', { leaseId: 'lease-8' }],
		['SSH binding', { sshBindingId: 'ssh-binding-8' }],
		['stable principal', { stablePrincipal: 'b'.repeat(64) }],
		['active use', { activeUseId: 'active-use-8' }],
	] as const)('rejects stale %s at each operation boundary', (_label, staleField) => {
		// Arrange
		const authority = createGatewayRuntimeSandboxOperationAuthority(currentOperation);

		// Act
		const decision = authority.authorize({ ...currentOperation, ...staleField });

		// Assert
		expect(decision).toEqual({ kind: 'stale-operation-authority' });
	});

	it('invalidates an already-created handle immediately when replacement begins', () => {
		// Arrange
		const authority = createGatewayRuntimeSandboxOperationAuthority(currentOperation);
		const handle = authority.bindHandle({ handleId: 'process-7' });

		// Act
		authority.beginReplacement({ replacementLeafGeneration: 'leaf-generation-10' });

		// Assert
		expect(handle.authorizeOperation()).toEqual({ kind: 'stale-operation-authority' });
	});
});
