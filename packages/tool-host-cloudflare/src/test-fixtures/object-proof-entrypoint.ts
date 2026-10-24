import { z } from 'zod';

import { WorkspaceAuthority } from '#worker-host/durable-workspace-authority/workspace-authority';

export { WorkspaceAuthority };
type ObjectProofBindings = Readonly<Pick<ToolPortalWorkerEnv, 'WORKSPACES'>>;
const controlSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('admission'),
		organizationId: z.string(),
		agentId: z.string(),
		state: z.enum(['listed', 'removed']),
		persona: z.string().min(1).default('one'),
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
		const object = bindings.WORKSPACES.get(bindings.WORKSPACES.idFromName(input.organizationId));
		switch (input.kind) {
			case 'admission':
				if (input.state === 'listed') await object.setMembership(input.agentId, input.persona);
				else {
					const requestId = crypto.randomUUID();
					await object.beginAgentRemoval(input.agentId, requestId, { operation: 'unlink' });
					await object.completeAgentRemoval(input.agentId, requestId, 'unlink');
				}
				return Response.json({ ok: true });
			case 'listed':
				return Response.json({ listed: (await object.readMembership(input.agentId)) !== null });
			case 'consume':
				return Response.json(await object.consumeApprovalToken(input.tokenId, input.expiresAtMs));
		}
		throw new Error('Unsupported proof control');
	},
};
