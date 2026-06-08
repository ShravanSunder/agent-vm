import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { SecretResolver } from '@agent-vm/secret-management';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig, SystemConfig } from '../../config/system-config.js';
import { GatewayOwnershipUnsafeError } from '../../gateway/gateway-ownership-evidence.js';
import type { GatewayZone, GatewayZoneStartResult } from '../../gateway/gateway-zone-support.js';
import {
	createManagedExecProcessStub,
	createManagedVmFsStub,
} from '../../testing/managed-vm-test-helpers.js';
import type { GatewayLifecycleOperationRecord } from './gateway-lifecycle-operation-record.js';
import { createOpenClawZoneRuntime } from './openclaw-zone-runtime.js';

const openClawZoneRuntimeTestRoot = path.join(
	tmpdir(),
	`agent-vm-openclaw-zone-runtime-test-${process.pid}`,
);

const systemConfig = {
	schemaVersion: 1,
	cacheDir: path.join(openClawZoneRuntimeTestRoot, 'cache'),
	runtimeDir: path.join(openClawZoneRuntimeTestRoot, 'runtime'),
	host: {
		controllerPort: 18800,
		projectNamespace: 'gateway-runtime-tests',
	},
	imageProfiles: {
		gateways: {
			openclaw: { type: 'openclaw', buildConfig: './gateway.json' },
		},
		toolVms: {
			standard: { type: 'toolVm', buildConfig: './tool.json' },
		},
	},
	zones: [
		{
			id: 'shravan',
			gateway: {
				type: 'openclaw',
				controlAuth: {
					mode: 'token',
					secret: 'OPENCLAW_GATEWAY_TOKEN',
				},
				imageProfile: 'openclaw',
				memory: '2G',
				cpus: 2,
				port: 18791,
				config: './shravan/openclaw.json',
				stateDir: path.join(openClawZoneRuntimeTestRoot, 'state', 'shravan'),
				zoneFilesDir: path.join(openClawZoneRuntimeTestRoot, 'zone-files', 'shravan'),
			},
			secrets: {
				OPENCLAW_GATEWAY_TOKEN: {
					source: 'environment',
					envVar: 'OPENCLAW_GATEWAY_TOKEN',
					injection: 'env',
					audience: 'gateway',
				},
			},
			egressHosts: [],
			websocketBypass: [],
			defaultToolVmProfile: 'standard',
			agentToolVmProfiles: {},
		},
	],
	tcpPool: { basePort: 19000, size: 5 },
	toolVmProfiles: {
		standard: {
			cpus: 1,
			imageProfile: 'standard',
			memory: '1G',
		},
	},
} satisfies SystemConfig;

const loadedSystemConfig = {
	...systemConfig,
	systemConfigPath: path.join(openClawZoneRuntimeTestRoot, 'config', 'system.json'),
} satisfies LoadedSystemConfig;

afterEach(async () => {
	await rm(openClawZoneRuntimeTestRoot, { force: true, recursive: true });
});

