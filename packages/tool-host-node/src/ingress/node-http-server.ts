import {
	createServer,
	type IncomingMessage,
	type Server as HttpServer,
	type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
	resolveToolLoading,
	toolLoadingMode,
	PortalCatalogPreparationError,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
	activeCredentialVersionsByAgent,
	assertNodeHostCredentialPrincipalsUnchanged,
	authenticateNodeHostRequest,
	compileNodeHostCredentialSet,
	finishNodeHostCredentialRequest,
	fixedNodeHostCredentialPrincipals,
	parseNodeHostBearerToken,
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
	constructor(readonly kind: 'invalid_request') {
		super(kind);
		this.name = 'NodeRequestBodyError';
	}
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
	if (request.method !== 'POST') return undefined;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		chunks.push(bytes);
	}
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
	let retiring = false;
	let retirement: Promise<void> | undefined;

	async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!nodeHostHttpRequestIsAllowed(request, requestPolicy)) {
			writeJsonErrorResponse(response, 400, 'invalid_request');
			return;
		}
		const requestUrl = new URL(request.url ?? '/', 'http://tool-portal.invalid');
		if (requestUrl.pathname !== props.routePath) {
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
			const parsedBody = await readRequestBody(request);
			if (retiring || credentialState !== activeCredentialSet) {
				writeJsonErrorResponse(response, 401, 'unauthorized');
				return;
			}
			const mode = toolLoadingMode(resolveToolLoading(requestUrl));
			const preparation: { error?: PortalCatalogPreparationError } = {};
			const handler = createMcpHandler(
				async () => {
					const gateway = props.composition.gatewayFor(credential);
					// The SDK calls the factory only after version, metadata and header validation.
					if (mode === 'direct' && request.headers['mcp-method'] === 'tools/list')
						await gateway.prepareCatalog();
					return createNodeMcpServer({ gateway, mode });
				},
				{
					legacy: 'reject',
					onerror: (error) => {
						if (error instanceof PortalCatalogPreparationError) preparation.error = error;
					},
				},
			);
			await toNodeHandler({
				fetch: async (fetchRequest, options) => {
					const result = await handler.fetch(fetchRequest, options);
					if (preparation.error === undefined) return result;
					return Response.json(
						{
							ok: false,
							error: {
								kind: 'catalog_preparation_failed',
								failedNamespaces: preparation.error.failedNamespaces,
								refusals: preparation.error.refusals,
							},
						},
						{ status: 503 },
					);
				},
			})(
				{
					method: request.method ?? 'POST',
					url: request.url ?? '/',
					headers: request.headers,
					[Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
				},
				response,
				parsedBody,
			);
		} finally {
			finishNodeHostCredentialRequest(credentialState);
		}
	}

	const httpServer = createServer((request, response) => {
		void handleRequest(request, response).catch((error: unknown) => {
			if (!response.headersSent && error instanceof NodeRequestBodyError) {
				writeJsonErrorResponse(response, 400, error.kind);
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
			httpServer.closeAllConnections();
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
