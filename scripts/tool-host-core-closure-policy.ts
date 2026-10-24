/** The SDK selects this one runtime shim through its own conditional export. */
export function isAllowedSdkNodeShimImport(props: {
	readonly condition: string;
	readonly importer: string;
	readonly sdkNodeShim: string;
	readonly specifier: string;
}): boolean {
	return (
		props.condition === 'node' &&
		props.importer === props.sdkNodeShim &&
		props.sdkNodeShim.endsWith('/node_modules/@modelcontextprotocol/server/dist/shimsNode.mjs') &&
		props.specifier === 'node:process'
	);
}
