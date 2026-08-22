import { request as sendHttpRequest } from 'node:http';

import {
	PortalArtifactReadRequestSchema,
	PortalArtifactReadResultSchema,
	type PortalArtifactReadResult,
} from '@agent-vm/agent-portal-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	type StandaloneToolPortalBearerCredentialSet,
} from './standalone-tool-portal-bearer-credentials.js';
import {
	startStandaloneToolPortalMcpHttpServer,
	type StandaloneToolPortalMcpHttpServer,
} from './standalone-tool-portal-mcp-http-server.js';
import {
	STANDALONE_TOOL_PORTAL_MCP_TOOL_NAMES,
	type StandaloneToolPortalArtifactReader,
	type StandaloneToolPortalProjectionService,
} from './standalone-tool-portal-mcp-projection.js';

const mcpProtocolVersion = '2025-06-18';
const routePath = '/tool-portal/mcp';
const tokenAV1 = 'standalone-agent-a-token-v1';
const tokenAV2 = 'standalone-agent-a-token-v2';
const tokenBV1 = 'standalone-agent-b-token-v1';
const tokenBV2 = 'standalone-agent-b-token-v2';
const artifactReadRequestMetadataKey = 'agent-vm/artifact-read-request';

const principalA = {
	agentId: 'agent-a',
	profileAssignmentRevision: 'profile:agent-a:1',
	toolPortalProfileId: 'builder',
} as const;

const principalB = {
	agentId: 'agent-b',
	profileAssignmentRevision: 'profile:agent-b:1',
	toolPortalProfileId: 'builder',
} as const;

const credentialSetV1 = {
	audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	credentials: [
		{ bearerToken: tokenAV1, credentialVersion: 1, principal: principalA },
		{ bearerToken: tokenBV1, credentialVersion: 1, principal: principalB },
	],
	serviceGeneration: 'standalone-service:1',
} as const satisfies StandaloneToolPortalBearerCredentialSet;

const credentialSetV2 = {
	audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	credentials: [
		{ bearerToken: tokenAV2, credentialVersion: 2, principal: principalA },
		{ bearerToken: tokenBV2, credentialVersion: 2, principal: principalB },
	],
	serviceGeneration: 'standalone-service:1',
} as const satisfies StandaloneToolPortalBearerCredentialSet;

const credentialSetAgentAOnlyV3 = {
	audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	credentials: [
		{ bearerToken: 'standalone-agent-a-token-v3', credentialVersion: 3, principal: principalA },
	],
	serviceGeneration: 'standalone-service:1',
} as const satisfies StandaloneToolPortalBearerCredentialSet;

const credentialSetRollbackAgentBV1 = {
	audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	credentials: [
		{ bearerToken: 'standalone-agent-a-token-v4', credentialVersion: 4, principal: principalA },
		{ bearerToken: 'standalone-agent-b-token-v1-new', credentialVersion: 1, principal: principalB },
	],
	serviceGeneration: 'standalone-service:1',
} as const satisfies StandaloneToolPortalBearerCredentialSet;

const credentialSetChangedIdentityV3 = {
	audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	credentials: [
		{
			bearerToken: 'standalone-agent-a-token-v3-changed',
			credentialVersion: 3,
			principal: { ...principalA, toolPortalProfileId: 'administrator' },
		},
	],
	serviceGeneration: 'standalone-service:1',
} as const satisfies StandaloneToolPortalBearerCredentialSet;

const artifactRequest = PortalArtifactReadRequestSchema.parse({
	maxBytes: 512,
	offsetBytes: 128,
	reference: {
		byteLength: 1_024,
		expiresAt: '2026-07-17T12:00:00.000Z',
		fingerprint: `sha256:${'a'.repeat(64)}`,
		id: 'artifact-a',
		mediaType: 'application/octet-stream',
	},
});

const artifactResult = PortalArtifactReadResultSchema.parse({
	contentBase64: Buffer.from('bounded artifact', 'utf8').toString('base64'),
	mediaType: 'application/octet-stream',
	offsetBytes: artifactRequest.offsetBytes,
	reference: artifactRequest.reference,
	truncated: true,
});

