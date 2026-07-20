import { Buffer } from 'node:buffer';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import {
	ControllerExecutionWebSocketPath,
	type ControllerExecutionDataFrame,
	type ControllerExecutionDataHandshake,
} from '@agent-vm/controller-execution-contracts/controller-execution-data-boundary';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import {
	createControllerExecutionDataChannel,
	type ControllerExecutionDataChannel,
} from './controller-execution-data-channel.js';
import { createControllerExecutionWebSocketUpgradeHandler } from './controller-execution-websocket-server.js';
import {
	createControllerExecutionWebSocketSession,
	type ControllerExecutionWebSocketCreditResult,
	type ControllerExecutionWebSocketSession,
	type ControllerExecutionWebSocketSessionReceiveResult,
} from './controller-execution-websocket-session.js';

const controllerCredential = 'controller-credential-a';
const fixtureSocketCloseTimeoutMs = 2_000;
const authenticatedContext = {
	credentialId: 'controller-credential-id-a',
	stablePrincipal: 'a'.repeat(64),
} as const;
const binding = {
	audience: 'controller-execution-data',
	channelId: 'channel-a',
	controllerEpoch: 'controller-epoch-a',
	executionFingerprint: 'fingerprint-a',
	gatewayEpoch: 'gateway-epoch-a',
	operationId: 'operation-a',
	runtimeEpoch: 'runtime-epoch-a',
	stablePrincipal: authenticatedContext.stablePrincipal,
} as const;
const handshake = {
	...binding,
	kind: 'handshake',
} as const satisfies ControllerExecutionDataHandshake;
const dataFrame = {
	...binding,
	creditBytes: 1024,
	kind: 'data',
	payloadBase64: 'AQID',
	sequence: 0,
} as const satisfies ControllerExecutionDataFrame;
const workLaneLimits = {
	codec: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
	execution: { maxConcurrentTasks: 1, maxQueuedTasks: 0 },
} as const;

type TestUpgradeAuthenticationResult =
	| {
			readonly authenticatedContext: typeof authenticatedContext;
			readonly kind: 'authenticated';
	  }
	| { readonly kind: 'rejected'; readonly reason: 'invalid-credential' };

interface Deferred<TValue> {
	readonly promise: Promise<TValue>;
	readonly resolve: (value: TValue) => void;
}

interface CreateSessionProps {
	readonly authenticatedContext: typeof authenticatedContext;
	readonly socket: WebSocket;
}

interface ControllerExecutionServerFixture {
	readonly clients: Set<WebSocket>;
	readonly close: () => Promise<void>;
	readonly rawSockets: Set<Socket>;
	readonly server: HttpServer;
	readonly urlFor: (path?: string) => string;
}

interface CreateControllerExecutionServerFixtureOptions {
	readonly authenticateUpgrade: (
		request: IncomingMessage,
	) => Promise<TestUpgradeAuthenticationResult>;
	readonly createSession: (props: CreateSessionProps) => ControllerExecutionWebSocketSession;
	readonly limits?: { readonly maxMessageBytes: number };
}

interface WebSocketCloseReceipt {
	readonly code: number;
	readonly reason: string;
}

function createDeferred<TValue>(): Deferred<TValue> {
	let resolvePromise: ((value: TValue) => void) | undefined;
	const promise = new Promise<TValue>((resolve) => {
		resolvePromise = resolve;
	});
	if (resolvePromise === undefined) {
		throw new Error('Expected deferred promise resolver to be initialized.');
	}
	return { promise, resolve: resolvePromise };
}

function createAcceptedSession(receiveText?: {
	readonly invoke: (text: string) => Promise<ControllerExecutionWebSocketSessionReceiveResult>;
}): ControllerExecutionWebSocketSession {
	return {
		activateAuthenticatedUpgrade: () => ({ kind: 'accepted' }),
		consumeData: async (): Promise<ControllerExecutionWebSocketCreditResult> => ({
			kind: 'rejected',
			reason: 'session-closed',
		}),
		notifyTransportClosed: (): void => undefined,
		receiveText:
			receiveText?.invoke ??
			(async (): Promise<ControllerExecutionWebSocketSessionReceiveResult> => ({
				kind: 'rejected',
				reason: 'invalid-message',
			})),
	};
}

