export interface PortalPromptNamespaceSummary {
	readonly namespace: string;
	readonly toolCount: number;
}

export interface PortalPromptDiagnostic {
	readonly hint?: string;
	readonly message: string;
	readonly namespace: string;
	readonly phase?: string;
}

function formatDiagnostic(entry: PortalPromptDiagnostic): string {
	const phase = entry.phase === undefined ? '' : ` ${entry.phase}`;
	const hint = entry.hint === undefined ? '' : ` Hint: ${entry.hint}`;
	return `${entry.namespace}${phase}: ${entry.message}.${hint}`;
}

export function createPortalPromptContext(props: {
	readonly diagnostics?: readonly PortalPromptDiagnostic[];
	readonly namespaces: readonly PortalPromptNamespaceSummary[];
}): string {
	const namespaceList =
		props.namespaces.length > 0
			? props.namespaces.map((entry) => `${entry.namespace}(${entry.toolCount} tools)`).join(', ')
			: 'none configured';
	const diagnostics =
		props.diagnostics !== undefined && props.diagnostics.length > 0
			? [`Discovery diagnostics: ${props.diagnostics.map(formatDiagnostic).join('; ')}`]
			: [];

	return [
		'MCP Portal is available as native OpenClaw tools.',
		'Use mcp_portal_list with requests[], mcp_portal_search with requests[],',
		'mcp_portal_describe with requests[], and mcp_portal_call with calls[].',
		'Responses are { ok, results, errors, diagnostics }; results is keyed by each request/call id and each value is discriminated by ok: true or ok: false.',
		'Call upstream tools by namespace + toolName inside calls[].',
		'Call mcp_portal_describe before mcp_portal_call unless you already saw the full schema for that tool in this portal session.',
		'Gateway owns MCP auth.',
		`Namespaces: ${namespaceList}`,
		...diagnostics,
	].join('\n');
}
