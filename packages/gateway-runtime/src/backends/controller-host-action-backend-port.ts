import {
	PortalCallRequestSchema,
	PortalCallResultSchema,
	PortalDescribeRequestSchema,
	PortalDescribeResultSchema,
	PortalListRequestSchema,
	PortalListResultSchema,
	PortalSearchRequestSchema,
	PortalSearchResultSchema,
	type CapabilityDescriptor,
	type CapabilitySearchMatch,
	type CapabilitySummary,
	type JsonObject,
	type JsonValue,
	type PortalCallRequest,
	type PortalCallResult,
	type PortalDescribeResult,
	type PortalError,
	type PortalListResult,
	type PortalSearchResult,
	type SafeDiagnostic,
} from '@agent-vm/agent-portal-sdk';
import type {
	ControllerExecutionAuthorityBinding,
	ControllerExecutionResult,
} from '@agent-vm/controller-execution-contracts';
import type {
	GatewayRuntimePortalSurfaceClass,
	GatewayRuntimeToolPortalDispatchAuthorityForBackendKind,
	GatewayRuntimeTrustedInvocationContext,
} from '@agent-vm/gateway-control-contracts';
import type { ToolPortalBackendPort } from '@agent-vm/tool-portal';
import type { z } from 'zod';

export interface ControllerHostActionDispatchRequest {
	readonly action: {
		readonly arguments: JsonObject;
		readonly capability: {
			readonly name: string;
			readonly namespace: string;
		};
	};
	readonly authority: {
		readonly dispatchAuthority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_host_action'>;
		readonly invocation: {
			readonly surfaceClass: GatewayRuntimePortalSurfaceClass;
			readonly trustedContext: GatewayRuntimeTrustedInvocationContext;
		};
	};
	readonly correlation: {
		readonly callId: string;
		readonly requestId: string | undefined;
	};
	readonly kind: 'controller-host-action-dispatch';
}

export interface ControllerHostActionRpcPort {
	readonly dispatch: (props: {
		readonly request: ControllerHostActionDispatchRequest;
		readonly signal: AbortSignal | undefined;
	}) => Promise<ControllerExecutionResult>;
}

export interface ControllerHostActionRegistration {
	readonly descriptor: CapabilityDescriptor;
	readonly parseArguments: (argumentsValue: JsonObject) => ControllerHostActionArgumentsResult;
	readonly summary: CapabilitySummary;
}

type ControllerHostActionArgumentsResult =
	| { readonly kind: 'valid'; readonly value: JsonObject }
	| { readonly kind: 'invalid' };

export function defineControllerHostActionRegistration<TArguments extends JsonObject>(props: {
	readonly argumentsSchema: z.ZodType<TArguments>;
	readonly descriptor: CapabilityDescriptor;
	readonly summary: CapabilitySummary;
}): ControllerHostActionRegistration {
	return {
		descriptor: props.descriptor,
		parseArguments: (argumentsValue): ControllerHostActionArgumentsResult => {
			const parsedArguments = props.argumentsSchema.safeParse(argumentsValue);
			return parsedArguments.success
				? { kind: 'valid', value: parsedArguments.data }
				: { kind: 'invalid' };
		},
		summary: props.summary,
	};
}

export interface CreateControllerHostActionBackendPortProps {
	readonly controllerRpc: ControllerHostActionRpcPort;
	readonly registeredActions: readonly ControllerHostActionRegistration[];
	readonly runtime: {
		readonly owningGeneration: string;
	};
}

interface RegisteredActionCatalog {
	readonly actions: readonly ControllerHostActionRegistration[];
	readonly byCapabilityKey: ReadonlyMap<string, ControllerHostActionRegistration>;
}

function capabilityKey(namespace: string, name: string): string {
	return `${namespace}\u0000${name}`;
}

function createRegisteredActionCatalog(
	registeredActions: readonly ControllerHostActionRegistration[],
): RegisteredActionCatalog {
	const actions = registeredActions.toSorted((left, right) =>
		left.summary.toolRef.localeCompare(right.summary.toolRef),
	);
	const byCapabilityKey = new Map<string, ControllerHostActionRegistration>();
	for (const action of actions) {
		if (
			action.summary.namespace !== action.descriptor.namespace ||
			action.summary.name !== action.descriptor.name ||
			action.summary.toolRef !== action.descriptor.toolRef
		) {
			throw new TypeError(
				'Controller host-action summary and descriptor must identify one capability.',
			);
		}
		const key = capabilityKey(action.summary.namespace, action.summary.name);
		if (byCapabilityKey.has(key)) {
			throw new TypeError(
				`Controller host action ${action.summary.namespace}.${action.summary.name} is registered more than once.`,
			);
		}
		byCapabilityKey.set(key, action);
	}
	return { actions, byCapabilityKey };
}

