import type { ManagedVm } from '@agent-vm/gondolin-adapter';

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
		process.stderr.write(
			`[lease-manager] liveness check failed for lease '${lease.id}' in zone '${lease.zoneId}': ${message}\n`,
		);
		return false;
	} finally {
		if (timeoutHandle !== undefined) {
			clearTimeout(timeoutHandle);
		}
	}
}
