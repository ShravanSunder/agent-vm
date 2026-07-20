import { createServer, type Server as HttpServer } from 'node:http';

import { createGatewayRuntimeControlMessageHandler } from './gateway-control-default-message-handler.js';
import {
	GATEWAY_CONTROL_READY_PATH,
	GATEWAY_CONTROL_SOCKET_PATH,
	createGatewayControlService,
	type GatewayControlService,
	type GatewayControlServiceOptions,
} from './gateway-control-session-service.js';

const DEFAULT_CONTROL_ENDPOINT_DRAIN_TIMEOUT_MS = 2_000;

export * from './gateway-control-session-service.js';
export { createGatewayRuntimeControlMessageHandler } from './gateway-control-default-message-handler.js';

export interface GatewayControlEndpointListenOptions {
	readonly host: string;
	readonly port: number;
}

export interface StartGatewayControlEndpointOptions extends GatewayControlServiceOptions {
	readonly listen: GatewayControlEndpointListenOptions;
}

export interface GatewayControlEndpointReadiness {
	readonly host: string;
	readonly port: number;
	readonly readyPath: typeof GATEWAY_CONTROL_READY_PATH;
	readonly socketPath: typeof GATEWAY_CONTROL_SOCKET_PATH;
}

export interface GatewayControlEndpoint {
	readonly close: (options?: { readonly drainTimeoutMs?: number }) => Promise<void>;
	readonly readiness: GatewayControlEndpointReadiness;
	readonly service: GatewayControlService;
}

function requestPath(requestUrl: string | undefined): string | undefined {
	try {
		return new URL(requestUrl ?? '/', 'http://gateway-runtime.local').pathname;
	} catch {
		return undefined;
	}
}

function validateListenOptions(options: GatewayControlEndpointListenOptions): void {
	if (options.host.trim() === '') throw new Error('gateway control endpoint host is required');
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
		throw new RangeError('gateway control endpoint port must be an integer from 0 through 65535');
	}
}

async function listen(
	server: HttpServer,
	options: GatewayControlEndpointListenOptions,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off('listening', onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(options.port, options.host);
	});
}

async function closeHttpServer(server: HttpServer, drainTimeoutMs: number): Promise<void> {
	const closed = new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error !== undefined) reject(error);
			else resolve();
		});
	});
	server.closeIdleConnections();
	const forceTimer = setTimeout(() => server.closeAllConnections(), drainTimeoutMs);
	forceTimer.unref?.();
	try {
		await closed;
	} finally {
		clearTimeout(forceTimer);
	}
}

export async function startGatewayControlEndpoint(
	options: StartGatewayControlEndpointOptions,
): Promise<GatewayControlEndpoint> {
	validateListenOptions(options.listen);
	const service = createGatewayControlService({
		applicationMessageHandler:
			options.applicationMessageHandler ?? createGatewayRuntimeControlMessageHandler(),
		identity: options.identity,
		...(options.nonceTtlMs === undefined ? {} : { nonceTtlMs: options.nonceTtlMs }),
		...(options.now === undefined ? {} : { now: options.now }),
		verifierPublicKeyPem: options.verifierPublicKeyPem,
	});
	const server = createServer((request, response) => {
		const path = requestPath(request.url);
		if (path === undefined) {
			response.statusCode = 400;
			response.setHeader('cache-control', 'no-store');
			response.setHeader('content-type', 'text/plain; charset=utf-8');
			response.end('bad request\n');
			return;
		}
		if (path === GATEWAY_CONTROL_READY_PATH) {
			service.handleReadyRequest(request, response);
			return;
		}
		response.statusCode = 404;
		response.setHeader('cache-control', 'no-store');
		response.setHeader('content-type', 'text/plain; charset=utf-8');
		response.end('not found\n');
	});
	server.on('upgrade', (request, socket, head) => {
		const path = requestPath(request.url);
		if (path === undefined) {
			socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
			socket.destroy();
			return;
		}
		if (path !== GATEWAY_CONTROL_SOCKET_PATH) {
			socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
			socket.destroy();
			return;
		}
		service.handleUpgrade(request, socket, head);
	});
	try {
		await listen(server, options.listen);
	} catch (error: unknown) {
		await service.close().catch(() => undefined);
		throw error;
	}
	const address = server.address();
	if (address === null || typeof address === 'string') {
		await service.close().catch(() => undefined);
		await closeHttpServer(server, 1).catch(() => undefined);
		throw new Error('gateway control endpoint did not bind an IP socket');
	}
	let closePromise: Promise<void> | undefined;
	return {
		close: (closeOptions = {}) => {
			const drainTimeoutMs =
				closeOptions.drainTimeoutMs ?? DEFAULT_CONTROL_ENDPOINT_DRAIN_TIMEOUT_MS;
			if (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs <= 0) {
				return Promise.reject(
					new RangeError('gateway control endpoint drain timeout must be positive'),
				);
			}
			closePromise ??= (async () => {
				const serverClose = closeHttpServer(server, drainTimeoutMs);
				const cleanupResults = await Promise.allSettled([service.close(), serverClose]);
				const failures = cleanupResults.flatMap((result) =>
					result.status === 'rejected' ? [result.reason] : [],
				);
				if (failures.length > 0) {
					throw new AggregateError(failures, 'gateway control endpoint retirement failed');
				}
			})();
			return closePromise;
		},
		readiness: Object.freeze({
			host: options.listen.host,
			port: address.port,
			readyPath: GATEWAY_CONTROL_READY_PATH,
			socketPath: GATEWAY_CONTROL_SOCKET_PATH,
		}),
		service,
	};
}
