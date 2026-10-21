import helperWorker from '#worker-host/deployed-checks/test-helper-worker/test-helper-worker';
export { TestObservations } from '#worker-host/deployed-checks/test-helper-worker/test-helper-worker';
import { OrganizationAuthorization } from '#worker-host/caller-authorization/organization-authorization';
export { OrganizationAuthorization };

export default {
	async fetch(
		request: Request,
		bindings: Parameters<typeof helperWorker.fetch>[1],
	): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/__listed') {
			const stub = bindings.ORGANIZATIONS.get(
				bindings.ORGANIZATIONS.idFromName(url.searchParams.get('organizationId') ?? ''),
			);
			return Response.json({
				listed: await stub.isAgentListed(url.searchParams.get('agentId') ?? ''),
			});
		}
		return helperWorker.fetch(request, bindings);
	},
};
