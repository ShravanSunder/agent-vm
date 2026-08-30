import type {
	CapabilityDescriptor,
	JsonObject,
	CapabilitySummary,
	PortalError,
} from '@agent-vm/agent-portal-sdk';
import { JsonObjectSchema } from '@agent-vm/agent-portal-sdk';
import {
	controllerConfiguredCliInputSchema,
	type GatewayRuntimeControllerExecutionOperation,
	type GatewayRuntimeManagedToolPortalConfig,
	openConfiguredCliInputSchema,
	openOAuthConfiguredCliInputSchema,
	quickConfiguredCliInputSchema,
	quickOAuthConfiguredCliInputSchema,
} from '@agent-vm/config-contracts';
import {
	type ControllerExecutionAuthorityBinding,
	type ControllerExecutionResult,
	OAuthAuthorizationBeginArgumentsSchema,
	OAuthAuthorizationCancelArgumentsSchema,
	OAuthAuthorizationControllerActionIdSchema,
	OAuthAuthorizationControllerActionRequestSchema,
	OAuthAuthorizationListArgumentsSchema,
	OAuthAuthorizationReauthorizeArgumentsSchema,
	OAuthAuthorizationRevokeArgumentsSchema,
	OAuthAuthorizationStatusArgumentsSchema,
	OAuthAuthorizationControllerActionResultSchema,
} from '@agent-vm/controller-execution-contracts';
import {
	deriveGatewayControlControllerExecutionRpcWindow,
	GatewayControlControllerHostProbeArgumentsSchema,
	GatewayControlToolPortalControllerExecutionPayloadSchema,
	GatewayControlWorkspaceGitPushArgumentsSchema,
	gatewayControlRegisteredControllerExecutionActionIds,
	gatewayControlCommandExecutionTimeoutMsByOperation,
	type GatewayControlToolPortalControllerExecutionPayload,
} from '@agent-vm/gateway-control-contracts';
import { evaluateCliAllowanceInvocation, type ToolPortalBackendPort } from '@agent-vm/tool-portal';
import { z } from 'zod/v4';

import type { GatewayControlCallerContextRegistrationClient } from '../control-endpoint/gateway-control-caller-context-registration-client.js';
import type { GatewayRuntimeControlCommandClient } from '../control-endpoint/gateway-control-command-client.js';
import {
	createControllerExecutionBackendPort,
	defineControllerExecutionRegistration,
	type ControllerExecutionDispatchRequest,
	type ControllerExecutionRegistration,
	type ControllerExecutionRpcPort,
} from './controller-execution-backend-port.js';

const controllerExecutionNamespace = 'controller_execution';
const oauthAuthorizationNamespace = 'oauth_authorization';
const controllerHostProbeName =
	'controller_host_probe' satisfies (typeof gatewayControlRegisteredControllerExecutionActionIds)[number];
const workspaceGitPushName =
	'workspace_git_push' satisfies (typeof gatewayControlRegisteredControllerExecutionActionIds)[number];

const workspaceGitPushSummary = {
	description: 'Push the current agent workspace Git branch through controller-owned credentials.',
	input: { optional: [], propertyCount: 1, required: ['expectedHead'], type: 'object' },
	name: workspaceGitPushName,
	namespace: controllerExecutionNamespace,
	safety: { destructiveHint: true, readOnlyHint: false },
	title: 'Push workspace Git branch',
	toolRef: `${controllerExecutionNamespace}.${workspaceGitPushName}`,
} as const satisfies CapabilitySummary;

const workspaceGitPushDescriptor = {
	annotations: { authority: 'controller_execution' },
	description: workspaceGitPushSummary.description,
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
	namespace: controllerExecutionNamespace,
	outputSchema: { type: 'object' },
	related: [],
	title: workspaceGitPushSummary.title,
	toolRef: `${controllerExecutionNamespace}.${workspaceGitPushName}`,
} as const satisfies CapabilityDescriptor;

