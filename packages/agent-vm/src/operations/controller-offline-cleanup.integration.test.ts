import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { ControllerOwnershipLockError } from '../controller/vm-ownership/controller-ownership-lock.js';
import { runControllerOfflineCleanup as runControllerOfflineCleanupProduction } from './controller-offline-cleanup.js';

function createSystemConfig(
	options: { readonly controllerPort?: number } = {},
): LoadedSystemConfig {
	return createLoadedSystemConfig(
		{
			schemaVersion: 1,
			cacheDir: '/cache',
			host: {
				controllerPort: options.controllerPort ?? 18900,
				projectNamespace: 'shravan-claw-beta-25319b68',
			},
			imageProfiles: {
				gateways: {
					openclaw: {
						type: 'openclaw',
						buildConfig: './vm-images/gateways/openclaw/build-config.jsonc',
						source: { kind: 'managedBase', base: 'openclaw-gateway' },
					},
				},
				toolVms: {
					default: {
						type: 'toolVm',
						buildConfig: './vm-images/tool-vms/default/build-config.jsonc',
						source: { kind: 'managedBase', base: 'tool-vm' },
					},
				},
			},
			runtimeDir: '/runtime',
			toolVmProfiles: {
				default: {
					cpus: 1,
					imageProfile: 'default',
					memory: '2G',
				},
			},
			tcpPool: {
				basePort: 19000,
				size: 8,
			},
			zones: [
				{
					egressHosts: [{ audience: 'gateway', host: 'api.openai.com' }],
					agentToolVmProfiles: {},
					defaultToolVmProfile: 'default',
					gateway: {
						controlAuth: {
							mode: 'token',
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
						config: '/deployments/shravan-claw-beta/config/gateways/beta/openclaw.json',
						cpus: 2,
						imageProfile: 'openclaw',
						memory: '4G',
						port: 18891,
						stateDir: '/state/beta',
						type: 'openclaw',
						zoneFilesDir: '/zone-files/beta',
					},
					id: 'beta',
					agents: [{ id: 'main' }],
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							audience: 'gateway',
							envVar: 'OPENCLAW_GATEWAY_TOKEN',
							injection: 'env',
							source: 'environment',
						},
					},
				},
			],
		},
		{ systemConfigPath: '/deployments/shravan-claw-beta/config/system.jsonc' },
	);
}

async function withHttpServer<TValue>(
	handler: http.RequestListener,
	callback: (port: number) => Promise<TValue>,
): Promise<TValue> {
	const server = http.createServer(handler);
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address() as AddressInfo;
	try {
		return await callback(address.port);
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}
}

async function findClosedLocalPort(): Promise<number> {
	return await withHttpServer(
		(_request, response) => {
			response.writeHead(204);
			response.end();
		},
		async (port) => port,
	);
}

function runControllerOfflineCleanup(
	options: Parameters<typeof runControllerOfflineCleanupProduction>[0],
	dependencies: Parameters<typeof runControllerOfflineCleanupProduction>[1] = {},
): ReturnType<typeof runControllerOfflineCleanupProduction> {
	return runControllerOfflineCleanupProduction(options, {
		acquireControllerOwnershipLock: async () => ({ release: async () => {} }),
		...dependencies,
	});
}

