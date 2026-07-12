import { describe, expect, it, vi } from 'vitest';

import {
	parseProcessIdentityOutput,
	terminateRecordedManagedVmHostProcess,
} from './managed-vm-process.js';

describe('parseProcessIdentityOutput', () => {
	it('keeps the ps lstart year out of the command field', () => {
		expect(
			parseProcessIdentityOutput('Fri May 22 10:00:00 2026 qemu-system-aarch64 -m 4G -smp 4'),
		).toEqual({
			command: 'qemu-system-aarch64 -m 4G -smp 4',
			lstart: 'Fri May 22 10:00:00 2026',
		});
	});

	it('returns null when the command column is missing', () => {
		expect(parseProcessIdentityOutput('Fri May 22 10:00:00 2026')).toBeNull();
	});
});

describe('terminateRecordedManagedVmHostProcess', () => {
	const recordedIdentity = {
		command: 'qemu-system-aarch64 -name controller-owned-vm',
		lstart: 'Tue Jul 11 12:00:00 2026',
	} as const;

	it('refuses to signal an identity-less live record', async () => {
		// Arrange
		const killProcess = vi.fn();

		// Act
		const termination = terminateRecordedManagedVmHostProcess({
			contextLabel: 'identity-less runtime record',
			dependencies: {
				isProcessAlive: () => true,
				killProcess,
				readProcessCommand: async () => recordedIdentity.command,
				sleep: async () => {},
			},
			pid: 48_282,
		});

		// Assert
		await expect(termination).rejects.toThrow(/recorded process identity.*required/iu);
		expect(killProcess).not.toHaveBeenCalled();
	});

	it('rechecks identity and refuses SIGKILL when the pid identity changes after SIGTERM', async () => {
		// Arrange
		const changedIdentity = {
			command: 'qemu-system-aarch64 -name replacement-vm',
			lstart: 'Tue Jul 11 12:05:00 2026',
		};
		const killProcess = vi.fn();
		const readProcessIdentity = vi
			.fn<() => Promise<typeof recordedIdentity | typeof changedIdentity>>()
			.mockResolvedValueOnce(recordedIdentity)
			.mockResolvedValueOnce(changedIdentity);

		// Act
		const termination = terminateRecordedManagedVmHostProcess({
			contextLabel: 'recorded runtime',
			dependencies: {
				isProcessAlive: () => true,
				killProcess,
				readProcessCommand: async () => recordedIdentity.command,
				readProcessIdentity,
				sleep: async () => {},
			},
			pid: 48_282,
			recordedIdentity,
		});

		// Assert
		await expect(termination).rejects.toThrow(/process identity changed/iu);
		expect(killProcess).toHaveBeenCalledOnce();
		expect(killProcess).toHaveBeenCalledWith(48_282, 'SIGTERM');
	});
});
