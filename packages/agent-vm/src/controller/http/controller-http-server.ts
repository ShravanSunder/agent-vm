import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

import { closeNodeServer, waitForNodeServerListening } from './node-server-lifecycle.js';

export async function startControllerHttpServer(options: {
	readonly app: Hono;
	readonly port: number;
}): Promise<{
	close(): Promise<void>;
}> {
	const server = serve({
		fetch: options.app.fetch,
		hostname: '127.0.0.1',
		overrideGlobalObjects: false,
		port: options.port,
	});
	await waitForNodeServerListening(server);

	return {
		async close(): Promise<void> {
			await closeNodeServer(server);
		},
	};
}
