import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { Server, createMcpHandler } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

async function cancellationFixture(): Promise<{
	readonly client: Client;
	readonly started: Promise<AbortSignal>;
	readonly aborted: Promise<void>;
	readonly release: () => void;
	readonly callId: () => number | string;
	readonly effects: () => number;
	readonly close: () => Promise<void>;
}> {
	const started = Promise.withResolvers<AbortSignal>();
	const aborted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let callId: number | string = -1;
	let effects = 0;
	const handler = createMcpHandler(
		() => {
			const server = new Server(
				{ name: 'modern-cancellation-control', version: '1' },
				{ capabilities: { tools: {} } },
			);
			server.setRequestHandler('tools/call', async (_request, context) => {
				effects += 1;
				context.mcpReq.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
				started.resolve(context.mcpReq.signal);
				await release.promise;
				return {
					content: [{ type: 'text', text: 'canonical' }],
					structuredContent: { canonical: true },
				};
			});
			return server;
		},
		{ legacy: 'reject' },
	);
	const http = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request)
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
			if (
				typeof body === 'object' &&
				body !== null &&
				'method' in body &&
				body.method === 'tools/call' &&
				'id' in body &&
				(typeof body.id === 'string' || typeof body.id === 'number')
			)
				callId = body.id;
			await toNodeHandler(handler)(
				{
					method: request.method ?? 'POST',
					url: request.url ?? '/',
					headers: request.headers,
					[Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
				},
				response,
				body,
			);
		})().catch(() => response.destroy());
	});
	await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
	const address = http.address() as AddressInfo;
	const client = new Client(
		{ name: 'modern-cancellation-control', version: '1' },
		{ versionNegotiation: { mode: { pin: '2026-07-28' } } },
	);
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)),
	);
	return {
		client,
		started: started.promise,
		aborted: aborted.promise,
		release: () => release.resolve(),
		callId: () => callId,
		effects: () => effects,
		close: async () => {
			release.resolve();
			await client.close();
			await handler.close();
			http.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				http.close((error) => (error === undefined ? resolve() : reject(error))),
			);
		},
	};
}

describe('modern HTTP cancellation control', () => {
	it('cancels by closing the response stream and loses a later canonical response', async () => {
		const fixture = await cancellationFixture();
		try {
			const cancellation = new AbortController();
			const result = fixture.client.callTool(
				{ name: 'effect', arguments: {} },
				{ signal: cancellation.signal },
			);
			const settled = result.then(
				(value) => ({ kind: 'resolved' as const, value }),
				(error: unknown) => ({ kind: 'rejected' as const, error }),
			);
			const serverSignal = await fixture.started;
			cancellation.abort(new Error('control-cancel'));
			const outcome = await settled;
			expect(outcome.kind).toBe('rejected');
			if (outcome.kind !== 'rejected') throw new Error('Expected SDK cancellation rejection.');
			expect(String(outcome.error)).toContain('control-cancel');
			await fixture.aborted;
			fixture.release();
			expect(serverSignal.aborted).toBe(true);
			expect(fixture.effects()).toBe(1);
		} finally {
			await fixture.close();
		}
	});

	it('cannot cancel another HTTP exchange with a separately posted modern notification', async () => {
		const fixture = await cancellationFixture();
		try {
			const result = fixture.client.callTool({ name: 'effect', arguments: {} });
			const serverSignal = await fixture.started;
			await fixture.client.notification({
				method: 'notifications/cancelled',
				params: { requestId: fixture.callId(), reason: 'control-cancel' },
			});
			expect(serverSignal.aborted).toBe(false);
			fixture.release();
			expect(await result).toMatchObject({ structuredContent: { canonical: true } });
			expect(fixture.effects()).toBe(1);
		} finally {
			await fixture.close();
		}
	});
});
