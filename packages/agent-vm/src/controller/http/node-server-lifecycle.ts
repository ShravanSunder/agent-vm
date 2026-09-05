import type { ServerType } from '@hono/node-server';

export async function waitForNodeServerListening(server: ServerType): Promise<void> {
	if (server.listening) return;
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off('listening', onListening);
			reject(error);
		};
		const onListening = (): void => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		if (server.listening) onListening();
	});
}

export async function closeNodeServer(server: ServerType): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error?: Error) => {
			if (error !== undefined) reject(error);
			else resolve();
		});
	});
}
