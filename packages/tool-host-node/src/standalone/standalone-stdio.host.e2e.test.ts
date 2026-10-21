/* oxlint-disable no-await-in-loop -- These controls sequence the same live host/provider state so effects, failure changes and replay races remain attributable. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-collaboration/tool-access/contracts';
import { ToolPortalMcpClient } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client';
import { createNodeToolPortalMcpTransport } from '@agent-vm/agent-portal-sdk/tool-portal-mcp-client/node-transport';
import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { startControlledProvider } from '#node-host/test-fixtures/node-host-fixture';
import { createNodeToolPortalMcpTransport as createOldTransport } from '#node-host/test-fixtures/old-node-tool-portal-mcp-transport';

const fixturePath = path.resolve('tests/harness/agent-portal/standalone-node-stdio-process.ts');
async function controlEvents(): Promise<{
	readonly url: string;
	readonly wait: (event: string) => Promise<void>;
	readonly seen: string[];
	readonly close: () => Promise<void>;
}> {
	const seen: string[] = [];
	const waiters = new Map<string, () => void>();
	const server = createServer((request, response) => {
		const name = (request.url ?? '').slice(1);
		seen.push(name);
		waiters.get(name)?.();
		response.writeHead(200);
		response.end();
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('Missing control address');
	return {
		url: `http://127.0.0.1:${address.port}/`,
		seen,
		wait: async (event) => {
			if (seen.includes(event)) return;
			await new Promise<void>((resolve) => waiters.set(event, resolve));
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error === undefined ? resolve() : reject(error))),
			);
		},
	};
}

it('keeps scoped stdio alive after legacy/malformed openings and executes a real call', async () => {
	const provider = await startControlledProvider('raw-stdio');
	const control = await controlEvents();
	const child = spawn(
		process.execPath,
		['--import', 'tsx', fixturePath, 'modern', provider.url, control.url],
		{ stdio: ['pipe', 'pipe', 'pipe'] },
	);
	const errors: string[] = [];
	child.stderr.on('data', (chunk: Buffer) => errors.push(String(chunk)));
	const exited = once(child, 'exit');
	const lines = createInterface({ input: child.stdout });
	const exchange = async (body: unknown): Promise<z.infer<typeof rpcReply>> => {
		const received = once(lines, 'line');
		child.stdin.write(JSON.stringify(body) + '\n');
		const [line] = await received;
		return rpcReply.parse(JSON.parse(String(line)));
	};
	try {
		await Promise.race([
			control.wait('ready'),
			exited.then(() => {
				throw new Error(errors.join(''));
			}),
		]);
		expect(provider.listings).toEqual(['raw-stdio']);
		const legacy = await exchange({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'old', version: '1.29.0' },
			},
		});
		expect(legacy.error).toMatchObject({ code: -32022, data: { supported: ['2026-07-28'] } });
		expect(
			(
				await exchange({
					jsonrpc: '2.0',
					id: 2,
					method: 'tools/list',
					params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' } },
				})
			).error?.code,
		).toBe(-32602);
		const meta = { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} };
		expect(
			(await exchange({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: meta } }))
				.result,
		).toMatchObject({
			cacheScope: 'private',
			ttlMs: 60000,
			tools: expect.arrayContaining([expect.objectContaining({ name: 'tool_portal_call' })]),
		});
		expect(provider.effects).toHaveLength(0);
		expect(
			(
				await exchange({
					jsonrpc: '2.0',
					id: 4,
					method: 'tools/call',
					params: {
						_meta: meta,
						name: 'tool_portal_call',
						arguments: {
							calls: [{ id: 'raw', namespace: 'example', name: 'read', arguments: { value: 42 } }],
						},
					},
				})
			).result,
		).toMatchObject({ structuredContent: { ok: true } });
		expect(provider.effects).toHaveLength(1);
		expect(child.exitCode).toBeNull();
	} finally {
		child.stdin.end();
		await exited;
		lines.close();
		await control.close();
		await provider.close();
	}
});
const rpcReply = z.object({
	result: z.record(z.string(), z.unknown()).optional(),
	error: z.object({ code: z.number() }).passthrough().optional(),
});

it('actual old/new SDK stdio adapters retain an authoritative result already produced before caller cancellation', async () => {
	const observations: unknown[] = [];
	for (const mode of ['old', 'modern'] as const) {
		const provider = await startControlledProvider('grace');
		provider.setCallResult({
			content: [{ type: 'text', text: 'canonical' }],
			structuredContent: { value: 42 },
		});
		const control = await controlEvents();
		const createTransport = mode === 'old' ? createOldTransport : createNodeToolPortalMcpTransport;
		const client = new ToolPortalMcpClient({
			transport: createTransport({
				kind: 'scoped-stdio',
				executable: process.execPath,
				argv: ['--import', 'tsx', fixturePath, mode, provider.url, control.url],
			}),
		});
		try {
			await client.connect();
			await control.wait('ready');
			expect(
				(await client.list(PortalListRequestSchema.parse({ requests: [{ id: 'list' }] }))).ok,
			).toBe(true);
			expect(
				(
					await client.search(
						PortalSearchRequestSchema.parse({ requests: [{ id: 'search', query: 'read' }] }),
					)
				).ok,
			).toBe(true);
			expect(
				(
					await client.describe(
						PortalDescribeRequestSchema.parse({
							requests: [
								{
									id: 'describe',
									tools: [{ namespace: 'example', name: 'read' }],
									includeTypescriptHelper: true,
								},
							],
						}),
					)
				).ok,
			).toBe(true);
			const abort = new AbortController();
			const pending = client.call(
				{ calls: [{ id: 'grace', namespace: 'example', name: 'read', arguments: { value: 42 } }] },
				{ signal: abort.signal, resultGraceAfterAbortMs: 5000 },
			);
			const settled = pending.then(
				(value) => ({ kind: 'result' as const, value }),
				(error) => ({ kind: 'error' as const, error: unknownError(error) }),
			);
			await control.wait('held');
			expect(provider.effects).toHaveLength(1);
			abort.abort(new Error('caller interrupted after response production'));
			const result = await settled;
			expect(result.kind).toBe('result');
			await control.wait('cancelled');
			expect(control.seen).toEqual(['ready', 'held', 'cancelled']);
			expect(provider.effects).toHaveLength(1);
			if (result.kind === 'result') observations.push(result.value);
		} finally {
			await client.close();
			await control.close();
			await provider.close();
		}
	}
	expect(observations).toHaveLength(2);
	expect(observations[1]).toEqual(observations[0]);
});
function unknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
