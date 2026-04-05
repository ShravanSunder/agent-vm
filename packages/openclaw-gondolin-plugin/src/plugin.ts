import { createGondolinSandboxBackendFactory } from './backend.js';
import { resolveGondolinPluginConfig } from './config.js';

export function createGondolinPlugin(dependencies: {
	readonly registerSandboxBackend: (
		id: string,
		registration: {
			factory: ReturnType<typeof createGondolinSandboxBackendFactory>;
		},
	) => void;
}): {
	readonly description: string;
	readonly id: string;
	readonly name: string;
	register(api: { pluginConfig: Record<string, unknown>; registrationMode: string }): void;
} {
	return {
		description: 'Gondolin-backed sandbox runtime for OpenClaw agent execution.',
		id: 'gondolin',
		name: 'Gondolin Sandbox',
		register(api: { pluginConfig: Record<string, unknown>; registrationMode: string }): void {
			if (api.registrationMode !== 'full') {
				return;
			}

			const pluginConfig = resolveGondolinPluginConfig(api.pluginConfig);
			dependencies.registerSandboxBackend('gondolin', {
				factory: createGondolinSandboxBackendFactory(pluginConfig, {
					buildExecSpec: async ({ command, env, ssh, usePty }) => ({
						argv: ['ssh', ssh.host, command],
						env,
						stdinMode: usePty ? 'pipe-open' : 'pipe-open',
					}),
					runRemoteShellScript: async () => ({
						code: 0,
						stderr: Buffer.from(''),
						stdout: Buffer.from(''),
					}),
				}),
			});
		},
	};
}

type RuntimeRegisterSandboxBackend = (
	id: string,
	registration: {
		factory: ReturnType<typeof createGondolinSandboxBackendFactory>;
	},
) => void;

let runtimeRegisterSandboxBackend: RuntimeRegisterSandboxBackend | null = null;

try {
	const sandboxModuleSpecifier = 'openclaw/plugin-sdk/sandbox';
	const sandboxModule = await import(sandboxModuleSpecifier);
	runtimeRegisterSandboxBackend =
		sandboxModule.registerSandboxBackend as RuntimeRegisterSandboxBackend;
} catch {
	runtimeRegisterSandboxBackend = null;
}

const defaultPlugin = createGondolinPlugin({
	registerSandboxBackend: (id, registration): void => {
		if (!runtimeRegisterSandboxBackend) {
			throw new Error(
				'openclaw/plugin-sdk/sandbox is unavailable; load this package inside an OpenClaw runtime.',
			);
		}
		runtimeRegisterSandboxBackend(id, registration);
	},
});

export default defaultPlugin;
