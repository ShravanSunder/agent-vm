import { describe, expect, it, vi } from 'vitest';

import { createGatewayWebSocketClient } from './gateway-websocket-client.js';

describe('createGatewayWebSocketClient', () => {
	it('sends a chat message and collects the response', async () => {
		const sentMessages: string[] = [];
		let messageHandler: ((data: { data: string }) => void) | undefined;

		const mockWebSocket = {
			addEventListener: vi.fn(
				(event: string, handler: (data: { data: string }) => void) => {
					if (event === 'message') {
						messageHandler = handler;
					}
				},
			),
			close: vi.fn(),
			send: vi.fn((data: string) => {
				sentMessages.push(data);
				const parsed = JSON.parse(data) as { id: string; method: string };
				setTimeout(() => {
					messageHandler?.({
						data: JSON.stringify({
							type: 'res',
							id: parsed.id,
							ok: true,
							payload: { text: 'I ran ls and found 2 files.' },
						}),
					});
				}, 1);
			}),
		};

		const client = createGatewayWebSocketClient({
			createSocket: () => mockWebSocket,
		});

		const response = await client.chatSend({
			session: 'main',
			text: 'run ls -la in /tmp',
		});

		expect(response).toMatchObject({ text: 'I ran ls and found 2 files.' });
		const sent = JSON.parse(sentMessages[0] ?? '{}') as { method: string; params: unknown };
		expect(sent.method).toBe('chat.send');
		expect(sent.params).toMatchObject({ session: 'main', text: 'run ls -la in /tmp' });
	});

	it('rejects the promise when the server returns an error response', async () => {
		let messageHandler: ((data: { data: string }) => void) | undefined;

		const mockWebSocket = {
			addEventListener: vi.fn(
				(event: string, handler: (data: { data: string }) => void) => {
					if (event === 'message') {
						messageHandler = handler;
					}
				},
			),
			close: vi.fn(),
			send: vi.fn((data: string) => {
				const parsed = JSON.parse(data) as { id: string };
				setTimeout(() => {
					messageHandler?.({
						data: JSON.stringify({
							type: 'res',
							id: parsed.id,
							ok: false,
							error: { message: 'session not found' },
						}),
					});
				}, 1);
			}),
		};

		const client = createGatewayWebSocketClient({
			createSocket: () => mockWebSocket,
		});

		await expect(
			client.chatSend({ session: 'missing', text: 'hello' }),
		).rejects.toThrow('session not found');
	});

	it('closes the underlying socket', () => {
		const mockWebSocket = {
			addEventListener: vi.fn(),
			close: vi.fn(),
			send: vi.fn(),
		};

		const client = createGatewayWebSocketClient({
			createSocket: () => mockWebSocket,
		});

		client.close();

		expect(mockWebSocket.close).toHaveBeenCalled();
	});
});
