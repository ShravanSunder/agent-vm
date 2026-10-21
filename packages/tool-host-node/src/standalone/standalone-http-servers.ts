import { randomUUID } from 'node:crypto';

import {
	PortalCallRequestSchema,
	PortalDescribeRequestSchema,
	PortalListRequestSchema,
	PortalSearchRequestSchema,
} from '@agent-collaboration/tool-access/contracts';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { NodeHostBearerCredentialSet } from '#node-host/ingress/bearer-credentials';
import {
	startNodeAuthenticatedHttpServer,
	type NodeAuthenticatedHttpServer,
} from '#node-host/ingress/node-authenticated-http-server';
import { createStandaloneToolPortalMcpServer } from '#node-host/standalone/standalone-mcp-server';
import type {
	StandaloneToolPortalArtifactReader,
	StandaloneToolPortalProjectionService,
} from '#node-host/standalone/standalone-portal-contracts';

export const STANDALONE_TOOL_PORTAL_HTTP_APPROVAL_HEADER = 'x-agent-vm-tool-portal-approval-token';
const standaloneJsonRequest = z.discriminatedUnion('operation', [
	z.strictObject({ operation: z.literal('call'), request: PortalCallRequestSchema }),
	z.strictObject({ operation: z.literal('list'), request: PortalListRequestSchema }),
	z.strictObject({ operation: z.literal('search'), request: PortalSearchRequestSchema }),
	z.strictObject({ operation: z.literal('describe'), request: PortalDescribeRequestSchema }),
]);

export interface StartStandaloneToolPortalHttpServerProps {
	readonly allowedHosts: readonly string[];
	readonly allowedOrigins: readonly string[];
	readonly credentialSet: NodeHostBearerCredentialSet;
	readonly hostname: string;
	readonly port: number;
	readonly routePath: string;
	readonly service: StandaloneToolPortalProjectionService;
}
export interface StandaloneToolPortalHttpServer extends NodeAuthenticatedHttpServer {
	readonly service: StandaloneToolPortalProjectionService;
}
export interface StartStandaloneToolPortalMcpHttpServerProps extends StartStandaloneToolPortalHttpServerProps {
	readonly artifactReader: StandaloneToolPortalArtifactReader;
}

export async function startStandaloneToolPortalHttpServer(
	props: StartStandaloneToolPortalHttpServerProps,
): Promise<StandaloneToolPortalHttpServer> {
	const server = await startNodeAuthenticatedHttpServer({
		...props,
		maximumRequestBytes: 64 * 1024,
		requestIsRouted: (request, requestUrl) =>
			request.method === 'POST' && requestUrl.search.length === 0,
		handle: async ({ request, response, parsedBody, credential }) => {
			try {
				const parsed = standaloneJsonRequest.parse(parsedBody);
				const rawToken = request.headers[STANDALONE_TOOL_PORTAL_HTTP_APPROVAL_HEADER];
				const approvalToken =
					rawToken === undefined ? undefined : z.string().min(1).max(16_384).parse(rawToken);
				const options = {
					authenticatedEnvelope: credential.authenticatedEnvelope,
					correlation: { sessionId: `standalone-http:${randomUUID()}` },
					surfaceClass: 'http' as const,
					...(approvalToken === undefined ? {} : { approvalToken }),
				};
				const result =
					parsed.operation === 'call'
						? await props.service.call(parsed.request, options)
						: parsed.operation === 'list'
							? await props.service.list(parsed.request, options)
							: parsed.operation === 'search'
								? await props.service.search(parsed.request, options)
								: await props.service.describe(parsed.request, options);
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify(result));
			} catch {
				response.writeHead(400, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ error: { kind: 'invalid_request' }, ok: false }));
			}
		},
	});
	return {
		...server,
		get activeCredentialVersionsByAgent() {
			return server.activeCredentialVersionsByAgent;
		},
		service: props.service,
	};
}

export async function startStandaloneToolPortalMcpHttpServer(
	props: StartStandaloneToolPortalMcpHttpServerProps,
): Promise<StandaloneToolPortalHttpServer> {
	const server = await startNodeAuthenticatedHttpServer({
		...props,
		handle: async ({ request, response, parsedBody, credential }) => {
			const handler = createMcpHandler(
				() =>
					createStandaloneToolPortalMcpServer({
						artifactReader: props.artifactReader,
						authenticatedEnvelope: credential.authenticatedEnvelope,
						service: props.service,
					}),
				{ legacy: 'reject' },
			);
			await toNodeHandler(handler)(
				{
					method: request.method ?? 'POST',
					url: request.url ?? '/',
					headers: request.headers,
					[Symbol.asyncIterator]: () => request[Symbol.asyncIterator](),
				},
				response,
				parsedBody,
			);
		},
	});
	return {
		...server,
		get activeCredentialVersionsByAgent() {
			return server.activeCredentialVersionsByAgent;
		},
		service: props.service,
	};
}
