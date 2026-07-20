import { registerGatewayControlAdmissionPressureE2eRoute } from './gateway-control-service/gateway-control-admission-pressure-e2e-route.js';
import {
	assertOpenClawGatewayRuntimeSandboxE2eClient,
	registerGatewayRuntimeSandboxWriteReadE2eRoute,
} from './gateway-runtime-sandbox-write-read-e2e-route.js';
import { registerAgentVmPlugin } from './openclaw-plugin-registration.js';

const plugin = {
	id: 'gondolin',
	name: 'Gondolin VM Sandbox E2E Harness',
	description: 'E2E entrypoint for the thin agent-vm Gateway Runtime adapter.',

	register(api: Parameters<typeof registerAgentVmPlugin>[0]): void {
		const pressureRouteApi =
			api.registerHttpRoute === undefined ? {} : { registerHttpRoute: api.registerHttpRoute };
		registerGatewayControlAdmissionPressureE2eRoute({ api: pressureRouteApi });
		registerAgentVmPlugin(api, {
			onGatewayRuntimeClientCreated: ({ agentProjections, api: routeApi, client }) => {
				assertOpenClawGatewayRuntimeSandboxE2eClient(client);
				registerGatewayRuntimeSandboxWriteReadE2eRoute({
					agentProjections,
					api: routeApi,
					client,
				});
			},
		});
	},
};

export default plugin;
