import {
	createAgentTokenVerifier,
	type AgentTokenVerifier,
} from '@agent-collaboration/tool-access/contracts';
import {
	PortalCatalogPreparationError,
	resolveToolLoading,
	toolLoadingMode,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { recordBatchCallAnalytics } from '#tool-host-core/call-analytics/batch-call-analytics';
import { checkHostedCaller } from '#tool-host-core/caller-admission/caller-check';
import { createHostedMcpServer } from '#tool-host-core/hosted-mcp-proxy/hosted-mcp-server';
import type {
	HostedMcpProxy,
	HostedMcpProxyPorts,
} from '#tool-host-core/hosted-mcp-proxy/models/hosted-mcp-proxy-ports';
import type { OrganizationEngine } from '#tool-host-core/organization-engines/models/organization-engine';
import { createOrganizationEngine } from '#tool-host-core/organization-engines/organization-engine';
import { createHostedRequestLimits } from '#tool-host-core/request-limits/hosted-call-limits';

export function createHostedMcpProxy(props: HostedMcpProxyPorts): HostedMcpProxy {
	const engines = new Map<string, Promise<OrganizationEngine>>();
	const isolateId = props.newId();
	let activeRequests = 0;
	const log = props.log;
	function organizationEngine(organizationId: string): Promise<OrganizationEngine> {
		const existing = engines.get(organizationId);
		if (existing !== undefined) return existing;
		const created = props.configurations.read(organizationId).then(async (configuration) =>
			createOrganizationEngine({
				organizationId,
				configuration,
				secrets: props.secrets,
				clock: props.clock,
				limits: props.limits,
				createUpstreamMcpTransport: props.createUpstreamMcpTransport,
				...(props.createClient === undefined ? {} : { createClient: props.createClient }),
			}),
		);
		engines.set(organizationId, created);
		void created.catch(() => {
			if (engines.get(organizationId) === created) engines.delete(organizationId);
		});
		return created;
	}
	return {
		async handle(request: Request): Promise<Response> {
			const caller = await checkHostedCaller({
				request,
				verifier: props.verifier,
				organizations: props.organizations,
			});
			if (caller.kind !== 'verified')
				return Response.json(
					{ error: caller.reason },
					{ status: caller.kind === 'unavailable' ? 503 : 401 },
				);
			const mode = toolLoadingMode(resolveToolLoading(request.url));
			const requestId = props.newId();
			activeRequests += 1;
			log({ event: 'request-started', isolateId, requestId, activeRequests });
			const limits = createHostedRequestLimits(props.limits);
			let closeGateway: (() => Promise<void>) | undefined;
			let catalogError: PortalCatalogPreparationError | undefined;
			const handler = createMcpHandler(
				async () => {
					const engine = await organizationEngine(caller.organizationId);
					await engine.refresh();
					const requestEngine = engine.gatewayFor({
						agentClientId: caller.agentClientId,
						invoke: limits.invoke,
						consumeTokenId: async (tokenId, expiresAtMs) =>
							props.organizations
								.forOrganization(caller.organizationId)
								.consumeApprovalToken(`${caller.agentClientId}:${tokenId}`, expiresAtMs),
					});
					closeGateway = requestEngine.close;
					if (mode === 'direct' && request.headers.get('Mcp-Method') === 'tools/list')
						await requestEngine.gateway.prepareCatalog();
					return createHostedMcpServer({
						gateway: requestEngine.gateway,
						mode,
						limits,
						clock: props.clock,
						proxyLimits: props.limits,
						recordCalls: (input, result, startedAt) =>
							recordBatchCallAnalytics({
								organizationId: caller.organizationId,
								organizationName: engine.configuration.organizationName,
								agentClientId: caller.agentClientId,
								mode,
								input,
								result,
								startedAt,
								sink: props.analytics,
								clock: props.clock,
								log,
								trustedTool: engine.trustedTool,
								requiresApproval: (namespace, toolName) =>
									engine.requiresApproval(caller.agentClientId, namespace, toolName),
							}),
					});
				},
				{
					legacy: 'reject',
					maxRequestBodySize: props.limits.requestBodyBytes,
					onerror: (error) => {
						if (error instanceof PortalCatalogPreparationError) catalogError = error;
					},
				},
			);
			let response = await handler.fetch(request);
			if (catalogError !== undefined) {
				await response.body?.cancel();
				response = Response.json(
					{
						ok: false,
						error: {
							kind: 'catalog_preparation_failed',
							failedNamespaces: catalogError.failedNamespaces,
						},
					},
					{ status: 503 },
				);
			}
			return responseWithRequestCleanup(response, async () => {
				try {
					await closeGateway?.();
				} finally {
					activeRequests -= 1;
					log({ event: 'request-ended', isolateId, requestId, activeRequests });
				}
			});
		},
	};
}

export function hostedAgentVerifier(props: {
	readonly deployment: string;
	readonly audience: string;
	readonly jwksUrl: string;
}): AgentTokenVerifier {
	return createAgentTokenVerifier({
		deployment: props.deployment,
		audience: props.audience,
		jwksUrl: new URL(props.jwksUrl),
	});
}

/** Keep request-scoped clients alive through streamed results, then close on EOF, error or cancellation. */
export async function responseWithRequestCleanup(
	response: Response,
	close: () => Promise<void>,
): Promise<Response> {
	const body = response.body;
	if (body === null) {
		await close();
		return response;
	}
	const reader = body.getReader();
	let completion: Promise<void> | undefined;
	function closeOnce(): Promise<void> {
		return (completion ??= Promise.resolve().then(close));
	}
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller): Promise<void> {
				try {
					const next = await reader.read();
					if (next.done) {
						await closeOnce();
						controller.close();
					} else controller.enqueue(next.value);
				} catch (error) {
					await closeOnce();
					controller.error(error);
				}
			},
			async cancel(reason): Promise<void> {
				try {
					await reader.cancel(reason);
				} finally {
					await closeOnce();
				}
			},
		}),
		{ status: response.status, headers: response.headers },
	);
}