const controllerHostProbeSummary = {
	description: 'Run the fixed read-only controller host availability probe.',
	input: { optional: [], propertyCount: 0, required: [], type: 'object' },
	name: controllerHostProbeName,
	namespace: controllerExecutionNamespace,
	safety: { readOnlyHint: true },
	title: 'Probe controller host',
	toolRef: `${controllerExecutionNamespace}.${controllerHostProbeName}`,
} as const satisfies CapabilitySummary;

const controllerHostProbeDescriptor = {
	annotations: { authority: 'controller_execution' },
	description: controllerHostProbeSummary.description,
	inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
	name: controllerHostProbeName,
	namespace: controllerExecutionNamespace,
	outputSchema: { type: 'object' },
	related: [],
	title: controllerHostProbeSummary.title,
	toolRef: `${controllerExecutionNamespace}.${controllerHostProbeName}`,
} as const satisfies CapabilityDescriptor;

function defineOAuthAuthorizationRegistration(props: {
	readonly argumentsSchema: z.ZodType;
	readonly capabilityName: string;
	readonly description: string;
	readonly input: CapabilitySummary['input'];
	readonly readOnly: boolean;
	readonly title: string;
}): ControllerExecutionRegistration {
	const toolRef = `${oauthAuthorizationNamespace}.${props.capabilityName}`;
	return {
		descriptor: {
			annotations: { authority: 'controller_execution', operationKind: 'oauth_authorization' },
			description: props.description,
			inputSchema: JsonObjectSchema.parse(z.toJSONSchema(props.argumentsSchema)),
			name: props.capabilityName,
			namespace: oauthAuthorizationNamespace,
			outputSchema: JsonObjectSchema.parse(
				z.toJSONSchema(OAuthAuthorizationControllerActionResultSchema),
			),
			related: [],
			title: props.title,
			toolRef,
		},
		parseArguments: (argumentsValue) => {
			const parsedArguments = props.argumentsSchema.safeParse(argumentsValue);
			if (!parsedArguments.success) return { kind: 'invalid' };
			const jsonArguments = JsonObjectSchema.safeParse(parsedArguments.data);
			return jsonArguments.success
				? { kind: 'valid', value: jsonArguments.data }
				: { kind: 'invalid' };
		},
		summary: {
			description: props.description,
			input: props.input,
			name: props.capabilityName,
			namespace: oauthAuthorizationNamespace,
			safety: {
				...(props.readOnly ? {} : { destructiveHint: true }),
				readOnlyHint: props.readOnly,
			},
			title: props.title,
			toolRef,
		},
	};
}

const oauthAuthorizationRegistrations = Object.freeze([
	defineOAuthAuthorizationRegistration({
		argumentsSchema: OAuthAuthorizationListArgumentsSchema,
		capabilityName: 'list',
		description: 'List Google account profiles and their safe authorization status.',
		input: { optional: [], propertyCount: 0, required: [], type: 'object' },
		readOnly: true,
		title: 'List Google authorizations',
	}),
	defineOAuthAuthorizationRegistration({
		argumentsSchema: OAuthAuthorizationBeginArgumentsSchema,
		capabilityName: 'begin',
		description: 'Begin a human-controlled Google authorization ceremony for one account profile.',
		input: {
			optional: ['suggestedSelections'],
			propertyCount: 2,
			required: ['accountProfileId'],
			type: 'object',
		},
		readOnly: false,
		title: 'Begin Google authorization',
	}),
	defineOAuthAuthorizationRegistration({
		argumentsSchema: OAuthAuthorizationStatusArgumentsSchema,
		capabilityName: 'status',
		description: 'Check the safe status of a pending Google authorization ceremony.',
		input: { optional: [], propertyCount: 1, required: ['transactionId'], type: 'object' },
		readOnly: true,
		title: 'Check Google authorization',
	}),
	defineOAuthAuthorizationRegistration({
		argumentsSchema: OAuthAuthorizationCancelArgumentsSchema,
		capabilityName: 'cancel',
		description: 'Cancel a pending Google authorization ceremony owned by this agent.',
		input: { optional: [], propertyCount: 1, required: ['transactionId'], type: 'object' },
		readOnly: false,
		title: 'Cancel Google authorization',
	}),
	defineOAuthAuthorizationRegistration({
		argumentsSchema: OAuthAuthorizationReauthorizeArgumentsSchema,
		capabilityName: 'reauthorize',
		description: 'Begin human-approved reauthorization for one configured Google application.',
		input: {
			optional: ['suggestedSelections'],
			propertyCount: 3,
			required: ['accountProfileId', 'applicationId'],
			type: 'object',
		},
		readOnly: false,
		title: 'Reauthorize Google application',
	}),
	defineOAuthAuthorizationRegistration({
		argumentsSchema: OAuthAuthorizationRevokeArgumentsSchema,
		capabilityName: 'revoke',
		description: 'Revoke and remove one configured Google application authorization.',
		input: {
			optional: [],
			propertyCount: 2,
			required: ['accountProfileId', 'applicationId'],
			type: 'object',
		},
		readOnly: false,
		title: 'Revoke Google application',
	}),
]);