const artifactUri = `agent-vm-artifact://read?id=${encodeURIComponent(artifactRequest.reference.id)}`;

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	readonly resolve: (value: TValue) => void;
}

interface JsonRpcMessage {
	readonly error?: unknown;
	readonly id?: number | string;
	readonly result?: unknown;
}

interface McpResponse {
	readonly messages: readonly JsonRpcMessage[];
	readonly response: Response;
}

interface McpSession {
	readonly sessionId: string;
	readonly token: string;
	readonly url: URL;
}

interface RecordedInvocation {
	readonly operation: 'call' | 'describe' | 'list' | 'search';
	readonly options: Parameters<StandaloneToolPortalProjectionService['list']>[1];
}

function deferred<TValue>(): Deferred<TValue> {
	let resolver: ((value: TValue) => void) | undefined;
	return {
		promise: new Promise<TValue>((resolve) => {
			resolver = resolve;
		}),
		resolve: (value) => {
			if (resolver === undefined) throw new Error('Deferred resolver was not initialized.');
			resolver(value);
		},
	};
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodedMessages(text: string): readonly JsonRpcMessage[] {
	if (text.length === 0) return [];
	const payloads = text
		.split(/\r?\n/u)
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice('data:'.length).trim());
	return (payloads.length > 0 ? payloads : [text])
		.flatMap((payload): readonly unknown[] => {
			const parsed: unknown = JSON.parse(payload);
			return Array.isArray(parsed) ? parsed : [parsed];
		})
		.filter(isObjectRecord);
}

async function sendMcpRequest(props: {
	readonly body: unknown;
	readonly sessionId?: string;
	readonly token?: string;
	readonly url: URL;
}): Promise<McpResponse> {
	const headers = new Headers({
		accept: 'application/json, text/event-stream',
		'content-type': 'application/json',
		'mcp-protocol-version': mcpProtocolVersion,
	});
	if (props.token !== undefined) headers.set('authorization', `Bearer ${props.token}`);
	if (props.sessionId !== undefined) headers.set('mcp-session-id', props.sessionId);
	const response = await fetch(props.url, {
		body: JSON.stringify(props.body),
		headers,
		method: 'POST',
	});
	return { messages: decodedMessages(await response.text()), response };
}

async function sendRawHttpRequest(props: {
	readonly body: unknown;
	readonly headers: Readonly<Record<string, string>>;
	readonly url: URL;
}): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const request = sendHttpRequest(
			props.url,
			{ headers: props.headers, method: 'POST' },
			(response) => {
				response.resume();
				response.once('end', () => resolve(response.statusCode ?? 0));
			},
		);
		request.once('error', reject);
		request.end(JSON.stringify(props.body));
	});
}

function responseMessage(response: McpResponse, id: number): JsonRpcMessage {
	const message = response.messages.find((candidate) => candidate.id === id);
	if (message === undefined) throw new Error(`Missing JSON-RPC response ${String(id)}.`);
	return message;
}

async function initializeSession(url: URL, token: string): Promise<McpSession> {
	const initialization = await sendMcpRequest({
		body: {
			id: 1,
			jsonrpc: '2.0',
			method: 'initialize',
			params: {
				capabilities: {},
				clientInfo: { name: 'standalone-tool-portal-test', version: '1.0.0' },
				protocolVersion: mcpProtocolVersion,
			},
		},
		token,
		url,
	});
	expect(initialization.response.status).toBe(200);
	const sessionId = initialization.response.headers.get('mcp-session-id');
	if (sessionId === null) throw new Error('Standalone Tool Portal did not issue a session ID.');
	await sendMcpRequest({
		body: { jsonrpc: '2.0', method: 'notifications/initialized' },
		sessionId,
		token,
		url,
	});
	return { sessionId, token, url };
}