function isPathInsideDirectory(candidatePath: string, directoryPath: string): boolean {
	const relativePath = path.relative(path.resolve(directoryPath), path.resolve(candidatePath));
	return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function getOpenClawZone(): GatewayZone & {
	readonly gateway: Extract<GatewayZone['gateway'], { readonly type: 'openclaw' }>;
} {
	const zone = systemConfig.zones.find((candidateZone) => candidateZone.id === 'shravan');
	if (zone?.gateway.type !== 'openclaw') {
		throw new Error('Expected shravan OpenClaw test zone.');
	}
	return zone;
}

describe('OpenClaw zone runtime test fixture paths', () => {
	it('keeps generated lifecycle records outside the repository checkout', () => {
		const generatedPaths = [
			systemConfig.cacheDir,
			systemConfig.runtimeDir,
			getOpenClawZone().gateway.stateDir,
			getOpenClawZone().gateway.zoneFilesDir,
		];

		expect(
			generatedPaths.filter((generatedPath) =>
				isPathInsideDirectory(path.resolve(generatedPath), process.cwd()),
			),
		).toEqual([]);
	});
});

describe('createOpenClawZoneRuntime host process liveness', () => {
	it('normalizes managed VM exec processes into command results', async () => {
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
					exec: vi.fn(() =>
						createManagedExecProcessStub({
							exitCode: 7,
							stderr: 'command stderr',
							stdout: 'command stdout',
						}),
					),
					fs: createManagedVmFsStub(),
					getHostPid: () => 48_284,
					getVmInstance: vi.fn(),
					id: 'gateway-vm-exec-normalized',
					setIngressRoutes: vi.fn(),
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();

		await expect(runtime.exec('echo hello')).resolves.toEqual({
			exitCode: 7,
			stderr: 'command stderr',
			stdout: 'command stdout',
		});
	});

	it('does not project a started gateway as running when its host pid is missing', async () => {
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					fs: createManagedVmFsStub(),
					getHostPid: () => null,
					getVmInstance: vi.fn(),
					id: 'gateway-vm-missing-pid',
					setIngressRoutes: vi.fn(),
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();

		expect(runtime.getSnapshot()).toEqual({
			lastError: "vm-process-missing: Gateway VM host pid is unavailable for zone 'shravan'.",
			lifecycleState: 'failed',
		});
	});

	it('classifies a started gateway as vm-process-missing when its host pid is dead', async () => {
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => false,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					fs: createManagedVmFsStub(),
					getHostPid: () => 48_284,
					getVmInstance: vi.fn(),
					id: 'gateway-vm-dead-pid',
					setIngressRoutes: vi.fn(),
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();

		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'vm-process-missing' },
			kind: 'failed',
		});
		expect(runtime.getSnapshot()).toEqual({
			lastError: "vm-process-missing: Gateway VM host pid 48284 is not alive for zone 'shravan'.",
			lifecycleState: 'failed',
		});
	});

	it('projects gateway ownership preflight failures as owner-unsafe', async () => {
		const ownershipError = new GatewayOwnershipUnsafeError({
			evidence: {
				kind: 'missing-record-port-owned',
				ownerCommand: 'qemu-system-aarch64 -m 4G',
				ownerPid: 98_765,
				port: 18_791,
			},
			message:
				'Gateway runtime record is missing but configured ingress port 18791 is owned by pid 98765.',
		});
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				throw ownershipError;
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.start()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'owner-unsafe',
		});

		expect(runtime.getLifecycleState()).toEqual({
			evidence: ownershipError.evidence,
			kind: 'owner-unsafe',
		});
		expect(runtime.getSnapshot()).toEqual({
			lastError: ownershipError.message,
			lifecycleState: 'failed',
		});
	});
});

