const maximumCatalogToolNameLength = 128;

function readableCatalogToolNameSegment(value: string): string {
	const segment = value.replaceAll(/[^A-Za-z0-9_-]/gu, '_').replaceAll(/_+/gu, '_');
	return segment.length === 0 ? 'tool' : segment;
}

export async function createCatalogToolPresentationName(
	namespace: string,
	toolName: string,
): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify([namespace, toolName])),
	);
	const suffix = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.slice(0, 10);
	const readablePrefix = `${readableCatalogToolNameSegment(namespace)}__${readableCatalogToolNameSegment(toolName)}`;
	const maximumPrefixLength = maximumCatalogToolNameLength - suffix.length - 2;
	return `${readablePrefix.slice(0, maximumPrefixLength)}__${suffix}`;
}
