import { registerAgentVmPlugin } from './openclaw-plugin-registration.js';

const plugin = {
	id: 'gondolin',
	name: 'Gondolin VM Sandbox E2E Harness',
	description: 'E2E-only Gondolin plugin entrypoint with deterministic Tool VM proof route.',

	register(api: Parameters<typeof registerAgentVmPlugin>[0]): void {
		registerAgentVmPlugin(api, { enableToolVmWriteReadE2eRoute: true });
	},
};

export default plugin;
