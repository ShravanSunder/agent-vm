import {
	GatewayRuntimeClient,
	type GatewayRuntimeClientOptions,
	type GatewayRuntimeTraceContext,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { getLogger } from '@logtape/logtape';

import {
	type AgentVmPluginConfigInput,
	type AgentVmPluginConfigJsonObject,
	resolveAgentVmPluginConfig,
} from './agent-vm-plugin-config.js';
import {
	createOpenClawGatewayRuntimeSandboxRegistration,
	type OpenClawGatewayRuntimeSandboxClient,
	type OpenClawGatewayRuntimeSandboxRegistration,
} from './gateway-runtime-sandbox-backend.js';
import {
	getOpenClawGatewayRuntimeClient,
	publishOpenClawGatewayRuntimeClient,
} from './openclaw-gateway-runtime-client-binding.js';
import {
	createOpenClawGatewayRuntimeTraceContextBridge,
	type OpenClawDiagnosticRuntimeLoader,
} from './openclaw-gateway-runtime-trace-context.js';
import type {
	OpenClawHttpRouteRegistrationApi,
	OpenClawPluginLogger,
	OpenClawSandboxBackendRegistrationApi,
	OpenClawPluginServiceRegistrationApi,
	OpenClawToolRegistrationApi,
} from './openclaw-sandbox-sdk-contract.js';
import { assertSdkShape } from './openclaw-sandbox-sdk-contract.js';
import {
	type OpenClawToolPortalClient,
	registerToolPortalNativeTools,
} from './tool-portal-native-tools.js';

type OpenClawGatewayRuntimeClient = Pick<GatewayRuntimeClient, 'connect' | 'disconnect'> &
	OpenClawToolPortalClient;

const openClawPluginLogger = getLogger(['agent-vm', 'openclaw-plugin']);
const maximumOpenClawPluginWarningLength = 256;

interface AgentVmPluginRegistrationApi {
	readonly config?: AgentVmPluginConfigJsonObject;
	readonly logger?: OpenClawPluginLogger | undefined;
	readonly pluginConfig: AgentVmPluginConfigInput;
	readonly registerHttpRoute?: OpenClawHttpRouteRegistrationApi['registerHttpRoute'];
	readonly registerService?: OpenClawPluginServiceRegistrationApi['registerService'];
	readonly registerTool?: OpenClawToolRegistrationApi['registerTool'];
	readonly registrationMode: string;
	readonly runtime?: {
		readonly config?: {
			readonly current?: () => AgentVmPluginConfigJsonObject;
		};
	};
}

function createOpenClawPluginWarningLogger(
	api: Pick<AgentVmPluginRegistrationApi, 'logger'>,
): Pick<OpenClawPluginLogger, 'warn'> {
	if (api.logger !== undefined) {
		return api.logger;
	}
	return {
		warn: (message: string): void => {
			const boundedMessage = message
				.replace(/[\r\n\t]/gu, ' ')
				.trim()
				.slice(0, maximumOpenClawPluginWarningLength);
			openClawPluginLogger.warn('OpenClaw plugin warning: {warning}', {
				warning: boundedMessage,
			});
		},
	};
}

interface RegisterAgentVmPluginOptions {
	readonly createSandboxRegistration?: (options: {
		readonly agentProjections: NonNullable<
			ReturnType<typeof resolveAgentVmPluginConfig>['toolPortal']
		>['agentProjections'];
		readonly client: OpenClawGatewayRuntimeClient;
		readonly traceContextProvider: () => GatewayRuntimeTraceContext | undefined;
	}) => OpenClawGatewayRuntimeSandboxRegistration;
	readonly createGatewayRuntimeClient?: (
		options: GatewayRuntimeClientOptions,
	) => OpenClawGatewayRuntimeClient;
	readonly onGatewayRuntimeClientCreated?: (options: {
		readonly agentProjections: NonNullable<
			ReturnType<typeof resolveAgentVmPluginConfig>['toolPortal']
		>['agentProjections'];
		readonly api: OpenClawHttpRouteRegistrationApi;
		readonly client: OpenClawGatewayRuntimeClient;
	}) => void;
	readonly loadOpenClawSandboxSdk?: () => Promise<OpenClawSandboxBackendRegistrationApi>;
	readonly loadOpenClawDiagnosticRuntime?: OpenClawDiagnosticRuntimeLoader;
}

function createOpenClawGatewayRuntimeClient(
	options: GatewayRuntimeClientOptions,
): OpenClawGatewayRuntimeClient {
	return new GatewayRuntimeClient(options);
}

function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertGatewayRuntimeSandboxClient(
	client: OpenClawGatewayRuntimeClient,
): asserts client is OpenClawGatewayRuntimeClient & OpenClawGatewayRuntimeSandboxClient {
	const unknownClient: unknown = client;
	if (!isUnknownRecord(unknownClient) || !isUnknownRecord(unknownClient.sandbox)) {
		throw new Error('GatewayRuntimeClient is missing the managed Sandbox API.');
	}
	for (const operationGroup of ['environment', 'execution', 'filesystem', 'stream'] as const) {
		if (!isUnknownRecord(unknownClient.sandbox[operationGroup])) {
			throw new Error(`GatewayRuntimeClient is missing Sandbox ${operationGroup} operations.`);
		}
	}
}

function createDefaultSandboxRegistration(options: {
	readonly agentProjections: NonNullable<
		ReturnType<typeof resolveAgentVmPluginConfig>['toolPortal']
	>['agentProjections'];
	readonly client: OpenClawGatewayRuntimeClient;
	readonly traceContextProvider: () => GatewayRuntimeTraceContext | undefined;
}): OpenClawGatewayRuntimeSandboxRegistration {
	assertGatewayRuntimeSandboxClient(options.client);
	return createOpenClawGatewayRuntimeSandboxRegistration({
		agentProjections: options.agentProjections,
		client: options.client,
		traceContextProvider: options.traceContextProvider,
	});
}

async function loadOpenClawSandboxSdk(): Promise<OpenClawSandboxBackendRegistrationApi> {
	const sdkPath = '/opt/openclaw-sdk/sandbox.js';
	const sdkModule: unknown = await import(sdkPath);
	assertSdkShape(sdkModule);
	return sdkModule;
}

export function registerAgentVmPlugin(
	api: AgentVmPluginRegistrationApi,
	options: RegisterAgentVmPluginOptions = {},
): void {
	const registerTool = api.registerTool;
	if (typeof registerTool !== 'function') {
		if (api.registrationMode === 'full') {
			throw new Error('Gondolin full registration requires OpenClaw registerTool.');
		}
		return;
	}
	const warningLogger = createOpenClawPluginWarningLogger(api);

	const pluginConfig = resolveAgentVmPluginConfig(api.pluginConfig);
	const toolPortalConfig = pluginConfig.toolPortal;
	if (api.registrationMode !== 'full') {
		if (toolPortalConfig !== undefined) {
			registerToolPortalNativeTools({
				agentProjections: toolPortalConfig.agentProjections,
				api: { registerTool },
				clientProvider: getOpenClawGatewayRuntimeClient,
				logger: warningLogger,
			});
		}
		return;
	}

	if (toolPortalConfig === undefined) {
		throw new Error('Gondolin full registration requires toolPortal.');
	}
	const registerService = api.registerService;
	if (typeof registerService !== 'function') {
		throw new Error('Gondolin Tool Portal registration requires OpenClaw registerService.');
	}

	const createGatewayRuntimeClient =
		options.createGatewayRuntimeClient ?? createOpenClawGatewayRuntimeClient;
	const traceContextBridge = createOpenClawGatewayRuntimeTraceContextBridge(
		options.loadOpenClawDiagnosticRuntime === undefined
			? {}
			: { loadDiagnosticRuntime: options.loadOpenClawDiagnosticRuntime },
	);
	const gatewayRuntimeClient = createGatewayRuntimeClient({
		attachment: toolPortalConfig.attachment,
		traceContextProvider: traceContextBridge.provide,
	});
	const createSandboxRegistration =
		options.createSandboxRegistration ?? createDefaultSandboxRegistration;
	let sandboxRegistration: OpenClawGatewayRuntimeSandboxRegistration | undefined;
	let restoreSandboxBackend: (() => void) | undefined;
	let releaseGatewayRuntimeClient: (() => void) | undefined;
	const unregisterSandboxBackend = (): void => {
		try {
			restoreSandboxBackend?.();
		} finally {
			restoreSandboxBackend = undefined;
		}
	};
	registerToolPortalNativeTools({
		agentProjections: toolPortalConfig.agentProjections,
		api: { registerTool },
		clientProvider: getOpenClawGatewayRuntimeClient,
		logger: warningLogger,
	});
	options.onGatewayRuntimeClientCreated?.({
		agentProjections: toolPortalConfig.agentProjections,
		api: api.registerHttpRoute === undefined ? {} : { registerHttpRoute: api.registerHttpRoute },
		client: gatewayRuntimeClient,
	});
	registerService({
		id: 'agent-vm-gateway-runtime-client',
		start: async () => {
			try {
				await traceContextBridge.load();
				await gatewayRuntimeClient.connect();
				sandboxRegistration = createSandboxRegistration({
					agentProjections: toolPortalConfig.agentProjections,
					client: gatewayRuntimeClient,
					traceContextProvider: traceContextBridge.provide,
				});
				const sandboxSdk = await (options.loadOpenClawSandboxSdk ?? loadOpenClawSandboxSdk)();
				restoreSandboxBackend = sandboxSdk.registerSandboxBackend('gondolin', {
					factory: sandboxRegistration.factory,
					resolveWorkdir: sandboxRegistration.resolveWorkdir,
				});
				releaseGatewayRuntimeClient?.();
				releaseGatewayRuntimeClient = publishOpenClawGatewayRuntimeClient(gatewayRuntimeClient);
			} catch (error: unknown) {
				releaseGatewayRuntimeClient?.();
				releaseGatewayRuntimeClient = undefined;
				try {
					unregisterSandboxBackend();
				} catch {
					// Preserve the startup failure while still closing reservations and the client.
				}
				await sandboxRegistration?.close().catch(() => undefined);
				await gatewayRuntimeClient.disconnect().catch(() => undefined);
				throw error;
			}
		},
		stop: async () => {
			releaseGatewayRuntimeClient?.();
			releaseGatewayRuntimeClient = undefined;
			try {
				unregisterSandboxBackend();
			} finally {
				try {
					await sandboxRegistration?.close();
				} finally {
					await gatewayRuntimeClient.disconnect();
				}
			}
		},
	});
}

const plugin = {
	id: 'gondolin',
	name: 'Gondolin VM Sandbox',
	description: 'Thin OpenClaw adapter for the agent-vm Gateway Runtime service.',

	register(api: Parameters<typeof registerAgentVmPlugin>[0]): void {
		registerAgentVmPlugin(api);
	},
};

export default plugin;
