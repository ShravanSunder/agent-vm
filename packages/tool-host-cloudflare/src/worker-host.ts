import {
	createAgentTokenVerifier,
	type AgentTokenVerifier,
} from '@agent-collaboration/tool-access/contracts';
import {
	resolveToolLoading,
	toolLoadingMode,
	type ConsumeApprovalTokenId,
} from '@agent-collaboration/tool-engine/mcp-gateway';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { checkWorkerCaller, type OrganizationAdmission } from '#worker-host/caller-check';
import {
	createOrganizationEngine,
	type OrganizationEngine,
} from '#worker-host/organization-engine';
import {
	type OrganizationConfigurationSource,
	type WorkerSecretBindings,
} from '#worker-host/worker-configuration';
import { createWorkerMcpServer } from '#worker-host/worker-mcp-server';

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
}): WorkerHost {
	const engines = new Map<string, Promise<OrganizationEngine>>();
	function organizationEngine(organizationId: string): Promise<OrganizationEngine> {
		const existing = engines.get(organizationId);
		if (existing !== undefined) return existing;
		const created = props.configurations.read(organizationId).then(async (configuration) =>
			createOrganizationEngine({
				organizationId,
				configuration,
				secrets: props.secrets,
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
			let closeGateway: (() => Promise<void>) | undefined;
			const handler = createMcpHandler(
				async () => {
					const engine = await organizationEngine(caller.organizationId);
					const requestEngine = engine.gatewayFor({
						agentClientId: caller.agentClientId,
						consumeTokenId: async (tokenId, expiresAtMs) =>
							props.organizations
								.forOrganization(caller.organizationId)
								.consumeApprovalToken(`${caller.agentClientId}:${tokenId}`, expiresAtMs),
					});
					closeGateway = requestEngine.close;
					return createWorkerMcpServer({ gateway: requestEngine.gateway, mode });
				},
				{ legacy: 'reject', maxRequestBodySize: 4 * 1024 * 1024 },
			);
			const response = await handler.fetch(request);
			return responseWithRequestCleanup(response, async () => {
				await closeGateway?.();
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
function responseWithRequestCleanup(response: Response, close: () => Promise<void>): Response {
	const body = response.body;
	if (body === null) {
		void close();
		return response;
	}
	const reader = body.getReader();
	let closed = false;
	async function closeOnce(): Promise<void> {
		if (!closed) {
			closed = true;
			await close();
		}
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
