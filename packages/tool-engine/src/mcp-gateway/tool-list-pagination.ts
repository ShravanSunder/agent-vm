import type { Tool } from '@modelcontextprotocol/server';
import { z } from 'zod';

export interface McpToolListPage {
	readonly tools: Tool[];
	readonly cacheScope: 'private';
	readonly ttlMs: 60000;
	readonly nextCursor?: string;
}
export const maximumToolListPageBytes = 1024 * 1024;
const cursorSchema = z
	.string()
	.regex(/^(?:0|[1-9]\d*)$/u)
	.transform(Number)
	.pipe(z.number().int().nonnegative().safe());
const emptyPageBytes = '{"tools":[],"cacheScope":"private","ttlMs":60000}'.length;
const cursorFieldBytes = ',"nextCursor":""'.length;

/** Internal arithmetic for decimal cursors and already UTF-8-measured tool JSON. */
export function serializedToolListPageBytes(props: {
	readonly serializedToolsBytes: number;
	readonly toolCount: number;
	readonly nextCursor: string | undefined;
}): number {
	return (
		emptyPageBytes +
		props.serializedToolsBytes +
		Math.max(0, props.toolCount - 1) +
		(props.nextCursor === undefined ? 0 : cursorFieldBytes + props.nextCursor.length)
	);
}

/** Budget the serialized MCP result, including its cursor; tools are indivisible. */
export function paginateMcpTools(tools: readonly Tool[], cursor?: string): McpToolListPage {
	const offset = cursor === undefined ? 0 : cursorSchema.parse(cursor);
	if (offset > tools.length) throw new Error('Invalid tools/list cursor.');
	const encoder = new TextEncoder();
	const selectedTools: Tool[] = [];
	let serializedToolsBytes = 0;
	for (let index = offset; index < tools.length; index += 1) {
		const tool = tools[index];
		if (tool === undefined) break;
		const nextOffset = index + 1;
		const toolBytes = encoder.encode(JSON.stringify(tool)).byteLength;
		const candidateBytes = serializedToolListPageBytes({
			serializedToolsBytes: serializedToolsBytes + toolBytes,
			toolCount: selectedTools.length + 1,
			nextCursor: nextOffset < tools.length ? String(nextOffset) : undefined,
		});
		if (candidateBytes > maximumToolListPageBytes) {
			if (selectedTools.length === 0)
				throw new Error('One MCP tool exceeds the tools/list page budget.');
			break;
		}
		selectedTools.push(tool);
		serializedToolsBytes += toolBytes;
	}
	const nextOffset = offset + selectedTools.length;
	return {
		tools: selectedTools,
		cacheScope: 'private',
		ttlMs: 60000,
		...(nextOffset < tools.length ? { nextCursor: String(nextOffset) } : {}),
	};
}
