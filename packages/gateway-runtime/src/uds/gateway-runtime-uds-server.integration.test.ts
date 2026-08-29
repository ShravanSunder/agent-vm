import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import net, { type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
	DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS,
	GATEWAY_RUNTIME_REQUEST_CANCEL_NOTIFICATION_METHOD,
	GatewayRuntimeClient,
	GatewayRuntimeFrameDecoder,
	encodeGatewayRuntimeFrame,
	type GatewayRuntimeAttachmentMetadata,
	type GatewayRuntimeJsonRpcMessage,
} from '@agent-vm/agent-portal-sdk/gateway-runtime-client';
import { afterEach, describe, expect, it } from 'vitest';

import { createGatewayRuntimePaths, type GatewayRuntimePaths } from './gateway-runtime-paths.js';
import {
	GatewayRuntimeUdsServerError,
	startGatewayRuntimeUdsServer,
	type GatewayRuntimeUdsOperationDispatcher,
	type GatewayRuntimeUdsServer,
} from './gateway-runtime-uds-server.js';
import {
	createManagedPluginAttachmentState,
	type ManagedPluginAttachmentState,
} from './managed-plugin-attachment-policy.js';

const PROTOCOL_WAIT_MILLISECONDS = 5_000;
const CURRENT_ATTACHMENT = {
	attachmentGeneration: 7,
	clientKind: 'hermes-managed-plugin',
	configuredAgentIds: ['main', 'research'],
	frameworkEpoch: 'framework-epoch-current',
	gatewayEpoch: 'gateway-epoch-current',
	protocolVersion: 1,
	projectionCohortDigest:
		'projection-cohort:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	runtimeEpoch: 'runtime-epoch-current',
	schemaVersion: 1,
} as const satisfies GatewayRuntimeAttachmentMetadata;
const SERVER_AUTHORITY = {
	allowedOperationGroups: ['portal', 'sandbox.terminal'],
	surface: 'managed-plugin',
} as const;

const temporaryRoots: string[] = [];
const runningServers: GatewayRuntimeUdsServer[] = [];

function failOnAttachmentObserverError(error: unknown): never {
	throw error;
}

function createAttachmentState(): ManagedPluginAttachmentState {
	return createManagedPluginAttachmentState({
		attachmentGeneration: CURRENT_ATTACHMENT.attachmentGeneration,
		clientKind: CURRENT_ATTACHMENT.clientKind,
		configuredAgentIds: CURRENT_ATTACHMENT.configuredAgentIds,
		frameworkEpoch: CURRENT_ATTACHMENT.frameworkEpoch,
		gatewayEpoch: CURRENT_ATTACHMENT.gatewayEpoch,
		projectionCohortDigest: CURRENT_ATTACHMENT.projectionCohortDigest,
		runtimeEpoch: CURRENT_ATTACHMENT.runtimeEpoch,
		serverAuthority: SERVER_AUTHORITY,
	});
}

function resolveOperationGroup(method: string): string | undefined {
	if (method.startsWith('portal.')) return 'portal';
	if (method.startsWith('sandbox.terminal.')) return 'sandbox.terminal';
	if (method.startsWith('forbidden.')) return 'forbidden';
	return undefined;
}

async function waitForPressureSafetyProof<TValue>(
	promise: Promise<TValue>,
	label: string,
): Promise<TValue> {
	return await Promise.race([
		promise,
		new Promise<never>((_resolve, reject) =>
			AbortSignal.timeout(1_000).addEventListener(
				'abort',
				() => reject(new Error(`Timed out waiting for ${label} under UDS write pressure.`)),
				{ once: true },
			),
		),
	]);
}

async function createTemporaryPaths(): Promise<GatewayRuntimePaths> {
	const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-uds-server-'));
	temporaryRoots.push(sandboxRoot);
	return createGatewayRuntimePaths({ runtimeRoot: path.join(sandboxRoot, 'runtime') });
}

