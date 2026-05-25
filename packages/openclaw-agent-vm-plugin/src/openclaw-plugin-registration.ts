/* oxlint-disable eslint/no-await-in-loop -- runtime status publish retries must be sequential */
import { createLeaseClient } from './controller-lease-client.js';
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

const runtimeStatusPublishMaxAttempts = 30;
const runtimeStatusPublishRetryDelayMs = 1_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function publishRuntimeStatusWithRetry(options: {
	readonly controllerUrl: string;
	readonly report: ReturnType<typeof buildOpenClawRuntimeStatusReport>;
}): Promise<void> {
	const leaseClient = createLeaseClient({ controllerUrl: options.controllerUrl });
	for (let attemptIndex = 0; attemptIndex < runtimeStatusPublishMaxAttempts; attemptIndex += 1) {
		try {
			await leaseClient.publishOpenClawRuntimeStatus?.(options.report);
			return;
		} catch (error: unknown) {
			if (attemptIndex === runtimeStatusPublishMaxAttempts - 1) {
				throw error;
			}
			await sleep(runtimeStatusPublishRetryDelayMs);
		}
	}
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
			void publishRuntimeStatusWithRetry({
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
