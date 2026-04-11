interface PendingRequest {
	readonly resolve: (payload: unknown) => void;
	readonly reject: (error: Error) => void;
}

interface WebSocketLike {
	addEventListener(event: string, handler: (data: { data: string }) => void): void;
	close(): void;
	send(data: string): void;
}

/**
 * Gateway WebSocket protocol frame types, matching the OpenClaw gateway protocol.
 *
 * - Request:  `{ type: "req", id, method, params }`
 * - Response: `{ type: "res", id, ok, payload | error }`
 * - Event:    `{ type: "event", event, payload }`
 */
interface GatewayFrame {
	readonly type: 'req' | 'res' | 'event';
	readonly id?: string;
	readonly method?: string;
	readonly ok?: boolean;
	readonly payload?: unknown;
	readonly error?: { message?: string };
	readonly event?: string;
}

function parseGatewayFrame(rawFrame: string): GatewayFrame | null {
	const parsed = JSON.parse(rawFrame) as unknown;
	if (typeof parsed !== 'object' || parsed === null) {
		return null;
	}
	const candidate = parsed as Record<string, unknown>;
	if (candidate.type !== 'req' && candidate.type !== 'res' && candidate.type !== 'event') {
		return null;
	}
	const errorMessage =
		typeof candidate.error === 'object' &&
		candidate.error !== null &&
		typeof (candidate.error as { message?: unknown }).message === 'string'
			? (candidate.error as { message: string }).message
			: null;

	return {
		type: candidate.type,
		...(typeof candidate.id === 'string' ? { id: candidate.id } : {}),
		...(typeof candidate.method === 'string' ? { method: candidate.method } : {}),
		...(typeof candidate.ok === 'boolean' ? { ok: candidate.ok } : {}),
		...('payload' in candidate ? { payload: candidate.payload } : {}),
		...(typeof candidate.event === 'string' ? { event: candidate.event } : {}),
		...(errorMessage !== null ? { error: { message: errorMessage } } : {}),
	};
}

/** Nonce + timestamp sent by the gateway as the first frame after WS upgrade. */
interface ConnectChallengePayload {
	readonly nonce: string;
	readonly ts: number;
}

function isConnectChallengePayload(value: unknown): value is ConnectChallengePayload {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as { nonce?: unknown }).nonce === 'string' &&
		typeof (value as { ts?: unknown }).ts === 'number'
	);
}

/** Options for the connect handshake sent to the gateway. */
export interface GatewayConnectOptions {
	readonly token: string;
	readonly clientId?: string;
	readonly clientVersion?: string;
	readonly platform?: string;
	readonly role?: 'operator' | 'node';
	readonly scopes?: readonly string[];
	readonly protocolVersion?: number;
}

/** Successful connect response payload from the gateway. */
interface ConnectHelloOkPayload {
	readonly type: 'hello-ok';
	readonly protocol: number;
	readonly policy?: { readonly tickIntervalMs?: number };
	readonly auth?: {
		readonly deviceToken?: string;
		readonly role?: string;
		readonly scopes?: readonly string[];
	};
}

function isConnectHelloOkPayload(value: unknown): value is ConnectHelloOkPayload {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { type?: unknown }).type === 'hello-ok' &&
		typeof (value as { protocol?: unknown }).protocol === 'number'
	);
}

export interface GatewayWebSocketClient {
	/** Resolves when the connect handshake completes. Rejects if the gateway refuses. */
	readonly connected: Promise<ConnectHelloOkPayload>;
	chatSend(params: { readonly session: string; readonly text: string }): Promise<unknown>;
	close(): void;
}

const DEFAULT_PROTOCOL_VERSION = 3;

export function createGatewayWebSocketClient(options: {
	readonly createSocket: () => WebSocketLike;
	readonly connectOptions: GatewayConnectOptions;
}): GatewayWebSocketClient {
	const socket = options.createSocket();
	const pending = new Map<string, PendingRequest>();
	let nextId = 1;

	/** Resolves when the connect handshake succeeds. */
	let resolveConnected: (payload: ConnectHelloOkPayload) => void;
	let rejectConnected: (error: Error) => void;
	const connected = new Promise<ConnectHelloOkPayload>((resolve, reject) => {
		resolveConnected = resolve;
		rejectConnected = reject;
	});

	/** Tracks whether the handshake has completed so we can gate outbound requests. */
	let handshakeComplete = false;

	socket.addEventListener('message', (event: { data: string }) => {
		const message = parseGatewayFrame(event.data);
		if (!message) {
			return;
		}

		// --- Handle the connect.challenge event from the gateway ---
		if (message.type === 'event' && message.event === 'connect.challenge') {
			if (!isConnectChallengePayload(message.payload)) {
				rejectConnected(new Error('Gateway sent invalid connect.challenge payload'));
				return;
			}
			const challengePayload = message.payload;
			const connectOpts = options.connectOptions;
			const protocolVersion = connectOpts.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
			const connectId = String(nextId);
			nextId += 1;

			pending.set(connectId, {
				resolve: (payload: unknown) => {
					if (!isConnectHelloOkPayload(payload)) {
						rejectConnected(new Error('Gateway sent invalid hello-ok payload'));
						return;
					}
					handshakeComplete = true;
					resolveConnected(payload);
				},
				reject: (error: Error) => {
					rejectConnected(error);
				},
			});

			socket.send(
				JSON.stringify({
					type: 'req',
					id: connectId,
					method: 'connect',
					params: {
						minProtocol: protocolVersion,
						maxProtocol: protocolVersion,
						client: {
							id: connectOpts.clientId ?? 'agent-vm',
							version: connectOpts.clientVersion ?? '0.0.0',
							platform: connectOpts.platform ?? 'node',
							mode: connectOpts.role ?? 'operator',
						},
						role: connectOpts.role ?? 'operator',
						scopes: connectOpts.scopes ?? ['operator.read', 'operator.write'],
						caps: [],
						commands: [],
						permissions: {},
						auth: { token: connectOpts.token },
						device: {
							nonce: challengePayload.nonce,
						},
					},
				}),
			);
			return;
		}

		// --- Handle response frames ---
		if (message.type === 'res' && message.id) {
			const request = pending.get(message.id);
			if (request) {
				pending.delete(message.id);
				if (message.ok) {
					request.resolve(message.payload);
				} else {
					request.reject(new Error(message.error?.message ?? 'Gateway WebSocket request failed'));
				}
			}
		}
	});

	function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
		const id = String(nextId);
		nextId += 1;
		return new Promise<unknown>((resolve, reject) => {
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ type: 'req', id, method, params }));
		});
	}

	return {
		connected,
		chatSend: async (params) => {
			// Wait for the connect handshake to complete before sending requests.
			if (!handshakeComplete) {
				await connected;
			}
			return await sendRequest('chat.send', params);
		},
		close: () => socket.close(),
	};
}
