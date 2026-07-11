import {
	GatewayControlRpcCommandResultMessageSchema,
	GatewayControlRpcMessageSchema,
} from '@agent-vm/gateway-control-contracts';

import {
	startGatewayControlSessionHeartbeat,
	type GatewayControlEventPublisher,
	type GatewayControlSessionHeartbeatHandle,
} from './gateway-control-event-publisher.js';
import {
	createGatewayControlService,
	type GatewayControlApplicationMessageHandler,
	type GatewayControlIdentity,
	type GatewayControlService,
} from './gateway-control-service.js';

const GATEWAY_CONTROL_SERVICE_RUNTIME_STORES_KEY = Symbol.for(
	'agent-vm.openclawGatewayControlServiceRuntimeStores',
);

export interface GatewayControlServiceRuntime {
	heartbeat?: GatewayControlSessionHeartbeatHandle;
	readonly service: GatewayControlService;
}

export interface GetOrCreateGatewayControlServiceRuntimeOptions {
	readonly identity: GatewayControlIdentity;
	readonly verifierPublicKeyPem: string;
}

export interface EnsureGatewayControlSessionHeartbeatOptions {
	readonly identity: GatewayControlIdentity;
	readonly publisher: GatewayControlEventPublisher;
	readonly runtime: GatewayControlServiceRuntime;
	readonly writeLog?: (message: string) => void;
}

interface GatewayControlServiceRuntimeGlobalStore {
	[key: symbol]: unknown;
}

interface GatewayControlServiceRuntimeStores {
	readonly activeRuntimeKeys: Map<string, string>;
	readonly runtimes: Map<string, GatewayControlServiceRuntime>;
}

function activeRuntimeKey(options: GetOrCreateGatewayControlServiceRuntimeOptions): string {
	return JSON.stringify([options.identity.zoneId, options.identity.peerId]);
}

function isGatewayControlServiceRuntimeStores(
	value: unknown,
): value is GatewayControlServiceRuntimeStores {
	return (
		typeof value === 'object' &&
		value !== null &&
		'activeRuntimeKeys' in value &&
		'runtimes' in value &&
		value.activeRuntimeKeys instanceof Map &&
		value.runtimes instanceof Map
	);
}

function gatewayControlServiceRuntimeStores(): GatewayControlServiceRuntimeStores {
	const globalStore = globalThis as typeof globalThis & GatewayControlServiceRuntimeGlobalStore;
	const existingStores = globalStore[GATEWAY_CONTROL_SERVICE_RUNTIME_STORES_KEY];
	if (isGatewayControlServiceRuntimeStores(existingStores)) {
		return existingStores;
	}
	const stores = {
		activeRuntimeKeys: new Map<string, string>(),
		runtimes: new Map<string, GatewayControlServiceRuntime>(),
	} satisfies GatewayControlServiceRuntimeStores;
	globalStore[GATEWAY_CONTROL_SERVICE_RUNTIME_STORES_KEY] = stores;
	return stores;
}

function runtimeCacheKey(options: GetOrCreateGatewayControlServiceRuntimeOptions): string {
	return JSON.stringify([
		options.identity.zoneId,
		options.identity.peerId,
		options.identity.bootId,
		options.identity.processEpoch,
		options.identity.generationId,
		options.identity.controllerEpoch,
		options.verifierPublicKeyPem,
	]);
}

function createGatewayControlApplicationMessageHandler(): GatewayControlApplicationMessageHandler {
	return {
		handle: async ({ envelope, payload }) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			if (message.kind !== 'command') {
				return undefined;
			}
			if (message.operation === 'control_ping') {
				return GatewayControlRpcCommandResultMessageSchema.parse({
					kind: 'command_result',
					operation: 'control_ping',
					payload: {
						responseToMessageId: envelope.messageId,
						result: 'ok',
					},
				});
			}
			return GatewayControlRpcCommandResultMessageSchema.parse({
				kind: 'command_result',
				operation: message.operation,
				payload: {
					error: {
						errorClass: 'unsupported_gateway_control_command',
						retryable: false,
						safeMessage: `Gateway control command '${message.operation}' is not implemented by this peer.`,
					},
					responseToMessageId: envelope.messageId,
					result: 'rejected',
				},
			});
		},
		messageIdentity: ({ payload }) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			return {
				kind: message.kind,
				...(message.operation === undefined ? {} : { operation: message.operation }),
			};
		},
		buildHandlerFailureResult: ({ envelope, payload }) => {
			const message = GatewayControlRpcMessageSchema.parse(payload);
			if (message.kind !== 'command') {
				return undefined;
			}
			return GatewayControlRpcCommandResultMessageSchema.parse({
				kind: 'command_result',
				operation: message.operation,
				payload: {
					error: {
						errorClass: 'gateway_control_handler_failed',
						retryable: true,
						safeMessage: `Gateway control command '${message.operation}' failed after acceptance.`,
					},
					responseToMessageId: envelope.messageId,
					result: 'failed',
				},
			});
		},
	};
}

export function getOrCreateGatewayControlServiceRuntime(
	options: GetOrCreateGatewayControlServiceRuntimeOptions,
): GatewayControlServiceRuntime {
	const cacheKey = runtimeCacheKey(options);
	const peerActiveRuntimeKey = activeRuntimeKey(options);
	const { activeRuntimeKeys, runtimes } = gatewayControlServiceRuntimeStores();
	const existingRuntime = runtimes.get(cacheKey);
	if (existingRuntime !== undefined) {
		activeRuntimeKeys.set(peerActiveRuntimeKey, cacheKey);
		return existingRuntime;
	}
	const previousCacheKey = activeRuntimeKeys.get(peerActiveRuntimeKey);
	if (previousCacheKey !== undefined && previousCacheKey !== cacheKey) {
		const previousRuntime = runtimes.get(previousCacheKey);
		previousRuntime?.heartbeat?.stop();
		void previousRuntime?.service.close();
		runtimes.delete(previousCacheKey);
	}
	const runtime = {
		service: createGatewayControlService({
			applicationMessageHandler: createGatewayControlApplicationMessageHandler(),
			identity: options.identity,
			verifierPublicKeyPem: options.verifierPublicKeyPem,
		}),
	} satisfies GatewayControlServiceRuntime;
	runtimes.set(cacheKey, runtime);
	activeRuntimeKeys.set(peerActiveRuntimeKey, cacheKey);
	return runtime;
}

export function ensureGatewayControlSessionHeartbeat(
	options: EnsureGatewayControlSessionHeartbeatOptions,
): void {
	if (options.runtime.heartbeat !== undefined) {
		return;
	}
	options.runtime.heartbeat = startGatewayControlSessionHeartbeat({
		identity: options.identity,
		publisher: options.publisher,
		...(options.writeLog === undefined ? {} : { writeLog: options.writeLog }),
	});
}
