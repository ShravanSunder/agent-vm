import { describe, expect, it } from 'vitest';

import {
	DEFAULT_GATEWAY_RUNTIME_STARTUP_RETRY_POLICY,
	GatewayRuntimeClient,
	GatewayRuntimeClientError,
	GatewayRuntimeStartupUnavailableError,
	type GatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeConnection,
	type GatewayRuntimeStartupRetryScheduler,
	type GatewayRuntimeTransportFactory,
} from './index.js';

const CURRENT_ATTACHMENT = Object.freeze({
	attachmentGeneration: 3,
	clientKind: 'hermes-managed-plugin',
	configuredAgentIds: Object.freeze(['agent-a', 'agent-b']),
	frameworkEpoch: 'framework-epoch-1',
	gatewayEpoch: 'gateway-epoch-1',
	protocolVersion: 1,
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	runtimeEpoch: 'runtime-epoch-1',
	schemaVersion: 1,
} satisfies GatewayRuntimeAttachmentMetadata);

class FakeRetryScheduler implements GatewayRuntimeStartupRetryScheduler {
	readonly waits: number[] = [];
	currentTimeMs = 0;
	readonly #onWait: (() => void) | undefined;

	constructor(onWait?: () => void) {
		this.#onWait = onWait;
	}

	now(): number {
		return this.currentTimeMs;
	}

	async wait(delayMs: number, signal: AbortSignal): Promise<void> {
		this.waits.push(delayMs);
		this.currentTimeMs += delayMs;
		this.#onWait?.();
		if (signal.aborted) throw signal.reason;
	}
}

class FakeGatewayRuntimeConnection implements GatewayRuntimeConnection {
	readonly handshakes: GatewayRuntimeAttachmentMetadata[] = [];
	closed = false;
	readonly #handshakeError: Error | undefined;

	constructor(handshakeError?: Error) {
		this.#handshakeError = handshakeError;
	}

	async close(): Promise<void> {
		this.closed = true;
	}

	async handshake(attachment: GatewayRuntimeAttachmentMetadata): Promise<void> {
		this.handshakes.push(attachment);
		if (this.#handshakeError !== undefined) throw this.#handshakeError;
	}

	async request(): Promise<unknown> {
		return { items: [], ok: true };
	}
}

type ScriptedConnectOutcome =
	| Error
	| FakeGatewayRuntimeConnection
	| Promise<GatewayRuntimeConnection>;

class ScriptedGatewayRuntimeTransportFactory implements GatewayRuntimeTransportFactory {
	readonly attemptedSocketPaths: string[] = [];
	readonly attemptedSignals: AbortSignal[] = [];
	readonly #outcomes: ScriptedConnectOutcome[];

	constructor(outcomes: readonly ScriptedConnectOutcome[]) {
		this.#outcomes = [...outcomes];
	}

	async connect(options: {
		readonly signal: AbortSignal;
		readonly socketPath: string;
	}): Promise<GatewayRuntimeConnection> {
		this.attemptedSocketPaths.push(options.socketPath);
		this.attemptedSignals.push(options.signal);
		const outcome = this.#outcomes.shift();
		if (outcome === undefined) throw new Error('No scripted connection outcome remains.');
		if (outcome instanceof Error) throw outcome;
		return await outcome;
	}
}

describe('GatewayRuntimeClient startup retry', () => {
	it('retries only typed pre-publication absence and refusal within fixed bounds', async () => {
		// Arrange
		const connection = new FakeGatewayRuntimeConnection();
		const transportFactory = new ScriptedGatewayRuntimeTransportFactory([
			new GatewayRuntimeStartupUnavailableError('socket-absent'),
			new GatewayRuntimeStartupUnavailableError('socket-refused'),
			connection,
		]);
		const retryScheduler = new FakeRetryScheduler();
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT,
			startupRetryPolicy: { deadlineMs: 500, intervalMs: 25, maxAttempts: 4 },
			startupRetryScheduler: retryScheduler,
			transportFactory,
		});

		// Act
		await client.connect();

		// Assert
		expect(DEFAULT_GATEWAY_RUNTIME_STARTUP_RETRY_POLICY).toEqual({
			deadlineMs: 5_000,
			intervalMs: 100,
			maxAttempts: 50,
		});
		expect(retryScheduler.waits).toEqual([25, 25]);
		expect(transportFactory.attemptedSocketPaths).toHaveLength(3);
		expect(transportFactory.attemptedSignals.every((signal) => !signal.aborted)).toBe(true);
		expect(connection.handshakes).toEqual([CURRENT_ATTACHMENT]);
	});

