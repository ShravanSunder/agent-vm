import { describe, expect, it, vi } from 'vitest';

import { cleanupOrphanedGatewayIfPresent } from './gateway-recovery.js';
import type {
	GatewayRuntimeRecord,
	GatewayRuntimeRecordLoadResult,
} from './gateway-runtime-record.js';

const matchingProcessIdentity = {
	command: 'qemu-system-aarch64 -m 4G -smp 4 -kernel /vm-images/gateway/kernel',
	lstart: 'Mon Apr 13 12:34:56 2026',
};

function createGatewayRuntimeRecord(
	overrides: Partial<GatewayRuntimeRecord> = {},
): GatewayRuntimeRecord {
	return {
		configPath: '/deployments/shravan-claw/config/system.jsonc',
		controllerPort: 18_800,
		createdAt: '2026-04-13T12:34:56.000Z',
		gatewayType: 'openclaw',
		guestListenPort: 18_789,
		ingressPort: 18_791,
		processIdentity: matchingProcessIdentity,
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid: 48_282,
		schemaVersion: 1,
		sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
		vmId: 'gateway-vm-123',
		zoneId: 'shravan',
		...overrides,
	};
}

function loadedGatewayRuntimeRecord(record: GatewayRuntimeRecord): GatewayRuntimeRecordLoadResult {
	return {
		kind: 'loaded',
		path: `/state/${record.zoneId}/gateway-runtime.json`,
		record,
	};
}

function createGatewayRecoveryOptions(
	overrides: Partial<Parameters<typeof cleanupOrphanedGatewayIfPresent>[0]> = {},
): Parameters<typeof cleanupOrphanedGatewayIfPresent>[0] {
	return {
		projectNamespace: 'claw-tests-a1b2c3d4',
		stateDir: '/state/shravan',
		zoneId: 'shravan',
		...overrides,
	};
}

async function matchingIdentityResolver(): Promise<{ command: string; lstart: string }> {
	return matchingProcessIdentity;
}

