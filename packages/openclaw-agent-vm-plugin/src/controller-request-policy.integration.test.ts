import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { Socket } from 'node:net';

import { describe, expect, it } from 'vitest';

import {
	ControllerRequestPolicyTransportError,
	fetchControllerWithPolicy,
	type ControllerRequestPolicy,
} from './controller-request-policy.js';

const singleAttemptPolicy = {
	idempotency: 'read',
	maxAttempts: 1,
	retryBaseDelayMs: 0,
	retryEnabled: false,
	retryStatuses: [],
	timeoutMs: 500,
} satisfies ControllerRequestPolicy;

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
	it('classifies native fetch connection refusal as a bounded controller-link failure', async () => {
		const port = await nextUnusedLoopbackPort();

		await expect(
			fetchControllerWithPolicy({
				fetchImpl: fetch,
				input: `http://127.0.0.1:${String(port)}/health`,
				init: { method: 'GET' },
				operation: 'controller-health',
				policy: singleAttemptPolicy,
			}),
		).rejects.toMatchObject({
			code: 'controller-request-failed',
			operation: 'controller-health',
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
			let thrownError: unknown;
			try {
				await fetchControllerWithPolicy({
					fetchImpl: fetch,
					input: `http://127.0.0.1:${String(port)}/health`,
					init: { method: 'GET' },
					operation: 'controller-health',
					policy: singleAttemptPolicy,
				});
			} catch (error) {
				thrownError = error;
			}
			expect(thrownError).toBeInstanceOf(ControllerRequestPolicyTransportError);
			const transportError = thrownError as ControllerRequestPolicyTransportError;
			expect(transportError.operation).toBe('controller-health');
			expect(['controller-request-failed', 'controller-request-timeout']).toContain(
				transportError.code,
			);
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
				fetchControllerWithPolicy({
					fetchImpl: fetch,
					input: `http://127.0.0.1:${String(port)}/heartbeat-${String(index)}`,
					init: { method: 'POST' },
					operation: 'lease-heartbeat',
					policy: {
						...singleAttemptPolicy,
						idempotency: 'safe-mutation',
						timeoutMs: 25,
					},
				}).catch((error: unknown) => error),
			);

			await expect(Promise.all(requests)).resolves.toEqual([
				expect.objectContaining({
					code: 'controller-request-timeout',
					operation: 'lease-heartbeat',
				}),
				expect.objectContaining({
					code: 'controller-request-timeout',
					operation: 'lease-heartbeat',
				}),
				expect.objectContaining({
					code: 'controller-request-timeout',
					operation: 'lease-heartbeat',
				}),
			]);
		} finally {
			await closeServer(server);
		}
	});
});
