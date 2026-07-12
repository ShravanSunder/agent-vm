import {
	terminateRecordedManagedVmHostProcess,
	type ManagedVmKillDependencies,
	type ProcessIdentity,
} from './managed-vm-process.js';

const defaultRunnerDetachAttempts = 20;
const runnerDetachPollIntervalMs = 25;

export interface ManagedVmProcessTarget {
	readonly hostPid: number;
	readonly processIdentity: ProcessIdentity;
	readonly vmId: string;
}

export type ManagedVmTerminationOutcome =
	| { readonly kind: 'already-absent'; readonly pid: number }
	| { readonly kind: 'terminated'; readonly pid: number };

export interface LiveManagedVmTerminationHandle {
	readonly id: string;
	close(): Promise<void>;
	getHostProcessId(): number | null;
}

export class ManagedVmTerminationUnprovenError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ManagedVmTerminationUnprovenError';
	}
}

export function containsManagedVmTerminationUnprovenError(error: unknown): boolean {
	const pendingErrors: unknown[] = [error];
	const visitedErrors = new Set<unknown>();
	while (pendingErrors.length > 0) {
		const currentError = pendingErrors.pop();
		if (visitedErrors.has(currentError)) {
			continue;
		}
		visitedErrors.add(currentError);
		if (currentError instanceof ManagedVmTerminationUnprovenError) {
			return true;
		}
		if (currentError instanceof AggregateError) {
			pendingErrors.push(...currentError.errors);
		}
		if (currentError instanceof Error && currentError.cause !== undefined) {
			pendingErrors.push(currentError.cause);
		}
	}
	return false;
}

interface TerminateRecordedManagedVmProcessOptions {
	readonly contextLabel?: string;
	readonly dependencies: ManagedVmKillDependencies;
	readonly target: ManagedVmProcessTarget;
}

export async function terminateRecordedManagedVmProcess(
	options: TerminateRecordedManagedVmProcessOptions,
): Promise<ManagedVmTerminationOutcome> {
	const terminatedPid = await terminateRecordedManagedVmHostProcess({
		contextLabel: options.contextLabel ?? `managed VM '${options.target.vmId}'`,
		dependencies: options.dependencies,
		pid: options.target.hostPid,
		recordedIdentity: options.target.processIdentity,
	});
	return terminatedPid === null
		? { kind: 'already-absent', pid: options.target.hostPid }
		: { kind: 'terminated', pid: terminatedPid };
}

interface TerminateLiveManagedVmOptions extends TerminateRecordedManagedVmProcessOptions {
	readonly runnerDetachAttempts?: number;
	readonly vm: LiveManagedVmTerminationHandle;
}

function assertLiveVmMatchesTarget(options: {
	readonly target: ManagedVmProcessTarget;
	readonly vm: LiveManagedVmTerminationHandle;
}): number | null {
	if (options.vm.id !== options.target.vmId) {
		throw new Error(
			`Refusing managed VM termination because live VM id '${options.vm.id}' does not match recorded VM id '${options.target.vmId}'.`,
		);
	}
	const liveHostPid = options.vm.getHostProcessId();
	if (liveHostPid !== null && liveHostPid !== options.target.hostPid) {
		throw new Error(
			`Refusing managed VM termination because live VM '${options.vm.id}' reports pid ${String(liveHostPid)}, not recorded pid ${String(options.target.hostPid)}.`,
		);
	}
	return liveHostPid;
}

async function waitForGondolinRunnerDetach(options: {
	readonly attempts: number;
	readonly dependencies: ManagedVmKillDependencies;
	readonly target: ManagedVmProcessTarget;
	readonly vm: LiveManagedVmTerminationHandle;
}): Promise<void> {
	for (let attempt = 0; attempt < options.attempts; attempt += 1) {
		const liveHostPid = options.vm.getHostProcessId();
		if (liveHostPid === null) {
			return;
		}
		if (liveHostPid !== options.target.hostPid) {
			throw new Error(
				`Gondolin runner identity changed for VM '${options.target.vmId}': expected pid ${String(options.target.hostPid)}, observed ${String(liveHostPid)}.`,
			);
		}
		// oxlint-disable-next-line no-await-in-loop -- bounded runner-detach polling is sequential
		await options.dependencies.sleep(runnerDetachPollIntervalMs);
	}
	throw new Error(
		`Gondolin still reports runner pid ${String(options.target.hostPid)} for VM '${options.target.vmId}' after controller-owned process termination; refusing stock close to protect sibling VMs.`,
	);
}

export async function terminateLiveManagedVm(
	options: TerminateLiveManagedVmOptions,
): Promise<ManagedVmTerminationOutcome> {
	try {
		const initialHostPid = assertLiveVmMatchesTarget(options);
		const outcome = await terminateRecordedManagedVmProcess(options);
		if (initialHostPid !== null) {
			await waitForGondolinRunnerDetach({
				attempts: options.runnerDetachAttempts ?? defaultRunnerDetachAttempts,
				dependencies: options.dependencies,
				target: options.target,
				vm: options.vm,
			});
		}
		await options.vm.close();
		return outcome;
	} catch (error) {
		if (error instanceof ManagedVmTerminationUnprovenError) {
			throw error;
		}
		throw new ManagedVmTerminationUnprovenError(
			`Controller-managed termination of VM '${options.target.vmId}' was not proven complete: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
}
