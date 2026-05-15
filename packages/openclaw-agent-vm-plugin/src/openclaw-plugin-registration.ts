import { createLeaseClient } from './controller-lease-client.js';
import { resolveGondolinPluginConfig } from './gondolin-plugin-config.js';
import { createBackendDeps } from './openclaw-backend-dependencies.js';
import { buildOpenClawRuntimeStatusReport } from './openclaw-runtime-status.js';
import {
	assertSdkShape,
	type OpenClawToolRegistrationApi,
	type SshHelpers,
	type SshSandboxSession,
} from './openclaw-sandbox-sdk-contract.js';
import {
	createGondolinSandboxBackendFactory,
	createGondolinSandboxBackendManager,
} from './sandbox-backend-factory.js';
import { registerZoneGitTool } from './zone-git-tool.js';

const plugin = {
	id: 'gondolin',
	name: 'Gondolin VM Sandbox',
	description: 'Sandbox backend powered by Gondolin micro-VMs.',

	register(api: {
		readonly config?: Record<string, unknown>;
		readonly pluginConfig: Record<string, unknown>;
		readonly registerTool?: OpenClawToolRegistrationApi['registerTool'];
		readonly registrationMode: string;
		readonly runtime?: {
			readonly config?: {
				readonly current?: () => Record<string, unknown>;
			};
		};
	}): void {
		const registerTool = api.registerTool;
		if (typeof registerTool !== 'function') {
			if (api.registrationMode === 'full') {
				throw new Error('Gondolin full registration requires OpenClaw registerTool.');
			}
			return;
		}
		const pluginConfig = resolveGondolinPluginConfig(api.pluginConfig);
		const zoneGitToken =
			pluginConfig.zoneGitToken ??
			(pluginConfig.zoneGitTokenEnv ? process.env[pluginConfig.zoneGitTokenEnv] : undefined);
		registerZoneGitTool({
			api: { registerTool },
			controllerUrl: pluginConfig.controllerUrl,
			...(zoneGitToken ? { zoneGitToken } : {}),
			zoneId: pluginConfig.zoneId,
		});
		if (api.registrationMode !== 'full') {
			return;
		}
		const buildRuntimeStatus = ():
			| ReturnType<typeof buildOpenClawRuntimeStatusReport>
			| undefined => {
			const runtimeConfig = api.runtime?.config?.current?.() ?? api.config;
			return runtimeConfig
				? buildOpenClawRuntimeStatusReport({
						config: runtimeConfig,
						zoneId: pluginConfig.zoneId,
					})
				: undefined;
		};
		const initialRuntimeStatus = buildRuntimeStatus();
		if (initialRuntimeStatus) {
			const leaseClient = createLeaseClient({ controllerUrl: pluginConfig.controllerUrl });
			void leaseClient
				.publishOpenClawRuntimeStatus?.(initialRuntimeStatus)
				?.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : JSON.stringify(error);
					process.stderr.write(
						`[gondolin] failed to publish OpenClaw runtime status: ${message}\n`,
					);
				});
		}

		const sdkPath = '/opt/openclaw-sdk/sandbox.js';
		const sdkPromise = import(sdkPath).then((sdkRaw: Record<string, unknown>) => {
			assertSdkShape(sdkRaw);

			const sshHelpers: SshHelpers = {
				buildExecRemoteCommand: sdkRaw.buildExecRemoteCommand,
				buildRemoteCommand: sdkRaw.buildRemoteCommand,
				buildSshSandboxArgv: sdkRaw.buildSshSandboxArgv,
				createRemoteShellSandboxFsBridge: sdkRaw.createRemoteShellSandboxFsBridge,
				createSshSandboxSessionFromSettings: sdkRaw.createSshSandboxSessionFromSettings,
				...(typeof sdkRaw.disposeSshSandboxSession === 'function'
					? {
							disposeSshSandboxSession: sdkRaw.disposeSshSandboxSession as (
								session: SshSandboxSession,
							) => Promise<void>,
						}
					: {}),
				runSshSandboxCommand: sdkRaw.runSshSandboxCommand,
				sanitizeEnvVars: sdkRaw.sanitizeEnvVars,
			};

			const backendDependencies = createBackendDeps(sshHelpers);
			sdkRaw.registerSandboxBackend('gondolin', {
				factory: createGondolinSandboxBackendFactory(
					{
						...pluginConfig,
						openClawRuntimeStatusProvider: buildRuntimeStatus,
					},
					backendDependencies,
				),
				manager: createGondolinSandboxBackendManager(pluginConfig, backendDependencies),
			});
		});

		sdkPromise.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : JSON.stringify(error);
			process.stderr.write(`[gondolin] failed to load OpenClaw SDK: ${message}\n`);
		});
	},
};

export default plugin;

export { createBackendDeps };
export type { SshHelpers };