async function waitForImmediateTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForWebSocketOpen(socket: WebSocket): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			socket.off('open', onOpen);
			reject(error);
		};
		const onOpen = (): void => {
			socket.off('error', onError);
			resolve();
		};
		socket.once('error', onError);
		socket.once('open', onOpen);
	});
}

async function waitForWebSocketClose(socket: WebSocket): Promise<WebSocketCloseReceipt> {
	return await new Promise<WebSocketCloseReceipt>((resolve, reject) => {
		const onError = (error: Error): void => {
			socket.off('close', onClose);
			reject(error);
		};
		const onClose = (code: number, reason: Buffer): void => {
			socket.off('error', onError);
			resolve({ code, reason: reason.toString('utf8') });
		};
		socket.once('error', onError);
		socket.once('close', onClose);
	});
}

async function sendWebSocketMessage(
	socket: WebSocket,
	data: string | Buffer,
	options?: { readonly binary: boolean },
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const callback = (error?: Error | null): void => {
			if (error !== undefined && error !== null) {
				reject(error);
				return;
			}
			resolve();
		};
		if (options === undefined) {
			socket.send(data, callback);
			return;
		}
		socket.send(data, { binary: options.binary }, callback);
	});
}

async function waitForTrackedSocketCloseEvents(
	closeEvents: readonly Promise<void>[],
): Promise<void> {
	if (closeEvents.length === 0) return;
	await Promise.race([
		Promise.all(closeEvents).then((): void => undefined),
		new Promise<never>((_resolve, reject) =>
			AbortSignal.timeout(fixtureSocketCloseTimeoutMs).addEventListener(
				'abort',
				() =>
					reject(
						new Error(
							`Controller execution fixture sockets did not close within ${String(fixtureSocketCloseTimeoutMs)} ms.`,
						),
					),
				{ once: true },
			),
		),
	]);
}

async function closeHttpServer(server: HttpServer): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error !== undefined) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

async function createControllerExecutionServerFixture(
	options: CreateControllerExecutionServerFixtureOptions,
): Promise<ControllerExecutionServerFixture> {
	const handleUpgrade = createControllerExecutionWebSocketUpgradeHandler({
		authenticateUpgrade: options.authenticateUpgrade,
		createSession: options.createSession,
		limits: options.limits ?? { maxMessageBytes: 4096 },
	});
	const server = createServer((_request, response) => {
		response.writeHead(404).end();
	});
	const rawSockets = new Set<Socket>();
	const rawSocketCloseEvents = new Map<Socket, Promise<void>>();
	const clients = new Set<WebSocket>();
	server.on('connection', (socket) => {
		const closeEvent = createDeferred<void>();
		rawSockets.add(socket);
		rawSocketCloseEvents.set(socket, closeEvent.promise);
		socket.once('close', () => {
			rawSockets.delete(socket);
			rawSocketCloseEvents.delete(socket);
			closeEvent.resolve();
		});
	});
	const upgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
		const completion: Promise<void> = handleUpgrade(request, socket, head);
		void completion.catch((error: unknown) => {
			socket.destroy(error instanceof Error ? error : new Error('WebSocket upgrade failed.'));
		});
	};
	server.on('upgrade', upgradeListener);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Expected controller execution test server to bind a TCP address.');
	}
	const port = (address satisfies AddressInfo).port;

	return {
		clients,
		close: async (): Promise<void> => {
			server.off('upgrade', upgradeListener);
			const serverClose = closeHttpServer(server);
			const socketCloseEvents = [...rawSocketCloseEvents.values()];
			for (const client of clients) {
				client.terminate();
			}
			for (const socket of rawSockets) {
				socket.destroy();
			}
			await Promise.all([serverClose, waitForTrackedSocketCloseEvents(socketCloseEvents)]);
		},
		rawSockets,
		server,
		urlFor: (path = ControllerExecutionWebSocketPath): string =>
			`ws://127.0.0.1:${String(port)}${path}`,
	};
}

