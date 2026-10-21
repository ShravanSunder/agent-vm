export type ToolLoading =
	| { readonly kind: 'client-deferred' }
	| { readonly kind: 'portal-deferred' };
export type McpToolMode = 'direct' | 'indirect';

/** The address chooses presentation only; it never supplies caller authority. */
export function resolveToolLoading(address: string | URL): ToolLoading {
	return new URL(address, 'http://mcp.invalid').searchParams.get('tools') === 'direct'
		? { kind: 'client-deferred' }
		: { kind: 'portal-deferred' };
}
export function toolLoadingMode(loading: ToolLoading): McpToolMode {
	return loading.kind === 'client-deferred' ? 'direct' : 'indirect';
}
