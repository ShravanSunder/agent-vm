import { z } from 'zod';

import { OrganizationAuthorization } from '#worker-host/caller-authorization/organization-authorization';

export { OrganizationAuthorization };
interface ObjectProofBindings {
	readonly ORGANIZATIONS: DurableObjectNamespace<OrganizationAuthorization>;
}
const controlSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('admission'),
		organizationId: z.string(),
		agentId: z.string(),
		state: z.enum(['listed', 'removed']),
	}),
	z.strictObject({ kind: z.literal('listed'), organizationId: z.string(), agentId: z.string() }),
	z.strictObject({
		kind: z.literal('consume'),
		organizationId: z.string(),
		tokenId: z.string(),
		expiresAtMs: z.number(),
	}),
]);
// Test-only composition. Production exports no admission/replay HTTP endpoints.
export default {
	async fetch(request: Request, bindings: ObjectProofBindings): Promise<Response> {
		const input = controlSchema.parse(await request.json());
		const object = bindings.ORGANIZATIONS.get(
			bindings.ORGANIZATIONS.idFromName(input.organizationId),
		);
		switch (input.kind) {
			case 'admission':
				await object.setAgentAdmission(input.agentId, input.state);
				return Response.json({ ok: true });
			case 'listed':
				return Response.json({ listed: await object.isAgentListed(input.agentId) });
			case 'consume':
				return Response.json(await object.consumeApprovalToken(input.tokenId, input.expiresAtMs));
		}
	},
};
