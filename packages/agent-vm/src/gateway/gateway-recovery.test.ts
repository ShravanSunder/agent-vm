import { describe, expect, it, vi } from 'vitest';

import { cleanupOrphanedGatewayIfPresent } from './gateway-recovery.js';

describe('cleanupOrphanedGatewayIfPresent', () => {
	it('kills an orphaned qemu process, deletes the runtime record, and reports cleanup', async () => {
		const logMessages: string[] = [];
		const loadGatewayRuntimeRecord = vi.fn(async () => ({
			createdAt: '2026-04-13T12:34:56.000Z',
			gatewayType: 'openclaw' as const,
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 48282,
			sessionId: 'gateway-vm-123',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'gateway-vm-123',
			zoneId: 'shravan',
		}));
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
					sleep: async () => {},
				},
			),
		).resolves.toEqual({
			cleanedUp: true,
			killedPid: null,
		});

		expect(readProcessCommand).toHaveBeenCalledWith(48282);
		expect(killProcess).toHaveBeenNthCalledWith(1, 48282, 'SIGTERM');
		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
		expect(logMessages).toEqual([
			"Found persisted gateway runtime for zone 'shravan' (pid 48282, session gateway-vm-123).",
			"Removed stale gateway runtime record for zone 'shravan' after confirming the orphaned process was already gone.",
		]);
	});

	it('fails fast when the recorded pid belongs to a different process', async () => {
		const loadGatewayRuntimeRecord = vi.fn(async () => ({
			createdAt: '2026-04-13T12:34:56.000Z',
			gatewayType: 'openclaw' as const,
			guestListenPort: 18789,
			ingressPort: 18791,
			projectNamespace: 'claw-tests-a1b2c3d4',
			qemuPid: 48282,
			sessionId: 'gateway-vm-123',
			sessionLabel: 'claw-tests-a1b2c3d4:shravan:gateway',
			vmId: 'gateway-vm-123',
			zoneId: 'shravan',
		}));
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});

		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord,
					isProcessAlive: () => true,
					killProcess: vi.fn(),
					loadGatewayRuntimeRecord,
					readProcessCommand: async () => 'node /tmp/something-else.js',
					sleep: async () => {},
				},
			),
		).rejects.toThrow(/unexpected live process/i);

		expect(deleteGatewayRuntimeRecord).not.toHaveBeenCalled();
	});

	it('deletes stale runtime records for already-dead processes without trying to kill them', async () => {
		const killProcess = vi.fn();
		const deleteGatewayRuntimeRecord = vi.fn(async () => {});

		await expect(
			cleanupOrphanedGatewayIfPresent(
				{
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord,
					isProcessAlive: () => false,
					killProcess,
					loadGatewayRuntimeRecord: async () => ({
						createdAt: '2026-04-13T12:34:56.000Z',
						gatewayType: 'openclaw',
						guestListenPort: 18789,
						ingressPort: 18791,
						projectNamespace: 'claw-tests-a1b2c3d4',
						qemuPid: 48282,
						sessionId: 'gateway-vm-123',
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
					stateDir: '/state/shravan',
					zoneId: 'shravan',
				},
				{
					deleteGatewayRuntimeRecord,
					isProcessAlive,
					killProcess,
					loadGatewayRuntimeRecord: async () => ({
						createdAt: '2026-04-13T12:34:56.000Z',
						gatewayType: 'openclaw',
						guestListenPort: 18789,
						ingressPort: 18791,
						projectNamespace: 'claw-tests-a1b2c3d4',
						qemuPid: 48282,
						sessionId: 'gateway-vm-123',
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
			killedPid: null,
		});

		expect(deleteGatewayRuntimeRecord).toHaveBeenCalledWith('/state/shravan');
	});
});
