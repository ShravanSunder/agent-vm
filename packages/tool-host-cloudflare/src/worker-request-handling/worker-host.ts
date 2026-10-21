import {
	createAgentTokenVerifier,
	type AgentTokenVerifier,
} from '@agent-collaboration/tool-access/contracts';
import type { UpstreamMcpRuntimeOptions } from '@agent-collaboration/tool-engine/connectors';
import {
	PortalCatalogPreparationError,
	resolveToolLoading,
	toolLoadingMode,
	type ConsumeApprovalTokenId,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { recordBatchCallAnalytics } from '#worker-host/call-analytics/batch-call-analytics';
import type { CallAnalyticsBinding } from '#worker-host/call-analytics/call-analytics';
import {
	writeWorkerObservationLog,
	type WorkerObservationLog,
} from '#worker-host/call-analytics/worker-observation-log';
import {
	checkWorkerCaller,
	type OrganizationAdmission,
} from '#worker-host/caller-authorization/caller-check';
import {
	createOrganizationEngine,
	type OrganizationEngine,
} from '#worker-host/organization-engines/organization-engine';
import {
	type OrganizationConfigurationSource,
	type WorkerSecretBindings,
} from '#worker-host/worker-configuration/models/worker-configuration';
import {
	createWorkerRequestLimits,
	workerRequestBodyBytes,
} from '#worker-host/worker-request-handling/worker-call-limits';
import { createWorkerMcpServer } from '#worker-host/worker-request-handling/worker-mcp-server';

export interface OrganizationAuthorizationPort extends OrganizationAdmission {
	readonly consumeApprovalToken: ConsumeApprovalTokenId;
}
export interface WorkerOrganizations {
	readonly forOrganization: (organizationId: string) => OrganizationAuthorizationPort;
}
export interface WorkerHost {
	readonly fetch: (request: Request) => Promise<Response>;
}

export function createWorkerHost(props: {
	readonly verifier: AgentTokenVerifier;
	readonly organizations: WorkerOrganizations;
	readonly configurations: OrganizationConfigurationSource;
	readonly secrets: WorkerSecretBindings;
	readonly log?: (event: WorkerObservationLog) => void;
	readonly analytics: CallAnalyticsBinding;
	readonly createClient?: UpstreamMcpRuntimeOptions['createClient'];
}): WorkerHost {
	const engines = new Map<string, Promise<OrganizationEngine>>();
	const isolateId = crypto.randomUUID();
	let activeRequests = 0;
	const log = props.log ?? writeWorkerObservationLog;
	function organizationEngine(organizationId: string): Promise<OrganizationEngine> {
		const existing = engines.get(organizationId);
		if (existing !== undefined) return existing;
		const created = props.configurations.read(organizationId).then(async (configuration) =>
			createOrganizationEngine({
				organizationId,
				configuration,
				secrets: props.secrets,
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
		async fetch(request: Request): Promise<Response> {
			const caller = await checkWorkerCaller({
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
			const requestId = crypto.randomUUID();
			activeRequests += 1;
			log({ event: 'request-started', isolateId, requestId, activeRequests });
			const limits = createWorkerRequestLimits();
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
					return createWorkerMcpServer({
						gateway: requestEngine.gateway,
						mode,
						limits,
						recordCalls: (input, result, startedAt) =>
							recordBatchCallAnalytics({
								organizationId: caller.organizationId,
								organizationName: engine.configuration.organizationName,
								agentClientId: caller.agentClientId,
								mode,
								input,
								result,
								startedAt,
								binding: props.analytics,
								log,
								trustedTool: engine.trustedTool,
								requiresApproval: (namespace, toolName) =>
									engine.requiresApproval(caller.agentClientId, namespace, toolName),
							}),
					});
				},
				{
					legacy: 'reject',
					maxRequestBodySize: workerRequestBodyBytes,
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

export function workerAgentVerifier(props: {
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
