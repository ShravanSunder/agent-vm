import {
	resolveToolLoading,
	toolLoadingMode,
	PortalCatalogPreparationError,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';

import type { NodeHostBearerCredentialSet } from '#node-host/mcp-proxy-server/models/bearer-credentials';
import { startNodeAuthenticatedHttpServer } from '#node-host/mcp-proxy-server/node-authenticated-http-server';
import { createNodeMcpServer } from '#node-host/mcp-proxy-server/node-mcp-server';
import type { NodeHostComposition } from '#node-host/node-host-composition';

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

export async function startNodeHostMcpHttpServer(
	props: StartNodeHostMcpHttpServerProps,
): Promise<NodeHostMcpHttpServer> {
	return await startNodeAuthenticatedHttpServer({
		...props,
		onCredentialSetActivated: (credentials) => props.composition.activateCredentials(credentials),
		handle: async ({ request, response, parsedBody, credential, requestUrl }) => {
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
		},
	});
}
