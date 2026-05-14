import { z } from 'zod';

export interface ToolIdentity {
	readonly namespace: string;
	readonly toolName: string;
}

const toolIdentitySchema = z
	.object({
		namespace: z.string().min(1),
		toolName: z.string().min(1),
	})
	.strict();
const toolRefSchema = z.string().startsWith('mcp:').brand<'ToolRef'>();

export type ToolRef = z.infer<typeof toolRefSchema>;

function decodeToolRefSegment(segment: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
		throw new Error('Invalid MCP toolRef.');
	}

	const decoded = Buffer.from(segment, 'base64url').toString('utf-8');
	const canonicalSegment = Buffer.from(decoded, 'utf-8').toString('base64url');
	if (canonicalSegment !== segment) {
		throw new Error('Invalid MCP toolRef.');
	}

	return decoded;
}

export function encodeToolRef(identity: ToolIdentity): ToolRef {
	const parsed = toolIdentitySchema.parse(identity);
	const encodedNamespace = Buffer.from(parsed.namespace, 'utf-8').toString('base64url');
	const encodedToolName = Buffer.from(parsed.toolName, 'utf-8').toString('base64url');

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
