import {
	createGatewayRuntimeManagedToolPortalConfig,
	type ManagedToolPortalConfig,
} from '@agent-vm/config-contracts';
import type {
	GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
	GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import type { ToolPortalBackendCallOptions } from '@agent-vm/tool-portal';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayControlCallerContextRegistrationClient } from '../control-endpoint/gateway-control-caller-context-registration-client.js';
import type {
	GatewayRuntimeControlCommandClient,
	GatewayRuntimeControlCommandRequest,
} from '../control-endpoint/gateway-control-command-client.js';
import type { GatewayControlAcceptedSession } from '../control-endpoint/gateway-control-endpoint-contracts.js';
import { createGatewayControlControllerExecutionBackendPort } from './controller-execution-gateway-control-adapter.js';

const operationId = '11111111-1111-5111-8111-111111111111';
const commandId = '22222222-2222-7222-8222-222222222222';
const callerContextId = '33333333-3333-4333-8333-333333333333';
const responseMessageId = '44444444-4444-4444-8444-444444444444';
const expectedHead = '0123456789abcdef0123456789abcdef01234567';
const namespaceSummaryPayloadCanary = 'SUMMARY_MARKER_MUST_NOT_ENTER_CONTROLLER_RPC';
const toolPortalConfig = {
	agents: { 'agent-a': { profile: 'profile-a' } },
	mode: 'managed',
	profiles: {
		'profile-a': {
			namespaces: {
				custom_controller: {
					discovery: { summary: namespaceSummaryPayloadCanary },
					backend: {
						kind: 'controller_execution',
						operations: {
							workspace_git_push: {
								calls: {
									deny: [],
									requiresApproval: [],
									withoutApproval: 'remaining_admitted',
								},
								commands: [{ flagRules: [], path: ['increment'] }],
								deniedPatterns: [],
								executablePath: '/usr/bin/printf',
								executionTarget: {
									cwd: '/tmp',
									environment: { kind: 'empty' },
									kind: 'controller_host',
								},
								kind: 'configured_cli',
								mandatoryArgvPrefix: ['--'],
								output: {
									modelVisibleStderr: 'none',
									overflow: 'truncate',
									stderrMaxBytes: 1024,
									stdoutMaxBytes: 1024,
								},
								safeHelp: 'Prove operation-kind routing is namespace aware.',
								stdin: { kind: 'none' },
								timeout: { kind: 'quick' },
							},
						},
					},
					calls: {
						requiresApproval: { allow: [], deny: [] },
						withoutApproval: { allow: ['workspace_git_push'], deny: [] },
					},
					tools: { allow: ['workspace_git_push'], deny: [] },
				},
				controller_execution: {
					discovery: { summary: namespaceSummaryPayloadCanary },
					backend: {
						kind: 'controller_execution',
						operations: {
							inspect_host: {
								calls: {
									deny: [],
									requiresApproval: [],
									withoutApproval: 'remaining_admitted',
								},
								commands: [{ flagRules: [], path: ['inspect'] }],
								deniedPatterns: [],
								executablePath: '/usr/bin/printf',
								executionTarget: {
									cwd: '/tmp',
									environment: { kind: 'empty' },
									kind: 'controller_host',
								},
								kind: 'configured_cli',
								mandatoryArgvPrefix: ['--'],
								output: {
									modelVisibleStderr: 'none',
									overflow: 'truncate',
									stderrMaxBytes: 1024,
									stdoutMaxBytes: 1024,
								},
								safeHelp: 'Inspect the host fixture.',
								stdin: { kind: 'none' },
								timeout: { kind: 'quick' },
							},
							controller_host_probe: { kind: 'registered_action' },
							workspace_git_push: { kind: 'registered_action' },
						},
					},
					calls: {
						requiresApproval: { allow: ['workspace_git_push'], deny: [] },
						withoutApproval: { allow: ['controller_host_probe', 'inspect_host'], deny: [] },
					},
					tools: {
						allow: ['controller_host_probe', 'inspect_host', 'workspace_git_push'],
						deny: [],
					},
				},
			},
		},
	},
	schemaVersion: 1,
} satisfies ManagedToolPortalConfig;
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

