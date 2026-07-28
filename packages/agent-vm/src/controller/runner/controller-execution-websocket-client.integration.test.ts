import { Buffer } from 'node:buffer';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import {
	ControllerExecutionDataCreditSchema,
	ControllerExecutionDataFrameSchema,
	ControllerExecutionDataHandshakeSchema,
	ControllerExecutionWebSocketPath,
	type ControllerExecutionDataBinding,
	type ControllerExecutionDataCredit,
} from '@agent-vm/controller-execution-contracts/controller-execution-data-boundary';
import type { ManagedVmExecProcess } from '@agent-vm/managed-vm';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import {
	createControllerExecutionWebSocketClient,
	streamManagedVmExecProcessOutput,
} from './controller-execution-websocket-client.js';

const authorizationHeaderValue = 'Bearer controller-execution-test-secret';
const policyViolationCloseCode = 1008;

const binding = {
	audience: 'controller-execution-data',
	channelId: 'channel-a',
	controllerEpoch: 'controller-epoch-a',
	executionFingerprint: 'fingerprint-a',
	gatewayEpoch: 'gateway-epoch-a',
	operationId: 'operation-a',
	runtimeEpoch: 'runtime-epoch-a',
	stablePrincipal: 'a'.repeat(64),
} as const satisfies ControllerExecutionDataBinding;

interface ControllerExecutionWebSocketClientLimits {
	readonly maxBufferedBytes: number;
	readonly maxMessageBytes: number;
	readonly maxQueuedBytes: number;
	readonly maxQueuedMessages: number;
	readonly maxWindowBytes: number;
}

interface InvalidControllerExecutionUrlCase {
	readonly mutate: (url: URL) => void;
	readonly title: string;
}

const invalidControllerExecutionUrlCases = [
	{
		mutate: (url): void => {
			url.pathname = '/agent-vm/controller-execution-other';
		},
		title: 'a sibling path',
	},
	{
		mutate: (url): void => {
			url.search = '?trace=test';
		},
		title: 'a query string',
	},
	{
		mutate: (url): void => {
			url.hash = '#trace';
		},
		title: 'a fragment',
	},
	{
		mutate: (url): void => {
			url.username = 'attacker';
		},
		title: 'user information',
	},
	{
		mutate: (url): void => {
			url.protocol = 'http:';
		},
		title: 'the HTTP protocol',
	},
] as const satisfies readonly InvalidControllerExecutionUrlCase[];

const defaultLimits = {
	maxBufferedBytes: 4096,
	maxMessageBytes: 4096,
	maxQueuedBytes: 4096,
	maxQueuedMessages: 16,
	maxWindowBytes: 1024,
} as const satisfies ControllerExecutionWebSocketClientLimits;

interface WebSocketMessage {
	readonly data: Buffer;
	readonly isBinary: boolean;
}

interface WebSocketMessageInbox {
	next(): Promise<WebSocketMessage>;
}

interface AcceptedWebSocketConnection {
	readonly inbox: WebSocketMessageInbox;
	readonly request: IncomingMessage;
	readonly socket: WebSocket;
}

interface ControllerExecutionTestServer extends AsyncDisposable {
	readonly connection: Promise<AcceptedWebSocketConnection>;
	readonly url: string;
	readonly upgradeCount: () => number;
}

interface DeferredProtocolValue<TValue> {
	readonly promise: Promise<TValue>;
	reject(error: Error): void;
	resolve(value: TValue): void;
}

type ControllerExecutionWebSocketClient = ReturnType<
	typeof createControllerExecutionWebSocketClient
>;

type WebSocketSendData = Parameters<WebSocket['send']>[0];
type WebSocketSendOptions = Parameters<WebSocket['send']>[1];
type WebSocketSendCallback = NonNullable<Parameters<WebSocket['send']>[2]>;

