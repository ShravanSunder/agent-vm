import { describe, expect, it, vi, type Mock } from 'vitest';

import {
	containsManagedVmTerminationUnprovenError,
	ManagedVmTerminationUnprovenError,
	terminateLiveManagedVm,
	terminateRecordedManagedVmProcess,
} from './controller-managed-vm-termination.js';
import type { ProcessIdentity } from './managed-vm-process.js';

const hostPid = 48_282;
const processIdentity = {
	command: 'qemu-system-aarch64 -name controller-owned-vm',
	lstart: 'Tue Jul 11 12:00:00 2026',
} satisfies ProcessIdentity;
const terminationTarget = {
	hostPid,
	processIdentity,
	vmId: 'controller-owned-vm',
} as const;

interface ProcessDependenciesHarness {
	readonly isProcessAlive: Mock<(pid: number) => boolean>;
	readonly killProcess: Mock<(pid: number, signal: NodeJS.Signals) => void>;
	readonly readProcessCommand: Mock<(pid: number) => Promise<string | null>>;
	readonly readProcessIdentity: Mock<(pid: number) => Promise<ProcessIdentity | null>>;
	readonly sleep: Mock<(delayMs: number) => Promise<void>>;
}

function createProcessDependencies(
	options: {
		readonly isProcessAlive?: (pid: number) => boolean;
		readonly readProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
	} = {},
): ProcessDependenciesHarness {
	return {
		isProcessAlive: vi.fn(options.isProcessAlive ?? (() => false)),
		killProcess: vi.fn<(pid: number, signal: NodeJS.Signals) => void>(),
		readProcessCommand: vi.fn(async () => processIdentity.command),
		readProcessIdentity: vi.fn(options.readProcessIdentity ?? (async () => processIdentity)),
		sleep: vi.fn(async () => {}),
	};
}

describe('controller-managed VM termination', () => {
	it('observes exact TERM exit and cleared Gondolin runner ownership before closing live handles', async () => {
		// Arrange
		const orderedEvents: string[] = [];
		let processAlive = true;
		const dependencies = createProcessDependencies({
			isProcessAlive: () => {
				if (!processAlive) {
					orderedEvents.push('os-absent');
				}
				return processAlive;
			},
		});
		dependencies.killProcess.mockImplementation((_pid, signal) => {
			orderedEvents.push(`signal-${signal}`);
			processAlive = false;
		});
		const getHostPid = vi
			.fn<() => number | null>()
			.mockReturnValueOnce(hostPid)
			.mockImplementation(() => {
				orderedEvents.push('gondolin-runner-absent');
				return null;
			});
		const close = vi.fn(async () => {
			orderedEvents.push('close-live-handles');
		});

		// Act
		await terminateLiveManagedVm({
			dependencies,
			target: terminationTarget,
			vm: { close, getHostPid, id: terminationTarget.vmId },
		});

		// Assert
		expect(orderedEvents).toEqual([
			'signal-SIGTERM',
			'os-absent',
			'gondolin-runner-absent',
			'close-live-handles',
		]);
		expect(dependencies.killProcess).toHaveBeenCalledOnce();
		expect(dependencies.killProcess).toHaveBeenCalledWith(hostPid, 'SIGTERM');
		expect(close).toHaveBeenCalledOnce();
	});

	it('closes live handles when the recorded process and Gondolin runner are already absent', async () => {
		// Arrange
		const dependencies = createProcessDependencies();
		const close = vi.fn(async () => {});

		// Act
		await terminateLiveManagedVm({
			dependencies,
			target: terminationTarget,
			vm: { close, getHostPid: () => null, id: terminationTarget.vmId },
		});

		// Assert
		expect(dependencies.killProcess).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it('terminates an exact recorded process without requiring a live Gondolin handle', async () => {
		// Arrange
		const dependencies = createProcessDependencies({
			isProcessAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
		});

		// Act
		await terminateRecordedManagedVmProcess({ dependencies, target: terminationTarget });

		// Assert
		expect(dependencies.killProcess).toHaveBeenCalledOnce();
		expect(dependencies.killProcess).toHaveBeenCalledWith(hostPid, 'SIGTERM');
	});

	it('refuses an identity mismatch without signaling or closing live handles', async () => {
		// Arrange
		const dependencies = createProcessDependencies({
			isProcessAlive: () => true,
			readProcessIdentity: async () => ({
				command: 'node unrelated-process.js',
				lstart: 'Tue Jul 11 12:05:00 2026',
			}),
		});
		const close = vi.fn(async () => {});

		// Act
		const termination = terminateLiveManagedVm({
			dependencies,
			target: terminationTarget,
			vm: { close, getHostPid: () => hostPid, id: terminationTarget.vmId },
		});

		// Assert
		await expect(termination).rejects.toThrow(/process identity changed/u);
		expect(dependencies.killProcess).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it('rejects without closing while Gondolin keeps a live runner reference after OS absence', async () => {
		// Arrange
		const dependencies = createProcessDependencies({
			isProcessAlive: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false),
		});
		const close = vi.fn(async () => {});

		// Act
		const termination = terminateLiveManagedVm({
			dependencies,
			target: terminationTarget,
			vm: { close, getHostPid: () => hostPid, id: terminationTarget.vmId },
		});

		// Assert
		await expect(termination).rejects.toThrow(/Gondolin.*runner|runner.*Gondolin/iu);
		expect(dependencies.sleep).toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it('refuses a live VM id mismatch without signaling or closing', async () => {
		// Arrange
		const dependencies = createProcessDependencies({ isProcessAlive: () => true });
		const close = vi.fn(async () => {});

		// Act
		const termination = terminateLiveManagedVm({
			dependencies,
			target: terminationTarget,
			vm: { close, getHostPid: () => hostPid, id: 'different-vm' },
		});

		// Assert
		await expect(termination).rejects.toThrow(/VM id|vm id/iu);
		expect(dependencies.killProcess).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it('propagates a live-handle close error after proving runner absence', async () => {
		// Arrange
		const dependencies = createProcessDependencies();
		const closeError = new Error('live handle close failed');
		const close = vi.fn(async () => {
			throw closeError;
		});

		// Act
		const termination = terminateLiveManagedVm({
			dependencies,
			target: terminationTarget,
			vm: { close, getHostPid: () => null, id: terminationTarget.vmId },
		});

		// Assert
		await expect(termination).rejects.toMatchObject({
			cause: closeError,
			name: 'ManagedVmTerminationUnprovenError',
		});
		expect(dependencies.killProcess).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it('finds an unproven termination through aggregate and cause chains', () => {
		// Arrange
		const terminationError = new ManagedVmTerminationUnprovenError('runner still attached');
		const aggregateError = new AggregateError([
			new Error('primary failure'),
			new Error('cleanup failed', { cause: terminationError }),
		]);

		// Act
		const containsUnprovenTermination = containsManagedVmTerminationUnprovenError(aggregateError);

		// Assert
		expect(containsUnprovenTermination).toBe(true);
		expect(containsManagedVmTerminationUnprovenError(new Error('ordinary failure'))).toBe(false);
	});
});
