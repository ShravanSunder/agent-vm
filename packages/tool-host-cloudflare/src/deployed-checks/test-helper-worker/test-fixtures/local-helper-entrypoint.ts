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
		if (url.pathname === '/__listed') {
			const stub = bindings.WORKSPACES.get(
				bindings.WORKSPACES.idFromName(url.searchParams.get('organizationId') ?? ''),
			);
			return Response.json({
				listed: (await stub.readMembership(url.searchParams.get('agentId') ?? '')) !== null,
			});
		}
		return helperWorker.fetch(request, bindings);
	},
};
