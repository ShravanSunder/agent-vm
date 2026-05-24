import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { runControllerOfflineCleanup } from './controller-offline-cleanup.js';

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
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							audience: 'gateway',
							envVar: 'OPENCLAW_GATEWAY_TOKEN',
							injection: 'env',
							source: 'environment',
						},
					},
					websocketBypass: [],
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

describe('runControllerOfflineCleanup', () => {
	it('refuses to clean up while the configured controller is reachable', async () => {
		const cleanupOrphanedGatewayIfPresent = vi.fn();

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					assertControllerUnavailableForOfflineCleanup: async () => {
						throw new Error('controller is reachable');
					},
					cleanupOrphanedGatewayIfPresent,
				},
			),
		).rejects.toThrow(/controller is reachable/u);

		expect(cleanupOrphanedGatewayIfPresent).not.toHaveBeenCalled();
	});

	it('refuses cleanup when controller reachability is ambiguous', async () => {
		const cleanupOrphanedGatewayIfPresent = vi.fn();

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
					cleanupOrphanedGatewayIfPresent,
				},
			),
		).rejects.toThrow(/health probe timed out/u);

		expect(cleanupOrphanedGatewayIfPresent).not.toHaveBeenCalled();
	});

	it('refuses cleanup when the controller health endpoint returns an HTTP response', async () => {
		const cleanupOrphanedGatewayIfPresent = vi.fn();
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
						{ cleanupOrphanedGatewayIfPresent },
					),
				).rejects.toThrow(/HTTP 503/u);
			},
		);

		expect(cleanupOrphanedGatewayIfPresent).not.toHaveBeenCalled();
	});

	it('allows cleanup when the controller port refuses connections', async () => {
		const controllerPort = await findClosedLocalPort();
		const cleanupOrphanedGatewayIfPresent = vi.fn(async () => ({
			cleanedUp: true,
			killedPid: null,
		}));

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig({ controllerPort }),
					zoneId: 'beta',
				},
				{ cleanupOrphanedGatewayIfPresent },
			),
		).resolves.toEqual({
			results: [
				{
					cleanedUp: true,
					killedPid: null,
					stateDir: '/state/beta',
					zoneId: 'beta',
				},
			],
		});
	});

	it('allows forced cleanup even while the configured controller is reachable', async () => {
		const cleanupOrphanedGatewayIfPresent = vi.fn(async () => ({
			cleanedUp: true,
			killedPid: 48282,
		}));

		await expect(
			runControllerOfflineCleanup(
				{
					force: true,
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					assertControllerUnavailableForOfflineCleanup: async () => {
						throw new Error('should not probe when forced');
					},
					cleanupOrphanedGatewayIfPresent,
				},
			),
		).resolves.toEqual({
			results: [
				{
					cleanedUp: true,
					killedPid: 48282,
					stateDir: '/state/beta',
					zoneId: 'beta',
				},
			],
		});
	});

	it('cleans only the requested zone from the selected installation config', async () => {
		const cleanupOrphanedToolVmsIfPresent = vi.fn(async () => ({
			cleanedCount: 0,
			killedPids: [],
			quarantinedCount: 0,
			warnings: [],
		}));
		const cleanupOrphanedGatewayIfPresent = vi.fn(async () => ({
			cleanedUp: true,
			killedPid: 48282,
		}));

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					assertControllerUnavailableForOfflineCleanup: async () => {},
					cleanupOrphanedGatewayIfPresent,
					cleanupOrphanedToolVmsIfPresent,
				},
			),
		).resolves.toEqual({
			results: [
				{
					cleanedUp: true,
					killedPid: 48282,
					stateDir: '/state/beta',
					zoneId: 'beta',
				},
			],
		});

		expect(cleanupOrphanedToolVmsIfPresent).toHaveBeenCalledWith({
			expectedConfigPath: '/deployments/shravan-claw-beta/config/system.jsonc',
			expectedControllerPort: 18900,
			mode: 'offline-cleanup',
			projectNamespace: 'shravan-claw-beta-25319b68',
			stateDir: '/state/beta',
			tcpBasePort: 19000,
			zoneId: 'beta',
		});
		expect(cleanupOrphanedGatewayIfPresent).toHaveBeenCalledWith({
			mode: 'offline-cleanup',
			projectNamespace: 'shravan-claw-beta-25319b68',
			stateDir: '/state/beta',
			zoneId: 'beta',
		});
		expect(cleanupOrphanedToolVmsIfPresent.mock.invocationCallOrder[0]).toBeLessThan(
			cleanupOrphanedGatewayIfPresent.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it('preserves cleanup warnings in the per-zone result', async () => {
		const cleanupOrphanedGatewayIfPresent = vi.fn(async () => ({
			cleanedUp: false,
			cleanupWarning: 'failed to remove stale runtime record',
			killedPid: 48282,
		}));

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					assertControllerUnavailableForOfflineCleanup: async () => {},
					cleanupOrphanedGatewayIfPresent,
				},
			),
		).resolves.toEqual({
			results: [
				{
					cleanedUp: false,
					cleanupWarning: 'failed to remove stale runtime record',
					killedPid: 48282,
					stateDir: '/state/beta',
					zoneId: 'beta',
				},
			],
		});
	});

	it('rejects an unknown zone before touching runtime records', async () => {
		const cleanupOrphanedGatewayIfPresent = vi.fn();

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig(),
					zoneId: 'sunfam',
				},
				{
					assertControllerUnavailableForOfflineCleanup: async () => {},
					cleanupOrphanedGatewayIfPresent,
				},
			),
		).rejects.toThrow(/Unknown zone 'sunfam'/u);

		expect(cleanupOrphanedGatewayIfPresent).not.toHaveBeenCalled();
	});
});
