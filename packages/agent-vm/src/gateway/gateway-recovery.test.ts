import { describe, expect, it, vi } from 'vitest';

import { cleanupOrphanedGatewayIfPresent } from './gateway-recovery.js';
import type { GatewayRuntimeRecord } from './gateway-runtime-record.js';

// Stub readProcessIdentity at the module boundary so tests that don't
// explicitly inject one get a default matching the factory record. Tests
// that want a mismatch (the PID-reuse defense test) inject per-call.
vi.mock('../shared/managed-vm-process.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../shared/managed-vm-process.js')>();
	return {
		...actual,
		readProcessIdentity: vi.fn(async () => ({
			command: 'qemu-system-aarch64 -m 4G -smp 4 -kernel /vm-images/gateway/kernel',
			lstart: 'Mon Apr 13 12:34:56 2026',
		})),
	};
});

const matchingProcessIdentity = {
	command: 'qemu-system-aarch64 -m 4G -smp 4 -kernel /vm-images/gateway/kernel',
	lstart: 'Mon Apr 13 12:34:56 2026',
};

function createGatewayRuntimeRecord(
	overrides: Partial<GatewayRuntimeRecord> = {},
): GatewayRuntimeRecord {
	return {
		configPath: '/deployments/shravan-claw/config/system.jsonc',
		controllerPort: 18800,
		createdAt: '2026-04-13T12:34:56.000Z',
		gatewayType: 'openclaw',
		guestListenPort: 18789,
		ingressPort: 18791,
		processIdentity: matchingProcessIdentity,
		projectNamespace: 'claw-tests-a1b2c3d4',
		qemuPid: 48282,
		schemaVersion: 1,
		sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
		vmId: 'gateway-vm-123',
		zoneId: 'shravan',
		...overrides,
	};
}

async function matchingIdentityResolver(): Promise<{ command: string; lstart: string }> {
	return matchingProcessIdentity;
}

