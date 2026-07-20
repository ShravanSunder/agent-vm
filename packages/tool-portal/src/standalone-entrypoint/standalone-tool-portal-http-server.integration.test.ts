import { request as sendHttpRequest } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	TOOL_PORTAL_MCP_BEARER_AUDIENCE,
	type StandaloneToolPortalBearerCredentialSet,
} from './standalone-tool-portal-bearer-credentials.js';
import {
	STANDALONE_TOOL_PORTAL_HTTP_APPROVAL_HEADER,
	startStandaloneToolPortalHttpServer,
	type StandaloneToolPortalHttpServer,
} from './standalone-tool-portal-http-server.js';
import type { StandaloneToolPortalProjectionService } from './standalone-tool-portal-mcp-projection.js';

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

function credentialSet(props: {
	readonly includeAgentB?: boolean;
	readonly version: number;
}): StandaloneToolPortalBearerCredentialSet {
	return {
		audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
		credentials: [
			{
				bearerToken: `agent-a-token-v${String(props.version)}`,
				credentialVersion: props.version,
				principal: principalA,
			},
			...(props.includeAgentB === false
				? []
				: [
						{
							bearerToken: `agent-b-token-v${String(props.version)}`,
							credentialVersion: props.version,
							principal: principalB,
						},
					]),
		],
		serviceGeneration: 'standalone-service:1',
	};
}

interface Deferred {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
}

function deferred(): Deferred {
	let resolver: (() => void) | undefined;
	return {
		promise: new Promise<void>((resolve) => {
			resolver = resolve;
		}),
		resolve: () => {
			if (resolver === undefined) throw new Error('Deferred resolver was not initialized.');
			resolver();
		},
	};
}

function createService(blockListUntil?: Promise<void>): StandaloneToolPortalProjectionService {
	return {
		call: vi.fn(async (request: Parameters<StandaloneToolPortalProjectionService['call']>[0]) => ({
			items: request.calls.map((call) => ({
				id: call.id,
				operationId: `operation:${call.id}`,
				outcome: {
					certainty: 'proven' as const,
					completion: 'succeeded' as const,
					kind: 'completed' as const,
					retryClass: 'forbidden' as const,
				},
				owningGeneration: 'standalone-service:1',
				status: 'ok' as const,
				value: { output: 'done' },
			})),
			ok: true,
		})),
		describe: vi.fn(
			async (request: Parameters<StandaloneToolPortalProjectionService['describe']>[0]) => ({
				items: request.requests.map(({ id }) => ({
					id,
					status: 'ok' as const,
					value: { tools: [] },
				})),
				ok: true,
			}),
		),
		list: vi.fn(async (request: Parameters<StandaloneToolPortalProjectionService['list']>[0]) => {
			await blockListUntil;
			return {
				items: request.requests.map(({ id }) => ({
					id,
					status: 'ok' as const,
					value: { namespaces: ['github'], tools: [] },
				})),
				ok: true,
			};
		}),
		search: vi.fn(
			async (request: Parameters<StandaloneToolPortalProjectionService['search']>[0]) => ({
				items: request.requests.map(({ id }) => ({
					id,
					status: 'ok' as const,
					value: { tools: [] },
				})),
				ok: true,
			}),
		),
	};
}

const activeServers: StandaloneToolPortalHttpServer[] = [];

afterEach(async () => {
	await Promise.allSettled(activeServers.splice(0).map(async (server) => await server.retire()));
});

async function startServer(
	service: StandaloneToolPortalProjectionService,
): Promise<StandaloneToolPortalHttpServer> {
	const server = await startStandaloneToolPortalHttpServer({
		allowedHosts: ['127.0.0.1', 'localhost'],
		allowedOrigins: ['http://allowed.example'],
		credentialSet: credentialSet({ version: 1 }),
		hostname: '127.0.0.1',
		port: 0,
		routePath: '/tool-portal/http',
		service,
	});
	activeServers.push(server);
	return server;
}

async function sendRequest(props: {
	readonly body: unknown;
	readonly headers?: Readonly<Record<string, string>>;
	readonly server: StandaloneToolPortalHttpServer;
	readonly token?: string;
}): Promise<Response> {
	return await fetch(props.server.endpoint, {
		body: JSON.stringify(props.body),
		headers: {
			authorization: `Bearer ${props.token ?? 'agent-a-token-v1'}`,
			'content-type': 'application/json',
			...props.headers,
		},
		method: 'POST',
	});
}

