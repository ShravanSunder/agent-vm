/* oxlint-disable no-await-in-loop -- These controls sequence the same live host/provider state so effects, failure changes and replay races remain attributable. */
import { request as httpRequest } from 'node:http';

import { PortalCallResultSchema } from '@agent-collaboration/tool-access/contracts';
import { createPortalArtifactReadResourceRequest } from '@agent-vm/agent-portal-sdk';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHttpTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport as LegacyTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	startStandaloneToolPortalHttpServer,
	startStandaloneToolPortalMcpHttpServer,
} from '#node-host/standalone-tool-portal/standalone-http-servers';
import {
	startControlledProvider,
	toolInputSchema,
} from '#node-host/test-fixtures/node-host-fixture';
import {
	createStandaloneHostFixture,
	standaloneCredentials,
} from '#node-host/test-fixtures/standalone-host-fixture';

const meta = { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} };
const headers = {
	authorization: 'Bearer credential-agent-a',
	'content-type': 'application/json',
	accept: 'application/json, text/event-stream',
	'MCP-Protocol-Version': '2026-07-28',
	'Mcp-Method': 'tools/call',
	'Mcp-Name': 'tool_portal_call',
};
const replySchema = z.object({
	result: z.record(z.string(), z.unknown()).optional(),
	error: z.object({ code: z.number() }).passthrough().optional(),
});
const rpcCall = (id: string): Record<string, unknown> => ({
	jsonrpc: '2.0',
	id,
	method: 'tools/call',
	params: {
		name: 'tool_portal_call',
		arguments: { calls: [{ id, namespace: 'example', name: 'read', arguments: { value: 42 } }] },
		_meta: meta,
	},
});

it('standalone HTTP rejects legacy, malformed envelopes and mismatched headers before effects, ignores sessions, and has private cache hints', async () => {
	const provider = await startControlledProvider(
		'wire',
		['read', 'binary'].map((name) => ({ name, inputSchema: toolInputSchema })),
	);
	const fixture = await createStandaloneHostFixture(provider);
	let reads = 0;
	const host = await startStandaloneToolPortalMcpHttpServer({
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/portal',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		credentialSet: standaloneCredentials,
		service: fixture.service,
		artifactReader: {
			read: async (input) => {
				reads++;
				return fixture.artifactReader.read(input);
			},
		},
	});
	const post = async (
		body: unknown,
		selected: Record<string, string> = headers,
	): Promise<{
		readonly status: number;
		readonly body: z.infer<typeof replySchema>;
		readonly session: string | null;
	}> => {
		const response = await fetch(host.endpoint, {
			method: 'POST',
			headers: selected,
			body: JSON.stringify(body),
		});
		const wire = await response.text();
		const data =
			wire.startsWith('event:') || wire.startsWith('data:')
				? wire
						.split('\n')
						.find((line) => line.startsWith('data:'))
						?.slice(5)
						.trim()
				: wire;
		const bodyReply = replySchema.parse(JSON.parse(data ?? 'null'));
		process.stdout.write(
			JSON.stringify({
				case: 'standalone-wire',
				status: response.status,
				code: bodyReply.error?.code,
			}) + '\n',
		);
		return {
			status: response.status,
			body: bodyReply,
			session: response.headers.get('mcp-session-id'),
		};
	};
	try {
		const legacy = await post(
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-11-25',
					capabilities: {},
					clientInfo: { name: 'v1.29-wire', version: '1.29.0' },
				},
			},
			{
				authorization: headers.authorization,
				'content-type': headers['content-type'],
				accept: headers.accept,
			},
		);
		expect(legacy).toMatchObject({
			status: 400,
			body: { error: { code: -32022, data: { supported: ['2026-07-28'] } } },
		});
		const invalid = rpcCall('invalid');
		const missing = {
			...invalid,
			params: { name: 'tool_portal_call', arguments: {}, _meta: undefined },
		};
		expect(await post(missing)).toMatchObject({ status: 400, body: { error: { code: -32602 } } });
		for (const field of ['MCP-Protocol-Version', 'Mcp-Method', 'Mcp-Name'])
			for (const value of [undefined, 'wrong']) {
				const changed: Record<string, string> = { ...headers };
				if (value === undefined) delete changed[field];
				else changed[field] = value;
				expect(await post(invalid, changed)).toMatchObject({
					status: 400,
					body: { error: { code: -32020 } },
				});
			}
		for (const method of ['GET', 'DELETE']) {
			const response = await fetch(host.endpoint, { method, headers });
			expect(response.status).toBe(405);
			expect(response.headers.has('mcp-session-id')).toBe(false);
			await response.text();
		}
		expect(provider.effects).toHaveLength(0);
		for (const session of ['arbitrary', 'different']) {
			const result = await post(rpcCall(session), { ...headers, 'Mcp-Session-Id': session });
			expect(result.status).toBe(200);
			expect(result.session).toBeNull();
			expect(result.body.result).toMatchObject({ structuredContent: { ok: true } });
		}
		expect(provider.effects).toHaveLength(2);
		for (const method of ['tools/list', 'server/discover']) {
			const selected: Record<string, string> = { ...headers, 'Mcp-Method': method };
			delete selected['Mcp-Name'];
			const result = await post(
				{ jsonrpc: '2.0', id: method, method, params: { _meta: meta } },
				selected,
			);
			expect(result).toMatchObject({
				status: 200,
				body: { result: { cacheScope: 'private', ttlMs: 60_000 } },
			});
			if (method === 'server/discover') expect(JSON.stringify(result.body)).toContain('2026-07-28');
			if (method === 'tools/list')
				expect(Buffer.byteLength(JSON.stringify(result.body.result))).toBeLessThanOrEqual(
					1024 * 1024,
				);
		}
		const binary = await post({
			jsonrpc: '2.0',
			id: 'binary',
			method: 'tools/call',
			params: {
				name: 'tool_portal_call',
				arguments: {
					calls: [{ id: 'binary', namespace: 'example', name: 'binary', arguments: { value: 42 } }],
				},
				_meta: meta,
			},
		});
		expect(binary.body.result).toMatchObject({ structuredContent: { ok: true } });
		const resource = createPortalArtifactReadResourceRequest({
			reference: fixture.reference,
			offsetBytes: 0,
			maxBytes: 8,
		});
		for (const name of [undefined, 'wrong']) {
			const selected: Record<string, string> = { ...headers, 'Mcp-Method': 'resources/read' };
			if (name === undefined) delete selected['Mcp-Name'];
			else selected['Mcp-Name'] = name;
			expect(
				await post(
					{
						jsonrpc: '2.0',
						id: 'bad-resource',
						method: 'resources/read',
						params: { ...resource, _meta: { ...resource['_meta'], ...meta } },
					},
					selected,
				),
			).toMatchObject({ status: 400, body: { error: { code: -32020 } } });
		}
		expect(reads).toBe(0);
		const result = await post(
			{
				jsonrpc: '2.0',
				id: 'resource',
				method: 'resources/read',
				params: { ...resource, _meta: { ...resource['_meta'], ...meta } },
			},
			{ ...headers, 'Mcp-Method': 'resources/read', 'Mcp-Name': resource.uri },
		);
		expect(result).toMatchObject({
			status: 200,
			body: {
				result: {
					cacheScope: 'private',
					ttlMs: 0,
					contents: [
						{
							uri: resource.uri,
							mimeType: 'application/octet-stream',
							blob: fixture.artifactBytes.toString('base64'),
						},
					],
				},
			},
		});
		expect(reads).toBe(1);
		expect(provider.effects).toHaveLength(3);
	} finally {
		await host.retire();
		await fixture.close();
		await provider.close();
	}
});

