import { workspaceConfigurationSchema } from '@agent-collaboration/tool-host-core';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { expect, it } from 'vitest';
import { z } from 'zod';

import {
	workspaceConfigurations,
	organizationOne,
	organizationTwo,
	signingKeyHex,
	startControlledMcpIssuer,
} from '#worker-host/test-fixtures/controlled-mcp-issuer';
import { startWorkerdSocketGuard } from '#worker-host/test-fixtures/workerd-socket-guard';

const siblingWorkspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const portalOrigin = 'https://portal-test.invalid';
const audience = (workspaceId: string): string => `${portalOrigin}/workspaces/${workspaceId}/mcp`;

it.each(['direct', 'indirect'] as const)(
	'production %s workspace routing keeps persona, labels and warm removal local',
	async (mode) => {
		const guard = startWorkerdSocketGuard();
		const fixture = await startControlledMcpIssuer();
		let runtime: Miniflare | undefined;
		try {
			const configurations = z
				.record(z.string(), workspaceConfigurationSchema)
				.parse(workspaceConfigurations(fixture.url));
			const firstConfiguration = configurations[organizationOne];
			if (firstConfiguration === undefined)
				throw new Error('Missing first workspace configuration');
			configurations[siblingWorkspace] = workspaceConfigurationSchema.parse({
				...firstConfiguration,
				workspaceName: 'sibling-workspace',
				approvalKeyBinding: 'SIBLING_APPROVAL_KEY',
				mcp: {
					schemaVersion: 1,
					providers: {
						fixture: {
							kind: 'mcp',
							namespace: 'same-server',
							transport: {
								kind: 'streamable-http',
								url: `${fixture.url}/mcp`,
								headers: { authorization: { source: 'environment', name: 'SIBLING_CREDENTIAL' } },
							},
						},
					},
				},
			});
			const bundles = await Promise.all(
				[
					'packages/tool-host-cloudflare/src/index.ts',
					'packages/tool-host-cloudflare/src/test-fixtures/object-proof-entrypoint.ts',
				].map((entry) =>
					build({
						entryPoints: [entry],
						bundle: true,
						write: false,
						format: 'esm',
						platform: 'browser',
						conditions: ['workerd', 'worker', 'browser'],
						external: ['cloudflare:workers'],
					}),
				),
			);
			const production = bundles[0]?.outputFiles[0]?.text;
			const seed = bundles[1]?.outputFiles[0]?.text;
			if (production === undefined || seed === undefined)
				throw new Error('Missing production matrix modules');
			runtime = new Miniflare(
				convertV4MiniflareOptions({
					workers: [
						{
							name: 'production-matrix',
							script: production,
							modules: true,
							compatibilityDate: '2026-08-15',
							bindings: {
								SIGN_IN_ISSUER: fixture.url,
								SIGN_IN_JWKS_URL: `${fixture.url}/jwks`,
								TOOL_PORTAL_ORIGIN: portalOrigin,
								WORKSPACE_CONFIGURATIONS: JSON.stringify(configurations),
								ONE_CREDENTIAL: 'one-secret-canary',
								TWO_CREDENTIAL: 'two-secret-canary',
								SIBLING_CREDENTIAL: 'sibling-secret-canary',
								ONE_APPROVAL_KEY: signingKeyHex,
								TWO_APPROVAL_KEY: '34'.repeat(32),
								SIBLING_APPROVAL_KEY: '56'.repeat(32),
							},
							durableObjects: { WORKSPACES: { className: 'WorkspaceAuthority', useSQLite: true } },
						},
						{
							name: 'seed',
							script: seed,
							modules: true,
							compatibilityDate: '2026-08-15',
							durableObjects: {
								WORKSPACES: {
									className: 'WorkspaceAuthority',
									scriptName: 'production-matrix',
									useSQLite: true,
								},
							},
						},
					],
				}),
			);
			const worker = await runtime.getWorker('production-matrix');
			type MatrixResponse = Awaited<ReturnType<typeof worker.fetch>>;
			const writer = await runtime.getWorker('seed');
			async function membership(
				workspaceId: string,
				state: 'listed' | 'removed',
				persona = 'one',
			): Promise<void> {
				const response = await writer.fetch('https://seed.invalid', {
					method: 'POST',
					body: JSON.stringify({
						kind: 'admission',
						organizationId: workspaceId,
						agentId: 'agent-one',
						state,
						persona,
					}),
				});
				expect(response.status).toBe(200);
				await response.body?.cancel();
			}
			async function token(workspaceId: string, agentId = 'agent-one'): Promise<string> {
				return fixture.sign({
					agentId,
					organizationId: workspaceId === organizationTwo ? organizationTwo : organizationOne,
					changes: { aud: audience(workspaceId), workspace_id: workspaceId },
				});
			}
			async function rpc({
				workspaceId,
				bearer,
				method,
				params = {},
				labels = false,
			}: {
				readonly workspaceId: string;
				readonly bearer: string | null;
				readonly method: string;
				readonly params?: Readonly<Record<string, unknown>>;
				readonly labels?: boolean;
			}): Promise<MatrixResponse> {
				return worker.fetch(
					`${portalOrigin}/workspaces/${workspaceId}/mcp${mode === 'direct' ? '?tools=direct&' : '?'}${labels ? 'agent=agent-two&sessionId=spoof' : ''}`,
					{
						method: 'POST',
						headers: {
							...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
							'content-type': 'application/json',
							'MCP-Protocol-Version': '2026-07-28',
							'Mcp-Method': method,
							...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
							...(labels ? { 'x-agent-id': 'agent-two', 'Mcp-Session-Id': 'spoof' } : {}),
						},
						body: JSON.stringify({
							jsonrpc: '2.0',
							id: crypto.randomUUID(),
							method,
							params: {
								_meta: {
									'io.modelcontextprotocol/protocolVersion': '2026-07-28',
									'io.modelcontextprotocol/clientCapabilities': {},
								},
								...params,
							},
						}),
					},
				);
			}
			const read = (value: string): Readonly<Record<string, unknown>> => ({
				name: 'mcp_portal_call',
				arguments: {
					calls: [{ id: value, namespace: 'same-server', toolName: 'read', arguments: { value } }],
				},
			});
			async function succeeds({
				workspaceId,
				bearer,
				value,
				labels = false,
			}: {
				readonly workspaceId: string;
				readonly bearer: string;
				readonly value: string;
				readonly labels?: boolean;
			}): Promise<void> {
				const before = fixture.calls.length;
				const response = await rpc({
					workspaceId: workspaceId,
					bearer: bearer,
					method: 'tools/call',
					params: read(value),
					labels: labels,
				});
				expect(response.status).toBe(200);
				await response.body?.cancel();
				expect(fixture.calls.slice(before)).toEqual([
					{
						credential:
							workspaceId === organizationOne
								? 'one-secret-canary'
								: workspaceId === siblingWorkspace
									? 'sibling-secret-canary'
									: 'two-secret-canary',
						name: 'read',
						arguments: { value },
					},
				]);
			}
			// Ruling 7 permits these Portal-internal controls. Real issuance is proved separately by Auth.
			await membership(organizationTwo, 'listed', 'unknown');
			const unknown = await rpc({
				workspaceId: organizationTwo,
				bearer: await token(organizationTwo),
				method: 'tools/list',
			});
			expect(unknown.status).toBe(401);
			expect(await unknown.json()).toEqual({ error: 'profile-unassigned' });
			expect(fixture.discoveryCredentials).toEqual([]);
			expect(fixture.calls).toEqual([]);
			await Promise.all(
				[organizationOne, siblingWorkspace, organizationTwo].map((workspaceId) =>
					membership(workspaceId, 'listed'),
				),
			);
			const tokens = {
				first: await token(organizationOne),
				sibling: await token(siblingWorkspace),
				foreign: await token(organizationTwo),
			};
			await succeeds({ workspaceId: organizationOne, bearer: tokens.first, value: 'first' });
			await succeeds({ workspaceId: siblingWorkspace, bearer: tokens.sibling, value: 'sibling' });
			await succeeds({ workspaceId: organizationTwo, bearer: tokens.foreign, value: 'foreign' });
			await succeeds({
				workspaceId: organizationOne,
				bearer: tokens.first,
				value: 'spoofed-labels',
				labels: true,
			});
			let nativeReadName: string | undefined;
			if (mode === 'direct') {
				const nativeList = await rpc({
					workspaceId: organizationOne,
					bearer: tokens.first,
					method: 'tools/list',
				});
				expect(nativeList.status).toBe(200);
				const tools = z
					.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
					.parse(await nativeList.json()).result.tools;
				nativeReadName = tools.find((tool) => tool.name.startsWith('same-server__read__'))?.name;
				if (nativeReadName === undefined) throw new Error('Missing admitted native read tool');
				const beforeNative = fixture.calls.length;
				const admittedNative = await rpc({
					workspaceId: organizationOne,
					bearer: tokens.first,
					method: 'tools/call',
					params: {
						name: nativeReadName,
						arguments: { value: 'native-allowed' },
					},
				});
				expect(admittedNative.status).toBe(200);
				const admittedResult = z
					.object({
						result: z.object({
							content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
						}),
					})
					.parse(await admittedNative.json());
				const admittedCore: unknown = JSON.parse(
					admittedResult.result.content.map((item) => item.text).join(''),
				);
				expect(admittedCore).toMatchObject({
					items: [
						{
							requestId: 'catalog-call',
							status: 'success',
							structuredContent: {
								namespace: 'same-server',
								toolName: 'read',
								result: { content: [{ type: 'text', text: 'native-allowed' }] },
							},
						},
					],
				});
				expect(fixture.calls.slice(beforeNative)).toEqual([
					{ credential: 'one-secret-canary', name: 'read', arguments: { value: 'native-allowed' } },
				]);
			}
			const beforeCross = [...fixture.calls];
			const responses = await Promise.all([
				rpc({
					workspaceId: siblingWorkspace,
					bearer: tokens.first,
					method: 'tools/call',
					params: read('cross-sibling'),
				}),
				rpc({
					workspaceId: organizationOne,
					bearer: tokens.foreign,
					method: 'tools/call',
					params: read('cross-foreign'),
				}),
				rpc({
					workspaceId: organizationOne,
					bearer: await token(organizationOne, 'nonmember'),
					method: 'tools/call',
					params: read('nonmember'),
				}),
				rpc({
					workspaceId: organizationOne,
					bearer: 'invalid-signature',
					method: 'tools/call',
					params: read('invalid'),
				}),
				rpc({
					workspaceId: organizationOne,
					bearer: await fixture.sign({ forge: true }),
					method: 'tools/call',
					params: read('forged-signature'),
				}),
				rpc({
					workspaceId: organizationOne,
					bearer: null,
					method: 'tools/call',
					params: read('missing-token'),
				}),
				rpc({
					workspaceId: organizationOne,
					bearer: await fixture.sign({ changes: { exp: Math.floor(Date.now() / 1000) - 3600 } }),
					method: 'tools/call',
					params: read('expired-token'),
				}),
				rpc({
					workspaceId: organizationOne,
					bearer: await fixture.sign({
						changes: { aud: 'https://portal-test.invalid/mcp', workspace_id: undefined },
					}),
					method: 'tools/call',
					params: read('legacy-token'),
				}),
			]);
			expect(responses.map((response) => response.status)).toEqual([
				401, 401, 401, 401, 401, 401, 401, 401,
			]);
			expect(await Promise.all(responses.map((response) => response.text()))).toEqual(
				Array.from({ length: 8 }, () => '{"error":"unknown-caller"}'),
			);
			expect(fixture.calls).toEqual(beforeCross);
			await membership(organizationOne, 'listed', 'two');
			const list = await rpc({
				workspaceId: organizationOne,
				bearer: tokens.first,
				method: 'tools/call',
				params: {
					name: 'mcp_portal_list',
					arguments: { requests: [{ id: 'persona-list' }] },
				},
			});
			expect(list.status).toBe(200);
			const result = z
				.object({
					result: z.object({
						content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
					}),
				})
				.parse(await list.json());
			const listing: unknown = JSON.parse(result.result.content.map((item) => item.text).join(''));
			const personaTools = z
				.object({
					structuredContent: z.object({
						ok: z.literal(true),
						results: z.object({
							'persona-list': z.object({
								ok: z.literal(true),
								output: z.object({
									tools: z.array(z.object({ namespace: z.string(), toolName: z.string() })),
								}),
							}),
						}),
					}),
				})
				.parse(listing).structuredContent.results['persona-list'].output.tools;
			expect(personaTools).toEqual([{ namespace: 'same-server', toolName: 'ask' }]);
			const native = await rpc({
				workspaceId: organizationOne,
				bearer: tokens.first,
				method: 'tools/list',
			});
			expect(native.status).toBe(200);
			const names = z
				.object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
				.parse(await native.json())
				.result.tools.map((tool) => tool.name);
			expect(names.some((name) => name.startsWith('same-server__read__'))).toBe(false);
			const denied = await rpc({
				workspaceId: organizationOne,
				bearer: tokens.first,
				method: 'tools/call',
				params: read('persona-denied'),
			});
			expect(denied.status).toBe(200);
			expect(await denied.json()).toMatchObject({ result: { isError: true } });
			expect(fixture.calls).toEqual(beforeCross);
			if (nativeReadName !== undefined) {
				const deniedNative = await rpc({
					workspaceId: organizationOne,
					bearer: tokens.first,
					method: 'tools/call',
					params: {
						name: nativeReadName,
						arguments: { value: 'native-persona-denied' },
					},
				});
				expect(deniedNative.status).toBe(200);
				expect(await deniedNative.json()).toMatchObject({ result: { isError: true } });
				expect(fixture.calls).toEqual(beforeCross);
			}
			await membership(organizationOne, 'removed');
			const removed = await rpc({
				workspaceId: organizationOne,
				bearer: tokens.first,
				method: 'tools/call',
				params: read('warm-removed'),
			});
			expect(removed.status).toBe(401);
			await removed.body?.cancel();
			expect(fixture.calls).toEqual(beforeCross);
			await succeeds({
				workspaceId: siblingWorkspace,
				bearer: tokens.sibling,
				value: 'sibling-after-removal',
			});
			guard.check();
		} finally {
			try {
				await runtime?.dispose();
			} finally {
				try {
					await fixture.close();
				} finally {
					await guard.stop();
				}
			}
		}
	},
);