async function sendWithHost(props: {
	readonly body: unknown;
	readonly host?: string;
	readonly requestTarget?: string;
	readonly server: StandaloneToolPortalHttpServer;
}): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const request = sendHttpRequest(
			{
				headers: {
					authorization: 'Bearer agent-a-token-v1',
					'content-type': 'application/json',
					...(props.host === undefined ? {} : { host: props.host }),
				},
				hostname: props.server.endpoint.hostname,
				method: 'POST',
				path: props.requestTarget ?? props.server.endpoint.pathname,
				port: props.server.endpoint.port,
				setHost: props.host !== undefined,
			},
			(response) => {
				response.resume();
				response.once('end', () => resolve(response.statusCode ?? 0));
			},
		);
		request.once('error', reject);
		request.end(JSON.stringify(props.body));
	});
}

describe('standalone Tool Portal direct JSON HTTP server', () => {
	it('projects four operations with server-derived identity and protected-header approval', async () => {
		const service = createService();
		const server = await startServer(service);
		const requests = [
			{ operation: 'list', request: { requests: [{ id: 'list' }] } },
			{ operation: 'search', request: { requests: [{ id: 'search', query: 'issue' }] } },
			{ operation: 'describe', request: { requests: [{ id: 'describe', refs: [] }] } },
			{
				operation: 'call',
				request: {
					calls: [{ arguments: {}, id: 'call', name: 'create_issue', namespace: 'github' }],
				},
			},
		] as const;

		const responses = await Promise.all(
			requests.map(
				async (body) =>
					await sendRequest({
						body,
						headers:
							body.operation === 'call'
								? { [STANDALONE_TOOL_PORTAL_HTTP_APPROVAL_HEADER]: 'signed-batch-proof' }
								: {},
						server,
					}),
			),
		);

		expect(responses.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
		expect(service.call).toHaveBeenCalledWith(
			requests[3].request,
			expect.objectContaining({
				approvalToken: 'signed-batch-proof',
				authenticatedEnvelope: expect.objectContaining({
					principal: expect.objectContaining({ agentId: 'agent-a' }),
				}),
				surfaceClass: 'http',
			}),
		);
		expect(JSON.stringify(requests[3])).not.toContain('signed-batch-proof');
	});

	it('enforces bearer, Host, Origin, and loopback plaintext policy', async () => {
		const service = createService();
		const server = await startServer(service);
		const body = { operation: 'list', request: { requests: [{ id: 'list' }] } };

		const badBearer = await sendRequest({ body, server, token: 'wrong' });
		const badHostStatus = await sendWithHost({ body, host: 'attacker.example', server });
		const missingHostStatus = await sendWithHost({ body, server });
		const absoluteFormStatus = await sendWithHost({
			body,
			host: '127.0.0.1',
			requestTarget: server.endpoint.href,
			server,
		});
		const badOrigin = await sendRequest({
			body,
			headers: { origin: 'http://attacker.example' },
			server,
		});
		const allowedOrigin = await sendRequest({
			body,
			headers: { origin: 'http://allowed.example' },
			server,
		});

		expect(badBearer.status).toBe(401);
		expect(badHostStatus).toBe(400);
		expect(missingHostStatus).toBe(400);
		expect(absoluteFormStatus).toBe(400);
		expect(badOrigin.status).toBe(400);
		expect(allowedOrigin.status).toBe(200);
		await expect(
			startStandaloneToolPortalHttpServer({
				allowedHosts: ['0.0.0.0'],
				allowedOrigins: [],
				credentialSet: credentialSet({ version: 1 }),
				hostname: '0.0.0.0',
				port: 0,
				routePath: '/tool-portal/http',
				service,
			}),
		).rejects.toThrow('loopback');
	});

	it('bounds rotation drain and rejects removed-agent credential rollback', async () => {
		const listCanFinish = deferred();
		const service = createService(listCanFinish.promise);
		const server = await startServer(service);
		const inFlight = sendRequest({
			body: { operation: 'list', request: { requests: [{ id: 'blocked' }] } },
			server,
		});
		await vi.waitFor(() => expect(service.list).toHaveBeenCalledOnce());

		await expect(
			server.activateCredentialSet({
				audience: TOOL_PORTAL_MCP_BEARER_AUDIENCE,
				credentials: [
					{
						bearerToken: 'agent-a-token-v2-changed-profile',
						credentialVersion: 2,
						principal: { ...principalA, toolPortalProfileId: 'administrator' },
					},
				],
				serviceGeneration: 'standalone-service:1',
			}),
		).rejects.toThrow('cannot change identity');
		await expect(
			server.activateCredentialSet(credentialSet({ includeAgentB: false, version: 2 }), {
				drainTimeoutMs: 10,
			}),
		).resolves.toBeUndefined();
		await expect(server.activateCredentialSet(credentialSet({ version: 1 }))).rejects.toThrow(
			'credentialVersion must increase',
		);
		listCanFinish.resolve();
		expect((await inFlight).status).toBe(200);
	});
});
