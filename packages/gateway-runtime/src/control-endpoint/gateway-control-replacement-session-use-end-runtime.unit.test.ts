import {
	deriveGatewayControlStablePrincipal,
	type GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayControlRegisteredCallerContext } from './gateway-control-caller-context-registration-client.js';
import type { GatewayControlAcceptedSession } from './gateway-control-endpoint-contracts.js';
import { createGatewayControlReplacementSessionUseEndRuntime } from './gateway-control-replacement-session-use-end-runtime.js';

const sessionA = Object.freeze({
	attachmentGeneration: 1,
	bootId: 'boot-a',
	connectionId: 'connection-a',
	controllerEpoch: 'controller-a',
	gatewayEpoch: 'gateway-a',
	generationId: 'gateway-a',
	peerId: 'peer-a',
	processEpoch: 'process-a',
	sessionId: 'session-a',
	zoneId: 'zone-a',
}) satisfies GatewayControlAcceptedSession;

const sessionB = Object.freeze({
	...sessionA,
	attachmentGeneration: 2,
	connectionId: 'connection-b',
	sessionId: 'session-b',
}) satisfies GatewayControlAcceptedSession;

const trustedContextA = Object.freeze({
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'framework-agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'revision-a',
		toolPortalProfileId: 'profile-a',
	},
}) satisfies GatewayRuntimeTrustedInvocationContext;
const trustedContextB = Object.freeze({
	principal: {
		agentId: 'agent-b',
		frameworkIdentity: { agentId: 'framework-agent-b', kind: 'openclaw' },
		profileAssignmentRevision: 'revision-b',
		toolPortalProfileId: 'profile-b',
	},
}) satisfies GatewayRuntimeTrustedInvocationContext;
const stablePrincipalA = deriveGatewayControlStablePrincipal({
	principal: trustedContextA.principal,
});
const stablePrincipalB = deriveGatewayControlStablePrincipal({
	principal: trustedContextB.principal,
});

function deferred<TValue>(): {
	readonly promise: Promise<TValue>;
	resolve(value: TValue): void;
} {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: (value) => resolvePromise?.(value) };
}

