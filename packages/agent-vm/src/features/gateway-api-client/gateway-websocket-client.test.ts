import { describe, expect, it, vi } from 'vitest';

import { createGatewayWebSocketClient } from './gateway-websocket-client.js';

/**
 * Creates a mock WebSocket that simulates the OpenClaw gateway protocol:
 * 1. Emits a `connect.challenge` event immediately after creation
 * 2. Responds to `connect` requests with a `hello-ok` response
 * 3. Responds to subsequent requests via `mockResponder`
 */
function createMockGatewaySocket(options?: {
	readonly challengeNonce?: string;
	readonly connectReject?: { message: string };
	readonly mockResponder?: (parsed: {
		id: string;
		method: string;
		params: unknown;
	}) => { ok: boolean; payload?: unknown; error?: { message: string } };
}): {
	socket: {
		addEventListener: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		send: ReturnType<typeof vi.fn>;
	};
	sentMessages: string[];
} {
	const sentMessages: string[] = [];
	let messageHandler: ((data: { data: string }) => void) | undefined;
	const nonce = options?.challengeNonce ?? 'test-nonce-abc123';

	const socket = {
		addEventListener: vi.fn(
			(event: string, handler: (data: { data: string }) => void) => {
				if (event === 'message') {
					messageHandler = handler;
					// Gateway sends connect.challenge as the first frame
					setTimeout(() => {
						messageHandler?.({
							data: JSON.stringify({
								type: 'event',
								event: 'connect.challenge',
								payload: { nonce, ts: 1737264000000 },
							}),
						});
					}, 1);
				}
			},
		),
		close: vi.fn(),
		send: vi.fn((data: string) => {
			sentMessages.push(data);
			const parsed = JSON.parse(data) as {
				id: string;
				method: string;
				params: unknown;
			};

			if (parsed.method === 'connect') {
				setTimeout(() => {
					if (options?.connectReject) {
						messageHandler?.({
							data: JSON.stringify({
								type: 'res',
								id: parsed.id,
								ok: false,
								error: options.connectReject,
							}),
						});
					} else {
						messageHandler?.({
							data: JSON.stringify({
								type: 'res',
								id: parsed.id,
								ok: true,
								payload: {
									type: 'hello-ok',
									protocol: 3,
									policy: { tickIntervalMs: 15000 },
								},
							}),
						});
					}
				}, 1);
				return;
			}

			// For non-connect requests, use the mock responder or default success
			setTimeout(() => {
				const response = options?.mockResponder?.(parsed) ?? {
					ok: true,
					payload: { text: 'default response' },
				};
				messageHandler?.({
					data: JSON.stringify({
						type: 'res',
						id: parsed.id,
						...response,
					}),
				});
			}, 1);
		}),
	};

	return { socket, sentMessages };
}

