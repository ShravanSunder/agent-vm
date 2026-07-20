import { randomUUID } from 'node:crypto';
import {
	createServer,
	type IncomingMessage,
	type Server as HttpServer,
	type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-vm/agent-portal-sdk';
import { z } from 'zod';

import {
	activeCredentialVersionsByAgent,
	assertStandaloneToolPortalCredentialPrincipalsUnchanged,
	authenticateStandaloneToolPortalRequest,
	compileStandaloneToolPortalCredentialSet,
	finishStandaloneToolPortalCredentialRequest,
	fixedStandaloneToolPortalCredentialPrincipals,
	parseStandaloneToolPortalBearerToken,
	type StandaloneToolPortalBearerCredentialSet,
	type StandaloneToolPortalCredentialSetState,
	waitForStandaloneToolPortalCredentialDrainDeadline,
} from './standalone-tool-portal-bearer-credentials.js';
import {
	compileStandaloneToolPortalHttpRequestPolicy,
	standaloneToolPortalHttpRequestIsAllowed,
} from './standalone-tool-portal-http-request-policy.js';
import type { StandaloneToolPortalProjectionService } from './standalone-tool-portal-mcp-projection.js';

export const STANDALONE_TOOL_PORTAL_HTTP_APPROVAL_HEADER = 'x-agent-vm-tool-portal-approval-token';

const maximumRequestBytes = 64 * 1_024;
const defaultDrainTimeoutMilliseconds = 3_000;

const StandaloneToolPortalHttpRequestSchema = z.discriminatedUnion('operation', [
	z.object({ operation: z.literal('call'), request: PortalCallRequestSchema }).strict(),
	z.object({ operation: z.literal('describe'), request: PortalDescribeRequestSchema }).strict(),
	z.object({ operation: z.literal('list'), request: PortalListRequestSchema }).strict(),
	z.object({ operation: z.literal('search'), request: PortalSearchRequestSchema }).strict(),
]);

export interface StartStandaloneToolPortalHttpServerProps {
	readonly allowedHosts: readonly string[];
	readonly allowedOrigins: readonly string[];
	readonly credentialSet: StandaloneToolPortalBearerCredentialSet;
	readonly hostname: string;
	readonly port: number;
	readonly routePath: string;
	readonly service: StandaloneToolPortalProjectionService;
}

export interface StandaloneToolPortalHttpServer {
	readonly activateCredentialSet: (
		credentialSet: StandaloneToolPortalBearerCredentialSet,
		props?: { readonly drainTimeoutMs?: number },
	) => Promise<void>;
	readonly activeCredentialVersionsByAgent: Readonly<Record<string, number>>;
	readonly endpoint: URL;
	readonly retire: (props?: { readonly drainTimeoutMs?: number }) => Promise<void>;
	readonly service: StandaloneToolPortalProjectionService;
}

function validateListener(hostname: string, port: number, routePath: string): void {
	if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) {
		throw new Error('Standalone Tool Portal plaintext HTTP must bind a loopback host.');
	}
	if (!routePath.startsWith('/') || routePath === '/' || routePath.includes('?')) {
		throw new Error('Standalone Tool Portal HTTP route must be an explicit non-root path.');
	}
	z.number().int().min(0).max(65_535).parse(port);
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
	response.writeHead(statusCode, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
	const contentLength = request.headers['content-length'];
	if (contentLength !== undefined && Number(contentLength) > maximumRequestBytes) {
		throw new RangeError('request-too-large');
	}
	const chunks: Buffer[] = [];
	let receivedBytes = 0;
	for await (const chunk of request) {
		if (!Buffer.isBuffer(chunk))
			throw new TypeError('Standalone Tool Portal HTTP body is not bytes.');
		const bytes = chunk;
		receivedBytes += bytes.length;
		if (receivedBytes > maximumRequestBytes) throw new RangeError('request-too-large');
		chunks.push(bytes);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function listen(server: HttpServer, hostname: string, port: number): Promise<AddressInfo> {
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, hostname, resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('HTTP listener failed.');
	return address;
}

function closeListener(server: HttpServer): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});
}

