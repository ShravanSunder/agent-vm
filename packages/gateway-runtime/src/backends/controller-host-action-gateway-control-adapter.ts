import type {
	CapabilityDescriptor,
	CapabilitySummary,
	PortalError,
} from '@agent-vm/agent-portal-sdk';
import type {
	ControllerExecutionAuthorityBinding,
	ControllerExecutionResult,
} from '@agent-vm/controller-execution-contracts';
import {
	GatewayControlToolPortalControllerHostActionPayloadSchema,
	gatewayControlCommandExecutionTimeoutMsByOperation,
	type GatewayControlToolPortalControllerHostActionPayload,
} from '@agent-vm/gateway-control-contracts';
import type { ToolPortalBackendPort } from '@agent-vm/tool-portal';
import { z } from 'zod/v4';

import type { GatewayControlCallerContextRegistrationClient } from '../control-endpoint/gateway-control-caller-context-registration-client.js';
import type { GatewayRuntimeControlCommandClient } from '../control-endpoint/gateway-control-command-client.js';
import {
	createControllerHostActionBackendPort,
	defineControllerHostActionRegistration,
	type ControllerHostActionDispatchRequest,
	type ControllerHostActionRpcPort,
} from './controller-host-action-backend-port.js';

const controllerHostActionNamespace = 'controller_host_action';
const workspaceGitPushName = 'workspace_git_push';
const controllerHostProbeName = 'controller_host_probe';
const GitObjectIdSchema = z
	.string()
	.regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, 'expected an exact lowercase Git object id');
const WorkspaceGitPushArgumentsSchema = z.object({ expectedHead: GitObjectIdSchema }).strict();
const ControllerHostProbeArgumentsSchema = z.object({}).strict();

const workspaceGitPushSummary = {
	description: 'Push the current agent workspace Git branch through controller-owned credentials.',
	input: { optional: [], propertyCount: 1, required: ['expectedHead'], type: 'object' },
	name: workspaceGitPushName,
	namespace: controllerHostActionNamespace,
	safety: { destructiveHint: true, readOnlyHint: false },
	title: 'Push workspace Git branch',
	toolRef: `${controllerHostActionNamespace}.${workspaceGitPushName}`,
} as const satisfies CapabilitySummary;

const workspaceGitPushDescriptor = {
	annotations: { authority: 'controller_host_action' },
	inputSchema: {
		additionalProperties: false,
		properties: {
			expectedHead: {
				pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$',
				type: 'string',
			},
		},
		required: ['expectedHead'],
		type: 'object',
	},
	name: workspaceGitPushName,
	namespace: controllerHostActionNamespace,
	outputSchema: { type: 'object' },
	related: [],
	toolRef: `${controllerHostActionNamespace}.${workspaceGitPushName}`,
} as const satisfies CapabilityDescriptor;

const controllerHostProbeSummary = {
	description: 'Run the fixed read-only controller host availability probe.',
	input: { optional: [], propertyCount: 0, required: [], type: 'object' },
	name: controllerHostProbeName,
	namespace: controllerHostActionNamespace,
	safety: { readOnlyHint: true },
	title: 'Probe controller host',
	toolRef: `${controllerHostActionNamespace}.${controllerHostProbeName}`,
} as const satisfies CapabilitySummary;

const controllerHostProbeDescriptor = {
	annotations: { authority: 'controller_host_action' },
	inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
	name: controllerHostProbeName,
	namespace: controllerHostActionNamespace,
	outputSchema: { type: 'object' },
	related: [],
	toolRef: `${controllerHostActionNamespace}.${controllerHostProbeName}`,
} as const satisfies CapabilityDescriptor;

const registeredControllerHostActions = Object.freeze([
	defineControllerHostActionRegistration({
		argumentsSchema: WorkspaceGitPushArgumentsSchema,
		descriptor: workspaceGitPushDescriptor,
		summary: workspaceGitPushSummary,
	}),
	defineControllerHostActionRegistration({
		argumentsSchema: ControllerHostProbeArgumentsSchema,
		descriptor: controllerHostProbeDescriptor,
		summary: controllerHostProbeSummary,
	}),
]);

