import { z } from 'zod';

import { WorkspaceAuthority as ProductionWorkspaceAuthority } from '#worker-host/durable-workspace-authority/workspace-authority';
import gateway, { type WorkerBindings } from '#worker-host/index';

const storedAgentStateSchema = z.record(
	z.string(),
	z.union([
		z.strictObject({ state: z.enum(['member', 'removed']), persona: z.string().min(1) }),
		z.strictObject({
			kind: z.enum(['pending', 'complete']),
			operation: z.enum(['unlink', 'disable']),
			requestId: z.uuid(),
		}),
	]),
);

export class WorkspaceAuthority extends ProductionWorkspaceAuthority {
	/** Read raw storage independently of membership and removal decision methods. */
	async readStoredAgentState(clientId: string): Promise<z.infer<typeof storedAgentStateSchema>> {
		const stored = await this.ctx.storage.get([`member:${clientId}`, `member-removal:${clientId}`]);
		return storedAgentStateSchema.parse(Object.fromEntries(stored));
	}
}
interface ProofBindings extends WorkerBindings {
	readonly WORKSPACES: DurableObjectNamespace<WorkspaceAuthority>;
}

// Readback exists only in this test composition. Every ordinary request uses production fetch.
export default {
	async fetch(request: Request, bindings: ProofBindings): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/__auth-proof') {
			if (request.method !== 'GET')
				return Response.json({ error: 'method-not-allowed' }, { status: 405 });
			const workspaceId = z.uuid().parse(url.searchParams.get('workspace'));
			const clientId = z.string().min(1).parse(url.searchParams.get('client'));
			return Response.json(
				await bindings.WORKSPACES.get(
					bindings.WORKSPACES.idFromName(workspaceId),
				).readStoredAgentState(clientId),
			);
		}
		return gateway.fetch(request, bindings);
	},
};
