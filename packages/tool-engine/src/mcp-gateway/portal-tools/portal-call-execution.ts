import type {
	PortalToolSelector,
	PortalAgentIdentity,
} from '@agent-collaboration/tool-access/authorization';
import { jsonObjectSchema } from '@agent-collaboration/tool-access/contracts';

import type { AgentCatalogView } from '#mcp-gateway/agent-catalog-views/models/agent-catalog-view';
import type { PortalDiscoveryFailure } from '#mcp-gateway/agent-catalog-views/models/portal-discovery-failure';
import type { PortalCallAuthorization } from '#mcp-gateway/call-approvals/models/call-approval';
import type {
	CallRequest,
	PreparedPortalCall,
	PortalToolResult,
	PortalToolRuntime,
} from '#mcp-gateway/portal-tools/models/portal-tool-contracts';
import { itemError, itemOutput } from '#mcp-gateway/portal-tools/portal-batch-results';
import { validatePortalToolArguments } from '#mcp-gateway/portal-tools/portal-call-validation';
import {
	findTool,
	discoveryFailureForNamespace,
} from '#mcp-gateway/portal-tools/portal-tool-selection';

function unavailableNamespaceError(props: {
	readonly failure: PortalDiscoveryFailure;
	readonly selector: PortalToolSelector;
}): Readonly<Record<string, unknown>> {
	return {
		kind: 'namespace_unavailable',
		message: `MCP namespace "${props.selector.namespace}" is disabled/unavailable: ${props.failure.message}`,
		namespace: props.selector.namespace,
		toolName: props.selector.toolName,
	};
}

export function preparePortalCall(
	session: AgentCatalogView,
	request: CallRequest,
): PreparedPortalCall | PortalToolResult {
	const tool = findTool(session, request);
	if (!tool) {
		const discoveryFailure = discoveryFailureForNamespace(session, request.namespace);
		if (discoveryFailure !== null) {
			return itemError({
				error: unavailableNamespaceError({
					failure: discoveryFailure,
					selector: request,
				}),
				input: request,
			});
		}
		return itemError({
			error: {
				kind: 'unknown_or_denied_tool',
				message: 'The requested tool is unknown or denied for this portal agent scope.',
				namespace: request.namespace,
				toolName: request.toolName,
			},
			input: request,
		});
	}

	const validation = validatePortalToolArguments(tool, request.arguments);
	if (!validation.ok) {
		return itemError({ error: validation.error, input: request });
	}
	const validatedArgumentsResult = jsonObjectSchema.safeParse(validation.value);
	if (!validatedArgumentsResult.success) {
		return itemError({
			error: {
				kind: 'invalid_portal_input',
				message: validatedArgumentsResult.error.message,
			},
			input: request,
		});
	}

	return { input: request, tool, validatedArguments: validatedArgumentsResult.data };
}

async function executePreparedPortalCall(props: {
	readonly call: PreparedPortalCall;
	readonly identity: PortalAgentIdentity;
	readonly runtime: PortalToolRuntime;
	readonly authorization: PortalCallAuthorization | undefined;
}): Promise<PortalToolResult> {
	const { call, identity, runtime, authorization } = props;
	const input = { ...call.input, arguments: call.validatedArguments };
	if (authorization?.kind === 'token-missing')
		return itemError({
			input,
			error: {
				kind: 'approval_token_missing',
				message: 'An MCP Portal approval token is required before this MCP Portal call can run.',
				namespace: call.tool.namespace,
				toolName: call.tool.toolName,
			},
		});
	if (authorization?.kind === 'refused')
		return itemError({
			input,
			error: {
				kind: 'approval_token_invalid',
				message: `MCP Portal approval token is invalid: ${authorization.reason}.`,
				namespace: call.tool.namespace,
				reason: authorization.reason,
				toolName: call.tool.toolName,
			},
		});
	try {
		const result = await runtime.dispatchCall({
			...(authorization?.kind === 'token-approved' ? { approval: authorization.approval } : {}),
			arguments: call.validatedArguments,
			identity,
			namespace: call.tool.namespace,
			requestId: call.input.id,
			toolName: call.tool.toolName,
		});
		return result.kind === 'completed'
			? itemOutput({
					input,
					output: {
						namespace: call.tool.namespace,
						result: result.result,
						toolName: call.tool.toolName,
					},
				})
			: itemError({
					input,
					error:
						(result.kind === 'failed' || result.kind === 'ambiguous') &&
						result.detail?.kind === 'mcp-upstream-failure'
							? {
									kind: result.detail.code,
									message: result.detail.message,
									namespace: result.detail.namespace,
									toolName: result.detail.toolName,
									upstream: result.detail.upstream,
								}
							: result,
				});
	} catch {
		return itemError({ input, error: { kind: 'ambiguous', reason: 'dispatch-unconfirmed' } });
	}
}

export function isPreparedPortalCall(
	value: PreparedPortalCall | PortalToolResult,
): value is PreparedPortalCall {
	return 'validatedArguments' in value;
}

export async function addExecutableCallResults(props: {
	readonly authorizations: ReadonlyMap<string, PortalCallAuthorization>;
	readonly identity: PortalAgentIdentity;
	readonly preparedCalls: readonly PreparedPortalCall[];
	readonly results: Record<string, PortalToolResult>;
	readonly runtime: PortalToolRuntime;
}): Promise<void> {
	await Promise.all(
		props.preparedCalls.map(async (preparedCall): Promise<void> => {
			props.results[preparedCall.input.id] = await executePreparedPortalCall({
				call: preparedCall,
				identity: props.identity,
				runtime: props.runtime,
				authorization: props.authorizations.get(preparedCall.input.id),
			});
		}),
	);
}