function connectWebSocket(
	fixture: ControllerExecutionServerFixture,
	options?: {
		readonly authorization?: string;
		readonly path?: string;
	},
): WebSocket {
	const headers =
		options?.authorization === undefined ? undefined : { authorization: options.authorization };
	const socket = new WebSocket(fixture.urlFor(options?.path), { headers });
	fixture.clients.add(socket);
	socket.once('close', () => fixture.clients.delete(socket));
	return socket;
}

async function connectExpectingHttpRejection(
	fixture: ControllerExecutionServerFixture,
	options: { readonly authorization?: string; readonly path?: string },
): Promise<number> {
	const socket = connectWebSocket(fixture, options);
	return await new Promise<number>((resolve, reject) => {
		socket.once('error', () => undefined);
		socket.once('open', () => reject(new Error('Expected WebSocket upgrade rejection.')));
		socket.once('unexpected-response', (request, response) => {
			const statusCode = response.statusCode;
			response.resume();
			request.destroy();
			if (statusCode === undefined) {
				reject(new Error('Expected rejected upgrade to include an HTTP status code.'));
				return;
			}
			resolve(statusCode);
		});
	});
}

async function authenticateControllerCredential(
	request: IncomingMessage,
): Promise<TestUpgradeAuthenticationResult> {
	return request.headers.authorization === `Bearer ${controllerCredential}`
		? { authenticatedContext, kind: 'authenticated' }
		: { kind: 'rejected', reason: 'invalid-credential' };
}

describe('controller execution WebSocket upgrade authentication', () => {
	it('finishes authentication before the 101 and creates a session only after upgrade', async () => {
		const authenticationStarted = createDeferred<void>();
		const authenticationDecision = createDeferred<TestUpgradeAuthenticationResult>();
		const callOrder: string[] = [];
		const authenticateUpgrade = vi.fn(
			async (_request: IncomingMessage): Promise<TestUpgradeAuthenticationResult> => {
				callOrder.push('authenticate-start');
				authenticationStarted.resolve();
				const result = await authenticationDecision.promise;
				callOrder.push('authenticate-finish');
				return result;
			},
		);
		const createSession = vi.fn((_props: CreateSessionProps) => {
			callOrder.push('create-session');
			return createAcceptedSession();
		});
		const fixture = await createControllerExecutionServerFixture({
			authenticateUpgrade,
			createSession,
		});

		try {
			const client = connectWebSocket(fixture, {
				authorization: `Bearer ${controllerCredential}`,
			});
			let upgradeHeaders: IncomingHttpHeaders | undefined;
			client.once('upgrade', (response) => {
				upgradeHeaders = response.headers;
			});
			await authenticationStarted.promise;
			await waitForImmediateTurn();
			expect(client.readyState).toBe(WebSocket.CONNECTING);
			expect(createSession).not.toHaveBeenCalled();

			authenticationDecision.resolve({ authenticatedContext, kind: 'authenticated' });
			await waitForWebSocketOpen(client);
			expect(callOrder).toEqual(['authenticate-start', 'authenticate-finish', 'create-session']);
			expect(createSession).toHaveBeenCalledOnce();
			expect(createSession.mock.calls[0]?.[0].authenticatedContext).toEqual(authenticatedContext);
			expect(createSession.mock.calls[0]?.[0].socket.readyState).toBe(WebSocket.OPEN);
			expect(upgradeHeaders?.['sec-websocket-extensions']).toBeUndefined();
			expect(client.extensions).toBe('');
		} finally {
			await fixture.close();
		}
	});

	it.each([
		{ path: '/agent-vm/controller-execution-other', title: 'a sibling path' },
		{
			path: `${ControllerExecutionWebSocketPath}?credential=${controllerCredential}`,
			title: 'a credential query string',
		},
	])('rejects $title before credential authentication', async ({ path }) => {
		const authenticateUpgrade = vi.fn(authenticateControllerCredential);
		const createSession = vi.fn((_props: CreateSessionProps) => createAcceptedSession());
		const fixture = await createControllerExecutionServerFixture({
			authenticateUpgrade,
			createSession,
		});

		try {
			await expect(
				connectExpectingHttpRejection(fixture, {
					authorization: `Bearer ${controllerCredential}`,
					path,
				}),
			).resolves.toBe(404);
			expect(authenticateUpgrade).not.toHaveBeenCalled();
			expect(createSession).not.toHaveBeenCalled();
		} finally {
			await fixture.close();
		}
	});

	it('rejects a wrong header credential without upgrading or creating a session', async () => {
		const authenticateUpgrade = vi.fn(authenticateControllerCredential);
		const createSession = vi.fn((_props: CreateSessionProps) => createAcceptedSession());
		const fixture = await createControllerExecutionServerFixture({
			authenticateUpgrade,
			createSession,
		});

		try {
			await expect(
				connectExpectingHttpRejection(fixture, {
					authorization: 'Bearer attacker-credential',
				}),
			).resolves.toBe(401);
			expect(authenticateUpgrade).toHaveBeenCalledOnce();
			expect(createSession).not.toHaveBeenCalled();
		} finally {
			await fixture.close();
		}
	});
});

