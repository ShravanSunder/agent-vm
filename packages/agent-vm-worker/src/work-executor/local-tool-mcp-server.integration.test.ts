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

function describeValue(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return '[unserializable]';
	}
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseJsonRpcResult(text: string): Record<string, unknown> {
	const dataLine = text
		.split('\n')
		.find((line) => line.startsWith('data:'))
		?.slice('data:'.length)
		.trim();
	const rawPayload = dataLine ?? text;
	const parsed: unknown = JSON.parse(rawPayload);
	if (!isObjectRecord(parsed) || !isObjectRecord(parsed.result)) {
		throw new Error(`Expected JSON-RPC result object, received ${text}`);
	}
	return parsed.result;
}

function readFirstTextContent(result: Record<string, unknown>): string {
	const content = result.content;
	if (
		!Array.isArray(content) ||
		!isObjectRecord(content[0]) ||
		typeof content[0].text !== 'string'
	) {
		throw new Error('Expected first MCP content item to be text.');
	}
	return content[0].text;
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
				artifact: describeValue(params.value ?? ''),
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
				artifact: describeValue(params.value ?? ''),
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

	it('returns MCP tool errors for unknown and thrown tools over HTTP', async () => {
		const tool: ToolDefinition = {
			name: 'throw-tool',
			description: 'Throws an error',
			inputSchema: {},
			execute: async () => {
				throw new Error('tool exploded');
			},
		};

		const server = await getOrCreateLocalToolMcpServer([tool]);
		expect(server).not.toBeNull();
		serverUrl = server?.url ?? null;
		if (!serverUrl) {
			throw new Error('Expected local MCP server URL.');
		}

		const unknownToolResponse = await postJson(serverUrl, {
			jsonrpc: '2.0',
			id: 'unknown',
			method: 'tools/call',
			params: {
				name: 'missing-tool',
				arguments: {},
			},
		});
		const thrownToolResponse = await postJson(serverUrl, {
			jsonrpc: '2.0',
			id: 'thrown',
			method: 'tools/call',
			params: {
				name: 'throw-tool',
				arguments: {},
			},
		});

		expect(unknownToolResponse.status).toBe(200);
		const unknownToolResult = parseJsonRpcResult(unknownToolResponse.text);
		expect(unknownToolResult.isError).toBe(true);
		expect(readFirstTextContent(unknownToolResult)).toBe('Unknown tool: missing-tool');
		expect(thrownToolResponse.status).toBe(200);
		const thrownToolResult = parseJsonRpcResult(thrownToolResponse.text);
		expect(thrownToolResult.isError).toBe(true);
		expect(readFirstTextContent(thrownToolResult)).toBe('tool exploded');
	});
});