describe('cleanupOrphanedGatewayIfPresent', () => {
	it('refuses to clean up a runtime record from another project namespace', async () => {
		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'shravan-claw-beta-25319b68',
					stateDir: '/state/beta',
					zoneId: 'beta',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => true,
					killProcess: vi.fn(),
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							configPath: '/deployments/shravan-claw/config/system.json',
							projectNamespace: 'shravan-claw-463c3e5f',
							sessionLabel: 'shravan-claw-463c3e5f:sunfam:gateway',
							zoneId: 'sunfam',
						}),
					readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/belongs to projectNamespace 'shravan-claw-463c3e5f'/u);
	});

	it('refuses to clean up a runtime record whose session label does not match the config boundary', async () => {
		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'shravan-claw-beta-25319b68',
					stateDir: '/state/beta',
					zoneId: 'beta',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => true,
					killProcess: vi.fn(),
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							configPath: '/deployments/shravan-claw-beta/config/system.jsonc',
							controllerPort: 18900,
							ingressPort: 18891,
							projectNamespace: 'shravan-claw-beta-25319b68',
							sessionLabel: 'shravan-claw-463c3e5f:sunfam:gateway',
							zoneId: 'beta',
						}),
					readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/session label/u);
	});

	it('refuses to clean up a runtime record whose zone id does not match the requested zone', async () => {
		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => true,
					killProcess: vi.fn(),
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							sessionLabel: 'claw-tests-a1b2c3d4:ember:gateway',
							zoneId: 'ember',
						}),
					readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/belongs to zone 'ember'/u);
	});

	it('quarantines mismatched records during in-process recovery without signaling the process', async () => {
		const logMessages: string[] = [];
		const killProcess = vi.fn();
		const quarantineGatewayRuntimeRecord = vi.fn(async () => {});

		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					legacyRecordDefaults: {
						configPath: '/deployments/shravan-claw-beta/config/system.jsonc',
						controllerPort: 18900,
					},
					mode: 'in-process-recovery',
					projectNamespace: 'shravan-claw-beta-25319b68',
					stateDir: '/state/beta',
					zoneId: 'beta',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => true,
					killProcess,
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							configPath: '/deployments/shravan-claw/config/system.jsonc',
							projectNamespace: 'shravan-claw-463c3e5f',
							sessionLabel: 'shravan-claw-463c3e5f:sunfam:gateway',
							zoneId: 'sunfam',
						}),
					log: (message) => {
						logMessages.push(message);
					},
					quarantineGatewayRuntimeRecord,
					readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
					sleep: async () => {},
				},
			),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning: expect.stringContaining('Quarantining the stale runtime record'),
			killedPid: null,
		});

		expect(killProcess).not.toHaveBeenCalled();
		expect(quarantineGatewayRuntimeRecord).toHaveBeenCalledWith('/state/beta', {
			log: expect.any(Function),
			reason: expect.stringContaining('Quarantining the stale runtime record'),
		});
		expect(logMessages.join('\n')).toContain('configPath');
	});

	it('kills an orphaned qemu process, deletes the runtime record, and reports cleanup', async () => {
		const logMessages: string[] = [];
		const loadGatewayRuntimeRecord = vi.fn(async () =>
			createGatewayRuntimeRecord({
				createdAt: '2026-04-13T12:34:56.000Z',
				gatewayType: 'openclaw' as const,
				guestListenPort: 18789,
				ingressPort: 18791,
				projectNamespace: 'claw-tests-a1b2c3d4',
				qemuPid: 48282,
				sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
				vmId: 'gateway-vm-123',
				zoneId: 'shravan',
			}),
		);
		const readProcessCommand = vi.fn(async () => 'qemu-system-aarch64 -nodefaults');
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		const killProcess = vi.fn();
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});

		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord,
					isProcessAlive,
					killProcess,
					loadGatewayRuntimeRecord,
					log: (message) => {
						logMessages.push(message);
					},
					readProcessCommand,
					readProcessIdentity: matchingIdentityResolver,
					sleep: async () => {},
				},
			),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: 48282,
		});

		expect(killProcess).toHaveBeenNthCalledWith(1, 48282, 'SIGTERM');
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
		expect(logMessages).toEqual([
			"Found persisted gateway runtime for zone 'shravan' (pid 48282, vm gateway-vm-123).",
			"Removed stale gateway runtime record for zone 'shravan' after terminating orphaned gateway pid 48282.",
		]);
	});

	it('fails fast when the recorded pid belongs to a different process', async () => {
		// Live process's identity differs from the recorded one: same PID,
		// different process. Cleanup must refuse rather than killing the
		// unrelated process. This exercises the identity-check rejection path.
		const loadGatewayRuntimeRecord = vi.fn(async () => createGatewayRuntimeRecord());
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});

		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord,
					isProcessAlive: () => true,
					killProcess: vi.fn(),
					loadGatewayRuntimeRecord,
					readProcessCommand: async () => 'node /tmp/something-else.js',
					readProcessIdentity: async () => ({
						command: 'node /tmp/something-else.js',
						lstart: 'Tue Apr 14 15:00:00 2026',
					}),
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/process identity changed/u);

		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
	});

	it('deletes stale runtime records for already-dead processes without trying to kill them', async () => {
		const killProcess = vi.fn();
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});

		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord,
					isProcessAlive: () => false,
					killProcess,
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							createdAt: '2026-04-13T12:34:56.000Z',
							gatewayType: 'openclaw',
							guestListenPort: 18789,
							ingressPort: 18791,
							projectNamespace: 'claw-tests-a1b2c3d4',
							qemuPid: 48282,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							vmId: 'gateway-vm-123',
							zoneId: 'shravan',
						}),
					readProcessCommand: async () => null,
					sleep: async () => {},
				},
			),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: null,
		});

		expect(killProcess).not.toHaveBeenCalled();
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
	});

	it('treats ESRCH during orphan termination as already cleaned up', async () => {
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});
		const isProcessAlive = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
		const killProcess = vi.fn(() => {
			const error = new Error('missing process');
			Object.assign(error, { code: 'ESRCH' });
			throw error;
		});

		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord,
					isProcessAlive,
					killProcess,
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							createdAt: '2026-04-13T12:34:56.000Z',
							gatewayType: 'openclaw',
							guestListenPort: 18789,
							ingressPort: 18791,
							projectNamespace: 'claw-tests-a1b2c3d4',
							qemuPid: 48282,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							vmId: 'gateway-vm-123',
							zoneId: 'shravan',
						}),
					readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
					sleep: async () => {},
				},
			),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: 48282,
		});

		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
	});

	it('rethrows unexpected liveness-check errors instead of treating the process as dead', async () => {
		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => {
						throw new Error('kill(0) failed unexpectedly');
					},
					killProcess: vi.fn(),
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							createdAt: '2026-04-13T12:34:56.000Z',
							gatewayType: 'openclaw',
							guestListenPort: 18789,
							ingressPort: 18791,
							projectNamespace: 'claw-tests-a1b2c3d4',
							qemuPid: 48282,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							vmId: 'gateway-vm-123',
							zoneId: 'shravan',
						}),
					readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/kill\(0\) failed unexpectedly/u);
	});

	it('treats a clean start with no runtime record as a no-op', async () => {
		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					loadGatewayRuntimeRecord: async () => null,
				},
			),
		).resolves.toEqual({
			cleanedUp: false,
			killedPid: null,
		});
	});

	it('returns a cleanup warning when record deletion fails after handling the orphan', async () => {
		const logMessages: string[] = [];

		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord: async () => {
						throw new Error('filesystem readonly');
					},
					isProcessAlive: vi
						.fn()
						.mockReturnValueOnce(true)
						.mockReturnValueOnce(true)
						.mockReturnValueOnce(false),
					killProcess: vi.fn(),
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							createdAt: '2026-04-13T12:34:56.000Z',
							gatewayType: 'openclaw',
							guestListenPort: 18789,
							ingressPort: 18791,
							projectNamespace: 'claw-tests-a1b2c3d4',
							qemuPid: 48282,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							vmId: 'gateway-vm-123',
							zoneId: 'shravan',
						}),
					log: (message) => {
						logMessages.push(message);
					},
					readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
					sleep: async () => {},
				},
			),
		).resolves.toEqual({
			cleanedUp: false,
			cleanupWarning:
				"Failed to remove stale gateway runtime record for zone 'shravan' at '/state/shravan': filesystem readonly",
			killedPid: 48282,
		});

		expect(logMessages).toContain(
			"Failed to remove stale gateway runtime record for zone 'shravan' at '/state/shravan': filesystem readonly",
		);
	});

	it('surfaces ps execution failures instead of misreporting an unexpected live process', async () => {
		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => true,
					killProcess: vi.fn(),
					loadGatewayRuntimeRecord: async () => createGatewayRuntimeRecord(),
					readProcessCommand: async () => {
						throw new Error('ps failed');
					},
					// Identity probe also fails — the cleanup must surface the
					// error rather than silently treating the pid as gone.
					readProcessIdentity: async () => {
						throw new Error('ps failed');
					},
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/ps failed/u);
	});

	it('surfaces actionable permission errors when the orphaned process cannot be signaled', async () => {
		const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(((
			_pid: number,
			signal?: number | NodeJS.Signals,
		) => {
			if (signal === 0) {
				return true;
			}
			const error = new Error('operation not permitted');
			Object.assign(error, { code: 'EPERM' });
			throw error;
		}) as typeof process.kill);

		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							createdAt: '2026-04-13T12:34:56.000Z',
							gatewayType: 'openclaw',
							guestListenPort: 18789,
							ingressPort: 18791,
							projectNamespace: 'claw-tests-a1b2c3d4',
							qemuPid: 48282,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							vmId: 'gateway-vm-123',
							zoneId: 'shravan',
						}),
					readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/Permission denied while sending SIGTERM/u);

		processKillSpy.mockRestore();
	});

	it('escalates to SIGKILL when SIGTERM does not stop the orphaned process', async () => {
		let nowMs = 0;
		const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
		const killProcess = vi.fn();
		const isProcessAlive = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);

		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive,
					killProcess,
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							createdAt: '2026-04-13T12:34:56.000Z',
							gatewayType: 'openclaw',
							guestListenPort: 18789,
							ingressPort: 18791,
							projectNamespace: 'claw-tests-a1b2c3d4',
							qemuPid: 48282,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							vmId: 'gateway-vm-123',
							zoneId: 'shravan',
						}),
					readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
					sleep: async () => {
						nowMs += 2_500;
					},
				},
			),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: 48282,
		});

		expect(killProcess).toHaveBeenNthCalledWith(1, 48282, 'SIGTERM');
		expect(killProcess).toHaveBeenNthCalledWith(2, 48282, 'SIGKILL');
		dateNowSpy.mockRestore();
	});

	it('throws when SIGTERM and SIGKILL both fail to terminate the orphaned process', async () => {
		let nowMs = 0;
		const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => true,
					killProcess: vi.fn(),
					loadGatewayRuntimeRecord: async () =>
						createGatewayRuntimeRecord({
							createdAt: '2026-04-13T12:34:56.000Z',
							gatewayType: 'openclaw',
							guestListenPort: 18789,
							ingressPort: 18791,
							projectNamespace: 'claw-tests-a1b2c3d4',
							qemuPid: 48282,
							sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
							vmId: 'gateway-vm-123',
							zoneId: 'shravan',
						}),
					readProcessCommand: async () => 'qemu-system-aarch64 -nodefaults',
					sleep: async () => {
						nowMs += 2_500;
					},
				},
			),
		).rejects.toThrow(/Failed to terminate orphaned managed VM process 48282/u);
		dateNowSpy.mockRestore();
	});

	it('refuses to signal when the live PID identity differs from the recorded one (PID reuse defense)', async () => {
		// Same PID, different process: recorded was the original QEMU,
		// live is a different process that took the PID after the first
		// died. Cleanup must REFUSE the signal rather than killing the
		// unrelated process.
		const killProcess = vi.fn();
		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					projectNamespace: 'claw-tests-a1b2c3d4',
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord: vi.fn(async () => {}),
					isProcessAlive: () => true,
					killProcess,
					loadGatewayRuntimeRecord: vi.fn(async () => createGatewayRuntimeRecord()),
					log: () => {},
					readProcessCommand: async () => '/usr/local/bin/postgres -D /var/lib/postgres',
					readProcessIdentity: async () => ({
						command: '/usr/local/bin/postgres -D /var/lib/postgres',
						lstart: 'Tue Apr 14 15:00:00 2026',
					}),
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/refusing SIGTERM to pid 48282: process identity changed/u);
		expect(killProcess).not.toHaveBeenCalled();
	});
});
