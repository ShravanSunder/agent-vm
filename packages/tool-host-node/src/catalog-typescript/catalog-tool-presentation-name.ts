import { createHash } from 'node:crypto';

const maximumCatalogToolNameLength = 128;

function readableCatalogToolNameSegment(value: string): string {
	const segment = value.replaceAll(/[^A-Za-z0-9_-]/gu, '_').replaceAll(/_+/gu, '_');
	return segment.length === 0 ? 'tool' : segment;
}

export function createCatalogToolPresentationName(namespace: string, toolName: string): string {
	const suffix = createHash('sha256')
		.update(JSON.stringify([namespace, toolName]))
		.digest('hex')
		.slice(0, 10);
	const readablePrefix = `${readableCatalogToolNameSegment(namespace)}__${readableCatalogToolNameSegment(toolName)}`;
	const maximumPrefixLength = maximumCatalogToolNameLength - suffix.length - 2;
	return `${readablePrefix.slice(0, maximumPrefixLength)}__${suffix}`;
}