function dispatchAuthorityBinding(
	authority: GatewayRuntimeToolPortalDispatchAuthorityForBackendKind<'controller_host_action'>,
): ControllerExecutionAuthorityBinding {
	return authority.kind === 'without-approval'
		? { fingerprint: authority.fingerprint, operationId: authority.operationId }
		: {
				fingerprint: authority.reservation.fingerprint,
				operationId: authority.reservation.operationId,
			};
}

function bindingMatches(
	actual: ControllerExecutionAuthorityBinding | undefined,
	expected: ControllerExecutionAuthorityBinding,
): boolean {
	return (
		actual !== undefined &&
		actual.operationId === expected.operationId &&
		actual.fingerprint === expected.fingerprint
	);
}

function notDispatchedOutcome(): {
	readonly certainty: 'proven';
	readonly kind: 'not-dispatched';
	readonly retryClass: 'safe-before-dispatch';
} {
	return {
		certainty: 'proven',
		kind: 'not-dispatched',
		retryClass: 'safe-before-dispatch',
	};
}

function ambiguousOutcome(): {
	readonly certainty: 'side-effects-and-termination-unknown';
	readonly kind: 'ambiguous';
	readonly retryClass: 'forbidden';
} {
	return {
		certainty: 'side-effects-and-termination-unknown',
		kind: 'ambiguous',
		retryClass: 'forbidden',
	};
}

function deniedError(message: string): PortalError {
	return { code: 'capability_denied', message };
}

function invalidArgumentsError(): PortalError {
	return {
		code: 'validation_failed',
		message: 'Controller host-action arguments do not match the registered schema.',
	};
}

function invalidDispatchBatchError(): PortalError {
	return {
		code: 'invalid_request',
		message: 'Controller host-action authority binds exactly one call.',
	};
}

function ambiguousDispatchError(): PortalError {
	return {
		code: 'execution_failed',
		message: 'Controller host-action dispatch state is unknown.',
	};
}