export async function startStandaloneToolPortalHttpServer(
	props: StartStandaloneToolPortalHttpServerProps,
): Promise<StandaloneToolPortalHttpServer> {
	validateListener(props.hostname, props.port, props.routePath);
	const requestPolicy = compileStandaloneToolPortalHttpRequestPolicy(props);
	let activeCredentialSet = compileStandaloneToolPortalCredentialSet(props.credentialSet);
	const serviceGeneration =
		activeCredentialSet.credentials[0]?.authenticatedEnvelope.serviceGeneration;
	const fixedCredentialPrincipals =
		fixedStandaloneToolPortalCredentialPrincipals(activeCredentialSet);
	const credentialStates = new Set<StandaloneToolPortalCredentialSetState>([activeCredentialSet]);
	const highestCredentialVersionByAgent = new Map(
		Object.entries(activeCredentialVersionsByAgent(activeCredentialSet)),
	);
	let retiring = false;
	let retirement: Promise<void> | undefined;

	async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!standaloneToolPortalHttpRequestIsAllowed(request, requestPolicy)) {
			writeJson(response, 400, { error: { kind: 'invalid_request' }, ok: false });
			return;
		}
		const requestUrl = new URL(request.url ?? '/', 'http://tool-portal.invalid');
		if (request.method !== 'POST' || requestUrl.pathname !== props.routePath || requestUrl.search) {
			writeJson(response, 404, { error: { kind: 'not_found' }, ok: false });
			return;
		}
		if (retiring) {
			writeJson(response, 503, { error: { kind: 'retiring' }, ok: false });
			return;
		}
		const credentialState = activeCredentialSet;
		const credential = authenticateStandaloneToolPortalRequest(
			parseStandaloneToolPortalBearerToken(request.headers.authorization),
			credentialState,
		);
		if (credential === null) {
			writeJson(response, 401, { error: { kind: 'unauthorized' }, ok: false });
			return;
		}
		credentialState.inFlightRequests += 1;
		try {
			const parsed = StandaloneToolPortalHttpRequestSchema.parse(await readBoundedJson(request));
			const rawApprovalHeader = request.headers[STANDALONE_TOOL_PORTAL_HTTP_APPROVAL_HEADER];
			if (rawApprovalHeader !== undefined && typeof rawApprovalHeader !== 'string') {
				throw new TypeError('Standalone Tool Portal approval header must occur once.');
			}
			const approvalToken =
				typeof rawApprovalHeader === 'string'
					? z.string().min(1).max(16_384).parse(rawApprovalHeader)
					: undefined;
			const options = {
				...(approvalToken === undefined ? {} : { approvalToken }),
				authenticatedEnvelope: credential.authenticatedEnvelope,
				correlation: { sessionId: `standalone-http:${randomUUID()}` },
				surfaceClass: 'http' as const,
			};
			const result =
				parsed.operation === 'call'
					? await props.service.call(parsed.request, options)
					: parsed.operation === 'describe'
						? await props.service.describe(parsed.request, options)
						: parsed.operation === 'list'
							? await props.service.list(parsed.request, options)
							: await props.service.search(parsed.request, options);
			writeJson(response, 200, result);
		} catch (error) {
			writeJson(response, error instanceof RangeError ? 413 : 400, {
				error: { kind: error instanceof RangeError ? 'request_too_large' : 'invalid_request' },
				ok: false,
			});
		} finally {
			finishStandaloneToolPortalCredentialRequest(credentialState);
		}
	}

	const server = createServer((request, response) => {
		void handleRequest(request, response).catch(() => {
			if (!response.headersSent)
				writeJson(response, 500, { error: { kind: 'internal_error' }, ok: false });
			else response.destroy();
		});
	});
	const address = await listen(server, props.hostname, props.port);
	const endpoint = new URL(`http://${props.hostname}:${String(address.port)}${props.routePath}`);

	async function activateCredentialSet(
		credentialSet: StandaloneToolPortalBearerCredentialSet,
		activateProps: { readonly drainTimeoutMs?: number } = {},
	): Promise<void> {
		if (retiring) throw new Error('Standalone Tool Portal HTTP server is retiring.');
		const drainTimeoutMs = z
			.number()
			.int()
			.positive()
			.parse(activateProps.drainTimeoutMs ?? defaultDrainTimeoutMilliseconds);
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
				'Standalone Tool Portal HTTP credential rotation cannot change service generation.',
			);
		}
		for (const credential of nextCredentialSet.credentials) {
			const highestVersion = highestCredentialVersionByAgent.get(credential.principal.agentId);
			if (highestVersion !== undefined && credential.credentialVersion <= highestVersion) {
				throw new Error(
					`Standalone Tool Portal HTTP credentialVersion must increase for agent "${credential.principal.agentId}".`,
				);
			}
		}
		const previousCredentialSet = activeCredentialSet;
		for (const credential of nextCredentialSet.credentials) {
			highestCredentialVersionByAgent.set(
				credential.principal.agentId,
				credential.credentialVersion,
			);
		}
		credentialStates.add(nextCredentialSet);
		activeCredentialSet = nextCredentialSet;
		await waitForStandaloneToolPortalCredentialDrainDeadline(previousCredentialSet, drainTimeoutMs);
		credentialStates.delete(previousCredentialSet);
	}

	function retire(retireProps: { readonly drainTimeoutMs?: number } = {}): Promise<void> {
		if (retirement !== undefined) return retirement;
		const drainTimeoutMs = z
			.number()
			.int()
			.positive()
			.parse(retireProps.drainTimeoutMs ?? defaultDrainTimeoutMilliseconds);
		retirement = (async () => {
			retiring = true;
			const listenerClosed = closeListener(server);
			await Promise.all(
				[...credentialStates].map(
					async (state) =>
						await waitForStandaloneToolPortalCredentialDrainDeadline(state, drainTimeoutMs),
				),
			);
			server.closeAllConnections();
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
