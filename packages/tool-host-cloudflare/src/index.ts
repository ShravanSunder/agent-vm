import { z } from 'zod';

import { OrganizationAuthorization } from '#worker-host/organization-authorization';
import {
	deployedConfigurationSource,
	workerSecretBindings,
} from '#worker-host/worker-configuration';
import { createWorkerHost, workerAgentVerifier, type WorkerHost } from '#worker-host/worker-host';
import { writeWorkerObservationLog } from '#worker-host/worker-observation-log';

export { OrganizationAuthorization, createWorkerHost };
export type { WorkerHost };
export interface WorkerBindings extends Readonly<Record<string, unknown>> {
	readonly ORGANIZATIONS: DurableObjectNamespace<OrganizationAuthorization>;
	readonly ORGANIZATION_CONFIGURATIONS: string;
	readonly CALL_ANALYTICS: import('#worker-host/call-analytics').CallAnalyticsBinding;
	readonly SIGN_IN_ISSUER: string;
	readonly SIGN_IN_JWKS_URL: string;
	readonly TOOL_PORTAL_AUDIENCE: string;
}
let host: WorkerHost | undefined;

export default {
	async fetch(request: Request, bindings: WorkerBindings): Promise<Response> {
		try {
			host ??= createWorkerHost({
				analytics: bindings.CALL_ANALYTICS,
				verifier: workerAgentVerifier({
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
			return await host.fetch(request);
		} catch {
			writeWorkerObservationLog({ event: 'worker-request-unavailable' });
			return Response.json({ error: 'worker-unavailable' }, { status: 503 });
		}
	},
};
