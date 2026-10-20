import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';

import type { ApprovalPort } from '@agent-collaboration/tool-engine/dispatch';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { startNodeHost } from '#node-host/node-host-startup';
import {
	connectClient,
	decodedResult,
	fixtureContextRef,
	fixtureConfig,
	fixtureDirectory,
	headerCanary,
	secretCanary,
	startControlledProvider,
	successfulOutput,
	toolInputSchema,
	writeFixtureConfig,
} from '#node-host/test-fixtures/node-host-fixture';

const secrets = {
	resolve: async (secret: { readonly source: string; readonly name?: string }): Promise<string> =>
		secret.name === 'PROVIDER_SECRET' ? secretCanary : headerCanary,
};
const pendingApprovals: ApprovalPort = {
	challenge: async (invocation) => ({
		kind: 'pending',
		challenge: {
			authority: invocation.authority,
			approvalId: 'pending-fixture-1',
			operationKey: invocation.operationKey,
			intentDigest: invocation.intentDigest,
			callerDisplay: 'test caller',
			targetDisplay: 'controlled provider',
			revisions: invocation.admissionRevisions,
			expiresAt: '2099-01-01T00:00:00.000Z',
			permittedDecisions: ['approve', 'deny'],
		},
	}),
	receipt: async () => ({ kind: 'unavailable' }),
	decision: async () => ({ kind: 'unavailable' }),
};

function endpointOf(host: Awaited<ReturnType<typeof startNodeHost>>): URL {
	if (host.http === undefined) throw new Error('Expected HTTP host');
	return host.http.endpoint;
}
function readCall(
	id: string,
	namespace = 'alpha',
	toolName = 'read',
	value: unknown = 42,
): Record<string, unknown> {
	return { calls: [{ id, namespace, toolName, arguments: { value } }] };
}
function toolIdentities(value: unknown): string[] {
	return z
		.array(z.object({ namespace: z.string(), toolName: z.string() }))
		.parse(value)
		.map((tool) => `${tool.namespace}.${tool.toolName}`)
		.toSorted();
}

