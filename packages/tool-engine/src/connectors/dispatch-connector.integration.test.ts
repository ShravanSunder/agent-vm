import { once } from 'node:events';
import { createServer } from 'node:http';

import { createPortalAgentIdentity } from '@agent-collaboration/tool-access/authorization';
import {
	jsonValueSchema,
	type AssessAccessInput,
	assessAccessInput,
} from '@agent-collaboration/tool-access/contracts';
import type {
	DispatchInvocation,
	ToolBackend,
	BackendKind,
	OperationRecord,
} from '@agent-collaboration/tool-engine/dispatch';
import {
	signApprovalToken,
	hashCallArguments,
	createMcpGateway,
	createAgentCatalogViewCache,
	createInMemoryApprovalTokenUse,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, it, expect } from 'vitest';

import { createUpstreamMcpClientRuntime } from '#connectors/upstream-mcp-client-runtime';

async function unavailable(): Promise<{ kind: 'unavailable' }> {
	return { kind: 'unavailable' };
}

// Real dispatcher + assessor + connector + SDK HTTP. The controlled provider is the external fixture.
describe('dispatch to a selected credentialed HTTP MCP connector', () => {
	it.each([
		{ mode: 'direct', requiresApproval: false },
		{ mode: 'indirect', requiresApproval: false },
		{ mode: 'direct', requiresApproval: true },
		{ mode: 'indirect', requiresApproval: true },
	] as const)(
		'records binding/header and redacts nested material: $mode, approval=$requiresApproval',
		async ({ mode, requiresApproval }) => {
			const secretCanary = 'opaque-provider-credential-31';
			const headerCanary = 'selected-header-canary-62';
			const effects: {
				name: string;
				arguments: unknown;
				authorization: string | undefined;
				header: string | undefined;
			}[] = [];
			const diagnostics: unknown[] = [];
			const invocations: DispatchInvocation[] = [];
			const provider = createServer((request, response) => {
				const serve = async (): Promise<void> => {
					const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
					const server = new Server(
						{ name: 'controlled-provider', version: '1.0.0' },
						{ capabilities: { tools: {} } },
					);
					server.setRequestHandler(ListToolsRequestSchema, async () => ({
						tools: ['read', 'fail'].map((name) => ({
							name,
							description: `provider ${secretCanary} ${headerCanary}`,
							inputSchema: {
								type: 'object',
								properties: { value: { type: 'integer', description: secretCanary } },
								required: ['value'],
								additionalProperties: false,
							},
						})),
					}));
					server.setRequestHandler(CallToolRequestSchema, async (call) => {
						effects.push({
							name: call.params.name,
							arguments: call.params.arguments,
							authorization: request.headers.authorization,
							header:
								typeof request.headers['x-selected-binding'] === 'string'
									? request.headers['x-selected-binding']
									: undefined,
						});
						return {
							content: [{ type: 'text', text: `${secretCanary} ${headerCanary}` }],
							structuredContent: { nested: { credential: secretCanary, header: headerCanary } },
							...(call.params.name === 'fail' ? { isError: true } : {}),
						};
					});
					const serverTransport: Transport = {
						start: async () => transport.start(),
						send: async (message, options) => transport.send(message, options),
						close: async () => transport.close(),
					};
					const callbacks: Pick<Transport, 'onclose' | 'onerror' | 'onmessage'> = {
						onclose: () => serverTransport.onclose?.(),
						onerror: (error) => serverTransport.onerror?.(error),
						onmessage: (message, extra) => serverTransport.onmessage?.(message, extra),
					};
					Object.assign(transport, callbacks);
					await server.connect(serverTransport);
					try {
						await transport.handleRequest(request, response);
					} finally {
						await server.close();
					}
				};
				void serve().catch(() => {
					response.writeHead(500);
					response.end();
				});
			});
			provider.listen(0, '127.0.0.1');
			await once(provider, 'listening');
			const address = provider.address();
			if (address === null || typeof address === 'string') throw new Error('No provider address');
			const runtime = createUpstreamMcpClientRuntime({
				servers: [
					{
						namespace: 'provider',
						transport: 'streamable-http',
						url: `http://127.0.0.1:${address.port}/mcp`,
						headers: {
							Authorization: `Bearer ${secretCanary}`,
							'x-selected-binding': headerCanary,
						},
					},
				],
				additionalRedactionValues: [secretCanary],
				createUpstreamMcpTransport: (server) =>
					new StreamableHTTPClientTransport(
						new URL(server.url),
						server.requestInit === undefined ? {} : { requestInit: server.requestInit },
					),
				onCloseError: (error) => {
					diagnostics.push(error);
				},
			});
			const revision = { owner: 'provider-registry', revision: 'selected-account:v1' };
			const identity = createPortalAgentIdentity({
				agentId: 'agent-a',
				agentScopeId: 'scope-a',
				source: 'mcp-proxy-bearer',
			});
			const backend: ToolBackend<BackendKind> = {
				backendKind: 'mcp_provider',
				list: async () => ({}),
				describe: async () => ({}),
				search: async () => ({}),
				invoke: async (invocation) => {
					invocations.push(invocation);
					try {
						return {
							kind: 'completed',
							result: jsonValueSchema.parse(
								await runtime.callTool({
									agentScopeId: 'scope-a',
									namespace: invocation.capability.namespace,
									toolName: invocation.capability.tool,
									arguments: invocation.arguments,
								}),
							),
						};
					} catch (error) {
						diagnostics.push(error);
						throw error;
					}
				},
			};

			const signingKey = new Uint8Array(32).fill(17);
			const records = new Map<string, OperationRecord>();
			async function approvalFor(toolName: string, value: number): Promise<string> {
				return signApprovalToken({
					agentId: 'agent-a',
					key: signingKey,
					calls: [
						{ namespace: 'provider', toolName, argumentsHash: await hashCallArguments({ value }) },
					],
					issuedAtMs: 0,
					expiresAtMs: 10000,
					jti: `approval:${toolName}`,
				});
			}
			const gateway = createMcpGateway({
				caller: {
					identity,
					authority: 'fixture',
					principal: 'agent-a',
					verifiedContextRef: 'verified-a',
				},
				hostBinding: { workspaceLayer: 'not-configured', config: revision },
				sessions: createAgentCatalogViewCache({
					accessPolicy: {
						defaultPolicy: 'allow-all',
						enabledNamespacesByAgent: {},
						hiddenToolsByAgent: {},
					},
					catalogTtlMs: 60000,
					runtime,
					upstreamNamespaces: ['provider'],
				}),
				resolveAccess: async ({ capability, call }): Promise<AssessAccessInput> =>
					assessAccessInput.parse({
						capability,
						call,
						surface: 'mcp',
						facts: {
							workspace: { kind: 'not-configured' },
							assignment: {
								profileRevision: revision,
								revision,
								profile: {
									profileId: 'complete-profile',
									namespaces: {
										provider: {
											backendKind: 'mcp_provider',
											tools: { allow: '*', deny: [] },
											calls: {
												kind: 'selectors',
												withoutApproval: { allow: requiresApproval ? [] : '*', deny: [] },
												requiresApproval: {
													allow: requiresApproval ? ['read', 'fail'] : [],
													deny: [],
												},
											},
											operations: {},
										},
									},
								},
							},
							surface: { eligible: ['mcp'], snapshot: revision },
							accounts: [],
							upstream: { status: 'available', credentialNeed: 'met', binding: revision },
						},
					}),
				prepareCatalog: async (input) => input,
				approvalTokens: {
					key: signingKey,
					consumeTokenId: createInMemoryApprovalTokenUse({ now: () => 0 }),
				},
				operations: {
					createOrRead: async ({ invocation }) => {
						if (!requiresApproval) return { kind: 'untracked' };
						const key = JSON.stringify(invocation.operationKey);
						const old = records.get(key);
						if (old !== undefined) return { kind: 'existing', record: old };
						const record: OperationRecord = {
							version: 'tool-operation-v1',
							key: invocation.operationKey,
							intentDigest: invocation.intentDigest,
							createdAt: '2026-10-20T00:00:00.000Z',
							updatedAt: '2026-10-20T00:00:00.000Z',
							revision: '1',
							state: { kind: 'ready' },
						};
						records.set(key, record);
						return { kind: 'created', record };
					},
					lookup: unavailable,
					transition: async ({ invocation, expectedRevision, next }) => {
						const key = JSON.stringify(invocation.operationKey);
						const old = records.get(key);
						if (old?.revision !== expectedRevision) return { kind: 'conflict' };
						const record = { ...old, state: next, revision: String(Number(old.revision) + 1) };
						records.set(key, record);
						return { kind: 'found', record };
					},
				},
				approvals: { challenge: unavailable, decision: unavailable, receipt: unavailable },
				backends: new Map([['mcp_provider', backend]]),
				now: () => 0,
			});
			try {
				const catalog = await gateway.prepareCatalog();
				const readTool = catalog.tools.find((tool) => tool.toolName === 'read');
				const failTool = catalog.tools.find((tool) => tool.toolName === 'fail');
				if (readTool === undefined || failTool === undefined)
					throw new Error('Missing discovered provider tools');
				const readApproval = await approvalFor('read', 42);
				const failApproval = await approvalFor('fail', 43);
				const result =
					mode === 'direct'
						? await gateway.callDirect({
								name: readTool.descriptor.name,
								arguments: { value: 42 },
								item: 'allowed',
								catalog,
								_meta: { 'agent-vm/tool-portal-approval-token': readApproval },
							})
						: await gateway.call({
								portalApprovalToken: readApproval,
								calls: [
									{
										id: 'allowed',
										namespace: 'provider',
										toolName: 'read',
										arguments: { value: 42 },
									},
								],
							});
				expect(result).toMatchObject({
					ok: true,
					results: {
						allowed: {
							ok: true,
							output: {
								result: {
									structuredContent: { nested: { credential: '[REDACTED]', header: '[REDACTED]' } },
								},
							},
						},
					},
				});
				const failed =
					mode === 'direct'
						? await gateway.callDirect({
								name: failTool.descriptor.name,
								arguments: { value: 43 },
								item: 'failed',
								catalog,
								_meta: { 'agent-vm/tool-portal-approval-token': failApproval },
							})
						: await gateway.call({
								portalApprovalToken: failApproval,
								calls: [
									{
										id: 'failed',
										namespace: 'provider',
										toolName: 'fail',
										arguments: { value: 43 },
									},
								],
							});
				expect(failed).toMatchObject({
					ok: false,
					results: {
						failed: {
							ok: false,
							error: { kind: 'ambiguous', reason: 'resource-authority-unconfirmed' },
						},
					},
				});
				expect(effects).toEqual([
					{
						name: 'read',
						arguments: { value: 42 },
						authorization: `Bearer ${secretCanary}`,
						header: headerCanary,
					},
					{
						name: 'fail',
						arguments: { value: 43 },
						authorization: `Bearer ${secretCanary}`,
						header: headerCanary,
					},
				]);
				expect(invocations.map((invocation) => invocation.bindingRevision)).toEqual([
					revision,
					revision,
				]);
				if (requiresApproval) {
					expect(invocations.map((invocation) => invocation.approvalReceiptRef)).toEqual([
						'mcp-approval:approval:read',
						'mcp-approval:approval:fail',
					]);
					const replay =
						mode === 'direct'
							? await gateway.callDirect({
									name: readTool.descriptor.name,
									arguments: { value: 42 },
									item: 'replay',
									catalog,
									_meta: { 'agent-vm/tool-portal-approval-token': readApproval },
								})
							: await gateway.call({
									calls: [
										{
											id: 'replay',
											namespace: 'provider',
											toolName: 'read',
											arguments: { value: 42 },
										},
									],
									portalApprovalToken: readApproval,
								});
					expect(replay.ok).toBe(false);
					expect(effects).toHaveLength(2);
				}
				const callerVisible = JSON.stringify({ catalog, result, failed, diagnostics });
				expect(callerVisible).not.toContain(secretCanary);
				expect(callerVisible).not.toContain(headerCanary);
				expect(callerVisible).toContain('[REDACTED]');
			} finally {
				await runtime.closeAgentScope('scope-a');
				provider.closeAllConnections();
				await new Promise<void>((resolve, reject) =>
					provider.close((error) => (error ? reject(error) : resolve())),
				);
			}
		},
	);
});