describe('controller execution WebSocket message boundary', () => {
	it('serializes strict handshake and data messages into the authenticated session', async () => {
		const deliveredData = createDeferred<Uint8Array>();
		const receivedTexts: string[] = [];
		let activeReceiveCount = 0;
		let maximumActiveReceiveCount = 0;
		let channel: ControllerExecutionDataChannel | undefined;
		const createSession = vi.fn((props: CreateSessionProps) => {
			channel = createControllerExecutionDataChannel({
				binding,
				deadlineMilliseconds: {
					heartbeat: 1_000,
					'recovery-admission': 1_000,
					'safety-cancel': 1_000,
				},
				limits: { initialCreditBytes: 1024, maxQueuedBytes: 1024 },
				workLaneLimits,
				runtime: {
					clock: { now: (): number => 0 },
					scheduler: {
						schedule: (): void => {
							throw new Error('WebSocket server integration must not schedule deadlines.');
						},
					},
				},
			});
			const innerSession = createControllerExecutionWebSocketSession({
				channel,
				close: async ({ code, reason }): Promise<void> => props.socket.close(code, reason),
				limits: { maxMessageBytes: 4096 },
				onData: async (data): Promise<void> => deliveredData.resolve(data),
				onTerminal: async (): Promise<void> => undefined,
				sendText: async (text): Promise<void> => {
					await sendWebSocketMessage(props.socket, text);
				},
			});
			return {
				...innerSession,
				receiveText: async (
					text: string,
				): Promise<ControllerExecutionWebSocketSessionReceiveResult> => {
					receivedTexts.push(text);
					activeReceiveCount += 1;
					maximumActiveReceiveCount = Math.max(maximumActiveReceiveCount, activeReceiveCount);
					try {
						await waitForImmediateTurn();
						return await innerSession.receiveText(text);
					} finally {
						activeReceiveCount -= 1;
					}
				},
			} satisfies ControllerExecutionWebSocketSession;
		});
		const fixture = await createControllerExecutionServerFixture({
			authenticateUpgrade: authenticateControllerCredential,
			createSession,
		});

		try {
			const client = connectWebSocket(fixture, {
				authorization: `Bearer ${controllerCredential}`,
			});
			await waitForWebSocketOpen(client);
			const handshakeText = JSON.stringify(handshake);
			const dataText = JSON.stringify(dataFrame);
			await Promise.all([
				sendWebSocketMessage(client, handshakeText),
				sendWebSocketMessage(client, dataText),
			]);

			await expect(deliveredData.promise).resolves.toEqual(Uint8Array.from([1, 2, 3]));
			expect(receivedTexts).toEqual([handshakeText, dataText]);
			expect(maximumActiveReceiveCount).toBe(1);
			expect(channel?.state()).toMatchObject({ kind: 'open', nextSequence: 1 });
		} finally {
			await fixture.close();
		}
	});

	it('rejects binary messages before they reach the text session', async () => {
		const receiveText = vi.fn(
			async (_text: string): Promise<ControllerExecutionWebSocketSessionReceiveResult> => ({
				kind: 'rejected',
				reason: 'invalid-message',
			}),
		);
		const fixture = await createControllerExecutionServerFixture({
			authenticateUpgrade: authenticateControllerCredential,
			createSession: (_props) => createAcceptedSession({ invoke: receiveText }),
		});

		try {
			const client = connectWebSocket(fixture, {
				authorization: `Bearer ${controllerCredential}`,
			});
			await waitForWebSocketOpen(client);
			const closeReceipt = waitForWebSocketClose(client);
			await sendWebSocketMessage(client, Buffer.from([1, 2, 3]), { binary: true });

			await expect(closeReceipt).resolves.toMatchObject({ code: 1003 });
			expect(receiveText).not.toHaveBeenCalled();
		} finally {
			await fixture.close();
		}
	});

	it('fails closed at the WebSocket payload limit before session parsing', async () => {
		const maxMessageBytes = 128;
		const receiveText = vi.fn(
			async (_text: string): Promise<ControllerExecutionWebSocketSessionReceiveResult> => ({
				kind: 'rejected',
				reason: 'invalid-message',
			}),
		);
		const fixture = await createControllerExecutionServerFixture({
			authenticateUpgrade: authenticateControllerCredential,
			createSession: (_props) => createAcceptedSession({ invoke: receiveText }),
			limits: { maxMessageBytes },
		});

		try {
			const client = connectWebSocket(fixture, {
				authorization: `Bearer ${controllerCredential}`,
			});
			await waitForWebSocketOpen(client);
			const closeReceipt = waitForWebSocketClose(client);
			await sendWebSocketMessage(client, 'x'.repeat(maxMessageBytes + 1));

			await expect(closeReceipt).resolves.toMatchObject({ code: 1009 });
			expect(receiveText).not.toHaveBeenCalled();
		} finally {
			await fixture.close();
		}
	});
});