describe('cleanupOrphanedGatewayIfPresent', () => {
	it('returns no cleanup when no runtime record exists', async () => {
		await expect(
			cleanupOrphanedGatewayIfPresent(createGatewayRecoveryOptions(), {
				loadGatewayRuntimeRecordResult: async () => ({
					kind: 'missing',
					path: '/state/shravan/gateway-runtime.json',
				}),
			}),
		).resolves.toEqual({ cleanedUp: false, killedPid: null });
	});

	it('warns and skips malformed records during in-process recovery without mutating', async () => {
		const logMessages: string[] = [];

		await expect(
			cleanupOrphanedGatewayIfPresent(
				createGatewayRecoveryOptions({ mode: 'in-process-recovery' }),
				{
					loadGatewayRuntimeRecordResult: async () => ({
						error: new Error('expected schemaVersion'),
						kind: 'parse-error',
						path: '/state/shravan/gateway-runtime.json',
					}),
					log: (message) => {
						logMessages.push(message);
					},
				},
			),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('Malformed gateway runtime record'),
			killedPid: null,
		});
		expect(logMessages.join('\n')).toContain('Malformed gateway runtime record');
	});

	it('throws on malformed records during offline cleanup', async () => {
		await expect(
			cleanupOrphanedGatewayIfPresent(createGatewayRecoveryOptions({ mode: 'offline-cleanup' }), {
				loadGatewayRuntimeRecordResult: async () => ({
					error: new Error('expected schemaVersion'),
					kind: 'parse-error',
					path: '/state/shravan/gateway-runtime.json',
				}),
			}),
		).rejects.toThrow(/Malformed gateway runtime record/u);
	});

	it('refuses to clean up a runtime record from another project namespace', async () => {
		await expect(
			cleanupOrphanedGatewayIfPresent(createGatewayRecoveryOptions(), {
				deleteGatewayRuntimeRecord: vi.fn(async () => {}),
				isProcessAlive: () => true,
				killProcess: vi.fn(),
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(
						createGatewayRuntimeRecord({
							projectNamespace: 'shravan-claw-463c3e5f',
							sessionLabel: 'shravan-claw-463c3e5f:shravan:gateway',
						}),
					),
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 48_282 }),
				sleep: async () => {},
			}),
		).rejects.toThrow(/belongs to projectNamespace 'shravan-claw-463c3e5f'/u);
	});

	it('skips mismatched records during in-process recovery without signaling the process', async () => {
		const logMessages: string[] = [];
		const killProcess = vi.fn();

		await expect(
			cleanupOrphanedGatewayIfPresent(
				createGatewayRecoveryOptions({
					mode: 'in-process-recovery',
					projectNamespace: 'shravan-claw-beta-25319b68',
					stateDir: '/state/beta',
					zoneId: 'beta',
				}),
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => true,
					killProcess,
					loadGatewayRuntimeRecordResult: async () =>
						loadedGatewayRuntimeRecord(
							createGatewayRuntimeRecord({
								projectNamespace: 'shravan-claw-463c3e5f',
								sessionLabel: 'shravan-claw-463c3e5f:sunfam:gateway',
								zoneId: 'sunfam',
							}),
						),
					log: (message) => {
						logMessages.push(message);
					},
					readTcpListenPortOwner: async () => ({
						command: 'qemu-system-aarch64',
						pid: 48_282,
					}),
					sleep: async () => {},
				},
			),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('Skipping the stale runtime record'),
			killedPid: null,
		});

		expect(killProcess).not.toHaveBeenCalled();
		expect(logMessages.join('\n')).toContain('projectNamespace');
	});

	it('skips gateway recovery when the ingress port is held by a different pid during startup recovery', async () => {
		const killProcess = vi.fn();
		const logMessages: string[] = [];

		await expect(
			cleanupOrphanedGatewayIfPresent(
				createGatewayRecoveryOptions({ mode: 'in-process-recovery' }),
				{
					killProcess,
					loadGatewayRuntimeRecordResult: async () =>
						loadedGatewayRuntimeRecord(
							createGatewayRuntimeRecord({ ingressPort: 18_891, qemuPid: 111 }),
						),
					log: (message) => {
						logMessages.push(message);
					},
					readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
				},
			),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('held by pid 222'),
			killedPid: null,
		});
		expect(killProcess).not.toHaveBeenCalled();
		expect(logMessages.join('\n')).toContain('held by pid 222');
	});

	it('throws in offline cleanup when the gateway ingress port is held by a different pid', async () => {
		const killProcess = vi.fn();

		await expect(
			cleanupOrphanedGatewayIfPresent(createGatewayRecoveryOptions({ mode: 'offline-cleanup' }), {
				killProcess,
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(
						createGatewayRuntimeRecord({ ingressPort: 18_891, qemuPid: 111 }),
					),
				readTcpListenPortOwner: async () => ({ command: 'qemu-system-aarch64', pid: 222 }),
			}),
		).rejects.toThrow(/port 18891 is held by pid 222/u);
		expect(killProcess).not.toHaveBeenCalled();
	});

	it('deletes a stale record when its ingress port is already free', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const killProcess = vi.fn();

		await expect(
			cleanupOrphanedGatewayIfPresent(createGatewayRecoveryOptions(), {
				deleteGatewayRuntimeRecord,
				killProcess,
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord({ qemuPid: 111 })),
				readTcpListenPortOwner: async () => null,
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: null,
		});
		expect(killProcess).not.toHaveBeenCalled();
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
	});

	it('kills an owned orphaned qemu process, deletes the runtime record, and reports cleanup', async () => {
		const logMessages: string[] = [];
		const readProcessCommand = vi.fn(async () => 'qemu-system-aarch64 -nodefaults');
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		const killProcess = vi.fn();
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});

		await expect(
			cleanupOrphanedGatewayIfPresent(createGatewayRecoveryOptions(), {
				deleteGatewayRuntimeRecord,
				isProcessAlive,
				killProcess,
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord()),
				log: (message) => {
					logMessages.push(message);
				},
				readProcessCommand,
				readProcessIdentity: matchingIdentityResolver,
				readTcpListenPortOwner: async () => ({
					command: 'qemu-system-aarch64',
					pid: 48_282,
				}),
				sleep: async () => {},
			}),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: 48_282,
		});

		expect(killProcess).toHaveBeenNthCalledWith(1, 48_282, 'SIGTERM');
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
		expect(logMessages).toEqual([
			"Found persisted gateway runtime for zone 'shravan' (pid 48282, vm gateway-vm-123).",
			"Removed stale gateway runtime record for zone 'shravan' after terminating orphaned gateway pid 48282.",
		]);
	});

	it('warns and skips when the recorded pid owns the port but is not a managed VM command', async () => {
		const killProcess = vi.fn();

		await expect(
			cleanupOrphanedGatewayIfPresent(
				createGatewayRecoveryOptions({ mode: 'in-process-recovery' }),
				{
					killProcess,
					loadGatewayRuntimeRecordResult: async () =>
						loadedGatewayRuntimeRecord(createGatewayRuntimeRecord({ qemuPid: 111 })),
					readTcpListenPortOwner: async () => ({ command: '/usr/bin/python3', pid: 111 }),
				},
			),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('not a managed VM process'),
			killedPid: null,
		});
		expect(killProcess).not.toHaveBeenCalled();
	});

	it('fails fast when the recorded pid belongs to a different process', async () => {
		const killProcess = vi.fn();

		await expect(
			cleanupOrphanedGatewayIfPresent(createGatewayRecoveryOptions(), {
				deleteGatewayRuntimeRecord: vi.fn(async () => {}),
				isProcessAlive: () => true,
				killProcess,
				loadGatewayRuntimeRecordResult: async () =>
					loadedGatewayRuntimeRecord(createGatewayRuntimeRecord()),
				readProcessCommand: async () => 'node /tmp/something-else.js',
				readProcessIdentity: async () => ({
					command: 'node /tmp/something-else.js',
					lstart: 'Tue Apr 14 15:00:00 2026',
				}),
				readTcpListenPortOwner: async () => ({
					command: 'qemu-system-aarch64',
					pid: 48_282,
				}),
				sleep: async () => {},
			}),
		).rejects.toThrow(/refusing SIGTERM to pid 48282: process identity changed/u);
		expect(killProcess).not.toHaveBeenCalled();
	});
});
