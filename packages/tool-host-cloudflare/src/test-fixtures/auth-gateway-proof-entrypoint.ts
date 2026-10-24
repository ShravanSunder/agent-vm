import { z } from 'zod';

import { OrganizationAuthorization as ProductionOrganizationAuthorization } from '#worker-host/durable-organization-authority/organization-authorization';
import gateway, { type WorkerBindings } from '#worker-host/index';

const storedAgentStateSchema = z.record(
	z.string(),
	z.union([
		z.strictObject({ state: z.enum(['listed', 'removed']) }),
		z.strictObject({ kind: z.enum(['pending', 'complete']), requestId: z.uuid() }),
	]),
);

export class OrganizationAuthorization extends ProductionOrganizationAuthorization {
	/** Independent readback bypasses the authority's admission and retirement decision methods. */
	async readStoredAgentState(clientId: string): Promise<z.infer<typeof storedAgentStateSchema>> {
		const stored = await this.ctx.storage.get([
			`agent:${clientId}`,
			`agent-retirement:${clientId}`,
		]);
		return storedAgentStateSchema.parse(Object.fromEntries(stored));
	}
}
interface ProofBindings extends WorkerBindings {
	readonly ORGANIZATIONS: DurableObjectNamespace<OrganizationAuthorization>;
}

// Test composition adds readback only. Management, verification, transport and DO writes are production.
export default {
	async fetch(request: Request, bindings: ProofBindings): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/__auth-proof') {
			const organizationId = z.uuid().parse(url.searchParams.get('organization'));
			const clientId = z.string().min(1).parse(url.searchParams.get('client'));
			const authority = bindings.ORGANIZATIONS.get(
				bindings.ORGANIZATIONS.idFromName(organizationId),
			);
			return Response.json(await authority.readStoredAgentState(clientId));
		}
		return gateway.fetch(request, bindings);
	},
};
