import { createServer, type Server as HttpServer } from 'node:http';

import {
	CONTROL_PROTOCOL_VERSION,
	type ControlEnvelope,
} from '@agent-vm/control-protocol-contracts';
import { WorkerControlRpcMessageSchema } from '@agent-vm/worker-control-contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createWorkerControlApplicationMessageHandler } from '../../../../agent-vm-worker/src/control-session/worker-control-application-handler.js';
import {
	WORKER_CONTROL_READY_PATH,
	WORKER_CONTROL_SOCKET_PATH,
	createWorkerControlService,
	type WorkerControlService,
} from '../../../../agent-vm-worker/src/control-session/worker-control-service.js';
import {
	buildWorkerControlEndpoint,
	connectWorkerControlSession,
	createWorkerControlSessionMaterial,
} from './worker-control-session.js';

const activeServers: HttpServer[] = [];

afterEach(async () => {
	await Promise.all(
		activeServers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) {
							reject(error);
							return;
						}
						resolve();
					});
				}),
		),
	);
});

async function listenWithWorkerControlService(service: WorkerControlService): Promise<number> {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://worker.local');
		if (url.pathname === WORKER_CONTROL_READY_PATH) {
			service.handleReadyRequest(req, res);
			return;
		}
		res.statusCode = 404;
		res.end('not found\n');
	});
	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', 'http://worker.local');
		if (url.pathname === WORKER_CONTROL_SOCKET_PATH) {
			service.handleUpgrade(req, socket, head);
			return;
		}
		socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
		socket.destroy();
	});
	activeServers.push(server);
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	if (typeof address !== 'object' || address === null) {
		throw new Error('Expected TCP server address.');
	}
	return address.port;
}

describe('worker control session connector', () => {
	it('sends controller-originated operation_cancel to the real worker control service for hard rejection', async () => {
		const material = createWorkerControlSessionMaterial({
			controllerEpoch: 'controller-epoch-a',
			taskId: 'task-1',
			zoneId: 'zone-a',
		});
		const service = createWorkerControlService({
			applicationMessageHandler: createWorkerControlApplicationMessageHandler(),
			identity: {
				bootId: material.bootId,
				controllerEpoch: material.controllerEpoch,
				generationId: material.generationId,
				peerId: material.peerId,
				zoneId: material.zoneId,
			},
			verifierPublicKeyPem: material.verifierPublicKeyPem,
		});
		const port = await listenWithWorkerControlService(service);
		const client = await connectWorkerControlSession({
			endpoint: buildWorkerControlEndpoint({ host: '127.0.0.1', port }),
			material,
		});

		try {
			const acceptedSession = await service.getAcceptedSession();
			const envelope = {
				bootId: material.bootId,
				commandId: '11111111-1111-4111-8111-111111111111',
				connectionId: acceptedSession.connectionId,
				controllerEpoch: material.controllerEpoch,
				createdAtMs: 1,
				deliveryPolicy: 'acked_idempotent',
				domain: 'worker_control',
				idempotencyKey: 'operation-cancel-key',
				kind: 'command',
				messageId: '22222222-2222-4222-8222-222222222222',
				operation: 'operation_cancel',
				peerId: material.peerId,
				protocolVersion: CONTROL_PROTOCOL_VERSION,
				sequence: 1,
				sessionId: acceptedSession.sessionId,
				zoneId: material.zoneId,
			} satisfies ControlEnvelope;
			const result = await client.emitApplicationMessage(
				envelope,
				{ kind: 'command', operation: 'operation_cancel' },
				WorkerControlRpcMessageSchema.parse({
					kind: 'command',
					operation: 'operation_cancel',
					payload: {
						activeOperationId: '33333333-3333-4333-8333-333333333333',
						initiatedBy: 'controller',
						reason: 'operator_cancelled',
					},
				}),
			);

			expect(result).toMatchObject({
				kind: 'command_result',
				operation: 'operation_cancel',
				payload: {
					error: {
						errorClass: 'worker_control_cancel_not_supported',
					},
					result: 'rejected',
				},
			});
		} finally {
			client.close();
			await service.close();
		}
	});
});