const builtInControllerExecutions = Object.freeze([
	defineControllerExecutionRegistration({
		argumentsSchema: GatewayControlWorkspaceGitPushArgumentsSchema,
		descriptor: workspaceGitPushDescriptor,
		summary: workspaceGitPushSummary,
	}),
	defineControllerExecutionRegistration({
		argumentsSchema: GatewayControlControllerHostProbeArgumentsSchema,
		descriptor: controllerHostProbeDescriptor,
		summary: controllerHostProbeSummary,
	}),
	...oauthAuthorizationRegistrations,
]);

export interface CreateGatewayControlControllerExecutionBackendPortProps {
	readonly callerContextRegistrationClient: GatewayControlCallerContextRegistrationClient;
	readonly controlCommandClient: GatewayRuntimeControlCommandClient;
	readonly createCommandId: () => string;
	readonly now?: () => number;
	readonly owningGeneration: string;
	readonly toolPortalConfig: GatewayRuntimeManagedToolPortalConfig;
}

function configuredInputSchema(
	operation: Extract<GatewayRuntimeControllerExecutionOperation, { kind: 'configured_cli' }>,
):
	| typeof quickConfiguredCliInputSchema
	| typeof openConfiguredCliInputSchema
	| typeof quickOAuthConfiguredCliInputSchema
	| typeof openOAuthConfiguredCliInputSchema {
	return operation.authorization?.kind === 'oauth_account_profile'
		? operation.timeout.kind === 'quick'
			? quickOAuthConfiguredCliInputSchema
			: openOAuthConfiguredCliInputSchema
		: operation.timeout.kind === 'quick'
			? quickConfiguredCliInputSchema
			: openConfiguredCliInputSchema;
}

function configuredRegistration(props: {
	readonly name: string;
	readonly namespace: string;
	readonly operation: Extract<
		GatewayRuntimeControllerExecutionOperation,
		{ kind: 'configured_cli' }
	>;
}): ControllerExecutionRegistration {
	const inputSchema = configuredInputSchema(props.operation);
	const toolRef = `${props.namespace}.${props.name}`;
	return {
		descriptor: {
			annotations: { authority: 'controller_execution', operationKind: 'configured_cli' },
			description: props.operation.safeHelp,
			inputSchema: JsonObjectSchema.parse(z.toJSONSchema(inputSchema)),
			name: props.name,
			namespace: props.namespace,
			outputSchema: { type: 'object' },
			related: [],
			title: props.name,
			toolRef,
		},
		parseArguments: (argumentsValue: JsonObject) => {
			const parsedInput = inputSchema.safeParse(argumentsValue);
			if (!parsedInput.success) return { kind: 'invalid' };
			const validation = evaluateCliAllowanceInvocation({
				allowance: {
					calls: props.operation.calls,
					commands: props.operation.commands,
					deniedPatterns: props.operation.deniedPatterns,
					stdin: props.operation.stdin,
					timeout: props.operation.timeout,
				},
				baseline: 'without_approval',
				input: parsedInput.data,
			});
			return validation.ok
				? { kind: 'valid', value: JsonObjectSchema.parse(parsedInput.data) }
				: { kind: 'invalid' };
		},
		summary: {
			description: props.operation.safeHelp,
			input: {
				optional: props.operation.timeout.kind === 'open' ? ['stdin', 'timeoutMs'] : ['stdin'],
				propertyCount: props.operation.timeout.kind === 'open' ? 4 : 3,
				required: ['argv', 'reason'],
				type: 'object',
			},
			name: props.name,
			namespace: props.namespace,
			safety: { destructiveHint: true, readOnlyHint: false },
			title: props.name,
			toolRef,
		},
	};
}

