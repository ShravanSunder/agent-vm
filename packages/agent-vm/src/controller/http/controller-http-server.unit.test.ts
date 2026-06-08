import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

interface CapturedServeOptions {
	readonly fetch: unknown;
	readonly hostname?: string;
	readonly port: number;
}

const serveHarness = vi.hoisted(() => {
	const capturedOptions: CapturedServeOptions[] = [];
	return {
		capturedOptions,
		serve: vi.fn((options: CapturedServeOptions) => {
			capturedOptions.push(options);
			return {
				close: (callback: (error?: Error) => void): void => {
					callback();
				},
			};
		}),
	};
});

vi.mock('@hono/node-server', () => ({
	serve: serveHarness.serve,
}));

import { startControllerHttpServer } from './controller-http-server.js';

describe('startControllerHttpServer', () => {
	it('binds the controller API to loopback by default', async () => {
		const app = new Hono();

		const server = await startControllerHttpServer({ app, port: 18800 });

		expect(serveHarness.capturedOptions).toHaveLength(1);
		expect(serveHarness.capturedOptions[0]).toMatchObject({
			hostname: '127.0.0.1',
			port: 18800,
		});

		await server.close();
	});
});
