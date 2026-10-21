import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface McpToolListPage {
	readonly tools: Tool[];
	readonly nextCursor?: string;
}
export const maximumToolListPageBytes = 1024 * 1024;
const cursorSchema = z
	.string()
	.regex(/^(?:0|[1-9]\d*)$/u)
	.transform(Number)
	.pipe(z.number().int().nonnegative().safe());

/** Budget the serialized MCP result, including its cursor; tools are indivisible. */
export function paginateMcpTools(tools: readonly Tool[], cursor?: string): McpToolListPage {
	const offset = cursor === undefined ? 0 : cursorSchema.parse(cursor);
	if (offset > tools.length) throw new Error('Invalid tools/list cursor.');
	const encoder = new TextEncoder();
	let page: McpToolListPage = { tools: [] };
	for (let index = offset; index < tools.length; index += 1) {
		const tool = tools[index];
		if (tool === undefined) break;
		const nextOffset = index + 1;
		const candidate: McpToolListPage = {
			tools: [...page.tools, tool],
			...(nextOffset < tools.length ? { nextCursor: String(nextOffset) } : {}),
		};
		if (encoder.encode(JSON.stringify(candidate)).byteLength > maximumToolListPageBytes) {
			if (page.tools.length === 0)
				throw new Error('One MCP tool exceeds the tools/list page budget.');
			return page;
		}
		page = candidate;
	}
	return page;
}
