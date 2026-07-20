import { randomUUID } from 'node:crypto';
import {
	createServer,
	type IncomingMessage,
	type Server as HttpServer,
	type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
	activeCredentialVersionsByAgent,
	assertStandaloneToolPortalCredentialPrincipalsUnchanged,
	authenticateStandaloneToolPortalRequest,
	compileStandaloneToolPortalCredentialSet,
	finishStandaloneToolPortalCredentialRequest,
	fixedStandaloneToolPortalCredentialPrincipals,
	parseStandaloneToolPortalBearerToken,
	type CompiledStandaloneToolPortalCredential,
	type StandaloneToolPortalBearerCredentialSet,
	type StandaloneToolPortalCredentialSetState,
	waitForStandaloneToolPortalCredentialDrainDeadline,
} from './standalone-tool-portal-bearer-credentials.js';
import {
	compileStandaloneToolPortalHttpRequestPolicy,
	standaloneToolPortalHttpRequestIsAllowed,
} from './standalone-tool-portal-http-request-policy.js';
import {
	createStandaloneToolPortalMcpServer,
	createStandaloneToolPortalTransportBridge,
	type StandaloneToolPortalArtifactReader,
	type StandaloneToolPortalProjectionService,
} from './standalone-tool-portal-mcp-projection.js';

const defaultRetirementDrainTimeoutMilliseconds = 3_000;

export interface StartStandaloneToolPortalMcpHttpServerProps {
	readonly artifactReader: StandaloneToolPortalArtifactReader;
	readonly allowedHosts: readonly string[];
	readonly allowedOrigins: readonly string[];
	readonly credentialSet: StandaloneToolPortalBearerCredentialSet;
	readonly hostname: string;
	readonly port: number;
	readonly routePath: string;
	readonly service: StandaloneToolPortalProjectionService;
}

export interface StandaloneToolPortalMcpHttpServer {
	readonly activateCredentialSet: (
		credentialSet: StandaloneToolPortalBearerCredentialSet,
		props?: { readonly drainTimeoutMs?: number },
	) => Promise<void>;
	readonly activeCredentialVersionsByAgent: Readonly<Record<string, number>>;
	readonly endpoint: URL;
	readonly retire: (props?: { readonly drainTimeoutMs?: number }) => Promise<void>;
	readonly service: StandaloneToolPortalProjectionService;
}

interface ActiveMcpSession {
	readonly credentialId: string;
	readonly credentialSetIdentity: string;
	readonly mcpServer: ReturnType<typeof createStandaloneToolPortalMcpServer>;
	readonly transport: StreamableHTTPServerTransport;
}

function validateRoutePath(routePath: string): void {
	if (
		!routePath.startsWith('/') ||
		routePath === '/' ||
		routePath.includes('?') ||
		routePath.includes('#')
	) {
		throw new Error('Standalone Tool Portal MCP route must be an explicit non-root path.');
	}
}

function validatePlaintextListenerHostname(hostname: string): void {
	if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
		throw new Error(
			'Standalone Tool Portal plaintext HTTP must bind a loopback host; remote listeners require a confidential transport terminator.',
		);
	}
}

type StandaloneMcpErrorKind =
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
		throw new Error('Standalone Tool Portal MCP listener did not expose a TCP address.');
	}
	return address;
}

function stopHttpServerAdmission(httpServer: HttpServer): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
	});
}

