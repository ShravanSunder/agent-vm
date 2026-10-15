import { EventEmitter, getEventListeners } from 'node:events';

import { CONTROL_PROTOCOL_VERSION } from '@agent-vm/control-protocol-contracts';
import {
	GatewayControlHelloSchema,
	type GatewayControlHelloResponse,
} from '@agent-vm/gateway-control-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

const socketTransportMocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('socket.io-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('socket.io-client')>()),
	io: socketTransportMocks.create,
}));

import { createGatewayControlProcessAdmissionCoordinator } from './gateway-control-process-admission-coordinator.js';
import {
	buildGatewayControlEndpoint,
	connectGatewayControlSession,
	createGatewayControlSessionMaterial,
	type GatewayControlSessionMaterial,
} from './gateway-control-session.js';
import type {
	GatewayDisposableControlSessionClient,
	GatewayDisposableControlSocket,
} from './gateway-disposable-control-session-client.js';

type StartupConnectionObservation =
	| {
			readonly kind: 'connected';
			readonly client: GatewayDisposableControlSessionClient;
			readonly elapsedMs: number;
	  }
	| { readonly kind: 'failed'; readonly error: unknown; readonly elapsedMs: number };

// Only the external socket transport is replaced. Connector, credential parsing,
// request signing, disposable attempt ownership and hello acceptance remain real.
function createStartupControlSocket(
	options: {
		readonly connectError?: Error;
		readonly pendingHello?: boolean;
	} = {},
): GatewayDisposableControlSocket {
	const socketEvents = new EventEmitter();
	const managerEvents = new EventEmitter();
	let connected = false;
	const socket = {
		get connected(): boolean {
			return connected;
		},
		connect(): void {
			if (options.connectError !== undefined) {
				socketEvents.emit('connect_error', options.connectError);
				return;
			}
			connected = true;
			socketEvents.emit('connect');
		},
		disconnect(): void {
			connected = false;
		},
		io: {
			engine: { transport: { name: 'websocket' } },
			removeAllListeners: (): EventEmitter => managerEvents.removeAllListeners(),
		},
		on: socketEvents.on.bind(socketEvents),
		once: socketEvents.once.bind(socketEvents),
		removeAllListeners: socketEvents.removeAllListeners.bind(socketEvents),
		sendBuffer: [],
		timeout: (timeoutMs: number) => ({
			emitWithAck: async (eventName: string, payload: unknown): Promise<unknown> => {
				if (eventName !== 'control:hello') {
					throw new Error(`Unexpected socket transport event: ${eventName}`);
				}
				const hello = GatewayControlHelloSchema.parse(payload);
				if (options.pendingHello === true) {
					return await new Promise<never>((_resolve, reject) => {
						setTimeout(() => reject(new Error('hello acknowledgement timed out')), timeoutMs);
					});
				}
				return {
					attachmentGeneration: hello.attachmentGeneration,
					connectionId: '11111111-1111-4111-8111-111111111111',
					controllerEpoch: hello.controllerEpoch,
					outcome: 'accepted',
					sessionId: '22222222-2222-4222-8222-222222222222',
				} satisfies GatewayControlHelloResponse;
			},
		}),
	};
	// Socket.IO's unrelated transport machinery is outside this unit boundary.
	return socket as unknown as GatewayDisposableControlSocket;
}

function buildStartupCredentialResponse(material: GatewayControlSessionMaterial): Response {
	const issuedAtMs = Date.now();
	return new Response(
		JSON.stringify({
			audience: 'gateway_control',
			bootId: material.bootId,
			controllerEpoch: material.controllerEpoch,
			credentialId: '33333333-3333-4333-8333-333333333333',
			expiresAtMs: issuedAtMs + 1_000,
			generationId: material.generationId,
			issuedAtMs,
			nonce: 'gateway-startup-ready-nonce',
			peerId: material.peerId,
			protocolVersion: CONTROL_PROTOCOL_VERSION,
			zoneId: material.zoneId,
		}),
		{ headers: { 'content-type': 'application/json' }, status: 200 },
	);
}

