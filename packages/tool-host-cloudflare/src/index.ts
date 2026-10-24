/// <reference types="../worker-configuration.gen.d.ts" preserve="true" />

import { createPersonTokenVerifier } from '@agent-collaboration/tool-access/contracts';
import {
	createHostedMcpProxy,
	createWorkspaceAgentManagement,
	hostedAgentVerifier,
	type AgentClientManagementPort,
	type HostedMcpProxy,
} from '@agent-collaboration/tool-host-core';
import { z } from 'zod';

import { createAnalyticsEngineSink } from '#worker-host/analytics-engine-sink/analytics-engine-sink';
import { WorkspaceAuthority } from '#worker-host/durable-workspace-authority/workspace-authority';
import {
	deployedConfigurationSource,
	workerSecretBindings,
} from '#worker-host/worker-bindings/worker-configuration';
import { writeObservationLog } from '#worker-host/worker-bindings/worker-observation-log';
import { workerHostedProxyLimits } from '#worker-host/worker-limits';
import { createWorkerUpstreamTransport } from '#worker-host/worker-upstream-transports';

export { WorkspaceAuthority };
export type WorkerBindings = Readonly<Omit<ToolPortalWorkerEnv, 'SIGN_IN'>> &
	Readonly<Record<string, unknown>> & {
		readonly SIGN_IN?: AgentClientManagementPort;
	};
let host: HostedMcpProxy | undefined;

export default {
	async fetch(request: Request, bindings: WorkerBindings): Promise<Response> {
		try {
			if (new URL(request.url).pathname.startsWith('/management/')) {
				if (bindings.SIGN_IN === undefined)
					return Response.json({ error: 'management-unavailable' }, { status: 503 });
				return await createWorkspaceAgentManagement({
					verifier: createPersonTokenVerifier({
						deployment: z.url().parse(bindings.SIGN_IN_ISSUER),
						audience: z.string().min(1).parse(bindings.MANAGEMENT_AUDIENCE),
						jwksUrl: new URL(z.url().parse(bindings.SIGN_IN_JWKS_URL)),
					}),
					signIn: bindings.SIGN_IN,
					toolPortalOrigin: bindings.TOOL_PORTAL_ORIGIN,
					configurations: deployedConfigurationSource(
						JSON.parse(bindings.WORKSPACE_CONFIGURATIONS),
					),
					workspaces: {
						forWorkspace: (workspaceId) =>
							bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(workspaceId)),
					},
				}).handle(request);
			}
			const workspace = /^\/workspaces\/([^/]+)\/mcp$/u.exec(new URL(request.url).pathname);
			if (!z.uuid().safeParse(workspace?.[1]).success)
				return Response.json({ error: 'not-found' }, { status: 404 });
			host ??= createHostedMcpProxy({
				sessionClientId: z.string().min(1).parse(bindings.FLEET_CENTRAL_CLIENT_ID),
				toolPortalOrigin: bindings.TOOL_PORTAL_ORIGIN,
				analytics: createAnalyticsEngineSink(bindings.CALL_ANALYTICS),
				log: writeObservationLog,
				clock: { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() },
				newId: () => crypto.randomUUID(),
				limits: workerHostedProxyLimits,
				createUpstreamMcpTransport: createWorkerUpstreamTransport,
				verifier: hostedAgentVerifier({
					deployment: z.url().parse(bindings.SIGN_IN_ISSUER),

					jwksUrl: z.url().parse(bindings.SIGN_IN_JWKS_URL),
				}),
				configurations: deployedConfigurationSource(JSON.parse(bindings.WORKSPACE_CONFIGURATIONS)),
				secrets: workerSecretBindings(bindings),
				workspaces: {
					forWorkspace: (workspaceId) =>
						bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(workspaceId)),
				},
			});
			return await host.handle(request);
		} catch {
			writeObservationLog({ event: 'worker-request-unavailable' });
			return Response.json({ error: 'worker-unavailable' }, { status: 503 });
		}
	},
};
