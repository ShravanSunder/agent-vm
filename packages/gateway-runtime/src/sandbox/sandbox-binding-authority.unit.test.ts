import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	createGatewayRuntimeSandboxBinding,
	type GatewayRuntimeSandboxTrustedInvocation,
} from './sandbox-binding-authority.js';

const trustedInvocation = {
	backendBindingId: 'sandbox-binding-standard',
	environmentGeneration: 'environment-generation-7',
	principal: {
		agentId: 'agent-main',
		frameworkIdentity: { kind: 'hermes', profileName: 'agent-main' },
		profileAssignmentRevision: 'profile-assignment:agent-main:4',
		toolPortalProfileId: 'standard',
	},
} as const satisfies GatewayRuntimeSandboxTrustedInvocation;

type SandboxPublicRequest =
	| {
			readonly arguments: { readonly commandName: 'configured-health-check' };
			readonly kind: 'exec';
	  }
	| { readonly arguments: { readonly path: string }; readonly kind: 'read_file' };

const validPublicRequest = {
	arguments: { commandName: 'configured-health-check' },
	kind: 'exec',
} as const satisfies SandboxPublicRequest;

describe('Gateway runtime sandbox binding authority', () => {
	it.each([
		['backend', { backend: 'controller_rpc' }],
		['profile', { profileId: 'privileged' }],
		['SSH destination', { ssh: { host: 'attacker.invalid', port: 22, user: 'root' } }],
		['executable', { executable: '/bin/sh' }],
		['working directory', { cwd: '/etc' }],
		['egress', { egress: { allowHosts: ['attacker.invalid'] } }],
	] as const)(
		'rejects a public %s selector before backend admission',
		(_label, authoritySelector) => {
			// Arrange
			let backendAdmissionCount = 0;
			const binding = createGatewayRuntimeSandboxBinding({
				admitTrustedBinding: () => {
					backendAdmissionCount += 1;
					return { bindingId: trustedInvocation.backendBindingId };
				},
			});

			// Act
			const decision = binding.authorize({
				publicInput: { ...validPublicRequest, ...authoritySelector },
				trustedInvocation,
			});

			// Assert
			expect(decision).toEqual({ kind: 'denied', reason: 'public-authority-selector' });
			expect(backendAdmissionCount).toBe(0);
		},
	);

	it('admits only the controller-authored binding selected by trusted invocation context', () => {
		// Arrange
		const binding = createGatewayRuntimeSandboxBinding({
			admitTrustedBinding: (invocation) => ({
				bindingId: invocation.backendBindingId,
			}),
		});

		// Act
		const decision = binding.authorize({ publicInput: validPublicRequest, trustedInvocation });

		// Assert
		expect(decision).toEqual({
			admission: { bindingId: trustedInvocation.backendBindingId },
			kind: 'admitted',
		});
		if (decision.kind !== 'admitted') {
			throw new Error('Expected the trusted sandbox binding to be admitted.');
		}
		expectTypeOf(decision.admission).toEqualTypeOf<{ bindingId: string }>();
	});
});