function postBytes(
	endpoint: URL,
	body: Buffer,
	chunked: boolean,
): Promise<{ readonly status: number; readonly body: unknown }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			endpoint,
			{
				method: 'POST',
				headers: {
					authorization: 'Bearer credential-agent-a',
					'content-type': 'application/json',
					...(chunked
						? { 'transfer-encoding': 'chunked' }
						: { 'content-length': String(body.length) }),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () =>
					resolve({
						status: response.statusCode ?? 0,
						body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
					}),
				);
				response.on('error', reject);
			},
		);
		request.on('error', reject);
		if (chunked) {
			request.write(body.subarray(0, 1024));
			request.end(body.subarray(1024));
		} else request.end(body);
	});
}

it('JSON keeps exact 64 KiB actual UTF-8 bytes and refuses 65 KiB for content-length and chunked bodies', async () => {
	const provider = await startControlledProvider('json', [
		{
			name: 'read',
			inputSchema: {
				...toolInputSchema,
				properties: { value: { type: 'number' }, padding: { type: 'string' } },
			},
		},
	]);
	const fixture = await createStandaloneHostFixture(provider);
	const host = await startStandaloneToolPortalHttpServer({
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/json',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		credentialSet: standaloneCredentials,
		service: fixture.service,
	});
	const base = JSON.stringify({
		operation: 'call',
		request: {
			calls: [{ id: 'json', namespace: 'example', name: 'read', arguments: { value: 42 } }],
		},
	});
	try {
		for (const chunked of [false, true])
			for (const size of [65536, 66560]) {
				// JSON whitespace makes a valid request at the exact byte threshold; a multibyte string
				// distinguishes a byte limit from a JavaScript character-count limit.
				const prefix = base.replace('"value":42', '"value":42,"padding":"é"');
				// The real provider accepts the multibyte argument; successful threshold requests must have effects.
				const bytes = Buffer.from(prefix + ' '.repeat(size - Buffer.byteLength(prefix)));
				expect(bytes.length).toBe(size);
				expect(bytes.toString('utf8').length).toBe(size - 1);
				const result = await postBytes(host.endpoint, bytes, chunked);
				expect(result.status).toBe(size === 65536 ? 200 : 413);
				if (size > 65536)
					expect(result.body).toEqual({ error: { kind: 'request_too_large' }, ok: false });
				process.stdout.write(
					JSON.stringify({ case: 'JSON bytes', size, chunked, ...result }) + '\n',
				);
			}
		expect(provider.effects).toHaveLength(2);
		expect((await postBytes(host.endpoint, Buffer.from(base), false)).status).toBe(200);
		expect(provider.effects).toHaveLength(3);
	} finally {
		await host.retire();
		await fixture.close();
		await provider.close();
	}
});