async function sessionRequest(
	session: McpSession,
	props: {
		readonly argumentsValue?: Record<string, unknown>;
		readonly id: number;
		readonly method: 'tools/call' | 'tools/list';
		readonly token?: string | null;
		readonly toolName?: string;
	},
): Promise<McpResponse> {
	return await sendMcpRequest({
		body: {
			id: props.id,
			jsonrpc: '2.0',
			method: props.method,
			params:
				props.method === 'tools/list'
					? {}
					: { arguments: props.argumentsValue ?? {}, name: props.toolName },
		},
		sessionId: session.sessionId,
		...(props.token === null ? {} : { token: props.token ?? session.token }),
		url: session.url,
	});
}

function createServiceFixture(
	props: {
		readonly blockListUntil?: Promise<void>;
		readonly onListStarted?: () => void;
	} = {},
): {
	readonly invocations: readonly RecordedInvocation[];
	readonly service: StandaloneToolPortalProjectionService;
} {
	const invocations: RecordedInvocation[] = [];
	const record = (
		operation: RecordedInvocation['operation'],
		options: RecordedInvocation['options'],
	): void => {
		invocations.push({ operation, options });
	};
	return {
		invocations,
		service: {
			call: vi.fn(
				async (
					request: Parameters<StandaloneToolPortalProjectionService['call']>[0],
					options: Parameters<StandaloneToolPortalProjectionService['call']>[1],
				) => {
					record('call', options);
					return {
						items: request.calls.map((call) => ({
							id: call.id,
							operationId: `operation:${call.id}`,
							outcome: {
								certainty: 'proven' as const,
								completion: 'succeeded' as const,
								kind: 'completed' as const,
								retryClass: 'forbidden' as const,
							},
							owningGeneration: 'standalone-generation:1',
							status: 'ok' as const,
							value: { output: 'done' },
						})),
						ok: true,
					};
				},
			),
			describe: vi.fn(
				async (
					request: Parameters<StandaloneToolPortalProjectionService['describe']>[0],
					options: Parameters<StandaloneToolPortalProjectionService['describe']>[1],
				) => {
					record('describe', options);
					return {
						items: request.requests.map(({ id }) => ({
							id,
							status: 'ok' as const,
							value: { namespaceDiscovery: [], tools: [] },
						})),
						ok: true,
					};
				},
			),
			list: vi.fn(
				async (
					request: Parameters<StandaloneToolPortalProjectionService['list']>[0],
					options: Parameters<StandaloneToolPortalProjectionService['list']>[1],
				) => {
					record('list', options);
					props.onListStarted?.();
					await props.blockListUntil;
					return {
						items: request.requests.map(({ id }) => ({
							id,
							status: 'ok' as const,
							value: { namespaceDiscovery: [], namespaces: ['github'], tools: [] },
						})),
						ok: true,
					};
				},
			),
			search: vi.fn(
				async (
					request: Parameters<StandaloneToolPortalProjectionService['search']>[0],
					options: Parameters<StandaloneToolPortalProjectionService['search']>[1],
				) => {
					record('search', options);
					return {
						items: request.requests.map(({ id }) => ({
							id,
							status: 'ok' as const,
							value: { namespaceDiscovery: [], tools: [] },
						})),
						ok: true,
					};
				},
			),
		},
	};
}

function unusedArtifactReader(): StandaloneToolPortalArtifactReader {
	return { read: vi.fn(() => Promise.reject(new Error('Artifact read was not expected.'))) };
}

const activeServers: StandaloneToolPortalMcpHttpServer[] = [];

afterEach(async () => {
	await Promise.allSettled(activeServers.splice(0).map(async (server) => await server.retire()));
});

async function startServer(props: {
	readonly artifactReader?: StandaloneToolPortalArtifactReader;
	readonly service: StandaloneToolPortalProjectionService;
}): Promise<StandaloneToolPortalMcpHttpServer> {
	const server = await startStandaloneToolPortalMcpHttpServer({
		allowedHosts: ['127.0.0.1', 'localhost'],
		allowedOrigins: ['http://allowed.example'],
		artifactReader: props.artifactReader ?? unusedArtifactReader(),
		credentialSet: credentialSetV1,
		hostname: '127.0.0.1',
		port: 0,
		routePath,
		service: props.service,
	});
	activeServers.push(server);
	return server;
}