describe('createGatewayWebSocketClient', () => {
	it('completes the connect.challenge handshake before sending chat messages', async () => {
		const { socket, sentMessages } = createMockGatewaySocket({
			mockResponder: () => ({
				ok: true,
				payload: { text: 'I ran ls and found 2 files.' },
			}),
		});

		const client = createGatewayWebSocketClient({
			createSocket: () => socket,
			connectOptions: {
				token: 'test-token',
				clientId: 'agent-vm-test',
				clientVersion: '0.1.0',
			},
		});

		const helloOk = await client.connected;
		expect(helloOk).toMatchObject({
			type: 'hello-ok',
			protocol: 3,
		});

		// Verify the connect request was sent with the challenge nonce
		const connectFrame = JSON.parse(sentMessages[0] ?? '{}') as {
			method: string;
			params: {
				auth: { token: string };
				device: { nonce: string };
				role: string;
				minProtocol: number;
			};
		};
		expect(connectFrame.method).toBe('connect');
		expect(connectFrame.params.auth.token).toBe('test-token');
		expect(connectFrame.params.device.nonce).toBe('test-nonce-abc123');
		expect(connectFrame.params.role).toBe('operator');
		expect(connectFrame.params.minProtocol).toBe(3);

		// Now send a chat message after handshake
		const response = await client.chatSend({
			session: 'main',
			text: 'run ls -la in /tmp',
		});

		expect(response).toMatchObject({ text: 'I ran ls and found 2 files.' });
		const chatFrame = JSON.parse(sentMessages[1] ?? '{}') as {
			method: string;
			params: unknown;
		};
		expect(chatFrame.method).toBe('chat.send');
		expect(chatFrame.params).toMatchObject({
			session: 'main',
			text: 'run ls -la in /tmp',
		});
	});

	it('waits for handshake before sending chat.send even if called immediately', async () => {
		const { socket, sentMessages } = createMockGatewaySocket({
			mockResponder: () => ({
				ok: true,
				payload: { text: 'response after handshake' },
			}),
		});

		const client = createGatewayWebSocketClient({
			createSocket: () => socket,
			connectOptions: { token: 'test-token' },
		});

		// Call chatSend immediately -- it should wait for handshake internally
		const responsePromise = client.chatSend({
			session: 'main',
			text: 'hello',
		});

		const response = await responsePromise;
		expect(response).toMatchObject({ text: 'response after handshake' });

		// First message should be the connect request, second is chat.send
		expect(sentMessages).toHaveLength(2);
		const firstFrame = JSON.parse(sentMessages[0] ?? '{}') as { method: string };
		const secondFrame = JSON.parse(sentMessages[1] ?? '{}') as { method: string };
		expect(firstFrame.method).toBe('connect');
		expect(secondFrame.method).toBe('chat.send');
	});

	it('rejects when the gateway refuses the connect handshake', async () => {
		const { socket } = createMockGatewaySocket({
			connectReject: { message: 'protocol version mismatch' },
		});

		const client = createGatewayWebSocketClient({
			createSocket: () => socket,
			connectOptions: { token: 'bad-token' },
		});

		await expect(client.connected).rejects.toThrow('protocol version mismatch');
	});

	it('rejects chat.send when the connect handshake fails', async () => {
		const { socket } = createMockGatewaySocket({
			connectReject: { message: 'auth failed' },
		});

		const client = createGatewayWebSocketClient({
			createSocket: () => socket,
			connectOptions: { token: 'bad-token' },
		});

		await expect(
			client.chatSend({ session: 'test', text: 'hello' }),
		).rejects.toThrow('auth failed');
	});

	it('rejects the promise when the server returns an error to chat.send', async () => {
		const { socket } = createMockGatewaySocket({
			mockResponder: () => ({
				ok: false,
				error: { message: 'session not found' },
			}),
		});

		const client = createGatewayWebSocketClient({
			createSocket: () => socket,
			connectOptions: { token: 'test-token' },
		});

		await client.connected;

		await expect(
			client.chatSend({ session: 'missing', text: 'hello' }),
		).rejects.toThrow('session not found');
	});

	it('closes the underlying socket', () => {
		const { socket } = createMockGatewaySocket();

		const client = createGatewayWebSocketClient({
			createSocket: () => socket,
			connectOptions: { token: 'test-token' },
		});

		client.close();

		expect(socket.close).toHaveBeenCalled();
	});

	it('uses custom protocol version and node role when provided', async () => {
		const { socket, sentMessages } = createMockGatewaySocket();

		const client = createGatewayWebSocketClient({
			createSocket: () => socket,
			connectOptions: {
				token: 'node-token',
				clientId: 'ios-node',
				clientVersion: '2.0.0',
				platform: 'ios',
				role: 'node',
				scopes: [],
				protocolVersion: 4,
			},
		});

		await client.connected;

		const connectFrame = JSON.parse(sentMessages[0] ?? '{}') as {
			params: {
				minProtocol: number;
				maxProtocol: number;
				client: { id: string; mode: string; platform: string };
				role: string;
				scopes: readonly string[];
			};
		};
		expect(connectFrame.params.minProtocol).toBe(4);
		expect(connectFrame.params.maxProtocol).toBe(4);
		expect(connectFrame.params.client.id).toBe('ios-node');
		expect(connectFrame.params.client.mode).toBe('node');
		expect(connectFrame.params.client.platform).toBe('ios');
		expect(connectFrame.params.role).toBe('node');
		expect(connectFrame.params.scopes).toEqual([]);
	});
});