describe('controller execution WebSocket teardown', () => {
	it('notifies the authenticated session when the peer transport closes abnormally', async () => {
		const transportClosed = createDeferred<void>();
		const notifyTransportClosed = vi.fn((): void => transportClosed.resolve());
		const fixture = await createControllerExecutionServerFixture({
			authenticateUpgrade: authenticateControllerCredential,
			createSession: (_props) => ({
				...createAcceptedSession(),
				notifyTransportClosed,
			}),
		});
		const client = connectWebSocket(fixture, {
			authorization: `Bearer ${controllerCredential}`,
		});
		await waitForWebSocketOpen(client);

		client.terminate();
		await transportClosed.promise;

		expect(notifyTransportClosed).toHaveBeenCalledOnce();
		await fixture.close();
	});

	it('leaves no upgraded sockets or upgrade listener after the host server closes', async () => {
		const fixture = await createControllerExecutionServerFixture({
			authenticateUpgrade: authenticateControllerCredential,
			createSession: (_props) => createAcceptedSession(),
		});
		const client = connectWebSocket(fixture, {
			authorization: `Bearer ${controllerCredential}`,
		});
		await waitForWebSocketOpen(client);
		expect(fixture.rawSockets.size).toBe(1);

		await fixture.close();

		expect(fixture.server.listening).toBe(false);
		expect(fixture.server.listenerCount('upgrade')).toBe(0);
		expect(fixture.rawSockets.size).toBe(0);
	});
});
