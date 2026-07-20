import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { ControllerExecutionWebSocketPath } from '@agent-vm/controller-execution-contracts/controller-execution-data-boundary';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import type { ControllerExecutionWebSocketSession } from './controller-execution-websocket-session.js';

export type ControllerExecutionUpgradeAuthentication<TAuthenticatedContext> =
	| {
			readonly authenticatedContext: TAuthenticatedContext;
			readonly kind: 'authenticated';
	  }
	| {
			readonly kind: 'rejected';
			readonly reason: string;
	  };

export interface CreateControllerExecutionWebSocketUpgradeHandlerOptions<TAuthenticatedContext> {
	readonly authenticateUpgrade: (
		request: IncomingMessage,
	) => Promise<ControllerExecutionUpgradeAuthentication<TAuthenticatedContext>>;
	readonly createSession: (props: {
		readonly authenticatedContext: TAuthenticatedContext;
		readonly socket: WebSocket;
	}) => ControllerExecutionWebSocketSession;
	readonly limits: {
		readonly maxMessageBytes: number;
	};
}

export type ControllerExecutionWebSocketUpgradeHandler = (
	request: IncomingMessage,
	socket: Duplex,
	head: Buffer,
) => Promise<void>;

function rejectHttpUpgrade(socket: Duplex, status: 401 | 404): void {
	const reason = status === 401 ? 'Unauthorized' : 'Not Found';
	socket.end(
		`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
	);
}

function rawDataToUtf8(data: RawData): string {
	if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
	return data.toString('utf8');
}

function closeWebSocket(socket: WebSocket, code: number, reason: string): void {
	if (socket.readyState === socket.OPEN) socket.close(code, reason);
}

export function createControllerExecutionWebSocketUpgradeHandler<TAuthenticatedContext>(
	options: CreateControllerExecutionWebSocketUpgradeHandlerOptions<TAuthenticatedContext>,
): ControllerExecutionWebSocketUpgradeHandler {
	if (
		!Number.isSafeInteger(options.limits.maxMessageBytes) ||
		options.limits.maxMessageBytes <= 0
	) {
		throw new Error(
			'Controller execution WebSocket maxMessageBytes must be a positive safe integer.',
		);
	}

	const webSocketServer = new WebSocketServer({
		clientTracking: false,
		maxPayload: options.limits.maxMessageBytes,
		noServer: true,
		perMessageDeflate: false,
	});

	return async (request, socket, head): Promise<void> => {
		if (request.method !== 'GET' || request.url !== ControllerExecutionWebSocketPath) {
			rejectHttpUpgrade(socket, 404);
			return;
		}

		let authentication: ControllerExecutionUpgradeAuthentication<TAuthenticatedContext>;
		try {
			authentication = await options.authenticateUpgrade(request);
		} catch {
			rejectHttpUpgrade(socket, 401);
			return;
		}
		if (authentication.kind === 'rejected') {
			rejectHttpUpgrade(socket, 401);
			return;
		}

		await new Promise<void>((resolve, reject) => {
			try {
				webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
					webSocket.on('error', (): void => undefined);
					let session: ControllerExecutionWebSocketSession;
					try {
						session = options.createSession({
							authenticatedContext: authentication.authenticatedContext,
							socket: webSocket,
						});
						const activation = session.activateAuthenticatedUpgrade();
						if (activation.kind === 'rejected') {
							closeWebSocket(webSocket, 1008, activation.reason);
							resolve();
							return;
						}
					} catch {
						closeWebSocket(webSocket, 1011, 'session-initialization-failed');
						resolve();
						return;
					}
					webSocket.once('close', (): void => {
						session.notifyTransportClosed();
					});

					let receiveSequence = Promise.resolve();
					webSocket.on('message', (data, isBinary) => {
						if (isBinary) {
							closeWebSocket(webSocket, 1003, 'binary-message-not-supported');
							return;
						}
						const text = rawDataToUtf8(data);
						receiveSequence = receiveSequence
							.then(async (): Promise<void> => {
								await session.receiveText(text);
							})
							.catch((): void => {
								closeWebSocket(webSocket, 1011, 'session-receive-failed');
							});
					});
					resolve();
				});
			} catch (error: unknown) {
				reject(error);
			}
		});
	};
}
