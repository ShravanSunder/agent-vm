import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workerOperationMocks = vi.hoisted(() => ({
	attachWorkerControlUpgradeHandler: vi.fn(),
	createApp: vi.fn(() => ({ fetch: vi.fn() })),
	createCoordinator: vi.fn(async () => ({
		closeTask: vi.fn(),
		getActiveTaskId: vi.fn(() => undefined),
		getTaskState: vi.fn(() => undefined),
		submitTask: vi.fn(),
	})),
	createWorkerControlApplicationMessageHandler: vi.fn(),
	createWorkerControlService: vi.fn(),
	createWorkerControlServiceOptionsFromEnvironment: vi.fn(() => undefined),
	loadWorkerConfig: vi.fn(async () => ({ stateDir: '/tmp/worker-state' })),
	resolvePhaseExecutor: vi.fn(() => ({ model: 'test-model', provider: 'test-provider' })),
	serve: vi.fn(),
}));

vi.mock('@hono/node-server', () => ({ serve: workerOperationMocks.serve }));
vi.mock('./config/worker-config.js', () => ({
	loadWorkerConfig: workerOperationMocks.loadWorkerConfig,
	resolvePhaseExecutor: workerOperationMocks.resolvePhaseExecutor,
}));
vi.mock('./control-session/worker-control-application-handler.js', () => ({
	createWorkerControlApplicationMessageHandler:
		workerOperationMocks.createWorkerControlApplicationMessageHandler,
}));
vi.mock('./control-session/worker-control-http-server.js', () => ({
	attachWorkerControlUpgradeHandler: workerOperationMocks.attachWorkerControlUpgradeHandler,
}));
vi.mock('./control-session/worker-control-service.js', () => ({
	createWorkerControlService: workerOperationMocks.createWorkerControlService,
	createWorkerControlServiceOptionsFromEnvironment:
		workerOperationMocks.createWorkerControlServiceOptionsFromEnvironment,
}));
vi.mock('./coordinator/coordinator.js', () => ({
	createCoordinator: workerOperationMocks.createCoordinator,
}));
vi.mock('./server.js', () => ({ createApp: workerOperationMocks.createApp }));

import { runWorkerServeLifecycle } from './worker-cli-operations.js';

const createdServers: Server[] = [];

async function closeListeningServer(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

describe('worker CLI serve startup', () => {
	beforeEach(() => {
		workerOperationMocks.serve.mockImplementation(
			(options: { readonly port: number }, listeningListener: (info: AddressInfo) => void) => {
				const server = createServer();
				createdServers.push(server);
				server.on('error', () => undefined);
				server.listen(options.port, () => {
					const address = server.address();
					if (address !== null && typeof address !== 'string') listeningListener(address);
				});
				return server;
			},
		);
	});

	afterEach(async () => {
		await Promise.all(createdServers.splice(0).map(closeListeningServer));
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('rejects when the requested port cannot be bound', async () => {
		// Arrange
		const occupiedServer = createServer();
		createdServers.push(occupiedServer);
		await new Promise<void>((resolve) => occupiedServer.listen(0, resolve));
		const occupiedAddress = occupiedServer.address();
		if (occupiedAddress === null || typeof occupiedAddress === 'string') {
			throw new Error('Expected the occupied worker test server to have a TCP address.');
		}

		// Act / Assert
		await expect(
			runWorkerServeLifecycle({
				command: 'serve',
				config: undefined,
				port: occupiedAddress.port,
				stateDir: undefined,
			}),
		).rejects.toMatchObject({ code: 'EADDRINUSE' });
	});
});