function createDeferredProtocolValue<TValue>(): DeferredProtocolValue<TValue> {
	let rejectPromise!: (error: Error) => void;
	let resolvePromise!: (value: TValue) => void;
	const promise = new Promise<TValue>((resolve, reject) => {
		rejectPromise = reject;
		resolvePromise = resolve;
	});
	return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function createWebSocketMessageInbox(socket: WebSocket): WebSocketMessageInbox {
	const queuedMessages: WebSocketMessage[] = [];
	const pendingReaders: DeferredProtocolValue<WebSocketMessage>[] = [];
	let terminalError: Error | undefined;

	socket.on('message', (data: RawData, isBinary: boolean): void => {
		const message = { data: rawDataToBuffer(data), isBinary };
		const pendingReader = pendingReaders.shift();
		if (pendingReader === undefined) {
			queuedMessages.push(message);
			return;
		}
		pendingReader.resolve(message);
	});
	const rejectPendingReaders = (error: Error): void => {
		terminalError = error;
		for (const pendingReader of pendingReaders.splice(0)) {
			pendingReader.reject(error);
		}
	};
	socket.once('close', (code: number): void => {
		rejectPendingReaders(new Error(`WebSocket closed before the next message (${String(code)}).`));
	});
	socket.once('error', rejectPendingReaders);

	return {
		next: async (): Promise<WebSocketMessage> => {
			const queuedMessage = queuedMessages.shift();
			if (queuedMessage !== undefined) return queuedMessage;
			if (terminalError !== undefined) throw terminalError;
			const pendingReader = createDeferredProtocolValue<WebSocketMessage>();
			pendingReaders.push(pendingReader);
			return await pendingReader.promise;
		},
	};
}

function rawDataToBuffer(data: RawData): Buffer {
	if (Array.isArray(data)) return Buffer.concat(data);
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return Buffer.from(data);
}

async function listen(server: HttpServer): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			const address = server.address();
			if (typeof address === 'object' && address !== null) {
				resolve(address.port);
				return;
			}
			reject(new Error('Controller execution test server did not expose a TCP address.'));
		});
	});
}

async function closeHttpServer(server: HttpServer): Promise<void> {
	server.closeAllConnections();
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

async function closeWebSocketServer(server: WebSocketServer): Promise<void> {
	for (const client of server.clients) client.terminate();
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

async function createControllerExecutionTestServer(): Promise<ControllerExecutionTestServer> {
	const httpServer = createServer();
	const webSocketServer = new WebSocketServer({
		maxPayload: defaultLimits.maxMessageBytes,
		noServer: true,
		perMessageDeflate: false,
	});
	const acceptedConnection = createDeferredProtocolValue<AcceptedWebSocketConnection>();
	let observedUpgradeCount = 0;

	webSocketServer.once('connection', (socket: WebSocket, request: IncomingMessage): void => {
		acceptedConnection.resolve({
			inbox: createWebSocketMessageInbox(socket),
			request,
			socket,
		});
	});
	httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
		observedUpgradeCount += 1;
		webSocketServer.handleUpgrade(request, socket, head, (acceptedSocket: WebSocket): void => {
			webSocketServer.emit('connection', acceptedSocket, request);
		});
	});
	const port = await listen(httpServer);

	return {
		connection: acceptedConnection.promise,
		upgradeCount: (): number => observedUpgradeCount,
		url: `ws://127.0.0.1:${String(port)}${ControllerExecutionWebSocketPath}`,
		[Symbol.asyncDispose]: async (): Promise<void> => {
			await closeWebSocketServer(webSocketServer);
			await closeHttpServer(httpServer);
		},
	};
}

function createClient(options: {
	readonly limits?: ControllerExecutionWebSocketClientLimits;
	readonly url: string;
}): ControllerExecutionWebSocketClient {
	return createControllerExecutionWebSocketClient({
		authorization: { headerValue: authorizationHeaderValue },
		binding,
		limits: options.limits ?? defaultLimits,
		url: options.url,
	});
}

function createCredit(
	overrides: Partial<ControllerExecutionDataCredit> = {},
): ControllerExecutionDataCredit {
	return ControllerExecutionDataCreditSchema.parse({
		...binding,
		availableCreditBytes: 1024,
		kind: 'credit',
		nextSequence: 0,
		queuedBytes: 0,
		...overrides,
	});
}

