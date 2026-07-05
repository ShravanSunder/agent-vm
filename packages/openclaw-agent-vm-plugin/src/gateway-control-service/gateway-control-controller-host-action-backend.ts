import { randomUUID } from 'node:crypto';

import {
	type JsonValue,
	PortalCallRequestSchema,
	type PortalCallResult,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	type PortalDescribeResult,
	PortalDescribeResultSchema,
	PortalListRequestSchema,
	type PortalListResult,
	PortalListResultSchema,
	PortalSearchRequestSchema,
	type PortalSearchResult,
	PortalSearchResultSchema,
} from '@agent-vm/agent-portal-sdk';
import {
	ToolPortalControllerHostActionProjectionSchema,
	type ToolPortalControllerHostActionProjection,
	type ToolPortalToolSelector,
} from '@agent-vm/config-contracts';
import {
	CONTROL_PROTOCOL_VERSION,
	type ControlDeliveryPolicy,
	type ControlEnvelope,
	type DomainControlMessageIdentity,
} from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcMessageSchema,
	GatewayControlToolPortalControllerHostActionPayloadSchema,
	gatewayControlDeliveryPolicyByOperation,
} from '@agent-vm/gateway-control-contracts';
import type { ToolPortalCapabilityBackend } from '@agent-vm/tool-portal';
import { z } from 'zod/v4';

import {
	signGatewayControlCallerContextAgentAuthority,
	signGatewayControlCallerContextProof,
} from './gateway-control-caller-context-proof.js';
import type {
	GatewayControlCallerContextCacheScope,
	GatewayControlCallerContextStore,
} from './gateway-control-caller-context-store.js';
import type { GatewayControlIdentity, GatewayControlService } from './gateway-control-service.js';

const controllerHostActionToolName = 'zone_git_push';

const ZoneGitPushCallArgumentsSchema = z
	.object({
		expectedHead: z.string().min(1),
	})
	.strict();

export interface GatewayControlControllerHostActionBackendOptions {
	readonly callerContextStore: GatewayControlCallerContextStore;
	readonly callerContextScope: GatewayControlCallerContextCacheScope;
	readonly controlService: GatewayControlService;
	readonly createId?: () => string;
	readonly identity: GatewayControlIdentity;
	readonly now?: () => number;
	readonly projection: ToolPortalControllerHostActionProjection;
}

interface ControllerHostActionCapability {
	readonly namespace: string;
	readonly name: typeof controllerHostActionToolName;
}

type PortalCallOkItem = Extract<PortalCallResult['items'][number], { readonly status: 'ok' }>;
type PortalDescribeOkItem = Extract<
	PortalDescribeResult['items'][number],
	{ readonly status: 'ok' }
>;
type PortalListOkItem = Extract<PortalListResult['items'][number], { readonly status: 'ok' }>;

interface GatewayControlCommandRetryIdentity {
	readonly commandId: string;
	readonly idempotencyKey: string;
	readonly messageId: string;
}

function selectorIncludesTool(selector: ToolPortalToolSelector, name: string): boolean {
	if (selector.deny.includes(name)) {
		return false;
	}
	return selector.allow === '*' || selector.allow.includes(name);
}

function controllerHostActionCapabilities(
	projection: ToolPortalControllerHostActionProjection,
): readonly ControllerHostActionCapability[] {
	return Object.entries(projection.namespaces)
		.filter(([, namespaceProjection]) =>
			selectorIncludesTool(namespaceProjection.tools, controllerHostActionToolName),
		)
		.map(([namespace]) => ({
			namespace,
			name: controllerHostActionToolName,
		}));
}

function canCallCapability(
	projection: ToolPortalControllerHostActionProjection,
	capability: { readonly namespace: string; readonly name: string },
): 'allow' | 'approval_required' | 'capability_denied' {
	const namespaceProjection = projection.namespaces[capability.namespace];
	if (
		namespaceProjection === undefined ||
		capability.name !== controllerHostActionToolName ||
		!selectorIncludesTool(namespaceProjection.tools, capability.name)
	) {
		return 'capability_denied';
	}
	if (selectorIncludesTool(namespaceProjection.calls.withoutApproval, capability.name)) {
		return 'allow';
	}
	if (selectorIncludesTool(namespaceProjection.calls.requiresApproval, capability.name)) {
		return 'approval_required';
	}
	return 'capability_denied';
}

