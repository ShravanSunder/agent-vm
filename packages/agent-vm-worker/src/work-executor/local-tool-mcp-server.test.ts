import { afterEach, describe, expect, it } from 'vitest';

import type { ToolDefinition } from './executor-interface.js';
import { getOrCreateLocalToolMcpServer } from './local-tool-mcp-server.js';

async function postJson(
	url: string,
	body: Record<string, unknown>,
): Promise<{ readonly status: number; readonly text: string }> {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify(body),
	});
	return {
		status: response.status,
		text: await response.text(),
	};
}

describe('local-tool-mcp-server', () => {
	let serverUrl: string | null = null;

	afterEach(async () => {
		if (serverUrl) {
			// cache cleanup is process-global; keep the server alive for the process lifetime
			serverUrl = null;
		}
	});

	it('returns a stable cached server for the same tool signature', async () => {
		const tool: ToolDefinition = {
			name: 'echo-tool',
			description: 'Echo text',
			inputSchema: { properties: { value: { type: 'string' } }, required: ['value'] },
			execute: async (params) => ({
				type: 'echo',
				success: true,
				artifact: String(params.value ?? ''),
			}),
		};

		const first = await getOrCreateLocalToolMcpServer([tool]);
		const second = await getOrCreateLocalToolMcpServer([tool]);

		expect(first?.url).toBe(second?.url);
		serverUrl = first?.url ?? null;
	});

	it('lists tools and dispatches tool calls over MCP HTTP', async () => {
		const tool: ToolDefinition = {
			name: 'echo-tool',
			description: 'Echo text',
			inputSchema: { properties: { value: { type: 'string' } }, required: ['value'] },
			execute: async (params) => ({
				type: 'echo',
				success: true,
				artifact: String(params.value ?? ''),
			}),
		};

		const server = await getOrCreateLocalToolMcpServer([tool]);
		expect(server).not.toBeNull();
		serverUrl = server?.url ?? null;
		if (!serverUrl) {
			throw new Error('Expected local MCP server URL.');
		}

		const listResponse = await postJson(serverUrl, {
			jsonrpc: '2.0',
			id: '1',
			method: 'tools/list',
			params: {},
		});
		expect(listResponse.status).toBe(200);
		expect(listResponse.text).toContain('echo-tool');

		const callResponse = await postJson(serverUrl, {
			jsonrpc: '2.0',
			id: '2',
			method: 'tools/call',
			params: {
				name: 'echo-tool',
				arguments: { value: 'hello' },
			},
		});
		expect(callResponse.status).toBe(200);
		expect(callResponse.text).toContain('hello');
	});
});