function observeStartupConnection(promise: Promise<GatewayDisposableControlSessionClient>): {
	readonly observations: StartupConnectionObservation[];
	readonly completion: Promise<void>;
} {
	const startedAtMs = Date.now();
	const observations: StartupConnectionObservation[] = [];
	const completion = promise.then(
		(client): void => {
			observations.push({ kind: 'connected', client, elapsedMs: Date.now() - startedAtMs });
		},
		(error: unknown): void => {
			observations.push({ kind: 'failed', error, elapsedMs: Date.now() - startedAtMs });
		},
	);
	return { observations, completion };
}

async function closeObservedStartup(options: {
	readonly ownerAbort: AbortController;
	readonly connection: ReturnType<typeof observeStartupConnection>;
}): Promise<void> {
	options.ownerAbort.abort(new Error('startup scenario cleanup'));
	await options.connection.completion;
	for (const observation of options.connection.observations) {
		if (observation.kind === 'connected') observation.client.close();
	}
}

afterEach(() => {
	socketTransportMocks.create.mockReset();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('gateway control first acceptance through credential discovery', () => {
	it('accepts a valid credential and hello through the real disposable manager', async () => {
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'startup-controller',
			zoneId: 'startup-ready-zone',
		});
		socketTransportMocks.create.mockReturnValue(createStartupControlSocket());
		const onHelloResponse = vi.fn();

		const client = await connectGatewayControlSession({
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
			fetchImpl: async () => buildStartupCredentialResponse(material),
			material,
			onHelloResponse,
		});
		try {
			expect(client.getDiagnostics()).toMatchObject({ accepted: true, helloCount: 1, ready: true });
			expect(onHelloResponse).toHaveBeenCalledWith(
				expect.objectContaining({ controllerEpoch: material.controllerEpoch, outcome: 'accepted' }),
			);
			expect(socketTransportMocks.create).toHaveBeenCalledOnce();
		} finally {
			client.close();
		}
	});

	it('accepts a listener published after eight seconds within the existing first-acceptance budget', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const startedAtMs = Date.now();
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'startup-controller',
			zoneId: 'startup-delayed-zone',
		});
		socketTransportMocks.create.mockReturnValue(createStartupControlSocket());
		const onHelloResponse = vi.fn();
		let transientResponseCount = 0;
		let credentialResponseCount = 0;
		const fetchImpl: typeof fetch = async () => {
			if (Date.now() - startedAtMs < 8_000) {
				transientResponseCount += 1;
				return new Response('bad gateway\n', { status: 502, statusText: 'Bad Gateway' });
			}
			credentialResponseCount += 1;
			return buildStartupCredentialResponse(material);
		};
		const ownerAbort = new AbortController();
		const observations: StartupConnectionObservation[] = [];
		const completion = connectGatewayControlSession({
			endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
			fetchImpl,
			material,
			onHelloResponse,
			signal: ownerAbort.signal,
		}).then(
			(client): void => {
				observations.push({ kind: 'connected', client, elapsedMs: Date.now() - startedAtMs });
			},
			(error: unknown): void => {
				observations.push({ kind: 'failed', error, elapsedMs: Date.now() - startedAtMs });
			},
		);
		try {
			// Retry scheduling may observe the recovered listener after 8000ms.
			// Drive only the existing first-acceptance bound, never an unbounded timer drain.
			await vi.advanceTimersByTimeAsync(60_000);
			const outcome = observations[0];
			if (outcome === undefined) {
				throw new Error(
					'Gateway first acceptance did not settle within its existing 60000ms bound.',
				);
			}
			if (outcome.kind === 'failed') {
				throw new Error(
					`Gateway first acceptance failed at ${String(outcome.elapsedMs)}ms before transient ingress recovered at 8000ms.`,
					{ cause: outcome.error },
				);
			}
			const connectedClient = outcome.client;
			expect(connectedClient.getDiagnostics()).toMatchObject({
				accepted: true,
				helloCount: 1,
				ready: true,
			});
			expect(onHelloResponse).toHaveBeenCalledWith(
				expect.objectContaining({ controllerEpoch: material.controllerEpoch, outcome: 'accepted' }),
			);
			expect(transientResponseCount).toBeGreaterThan(0);
			expect(credentialResponseCount).toBe(1);
			expect(socketTransportMocks.create).toHaveBeenCalledOnce();
			expect(outcome.elapsedMs).toBeGreaterThanOrEqual(8_000);
			expect(outcome.elapsedMs).toBeLessThan(60_000);
		} finally {
			ownerAbort.abort(new Error('startup regression cleanup'));
			await completion;
			for (const observation of observations) {
				if (observation.kind === 'connected') observation.client.close();
			}
		}
	});
	it('terminates on401 after earlier502 responses before the first valid credential', async () => {
		vi.useFakeTimers();
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'startup-controller',
			zoneId: 'startup-auth-zone',
		});
		const ownerAbort = new AbortController();
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
			.mockResolvedValue(
				new Response('unauthorized: signature_mismatch', {
					status: 401,
					statusText: 'Unauthorized',
				}),
			);
		const connection = observeStartupConnection(
			connectGatewayControlSession({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
				signal: ownerAbort.signal,
			}),
		);
		try {
			await vi.advanceTimersByTimeAsync(60_000);
			const outcome = connection.observations[0];
			expect(outcome?.kind).toBe('failed');
			if (outcome?.kind !== 'failed') throw new Error('Expected terminal initial401.');
			expect(outcome.error).toBeInstanceOf(Error);
			expect(String(outcome.error)).toContain('HTTP 401 Unauthorized');
			expect(fetchImpl).toHaveBeenCalledTimes(2);
			expect(socketTransportMocks.create).not.toHaveBeenCalled();
		} finally {
			await closeObservedStartup({ ownerAbort, connection });
		}
	});

	it.each([
		['transport', 'transport refused'],
		['schema', ''],
		['identity', 'did not match controller session material'],
		['forbidden', 'HTTP 403 Forbidden'],
		['other-server-status', 'HTTP 503 Service Unavailable'],
	] as const)('keeps initial %s failure terminal', async (failureKind, expectedMessage) => {
		vi.useFakeTimers();
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'startup-controller',
			zoneId: 'startup-terminal-zone',
		});
		const ownerAbort = new AbortController();
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			switch (failureKind) {
				case 'transport':
					throw new Error('transport refused');
				case 'schema':
					return new Response('{}', { status: 200 });
				case 'identity':
					return buildStartupCredentialResponse({
						...material,
						generationId: 'foreign-generation',
					});
				case 'forbidden':
					return new Response('forbidden', { status: 403, statusText: 'Forbidden' });
				case 'other-server-status':
					return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' });
			}
		});
		const connection = observeStartupConnection(
			connectGatewayControlSession({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
				signal: ownerAbort.signal,
			}),
		);
		try {
			await vi.advanceTimersByTimeAsync(60_000);
			const outcome = connection.observations[0];
			expect(outcome?.kind).toBe('failed');
			if (outcome?.kind !== 'failed') throw new Error('Expected terminal initial failure.');
			if (failureKind === 'schema') expect(outcome.error).toMatchObject({ name: 'ZodError' });
			else expect(String(outcome.error)).toContain(expectedMessage);
			expect(fetchImpl).toHaveBeenCalledOnce();
			expect(socketTransportMocks.create).not.toHaveBeenCalled();
		} finally {
			await closeObservedStartup({ ownerAbort, connection });
		}
	});

	it('keeps a pending initial request timeout terminal at3000ms', async () => {
		vi.useFakeTimers();
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'startup-controller',
			zoneId: 'startup-timeout-zone',
		});
		const ownerAbort = new AbortController();
		const fetchImpl = vi.fn<typeof fetch>(async () => await new Promise<Response>(() => undefined));
		const connection = observeStartupConnection(
			connectGatewayControlSession({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
				signal: ownerAbort.signal,
			}),
		);
		try {
			await vi.advanceTimersByTimeAsync(60_000);
			const outcome = connection.observations[0];
			if (outcome?.kind !== 'failed') throw new Error('Expected terminal initial request timeout.');
			expect(outcome.elapsedMs).toBe(3_000);
			expect(String(outcome.error)).toContain('readiness timed out after 3000ms');
			expect(fetchImpl).toHaveBeenCalledOnce();
			expect(socketTransportMocks.create).not.toHaveBeenCalled();
		} finally {
			await closeObservedStartup({ ownerAbort, connection });
		}
	});

	it('exhausts the existing initial attempt budget with the last bounded502 cause', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'startup-controller',
			zoneId: 'startup-exhaust-zone',
		});
		const ownerAbort = new AbortController();
		const fetchImpl = vi.fn<typeof fetch>(
			async () =>
				new Response('cold listener unavailable', { status: 502, statusText: 'Bad Gateway' }),
		);
		const connection = observeStartupConnection(
			connectGatewayControlSession({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
				signal: ownerAbort.signal,
			}),
		);
		try {
			await vi.advanceTimersByTimeAsync(60_000);
			const outcome = connection.observations[0];
			if (outcome?.kind !== 'failed') throw new Error('Expected bounded initial exhaustion.');
			expect(String(outcome.error)).toContain('gateway control reconnect budget exhausted');
			expect(String(outcome.error)).toContain('HTTP 502 Bad Gateway: cold listener unavailable');
			expect(outcome.error).toMatchObject({ cause: expect.any(Error) });
			expect(outcome.elapsedMs).toBeLessThanOrEqual(60_000);
			expect(fetchImpl).toHaveBeenCalledTimes(16);
			expect(socketTransportMocks.create).not.toHaveBeenCalled();
		} finally {
			await closeObservedStartup({ ownerAbort, connection });
		}
	});

	it('lets an admitted late credential reach its existing hello timeout before attempt exhaustion', async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
		vi.setSystemTime(1_000_000);
		const startedAtMs = Date.now();
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'startup-controller',
			zoneId: 'startup-deadline-zone',
		});
		const ownerAbort = new AbortController();
		socketTransportMocks.create.mockReturnValue(createStartupControlSocket({ pendingHello: true }));
		const fetchImpl = vi.fn<typeof fetch>(async () => {
			if (Date.now() - startedAtMs < 57_000) return new Response('bad gateway', { status: 502 });
			await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
			return buildStartupCredentialResponse(material);
		});
		const connection = observeStartupConnection(
			connectGatewayControlSession({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
				signal: ownerAbort.signal,
			}),
		);
		try {
			await vi.advanceTimersByTimeAsync(65_000);
			const outcome = connection.observations[0];
			if (outcome?.kind !== 'failed')
				throw new Error('Expected admission exhaustion after the admitted hello timed out.');
			expect(outcome.elapsedMs).toBeGreaterThan(60_000);
			expect(outcome.elapsedMs).toBeLessThan(63_000);
			expect(String(outcome.error)).toContain('gateway control reconnect budget exhausted');
			expect(socketTransportMocks.create).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(socketTransportMocks.create).toHaveBeenCalledOnce();
		} finally {
			await closeObservedStartup({ ownerAbort, connection });
		}
	});

	it('retains refresh401 retry behavior after a valid first credential but before accepted hello', async () => {
		vi.useFakeTimers();
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'startup-controller',
			zoneId: 'startup-refresh-zone',
		});
		const ownerAbort = new AbortController();
		socketTransportMocks.create
			.mockReturnValueOnce(
				createStartupControlSocket({ connectError: new Error('socket refused') }),
			)
			.mockReturnValue(createStartupControlSocket());
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(async () => buildStartupCredentialResponse(material))
			.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
			.mockImplementation(async () => buildStartupCredentialResponse(material));
		const connection = observeStartupConnection(
			connectGatewayControlSession({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
				signal: ownerAbort.signal,
			}),
		);
		try {
			await vi.advanceTimersByTimeAsync(10_000);
			const outcome = connection.observations[0];
			if (outcome?.kind !== 'connected')
				throw new Error('Expected refreshed credentials to recover before first acceptance.');
			expect(outcome.client.getDiagnostics()).toMatchObject({ accepted: true });
			expect(fetchImpl).toHaveBeenCalledTimes(3);
			expect(socketTransportMocks.create).toHaveBeenCalledTimes(2);
		} finally {
			await closeObservedStartup({ ownerAbort, connection });
		}
	});

	it('preserves owner abort and fences a late initial credential without a socket or retry', async () => {
		vi.useFakeTimers();
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'startup-controller',
			zoneId: 'startup-abort-zone',
		});
		const ownerAbort = new AbortController();
		const addEventListener = vi.spyOn(ownerAbort.signal, 'addEventListener');
		const removeEventListener = vi.spyOn(ownerAbort.signal, 'removeEventListener');
		const onHelloResponse = vi.fn();
		let resolveResponse!: (response: Response) => void;
		const response = new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
		const fetchImpl = vi.fn<typeof fetch>(async () => await response);
		const connection = observeStartupConnection(
			connectGatewayControlSession({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
				onHelloResponse,
				signal: ownerAbort.signal,
			}),
		);
		const abortReason = new Error('exact startup owner abort');
		try {
			await vi.advanceTimersByTimeAsync(0);
			ownerAbort.abort(abortReason);
			await connection.completion;
			const outcome = connection.observations[0];
			if (outcome?.kind !== 'failed') throw new Error('Expected owner abort failure.');
			expect(outcome.error).toBe(abortReason);
			resolveResponse(buildStartupCredentialResponse(material));
			await vi.advanceTimersByTimeAsync(60_000);
			expect(fetchImpl).toHaveBeenCalledOnce();
			expect(socketTransportMocks.create).not.toHaveBeenCalled();
			expect(onHelloResponse).not.toHaveBeenCalled();
			expect(addEventListener).toHaveBeenCalled();
			// Abort and ready settlement can both request idempotent removal of the same listener.
			expect(new Set(removeEventListener.mock.calls.map(([, listener]) => listener))).toEqual(
				new Set(addEventListener.mock.calls.map(([, listener]) => listener)),
			);
			expect(getEventListeners(ownerAbort.signal, 'abort')).toHaveLength(0);
		} finally {
			await closeObservedStartup({ ownerAbort, connection });
		}
	});

	it('rejects a superseded pending acquisition and fences its late credential', async () => {
		vi.useFakeTimers();
		const coordinator = createGatewayControlProcessAdmissionCoordinator();
		const material = createGatewayControlSessionMaterial({
			controllerEpoch: 'startup-controller',
			zoneId: 'startup-superseded-zone',
		});
		const ownerAbort = new AbortController();
		let resolveResponse!: (response: Response) => void;
		const response = new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
		const fetchImpl = vi.fn<typeof fetch>(async () => await response);
		const connection = observeStartupConnection(
			connectGatewayControlSession({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl,
				material,
				processAdmissionCoordinator: coordinator,
				signal: ownerAbort.signal,
			}),
		);
		let successor: GatewayDisposableControlSessionClient | undefined;
		socketTransportMocks.create.mockReturnValue(createStartupControlSocket());
		try {
			await vi.advanceTimersByTimeAsync(0);
			successor = await connectGatewayControlSession({
				endpoint: buildGatewayControlEndpoint({ host: '127.0.0.1', port: 18791 }),
				fetchImpl: async () => buildStartupCredentialResponse(material),
				material,
				processAdmissionCoordinator: coordinator,
			});
			await vi.advanceTimersByTimeAsync(0);
			const outcome = connection.observations[0];
			if (outcome?.kind !== 'failed')
				throw new Error('Pending initial owner was not settled on supersession.');
			expect(String(outcome.error)).toContain('superseded');
			resolveResponse(buildStartupCredentialResponse(material));
			await vi.advanceTimersByTimeAsync(60_000);
			expect(socketTransportMocks.create).toHaveBeenCalledOnce();
			expect(successor.getDiagnostics()).toMatchObject({ accepted: true });
		} finally {
			await closeObservedStartup({ ownerAbort, connection });
			successor?.close();
		}
	});
});