it('MCP text is exact through 4096 bytes, bounded at 4097, and retains complete structured content', async () => {
	const provider = await startControlledProvider('text');
	const fixture = await createStandaloneHostFixture(provider);
	const host = await startStandaloneToolPortalMcpHttpServer({
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/portal',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		credentialSet: standaloneCredentials,
		service: fixture.service,
		artifactReader: fixture.artifactReader,
	});
	try {
		// Compute padding from an actual first response because the resource result wraps upstream content.
		provider.setCallResult({
			content: [{ type: 'text', text: '' }],
			structuredContent: { padding: '' },
		});
		const exchange = async (): Promise<z.infer<typeof replySchema>> => {
			const response = await fetch(host.endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify(rpcCall('text')),
			});
			expect(response.status).toBe(200);
			return replySchema.parse(await response.json());
		};
		const initial = await exchange();
		const initialValue = PortalCallResultSchema.parse(initial.result?.['structuredContent']);
		expect(initialValue.items[0]?.status).toBe('ok');
		const baseBytes = Buffer.byteLength(JSON.stringify(initialValue));
		for (const limit of [4096, 4097]) {
			provider.setCallResult({
				content: [{ type: 'text', text: '' }],
				structuredContent: { padding: 'p'.repeat(limit - baseBytes) },
			});
			const result = await exchange();
			const structured = PortalCallResultSchema.parse(result.result?.['structuredContent']);
			// The controlled provider's raw structured result is retained under the legacy resource projection.
			expect(Buffer.byteLength(JSON.stringify(structured))).toBe(limit);
			expect(result.result?.['content']).toEqual([
				{
					type: 'text',
					text:
						limit === 4096
							? JSON.stringify(structured)
							: 'Tool Portal result exceeded the MCP response bound.',
				},
			]);
			expect(JSON.stringify(structured)).toContain('p'.repeat(limit - baseBytes));
		}
		expect(provider.effects).toHaveLength(3);
	} finally {
		await host.retire();
		await fixture.close();
		await provider.close();
	}
});

it('standalone MCP accepts a real request over 4 MiB through parsedBody without a new incoming limit', async () => {
	const provider = await startControlledProvider('large');
	const fixture = await createStandaloneHostFixture(provider);
	const host = await startStandaloneToolPortalMcpHttpServer({
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/portal',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		credentialSet: standaloneCredentials,
		service: fixture.service,
		artifactReader: fixture.artifactReader,
	});
	const post = async (body: unknown): Promise<unknown> => {
		const response = await fetch(host.endpoint, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	};
	try {
		const large = {
			jsonrpc: '2.0',
			id: 'large',
			method: 'tools/call',
			params: {
				name: 'tool_portal_call',
				arguments: {
					calls: [{ id: 'large', namespace: 'example', name: 'read', arguments: { value: 42 } }],
				},
				_meta: { ...meta, proofPadding: 'p'.repeat(4 * 1024 * 1024 + 1) },
			},
		};
		expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(4 * 1024 * 1024);
		expect(await post(large)).toMatchObject({
			status: 200,
			body: { result: { structuredContent: { ok: true } } },
		});
		expect(provider.effects).toHaveLength(1);
	} finally {
		await host.retire();
		await fixture.close();
		await provider.close();
	}
});

it('the actual SDK v1.29.0 initialize receives 400/-32022 with supported versions on the standalone route', async () => {
	const provider = await startControlledProvider('actual-v1');
	const fixture = await createStandaloneHostFixture(provider);
	const host = await startStandaloneToolPortalMcpHttpServer({
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/portal',
		allowedHosts: ['127.0.0.1'],
		allowedOrigins: [],
		credentialSet: standaloneCredentials,
		service: fixture.service,
		artifactReader: fixture.artifactReader,
	});
	const client = new LegacyClient({ name: 'actual-v1.29.0', version: '1.29.0' });
	const observations: { readonly status: number; readonly body: unknown }[] = [];
	const candidate: unknown = new LegacyHttpTransport(host.endpoint, {
		requestInit: { headers: { authorization: headers.authorization } },
		fetch: async (input, init) => {
			const response = await fetch(input, init);
			observations.push({ status: response.status, body: await response.clone().json() });
			return response;
		},
	});
	try {
		if (!isLegacyTransport(candidate)) throw new Error('Missing actual legacy transport');
		await expect(client.connect(candidate)).rejects.toThrow();
		expect(observations[0]).toMatchObject({
			status: 400,
			body: { error: { code: -32022, data: { supported: ['2026-07-28'] } } },
		});
		expect(provider.effects).toHaveLength(0);
		process.stdout.write(JSON.stringify({ case: 'actual SDK v1.29.0', ...observations[0] }) + '\n');
	} finally {
		await client.close();
		await host.retire();
		await fixture.close();
		await provider.close();
	}
});
function isLegacyTransport(value: unknown): value is LegacyTransport {
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