describe('standalone Tool Portal MCP Streamable HTTP server', () => {
	it('rejects plaintext non-loopback exposure before creating a listener', async () => {
		const fixture = createServiceFixture();
		await expect(
			startStandaloneToolPortalMcpHttpServer({
				allowedHosts: ['127.0.0.1'],
				allowedOrigins: [],
				artifactReader: unusedArtifactReader(),
				credentialSet: credentialSetV1,
				hostname: '0.0.0.0',
				port: 0,
				routePath,
				service: fixture.service,
			}),
		).rejects.toThrow('must bind a loopback host');
	});

	it('projects exactly four Tool Portal tools and independently authenticates every request', async () => {
		const fixture = createServiceFixture();
		const server = await startServer({ service: fixture.service });
		const session = await initializeSession(server.endpoint, tokenAV1);

		const listed = await sessionRequest(session, { id: 2, method: 'tools/list' });
		const missing = await sessionRequest(session, { id: 3, method: 'tools/list', token: null });
		const wrong = await sessionRequest(session, {
			id: 4,
			method: 'tools/list',
			token: 'wrong-token',
		});

		const listedResult = responseMessage(listed, 2).result;
		if (!isObjectRecord(listedResult) || !Array.isArray(listedResult['tools'])) {
			throw new TypeError('Expected an MCP tools list.');
		}
		expect(
			listedResult['tools'].map((tool: unknown) =>
				isObjectRecord(tool) ? tool['name'] : undefined,
			),
		).toEqual(STANDALONE_TOOL_PORTAL_MCP_TOOL_NAMES);
		expect(missing.response.status).toBe(401);
		expect(wrong.response.status).toBe(401);
	});

	it('rejects spoofed Host and forbidden Origin before authentication', async () => {
		const fixture = createServiceFixture();
		const server = await startServer({ service: fixture.service });
		const body = {
			id: 1,
			jsonrpc: '2.0',
			method: 'initialize',
			params: {
				capabilities: {},
				clientInfo: { name: 'test', version: '1' },
				protocolVersion: mcpProtocolVersion,
			},
		};
		const badHostStatus = await sendRawHttpRequest({
			body,
			headers: {
				accept: 'application/json, text/event-stream',
				authorization: `Bearer ${tokenAV1}`,
				'content-type': 'application/json',
				host: 'attacker.example',
			},
			url: server.endpoint,
		});
		const badOrigin = await fetch(server.endpoint, {
			body: JSON.stringify(body),
			headers: {
				accept: 'application/json, text/event-stream',
				authorization: `Bearer ${tokenAV1}`,
				'content-type': 'application/json',
				origin: 'http://attacker.example',
			},
			method: 'POST',
		});
		const allowedOrigin = await fetch(server.endpoint, {
			body: JSON.stringify(body),
			headers: {
				accept: 'application/json, text/event-stream',
				authorization: `Bearer ${tokenAV1}`,
				'content-type': 'application/json',
				origin: 'http://allowed.example',
			},
			method: 'POST',
		});

		expect(badHostStatus).toBe(400);
		expect(badOrigin.status).toBe(400);
		expect(allowedOrigin.status).toBe(200);
	});

	it('projects all four operations through the injected service under server-derived identity', async () => {
		const fixture = createServiceFixture();
		const server = await startServer({ service: fixture.service });
		const session = await initializeSession(server.endpoint, tokenAV1);
		const calls = [
			{ argumentsValue: { requests: [{ id: 'list' }] }, name: 'tool_portal_list' },
			{
				argumentsValue: { requests: [{ id: 'search', query: 'issue' }] },
				name: 'tool_portal_search',
			},
			{
				argumentsValue: { requests: [{ id: 'describe', refs: [] }] },
				name: 'tool_portal_describe',
			},
			{
				argumentsValue: {
					calls: [{ arguments: {}, id: 'call', name: 'get_issue', namespace: 'github' }],
				},
				name: 'tool_portal_call',
			},
		] as const;

		const responses = await Promise.all(
			calls.map(
				async (call, index) =>
					await sessionRequest(session, {
						argumentsValue: call.argumentsValue,
						id: index + 10,
						method: 'tools/call',
						toolName: call.name,
					}),
			),
		);

		expect(fixture.invocations.map(({ operation }) => operation).toSorted()).toEqual([
			'call',
			'describe',
			'list',
			'search',
		]);
		for (const [index, response] of responses.entries()) {
			expect(responseMessage(response, index + 10).error).toBeUndefined();
		}
		expect(fixture.invocations[0]?.options.authenticatedEnvelope.principal).toEqual({
			...principalA,
			credentialVersion: 1,
		});
	});

	it('carries exact-call HMAC proofs only in protected MCP metadata', async () => {
		const fixture = createServiceFixture();
		const server = await startServer({ service: fixture.service });
		const session = await initializeSession(server.endpoint, tokenAV1);
		const publicArguments = {
			calls: [{ arguments: {}, id: 'protected-call', name: 'create_issue', namespace: 'github' }],
		};
		const response = await sendMcpRequest({
			body: {
				id: 19,
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					_meta: {
						'agent-vm/tool-portal-approval-token': 'signed-exact-batch-proof',
					},
					arguments: publicArguments,
					name: 'tool_portal_call',
				},
			},
			sessionId: session.sessionId,
			token: session.token,
			url: session.url,
		});

		expect(responseMessage(response, 19).error).toBeUndefined();
		expect(fixture.service.call).toHaveBeenCalledWith(
			publicArguments,
			expect.objectContaining({ approvalToken: 'signed-exact-batch-proof' }),
		);
		expect(publicArguments).not.toHaveProperty('approvalToken');
	});

	it('isolates sessions by principal and closes stale sessions after credential rotation', async () => {
		const fixture = createServiceFixture();
		const server = await startServer({ service: fixture.service });
		const sessionA = await initializeSession(server.endpoint, tokenAV1);
		const sessionB = await initializeSession(server.endpoint, tokenBV1);

		const crossPrincipal = await sessionRequest(sessionA, {
			id: 20,
			method: 'tools/list',
			token: tokenBV1,
		});
		await server.activateCredentialSet(credentialSetV2);
		const stale = await sessionRequest(sessionA, { id: 21, method: 'tools/list' });
		const current = await initializeSession(server.endpoint, tokenAV2);

		expect(crossPrincipal.response.status).toBe(401);
		expect(stale.response.status).toBe(401);
		expect(current.sessionId).not.toBe(sessionA.sessionId);
		expect(current.sessionId).not.toBe(sessionB.sessionId);
		expect(server.activeCredentialVersionsByAgent).toEqual({ 'agent-a': 2, 'agent-b': 2 });
	});

	it('retains highest credential versions when an agent is removed and re-added', async () => {
		const fixture = createServiceFixture();
		const server = await startServer({ service: fixture.service });

		await expect(server.activateCredentialSet(credentialSetChangedIdentityV3)).rejects.toThrow(
			'cannot change identity',
		);
		await server.activateCredentialSet(credentialSetAgentAOnlyV3);
		await expect(server.activateCredentialSet(credentialSetRollbackAgentBV1)).rejects.toThrow(
			'credentialVersion must increase for agent "agent-b"',
		);
	});

	it('reauthenticates every artifact read and passes only principal plus MCP surface to storage', async () => {
		const fixture = createServiceFixture();
		const read = vi.fn(
			async (
				props: Parameters<StandaloneToolPortalArtifactReader['read']>[0],
			): Promise<PortalArtifactReadResult> => {
				if (props.caller.authenticatedEnvelope.principal.agentId !== principalA.agentId) {
					throw new Error('Artifact belongs to another principal.');
				}
				return artifactResult;
			},
		);
		const server = await startServer({ artifactReader: { read }, service: fixture.service });
		const sessionA = await initializeSession(server.endpoint, tokenAV1);
		const sessionB = await initializeSession(server.endpoint, tokenBV1);
		const readBody = {
			id: 30,
			jsonrpc: '2.0',
			method: 'resources/read',
			params: {
				_meta: { [artifactReadRequestMetadataKey]: artifactRequest },
				uri: artifactUri,
			},
		};

		const missing = await sendMcpRequest({
			body: readBody,
			sessionId: sessionA.sessionId,
			url: sessionA.url,
		});
		const swapped = await sendMcpRequest({
			body: { ...readBody, id: 31 },
			sessionId: sessionA.sessionId,
			token: tokenBV1,
			url: sessionA.url,
		});
		const crossPrincipal = await sendMcpRequest({
			body: { ...readBody, id: 32 },
			sessionId: sessionB.sessionId,
			token: tokenBV1,
			url: sessionB.url,
		});
		const authorized = await sendMcpRequest({
			body: { ...readBody, id: 33 },
			sessionId: sessionA.sessionId,
			token: tokenAV1,
			url: sessionA.url,
		});

		expect(missing.response.status).toBe(401);
		expect(swapped.response.status).toBe(401);
		expect(responseMessage(crossPrincipal, 32).error).toBeDefined();
		expect(responseMessage(authorized, 33).error).toBeUndefined();
		expect(read).toHaveBeenLastCalledWith({
			caller: {
				authenticatedEnvelope: {
					audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
					principal: { ...principalA, credentialVersion: 1 },
					serviceGeneration: 'standalone-service:1',
				},
				surfaceClass: 'mcp',
			},
			request: artifactRequest,
		});
	});

	it('drains admitted work before completing credential rotation', async () => {
		const listStarted = deferred<void>();
		const listCanFinish = deferred<void>();
		const fixture = createServiceFixture({
			blockListUntil: listCanFinish.promise,
			onListStarted: () => listStarted.resolve(undefined),
		});
		const server = await startServer({ service: fixture.service });
		const session = await initializeSession(server.endpoint, tokenAV1);
		const inFlight = sessionRequest(session, {
			argumentsValue: { requests: [{ id: 'blocked' }] },
			id: 40,
			method: 'tools/call',
			toolName: 'tool_portal_list',
		});
		await listStarted.promise;
		let rotationSettled = false;
		const rotation = server.activateCredentialSet(credentialSetV2).then(() => {
			rotationSettled = true;
		});
		await Promise.resolve();

		expect(rotationSettled).toBe(false);
		listCanFinish.resolve(undefined);
		expect((await inFlight).response.status).toBe(200);
		await rotation;
	});

	it('cuts admission and force-closes work beyond the retirement drain deadline', async () => {
		const listStarted = deferred<void>();
		const listCanFinish = deferred<void>();
		const fixture = createServiceFixture({
			blockListUntil: listCanFinish.promise,
			onListStarted: () => listStarted.resolve(undefined),
		});
		const server = await startServer({ service: fixture.service });
		const session = await initializeSession(server.endpoint, tokenAV1);
		const blockedRequest = sessionRequest(session, {
			argumentsValue: { requests: [{ id: 'blocked-retirement' }] },
			id: 50,
			method: 'tools/call',
			toolName: 'tool_portal_list',
		});
		await listStarted.promise;

		const retirement = server.retire({ drainTimeoutMs: 20 });
		const requestAfterRetirement = sendMcpRequest({
			body: { id: 51, jsonrpc: '2.0', method: 'tools/list', params: {} },
			token: tokenAV1,
			url: server.endpoint,
		}).catch(() => null);

		await expect(retirement).resolves.toBeUndefined();
		const afterRetirement = await requestAfterRetirement;
		expect(afterRetirement === null || afterRetirement.response.status === 503).toBe(true);
		await expect(blockedRequest).rejects.toThrow();
		listCanFinish.resolve(undefined);
		await expect(
			sendMcpRequest({
				body: { id: 52, jsonrpc: '2.0', method: 'tools/list', params: {} },
				token: tokenAV1,
				url: server.endpoint,
			}),
		).rejects.toThrow();
	}, 1_000);
});
