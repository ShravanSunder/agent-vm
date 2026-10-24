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
import { z } from 'zod';

import { recordBatchCallAnalytics } from '#tool-host-core/call-analytics/batch-call-analytics';
import { checkHostedCaller } from '#tool-host-core/caller-admission/caller-check';
import type { HostedCallerCheck } from '#tool-host-core/caller-admission/models/caller-admission';
import type { WorkspaceConfiguration } from '#tool-host-core/hosted-configuration/models/hosted-configuration';
import { createHostedMcpServer } from '#tool-host-core/hosted-mcp-proxy/hosted-mcp-server';
import type {
	HostedMcpProxy,
	HostedMcpProxyPorts,
} from '#tool-host-core/hosted-mcp-proxy/models/hosted-mcp-proxy-ports';
import { createHostedRequestLimits } from '#tool-host-core/request-limits/hosted-call-limits';
import type { SettledWorkspaceCatalog } from '#tool-host-core/workspace-engines/models/workspace-engine';
import { createWorkspaceEngine } from '#tool-host-core/workspace-engines/workspace-engine';

interface HostedWorkspaceContext {
	readonly configuration: WorkspaceConfiguration;
	catalog?: SettledWorkspaceCatalog;
}

function callerRefusalResponse(
	caller: Exclude<HostedCallerCheck, { readonly kind: 'verified' }>,
): Response {
	return Response.json(
		{
			error:
				caller.kind === 'unavailable'
					? 'admission-unavailable'
					: caller.reason === 'profile-unassigned'
						? 'profile-unassigned'
						: 'unknown-caller',
		},
		{ status: caller.kind === 'unavailable' ? 503 : 401 },
	);
}

export function createHostedMcpProxy(props: HostedMcpProxyPorts): HostedMcpProxy {
	// Cache configuration before lazy discovery so an unassigned caller cannot
	// start upstream clients or poison a later assigned caller's organization engine.
	const workspaces = new Map<string, HostedWorkspaceContext>();
	const isolateId = props.newId();
	let activeRequests = 0;
	const log = props.log;
	async function workspaceContext(workspaceId: string): Promise<HostedWorkspaceContext> {
		const existing = workspaces.get(workspaceId);
		if (existing !== undefined) return existing;
		// Concurrent cold requests read independently. Only completed configuration is shared.
		const configuration = await props.configurations.read(workspaceId);
		const context = workspaces.get(workspaceId) ?? { configuration };
		workspaces.set(workspaceId, context);
		return context;
	}

	return {
		async handle(request: Request): Promise<Response> {
			const matched = /^\/workspaces\/([^/]+)\/mcp$/u.exec(new URL(request.url).pathname);
			const selected = z.uuid().safeParse(matched?.[1]);
			if (!selected.success) return Response.json({ error: 'not-found' }, { status: 404 });
			const caller = await checkHostedCaller({
				workspaceId: selected.data,
				toolPortalOrigin: props.toolPortalOrigin,
				request,
				verifier: props.verifier,
				workspaces: props.workspaces,
			});
			if (caller.kind !== 'verified') {
				log({ event: 'caller-refused', reason: caller.reason });
				return callerRefusalResponse(caller);
			}
			const pendingContext = workspaceContext(caller.workspaceId);
			// Preserve the existing SDK error path for failed configuration reads;
			// a readable but unassigned profile is an admission refusal before MCP handling.
			const admissionContext = await pendingContext.catch(() => undefined);
			if (admissionContext !== undefined) {
				if (admissionContext.configuration.portal.profiles[caller.persona] === undefined) {
					log({ event: 'caller-refused', reason: 'profile-unassigned' });
					return callerRefusalResponse({ kind: 'refused', reason: 'profile-unassigned' });
				}
			}
			const mode = toolLoadingMode(resolveToolLoading(request.url));
			const requestId = props.newId();
			activeRequests += 1;
			log({ event: 'request-started', isolateId, requestId, activeRequests });
			const limits = createHostedRequestLimits(props.limits);
			let closeGateway: (() => Promise<void>) | undefined;
			let catalogError: PortalCatalogPreparationError | undefined;
			const handler = createMcpHandler(
				async () => {
					const context = await pendingContext;
					const engine = await createWorkspaceEngine({
						workspaceId: caller.workspaceId,
						configuration: context.configuration,
						secrets: props.secrets,
						clock: props.clock,
						limits: props.limits,
						...(context.catalog === undefined ? {} : { cachedCatalog: context.catalog }),
						createUpstreamMcpTransport: props.createUpstreamMcpTransport,
						...(props.createClient === undefined ? {} : { createClient: props.createClient }),
					});
					const settled = engine.settledCatalog();
					if (
						settled !== undefined &&
						(context.catalog === undefined ||
							settled.discoveryStartedAt > context.catalog.discoveryStartedAt)
					)
						context.catalog = settled;
					const requestEngine = engine.gatewayFor({
						agentClientId: caller.agentClientId,
						persona: caller.persona,
						invoke: limits.invoke,
						consumeTokenId: async (tokenId, expiresAtMs) =>
							props.workspaces
								.forWorkspace(caller.workspaceId)
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
								organizationId: engine.configuration.organizationId,
								organizationName: engine.configuration.workspaceName,
								agentClientId: caller.agentClientId,
								mode,
								input,
								result,
								startedAt,
								sink: props.analytics,
								clock: props.clock,
								log,
								trustedTool: requestEngine.trustedTool,
								requiresApproval: (namespace, toolName) =>
									requestEngine.requiresApproval(namespace, toolName),
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
	readonly jwksUrl: string;
}): AgentTokenVerifier {
	return createAgentTokenVerifier({
		deployment: props.deployment,
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
