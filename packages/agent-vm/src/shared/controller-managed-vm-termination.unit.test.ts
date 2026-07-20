import type {
	ManagedVmExactProcessTerminationCapability,
	ManagedVmExactProcessTerminationOutcome,
} from '@agent-vm/managed-vm';
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

interface TerminationDependenciesHarness {
	readonly exactProcessTermination: ManagedVmExactProcessTerminationCapability;
	readonly terminateRecordedHostProcess: Mock<
		(
			request: Parameters<
				ManagedVmExactProcessTerminationCapability['terminateRecordedHostProcess']
			>[0],
		) => Promise<ManagedVmExactProcessTerminationOutcome>
	>;
	readonly sleep: Mock<(delayMs: number) => Promise<void>>;
}

function createTerminationDependencies(
	options: {
		readonly outcome?: ManagedVmExactProcessTerminationOutcome;
	} = {},
): TerminationDependenciesHarness {
	const terminateRecordedHostProcess = vi.fn(async () =>
		Promise.resolve(options.outcome ?? { hostProcessId: hostPid, kind: 'terminated' as const }),
	);
	return {
		exactProcessTermination: { terminateRecordedHostProcess },
		terminateRecordedHostProcess,
		sleep: vi.fn(async () => {}),
	};
}

describe('controller-managed VM termination', () => {
	it('observes exact TERM exit and cleared Gondolin runner ownership before closing live handles', async () => {
		// Arrange
		const orderedEvents: string[] = [];
		const dependencies = createTerminationDependencies();
		dependencies.terminateRecordedHostProcess.mockImplementation(async () => {
			orderedEvents.push('adapter-exact-termination');
			return { hostProcessId: hostPid, kind: 'terminated' };
		});
		const getHostProcessId = vi
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
			exactProcessTermination: dependencies.exactProcessTermination,
			sleep: dependencies.sleep,
			target: terminationTarget,
			vm: { close, getHostProcessId, id: terminationTarget.vmId },
		});

		// Assert
		expect(orderedEvents).toEqual([
			'adapter-exact-termination',
			'gondolin-runner-absent',
			'close-live-handles',
		]);
		expect(dependencies.terminateRecordedHostProcess).toHaveBeenCalledWith({
			contextLabel: "managed VM 'controller-owned-vm'",
			identity: {
				command: processIdentity.command,
				hostProcessId: hostPid,
				processStartIdentity: processIdentity.lstart,
				vmId: terminationTarget.vmId,
			},
		});
		expect(close).toHaveBeenCalledOnce();
	});

	it('closes live handles when the recorded process and Gondolin runner are already absent', async () => {
		// Arrange
		const dependencies = createTerminationDependencies({
			outcome: { hostProcessId: hostPid, kind: 'already-absent' },
		});
		const close = vi.fn(async () => {});

		// Act
		await terminateLiveManagedVm({
			exactProcessTermination: dependencies.exactProcessTermination,
			sleep: dependencies.sleep,
			target: terminationTarget,
			vm: { close, getHostProcessId: () => null, id: terminationTarget.vmId },
		});

		// Assert
		expect(dependencies.terminateRecordedHostProcess).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledOnce();
	});

	it('terminates an exact recorded process without requiring a live Gondolin handle', async () => {
		// Arrange
		const dependencies = createTerminationDependencies();

		// Act
		await terminateRecordedManagedVmProcess({
			exactProcessTermination: dependencies.exactProcessTermination,
			target: terminationTarget,
		});

		// Assert
		expect(dependencies.terminateRecordedHostProcess).toHaveBeenCalledWith({
			contextLabel: "managed VM 'controller-owned-vm'",
			identity: {
				command: processIdentity.command,
				hostProcessId: hostPid,
				processStartIdentity: processIdentity.lstart,
				vmId: terminationTarget.vmId,
			},
		});
	});

	it('refuses a same-start command inconsistency without signaling or closing live handles', async () => {
		// Arrange
		const dependencies = createTerminationDependencies();
		dependencies.terminateRecordedHostProcess.mockRejectedValue(
			new Error('same process start identity was observed but command changed'),
		);
		const close = vi.fn(async () => {});

		// Act
		const termination = terminateLiveManagedVm({
			exactProcessTermination: dependencies.exactProcessTermination,
			sleep: dependencies.sleep,
			target: terminationTarget,
			vm: { close, getHostProcessId: () => hostPid, id: terminationTarget.vmId },
		});

		// Assert
		await expect(termination).rejects.toThrow(/same process start.*command changed/iu);
		expect(dependencies.terminateRecordedHostProcess).toHaveBeenCalledOnce();
		expect(close).not.toHaveBeenCalled();
	});

	it('rejects without closing while Gondolin keeps a live runner reference after OS absence', async () => {
		// Arrange
		const dependencies = createTerminationDependencies();
		const close = vi.fn(async () => {});

		// Act
		const termination = terminateLiveManagedVm({
			exactProcessTermination: dependencies.exactProcessTermination,
			sleep: dependencies.sleep,
			target: terminationTarget,
			vm: { close, getHostProcessId: () => hostPid, id: terminationTarget.vmId },
		});

		// Assert
		await expect(termination).rejects.toThrow(/Gondolin.*runner|runner.*Gondolin/iu);
		expect(dependencies.sleep).toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it('refuses a live VM id mismatch without signaling or closing', async () => {
		// Arrange
		const dependencies = createTerminationDependencies();
		const close = vi.fn(async () => {});

		// Act
		const termination = terminateLiveManagedVm({
			exactProcessTermination: dependencies.exactProcessTermination,
			sleep: dependencies.sleep,
			target: terminationTarget,
			vm: { close, getHostProcessId: () => hostPid, id: 'different-vm' },
		});

		// Assert
		await expect(termination).rejects.toThrow(/VM id|vm id/iu);
		expect(dependencies.terminateRecordedHostProcess).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
	});

	it('propagates a live-handle close error after proving runner absence', async () => {
		// Arrange
		const dependencies = createTerminationDependencies({
			outcome: { hostProcessId: hostPid, kind: 'already-absent' },
		});
		const closeError = new Error('live handle close failed');
		const close = vi.fn(async () => {
			throw closeError;
		});

		// Act
		const termination = terminateLiveManagedVm({
			exactProcessTermination: dependencies.exactProcessTermination,
			sleep: dependencies.sleep,
			target: terminationTarget,
			vm: { close, getHostProcessId: () => null, id: terminationTarget.vmId },
		});

		// Assert
		await expect(termination).rejects.toMatchObject({
			cause: closeError,
			name: 'ManagedVmTerminationUnprovenError',
		});
		expect(dependencies.terminateRecordedHostProcess).toHaveBeenCalledOnce();
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
