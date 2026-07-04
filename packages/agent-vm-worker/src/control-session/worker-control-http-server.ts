import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

import {
	WORKER_CONTROL_SOCKET_PATH,
	writeWorkerControlUpgradeFailure,
	type WorkerControlService,
} from './worker-control-service.js';

export interface AttachWorkerControlUpgradeHandlerOptions {
	readonly server: HttpServer;
	readonly workerControlService?: WorkerControlService | undefined;
}

export function attachWorkerControlUpgradeHandler(
	options: AttachWorkerControlUpgradeHandlerOptions,
): void {
	options.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
		const url = new URL(req.url ?? '/', 'http://worker.local');
		if (url.pathname !== WORKER_CONTROL_SOCKET_PATH) {
			return;
		}
		const service = options.workerControlService;
		if (service === undefined) {
			writeWorkerControlUpgradeFailure(socket, 503);
			return;
		}
		service.handleUpgrade(req, socket, head);
	});
}