function capabilitySummary(
	capability: ControllerHostActionCapability,
): PortalListOkItem['value']['tools'][number] {
	return {
		description: 'Ask the controller to push the OpenClaw zone Git branch.',
		input: {
			optional: [],
			propertyCount: 1,
			required: ['expectedHead'],
			type: 'object',
		},
		namespace: capability.namespace,
		safety: { destructiveHint: true },
		schemaHint: {
			message: 'Provide expectedHead for the current zone Git branch before calling.',
			next: 'call_ready',
		},
		title: 'Push zone Git',
		name: capability.name,
		toolRef: `${capability.namespace}.${capability.name}`,
	};
}

function capabilityDescriptor(
	capability: ControllerHostActionCapability,
): PortalDescribeOkItem['value']['tools'][number] {
	return {
		annotations: {
			authority: 'controller_host_action',
			actionId: 'zone_git_push',
		},
		inputSchema: zoneGitPushInputSchema(),
		namespace: capability.namespace,
		outputSchema: {
			additionalProperties: false,
			properties: {
				actionId: { const: 'zone_git_push', type: 'string' },
				result: { type: 'object' },
			},
			required: ['actionId', 'result'],
			type: 'object',
		},
		related: [],
		schemaHint: {
			message: 'The controller performs the push and returns a sanitized result.',
			next: 'call_ready',
		},
		name: capability.name,
		toolRef: `${capability.namespace}.${capability.name}`,
	};
}

function zoneGitPushInputSchema(): Record<string, JsonValue> {
	return {
		additionalProperties: false,
		properties: {
			expectedHead: {
				description: 'Current expected local zone Git HEAD before the controller push.',
				minLength: 1,
				type: 'string',
			},
		},
		required: ['expectedHead'],
		type: 'object',
	};
}

function requestedCapabilities(
	projection: ToolPortalControllerHostActionProjection,
	request: {
		readonly namespaces?: readonly string[] | undefined;
		readonly tools?: readonly { readonly namespace: string; readonly name: string }[] | undefined;
	},
): readonly ControllerHostActionCapability[] {
	const visibleCapabilities = controllerHostActionCapabilities(projection);
	if (request.tools !== undefined) {
		const requestedRefs = new Set(request.tools.map((tool) => `${tool.namespace}.${tool.name}`));
		return visibleCapabilities.filter((capability) =>
			requestedRefs.has(`${capability.namespace}.${capability.name}`),
		);
	}
	if (request.namespaces !== undefined && request.namespaces.length > 0) {
		const requestedNamespaces = new Set(request.namespaces);
		return visibleCapabilities.filter((capability) =>
			requestedNamespaces.has(capability.namespace),
		);
	}
	return visibleCapabilities;
}

function matchesSearchQuery(
	capability: ControllerHostActionCapability,
	query: string | undefined,
): boolean {
	if (query === undefined || query.trim().length === 0) {
		return true;
	}
	const haystack = `${capability.namespace} ${capability.name} zone git push controller host action`;
	return haystack.toLowerCase().includes(query.toLowerCase());
}

function errorItem(props: {
	readonly code:
		| 'approval_required'
		| 'capability_denied'
		| 'execution_failed'
		| 'validation_failed';
	readonly id: string;
	readonly message: string;
}): PortalCallResult['items'][number] {
	return {
		error: {
			code: props.code,
			message: props.message,
			safeDiagnostic: {
				code: props.code,
				level: props.code === 'approval_required' ? 'warn' : 'error',
				safeMessage: props.message,
			},
		},
		id: props.id,
		status: 'error',
	};
}

function isControllerHostActionCallerContextError(errorClass: string | undefined): boolean {
	return (
		errorClass === 'controller_host_action_caller_context_absent' ||
		errorClass === 'controller_host_action_caller_context_stale'
	);
}

function buildZoneGitPushIdempotencyKey(parts: {
	readonly expectedHead: string;
	readonly namespace: string;
}): string {
	return ['zone_git_push', parts.namespace, parts.expectedHead].join('\u0000');
}