export interface CreateGatewayControlControllerHostActionBackendPortProps {
	readonly callerContextRegistrationClient: GatewayControlCallerContextRegistrationClient;
	readonly controlCommandClient: GatewayRuntimeControlCommandClient;
	readonly createCommandId: () => string;
	readonly now?: () => number;
	readonly owningGeneration: string;
}

function authorityBinding(
	request: ControllerHostActionDispatchRequest,
): ControllerExecutionAuthorityBinding {
	const authority = request.authority.dispatchAuthority;
	return authority.kind === 'without-approval'
		? { fingerprint: authority.fingerprint, operationId: authority.operationId }
		: {
				fingerprint: authority.reservation.fingerprint,
				operationId: authority.reservation.operationId,
			};
}

function commandCorrelation(request: ControllerHostActionDispatchRequest): {
	readonly capability: { readonly name: string; readonly namespace: string };
	readonly requestId?: string;
	readonly runId?: string;
	readonly toolCallId?: string;
} {
	const invocationCorrelation = request.authority.invocation.trustedContext.correlation;
	return {
		capability: request.action.capability,
		...(request.correlation.requestId === undefined
			? {}
			: { requestId: request.correlation.requestId }),
		...(invocationCorrelation?.runId === undefined ? {} : { runId: invocationCorrelation.runId }),
		...(invocationCorrelation?.toolCallId === undefined
			? {}
			: { toolCallId: invocationCorrelation.toolCallId }),
	};
}

function controllerActionPayload(props: {
	readonly callerContextId: string;
	readonly request: ControllerHostActionDispatchRequest;
}): GatewayControlToolPortalControllerHostActionPayload {
	const common = {
		callerContext: { callerContextId: props.callerContextId },
		correlation: commandCorrelation(props.request),
	};
	switch (props.request.action.capability.name) {
		case workspaceGitPushName: {
			const argumentsValue = WorkspaceGitPushArgumentsSchema.parse(props.request.action.arguments);
			return GatewayControlToolPortalControllerHostActionPayloadSchema.parse({
				...common,
				actionId: workspaceGitPushName,
				expectedHead: argumentsValue.expectedHead,
			});
		}
		case controllerHostProbeName:
			ControllerHostProbeArgumentsSchema.parse(props.request.action.arguments);
			return GatewayControlToolPortalControllerHostActionPayloadSchema.parse({
				...common,
				actionId: controllerHostProbeName,
			});
		default:
			throw new Error('Controller host action is not registered for Gateway Control dispatch.');
	}
}

function notDispatchedResult(props: {
	readonly binding: ControllerExecutionAuthorityBinding;
	readonly code: PortalError['code'];
	readonly message: string;
	readonly reason: 'denied' | 'stale-authority';
}): ControllerExecutionResult {
	return {
		binding: props.binding,
		certainty: 'proven',
		diagnostics: [],
		error: { code: props.code, message: props.message },
		kind: 'not-dispatched',
		reason: props.reason,
		retryClass: 'safe-before-dispatch',
	};
}