function controllerExecutionRegistrations(
	config: GatewayRuntimeManagedToolPortalConfig,
): readonly ControllerExecutionRegistration[] {
	const builtInByToolRef = new Map(
		builtInControllerExecutions.map((registration) => [registration.summary.toolRef, registration]),
	);
	const legacyBuiltInByName = new Map(
		builtInControllerExecutions
			.filter((registration) => registration.summary.namespace === controllerExecutionNamespace)
			.map((registration) => [registration.summary.name, registration]),
	);
	const registrationByToolRef = new Map<string, ControllerExecutionRegistration>();
	const policyByToolRef = new Map<string, string>();
	for (const profile of Object.values(config.profiles)) {
		for (const [namespace, namespacePolicy] of Object.entries(profile.namespaces)) {
			if (namespacePolicy.backend.kind !== 'controller_execution') continue;
			for (const [name, operation] of Object.entries(namespacePolicy.backend.operations)) {
				const toolRef = `${namespace}.${name}`;
				const policy = JSON.stringify(operation);
				const existingPolicy = policyByToolRef.get(toolRef);
				if (existingPolicy !== undefined) {
					if (existingPolicy !== policy) {
						throw new Error(`Controller execution operation '${toolRef}' differs across profiles.`);
					}
					continue;
				}
				const registration =
					operation.kind === 'configured_cli'
						? configuredRegistration({ name, namespace, operation })
						: registeredRegistration({
								base: builtInByToolRef.get(toolRef) ?? legacyBuiltInByName.get(name),
								name,
								namespace,
							});
				registrationByToolRef.set(toolRef, registration);
				policyByToolRef.set(toolRef, policy);
			}
		}
	}
	return [...registrationByToolRef.values()];
}

function operationForRequest(
	config: GatewayRuntimeManagedToolPortalConfig,
	request: ControllerExecutionDispatchRequest,
): GatewayRuntimeControllerExecutionOperation | undefined {
	for (const profile of Object.values(config.profiles)) {
		const namespacePolicy = profile.namespaces[request.action.capability.namespace];
		if (namespacePolicy?.backend.kind !== 'controller_execution') continue;
		const operation = namespacePolicy.backend.operations[request.action.capability.name];
		if (operation !== undefined) return operation;
	}
	return undefined;
}

function registeredRegistration(props: {
	readonly base: ControllerExecutionRegistration | undefined;
	readonly name: string;
	readonly namespace: string;
}): ControllerExecutionRegistration {
	if (props.base === undefined) {
		throw new Error(`Controller execution registered action '${props.name}' is not defined.`);
	}
	const toolRef = `${props.namespace}.${props.name}`;
	return {
		...props.base,
		descriptor: { ...props.base.descriptor, namespace: props.namespace, toolRef },
		summary: { ...props.base.summary, namespace: props.namespace, toolRef },
	};
}

