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

const GATEWAY_CONTROL_SERVICE_RUNTIMES_KEY = Symbol.for(
	'agent-vm.openclawGatewayControlServiceRuntimes',
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
	[key: symbol]: Map<string, GatewayControlServiceRuntime> | undefined;
}

function runtimeCacheKey(options: GetOrCreateGatewayControlServiceRuntimeOptions): string {
	return JSON.stringify([
		options.identity.zoneId,
		options.identity.peerId,
		options.identity.bootId,
		options.identity.generationId,
		options.identity.controllerEpoch,
		options.verifierPublicKeyPem,
	]);
}

function gatewayControlServiceRuntimes(): Map<string, GatewayControlServiceRuntime> {
	const globalStore = globalThis as typeof globalThis & GatewayControlServiceRuntimeGlobalStore;
	globalStore[GATEWAY_CONTROL_SERVICE_RUNTIMES_KEY] ??= new Map();
	return globalStore[GATEWAY_CONTROL_SERVICE_RUNTIMES_KEY];
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
	const runtimes = gatewayControlServiceRuntimes();
	const existingRuntime = runtimes.get(cacheKey);
	if (existingRuntime !== undefined) {
		return existingRuntime;
	}
	const runtime = {
		service: createGatewayControlService({
			applicationMessageHandler: createGatewayControlApplicationMessageHandler(),
			identity: options.identity,
			verifierPublicKeyPem: options.verifierPublicKeyPem,
		}),
	} satisfies GatewayControlServiceRuntime;
	runtimes.set(cacheKey, runtime);
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