function callOptions(
	signal?: AbortSignal,
	dispatchAuthority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_execution'> = {
		backendKind: 'controller_execution',
		bindingRevision: 'binding:current',
		fingerprint: `sha256:${'a'.repeat(64)}`,
		kind: 'without-approval',
		operationId,
	},
): ToolPortalBackendCallOptions<'controller_execution'> {
	return {
		dispatchAuthority,
		...(signal === undefined ? {} : { signal }),
		surfaceClass: 'protected_uds',
		trustedContext,
	};
}

const approvalReservationDispatchAuthority = {
	backendKind: 'controller_execution',
	kind: 'controller-approval-reservation',
	reservation: {
		approvalId: '77777777-7777-4777-8777-777777777777',
		authorityContext: {
			controllerEpoch: acceptedSession.controllerEpoch,
			frameworkEpoch: acceptedSession.processEpoch,
			gatewayEpoch: acceptedSession.gatewayEpoch,
			runtimeEpoch: acceptedSession.generationId,
			zoneId: acceptedSession.zoneId,
		},
		backendKind: 'controller_execution',
		bindingRevision: 'binding:current',
		expiresAt: '2026-07-20T16:05:00.000Z',
		fingerprint: `sha256:${'c'.repeat(64)}`,
		operationId,
		reservationId: '88888888-8888-4888-8888-888888888888',
		stablePrincipal: 'b'.repeat(64),
	},
} as const satisfies GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_execution'>;

function createFixture(
	props: {
		readonly sendCommand?: GatewayRuntimeControlCommandClient['sendCommand'];
		readonly register?: GatewayControlCallerContextRegistrationClient['register'];
	} = {},
): {
	readonly backend: ReturnType<typeof createGatewayControlControllerExecutionBackendPort>;
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
					operation: 'tool_portal_controller_execution',
					payload: {
						controllerExecution: {
							action: {
								actionId: 'workspace_git_push',
								result: {
									branch: 'agent/agent-a',
									localHead: expectedHead,
									pushedCommits: [],
									remoteHead: expectedHead,
								},
							},
							kind: 'registered_action',
						},
						responseToMessageId: responseMessageId,
						result: 'ok',
					},
				},
			})),
	);
	return {
		backend: createGatewayControlControllerExecutionBackendPort({
			callerContextRegistrationClient: { close: async () => undefined, register },
			controlCommandClient: { sendCommand },
			createCommandId: () => commandId,
			now: () => 1_000,
			owningGeneration: 'runtime-generation-a',
			toolPortalConfig: createGatewayRuntimeManagedToolPortalConfig(toolPortalConfig),
		}),
		register,
		sendCommand,
	};
}