async function startTestServer(
	props: {
		readonly dispatch?: GatewayRuntimeUdsOperationDispatcher;
		readonly frameLimits?: {
			readonly maxBufferedBytes?: number;
			readonly maxContentBytes?: number;
			readonly maxFramesPerChunk?: number;
			readonly maxHeaderBytes?: number;
		};
		readonly maxConnections?: number;
		readonly maxPendingRequestsPerConnection?: number;
		readonly paths?: GatewayRuntimePaths;
	} = {},
): Promise<GatewayRuntimeUdsServer> {
	const paths = props.paths ?? (await createTemporaryPaths());
	const server = await startGatewayRuntimeUdsServer({
		attachmentState: createAttachmentState(),
		dispatch:
			props.dispatch ??
			(async ({ method, params }): Promise<unknown> => ({ echoedMethod: method, params })),
		frameLimits: props.frameLimits,
		limits: {
			maxConnections: props.maxConnections ?? 4,
			maxPendingRequestsPerConnection: props.maxPendingRequestsPerConnection ?? 4,
		},
		paths,
		resolveOperationGroup,
	});
	runningServers.push(server);
	return server;
}

function createClient(
	socketPath: string,
	attachment: GatewayRuntimeAttachmentMetadata = CURRENT_ATTACHMENT,
): GatewayRuntimeClient {
	return new GatewayRuntimeClient({
		attachment,
		socketPath,
		startupRetryPolicy: { maxAttempts: 1 },
	});
}

async function connectRawSocket(socketPath: string): Promise<Socket> {
	const socket = net.createConnection(socketPath);
	socket.on('error', () => undefined);
	await once(socket, 'connect', { signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS) });
	return socket;
}

async function sendRawRequest(props: {
	readonly message: GatewayRuntimeJsonRpcMessage;
	readonly socket: Socket;
}): Promise<GatewayRuntimeJsonRpcMessage> {
	const response = Promise.withResolvers<GatewayRuntimeJsonRpcMessage>();
	const decoder = new GatewayRuntimeFrameDecoder();
	const onData = (chunk: Buffer): void => {
		for (const message of decoder.push(chunk)) {
			if (message['id'] === props.message['id']) response.resolve(message);
		}
	};
	props.socket.on('data', onData);
	props.socket.write(encodeGatewayRuntimeFrame(props.message));
	try {
		return await Promise.race([
			response.promise,
			new Promise<never>((_resolve, reject) =>
				AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS).addEventListener(
					'abort',
					() => reject(new Error('Timed out waiting for JSON-RPC response.')),
					{ once: true },
				),
			),
		]);
	} finally {
		props.socket.off('data', onData);
	}
}

afterEach(async (): Promise<void> => {
	await Promise.allSettled(
		runningServers.splice(0).map(async (server) => await server.retire({ drainTimeoutMs: 50 })),
	);
	await Promise.all(
		temporaryRoots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
	);
});