describe('Gateway control replacement-session use-end runtime', () => {
	it('settles one queued use through authority from the replacement session', async () => {
		// Arrange
		let currentSession: GatewayControlAcceptedSession | undefined = sessionB;
		const register = vi.fn(
			async (): Promise<GatewayControlRegisteredCallerContext> => ({
				admissionPrincipal: stablePrincipalA,
				callerContextId: '11111111-1111-4111-8111-111111111111',
			}),
		);
		const endUse = vi.fn(async (_request: { readonly leaseId: string }) => true);
		const runtime = createGatewayControlReplacementSessionUseEndRuntime({
			callerContextRegistrationClient: { register },
			controlService: { getCurrentAcceptedSession: () => currentSession },
			endUse,
		});
		runtime.queue({
			leaseId: 'lease-a',
			reason: 'failed',
			stablePrincipal: stablePrincipalA,
			useId: 'use-a',
		});

		// Act
		const settled = await runtime.settle({
			stablePrincipal: stablePrincipalA,
			trustedContext: trustedContextA,
		});
		currentSession = undefined;

		// Assert
		expect(settled).toBe(true);
		expect(register).toHaveBeenCalledOnce();
		expect(endUse).toHaveBeenCalledExactlyOnceWith({
			acceptedSession: sessionB,
			callerContext: {
				admissionPrincipal: stablePrincipalA,
				callerContextId: '11111111-1111-4111-8111-111111111111',
			},
			leaseId: 'lease-a',
			reason: 'failed',
			useId: 'use-a',
		});
		expect(
			await runtime.settle({
				stablePrincipal: stablePrincipalA,
				trustedContext: trustedContextA,
			}),
		).toBe(true);
	});

	it('coalesces concurrent settlement for the same principal', async () => {
		// Arrange
		const endUseResult = deferred<boolean>();
		const register = vi.fn(
			async (): Promise<GatewayControlRegisteredCallerContext> => ({
				admissionPrincipal: stablePrincipalA,
				callerContextId: '11111111-1111-4111-8111-111111111111',
			}),
		);
		const endUse = vi.fn(async () => await endUseResult.promise);
		const runtime = createGatewayControlReplacementSessionUseEndRuntime({
			callerContextRegistrationClient: { register },
			controlService: { getCurrentAcceptedSession: () => sessionB },
			endUse,
		});
		runtime.queue({
			leaseId: 'lease-a',
			reason: 'failed',
			stablePrincipal: stablePrincipalA,
			useId: 'use-a',
		});

		// Act
		const first = runtime.settle({
			stablePrincipal: stablePrincipalA,
			trustedContext: trustedContextA,
		});
		const second = runtime.settle({
			stablePrincipal: stablePrincipalA,
			trustedContext: trustedContextA,
		});
		await vi.waitFor(() => expect(endUse).toHaveBeenCalledOnce());
		endUseResult.resolve(true);

		// Assert
		await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
		expect(register).toHaveBeenCalledOnce();
		expect(endUse).toHaveBeenCalledOnce();
	});

	it('keeps different principals independently settleable', async () => {
		// Arrange
		const register = vi.fn(
			async ({ trustedContext }): Promise<GatewayControlRegisteredCallerContext> => ({
				admissionPrincipal: deriveGatewayControlStablePrincipal({
					principal: trustedContext.principal,
				}),
				callerContextId: '11111111-1111-4111-8111-111111111111',
			}),
		);
		const endUse = vi.fn(async (_request: { readonly leaseId: string }) => true);
		const runtime = createGatewayControlReplacementSessionUseEndRuntime({
			callerContextRegistrationClient: { register },
			controlService: { getCurrentAcceptedSession: () => sessionB },
			endUse,
		});
		runtime.queue({
			leaseId: 'lease-a',
			reason: 'failed',
			stablePrincipal: stablePrincipalA,
			useId: 'use-a',
		});
		runtime.queue({
			leaseId: 'lease-b',
			reason: 'failed',
			stablePrincipal: stablePrincipalB,
			useId: 'use-b',
		});

		// Act
		const settledA = await runtime.settle({
			stablePrincipal: stablePrincipalA,
			trustedContext: trustedContextA,
		});
		const settledB = await runtime.settle({
			stablePrincipal: stablePrincipalB,
			trustedContext: trustedContextB,
		});

		// Assert
		expect(settledA).toBe(true);
		expect(settledB).toBe(true);
		expect(endUse.mock.calls.map(([request]) => request.leaseId)).toEqual(['lease-a', 'lease-b']);
	});

	it('retains cleanup when authority registration crosses sessions', async () => {
		// Arrange
		let currentSession: GatewayControlAcceptedSession | undefined = sessionA;
		const firstRegistration = deferred<GatewayControlRegisteredCallerContext>();
		const register = vi
			.fn()
			.mockImplementationOnce(async () => await firstRegistration.promise)
			.mockResolvedValue({
				admissionPrincipal: stablePrincipalA,
				callerContextId: '22222222-2222-4222-8222-222222222222',
			} satisfies GatewayControlRegisteredCallerContext);
		const endUse = vi.fn(async () => true);
		const runtime = createGatewayControlReplacementSessionUseEndRuntime({
			callerContextRegistrationClient: { register },
			controlService: { getCurrentAcceptedSession: () => currentSession },
			endUse,
		});
		runtime.queue({
			leaseId: 'lease-a',
			reason: 'failed',
			stablePrincipal: stablePrincipalA,
			useId: 'use-a',
		});

		// Act
		const staleSettlement = runtime.settle({
			stablePrincipal: stablePrincipalA,
			trustedContext: trustedContextA,
		});
		currentSession = sessionB;
		firstRegistration.resolve({
			admissionPrincipal: stablePrincipalA,
			callerContextId: '11111111-1111-4111-8111-111111111111',
		});
		const staleResult = await staleSettlement;
		const freshResult = await runtime.settle({
			stablePrincipal: stablePrincipalA,
			trustedContext: trustedContextA,
		});

		// Assert
		expect(staleResult).toBe(false);
		expect(freshResult).toBe(true);
		expect(endUse).toHaveBeenCalledOnce();
		expect(endUse).toHaveBeenCalledWith(expect.objectContaining({ acceptedSession: sessionB }));
	});

	it('retries only failed uses after partial cleanup', async () => {
		// Arrange
		const register = vi.fn(
			async (): Promise<GatewayControlRegisteredCallerContext> => ({
				admissionPrincipal: stablePrincipalA,
				callerContextId: '11111111-1111-4111-8111-111111111111',
			}),
		);
		let leaseBEndAttempt = 0;
		const endUse = vi.fn(async (request: { readonly leaseId: string }) => {
			if (request.leaseId === 'lease-a') return true;
			leaseBEndAttempt += 1;
			return leaseBEndAttempt > 1;
		});
		const runtime = createGatewayControlReplacementSessionUseEndRuntime({
			callerContextRegistrationClient: { register },
			controlService: { getCurrentAcceptedSession: () => sessionB },
			endUse,
		});
		runtime.queue({
			leaseId: 'lease-a',
			reason: 'failed',
			stablePrincipal: stablePrincipalA,
			useId: 'use-a',
		});
		runtime.queue({
			leaseId: 'lease-b',
			reason: 'failed',
			stablePrincipal: stablePrincipalA,
			useId: 'use-b',
		});

		// Act
		const firstResult = await runtime.settle({
			stablePrincipal: stablePrincipalA,
			trustedContext: trustedContextA,
		});
		const secondResult = await runtime.settle({
			stablePrincipal: stablePrincipalA,
			trustedContext: trustedContextA,
		});

		// Assert
		expect(firstResult).toBe(false);
		expect(secondResult).toBe(true);
		expect(endUse.mock.calls.map(([request]) => request.leaseId)).toEqual([
			'lease-a',
			'lease-b',
			'lease-b',
		]);
	});
});
