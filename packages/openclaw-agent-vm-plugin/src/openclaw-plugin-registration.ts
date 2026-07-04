import { createGatewayControlCallerContextStore } from './gateway-control-service/gateway-control-caller-context-store.js';
import { createGatewayControlEventPublisher } from './gateway-control-service/gateway-control-event-publisher.js';
import { createGatewayControlLeaseClient } from './gateway-control-service/gateway-control-lease-client.js';
import {
	ensureGatewayControlSessionHeartbeat,
	getOrCreateGatewayControlServiceRuntime,
} from './gateway-control-service/gateway-control-service-runtime.js';
import {
	GATEWAY_CONTROL_READY_PATH,
	GATEWAY_CONTROL_SOCKET_PATH,
	type GatewayControlIdentity,
	type GatewayControlService,
} from './gateway-control-service/gateway-control-service.js';
import { resolveGondolinPluginConfig } from './gondolin-plugin-config.js';
import {
	OPENCLAW_SSH_SESSION_SCRATCH_ROOT,
	createBackendDeps,
} from './openclaw-backend-dependencies.js';
import { buildOpenClawRuntimeStatusReport } from './openclaw-runtime-status.js';
import {
	assertSdkShape,
	type OpenClawHttpRouteRegistrationApi,
	type OpenClawToolRegistrationApi,
	type SshHelpers,
	type SshSandboxSession,
} from './openclaw-sandbox-sdk-contract.js';
import {
	createGondolinSandboxBackendFactory,
	createGondolinSandboxBackendManager,
} from './sandbox-backend-factory.js';
import { registerToolPortalNativeTools } from './tool-portal-native-tools.js';

const gatewayControlLeaseClientEndpoint = 'gateway-control://control-session';

const plugin = {
	id: 'gondolin',
	name: 'Gondolin VM Sandbox',
	description: 'Sandbox backend powered by Gondolin micro-VMs.',

	register(api: {
		readonly config?: Record<string, unknown>;
		readonly pluginConfig: Record<string, unknown>;
		readonly registerHttpRoute?: OpenClawHttpRouteRegistrationApi['registerHttpRoute'];
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
		if (pluginConfig.toolPortal !== undefined && api.registrationMode !== 'full') {
			registerToolPortalNativeTools({
				api: { registerTool },
				configDir: pluginConfig.toolPortal.configDir,
				logger: {
					warn: (message) => process.stderr.write(`${message}\n`),
				},
			});
		}
		if (api.registrationMode !== 'full') {
			return;
		}
		if (pluginConfig.controlSession === undefined) {
			throw new Error('Gondolin full registration requires controlSession.');
		}
		const registerHttpRoute = api.registerHttpRoute;
		if (typeof registerHttpRoute !== 'function') {
			throw new Error('Gondolin control-session registration requires OpenClaw registerHttpRoute.');
		}
		const gatewayControlIdentity: GatewayControlIdentity = {
			bootId: pluginConfig.controlSession.bootId,
			controllerEpoch: pluginConfig.controlSession.controllerEpoch,
			generationId: pluginConfig.controlSession.generationId,
			peerId: pluginConfig.controlSession.peerId,
			zoneId: pluginConfig.zoneId,
		};
		const gatewayControlRuntime = getOrCreateGatewayControlServiceRuntime({
			identity: gatewayControlIdentity,
			verifierPublicKeyPem: pluginConfig.controlSession.verifierPublicKeyPem,
		});
		const gatewayControlService: GatewayControlService = gatewayControlRuntime.service;
		const gatewayControlCallerContextStore = createGatewayControlCallerContextStore();
		if (pluginConfig.toolPortal !== undefined) {
			registerToolPortalNativeTools({
				api: { registerTool },
				configDir: pluginConfig.toolPortal.configDir,
				gatewayControl: {
					callerContextStore: gatewayControlCallerContextStore,
					identity: gatewayControlIdentity,
					service: gatewayControlService,
				},
				logger: {
					warn: (message) => process.stderr.write(`${message}\n`),
				},
			});
		}
		const gatewayControlEventPublisher = createGatewayControlEventPublisher({
			controlService: gatewayControlService,
			identity: gatewayControlIdentity,
		});
		ensureGatewayControlSessionHeartbeat({
			identity: gatewayControlIdentity,
			publisher: gatewayControlEventPublisher,
			runtime: gatewayControlRuntime,
			writeLog: (message) => process.stderr.write(`${message}\n`),
		});
		registerHttpRoute({
			auth: 'plugin',
			handler: gatewayControlService.handleReadyRequest,
			match: 'exact',
			path: GATEWAY_CONTROL_READY_PATH,
		});
		registerHttpRoute({
			auth: 'plugin',
			handler: (_req, res) => {
				res.statusCode = 404;
				res.setHeader('cache-control', 'no-store');
				res.setHeader('content-type', 'text/plain; charset=utf-8');
				res.end('upgrade required\n');
				return true;
			},
			handleUpgrade: gatewayControlService.handleUpgrade,
			match: 'exact',
			path: GATEWAY_CONTROL_SOCKET_PATH,
		});
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
		const publishRuntimeStatus = async (
			report: ReturnType<typeof buildOpenClawRuntimeStatusReport>,
		): Promise<void> => {
			await gatewayControlEventPublisher.publishOpenClawRuntimeStatus(report);
		};

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
			const gatewayControlLeaseClient = createGatewayControlLeaseClient({
				callerContextStore: gatewayControlCallerContextStore,
				controlService: gatewayControlService,
				identity: gatewayControlIdentity,
			});
			const backendDependenciesWithLeaseClient = {
				...backendDependencies,
				createLeaseClient: () => gatewayControlLeaseClient,
				publishHealthEvent: gatewayControlEventPublisher.publishHealthEvent,
				publishOpenClawRuntimeStatus: publishRuntimeStatus,
			};
			sdkRaw.registerSandboxBackend('gondolin', {
				factory: createGondolinSandboxBackendFactory(
					{
						...pluginConfig,
						controllerUrl: gatewayControlLeaseClientEndpoint,
						openClawRuntimeConfigProvider: () => api.runtime?.config?.current?.() ?? api.config,
						openClawRuntimeStatusProvider: buildRuntimeStatus,
					},
					backendDependenciesWithLeaseClient,
				),
				manager: createGondolinSandboxBackendManager(
					{
						controllerUrl: gatewayControlLeaseClientEndpoint,
						zoneId: pluginConfig.zoneId,
					},
					backendDependenciesWithLeaseClient,
				),
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
