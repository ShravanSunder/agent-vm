import { randomUUID } from 'node:crypto';
import {
	createServer,
	type IncomingMessage,
	type Server as HttpServer,
	type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
	createPortalAgentIdentity,
	type PortalAgentIdentity,
} from '@agent-collaboration/tool-access/authorization';
import { PortalCatalogPreparationError } from '@agent-collaboration/tool-engine/mcp-gateway';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import {
	activeCredentialVersionsByAgent,
	assertNodeHostCredentialPrincipalsUnchanged,
	authenticateNodeHostRequest,
	compileNodeHostCredentialSet,
	finishNodeHostCredentialRequest,
	fixedNodeHostCredentialPrincipals,
	parseNodeHostBearerToken,
	type CompiledNodeHostCredential,
	type NodeHostBearerCredentialSet,
	type NodeHostCredentialSetState,
	waitForNodeHostCredentialDrainDeadline,
} from '#node-host/ingress/bearer-credentials';
import {
	compileNodeHostHttpRequestPolicy,
	nodeHostHttpRequestIsAllowed,
} from '#node-host/ingress/http-request-policy';
import { createNodeMcpServer } from '#node-host/ingress/node-mcp-server';
import type { NodeHostComposition } from '#node-host/node-host-composition';

const defaultRetirementDrainTimeoutMilliseconds = 3_000;

export interface StartNodeHostMcpHttpServerProps {
	readonly composition: NodeHostComposition;
	readonly exposure: 'compact' | 'catalog';
	readonly onDiagnostic?: (
		event: 'authentication-allowed' | 'authentication-denied' | 'server-failed',
	) => void;
	readonly allowedHosts: readonly string[];
	readonly allowedOrigins: readonly string[];
	readonly credentialSet: NodeHostBearerCredentialSet;
	readonly hostname: string;
	readonly port: number;
	readonly routePath: string;
}

export interface NodeHostMcpHttpServer {
	readonly activateCredentialSet: (
		credentialSet: NodeHostBearerCredentialSet,
		props?: { readonly drainTimeoutMs?: number },
	) => Promise<void>;
	readonly activeCredentialVersionsByAgent: Readonly<Record<string, number>>;
	readonly endpoint: URL;
	readonly retire: (props?: { readonly drainTimeoutMs?: number }) => Promise<void>;
}

interface ActiveMcpSession {
	readonly identity: PortalAgentIdentity;
	readonly credentialId: string;
	readonly credentialSetIdentity: string;
	readonly mcpServer: Awaited<ReturnType<typeof createNodeMcpServer>>;
	readonly transport: StreamableHTTPServerTransport;
}

function validateRoutePath(routePath: string): void {
	if (
		!routePath.startsWith('/') ||
		routePath === '/' ||
		routePath.includes('?') ||
		routePath.includes('#')
	) {
		throw new Error('Node Tool Portal MCP route must be an explicit non-root path.');
	}
}

function validatePlaintextListenerHostname(hostname: string): void {
	if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
		throw new Error(
			'Node Tool Portal plaintext HTTP must bind a loopback host; remote listeners require a confidential transport terminator.',
		);
	}
}

type StandaloneMcpErrorKind =
	| 'catalog_preparation_failed'
	| 'body_too_large'
	| 'internal_error'
	| 'invalid_request'
	| 'not_found'
	| 'retiring'
	| 'unauthorized';

function writeJsonErrorResponse(
	response: ServerResponse,
	statusCode: number,
	kind: StandaloneMcpErrorKind,
): void {
	response.writeHead(statusCode, { 'content-type': 'application/json' });
	response.end(JSON.stringify({ error: { kind }, ok: false }));
}

async function listen(
	httpServer: HttpServer,
	hostname: string,
	port: number,
): Promise<AddressInfo> {
	await new Promise<void>((resolve, reject) => {
		httpServer.once('error', reject);
		httpServer.listen(port, hostname, resolve);
	});
	const address = httpServer.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Node Tool Portal MCP listener did not expose a TCP address.');
	}
	return address;
}

function stopHttpServerAdmission(httpServer: HttpServer): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
	});
}

class NodeRequestBodyError extends Error {
	constructor(readonly kind: 'body_too_large' | 'invalid_request') {
		super(kind);
		this.name = 'NodeRequestBodyError';
	}
}

async function readBoundedRequestBody(request: IncomingMessage): Promise<unknown> {
	if (request.method !== 'POST') return undefined;
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		length += bytes.length;
		if (length <= 4 * 1024 * 1024) chunks.push(bytes);
	}
	if (length > 4 * 1024 * 1024) throw new NodeRequestBodyError('body_too_large');
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new NodeRequestBodyError('invalid_request');
	}
	return body;
}

