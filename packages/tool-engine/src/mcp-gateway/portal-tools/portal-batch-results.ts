import type {
	PortalDiscoveryFailure,
	AgentCatalogView,
} from '#mcp-gateway/agent-catalog-views/models/agent-catalog-view';
import type {
	PortalSafeTransportDiagnostic,
	PortalBatchResult,
	PortalToolResult,
	PortalBatchDiagnostic,
	PortalToolResultMap,
	PortalBatchError,
} from '#mcp-gateway/portal-tools/models/portal-tool-contracts';

export function messageFromError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function safeTransportDiagnosticFromUnknown(
	transport: unknown,
): PortalSafeTransportDiagnostic | undefined {
	if (typeof transport !== 'object' || transport === null || Array.isArray(transport)) {
		return undefined;
	}
	if (!('kind' in transport)) {
		return undefined;
	}
	const kind = transport.kind;
	return typeof kind === 'string' ? { kind } : undefined;
}

function safeUpstreamMcpCauseMessage(): string {
	return 'Upstream MCP provider failed.';
}

function safeDiscoveryDiagnosticMessage(failure: PortalDiscoveryFailure): string {
	if (failure.kind !== 'upstream_mcp_failed') {
		return 'MCP provider discovery failed.';
	}
	return `${failure.namespace}: ${failure.phase ?? 'discovery'} failed`;
}

export function invalidPortalInput(error: unknown): PortalBatchResult {
	return {
		diagnostics: [],
		errors: [{ kind: 'invalid_portal_input', message: messageFromError(error) }],
		ok: false,
		results: {},
	};
}

export function itemError(props: {
	readonly error: unknown;
	readonly input: Readonly<Record<string, unknown>>;
}): PortalToolResult {
	return {
		error: props.error,
		input: props.input,
		ok: false,
	};
}

export function itemOutput(props: {
	readonly input: Readonly<Record<string, unknown>>;
	readonly output: Readonly<Record<string, unknown>>;
}): PortalToolResult {
	return {
		input: props.input,
		ok: true,
		output: props.output,
	};
}

export function discoveryDiagnostics(session: AgentCatalogView): readonly PortalBatchDiagnostic[] {
	return session.catalog.discoveryFailures.map((failure) => {
		const safeTransport = safeTransportDiagnosticFromUnknown(failure.transport);
		const isUpstreamMcpFailure = failure.kind === 'upstream_mcp_failed';
		return {
			...(failure.causeMessage === undefined || !isUpstreamMcpFailure
				? {}
				: { causeMessage: safeUpstreamMcpCauseMessage() }),
			...(failure.elapsedMs === undefined ? {} : { elapsedMs: failure.elapsedMs }),
			...(failure.hint === undefined ? {} : { hint: failure.hint }),
			kind: isUpstreamMcpFailure ? 'upstream_mcp_failed' : 'upstream_discovery_failed',
			message: safeDiscoveryDiagnosticMessage(failure),
			namespace: failure.namespace,
			...(failure.operation === undefined ? {} : { operation: failure.operation }),
			...(failure.phase === undefined ? {} : { phase: failure.phase }),
			...(failure.timeoutMs === undefined ? {} : { timeoutMs: failure.timeoutMs }),
			...(failure.toolName === undefined ? {} : { toolName: failure.toolName }),
			...(safeTransport === undefined ? {} : { transport: safeTransport }),
		};
	});
}

export function portalBatchResult(
	results: PortalToolResultMap,
	diagnostics: readonly PortalBatchDiagnostic[] = [],
): PortalBatchResult {
	const allItemsOk = Object.values(results).every((result) => result.ok);
	return { diagnostics, errors: [], ok: allItemsOk, results };
}

function duplicateIdErrors(items: readonly { readonly id: string }[]): readonly PortalBatchError[] {
	const seenIds = new Set<string>();
	const duplicateIds = new Set<string>();
	for (const item of items) {
		if (seenIds.has(item.id)) {
			duplicateIds.add(item.id);
		}
		seenIds.add(item.id);
	}

	return [...duplicateIds].toSorted().map((id) => ({
		id,
		kind: 'duplicate_id',
		message: `Duplicate portal request id "${id}". Each request id must be unique.`,
	}));
}

export function duplicateIdResult(
	items: readonly { readonly id: string }[],
): PortalBatchResult | null {
	const errors = duplicateIdErrors(items);
	return errors.length > 0 ? { diagnostics: [], errors, ok: false, results: {} } : null;
}