function requireAgentAuthorityKey(options: {
	readonly agentId: string;
	readonly keys: Readonly<Record<string, string>>;
}): string {
	const key = options.keys[options.agentId];
	if (key === undefined || key.length === 0) {
		throw new Error(
			`gateway control missing caller-context agent authority for '${options.agentId}'`,
		);
	}
	return key;
}

export function createGatewayControlControllerHostActionBackend(
	options: GatewayControlControllerHostActionBackendOptions,
): ToolPortalCapabilityBackend {
	const projection = ToolPortalControllerHostActionProjectionSchema.parse(options.projection);
	const createId = options.createId ?? randomUUID;
	const now = options.now ?? (() => Date.now());
	const pendingZoneGitPushIdentityByIdempotencyKey = new Map<
		string,
		GatewayControlCommandRetryIdentity
	>();

	const pendingZoneGitPushIdentityFor = (
		idempotencyKey: string,
	): GatewayControlCommandRetryIdentity => {
		const existingIdentity = pendingZoneGitPushIdentityByIdempotencyKey.get(idempotencyKey);
		if (existingIdentity !== undefined) {
			return existingIdentity;
		}
		const identity = {
			commandId: createId(),
			idempotencyKey: [idempotencyKey, createId()].join('\u0000'),
			messageId: createId(),
		} satisfies GatewayControlCommandRetryIdentity;
		pendingZoneGitPushIdentityByIdempotencyKey.set(idempotencyKey, identity);
		return identity;
	};

	const forgetPendingZoneGitPushIdentity = (idempotencyKey: string): void => {
		pendingZoneGitPushIdentityByIdempotencyKey.delete(idempotencyKey);
	};

	const registerControllerHostActionCallerContext = async (): Promise<string> => {
		const cachedCallerContextId = options.callerContextStore.resolveCallerContextIdForAgent({
			...options.callerContextScope,
		});
		if (cachedCallerContextId !== undefined) {
			return cachedCallerContextId;
		}
		const acceptedSession = await options.controlService.getAcceptedSession();
		const messageId = createId();
		const message = GatewayControlRpcMessageSchema.parse({
			kind: 'command',
			operation: 'caller_context_register',
			payload: {
				adapterEvidence: {
					agentAuthority: signGatewayControlCallerContextAgentAuthority({
						input: {
							agentId: options.callerContextScope.agentId,
							agentWorkspaceDir: options.callerContextScope.agentWorkspaceDir,
							purpose: 'tool_portal_controller_host_action',
							sessionKey: options.callerContextScope.sessionKey,
							workMountDir: options.callerContextScope.workMountDir,
							zoneId: options.identity.zoneId,
						},
						key: requireAgentAuthorityKey({
							agentId: options.callerContextScope.agentId,
							keys: options.identity.callerContextAgentAuthorityKeys,
						}),
						keyId: options.callerContextScope.agentId,
					}),
					agentId: options.callerContextScope.agentId,
					agentWorkspaceDir: options.callerContextScope.agentWorkspaceDir,
					proof: signGatewayControlCallerContextProof({
						input: {
							agentId: options.callerContextScope.agentId,
							agentWorkspaceDir: options.callerContextScope.agentWorkspaceDir,
							purpose: 'tool_portal_controller_host_action',
							sessionKey: options.callerContextScope.sessionKey,
							workMountDir: options.callerContextScope.workMountDir,
							zoneId: options.identity.zoneId,
						},
						proofKey: options.identity.callerContextProofKey,
					}),
					purpose: 'tool_portal_controller_host_action',
					sessionKey: options.callerContextScope.sessionKey,
					workMountDir: options.callerContextScope.workMountDir,
					zoneId: options.identity.zoneId,
				},
			},
		});
		const envelope = {
			bootId: options.identity.bootId,
			commandId: createId(),
			connectionId: acceptedSession.connectionId,
			controllerEpoch: options.identity.controllerEpoch,
			createdAtMs: Math.max(1, now()),
			deliveryPolicy:
				gatewayControlDeliveryPolicyByOperation.caller_context_register as ControlDeliveryPolicy,
			domain: 'gateway_control',
			idempotencyKey: `tool_portal_controller_host_action_context:${options.callerContextScope.agentId}:${messageId}`,
			kind: 'command',
			messageId,
			operation: 'caller_context_register',
			peerId: options.identity.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			sequence: options.controlService.nextPeerSequence(),
			sessionId: acceptedSession.sessionId,
			zoneId: options.identity.zoneId,
		} satisfies ControlEnvelope;
		const domainMessage = {
			kind: 'command',
			operation: 'caller_context_register',
		} satisfies DomainControlMessageIdentity;
		const response = GatewayControlRpcCommandResultMessageSchema.parse(
			await options.controlService.emitApplicationMessage(envelope, domainMessage, message),
		);
		const callerContextId = response.payload.callerContext?.callerContextId;
		if (
			response.operation !== 'caller_context_register' ||
			response.payload.responseToMessageId !== messageId ||
			response.payload.result !== 'ok' ||
			callerContextId === undefined
		) {
			throw new Error(
				response.payload.error?.safeMessage ??
					'tool-portal: controller did not issue a caller context.',
			);
		}
		options.callerContextStore.rememberCallerContextForAgent({
			callerContextId,
			...options.callerContextScope,
		});
		return callerContextId;
	};

	const sendZoneGitPush = async (params: {
		readonly expectedHead: string;
		readonly namespace: string;
	}): Promise<PortalCallOkItem['value']> => {
		const emitZoneGitPush = async (
			callerContextId: string,
			commandIdentity: GatewayControlCommandRetryIdentity,
		): Promise<{
			readonly result: ReturnType<typeof GatewayControlRpcCommandResultMessageSchema.parse>;
			readonly messageId: string;
		}> => {
			const payload = GatewayControlToolPortalControllerHostActionPayloadSchema.parse({
				actionId: 'zone_git_push',
				callerContext: {
					callerContextId,
				},
				correlation: {
					capability: {
						name: controllerHostActionToolName,
						namespace: params.namespace,
					},
				},
				expectedHead: params.expectedHead,
			});
			const message = GatewayControlRpcMessageSchema.parse({
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
				payload,
			});
			const acceptedSession = await options.controlService.getAcceptedSession();
			const envelope = {
				bootId: options.identity.bootId,
				commandId: commandIdentity.commandId,
				connectionId: acceptedSession.connectionId,
				controllerEpoch: options.identity.controllerEpoch,
				createdAtMs: Math.max(1, now()),
				deliveryPolicy:
					gatewayControlDeliveryPolicyByOperation.tool_portal_controller_host_action as ControlDeliveryPolicy,
				domain: 'gateway_control',
				idempotencyKey: commandIdentity.idempotencyKey,
				kind: 'command',
				messageId: commandIdentity.messageId,
				operation: 'tool_portal_controller_host_action',
				peerId: options.identity.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				sequence: options.controlService.nextPeerSequence(),
				sessionId: acceptedSession.sessionId,
				zoneId: options.identity.zoneId,
			} satisfies ControlEnvelope;
			const domainMessage = {
				kind: 'command',
				operation: 'tool_portal_controller_host_action',
			} satisfies DomainControlMessageIdentity;
			return {
				messageId: commandIdentity.messageId,
				result: GatewayControlRpcCommandResultMessageSchema.parse(
					await options.controlService.emitApplicationMessage(envelope, domainMessage, message),
				),
			};
		};

		const zoneGitPushIdempotencyKey = buildZoneGitPushIdempotencyKey(params);
		let commandIdentity = pendingZoneGitPushIdentityFor(zoneGitPushIdempotencyKey);
		let callerContextId = await registerControllerHostActionCallerContext();
		try {
			let { messageId, result: response } = await emitZoneGitPush(callerContextId, commandIdentity);
			if (isControllerHostActionCallerContextError(response.payload.error?.errorClass)) {
				forgetPendingZoneGitPushIdentity(zoneGitPushIdempotencyKey);
				options.callerContextStore.forgetCallerContextForAgent({
					...options.callerContextScope,
				});
				commandIdentity = pendingZoneGitPushIdentityFor(zoneGitPushIdempotencyKey);
				callerContextId = await registerControllerHostActionCallerContext();
				({ messageId, result: response } = await emitZoneGitPush(callerContextId, commandIdentity));
			}
			if (
				response.operation !== 'tool_portal_controller_host_action' ||
				response.payload.responseToMessageId !== messageId ||
				response.payload.result !== 'ok' ||
				response.payload.controllerHostAction === undefined
			) {
				forgetPendingZoneGitPushIdentity(zoneGitPushIdempotencyKey);
				if (isControllerHostActionCallerContextError(response.payload.error?.errorClass)) {
					options.callerContextStore.forgetCallerContextForAgent({
						...options.callerContextScope,
					});
				}
				throw new Error(
					response.payload.error?.safeMessage ?? 'controller host action did not succeed',
				);
			}
			forgetPendingZoneGitPushIdentity(zoneGitPushIdempotencyKey);
			return response.payload.controllerHostAction;
		} finally {
			options.callerContextStore.forgetCallerContextForAgent({
				...options.callerContextScope,
			});
		}
	};

	return {
		call: async (request): Promise<PortalCallResult> => {
			const callRequest = PortalCallRequestSchema.parse(request);
			const items = await Promise.all(
				callRequest.calls.map(async (call) => {
					const decision = canCallCapability(projection, {
						namespace: call.namespace,
						name: call.name,
					});
					if (decision === 'approval_required') {
						return errorItem({
							code: 'approval_required',
							id: call.id,
							message: `Ask operator to approve ${call.namespace}.${call.name}.`,
						});
					}
					if (decision === 'capability_denied') {
						return errorItem({
							code: 'capability_denied',
							id: call.id,
							message: `Capability ${call.namespace}.${call.name} is not allowed.`,
						});
					}
					const argumentsResult = ZoneGitPushCallArgumentsSchema.safeParse(call.arguments);
					if (!argumentsResult.success) {
						return errorItem({
							code: 'validation_failed',
							id: call.id,
							message: 'zone_git_push requires expectedHead.',
						});
					}
					try {
						return {
							id: call.id,
							status: 'ok' as const,
							value: await sendZoneGitPush({
								expectedHead: argumentsResult.data.expectedHead,
								namespace: call.namespace,
							}),
						};
					} catch {
						return errorItem({
							code: 'execution_failed',
							id: call.id,
							message: 'Controller host action failed.',
						});
					}
				}),
			);
			return PortalCallResultSchema.parse({
				items,
				ok: items.every((item) => item.status === 'ok'),
			});
		},
		describe: async (request): Promise<PortalDescribeResult> => {
			const describeRequest = PortalDescribeRequestSchema.parse(request);
			return PortalDescribeResultSchema.parse({
				items: describeRequest.requests.map((itemRequest) => ({
					id: itemRequest.id,
					status: 'ok',
					value: {
						tools: requestedCapabilities(projection, itemRequest).map(capabilityDescriptor),
					},
				})),
				ok: true,
			});
		},
		list: async (request): Promise<PortalListResult> => {
			const listRequest = PortalListRequestSchema.parse(request);
			return PortalListResultSchema.parse({
				items: listRequest.requests.map((itemRequest) => {
					const capabilities = requestedCapabilities(projection, itemRequest);
					return {
						id: itemRequest.id,
						status: 'ok',
						value: {
							namespaces: [
								...new Set(capabilities.map((capability) => capability.namespace)),
							].toSorted(),
							tools: capabilities.map(capabilitySummary).slice(0, itemRequest.limit),
						},
					};
				}),
				ok: true,
			});
		},
		search: async (request): Promise<PortalSearchResult> => {
			const searchRequest = PortalSearchRequestSchema.parse(request);
			return PortalSearchResultSchema.parse({
				items: searchRequest.requests.map((itemRequest) => ({
					id: itemRequest.id,
					status: 'ok',
					value: {
						tools: requestedCapabilities(projection, itemRequest)
							.filter((capability) => matchesSearchQuery(capability, itemRequest.query))
							.map((capability) => {
								const summary = capabilitySummary(capability);
								return {
									description: summary.description,
									input: summary.input,
									inputSchema:
										itemRequest.schemaDetail === 'none' ? undefined : zoneGitPushInputSchema(),
									namespace: summary.namespace,
									safety: summary.safety,
									schemaHint: summary.schemaHint,
									title: summary.title,
									name: summary.name,
									toolRef: summary.toolRef,
								};
							})
							.slice(0, itemRequest.limit),
					},
				})),
				ok: true,
			});
		},
	};
}