describe('production Gateway runtime private UDS server', () => {
	it('reports immutable accepted and lost current attachment snapshots exactly once', async () => {
		// Arrange
		const server = await startTestServer();
		const observedSnapshots: unknown[] = [];
		const attachmentLost = Promise.withResolvers<void>();
		const observation = server.observeAttachmentSnapshots((snapshot) => {
			observedSnapshots.push(snapshot);
			if (snapshot.status === 'attachment-lost') attachmentLost.resolve();
		}, failOnAttachmentObserverError);
		const client = createClient(server.readiness.socketPath);

		// Assert: publication is not attachment acceptance
		expect(observation.currentSnapshot).toMatchObject({
			expected: CURRENT_ATTACHMENT,
			observationSequence: 0,
			snapshotVersion: 1,
			status: 'awaiting-attachment',
		});
		expect(server.readiness.kind).toBe('ready');

		// Act: accept and then lose the current attachment
		await client.connect();
		await client.disconnect();
		await Promise.race([
			attachmentLost.promise,
			new Promise<never>((_resolve, reject) =>
				AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS).addEventListener(
					'abort',
					() => reject(new Error('Timed out waiting for attachment loss observation.')),
					{ once: true },
				),
			),
		]);

		// Assert
		expect(observedSnapshots).toHaveLength(2);
		expect(observedSnapshots).toMatchObject([
			{ observationSequence: 1, status: 'attached' },
			{ observationSequence: 2, status: 'attachment-lost' },
		]);
		for (const snapshot of observedSnapshots) {
			expect(Object.isFrozen(snapshot)).toBe(true);
		}
		expect(server.getAttachmentSnapshot()).toMatchObject({
			observationSequence: 2,
			status: 'attachment-lost',
		});
	});

	it('never activates stale, wrong, or duplicate attachment handshakes', async () => {
		// Arrange
		const server = await startTestServer();
		const observedSnapshots: unknown[] = [];
		server.observeAttachmentSnapshots(
			(snapshot) => observedSnapshots.push(snapshot),
			failOnAttachmentObserverError,
		);
		const staleClient = createClient(server.readiness.socketPath, {
			...CURRENT_ATTACHMENT,
			runtimeEpoch: 'runtime-epoch-stale',
		});

		// Act / Assert: stale identity never activates
		await expect(staleClient.connect()).rejects.toMatchObject({ code: 'stale-runtime-epoch' });
		const wrongAgentClient = createClient(server.readiness.socketPath, {
			...CURRENT_ATTACHMENT,
			configuredAgentIds: ['main', 'unconfigured'],
		});
		await expect(wrongAgentClient.connect()).rejects.toMatchObject({
			code: 'wrong-configured-agent-set',
		});
		const wrongProjectionClient = createClient(server.readiness.socketPath, {
			...CURRENT_ATTACHMENT,
			projectionCohortDigest:
				'projection-cohort:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
		});
		await expect(wrongProjectionClient.connect()).rejects.toMatchObject({
			code: 'wrong-projection-cohort',
		});
		expect(server.getAttachmentSnapshot()).toMatchObject({
			observationSequence: 0,
			status: 'awaiting-attachment',
		});
		expect(observedSnapshots).toEqual([]);

		// Arrange / Act: current attachment is accepted
		const activeClient = createClient(server.readiness.socketPath);
		await activeClient.connect();
		const acceptedSnapshot = server.getAttachmentSnapshot();
		const duplicateClient = createClient(server.readiness.socketPath);

		try {
			// Act / Assert: a duplicate cannot replace or reset current readiness
			await expect(duplicateClient.connect()).rejects.toMatchObject({
				code: 'duplicate-active-connection',
			});
			expect(server.getAttachmentSnapshot()).toBe(acceptedSnapshot);
			expect(observedSnapshots).toHaveLength(1);
			expect(acceptedSnapshot).toMatchObject({
				expected: CURRENT_ATTACHMENT,
				observationSequence: 1,
				status: 'attached',
			});
		} finally {
			await activeClient.disconnect();
			await duplicateClient.disconnect();
			await wrongAgentClient.disconnect();
			await staleClient.disconnect();
		}
	});

	it('bounds observers, supports unsubscribe, and retirement cannot reset attachment epochs', async () => {
		// Arrange: fill the bounded observation port
		const server = await startTestServer();
		const observations = Array.from({ length: 32 }, () =>
			server.observeAttachmentSnapshots(() => undefined, failOnAttachmentObserverError),
		);

		// Act / Assert: bounded capacity and release
		expect(() =>
			server.observeAttachmentSnapshots(() => undefined, failOnAttachmentObserverError),
		).toThrowError(/attachment observer capacity/u);
		observations[0]?.unsubscribe();
		const replacementObservation = server.observeAttachmentSnapshots(
			() => undefined,
			failOnAttachmentObserverError,
		);
		replacementObservation.unsubscribe();
		replacementObservation.unsubscribe();
		for (const observation of observations) observation.unsubscribe();

		// Arrange: verify unsubscribe and retirement semantics
		const observedSnapshots: unknown[] = [];
		const retiredObservation = server.observeAttachmentSnapshots(
			(snapshot) => observedSnapshots.push(snapshot),
			failOnAttachmentObserverError,
		);
		const unsubscribedSnapshots: unknown[] = [];
		const unsubscribedObservation = server.observeAttachmentSnapshots(
			(snapshot) => unsubscribedSnapshots.push(snapshot),
			failOnAttachmentObserverError,
		);
		unsubscribedObservation.unsubscribe();
		const client = createClient(server.readiness.socketPath);
		await client.connect();

		// Act
		await server.retire({ drainTimeoutMs: 100 });
		await client.disconnect();

		// Assert
		expect(observedSnapshots).toMatchObject([
			{ observationSequence: 1, status: 'attached' },
			{ observationSequence: 2, status: 'retired' },
		]);
		expect(unsubscribedSnapshots).toEqual([]);
		expect(server.getAttachmentSnapshot()).toMatchObject({
			expected: CURRENT_ATTACHMENT,
			observationSequence: 2,
			status: 'retired',
		});
		retiredObservation.unsubscribe();
	});

	it('reports an attachment observer failure instead of silently dropping authority evidence', async () => {
		const server = await startTestServer();
		const observerFailure = new Error('readiness persistence failed');
		const reportedFailures: unknown[] = [];
		server.observeAttachmentSnapshots(
			() => {
				throw observerFailure;
			},
			(error) => reportedFailures.push(error),
		);
		const client = createClient(server.readiness.socketPath);

		await client.connect();

		expect(reportedFailures).toEqual([observerFailure]);
		await client.disconnect();
	});

	it('publishes a protected fixed socket, serves a handshake-first call, and retires only its socket', async () => {
		// Arrange
		const paths = await createTemporaryPaths();
		const markerPath = path.join(paths.runtimeRoot, 'controller-materialized.marker');
		const dispatchCalls: Parameters<GatewayRuntimeUdsOperationDispatcher>[0][] = [];
		const server = await startTestServer({
			dispatch: async (request): Promise<unknown> => {
				dispatchCalls.push(request);
				return { kind: 'echoed', value: request.params };
			},
			paths,
		});
		await writeFile(markerPath, 'preserve');
		const client = createClient(paths.managedPluginSocketPath);

		try {
			// Act
			await client.connect();
			const result = await client.request('portal.echo', { publicRequest: { text: 'hello' } });
			const runtimeRootStatus = await stat(paths.runtimeRoot);
			const socketStatus = await lstat(paths.managedPluginSocketPath);
			const retirement = await server.retire({ drainTimeoutMs: 100 });

			// Assert
			expect(server.readiness).toEqual({
				kind: 'ready',
				runtimeDirectoryMode: 0o700,
				runtimeRoot: paths.runtimeRoot,
				socketMode: 0o600,
				socketPath: paths.managedPluginSocketPath,
			});
			expect(runtimeRootStatus.mode & 0o777).toBe(0o700);
			expect(socketStatus.isSocket()).toBe(true);
			expect(socketStatus.mode & 0o777).toBe(0o600);
			expect(result).toEqual({
				kind: 'echoed',
				value: { publicRequest: { text: 'hello' } },
			});
			expect(dispatchCalls).toHaveLength(1);
			expect(dispatchCalls[0]).toMatchObject({
				method: 'portal.echo',
				params: { publicRequest: { text: 'hello' } },
			});
			expect(dispatchCalls[0]?.connectionId).toMatch(/^[0-9a-f-]{36}$/u);
			expect(dispatchCalls[0]?.signal.aborted).toBe(false);
			expect(retirement).toMatchObject({
				drainOutcome: 'drained',
				kind: 'retired',
				pendingRequestCountAtRetirement: 0,
				socketRemoved: true,
			});
			await expect(lstat(paths.managedPluginSocketPath)).rejects.toMatchObject({ code: 'ENOENT' });
			await expect(stat(markerPath)).resolves.toMatchObject({ size: 8 });
		} finally {
			await client.disconnect();
		}
	});

	it('does not cache invalid retirement options and caches the first valid retirement', async () => {
		// Arrange
		const server = await startTestServer();

		// Act
		const invalidRetirement = server.retire({ drainTimeoutMs: 0 });

		// Assert
		await expect(invalidRetirement).rejects.toMatchObject({ code: 'invalid-server-limit' });
		expect((await lstat(server.readiness.socketPath)).isSocket()).toBe(true);

		// Act
		const validRetirement = server.retire({ drainTimeoutMs: 100 });
		const repeatedRetirement = server.retire({ drainTimeoutMs: 1 });

		// Assert
		expect(repeatedRetirement).toBe(validRetirement);
		await expect(validRetirement).resolves.toMatchObject({
			drainOutcome: 'drained',
			kind: 'retired',
			socketRemoved: true,
		});
	});

	it('rejects method-before-handshake and never dispatches it', async () => {
		// Arrange
		const dispatchCalls: unknown[] = [];
		const server = await startTestServer({
			dispatch: async (request): Promise<unknown> => {
				dispatchCalls.push(request);
				return { ok: true };
			},
		});
		const socket = await connectRawSocket(server.readiness.socketPath);

		try {
			// Act
			const response = await sendRawRequest({
				message: {
					id: 1,
					jsonrpc: '2.0',
					method: 'portal.echo',
					params: { publicRequest: { text: 'blocked' } },
				},
				socket,
			});

			// Assert
			expect(response).toMatchObject({
				error: { data: { code: 'method-before-handshake' } },
				id: 1,
			});
			expect(dispatchCalls).toEqual([]);
		} finally {
			socket.destroy();
		}
	});

	it('rejects cancellation before handshake as an unauthorized protocol action', async () => {
		// Arrange
		const server = await startTestServer();
		const socket = await connectRawSocket(server.readiness.socketPath);
		const socketClosed = once(socket, 'close', {
			signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
		});

		// Act
		socket.write(
			encodeGatewayRuntimeFrame({
				jsonrpc: '2.0',
				method: 'notifications/cancelled',
				params: { requestId: 1 },
			}),
		);

		// Assert
		await expect(socketClosed).resolves.toBeDefined();
	});

	it('rejects duplicate active, stale, and unauthorized attachments or calls', async () => {
		// Arrange
		const duplicateServer = await startTestServer();
		const activeClient = createClient(duplicateServer.readiness.socketPath);
		const duplicateClient = createClient(duplicateServer.readiness.socketPath);
		await activeClient.connect();

		try {
			// Act / Assert: duplicate and unauthorized
			await expect(duplicateClient.connect()).rejects.toMatchObject({
				code: 'duplicate-active-connection',
			});
			await expect(activeClient.request('forbidden.execute', {})).rejects.toMatchObject({
				data: { code: 'operation-group-not-allowed' },
			});

			// Arrange: stale generation on an independent current server
			const staleServer = await startTestServer();
			const staleClient = createClient(staleServer.readiness.socketPath, {
				...CURRENT_ATTACHMENT,
				attachmentGeneration: CURRENT_ATTACHMENT.attachmentGeneration - 1,
			});

			// Act / Assert: stale
			await expect(staleClient.connect()).rejects.toMatchObject({
				code: 'stale-attachment-generation',
			});
			await staleClient.disconnect();
		} finally {
			await activeClient.disconnect();
			await duplicateClient.disconnect();
		}
	});

	it('isolates cancellation to the matching request while a sibling request completes', async () => {
		// Arrange
		const cancelledDispatchStarted = Promise.withResolvers<void>();
		const cancelledDispatch = Promise.withResolvers<void>();
		const cancelledTerminal = Promise.withResolvers<unknown>();
		const siblingDispatch = Promise.withResolvers<unknown>();
		const dispatchSignals = new Map<string, AbortSignal>();
		const server = await startTestServer({
			dispatch: async ({ method, signal }): Promise<unknown> => {
				dispatchSignals.set(method, signal);
				if (method === 'portal.cancelled') {
					cancelledDispatchStarted.resolve();
					signal.addEventListener('abort', () => cancelledDispatch.resolve(), { once: true });
					return await cancelledTerminal.promise;
				}
				return await siblingDispatch.promise;
			},
		});
		const client = createClient(server.readiness.socketPath);
		await client.connect();
		const cancellation = new AbortController();
		const cancelledRequest = client.request(
			'portal.cancelled',
			{},
			{ signal: cancellation.signal },
		);
		const cancelledRequestResult = cancelledRequest.catch((error: unknown) => error);
		const siblingRequest = client.request('portal.sibling', {});
		await cancelledDispatchStarted.promise;

		try {
			// Act
			cancellation.abort(new Error('local cancellation'));
			await cancelledDispatch.promise;
			cancelledTerminal.resolve({ kind: 'cancelled-terminal' });
			siblingDispatch.resolve({ kind: 'sibling-complete' });

			// Assert
			expect(await cancelledRequestResult).toMatchObject({ code: 'request-aborted' });
			await expect(siblingRequest).resolves.toEqual({ kind: 'sibling-complete' });
			expect(dispatchSignals.get('portal.cancelled')?.aborted).toBe(true);
			expect(dispatchSignals.get('portal.sibling')?.aborted).toBe(false);
		} finally {
			await client.disconnect();
		}
	});

	it('keeps cancellation and terminal access live while bounding admission under frozen outbound pressure', async () => {
		// Arrange
		const cancelledDispatchStarted = Promise.withResolvers<void>();
		const cancelledDispatchAborted = Promise.withResolvers<void>();
		const pressureDispatchCompleted = Promise.withResolvers<void>();
		const terminalAccessObserved = Promise.withResolvers<void>();
		let ordinaryDispatchCount = 0;
		const server = await startTestServer({
			dispatch: async ({ method, signal }): Promise<unknown> => {
				if (method === 'portal.cancelled') {
					cancelledDispatchStarted.resolve();
					return await new Promise<unknown>((resolve) =>
						signal.addEventListener(
							'abort',
							() => {
								cancelledDispatchAborted.resolve();
								resolve({ kind: 'cancelled-terminal' });
							},
							{ once: true },
						),
					);
				}
				if (method === 'portal.pressure') {
					pressureDispatchCompleted.resolve();
					return { payload: 'x'.repeat(256 * 1_024) };
				}
				if (method === 'sandbox.terminal.attach') {
					terminalAccessObserved.resolve();
					return { kind: 'terminal-access-observed' };
				}
				ordinaryDispatchCount += 1;
				return { kind: 'ordinary-work-dispatched' };
			},
			frameLimits: {
				maxBufferedBytes: 300 * 1_024,
				maxContentBytes: 288 * 1_024,
				maxFramesPerChunk: 16,
				maxHeaderBytes: 1_024,
			},
			maxPendingRequestsPerConnection: 2,
		});
		const socket = await connectRawSocket(server.readiness.socketPath);
		await sendRawRequest({
			message: {
				id: 'pressure-handshake',
				jsonrpc: '2.0',
				method: 'managed-plugin.handshake',
				params: CURRENT_ATTACHMENT,
			},
			socket,
		});
		socket.write(
			encodeGatewayRuntimeFrame({
				id: 'cancelled-request',
				jsonrpc: '2.0',
				method: 'portal.cancelled',
				params: {},
			}),
		);
		await cancelledDispatchStarted.promise;
		socket.pause();
		const pressureResponseBuffered = once(socket, 'readable', {
			signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
		});
		socket.write(
			encodeGatewayRuntimeFrame({
				id: 'pressure-response',
				jsonrpc: '2.0',
				method: 'portal.pressure',
				params: {},
			}),
		);
		await pressureDispatchCompleted.promise;
		await pressureResponseBuffered;
		const socketClosed = once(socket, 'close', {
			signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
		});

		// Act: ordinary work consumes one bounded rejection slot, while cancellation and
		// terminal safety traffic behind it must still reach the server before the next request
		// exhausts the pressure budget and closes the connection.
		socket.write(
			Buffer.concat([
				encodeGatewayRuntimeFrame({
					id: 'ordinary-under-pressure',
					jsonrpc: '2.0',
					method: 'portal.ordinary',
					params: {},
				}),
				encodeGatewayRuntimeFrame({
					jsonrpc: '2.0',
					method: GATEWAY_RUNTIME_REQUEST_CANCEL_NOTIFICATION_METHOD,
					params: { requestId: 'cancelled-request' },
				}),
				encodeGatewayRuntimeFrame({
					id: 'terminal-under-pressure',
					jsonrpc: '2.0',
					method: 'sandbox.terminal.attach',
					params: {},
				}),
				encodeGatewayRuntimeFrame({
					id: 'pressure-budget-exhausted',
					jsonrpc: '2.0',
					method: 'portal.ordinary',
					params: {},
				}),
			]),
		);
		await waitForPressureSafetyProof(
			Promise.all([cancelledDispatchAborted.promise, terminalAccessObserved.promise]),
			'cancellation and terminal access',
		);
		socket.resume();

		// Assert
		await socketClosed;
		expect(ordinaryDispatchCount).toBe(0);
		expect(socket.destroyed).toBe(true);
		await expect(server.retire({ drainTimeoutMs: 100 })).resolves.toMatchObject({
			drainOutcome: 'drained',
			pendingRequestCountAtRetirement: 0,
		});
	});

	it('closes before pending settlements exceed two writable frames per connection', async () => {
		// Arrange
		const firstDispatch = Promise.withResolvers<unknown>();
		const secondDispatch = Promise.withResolvers<unknown>();
		const thirdDispatch = Promise.withResolvers<unknown>();
		const allDispatchesStarted = Promise.withResolvers<void>();
		let startedDispatchCount = 0;
		const server = await startTestServer({
			dispatch: async ({ method }): Promise<unknown> => {
				startedDispatchCount += 1;
				if (startedDispatchCount === 3) allDispatchesStarted.resolve();
				if (method === 'portal.buffer-first') return await firstDispatch.promise;
				if (method === 'portal.buffer-second') return await secondDispatch.promise;
				if (method === 'portal.buffer-third') return await thirdDispatch.promise;
				throw new Error('Unexpected writable-retention test method.');
			},
			frameLimits: {
				maxBufferedBytes: 300 * 1_024,
				maxContentBytes: 288 * 1_024,
				maxFramesPerChunk: 16,
				maxHeaderBytes: 1_024,
			},
			maxPendingRequestsPerConnection: 8,
		});
		const socket = await connectRawSocket(server.readiness.socketPath);
		await sendRawRequest({
			message: {
				id: 'retention-handshake',
				jsonrpc: '2.0',
				method: 'managed-plugin.handshake',
				params: CURRENT_ATTACHMENT,
			},
			socket,
		});
		socket.pause();
		socket.write(
			Buffer.concat(
				['first', 'second', 'third'].map((requestName) =>
					encodeGatewayRuntimeFrame({
						id: `buffer-${requestName}`,
						jsonrpc: '2.0',
						method: `portal.buffer-${requestName}`,
						params: {},
					}),
				),
			),
		);
		await allDispatchesStarted.promise;
		const responseReadable = once(socket, 'readable', {
			signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
		});
		const socketClosed = once(socket, 'close', {
			signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
		});

		// Act
		const maximumResponse = { payload: 'x'.repeat(256 * 1_024) };
		firstDispatch.resolve(maximumResponse);
		secondDispatch.resolve(maximumResponse);
		thirdDispatch.resolve(maximumResponse);
		await responseReadable;
		socket.resume();

		// Assert
		await socketClosed;
		expect(startedDispatchCount).toBe(3);
		expect(socket.destroyed).toBe(true);
		await expect(server.retire({ drainTimeoutMs: 100 })).resolves.toMatchObject({
			drainOutcome: 'drained',
			pendingRequestCountAtRetirement: 0,
		});
	});

	it('rejects a server frame buffer above the protocol default', async () => {
		// Arrange
		const paths = await createTemporaryPaths();

		// Act / Assert
		await expect(
			startGatewayRuntimeUdsServer({
				attachmentState: createAttachmentState(),
				dispatch: async (): Promise<unknown> => ({ ok: true }),
				frameLimits: {
					maxBufferedBytes: DEFAULT_GATEWAY_RUNTIME_FRAME_LIMITS.maxBufferedBytes + 1,
				},
				paths,
				resolveOperationGroup,
			}),
		).rejects.toMatchObject({
			code: 'invalid-server-limit',
			name: GatewayRuntimeUdsServerError.name,
		});
	});

	it('enforces connection and pending-request pressure caps', async () => {
		// Arrange: connection pressure
		const connectionPressureServer = await startTestServer({ maxConnections: 1 });
		const firstSocket = await connectRawSocket(connectionPressureServer.readiness.socketPath);
		const secondSocket = await connectRawSocket(connectionPressureServer.readiness.socketPath);
		const secondSocketClosed = once(secondSocket, 'close', {
			signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
		});

		// Act / Assert: connection pressure
		await expect(secondSocketClosed).resolves.toBeDefined();
		expect(firstSocket.destroyed).toBe(false);
		firstSocket.destroy();
		secondSocket.destroy();

		// Arrange: pending pressure
		const firstDispatchObserved = Promise.withResolvers<void>();
		const firstDispatch = Promise.withResolvers<unknown>();
		const pendingPressureServer = await startTestServer({
			dispatch: async ({ method }): Promise<unknown> => {
				if (method === 'portal.slow') {
					firstDispatchObserved.resolve();
					return await firstDispatch.promise;
				}
				return { kind: 'unexpected-dispatch' };
			},
			maxPendingRequestsPerConnection: 1,
		});
		const client = createClient(pendingPressureServer.readiness.socketPath);
		await client.connect();
		const slowRequest = client.request('portal.slow', {});
		await firstDispatchObserved.promise;

		try {
			// Act / Assert: pending pressure
			await expect(client.request('portal.second', {})).rejects.toMatchObject({
				data: { code: 'pending-request-limit-exceeded' },
			});
			firstDispatch.resolve({ kind: 'slow-complete' });
			await expect(slowRequest).resolves.toEqual({ kind: 'slow-complete' });
		} finally {
			await client.disconnect();
		}
	});

	it('bounds malformed frame retention and closes the offending connection', async () => {
		// Arrange
		const dispatchCalls: unknown[] = [];
		const server = await startTestServer({
			dispatch: async (request): Promise<unknown> => {
				dispatchCalls.push(request);
				return { ok: true };
			},
			frameLimits: {
				maxBufferedBytes: 256,
				maxContentBytes: 128,
				maxFramesPerChunk: 4,
				maxHeaderBytes: 64,
			},
		});
		const socket = await connectRawSocket(server.readiness.socketPath);
		const socketClosed = once(socket, 'close', {
			signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
		});

		// Act
		socket.write('Content-Length: 200\r\n\r\n');

		// Assert
		await expect(socketClosed).resolves.toBeDefined();
		expect(dispatchCalls).toEqual([]);
	});

	it('bounded retirement aborts leftovers, fences admission, and reports forced drain', async () => {
		// Arrange
		const dispatchObserved = Promise.withResolvers<void>();
		let dispatchSignal: AbortSignal | undefined;
		const server = await startTestServer({
			dispatch: async ({ signal }): Promise<unknown> => {
				dispatchSignal = signal;
				dispatchObserved.resolve();
				return await new Promise<never>(() => undefined);
			},
		});
		const client = createClient(server.readiness.socketPath);
		await client.connect();
		const pendingRequest = client.request('portal.slow', {});
		const pendingRequestResult = pendingRequest.catch((error: unknown) => error);
		await dispatchObserved.promise;

		// Act
		const retirement = await server.retire({ drainTimeoutMs: 20 });

		// Assert
		expect(retirement).toMatchObject({
			abortedRequestCount: 1,
			drainOutcome: 'forced',
			destroyedConnectionCount: 1,
			kind: 'retired',
			pendingRequestCountAtRetirement: 1,
		});
		expect(dispatchSignal?.aborted).toBe(true);
		expect(await pendingRequestResult).toMatchObject({ code: 'connection-closed' });
		await expect(client.request('portal.after-retirement', {})).rejects.toMatchObject({
			code: 'connection-closed',
		});
	});

	it('safely replaces only a stale socket inode and rejects regular-file or symlink collisions', async () => {
		// Arrange: stale socket inode
		const stalePaths = await createTemporaryPaths();
		await mkdir(stalePaths.runtimeRoot, { mode: 0o700, recursive: true });
		const stagingSocketPath = path.join(stalePaths.runtimeRoot, 'staging.sock');
		const stagingServer = net.createServer();
		stagingServer.listen(stagingSocketPath);
		await once(stagingServer, 'listening', {
			signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
		});
		await rename(stagingSocketPath, stalePaths.managedPluginSocketPath);
		stagingServer.close();
		await once(stagingServer, 'close', {
			signal: AbortSignal.timeout(PROTOCOL_WAIT_MILLISECONDS),
		});
		expect((await lstat(stalePaths.managedPluginSocketPath)).isSocket()).toBe(true);

		// Act / Assert: stale socket is replaced
		const staleReplacementServer = await startTestServer({ paths: stalePaths });
		expect((await lstat(staleReplacementServer.readiness.socketPath)).isSocket()).toBe(true);

		// Arrange / Act / Assert: unsafe collisions are preserved and rejected
		await Promise.all(
			(['regular-file', 'symlink'] as const).map(async (collisionKind) => {
				const collisionPaths = await createTemporaryPaths();
				await mkdir(collisionPaths.runtimeRoot, { mode: 0o700, recursive: true });
				if (collisionKind === 'regular-file') {
					await writeFile(collisionPaths.managedPluginSocketPath, 'do-not-delete');
				} else {
					await symlink('/tmp/forbidden-target', collisionPaths.managedPluginSocketPath);
				}
				await expect(
					startGatewayRuntimeUdsServer({
						attachmentState: createAttachmentState(),
						dispatch: async (): Promise<unknown> => ({ ok: true }),
						limits: { maxConnections: 1, maxPendingRequestsPerConnection: 1 },
						paths: collisionPaths,
						resolveOperationGroup,
					}),
				).rejects.toMatchObject({
					code: 'unsafe-socket-path-collision',
					name: GatewayRuntimeUdsServerError.name,
				});
				expect(await lstat(collisionPaths.managedPluginSocketPath)).toSatisfy((status) =>
					collisionKind === 'regular-file' ? status.isFile() : status.isSymbolicLink(),
				);
			}),
		);
	});
});