async function sendServerMessage(options: {
	readonly data: Buffer | string;
	readonly isBinary?: boolean;
	readonly socket: WebSocket;
}): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		options.socket.send(
			options.data,
			{ binary: options.isBinary ?? false, compress: false },
			(error?: Error | null): void => {
				if (error !== undefined && error !== null) {
					reject(error);
					return;
				}
				resolve();
			},
		);
	});
}

async function waitForClientToProcessServerFrames(socket: WebSocket): Promise<void> {
	const synchronizationPayload = Buffer.from('credit-applied', 'utf8');
	await new Promise<void>((resolve, reject) => {
		const removeListeners = (): void => {
			socket.off('error', handleError);
			socket.off('pong', handlePong);
		};
		const handleError = (error: Error): void => {
			removeListeners();
			reject(error);
		};
		const handlePong = (data: Buffer): void => {
			removeListeners();
			if (!data.equals(synchronizationPayload)) {
				reject(new Error('Controller execution synchronization pong payload did not match.'));
				return;
			}
			resolve();
		};
		socket.once('error', handleError);
		socket.once('pong', handlePong);
		socket.ping(synchronizationPayload, false, (error?: Error | null): void => {
			if (error === undefined || error === null) return;
			removeListeners();
			reject(error);
		});
	});
}

async function nextTextMessage(connection: AcceptedWebSocketConnection): Promise<unknown> {
	const message = await connection.inbox.next();
	expect(message.isBinary).toBe(false);
	return JSON.parse(message.data.toString('utf8')) as unknown;
}

async function connectAuthenticatedClient(options: {
	readonly initialCreditBytes?: number;
	readonly limits?: ControllerExecutionWebSocketClientLimits;
	readonly server: ControllerExecutionTestServer;
}): Promise<{
	readonly client: ControllerExecutionWebSocketClient;
	readonly connection: AcceptedWebSocketConnection;
}> {
	const client = createClient({
		...(options.limits === undefined ? {} : { limits: options.limits }),
		url: options.server.url,
	});
	const connection = await options.server.connection;
	const firstMessage = await nextTextMessage(connection);
	expect(ControllerExecutionDataHandshakeSchema.parse(firstMessage)).toEqual({
		...binding,
		kind: 'handshake',
	});
	await sendServerMessage({
		data: JSON.stringify(
			createCredit({ availableCreditBytes: options.initialCreditBytes ?? 1024 }),
		),
		socket: connection.socket,
	});
	await client.connected;
	return { client, connection };
}

function waitForWebSocketClose(
	socket: WebSocket,
): Promise<{ readonly code: number; readonly reason: string }> {
	return new Promise((resolve) => {
		socket.once('close', (code: number, reason: Buffer): void => {
			resolve({ code, reason: reason.toString('utf8') });
		});
	});
}

function isWebSocketSendCallback(value: unknown): value is WebSocketSendCallback {
	return typeof value === 'function';
}