describe('Gateway Control controller-execution adapter', () => {
	it('registers the caller and routes workspace_git_push through the existing narrow command', async () => {
		const fixture = createFixture();

		const result = await fixture.backend.call(
			{
				calls: [
					{
						arguments: { expectedHead },
						id: 'call-a',
						name: 'workspace_git_push',
						namespace: 'controller_execution',
					},
				],
				requestId: 'request-a',
			},
			callOptions(),
		);

		expect(fixture.register).toHaveBeenCalledWith({
			purpose: 'tool_portal_controller_execution',
			trustedContext,
		});
		expect(fixture.sendCommand).toHaveBeenCalledWith({
			admissionPrincipal: 'b'.repeat(64),
			commandId,
			expiresAtMs: 121_000,
			idempotencyKey: `controller-execution:${operationId}:sha256:${'a'.repeat(64)}`,
			message: {
				kind: 'command',
				operation: 'tool_portal_controller_execution',
				payload: {
					action: {
						actionId: 'workspace_git_push',
						callerContext: { callerContextId },
						correlation: {
							capability: {
								name: 'workspace_git_push',
								namespace: 'controller_execution',
							},
							requestId: 'request-a',
							runId: 'run-a',
							toolCallId: 'tool-call-a',
						},
						expectedHead,
					},
					kind: 'registered_action',
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
					value: { action: { actionId: 'workspace_git_push' }, kind: 'registered_action' },
				},
			],
			ok: true,
		});
		expect(JSON.stringify(fixture.sendCommand.mock.calls)).not.toContain(
			namespaceSummaryPayloadCanary,
		);
	});

	it('carries the complete controller approval reservation over Gateway Control', async () => {
		const fixture = createFixture();

		await fixture.backend.call(
			{
				calls: [
					{
						arguments: {},
						id: 'probe-approved',
						name: 'controller_host_probe',
						namespace: 'controller_execution',
					},
				],
			},
			callOptions(undefined, approvalReservationDispatchAuthority),
		);

		expect(fixture.sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: `controller-execution:${operationId}:sha256:${'c'.repeat(64)}`,
				message: expect.objectContaining({
					payload: expect.objectContaining({
						action: expect.objectContaining({
							approvalReservation: approvalReservationDispatchAuthority.reservation,
						}),
					}),
				}),
			}),
		);
	});

	it('routes a validated configured CLI input with a target-derived quick RPC window', async () => {
		const fixture = createFixture({
			sendCommand: async () => ({
				acceptedSession,
				messageId: responseMessageId,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_controller_execution',
					payload: {
						controllerExecution: {
							kind: 'configured_cli',
							operationName: 'inspect_host',
							result: {
								exitCode: 0,
								stderrTruncated: false,
								stdout: 'inspected',
								stdoutTruncated: false,
							},
						},
						responseToMessageId: responseMessageId,
						result: 'ok',
					},
				},
			}),
		});

		const result = await fixture.backend.call(
			{
				calls: [
					{
						arguments: { argv: ['inspect', 'target'], reason: 'verify host fixture' },
						id: 'configured-call',
						name: 'inspect_host',
						namespace: 'controller_execution',
					},
				],
			},
			callOptions(),
		);

		expect(fixture.sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				commandResultTimeoutMs: 15_000,
				createdAtMs: 1_000,
				expiresAtMs: 16_000,
				message: expect.objectContaining({
					payload: expect.objectContaining({
						capability: { name: 'inspect_host', namespace: 'controller_execution' },
						input: { argv: ['inspect', 'target'], reason: 'verify host fixture' },
						invocation: {
							callId: 'configured-call',
							surfaceClass: 'protected_uds',
							trustedContext,
						},
						kind: 'configured_cli',
						operationName: 'inspect_host',
					}),
				}),
			}),
		);
		expect(result).toMatchObject({
			items: [{ status: 'ok', value: { kind: 'configured_cli', operationName: 'inspect_host' } }],
			ok: true,
		});
	});

	it('routes by the configured operation discriminant instead of a built-in action name', async () => {
		const fixture = createFixture({
			sendCommand: async () => ({
				acceptedSession,
				messageId: responseMessageId,
				response: {
					kind: 'command_result',
					operation: 'tool_portal_controller_execution',
					payload: {
						controllerExecution: {
							kind: 'configured_cli',
							operationName: 'workspace_git_push',
							result: {
								exitCode: 0,
								stderrTruncated: false,
								stdout: '1',
								stdoutTruncated: false,
							},
						},
						responseToMessageId: responseMessageId,
						result: 'ok',
					},
				},
			}),
		});

		await fixture.backend.call(
			{
				calls: [
					{
						arguments: { argv: ['increment'], reason: 'prove exact operation routing' },
						id: 'configured-built-in-name',
						name: 'workspace_git_push',
						namespace: 'custom_controller',
					},
				],
			},
			callOptions(),
		);

		expect(fixture.sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.objectContaining({
					payload: expect.objectContaining({
						capability: { name: 'workspace_git_push', namespace: 'custom_controller' },
						kind: 'configured_cli',
					}),
				}),
			}),
		);
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
						namespace: 'controller_execution',
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
						namespace: 'controller_execution',
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
						namespace: 'controller_execution',
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
					operation: 'tool_portal_controller_execution',
					payload: {
						error: {
							errorClass: 'controller_execution_denied',
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
						namespace: 'controller_execution',
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
						namespace: 'controller_execution',
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