describe('createOpenClawZoneRuntime credentials refresh', () => {
	it('keeps a running gateway active when refresh secret preflight fails', async () => {
		const closeGatewayVm = vi.fn(async () => {});
		const runtime = createOpenClawZoneRuntime({
			createFreshSecretResolver: vi.fn(async () => ({
				resolve: async () => {
					throw new Error('fresh resolver should not resolve single secrets');
				},
				resolveAll: async () => {
					throw new Error('1Password SDK resolveAll failed');
				},
			})),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: closeGatewayVm,
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					fs: createManagedVmFsStub(),
					getHostPid: () => 48_284,
					getVmInstance: vi.fn(),
					id: 'gateway-vm-live-before-refresh',
					setIngressRoutes: vi.fn(),
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});
		await runtime.start();

		await expect(runtime.refreshCredentials()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'secret-resolution-failed',
		});

		expect(closeGatewayVm).not.toHaveBeenCalled();
		expect(runtime.getLifecycleState()).toMatchObject({
			gateway: expect.objectContaining({
				vm: expect.objectContaining({ id: 'gateway-vm-live-before-refresh' }),
			}),
			kind: 'running',
		});
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-live-before-refresh' } },
			lastError: expect.stringContaining('1Password SDK resolveAll failed'),
			lifecycleState: 'running',
		});
	});

	it('resolves gateway secrets and restarts with a fresh controller-side resolver', async () => {
		const staleResolveAll = vi.fn(async () => {
			throw new Error('stale resolver should not resolve during credentials refresh');
		});
		const freshResolveAll = vi.fn(async (refs: Parameters<SecretResolver['resolveAll']>[0]) =>
			Object.fromEntries(
				Object.keys(refs).map((secretName) => [secretName, `fresh:${secretName}`]),
			),
		);
		const staleResolver: SecretResolver = {
			resolve: async () => {
				throw new Error('stale resolver should not resolve during credentials refresh');
			},
			resolveAll: staleResolveAll,
		};
		const freshResolver: SecretResolver = {
			resolve: async () => 'fresh-single-secret',
			resolveAll: freshResolveAll,
		};
		const restartResolverRefs: unknown[] = [];
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			createFreshSecretResolver: vi.fn(async () => freshResolver),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async (_zoneId, startOptions) => {
				if (!startOptions?.secretResolver) {
					throw new Error('restart did not receive a fresh resolver');
				}
				restartResolverRefs.push(
					await startOptions.secretResolver.resolveAll({
						OPENCLAW_GATEWAY_TOKEN: {
							ref: 'OPENCLAW_GATEWAY_TOKEN',
							source: 'environment',
						},
					}),
				);
				return {
					image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close: vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						fs: createManagedVmFsStub(),
						getHostPid: () => 48_284,
						getVmInstance: vi.fn(),
						id: 'gateway-vm-fresh-resolver',
						setIngressRoutes: vi.fn(),
					},
					zone: getOpenClawZone(),
				};
			},
			secretResolver: staleResolver,
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.refreshCredentials()).resolves.toEqual({ ok: true, zoneId: 'shravan' });

		expect(staleResolveAll).not.toHaveBeenCalled();
		expect(freshResolveAll).toHaveBeenCalledTimes(2);
		expect(restartResolverRefs).toEqual([
			{ OPENCLAW_GATEWAY_TOKEN: 'fresh:OPENCLAW_GATEWAY_TOKEN' },
		]);
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-fresh-resolver' } },
			lifecycleState: 'running',
		});
		expect(operationRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'credentials-refresh-requested',
					operationTrigger: 'credentials-refresh',
				}),
				expect.objectContaining({
					kind: 'cold-start-requested',
					operationTrigger: 'credentials-refresh',
				}),
			]),
		);
		const refreshOperationId = operationRecords.find(
			(record) => record.kind === 'credentials-refresh-requested',
		)?.operationId;
		expect(
			operationRecords.filter((record) => record.operationId === refreshOperationId).length,
		).toBeGreaterThanOrEqual(2);
	});

	it('records credentials-refresh operation failure when fresh resolver construction fails', async () => {
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			createFreshSecretResolver: vi.fn(async () => {
				throw new Error('1Password SDK failed to create client');
			}),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				throw new Error('start should not run');
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.refreshCredentials()).rejects.toThrow('1Password SDK failed');

		const refreshRequested = operationRecords.find(
			(record) => record.kind === 'credentials-refresh-requested',
		);
		expect(refreshRequested).toMatchObject({
			kind: 'credentials-refresh-requested',
			operationTrigger: 'credentials-refresh',
		});
		expect(operationRecords).toContainEqual(
			expect.objectContaining({
				errorCode: 'secret-resolution-failed',
				kind: 'operation-failed',
				operationId: refreshRequested?.operationId,
				operationTrigger: 'credentials-refresh',
			}),
		);
	});

	it('keeps a live gateway running when credentials-refresh resolver construction fails', async () => {
		const closeGatewayVm = vi.fn(async () => {});
		const runtime = createOpenClawZoneRuntime({
			createFreshSecretResolver: async () => {
				throw new Error('1Password SDK failed');
			},
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: closeGatewayVm,
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					fs: createManagedVmFsStub(),
					getHostPid: () => 48_284,
					getVmInstance: vi.fn(),
					id: 'gateway-vm-live-refresh-preflight',
					setIngressRoutes: vi.fn(),
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();

		await expect(runtime.refreshCredentials()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'secret-resolution-failed',
		});

		expect(closeGatewayVm).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-live-refresh-preflight' } },
			lastError: '1Password SDK failed',
			lifecycleState: 'running',
		});
		expect(runtime.getDiagnosis()).toMatchObject({
			currentRecoveryBlocker: 'none',
			originalOutageCause: { kind: 'unknown' },
			selectedZoneReadiness: 'running',
		});
	});

	it('records credentials-refresh operation failure when fresh resolver cannot resolve zone secrets', async () => {
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			createFreshSecretResolver: vi.fn(async () => ({
				resolve: async () => '',
				resolveAll: async () => {
					throw new Error('1Password SDK resolveAll failed: op failed');
				},
			})),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				throw new Error('start should not run');
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.refreshCredentials()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'secret-resolution-failed',
		});

		const refreshRequested = operationRecords.find(
			(record) => record.kind === 'credentials-refresh-requested',
		);
		expect(refreshRequested).toMatchObject({
			kind: 'credentials-refresh-requested',
			operationTrigger: 'credentials-refresh',
		});
		expect(operationRecords).toContainEqual(
			expect.objectContaining({
				errorCode: 'secret-resolution-failed',
				kind: 'operation-failed',
				operationId: refreshRequested?.operationId,
				operationTrigger: 'credentials-refresh',
			}),
		);
		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'secret-resolution-failed' },
			kind: 'failed',
		});
	});

	it('does not overwrite a proven VM-process outage with a later secret refresh blocker', async () => {
		const runtime = createOpenClawZoneRuntime({
			createFreshSecretResolver: vi.fn(async () => ({
				resolve: async () => '',
				resolveAll: async () => {
					throw new Error('1Password SDK resolveAll failed: op failed');
				},
			})),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => false,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					fs: createManagedVmFsStub(),
					getHostPid: () => 48_284,
					getVmInstance: vi.fn(),
					id: 'gateway-vm-dead-before-refresh',
					setIngressRoutes: vi.fn(),
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'vm-process-missing' },
			kind: 'failed',
		});

		await expect(runtime.refreshCredentials()).rejects.toMatchObject({
			gatewayLifecycleErrorCode: 'secret-resolution-failed',
		});

		expect(runtime.getDiagnosis()).toMatchObject({
			currentRecoveryBlocker: 'secret-resolution-failed',
			originalOutageCause: {
				errorCode: 'vm-process-missing',
				eventKind: 'gateway-lifecycle-operation',
				kind: 'proven',
			},
		});
	});
});