describe('controller execution WebSocket client integration', () => {
	it.each(invalidControllerExecutionUrlCases)(
		'rejects $title before opening a socket',
		async ({ mutate }) => {
			await using server = await createControllerExecutionTestServer();
			const invalidUrl = new URL(server.url);
			mutate(invalidUrl);

			expect(() => createClient({ url: invalidUrl.toString() })).toThrow(
				/exact controller execution path/u,
			);
			await Promise.resolve();
			expect(server.upgradeCount()).toBe(0);
		},
	);

	it('authenticates only in the upgrade header, disables compression, and sends the strict handshake first', async () => {
		await using server = await createControllerExecutionTestServer();
		const client = createClient({ url: server.url });
		const connection = await server.connection;

		expect(connection.request.headers.authorization).toBe(authorizationHeaderValue);
		expect(connection.request.url).not.toContain(authorizationHeaderValue);
		expect(connection.request.headers['sec-websocket-extensions']).toBeUndefined();
		await expect(nextTextMessage(connection)).resolves.toEqual({
			...binding,
			kind: 'handshake',
		});
		await sendServerMessage({ data: JSON.stringify(createCredit()), socket: connection.socket });
		await expect(client.connected).resolves.toBeUndefined();
		expect(server.upgradeCount()).toBe(1);
		client.close();
	});

	it('encodes Uint8Array payloads canonically with the current credit and monotonic sequence', async () => {
		await using server = await createControllerExecutionTestServer();
		const { client, connection } = await connectAuthenticatedClient({
			initialCreditBytes: 8,
			server,
		});

		await client.sendData(Uint8Array.from([1, 2, 3]));
		expect(ControllerExecutionDataFrameSchema.parse(await nextTextMessage(connection))).toEqual({
			...binding,
			creditBytes: 8,
			kind: 'data',
			payloadBase64: 'AQID',
			sequence: 0,
		});
		await client.sendData(Uint8Array.from([4, 5]));
		expect(ControllerExecutionDataFrameSchema.parse(await nextTextMessage(connection))).toEqual({
			...binding,
			creditBytes: 5,
			kind: 'data',
			payloadBase64: 'BAU=',
			sequence: 1,
		});
		await sendServerMessage({
			data: JSON.stringify(
				createCredit({ availableCreditBytes: 8, nextSequence: 2, queuedBytes: 0 }),
			),
			socket: connection.socket,
		});
		await waitForClientToProcessServerFrames(connection.socket);
		await client.sendData(Uint8Array.from([6]));
		expect(ControllerExecutionDataFrameSchema.parse(await nextTextMessage(connection))).toEqual({
			...binding,
			creditBytes: 8,
			kind: 'data',
			payloadBase64: 'Bg==',
			sequence: 2,
		});
		client.close();
	});

	it('pauses queued output until bound credit refreshes instead of rejecting the producer', async () => {
		await using server = await createControllerExecutionTestServer();
		const { client, connection } = await connectAuthenticatedClient({
			initialCreditBytes: 3,
			server,
		});

		await client.sendData(Uint8Array.from([1, 2, 3]));
		await nextTextMessage(connection);
		let secondSendState: 'pending' | 'rejected' | 'resolved' = 'pending';
		const secondSend = client.sendData(Uint8Array.from([4, 5])).then(
			(): void => {
				secondSendState = 'resolved';
			},
			(): void => {
				secondSendState = 'rejected';
			},
		);
		await Promise.resolve();
		expect(secondSendState).toBe('pending');

		await sendServerMessage({
			data: JSON.stringify(
				createCredit({ availableCreditBytes: 3, nextSequence: 1, queuedBytes: 0 }),
			),
			socket: connection.socket,
		});
		await secondSend;
		expect(secondSendState).toBe('resolved');
		expect(ControllerExecutionDataFrameSchema.parse(await nextTextMessage(connection))).toEqual({
			...binding,
			creditBytes: 3,
			kind: 'data',
			payloadBase64: 'BAU=',
			sequence: 1,
		});
		client.close();
	});

	it('rejects new output before retaining bytes beyond the execution queue caps', async () => {
		await using server = await createControllerExecutionTestServer();
		const limits = {
			...defaultLimits,
			maxQueuedBytes: 2,
			maxQueuedMessages: 2,
		} as const satisfies ControllerExecutionWebSocketClientLimits;
		const { client, connection } = await connectAuthenticatedClient({ limits, server });
		const originalSend: unknown = Object.getOwnPropertyDescriptor(
			WebSocket.prototype,
			'send',
		)?.value;
		if (typeof originalSend !== 'function') {
			throw new Error('ws WebSocket.prototype.send must be a function.');
		}
		const firstDataReachedTransport = createDeferredProtocolValue<void>();
		const releaseFirstDataCallback = createDeferredProtocolValue<void>();
		const sendSpy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
			this: WebSocket,
			data: WebSocketSendData,
			options: WebSocketSendOptions,
			callback?: WebSocketSendCallback,
		): void {
			const sendCallback = isWebSocketSendCallback(options) ? options : callback;
			const frame =
				typeof data === 'string'
					? ControllerExecutionDataFrameSchema.safeParse(JSON.parse(data) as unknown)
					: undefined;
			if (frame?.success !== true || frame.data.kind !== 'data') {
				Reflect.apply(originalSend, this, [data, options, callback]);
				return;
			}
			const interceptedCallback = (error?: Error): void => {
				firstDataReachedTransport.resolve();
				void releaseFirstDataCallback.promise.then((): void => sendCallback?.(error));
			};
			Reflect.apply(originalSend, this, [data, options, interceptedCallback]);
		});
		try {
			const firstSend = client.sendData(Uint8Array.of(1));
			await firstDataReachedTransport.promise;
			const secondSend = client.sendData(Uint8Array.of(2));
			const thirdSend = client.sendData(Uint8Array.of(3));

			await expect(thirdSend).rejects.toThrow(/queue.*capacity/u);
			releaseFirstDataCallback.resolve();
			await firstSend;
			await sendServerMessage({
				data: JSON.stringify(
					createCredit({ availableCreditBytes: 1024, nextSequence: 1, queuedBytes: 0 }),
				),
				socket: connection.socket,
			});
			await secondSend;
		} finally {
			releaseFirstDataCallback.resolve();
			sendSpy.mockRestore();
			client.close();
		}
	});

	it('rejects retained output when the admitted transport closes before credit refreshes', async () => {
		await using server = await createControllerExecutionTestServer();
		const { client, connection } = await connectAuthenticatedClient({
			initialCreditBytes: 1,
			server,
		});

		await client.sendData(Uint8Array.of(1));
		await nextTextMessage(connection);
		const retainedSendRejection = expect(client.sendData(Uint8Array.of(2))).rejects.toThrow(
			/closed|socket/u,
		);
		const serverSocketClosed = new Promise<void>((resolve) => {
			connection.socket.once('close', (): void => resolve());
		});
		connection.socket.terminate();
		await serverSocketClosed;
		await retainedSendRejection;
	});

	it('sends cancellation ahead of retained bulk output after the active transport send', async () => {
		await using server = await createControllerExecutionTestServer();
		const { client, connection } = await connectAuthenticatedClient({ server });
		const originalSend: unknown = Object.getOwnPropertyDescriptor(
			WebSocket.prototype,
			'send',
		)?.value;
		if (typeof originalSend !== 'function') {
			throw new Error('ws WebSocket.prototype.send must be a function.');
		}
		const firstDataReachedTransport = createDeferredProtocolValue<void>();
		const releaseFirstDataCallback = createDeferredProtocolValue<void>();
		let interceptedDataFrames = 0;
		const sendSpy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
			this: WebSocket,
			data: WebSocketSendData,
			options: WebSocketSendOptions,
			callback?: WebSocketSendCallback,
		): void {
			const sendCallback = isWebSocketSendCallback(options) ? options : callback;
			const frame =
				typeof data === 'string'
					? ControllerExecutionDataFrameSchema.safeParse(JSON.parse(data) as unknown)
					: undefined;
			if (frame?.success !== true || frame.data.kind !== 'data') {
				Reflect.apply(originalSend, this, [data, options, callback]);
				return;
			}
			interceptedDataFrames += 1;
			const interceptedCallback = (error?: Error): void => {
				firstDataReachedTransport.resolve();
				void releaseFirstDataCallback.promise.then((): void => sendCallback?.(error));
			};
			Reflect.apply(originalSend, this, [data, options, interceptedCallback]);
		});
		try {
			const firstSend = client.sendData(Uint8Array.of(1));
			await firstDataReachedTransport.promise;
			const retainedBulkSend = client.sendData(Uint8Array.of(2));
			const retainedBulkRejection = expect(retainedBulkSend).rejects.toThrow(/cancel/u);
			const cancellation = client.cancel();
			releaseFirstDataCallback.resolve();

			await firstSend;
			await retainedBulkRejection;
			await cancellation;
			expect(interceptedDataFrames).toBe(1);
			expect(
				ControllerExecutionDataFrameSchema.parse(await nextTextMessage(connection)),
			).toMatchObject({ kind: 'data', sequence: 0 });
			expect(
				ControllerExecutionDataFrameSchema.parse(await nextTextMessage(connection)),
			).toMatchObject({ kind: 'cancel', sequence: 1 });
		} finally {
			releaseFirstDataCallback.resolve();
			sendSpy.mockRestore();
			client.close();
		}
	});

	it('streams byte-exact ManagedVmExecProcess output in bounded chunks before eof', async () => {
		await using server = await createControllerExecutionTestServer();
		const { client, connection } = await connectAuthenticatedClient({
			initialCreditBytes: 8,
			server,
		});
		const processOutput = {
			output: (): AsyncIterable<{
				readonly data: Uint8Array;
				readonly stream: 'stderr' | 'stdout';
				readonly text: string;
			}> =>
				(async function* () {
					yield {
						data: Uint8Array.from([1, 2, 3, 4]),
						stream: 'stdout',
						text: '\u0001\u0002\u0003\u0004',
					};
					yield { data: Uint8Array.from([5, 6]), stream: 'stderr', text: '\u0005\u0006' };
				})(),
		} satisfies Pick<ManagedVmExecProcess, 'output'>;

		await streamManagedVmExecProcessOutput({
			client,
			maxChunkBytes: 3,
			process: processOutput,
		});

		const frames = await Promise.all([
			nextTextMessage(connection),
			nextTextMessage(connection),
			nextTextMessage(connection),
			nextTextMessage(connection),
		]);
		expect(frames.map((frame) => ControllerExecutionDataFrameSchema.parse(frame))).toEqual([
			expect.objectContaining({ kind: 'data', payloadBase64: 'AQID', sequence: 0 }),
			expect.objectContaining({ kind: 'data', payloadBase64: 'BA==', sequence: 1 }),
			expect.objectContaining({ kind: 'data', payloadBase64: 'BQY=', sequence: 2 }),
			expect.objectContaining({ kind: 'eof', sequence: 3 }),
		]);
		client.close();
	});

	it.each(['eof', 'cancel'] as const)(
		'sends one bound %s terminal frame and never reconnects or redispatches afterward',
		async (terminalKind) => {
			await using server = await createControllerExecutionTestServer();
			const { client, connection } = await connectAuthenticatedClient({
				initialCreditBytes: 9,
				server,
			});
			const closeObserved = waitForWebSocketClose(connection.socket);

			if (terminalKind === 'eof') await client.sendEof();
			else await client.cancel();
			expect(ControllerExecutionDataFrameSchema.parse(await nextTextMessage(connection))).toEqual({
				...binding,
				creditBytes: 9,
				kind: terminalKind,
				sequence: 0,
			});
			connection.socket.close(1000, 'terminal accepted');
			await closeObserved;
			await expect(client.sendData(Uint8Array.from([1]))).rejects.toThrow(/closed|terminal/u);
			await Promise.resolve();
			expect(server.upgradeCount()).toBe(1);
		},
	);

	it('does not resolve a send until the ws callback completes', async () => {
		await using server = await createControllerExecutionTestServer();
		const { client, connection } = await connectAuthenticatedClient({ server });
		const originalSend: unknown = Object.getOwnPropertyDescriptor(
			WebSocket.prototype,
			'send',
		)?.value;
		if (typeof originalSend !== 'function') {
			throw new Error('ws WebSocket.prototype.send must be a function.');
		}
		const underlyingSendCompleted = createDeferredProtocolValue<void>();
		const releaseSendCallback = createDeferredProtocolValue<void>();
		const sendSpy = vi.spyOn(WebSocket.prototype, 'send').mockImplementation(function (
			this: WebSocket,
			data: WebSocketSendData,
			options: WebSocketSendOptions,
			callback?: WebSocketSendCallback,
		): void {
			const sendCallback = isWebSocketSendCallback(options) ? options : callback;
			const interceptedCallback = (error?: Error): void => {
				underlyingSendCompleted.resolve();
				void releaseSendCallback.promise.then((): void => sendCallback?.(error));
			};
			const sendArguments = isWebSocketSendCallback(options)
				? [data, interceptedCallback]
				: [data, options, interceptedCallback];
			Reflect.apply(originalSend, this, sendArguments);
		});
		try {
			let sendSettled = false;
			const sendPromise = client.sendData(Uint8Array.from([1, 2, 3])).finally((): void => {
				sendSettled = true;
			});
			await underlyingSendCompleted.promise;
			await connection.inbox.next();
			await Promise.resolve();
			expect(sendSettled).toBe(false);
			releaseSendCallback.resolve();
			await expect(sendPromise).resolves.toBeUndefined();
		} finally {
			sendSpy.mockRestore();
			client.close();
		}
	});

	it('rejects before send when the ws buffered amount reaches the configured cap', async () => {
		await using server = await createControllerExecutionTestServer();
		const { client } = await connectAuthenticatedClient({ server });
		const bufferedAmountSpy = vi
			.spyOn(WebSocket.prototype, 'bufferedAmount', 'get')
			.mockReturnValue(defaultLimits.maxBufferedBytes);
		const sendSpy = vi.spyOn(WebSocket.prototype, 'send');
		try {
			await expect(client.sendData(Uint8Array.from([1]))).rejects.toThrow(
				/buffer|backpressure|capacity/u,
			);
			expect(sendSpy).not.toHaveBeenCalled();
		} finally {
			sendSpy.mockRestore();
			bufferedAmountSpy.mockRestore();
			client.close();
		}
	});

	it.each([
		{
			name: 'binary credit',
			payload: (): { readonly data: Buffer; readonly isBinary: true } => ({
				data: Buffer.from(JSON.stringify(createCredit()), 'utf8'),
				isBinary: true,
			}),
		},
		{
			name: 'malformed credit',
			payload: (): { readonly data: string } => ({ data: '{' }),
		},
		{
			name: 'wrong-binding credit',
			payload: (): { readonly data: string } => ({
				data: JSON.stringify(createCredit({ operationId: 'attacker-operation' })),
			}),
		},
		{
			name: 'wrong-sequence credit',
			payload: (): { readonly data: string } => ({
				data: JSON.stringify(createCredit({ nextSequence: 1 })),
			}),
		},
	])('fails closed on $name without reconnect or redispatch', async ({ payload }) => {
		await using server = await createControllerExecutionTestServer();
		const client = createClient({ url: server.url });
		const connection = await server.connection;
		await nextTextMessage(connection);
		const closeObserved = waitForWebSocketClose(connection.socket);
		const connectedRejection = expect(client.connected).rejects.toThrow();
		await sendServerMessage({ ...payload(), socket: connection.socket });

		await connectedRejection;
		expect(await closeObserved).toMatchObject({ code: policyViolationCloseCode });
		await expect(client.sendData(Uint8Array.from([1]))).rejects.toThrow();
		await Promise.resolve();
		expect(server.upgradeCount()).toBe(1);
	});

	it('enforces maxPayload on inbound messages before unbounded parsing', async () => {
		await using server = await createControllerExecutionTestServer();
		const maxMessageBytes = 512;
		const client = createClient({
			limits: { ...defaultLimits, maxMessageBytes },
			url: server.url,
		});
		const connection = await server.connection;
		await nextTextMessage(connection);
		const closeObserved = waitForWebSocketClose(connection.socket);
		const connectedRejection = expect(client.connected).rejects.toThrow();
		const oversizedMessage = 'x'.repeat(maxMessageBytes + 1);
		expect(Buffer.byteLength(JSON.stringify(createCredit()), 'utf8')).toBeLessThanOrEqual(
			maxMessageBytes,
		);
		await sendServerMessage({ data: oversizedMessage, socket: connection.socket });

		await connectedRejection;
		expect(await closeObserved).toMatchObject({ code: 1009 });
		expect(server.upgradeCount()).toBe(1);
	});

	it('rejects an unexpected 401 upgrade response without credential query leakage or reconnect', async () => {
		const server = createServer();
		let upgradeCount = 0;
		let observedRequestUrl = '';
		server.on('upgrade', (request: IncomingMessage, socket: Duplex): void => {
			upgradeCount += 1;
			observedRequestUrl = request.url ?? '';
			socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
		});
		const port = await listen(server);
		try {
			const client = createClient({
				url: `ws://127.0.0.1:${String(port)}${ControllerExecutionWebSocketPath}`,
			});

			await expect(client.connected).rejects.toThrow(/401|Unauthorized/u);
			await Promise.resolve();
			expect(observedRequestUrl).not.toContain(authorizationHeaderValue);
			expect(upgradeCount).toBe(1);
		} finally {
			await closeHttpServer(server);
		}
	});
});
