import {
	createHostedMcpProxy,
	hostedAgentVerifier,
	type HostedMcpProxy,
} from '@agent-collaboration/tool-host-core';
import { z } from 'zod';

import { createAnalyticsEngineSink } from '#worker-host/analytics-engine-sink/analytics-engine-sink';
import { OrganizationAuthorization } from '#worker-host/durable-organization-authority/organization-authorization';
import {
	deployedConfigurationSource,
	workerSecretBindings,
} from '#worker-host/worker-bindings/worker-configuration';
import { writeObservationLog } from '#worker-host/worker-bindings/worker-observation-log';
import { workerHostedProxyLimits } from '#worker-host/worker-limits';
import { createWorkerUpstreamTransport } from '#worker-host/worker-upstream-transports';

export { OrganizationAuthorization };
export interface WorkerBindings extends Readonly<Record<string, unknown>> {
	readonly ORGANIZATIONS: DurableObjectNamespace<OrganizationAuthorization>;
	readonly ORGANIZATION_CONFIGURATIONS: string;
	readonly CALL_ANALYTICS: import('#worker-host/analytics-engine-sink/analytics-engine-sink').CallAnalyticsBinding;
	readonly SIGN_IN_ISSUER: string;
	readonly SIGN_IN_JWKS_URL: string;
	readonly TOOL_PORTAL_AUDIENCE: string;
}
let host: HostedMcpProxy | undefined;

export default {
	async fetch(request: Request, bindings: WorkerBindings): Promise<Response> {
		try {
			host ??= createHostedMcpProxy({
				analytics: createAnalyticsEngineSink(bindings.CALL_ANALYTICS),
				log: writeObservationLog,
				clock: { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() },
				newId: () => crypto.randomUUID(),
				limits: workerHostedProxyLimits,
				createUpstreamMcpTransport: createWorkerUpstreamTransport,
				verifier: hostedAgentVerifier({
					deployment: z.url().parse(bindings.SIGN_IN_ISSUER),
					audience: z.string().min(1).parse(bindings.TOOL_PORTAL_AUDIENCE),
					jwksUrl: z.url().parse(bindings.SIGN_IN_JWKS_URL),
				}),
				configurations: deployedConfigurationSource(
					JSON.parse(bindings.ORGANIZATION_CONFIGURATIONS),
				),
				secrets: workerSecretBindings(bindings),
				organizations: {
					forOrganization: (organizationId) =>
						bindings.ORGANIZATIONS.get(bindings.ORGANIZATIONS.idFromName(organizationId)),
				},
			});
			return await host.handle(request);
		} catch {
			writeObservationLog({ event: 'worker-request-unavailable' });
			return Response.json({ error: 'worker-unavailable' }, { status: 503 });
		}
	},
};
