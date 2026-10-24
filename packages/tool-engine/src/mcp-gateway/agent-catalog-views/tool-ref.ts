import {
	type ToolIdentity,
	type ToolRef,
	toolIdentitySchema,
	toolRefSchema,
} from '#mcp-gateway/agent-catalog-views/models/tool-identity';

function decodeToolRefSegment(segment: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
		throw new Error('Invalid MCP toolRef.');
	}

	// Preserve a leading BOM as identity data, matching Buffer's UTF-8 decoding.
	const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
		Uint8Array.from(atob(segment.replaceAll('-', '+').replaceAll('_', '/')), (character) =>
			character.charCodeAt(0),
		),
	);
	const canonicalSegment = encodeSegment(decoded);
	if (canonicalSegment !== segment) {
		throw new Error('Invalid MCP toolRef.');
	}

	return decoded;
}

export function encodeToolRef(identity: ToolIdentity): ToolRef {
	const parsed = toolIdentitySchema.parse(identity);
	const encodedNamespace = encodeSegment(parsed.namespace);
	const encodedToolName = encodeSegment(parsed.toolName);

	return toolRefSchema.parse(`mcp:${encodedNamespace}:${encodedToolName}`);
}

export function decodeToolRef(toolRef: string | ToolRef): ToolIdentity {
	const [scheme, encodedNamespace, encodedToolName, ...extraParts] = toolRef.split(':');
	if (scheme !== 'mcp' || !encodedNamespace || !encodedToolName || extraParts.length > 0) {
		throw new Error('Invalid MCP toolRef.');
	}

	try {
		return toolIdentitySchema.parse({
			namespace: decodeToolRefSegment(encodedNamespace),
			toolName: decodeToolRefSegment(encodedToolName),
		});
	} catch {
		throw new Error('Invalid MCP toolRef.');
	}
}

function encodeSegment(value: string): string {
	return btoa(
		Array.from(new TextEncoder().encode(value), (byte) => String.fromCharCode(byte)).join(''),
	)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
}
