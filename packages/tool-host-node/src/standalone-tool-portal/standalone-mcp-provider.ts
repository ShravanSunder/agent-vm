import {
	portalAgentScopeKey,
	type PortalAgentIdentity,
} from '@agent-collaboration/tool-access/authorization';
import {
	JsonValueSchema,
	PortalBackendDescribeResultSchema,
	PortalBackendListResultSchema,
	PortalBackendSearchResultSchema,
	PortalCallItemResultSchema,
	jsonValueSchema,
	type JsonValue,
	type PortalCallRequest,
	type SafeDiagnostic,
} from '@agent-collaboration/tool-access/contracts';
import {
	createPortalToolHandlers,
	proxyUpstreamFailureFromError,
	type AgentCatalogView,
	type PortalBatchResult,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import type {
	StandalonePortalCallItem,
	ToolPortalDiscoveryBackendPort,
} from '@agent-collaboration/tool-engine/standalone-tool-portal';
import type { UpstreamMcpClientRuntime } from '@agent-collaboration/tool-engine/upstream-mcp-connectors';

import type { StandaloneToolPortalInvocationOptions } from '#node-host/standalone-tool-portal/models/standalone-portal-contracts';
import {
	portalErrorFromUnknown,
	safeDiagnosticForCode,
} from '#node-host/standalone-tool-portal/standalone-provider-errors';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeModelVisibleValue(value: unknown): unknown {
	if (typeof value === 'string')
		return value.replace(/mcp_portal_(?:call|describe|list|search)/gu, 'portal capability');
	if (Array.isArray(value)) return value.map(sanitizeModelVisibleValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([key]) =>
					![
						'approvalToken',
						'backendKind',
						'executionFingerprint',
						'portalApprovalToken',
						'transport',
						'upstream',
					].includes(key),
			)
			.map(([key, child]) => [key, sanitizeModelVisibleValue(child)]),
	);
}

function publicToolRecord(
	tool: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return {
		...Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'toolName')),
		name: tool['toolName'],
	};
}

function projectPublicValue(value: Readonly<Record<string, unknown>>): JsonValue {
	if (typeof value['namespace'] === 'string' && typeof value['toolName'] === 'string')
		return JsonValueSchema.parse(sanitizeModelVisibleValue(publicToolRecord(value)));
	const tools = value['tools'];
	if (!Array.isArray(tools)) return JsonValueSchema.parse(sanitizeModelVisibleValue(value));
	const records = tools.filter(
		(tool): tool is Record<string, unknown> =>
			isRecord(tool) &&
			typeof tool['namespace'] === 'string' &&
			typeof tool['toolName'] === 'string',
	);
	return JsonValueSchema.parse(
		sanitizeModelVisibleValue({
			...value,
			...(Array.isArray(value['namespaces'])
				? {
						namespaces: [...new Set(records.map((tool) => String(tool['namespace'])))].toSorted(
							(left, right) => (left < right ? -1 : left > right ? 1 : 0),
						),
					}
				: {}),
			tools: records.map(publicToolRecord),
		}),
	);
}

function discoveryResult(batch: PortalBatchResult, mergeBatch: boolean): unknown {
	const diagnostics: SafeDiagnostic[] = batch.diagnostics.map((event) => {
		const diagnostic = safeDiagnosticForCode(event.kind);
		return {
			...diagnostic,
			level: event.kind.includes('failed') ? 'warn' : diagnostic.level,
			...(event.namespace === undefined ? {} : { safeParams: { namespace: event.namespace } }),
		};
	});
	const items = Object.entries(batch.results).map(([id, item]) =>
		item.ok
			? { id, status: 'ok', value: projectPublicValue(item.output) }
			: { id, status: 'error', error: portalErrorFromUnknown(item.error) },
	);
	return {
		diagnostics,
		items,
		ok: (mergeBatch || batch.ok) && items.every((item) => item.status === 'ok'),
	};
}

/** MCP resource adapter. Caller/session filtering is supplied by the host's shared catalog port. */
export function createStandaloneMcpProviderBackend<
	TOptions extends { readonly signal?: AbortSignal } = StandaloneToolPortalInvocationOptions,
>(props: {
	readonly identity: PortalAgentIdentity;
	readonly getView: () => Promise<AgentCatalogView>;
	readonly runtime: UpstreamMcpClientRuntime;
	readonly owningGeneration: string;
}): {
	readonly discovery: ToolPortalDiscoveryBackendPort<TOptions>;
	readonly invoke: (
		call: PortalCallRequest['calls'][number],
		operationId: string,
		options: TOptions,
	) => Promise<StandalonePortalCallItem>;
} {
	const readers = createPortalToolHandlers({
		getView: props.getView,
		dispatchCall: async () => {
			throw new Error('Discovery cannot invoke a capability.');
		},
	});
	return {
		discovery: {
			list: async (request) =>
				PortalBackendListResultSchema.parse(
					discoveryResult(
						await readers.list({ identity: props.identity, input: { requests: request.requests } }),
						true,
					),
				),
			search: async (request) =>
				PortalBackendSearchResultSchema.parse(
					discoveryResult(
						await readers.search({
							identity: props.identity,
							input: { requests: request.requests },
						}),
						true,
					),
				),
			describe: async (request) =>
				PortalBackendDescribeResultSchema.parse(
					discoveryResult(
						await readers.describe({
							identity: props.identity,
							input: {
								requests: request.requests.map((item) => ({
									...item,
									...(item.tools === undefined
										? {}
										: {
												tools: item.tools.map(({ namespace, name }) => ({
													namespace,
													toolName: name,
												})),
											}),
								})),
							},
						}),
						false,
					),
				),
		},
		invoke: async (call, operationId, options) => {
			let attempted = false;
			const caller = createPortalToolHandlers({
				getView: props.getView,
				dispatchCall: async (input) => {
					attempted = true;
					try {
						return {
							kind: 'completed',
							result: jsonValueSchema.parse(
								await props.runtime.callTool({
									agentScopeId: portalAgentScopeKey(props.identity),
									namespace: input.namespace,
									toolName: input.toolName,
									arguments: input.arguments,
									requestId: input.requestId,
									...(options.signal === undefined ? {} : { signal: options.signal }),
								}),
							),
						};
					} catch (error) {
						const known = proxyUpstreamFailureFromError({
							namespace: input.namespace,
							toolName: input.toolName,
							error,
						});
						if (known !== null) return known;
						throw error;
					}
				},
			});
			const batch = await caller.call({
				identity: props.identity,
				input: {
					calls: [
						{
							id: call.id,
							namespace: call.namespace,
							toolName: call.name,
							arguments: call.arguments,
						},
					],
				},
			});
			const item = batch.results[call.id];
			return PortalCallItemResultSchema.parse({
				id: call.id,
				operationId,
				owningGeneration: props.owningGeneration,
				...(item?.ok
					? {
							status: 'ok',
							value: projectPublicValue(item.output),
							outcome: {
								kind: 'completed',
								completion: 'succeeded',
								certainty: 'proven',
								retryClass: 'forbidden',
							},
						}
					: {
							status: 'error',
							error: portalErrorFromUnknown(item?.error),
							outcome: attempted
								? {
										kind: 'ambiguous',
										certainty: 'side-effects-and-termination-unknown',
										retryClass: 'forbidden',
									}
								: {
										kind: 'not-dispatched',
										certainty: 'proven',
										retryClass: 'safe-before-dispatch',
									},
						}),
			});
		},
	};
}
