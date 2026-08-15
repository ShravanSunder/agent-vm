import { createServer } from 'node:net';

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { startControllerHttpServer } from './controller-http-server.js';

async function findAvailablePort(): Promise<number> {
	const reservation = createServer();
	await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
	const address = reservation.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Port reservation did not expose a TCP port.');
	}
	await new Promise<void>((resolve, reject) =>
		reservation.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

describe('startControllerHttpServer', () => {
	it("preserves Node's native global web constructors", async () => {
		const nativeRequest = globalThis.Request;
		const nativeResponse = globalThis.Response;
		const app = new Hono();
		const port = await findAvailablePort();

		const server = await startControllerHttpServer({ app, port });
		try {
			const response = await fetch(`http://127.0.0.1:${port}/`);
			expect(response.status).toBe(404);
			expect(globalThis.Request).toBe(nativeRequest);
			expect(globalThis.Response).toBe(nativeResponse);
		} finally {
			globalThis.Request = nativeRequest;
			globalThis.Response = nativeResponse;
			await server.close();
		}
	});
});