export async function startStandaloneToolPortalMcpHttpServer(
	props: StartStandaloneToolPortalMcpHttpServerProps,
): Promise<StandaloneToolPortalMcpHttpServer> {
	validateRoutePath(props.routePath);
	z.string().min(1).parse(props.hostname);
	validatePlaintextListenerHostname(props.hostname);
	z.number().int().min(0).max(65_535).parse(props.port);
	const requestPolicy = compileStandaloneToolPortalHttpRequestPolicy(props);
	let activeCredentialSet = compileStandaloneToolPortalCredentialSet(props.credentialSet);
	const serviceGeneration =
		activeCredentialSet.credentials[0]?.authenticatedEnvelope.serviceGeneration;
	const fixedCredentialPrincipals =
		fixedStandaloneToolPortalCredentialPrincipals(activeCredentialSet);
	const credentialStates = new Set<StandaloneToolPortalCredentialSetState>([activeCredentialSet]);
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
			}),
		);
	}

	async function createSession(
		credential: CompiledStandaloneToolPortalCredential,
		credentialState: StandaloneToolPortalCredentialSetState,
	): Promise<ActiveMcpSession> {
		const sessionId = randomUUID();
		const transport = new StreamableHTTPServerTransport({
			enableJsonResponse: true,
			onsessionclosed: (closedSessionId) => {
				sessions.delete(closedSessionId);
			},
			onsessioninitialized: (initializedSessionId) => {
				sessions.set(initializedSessionId, activeSession);
			},
			sessionIdGenerator: () => sessionId,
		});
		const mcpServer = createStandaloneToolPortalMcpServer({
			artifactReader: props.artifactReader,
			authenticatedEnvelope: credential.authenticatedEnvelope,
			service: props.service,
			sessionId,
		});
		const activeSession: ActiveMcpSession = {
			credentialId: credential.credentialId,
			credentialSetIdentity: credentialState.identity,
			mcpServer,
			transport,
		};
		await mcpServer.connect(createStandaloneToolPortalTransportBridge(transport));
		return activeSession;
	}

	async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!standaloneToolPortalHttpRequestIsAllowed(request, requestPolicy)) {
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
		const credential = authenticateStandaloneToolPortalRequest(
			parseStandaloneToolPortalBearerToken(request.headers.authorization),
			credentialState,
		);
		if (credential === null) {
			writeJsonErrorResponse(response, 401, 'unauthorized');
			return;
		}
		credentialState.inFlightRequests += 1;
		try {
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
				await session.transport.handleRequest(request, response);
				return;
			}
			const session = await createSession(credential, credentialState);
			await session.transport.handleRequest(request, response);
			if (session.transport.sessionId === undefined) {
				await session.mcpServer.close();
			}
		} finally {
			finishStandaloneToolPortalCredentialRequest(credentialState);
		}
	}

	const httpServer = createServer((request, response) => {
		void handleRequest(request, response).catch(() => {
			if (!response.headersSent) {
				writeJsonErrorResponse(response, 500, 'internal_error');
			} else {
				response.destroy();
			}
		});
	});
	const address = await listen(httpServer, props.hostname, props.port);
	const endpoint = new URL(`http://${props.hostname}:${String(address.port)}${props.routePath}`);

	async function activateCredentialSet(
		credentialSet: StandaloneToolPortalBearerCredentialSet,
		activateProps: { readonly drainTimeoutMs?: number } = {},
	): Promise<void> {
		if (retiring) throw new Error('Standalone Tool Portal MCP server is retiring.');
		const drainTimeoutMs = z
			.number()
			.int()
			.positive()
			.max(Number.MAX_SAFE_INTEGER)
			.parse(activateProps.drainTimeoutMs ?? defaultRetirementDrainTimeoutMilliseconds);
		const nextCredentialSet = compileStandaloneToolPortalCredentialSet(credentialSet);
		assertStandaloneToolPortalCredentialPrincipalsUnchanged(
			nextCredentialSet,
			fixedCredentialPrincipals,
		);
		if (
			nextCredentialSet.credentials[0]?.authenticatedEnvelope.serviceGeneration !==
			serviceGeneration
		) {
			throw new Error(
				'Standalone Tool Portal MCP credential rotation cannot change service generation.',
			);
		}
		if (credentialSetIdentities.has(nextCredentialSet.identity)) {
			throw new Error('Standalone Tool Portal MCP credential set must have a new version.');
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
					`Standalone Tool Portal MCP credentialVersion must increase for agent "${nextCredential.principal.agentId}".`,
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
		await waitForStandaloneToolPortalCredentialDrainDeadline(previousCredentialSet, drainTimeoutMs);
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
						await waitForStandaloneToolPortalCredentialDrainDeadline(
							credentialState,
							drainTimeoutMs,
						),
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
		service: props.service,
	};
}
