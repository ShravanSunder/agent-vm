import { createLeaseClient } from './controller-lease-client.js';
import { createGatewayControlLinkMonitor } from './gateway-control-link-monitor.js';
import { resolveGondolinPluginConfig } from './gondolin-plugin-config.js';
import {
	OPENCLAW_SSH_SESSION_SCRATCH_ROOT,
	createBackendDeps,
} from './openclaw-backend-dependencies.js';
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

async function publishRuntimeStatus(options: {
	readonly controllerUrl: string;
	readonly report: ReturnType<typeof buildOpenClawRuntimeStatusReport>;
}): Promise<void> {
	const leaseClient = createLeaseClient({ controllerUrl: options.controllerUrl });
	await leaseClient.publishOpenClawRuntimeStatus?.(options.report);
}

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
		if (pluginConfig.gatewayControlLinkMonitor?.enabled) {
			createGatewayControlLinkMonitor({
				baseIntervalMs: pluginConfig.gatewayControlLinkMonitor.baseIntervalMs,
				controllerUrl: pluginConfig.controllerUrl,
				maxIntervalMs: pluginConfig.gatewayControlLinkMonitor.maxIntervalMs,
				now: () => Date.now(),
				zoneId: pluginConfig.zoneId,
			}).start();
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
			void publishRuntimeStatus({
				controllerUrl: pluginConfig.controllerUrl,
				report: initialRuntimeStatus,
			}).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : JSON.stringify(error);
				process.stderr.write(`[gondolin] failed to publish OpenClaw runtime status: ${message}\n`);
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
						openClawRuntimeConfigProvider: () => api.runtime?.config?.current?.() ?? api.config,
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

export { OPENCLAW_SSH_SESSION_SCRATCH_ROOT, createBackendDeps };
export type { SshHelpers };
