import type { GatewayRuntimeTrustedInvocationContext } from '@agent-vm/gateway-control-contracts';
import type { ToolPortalBackendCallOptions } from '@agent-vm/tool-portal';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayControlCallerContextRegistrationClient } from '../control-endpoint/gateway-control-caller-context-registration-client.js';
import type {
	GatewayRuntimeControlCommandClient,
	GatewayRuntimeControlCommandRequest,
} from '../control-endpoint/gateway-control-command-client.js';
import type { GatewayControlAcceptedSession } from '../control-endpoint/gateway-control-endpoint-contracts.js';
import { createGatewayControlControllerHostActionBackendPort } from './controller-host-action-gateway-control-adapter.js';

const operationId = '11111111-1111-5111-8111-111111111111';
const commandId = '22222222-2222-7222-8222-222222222222';
const callerContextId = '33333333-3333-4333-8333-333333333333';
const responseMessageId = '44444444-4444-4444-8444-444444444444';
const expectedHead = '0123456789abcdef0123456789abcdef01234567';
const trustedContext = {
	correlation: { runId: 'run-a', sessionId: 'session-a', toolCallId: 'tool-call-a' },
	principal: {
		agentId: 'agent-a',
		frameworkIdentity: { kind: 'hermes', profileName: 'profile-a' },
		profileAssignmentRevision: 'profile-assignment-a',
		toolPortalProfileId: 'profile-a',
	},
	requester: { authenticatedSubjectId: 'subject-a' },
} as const satisfies GatewayRuntimeTrustedInvocationContext;
const acceptedSession = Object.freeze({
	attachmentGeneration: 1,
	bootId: 'boot-a',
	connectionId: '55555555-5555-4555-8555-555555555555',
	controllerEpoch: 'controller-a',
	gatewayEpoch: 'gateway-a',
	generationId: 'generation-a',
	peerId: 'peer-a',
	processEpoch: 'process-a',
	sessionId: '66666666-6666-4666-8666-666666666666',
	zoneId: 'zone-a',
}) satisfies GatewayControlAcceptedSession;

function callOptions(signal?: AbortSignal): ToolPortalBackendCallOptions<'controller_host_action'> {
	return {
		dispatchAuthority: {
			backendKind: 'controller_host_action',
			fingerprint: `sha256:${'a'.repeat(64)}`,
			kind: 'without-approval',
			operationId,
		},
		...(signal === undefined ? {} : { signal }),
		surfaceClass: 'protected_uds',
		trustedContext,
	};
}

function createFixture(
	props: {
		readonly sendCommand?: GatewayRuntimeControlCommandClient['sendCommand'];
		readonly register?: GatewayControlCallerContextRegistrationClient['register'];
	} = {},
): {
	readonly backend: ReturnType<typeof createGatewayControlControllerHostActionBackendPort>;
	readonly register: ReturnType<
		typeof vi.fn<GatewayControlCallerContextRegistrationClient['register']>
	>;
	readonly sendCommand: ReturnType<typeof vi.fn<GatewayRuntimeControlCommandClient['sendCommand']>>;
} {
	const register = vi.fn<GatewayControlCallerContextRegistrationClient['register']>(
		props.register ??
			(async () => ({
				admissionPrincipal: 'b'.repeat(64),
				callerContextId,
			})),
	);
	const sendCommand = vi.fn<GatewayRuntimeControlCommandClient['sendCommand']>(
		props.sendCommand ??
			(async (_request: GatewayRuntimeControlCommandRequest) => ({
				acceptedSession,
				messageId: responseMessageId,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_controller_host_action',
					payload: {
						controllerHostAction: {
							actionId: 'workspace_git_push',
							result: {
								branch: 'agent/agent-a',
								localHead: expectedHead,
								pushedCommits: [],
								remoteHead: expectedHead,
							},
						},
						responseToMessageId: responseMessageId,
						result: 'ok',
					},
				},
			})),
	);
	return {
		backend: createGatewayControlControllerHostActionBackendPort({
			callerContextRegistrationClient: { close: async () => undefined, register },
			controlCommandClient: { sendCommand },
			createCommandId: () => commandId,
			now: () => 1_000,
			owningGeneration: 'runtime-generation-a',
		}),
		register,
		sendCommand,
	};
}

