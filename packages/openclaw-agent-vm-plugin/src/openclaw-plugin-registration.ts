import {
	GATEWAY_CONTROL_CALLER_CONTEXT_AGENT_AUTHORITY_KEYS_ENV,
	GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV,
} from '@agent-vm/gateway-interface';

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
import {
	type GondolinPluginConfigInput,
	type GondolinPluginConfigJsonObject,
	resolveGondolinPluginConfig,
} from './gondolin-plugin-config.js';
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
import { registerToolVmWriteReadE2eRoute } from './tool-vm-write-read-e2e-tool.js';

const gatewayControlLeaseClientEndpoint = 'gateway-control://control-session';

interface RegisterGondolinPluginOptions {
	readonly enableToolVmWriteReadE2eRoute?: boolean | undefined;
}

function resolveGatewayControlCallerContextProofKey(): string {
	const proofKey = process.env[GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV];
	if (proofKey === undefined || proofKey.length === 0) {
		throw new Error(
			`Gondolin full registration requires ${GATEWAY_CONTROL_CALLER_CONTEXT_PROOF_KEY_ENV}.`,
		);
	}
	return proofKey;
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	for (const entryValue of Object.values(value)) {
		if (typeof entryValue !== 'string' || entryValue.length === 0) {
			return false;
		}
	}
	return true;
}

function resolveGatewayControlCallerContextAgentAuthorityKeys(): Readonly<Record<string, string>> {
	const rawKeys = process.env[GATEWAY_CONTROL_CALLER_CONTEXT_AGENT_AUTHORITY_KEYS_ENV];
	if (rawKeys === undefined || rawKeys.length === 0) {
		throw new Error(
			`Gondolin full registration requires ${GATEWAY_CONTROL_CALLER_CONTEXT_AGENT_AUTHORITY_KEYS_ENV}.`,
		);
	}
	const parsedKeys = JSON.parse(rawKeys) as unknown;
	if (!isStringRecord(parsedKeys)) {
		throw new Error(
			`Gondolin full registration requires ${GATEWAY_CONTROL_CALLER_CONTEXT_AGENT_AUTHORITY_KEYS_ENV} to be a JSON object of agent keys.`,
		);
	}
	return parsedKeys;
}

export function registerGondolinPlugin(
	api: {
		readonly config?: GondolinPluginConfigJsonObject;
		readonly pluginConfig: GondolinPluginConfigInput;
		readonly registerHttpRoute?: OpenClawHttpRouteRegistrationApi['registerHttpRoute'];
		readonly registerTool?: OpenClawToolRegistrationApi['registerTool'];
		readonly registrationMode: string;
		readonly runtime?: {
			readonly config?: {
				readonly current?: () => GondolinPluginConfigJsonObject;
			};
		};
	},
	options: RegisterGondolinPluginOptions = {},
): void {
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
	const callerContextProofKey = resolveGatewayControlCallerContextProofKey();
	const callerContextAgentAuthorityKeys = resolveGatewayControlCallerContextAgentAuthorityKeys();
	const registerHttpRoute = api.registerHttpRoute;
	if (typeof registerHttpRoute !== 'function') {
		throw new Error('Gondolin control-session registration requires OpenClaw registerHttpRoute.');
	}
	const gatewayControlIdentity: GatewayControlIdentity = {
		bootId: pluginConfig.controlSession.bootId,
		callerContextAgentAuthorityKeys,
		callerContextProofKey,
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
	const gondolinSandboxBackendFactoryPromise = import(sdkPath).then(
		(sdkRaw: Record<string, unknown>) => {
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
			const gondolinSandboxBackendFactory = createGondolinSandboxBackendFactory(
				{
					...pluginConfig,
					controllerUrl: gatewayControlLeaseClientEndpoint,
					openClawRuntimeConfigProvider: () => api.runtime?.config?.current?.() ?? api.config,
					openClawRuntimeStatusProvider: buildRuntimeStatus,
				},
				backendDependenciesWithLeaseClient,
			);
			sdkRaw.registerSandboxBackend('gondolin', {
				factory: gondolinSandboxBackendFactory,
				manager: createGondolinSandboxBackendManager(
					{
						controllerUrl: gatewayControlLeaseClientEndpoint,
						zoneId: pluginConfig.zoneId,
					},
					backendDependenciesWithLeaseClient,
				),
			});
			return gondolinSandboxBackendFactory;
		},
	);
	gondolinSandboxBackendFactoryPromise.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : JSON.stringify(error);
		process.stderr.write(`[gondolin] failed to load OpenClaw SDK: ${message}\n`);
	});
	if (options.enableToolVmWriteReadE2eRoute === true) {
		registerToolVmWriteReadE2eRoute({
			api: { registerHttpRoute },
			factoryProvider: async () => await gondolinSandboxBackendFactoryPromise,
		});
	}
}

const plugin = {
	id: 'gondolin',
	name: 'Gondolin VM Sandbox',
	description: 'Sandbox backend powered by Gondolin micro-VMs.',

	register(api: Parameters<typeof registerGondolinPlugin>[0]): void {
		registerGondolinPlugin(api);
	},
};

export default plugin;

export { OPENCLAW_SSH_SESSION_SCRATCH_ROOT, createBackendDeps };
export type { SshHelpers };