describe('real Node host ingress, gateway, dispatcher, connectors and public store', () => {
	for (const exposure of ['compact', 'catalog'] as const) {
		it(`${exposure}: two caller catalogs, literal effects, stable caller items, zero-effect refusals`, async () => {
			const directory = await fixtureDirectory();
			const alpha = await startControlledProvider('alpha');
			const beta = await startControlledProvider('beta');
			const config = fixtureConfig(directory, [alpha.url, beta.url], exposure);
			const configPath = await writeFixtureConfig(config, directory);
			const diagnostics: string[] = [];
			const host = await startNodeHost({
				configPath,
				secrets,
				approvals: pendingApprovals,
				onDiagnostic: (event) => diagnostics.push(event),
			});
			const endpoint = endpointOf(host);
			const a = await connectClient(endpoint, 'credential-a', 'brand-claims-admin');
			const b = await connectClient(endpoint, 'credential-b');
			try {
				if (exposure === 'catalog') {
					expect((await a.client.listTools()).tools.map((tool) => tool.name)).toEqual([
						'alpha__ask__645775a667',
						'alpha__fail__f7bc995a6f',
						'alpha__read__151160dc30',
					]);
					expect((await b.client.listTools()).tools.map((tool) => tool.name)).toEqual([
						'beta__ask__7e2e2be604',
						'beta__fail__25055e8f23',
						'beta__read__08da93d672',
					]);
					expect(
						(await a.client.listTools()).tools.find(
							(tool) => tool.name === 'alpha__read__151160dc30',
						)?.inputSchema,
					).toEqual(toolInputSchema);
				} else {
					expect((await a.client.listTools()).tools.map((tool) => tool.name)).toEqual([
						'mcp_portal_list',
						'mcp_portal_search',
						'mcp_portal_describe',
						'mcp_portal_call',
					]);
					await Promise.all(
						(
							[
								[a.client, 'alpha'],
								[b.client, 'beta'],
							] as const
						).map(async ([client, namespace]) => {
							const listed = successfulOutput(
								await client.callTool({
									name: 'mcp_portal_list',
									arguments: { requests: [{ id: 'list' }] },
								}),
								'list',
							);
							expect(toolIdentities(listed.tools)).toEqual([
								`${namespace}.ask`,
								`${namespace}.fail`,
								`${namespace}.read`,
							]);
							const searched = successfulOutput(
								await client.callTool({
									name: 'mcp_portal_search',
									arguments: { requests: [{ id: 'search', query: 'read', schemaDetail: 'full' }] },
								}),
								'search',
							);
							expect(toolIdentities(searched.tools)).toEqual([`${namespace}.read`]);
							const described = successfulOutput(
								await client.callTool({
									name: 'mcp_portal_describe',
									arguments: {
										requests: [
											{
												id: 'describe',
												refs: [namespace === 'alpha' ? 'mcp:YWxwaGE:cmVhZA' : 'mcp:YmV0YQ:cmVhZA'],
											},
										],
									},
								}),
								'describe',
							);
							expect(toolIdentities(described.tools)).toEqual([`${namespace}.read`]);
						}),
					);
				}
				async function callA(item: string, tool = 'read', value: unknown = 42): Promise<unknown> {
					return a.client.callTool(
						exposure === 'compact'
							? { name: 'mcp_portal_call', arguments: readCall(item, 'alpha', tool, value) }
							: {
									name:
										{
											read: 'alpha__read__151160dc30',
											ask: 'alpha__ask__645775a667',
											hidden: 'alpha__hidden__ba2f2074fe',
											blocked: 'alpha__blocked__72eb8870ea',
											fail: 'alpha__fail__f7bc995a6f',
										}[tool] ?? 'unknown',
									arguments: { value },
									_meta: { 'tool-portal/operation-item': item },
								},
					);
				}
				const first = await callA('item-one');
				expect(successfulOutput(first, 'item-one')).toEqual({
					namespace: 'alpha',
					toolName: 'read',
					result: {
						content: [{ type: 'text', text: 'alpha:42' }],
						structuredContent: {
							provider: 'alpha',
							value: 42,
							nested: { credential: '[REDACTED]', header: '[REDACTED]' },
						},
					},
				});
				expect(await callA('item-one')).toEqual(first);
				await callA('item-two');
				expect(alpha.effects).toEqual(
					[42, 42].map((value) => ({
						name: 'read',
						arguments: { value },
						authorization: `Bearer ${secretCanary}`,
						selectedHeader: headerCanary,
					})),
				);
				const changed = decodedResult(await callA('item-one', 'read', 43));
				expect(changed.ok).toBe(false);
				const pending = decodedResult(await callA('ask-one', 'ask'));
				expect(pending).toMatchObject({
					ok: false,
					results: {
						'ask-one': { ok: false, error: { kind: 'pending', reference: 'pending-fixture-1' } },
					},
				});
				await callA('hidden-one', 'hidden');
				await callA('blocked-one', 'blocked');
				await callA('bad-arguments', 'read', 'not-an-integer');
				expect(alpha.effects).toHaveLength(2);
				const before = alpha.effects.length;
				if (exposure === 'catalog') {
					expect(
						await a.client.callTool({ name: 'alpha__read__151160dc30', arguments: { value: 42 } }),
					).toMatchObject({ isError: true });
					expect(
						await a.client.callTool({
							name: 'alpha__read__151160dc30',
							arguments: { value: 42 },
							_meta: { 'tool-portal/operation-item': 7 },
						}),
					).toMatchObject({ isError: true });
					expect(
						await b.client.callTool({
							name: 'alpha__read__151160dc30',
							arguments: { value: 42 },
							_meta: { 'tool-portal/operation-item': 'foreign' },
						}),
					).toMatchObject({ isError: true });
				} else {
					expect(
						decodedResult(
							await a.client.callTool({
								name: 'mcp_portal_call',
								arguments: { ...readCall('override'), principal: 'agent-b' },
							}),
						).ok,
					).toBe(false);
					expect(
						decodedResult(
							await b.client.callTool({ name: 'mcp_portal_call', arguments: readCall('foreign') }),
						).ok,
					).toBe(false);
					expect(
						decodedResult(
							await a.client.callTool({
								name: 'mcp_portal_call',
								arguments: {
									calls: [{ namespace: 'alpha', toolName: 'read', arguments: { value: 42 } }],
								},
							}),
						).ok,
					).toBe(false);
				}
				expect(alpha.effects).toHaveLength(before);
				const foreign = await fetch(endpoint, {
					method: 'POST',
					headers: {
						Authorization: 'Bearer credential-b',
						'mcp-session-id': a.transport.sessionId ?? '',
						accept: 'application/json, text/event-stream',
						'content-type': 'application/json',
					},
					body: JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'tools/list', params: {} }),
				});
				expect(foreign.status).toBe(401);
				const foreignLookup = await host.composition.operations.lookup({
					version: 'tool-operation-v1',
					key: { authority: config.authority, principal: 'agent-a', item: 'item-one' },
					verifiedContextRef: fixtureContextRef(config, 'agent-b'),
				});
				expect(foreignLookup).toEqual({ kind: 'denied' });
				const ownLookup = await host.composition.operations.lookup({
					version: 'tool-operation-v1',
					key: { authority: config.authority, principal: 'agent-a', item: 'item-one' },
					verifiedContextRef: fixtureContextRef(config),
				});
				expect(ownLookup).toMatchObject({
					kind: 'found',
					record: {
						key: { authority: config.authority, principal: 'agent-a', item: 'item-one' },
						state: { kind: 'completed' },
					},
				});
				await a.client.close();
				await b.client.callTool(
					exposure === 'compact'
						? { name: 'mcp_portal_call', arguments: readCall('b-one', 'beta') }
						: {
								name: 'beta__read__08da93d672',
								arguments: { value: 42 },
								_meta: { 'tool-portal/operation-item': 'b-one' },
							},
				);
				expect(beta.effects).toHaveLength(1);
				const reconnected = await connectClient(endpoint, 'credential-a');
				try {
					const retried = await reconnected.client.callTool(
						exposure === 'compact'
							? { name: 'mcp_portal_call', arguments: readCall('item-one') }
							: {
									name: 'alpha__read__151160dc30',
									arguments: { value: 42 },
									_meta: { 'tool-portal/operation-item': 'item-one' },
								},
					);
					expect(retried).toEqual(first);
					expect(alpha.effects).toHaveLength(2);
				} finally {
					await reconnected.client.close();
				}
				const filenames = await readdir(path.join(config.storeDirectory, 'tool-operations-v1'));
				expect(filenames.filter((name) => name.endsWith('.json')).length).toBeGreaterThanOrEqual(4);
				const records = await Promise.all(
					filenames
						.filter((name) => name.endsWith('.json'))
						.map(async (name) =>
							readFile(path.join(config.storeDirectory, 'tool-operations-v1', name), 'utf8'),
						),
				);
				expect(JSON.stringify(records)).not.toContain(secretCanary);
				expect(JSON.stringify({ diagnostics, first })).not.toContain(secretCanary);
				expect(JSON.stringify({ diagnostics, first })).not.toContain(headerCanary);
			} finally {
				await a.client.close();
				await b.client.close();
				await host.retire();
				await alpha.close();
				await beta.close();
			}
		}, 15_000);
	}
	it('authenticates every request; rejects wrong audience credential, Host, Origin and protocol version', async () => {
		const directory = await fixtureDirectory();
		const alpha = await startControlledProvider('alpha');
		const beta = await startControlledProvider('beta');
		const config = fixtureConfig(directory, [alpha.url, beta.url]);
		const configPath = await writeFixtureConfig(config, directory);
		const host = await startNodeHost({ configPath, secrets });
		const otherAudience = {
			audience: 'collaboration:mcp',
			bearerToken: 'credential-for-another-audience',
		};
		const otherService = createServer((request, response) => {
			response.writeHead(
				request.headers.authorization === `Bearer ${otherAudience.bearerToken}` ? 200 : 401,
				{ 'content-type': 'application/json' },
			);
			response.end(JSON.stringify({ audience: otherAudience.audience }));
		});
		otherService.listen(0, '127.0.0.1');
		await once(otherService, 'listening');
		try {
			const otherAddress = otherService.address();
			if (otherAddress === null || typeof otherAddress === 'string')
				throw new Error('Missing other audience endpoint');
			const validOtherProof = await fetch(`http://127.0.0.1:${otherAddress.port}`, {
				headers: { Authorization: `Bearer ${otherAudience.bearerToken}` },
			});
			expect(validOtherProof.status).toBe(200);
			expect(await validOtherProof.json()).toEqual({ audience: 'collaboration:mcp' });
			const endpoint = endpointOf(host);
			const initialize = {
				jsonrpc: '2.0',
				id: 0,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'claims-admin', version: '1' },
				},
			};
			await Promise.all(
				['', 'unknown', 'credential-for-another-audience'].map(async (token) => {
					const response = await fetch(endpoint, {
						method: 'POST',
						headers: {
							accept: 'application/json, text/event-stream',
							'content-type': 'application/json',
							...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
						},
						body: JSON.stringify(initialize),
					});
					expect(response.status).toBe(401);
				}),
			);
			const allowed = await fetch(endpoint, {
				method: 'POST',
				headers: {
					accept: 'application/json, text/event-stream',
					'content-type': 'application/json',
					Authorization: 'Bearer credential-a',
				},
				body: JSON.stringify(initialize),
			});
			expect(allowed.status).toBe(200);
			await Promise.all(
				[
					{ host: 'evil.example' },
					{ origin: 'https://evil.example' },
					{ 'mcp-protocol-version': 'unsupported' },
				].map(async (headers) => {
					const status = await new Promise<number>((resolve, reject) => {
						const request = httpRequest(
							endpoint,
							{
								method: 'POST',
								headers: {
									accept: 'application/json, text/event-stream',
									'content-type': 'application/json',
									Authorization: 'Bearer credential-a',
									'mcp-session-id': allowed.headers.get('mcp-session-id') ?? '',
									...headers,
								},
							},
							(response) => {
								response.resume();
								response.once('end', () => resolve(response.statusCode ?? 0));
							},
						);
						request.once('error', reject);
						request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
					});
					expect(status, JSON.stringify(headers)).toBe(400);
				}),
			);
			const active = await connectClient(endpoint, 'credential-a');
			try {
				await Promise.all(
					[
						'mcp_portal_list',
						'mcp_portal_search',
						'mcp_portal_describe',
						'mcp_portal_call',
					].flatMap((name) =>
						['profile', 'principal', 'backend', 'account', 'url'].map(async (field) => {
							const normal =
								name === 'mcp_portal_call'
									? readCall('override-' + field)
									: {
											requests: [
												{
													id: 'request',
													...(name === 'mcp_portal_describe'
														? { tools: [{ namespace: 'alpha', toolName: 'read' }] }
														: {}),
												},
											],
										};
							expect(
								decodedResult(
									await active.client.callTool({
										name,
										arguments: { ...normal, [field]: 'untrusted-override' },
									}),
								).ok,
							).toBe(false);
						}),
					),
				);
			} finally {
				await active.client.close();
			}
			await Promise.all(
				(
					[
						['{invalid', 400],
						[JSON.stringify({ padding: 'x'.repeat(4 * 1024 * 1024) }), 413],
					] as const
				).map(async ([body, status]) => {
					const response = await fetch(endpoint, {
						method: 'POST',
						headers: {
							Authorization: 'Bearer credential-a',
							accept: 'application/json, text/event-stream',
							'content-type': 'application/json',
						},
						body,
					});
					expect(response.status).toBe(status);
				}),
			);
			expect(alpha.effects).toEqual([]);
			expect(beta.effects).toEqual([]);
		} finally {
			otherService.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				otherService.close((error) => (error === undefined ? resolve() : reject(error))),
			);
			await host.retire();
			await alpha.close();
			await beta.close();
		}
	});
});
