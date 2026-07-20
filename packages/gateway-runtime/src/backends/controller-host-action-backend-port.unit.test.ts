import type {
	CapabilityDescriptor,
	CapabilitySummary,
	PortalCallRequest,
	PortalError,
} from '@agent-vm/agent-portal-sdk';
import type { ControllerExecutionResult } from '@agent-vm/controller-execution-contracts';
import type {
	GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
	GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import type { ToolPortalBackendCallOptions, ToolPortalBackendPort } from '@agent-vm/tool-portal';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	createControllerHostActionBackendPort,
	defineControllerHostActionRegistration,
	type ControllerHostActionRpcPort,
} from './controller-host-action-backend-port.js';

const RefreshPackageMetadataArgumentsSchema = z
	.object({ packageName: z.string().startsWith('@agent-vm/') })
	.strict();

const refreshPackageMetadataSummary = {
	description: 'Refresh package metadata through a registered controller operation.',
	input: {
		optional: [],
		propertyCount: 1,
		required: ['packageName'],
		type: 'object',
	},
	namespace: 'controller',
	safety: { readOnlyHint: true },
	title: 'Refresh package metadata',
	name: 'refresh-package-metadata',
	toolRef: 'controller.refresh-package-metadata',
} as const satisfies CapabilitySummary;

const refreshPackageMetadataDescriptor = {
	annotations: { authority: 'controller_host_action' },
	inputSchema: {
		additionalProperties: false,
		properties: {
			packageName: { type: 'string' },
		},
		required: ['packageName'],
		type: 'object',
	},
	namespace: 'controller',
	outputSchema: {
		additionalProperties: false,
		properties: {
			packageName: { type: 'string' },
		},
		required: ['packageName'],
		type: 'object',
	},
	related: [],
	name: 'refresh-package-metadata',
	toolRef: 'controller.refresh-package-metadata',
} as const satisfies CapabilityDescriptor;

const refreshPackageMetadataRegistration = defineControllerHostActionRegistration({
	argumentsSchema: RefreshPackageMetadataArgumentsSchema,
	descriptor: refreshPackageMetadataDescriptor,
	summary: refreshPackageMetadataSummary,
});

const trustedContext = {
	correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { agentId: 'agent-a', kind: 'openclaw' },
		profileAssignmentRevision: 'profile-revision-a',
		toolPortalProfileId: 'code-builder',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} as const satisfies GatewayRuntimeTrustedInvocationContext;

const directDispatchAuthority = {
	backendKind: 'controller_host_action',
	fingerprint: `sha256:${'a'.repeat(64)}`,
	kind: 'without-approval',
	operationId: '11111111-1111-5111-8111-111111111111',
} as const satisfies GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_host_action'>;

const approvalReservationDispatchAuthority = {
	backendKind: 'controller_host_action',
	kind: 'controller-approval-reservation',
	reservation: {
		approvalId: '22222222-2222-5222-8222-222222222222',
		authorityContext: {
			controllerEpoch: 'controller-epoch-a',
			frameworkEpoch: 'framework-epoch-a',
			gatewayEpoch: 'gateway-epoch-a',
			runtimeEpoch: 'runtime-epoch-a',
			zoneId: 'zone-a',
		},
		backendKind: 'controller_host_action',
		expiresAt: '2026-07-13T22:00:00.000Z',
		fingerprint: `sha256:${'b'.repeat(64)}`,
		operationId: '33333333-3333-5333-8333-333333333333',
		reservationId: '44444444-4444-5444-8444-444444444444',
		stablePrincipal: 'c'.repeat(64),
	},
} as const satisfies GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_host_action'>;

const portalCallRequest = {
	calls: [
		{
			arguments: { packageName: '@agent-vm/agent-vm' },
			id: 'call-a',
			namespace: 'controller',
			name: 'refresh-package-metadata',
		},
	],
	requestId: 'request-a',
} as const satisfies PortalCallRequest;

function callOptions(
	dispatchAuthority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_host_action'> = directDispatchAuthority,
): ToolPortalBackendCallOptions<'controller_host_action'> {
	return {
		dispatchAuthority,
		surfaceClass: 'mcp',
		trustedContext,
	};
}

function authorityBinding(
	dispatchAuthority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_host_action'>,
): { readonly fingerprint: string; readonly operationId: string } {
	return dispatchAuthority.kind === 'without-approval'
		? {
				fingerprint: dispatchAuthority.fingerprint,
				operationId: dispatchAuthority.operationId,
			}
		: {
				fingerprint: dispatchAuthority.reservation.fingerprint,
				operationId: dispatchAuthority.reservation.operationId,
			};
}

