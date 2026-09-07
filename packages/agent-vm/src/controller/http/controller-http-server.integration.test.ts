import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { loadSystemConfig } from '../../config/system-config.js';
import { createControllerService } from './controller-http-routes.js';
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

async function loadHermesSystemConfig(options: {
	readonly controllerPort: number;
	readonly temporaryRoot: string;
}): ReturnType<typeof loadSystemConfig> {
	const systemConfigPath = path.join(options.temporaryRoot, 'config', 'system.jsonc');
	await mkdir(path.dirname(systemConfigPath), { recursive: true });
	await writeFile(
		systemConfigPath,
		JSON.stringify({
			schemaVersion: 2,
			storageRootDir: '../storage',
			host: {
				controllerPort: options.controllerPort,
				projectNamespace: 'controller-http-boundary-test',
			},
			imageProfiles: {
				gateways: {
					hermes: {
						buildConfig: './vm-images/gateways/hermes/build-config.jsonc',
						type: 'hermes',
					},
				},
				toolVms: {
					default: {
						buildConfig: '../vm-images/tool-vms/default/build-config.jsonc',
						type: 'toolVm',
					},
				},
			},
			toolVmProfiles: {
				standard: {
					cpus: 1,
					imageProfile: 'default',
					memory: '1G',
				},
			},
			tcpPool: { basePort: 19_000, size: 2 },
			zones: [
				{
					agentToolVmProfiles: {},
					agents: [{ id: 'test-agent' }],
					adminAccess: { mode: 'none' },
					defaultToolVmProfile: 'standard',
					egressHosts: [{ audience: 'gateway', host: 'api.openai.com' }],
					gateway: {
						config: './config/gateways/hermes-zone/hermes-managed/config.yaml',
						cpus: 2,
						imageProfile: 'hermes',
						memory: '2G',
						port: 18_791,
						profileSecretProjectionsByAgent: {
							'test-agent': {
								API_SERVER_KEY: 'API_SERVER_KEY_TEST_AGENT',
								DISCORD_BOT_TOKEN: 'DISCORD_BOT_TOKEN_TEST_AGENT',
							},
						},
						profilesByAgent: { 'test-agent': 'test-agent' },
						type: 'hermes',
					},
					id: 'hermes-zone',
					secrets: {
						API_SERVER_KEY_TEST_AGENT: {
							audience: 'gateway',
							envVar: 'API_SERVER_KEY_TEST_AGENT',
							injection: 'env',
							source: 'environment',
						},
						DISCORD_BOT_TOKEN_TEST_AGENT: {
							audience: 'gateway',
							envVar: 'DISCORD_BOT_TOKEN_TEST_AGENT',
							injection: 'env',
							source: 'environment',
						},
					},
				},
			],
		}),
		'utf8',
	);
	return await loadSystemConfig(systemConfigPath);
}

describe('startControllerHttpServer', () => {
	it('rejects only after an occupied port emits its bind failure', async () => {
		const reservation = createServer();
		await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
		const address = reservation.address();
		if (address === null || typeof address === 'string') {
			throw new Error('Port reservation did not expose a TCP port.');
		}
		try {
			await expect(
				startControllerHttpServer({ app: new Hono(), port: address.port }),
			).rejects.toMatchObject({ code: 'EADDRINUSE' });
		} finally {
			await new Promise<void>((resolve, reject) =>
				reservation.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

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

	it('keeps retired Worker task routes absent at the real controller HTTP boundary', async () => {
		const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-controller-http-'));
		const port = await findAvailablePort();
		const obsoleteCallbacks = {
			closeTaskForZone: vi.fn(),
			getTaskState: vi.fn(),
			prepareWorkerTask: vi.fn(),
			pullDefaultForTask: vi.fn(),
			pushTaskBranches: vi.fn(),
		};
		const leaseManagerCallbacks = {
			createLease: vi.fn(),
			listLeases: vi.fn(() => []),
			peekLease: vi.fn(),
			releaseLease: vi.fn(),
			renewLease: vi.fn(),
		};
		const retainedOperationCallbacks = {
			destroyZone: vi.fn(async () => ({})),
			getStatus: vi.fn(async () => ({})),
			getZoneLogs: vi.fn(async () => ({})),
			refreshZoneCredentials: vi.fn(async () => ({})),
			upgradeZone: vi.fn(async () => ({})),
		};
		const systemConfig = await loadHermesSystemConfig({
			controllerPort: port,
			temporaryRoot,
		});
		const app = createControllerService({
			leaseManager: leaseManagerCallbacks,
			operations: {
				...retainedOperationCallbacks,
				...obsoleteCallbacks,
			},
			systemConfig,
		});
		const server = await startControllerHttpServer({ app, port });

		try {
			const baseUrl = `http://127.0.0.1:${String(port)}`;
			const retiredRouteResponses = await Promise.all([
				fetch(`${baseUrl}/zones/hermes-zone/worker-tasks`, { method: 'POST' }),
				fetch(`${baseUrl}/zones/hermes-zone/tasks/task-1`),
				fetch(`${baseUrl}/zones/hermes-zone/tasks/task-1/close`, { method: 'POST' }),
				fetch(`${baseUrl}/zones/hermes-zone/tasks/task-1/push-branches`, { method: 'POST' }),
				fetch(`${baseUrl}/zones/hermes-zone/tasks/task-1/pull-default`, { method: 'POST' }),
			]);
			const healthResponse = await fetch(`${baseUrl}/health`);

			expect(retiredRouteResponses.map((response) => response.status)).toEqual([
				404, 404, 404, 404, 404,
			]);
			expect(healthResponse.status).toBe(200);
			await expect(healthResponse.json()).resolves.toEqual({ ok: true, port, state: 'ready' });
			for (const obsoleteCallback of Object.values(obsoleteCallbacks)) {
				expect(obsoleteCallback).not.toHaveBeenCalled();
			}
			for (const retainedOperationCallback of Object.values(retainedOperationCallbacks)) {
				expect(retainedOperationCallback).not.toHaveBeenCalled();
			}
			for (const leaseManagerCallback of Object.values(leaseManagerCallbacks)) {
				expect(leaseManagerCallback).not.toHaveBeenCalled();
			}
			await expect(readdir(temporaryRoot)).resolves.toEqual(['config']);
		} finally {
			await server.close();
			await rm(temporaryRoot, { force: true, recursive: true });
		}
	});
});
