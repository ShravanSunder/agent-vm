import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNodeHttpUpstreamTransport } from '#node-host/stdio-upstream-servers/node-upstream-transports';

function isTransport(value: unknown): value is Transport {
	return (
		typeof value === 'object' &&
		value !== null &&
		'start' in value &&
		typeof value.start === 'function' &&
		'send' in value &&
		typeof value.send === 'function' &&
		'close' in value &&
		typeof value.close === 'function'
	);
}
function formatSseEvent(message: unknown): string {
	return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}
afterEach(() => vi.unstubAllGlobals());

describe('Node legacy SSE transport and pinned SDK notification ordering', () => {
	it('delivers progress before its coalesced response without an unknown-token error', async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start: (input): void => {
				controller = input;
			},
		});
		const emit = (text: string): void => {
			if (controller === undefined) throw new Error('Missing fixture SSE stream');
			controller.enqueue(encoder.encode(text));
		};
		// In-memory fetch is a parser/transport stand-in. No real-network claim.
		const fetchStandIn: typeof fetch = async (_input, init) => {
			if ((init?.method ?? 'GET') === 'GET') {
				emit('event: endpoint\ndata: /messages\n\n');
				return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
			}
			if (typeof init?.body !== 'string') throw new Error('Missing fixture MCP request body');
			const message = JSONRPCMessageSchema.parse(JSON.parse(init.body));
			if (!('id' in message) || !('method' in message)) return new Response(null, { status: 202 });
			const response = {
				jsonrpc: '2.0',
				id: message.id,
				result:
					message.method === 'initialize'
						? {
								protocolVersion: '2025-06-18',
								capabilities: { tools: {} },
								serverInfo: { name: 'controlled', version: '1' },
							}
						: { content: [{ type: 'text', text: 'known-result' }] },
			};
			const metadata = message.params?.['_meta'];
			const progressToken =
				typeof metadata === 'object' && metadata !== null && 'progressToken' in metadata
					? metadata.progressToken
					: undefined;
			const progress =
				message.method === 'tools/call'
					? formatSseEvent({
							jsonrpc: '2.0',
							method: 'notifications/progress',
							params: { progressToken, progress: 1, total: 1, message: 'coalesced' },
						})
					: '';
			// One stream enqueue must exercise coalesced notification/result delivery.
			emit(progress + formatSseEvent(response));
			return new Response(null, { status: 202 });
		};
		vi.stubGlobal('fetch', fetchStandIn);
		const transport = createNodeHttpUpstreamTransport(
			{ namespace: 'fixture', transport: 'sse', url: 'https://fixture.invalid/sse' },
			'sse',
		);
		if (!isTransport(transport)) throw new Error('Invalid SDK transport');
		const client = new Client({ name: 'node-sse-test', version: '1' });
		const errors: string[] = [];
		const progress: unknown[] = [];
		Object.assign(client, {
			onerror: (error: Error): void => {
				errors.push(error.message);
			},
		});
		try {
			await client.connect(transport);
			expect(
				await client.callTool({ name: 'read', arguments: {} }, undefined, {
					onprogress: (value): void => {
						progress.push(value);
					},
				}),
			).toEqual({ content: [{ type: 'text', text: 'known-result' }] });
			expect(progress).toEqual([{ progress: 1, total: 1, message: 'coalesced' }]);
			expect(errors).toEqual([]);
		} finally {
			await client.close();
			controller?.close();
		}
	});
});