describe('createOpenClawZoneRuntime cold-start recovery', () => {
	it('starts a failed gateway without deleting the runtime record before ownership preflight', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const restartGatewayZone = vi
			.fn()
			.mockRejectedValueOnce(new Error("Failed to resolve zone secrets for zone 'shravan'."))
			.mockResolvedValueOnce({
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					fs: createManagedVmFsStub(),
					getHostPid: () => 48_284,
					getVmInstance: vi.fn(),
					id: 'gateway-vm-cold-start',
					setIngressRoutes: vi.fn(),
				},
				zone: getOpenClawZone(),
			});
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone,
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.start()).rejects.toThrow('Failed to start zone');
		const coldStartResult = await runtime.coldStart();
		expect(coldStartResult).toMatchObject({ leaseReleaseFailureCount: 0 });
		expect(coldStartResult.operationId).toMatch(/^shravan-cold-start-/u);

		expect(restartGatewayZone).toHaveBeenCalledTimes(2);
		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-cold-start' } },
			lifecycleState: 'running',
		});
	});
});

describe('createOpenClawZoneRuntime stop and restart safety', () => {
	it('exposes stopping state and blocks gateway commands while stop is pending', async () => {
		const closeDeferred = createDeferredPromise<void>();
		const gatewayExec = vi.fn(() => createManagedExecProcessStub({ stdout: 'unexpected' }));
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: vi.fn(async () => await closeDeferred.promise),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
					exec: gatewayExec,
					fs: createManagedVmFsStub(),
					getHostPid: () => 48_284,
					getVmInstance: vi.fn(),
					id: 'gateway-vm-stopping',
					setIngressRoutes: vi.fn(),
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const stopPromise = runtime.stop();
		await vi.waitFor(() => {
			expect(runtime.getLifecycleState()).toMatchObject({
				kind: 'stopping',
				next: 'stopped',
				previousGateway: { vm: { id: 'gateway-vm-stopping' } },
			});
		});

		await expect(runtime.exec('echo should-not-run')).rejects.toThrow(
			"Gateway runtime for zone 'shravan' is unavailable.",
		);
		expect(gatewayExec).not.toHaveBeenCalled();

		closeDeferred.resolve();
		await expect(stopPromise).resolves.toBeUndefined();
		expect(runtime.getLifecycleState()).toEqual({ kind: 'stopped' });
	});

	it('classifies a stop failure as owner-unsafe failed instead of remaining stuck in stopping', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const closeGateway = vi.fn(async () => {
			throw new Error('gateway close timed out');
		});
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: closeGateway,
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					fs: createManagedVmFsStub(),
					getHostPid: () => 48_284,
					getVmInstance: vi.fn(),
					id: 'gateway-vm-retained-after-stop-failure',
					setIngressRoutes: vi.fn(),
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.stop()).rejects.toThrow('gateway close timed out');

		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
		expect(runtime.getLifecycleState()).toEqual({
			coldStartEligible: false,
			error: {
				code: 'owner-unsafe',
				message: 'gateway close timed out',
			},
			kind: 'failed',
		});
		expect(runtime.getSnapshot()).toEqual({
			lastError: 'gateway close timed out',
			lifecycleState: 'failed',
		});
	});

	it('rejects normal gateway access while restart is closing the old gateway', async () => {
		let gatewayStartCount = 0;
		const oldGatewayCloseDeferred = createDeferredPromise<void>();
		const oldGatewayExec = vi.fn(() => createManagedExecProcessStub({ stdout: 'unexpected' }));
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				return {
					image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close:
							gatewayStartCount === 1
								? vi.fn(async () => await oldGatewayCloseDeferred.promise)
								: vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
						exec:
							gatewayStartCount === 1
								? oldGatewayExec
								: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						fs: createManagedVmFsStub(),
						getHostPid: () => 48_284 + gatewayStartCount,
						getVmInstance: vi.fn(),
						id: `gateway-vm-${String(gatewayStartCount)}`,
						setIngressRoutes: vi.fn(),
					},
					zone: getOpenClawZone(),
				};
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart();
		await vi.waitFor(() => {
			expect(runtime.getLifecycleState()).toMatchObject({
				kind: 'stopping',
				next: 'starting',
				previousGateway: { vm: { id: 'gateway-vm-1' } },
			});
		});

		await expect(runtime.exec('date')).rejects.toThrow(
			"Gateway runtime for zone 'shravan' is unavailable.",
		);
		expect(oldGatewayExec).not.toHaveBeenCalled();

		oldGatewayCloseDeferred.resolve();
		const restartResult = await restartPromise;
		expect(restartResult).toMatchObject({ leaseReleaseFailureCount: 0 });
		expect(restartResult.operationId).toBe(
			operationRecords.find((record) => record.kind === 'restart-requested')?.operationId,
		);
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-2' } },
			lifecycleState: 'running',
		});
	});

	it('records stale-generation-closed when a timed-out restart later starts a stale gateway', async () => {
		let gatewayStartCount = 0;
		let resolveStaleGatewayStart: ((value: GatewayZoneStartResult) => void) | undefined;
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const staleGatewayClose = vi.fn(async () => {});
		const restartTimeoutCallbacks: (() => void)[] = [];
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const gatewayStartResult: GatewayZoneStartResult = {
					image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close: gatewayStartCount === 2 ? staleGatewayClose : vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						fs: createManagedVmFsStub(),
						getHostPid: () => 48_284 + gatewayStartCount,
						getVmInstance: vi.fn(),
						id: `gateway-vm-${gatewayStartCount}`,
						setIngressRoutes: vi.fn(),
					},
					zone: getOpenClawZone(),
				};
				if (gatewayStartCount === 2) {
					return await new Promise<typeof gatewayStartResult>((resolve) => {
						resolveStaleGatewayStart = resolve;
					});
				}
				return gatewayStartResult;
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			setTimeoutImpl: (callback, delayMs) => {
				if (delayMs === 5_000) {
					restartTimeoutCallbacks.push(callback);
				}
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart({ timeoutMs: 5_000 });
		await vi.waitFor(() => {
			expect(restartTimeoutCallbacks).toHaveLength(1);
		});
		await vi.waitFor(() => {
			expect(resolveStaleGatewayStart).toBeDefined();
		});
		restartTimeoutCallbacks[0]?.();
		await expect(restartPromise).rejects.toThrow('restart timed out');
		if (!resolveStaleGatewayStart) {
			throw new Error('Expected stale gateway start to be pending.');
		}
		let shutdownSettled = false;
		const shutdownPromise = runtime.shutdown().then(() => {
			shutdownSettled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledOnce();
		expect(shutdownSettled).toBe(false);
		resolveStaleGatewayStart({
			image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			processSpec: {
				bootstrapCommand: 'bootstrap',
				guestListenPort: 18789,
				healthCheck: { type: 'http', port: 18789, path: '/readyz' },
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
				startCommand: 'start',
			},
			vm: {
				close: staleGatewayClose,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
				exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
				fs: createManagedVmFsStub(),
				getHostPid: () => 48_286,
				getVmInstance: vi.fn(),
				id: 'gateway-vm-stale',
				setIngressRoutes: vi.fn(),
			},
			zone: getOpenClawZone(),
		});
		await vi.waitFor(() => {
			expect(staleGatewayClose).toHaveBeenCalledOnce();
		});
		await expect(shutdownPromise).resolves.toBeUndefined();
		expect(shutdownSettled).toBe(true);

		expect(runtime.getSnapshot()).toEqual({ lifecycleState: 'stopped' });
	});

	it('deletes the stale runtime record after closing a timed-out replacement gateway', async () => {
		let gatewayStartCount = 0;
		let resolveStaleGatewayStart: ((value: GatewayZoneStartResult) => void) | undefined;
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const staleGatewayClose = vi.fn(async () => {});
		const restartTimeoutCallbacks: (() => void)[] = [];
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const gatewayStartResult: GatewayZoneStartResult = {
					image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close: gatewayStartCount === 2 ? staleGatewayClose : vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						fs: createManagedVmFsStub(),
						getHostPid: () => 48_284 + gatewayStartCount,
						getVmInstance: vi.fn(),
						id: `gateway-vm-${gatewayStartCount}`,
						setIngressRoutes: vi.fn(),
					},
					zone: getOpenClawZone(),
				};
				if (gatewayStartCount === 2) {
					return await new Promise<typeof gatewayStartResult>((resolve) => {
						resolveStaleGatewayStart = resolve;
					});
				}
				return gatewayStartResult;
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			setTimeoutImpl: (callback, delayMs) => {
				if (delayMs === 5_000) {
					restartTimeoutCallbacks.push(callback);
				}
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart({ timeoutMs: 5_000 });
		await vi.waitFor(() => {
			expect(resolveStaleGatewayStart).toBeDefined();
		});
		restartTimeoutCallbacks[0]?.();
		await expect(restartPromise).rejects.toThrow('restart timed out');
		if (!resolveStaleGatewayStart) {
			throw new Error('Expected stale gateway start to be pending.');
		}
		resolveStaleGatewayStart({
			image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			processSpec: {
				bootstrapCommand: 'bootstrap',
				guestListenPort: 18789,
				healthCheck: { type: 'http', port: 18789, path: '/readyz' },
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
				startCommand: 'start',
			},
			vm: {
				close: staleGatewayClose,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
				exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
				fs: createManagedVmFsStub(),
				getHostPid: () => 48_286,
				getVmInstance: vi.fn(),
				id: 'gateway-vm-stale',
				setIngressRoutes: vi.fn(),
			},
			zone: getOpenClawZone(),
		});
		await vi.waitFor(() => {
			expect(staleGatewayClose).toHaveBeenCalledOnce();
		});

		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledTimes(2);
	});

	it('keeps lifecycle operations serialized until a timed-out replacement gateway settles', async () => {
		let gatewayStartCount = 0;
		let resolveStaleGatewayStart: ((value: GatewayZoneStartResult) => void) | undefined;
		const staleGatewayClose = vi.fn(async () => {});
		const restartTimeoutCallbacks: (() => void)[] = [];
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				const gatewayStartResult: GatewayZoneStartResult = {
					image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close: gatewayStartCount === 2 ? staleGatewayClose : vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						fs: createManagedVmFsStub(),
						getHostPid: () => 48_284 + gatewayStartCount,
						getVmInstance: vi.fn(),
						id: `gateway-vm-${gatewayStartCount}`,
						setIngressRoutes: vi.fn(),
					},
					zone: getOpenClawZone(),
				};
				if (gatewayStartCount === 2) {
					return await new Promise<typeof gatewayStartResult>((resolve) => {
						resolveStaleGatewayStart = resolve;
					});
				}
				return gatewayStartResult;
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			setTimeoutImpl: (callback, delayMs) => {
				if (delayMs === 5_000) {
					restartTimeoutCallbacks.push(callback);
				}
				return { unref: vi.fn() } as unknown as NodeJS.Timeout;
			},
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		const restartPromise = runtime.restart({ timeoutMs: 5_000 });
		await vi.waitFor(() => {
			expect(resolveStaleGatewayStart).toBeDefined();
		});
		restartTimeoutCallbacks[0]?.();
		await expect(restartPromise).rejects.toThrow('restart timed out');

		let stopSettled = false;
		const stopPromise = runtime.stop().then(() => {
			stopSettled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(stopSettled).toBe(false);

		resolveStaleGatewayStart?.({
			image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
			ingress: { host: '127.0.0.1', port: 18791 },
			processSpec: {
				bootstrapCommand: 'bootstrap',
				guestListenPort: 18789,
				healthCheck: { type: 'http', port: 18789, path: '/readyz' },
				logPath: '/agent-vm/logs/gateway-boot-latest.log',
				startCommand: 'start',
			},
			vm: {
				close: staleGatewayClose,
				enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
				enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
				exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
				fs: createManagedVmFsStub(),
				getHostPid: () => 48_286,
				getVmInstance: vi.fn(),
				id: 'gateway-vm-stale',
				setIngressRoutes: vi.fn(),
			},
			zone: getOpenClawZone(),
		});
		await expect(stopPromise).resolves.toBeUndefined();
		expect(stopSettled).toBe(true);
	});

	it('treats restart on a stopped runtime as a cold start without deleting ownership records first', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const runtime = createOpenClawZoneRuntime({
			deleteGatewayRuntimeRecord,
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => ({
				image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
				ingress: { host: '127.0.0.1', port: 18791 },
				processSpec: {
					bootstrapCommand: 'bootstrap',
					guestListenPort: 18789,
					healthCheck: { type: 'http', port: 18789, path: '/readyz' },
					logPath: '/agent-vm/logs/gateway-boot-latest.log',
					startCommand: 'start',
				},
				vm: {
					close: vi.fn(async () => {}),
					enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
					enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
					exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
					fs: createManagedVmFsStub(),
					getHostPid: () => 48_284,
					getVmInstance: vi.fn(),
					id: 'gateway-vm-cold-start-from-restart',
					setIngressRoutes: vi.fn(),
				},
				zone: getOpenClawZone(),
			}),
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await expect(runtime.restart()).resolves.toMatchObject({
			leaseReleaseFailureCount: 0,
		});

		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
		expect(runtime.getSnapshot()).toMatchObject({
			gateway: { vm: { id: 'gateway-vm-cold-start-from-restart' } },
			lifecycleState: 'running',
		});
	});

	it('records restart operation evidence with one operation id when replacement start fails', async () => {
		let gatewayStartCount = 0;
		const operationRecords: GatewayLifecycleOperationRecord[] = [];
		const runtime = createOpenClawZoneRuntime({
			appendGatewayLifecycleOperationRecord: vi.fn(async (record) => {
				operationRecords.push(record);
			}),
			deleteGatewayRuntimeRecord: vi.fn(async () => {}),
			isProcessAlive: () => true,
			leaseManager: { listLeases: () => [], releaseLease: vi.fn(async () => {}) },
			now: () => Date.parse('2026-06-07T14:00:00.000Z'),
			restartGatewayZone: async () => {
				gatewayStartCount += 1;
				if (gatewayStartCount === 2) {
					throw new Error('Failed to resolve zone secrets for zone shravan');
				}
				const hostPid = 48_284 + gatewayStartCount;
				const vmId = `gateway-vm-${String(gatewayStartCount)}`;
				return {
					image: { built: false, fingerprint: 'fingerprint', imagePath: '/tmp/image' },
					ingress: { host: '127.0.0.1', port: 18791 },
					processSpec: {
						bootstrapCommand: 'bootstrap',
						guestListenPort: 18789,
						healthCheck: { type: 'http', port: 18789, path: '/readyz' },
						logPath: '/agent-vm/logs/gateway-boot-latest.log',
						startCommand: 'start',
					},
					vm: {
						close: vi.fn(async () => {}),
						enableIngress: vi.fn(async () => ({ host: '127.0.0.1', port: 18791 })),
						enableSsh: vi.fn(async () => ({ host: '127.0.0.1', port: 22 })),
						exec: vi.fn(() => createManagedExecProcessStub({ stdout: 'ok' })),
						fs: createManagedVmFsStub(),
						getHostPid: () => hostPid,
						getVmInstance: vi.fn(),
						id: vmId,
						setIngressRoutes: vi.fn(),
					},
					zone: getOpenClawZone(),
				};
			},
			secretResolver: { resolve: async () => '', resolveAll: async () => ({}) },
			systemConfig: loadedSystemConfig,
			zone: getOpenClawZone(),
		});

		await runtime.start();
		await expect(runtime.restart()).rejects.toThrow('Failed to resolve zone secrets');

		const restartRequested = operationRecords.find((record) => record.kind === 'restart-requested');
		const operationFailed = operationRecords.find((record) => record.kind === 'operation-failed');
		expect(restartRequested).toMatchObject({
			kind: 'restart-requested',
			operationTrigger: 'operator-restart',
			previousGateway: { hostPid: 48_285, vmId: 'gateway-vm-1' },
		});
		expect(operationFailed).toMatchObject({
			errorCode: 'secret-resolution-failed',
			kind: 'operation-failed',
			operationId: restartRequested?.operationId,
			operationTrigger: 'operator-restart',
			previousGateway: { hostPid: 48_285, vmId: 'gateway-vm-1' },
		});
		expect(runtime.getLifecycleState()).toMatchObject({
			error: { code: 'secret-resolution-failed' },
			kind: 'failed',
		});
	});
});

function createDeferredPromise<TResult>(): {
	readonly promise: Promise<TResult>;
	readonly reject: (reason?: unknown) => void;
	readonly resolve: (value: TResult | PromiseLike<TResult>) => void;
} {
	let rejectDeferred: ((reason?: unknown) => void) | undefined;
	let resolveDeferred: ((value: TResult | PromiseLike<TResult>) => void) | undefined;
	const promise = new Promise<TResult>((resolve, reject) => {
		resolveDeferred = resolve;
		rejectDeferred = reject;
	});
	if (!resolveDeferred || !rejectDeferred) {
		throw new Error('Failed to create deferred promise.');
	}
	return {
		promise,
		reject: rejectDeferred,
		resolve: resolveDeferred,
	};
}
