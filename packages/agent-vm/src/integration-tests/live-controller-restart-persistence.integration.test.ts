import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ManagedVm, ManagedVmInstance } from 'gondolin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SystemConfig } from '../config/system-config.js';
import { startControllerRuntime } from '../controller/controller-runtime.js';

function createSystemConfig(
	controllerPort: number,
	stateDirectory: string,
	workspaceDirectory: string,
): SystemConfig {
	return {
		cacheDir: path.join(path.dirname(stateDirectory), 'cache'),
		host: {
			controllerPort,
			secretsProvider: {
				type: '1password',
				tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
			},
		},
		images: {
			gateway: {
				buildConfig: './images/gateway/build-config.json',
			},
			tool: {
				buildConfig: './images/tool/build-config.json',
			},
		},
		zones: [
			{
				id: 'shravan',
				gateway: {
					type: 'openclaw',
					memory: '2G',
					cpus: 2,
					port: controllerPort + 100,
					gatewayConfig: './config/shravan/openclaw.json',
					stateDir: stateDirectory,
					workspaceDir: workspaceDirectory,
				},
				secrets: {},
				allowedHosts: ['api.openai.com'],
				websocketBypass: [],
				toolProfile: 'standard',
			},
		],
		toolProfiles: {
			standard: {
				memory: '1G',
				cpus: 1,
				workspaceRoot: './workspaces/tools',
			},
		},
		tcpPool: {
			basePort: 19000,
			size: 5,
		},
	};
}

function createGatewayVmMock(
	stateDirectory: string,
): Pick<
	ManagedVm,
	'close' | 'enableIngress' | 'enableSsh' | 'exec' | 'getVmInstance' | 'id' | 'setIngressRoutes'
> {
	return {
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
		enableSsh: async () => ({
			command: 'ssh root@127.0.0.1',
			host: '127.0.0.1',
			port: 19000,
			user: 'root',
		}),
		exec: async (command: string) => {
			if (command === 'write-state persistence.txt persistent-value') {
				fs.writeFileSync(path.join(stateDirectory, 'persistence.txt'), 'persistent-value', 'utf8');
				return { exitCode: 0, stderr: '', stdout: '' };
			}

			if (command === 'read-state persistence.txt') {
				return {
					exitCode: 0,
					stderr: '',
					stdout: fs.readFileSync(path.join(stateDirectory, 'persistence.txt'), 'utf8'),
				};
			}

			if (command.includes('cat /tmp/openclaw.log')) {
				return { exitCode: 0, stderr: '', stdout: 'gateway-log' };
			}

			return { exitCode: 0, stderr: '', stdout: '' };
		},
		getVmInstance: () => ({}) as ManagedVmInstance,
		id: 'gateway-vm-live-restart',
		setIngressRoutes: () => {},
	};
}

async function waitForControllerShutdown(controllerPort: number): Promise<boolean> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- polling shutdown transition
			await fetch(`http://127.0.0.1:${controllerPort}/health`);
		} catch {
			return true;
		}
		// oxlint-disable-next-line no-await-in-loop -- polling shutdown transition
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	return false;
}

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { recursive: true, force: true });
	}
});

describe('live integration: controller restart persistence', () => {
	it('preserves state across stop and restart while restoring lease functionality', async () => {
		process.env.OP_SERVICE_ACCOUNT_TOKEN = 'token';
		const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-restart-live-'));
		createdDirectories.push(tempDirectory);

		const stateDirectory = path.join(tempDirectory, 'state');
		const workspaceDirectory = path.join(tempDirectory, 'workspace');
		fs.mkdirSync(stateDirectory, { recursive: true });
		fs.mkdirSync(workspaceDirectory, { recursive: true });

		const controllerPort = 18841;
		const systemConfig = createSystemConfig(controllerPort, stateDirectory, workspaceDirectory);
		const zone = systemConfig.zones[0];
		if (!zone) {
			throw new Error('Expected restart test zone.');
		}

		const startRuntime = async (): ReturnType<typeof startControllerRuntime> =>
			await startControllerRuntime(
				{
					systemConfig,
					zoneId: 'shravan',
				},
				{
					createManagedToolVm: vi.fn(async () => ({
						close: vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({
							host: '127.0.0.1',
							port: 18791,
						})),
						enableSsh: vi.fn(async () => ({
							command: 'ssh sandbox@127.0.0.1',
							host: '127.0.0.1',
							port: 19000,
							user: 'sandbox',
						})),
						exec: vi.fn(async () => ({ exitCode: 0, stderr: '', stdout: '' })),
						id: 'tool-vm-live-restart',
						setIngressRoutes: vi.fn(),
						getVmInstance: vi.fn(),
					})),
					createSecretResolver: async () => ({
						resolve: async () => '',
						resolveAll: async () => ({}),
					}),
					startGatewayZone: vi.fn(async () => ({
						image: {
							built: true,
							fingerprint: 'gateway-image',
							imagePath: '/tmp/gateway-image',
						},
						ingress: {
							host: '127.0.0.1',
							port: 18791,
						},
						processSpec: {
							bootstrapCommand: 'bootstrap-openclaw',
							guestListenPort: 18789,
							healthCheck: { type: 'http', port: 18789, path: '/' } as const,
							logPath: '/tmp/openclaw.log',
							startCommand: 'start-openclaw',
						},
						vm: createGatewayVmMock(stateDirectory),
						zone,
					})),
				},
			);

		const runtime = await startRuntime();

		await fetch(`http://127.0.0.1:${controllerPort}/zones/shravan/execute-command`, {
			body: JSON.stringify({ command: 'write-state persistence.txt persistent-value' }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});

		const stopResponse = await fetch(`http://127.0.0.1:${controllerPort}/stop-controller`, {
			method: 'POST',
		});
		expect(stopResponse.status).toBe(200);

		const healthStopped = await waitForControllerShutdown(controllerPort);
		expect(healthStopped).toBe(true);

		const restartedRuntime = await startRuntime();

		const readResponse = await fetch(
			`http://127.0.0.1:${controllerPort}/zones/shravan/execute-command`,
			{
				body: JSON.stringify({ command: 'read-state persistence.txt' }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			},
		);
		const readBody = (await readResponse.json()) as {
			readonly stdout: string;
		};
		expect(readBody.stdout).toBe('persistent-value');

		const leasesResponse = await fetch(`http://127.0.0.1:${controllerPort}/leases`);
		const leasesBody = (await leasesResponse.json()) as unknown[];
		expect(leasesBody).toHaveLength(0);

		const createLeaseResponse = await fetch(`http://127.0.0.1:${controllerPort}/lease`, {
			body: JSON.stringify({
				agentWorkspaceDir: '/workspace',
				profileId: 'standard',
				scopeKey: 'restart-test',
				workspaceDir: '/workspace',
				zoneId: 'shravan',
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		expect(createLeaseResponse.status).toBe(200);

		await restartedRuntime.close();
		await runtime.close().catch(() => {});
	});
});
