import helperWorker from '#worker-host/deployed-checks/test-helper-worker/test-helper-worker';
export { TestObservations } from '#worker-host/deployed-checks/test-helper-worker/test-helper-worker';
import { WorkspaceAuthority } from '#worker-host/durable-workspace-authority/workspace-authority';
export { WorkspaceAuthority };

export default {
	async fetch(
		request: Request,
		bindings: Parameters<typeof helperWorker.fetch>[1],
	): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/__membership') {
			const stub = bindings.WORKSPACES.get(
				bindings.WORKSPACES.idFromName(url.searchParams.get('workspaceId') ?? ''),
			);
			return Response.json(await stub.readMembership(url.searchParams.get('agentId') ?? ''));
		}
		return helperWorker.fetch(request, bindings);
	},
};