export async function startNodeHostMcpHttpServer(
	props: StartNodeHostMcpHttpServerProps,
): Promise<NodeHostMcpHttpServer> {
	validateRoutePath(props.routePath);
	z.string().min(1).parse(props.hostname);
	validatePlaintextListenerHostname(props.hostname);
	z.number().int().min(0).max(65_535).parse(props.port);
	const requestPolicy = compileNodeHostHttpRequestPolicy(props);
	let activeCredentialSet = compileNodeHostCredentialSet(props.credentialSet);
	const serviceGeneration =
		activeCredentialSet.credentials[0]?.authenticatedEnvelope.serviceGeneration;
	const fixedCredentialPrincipals = fixedNodeHostCredentialPrincipals(activeCredentialSet);
	const credentialStates = new Set<NodeHostCredentialSetState>([activeCredentialSet]);
	const credentialSetIdentities = new Set<string>([activeCredentialSet.identity]);
	const highestCredentialVersionByAgent = new Map(
		Object.entries(activeCredentialVersionsByAgent(activeCredentialSet)),
	);
	const sessions = new Map<string, ActiveMcpSession>();
	let retiring = false;
	let retirement: Promise<void> | undefined;

	async function closeSessionsForCredentialSet(identity: string): Promise<void> {
		const matchingSessions = [...sessions.entries()].filter(
			([, session]) => session.credentialSetIdentity === identity,
		);
		await Promise.all(
			matchingSessions.map(async ([sessionId, session]) => {
				sessions.delete(sessionId);
				await session.mcpServer.close();
				await props.composition.closeSession(session.identity);
			}),
		);
	}

	async function createSession(
		credential: CompiledNodeHostCredential,
		credentialState: NodeHostCredentialSetState,
	): Promise<ActiveMcpSession> {
		const sessionId = randomUUID();
		const identity = createPortalAgentIdentity({
			agentId: credential.principal.agentId,
			agentScopeId: credential.principal.agentId,
			source: 'mcp-proxy-bearer',
			sessionId,
		});
		const transport = new StreamableHTTPServerTransport({
			enableJsonResponse: true,
			onsessionclosed: (closedSessionId) => {
				sessions.delete(closedSessionId);
				void props.composition
					.closeSession(identity)
					.catch(() => props.onDiagnostic?.('server-failed'));
			},
			onsessioninitialized: (initializedSessionId) => {
				sessions.set(initializedSessionId, activeSession);
			},
			sessionIdGenerator: () => sessionId,
		});
		let mcpServer: Awaited<ReturnType<typeof createNodeMcpServer>>;
		try {
			mcpServer = await createNodeMcpServer({
				gateway: props.composition.gatewayFor(credential, sessionId),
				exposure: props.exposure,
			});
		} catch (error) {
			await props.composition.closeSession(identity);
			throw error;
		}
		const activeSession: ActiveMcpSession = {
			identity,
			credentialId: credential.credentialId,
			credentialSetIdentity: credentialState.identity,
			mcpServer,
			transport,
		};
		const bridge: Transport = {
			start: async () => {
				Object.assign(transport, {
					onmessage: bridge.onmessage,
					onclose: bridge.onclose,
					onerror: bridge.onerror,
				});
				await transport.start();
			},
			send: async (message, options) => transport.send(message, options),
			close: async () => transport.close(),
		};
		try {
			await mcpServer.connect(bridge);
		} catch (error) {
			await mcpServer.close();
			await transport.close();
			throw error;
		}
		return activeSession;
	}

	async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!nodeHostHttpRequestIsAllowed(request, requestPolicy)) {
			writeJsonErrorResponse(response, 400, 'invalid_request');
			return;
		}
		const requestUrl = new URL(request.url ?? '/', 'http://tool-portal.invalid');
		if (requestUrl.pathname !== props.routePath || requestUrl.search.length > 0) {
			writeJsonErrorResponse(response, 404, 'not_found');
			return;
		}
		if (retiring) {
			writeJsonErrorResponse(response, 503, 'retiring');
			return;
		}
		const credentialState = activeCredentialSet;
		const credential = authenticateNodeHostRequest(
			parseNodeHostBearerToken(request.headers.authorization),
			credentialState,
		);
		if (credential === null) {
			props.onDiagnostic?.('authentication-denied');
			writeJsonErrorResponse(response, 401, 'unauthorized');
			return;
		}
		props.onDiagnostic?.('authentication-allowed');
		credentialState.inFlightRequests += 1;
		try {
			const parsedBody = await readBoundedRequestBody(request);
			if (retiring || credentialState !== activeCredentialSet) {
				writeJsonErrorResponse(response, 401, 'unauthorized');
				return;
			}
			const sessionIdHeader = request.headers['mcp-session-id'];
			const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;
			if (sessionId !== undefined) {
				const session = sessions.get(sessionId);
				if (
					session === undefined ||
					session.credentialSetIdentity !== credentialState.identity ||
					session.credentialId !== credential.credentialId
				) {
					writeJsonErrorResponse(response, 401, 'unauthorized');
					return;
				}
				await session.transport.handleRequest(request, response, parsedBody);
				return;
			}
			const session = await createSession(credential, credentialState);
			if (retiring || credentialState !== activeCredentialSet) {
				await session.mcpServer.close();
				writeJsonErrorResponse(response, 401, 'unauthorized');
				return;
			}
			await session.transport.handleRequest(request, response, parsedBody);
			if (session.transport.sessionId === undefined) {
				await session.mcpServer.close();
			}
		} finally {
			finishNodeHostCredentialRequest(credentialState);
		}
	}

	const httpServer = createServer((request, response) => {
		void handleRequest(request, response).catch((error: unknown) => {
			if (!response.headersSent && error instanceof NodeRequestBodyError) {
				writeJsonErrorResponse(response, error.kind === 'body_too_large' ? 413 : 400, error.kind);
				return;
			}
			if (!response.headersSent && error instanceof PortalCatalogPreparationError) {
				writeJsonErrorResponse(response, 503, 'catalog_preparation_failed');
				return;
			}
			props.onDiagnostic?.('server-failed');
			if (!response.headersSent) {
				writeJsonErrorResponse(response, 500, 'internal_error');
			} else {
				response.destroy();
			}
		});
	});
	const address = await listen(httpServer, props.hostname, props.port);
	const endpoint = new URL(
		`http://${props.hostname.includes(':') ? `[${props.hostname}]` : props.hostname}:${String(address.port)}${props.routePath}`,
	);

	async function activateCredentialSet(
		credentialSet: NodeHostBearerCredentialSet,
		activateProps: { readonly drainTimeoutMs?: number } = {},
	): Promise<void> {
		if (retiring) throw new Error('Node Tool Portal MCP server is retiring.');
		const drainTimeoutMs = z
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.parse(activateProps.drainTimeoutMs ?? defaultRetirementDrainTimeoutMilliseconds);
		const nextCredentialSet = compileNodeHostCredentialSet(credentialSet);
		assertNodeHostCredentialPrincipalsUnchanged(nextCredentialSet, fixedCredentialPrincipals);
		if (
			nextCredentialSet.credentials[0]?.authenticatedEnvelope.serviceGeneration !==
			serviceGeneration
		) {
			throw new Error('Node Tool Portal MCP credential rotation cannot change service generation.');
		}
		if (credentialSetIdentities.has(nextCredentialSet.identity)) {
			throw new Error('Node Tool Portal MCP credential set must have a new version.');
		}
		for (const nextCredential of nextCredentialSet.credentials) {
			const highestCredentialVersion = highestCredentialVersionByAgent.get(
				nextCredential.principal.agentId,
			);
			if (
				highestCredentialVersion !== undefined &&
				nextCredential.credentialVersion <= highestCredentialVersion
			) {
				throw new Error(
					`Node Tool Portal MCP credentialVersion must increase for agent "${nextCredential.principal.agentId}".`,
				);
			}
		}
		const previousCredentialSet = activeCredentialSet;
		for (const nextCredential of nextCredentialSet.credentials) {
			highestCredentialVersionByAgent.set(
				nextCredential.principal.agentId,
				nextCredential.credentialVersion,
			);
		}
		credentialSetIdentities.add(nextCredentialSet.identity);
		credentialStates.add(nextCredentialSet);
		activeCredentialSet = nextCredentialSet;
		props.composition.activateCredentials(credentialSet);
		await waitForNodeHostCredentialDrainDeadline(previousCredentialSet, drainTimeoutMs);
		await closeSessionsForCredentialSet(previousCredentialSet.identity);
		credentialStates.delete(previousCredentialSet);
	}

	function retire(retireProps: { readonly drainTimeoutMs?: number } = {}): Promise<void> {
		if (retirement !== undefined) return retirement;
		const drainTimeoutMs = z
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.parse(retireProps.drainTimeoutMs ?? defaultRetirementDrainTimeoutMilliseconds);
		retirement = (async () => {
			retiring = true;
			const listenerClosed = stopHttpServerAdmission(httpServer);
			await Promise.all(
				[...credentialStates].map(
					async (credentialState) =>
						await waitForNodeHostCredentialDrainDeadline(credentialState, drainTimeoutMs),
				),
			);
			const sessionClosures = [...sessions.values()].map(
				async (session) => await session.mcpServer.close(),
			);
			sessions.clear();
			httpServer.closeAllConnections();
			await Promise.allSettled(sessionClosures);
			await listenerClosed;
		})();
		return retirement;
	}

	return {
		activateCredentialSet,
		get activeCredentialVersionsByAgent() {
			return activeCredentialVersionsByAgent(activeCredentialSet);
		},
		endpoint,
		retire,
	};
}