describe('Gateway Control controller-host-action adapter', () => {
	it('registers the caller and routes workspace_git_push through the existing narrow command', async () => {
		const fixture = createFixture();

		const result = await fixture.backend.call(
			{
				calls: [
					{
						arguments: { expectedHead },
						id: 'call-a',
						name: 'workspace_git_push',
						namespace: 'controller_host_action',
					},
				],
				requestId: 'request-a',
			},
			callOptions(),
		);

		expect(fixture.register).toHaveBeenCalledWith({
			purpose: 'tool_portal_controller_host_action',
			trustedContext,
		});
		expect(fixture.sendCommand).toHaveBeenCalledWith({
			admissionPrincipal: 'b'.repeat(64),
			commandId,
			expiresAtMs: 121_000,
			idempotencyKey: `controller-host-action:${operationId}:sha256:${'a'.repeat(64)}`,
			message: {
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
				payload: {
					actionId: 'workspace_git_push',
					callerContext: { callerContextId },
					correlation: {
						capability: {
							name: 'workspace_git_push',
							namespace: 'controller_host_action',
						},
						requestId: 'request-a',
						runId: 'run-a',
						toolCallId: 'tool-call-a',
					},
					expectedHead,
				},
			},
		});
		expect(result).toMatchObject({
			items: [
				{
					id: 'call-a',
					operationId,
					outcome: { kind: 'completed' },
					owningGeneration: 'runtime-generation-a',
					status: 'ok',
					value: { actionId: 'workspace_git_push' },
				},
			],
			ok: true,
		});
	});

	it('rejects non-exact workspace arguments before registration or dispatch', async () => {
		const fixture = createFixture();

		const result = await fixture.backend.call(
			{
				calls: [
					{
						arguments: { expectedHead: expectedHead.toUpperCase() },
						id: 'call-invalid',
						name: 'workspace_git_push',
						namespace: 'controller_host_action',
					},
				],
			},
			callOptions(),
		);

		expect(result).toMatchObject({ items: [{ status: 'error' }], ok: false });
		expect(fixture.register).not.toHaveBeenCalled();
		expect(fixture.sendCommand).not.toHaveBeenCalled();
	});

	it('returns proven not-dispatched when registration fails before send', async () => {
		const fixture = createFixture({ register: async () => Promise.reject(new Error('offline')) });

		const result = await fixture.backend.call(
			{
				calls: [
					{
						arguments: {},
						id: 'probe-a',
						name: 'controller_host_probe',
						namespace: 'controller_host_action',
					},
				],
			},
			callOptions(),
		);

		expect(result).toMatchObject({
			items: [{ outcome: { kind: 'not-dispatched' }, status: 'error' }],
			ok: false,
		});
		expect(fixture.sendCommand).not.toHaveBeenCalled();
	});

	it('does not register or send when cancellation is already observed', async () => {
		const fixture = createFixture();
		const cancellation = new AbortController();
		cancellation.abort();

		const result = await fixture.backend.call(
			{
				calls: [
					{
						arguments: {},
						id: 'probe-cancelled',
						name: 'controller_host_probe',
						namespace: 'controller_host_action',
					},
				],
			},
			callOptions(cancellation.signal),
		);

		expect(result).toMatchObject({
			items: [{ outcome: { kind: 'not-dispatched' }, status: 'error' }],
			ok: false,
		});
		expect(fixture.register).not.toHaveBeenCalled();
		expect(fixture.sendCommand).not.toHaveBeenCalled();
	});

	it('maps an explicit controller rejection to proven denied before dispatch', async () => {
		const fixture = createFixture({
			sendCommand: async () => ({
				acceptedSession,
				messageId: responseMessageId,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_controller_host_action',
					payload: {
						error: {
							errorClass: 'controller_host_action_denied',
							retryable: false,
							safeMessage: 'controller denied the host action',
						},
						responseToMessageId: responseMessageId,
						result: 'rejected',
					},
				},
			}),
		});

		const result = await fixture.backend.call(
			{
				calls: [
					{
						arguments: {},
						id: 'probe-denied',
						name: 'controller_host_probe',
						namespace: 'controller_host_action',
					},
				],
			},
			callOptions(),
		);

		expect(result).toMatchObject({
			items: [
				{
					error: { code: 'capability_denied' },
					outcome: { kind: 'not-dispatched' },
					status: 'error',
				},
			],
			ok: false,
		});
	});

	it('returns ambiguous after command send transport failure', async () => {
		const fixture = createFixture({
			sendCommand: async () => Promise.reject(new Error('session changed')),
		});

		const result = await fixture.backend.call(
			{
				calls: [
					{
						arguments: {},
						id: 'probe-a',
						name: 'controller_host_probe',
						namespace: 'controller_host_action',
					},
				],
			},
			callOptions(),
		);

		expect(result).toMatchObject({
			items: [{ outcome: { kind: 'ambiguous' }, status: 'error' }],
			ok: false,
		});
	});
});
