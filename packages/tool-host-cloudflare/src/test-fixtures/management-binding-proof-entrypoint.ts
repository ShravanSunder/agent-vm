import productionWorker, { type WorkerBindings } from '#worker-host/index';

export { WorkspaceAuthority } from '#worker-host/index';

export default {
	async fetch(request: Request, bindings: WorkerBindings): Promise<Response> {
		if (new URL(request.url).pathname === '/__binding-presence') {
			return Response.json({
				signInPresent: Object.hasOwn(bindings, 'SIGN_IN'),
				signInUndefined: bindings.SIGN_IN === undefined,
				managementAudiencePresent: Object.hasOwn(bindings, 'MANAGEMENT_AUDIENCE'),
				managementAudienceUndefined: bindings.MANAGEMENT_AUDIENCE === undefined,
			});
		}
		return productionWorker.fetch(request, bindings);
	},
};