describe('runControllerOfflineCleanup', () => {
	it('refuses to clean up while the configured controller is reachable', async () => {
		const operationOrder: string[] = [];
		const release = vi.fn(async () => {
			operationOrder.push('release-lock');
		});
		const acquireControllerOwnershipLock = vi.fn(async () => {
			operationOrder.push('acquire-lock');
			return { release };
		});
		const assertControllerUnavailableForOfflineCleanup = vi.fn(async () => {
			operationOrder.push('probe-controller');
			throw new Error('controller is reachable');
		});
		const reconcileExactVmOwnership = vi.fn(async () => {
			operationOrder.push('reconcile');
		});

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					acquireControllerOwnershipLock,
					assertControllerUnavailableForOfflineCleanup,
					reconcileExactVmOwnership,
				},
			),
		).rejects.toThrow(/controller is reachable/u);

		expect(reconcileExactVmOwnership).not.toHaveBeenCalled();
		expect(operationOrder).toEqual(['acquire-lock', 'probe-controller', 'release-lock']);
		expect(release).toHaveBeenCalledOnce();
	});

	it('does not probe or reconcile when the deployment ownership lock is held', async () => {
		const lockConflict = new ControllerOwnershipLockError('controller-already-active');
		const assertControllerUnavailableForOfflineCleanup = vi.fn(async () => {});
		const reconcileExactVmOwnership = vi.fn(async () => {});

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					acquireControllerOwnershipLock: vi.fn(async () => {
						throw lockConflict;
					}),
					assertControllerUnavailableForOfflineCleanup,
					reconcileExactVmOwnership,
				},
			),
		).rejects.toBe(lockConflict);

		expect(assertControllerUnavailableForOfflineCleanup).not.toHaveBeenCalled();
		expect(reconcileExactVmOwnership).not.toHaveBeenCalled();
	});

	it('refuses cleanup when controller reachability is ambiguous', async () => {
		const reconcileExactVmOwnership = vi.fn(async () => {});

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					assertControllerUnavailableForOfflineCleanup: async () => {
						throw new Error('health probe timed out');
					},
					reconcileExactVmOwnership,
				},
			),
		).rejects.toThrow(/health probe timed out/u);

		expect(reconcileExactVmOwnership).not.toHaveBeenCalled();
	});

	it('refuses cleanup when the controller health endpoint returns an HTTP response', async () => {
		const reconcileExactVmOwnership = vi.fn(async () => {});
		await withHttpServer(
			(_request, response) => {
				response.writeHead(503);
				response.end('busy');
			},
			async (controllerPort) => {
				await expect(
					runControllerOfflineCleanup(
						{
							systemConfig: createSystemConfig({ controllerPort }),
							zoneId: 'beta',
						},
						{ reconcileExactVmOwnership },
					),
				).rejects.toThrow(/HTTP 503/u);
			},
		);

		expect(reconcileExactVmOwnership).not.toHaveBeenCalled();
	});

	it('allows cleanup when the controller port refuses connections', async () => {
		const controllerPort = await findClosedLocalPort();
		const reconcileExactVmOwnership = vi.fn(async () => {});

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig({ controllerPort }),
					zoneId: 'beta',
				},
				{ reconcileExactVmOwnership },
			),
		).resolves.toEqual({
			results: [
				{
					ownershipDisposition: 'complete',
					stateDir: '/state/beta',
					zoneId: 'beta',
				},
			],
		});
		expect(reconcileExactVmOwnership).toHaveBeenCalledOnce();
	});

	it('allows forced cleanup even while the configured controller is reachable', async () => {
		const operationOrder: string[] = [];
		const release = vi.fn(async () => {
			operationOrder.push('release-lock');
		});
		const acquireControllerOwnershipLock = vi.fn(async () => {
			operationOrder.push('acquire-lock');
			return { release };
		});
		const assertControllerUnavailableForOfflineCleanup = vi.fn(async () => {
			throw new Error('should not probe when forced');
		});
		const reconcileExactVmOwnership = vi.fn(async () => {
			operationOrder.push('reconcile');
		});

		await expect(
			runControllerOfflineCleanup(
				{
					force: true,
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					acquireControllerOwnershipLock,
					assertControllerUnavailableForOfflineCleanup,
					reconcileExactVmOwnership,
				},
			),
		).resolves.toEqual({
			results: [
				{
					ownershipDisposition: 'complete',
					stateDir: '/state/beta',
					zoneId: 'beta',
				},
			],
		});
		expect(assertControllerUnavailableForOfflineCleanup).not.toHaveBeenCalled();
		expect(reconcileExactVmOwnership).toHaveBeenCalledOnce();
		expect(acquireControllerOwnershipLock).toHaveBeenCalledWith({
			runtimeDirectory: '/runtime',
		});
		expect(operationOrder).toEqual(['acquire-lock', 'reconcile', 'release-lock']);
	});

	it('cleans only the requested zone from the selected installation config', async () => {
		const systemConfig = createSystemConfig();
		const operationOrder: string[] = [];
		const release = vi.fn(async () => {
			operationOrder.push('release-lock');
		});
		const acquireControllerOwnershipLock = vi.fn(async () => {
			operationOrder.push('acquire-lock');
			return { release };
		});
		const assertControllerUnavailableForOfflineCleanup = vi.fn(async () => {
			operationOrder.push('probe-controller');
		});
		const reconcileExactVmOwnership = vi.fn(async () => {
			operationOrder.push('reconcile');
		});

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig,
					zoneId: 'beta',
				},
				{
					acquireControllerOwnershipLock,
					assertControllerUnavailableForOfflineCleanup,
					reconcileExactVmOwnership,
				},
			),
		).resolves.toEqual({
			results: [
				{
					ownershipDisposition: 'complete',
					stateDir: '/state/beta',
					zoneId: 'beta',
				},
			],
		});

		expect(reconcileExactVmOwnership).toHaveBeenCalledOnce();
		expect(reconcileExactVmOwnership).toHaveBeenCalledWith({
			systemConfig,
			zoneId: 'beta',
		});
		expect(operationOrder).toEqual([
			'acquire-lock',
			'probe-controller',
			'reconcile',
			'release-lock',
		]);
	});

	it('propagates owner-unsafe exact reconciliation without a success result', async () => {
		const ownershipError = Object.assign(
			new Error('exact VM ownership reconciliation refused owner-unsafe evidence'),
			{ code: 'owner-unsafe' as const },
		);
		const reconcileExactVmOwnership = vi.fn(async () => {
			throw ownershipError;
		});
		const release = vi.fn(async () => {});

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					acquireControllerOwnershipLock: vi.fn(async () => ({ release })),
					assertControllerUnavailableForOfflineCleanup: async () => {},
					reconcileExactVmOwnership,
				},
			),
		).rejects.toBe(ownershipError);

		expect(reconcileExactVmOwnership).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
	});

	it('rejects an unknown zone before touching runtime records', async () => {
		const acquireControllerOwnershipLock = vi.fn(async () => ({
			release: async () => {},
		}));
		const reconcileExactVmOwnership = vi.fn(async () => {});

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig(),
					zoneId: 'sunfam',
				},
				{
					acquireControllerOwnershipLock,
					assertControllerUnavailableForOfflineCleanup: async () => {},
					reconcileExactVmOwnership,
				},
			),
		).rejects.toThrow(/Unknown zone 'sunfam'/u);

		expect(acquireControllerOwnershipLock).not.toHaveBeenCalled();
		expect(reconcileExactVmOwnership).not.toHaveBeenCalled();
	});
});