function notDispatchedCallItem(props: {
	readonly error: PortalError;
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly diagnostics?: readonly SafeDiagnostic[];
}): PortalCallResult['items'][number] {
	return {
		...(props.diagnostics === undefined || props.diagnostics.length === 0
			? {}
			: { diagnostics: [...props.diagnostics] }),
		error: props.error,
		id: props.id,
		operationId: props.operationId,
		outcome: notDispatchedOutcome(),
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
}

function ambiguousCallItem(props: {
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly diagnostics?: readonly SafeDiagnostic[];
	readonly error?: PortalError;
}): PortalCallResult['items'][number] {
	return {
		...(props.diagnostics === undefined || props.diagnostics.length === 0
			? {}
			: { diagnostics: [...props.diagnostics] }),
		error: props.error ?? ambiguousDispatchError(),
		id: props.id,
		operationId: props.operationId,
		outcome: ambiguousOutcome(),
		owningGeneration: props.owningGeneration,
		status: 'error',
	};
}

function completedCallItem(props: {
	readonly diagnostics: readonly SafeDiagnostic[];
	readonly id: string;
	readonly operationId: string;
	readonly owningGeneration: string;
	readonly value: JsonValue;
}): PortalCallResult['items'][number] {
	return {
		...(props.diagnostics.length === 0 ? {} : { diagnostics: [...props.diagnostics] }),
		id: props.id,
		operationId: props.operationId,
		outcome: {
			certainty: 'proven',
			completion: 'succeeded',
			kind: 'completed',
			retryClass: 'forbidden',
		},
		owningGeneration: props.owningGeneration,
		status: 'ok',
		value: props.value,
	};
}

async function dispatchControllerHostAction(props: {
	readonly action: ControllerHostActionRegistration;
	readonly call: PortalCallRequest['calls'][number];
	readonly controllerRpc: ControllerHostActionRpcPort;
	readonly operationId: string;
	readonly options: Parameters<ToolPortalBackendPort<'controller_host_action'>['call']>[1];
	readonly owningGeneration: string;
	readonly requestId: string | undefined;
}): Promise<PortalCallResult['items'][number]> {
	const parsedArguments = props.action.parseArguments(props.call.arguments);
	if (parsedArguments.kind === 'invalid') {
		return notDispatchedCallItem({
			error: invalidArgumentsError(),
			id: props.call.id,
			operationId: props.operationId,
			owningGeneration: props.owningGeneration,
		});
	}

	const expectedBinding = dispatchAuthorityBinding(props.options.dispatchAuthority);
	let rpcResult: ControllerExecutionResult;
	try {
		rpcResult = await props.controllerRpc.dispatch({
			request: {
				action: {
					arguments: parsedArguments.value,
					capability: {
						name: props.call.name,
						namespace: props.call.namespace,
					},
				},
				authority: {
					dispatchAuthority: props.options.dispatchAuthority,
					invocation: {
						surfaceClass: props.options.surfaceClass,
						trustedContext: props.options.trustedContext,
					},
				},
				correlation: {
					callId: props.call.id,
					requestId: props.requestId,
				},
				kind: 'controller-host-action-dispatch',
			},
			signal: props.options.signal,
		});
	} catch {
		return ambiguousCallItem({
			id: props.call.id,
			operationId: props.operationId,
			owningGeneration: props.owningGeneration,
		});
	}

	if (!bindingMatches(rpcResult.binding, expectedBinding)) {
		return ambiguousCallItem({
			id: props.call.id,
			operationId: props.operationId,
			owningGeneration: props.owningGeneration,
		});
	}

	switch (rpcResult.kind) {
		case 'completed':
			return completedCallItem({
				diagnostics: rpcResult.diagnostics,
				id: props.call.id,
				operationId: props.operationId,
				owningGeneration: props.owningGeneration,
				value: rpcResult.value,
			});
		case 'not-dispatched':
			return notDispatchedCallItem({
				diagnostics: rpcResult.diagnostics,
				error: rpcResult.error,
				id: props.call.id,
				operationId: props.operationId,
				owningGeneration: props.owningGeneration,
			});
		case 'ambiguous':
			return ambiguousCallItem({
				diagnostics: rpcResult.diagnostics,
				error: rpcResult.error,
				id: props.call.id,
				operationId: props.operationId,
				owningGeneration: props.owningGeneration,
			});
		default:
			return assertNeverRpcResult(rpcResult);
	}
}

function assertNeverRpcResult(result: never): never {
	throw new TypeError(`Unsupported controller host-action RPC result: ${String(result)}`);
}

function capabilitySelected(props: {
	readonly action: ControllerHostActionRegistration;
	readonly namespaces?: readonly string[] | undefined;
	readonly refs?: readonly string[] | undefined;
	readonly tools?: readonly { readonly name: string; readonly namespace: string }[] | undefined;
}): boolean {
	if (
		props.namespaces !== undefined &&
		!props.namespaces.includes(props.action.summary.namespace)
	) {
		return false;
	}
	if (props.refs !== undefined && !props.refs.includes(props.action.summary.toolRef)) {
		return false;
	}
	return (
		props.tools === undefined ||
		props.tools.some(
			(tool) =>
				tool.namespace === props.action.summary.namespace &&
				tool.name === props.action.summary.name,
		)
	);
}

function searchMatchForAction(props: {
	readonly action: ControllerHostActionRegistration;
	readonly schemaDetail: 'none' | 'summary' | 'full';
}): CapabilitySearchMatch {
	return {
		...props.action.summary,
		...(props.schemaDetail === 'full'
			? {
					...(props.action.descriptor.inputSchema === undefined
						? {}
						: { inputSchema: props.action.descriptor.inputSchema }),
					...(props.action.descriptor.outputSchema === undefined
						? {}
						: { outputSchema: props.action.descriptor.outputSchema }),
				}
			: {}),
	};
}

function descriptorForRequest(props: {
	readonly action: ControllerHostActionRegistration;
	readonly includeJsonSchema: boolean;
	readonly includeRelated: boolean;
	readonly includeTypescriptHelper: boolean;
	readonly includeZod: boolean;
}): CapabilityDescriptor {
	const descriptor = props.action.descriptor;
	return {
		annotations: descriptor.annotations,
		...(props.includeJsonSchema && descriptor.inputSchema !== undefined
			? { inputSchema: descriptor.inputSchema }
			: {}),
		name: descriptor.name,
		namespace: descriptor.namespace,
		...(props.includeJsonSchema && descriptor.outputSchema !== undefined
			? { outputSchema: descriptor.outputSchema }
			: {}),
		related: props.includeRelated ? descriptor.related : [],
		toolRef: descriptor.toolRef,
		...(props.includeTypescriptHelper && descriptor.typescriptHelper !== undefined
			? { typescriptHelper: descriptor.typescriptHelper }
			: {}),
		...(props.includeZod && descriptor.zod !== undefined ? { zod: descriptor.zod } : {}),
	};
}

export function createControllerHostActionBackendPort(
	props: CreateControllerHostActionBackendPortProps,
): ToolPortalBackendPort<'controller_host_action'> {
	const catalog = createRegisteredActionCatalog(props.registeredActions);

	return {
		backendKind: 'controller_host_action',
		async call(request, options): Promise<PortalCallResult> {
			const parsedRequest = PortalCallRequestSchema.parse(request);
			const expectedBinding = dispatchAuthorityBinding(options.dispatchAuthority);
			if (parsedRequest.calls.length !== 1) {
				return PortalCallResultSchema.parse({
					items: parsedRequest.calls.map((call) =>
						notDispatchedCallItem({
							error: invalidDispatchBatchError(),
							id: call.id,
							operationId: expectedBinding.operationId,
							owningGeneration: props.runtime.owningGeneration,
						}),
					),
					ok: false,
				});
			}
			const items = await Promise.all(
				parsedRequest.calls.map(async (call) => {
					const action = catalog.byCapabilityKey.get(capabilityKey(call.namespace, call.name));
					if (action === undefined) {
						return notDispatchedCallItem({
							error: deniedError(
								`Controller host action ${call.namespace}.${call.name} is not registered.`,
							),
							id: call.id,
							operationId: expectedBinding.operationId,
							owningGeneration: props.runtime.owningGeneration,
						});
					}
					return await dispatchControllerHostAction({
						action,
						call,
						controllerRpc: props.controllerRpc,
						operationId: expectedBinding.operationId,
						options,
						owningGeneration: props.runtime.owningGeneration,
						requestId: parsedRequest.requestId,
					});
				}),
			);
			return PortalCallResultSchema.parse({
				items,
				ok: items.every((item) => item.status === 'ok'),
			});
		},
		async describe(request): Promise<PortalDescribeResult> {
			const parsedRequest = PortalDescribeRequestSchema.parse(request);
			return PortalDescribeResultSchema.parse({
				items: parsedRequest.requests.map((itemRequest) => ({
					id: itemRequest.id,
					status: 'ok',
					value: {
						tools: catalog.actions
							.filter((action) =>
								capabilitySelected({
									action,
									refs: itemRequest.refs,
									tools: itemRequest.tools,
								}),
							)
							.map((action) =>
								descriptorForRequest({
									action,
									includeJsonSchema: itemRequest.includeJsonSchema,
									includeRelated: itemRequest.includeRelated,
									includeTypescriptHelper: itemRequest.includeTypescriptHelper,
									includeZod: itemRequest.includeZod,
								}),
							),
					},
				})),
				ok: true,
			});
		},
		async list(request): Promise<PortalListResult> {
			const parsedRequest = PortalListRequestSchema.parse(request);
			return PortalListResultSchema.parse({
				items: parsedRequest.requests.map((itemRequest) => {
					const selectedActions = catalog.actions.filter((action) =>
						capabilitySelected({
							action,
							namespaces: itemRequest.namespaces,
							refs: itemRequest.refs,
							tools: itemRequest.tools,
						}),
					);
					const cursor = Number.parseInt(itemRequest.cursor ?? '0', 10);
					const nextCursor = cursor + itemRequest.limit;
					return {
						id: itemRequest.id,
						status: 'ok',
						value: {
							namespaces: [...new Set(selectedActions.map((action) => action.summary.namespace))],
							...(nextCursor < selectedActions.length ? { nextCursor: String(nextCursor) } : {}),
							tools: selectedActions.slice(cursor, nextCursor).map((action) => action.summary),
						},
					};
				}),
				ok: true,
			});
		},
		async search(request): Promise<PortalSearchResult> {
			const parsedRequest = PortalSearchRequestSchema.parse(request);
			return PortalSearchResultSchema.parse({
				items: parsedRequest.requests.map((itemRequest) => {
					const normalizedQuery = itemRequest.query?.trim().toLocaleLowerCase() ?? '';
					const tools = catalog.actions
						.filter((action) =>
							capabilitySelected({
								action,
								namespaces: itemRequest.namespaces,
							}),
						)
						.filter((action) => {
							if (normalizedQuery.length === 0) {
								return true;
							}
							return [
								action.summary.namespace,
								action.summary.name,
								action.summary.title ?? '',
								action.summary.description ?? '',
								action.summary.toolRef,
							].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
						})
						.slice(0, itemRequest.limit)
						.map((action) =>
							searchMatchForAction({ action, schemaDetail: itemRequest.schemaDetail }),
						);
					return { id: itemRequest.id, status: 'ok', value: { tools } };
				}),
				ok: true,
			});
		},
	};
}