	it('fails immediately for non-startup transport errors and handshake rejection', async () => {
		// Arrange
		const transportError = new Error('permission denied');
		const handshakeError = new Error('protocol-version-mismatch');
		const rejectedConnection = new FakeGatewayRuntimeConnection(handshakeError);
		const transportScheduler = new FakeRetryScheduler();
		const handshakeScheduler = new FakeRetryScheduler();
		const transportClient = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT,
			startupRetryScheduler: transportScheduler,
			transportFactory: new ScriptedGatewayRuntimeTransportFactory([transportError]),
		});
		const handshakeClient = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT,
			startupRetryScheduler: handshakeScheduler,
			transportFactory: new ScriptedGatewayRuntimeTransportFactory([rejectedConnection]),
		});

		// Act
		const transportAttempt = transportClient.connect();
		const handshakeAttempt = handshakeClient.connect();

		// Assert
		await expect(transportAttempt).rejects.toBe(transportError);
		await expect(handshakeAttempt).rejects.toBe(handshakeError);
		expect(transportScheduler.waits).toEqual([]);
		expect(handshakeScheduler.waits).toEqual([]);
		expect(rejectedConnection.closed).toBe(true);
	});

	it('fails with a typed error when the bounded startup attempts are exhausted', async () => {
		// Arrange
		const retryScheduler = new FakeRetryScheduler();
		const transportFactory = new ScriptedGatewayRuntimeTransportFactory([
			new GatewayRuntimeStartupUnavailableError('socket-absent'),
			new GatewayRuntimeStartupUnavailableError('socket-absent'),
			new GatewayRuntimeStartupUnavailableError('socket-refused'),
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT,
			startupRetryPolicy: { deadlineMs: 500, intervalMs: 10, maxAttempts: 3 },
			startupRetryScheduler: retryScheduler,
			transportFactory,
		});

		// Act
		const connectionAttempt = client.connect();

		// Assert
		await expect(connectionAttempt).rejects.toMatchObject({
			code: 'startup-retry-exhausted',
			name: 'GatewayRuntimeClientError',
		});
		expect(retryScheduler.waits).toEqual([10, 10]);
		expect(transportFactory.attemptedSocketPaths).toHaveLength(3);
	});

	it('does not begin another attempt when the retry wait reaches the startup deadline', async () => {
		// Arrange
		const retryScheduler = new FakeRetryScheduler();
		const transportFactory = new ScriptedGatewayRuntimeTransportFactory([
			new GatewayRuntimeStartupUnavailableError('socket-absent'),
			new FakeGatewayRuntimeConnection(),
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT,
			startupRetryPolicy: { deadlineMs: 20, intervalMs: 20, maxAttempts: 10 },
			startupRetryScheduler: retryScheduler,
			transportFactory,
		});

		// Act
		const connectionAttempt = client.connect();

		// Assert
		await expect(connectionAttempt).rejects.toMatchObject({ code: 'startup-retry-exhausted' });
		expect(retryScheduler.waits).toEqual([20]);
		expect(transportFactory.attemptedSocketPaths).toHaveLength(1);
	});

	it('aborts startup retry without admitting another connection attempt', async () => {
		// Arrange
		const cancellation = new AbortController();
		const retryScheduler = new FakeRetryScheduler(() => {
			cancellation.abort(new Error('Gateway startup was cancelled.'));
		});
		const transportFactory = new ScriptedGatewayRuntimeTransportFactory([
			new GatewayRuntimeStartupUnavailableError('socket-absent'),
			new FakeGatewayRuntimeConnection(),
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT,
			startupRetryScheduler: retryScheduler,
			transportFactory,
		});

		// Act
		const connectionAttempt = client.connect({ signal: cancellation.signal });

		// Assert
		await expect(connectionAttempt).rejects.toMatchObject({
			code: 'startup-aborted',
			name: 'GatewayRuntimeClientError',
		});
		expect(transportFactory.attemptedSocketPaths).toHaveLength(1);
	});

	it('does not apply pre-publication retry after an attached client begins reconnect', async () => {
		// Arrange
		const retryScheduler = new FakeRetryScheduler();
		const transportFactory = new ScriptedGatewayRuntimeTransportFactory([
			new FakeGatewayRuntimeConnection(),
			new GatewayRuntimeStartupUnavailableError('socket-refused'),
			new FakeGatewayRuntimeConnection(),
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT,
			startupRetryScheduler: retryScheduler,
			transportFactory,
		});
		await client.connect();

		// Act
		const reconnectAttempt = client.reconnect();

		// Assert
		await expect(reconnectAttempt).rejects.toMatchObject({
			code: 'startup-unavailable',
			kind: 'socket-refused',
		});
		expect(retryScheduler.waits).toEqual([]);
		expect(transportFactory.attemptedSocketPaths).toHaveLength(2);
	});

	it('rejects reconnect while the initial connection attempt still owns lifecycle custody', async () => {
		// Arrange
		const pendingConnection = Promise.withResolvers<GatewayRuntimeConnection>();
		const firstConnection = new FakeGatewayRuntimeConnection();
		const transportFactory = new ScriptedGatewayRuntimeTransportFactory([
			pendingConnection.promise,
			new FakeGatewayRuntimeConnection(),
		]);
		const client = new GatewayRuntimeClient({
			attachment: CURRENT_ATTACHMENT,
			transportFactory,
		});
		const connectionAttempt = client.connect();

		// Act
		const reconnectAttempt = client.reconnect();

		// Assert
		await expect(reconnectAttempt).rejects.toMatchObject({ code: 'already-connected' });
		expect(transportFactory.attemptedSocketPaths).toHaveLength(1);
		pendingConnection.resolve(firstConnection);
		await connectionAttempt;
		await client.disconnect();
	});

	it.each([
		{ deadlineMs: 0 },
		{ deadlineMs: 60_001 },
		{ intervalMs: 5_001, deadlineMs: 5_000 },
		{ maxAttempts: 1_001 },
	] as const)('rejects invalid retry policy %j before transport connect', (startupRetryPolicy) => {
		// Arrange
		const transportFactory = new ScriptedGatewayRuntimeTransportFactory([]);

		// Act
		const constructClient = (): GatewayRuntimeClient =>
			new GatewayRuntimeClient({
				attachment: CURRENT_ATTACHMENT,
				startupRetryPolicy,
				transportFactory,
			});

		// Assert
		expect(constructClient).toThrow(GatewayRuntimeClientError);
		expect(transportFactory.attemptedSocketPaths).toEqual([]);
	});
});
