import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createLoadedSystemConfig, type LoadedSystemConfig } from '../config/system-config.js';
import { ControllerOwnershipLockError } from '../controller/vm-ownership/controller-ownership-lock.js';
import { runControllerOfflineCleanup as runControllerOfflineCleanupProduction } from './controller-offline-cleanup.js';

function createSystemConfig(
	options: {
		readonly controllerPort?: number;
		readonly gatewayType?: 'openclaw' | 'worker';
	} = {},
): LoadedSystemConfig {
	const zone =
		options.gatewayType === 'worker'
			? {
					egressHosts: [{ audience: 'gateway' as const, host: 'api.openai.com' }],
					gateway: {
						config: '/deployments/shravan-claw-beta/config/gateways/beta/worker.json',
						cpus: 2,
						imageProfile: 'worker',
						memory: '4G',
						port: 18891,
						stateDir: '/state/beta',
						type: 'worker' as const,
					},
					id: 'beta',
					secrets: {},
				}
			: {
					agentToolVmProfiles: {},
					agents: [{ id: 'main' }],
					defaultToolVmProfile: 'default',
					egressHosts: [{ audience: 'gateway' as const, host: 'api.openai.com' }],
					gateway: {
						controlAuth: {
							mode: 'token' as const,
							secret: 'OPENCLAW_GATEWAY_TOKEN',
						},
						config: '/deployments/shravan-claw-beta/config/gateways/beta/openclaw.json',
						cpus: 2,
						imageProfile: 'openclaw',
						memory: '4G',
						port: 18891,
						stateDir: '/state/beta',
						type: 'openclaw' as const,
						zoneFilesDir: '/zone-files/beta',
					},
					id: 'beta',
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							audience: 'gateway' as const,
							envVar: 'OPENCLAW_GATEWAY_TOKEN',
							injection: 'env' as const,
							source: 'environment' as const,
						},
					},
				};
	return createLoadedSystemConfig(
		{
			schemaVersion: 1,
			cacheDir: '/cache',
			controllerStateDir: '/controller-state-test',
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
					worker: {
						type: 'worker',
						buildConfig: './vm-images/gateways/worker/build-config.jsonc',
						source: { kind: 'managedBase', base: 'worker-gateway' },
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
			zones: [zone],
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
	dependencies: Omit<
		Parameters<typeof runControllerOfflineCleanupProduction>[1],
		'exactProcessTermination'
	> &
		Partial<
			Pick<Parameters<typeof runControllerOfflineCleanupProduction>[1], 'exactProcessTermination'>
		> = {},
): ReturnType<typeof runControllerOfflineCleanupProduction> {
	return runControllerOfflineCleanupProduction(options, {
		acquireControllerOwnershipLock: async () => ({ release: async () => {} }),
		exactProcessTermination: {
			terminateRecordedHostProcess: async ({ identity }) => ({
				hostProcessId: identity.hostProcessId,
				kind: 'already-absent',
			}),
		},
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
		const cleanupRecordedVmTree = vi.fn(async () => {
			operationOrder.push('cleanup-records');
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
					cleanupRecordedVmTree,
				},
			),
		).rejects.toThrow(/controller is reachable/u);

		expect(cleanupRecordedVmTree).not.toHaveBeenCalled();
		expect(operationOrder).toEqual(['acquire-lock', 'probe-controller', 'release-lock']);
		expect(release).toHaveBeenCalledOnce();
	});

	it('does not probe or clean records when the deployment ownership lock is held', async () => {
		const lockConflict = new ControllerOwnershipLockError('controller-already-active');
		const assertControllerUnavailableForOfflineCleanup = vi.fn(async () => {});
		const cleanupRecordedVmTree = vi.fn(async () => {});

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
					cleanupRecordedVmTree,
				},
			),
		).rejects.toBe(lockConflict);

		expect(assertControllerUnavailableForOfflineCleanup).not.toHaveBeenCalled();
		expect(cleanupRecordedVmTree).not.toHaveBeenCalled();
	});

	it('refuses cleanup when controller reachability is ambiguous', async () => {
		const cleanupRecordedVmTree = vi.fn(async () => {});

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
					cleanupRecordedVmTree,
				},
			),
		).rejects.toThrow(/health probe timed out/u);

		expect(cleanupRecordedVmTree).not.toHaveBeenCalled();
	});

	it('refuses cleanup when the controller health endpoint returns an HTTP response', async () => {
		const cleanupRecordedVmTree = vi.fn(async () => {});
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
						{ cleanupRecordedVmTree },
					),
				).rejects.toThrow(/HTTP 503/u);
			},
		);

		expect(cleanupRecordedVmTree).not.toHaveBeenCalled();
	});

	it('allows cleanup when the controller port refuses connections', async () => {
		const controllerPort = await findClosedLocalPort();
		const cleanupRecordedVmTree = vi.fn(async () => {});

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig({ controllerPort }),
					zoneId: 'beta',
				},
				{ cleanupRecordedVmTree },
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
		expect(cleanupRecordedVmTree).toHaveBeenCalledOnce();
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
		const cleanupRecordedVmTree = vi.fn(async () => {
			operationOrder.push('cleanup-records');
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
					cleanupRecordedVmTree,
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
		expect(cleanupRecordedVmTree).toHaveBeenCalledOnce();
		expect(acquireControllerOwnershipLock).toHaveBeenCalledWith({
			runtimeDirectory: '/runtime',
		});
		expect(operationOrder).toEqual(['acquire-lock', 'cleanup-records', 'release-lock']);
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
		const cleanupRecordedVmTree = vi.fn(async () => {
			operationOrder.push('cleanup-records');
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
					cleanupRecordedVmTree,
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

		expect(cleanupRecordedVmTree).toHaveBeenCalledOnce();
		expect(cleanupRecordedVmTree).toHaveBeenCalledWith({
			controllerStateRoot: { directoryPath: '/controller-state-test' },
			systemConfig,
			zoneId: 'beta',
		});
		expect(operationOrder).toEqual([
			'acquire-lock',
			'probe-controller',
			'cleanup-records',
			'release-lock',
		]);
	});

	it('cleans recorded Tool VM runners before the recorded Gateway runner', async () => {
		const systemConfig = createSystemConfig();
		const operationOrder: string[] = [];
		const scanGatewayStateAuthorityEvidence = vi.fn(async () => {
			operationOrder.push('scan-legacy-evidence');
			return [];
		});
		const cleanupRecordedToolVmRuntimes = vi.fn(async () => {
			operationOrder.push('cleanup-tools');
			return { cleanedCount: 2, killedPids: [31, 32], quarantinedCount: 0, warnings: [] };
		});
		const cleanupRecordedGatewayRuntime = vi.fn(async () => {
			operationOrder.push('cleanup-gateway');
			return { cleanedUp: true, killedPid: 30 };
		});

		await expect(
			runControllerOfflineCleanup(
				{
					force: true,
					systemConfig,
					zoneId: 'beta',
				},
				{
					cleanupRecordedGatewayRuntime,
					cleanupRecordedToolVmRuntimes,
					scanGatewayStateAuthorityEvidence,
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

		expect(operationOrder).toEqual(['scan-legacy-evidence', 'cleanup-tools', 'cleanup-gateway']);
		expect(scanGatewayStateAuthorityEvidence).toHaveBeenCalledWith({
			gatewayStateDirectoryPath: '/state/beta',
		});
		expect(cleanupRecordedToolVmRuntimes).toHaveBeenCalledWith(
			{
				expectedConfigPath: systemConfig.systemConfigPath,
				expectedControllerPort: systemConfig.host.controllerPort,
				mode: 'offline-cleanup',
				projectNamespace: systemConfig.host.projectNamespace,
				recordsTarget: {
					directoryPath: '/controller-state-test/zones/beta/tool-leases',
					kind: 'controller-tool-lease-records',
					zoneId: 'beta',
				},
				tcpBasePort: systemConfig.tcpPool.basePort,
			},
			expect.objectContaining({ exactProcessTermination: expect.anything() }),
		);
		expect(cleanupRecordedGatewayRuntime).toHaveBeenCalledWith(
			{
				configuredIngressPort: 18891,
				expectedConfigPath: systemConfig.systemConfigPath,
				expectedControllerPort: systemConfig.host.controllerPort,
				mode: 'offline-cleanup',
				projectNamespace: systemConfig.host.projectNamespace,
				runtimeRecordTarget: {
					filePath: '/controller-state-test/zones/beta/gateway-runtime.json',
					kind: 'controller-managed-gateway-runtime-record',
					zoneId: 'beta',
				},
				zoneId: 'beta',
			},
			expect.objectContaining({ exactProcessTermination: expect.anything() }),
		);
	});

	it('reconciles Worker records from controller state without managed Gateway or Tool cleanup', async () => {
		const systemConfig = createSystemConfig({ gatewayType: 'worker' });
		const cleanupRecordedWorkerRuntimes = vi.fn(async () => ({
			cleanedCount: 2,
			killedPids: [41, 42],
		}));
		const cleanupRecordedToolVmRuntimes = vi.fn(async () => ({
			cleanedCount: 0,
			killedPids: [],
			quarantinedCount: 0,
			warnings: [],
		}));
		const cleanupRecordedGatewayRuntime = vi.fn(async () => ({
			cleanedUp: true,
			killedPid: 40,
		}));
		const scanGatewayStateAuthorityEvidence = vi.fn(async () => []);

		await expect(
			runControllerOfflineCleanup(
				{
					force: true,
					systemConfig,
					zoneId: 'beta',
				},
				{
					cleanupRecordedGatewayRuntime,
					cleanupRecordedToolVmRuntimes,
					cleanupRecordedWorkerRuntimes,
					scanGatewayStateAuthorityEvidence,
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

		expect(scanGatewayStateAuthorityEvidence).toHaveBeenCalledWith({
			gatewayStateDirectoryPath: '/state/beta',
		});
		expect(cleanupRecordedWorkerRuntimes).toHaveBeenCalledWith(
			{
				expectedConfigPath: systemConfig.systemConfigPath,
				expectedControllerPort: systemConfig.host.controllerPort,
				gatewayStateRoot: {
					directoryPath: '/controller-state-test/zones/beta',
					zoneId: 'beta',
				},
				mode: 'offline-cleanup',
				projectNamespace: systemConfig.host.projectNamespace,
			},
			expect.objectContaining({ exactProcessTermination: expect.anything() }),
		);
		expect(cleanupRecordedToolVmRuntimes).not.toHaveBeenCalled();
		expect(cleanupRecordedGatewayRuntime).not.toHaveBeenCalled();
	});

	it('fails closed on legacy Gateway-state evidence before mutating controller records', async () => {
		const cleanupRecordedToolVmRuntimes = vi.fn(async () => ({
			cleanedCount: 0,
			killedPids: [],
			quarantinedCount: 0,
			warnings: [],
		}));
		const cleanupRecordedGatewayRuntime = vi.fn(async () => ({
			cleanedUp: true,
			killedPid: 30,
		}));
		const scanGatewayStateAuthorityEvidence = vi.fn(async () => [
			{
				absolutePath: '/state/beta/gateway-runtime.json',
				family: 'gateway-runtime' as const,
				kind: 'file' as const,
			},
		]);

		await expect(
			runControllerOfflineCleanup(
				{
					force: true,
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					cleanupRecordedGatewayRuntime,
					cleanupRecordedToolVmRuntimes,
					scanGatewayStateAuthorityEvidence,
				},
			),
		).rejects.toThrow(
			/Legacy controller record evidence exists under Gateway state.*gateway-runtime:file:\/state\/beta\/gateway-runtime\.json/u,
		);

		expect(scanGatewayStateAuthorityEvidence).toHaveBeenCalledWith({
			gatewayStateDirectoryPath: '/state/beta',
		});
		expect(cleanupRecordedToolVmRuntimes).not.toHaveBeenCalled();
		expect(cleanupRecordedGatewayRuntime).not.toHaveBeenCalled();
	});

	it('preserves the Gateway record when Tool VM cleanup fails closed', async () => {
		const identityMismatch = new Error('recorded Tool VM process identity changed');
		const cleanupRecordedGatewayRuntime = vi.fn(async () => ({
			cleanedUp: true,
			killedPid: 30,
		}));

		await expect(
			runControllerOfflineCleanup(
				{
					force: true,
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					cleanupRecordedGatewayRuntime,
					cleanupRecordedToolVmRuntimes: vi.fn(async () => {
						throw identityMismatch;
					}),
				},
			),
		).rejects.toBe(identityMismatch);

		expect(cleanupRecordedGatewayRuntime).not.toHaveBeenCalled();
	});

	it('does not report completion when a Tool VM runtime record could not be deleted', async () => {
		const cleanupRecordedGatewayRuntime = vi.fn(async () => ({
			cleanedUp: true,
			killedPid: 30,
		}));

		await expect(
			runControllerOfflineCleanup(
				{
					force: true,
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					cleanupRecordedGatewayRuntime,
					cleanupRecordedToolVmRuntimes: vi.fn(async () => ({
						cleanedCount: 0,
						killedPids: [31],
						quarantinedCount: 0,
						warnings: ['runtime record deletion failed'],
					})),
				},
			),
		).rejects.toThrow(/runtime record deletion failed/u);

		expect(cleanupRecordedGatewayRuntime).not.toHaveBeenCalled();
	});

	it('does not report completion when the Gateway runtime record could not be deleted', async () => {
		await expect(
			runControllerOfflineCleanup(
				{
					force: true,
					systemConfig: createSystemConfig(),
					zoneId: 'beta',
				},
				{
					cleanupRecordedGatewayRuntime: vi.fn(async () => ({
						cleanedUp: false,
						cleanupWarning: 'gateway runtime record deletion failed',
						killedPid: 30,
					})),
					cleanupRecordedToolVmRuntimes: vi.fn(async () => ({
						cleanedCount: 0,
						killedPids: [],
						quarantinedCount: 0,
						warnings: [],
					})),
				},
			),
		).rejects.toThrow(/gateway runtime record deletion failed/u);
	});

	it('propagates owner-unsafe recorded-process cleanup without a success result', async () => {
		const ownershipError = Object.assign(
			new Error('recorded VM process cleanup refused owner-unsafe evidence'),
			{ code: 'owner-unsafe' as const },
		);
		const cleanupRecordedVmTree = vi.fn(async () => {
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
					cleanupRecordedVmTree,
				},
			),
		).rejects.toBe(ownershipError);

		expect(cleanupRecordedVmTree).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
	});

	it('rejects an unknown zone before touching runtime records', async () => {
		const acquireControllerOwnershipLock = vi.fn(async () => ({
			release: async () => {},
		}));
		const cleanupRecordedVmTree = vi.fn(async () => {});

		await expect(
			runControllerOfflineCleanup(
				{
					systemConfig: createSystemConfig(),
					zoneId: 'sunfam',
				},
				{
					acquireControllerOwnershipLock,
					assertControllerUnavailableForOfflineCleanup: async () => {},
					cleanupRecordedVmTree,
				},
			),
		).rejects.toThrow(/Unknown zone 'sunfam'/u);

		expect(acquireControllerOwnershipLock).not.toHaveBeenCalled();
		expect(cleanupRecordedVmTree).not.toHaveBeenCalled();
	});
});
