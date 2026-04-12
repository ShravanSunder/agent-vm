import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

export async function startControllerHttpServer(options: {
	readonly app: Hono;
	readonly port: number;
}): Promise<{
	close(): Promise<void>;
}> {
	const server = serve({
		fetch: options.app.fetch,
		port: options.port,
	});

	return {
		async close(): Promise<void> {
			await new Promise<void>((resolve, reject) => {
				server.close((error?: Error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		},
	};
}
