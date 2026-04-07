interface PendingRequest {
	readonly resolve: (payload: unknown) => void;
	readonly reject: (error: Error) => void;
}

interface WebSocketLike {
	addEventListener(event: string, handler: (data: { data: string }) => void): void;
	close(): void;
	send(data: string): void;
}

export interface GatewayWebSocketClient {
	chatSend(params: {
		readonly session: string;
		readonly text: string;
	}): Promise<unknown>;
	close(): void;
}

export function createGatewayWebSocketClient(options: {
	readonly createSocket: () => WebSocketLike;
}): GatewayWebSocketClient {
	const socket = options.createSocket();
	const pending = new Map<string, PendingRequest>();
	let nextId = 1;

	socket.addEventListener('message', (event: { data: string }) => {
		const message = JSON.parse(event.data) as {
			type: string;
			id?: string;
			ok?: boolean;
			payload?: unknown;
			error?: { message?: string };
		};
		if (message.type === 'res' && message.id) {
			const request = pending.get(message.id);
			if (request) {
				pending.delete(message.id);
				if (message.ok) {
					request.resolve(message.payload);
				} else {
					request.reject(
						new Error(message.error?.message ?? 'Gateway WebSocket request failed'),
					);
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
		chatSend: async (params) => await sendRequest('chat.send', params),
		close: () => socket.close(),
	};
}