function authorityBinding(
	request: ControllerExecutionDispatchRequest,
): ControllerExecutionAuthorityBinding {
	const authority = request.authority.dispatchAuthority;
	return authority.kind === 'without-approval'
		? { fingerprint: authority.fingerprint, operationId: authority.operationId }
		: {
				fingerprint: authority.reservation.fingerprint,
				operationId: authority.reservation.operationId,
			};
}

function commandCorrelation(request: ControllerExecutionDispatchRequest): {
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

function oauthAuthorizationActionIdForCapability(capability: {
	readonly name: string;
	readonly namespace: string;
}): ReturnType<typeof OAuthAuthorizationControllerActionIdSchema.parse> | undefined {
	if (capability.namespace !== oauthAuthorizationNamespace) return undefined;
	switch (capability.name) {
		case 'begin':
		case 'cancel':
		case 'list':
		case 'reauthorize':
		case 'revoke':
		case 'status':
			return OAuthAuthorizationControllerActionIdSchema.parse(
				`${oauthAuthorizationNamespace}.${capability.name}`,
			);
		default:
			return undefined;
	}
}

function controllerActionPayload(props: {
	readonly callerContextId: string;
	readonly operation: GatewayRuntimeControllerExecutionOperation;
	readonly request: ControllerExecutionDispatchRequest;
}): GatewayControlToolPortalControllerExecutionPayload {
	const dispatchAuthority = props.request.authority.dispatchAuthority;
	const common = {
		callerContext: { callerContextId: props.callerContextId },
		correlation: commandCorrelation(props.request),
	};
	if (props.operation.kind === 'configured_cli') {
		return GatewayControlToolPortalControllerExecutionPayloadSchema.parse({
			...common,
			authority:
				dispatchAuthority.kind === 'without-approval'
					? {
							bindingRevision: dispatchAuthority.bindingRevision,
							fingerprint: dispatchAuthority.fingerprint,
							kind: 'without_approval',
							operationId: dispatchAuthority.operationId,
						}
					: {
							kind: 'controller_approval_reservation',
							reservation: dispatchAuthority.reservation,
						},
			capability: props.request.action.capability,
			input: props.request.action.arguments,
			invocation: {
				callId: props.request.correlation.callId,
				surfaceClass: props.request.authority.invocation.surfaceClass,
				trustedContext: props.request.authority.invocation.trustedContext,
			},
			kind: 'configured_cli',
			operationName: props.request.action.capability.name,
		});
	}
	const oauthActionId = oauthAuthorizationActionIdForCapability(props.request.action.capability);
	if (oauthActionId !== undefined) {
		const actionRequest = OAuthAuthorizationControllerActionRequestSchema.parse({
			...props.request.action.arguments,
			actionId: oauthActionId,
		});
		return GatewayControlToolPortalControllerExecutionPayloadSchema.parse({
			action: {
				...actionRequest,
				...common,
				...(dispatchAuthority.kind === 'controller-approval-reservation'
					? { approvalReservation: dispatchAuthority.reservation }
					: {}),
			},
			kind: 'registered_action',
		});
	}
	switch (props.request.action.capability.name) {
		case workspaceGitPushName: {
			const argumentsValue = GatewayControlWorkspaceGitPushArgumentsSchema.parse(
				props.request.action.arguments,
			);
			return GatewayControlToolPortalControllerExecutionPayloadSchema.parse({
				action: {
					...common,
					...(dispatchAuthority.kind === 'controller-approval-reservation'
						? { approvalReservation: dispatchAuthority.reservation }
						: {}),
					actionId: workspaceGitPushName,
					expectedHead: argumentsValue.expectedHead,
				},
				kind: 'registered_action',
			});
		}
		case controllerHostProbeName:
			GatewayControlControllerHostProbeArgumentsSchema.parse(props.request.action.arguments);
			return GatewayControlToolPortalControllerExecutionPayloadSchema.parse({
				action: {
					...common,
					...(dispatchAuthority.kind === 'controller-approval-reservation'
						? { approvalReservation: dispatchAuthority.reservation }
						: {}),
					actionId: controllerHostProbeName,
				},
				kind: 'registered_action',
			});
		default:
			throw new Error(
				`Controller execution registered action '${props.request.action.capability.name}' is not defined.`,
			);
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
			message: props.message ?? 'Controller execution dispatch state is unknown.',
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
	if (props.response.operation !== 'tool_portal_controller_execution') {
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
			value: JsonObjectSchema.parse(payload.controllerExecution),
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
	return `controller-execution:${binding.operationId}:${binding.fingerprint}`;
}

function createGatewayControlControllerExecutionRpcPort(
	props: CreateGatewayControlControllerExecutionBackendPortProps,
): ControllerExecutionRpcPort {
	const now = props.now ?? Date.now;
	return {
		dispatch: async ({ request, signal }) => {
			const binding = authorityBinding(request);
			if (isAborted(signal)) {
				return notDispatchedResult({
					binding,
					code: 'cancelled',
					message: 'Controller execution was cancelled before dispatch.',
					reason: 'stale-authority',
				});
			}
			let callerContext: Awaited<
				ReturnType<GatewayControlCallerContextRegistrationClient['register']>
			>;
			try {
				callerContext = await props.callerContextRegistrationClient.register({
					purpose: 'tool_portal_controller_execution',
					trustedContext: request.authority.invocation.trustedContext,
				});
			} catch {
				return notDispatchedResult({
					binding,
					code: 'not_authorized',
					message: 'Controller execution caller registration failed.',
					reason: 'stale-authority',
				});
			}
			if (isAborted(signal)) {
				return notDispatchedResult({
					binding,
					code: 'cancelled',
					message: 'Controller execution was cancelled before dispatch.',
					reason: 'stale-authority',
				});
			}
			const commandId = props.createCommandId();
			const operation = operationForRequest(props.toolPortalConfig, request);
			if (operation === undefined) {
				return notDispatchedResult({
					binding,
					code: 'capability_denied',
					message: 'Controller execution operation is not current.',
					reason: 'stale-authority',
				});
			}
			const payload = controllerActionPayload({
				callerContextId: callerContext.callerContextId,
				operation,
				request,
			});
			const commandCreatedAtMs = now();
			const configuredOperation = operation.kind === 'configured_cli' ? operation : undefined;
			const configuredRpcWindow =
				configuredOperation === undefined
					? undefined
					: deriveGatewayControlControllerExecutionRpcWindow({
							input: controllerConfiguredCliInputSchema.parse(request.action.arguments),
							nowMs: commandCreatedAtMs,
							targetKind: configuredOperation.targetKind,
							timeoutKind: configuredOperation.timeout.kind,
						});
			let response: Awaited<ReturnType<GatewayRuntimeControlCommandClient['sendCommand']>>;
			try {
				response = await props.controlCommandClient.sendCommand({
					admissionPrincipal: callerContext.admissionPrincipal,
					commandId,
					...(configuredRpcWindow === undefined
						? {}
						: {
								commandResultTimeoutMs: configuredRpcWindow.expiresAtMs - commandCreatedAtMs,
								createdAtMs: commandCreatedAtMs,
							}),
					expiresAtMs:
						configuredRpcWindow?.expiresAtMs ??
						now() +
							gatewayControlCommandExecutionTimeoutMsByOperation.tool_portal_controller_execution,
					idempotencyKey: idempotencyKey(binding),
					message: {
						kind: 'command',
						operation: 'tool_portal_controller_execution',
						payload,
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

export function createGatewayControlControllerExecutionBackendPort(
	props: CreateGatewayControlControllerExecutionBackendPortProps,
): ToolPortalBackendPort<'controller_execution'> {
	return createControllerExecutionBackendPort({
		controllerRpc: createGatewayControlControllerExecutionRpcPort(props),
		registeredActions: controllerExecutionRegistrations(props.toolPortalConfig),
		runtime: { owningGeneration: props.owningGeneration },
	});
}
