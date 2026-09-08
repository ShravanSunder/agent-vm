import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createLocalToolPortalTransport } from './local-transport.js';
import { encodeRelayFrame, PortalRelayDecoder, type RelayMessage } from './relay-protocol.js';

it.each([false, true])(
	'correlates reversed replies, with cancellation grace=%s',
	async (abortBeforeReply) => {
		const cancellation = new AbortController();
		const directory = await mkdtemp(join(tmpdir(), 'prb-'));
		const socketPath = join(directory, 'p.sock');
		const peers = new Set<Socket>();
		const server = createServer((socket) => {
			peers.add(socket);
			socket.once('close', () => peers.delete(socket));
			const decoder = new PortalRelayDecoder();
			const requests: Extract<RelayMessage, { kind: 'request' }>[] = [];
			socket.on('data', (chunk: Buffer) => {
				for (const message of decoder.feed(chunk)) {
					if (message.kind === 'hello')
						socket.write(
							encodeRelayFrame({
								kind: 'ready',
								version: 1,
								maxMessageBytes: 1048576,
								maxPendingRequests: 16,
							}),
						);
					if (message.kind !== 'request') continue;
					requests.push(message);
					if (requests.length === 2) {
						if (abortBeforeReply) cancellation.abort();
						for (const request of requests.toReversed())
							socket.write(
								encodeRelayFrame({
									kind: 'result',
									requestId: request.requestId,
									result: { received: request.operation },
								}),
							);
					}
				}
			});
		});
		const transport = createLocalToolPortalTransport({
			environment: { AGENT_VM_TOOL_PORTAL_SOCKET: socketPath },
		});
		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(socketPath, resolve);
			});
			await transport.connect();
			const results = await Promise.all([
				transport.callTool(
					{ name: 'tool_portal_list', arguments: {} },
					{ signal: cancellation.signal, resultGraceAfterAbortMs: 1000 },
				),
				transport.callTool(
					{ name: 'tool_portal_search', arguments: {} },
					{ signal: cancellation.signal, resultGraceAfterAbortMs: 1000 },
				),
			]);
			expect(results).toEqual([
				{ structuredContent: { received: 'list' } },
				{ structuredContent: { received: 'search' } },
			]);
		} finally {
			await transport.close();
			for (const peer of peers) peer.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		}
	},
);
