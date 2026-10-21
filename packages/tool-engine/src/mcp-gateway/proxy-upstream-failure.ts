import {
	upstreamMcpFailureDetailsFromUnknown,
	type UpstreamMcpFailureDetails,
} from '#connectors/upstream-mcp-errors';
import type { ResourceResult } from '#dispatch/dispatch-contracts';
import {
	resourceFailureDetailSchema,
	type ResourceFailureDetail,
} from '#dispatch/resource-failure-detail';

/** Accept already-redacted facts only from the connector's nominal error extractor. */
export type ProxyUpstreamFailureFacts = Omit<
	UpstreamMcpFailureDetails,
	'transport' | 'attemptTransport'
> & {
	readonly attemptTransport?: 'sse' | 'streamable-http' | 'stdio';
	readonly transport: { readonly kind: 'sse' | 'streamable-http' | 'stdio' };
};

export function proxyUpstreamFailureResult(props: {
	readonly namespace: string;
	readonly toolName: string;
	readonly failure: ProxyUpstreamFailureFacts;
}): ResourceResult {
	const upstream = props.failure;
	const toolSuffix = upstream.toolName === undefined ? '' : ` ${upstream.toolName}`;
	const detail: ResourceFailureDetail = resourceFailureDetailSchema.parse({
		kind: 'mcp-upstream-failure',
		code: 'upstream_call_failed',
		message: `${upstream.namespace}: ${upstream.phase}${toolSuffix} failed`,
		namespace: props.namespace,
		toolName: props.toolName,
		upstream: {
			...(upstream.attemptTransport === undefined
				? {}
				: { attemptTransport: upstream.attemptTransport }),
			causeMessage: 'Upstream MCP provider failed.',
			elapsedMs: upstream.elapsedMs,
			...(upstream.failureClass === undefined ? {} : { failureClass: upstream.failureClass }),
			...(upstream.hint === undefined ? {} : { hint: upstream.hint }),
			...(upstream.httpStatusCode === undefined ? {} : { httpStatusCode: upstream.httpStatusCode }),
			kind: upstream.kind,
			namespace: upstream.namespace,
			operation: upstream.operation,
			phase: upstream.phase,
			...(upstream.providerErrorMessage === undefined
				? {}
				: { providerErrorMessage: upstream.providerErrorMessage }),
			...(upstream.timeoutMs === undefined ? {} : { timeoutMs: upstream.timeoutMs }),
			...(upstream.toolName === undefined ? {} : { toolName: upstream.toolName }),
			transport: { kind: upstream.transport.kind },
		},
	});
	// A response explicitly reports tool failure; connect failed before a tool request was sent.
	// Once call_tool has been sent, a lost response cannot establish whether effects happened.
	return {
		kind:
			upstream.phase === 'connect' || upstream.failureClass === 'tool_error'
				? 'failed'
				: 'ambiguous',
		reason: 'upstream-call-failed',
		detail,
	};
}

export function proxyUpstreamFailureFromError(props: {
	readonly namespace: string;
	readonly toolName: string;
	readonly error: unknown;
}): ResourceResult | null {
	const failure = upstreamMcpFailureDetailsFromUnknown(props.error);
	return failure === null ? null : proxyUpstreamFailureResult({ ...props, failure });
}