function ambiguousResult(props: {
	readonly binding: ControllerExecutionAuthorityBinding;
	readonly code?: 'cancelled' | 'execution_failed' | 'timeout';
	readonly message?: string;
}): ControllerExecutionResult {
	return {
		binding: props.binding,
		certainty: 'side-effects-and-termination-unknown',
		diagnostics: [],
		error: {
			code: props.code ?? 'execution_failed',
			message: props.message ?? 'Controller host-action dispatch state is unknown.',
		},
		kind: 'ambiguous',
		reason: 'dispatch-state-unknown',
		retryClass: 'forbidden',
	};
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function resultFromControllerResponse(props: {
	readonly binding: ControllerExecutionAuthorityBinding;
	readonly response: Awaited<
		ReturnType<GatewayRuntimeControlCommandClient['sendCommand']>
	>['response'];
}): ControllerExecutionResult {
	if (props.response.operation !== 'tool_portal_controller_host_action') {
		return ambiguousResult({ binding: props.binding });
	}
	const payload = props.response.payload;
	if (payload.result === 'ok') {
		return {
			binding: props.binding,
			certainty: 'proven',
			completion: 'succeeded',
			diagnostics: [],
			kind: 'completed',
			retryClass: 'forbidden',
			value: payload.controllerHostAction,
		};
	}
	if (payload.result === 'rejected') {
		return notDispatchedResult({
			binding: props.binding,
			code: 'capability_denied',
			message: payload.error.safeMessage ?? 'Controller denied the host action.',
			reason: 'denied',
		});
	}
	return ambiguousResult({
		binding: props.binding,
		code:
			payload.result === 'cancelled'
				? 'cancelled'
				: payload.result === 'timeout'
					? 'timeout'
					: 'execution_failed',
		...(payload.error.safeMessage === undefined ? {} : { message: payload.error.safeMessage }),
	});
}

function idempotencyKey(binding: ControllerExecutionAuthorityBinding): string {
	return `controller-host-action:${binding.operationId}:${binding.fingerprint}`;
}

function createGatewayControlControllerHostActionRpcPort(
	props: CreateGatewayControlControllerHostActionBackendPortProps,
): ControllerHostActionRpcPort {
	const now = props.now ?? Date.now;
	return {
		dispatch: async ({ request, signal }) => {
			const binding = authorityBinding(request);
			if (isAborted(signal)) {
				return notDispatchedResult({
					binding,
					code: 'cancelled',
					message: 'Controller host action was cancelled before dispatch.',
					reason: 'stale-authority',
				});
			}
			let callerContext: Awaited<
				ReturnType<GatewayControlCallerContextRegistrationClient['register']>
			>;
			try {
				callerContext = await props.callerContextRegistrationClient.register({
					purpose: 'tool_portal_controller_host_action',
					trustedContext: request.authority.invocation.trustedContext,
				});
			} catch {
				return notDispatchedResult({
					binding,
					code: 'not_authorized',
					message: 'Controller host-action caller registration failed.',
					reason: 'stale-authority',
				});
			}
			if (isAborted(signal)) {
				return notDispatchedResult({
					binding,
					code: 'cancelled',
					message: 'Controller host action was cancelled before dispatch.',
					reason: 'stale-authority',
				});
			}
			const commandId = props.createCommandId();
			let response: Awaited<ReturnType<GatewayRuntimeControlCommandClient['sendCommand']>>;
			try {
				response = await props.controlCommandClient.sendCommand({
					admissionPrincipal: callerContext.admissionPrincipal,
					commandId,
					expiresAtMs:
						now() +
						gatewayControlCommandExecutionTimeoutMsByOperation.tool_portal_controller_host_action,
					idempotencyKey: idempotencyKey(binding),
					message: {
						kind: 'command',
						operation: 'tool_portal_controller_host_action',
						payload: controllerActionPayload({
							callerContextId: callerContext.callerContextId,
							request,
						}),
					},
				});
			} catch {
				return ambiguousResult({ binding });
			}
			if (isAborted(signal)) return ambiguousResult({ binding, code: 'cancelled' });
			return resultFromControllerResponse({ binding, response: response.response });
		},
	};
}

export function createGatewayControlControllerHostActionBackendPort(
	props: CreateGatewayControlControllerHostActionBackendPortProps,
): ToolPortalBackendPort<'controller_host_action'> {
	return createControllerHostActionBackendPort({
		controllerRpc: createGatewayControlControllerHostActionRpcPort(props),
		registeredActions: registeredControllerHostActions,
		runtime: { owningGeneration: props.owningGeneration },
	});
}
