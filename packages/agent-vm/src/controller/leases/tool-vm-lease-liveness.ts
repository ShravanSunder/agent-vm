import type { ManagedVm } from '@agent-vm/managed-vm';

import { writeControllerDiagnostic } from '../controller-diagnostic-logging.js';

const toolVmLeaseLivenessTimeoutMs = 5_000;

export async function isToolVmLeaseVmLive(lease: {
	readonly id: string;
	readonly vm: Pick<ManagedVm, 'exec'>;
	readonly zoneId: string;
}): Promise<boolean> {
	const abortController = new AbortController();
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeoutResult = new Promise<false>((resolve) => {
			timeoutHandle = setTimeout(() => {
				abortController.abort();
				resolve(false);
			}, toolVmLeaseLivenessTimeoutMs);
		});
		const probeResult = await Promise.race([
			lease.vm.exec('true', { signal: abortController.signal }),
			timeoutResult,
		]);
		return probeResult !== false && probeResult.exitCode === 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		void message;
		writeControllerDiagnostic('lease', {
			event: 'lease-liveness-failed',
			level: 'warning',
			failureClass: 'failure',
			telemetry: {
				leaseId: lease.id,
				operation: 'tool-vm-lease-liveness',
				zoneId: lease.zoneId,
			},
		});
		return false;
	} finally {
		if (timeoutHandle !== undefined) {
			clearTimeout(timeoutHandle);
		}
	}
}