function completedRpcResult(
	dispatchAuthority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_host_action'> = directDispatchAuthority,
): ControllerExecutionResult {
	return {
		binding: authorityBinding(dispatchAuthority),
		certainty: 'proven',
		completion: 'succeeded',
		diagnostics: [],
		kind: 'completed',
		retryClass: 'forbidden',
		value: { packageName: '@agent-vm/agent-vm' },
	};
}

function createBackendPort(
	dispatch: ControllerHostActionRpcPort['dispatch'],
): ToolPortalBackendPort<'controller_host_action'> {
	return createControllerHostActionBackendPort({
		controllerRpc: { dispatch },
		registeredActions: [refreshPackageMetadataRegistration],
		runtime: { owningGeneration: 'runtime-epoch-a' },
	});
}

const deniedError = {
	code: 'capability_denied',
	message: 'Controller policy denied the registered host action.',
} as const satisfies PortalError;

const staleAuthorityError = {
	code: 'not_authorized',
	message: 'Controller authority is stale.',
} as const satisfies PortalError;

const ambiguousError = {
	code: 'execution_failed',
	message: 'Controller host-action dispatch state is unknown.',
} as const satisfies PortalError;

describe('controller host-action Tool Portal backend port', () => {
	it('exposes a backend-kind-bound port over one narrow grouped controller RPC', () => {
		const dispatch: ControllerHostActionRpcPort['dispatch'] = async (props: {
			readonly request: { readonly kind: 'controller-host-action-dispatch' };
			readonly signal: AbortSignal | undefined;
		}): Promise<ControllerExecutionResult> => {
			const { request, signal } = props;
			expect(request.kind).toBe('controller-host-action-dispatch');
			expect(signal).toBeUndefined();
			return completedRpcResult();
		};
		const backendPort: ToolPortalBackendPort<'controller_host_action'> =
			createBackendPort(dispatch);

		expect(backendPort.backendKind).toBe('controller_host_action');
	});

	it('dispatches a registered typed action with complete trusted invocation and direct authority', async () => {
		const dispatch = vi.fn<ControllerHostActionRpcPort['dispatch']>(async () =>
			completedRpcResult(),
		);
		const backendPort = createBackendPort(dispatch);

		await expect(backendPort.call(portalCallRequest, callOptions())).resolves.toEqual({
			items: [
				{
					id: 'call-a',
					operationId: directDispatchAuthority.operationId,
					outcome: {
						certainty: 'proven',
						completion: 'succeeded',
						kind: 'completed',
						retryClass: 'forbidden',
					},
					owningGeneration: 'runtime-epoch-a',
					status: 'ok',
					value: { packageName: '@agent-vm/agent-vm' },
				},
			],
			ok: true,
		});
		expect(dispatch).toHaveBeenCalledWith({
			request: {
				action: {
					arguments: { packageName: '@agent-vm/agent-vm' },
					capability: {
						name: 'refresh-package-metadata',
						namespace: 'controller',
					},
				},
				authority: {
					dispatchAuthority: directDispatchAuthority,
					invocation: {
						surfaceClass: 'mcp',
						trustedContext,
					},
				},
				correlation: {
					callId: 'call-a',
					requestId: 'request-a',
				},
				kind: 'controller-host-action-dispatch',
			},
			signal: undefined,
		});
	});

	it('preserves the complete approval reservation for controller-side atomic consumption', async () => {
		const dispatch = vi.fn<ControllerHostActionRpcPort['dispatch']>(async () =>
			completedRpcResult(approvalReservationDispatchAuthority),
		);
		const backendPort = createBackendPort(dispatch);

		await expect(
			backendPort.call(portalCallRequest, callOptions(approvalReservationDispatchAuthority)),
		).resolves.toMatchObject({
			items: [
				{
					operationId: approvalReservationDispatchAuthority.reservation.operationId,
					status: 'ok',
				},
			],
			ok: true,
		});
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch.mock.calls[0]?.[0].request.authority).toEqual({
			dispatchAuthority: approvalReservationDispatchAuthority,
			invocation: {
				surfaceClass: 'mcp',
				trustedContext,
			},
		});
	});

	it.each([
		['generic command', { command: 'id' }],
		['executable selection', { executablePath: '/bin/sh' }],
		['mandatory prefix selection', { mandatoryArgvPrefix: '-c' }],
		['OS context selection', { osContextId: 'root' }],
		['credential selection', { credentialProfileId: 'attacker' }],
		['endpoint selection', { endpoint: 'https://attacker.test' }],
	] as const)('rejects public %s before controller RPC dispatch', async (_name, publicOverride) => {
		const dispatch = vi.fn<ControllerHostActionRpcPort['dispatch']>(async () =>
			completedRpcResult(),
		);
		const backendPort = createBackendPort(dispatch);
		const request = {
			...portalCallRequest,
			calls: [
				{
					...portalCallRequest.calls[0],
					arguments: {
						packageName: '@agent-vm/agent-vm',
						...publicOverride,
					},
				},
			],
		} satisfies PortalCallRequest;

		await expect(backendPort.call(request, callOptions())).resolves.toMatchObject({
			items: [
				{
					error: { code: 'validation_failed' },
					operationId: directDispatchAuthority.operationId,
					outcome: {
						certainty: 'proven',
						kind: 'not-dispatched',
						retryClass: 'safe-before-dispatch',
					},
					status: 'error',
				},
			],
			ok: false,
		});
		expect(dispatch).not.toHaveBeenCalled();
	});

	it.each(['execute-command', '/zones/zone-a/execute-command', 'unregistered-action'])(
		'rejects the unregistered %s action without using the admin command route',
		async (actionName) => {
			const dispatch = vi.fn<ControllerHostActionRpcPort['dispatch']>(async () =>
				completedRpcResult(),
			);
			const backendPort = createBackendPort(dispatch);
			const request = {
				...portalCallRequest,
				calls: [{ ...portalCallRequest.calls[0], name: actionName }],
			} satisfies PortalCallRequest;

			await expect(backendPort.call(request, callOptions())).resolves.toMatchObject({
				items: [
					{
						error: { code: 'capability_denied' },
						outcome: { kind: 'not-dispatched' },
						status: 'error',
					},
				],
				ok: false,
			});
			expect(dispatch).not.toHaveBeenCalled();
		},
	);

	it.each([
		{
			expectedError: deniedError,
			expectedOutcome: 'not-dispatched',
			result: {
				binding: authorityBinding(directDispatchAuthority),
				certainty: 'proven',
				diagnostics: [],
				error: deniedError,
				kind: 'not-dispatched',
				reason: 'denied',
				retryClass: 'safe-before-dispatch',
			} satisfies ControllerExecutionResult,
		},
		{
			expectedError: staleAuthorityError,
			expectedOutcome: 'not-dispatched',
			result: {
				binding: authorityBinding(directDispatchAuthority),
				certainty: 'proven',
				diagnostics: [],
				error: staleAuthorityError,
				kind: 'not-dispatched',
				reason: 'stale-authority',
				retryClass: 'safe-before-dispatch',
			} satisfies ControllerExecutionResult,
		},
		{
			expectedError: ambiguousError,
			expectedOutcome: 'ambiguous',
			result: {
				binding: authorityBinding(directDispatchAuthority),
				certainty: 'side-effects-and-termination-unknown',
				diagnostics: [],
				error: ambiguousError,
				kind: 'ambiguous',
				reason: 'dispatch-state-unknown',
				retryClass: 'forbidden',
			} satisfies ControllerExecutionResult,
		},
	] as const)(
		'fails closed for controller result kind $result.kind',
		async ({ expectedError, expectedOutcome, result }) => {
			const backendPort = createBackendPort(async () => result);

			await expect(backendPort.call(portalCallRequest, callOptions())).resolves.toMatchObject({
				items: [
					{
						error: expectedError,
						operationId: directDispatchAuthority.operationId,
						outcome: { kind: expectedOutcome },
						status: 'error',
					},
				],
				ok: false,
			});
		},
	);

	it('treats a missing or stale response binding and RPC failure as ambiguous without retry', async () => {
		const missingBindingPort = createBackendPort(async () => ({
			certainty: 'proven',
			diagnostics: [],
			error: deniedError,
			kind: 'not-dispatched',
			reason: 'denied',
			retryClass: 'safe-before-dispatch',
		}));
		const staleBindingPort = createBackendPort(async () => ({
			...completedRpcResult(),
			binding: {
				fingerprint: `sha256:${'d'.repeat(64)}`,
				operationId: '55555555-5555-5555-8555-555555555555',
			},
		}));
		const failedRpcPort = createBackendPort(async () => {
			throw new Error('controller connection ended after dispatch');
		});

		await Promise.all(
			[missingBindingPort, staleBindingPort, failedRpcPort].map(async (backendPort) => {
				await expect(backendPort.call(portalCallRequest, callOptions())).resolves.toMatchObject({
					items: [
						{
							error: { code: 'execution_failed' },
							operationId: directDispatchAuthority.operationId,
							outcome: {
								certainty: 'side-effects-and-termination-unknown',
								kind: 'ambiguous',
								retryClass: 'forbidden',
							},
							status: 'error',
						},
					],
					ok: false,
				});
			}),
		);
	});
});
