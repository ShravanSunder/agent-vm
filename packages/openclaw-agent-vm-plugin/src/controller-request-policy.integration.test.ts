import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import { fetchControllerWithPolicy } from './controller-request-policy.js';

async function listenOnLoopback(server: Server): Promise<number> {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('Expected TCP server address.');
	}
	return address.port;
}

async function closeServer(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}
	server.close();
	await once(server, 'close');
}

async function nextUnusedLoopbackPort(): Promise<number> {
	const server = createServer();
	const port = await listenOnLoopback(server);
	await closeServer(server);
	return port;
}

describe('controller request policy real Node networking integration', () => {
	it('classifies native fetch connection refusal with the raw Node cause code', async () => {
		const port = await nextUnusedLoopbackPort();

		await expect(
			fetchControllerWithPolicy(`http://127.0.0.1:${String(port)}/health`, {
				fetchImpl: fetch,
				method: 'GET',
				operation: 'gateway-control-link',
				policy: {
					maxAttempts: 1,
					retryBaseDelayMs: 0,
					timeoutMs: 500,
				},
			}),
		).rejects.toMatchObject({
			causeCode: 'ECONNREFUSED',
			name: 'ControllerRequestFailureError',
			operation: 'gateway-control-link',
		});
	});

	it('classifies native fetch socket resets as bounded controller-link failures', async () => {
		const server = createServer((_request, response) => {
			const socket = response.socket;
			if (!(socket instanceof Socket)) {
				throw new Error('Expected response socket.');
			}
			socket.destroy();
		});
		const port = await listenOnLoopback(server);

		try {
			await expect(
				fetchControllerWithPolicy(`http://127.0.0.1:${String(port)}/health`, {
					fetchImpl: fetch,
					method: 'GET',
					operation: 'gateway-control-link',
					policy: {
						maxAttempts: 1,
						retryBaseDelayMs: 0,
						timeoutMs: 500,
					},
				}),
			).rejects.toMatchObject({
				name: 'ControllerRequestFailureError',
				operation: 'gateway-control-link',
			});
		} finally {
			await closeServer(server);
		}
	});

	it('aborts concurrent native fetches independently when the controller accepts but never responds', async () => {
		const server = createServer((_request, _response) => {
			// Leave each response open to simulate a stalled controller link.
		});
		const port = await listenOnLoopback(server);

		try {
			const requests = Array.from({ length: 3 }, (_value, index) =>
				fetchControllerWithPolicy(`http://127.0.0.1:${String(port)}/heartbeat-${String(index)}`, {
					fetchImpl: fetch,
					method: 'POST',
					operation: 'active-use-heartbeat',
					policy: {
						maxAttempts: 1,
						retryBaseDelayMs: 0,
						timeoutMs: 25,
					},
				}).catch((error: unknown) => error),
			);

			await expect(Promise.all(requests)).resolves.toEqual([
				expect.objectContaining({
					name: 'ControllerRequestTimeoutError',
					operation: 'active-use-heartbeat',
					timeoutMs: 25,
				}),
				expect.objectContaining({
					name: 'ControllerRequestTimeoutError',
					operation: 'active-use-heartbeat',
					timeoutMs: 25,
				}),
				expect.objectContaining({
					name: 'ControllerRequestTimeoutError',
					operation: 'active-use-heartbeat',
					timeoutMs: 25,
				}),
			]);
		} finally {
			await closeServer(server);
		}
	});
});
